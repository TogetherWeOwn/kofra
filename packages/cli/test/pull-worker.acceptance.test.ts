/**
 * Protected black-box acceptance: actual CLI + actual served workerd/D1/R2/KV.
 * Run: npm ci --include=dev && npm run test:cli -- test/pull-worker.acceptance.test.ts
 * Fixtures/reset: fresh local wrangler config, migrations, setup and multipart
 * publishes in mkdtemp; dispose Worker and remove only that directory afterward.
 * No root config deploy, remote bindings, production reads or real credentials.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { object, pullHarness, receipt, sha256, tree, type Wire } from "./fixtures/pull-harness";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bootstrap = "pull-local-bootstrap-only-0123456789abcdef";
const site = "pull-worker-fixture";
const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
// More than the existing maximum read_file page; UTF-8 code points cross page edges.
const large = Buffer.from("café 日本語 ☃\r\n".repeat(80_000));
function fixture(release: string): Record<string, Buffer> {
  return {
    "index.html": Buffer.from(`<!doctype html><a href='/docs/note.txt'>${release}</a><script src='/assets/app.js'></script>`),
    "assets/app.js": Buffer.from(`console.log(${JSON.stringify(release)})`),
    "assets/style.css": Buffer.from("body{background:url('/assets/image.bin')}\n"),
    "assets/image.bin": binary,
    "docs/résumé #1 日本語.txt": Buffer.from(`${release}: café ☃\r\nno final newline`),
    "empty.txt": Buffer.alloc(0),
    "nested/deep/large.txt": large,
    ...(release === "old" ? { "old-only.txt": Buffer.from("not live any more") } : { "new-only.txt": Buffer.from(release) }),
  };
}
const oldTree = fixture("old");
const liveTree = fixture("live");
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let h: Awaited<ReturnType<typeof pullHarness>>;
let api: string;
let ownerKey: string;
let readerKey: string;
let noReadKey: string;
let oldVersion: string;
let liveVersion: string;
let bundle: string;
let counter = 0;

function localUrl(path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\x00-\x20\x7f#]/.test(path)) throw new Error("fixture requires an origin-relative path/query");
  const url = new URL(api);
  const query = path.indexOf("?");
  url.pathname = query < 0 ? path : path.slice(0, query);
  url.search = query < 0 ? "" : path.slice(query);
  return url;
}
async function request(path: string, init: RequestInit = {}, key = ownerKey) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  return fetch(localUrl(path), { ...init, headers, redirect: "error" });
}
async function publish(slug: string, files: Record<string, Buffer>) {
  const body = new FormData();
  body.set("slug", slug);
  for (const [path, bytes] of Object.entries(files)) {
    body.set(path, new File([new Uint8Array(bytes)], path.split("/").pop()!, { type: path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : path.endsWith(".bin") ? "application/octet-stream" : "text/plain; charset=utf-8" }));
  }
  const res = await request("/api/v1/publish", { method: "POST", body });
  expect(res.ok, `disposable fixture publish HTTP ${res.status}`).toBe(true);
  const result = await res.json() as any;
  expect(result.version.id).toEqual(expect.any(String));
  return result.version.id as string;
}

beforeAll(async () => {
  h = await pullHarness();
  const config = join(h.work, "wrangler.json");
  const persist = join(h.work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-pull-acceptance", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "pull-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "pull-acceptance-files" }], kv_namespaces: [{ binding: "CACHE" }],
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
  const setup = await request("/api/v1/setup", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "pull-fixture@example.com" }),
  }, bootstrap);
  expect(setup.status).toBe(201);
  ownerKey = ((await setup.json()) as any).apiKey.key;
  for (const scopes of [["sites:read"], ["keys:write"]]) {
    const res = await request("/api/v1/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scopes }) });
    expect(res.status).toBe(201);
    const key = ((await res.json()) as any).key;
    if (scopes[0] === "sites:read") readerKey = key;
    else noReadKey = key;
  }
  oldVersion = await publish(site, oldTree);
  liveVersion = await publish(site, liveTree);
  expect(oldVersion).not.toBe(liveVersion);
  bundle = join(h.work, "bundle", "kofra.mjs");
  await build({ entryPoints: [join(root, "packages/cli/src/cli.ts")], bundle: true, platform: "node", format: "esm", target: "node20", outfile: bundle, logLevel: "silent" });
}, 120_000);
afterAll(async () => { await worker?.dispose(); await h?.dispose(); }, 30_000);

function readTransport(slug: string, options: { pinned?: string; afterManifest?: () => Promise<void> } = {}) {
  let moved = false;
  return async (req: Request) => {
    const url = new URL(req.url);
    const base = `/api/v1/sites/${slug}`;
    const manifest = url.pathname === `${base}/files`;
    const reads = manifest || url.pathname === "/api/v1/read-file" || url.pathname.startsWith(`${base}/files/`);
    expect(url.origin).toBe(api);
    expect(req.method).toBe("GET");
    expect([base, `${base}/files`, "/api/v1/read-file"].includes(url.pathname)
      || url.pathname.startsWith(`${base}/versions/`) || url.pathname.startsWith(`${base}/files/`), "only existing site/version/file reads").toBe(true);
    if (options.pinned && reads) expect(url.searchParams.get("version"), "all manifest/page/raw reads must stay on the pinned id").toBe(options.pinned);
    const response = await fetch(req, { redirect: "error" });
    if (manifest && !moved && options.afterManifest) {
      // Complete the old manifest response before publishing a changed file set.
      // The CLI has pinned but has not yet received the listing or started reads.
      const body = await response.arrayBuffer();
      moved = true;
      await options.afterManifest();
      return new Response(body, { status: response.status, headers: response.headers });
    }
    return response;
  };
}
async function cli(slug: string, flags: string[] = [], opts: { pinned?: string; key?: string; afterManifest?: () => Promise<void> } = {}) {
  const dir = join(h.cwd, `result-${++counter}`);
  const r = await h.cli(["pull", slug, dir, ...flags], { api, key: opts.key ?? readerKey, fetch: readTransport(slug, opts) });
  for (const secret of [bootstrap, ownerKey, readerKey, noReadKey]) expect(r.stdout + r.stderr, "no fixture credentials in output").not.toContain(secret);
  return { r, dir };
}
async function verifyTree(dir: string, expected: Record<string, Buffer>) {
  expect(await tree(dir), "whole tree must match with no missing/extra/partial files").toEqual(Object.fromEntries(Object.entries(expected).map(([path, bytes]) => [path, bytes.toString("base64")])));
  for (const [path, bytes] of Object.entries(expected)) {
    const downloaded = await readFile(join(dir, path));
    expect(downloaded.length, path).toBe(bytes.length);
    expect(sha256(downloaded), path).toBe(sha256(bytes));
  }
}
function verifyPin(wire: Wire[], slug: string, pin: string) {
  const base = `/api/v1/sites/${slug}`;
  const manifest = wire.findIndex(w => w.url.pathname === `${base}/files`);
  expect(manifest, "resolve an immutable id before fetching its manifest").toBeGreaterThan(0);
  expect(wire.some(w => w.url.pathname === `${base}/versions`), "no bounded history scan").toBe(false);
  for (const w of wire.slice(manifest)) expect(w.url.searchParams.get("version")).toBe(pin);
}

describe("served pull fixture controls (green on baseline)", () => {
  it("exposes independent pinned manifests and bounded pages through the existing API and CLI", async () => {
    const r = await h.cli(["api", "GET", `/sites/${site}/files?version=${oldVersion}`, "--json"], { api, key: readerKey, fetch: readTransport(site) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const manifest = object(r);
    expect(manifest.version.id).toBe(oldVersion);
    expect(manifest.files.map((f: any) => f.path).sort()).toEqual(Object.keys(oldTree).sort());
    for (const file of manifest.files) expect(file).toMatchObject({ size: oldTree[file.path]!.length, sha256: sha256(oldTree[file.path]!) });
    const query = new URLSearchParams({ site, path: "nested/deep/large.txt", version: oldVersion, encoding: "base64", length: "1048576" });
    const page = await request(`/api/v1/read-file?${query}`, {}, readerKey);
    expect(page.status).toBe(200);
    const body = await page.json() as any;
    expect(body).toMatchObject({ versionId: oldVersion, size: large.length, sha256: sha256(large), length: 1_048_576, truncated: true, nextOffset: 1_048_576 });
    expect(Buffer.from(body.content, "base64")).toEqual(large.subarray(0, 1_048_576));
  });

  it("demonstrates that rendered HTML differs but raw bytes retain stored identity", async () => {
    const encoded = encodeURIComponent("index.html");
    const rendered = await request(`/s/${site}/${encoded}`, { headers: { Accept: "text/html" } }, readerKey);
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await rendered.text()).not.toBe(liveTree["index.html"]!.toString());
    const raw = await request(`/api/v1/sites/${site}/files/index.html?version=${oldVersion}`, {}, readerKey);
    expect(raw.status).toBe(200);
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(oldTree["index.html"]);
  });
});

describe("pull with the actual disposable Worker", () => {
  it("round-trips live text, binary, nested Unicode, empty and multi-page files with exact hashes and raw HTML/CSS", async () => {
    const { r, dir } = await cli(site, ["--json"], { pinned: liveVersion });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const body = receipt(r, site, liveVersion, dir);
    expect(body.failures).toEqual([]);
    expect(body.files.sort((a: any, b: any) => a.path.localeCompare(b.path))).toEqual(Object.entries(liveTree).map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256(bytes) })).sort((a, b) => a.path.localeCompare(b.path)));
    await verifyTree(dir, liveTree);
    verifyPin(r.wire, site, liveVersion);
  });

  it.each(["v1", "1", "id"])("pulls the old immutable snapshot via %s after a different file set is live", async reference => {
    const { r, dir } = await cli(site, ["--version", reference === "id" ? oldVersion : reference, "--json"], { pinned: oldVersion });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(receipt(r, site, oldVersion, dir).failures).toEqual([]);
    await verifyTree(dir, oldTree);
    verifyPin(r.wire, site, oldVersion);
  });

  it("cannot switch its file set or bytes when live is republished between manifest and download", async () => {
    const slug = "pull-mid-flight";
    const first = await publish(slug, oldTree);
    let moved: string | undefined;
    const { r, dir } = await cli(slug, ["--json"], { pinned: first, afterManifest: async () => { moved = await publish(slug, fixture("changed mid-pull")); } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(moved, "the test must actually republish during this invocation").toEqual(expect.any(String));
    expect(moved).not.toBe(first);
    expect(receipt(r, slug, first, dir).files.map((f: any) => f.path).sort()).toEqual(Object.keys(oldTree).sort());
    await verifyTree(dir, oldTree);
    verifyPin(r.wire, slug, first);
  });

  it("human output summarizes successful counts and the exact pinned version", async () => {
    const { r, dir } = await cli(site, [], { pinned: liveVersion });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(liveVersion);
    expect(r.stdout).toMatch(/8\s+files?\b|\bfiles?\s*[:=]\s*8\b/i);
    expect(r.stdout).toMatch(/pull|success|complete/i);
    await verifyTree(dir, liveTree);
  });

  it.each([["invalid", 3], ["no-scope", 3], ["missing-version", 4]] as const)("preserves the established %s exit without writing destination files", async (kind, exit) => {
    const flags = kind === "missing-version" ? ["--version", "v99999", "--json"] : ["--json"];
    const { r, dir } = await cli(site, flags, { key: kind === "invalid" ? "dw_invalid_disposable_fixture" : kind === "no-scope" ? noReadKey : readerKey });
    expect(r.code, r.stdout + r.stderr).toBe(exit);
    const body = object(r);
    expect(body).toMatchObject({ ok: false, exitCode: exit, error: { code: expect.stringMatching(/^[a-z][a-z0-9_]*$/), hint: expect.any(String) } });
    expect(body.error.hint.length).toBeGreaterThan(0);
    expect(await tree(dir)).toEqual({});
  });

  it("runs the built CLI in a real non-TTY process with one receipt and no config/key writes", async () => {
    const dir = join(h.cwd, `process-${++counter}`);
    const wireFile = join(h.work, "process-wire.jsonl");
    const before = await tree(h.config);
    const result = await promisify(execFile)(process.execPath, ["--import", join(root, "packages/cli/test/helpers/pull-fetch-guard.mjs"), bundle, "pull", site, dir, "--json"], {
      cwd: h.cwd, timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: h.work, KOFRA_CONFIG_DIR: h.config, KOFRA_API: api, KOFRA_API_KEY: readerKey,
        PULL_TEST_SITE: site, PULL_TEST_ORIGIN: api, PULL_TEST_WIRE: wireFile },
    }).then(r => ({ code: 0, stdout: r.stdout, stderr: r.stderr, wire: [] }), (e: any) => ({ code: typeof e.code === "number" ? e.code : -1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), wire: [] }));
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(receipt(result, site, liveVersion, dir).files).toHaveLength(8);
    await verifyTree(dir, liveTree);
    const wire = (await readFile(wireFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(wire.length).toBeGreaterThan(1);
    expect(wire.every(w => w.allowed && w.method === "GET")).toBe(true);
    expect(await tree(h.config)).toEqual(before);
    for (const secret of [bootstrap, ownerKey, readerKey]) expect(result.stdout + result.stderr).not.toContain(secret);
  });
});
