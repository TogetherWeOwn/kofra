/** Protected text-rendering regression; the Builder consumes this file unchanged.
 * Run: npm run test:cli -- test/keys-ls-terminal-controls.acceptance.test.ts
 * Only transport is injected: real source/bundled CLI subprocesses, no network,
 * Worker, credential mint/revoke, production inventory or implementation mocks.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const api = "http://127.0.0.1:1"; // fetch is replaced, never delegated to the network
const credential = "dw_terminalFixture_0000000000000000000000";
const sentinel = "config_fixture_NEVER_PRINT_6de1472a";
const unicode = "Équipe 東京 🔑";
const controls = Array.from({ length: 32 }, (_, i) => i).concat(127, Array.from({ length: 32 }, (_, i) => 128 + i));
const controlName = `${unicode}\u001b[2J\r\nFORGED_KEY\t${String.fromCodePoint(...controls)} fin`;
const otherName = "Autre membre\u009b2J\u001b]0;forged title\u0007\r\nFORGED_OTHER\tfin";
const keyMetadata = {
  prefix: "dw_fixture", scopes: ["keys:write"], siteId: null,
  createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null, expiresAt: null, revoked: false,
};
const ownKeys = [
  { ...keyMetadata, id: "key_control", name: controlName, memberId: "mem_owner", current: true },
  { ...keyMetadata, id: "key_unicode", name: unicode, memberId: "mem_owner", current: false },
];
const otherKey = { ...keyMetadata, id: "key_other", name: otherName, memberId: "mem_other", current: false };
let work: string;
let preload: string;
let bundle: string;
let sequence = 0;

type Wire = { method: string; origin: string; path: string; query: string; hasBody: boolean };

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "keys-ls-terminal-"));
  bundle = join(work, "cli.mjs");
  await build({ entryPoints: [join(root, "packages/cli/src/cli.ts")], bundle: true,
    platform: "node", format: "esm", target: "node20", outfile: bundle, logLevel: "silent" });
  preload = join(work, "fixture-fetch.mjs");
  await writeFile(preload, `import { appendFileSync } from 'node:fs';
const ownKeys = ${JSON.stringify(ownKeys)};
const otherKey = ${JSON.stringify(otherKey)};
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  appendFileSync(process.env.ACCEPTANCE_WIRE, JSON.stringify({ method: request.method, origin: url.origin, path: url.pathname, query: url.search, hasBody: request.body !== null }) + '\\n');
  if (url.origin !== ${JSON.stringify(api)} || url.pathname !== '/api/v1/keys' || request.method !== 'GET' || request.body !== null) throw Error('acceptance_transport_refused');
  if (request.headers.get('authorization') !== ${JSON.stringify(`Bearer ${credential}`)}) throw Error('fixture_auth_missing');
  const all = ['1', 'true'].includes(url.searchParams.get('all'));
  return Response.json({ keys: all ? [...ownKeys, otherKey] : ownKeys });
};\n`);
});

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

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

async function cli(flags: string[], bundled: boolean) {
  const dir = join(work, `case-${++sequence}`);
  const sandbox = join(dir, "home");
  const configDir = join(sandbox, "config");
  await mkdir(configDir, { recursive: true });
  // Source cases use saved credentials; bundled cases must not create any config.
  if (!bundled) {
    await writeFile(join(configDir, "credentials.json"), JSON.stringify({
      version: 1, defaultApi: api, instances: { [api]: { key: credential } }, sentinel,
    }), { mode: 0o600 });
    await writeFile(join(sandbox, "dropway.json"), JSON.stringify({ api, sentinel }));
  }
  const before = await snapshot(sandbox);
  const audit = join(dir, "wire.jsonl");
  await writeFile(audit, "");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, "xdg"),
    KOFRA_API: api, KOFRA_CONFIG_DIR: configDir, NO_COLOR: "1", ACCEPTANCE_WIRE: audit,
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
  for (const secret of [credential, sentinel, createHash("sha256").update(credential).digest("hex")]) {
    expect(output.includes(secret), "listing must not disclose credential/config contents").toBe(false);
  }
  expect(result.code, "real CLI must succeed with the injected GET response").toBe(0);
  expect(result.stderr, "listing must not prompt or emit diagnostics").toBe("");
  const wire: Wire[] = (await readFile(audit, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(wire).toHaveLength(1);
  expect(wire[0]).toMatchObject({ method: "GET", origin: api, path: "/api/v1/keys", hasBody: false });
  if (flags.includes("--all")) expect(["?all=1", "?all=true"]).toContain(wire[0]!.query);
  else expect(wire[0]!.query).toBe("");
  return result;
}

function visibleControl(code: number): RegExp {
  // Accept common unambiguous visible escapes without prescribing a renderer API.
  const hex = code.toString(16).padStart(2, "0");
  const short: Record<number, string> = { 0: "0", 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r", 27: "e" };
  return new RegExp(`\\\\(?:u00${hex}|x${hex}${short[code] ? `|${short[code]}` : ""})`, "i");
}

// Breaks caught: emitting raw metadata into the text table; dropping controls
// instead of visibly escaping; escaping only --all/only own rows; corrupting
// Unicode or JSON to solve a terminal-only problem; introducing write side effects.
describe.each([
  { label: "source / saved credentials", bundled: false },
  { label: "bundle / environment credentials", bundled: true },
])("keys ls terminal controls: $label", ({ bundled }) => {
  it.each([{ flags: [] }, { flags: ["--all"] }])("visibly escapes every C0/DEL/C1 control in text cells ($flags)", async ({ flags }) => {
    const result = await cli(flags, bundled);
    expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(result.stdout), "text output must not contain raw terminal controls (only structural LF is allowed)").toBe(false);
    const rows = result.stdout.split("\n").filter(line => line.trim().length > 0);
    const controlRow = rows.find(line => line.includes("key_control"));
    expect(controlRow, "control-bearing key must remain visible").toBeDefined();
    expect(rows, "one header and one physical line per metadata row; names cannot forge rows").toHaveLength(flags.length ? 4 : 3);
    expect(controlRow).toContain(unicode);
    expect(controlRow).toContain("[2J");
    expect(controlRow, "LF must not move the remainder of a name to another row").toContain("FORGED_KEY");
    expect(controlRow).toContain("fin");
    for (const code of controls) {
      expect(controlRow, `U+${code.toString(16).padStart(4, "0")} must be visibly escaped, not removed`).toMatch(visibleControl(code));
    }
    expect(rows.find(line => line.includes("key_unicode"))).toContain(unicode);
    if (flags.length) {
      const otherRow = rows.find(line => line.includes("key_other"));
      expect(otherRow).toContain("Autre membre");
      expect(otherRow).toContain("FORGED_OTHER");
      expect(otherRow).toContain("forged title");
      for (const code of [7, 9, 10, 13, 27, 155]) expect(otherRow).toMatch(visibleControl(code));
    } else expect(result.stdout).not.toContain("key_other");
  });

  it.each([{ flags: [] }, { flags: ["--all"] }])("preserves original parsed metadata in JSON, not text escapes ($flags)", async ({ flags }) => {
    const result = await cli([...flags, "--json"], bundled);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.keys).toEqual(flags.length ? [...ownKeys, otherKey] : ownKeys);
    expect(parsed.keys[0].name).toBe(controlName);
    expect(parsed.keys[1].name).toBe(unicode);
    if (flags.length) expect(parsed.keys[2].name).toBe(otherName);
  });
});
