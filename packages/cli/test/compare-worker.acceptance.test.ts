/**
 * Compare against an actual disposable Worker/D1/R2/KV, not a production API.
 * Fixture setup may publish locally. The CLI transport is strictly GET-only,
 * allows only version resolution + raw manifest, and never forwards byte URLs.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, type Io } from "../src/main.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const SITE = "compare-worker-fixture";
const bootstrap = "compare-local-bootstrap-synthetic-0123456789abcdef";
let work: string;
let cwd: string;
let api: string;
let owner: string;
let reader: string;
let wrongScope: string;
let v1: string;
let v2: string;
let pending: string;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;

async function request(path: string, body?: unknown, key = owner) {
  // No absolute/authority input can escape the disposable fixture origin.
  if (!path.startsWith("/api/v1/") || path.includes("\\") || /[\x00-\x20#]/.test(path)) throw new Error("Invalid fixture path");
  const url = new URL(api);
  const query = path.indexOf("?");
  url.pathname = query < 0 ? path : path.slice(0, query);
  url.search = query < 0 ? "" : path.slice(query);
  return fetch(url, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function publish(text: string) {
  const res = await request("/api/v1/publish", { slug: SITE, files: [
    { path: "a.txt", content: text }, { path: "b.txt", content: "bravo" }, { path: "empty.txt", content: "" },
  ] });
  expect(res.ok, `fixture publish HTTP ${res.status}`).toBe(true);
  const body = await res.json() as any;
  expect(body.version.id).toEqual(expect.any(String));
  return body.version.id as string;
}
beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "compare-worker-"));
  cwd = join(work, "home");
  await mkdir(join(cwd, "config"), { recursive: true });
  await mkdir(join(cwd, "dist"));
  for (const [path, text] of Object.entries({ "a.txt": "alpha", "b.txt": "bravo", "empty.txt": "" })) await writeFile(join(cwd, "dist", path), text);
  await writeFile(join(cwd, "dropway.json"), JSON.stringify({ sites: { dist: "stale-site" } }));
  await writeFile(join(cwd, "config", "credentials.json"), JSON.stringify({ instances: {} }), { mode: 0o600 });
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-compare-acceptance", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "compare-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "compare-acceptance-files" }], kv_namespaces: [{ binding: "CACHE" }],
  }));
  const wrangler = join(dirname(fileURLToPath(import.meta.resolve("wrangler/package.json"))), "bin/wrangler.js");
  await promisify(execFile)(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--local", "--config", config, "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({ config,
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  api = (await worker.url).origin;
  const setup = await request("/api/v1/setup", { email: "compare-fixture@example.test" }, bootstrap);
  expect(setup.status).toBe(201);
  owner = ((await setup.json()) as any).apiKey.key;
  v1 = await publish("alpha");
  v2 = await publish("ALPHA");
  expect(v1).not.toBe(v2);
  for (const scopes of [["sites:read"], ["keys:write"]]) {
    const res = await request("/api/v1/keys", { scopes });
    expect(res.ok).toBe(true);
    const key = ((await res.json()) as any).key;
    if (scopes[0] === "sites:read") reader = key;
    else wrongScope = key;
  }
  expect((await request("/api/v1/sites", { slug: "compare-empty-fixture" })).status).toBe(201);
  const res = await request(`/api/v1/sites/${SITE}/versions`, { files: [{ path: "pending.txt", size: 9, sha256: createHash("sha256").update("not-ready").digest("hex") }] });
  expect(res.status).toBe(201);
  pending = ((await res.json()) as any).deploy.id;
}, 120_000);
afterAll(async () => {
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function snapshot(dir: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const s = await stat(path, { bigint: true });
    result.push([name, String(s.mode), String(s.mtimeNs), String(s.ctimeNs), s.isDirectory() ? await snapshot(path) : (await readFile(path)).toString("base64")]);
  }
  return result;
}
async function compare(flags: string[] = [], opts: { key?: string; site?: string; moveLive?: boolean } = {}) {
  const site = opts.site ?? SITE;
  const key = opts.key ?? reader;
  const before = await snapshot(cwd);
  const seen: { path: string; search: string }[] = [];
  const violations: string[] = [];
  let moved: string | undefined;
  let stdout = "";
  let stderr = "";
  const io: Io = {
    cwd, env: { HOME: cwd, KOFRA_CONFIG_DIR: join(cwd, "config"), KOFRA_API: api, KOFRA_API_KEY: key },
    stdout: t => void (stdout += t), stderr: t => void (stderr += t), stdinIsTTY: false, stderrIsTTY: false,
    readStdin: async () => { throw new Error("compare must not read stdin"); },
    prompt: async () => { throw new Error("compare must not prompt"); },
    fetch: async req => {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, search: url.search });
      const base = `/api/v1/sites/${site}`;
      if (url.origin !== api || req.method !== "GET" || seen.length > 2 || req.headers.has("Idempotency-Key") ||
          !(url.pathname === `${base}/versions` || url.pathname.startsWith(`${base}/versions/`) || url.pathname === `${base}/files`)) {
        violations.push(`${req.method} ${url.pathname}`);
        return new Response("{}", { status: 400 });
      }
      expect(req.headers.get("Authorization")).toBe(`Bearer ${key}`);
      const response = await fetch(req, { redirect: "error" });
      if (opts.moveLive && seen.length === 1) {
        // Change real local Worker state AFTER the resolution response is fixed.
        // This setup write is never reachable through the CLI transport.
        await response.clone().json();
        moved = await publish("omega");
      }
      return response;
    },
  };
  const code = await run(["compare", "dist", "--site", site, "--json", ...flags], io);
  expect(violations).toEqual([]);
  expect(await snapshot(cwd), "CLI must never write project files, mappings or credentials").toEqual(before);
  for (const value of [owner, reader, wrongScope, bootstrap]) expect(stdout + stderr).not.toContain(value);
  return { code, stdout, stderr, seen, moved };
}

describe("compare disposable Worker contract controls", () => {
  it("proves the existing raw REST manifest has complete SHA-256 metadata and historical identity", async () => {
    const res = await request(`/api/v1/sites/${SITE}/files?version=${v1}`, undefined, reader);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.version).toMatchObject({ id: v1, number: 1, status: "ready", fileCount: 3, totalBytes: 10 });
    expect(body.files).toHaveLength(3);
    expect(body.files.find((f: any) => f.path === "a.txt")).toMatchObject({ size: 5, sha256: "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8" });
    expect(body.nextCursor).toBeUndefined();
  });
  it("proves the existing read scope cannot be replaced with keys:write", async () => {
    expect((await request(`/api/v1/sites/${SITE}/versions?limit=500`, undefined, wrongScope)).status).toBe(403);
  });
});

describe("compare against real Worker manifests and existing controls", () => {
  it("compares the read-only key's historical v1 after v2 exists", async () => {
    const r = await compare(["--version", "v1"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body).toMatchObject({ ok: true, schemaVersion: 1, pinned: { versionId: v1, number: 1 }, counts: { changed: 0, unchanged: 3 }, records: [], truncated: false });
    expect(r.seen).toEqual([{ path: `/api/v1/sites/${SITE}/versions/v1`, search: "" }, { path: `/api/v1/sites/${SITE}/files`, search: `?version=${v1}` }]);
  });
  it.each([
    { name: "no live", site: "compare-empty-fixture", flags: [], code: "no_live_version", exit: 4 },
    { name: "pending", flags: ["--version", "pending"], code: "version_not_ready", exit: 4 },
    { name: "missing version", flags: ["--version", "v99"], code: "version_not_found", exit: 4 },
    { name: "wrong read scope", flags: [], code: "insufficient_scope", exit: 3 },
  ])("retains $name refusals without a manifest/content read", async scenario => {
    const flags = scenario.name === "pending" ? ["--version", pending] : scenario.flags;
    const r = await compare(flags, { site: scenario.site, key: scenario.name === "wrong read scope" ? wrongScope : reader });
    expect(r.code, r.stdout + r.stderr).toBe(scenario.exit);
    const body = JSON.parse(r.stdout);
    expect(body).toMatchObject({ ok: false, exitCode: scenario.exit, error: { code: scenario.code, hint: expect.any(String) } });
    expect(body.error.hint.trim().length).toBeGreaterThan(0);
    expect(r.seen).toHaveLength(1);
  });
  it("keeps v2 pinned when a real local publish moves live to v4 between the two reads", async () => {
    const r = await compare([], { moveLive: true });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.moved, "a real intervening publish is required, not just a static response").toEqual(expect.any(String));
    expect(r.moved).not.toBe(v2);
    const body = JSON.parse(r.stdout);
    expect(body.pinned).toMatchObject({ versionId: v2, number: 2, requestedRef: "live" });
    expect(body.counts).toMatchObject({ changed: 1, unchanged: 2 });
    expect(body.records[0]).toMatchObject({ class: "changed", path: "a.txt", localSha256: createHash("sha256").update("alpha").digest("hex"), remoteSha256: createHash("sha256").update("ALPHA").digest("hex") });
    expect(r.seen).toHaveLength(2);
    expect(r.seen[1]!.search).toBe(`?version=${v2}`);
  });
});
