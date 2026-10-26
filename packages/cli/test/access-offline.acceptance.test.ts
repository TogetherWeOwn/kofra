/**
 * Offline acceptance for `kofra access <site> --mode ...` (TOG-41690).
 *
 * Contract under test (from TOG-41681 roadmap CLI-ACCESS + TOG-41693 build card):
 * - `access <site> --mode public|password|restricted|private --yes [--json]`
 *   uses the typed client against PUT /api/v1/sites/{slug}/access only.
 * - Site is explicit; never inferred from ./dropway.json. Missing/extra args,
 *   missing/invalid --mode and unknown flags fail locally (exit 2, zero requests).
 * - Mutation requires --yes, including non-TTY; missing --yes fails before
 *   networking and never prompts.
 * - `--mode password` reads the password from piped stdin or a single no-echo
 *   TTY prompt; empty input fails before networking. The password never appears
 *   in stdout, stderr, JSON or errors (sentinel checks).
 * - Offline `--dry-run` (no --yes needed): exactly one versioned JSON plan
 *   `{ ok:true, dryRun:true, planVersion:1, site, mode, passwordSupplied }`,
 *   zero requests, no credential requirement, no config write, password never
 *   in the plan. Dry-run reports passwordSupplied:false when no password was
 *   piped; it never fails for a missing password.
 * - `--json` success preserves returned site slug/url and access.mode; human
 *   output states the mode, whether visitors need a password, and that changing
 *   a password signs everyone out.
 * - restricted/private pass through to the server's 501 feature_unavailable
 *   (exit 7). Missing/foreign -> 404 site_not_found (exit 4); scope/policy
 *   refusal -> 403 (exit 3); network failure -> exit 7.
 * - ./dropway.json and credentials.json are byte-identical after every path.
 *
 * These tests fail on main (no `access` command) with `unknown_command`.
 * Every negative case asserts the code is NOT unknown_command so a missing
 * command cannot accidentally pass.
 *
 * Run: npm run test:cli -- test/access-offline.acceptance.test.ts
 */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type Io } from "../src/main.ts";

const SENTINEL = "access-sentinel-pw-9f8e7d6c5b4a9137845f6a7b8c9d0e1f2a3b4";
const SENTINEL_TTY = "access-tty-sentinel-pw-1a2b3c4d5e6f708192a3b4c5d6e7f8091a2";
const API = "https://access-stub.invalid";
const KEY = "dw_synthetic_not_a_credential";

type Wire = { method: string; url: URL; auth: string | null; body: unknown };
type Ran = {
  code: number;
  stdout: string;
  stderr: string;
  wire: Wire[];
  prompts: number;
  promptHidden: boolean[];
  stdinReads: number;
};

let work: string;
let home: string;
let configDir: string;

beforeEach(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kofra-access-offline-"));
  home = join(work, "project");
  configDir = join(work, "config");
  await mkdir(home, { recursive: true });
  await mkdir(configDir, { recursive: true });
  // A mapping the command must ignore (site is explicit) and must not modify.
  await writeFile(join(home, "dropway.json"), JSON.stringify({ api: API, sites: { ".": "mapped-should-be-ignored" } }));
  await writeFile(join(home, "untouched.txt"), "keep these bytes\n");
  await writeFile(join(configDir, "credentials.json"), JSON.stringify({ version: 1, default: API, instances: { [API]: { key: KEY, savedAt: "2026-01-01T00:00:00.000Z" } } }), { mode: 0o600 });
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
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

async function configSnapshot(): Promise<Record<string, string>> {
  return snapshot(configDir);
}

function assertNoSentinel(text: string, what: string) {
  expect(text.includes(SENTINEL), `${what} must not contain the piped password`).toBe(false);
  expect(text.includes(SENTINEL_TTY), `${what} must not contain the prompted password`).toBe(false);
}

async function cli(
  args: string[],
  opts: {
    stdin?: string;
    stdinIsTTY?: boolean;
    stderrIsTTY?: boolean;
    promptImpl?: (question: string, o?: { hidden?: boolean }) => Promise<string>;
    fetchImpl?: Io["fetch"];
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<Ran> {
  const beforeHome = await snapshot(home);
  const beforeConfig = await configSnapshot();
  let stdout = "";
  let stderr = "";
  let prompts = 0;
  const promptHidden: boolean[] = [];
  let stdinReads = 0;
  const wire: Wire[] = [];
  const io: Io = {
    cwd: home,
    env: opts.env ?? { KOFRA_API: API, KOFRA_API_KEY: KEY, KOFRA_CONFIG_DIR: configDir, HOME: home },
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    stdinIsTTY: opts.stdinIsTTY ?? false,
    stderrIsTTY: opts.stderrIsTTY ?? false,
    readStdin: async () => {
      stdinReads++;
      return opts.stdin ?? "";
    },
    prompt: async (question, o) => {
      prompts++;
      promptHidden.push(o?.hidden === true);
      if (opts.promptImpl) return opts.promptImpl(question, o);
      throw new Error("unexpected prompt in offline access test");
    },
    fetch: opts.fetchImpl
      ?? (async () => {
        throw new Error("offline access validation must make zero requests");
      }),
  };
  // Wrap fetch to record calls when a stub is provided.
  if (opts.fetchImpl) {
    const inner = opts.fetchImpl;
    io.fetch = (async (input: Request) => {
      const url = new URL(input.url);
      let body: unknown = null;
      if (input.method !== "GET" && input.method !== "HEAD") {
        const text = await input.text();
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
      }
      wire.push({ method: input.method, url, auth: input.headers.get("authorization"), body });
      return inner(input);
    }) as Io["fetch"];
  }
  const code = await run(args, io);
  expect(await snapshot(home), "access must leave project mappings byte-identical").toEqual(beforeHome);
  expect(await configSnapshot(), "access must leave credentials byte-identical").toEqual(beforeConfig);
  return { code, stdout, stderr, wire, prompts, promptHidden, stdinReads };
}

/** Parse ALL of stdout as exactly one JSON object (rejects banners, JSONL, trailing notes). */
function object(r: Ran): any {
  let parsed: any;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`stdout must be exactly one JSON object (exit ${r.code}): ${r.stdout}`);
  }
  expect(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)).toBe(true);
  return parsed;
}

function stubJson(status: number, body: unknown): Io["fetch"] {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as Io["fetch"];
}

const successBody = (mode: string) => ({
  site: { slug: "explicit-site", url: `${API}/s/explicit-site/`, title: null, settings: { passwordProtected: mode === "password" } },
  access: { mode },
});

describe("access help is offline", () => {
  it.each([["access", "--help"], ["help", "access"]])("shows %j without network", async (...args) => {
    const r = await cli(args, { env: { KOFRA_CONFIG_DIR: configDir, HOME: home } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toEqual([]);
    expect(r.prompts).toBe(0);
    for (const token of ["access", "<site>", "--mode", "--yes", "--dry-run", "--json", "password", "public"]) {
      expect(r.stdout).toContain(token);
    }
  });

  it("advertises access alongside existing commands in global help", async () => {
    const r = await cli(["help"], { env: { KOFRA_CONFIG_DIR: configDir, HOME: home } });
    expect(r.code).toBe(0);
    expect(r.wire).toEqual([]);
    for (const command of ["access", "publish", "files", "versions", "api"]) expect(r.stdout).toContain(command);
  });
});

describe("explicit-site and argv validation fails before any request", () => {
  it.each([
    ["missing site", ["access", "--mode", "public", "--yes", "--json"], {}],
    ["missing site (password with piped input)", ["access", "--mode", "password", "--yes", "--json"], { stdin: SENTINEL }],
    ["extra positional", ["access", "my-site", "extra", "--mode", "public", "--yes", "--json"], {}],
    ["missing --mode", ["access", "my-site", "--yes", "--json"], {}],
    ["invalid --mode", ["access", "my-site", "--mode", "banana", "--yes", "--json"], {}],
    ["missing --mode value", ["access", "my-site", "--mode", "--json"], {}],
    ["unknown flag", ["access", "my-site", "--mode", "public", "--yes", "--nope", "--json"], {}],
    ["dry-run still needs a site", ["access", "--mode", "public", "--dry-run", "--json"], {}],
    ["dry-run still needs a mode", ["access", "my-site", "--dry-run", "--json"], {}],
    ["dry-run rejects an invalid mode", ["access", "my-site", "--mode", "banana", "--dry-run", "--json"], {}],
  ])("%s", async (_name, args, opts: { stdin?: string }) => {
    const first = await cli(args, opts);
    const again = await cli(args, opts);
    expect(first.wire).toEqual([]);
    expect(again.wire).toEqual([]);
    expect(first.prompts).toBe(0);
    expect(first.code).toBe(2);
    expect(again.code).toBe(2);
    const a = object(first);
    const b = object(again);
    expect(a).toMatchObject({ ok: false, exitCode: 2, error: { code: expect.stringMatching(/^[a-z][a-z0-9_]*$/), hint: expect.any(String) } });
    expect(a.error.code, "access must be a registered command before argv validation").not.toBe("unknown_command");
    expect(a.error.hint.trim().length).toBeGreaterThan(0);
    expect(b.error.code).toBe(a.error.code);
    expect(b.error.hint).toBe(a.error.hint);
    assertNoSentinel(first.stdout + first.stderr, "validation error");
  });

  it("never infers the site from ./dropway.json", async () => {
    // dropway.json maps "." -> mapped-should-be-ignored; the command must still
    // demand an explicit site and must use the explicit value when given.
    const missing = await cli(["access", "--mode", "public", "--yes", "--json"]);
    expect(missing.code).toBe(2);
    expect(missing.wire).toEqual([]);
    expect(object(missing).error.code).not.toBe("unknown_command");

    const r = await cli(["access", "explicit-site", "--mode", "public", "--dry-run", "--json"], {
      env: { KOFRA_CONFIG_DIR: configDir, HOME: home },
    });
    expect(r.code).toBe(0);
    expect(object(r)).toMatchObject({ site: "explicit-site" });
    expect(r.stdout).not.toContain("mapped-should-be-ignored");
  });
});

describe("--yes is required, including non-TTY, before any networking", () => {
  it.each([
    ["public", ["access", "my-site", "--mode", "public", "--json"], {}],
    ["password with piped input", ["access", "my-site", "--mode", "password", "--json"], { stdin: SENTINEL }],
    ["restricted", ["access", "my-site", "--mode", "restricted", "--json"], {}],
  ])("refuses %s without --yes and never prompts", async (_name, args, opts: { stdin?: string }) => {
    const first = await cli(args, opts);
    const again = await cli(args, opts);
    expect(first.wire).toEqual([]);
    expect(again.wire).toEqual([]);
    expect(first.prompts, "missing --yes must never prompt").toBe(0);
    expect(first.code).toBe(2);
    expect(again.code).toBe(2);
    const a = object(first);
    expect(a.error.code).not.toBe("unknown_command");
    expect(a.error.hint).toMatch(/--yes/);
    expect(object(again).error.code).toBe(a.error.code);
    assertNoSentinel(first.stdout + first.stderr, "confirmation refusal");
  });
});

describe("offline --dry-run plans without credentials, requests or writes", () => {
  const offlineEnv = () => ({ KOFRA_CONFIG_DIR: configDir, HOME: home });

  it("plans public with zero requests and no credential requirement", async () => {
    const r = await cli(["access", "explicit-site", "--mode", "public", "--dry-run", "--json"], { env: offlineEnv() });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toEqual([]);
    expect(r.prompts).toBe(0);
    expect(object(r)).toEqual({ ok: true, dryRun: true, planVersion: 1, site: "explicit-site", mode: "public", passwordSupplied: false });
  });

  it("reports passwordSupplied:true without ever placing the password in the plan", async () => {
    const r = await cli(["access", "explicit-site", "--mode", "password", "--dry-run", "--json"], { env: offlineEnv(), stdin: `${SENTINEL}\n` });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toEqual([]);
    const plan = object(r);
    expect(plan).toEqual({ ok: true, dryRun: true, planVersion: 1, site: "explicit-site", mode: "password", passwordSupplied: true });
    expect(JSON.stringify(plan)).not.toContain(SENTINEL);
    assertNoSentinel(r.stdout + r.stderr, "dry-run plan");
  });

  it("reports passwordSupplied:false instead of failing when no password was piped", async () => {
    for (const stdin of ["", "   \n"]) {
      const r = await cli(["access", "explicit-site", "--mode", "password", "--dry-run", "--json"], { env: offlineEnv(), stdin });
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.wire).toEqual([]);
      expect(object(r)).toMatchObject({ dryRun: true, planVersion: 1, site: "explicit-site", mode: "password", passwordSupplied: false });
    }
  });

  it.each(["restricted", "private"])("plans %s offline without contacting the server", async (mode) => {
    const r = await cli(["access", "explicit-site", "--mode", mode, "--dry-run", "--json"], { env: offlineEnv() });
    expect(r.code).toBe(0);
    expect(r.wire).toEqual([]);
    expect(object(r)).toMatchObject({ dryRun: true, planVersion: 1, site: "explicit-site", mode, passwordSupplied: false });
  });

  it("ignores even malformed configured URLs and never echoes environment values", async () => {
    const r = await cli(["access", "explicit-site", "--mode", "password", "--dry-run", "--json"], {
      env: { KOFRA_CONFIG_DIR: configDir, HOME: home, KOFRA_API: "ftp://INVALID_ENV_SENTINEL", KOFRA_API_KEY: "ENV_VALUE_SENTINEL" },
      stdin: SENTINEL,
    });
    expect(r.code).toBe(0);
    expect(r.wire).toEqual([]);
    expect(r.stdout + r.stderr).not.toMatch(/INVALID_ENV_SENTINEL|ENV_VALUE_SENTINEL/);
    assertNoSentinel(r.stdout + r.stderr, "dry-run plan");
  });

  it("needs no --yes and keeps human dry-run free of the password", async () => {
    const r = await cli(["access", "explicit-site", "--mode", "password", "--dry-run"], { env: offlineEnv(), stdin: SENTINEL });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toEqual([]);
    expect(r.stdout).toContain("explicit-site");
    expect(r.stdout).toMatch(/password/i);
    assertNoSentinel(r.stdout + r.stderr, "human dry-run");

    const withYes = await cli(["access", "explicit-site", "--mode", "password", "--dry-run", "--json", "--yes"], { env: offlineEnv(), stdin: SENTINEL });
    expect(withYes.code).toBe(0);
    expect(object(withYes)).toMatchObject({ dryRun: true, passwordSupplied: true });
  });
});

describe("password paths: piped stdin, TTY prompt, empty refusal, no leakage", () => {
  it("accepts a piped password, sends it once in the PUT body, and never echoes it", async () => {
    const r = await cli(["access", "explicit-site", "--mode", "password", "--yes", "--json"], {
      stdin: `${SENTINEL}\n`,
      fetchImpl: stubJson(200, successBody("password")),
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.prompts).toBe(0);
    expect(r.wire).toHaveLength(1);
    const call = r.wire[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url.origin).toBe(API);
    expect(call.url.pathname).toBe("/api/v1/sites/explicit-site/access");
    expect(call.url.search).toBe("");
    expect(call.auth).toBe(`Bearer ${KEY}`);
    expect(call.body).toEqual({ mode: "password", password: SENTINEL });
    const result = object(r);
    expect(result).toMatchObject({ ok: true, site: { slug: "explicit-site", url: `${API}/s/explicit-site/` }, access: { mode: "password" } });
    assertNoSentinel(r.stdout + r.stderr, "password success");
    assertNoSentinel(JSON.stringify(result), "password JSON");
  });

  it.each([["empty", ""], ["whitespace-only", "   \n\t  "]])("refuses %s piped input before any networking", async (_name, stdin) => {
    const r = await cli(["access", "explicit-site", "--mode", "password", "--yes", "--json"], { stdin });
    expect(r.wire).toEqual([]);
    expect(r.prompts).toBe(0);
    expect(r.code).toBe(2);
    const result = object(r);
    expect(result.ok).toBe(false);
    expect(result.error.code).not.toBe("unknown_command");
    expect(result.error.code).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(result.error.hint).toMatch(/password/i);
  });

  it("takes the password from a single no-echo TTY prompt", async () => {
    let calls = 0;
    const r = await cli(["access", "explicit-site", "--mode", "password", "--yes", "--json"], {
      stdinIsTTY: true,
      stderrIsTTY: true,
      promptImpl: async () => {
        calls++;
        return SENTINEL_TTY;
      },
      fetchImpl: stubJson(200, successBody("password")),
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(calls).toBe(1);
    expect(r.promptHidden).toEqual([true]);
    expect(r.wire).toHaveLength(1);
    expect(r.wire[0]!.body).toEqual({ mode: "password", password: SENTINEL_TTY });
    assertNoSentinel(r.stdout + r.stderr, "TTY password success");
  });

  it("refuses an empty TTY prompt before any networking", async () => {
    const r = await cli(["access", "explicit-site", "--mode", "password", "--yes", "--json"], {
      stdinIsTTY: true,
      stderrIsTTY: true,
      promptImpl: async () => "   ",
    });
    expect(r.wire).toEqual([]);
    expect(r.code).toBe(2);
    expect(object(r).error.code).not.toBe("unknown_command");
  });
});

describe("--mode public clears via the existing endpoint only", () => {
  it("sends exactly one PUT without a password and preserves site identity in JSON", async () => {
    const r = await cli(["access", "explicit-site", "--mode", "public", "--yes", "--json"], {
      fetchImpl: stubJson(200, successBody("public")),
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toHaveLength(1);
    expect(r.wire[0]!.method).toBe("PUT");
    expect(r.wire[0]!.url.pathname).toBe("/api/v1/sites/explicit-site/access");
    expect(r.wire[0]!.body).toEqual({ mode: "public" });
    expect(object(r)).toMatchObject({ ok: true, site: { slug: "explicit-site", url: `${API}/s/explicit-site/` }, access: { mode: "public" } });
  });

  it("states public mode and the no-password outcome in human output", async () => {
    const r = await cli(["access", "explicit-site", "--mode", "public", "--yes"], {
      fetchImpl: stubJson(200, successBody("public")),
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toHaveLength(1);
    expect(r.stdout).toMatch(/public/i);
    expect(r.stdout).toMatch(/password/i);
  });

  it("states password mode, the visitor gate and the sign-out warning in human output", async () => {
    const r = await cli(["access", "explicit-site", "--mode", "password", "--yes"], {
      stdin: SENTINEL,
      fetchImpl: stubJson(200, successBody("password")),
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toHaveLength(1);
    expect(r.stdout).toMatch(/password/i);
    expect(r.stdout).toMatch(/visitor/i);
    expect(r.stdout).toMatch(/signs everyone out/i);
    assertNoSentinel(r.stdout + r.stderr, "human password success");
  });
});

describe("restricted/private pass through the server's feature_unavailable", () => {
  it.each(["restricted", "private"])("surfaces 501 %s honestly with exit 7", async (mode) => {
    const serverHint = 'Use "password" to keep a site away from the public.';
    const r = await cli(["access", "explicit-site", "--mode", mode, "--yes", "--json"], {
      fetchImpl: stubJson(501, { error: { code: "feature_unavailable", message: `Access mode "${mode}" is not available.`, hint: serverHint } }),
    });
    expect(r.wire).toHaveLength(1);
    expect(r.wire[0]!.method).toBe("PUT");
    expect(r.wire[0]!.body).toEqual({ mode });
    expect(r.code).toBe(7);
    expect(object(r)).toMatchObject({ ok: false, exitCode: 7, error: { code: "feature_unavailable", hint: serverHint, status: 501 } });
  });
});

describe("stable exits for missing, refused and failed requests", () => {
  it("maps a missing or foreign site to exit 4 without leaking existence", async () => {
    const r = await cli(["access", "ghost-site", "--mode", "public", "--yes", "--json"], {
      fetchImpl: stubJson(404, { error: { code: "site_not_found", message: 'No site "ghost-site".', hint: "List your sites." } }),
    });
    expect(r.wire).toHaveLength(1);
    expect(r.wire[0]!.url.pathname).toBe("/api/v1/sites/ghost-site/access");
    expect(r.code).toBe(4);
    expect(object(r)).toMatchObject({ ok: false, exitCode: 4, error: { code: "site_not_found", status: 404 } });
  });

  it.each([
    ["scope refusal", "insufficient_scope", 'This key lacks the "sites:write" scope.'],
    ["site-restricted key", "key_site_restricted", "This key is restricted to one site."],
  ])("maps %s to exit 3", async (_name, code, message) => {
    const r = await cli(["access", "explicit-site", "--mode", "public", "--yes", "--json"], {
      fetchImpl: stubJson(403, { error: { code, message, hint: "Use a key with that scope." } }),
    });
    expect(r.wire).toHaveLength(1);
    expect(r.code).toBe(3);
    expect(object(r)).toMatchObject({ ok: false, exitCode: 3, error: { code, status: 403 } });
  });

  it("maps a retryable server failure to exit 7", async () => {
    const r = await cli(["access", "explicit-site", "--mode", "public", "--yes", "--json"], {
      fetchImpl: stubJson(503, { error: { code: "temporarily_unavailable", message: "try again", hint: "Retry shortly." } }),
    });
    expect(r.wire).toHaveLength(1);
    expect(r.code).toBe(7);
    expect(object(r)).toMatchObject({ ok: false, exitCode: 7 });
  });

  it("maps a network failure to exit 7 without a stack trace", async () => {
    const r = await cli(["access", "explicit-site", "--mode", "public", "--yes", "--json"], {
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as Io["fetch"],
    });
    expect(r.wire).toHaveLength(1);
    expect(r.code).toBe(7);
    const result = object(r);
    expect(result.ok).toBe(false);
    expect(result.error.code).not.toBe("unknown_command");
    expect(result.stderr ?? r.stderr).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });
});
