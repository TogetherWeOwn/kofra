import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect } from "vitest";

export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const guard = fileURLToPath(new URL("./fetch-guard.mjs", import.meta.url));
export const sentinelKey = "dw_settings_acceptance_synthetic_key_only";
export const secretMarkers = [sentinelKey, "dwc_settings_claim_not_for_output", "settings_password_not_for_output"];
export const sitePath = "/api/v1/sites/settings-fixture";
export const originalSite = {
  id: "site_settings_fixture", slug: "settings-fixture", url: "https://sites.example.test/settings-fixture/",
  title: "Original title", description: "Original description", anonymous: false, expiresAt: null,
  currentVersionId: "ver_settings_fixture", createdAt: "2026-01-01T00:00:00.000Z",
  settings: { spa: true, renderMarkdown: true, crossOriginIsolation: true },
};
export type Wire = { method: string; url: string; body: string; authenticated: boolean; allowed?: boolean };
export type Ran = { code: number | null; stdout: string; stderr: string; json: any; wire: Wire[] };
export type Box = { dir: string; cwd: string; home: string; config: string };

export function isolatedEnv(home: string): Record<string, string> {
  return { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, "xdg"),
    CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" };
}
export async function testRoot() {
  return mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "site-settings-"));
}
export async function bundle(root: string) {
  const entry = join(root, "bundle/dropway.mjs");
  await build({ entryPoints: [join(repoRoot, "packages/cli/src/cli.ts")], bundle: true, platform: "node",
    format: "esm", target: "node20", outfile: entry, logLevel: "silent" });
  return entry;
}
export async function sandbox(root: string, origin: string): Promise<Box> {
  const dir = await mkdtemp(join(root, "cli-"));
  const cwd = join(dir, "project"), home = join(dir, "home"), config = join(dir, "config");
  await mkdir(cwd); await mkdir(home); await mkdir(config);
  // A stale mapping must never become an implicit mutation target.
  await writeFile(join(cwd, "dropway.json"), JSON.stringify({ api: origin, sites: { ".": "stale-other-site", dist: "stale-other-site" } }) + "\n");
  await writeFile(join(config, "credentials.json"), JSON.stringify({ default: origin,
    instances: { [origin]: { key: sentinelKey, email: "fixture@example.test" } } }) + "\n", { mode: 0o600 });
  return { dir, cwd, home, config };
}
async function snapshot(dir: string, prefix = ""): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name), info = await lstat(path), relative = prefix + name;
    result[relative] = { mode: info.mode, mtime: info.mtimeMs,
      ...(info.isFile() ? { hash: createHash("sha256").update(await readFile(path)).digest("hex") } : {}) };
    if (info.isDirectory()) Object.assign(result, await snapshot(path, relative + "/"));
  }
  return result;
}
export async function runCli(entry: string, box: Box, origin: string, args: string[], options: {
  key?: string; offline?: boolean; path?: string; noKey?: boolean;
} = {}): Promise<Ran> {
  const wireFile = box.dir + ".wire.jsonl";
  await writeFile(wireFile, "");
  const before = await snapshot(box.dir);
  const key = options.key ?? sentinelKey;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", guard, entry, ...args], { cwd: box.cwd,
      env: { ...isolatedEnv(box.home), KOFRA_CONFIG_DIR: options.noKey ? join(box.dir, "empty-config") : box.config,
        KOFRA_API: origin, ...(options.noKey ? {} : { KOFRA_API_KEY: key }),
        SETTINGS_TEST_ORIGIN: origin, SETTINGS_TEST_PATH: options.path ?? sitePath,
        SETTINGS_TEST_WIRE: wireFile, SETTINGS_TEST_OFFLINE: String(options.offline ?? false) },
      stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Non-TTY settings CLI timed out (possible prompt)")); }, 12_000);
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end();
  });
  expect(await snapshot(box.dir), "settings must not touch project/config/credentials, including on failures").toEqual(before);
  expect([...secretMarkers, key].some(value => (result.stdout + result.stderr).includes(value)), "secret leaked to CLI output").toBe(false);
  const wire: Wire[] = (await readFile(wireFile, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  let json: any;
  try { json = JSON.parse(result.stdout); } catch { /* Text help/output is not JSON. */ }
  return { ...result, json, wire };
}
export function success(result: Ran) {
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.json, "stdout must be exactly one JSON object (no progress or prompts)").toBeTypeOf("object");
  expect(result.json).not.toBeNull();
  expect(Array.isArray(result.json)).toBe(false);
  expect(result.json.ok).toBe(true);
  return result.json;
}
export function failure(result: Ran, exitCode: number) {
  expect(result.code, result.stdout + result.stderr).toBe(exitCode);
  expect(result.json).toMatchObject({ ok: false, exitCode });
  expect(result.json.error.code).toMatch(/^[a-z][a-z0-9_]*$/);
  expect(result.json.error.code, "rejecting the whole missing command is not argument validation").not.toBe("unknown_command");
  expect(result.json.error.message).toBeTypeOf("string");
  expect(result.json.error.hint).toEqual(expect.any(String));
  expect(result.json.error.hint.length).toBeGreaterThan(0);
  return result.json.error;
}
export function requests(result: Ran, origin: string, expected: Array<[string, string, unknown?]>) {
  expect(result.wire.map(r => [r.method, r.url, r.body ? JSON.parse(r.body) : null])).toEqual(
    expected.map(([method, path, body]) => [method, origin + path, body ?? null]));
  for (const request of result.wire) {
    expect(request.allowed, "unexpected route/method or egress").toBe(true);
    expect(request.authenticated, "site read and patch require the selected credential").toBe(true);
  }
}
export async function transport(reply: (request: Wire) => Response | Promise<Response>, key = sentinelKey) {
  const received: Wire[] = [];
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = { method: req.method!, url: req.url!, body, authenticated: req.headers.authorization === `Bearer ${key}` };
      received.push(request);
      const response = await reply(request);
      const bytes = Buffer.from(await response.arrayBuffer()), headers = new Headers(response.headers);
      for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) headers.delete(name);
      res.writeHead(response.status, Object.fromEntries(headers)); res.end(bytes);
    } catch { res.writeHead(500); res.end("Fixture transport failure"); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral loopback port");
  return { origin: `http://127.0.0.1:${address.port}`, received,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
export async function clean(root: string | undefined) { if (root) await rm(root, { recursive: true, force: true }); }
