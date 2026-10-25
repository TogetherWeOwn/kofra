/** Native read-only keys acceptance. Run: npm run test:cli -- test/keys-ls.acceptance.test.ts
 * Uses only a disposable local Worker/D1 and real CLI subprocesses. SQL fixtures
 * precede the commands; no setup/create/revoke/login request is needed. The fetch
 * preload records attempted transport and refuses nonlocal or mutating requests.
 * These tests deliberately remain RED until the native command is implemented.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = join(root, "packages/cli/bin/dropway.mjs");
const tokens = {
  owner: "dw_ownerFixture_00000000000000000000000000",
  other: "dw_otherFixture_00000000000000000000000000",
  reader: "dw_readerFixture_0000000000000000000000000",
  restricted: "dw_scopedFixture_0000000000000000000000000",
  expired: "dw_expiredFixture_000000000000000000000000",
  revoked: "dw_revokedFixture_000000000000000000000000",
  foreign: "dw_foreignFixture_000000000000000000000000",
  empty: "dw_fixtureEmpty_000000000000000000000000",
  keyless: "dw_fixtureKeyless_0000000000000000000000",
  invalid: "dw_invalidFixture_000000000000000000000000",
};
const sessionSentinel = "session_fixture_NEVER_PRINT_2cc5190e";
const credentialsSentinel = "credentials_file_NEVER_PRINT_c98f40d2";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secrets = [...Object.values(tokens), ...Object.values(tokens).map(digest), sessionSentinel, credentialsSentinel];
const scopeHint = "Use a member API key with the required scopes; a claim token only controls its own site.";
let work: string;
let api: string;
let preload: string;
let bundle: string;
let sequence = 0;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;

type Wire = { method: string; origin: string; path: string; query: string; hasBody: boolean };
type Ran = { code: number | null; stdout: string; stderr: string; wire: Wire[] };

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "keys-ls-acceptance-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-keys-ls-acceptance", main: join(root, "test/fixtures/keys-ls.worker.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { SITES_MODE: "path", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "keys-ls-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "keys-ls-acceptance-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  const wrangler = async (args: string[]) => promisify(execFile)(process.execPath,
    [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", ...args, "--config", config, "--local", "--persist-to", persist],
    { cwd: root, env: { PATH: process.env.PATH, HOME: work, CI: "1", WRANGLER_SEND_METRICS: "false" } });
  await wrangler(["migrations", "apply", "DB"]);
  const rows = [
    ["key_owner", "ten_keys", "mem_owner", "Inventory agent", "dw_ownerFi", tokens.owner, "keys:write members:write", null, 1767225606000, null, null, null],
    ["key_scoped", "ten_keys", "mem_owner", "Site-only agent", "dw_scopedF", tokens.restricted, "keys:write", "site_restricted", 1767225605000, 1767225607000, 4102444800000, null],
    ["key_expired", "ten_keys", "mem_owner", null, "dw_expired", tokens.expired, "keys:write", null, 1767225604000, null, 946684800000, null],
    ["key_other", "ten_keys", "mem_other", "Other member", "dw_otherFi", tokens.other, "keys:write", null, 1767225603000, 1767225607000, null, null],
    ["key_reader", "ten_keys", "mem_reader", "No key scope", "dw_readerF", tokens.reader, "sites:read", null, 1767225602000, null, null, null],
    ["key_revoked", "ten_keys", "mem_owner", "Revoked fixture", "dw_revoked", tokens.revoked, "keys:write", null, 1767225601000, null, null, 1767225608000],
    ["key_foreign", "ten_foreign", "mem_foreign", "Separate tenant", "dw_foreign", tokens.foreign, "keys:write", null, 1767225600000, null, null, null],
  ];
  const sql = (value: unknown) => value === null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
  const seed = [
    "INSERT INTO tenants(id,created_at) VALUES ('ten_keys',1767225600000),('ten_foreign',1767225600000);",
    ...["owner", "other", "reader", "empty", "foreign"].map(name =>
      `INSERT INTO members(id,tenant_id,role,created_at) VALUES ('mem_${name}','${name === "foreign" ? "ten_foreign" : "ten_keys"}','${name === "owner" ? "owner" : "member"}',1767225600000);`),
    ...rows.map(row => `INSERT INTO api_keys(id,tenant_id,member_id,name,prefix,key_hash,scopes,site_id,created_at,last_used_at,expires_at,revoked_at) VALUES (${row.map((v, i) => sql(i === 5 ? digest(String(v)) : v)).join(",")});`),
  ].join("\n");
  const seedFile = join(work, "seed.sql");
  await writeFile(seedFile, seed);
  await wrangler(["execute", "DB", "--file", seedFile]);
  worker = await unstable_startWorker({ config, dev: {
    server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error",
  } });
  await worker.ready;
  api = (await worker.url).origin;
  bundle = join(work, "cli.mjs");
  await build({ entryPoints: [join(root, "packages/cli/src/cli.ts")], bundle: true,
    platform: "node", format: "esm", target: "node20", outfile: bundle, logLevel: "silent" });
  preload = join(work, "observe-fetch.mjs");
  await writeFile(preload, `import { appendFileSync } from 'node:fs';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  appendFileSync(process.env.ACCEPTANCE_WIRE, JSON.stringify({ method: request.method, origin: url.origin, path: url.pathname, query: url.search, hasBody: request.body !== null }) + '\\n');
  if (url.origin !== process.env.ACCEPTANCE_ORIGIN || request.method !== 'GET') throw Error('acceptance_transport_refused');
  return realFetch(request);
};\n`);
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string, relative: string) {
    const info = await stat(path);
    result[relative] = `${info.mode}:${info.mtimeMs}:${info.size}`;
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${relative}/${name}`);
    } else result[relative] += `:${digest(await readFile(path, "utf8"))}`;
  }
  await visit(dir, ".");
  return result;
}

async function cli(args: string[], opts: { key?: string; saved?: boolean; legacy?: boolean; bundled?: boolean; noConfig?: boolean } = {}): Promise<Ran> {
  const caseDir = join(work, `case-${++sequence}`);
  const sandbox = join(caseDir, "sandbox");
  const configDir = join(sandbox, "config");
  await mkdir(configDir, { recursive: true });
  const key = opts.key ?? tokens.owner;
  if (!opts.noConfig) {
    await writeFile(join(configDir, "credentials.json"), JSON.stringify({
      version: 1, defaultApi: api, instances: { [api]: { key: opts.saved ? key : tokens.invalid } },
      sentinel: credentialsSentinel, session: sessionSentinel,
    }), { mode: 0o600 });
    await writeFile(join(sandbox, "dropway.json"), JSON.stringify({ api, sentinel: credentialsSentinel }));
  }
  const before = await snapshot(sandbox);
  const audit = join(caseDir, "wire.jsonl");
  await writeFile(audit, "");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, "xdg"), NO_COLOR: "1",
    ACCEPTANCE_WIRE: audit, ACCEPTANCE_ORIGIN: api,
  };
  const prefix = opts.legacy ? "DROPWAY_" : "KOFRA_"; // rebrand:keep
  env[`${prefix}API`] = api;
  env[`${prefix}CONFIG_DIR`] = configDir;
  if (!opts.saved) env[`${prefix}API_KEY`] = key;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", preload, opts.bundled ? bundle : source, ...args], {
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
  const output = result.stdout + result.stderr;
  for (const value of secrets) expect(output.includes(value), "stdout/stderr must not disclose fixture credentials or hashes").toBe(false);
  expect(/authorization\s*[:=]|bearer\s+dw_|"(?:key_hash|keyHash|accessToken|sessionToken)"/i.test(output), "no authentication material in output").toBe(false);
  expect(await snapshot(sandbox), "read-only command must leave HOME, credentials and project config byte/metadata-identical").toEqual(before);
  const wire = (await readFile(audit, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Wire);
  for (const request of wire) expect(request).toMatchObject({ method: "GET", origin: api, hasBody: false });
  return { ...result, wire };
}

function listing(result: Ran, generic = false): any[] {
  expect(result.code, "key listing must succeed, not return unknown_command").toBe(0);
  const json = JSON.parse(result.stdout);
  expect(json).toMatchObject({ keys: expect.any(Array) });
  if (Object.hasOwn(json, "ok")) expect(json.ok).toBe(true);
  if (generic) expect(Object.keys(json)).toEqual(["keys"]);
  expect(result.stderr).not.toMatch(/paste|enter.*(?:key|token)|sign in.*browser/i);
  expect(result.wire).toHaveLength(1);
  expect(result.wire[0]).toMatchObject({ path: "/api/v1/keys", method: "GET", hasBody: false });
  return json.keys;
}

function ownMetadata(keys: any[]) {
  expect(keys.map(k => k.id)).toEqual(["key_owner", "key_scoped", "key_expired"]);
  expect(keys[0]).toEqual({
    id: "key_owner", name: "Inventory agent", prefix: "dw_ownerFi", memberId: "mem_owner",
    scopes: ["keys:write", "members:write"], siteId: null, current: true,
    createdAt: "2026-01-01T00:00:06.000Z", lastUsedAt: expect.any(String), expiresAt: null, revoked: false,
  });
  expect(Number.isFinite(Date.parse(keys[0].lastUsedAt))).toBe(true);
  expect(keys[1]).toEqual({
    id: "key_scoped", name: "Site-only agent", prefix: "dw_scopedF", memberId: "mem_owner",
    scopes: ["keys:write"], siteId: "site_restricted", current: false,
    createdAt: "2026-01-01T00:00:05.000Z", lastUsedAt: expect.any(String),
    expiresAt: "2100-01-01T00:00:00.000Z", revoked: false,
  });
  expect(Number.isFinite(Date.parse(keys[1].lastUsedAt))).toBe(true);
  expect(keys[2]).toEqual({
    id: "key_expired", name: null, prefix: "dw_expired", memberId: "mem_owner",
    scopes: ["keys:write"], siteId: null, current: false, createdAt: "2026-01-01T00:00:04.000Z",
    lastUsedAt: null, expiresAt: "2000-01-01T00:00:00.000Z", revoked: false,
  });
}

describe("keys ls: native read-only acceptance", () => {
  it("lists only own safe API metadata as exactly one JSON value", async () => {
    const result = await cli(["keys", "ls", "--json"]);
    ownMetadata(listing(result));
    expect(result.wire[0]!.query).toBe("");
  });

  it("serializes explicit --all using a canonical true query and preserves server ordering/filtering", async () => {
    const result = await cli(["keys", "ls", "--all", "--json"]);
    const keys = listing(result);
    expect(keys.map(k => k.id)).toEqual(["key_owner", "key_scoped", "key_expired", "key_other", "key_reader"]);
    expect(["?all=1", "?all=true"]).toContain(result.wire[0]!.query);
    expect(keys.filter(k => k.current).map(k => k.id)).toEqual(["key_owner"]);
  });

  it("does not broaden --all when keys:write is present but members:write is absent", async () => {
    const result = await cli(["keys", "ls", "--all", "--json"], { key: tokens.other });
    const keys = listing(result);
    expect(keys.map(k => k.id)).toEqual(["key_other"]);
    expect(keys[0]).toMatchObject({ memberId: "mem_other", scopes: ["keys:write"], current: true });
    expect(["?all=1", "?all=true"]).toContain(result.wire[0]!.query);
  });

  it.each([{ flags: [] }, { flags: ["--all"] }])("retains the existing keys:write refusal with server code, hint and next action ($flags)", async ({ flags }) => {
    const result = await cli(["keys", "ls", ...flags, "--json"], { key: tokens.reader });
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, exitCode: 3, error: {
      code: "insufficient_scope", status: 403, retryable: false,
      message: 'Your credential lacks the "keys:write" scope needed for list_api_keys.', hint: scopeHint,
      details: { required: "keys:write", held: ["sites:read"] }, requestId: expect.any(String),
    } });
    expect(result.wire).toHaveLength(1);
    expect(result.wire[0]!.path).toBe("/api/v1/keys");
  });

  it("a site-restricted key retains the server's own-member listing and current marker", async () => {
    const result = await cli(["keys", "ls", "--json"], { key: tokens.restricted });
    const keys = listing(result);
    expect(keys.map(k => k.id)).toEqual(["key_owner", "key_scoped", "key_expired"]);
    expect(keys.filter(k => k.current).map(k => k.id)).toEqual(["key_scoped"]);
    expect(keys[1]).toMatchObject({ siteId: "site_restricted", scopes: ["keys:write"] });
    expect(result.wire[0]!.query).toBe("");
  });

  it("text-mode scope refusal retains the code and remediation on stderr", async () => {
    const result = await cli(["keys", "ls"], { key: tokens.reader });
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("insufficient_scope");
    expect(result.stderr).toContain(scopeHint);
    expect(result.wire).toHaveLength(1);
  });

  it("does not expose an invalid supplied key in an authentication error", async () => {
    const result = await cli(["keys", "ls", "--json"], { key: tokens.invalid });
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, exitCode: 3, error: {
      code: "invalid_api_key", status: 401, retryable: false, hint: expect.any(String),
    } });
    expect(JSON.parse(result.stdout).error.hint.length).toBeGreaterThan(0);
    expect(result.wire).toHaveLength(1);
  });

  it("handles a keyless fixture member's empty inventory without prompting or writes", async () => {
    expect(listing(await cli(["keys", "ls", "--json"], { key: tokens.empty }))).toEqual([]);
  });

  it("keeps an omitted current marker omitted instead of fabricating a decision", async () => {
    const keys = listing(await cli(["keys", "ls", "--json"], { key: tokens.keyless }));
    expect(keys).toEqual([{
      id: "key_other", name: "Other member", prefix: "dw_otherFi", memberId: "mem_other",
      scopes: ["keys:write"], siteId: null, createdAt: "2026-01-01T00:00:03.000Z",
      lastUsedAt: expect.any(String), expiresAt: null, revoked: false,
    }]);
  });

  it("text mode identifies the current key, scopes and site restriction without secrets", async () => {
    const result = await cli(["keys", "ls"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("key_owner");
    expect(result.stdout).toContain("dw_ownerFi");
    expect(result.stdout).toMatch(/current|\*/i);
    expect(result.stdout).toContain("keys:write");
    expect(result.stdout).toContain("site_restricted");
    expect(result.stdout).not.toContain("key_other");
    expect(result.wire).toHaveLength(1);
    expect(result.wire[0]).toMatchObject({ path: "/api/v1/keys", query: "" });
  });

  it("text mode describes an empty inventory predictably", async () => {
    const result = await cli(["keys", "ls"], { key: tokens.empty });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/no\s+(?:active\s+|api\s+)*keys|0\s+(?:active\s+|api\s+)*keys|empty/i);
    expect(result.wire).toHaveLength(1);
  });

  it("saved credentials are read without rewriting config or printing its unrelated session values", async () => {
    ownMetadata(listing(await cli(["keys", "ls", "--json"], { saved: true })));
  });

  it("does not create credentials/config files when authentication is supplied by environment", async () => {
    ownMetadata(listing(await cli(["keys", "ls", "--json"], { noConfig: true })));
  });

  it("retains the former environment aliases for native listing", async () => {
    ownMetadata(listing(await cli(["keys", "ls", "--json"], { legacy: true })));
  });

  it("explicit key and API flags retain precedence over environment and saved credentials", async () => {
    ownMetadata(listing(await cli(["keys", "ls", "--key", tokens.owner, "--api", api, "--json"], { key: tokens.invalid })));
  });

  it("the bundled executable exposes the same native JSON command", async () => {
    ownMetadata(listing(await cli(["keys", "ls", "--json"], { bundled: true })));
  });

  it.each([
    ["keys"], ["keys", "create"], ["keys", "revoke", "key_owner"],
    ["keys", "ls", "--unknown"], ["keys", "ls", "--method", "POST"],
    ["keys", "ls", "--data", "{}"], ["keys", "ls", "unexpected"],
  ])("refuses unsupported syntax without dispatching any API request: %j", async (...args) => {
    const result = await cli([...args, "--json"]);
    expect(result.code).toBe(2);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({ ok: false, exitCode: 2, error: {
      code: expect.stringMatching(/^[a-z][a-z0-9_]*$/), retryable: false, hint: expect.any(String),
    } });
    expect(json.error.hint.length).toBeGreaterThan(0);
    expect(result.wire).toEqual([]);
  });

  it.each([["help", "keys"], ["keys", "ls", "--help"]])("help discovers safe listing and --all/--json without network or credential writes: %j", async (...args) => {
    const result = await cli(args);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/keys\s+ls/);
    expect(result.stdout).toContain("--all");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toMatch(/keys:write/);
    expect(result.stdout).toMatch(/members:write/);
    expect(result.wire).toEqual([]);
  });
});

describe("keys listing: existing generic API compatibility controls", () => {
  it("generic GET /keys preserves safe REST metadata and credential-file compatibility", async () => {
    const result = await cli(["api", "GET", "/keys", "--json"], { saved: true });
    ownMetadata(listing(result, true));
    expect(result.wire[0]!.query).toBe("");
  });

  it("generic all=true remains server-authorized and tenant isolated", async () => {
    const result = await cli(["api", "GET", "/keys?all=true", "--json"]);
    expect(listing(result, true).map(k => k.id)).toEqual(["key_owner", "key_scoped", "key_expired", "key_other", "key_reader"]);
    expect(result.wire[0]!.query).toBe("?all=true");
  });

  it("generic --all wire still falls back to own keys without members:write", async () => {
    const result = await cli(["api", "GET", "/keys?all=1", "--json"], { key: tokens.other });
    expect(listing(result, true).map(k => k.id)).toEqual(["key_other"]);
    expect(result.wire[0]!.query).toBe("?all=1");
  });

  it("generic GET verifies the fixture's genuinely empty service result", async () => {
    expect(listing(await cli(["api", "GET", "/keys", "--json"], { key: tokens.empty }), true)).toEqual([]);
  });

  it("generic GET verifies that keyless identity omits current instead of setting false", async () => {
    const keys = listing(await cli(["api", "GET", "/keys", "--json"], { key: tokens.keyless }), true);
    expect(keys).toHaveLength(1);
    expect(keys[0].id).toBe("key_other");
    expect(Object.hasOwn(keys[0], "current")).toBe(false);
  });

  it("generic GET still refuses missing keys:write with the original next-action hint", async () => {
    const result = await cli(["api", "GET", "/keys", "--json"], { key: tokens.reader });
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, exitCode: 3, error: {
      code: "insufficient_scope", status: 403, retryable: false, hint: scopeHint,
      message: 'Your credential lacks the "keys:write" scope needed for list_api_keys.',
      details: { required: "keys:write", held: ["sites:read"] }, requestId: expect.any(String),
    } });
    expect(result.wire).toHaveLength(1);
  });
});
