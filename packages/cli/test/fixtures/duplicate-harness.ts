import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
export const duplicateApi = "http://127.0.0.1:1";
export const duplicateKey = "dw_duplicate_fixture_NEVER_PRINT_0123456789";
export const sourceSecret = "source_password_fixture_NEVER_PRINT_129ab";
export const configSecret = "saved_credential_fixture_NEVER_PRINT_093be";
export type DuplicateWire = { method: string; url: string; body: string; key: string | null; authenticated: boolean };
export type DuplicateReply = { status?: number; body?: unknown; headers?: Record<string, string>; networkError?: boolean };
export type DuplicateRun = { code: number | null; stdout: string; stderr: string; wire: DuplicateWire[]; fileReads: string[] };

export async function duplicateSnapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, name: string) {
    const info = await stat(path, { bigint: true });
    result[name] = `${info.mode}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(join(path, child), `${name}/${child}`);
    } else result[name] += `:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  }
  await visit(dir, ".");
  return result;
}

// Only fetch is replaced. The bundle runs its real parser, SDK, configuration,
// renderer and exit handler in a non-TTY process. The optional local Worker
// forwarding path is restricted to one endpoint, never arbitrary networking.
export async function duplicateHarness() {
  const work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "duplicate-cli-tests-"));
  const bundle = join(work, "kofra.mjs");
  const preload = join(work, "transport.mjs");
  let sequence = 0;
  await build({ entryPoints: [join(root, "packages/cli/src/cli.ts")], bundle: true,
    platform: "node", format: "esm", target: "node20", outfile: bundle, logLevel: "silent" });
  await writeFile(preload, `import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import cp from 'node:child_process';
import { resolve } from 'node:path';
const read = fs.readFileSync.bind(fs);
const append = fs.appendFileSync.bind(fs);
const setup = JSON.parse(read(process.env.DUPLICATE_SETUP, 'utf8'));
const nativeFetch = globalThis.fetch;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[name] = () => {
    append(setup.processes, JSON.stringify(name) + '\\n');
    throw new Error('duplicate must not open a browser or launch another process');
  };
}
syncBuiltinESMExports();
let attempt = 0;
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const body = await req.text();
  append(setup.audit, JSON.stringify({method: req.method, url: req.url, body,
    key: req.headers.get('Idempotency-Key'), authenticated: req.headers.get('Authorization') === 'Bearer ' + setup.key}) + '\\n');
  if (setup.forward) {
    if (new URL(req.url).origin !== setup.api || req.method !== 'POST' || new URL(req.url).pathname !== setup.path) {
      throw new Error('fixture blocked a request outside the disposable duplicate endpoint');
    }
    return nativeFetch(req.url, { method: req.method, headers: req.headers, body, redirect: 'error' });
  }
  const reply = setup.replies[Math.min(attempt++, setup.replies.length - 1)];
  if (!reply || reply.networkError) throw new TypeError('fixture network failure');
  return new Response(JSON.stringify(reply.body ?? {}), {status: reply.status ?? 201,
    headers: {'Content-Type': 'application/json', ...reply.headers}});
};
if (setup.forbidReads) {
  const check = path => {
    const p = path instanceof URL ? path.pathname : typeof path === 'string' ? resolve(path) : '';
    if (p === setup.home || p.startsWith(setup.home + '/')) {
      append(setup.reads, JSON.stringify(p.slice(setup.home.length)) + '\\n');
      throw new Error('offline duplicate must not read project files or credentials');
    }
  };
  for (const name of ['readFileSync', 'openSync', 'readdirSync', 'statSync', 'lstatSync', 'accessSync', 'existsSync', 'createReadStream']) {
    const original = fs[name].bind(fs);
    fs[name] = (path, ...args) => { check(path); return original(path, ...args); };
  }
  for (const name of ['readFile', 'open', 'readdir', 'stat', 'lstat', 'access']) {
    const callbackOriginal = fs[name].bind(fs);
    fs[name] = (path, ...args) => { check(path); return callbackOriginal(path, ...args); };
    const original = fsp[name].bind(fsp);
    fsp[name] = async (path, ...args) => { check(path); return original(path, ...args); };
  }
  syncBuiltinESMExports();
}
`);
  return {
    async dispose() { await rm(work, { recursive: true, force: true }); },
    async cli(args: string[], opts: {
      replies?: DuplicateReply[]; api?: string; key?: string | null; offline?: boolean;
      forwardSource?: string; repositoryBin?: boolean;
    } = {}): Promise<DuplicateRun> {
      const dir = join(work, `case-${++sequence}`);
      const home = join(dir, "home");
      const config = join(home, "config");
      await mkdir(config, { recursive: true });
      await writeFile(join(home, "dropway.json"), JSON.stringify({ api: "https://mapping.invalid",
        sites: { ".": { slug: "never-infer-source", siteId: "site_never_infer" } }, marker: configSecret }));
      await writeFile(join(config, "credentials.json"), opts.offline ? "not valid credential JSON" : JSON.stringify({
        version: 1, defaultApi: "https://mapping.invalid", instances: {}, marker: configSecret,
      }), { mode: 0o600 });
      await writeFile(join(home, "index.html"), `<p>${sourceSecret}</p>`);
      const before = await duplicateSnapshot(home);
      const audit = join(dir, "wire.jsonl");
      const reads = join(dir, "reads.jsonl");
      const processes = join(dir, "processes.jsonl");
      const setup = join(dir, "setup.json");
      await writeFile(audit, "");
      await writeFile(reads, "");
      await writeFile(processes, "");
      const api = opts.api ?? duplicateApi;
      const key = opts.key === undefined ? duplicateKey : opts.key;
      await writeFile(setup, JSON.stringify({ api, key, home, audit, reads, processes, forbidReads: opts.offline,
        forward: opts.forwardSource !== undefined,
        path: opts.forwardSource === undefined ? null : `/api/v1/sites/${encodeURIComponent(opts.forwardSource)}/duplicate`,
        replies: opts.replies ?? [{ status: 201, body: {} }],
      }));
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "xdg"),
        KOFRA_CONFIG_DIR: config, NO_COLOR: "1", DUPLICATE_SETUP: setup };
      if (!opts.offline) env.KOFRA_API = api;
      if (key !== null && !opts.offline) env.KOFRA_API_KEY = key;
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", preload,
          opts.repositoryBin ? join(root, "packages/cli/bin/dropway.mjs") : bundle, ...args],
        { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("duplicate CLI did not terminate without a TTY")); }, 15_000);
        child.stdout.on("data", data => { stdout += data; });
        child.stderr.on("data", data => { stderr += data; });
        child.on("error", error => { clearTimeout(timeout); reject(error); });
        child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      });
      expect(await duplicateSnapshot(home), "duplicate never writes local mappings, credentials or project files").toEqual(before);
      for (const secret of [key, sourceSecret, configSecret]) {
        if (secret) expect(result.stdout + result.stderr, "credential/source/config sentinel leaked").not.toContain(secret);
      }
      const lines = async (path: string) => (await readFile(path, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(await lines(processes), "duplicate must not automatically open a browser or invoke a second tool").toEqual([]);
      return { ...result, wire: await lines(audit), fileReads: await lines(reads) };
    },
  };
}

export function duplicateObject(result: DuplicateRun): any {
  // Parse ALL stdout, not just the first line: rejects progress, JSONL and notes.
  const value = JSON.parse(result.stdout);
  expect(value !== null && typeof value === "object" && !Array.isArray(value)).toBe(true);
  return value;
}
