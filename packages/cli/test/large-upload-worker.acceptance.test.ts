/**
 * Real Node CLI -> loopback HTTP -> workerd/D1/R2/KV acceptance.
 * Generated files are written and downloads hashed in bounded chunks. The wire
 * tap observes metadata only; it must not clone/buffer any upload body.
 * Run: npm run test:cli -- test/large-upload-worker.acceptance.test.ts
 * Local emulation is NOT evidence for workers.dev ingress limits.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, type Io } from "../src/main.ts";
import { DropwayClient } from "../src/client.ts";
import { publish, type ProgressEvent } from "../src/publish.ts";

const MiB = 1024 * 1024;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const bootstrap = "large-upload-local-fixture-0123456789abcdef";
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let work = "";
let api = "";
let key = "";
let workerConfig = "";
let persistState = "";

async function launch() {
  worker = await unstable_startWorker({ config: workerConfig,
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist: persistState, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  api = (await worker.url).origin;
}

type Wire = { method: string; path: string; length: number | null };

async function generated(name: string, size: number, seed: number) {
  const dir = join(work, name);
  await mkdir(dir);
  const file = await open(join(dir, "data.bin"), "wx");
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(256 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + seed) % 256;
  try {
    for (let offset = 0; offset < size; offset += chunk.length) {
      const part = chunk.subarray(0, Math.min(chunk.length, size - offset));
      let written = 0;
      while (written < part.length) written += (await file.write(part, written, part.length - written)).bytesWritten;
      hash.update(part);
    }
  } finally { await file.close(); }
  return { dir, size, sha256: hash.digest("hex") };
}

async function download(url: string) {
  expect(new URL(url).origin).toBe(api);
  const res = await fetch(url, { redirect: "error" });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const hash = createHash("sha256");
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      hash.update(value);
    }
  } finally { reader.releaseLock(); }
  return { size, sha256: hash.digest("hex") };
}

async function cli(dir: string, slug: string, inject?: (req: Request, forward: () => Promise<Response>) => Promise<Response>) {
  let stdout = "";
  let stderr = "";
  const wire: Wire[] = [];
  const io: Io = {
    cwd: dir, env: { KOFRA_CONFIG_DIR: join(work, "config"), KOFRA_API: api, KOFRA_API_KEY: key },
    stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text),
    stdinIsTTY: false, stderrIsTTY: false,
    readStdin: async () => "", prompt: async () => { throw new Error("must not prompt"); },
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      expect(url.origin, "no production or external requests").toBe(api);
      const length = req.headers.get("Content-Length");
      wire.push({ method: req.method, path: url.pathname, length: length === null ? null : Number(length) });
      return inject ? inject(req, () => fetch(req)) : fetch(req);
    },
  };
  const code = await run(["publish", dir, "--site", slug, "--json", "--no-save", "--no-wait"], io);
  let json: any;
  try { json = JSON.parse(stdout); } catch { json = null; }
  expect(stdout, "stdout contains exactly one JSON result").toBe(`${JSON.stringify(json, null, 2)}\n`);
  expect(stdout + stderr).not.toContain(key);
  return { code, stdout, stderr, json, wire };
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "large-upload-acceptance-"));
  await mkdir(join(work, "config"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "large-upload-local-acceptance", main: join(root, "packages/cli/test/fixtures/large-upload-worker.mjs"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "large-upload-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "large-upload-acceptance-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  const wrangler = join(dirname(fileURLToPath(import.meta.resolve("wrangler/package.json"))), "bin/wrangler.js");
  await promisify(execFile)(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  workerConfig = config;
  persistState = persist;
  await launch();
  const res = await fetch(`${api}/api/v1/setup`, { method: "POST", headers: { Authorization: `Bearer ${bootstrap}`, "Content-Type": "application/json" }, body: JSON.stringify({ email: "large-fixture@example.test" }) });
  expect(res.status).toBe(201);
  key = ((await res.json()) as any).apiKey.key;
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
}, 120_000);

describe("CLI large-file upload through the actual Worker", () => {
  it("resumes acknowledged R2 parts after the local Worker process is disposed and restarted", async () => {
    const data = Buffer.from("durably acknowledged multipart bytes");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const request = async (path: string, method = "GET", body?: RequestInit["body"], token = key) => {
      const res = await fetch(`${api}${path}`, { method, body, headers: {
        Authorization: `Bearer ${token}`, "Content-Type": method === "PUT" ? "application/octet-stream" : "application/json",
      } });
      const value = await res.json() as any;
      expect(res.ok, JSON.stringify(value)).toBe(true);
      return value;
    };
    const p = await request("/api/v1/publish", "POST", JSON.stringify({ site: "restart-session", files: [{ path: "data.bin", sha256, size: data.length }] }));
    expect(p.status).toBe("awaiting_upload");
    const s = await request("/api/v1/uploads", "POST", JSON.stringify({ versionId: p.version.id, sha256, partSize: 10 * MiB }));
    await request(`/api/v1/uploads/${s.id}/parts/1`, "PUT", data);
    await worker!.dispose();
    worker = undefined;
    await launch();
    // No byte resubmission after restart. Process-local session/part maps cannot pass.
    const resumed = await request(`/api/v1/uploads/${s.id}`);
    expect(resumed.parts).toEqual([expect.objectContaining({ partNumber: 1, size: data.length })]);
    const verified = await request(`/api/v1/uploads/${s.id}/complete`, "POST", "{}");
    expect(verified).toMatchObject({ sha256, size: data.length });
    await request(`/api/v1/sites/restart-session/deploys/${p.version.id}/finalize`, "POST");
    expect(await download(`${api}/s/restart-session/data.bin?raw=1`)).toEqual({ size: data.length, sha256 });
  }, 120_000);

  it("keeps file progress monotonic and dedupe lazy across a multipart retry", async () => {
    const file = await generated("protocol-progress", 95 * MiB + 2, 4);
    const events: ProgressEvent[] = [];
    let attempts = 0;
    let bodyCalls = 0;
    const client = new DropwayClient({ api, token: key, backoffMs: 1, fetch: async (req) => {
      expect(new URL(req.url).origin).toBe(api);
      if (req.method === "PUT" && new URL(req.url).pathname.includes("/parts/") && attempts++ === 0) {
        await req.body?.cancel();
        return new Response("retry this part", { status: 503 });
      }
      return fetch(req);
    } });
    const source = { path: "data.bin", size: file.size, sha256: file.sha256, body: async () => { bodyCalls++; return openAsBlob(join(file.dir, "data.bin")); } };
    const out = await publish(client, [source], { site: "multipart-progress", onProgress: (event) => events.push(event) });
    expect(out).toMatchObject({ uploaded: 1, bytesUploaded: file.size });
    expect(attempts, "the real multipart request must actually be retried").toBeGreaterThan(1);
    const uploads = events.filter((e): e is Extract<ProgressEvent, { phase: "upload" }> => e.phase === "upload");
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads.at(-1)).toMatchObject({ done: 1, total: 1, bytes: file.size, totalBytes: file.size });
    let previous = 0;
    for (const event of uploads) {
      expect(event.bytes).toBeGreaterThanOrEqual(previous);
      expect(event.bytes).toBeLessThanOrEqual(file.size);
      previous = event.bytes;
    }
    const reads = bodyCalls;
    expect((await publish(client, [source], { site: "multipart-progress-copy" })).reused).toBe(1);
    expect(bodyCalls, "dedupe must not reopen the large body").toBe(reads);
  }, 180_000);

  it.each([
    { name: "exact-boundary", size: 95 * MiB, multipart: false },
    { name: "above-boundary", size: 95 * MiB + 1, multipart: true },
  ])("$name selects the correct transport at $size bytes", async ({ name, size, multipart }) => {
    const file = await generated(name, size, multipart ? 2 : 1);
    const result = await cli(file.dir, `large-${name}`);
    const starts = result.wire.filter((r) => r.method === "POST" && r.path === "/api/v1/uploads");
    const raw = result.wire.filter((r) => r.method === "PUT" && r.path.startsWith("/api/v1/blobs/"));
    if (multipart) {
      expect(starts, result.stdout + result.stderr).toHaveLength(1);
      expect(raw).toEqual([]);
    } else {
      expect(starts).toEqual([]);
      expect(raw).toHaveLength(1);
      // Node adds Content-Length when sending the Request; the pre-fetch tap
      // must not buffer a body just to reproduce that transport behavior.
    }
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.json).toMatchObject({ ok: true, uploaded: 1, reused: 0 });
    expect(await download(new URL("data.bin?raw=1", result.json.url).href)).toEqual({ size, sha256: file.sha256 });
  }, 180_000);

  it("round-trips 157286400 generated bytes with part retry, finalize recovery and owner dedupe", async () => {
    const file = await generated("generated-150-mib", 150 * MiB, 3);
    let partFailures = 0;
    let lostFinalize = 0;
    const result = await cli(file.dir, "large-generated-roundtrip", async (req, forward) => {
      if (/\/uploads\/[^/]+\/parts\/\d+$/.test(new URL(req.url).pathname) && partFailures++ === 0) {
        await req.body?.cancel();
        return new Response("temporary local fixture failure", { status: 503 });
      }
      const res = await forward();
      if (req.method === "POST" && req.url.endsWith("/finalize") && res.ok && lostFinalize++ === 0) {
        await res.body?.cancel();
        return new Response("lost finalize acknowledgement", { status: 503 });
      }
      return res;
    });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.json).toMatchObject({ ok: true, files: 1, uploaded: 1, reused: 0 });
    expect(await download(new URL("data.bin?raw=1", result.json.url).href)).toEqual({ size: 157_286_400, sha256: file.sha256 });
    expect(partFailures, "successful bytes alone do not prove the multipart protocol was used").toBeGreaterThan(1);
    expect(lostFinalize).toBeGreaterThan(1);
    const parts = result.wire.filter((r) => r.method === "PUT" && r.path.includes("/parts/"));
    expect(parts.length).toBeGreaterThanOrEqual(3);
    // Bounds/Content-Length are validated by the actual part endpoint. A
    // metadata-only pre-fetch tap cannot observe Node's synthesized headers.
    expect(new Set(parts.map((p) => p.path)).size).toBeGreaterThanOrEqual(2);
    expect(result.wire.some((r) => r.path.startsWith("/api/v1/blobs/") && r.method === "PUT")).toBe(false);
    expect(await download(new URL("data.bin?raw=1", result.json.url).href)).toEqual({ size: 157_286_400, sha256: file.sha256 });
    const duplicate = await cli(file.dir, "large-generated-copy");
    expect(duplicate.code, duplicate.stdout + duplicate.stderr).toBe(0);
    expect(duplicate.json).toMatchObject({ ok: true, uploaded: 0, reused: 1 });
    expect(duplicate.wire.filter((r) => r.method === "PUT" || r.path === "/api/v1/uploads")).toEqual([]);
    expect(await download(new URL("data.bin?raw=1", duplicate.json.url).href)).toEqual({ size: file.size, sha256: file.sha256 });
  }, 240_000);
});
