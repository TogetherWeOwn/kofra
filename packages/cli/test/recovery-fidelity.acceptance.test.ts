import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliError, DropwayClient, errorFromResponse } from "../src/client.ts";

// Only the external HTTP boundary is a fixture; error conversion, serialization,
// process exits and generated shell continuations run through the real CLI.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const fields = { code: "version_conflict", message: "The live version moved.", hint: "Read the immutable base.", details: { liveVersionId: "ver_new" } };
const next = [{ tool: "get_version", args: { site: "sample", version: "ver_old" }, why: "Inspect before changing anything." }];
const token = "dw_disposable_recovery_token_sentinel";
const cookie = "disposable_recovery_cookie_sentinel";
const diskSecret = "disposable_recovery_filesystem_sentinel";
const recovery = { retryable: false, retryAfterSeconds: 0, docs: "https://never-follow.test/recovery", next };
let work: string;
let bundle: string;
let api: string;
let server: Server;
let respond: (url: URL) => { status?: number; body: unknown; raw?: boolean; headers?: Record<string, string> };
let seen: { method: string; url: URL }[] = [];

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "kofra-recovery-"));
  bundle = join(work, "cli.mjs");
  await mkdir(join(work, "config"));
  await writeFile(join(work, "config", "credentials.json"), JSON.stringify({ instances: {}, sentinel: diskSecret }), { mode: 0o600 });
  await mkdir(join(work, "bin"));
  await writeFile(join(work, "bin", "kofra"), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${bundle.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  await build({ entryPoints: [join(root, "packages/cli/src/cli.ts")], bundle: true, platform: "node", format: "esm", target: "node20", outfile: bundle, logLevel: "silent" });
  server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", api);
    seen.push({ method: incoming.method ?? "", url });
    incoming.resume();
    if (url.origin !== api || !url.pathname.startsWith("/api/v1/")) { outgoing.writeHead(400).end(); return; }
    const response = respond(url);
    outgoing.writeHead(response.status ?? 200, { "Content-Type": response.raw ? "text/html" : "application/json", "X-Request-Id": "header-request", "Set-Cookie": cookie, ...response.headers });
    outgoing.end(response.raw ? String(response.body) : JSON.stringify(response.body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local fixture did not bind");
  api = `http://127.0.0.1:${address.port}`;
  // A wrongly followed docs link is trapped locally and counted, never external.
  recovery.docs = `${api}/docs/recovery`;
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  if (work) await rm(work, { recursive: true, force: true });
});

async function processRun(command: string, args: string[]) {
  const before = await readFile(join(work, "config", "credentials.json"), "utf8");
  const result = await promisify(execFile)(command, args, { cwd: work, timeout: 10_000,
    env: { PATH: `${join(work, "bin")}:${process.env.PATH ?? ""}`, HOME: work, KOFRA_CONFIG_DIR: join(work, "config"), KOFRA_API: api, KOFRA_API_KEY: token } }).then(
    value => ({ code: 0, ...value }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === "number" ? error.code : -1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
  );
  expect(await readFile(join(work, "config", "credentials.json"), "utf8")).toBe(before);
  for (const sentinel of [token, cookie, diskSecret]) expect(result.stdout + result.stderr).not.toContain(sentinel);
  return result;
}
const cli = (args: string[]) => processRun(process.execPath, [bundle, ...args]);

function page(versionId: unknown, offset = 2, content = "café\r\n") {
  return { path: "docs/a'b #1; $(touch escaped).txt", versionId, contentType: "text/plain", kind: "text", size: 15,
    sha256: "a".repeat(64), encoding: "text", offset, length: 7, truncated: true, nextOffset: 9,
    content, url: "https://site.test/file", rawUrl: "https://site.test/file?raw=1" };
}

describe("CLI recovery error translation", () => {
  it("preserves all recovery fields through errorFromResponse and typed client conversion", async () => {
    const body = { error: { ...fields, ...recovery }, requestId: "body-request" };
    const direct = await errorFromResponse(new Response(JSON.stringify(body), { status: 409 }));
    const converted = await new DropwayClient({ api: "https://recovery.test", token: null, attempts: 1,
      fetch: async () => new Response(JSON.stringify(body), { status: 409 }) }).getSite({ slug: "sample" }).then(
        () => { throw new Error("fixture must fail"); }, (error: unknown) => error as CliError);
    for (const error of [direct, converted]) {
      expect(error).toBeInstanceOf(CliError);
      expect(error.exitCode).toBe(5);
      expect(error.toJSON()).toEqual({ ...fields, ...recovery, status: 409, requestId: "body-request" });
    }
  });

  it.each([[400, 6], [401, 3], [403, 3], [404, 4], [409, 5], [413, 6], [429, 7], [500, 7], [503, 7]] as const)("emits allowlisted JSON and unchanged process exit for HTTP %s", async (status, exitCode) => {
    seen = [];
    respond = () => ({ status, body: { error: { ...fields, ...recovery, token, cookie, headers: { Authorization: token }, rawResponse: diskSecret }, requestId: "body-request", token }, headers: { "Retry-After": "9999" } });
    // POST is intentionally not retried, even when the fixture returns 429/503.
    const result = await cli(["api", "POST", "/sites", "--data", "{}", "--json"]);
    expect(result.code, result.stderr).toBe(exitCode);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, exitCode, error: { ...fields, ...recovery, status, requestId: "body-request" } });
    expect(result.stderr).toBe("");
    expect(seen.map(r => [r.method, r.url.pathname])).toEqual([["POST", "/api/v1/sites"]]);
  });

  it.each([null, 0])("preserves %j delay and empty next array in process JSON", async retryAfterSeconds => {
    seen = [];
    respond = () => ({ status: 409, body: { error: { ...fields, retryable: true, retryAfterSeconds, docs: "/docs/errors", next: [] } } });
    const result = await cli(["api", "GET", "/sites", "--json"]);
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, exitCode: 5, error: { ...fields, status: 409, retryable: true, retryAfterSeconds, docs: "/docs/errors", next: [], requestId: "header-request" } });
    expect(seen).toHaveLength(1);
  });

  it("retains legacy fields and exit behavior without new metadata", async () => {
    seen = [];
    respond = () => ({ status: 404, body: { error: fields } });
    const result = await cli(["api", "GET", "/sites", "--json"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, exitCode: 4, error: { ...fields, status: 404, retryable: false, requestId: "header-request" } });
    expect(seen).toHaveLength(1);
  });

  it("omits malformed optional metadata rather than leaking arbitrary raw objects", async () => {
    seen = [];
    respond = () => ({ status: 409, body: { error: { ...fields, retryable: "false", retryAfterSeconds: -1, docs: { token }, next: { cookie }, rawResponse: diskSecret } } });
    const result = await cli(["api", "GET", "/sites", "--json"]);
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, exitCode: 5, error: { ...fields, status: 409, retryable: false, requestId: "header-request" } });
    expect(seen).toHaveLength(1);
  });

  it("bounds non-JSON diagnostics and does not dump the raw response", async () => {
    seen = [];
    respond = () => ({ status: 404, raw: true, body: `<html>${"upstream unavailable ".repeat(2000)}${diskSecret}</html>` });
    const result = await cli(["api", "GET", "/sites", "--json"]);
    expect(result.code).toBe(4);
    const value = JSON.parse(result.stdout);
    expect(value).toMatchObject({ ok: false, exitCode: 4, error: { code: "http_404", status: 404, retryable: false, requestId: "header-request" } });
    expect(Object.keys(value.error).every(key => ["code", "hint", "message", "requestId", "retryable", "status"].includes(key))).toBe(true);
    expect(value.error.message.length).toBeGreaterThan(0);
    expect(result.stdout.length).toBeLessThan(1500);
    expect(seen).toHaveLength(1);
  });
});

describe("immutable text read-file shell continuations", () => {
  it.each([undefined, "live", "7", "v7", "ver_original"])("pins returned identity after initial version %j and live moving", async initial => {
    seen = [];
    let live = "ver_original";
    const path = "docs/a'b #1; $(touch escaped).txt";
    const site = "https://site.test/s/a'b";
    respond = url => {
      const version = url.searchParams.get("version");
      const resolved = version === null || version === "live" ? live : version === "7" || version === "v7" ? "ver_original" : version;
      const offset = Number(url.searchParams.get("offset"));
      return { body: offset === 2 ? page(resolved) : { ...page(resolved, 9, resolved === "ver_original" ? "tail" : "WRONG"), truncated: false, nextOffset: null, length: 4 } };
    };
    const first = await cli(["read-file", site, path, "--offset", "2", "--length", "7", "--encoding", "text", ...(initial === undefined ? [] : ["--version", initial])]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toBe("café\r\n");
    expect(seen).toHaveLength(1); // no automatic continuation or suggested call
    expect(seen[0]!.url.searchParams.get("version")).toBe(initial ?? null);
    const command = first.stderr.match(/Truncated: continue with: (.+)/)?.[1];
    expect(command, first.stderr).toBeDefined();
    expect(command).toContain("--version ver_original");
    live = "ver_new_live";
    // Execute the actual quoted recovery command, not a test-built substitute.
    const second = await processRun("/bin/sh", ["-c", command!]);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toBe("tail");
    expect(first.stdout + second.stdout).toBe("café\r\ntail");
    expect(seen).toHaveLength(2);
    const query = seen[1]!.url.searchParams;
    expect(Object.fromEntries(query)).toEqual({ site, path, offset: "9", version: "ver_original", length: "7", encoding: "text" });
    expect(seen.every(r => r.method === "GET" && r.url.pathname === "/api/v1/read-file")).toBe(true);
    expect(await readdir(work)).not.toContain("escaped");
  });

  it("pins even when length/encoding/version were omitted and leaves content stdout untouched", async () => {
    seen = [];
    respond = () => ({ body: page("ver_original") });
    const result = await cli(["read-file", "sample", "file.txt"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("café\r\n");
    const command = result.stderr.match(/Truncated: continue with: (.+)/)?.[1];
    expect(command).toContain("--version ver_original");
    expect(command).toContain("--offset 9");
    expect(command).not.toContain("--length");
    expect(command).not.toContain("--encoding");
    expect(seen).toHaveLength(1);
  });

  it.each([undefined, null, "", 7, {}, [], "live", "v7", "7", "   "].map(versionId => ({ versionId })))("fails actionably without guessing a continuation for malformed identity $versionId", async ({ versionId }) => {
    seen = [];
    respond = () => ({ body: page(versionId) });
    const result = await cli(["read-file", "sample", "file.txt", "--version", "live"]);
    expect(result.code).not.toBe(0);
    expect(result.code).toBeGreaterThan(0);
    expect(result.stderr).toMatch(/Error \([a-z][a-z0-9_]*\):/);
    expect(result.stderr).toMatch(/Fix: .+/);
    expect(result.stderr).toMatch(/version|response/i);
    expect(result.stderr.length).toBeLessThan(1500);
    expect(result.stdout === "" || result.stdout === "café\r\n").toBe(true);
    expect(result.stdout + result.stderr).not.toContain("continue with:");
    expect(result.stdout + result.stderr).not.toContain("kofra read-file sample file.txt --offset");
    expect(seen).toHaveLength(1);
  });
});
