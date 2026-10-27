/**
 * Acceptance: every CLI command refuses surplus positional arguments
 * before any side effect.
 *
 * Contract under test:
 * - Every command in the CLI command table declares its exact positional
 *   arity: a fixed count, or a bounded range for the genuinely optional
 *   cases (`versions`/`restore` 1-2, `operations` 0-1, `api` 1-2, the
 *   zero-positional commands 0). Surplus positionals -- including any
 *   arriving after `--` -- fail with the existing usage error
 *   (`Too many arguments. Usage: ...`, error code `usage`, exit code 2)
 *   in human and `--json` output alike. No new error code.
 * - The refusal happens before any side effect for every command: no
 *   filesystem stat/read of a publish target, no instance/key resolution
 *   (no ./dropway.json or credentials.json read can change the outcome),
 *   no network call, no stdin read, no prompt, no file written.
 * - Well-formed invocations are unchanged: exact-minimum and
 *   exact-maximum arity, subcommand dispatch (`keys ls`), aliases,
 *   `--flag=value`, bundled shorts, `--no-flag` and `--` all behave as
 *   before and are never refused as "too many".
 * - The command registry is enumerated from `kofra help` (which is
 *   generated from the command table), not from a hand-copied list: a
 *   future command added without an arity refusal fails the barrage
 *   test below, and the failure names the offending command.
 *
 * All invocations run the real CLI entry (`run()` from src/main.ts)
 * against an in-process stub instance and disposable temp directories.
 * Nothing touches a real server, home directory or credential store.
 *
 * On the baseline this file is expected to be RED for the commands that
 * silently ignore surplus positionals (publish, list, site, files,
 * versions, restore, delete, whoami, login, logout, setup, api) and for
 * the commands whose ad-hoc guards use a different message (duplicate,
 * keys). The pre-existing identical guards (read-file, access,
 * operations), the well-formed invocations, help discovery and flag
 * parsing already pass and must keep passing unmodified.
 *
 * Run: npm run test:cli -- test/surplus-positionals.acceptance.test.ts
 */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, type Io } from "../src/main.ts";

const API = "https://arity-stub.invalid";
const KEY = "dw_synthetic_arity_key_not_a_credential";
const BOOTSTRAP = "synthetic-bootstrap-value";
const USAGE_EXIT = 2;

// ---------------------------------------------------------------- harness

type WireCall = { method: string; pathname: string };

type Ran = {
  code: number;
  stdout: string;
  stderr: string;
  calls: WireCall[];
  prompts: string[];
  stdinReads: number;
  /** True when every seeded file (home + config dir) is byte- and metadata-identical after the run. */
  frozenOk: boolean;
};

type Dirs = { home: string; configDir: string };

type CliOpts = {
  stdin?: string;
  stdinIsTTY?: boolean;
  stderrIsTTY?: boolean;
  promptAnswer?: string;
  env?: (dirs: Dirs) => NodeJS.ProcessEnv;
  seed?: (dirs: Dirs) => Promise<void>;
  /** Assert inside the harness that no seeded file changed (default false; the result is in frozenOk). */
  frozen?: boolean;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const VERSION_1 = { id: "ver_1", number: 1, status: "ready", fileCount: 1, totalBytes: 24, createdAt: "2026-01-01T00:00:00.000Z", finalizedAt: "2026-01-01T00:00:00.000Z", message: null, client: null };
const VERSION_2 = { ...VERSION_1, id: "ver_2", number: 2, createdAt: "2026-01-02T00:00:00.000Z", finalizedAt: "2026-01-02T00:00:00.000Z" };

/** A stub instance answering just enough of /api/v1 for a well-formed invocation of any command to succeed. */
function stubInstance(input: Request): Response {
  const url = new URL(input.url);
  const path = url.pathname;
  const method = input.method;
  if (path === "/api/v1/me") {
    return jsonResponse(200, { principal: "member", member: { id: "mem_1", email: "owner@example.test", role: "owner" }, tenant: { id: "ten_1", name: "Fixture" }, keyId: "key_1", scopes: ["sites:read", "sites:write", "keys:write"], anonymousPublish: false });
  }
  if (path === "/api/v1/setup" && method === "POST") {
    return jsonResponse(200, { apiKey: { key: "dw_created_synthetic_key", id: "key_new" }, member: { email: "owner@example.test" }, tenant: { id: "ten_1" } });
  }
  if (path === "/api/v1/operations") {
    return jsonResponse(200, { operations: [{ id: "list_sites", method: "GET", path: "/api/v1/sites", scopes: ["sites:read"], inputSchema: { type: "object" } }] });
  }
  if (path === "/api/v1/keys") return jsonResponse(200, { keys: [] });
  if (path === "/api/v1/read-file") {
    return jsonResponse(200, { path: "index.html", versionId: "ver_2", contentType: "text/html", kind: "html", size: 24, sha256: "abc123", encoding: "text", offset: 0, length: 24, truncated: false, nextOffset: null, content: "<h1>arity fixture</h1>\n", url: `${API}/s/my-site/index.html`, rawUrl: `${API}/raw/index.html` });
  }
  if (path === "/api/v1/sites" && method === "GET") return jsonResponse(200, { sites: [], nextCursor: null });
  if (/\/access$/.test(path) && method === "PUT") {
    return jsonResponse(200, { site: { slug: "my-site", url: `${API}/s/my-site/`, title: null, settings: { passwordProtected: false } }, access: { mode: "public" } });
  }
  if (/\/restore$/.test(path) && method === "POST") {
    return jsonResponse(200, { restored: true, alreadyLive: false, version: VERSION_1, url: `${API}/s/my-site/` });
  }
  if (/\/duplicate$/.test(path) && method === "POST") {
    return jsonResponse(200, { slug: "copy-site", url: `${API}/s/copy-site/`, versionId: "ver_1", fileCount: 1, totalBytes: 24 });
  }
  if (/\/versions\/[^/]+$/.test(path) && method === "GET") {
    return jsonResponse(200, { site: "my-site", version: VERSION_1, missing: [] });
  }
  if (/\/versions$/.test(path) && method === "GET") {
    return jsonResponse(200, { currentVersionId: "ver_2", versions: [VERSION_2, VERSION_1] });
  }
  if (/\/files$/.test(path) && method === "GET") return jsonResponse(200, { version: null, files: [] });
  if (/^\/api\/v1\/sites\/[^/]+$/.test(path)) {
    if (method === "DELETE") return jsonResponse(200, { deleted: true });
    return jsonResponse(200, { site: { slug: "my-site", title: null, url: `${API}/s/my-site/`, currentVersion: null, settings: { spa: false, renderMarkdown: true, passwordProtected: false }, expiresAt: null, updatedAt: null } });
  }
  return jsonResponse(404, { error: { code: "not_found", message: `No stub route for ${method} ${path}.`, hint: "Stub instance." }, requestId: "req_stub" });
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const metadata = (info: { mode: bigint; mtimeNs: bigint; ctimeNs: bigint }) => `${info.mode}:${info.mtimeNs}:${info.ctimeNs}`;
  const directory = await stat(dir, { bigint: true });
  const result: Record<string, string> = { ".": metadata(directory) };
  for (const entry of (await readdir(dir)).sort()) {
    const path = join(dir, entry);
    const info = await stat(path, { bigint: true });
    if (info.isDirectory()) {
      for (const [nested, value] of Object.entries(await snapshot(path))) result[`${entry}/${nested}`] = value;
    } else {
      result[entry] = `${metadata(info)}:${(await readFile(path)).toString("base64")}`;
    }
  }
  return result;
}

async function snapshotAll(dirs: Dirs): Promise<string> {
  return JSON.stringify({ home: await snapshot(dirs.home), config: await snapshot(dirs.configDir) });
}

async function cli(args: string[], opts: CliOpts = {}): Promise<Ran> {
  const work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kofra-arity-"));
  const dirs: Dirs = { home: join(work, "project"), configDir: join(work, "config") };
  try {
    await mkdir(join(dirs.home, "dist"), { recursive: true });
    await mkdir(join(dirs.home, "secret-dist"), { recursive: true });
    await mkdir(dirs.configDir, { recursive: true });
    await writeFile(join(dirs.home, "dist", "index.html"), "<h1>arity fixture</h1>\n");
    // Looks like a credential to the publish secret scan: a surplus refusal
    // must win over ever reading this folder.
    await writeFile(join(dirs.home, "secret-dist", "index.html"), `<script>const k = "${"ghp_" + "a".repeat(36)}";</script>\n`);
    await writeFile(join(dirs.home, "data-bad.json"), "not-json-DATAFILE-SENTINEL");
    await writeFile(join(dirs.home, "untouched.txt"), "keep these bytes\n");
    await writeFile(join(dirs.home, "dropway.json"), JSON.stringify({ api: API, sites: { dist: "my-site" } }));
    await writeFile(join(dirs.configDir, "credentials.json"), JSON.stringify({ version: 1, default: API, instances: { [API]: { key: KEY, savedAt: "2026-01-01T00:00:00.000Z" } } }), { mode: 0o600 });
    if (opts.seed) await opts.seed(dirs);

    const before = await snapshotAll(dirs);
    let stdout = "";
    let stderr = "";
    let stdinReads = 0;
    const prompts: string[] = [];
    const calls: WireCall[] = [];
    const io: Io = {
      cwd: dirs.home,
      env: opts.env ? opts.env(dirs) : { KOFRA_API: API, KOFRA_API_KEY: KEY, KOFRA_CONFIG_DIR: dirs.configDir, KOFRA_BOOTSTRAP_KEY: BOOTSTRAP, HOME: dirs.home },
      stdout: (t) => void (stdout += t),
      stderr: (t) => void (stderr += t),
      stdinIsTTY: opts.stdinIsTTY ?? false,
      stderrIsTTY: opts.stderrIsTTY ?? false,
      readStdin: async () => {
        stdinReads++;
        return opts.stdin ?? "";
      },
      prompt: async (question) => {
        prompts.push(question);
        return opts.promptAnswer ?? "";
      },
      fetch: (async (input: Request) => {
        calls.push({ method: input.method, pathname: new URL(input.url).pathname });
        return stubInstance(input);
      }) as Io["fetch"],
    };
    const code = await run(args, io);
    const after = await snapshotAll(dirs);
    const frozenOk = before === after;
    if (opts.frozen) {
      expect(JSON.parse(after), "a surplus refusal must not write, delete or modify any seeded file (project, dropway.json, credentials)").toEqual(JSON.parse(before));
    }
    return { code, stdout, stderr, calls, prompts, stdinReads, frozenOk };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- assertions

function expectNoSideEffects(ran: Ran) {
  expect(ran.calls, "no network call may happen before the arity refusal").toEqual([]);
  expect(ran.prompts, "no prompt may happen before the arity refusal").toEqual([]);
  expect(ran.stdinReads, "stdin must not be read before the arity refusal").toBe(0);
  expect(ran.frozenOk, "no seeded file may be written or removed before the arity refusal").toBe(true);
}

function expectTooManyHuman(ran: Ran, usageCommand: string) {
  expect(ran.code, `expected the usage exit code, stdout+stderr: ${ran.stdout}${ran.stderr}`).toBe(USAGE_EXIT);
  expect(ran.stdout, "a human usage error writes nothing to stdout").toBe("");
  expect(ran.stderr).toContain(`Error (usage): Too many arguments. Usage: kofra ${usageCommand}`);
  expectNoSideEffects(ran);
}

/** Parse ALL of stdout as exactly one JSON object (rejects banners, JSONL, trailing notes). */
function jsonObject(ran: Ran): any {
  let parsed: any;
  try {
    parsed = JSON.parse(ran.stdout);
  } catch {
    throw new Error(`stdout must be exactly one JSON object (exit ${ran.code}): ${ran.stdout}`);
  }
  expect(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)).toBe(true);
  return parsed;
}

function expectTooManyJson(ran: Ran, usageCommand: string) {
  expect(ran.code, `expected the usage exit code, stdout+stderr: ${ran.stdout}${ran.stderr}`).toBe(USAGE_EXIT);
  const body = jsonObject(ran);
  expect(body).toMatchObject({ ok: false, exitCode: USAGE_EXIT, error: { code: "usage" } });
  expect(body.error.message).toContain(`Too many arguments. Usage: kofra ${usageCommand}`);
  expect(body.error.hint).toContain("--help");
  expectNoSideEffects(ran);
}

// ---------------------------------------------------------------- arity spec

type AritySpec = {
  /** Positional arguments of a well-formed invocation at exact-minimum arity. */
  min: string[];
  /** Positional arguments of a well-formed invocation at exact-maximum arity. */
  max: string[];
  /** Flags that make the invocation otherwise well-formed (never positional). */
  flags?: string[];
};

/**
 * The declared positional arity of every command on the baseline this file
 * was written against, expressed as concrete well-formed invocations.
 * `publish`/`duplicate` use their offline `--dry-run` form so the
 * well-formed cases need no server; every other command runs against the
 * stub instance above.
 */
const SPEC: Record<string, AritySpec> = {
  publish: { min: ["dist"], max: ["dist"], flags: ["--dry-run"] },
  duplicate: { min: ["source-site", "copy-site"], max: ["source-site", "copy-site"], flags: ["--dry-run"] },
  list: { min: [], max: [] },
  site: { min: ["my-site"], max: ["my-site"] },
  files: { min: ["my-site"], max: ["my-site"] },
  "read-file": { min: ["my-site", "index.html"], max: ["my-site", "index.html"] },
  versions: { min: ["my-site"], max: ["my-site", "v1"] },
  restore: { min: ["my-site"], max: ["my-site", "v1"] },
  delete: { min: ["my-site"], max: ["my-site"], flags: ["--yes"] },
  access: { min: ["my-site"], max: ["my-site"], flags: ["--mode", "public", "--yes"] },
  whoami: { min: [], max: [] },
  keys: { min: ["ls"], max: ["ls"] },
  login: { min: [], max: [], flags: ["--api", API, "--key", KEY] },
  logout: { min: [], max: [], flags: ["--api", API] },
  setup: { min: [], max: [], flags: ["--api", API, "--email", "owner@example.test", "--no-save"] },
  api: { min: ["/me"], max: ["GET", "/me"] },
  operations: { min: [], max: ["list_sites"] },
};

const ALIASES: Record<string, string> = {
  deploy: "publish",
  ls: "list",
  sites: "list",
  info: "site",
  rollback: "restore",
  rm: "delete",
};

const SPEC_ENTRIES = Object.entries(SPEC);

// ---------------------------------------------------------------- registry enumeration

async function discoverCommands(): Promise<string[]> {
  const ran = await cli(["help"]);
  expect(ran.code, ran.stdout + ran.stderr).toBe(0);
  expect(ran.calls, "help must stay offline").toEqual([]);
  const section = ran.stdout.split("Commands:\n")[1]?.split("\n\n")[0] ?? "";
  const names = section
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((name) => name.length > 0);
  expect(names.length, `could not enumerate the command table from help output:\n${ran.stdout}`).toBeGreaterThan(0);
  return names;
}

describe("the command registry itself is enumerated, not a hand-copied list", () => {
  it("every command this file pins is still registered in help", async () => {
    const discovered = await discoverCommands();
    const missing = Object.keys(SPEC).filter((name) => !discovered.includes(name));
    expect(missing, "commands with a pinned arity that no longer appear in the command table (renamed or removed?)").toEqual([]);
  });

  it("every command named in help refuses a barrage of surplus positionals before any side effect", async () => {
    // This is the future-proofing pin: a command added later without an
    // arity refusal is discovered here and named in the failure, even
    // though it has no SPEC row in this file.
    const discovered = await discoverCommands();
    const failures: string[] = [];
    for (const name of discovered) {
      const spec = SPEC[name];
      const extras = ["surplus-1", "surplus-2", "surplus-3", "surplus-4", "surplus-5", "surplus-6", "surplus-7", "surplus-8"];
      const args = spec ? [name, ...spec.max, ...extras, ...(spec.flags ?? [])] : [name, ...extras];
      const ran = await cli(args);
      const combined = ran.stdout + ran.stderr;
      const problems: string[] = [];
      if (ran.code !== USAGE_EXIT) problems.push(`exit ${ran.code}`);
      if (!combined.includes("Too many arguments.")) problems.push(`no "Too many arguments." refusal`);
      if (ran.calls.length > 0) problems.push(`${ran.calls.length} network call(s)`);
      if (ran.prompts.length > 0) problems.push(`${ran.prompts.length} prompt(s)`);
      if (ran.stdinReads > 0) problems.push(`${ran.stdinReads} stdin read(s)`);
      if (!ran.frozenOk) problems.push("seeded files changed");
      if (problems.length > 0) {
        failures.push(`${name}: ${problems.join(", ")} -- first output: ${(combined.split("\n")[0] ?? "").slice(0, 160)}`);
      }
    }
    expect(failures, "commands that do not refuse surplus positionals before any side effect").toEqual([]);
  });
});

// ---------------------------------------------------------------- per-command surplus refusal

describe("one surplus positional is refused, for every command, before any side effect", () => {
  it.each(SPEC_ENTRIES)("%s refuses max+1 positionals (human output)", async (name, spec) => {
    const ran = await cli([name, ...spec.max, "surplus-arg", ...(spec.flags ?? [])], { frozen: true });
    expectTooManyHuman(ran, name);
    expect(ran.stderr).toContain(`Fix: Run \`kofra ${name} --help\`.`);
  });

  it.each(SPEC_ENTRIES)("%s refuses a surplus positional arriving after --", async (name, spec) => {
    const ran = await cli([name, ...spec.max, ...(spec.flags ?? []), "--", "surplus-after-dashes"], { frozen: true });
    expectTooManyHuman(ran, name);
  });

  it.each(SPEC_ENTRIES)("%s refuses max+1 positionals in --json output with the usage envelope", async (name, spec) => {
    const ran = await cli([name, ...spec.max, "surplus-arg", ...(spec.flags ?? []), "--json"], { frozen: true });
    expectTooManyJson(ran, name);
  });

  it.each(SPEC_ENTRIES)("%s refuses max+3 positionals, not just one over", async (name, spec) => {
    const ran = await cli([name, ...spec.max, "extra-1", "extra-2", "extra-3", ...(spec.flags ?? [])], { frozen: true });
    expectTooManyHuman(ran, name);
  });

  it.each(SPEC_ENTRIES)("%s refuses a surplus positional that arrives before its flags are complete", async (name, spec) => {
    // Flags first, positionals last: the surplus still counts, and the
    // refusal still precedes instance resolution and networking.
    const ran = await cli([name, ...(spec.flags ?? []), ...spec.max, "surplus-arg"], { frozen: true });
    expectTooManyHuman(ran, name);
  });
});

describe("aliases obey the canonical command's arity", () => {
  it.each(Object.entries(ALIASES))("%s (alias of %s) refuses a surplus positional", async (alias, canonical) => {
    const spec = SPEC[canonical]!;
    const ran = await cli([alias, ...spec.max, "surplus-arg", ...(spec.flags ?? [])], { frozen: true });
    expectTooManyHuman(ran, canonical);
  });

  it.each(Object.entries(ALIASES))("%s (alias of %s) still runs at exact-maximum arity", async (alias, canonical) => {
    const spec = SPEC[canonical]!;
    const ran = await cli([alias, ...spec.max, ...(spec.flags ?? []), "--json"]);
    expect(ran.stdout + ran.stderr).not.toContain("Too many arguments.");
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
  });
});

// ---------------------------------------------------------------- well-formed invocations unchanged

describe("well-formed invocations at exact-minimum and exact-maximum arity are unchanged", () => {
  it.each(SPEC_ENTRIES)("%s at exact-minimum arity succeeds and is never called surplus", async (name, spec) => {
    const ran = await cli([name, ...spec.min, ...(spec.flags ?? []), "--json"]);
    expect(ran.stdout + ran.stderr).not.toContain("Too many arguments.");
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
  });

  it.each(SPEC_ENTRIES)("%s at exact-maximum arity succeeds and is never called surplus", async (name, spec) => {
    const ran = await cli([name, ...spec.max, ...(spec.flags ?? []), "--json"]);
    expect(ran.stdout + ran.stderr).not.toContain("Too many arguments.");
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
  });

  it("positionals after -- still count as the declared arguments, not as surplus", async () => {
    const publish = await cli(["publish", "--dry-run", "--json", "--", "dist"]);
    expect(publish.code, publish.stdout + publish.stderr).toBe(0);
    expect(publish.stdout).toContain("index.html");

    const versions = await cli(["versions", "my-site", "--json", "--", "v1"]);
    expect(versions.stdout + versions.stderr).not.toContain("Too many arguments.");
    expect(versions.code, versions.stdout + versions.stderr).toBe(0);
  });

  it("flag forms are unchanged at exact arity: --flag=value, bundled shorts, --no-flag, keys ls dispatch", async () => {
    const byValue = await cli(["site", `--api=${API}`, `--key=${KEY}`, "my-site", "--json"]);
    expect(byValue.code, byValue.stdout + byValue.stderr).toBe(0);

    const bundled = await cli(["delete", "my-site", "-y", "--json"]);
    expect(bundled.code, bundled.stdout + bundled.stderr).toBe(0);

    const negated = await cli(["publish", "dist", "--dry-run", "--no-save", "--json"]);
    expect(negated.code, negated.stdout + negated.stderr).toBe(0);

    const subcommand = await cli(["keys", "ls", "--json"]);
    expect(subcommand.code, subcommand.stdout + subcommand.stderr).toBe(0);
    expect(jsonObject(subcommand)).toMatchObject({ ok: true, keys: [] });
  });

  it("an unknown flag still fails loudly as a usage error before any network call", async () => {
    const ran = await cli(["site", "my-site", "--nope", "--json"], { frozen: true });
    expect(ran.code).toBe(USAGE_EXIT);
    expect(jsonObject(ran).error.code).toBe("usage");
    expect(ran.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------- pinned pre-side-effect probes

const poisonedInstanceSeed = async ({ home, configDir }: Dirs) => {
  // If the command resolved the instance before refusing, it would read
  // this poisoned link/credentials pair and fail on the ftp: URL (or try
  // to reach it) instead of reporting the surplus argument.
  await writeFile(join(home, "dropway.json"), JSON.stringify({ api: "ftp://poison.invalid", sites: { dist: "poison-site" } }));
  await writeFile(join(configDir, "credentials.json"), JSON.stringify({ version: 1, default: "ftp://poison.invalid", instances: { "ftp://poison.invalid": { key: "dw_poison", savedAt: "2026-01-01T00:00:00.000Z" } } }), { mode: 0o600 });
};
const bareEnv = ({ configDir, home }: Dirs): NodeJS.ProcessEnv => ({ KOFRA_CONFIG_DIR: configDir, HOME: home });

describe("publish refuses surplus before stat, file collection, secret scan or instance resolution", () => {
  it("a missing target is never statted: surplus wins over path_not_found", async () => {
    const ran = await cli(["publish", "no-such-target", "surplus-arg", "--api", API, "--key", KEY], { frozen: true });
    expectTooManyHuman(ran, "publish");
    expect(ran.stderr).not.toContain("No such file or directory");
  });

  it("--dry-run with a real folder lists nothing: surplus wins over collecting files", async () => {
    const ran = await cli(["publish", "dist", "surplus-arg", "--dry-run", "--json"], { frozen: true });
    expectTooManyJson(ran, "publish");
    expect(ran.stdout).not.toContain("index.html");
  });

  it("--dry-run over a folder that would trip the secret scan never reads it", async () => {
    const ran = await cli(["publish", "secret-dist", "surplus-arg", "--dry-run", "--json"], { frozen: true });
    expectTooManyJson(ran, "publish");
    expect(ran.stdout).not.toContain("possible_secrets");
    expect(ran.stdout).not.toContain("ghp_");
  });

  it("poisoned dropway.json/credentials cannot change the outcome: no instance or key resolution happens first", async () => {
    const ran = await cli(["publish", "dist", "surplus-arg"], { frozen: true, seed: poisonedInstanceSeed, env: bareEnv });
    expectTooManyHuman(ran, "publish");
    expect(ran.stdout + ran.stderr).not.toContain("poison");
    expect(ran.stdout + ran.stderr).not.toContain("ftp:");
  });
});

describe("delete refuses surplus before resolution, confirmation prompt and the DELETE call", () => {
  it("with --yes and a stub that would succeed, nothing is contacted", async () => {
    const ran = await cli(["delete", "my-site", "extra", "--yes"], { frozen: true });
    expectTooManyHuman(ran, "delete");
    expect(ran.stderr).not.toContain("Deleted");
  });

  it("in a terminal without --yes, the type-to-confirm prompt is never shown", async () => {
    const ran = await cli(["delete", "my-site", "extra"], { frozen: true, stdinIsTTY: true, stderrIsTTY: true, promptAnswer: "my-site" });
    expectTooManyHuman(ran, "delete");
  });
});

describe("restore refuses surplus before resolution and any version lookup", () => {
  it("with a stub that would restore, nothing is contacted", async () => {
    const ran = await cli(["restore", "my-site", "v1", "surplus-arg"], { frozen: true });
    expectTooManyHuman(ran, "restore");
  });

  it("poisoned dropway.json/credentials cannot change the outcome", async () => {
    const ran = await cli(["restore", "my-site", "v1", "surplus-arg"], { frozen: true, seed: poisonedInstanceSeed, env: bareEnv });
    expectTooManyHuman(ran, "restore");
    expect(ran.stdout + ran.stderr).not.toContain("poison");
    expect(ran.stdout + ran.stderr).not.toContain("ftp:");
  });
});

describe("login refuses surplus before prompts, stdin, the key check and saving credentials", () => {
  it("with --api/--key and a stub that would accept the key, credentials stay byte-identical", async () => {
    const ran = await cli(["login", "stray-positional", "--api", API, "--key", KEY], { frozen: true });
    expectTooManyHuman(ran, "login");
    expect(ran.stdout + ran.stderr).not.toContain("Logged in");
  });

  it("with nothing configured in a terminal, neither the URL prompt nor the key prompt is shown and stdin is untouched", async () => {
    const ran = await cli(["login", "stray-positional"], {
      frozen: true,
      stdinIsTTY: true,
      stderrIsTTY: true,
      promptAnswer: API,
      env: bareEnv,
      seed: async ({ home, configDir }) => {
        await rm(join(home, "dropway.json"), { force: true });
        await rm(join(configDir, "credentials.json"), { force: true });
      },
    });
    expectTooManyHuman(ran, "login");
  });
});

describe("api refuses surplus before resolution, --data file/stdin reads and the request", () => {
  it("a third positional is refused and the endpoint is never called", async () => {
    const ran = await cli(["api", "GET", "/me", "surplus-arg"], { frozen: true });
    expectTooManyHuman(ran, "api");
  });

  it("the operation-id form refuses a third positional too (no catalog fetch)", async () => {
    const ran = await cli(["api", "list_sites", "extra-1", "extra-2"], { frozen: true });
    expectTooManyHuman(ran, "api");
  });

  it("--data @file is never read: surplus wins over the JSON parse of a broken file", async () => {
    const ran = await cli(["api", "POST", "/keys", "surplus-arg", "--data", "@data-bad.json"], { frozen: true });
    expectTooManyHuman(ran, "api");
    expect(ran.stdout + ran.stderr).not.toContain("--data must be JSON");
    expect(ran.stdout + ran.stderr).not.toContain("DATAFILE-SENTINEL");
  });

  it("--data - never reads stdin when a surplus positional is present", async () => {
    const ran = await cli(["api", "GET", "/me", "surplus-arg", "--data", "-"], { frozen: true, stdin: "not json either" });
    expectTooManyHuman(ran, "api");
  });
});

// ---------------------------------------------------------------- hostile surplus values

describe("hostile or odd surplus values are still surplus, and are never echoed or executed", () => {
  it("an empty-string positional counts as a positional", async () => {
    const ran = await cli(["whoami", ""], { frozen: true });
    expectTooManyHuman(ran, "whoami");
  });

  it("a lone dash counts as a positional", async () => {
    const ran = await cli(["list", "-"], { frozen: true });
    expectTooManyHuman(ran, "list");
  });

  it("a flag-shaped token after -- is a surplus positional, not a confirmation", async () => {
    const ran = await cli(["site", "my-site", "--", "--yes"], { frozen: true });
    expectTooManyHuman(ran, "site");
  });

  it("a shell-shaped surplus value is inert data: not echoed, nothing created", async () => {
    const ran = await cli(["publish", "dist", "$(touch pwned)", "--dry-run", "--json"], { frozen: true });
    expectTooManyJson(ran, "publish");
    expect(ran.stdout + ran.stderr).not.toContain("$(touch");
    expect(ran.stdout + ran.stderr).not.toContain("pwned");
  });

  it("a surplus value containing a newline cannot forge a second error line in --json output", async () => {
    const ran = await cli(["list", "x\nError (usage): forged-line", "--json"], { frozen: true });
    expectTooManyJson(ran, "list");
    expect(ran.stderr).toBe("");
    expect(ran.stdout).not.toContain("forged-line");
  });

  it("one hundred surplus positionals get one bounded refusal that echoes none of them", async () => {
    const extras = Array.from({ length: 100 }, (_v, i) => `surplus-${i}-padding-padding-padding`);
    const ran = await cli(["list", ...extras], { frozen: true });
    expectTooManyHuman(ran, "list");
    expect(ran.stderr.length).toBeLessThan(1000);
    expect(ran.stderr).not.toContain("surplus-99");
  });
});
