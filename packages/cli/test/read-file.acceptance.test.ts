/**
 * Independent bounded-read contract, exercised through the real CLI and a local
 * Worker with disposable D1/R2/KV. No production read/encoding/hash helpers.
 *
 * Run: npm ci --include=dev
 *      npm run test:cli -- test/read-file.acceptance.test.ts
 *
 * Human-output convention: stdout is the API's content string, byte-for-byte
 * (base64 stays base64, no added newline). Encoding and continuation notes belong
 * on stderr. This makes redirection safe; --json preserves the entire API page.
 * The builder must document that convention in the CLI guide.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, type Io } from "../src/main.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const slug = "bounded-read-fixture";
const textPath = "docs/résumé #1.txt";
const oldText = "Historical page: café ☃\r\nno final newline";
const text = "Live page: café ☃ / 日本語\r\nno final newline";
const binary = Buffer.from([0, 255, 128, 1, 10, 13, 34, 92, 127, 195, 40, 254]);
const large = Buffer.alloc(1_048_576 + 19, 97);
const bootstrap = "bounded-read-local-bootstrap-0123456789abcdef";
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type Wire = { method: string; url: URL; body?: any };
type Ran = { code: number; stdout: string; stderr: string; wire: Wire[]; prompts: number };
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let proxy: Server | undefined;
let work: string;
let home: string;
let api: string;
let cliApi: string;
let ownerKey: string;
let noReadKey: string;
let readerKey: string;
let firstVersion: string;
let liveVersion: string;
let bundle: string;
let observed: Wire[] = [];
let violations: string[] = [];

function fixtureUrl(path: string, origin: string) {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\x00-\x20\x7f#]/.test(path)) {
    throw new Error("fixture requires an origin-relative path and query");
  }
  // Assign only path/query: request input can never replace the fixture authority.
  const url = new URL(origin);
  const query = path.indexOf("?");
  url.pathname = query < 0 ? path : path.slice(0, query);
  url.search = query < 0 ? "" : path.slice(query);
  return url;
}

async function request(path: string, init: RequestInit = {}, key = ownerKey) {
  const url = fixtureUrl(path, api);
  const headers = new Headers(init.headers);
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return fetch(url, { ...init, headers, redirect: "error" });
}

async function publish(content: string) {
  const body = new FormData();
  body.set("slug", slug);
  for (const [path, bytes, type] of [
    [textPath, Buffer.from(content), "text/plain; charset=utf-8"],
    ["bytes.bin", binary, "application/octet-stream"],
    ["large.txt", large, "text/plain"],
    ["empty.txt", Buffer.alloc(0), "text/plain"],
  ] as const) {
    body.set(path, new File([new Uint8Array(bytes)], path.split("/").pop()!, { type }));
  }
  const res = await request("/api/v1/publish", { method: "POST", body });
  expect(res.ok, `local fixture publish HTTP ${res.status}`).toBe(true);
  const result = await res.json() as any;
  expect(result.version.id).toEqual(expect.any(String));
  return result.version.id as string;
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "read-file-acceptance-"));
  home = join(work, "client");
  await mkdir(join(home, "config"), { recursive: true });
  // Existing configuration and unrelated files must survive every read unchanged.
  await writeFile(join(home, "dropway.json"), JSON.stringify({ sites: { untouched: "keep-me" } }));
  await writeFile(join(home, "config", "credentials.json"), JSON.stringify({ instances: {} }), { mode: 0o600 });
  await writeFile(join(home, "untouched.txt"), "keep these bytes\n");
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-read-file-acceptance", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "read-file-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "read-file-acceptance-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  const wrangler = join(dirname(fileURLToPath(import.meta.resolve("wrangler/package.json"))), "bin/wrangler.js");
  await promisify(execFile)(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config,
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  api = (await worker.url).origin;
  const setup = await request("/api/v1/setup", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "read-fixture@example.com" }),
  }, bootstrap);
  expect(setup.status).toBe(201);
  ownerKey = ((await setup.json()) as any).apiKey.key;
  firstVersion = await publish(oldText);
  liveVersion = await publish(text);
  expect(firstVersion === liveVersion, "fixture must contain two immutable versions").toBe(false);
  for (const scopes of [["keys:write"], ["sites:read"]]) {
    const res = await request("/api/v1/keys", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scopes }),
    });
    expect(res.ok).toBe(true);
    const key = ((await res.json()) as any).key;
    expect(typeof key === "string", "fixture key must exist").toBe(true);
    if (scopes[0] === "sites:read") readerKey = key;
    else noReadKey = key;
  }
  // Even the process smoke test can reach only GETs on the disposable Worker.
  // Seed/setup above deliberately bypass this read-only invocation transport.
  proxy = createServer(async (incoming, outgoing) => {
    if (incoming.method !== "GET") {
      violations.push("non-GET request");
      outgoing.writeHead(405).end();
      return;
    }
    let url: URL;
    try { url = fixtureUrl(incoming.url ?? "", cliApi); } catch {
      outgoing.writeHead(400).end();
      return;
    }
    const wire: Wire = { method: incoming.method, url };
    observed.push(wire);
    try {
      const res = await request(url.pathname + url.search, { headers: incoming.headers as Record<string, string> }, "");
      const bytes = Buffer.from(await res.arrayBuffer());
      try { wire.body = JSON.parse(bytes.toString("utf8")); } catch { /* non-JSON help probes remain observable */ }
      outgoing.writeHead(res.status, { "Content-Type": res.headers.get("Content-Type") ?? "application/json" });
      outgoing.end(bytes);
    } catch {
      violations.push("local forwarding failed");
      outgoing.writeHead(502).end();
    }
  });
  await new Promise<void>(resolve => proxy!.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("local proxy has no port");
  cliApi = `http://127.0.0.1:${address.port}`;
  bundle = join(work, "bundle", "kofra.mjs");
  await build({ entryPoints: [join(root, "packages/cli/src/cli.ts")], bundle: true, platform: "node", format: "esm", target: "node20", outfile: bundle, logLevel: "silent" });
}, 120_000);

afterAll(async () => {
  if (proxy) await new Promise<void>((resolve, reject) => proxy!.close(error => error ? reject(error) : resolve()));
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function snapshot(dir = home): Promise<Record<string, string>> {
  const metadata = (info: { mode: bigint; mtimeNs: bigint; ctimeNs: bigint }) => `${info.mode}:${info.mtimeNs}:${info.ctimeNs}`;
  const directory = await stat(dir, { bigint: true });
  const result: Record<string, string> = { ".": metadata(directory) };
  for (const entry of (await readdir(dir)).sort()) {
    const path = join(dir, entry);
    const info = await stat(path, { bigint: true });
    if (info.isDirectory()) {
      for (const [nested, value] of Object.entries(await snapshot(path))) result[`${entry}/${nested}`] = value;
    } else result[entry] = `${metadata(info)}:${(await readFile(path)).toString("base64")}`;
  }
  return result;
}

function assertNoSecrets(output: string) {
  for (const secret of [bootstrap, ownerKey, readerKey, noReadKey]) {
    expect(output.includes(secret), "credential values must not appear in output").toBe(false);
  }
}

async function cli(args: string[], opts: { key?: string; legacy?: boolean } = {}): Promise<Ran> {
  const before = await snapshot();
  observed = [];
  violations = [];
  let stdout = "";
  let stderr = "";
  let prompts = 0;
  const io: Io = {
    cwd: home,
    env: { KOFRA_API: cliApi, KOFRA_API_KEY: opts.key ?? readerKey, KOFRA_CONFIG_DIR: join(home, "config"), HOME: home },
    stdout: t => void (stdout += t), stderr: t => void (stderr += t),
    stdinIsTTY: false, stderrIsTTY: false,
    readStdin: async () => { prompts++; throw new Error("read-file must not consume stdin"); },
    prompt: async () => { prompts++; throw new Error("read-file must not prompt"); },
    fetch: async req => {
      const url = new URL(req.url);
      if (url.origin !== cliApi || req.method !== "GET" || (!opts.legacy && url.pathname !== "/api/v1/read-file") || (!opts.legacy && observed.length > 0)) {
        violations.push("read must make at most one GET to the existing local read-file operation");
        throw new Error("read-only transport refused request");
      }
      return fetch(req);
    },
  };
  const code = await run(args, io);
  expect(violations, "transport sentinel").toEqual([]);
  expect(await snapshot(), "read-only commands must not write local config or project files").toEqual(before);
  expect(prompts, "non-TTY reads must not prompt").toBe(0);
  assertNoSecrets(stdout + stderr);
  return { code, stdout, stderr, wire: [...observed], prompts };
}

function object(r: Ran) {
  // Parsing all stdout rejects banners, progress, JSONL and trailing notes.
  let parsed: any;
  try { parsed = JSON.parse(r.stdout); } catch { throw new Error(`stdout must be exactly one JSON object (exit ${r.code}): ${r.stdout}`); }
  expect(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)).toBe(true);
  return parsed;
}

async function read(path: string, flags: string[] = [], opts: { key?: string } = {}) {
  return cli(["read-file", slug, path, ...flags, "--json"], opts);
}

function page(r: Ran, expected: Record<string, unknown>) {
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.wire).toHaveLength(1);
  const request = r.wire[0]!;
  expect(request.method).toBe("GET");
  expect(request.url.pathname).toBe("/api/v1/read-file");
  const result = object(r);
  expect(result).toMatchObject(expected);
  expect(result, "JSON must retain every API page field without re-encoding content").toMatchObject(request.body);
  return result;
}

describe("bounded read fixture origin boundary", () => {
  it("rejects unsafe URL references before the fixture helper can contact another origin", async () => {
    let contacts = 0;
    const trap = createServer((_incoming, outgoing) => { contacts++; outgoing.end("escaped"); });
    await new Promise<void>(resolve => trap.listen(0, "127.0.0.1", resolve));
    try {
      const address = trap.address();
      if (!address || typeof address === "string") throw new Error("local trap has no port");
      const authority = `127.0.0.1:${address.port}`;
      for (const path of [
        `http://${authority}/escape`, `//${authority}/escape`, `/\\${authority}/escape`,
        `${api}/api/v1/read-file`, "relative", "", "?path=bytes.bin", "/#fragment", "/\t/read-file",
      ]) {
        await expect(request(path, {}, "")).rejects.toThrow("origin-relative");
      }
      expect(contacts, "unsafe references must not reach even a loopback trap").toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => trap.close(error => error ? reject(error) : resolve()));
    }
  });

  it("rejects unsafe raw proxy targets instead of normalizing them into forwarded requests", async () => {
    observed = [];
    violations = [];
    const port = new URL(cliApi).port;
    for (const path of [
      `${cliApi}/api/v1/read-file`, `//127.0.0.1:${port}/api/v1/read-file`,
      `/\\127.0.0.1:${port}/api/v1/read-file`, "/#fragment",
    ]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest({ hostname: "127.0.0.1", port, path, method: "GET" }, res => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.end();
      });
      expect(status, "unsafe request target must be refused before forwarding").toBe(400);
    }
    expect(observed, "no unsafe target enters the CLI request log").toEqual([]);
    expect(violations).toEqual([]);
  });
});

describe("bounded read-file CLI acceptance", () => {
  it("keeps the legacy files command a listing, not a content reader", async () => {
    const r = await cli(["files", slug, "--json"], { legacy: true });
    expect(r.code).toBe(0);
    expect(object(r).files.map((f: any) => f.path).sort()).toEqual(["bytes.bin", textPath, "empty.txt", "large.txt"].sort());
    expect(r.wire.every(w => !w.url.pathname.endsWith("read-file"))).toBe(true);
  });

  it("keeps generic api GET working as a control for CLI transport and JSON receipts", async () => {
    const query = new URLSearchParams({ site: slug, path: "bytes.bin", encoding: "base64" });
    page(await cli(["api", "GET", `/read-file?${query}`, "--json"]), {
      path: "bytes.bin", content: "AP+AAQoNIlx/wyj+", encoding: "base64", versionId: liveVersion,
      sha256: digest(binary), size: 12, offset: 0, length: 12, truncated: false, nextOffset: null,
    });
  });

  it("establishes the unchanged API fixture's text, hash and historical page independently", async () => {
    const query = new URLSearchParams({ site: slug, path: textPath, version: "v1" });
    const res = await request(`/api/v1/read-file?${query}`, {}, readerKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      path: textPath, versionId: firstVersion, content: oldText, encoding: "text", sha256: digest(oldText),
      size: Buffer.byteLength(oldText), offset: 0, length: Buffer.byteLength(oldText), truncated: false, nextOffset: null,
    });
  });

  it.each([
    { name: "binary auto", path: "bytes.bin", params: {}, expected: { content: "AP+AAQoNIlx/wyj+", encoding: "base64", size: 12, sha256: digest(binary), nextOffset: null } },
    { name: "binary byte slice", path: "bytes.bin", params: { offset: "2", length: "10", encoding: "base64" }, expected: { content: "gAEKDSJcf8Mo/g==", offset: 2, length: 10, nextOffset: null } },
    { name: "default page", path: "large.txt", params: {}, expected: { content: "a".repeat(65_536), offset: 0, length: 65_536, truncated: true, nextOffset: 65_536, sha256: digest(large) } },
    { name: "maximum page", path: "large.txt", params: { length: "1048576" }, expected: { content: "a".repeat(1_048_576), length: 1_048_576, truncated: true, nextOffset: 1_048_576 } },
    { name: "empty file", path: "empty.txt", params: {}, expected: { content: "", size: 0, length: 0, offset: 0, nextOffset: null, sha256: digest("") } },
  ])("checks the real API fixture receipt for $name before relying on the CLI", async ({ path, params, expected }) => {
    const query = new URLSearchParams({ site: slug, path });
    for (const [key, value] of Object.entries(params)) query.set(key, value);
    const res = await request(`/api/v1/read-file?${query}`, {}, readerKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject(expected);
  });

  it.each([
    { name: "missing file", path: "missing.txt", version: "live", keyKind: "reader", status: 404 },
    { name: "missing version", path: textPath, version: "v99999", keyKind: "reader", status: 404 },
    { name: "missing scope", path: textPath, version: "live", keyKind: "restricted", status: 403 },
    { name: "invalid key", path: textPath, version: "live", keyKind: "invalid", status: 401 },
  ])("checks the real API fixture's $name error without the new command", async ({ path, version, keyKind, status }) => {
    const query = new URLSearchParams({ site: slug, path, version });
    const key = keyKind === "restricted" ? noReadKey : keyKind === "invalid" ? "dw_invalid_local_fixture_key" : readerKey;
    const res = await request(`/api/v1/read-file?${query}`, {}, key);
    expect(res.status).toBe(status);
    const result = await res.json() as any;
    expect(result.error.code).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(result.error.hint.trim().length).toBeGreaterThan(0);
  });

  it("preserves UTF-8, CRLF, path escaping and whole-file hash in one live JSON page", async () => {
    const r = await read(textPath);
    page(r, { path: textPath, content: text, encoding: "text", versionId: liveVersion, size: Buffer.byteLength(text), sha256: digest(text), offset: 0, length: Buffer.byteLength(text), truncated: false, nextOffset: null });
    expect(r.wire[0]!.url.searchParams.get("path")).toBe(textPath);
    expect(r.wire[0]!.url.searchParams.get("site")).toBe(slug);
  });

  it("returns binary as base64 by default without lossy UTF-8 conversion", async () => {
    const r = await read("bytes.bin");
    const result = page(r, { content: "AP+AAQoNIlx/wyj+", encoding: "base64", size: 12, sha256: digest(binary), truncated: false, nextOffset: null });
    expect(Buffer.from(result.content, "base64")).toEqual(binary);
  });

  it("forwards explicit text encoding rather than deciding from the filename", async () => {
    const r = await read(textPath, ["--encoding", "text"]);
    page(r, { content: text, encoding: "text" });
    expect(r.wire[0]!.url.searchParams.get("encoding")).toBe("text");
  });

  it("forwards explicit auto encoding without stripping the request option", async () => {
    const r = await read("bytes.bin", ["--encoding", "auto"]);
    page(r, { content: "AP+AAQoNIlx/wyj+", encoding: "base64" });
    expect(r.wire[0]!.url.searchParams.get("encoding")).toBe("auto");
  });

  it("can request UTF-8 bytes as base64 without re-encoding the API content", async () => {
    const r = await read(textPath, ["--encoding", "base64"]);
    const result = page(r, { encoding: "base64", content: Buffer.from(text).toString("base64"), sha256: digest(text) });
    expect(Buffer.from(result.content, "base64")).toEqual(Buffer.from(text));
    expect(r.wire[0]!.url.searchParams.get("encoding")).toBe("base64");
  });

  it("uses the default 64 KiB page and never auto-fetches the rest", async () => {
    const r = await read("large.txt");
    page(r, { content: "a".repeat(65_536), encoding: "text", size: large.length, sha256: digest(large), offset: 0, length: 65_536, truncated: true, nextOffset: 65_536 });
  });

  it("accepts the maximum 1 MiB length as one bounded page", async () => {
    const r = await read("large.txt", ["--offset", "0", "--length", "1048576"]);
    page(r, { content: "a".repeat(1_048_576), offset: 0, length: 1_048_576, truncated: true, nextOffset: 1_048_576, sha256: digest(large) });
    expect(r.wire[0]!.url.searchParams.get("length")).toBe("1048576");
    expect(r.wire[0]!.url.searchParams.get("offset")).toBe("0");
  });

  it("honors byte offsets, minimum length, continuation and final null nextOffset", async () => {
    const first = await read("bytes.bin", ["--offset", "1", "--length", "1", "--encoding", "base64"]);
    const a = page(first, { content: "/w==", offset: 1, length: 1, nextOffset: 2, truncated: true, size: 12, sha256: digest(binary) });
    expect(first.wire[0]!.url.searchParams.get("offset")).toBe("1");
    expect(first.wire[0]!.url.searchParams.get("length")).toBe("1");
    const second = await read("bytes.bin", ["--offset", String(a.nextOffset), "--length", "10", "--encoding", "base64"]);
    const b = page(second, { content: "gAEKDSJcf8Mo/g==", offset: 2, length: 10, nextOffset: null, truncated: false, sha256: digest(binary) });
    expect(Buffer.concat([binary.subarray(0, 1), Buffer.from(a.content, "base64"), Buffer.from(b.content, "base64")])).toEqual(binary);
  });

  it("preserves an empty file as an empty successful page", async () => {
    page(await read("empty.txt"), { content: "", size: 0, length: 0, offset: 0, truncated: false, nextOffset: null, sha256: digest("") });
  });

  it.each(["v1", "1", "id", "live"])("passes version reference %s straight to read-file without any versions scan", async ref => {
    const value = ref === "id" ? firstVersion : ref;
    const r = await read(textPath, ["--version", value]);
    page(r, { versionId: ref === "live" ? liveVersion : firstVersion, content: ref === "live" ? text : oldText });
    expect(r.wire[0]!.url.searchParams.get("version")).toBe(value);
  });

  it.each([
    ["missing file", "missing.txt", [], "reader", 4],
    ["missing version", textPath, ["--version", "v99999"], "reader", 4],
    ["missing read scope", textPath, [], "restricted", 3],
    ["invalid key", textPath, [], "invalid", 3],
  ] as const)("retains stable server code and next-action hint for %s", async (_name, path, flags, keyKind, exit) => {
    const key = keyKind === "restricted" ? noReadKey : keyKind === "invalid" ? "dw_invalid_local_fixture_key" : readerKey;
    const r = await read(path, [...flags], { key });
    expect(r.code).toBe(exit);
    expect(r.wire).toHaveLength(1);
    const result = object(r);
    expect(result.ok).toBe(false);
    expect(result.error.code).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(result.error.code).toBe(r.wire[0]!.body.error.code);
    expect(result.error.hint).toBe(r.wire[0]!.body.error.hint);
    expect(result.error.hint.trim().length).toBeGreaterThan(0);
    expect(result.error.status).toBe(exit === 4 ? 404 : keyKind === "restricted" ? 403 : 401);
    expect(result.exitCode).toBe(exit);
    expect(r.stdout.includes(key), "a rejected key must not be echoed").toBe(false);
  });

  it.each([
    ["negative offset", ["--offset", "-1"]],
    ["fractional offset", ["--offset", "0.5"]],
    ["NaN offset", ["--offset", "NaN"]],
    ["infinite offset", ["--offset", "Infinity"]],
    ["unsafe offset", ["--offset", "9007199254740992"]],
    ["partial numeric offset", ["--offset", "1garbage"]],
    ["zero length", ["--length", "0"]],
    ["negative length", ["--length", "-1"]],
    ["fractional length", ["--length", "1.5"]],
    ["NaN length", ["--length", "NaN"]],
    ["infinite length", ["--length", "Infinity"]],
    ["over-limit length", ["--length", "1048577"]],
    ["partial numeric length", ["--length", "8bytes"]],
    ["invalid encoding", ["--encoding", "utf8"]],
    ["unknown flag", ["--lenght", "8"]],
    ["extra positional", ["unexpected.txt"]],
    ["missing offset value", ["--offset"]],
    ["missing length value", ["--length"]],
    ["missing version value", ["--version"]],
    ["missing encoding value", ["--encoding"]],
  ])("rejects %s locally with one stable JSON error and no request", async (_name, flags) => {
    const args = ["read-file", slug, textPath, ...flags, "--json"];
    const first = await cli(args);
    const again = await cli(args);
    expect(first.wire).toEqual([]);
    expect(again.wire).toEqual([]);
    expect(first.code).toBe(2);
    expect(again.code).toBe(2);
    const a = object(first);
    const b = object(again);
    expect(a).toMatchObject({ ok: false, exitCode: 2, error: { code: expect.stringMatching(/^[a-z][a-z0-9_]*$/), hint: expect.any(String) } });
    expect(a.error.code, "the read-file command must be recognized before argument validation").not.toBe("unknown_command");
    expect(a.error.hint.trim().length).toBeGreaterThan(0);
    expect(b.error.code).toBe(a.error.code);
    expect(b.error.hint).toBe(a.error.hint);
  });

  it.each([["read-file"], ["read-file", slug]])("rejects missing required positionals %j before any request", async (...args) => {
    const r = await cli([...args, "--json"]);
    expect(r.wire).toEqual([]);
    expect(r.code).toBe(2);
    const result = object(r);
    expect(result.ok).toBe(false);
    expect(result.error.code).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(result.error.code, "required-positionals validation must not be an unknown-command error").not.toBe("unknown_command");
    expect(result.error.hint.trim().length).toBeGreaterThan(0);
  });

  it.each(["text", "base64"])("keeps human %s content untouched on stdout and pagination notes on stderr", async encoding => {
    const r = await cli(["read-file", slug, "large.txt", "--offset", "2", "--length", "3", "--encoding", encoding]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toHaveLength(1);
    expect(r.stdout).toBe(encoding === "text" ? "aaa" : "YWFh");
    expect(r.stderr).toContain(encoding);
    expect(r.stderr).toMatch(/(?:next|continu|truncat|--offset)/i);
    expect(r.stderr).toMatch(/\b5\b/);
  });

  it.each([["help", "read-file"], ["read-file", "--help"]])("discovers the command's arguments and bounds without network via %j", async (...args) => {
    const r = await cli(args);
    expect(r.code).toBe(0);
    expect(r.wire).toEqual([]);
    expect(r.stdout).toContain("read-file");
    for (const flag of ["--version", "--offset", "--length", "--encoding", "--json"]) expect(r.stdout).toContain(flag);
    for (const value of ["auto", "text", "base64"]) expect(r.stdout).toContain(value);
    expect(r.stdout).toMatch(/(?:65536|65,536|64\s*(?:KiB|KB))/i);
    expect(r.stdout).toMatch(/(?:1048576|1,048,576|1\s*(?:MiB|MB))/i);
  });

  it("advertises read-file alongside existing commands in global help", async () => {
    const r = await cli(["help"]);
    expect(r.code).toBe(0);
    expect(r.wire).toEqual([]);
    for (const command of ["read-file", "files", "versions", "restore", "publish", "api"]) expect(r.stdout).toContain(command);
  });

  it("runs the bundled CLI as a non-TTY process with exactly one JSON page and no config writes", async () => {
    const before = await snapshot();
    observed = [];
    violations = [];
    const result = await promisify(execFile)(process.execPath, [bundle, "read-file", slug, "bytes.bin", "--encoding", "base64", "--json"], {
      cwd: home, timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: home, KOFRA_CONFIG_DIR: join(home, "config"), KOFRA_API: cliApi, KOFRA_API_KEY: readerKey },
    }).then(r => ({ code: 0, stdout: r.stdout, stderr: r.stderr }), (e: any) => ({ code: typeof e.code === "number" ? e.code : -1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }));
    assertNoSecrets(result.stdout + result.stderr);
    expect(violations).toEqual([]);
    expect(await snapshot()).toEqual(before);
    page({ ...result, wire: [...observed], prompts: 0 }, { content: "AP+AAQoNIlx/wyj+", encoding: "base64", versionId: liveVersion, sha256: digest(binary) });
  });
});
