import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const api = "http://127.0.0.1:1"; // injected fetch never delegates to the network
const credential = "dw_shapeFixture_0000000000000000000000";
const configSentinel = "config_fixture_NEVER_PRINT_b7512a";
export const responseSentinel = "response_fixture_NEVER_PRINT_d9a873";

async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, relative: string) {
    const info = await stat(path);
    result[relative] = `${info.mode}:${info.mtimeMs}:${info.size}`;
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${relative}/${name}`);
    } else result[relative] += `:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  }
  await visit(dir, ".");
  return result;
}

// Only transport is replaced: parsing, credentials, command dispatch, validation,
// rendering and exit handling all run in the actual CLI subprocess.
export async function keyListHarness() {
  const work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "keys-list-review-"));
  const bundle = join(work, "cli.mjs");
  const preload = join(work, "fixture-fetch.mjs");
  let sequence = 0;
  await build({ entryPoints: [join(root, "packages/cli/src/cli.ts")], bundle: true,
    platform: "node", format: "esm", target: "node20", outfile: bundle, logLevel: "silent" });
  await writeFile(preload, `import { appendFileSync, readFileSync } from 'node:fs';
const payload = readFileSync(process.env.ACCEPTANCE_RESPONSE, 'utf8');
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  appendFileSync(process.env.ACCEPTANCE_WIRE, JSON.stringify({ method: request.method, origin: url.origin, path: url.pathname, query: url.search, hasBody: request.body !== null }) + '\\n');
  if (url.origin !== ${JSON.stringify(api)} || url.pathname !== '/api/v1/keys' || request.method !== 'GET' || request.body !== null) throw Error('acceptance_transport_refused');
  if (!['', '?all=1', '?all=true'].includes(url.search)) throw Error('acceptance_query_refused');
  if (request.headers.get('authorization') !== ${JSON.stringify(`Bearer ${credential}`)}) throw Error('fixture_auth_missing');
  return new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } });
};\n`);

  return {
    async dispose() { await rm(work, { recursive: true, force: true }); },
    async cli(body: unknown, bundled: boolean, flags: string[] = []) {
      const dir = join(work, `case-${++sequence}`);
      const sandbox = join(dir, "home");
      const configDir = join(sandbox, "config");
      await mkdir(configDir, { recursive: true });
      // Both saved-credential read-only behavior and config-free env use are exercised.
      if (!bundled) {
        await writeFile(join(configDir, "credentials.json"), JSON.stringify({
          version: 1, defaultApi: api, instances: { [api]: { key: credential } }, sentinel: configSentinel,
        }), { mode: 0o600 });
        await writeFile(join(sandbox, "dropway.json"), JSON.stringify({ api, sentinel: configSentinel }));
      }
      const before = await snapshot(sandbox);
      const audit = join(dir, "wire.jsonl");
      const response = join(dir, "response.json");
      await writeFile(audit, "");
      await writeFile(response, JSON.stringify(body));
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, "xdg"),
        KOFRA_API: api, KOFRA_CONFIG_DIR: configDir, NO_COLOR: "1",
        ACCEPTANCE_WIRE: audit, ACCEPTANCE_RESPONSE: response,
      };
      if (bundled) env.KOFRA_API_KEY = credential;
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", preload,
          bundled ? bundle : join(root, "packages/cli/bin/dropway.mjs"), "keys", "ls", ...flags], {
          cwd: sandbox, env, stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("non-TTY CLI did not terminate")); }, 15_000);
        child.stdout.on("data", data => { stdout += data; });
        child.stderr.on("data", data => { stderr += data; });
        child.on("error", error => { clearTimeout(timer); reject(error); });
        child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      expect(await snapshot(sandbox), "listing must not create/rewrite config or credentials").toEqual(before);
      const output = result.stdout + result.stderr;
      for (const secret of [credential, configSentinel, responseSentinel,
        createHash("sha256").update(credential).digest("hex")]) {
        expect(output.includes(secret), "output must not echo auth, config or response-body sentinels").toBe(false);
      }
      expect(output).not.toMatch(/authorization\s*[:=]|bearer\s+dw_|"(?:key_hash|keyHash|accessToken|sessionToken)"/i);
      expect(output, "non-TTY listing must not prompt").not.toMatch(/paste|enter.*(?:key|token)|sign in.*browser/i);
      const wire = (await readFile(audit, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(wire, "one nonretrying read, never mint/revoke or fallback requests").toHaveLength(1);
      expect(wire[0]).toEqual({ method: "GET", origin: api, path: "/api/v1/keys",
        query: expect.any(String), hasBody: false });
      if (flags.includes("--all")) expect(["?all=1", "?all=true"]).toContain(wire[0].query);
      else expect(wire[0].query).toBe("");
      return result;
    },
  };
}
