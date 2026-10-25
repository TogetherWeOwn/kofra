import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, lstat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const cliRoot = join(repoRoot, "packages/cli");
const guard = fileURLToPath(new URL("./operations-inspection-fetch-guard.mjs", import.meta.url));
export const catalogPath = "/api/v1/operations";
export const tokenSentinels = [
  "dw_operations_acceptance_saved_not_a_real_key",
  "dw_operations_acceptance_env_not_a_real_key",
  "operations_acceptance_bootstrap_not_a_real_key",
  "dw_operations_acceptance_flag_not_a_real_key",
] as const;
export type Wire = { method: string; url: string; headers: Record<string, string>; body: string; allowed?: boolean };
export type Ran = { code: number | null; stdout: string; stderr: string; json: any; wire: Wire[] };
export type Sandbox = { dir: string; cwd: string; config: string; home: string };

export function isolatedEnv(home: string): Record<string, string> {
  // Do not inherit credentials, proxies, NODE_OPTIONS or cloud account settings.
  return { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
    XDG_CONFIG_HOME: join(home, "xdg"), CI: "true", NO_COLOR: "1",
    WRANGLER_SEND_METRICS: "false" };
}

export async function tempRoot() {
  return mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "operations-acceptance-"));
}

export async function sandbox(root: string): Promise<Sandbox> {
  const dir = await mkdtemp(join(root, "cli-"));
  const cwd = join(dir, "project");
  const home = join(dir, "home");
  await mkdir(cwd); await mkdir(home);
  return { dir, cwd, home, config: join(dir, "config") };
}

async function snapshot(dir: string, prefix = ""): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const relative = prefix + name;
    const info = await lstat(path);
    result[relative] = { mode: info.mode, mtime: info.mtimeMs,
      ...(info.isFile() ? { sha256: createHash("sha256").update(await readFile(path)).digest("hex") } : {}) };
    if (info.isDirectory()) Object.assign(result, await snapshot(path, relative + "/"));
  }
  return result;
}

export async function runCli(box: Sandbox, origin: string, args: string[], options: {
  env?: Record<string, string>; entry?: string; defaultApi?: boolean;
} = {}): Promise<Ran> {
  const wireFile = box.dir + ".wire.jsonl";
  await writeFile(wireFile, "");
  const before = await snapshot(box.dir);
  const env = { ...isolatedEnv(box.home), KOFRA_CONFIG_DIR: box.config,
    ...(options.defaultApi === false ? {} : { KOFRA_API: origin }),
    ...options.env, OPERATIONS_TEST_ORIGIN: origin, OPERATIONS_TEST_WIRE: wireFile };
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // Run the same black-box contract against a test bundle (including mutation checks).
    const child = spawn(process.execPath, ["--import", guard,
      options.entry ?? process.env.OPERATIONS_TEST_CLI_ENTRY ?? join(cliRoot, "bin/dropway.mjs"), ...args],
      { cwd: box.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI timed out; non-TTY discovery must never prompt")); }, 12_000);
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end();
  });
  const wire: Wire[] = (await readFile(wireFile, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(await snapshot(box.dir), "inspection must not create, rewrite, chmod or touch config/credentials/project files").toEqual(before);
  expect(tokenSentinels.some(token => (result.stdout + result.stderr).includes(token)), "configured token leaked to output").toBe(false);
  for (const request of wire) {
    expect(request.allowed, "CLI attempted a request other than GET /api/v1/operations").toBe(true);
    expect(request.method).toBe("GET");
    expect(request.url).toBe(origin + catalogPath);
    expect(request.body).toBe("");
  }
  let json: any;
  try { json = JSON.parse(result.stdout); } catch { /* Human help and table output are not JSON. */ }
  return { ...result, json, wire };
}

export function jsonSuccess(result: Ran) {
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.json, "stdout must contain exactly one JSON object, without progress or prompts").toBeTypeOf("object");
  expect(result.json).not.toBeNull();
  expect(Array.isArray(result.json)).toBe(false);
  expect(result.json.ok).toBe(true);
  return result.json;
}

export function jsonError(result: Ran, exitCode: number) {
  expect(result.code, result.stdout + result.stderr).toBe(exitCode);
  expect(result.json, "JSON errors belong on stdout, not mixed with human prose").toMatchObject({ ok: false, exitCode });
  expect(result.json.error.code).toMatch(/^[a-z][a-z0-9_]*$/);
  expect(result.json.error.message).toBeTypeOf("string");
  expect(result.json.error.message.length).toBeGreaterThan(0);
  expect(result.json.error.hint).toBeTypeOf("string");
  expect(result.json.error.hint.length).toBeGreaterThan(0);
  return result.json.error;
}

export async function savedInstance(box: Sandbox, api: string, key?: string) {
  await mkdir(box.config, { recursive: true });
  await writeFile(join(box.config, "credentials.json"), JSON.stringify({
    default: api, instances: { [api]: { ...(key ? { key } : {}), email: "fixture@example.test" } },
  }) + "\n", { mode: 0o600 });
}

export async function catalogServer(reply: () => Promise<Response> | Response) {
  const requests: Wire[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method!, url: req.url!, headers: req.headers as Record<string, string>, body });
    const response = req.method === "GET" && req.url === catalogPath && !body
      ? await reply()
      : Response.json({ error: { code: "acceptance_transport_refused", message: "Catalog GET only", hint: "Do not execute advertised operations." } }, { status: 405 });
    // fetch() has decoded the body; do not forward compressed wire lengths/encoding.
    const bytes = Buffer.from(await response.arrayBuffer());
    const headers = new Headers(response.headers);
    for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) headers.delete(name);
    res.writeHead(response.status, Object.fromEntries(headers));
    res.end(bytes);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an ephemeral loopback port");
  return { origin: `http://127.0.0.1:${address.port}`, requests,
    clear: () => { requests.length = 0; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

export async function cleanRoot(root: string | undefined) {
  if (root) await rm(root, { recursive: true, force: true });
}
