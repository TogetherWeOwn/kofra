/**
 * Protected independent subprocess/workerd acceptance. All writes hit a fresh
 * local Worker and disposable D1/R2/KV; no deploy or remote bindings are used.
 * Existing backend duplicate tests remain unchanged. This file checks the CLI's
 * composition with that backend, not a second implementation of duplication.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { duplicateHarness, duplicateObject, sourceSecret } from "./fixtures/duplicate-harness";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = "cli-template";
const bootstrap = "duplicate-local-only-bootstrap-0123456789";
let work: string;
let api: string;
let key: string;
let scopedKey: string;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let h: Awaited<ReturnType<typeof duplicateHarness>>;
let original: any;
let manifest: any;
let noLiveRefusal: any;
let sourceId: string;

async function request(path: string, init: RequestInit = {}, credential = key) {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("fixture requires a local relative path");
  return fetch(api + path, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}`, ...init.headers }, redirect: "error" });
}
async function json(path: string, init: RequestInit = {}, credential = key) {
  const response = await request(path, init, credential);
  return { status: response.status, body: await response.json() as any };
}
async function post(path: string, body: unknown, credential = key) {
  return json(path, { method: "POST", body: JSON.stringify(body) }, credential);
}
async function siteCount() {
  const response = await json("/api/v1/sites");
  expect(response.status).toBe(200);
  return response.body.sites.length;
}
async function assertSourceUnchanged() {
  expect((await json(`/api/v1/sites/${source}`)).body).toEqual(original);
  expect((await json(`/api/v1/sites/${source}/files`)).body).toEqual(manifest);
}
async function cli(sourceRef: string, newSlug: string, flags: string[] = [], credential = key) {
  const result = await h.cli(["duplicate", sourceRef, newSlug, ...flags, "--json"], { api, key: credential, forwardSource: sourceRef });
  expect(result.stdout + result.stderr).not.toContain(bootstrap);
  expect(result.wire, "one duplicate request only; no source mutation, uploads, finalize or protection request").toHaveLength(1);
  expect(result.wire[0]).toMatchObject({ method: "POST", url: `${api}/api/v1/sites/${encodeURIComponent(sourceRef)}/duplicate`, authenticated: true });
  expect(result.wire[0]!.key?.trim().length).toBeGreaterThan(0);
  return result;
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "duplicate-worker-tests-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-duplicate-cli-acceptance", main: join(root, "test/fixtures/duplicate-cli.worker.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "https://sites.example.test", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "duplicate-cli-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "duplicate-cli-acceptance-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  const wrangler = join(dirname(fileURLToPath(import.meta.resolve("wrangler/package.json"))), "bin/wrangler.js");
  await promisify(execFile)(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({ config,
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  api = (await worker.url).origin;
  const setup = await post("/api/v1/setup", { email: "duplicate-fixture@example.com" }, bootstrap);
  expect(setup.status).toBe(201);
  key = setup.body.apiKey.key;
  // Two versions prove that the live snapshot, not an old version, is copied.
  for (const [content, expectedStatus] of [["Historical template", 201], ["Live template: café ☃", 200]] as const) {
    const publish = await post("/api/v1/publish", { slug: source, files: [
      { path: "index.html", content }, { path: "docs/résumé.txt", content: "Hello\n" }, { path: "empty.txt", content: "" },
    ] });
    expect(publish.status, `fixture publish: ${JSON.stringify(publish.body)}`).toBe(expectedStatus);
    sourceId = publish.body.site.id;
    expect(sourceId).toEqual(expect.any(String));
  }
  const settings = await json(`/api/v1/sites/${source}`, { method: "PATCH", body: JSON.stringify({
    spa: true, password: sourceSecret, renderMarkdown: false, crossOriginIsolation: true, title: "Do not copy my settings",
  }) });
  expect(settings.status).toBe(200);
  expect((await post("/api/v1/sites", { slug: "empty-template" })).status).toBe(201);
  const scoped = await post("/api/v1/keys", { name: "fixture other-site only", scopes: ["sites:read", "sites:write"], site: "empty-template" });
  expect(scoped.status).toBe(201);
  scopedKey = scoped.body.key;
  const transfer = await post("/api/v1/transfers", {
    slug: "delivery-template", files: [{ path: "note.txt", content: "Delivery is not a site template" }], recipients: ["recipient@example.com"],
  });
  expect(transfer.status, `fixture transfer: ${JSON.stringify(transfer.body)}`).toBe(201);
  original = (await json(`/api/v1/sites/${source}`)).body;
  manifest = (await json(`/api/v1/sites/${source}/files`)).body;
  expect(original.site.currentVersion.number).toBe(2);
  expect(manifest.files).toHaveLength(3);
  // Capture the real backend's established no-live error, not an invented CLI code.
  noLiveRefusal = await post("/api/v1/sites/empty-template/duplicate", { newSlug: "control-no-live" });
  expect(noLiveRefusal.status).toBe(409);
  expect(noLiveRefusal.body.error.hint).toEqual(expect.any(String));
  h = await duplicateHarness();
}, 120_000);

afterAll(async () => {
  await h?.dispose();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
}, 30_000);

const workerRefusals = [
  { sourceRef: source, target: source, status: 409, code: "slug_taken", exit: 5 },
  { sourceRef: "missing-template", target: "missing-copy", status: 404, code: "site_not_found", exit: 4 },
  { sourceRef: source, target: "foreign-copy", status: 404, code: "site_not_found", exit: 4, scoped: true },
  { sourceRef: "empty-template", target: "empty-copy", status: 409, exit: 5 },
  { sourceRef: "delivery-template", target: "delivery-copy", status: 409, code: "transfer_immutable", exit: 5 },
  { sourceRef: source, target: "policy-refused-copy", status: 403, code: "fixture_duplicate_refused", exit: 3 },
  { sourceRef: source, target: "quota-refused-copy", status: 413, code: "limit_reached", exit: 6 },
];

async function assertLiveCopy(output: any, slug: string, message: string | null) {
  const copy = await json(`/api/v1/sites/${slug}`);
  expect(copy.status).toBe(200);
  expect(output).toMatchObject({ slug, site: { slug },
    versionId: copy.body.site.currentVersionId, fileCount: 3, totalBytes: original.site.currentVersion.totalBytes });
  expect(output.versionId).not.toBe(original.site.currentVersionId);
  expect(copy.body.site.currentVersion).toMatchObject({ number: 1, message });
  expect(copy.body.site.settings).toMatchObject({ spa: true, passwordProtected: false, renderMarkdown: true, crossOriginIsolation: false });
  expect(copy.body.site.title).toBeNull();
  expect(output.note).toMatch(/password/i);
  expect(new URL(output.url).search).toBe("");
  expect(new URL(output.url).hash).toBe("");
  const copiedFiles = (await json(`/api/v1/sites/${slug}/files`)).body.files;
  const tuples = (files: any[]) => files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  expect(tuples(copiedFiles)).toEqual(tuples(manifest.files));
  const copied = await request(`/api/v1/sites/${slug}/files/index.html`);
  expect(copied.status).toBe(200);
  expect(await copied.text()).toBe("Live template: café ☃");
  await assertSourceUnchanged();
}

describe("duplicate CLI with the real disposable Worker", () => {
  it("advertises duplicate in the existing server command table", async () => {
    const table = await json("/api/v1/operations");
    expect(table.status).toBe(200);
    const rows = Array.isArray(table.body) ? table.body : table.body.operations;
    expect(Array.isArray(rows)).toBe(true);
    const row = rows.find((item: any) => item.id === "duplicate_site");
    expect(row).toMatchObject({ method: "POST", cli: { command: ["duplicate"], positional: ["site", "newSlug"] } });
  });

  it("returns destination identities/live bytes, preserves source and resets access/settings except SPA", async () => {
    const result = await cli(source, "cli-live-copy", ["--message", "CLI live snapshot"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.wire[0]!.body)).toEqual({ newSlug: "cli-live-copy", message: "CLI live snapshot" });
    await assertLiveCopy(duplicateObject(result), "cli-live-copy", "CLI live snapshot");
  });

  it("replays an explicit recovery key across CLI processes with one destination version", async () => {
    const before = await siteCount();
    const flags = ["--idempotency-key", "local-duplicate-recovery-01", "--message", "Recover identical snapshot"];
    const first = await cli(sourceId, "cli-replay-copy", flags);
    const second = await cli(sourceId, "cli-replay-copy", flags);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    const a = duplicateObject(first);
    const b = duplicateObject(second);
    expect(b).toMatchObject({ replayed: true, versionId: a.versionId, site: { slug: a.site.slug } });
    expect([first.wire[0]!.key, second.wire[0]!.key]).toEqual(["local-duplicate-recovery-01", "local-duplicate-recovery-01"]);
    expect(await siteCount()).toBe(before + 1);
    const versions = await json("/api/v1/sites/cli-replay-copy/versions");
    expect(versions.status).toBe(200);
    expect(versions.body.versions).toHaveLength(1);
    await assertSourceUnchanged();
  });

  it.each(workerRefusals)("keeps $target refusal non-successful and leaves sites/source unchanged", async scenario => {
    const before = await siteCount();
    const result = await cli(scenario.sourceRef, scenario.target, [], scenario.scoped ? scopedKey : key);
    expect(result.code, result.stdout + result.stderr).toBe(scenario.exit);
    const output = duplicateObject(result);
    expect(output).toMatchObject({ ok: false, exitCode: scenario.exit, error: {
      status: scenario.status, code: scenario.code ?? noLiveRefusal.body.error.code, hint: expect.any(String),
    } });
    if (scenario.sourceRef === "empty-template") {
      expect(output.error.hint).toBe(noLiveRefusal.body.error.hint);
      expect(output.error.details).toEqual(noLiveRefusal.body.error.details);
    }
    if (scenario.target === "policy-refused-copy") expect(output.error.details).toEqual({ destination: scenario.target, rule: "fixture-policy" });
    if (scenario.target === "quota-refused-copy") expect(output.error.details).toEqual({ resource: "sites", limit: 0 });
    expect(await siteCount()).toBe(before);
    await assertSourceUnchanged();
  });
});

describe("disposable Worker fixture control (green on baseline)", () => {
  it("existing raw api can duplicate through the same built CLI transport", async () => {
    const result = await h.cli(["api", "POST", `/sites/${source}/duplicate`, "--data", '{"newSlug":"cli-control-copy"}', "--json"], {
      api, key, forwardSource: source,
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.wire).toHaveLength(1);
    await assertLiveCopy(duplicateObject(result), "cli-control-copy", null);
  });

  it.each(workerRefusals)("raw api verifies the $target fixture's real refusal and exit", async scenario => {
    const before = await siteCount();
    const result = await h.cli(["api", "POST", `/sites/${scenario.sourceRef}/duplicate`, "--data",
      JSON.stringify({ newSlug: scenario.target }), "--json"], {
      api, key: scenario.scoped ? scopedKey : key, forwardSource: scenario.sourceRef,
    });
    expect(result.code, result.stdout + result.stderr).toBe(scenario.exit);
    expect(duplicateObject(result)).toMatchObject({ ok: false, error: {
      status: scenario.status, code: scenario.code ?? noLiveRefusal.body.error.code, hint: expect.any(String),
    } });
    expect(result.wire).toHaveLength(1);
    expect(await siteCount()).toBe(before);
    await assertSourceUnchanged();
  });
});
