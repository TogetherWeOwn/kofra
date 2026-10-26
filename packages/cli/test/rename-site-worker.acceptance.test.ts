/**
 * Disposable local Worker verification for the CLI rename contract.
 * The direct REST control must pass on the baseline; the CLI case is RED until
 * the command exists. Only test files are changed, no production/staging calls.
 * Run: npm run test:cli -- test/rename-site-worker.acceptance.test.ts
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, type Io } from "../src/main.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const BOOTSTRAP = "rename-local-fixture-bootstrap-0123456789abcdef";
const PASSWORD = "rename-disposable-password-not-a-real-secret";
const CONTENT = "<h1>Immutable rename acceptance</h1>";
const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
let work: string;
let home: string;
let api: string;
let ownerKey: string;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
const wire: Array<{ method: string; path: string; body: unknown; response: any }> = [];
const fixtures = new Map<string, { versionId: string; site: any }>();

async function request(path: string, init: RequestInit = {}, key = ownerKey) {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("fixture requires an origin-relative path");
  const url = new URL(path, api);
  if (url.origin !== api) throw new Error("fixture authority cannot change");
  const headers = new Headers(init.headers);
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return fetch(url, { ...init, headers, redirect: "manual" });
}
async function json(path: string, body: unknown, method = "POST") {
  const res = await request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(res.ok, `fixture HTTP ${res.status}: ${path}`).toBe(true);
  return res.json() as Promise<any>;
}
async function snapshot(dir: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const info = await stat(path, { bigint: true });
    result.push([name, String(info.mode), String(info.ino), String(info.mtimeNs), String(info.ctimeNs),
      info.isDirectory() ? await snapshot(path) : (await readFile(path)).toString("base64")]);
  }
  return result;
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "rename-worker-"));
  home = join(work, "client");
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(join(home, "dropway.json"), JSON.stringify({ sites: { dist: "worker-cli-old", docs: "untouched" } }) + "\n");
  await writeFile(join(home, "config", "credentials.json"), '{"instances":{}}\n', { mode: 0o600 });
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-rename-acceptance", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "rename-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "rename-acceptance-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  const wrangler = join(dirname(fileURLToPath(import.meta.resolve("wrangler/package.json"))), "bin/wrangler.js");
  await promisify(execFile)(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config, dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: BOOTSTRAP } },
  });
  await worker.ready;
  api = (await worker.url).origin;
  const setup = await request("/api/v1/setup", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "rename-fixture@example.net" }),
  }, BOOTSTRAP);
  expect(setup.status).toBe(201);
  ownerKey = ((await setup.json()) as any).apiKey.key;
  for (const slug of ["worker-control-old", "worker-cli-old"]) {
    const published = await json("/api/v1/publish", { slug, files: [
      { path: "index.html", content: CONTENT }, { path: "docs/note.txt", content: "Original nested bytes\n" },
    ] });
    expect(published.version.id).toEqual(expect.any(String));
    await json(`/api/v1/sites/${slug}/access`, { mode: "password", password: PASSWORD }, "PUT");
    const metadata = await request(`/api/v1/sites/${slug}`);
    expect(metadata.status).toBe(200);
    const site = ((await metadata.json()) as any).site;
    expect(site.currentVersionId).toBe(published.version.id);
    expect((await request(`/s/${slug}/`, { headers: NAV }, "")).status).toBe(401);
    fixtures.set(slug, { versionId: published.version.id, site });
  }
}, 120_000);
afterAll(async () => {
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function verifyRename(oldSlug: string, newSlug: string, result: any) {
  const original = fixtures.get(oldSlug)!;
  expect(result).toMatchObject({ renamed: true, oldSlug, slug: newSlug, url: `${api}/s/${newSlug}/` });
  expect(typeof result.redirectUntil).toBe("string");
  expect(Number.isFinite(Date.parse(result.redirectUntil))).toBe(true);
  expect(Date.parse(result.redirectUntil)).toBeGreaterThan(Date.now());
  const metadata = await request(`/api/v1/sites/${newSlug}`);
  expect(metadata.status).toBe(200);
  const site = ((await metadata.json()) as any).site;
  expect(site.currentVersionId).toBe(original.versionId);
  expect(site.settings).toEqual(original.site.settings);
  expect(result.site).toMatchObject({ slug: newSlug, currentVersionId: original.versionId, settings: original.site.settings });
  // If identity is present on the API wire, it must not change during rename.
  if (original.site.id !== undefined) expect(result.site.id).toBe(original.site.id);
  expect((await request(`/s/${newSlug}/`, { headers: NAV }, "")).status).toBe(401);
  const unlocked = await request(`/s/${newSlug}/__dropway/password`, {
    method: "POST", body: new URLSearchParams({ password: PASSWORD }), headers: { Origin: api },
  }, "");
  expect(unlocked.status).toBe(303);
  const cookie = unlocked.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toEqual(expect.any(String));
  const live = await request(`/s/${newSlug}/?raw=1`, { headers: { ...NAV, Cookie: cookie! } }, "");
  expect(live.status).toBe(200);
  expect(await live.text()).toBe(CONTENT);
  expect(live.headers.get("x-kofra-version")).toBe(original.versionId);
  const nested = await request(`/s/${newSlug}/docs/note.txt?raw=1`, { headers: { Cookie: cookie! } }, "");
  expect(nested.status).toBe(200);
  expect(await nested.text()).toBe("Original nested bytes\n");
  const old = await request(`/s/${oldSlug}/docs/note.txt?x=1&y=two`, { headers: NAV }, "");
  expect(old.status).toBe(308);
  expect(old.headers.get("location")).toBe(`${api}/s/${newSlug}/docs/note.txt?x=1&y=two`);
  expect(old.headers.get("cache-control")).toBe("no-store");
}

describe("ordinary rename against an isolated real Worker", () => {
  it("control: existing REST rename preserves live version, password and old nested link", async () => {
    const result = await json("/api/v1/sites/worker-control-old/rename", { newSlug: "worker-control-new" });
    await verifyRename("worker-control-old", "worker-control-new", result);
  });

  it("CLI performs one explicit rename, returns the real deadline and leaves local mappings untouched", async () => {
    const before = await snapshot(home);
    wire.length = 0;
    let stdout = "";
    let stderr = "";
    let prompts = 0;
    const io: Io = {
      cwd: home, env: { KOFRA_API: api, KOFRA_API_KEY: ownerKey, KOFRA_CONFIG_DIR: join(home, "config") },
      stdout: text => void (stdout += text), stderr: text => void (stderr += text),
      stdinIsTTY: false, stderrIsTTY: false,
      prompt: async () => { prompts++; throw new Error("rename must never prompt"); },
      readStdin: async () => { prompts++; throw new Error("rename must not read stdin"); },
      fetch: async req => {
        const url = new URL(req.url);
        expect(url.origin).toBe(api);
        expect(req.method).toBe("POST");
        expect(url.pathname).toBe("/api/v1/sites/worker-cli-old/rename");
        expect(wire).toHaveLength(0);
        // Capture before fetch: Node fetch consumes the Request body, so req.clone() after would throw TypeError: unusable.
        const body = await req.clone().json();
        const res = await fetch(req, { redirect: "manual" });
        wire.push({ method: req.method, path: url.pathname, body, response: await res.clone().json() });
        return res;
      },
    };
    const code = await run(["rename", "worker-cli-old", "worker-cli-new", "--yes", "--json"], io);
    expect(await snapshot(home), "CLI must not change local links or credentials").toEqual(before);
    expect(prompts).toBe(0);
    for (const secret of [BOOTSTRAP, PASSWORD, ownerKey]) expect(stdout + stderr).not.toContain(secret);
    expect(code, stdout + stderr).toBe(0);
    expect(wire).toHaveLength(1);
    expect(wire[0]!.body).toEqual({ newSlug: "worker-cli-new" });
    const result = JSON.parse(stdout);
    expect(result).toEqual({ ...wire[0]!.response, localLinksUpdated: false });
    await verifyRename("worker-cli-old", "worker-cli-new", result);
  });
});
