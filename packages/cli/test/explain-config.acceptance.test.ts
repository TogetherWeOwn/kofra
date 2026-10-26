// rebrand:keep-file (intentional DROPWAY_* legacy fixtures; scripts/rebrand.mjs never edits this file.)
/**
 * Acceptance contract: docs/CLI_DIAGNOSTICS.md, matrix rows 1–36.
 * Security bounds tighten the document: custom config selectors never expose
 * paths, userinfo is presence-only, and remediation never embeds caller values.
 *
 * Real run(), real disposable files. Only OS failure injection, side-effect
 * tripwires and homedir isolation are mocked; no diagnostic/resolver is mocked.
 * A missing command MUST fail data-envelope assertions, not pass negative cases.
 * Run: npm run test:cli -- test/explain-config.acceptance.test.ts
 */
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, type Io } from "../src/main.ts";
import { findSecrets } from "../src/secrets.ts";

const probe = vi.hoisted(() => ({
  active: false,
  home: "",
  reads: [] as string[],
  forbidden: [] as string[],
  errors: new Map<string, string>(),
}));

// Permission bits are unreliable under root/Windows. Inject at the OS boundary,
// preserving actual reads, JSON parsing, source selection and output formatting.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const writes = new Set(["appendFile", "chmod", "chown", "copyFile", "cp", "link", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile"]);
  const result: Record<string, unknown> = { ...actual };
  for (const [name, fn] of Object.entries(actual)) {
    if (typeof fn !== "function") continue;
    if (writes.has(name) || ["readFile", "readdir", "open"].includes(name)) {
      result[name] = (...args: unknown[]) => {
        if (probe.active) {
          const path = String(args[0]);
          if (writes.has(name) || name === "open") {
            probe.forbidden.push(name);
            throw new Error("diagnostics attempted a forbidden filesystem operation");
          }
          probe.reads.push(path);
          const code = probe.errors.get(path);
          if (code) return Promise.reject(Object.assign(new Error("synthetic-private-error-fragment"), { code }));
        }
        return (fn as (...values: unknown[]) => unknown)(...args);
      };
    }
  }
  return result;
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => probe.home || actual.homedir() };
});

const API = "https://effective.example.test";
const ENV_API = "https://environment.example.test";
const PROJECT_API = "https://project.example.test";
const DEFAULT_API = "https://default.example.test";
const API_KEY = "dw_test_DiagnosticCanaryA0123456789";
const CLAIM_KEY = "dwc_test_DiagnosticCanaryB0123456789";
const OTHER_KEY = "Zp7UnprefixedDiagnosticCanaryC0123456789";
const KEYS = [API_KEY, CLAIM_KEY, OTHER_KEY];
const HIDDEN_MAPPING = "private-unrequested-mapping-canary";
const HIDDEN_SLUG = "unrequested-slug-canary";
const FIXED_ERROR = {
  ok: false, exitCode: 1,
  error: { code: "unexpected_error", message: "Unexpected internal failure.", retryable: false },
};

const CHECKS = [
  ["api.selected", "info", "source_selected", null],
  ["api.unconfigured", "error", "no_instance", "kofra login --api https://<your-instance>"],
  ["api.empty_value", "error", "empty_value", "Unset the empty source or pass --api https://<your-instance>."],
  ["api.invalid_value", "error", "invalid_api_url", "Pass --api https://<your-instance>."],
  ["api.value_trimmed", "info", "input_trimmed", "Use the bare origin https://<host>."],
  ["api.source_shadowed", "info", "source_shadowed", null],
  ["key.selected", "info", "source_selected", null],
  ["key.absent", "error", "not_logged_in", "kofra login --api <effective-origin>"],
  ["key.kind_noted", "info", "key_kind", null],
  ["credentials_file.malformed", "error", "malformed_credentials", "kofra login --api https://<your-instance>"],
  ["credentials_file.unreadable", "error", "unreadable_credentials", "Check the permissions of <path>."],
  ["project_link.malformed", "error", "malformed_project_link", "Delete or fix ./dropway.json."],
  ["project_link.unreadable", "error", "unreadable_project_link", "Check the permissions of ./dropway.json."],
  ["project_link.foreign_instance", "warning", "foreign_project_link", "Publish once with --api <effective-origin> --new, or remove ./dropway.json."],
  ["project_link.mapping_missing", "info", "mapping_missing", null],
  ["project_link.mapping_found", "info", "mapping_found", null],
  ["env.legacy_shadowed", "info", "source_shadowed", null],
] as const;

type Result = { code: number; stdout: string; stderr: string; network: number; stdin: number; prompts: number };
type Options = { env?: NodeJS.ProcessEnv; tty?: boolean; failOutputOnce?: boolean; fetch?: Io["fetch"] };
let work: string;
let cwd: string;
let config: string;
let credentials: string;
let link: string;

beforeEach(async () => {
  work = await fs.mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kofra-explain-"));
  cwd = join(work, "project");
  probe.home = join(work, "synthetic-home");
  config = join(work, "custom-config-canary");
  credentials = join(config, "credentials.json");
  link = join(cwd, "dropway.json");
  await fs.mkdir(cwd);
  await fs.mkdir(probe.home);
  await fs.mkdir(config);
  await fs.writeFile(join(cwd, "must-not-read.txt"), "unrelated-file-content-canary");
  probe.errors.clear();
  probe.forbidden = [];
  probe.reads = [];
});

afterEach(async () => {
  probe.active = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(work, { recursive: true, force: true });
  probe.home = "";
});

async function putCredentials(value: unknown, path = credentials) {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value), { mode: 0o600 });
}
async function putLink(value: unknown) {
  await fs.writeFile(link, JSON.stringify(value));
}
function saved(api = API, key: unknown = API_KEY) {
  return { version: 1, default: api, instances: { [api]: { key, savedAt: "2026-01-01T00:00:00.000Z" } } };
}

// Snapshot bytes + mode + nanosecond modification/change times. Access time is
// deliberately excluded: a legitimate read is allowed to update it.
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function visit(path: string, key: string) {
    const s = await fs.lstat(path, { bigint: true });
    const meta = `${s.mode}:${s.mtimeNs}:${s.ctimeNs}`;
    if (s.isSymbolicLink()) {
      out[key] = `${meta}:link:${await fs.readlink(path)}`;
    } else if (s.isDirectory()) {
      out[key] = meta;
      for (const name of (await fs.readdir(path)).sort()) await visit(join(path, name), `${key}/${name}`);
    } else {
      out[key] = `${meta}:${createHash("sha256").update(await fs.readFile(path)).digest("hex")}`;
    }
  }
  await visit(dir, ".");
  return out;
}

async function invoke(args: string[] = [], opts: Options = {}): Promise<Result> {
  const before = await snapshot(work);
  const r: Result = { code: -1, stdout: "", stderr: "", network: 0, stdin: 0, prompts: 0 };
  let outputFailed = false;
  const denied = async () => {
    r.network++;
    throw new Error("offline-network-canary");
  };
  const io: Io = {
    cwd,
    env: opts.env ?? { KOFRA_CONFIG_DIR: config },
    stdout: (text) => {
      if (opts.failOutputOnce && !outputFailed) {
        outputFailed = true;
        throw new Error(`internal-caller-canary ${API_KEY} ${cwd}`);
      }
      r.stdout += text;
    },
    stderr: (text) => { r.stderr += text; },
    stdinIsTTY: opts.tty ?? false,
    stderrIsTTY: opts.tty ?? false,
    readStdin: async () => { r.stdin++; throw new Error("stdin must not be read"); },
    prompt: async () => { r.prompts++; throw new Error("diagnostics must not prompt"); },
    fetch: opts.fetch ?? denied,
  };
  vi.stubGlobal("fetch", denied);
  vi.stubGlobal("XMLHttpRequest", class { constructor() { r.network++; throw new Error("offline XHR"); } });
  probe.active = true;
  try {
    r.code = await run(["explain-config", ...args], io);
  } finally {
    probe.active = false;
  }
  expect(probe.forbidden, "no write or extra file-open surface, even if the command catches the sentinel").toEqual([]);
  expect(await snapshot(work), "diagnostics must not change file bytes, metadata, links or directories").toEqual(before);
  expect(r.network, "no network, token validation or login").toBe(0);
  expect(r.stdin, "no stdin read, even in a terminal").toBe(0);
  expect(r.prompts, "no prompt, even in a terminal").toBe(0);
  return r;
}

function object(r: Result): any {
  const body = JSON.parse(r.stdout);
  expect(body && typeof body === "object" && !Array.isArray(body)).toBe(true);
  return body;
}
function check(body: any, id: string): any {
  const found = body.checks.find((c: any) => c.id === id);
  expect(found, `missing ${id}`).toBeDefined();
  return found;
}
function absentCheck(body: any, id: string) {
  expect(body.checks.filter((c: any) => c.id === id)).toEqual([]);
}
function noSecrets(r: Result, extra: string[] = []) {
  const bytes = r.stdout + r.stderr;
  for (const canary of [...KEYS, ...extra]) expect(bytes, "a synthetic secret/input fragment leaked").not.toContain(canary);
  expect(findSecrets("diagnostic.txt", bytes), "credential-pattern sweep supplements, never replaces, canaries").toEqual([]);
}
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
function data(r: Result, status: "ready" | "needs_key" | "unconfigured" = "ready"): any {
  const exit = { ready: 0, needs_key: 3, unconfigured: 2 }[status];
  expect(r.code, r.stdout + r.stderr).toBe(exit);
  const b = object(r);
  expect(b).toMatchObject({ schema: "kofra.explain-config/v1", ok: exit === 0, status, exitCode: exit });
  expect(b).not.toHaveProperty("error");
  expect(b.api).toHaveProperty("origin");
  expect(b.api).toHaveProperty("source");
  expect(b.key).toHaveProperty("present");
  expect(b.key).toHaveProperty("source");
  expect(b.key).toHaveProperty("kind");
  for (const field of ["defaultPresent", "instanceCount", "hasEntryForEffectiveApi"]) expect(b.credentialsFile).toHaveProperty(field);
  for (const field of ["apiMatchesEffective", "sitesEntryCount", "mapping"]) expect(b.projectLink).toHaveProperty(field);
  expect(Array.isArray(b.checks), "checks must be an array, not omitted or an error envelope").toBe(true);
  expect(b.checks.length).toBeLessThanOrEqual(32);
  let previous = -1;
  for (const c of b.checks) {
    const index = CHECKS.findIndex(([id]) => id === c.id);
    expect(index, `unknown producer check ${c.id}`).toBeGreaterThanOrEqual(0);
    expect(index, "checks must appear in documented table order").toBeGreaterThanOrEqual(previous);
    previous = index;
    const spec = CHECKS[index]!;
    expect(c.severity).toBe(spec[1]);
    expect(c.code).toBe(spec[2]);
    expect(c.hint).toEqual(expect.any(String));
    expect(c.hint.trim().length).toBeGreaterThan(0);
    expect(c.nextAction).toBe(spec[3]);
    if (c.id !== "api.value_trimmed") expect(c).not.toHaveProperty("removed");
    for (const canary of [...KEYS, API, ENV_API, PROJECT_API, DEFAULT_API, cwd, config, HIDDEN_MAPPING, HIDDEN_SLUG]) {
      expect(`${c.hint}\n${c.nextAction ?? ""}`, "Q7: templates must keep literal placeholders").not.toContain(canary);
    }
  }
  for (const text of strings(b)) expect(text.length, "every emitted string is capped").toBeLessThanOrEqual(1024);
  expect(r.stderr).toBe("");
  noSecrets(r);
  return b;
}
function source(kind: string, detail: string | null = null, legacy = false) {
  return kind === "env" ? { kind, detail, viaLegacyName: legacy } : { kind, detail };
}
function shadowed(b: any): any[] {
  return b.checks.filter((c: any) => c.id === "api.source_shadowed").map((c: any) => c.source);
}
function summary(b: any, state: string, detail: string | null, values: unknown[]) {
  expect(b.credentialsFile).toEqual({ state, detail, defaultPresent: values[0], instanceCount: values[1], hasEntryForEffectiveApi: values[2] });
}

// Each group names the wrong branch it detects; matrix numbers make omissions
// visible without tying expectations to private implementation structure.
describe("API source selection, not validity fallback (matrix 1–9, 27, 29)", () => {
  it("1: flag wins and every lower set source is named, never diagnosed", async () => {
    await putCredentials(saved(DEFAULT_API));
    await putLink({ api: PROJECT_API });
    const b = data(await invoke(["--api", API, "--key", API_KEY, "--json"], { env: { KOFRA_CONFIG_DIR: config, KOFRA_API: ENV_API, KOFRA_URL: "ftp://shadowed.invalid" } }));
    expect(b.api).toEqual({ origin: API, source: source("flag", "--api") });
    expect(shadowed(b)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "env", detail: "KOFRA_API" }),
      expect.objectContaining({ kind: "env", detail: "KOFRA_URL" }),
      { kind: "project", detail: null }, { kind: "default", detail: null },
    ]));
    expect(shadowed(b)).toHaveLength(4);
    for (const c of b.checks.filter((c: any) => c.id === "api.source_shadowed")) {
      expect(c).not.toHaveProperty("state");
      expect(c).not.toHaveProperty("value");
      expect(c.source).not.toHaveProperty("state");
    }
    absentCheck(b, "api.invalid_value");
    expect(b.projectLink.state).toBe("valid");
    expect(b.credentialsFile.state).toBe("valid");
  });

  it("2: API env precedes URL env", async () => {
    const b = data(await invoke(["--key", API_KEY, "--json"], { env: { KOFRA_CONFIG_DIR: config, KOFRA_API: API, KOFRA_URL: ENV_API } }));
    expect(b.api).toEqual({ origin: API, source: source("env", "KOFRA_API") });
    expect(shadowed(b)).toEqual([expect.objectContaining({ kind: "env", detail: "KOFRA_URL" })]);
  });

  it.each([
    ["KOFRA_API", false], ["KOFRA_URL", false], ["DROPWAY_API", true], ["DROPWAY_URL", true],
  ])("3: %s remains the literal winning name", async (name, legacy) => {
    const b = data(await invoke(["--key", API_KEY, "--json"], { env: { KOFRA_CONFIG_DIR: config, [name]: API } }));
    expect(b.api).toEqual({ origin: API, source: source("env", name, legacy) });
    expect(check(b, "api.selected").source).toMatchObject({ kind: "env", detail: name });
  });

  it.each(["API", "URL"])("4: nonempty modern %s shadows its legacy twin without validating it", async (suffix) => {
    const b = data(await invoke(["--key", API_KEY, "--json"], { env: { KOFRA_CONFIG_DIR: config, [`KOFRA_${suffix}`]: API, [`DROPWAY_${suffix}`]: "ftp://legacy-unvalidated.invalid" } }));
    expect(b.api.source).toEqual(source("env", `KOFRA_${suffix}`));
    expect(check(b, "env.legacy_shadowed").source).toMatchObject({ kind: "env", detail: `DROPWAY_${suffix}` });
    absentCheck(b, "api.invalid_value");
  });

  it("5: empty env falls through and an empty modern twin accepts legacy", async () => {
    await putCredentials(saved());
    const empty = data(await invoke(["--json"], { env: { KOFRA_CONFIG_DIR: config, KOFRA_API: "", KOFRA_URL: "", KOFRA_API_KEY: "" } }));
    expect(empty.api.source).toEqual(source("default"));
    expect(empty.key.source).toEqual(source("saved"));
    const legacy = data(await invoke(["--key", API_KEY, "--json"], { env: { KOFRA_CONFIG_DIR: config, KOFRA_API: "", DROPWAY_API: ENV_API } }));
    expect(legacy.api.source).toEqual(source("env", "DROPWAY_API", true));
  });

  it("6: project wins over default; default wins without a project", async () => {
    await putCredentials(saved(DEFAULT_API));
    await putLink({ api: API });
    const b = data(await invoke(["--key", API_KEY, "--json"]));
    expect(b.api).toEqual({ origin: API, source: source("project") });
    expect(shadowed(b)).toEqual([{ kind: "default", detail: null }]);
    await fs.rm(link);
    const fallback = data(await invoke(["--json"]));
    expect(fallback.api).toEqual({ origin: DEFAULT_API, source: source("default") });
    expect(fallback.key.source).toEqual(source("saved"));
  });

  it("8: no source yields diagnosed unconfigured data, not a generic error", async () => {
    const b = data(await invoke(["--json"]), "unconfigured");
    expect(b.api).toEqual({ origin: null, source: null });
    expect(b.key).toEqual({ present: false, source: null, kind: null });
    check(b, "api.unconfigured");
    absentCheck(b, "key.absent");
    summary(b, "absent", null, [false, 0, null]);
  });

  it("9: an invalid flag wins over valid env, without echoing rejected input", async () => {
    const r = await invoke(["--api", "ftp://invalid-input-canary.test", "--json"], { env: { KOFRA_CONFIG_DIR: config, KOFRA_API: API } });
    const b = data(r, "unconfigured");
    expect(b.api).toEqual({ origin: null, source: source("flag", "--api") });
    check(b, "api.invalid_value");
    expect(shadowed(b)).toEqual([expect.objectContaining({ kind: "env", detail: "KOFRA_API" })]);
    expect(b.credentialsFile.hasEntryForEffectiveApi).toBeNull();
    expect(r.stdout).not.toContain("invalid-input-canary");
  });

  it.each(["flag", "project", "default"])("27: empty %s wins (nullish precedence), never falls through", async (winner) => {
    await putCredentials({ default: winner === "default" ? "" : DEFAULT_API, instances: { [API]: { key: API_KEY }, [DEFAULT_API]: {} } });
    if (winner === "project") await putLink({ api: "" });
    const args = winner === "flag" ? ["--api", "", "--json"] : ["--json"];
    const b = data(await invoke(args, { env: winner === "flag" ? { KOFRA_CONFIG_DIR: config, KOFRA_API: API } : { KOFRA_CONFIG_DIR: config } }), "unconfigured");
    expect(b.api).toEqual({ origin: null, source: source(winner, winner === "flag" ? "--api" : null) });
    check(b, "api.empty_value");
    absentCheck(b, "api.unconfigured");
    summary(b, "valid", null, [true, 2, null]);
    if (winner === "flag") expect(shadowed(b)).toContainEqual(expect.objectContaining({ kind: "env", detail: "KOFRA_API" }));
  });
});

describe("file health remains independent of effective selection (10–13, 27, 34–35)", () => {
  it("10: malformed JSON reports unavailable summaries but flags still make ready", async () => {
    await fs.writeFile(credentials, `{broken-${OTHER_KEY}`);
    const b = data(await invoke(["--api", API, "--key", API_KEY, "--json"]));
    summary(b, "malformed", "invalid_json", [null, null, null]);
    expect(check(b, "credentials_file.malformed").detail).toBe("invalid_json");
    const noKey = data(await invoke(["--api", API, "--json"]), "needs_key");
    summary(noKey, "malformed", "invalid_json", [null, null, null]);
  });

  it.each([
    null, [], 7, "primitive", { default: 8 }, { instances: null },
    { instances: [] }, { instances: "bad" }, { instances: { x: null } },
    { instances: { x: [] } }, { instances: { x: 3 } },
  ].map((fixture) => ({ fixture })))("11: wrong credentials shape $fixture is diagnosed, not silently absent", async ({ fixture }) => {
    await putCredentials(fixture);
    const b = data(await invoke(["--api", API, "--key", API_KEY, "--json"]));
    summary(b, "malformed", "invalid_shape", [null, null, null]);
    expect(check(b, "credentials_file.malformed").detail).toBe("invalid_shape");
  });

  it.each([
    {}, { version: "ignored", default: null, unknown: { arbitrary: true } },
    { version: [], instances: { [API]: { key: 123, future: OTHER_KEY } } },
  ])("34: unknown/version fields and entry fields do not tighten shape %j", async (fixture) => {
    await putCredentials(fixture);
    const b = data(await invoke(["--api", API, "--key", API_KEY, "--json"]));
    expect(b.credentialsFile.state).toBe("valid");
    expect(b.credentialsFile.defaultPresent).toBe(false);
  });

  it("34: empty object and empty default preserve known summaries without an origin", async () => {
    await putCredentials({});
    summary(data(await invoke(["--json"]), "unconfigured"), "valid", null, [false, 0, null]);
    await putCredentials({ default: "", instances: { [API]: { key: API_KEY }, [ENV_API]: { key: "" } } });
    summary(data(await invoke(["--json"]), "unconfigured"), "valid", null, [true, 2, null]);
    summary(data(await invoke(["--api", API, "--json"])), "valid", null, [true, 2, true]);
    summary(data(await invoke(["--api", ENV_API, "--json"]), "needs_key"), "valid", null, [true, 2, false]);
  });

  it.each(["EACCES", "EPERM", "EIO", "ENOTDIR"])("12: %s is a closed unreadable detail, never strerror", async (code) => {
    await putCredentials(saved());
    probe.errors.set(credentials, code);
    const b = data(await invoke(["--api", API, "--key", API_KEY, "--json"]));
    summary(b, "unreadable", code === "EACCES" || code === "EPERM" ? "permission" : code === "ENOTDIR" ? "not_a_file" : "io_error", [null, null, null]);
    check(b, "credentials_file.unreadable");
    expect(JSON.stringify(b)).not.toContain("synthetic-private-error-fragment");
  });

  it("12: an actual directory at credentials.json is not a file", async () => {
    await fs.mkdir(credentials);
    const b = data(await invoke(["--api", API, "--json"]), "needs_key");
    summary(b, "unreadable", "not_a_file", [null, null, null]);
  });

  it.each(["absent", "invalid_json", "permission"])("27: empty flag keeps %s summary semantics with no lookup", async (state) => {
    if (state === "invalid_json") await fs.writeFile(credentials, "{bad");
    if (state === "permission") { await putCredentials(saved()); probe.errors.set(credentials, "EACCES"); }
    const b = data(await invoke(["--api", "", "--json"]), "unconfigured");
    check(b, "api.empty_value");
    expect([b.credentialsFile.defaultPresent, b.credentialsFile.instanceCount, b.credentialsFile.hasEntryForEffectiveApi]).toEqual(state === "absent" ? [false, 0, null] : [null, null, null]);
  });

  it("35: invalid_shape does not veto a usable default or saved key", async () => {
    await putCredentials({ ...saved(), instances: { [API]: { key: API_KEY }, "https://unrelated.example.test": null } });
    const b = data(await invoke(["--json"]));
    summary(b, "malformed", "invalid_shape", [null, null, null]);
    expect(b.api).toEqual({ origin: API, source: source("default") });
    expect(b.key).toEqual({ present: true, source: source("saved"), kind: "api_key" });
    check(b, "credentials_file.malformed");
  });
});

describe("key presence, saved-origin lookup and legacy provenance (14–16, 28, 33)", () => {
  it.each([[API_KEY, "api_key"], [CLAIM_KEY, "claim_token"], [OTHER_KEY, "other"], ["dw_", "api_key"], ["dwc_", "claim_token"]])("14: %s is classified by prefix only, with no validation", async (key, kind) => {
    const b = data(await invoke(["--api", API, "--key", key, "--json"]));
    expect(b.key).toEqual({ present: true, source: source("flag", "--key"), kind });
    if (kind === "api_key") absentCheck(b, "key.kind_noted");
    else check(b, "key.kind_noted");
  });

  it("14/28: flag beats env beats saved; empty flag falls through", async () => {
    await putCredentials(saved());
    const env = { KOFRA_CONFIG_DIR: config, KOFRA_API_KEY: CLAIM_KEY };
    const flag = data(await invoke(["--api", API, "--key", OTHER_KEY, "--json"], { env }));
    expect(flag.key).toEqual({ present: true, source: source("flag", "--key"), kind: "other" });
    const fallback = data(await invoke(["--api", API, "--key", "", "--json"], { env }));
    expect(fallback.key).toEqual({ present: true, source: source("env", "KOFRA_API_KEY"), kind: "claim_token" });
    expect(data(await invoke(["--api", API, "--json"])).key.source).toEqual(source("saved"));
  });

  it("15: an origin without any key is diagnosed exit 3, not a crash or login attempt", async () => {
    const b = data(await invoke(["--api", API, "--json"]), "needs_key");
    expect(b.key).toEqual({ present: false, source: null, kind: null });
    summary(b, "absent", null, [false, 0, false]);
    check(b, "key.absent");
  });

  it("saved lookup uses the effective origin, never another instance's key", async () => {
    await putCredentials(saved(DEFAULT_API));
    const b = data(await invoke(["--api", API, "--json"]), "needs_key");
    summary(b, "valid", null, [true, 1, false]);
  });

  it.each([false, true])("33: literal key twin provenance (modern present: %s)", async (modern) => {
    const b = data(await invoke(["--api", API, "--json"], { env: { KOFRA_CONFIG_DIR: config, DROPWAY_API_KEY: CLAIM_KEY, KOFRA_API_KEY: modern ? OTHER_KEY : "" } }));
    expect(b.key.source).toEqual(source("env", modern ? "KOFRA_API_KEY" : "DROPWAY_API_KEY", !modern));
    expect(b.key.kind).toBe(modern ? "other" : "claim_token");
    if (modern) expect(check(b, "env.legacy_shadowed").source.detail).toBe("DROPWAY_API_KEY");
  });

  it.each(KEYS)("16: flag/env/saved/unknown-field canaries never appear in JSON or human bytes (%s)", async (key) => {
    await putCredentials({ ...saved(API, key), unknown: OTHER_KEY });
    await putLink({ api: API, unknown: CLAIM_KEY, sites: { [HIDDEN_MAPPING]: HIDDEN_SLUG } });
    for (const args of [["--api", API, "--key", key], ["--api", API]]) {
      data(await invoke([...args, "--json"], { env: { KOFRA_CONFIG_DIR: config, KOFRA_API_KEY: key } }));
      const human = await invoke(args, { env: { KOFRA_CONFIG_DIR: config, KOFRA_API_KEY: key } });
      expect(human.code).toBe(0);
      noSecrets(human, [HIDDEN_MAPPING, HIDDEN_SLUG]);
    }
    const savedHuman = await invoke([]);
    expect(savedHuman.code).toBe(0);
    noSecrets(savedHuman, [HIDDEN_MAPPING, HIDDEN_SLUG]);
  });
});

describe("single-path mapping is not a mapping inventory (7, 13, 20–21, 29, 36)", () => {
  const cases = [
    ["absent", null, false, 0, null],
    ["matching with entry", { api: API, sites: { dist: "chosen-site" } }, true, 1, "chosen-site"],
    ["matching without entry", { api: API, sites: {} }, true, 0, null],
    ["empty entry", { api: API, sites: { dist: "" } }, true, 1, null],
    ["foreign", { api: PROJECT_API, sites: { dist: "ignored-site" } }, false, 1, null],
    ["missing api", { sites: { dist: "ignored-site" } }, false, 1, null],
    ["raw unequal normalized self", { api: `${API}/path?q=x`, sites: { dist: "ignored-site" } }, false, 1, null],
  ] as const;

  it.each(cases)("36: %s reports the hand-checked lookup result", async (_name, fixture, matches, count, slug) => {
    if (fixture) await putLink(fixture);
    const b = data(await invoke(["./dist/../dist", "--api", API, "--key", API_KEY, "--json"]));
    expect(b.projectLink).toEqual({ state: fixture ? "valid" : "absent", detail: null, apiMatchesEffective: matches, sitesEntryCount: count, mapping: { key: "dist", slug } });
    check(b, slug ? "project_link.mapping_found" : "project_link.mapping_missing");
    absentCheck(b, slug ? "project_link.mapping_missing" : "project_link.mapping_found");
    if (fixture && "api" in fixture && !matches) check(b, "project_link.foreign_instance");
    else absentCheck(b, "project_link.foreign_instance");
  });

  it("36: no resolved origin means no project equality or mapping, even with an entry", async () => {
    await putLink({ sites: { dist: "must-not-win" } });
    const b = data(await invoke(["dist", "--json"]), "unconfigured");
    expect(b.projectLink).toMatchObject({ apiMatchesEffective: false, sitesEntryCount: 1, mapping: { key: "dist", slug: null } });
  });

  it.each([".", "dist", "./dist", "dist/../dist", "../sibling"])("20: lookup key for %s is cwd-relative POSIX, without reading the target", async (path) => {
    const key = path === "." ? "." : path === "../sibling" ? "../sibling" : "dist";
    await putLink({ api: API, sites: { [key]: "chosen-site", [HIDDEN_MAPPING]: HIDDEN_SLUG } });
    const r = await invoke([path, "--api", API, "--key", API_KEY, "--json"]);
    const b = data(r);
    expect(b.projectLink.mapping).toEqual({ key, slug: "chosen-site" });
    expect(b.projectLink.sitesEntryCount).toBe(2);
    expect(r.stdout + r.stderr).not.toMatch(/private-unrequested-mapping-canary|unrequested-slug-canary/);
    expect(probe.reads.every((p) => [link, credentials].includes(p)), "only the two configuration files may be read").toBe(true);
  });

  it.each([true, false])("21: without path, mapping is null (link present: %s)", async (present) => {
    if (present) await putLink({ api: API, sites: { [HIDDEN_MAPPING]: HIDDEN_SLUG } });
    const r = await invoke(["--api", API, "--key", API_KEY, "--json"]);
    const b = data(r);
    expect(b.projectLink.mapping).toBeNull();
    expect(b.projectLink.sitesEntryCount).toBe(present ? 1 : 0);
    absentCheck(b, "project_link.mapping_found");
    absentCheck(b, "project_link.mapping_missing");
    noSecrets(r, [HIDDEN_MAPPING, HIDDEN_SLUG]);
  });

  it.each([null, [], 1, { api: null }, { api: 5 }, { sites: null }, { sites: [] }, { sites: { dist: 7 } }].map((fixture) => ({ fixture })))("13: wrong-shaped link $fixture cannot expose a coerced mapping", async ({ fixture }) => {
    await putLink(fixture);
    const b = data(await invoke(["dist", "--api", API, "--key", API_KEY, "--json"]));
    expect(b.projectLink).toEqual({ state: "malformed", detail: "invalid_shape", apiMatchesEffective: null, sitesEntryCount: null, mapping: { key: "dist", slug: null } });
    expect(check(b, "project_link.malformed").detail).toBe("invalid_shape");
    check(b, "project_link.mapping_missing");
  });

  it.each(["invalid_json", "EACCES", "EPERM", "EIO", "directory"])("13: %s link keeps unavailable fields and optional lookup semantics", async (failure) => {
    if (failure === "directory") await fs.mkdir(link);
    else {
      await fs.writeFile(link, failure === "invalid_json" ? "{broken" : JSON.stringify({ api: API }));
      if (failure !== "invalid_json") probe.errors.set(link, failure);
    }
    const state = failure === "invalid_json" ? "malformed" : "unreadable";
    const detail = failure === "invalid_json" ? "invalid_json" : failure === "directory" ? "not_a_file" : failure === "EIO" ? "io_error" : "permission";
    for (const path of [[], ["dist"]]) {
      const b = data(await invoke([...path, "--api", API, "--key", API_KEY, "--json"]));
      expect(b.projectLink).toEqual({ state, detail, apiMatchesEffective: null, sitesEntryCount: null, mapping: path.length ? { key: "dist", slug: null } : null });
      expect(check(b, `project_link.${state}`).detail).toBe(detail);
      if (path.length) check(b, "project_link.mapping_missing");
    }
  });

  it("a malformed-but-usable link still wins API selection, but not diagnostic mapping", async () => {
    await putLink({ api: API, sites: { dist: "usable-by-publish", unrelated: 123 } });
    const b = data(await invoke(["dist", "--key", API_KEY, "--json"]));
    expect(b.api).toEqual({ origin: API, source: source("project") });
    expect(b.projectLink).toEqual({ state: "malformed", detail: "invalid_shape", apiMatchesEffective: null, sitesEntryCount: null, mapping: { key: "dist", slug: null } });
  });
});

describe("URL normalization reports only presence, never rejected bytes (17–19, Q2/Q7)", () => {
  it("17: userinfo/path/query/fragment produce only distinct ordered removal labels", async () => {
    const url = "https://userinfo-name-canary:userinfo-pass-canary@effective.example.test/private-path-canary?token=query-canary#fragment-canary";
    const r = await invoke(["--api", url, "--key", API_KEY, "--json"]);
    const b = data(r);
    expect(b.api.origin).toBe(API);
    const trimmed = check(b, "api.value_trimmed");
    expect(trimmed.removed).toEqual(["userinfo", "path", "query", "fragment"]);
    expect(trimmed.hint).toMatch(/rotat/i);
    expect(trimmed.hint).toMatch(/shell history/i);
    expect(trimmed.hint).toMatch(/env/i);
    noSecrets(r, ["userinfo-name-canary", "userinfo-pass-canary", "private-path-canary", "query-canary", "fragment-canary"]);
    const human = await invoke(["--api", url, "--key", API_KEY]);
    expect(human.code).toBe(0);
    noSecrets(human, ["userinfo-name-canary", "userinfo-pass-canary", "private-path-canary", "query-canary", "fragment-canary"]);
  });

  it.each(["a:b", "longer-user:longer-pass"])("Q2: userinfo %s is presence-only, not length/count metadata", async (userinfo) => {
    const b = data(await invoke(["--api", `https://${userinfo}@effective.example.test`, "--key", API_KEY, "--json"]));
    expect(check(b, "api.value_trimmed").removed).toEqual(["userinfo"]);
    for (const field of ["userinfo", "username", "password", "value", "length", "count"]) expect(check(b, "api.value_trimmed")).not.toHaveProperty(field);
    expect(JSON.stringify(b)).not.toContain(userinfo);
  });

  it.each(["javascript:alert(1)", "ftp://hostile.example.test", "file:///synthetic/file", "https://bad\u0000.example.test", "https://bad\u0001.example.test"])("18: hostile value %j is invalid data, never a fallback", async (api) => {
    const b = data(await invoke(["--api", api, "--json"]), "unconfigured");
    check(b, "api.invalid_value");
    expect(b.api.origin).toBeNull();
  });

  it.each([
    ["  https://effective.example.test  ", API],
    ["https://bücher.example.test/a", "https://xn--bcher-kva.example.test"],
    [`${API}/${"a".repeat(8192)}`, API],
    ["http://effective.example.test:8787/path", "http://effective.example.test:8787"],
  ])("19: normalizes whitespace, IDN, large suffix or explicit port (%s)", async (raw, origin) => {
    const b = data(await invoke(["--api", raw, "--key", API_KEY, "--json"]));
    expect(b.api.origin).toBe(origin);
  });

  it("19: an overlong lookup key is bounded with the documented marker", async () => {
    const b = data(await invoke(["p".repeat(8192), "--api", API, "--key", API_KEY, "--json"]));
    expect(b.projectLink.mapping.key.length).toBeLessThanOrEqual(1024);
    expect(b.projectLink.mapping.key).toMatch(/\[…truncated\]$/);
  });

  it("Q7: effective origin/path canaries occur only in explicitly allowlisted JSON fields", async () => {
    const origin = "https://origin-field-canary.example.test";
    const path = "mapping-field-canary";
    await putLink({ api: origin, sites: { [path]: "chosen-site" } });
    const b = data(await invoke([path, "--api", origin, "--key", OTHER_KEY, "--json"]));
    expect(b.api.origin).toBe(origin);
    expect(b.projectLink.mapping.key).toBe(path);
    const rest = structuredClone(b);
    delete rest.api.origin;
    delete rest.projectLink.mapping.key;
    for (const value of [origin, "origin-field-canary", path, OTHER_KEY]) expect(JSON.stringify(rest)).not.toContain(value);
  });

  it("Q7: unselected origin/custom-path/key canaries never enter any human line or template", async () => {
    const hiddenOrigin = "https://unselected-origin-canary.example.test";
    await putCredentials(saved(hiddenOrigin, OTHER_KEY));
    await putLink({ api: hiddenOrigin, sites: { [HIDDEN_MAPPING]: HIDDEN_SLUG } });
    const args = ["--api", API, "--key", API_KEY];
    const b = data(await invoke([...args, "--json"]));
    check(b, "project_link.foreign_instance");
    const human = await invoke(args);
    expect(human.code).toBe(0);
    noSecrets(human, [hiddenOrigin, "unselected-origin-canary", config, "custom-config-canary", HIDDEN_MAPPING, HIDDEN_SLUG]);
    expect(human.stdout + human.stderr).toContain("foreign_project_link");
    expect(human.stdout + human.stderr).toContain("<effective-origin>");
  });
});

describe("config selectors hide every custom path (30, 32, Q1)", () => {
  it.each(["KOFRA_CONFIG_DIR", "DROPWAY_CONFIG_DIR", "XDG_CONFIG_HOME"])("%s never prints even an in-home custom path", async (selector) => {
    const custom = join(probe.home, "inside-home-path-canary");
    const path = selector === "XDG_CONFIG_HOME" ? join(custom, "dropway", "credentials.json") : join(custom, "credentials.json");
    await putCredentials(saved(), path);
    const env = { [selector]: custom };
    const b = data(await invoke(["--json"], { env }));
    expect(b.configDir).toEqual({ selector, viaLegacyName: selector === "DROPWAY_CONFIG_DIR", path: null });
    const human = await invoke([], { env });
    expect(human.code).toBe(0);
    expect(human.stdout + human.stderr).toContain(selector);
    noSecrets(human, [custom, "inside-home-path-canary"]);
    expect(JSON.stringify(b)).not.toContain("inside-home-path-canary");
  });

  it("32: out-of-home custom path is null in JSON and absent from all human lines", async () => {
    await putCredentials(saved());
    const r = await invoke(["--json"]);
    expect(data(r).configDir).toEqual({ selector: "KOFRA_CONFIG_DIR", viaLegacyName: false, path: null });
    const h = await invoke([]);
    expect(h.code).toBe(0);
    noSecrets(h, [config, "custom-config-canary"]);
  });

  it("the real default selector alone emits a home-collapsed default path", async () => {
    await putCredentials(saved(), join(probe.home, ".config", "dropway", "credentials.json"));
    const b = data(await invoke(["--json"], { env: {} }));
    expect(b.configDir).toEqual({ selector: "default", viaLegacyName: false, path: "~/.config/dropway" });
    expect(JSON.stringify(b)).not.toContain(probe.home);
  });

  it("modern config dir beats legacy/XDG and never exposes the shadowed locations", async () => {
    await putCredentials(saved());
    const b = data(await invoke(["--json"], { env: { KOFRA_CONFIG_DIR: config, DROPWAY_CONFIG_DIR: join(work, "legacy-path-canary"), XDG_CONFIG_HOME: join(work, "xdg-path-canary") } }));
    expect(b.configDir).toEqual({ selector: "KOFRA_CONFIG_DIR", viaLegacyName: false, path: null });
    expect(JSON.stringify(b)).not.toMatch(/legacy-path-canary|xdg-path-canary/);
  });

  it("Q5: symlinked config files follow the unchanged resolver without disclosing targets", async () => {
    const credentialTarget = join(work, "credential-target-canary.json");
    const linkTarget = join(work, "link-target-canary.json");
    await fs.writeFile(credentialTarget, JSON.stringify(saved()));
    await fs.writeFile(linkTarget, JSON.stringify({ api: API, sites: { dist: "chosen-site" } }));
    await fs.symlink(credentialTarget, credentials);
    await fs.symlink(linkTarget, link);
    const r = await invoke(["dist", "--json"]);
    const b = data(r);
    expect(b.credentialsFile.state).toBe("valid");
    expect(b.projectLink).toMatchObject({ state: "valid", mapping: { key: "dist", slug: "chosen-site" } });
    noSecrets(r, ["credential-target-canary", "link-target-canary"]);
  });
});

describe("offline/read-only, deterministic and stable failure boundaries (22–26, 31)", () => {
  it("22/23: sabotaged fetch and filesystem writes cannot change ready data", async () => {
    await putCredentials(saved());
    await putLink({ api: API, sites: { dist: "chosen-site" } });
    const r = await invoke(["dist", "--json"]);
    data(r);
    expect(probe.reads.length).toBeGreaterThan(0);
    expect([...new Set(probe.reads)].sort()).toEqual([credentials, link].sort());
    // The harness also checks byte hashes, nanosecond metadata and attempted
    // writes, catching mutate-then-restore as well as persistent modifications.
  });

  it("24: identical input produces byte-identical output with no savedAt or time metadata", async () => {
    await putCredentials(saved());
    const a = await invoke(["--json"]);
    data(a);
    const b = await invoke(["--json"]);
    data(b);
    expect(b.stdout).toBe(a.stdout);
    expect(b.stderr).toBe(a.stderr);
    expect(a.stdout).not.toMatch(/savedAt|2026-01-01|timestamp/i);
  });

  it.each([true, false])("25: terminal=%s never reads stdin or prompts", async (tty) => {
    const r = await invoke(["--json"], { tty });
    data(r, "unconfigured");
  });

  it("26: consumer can ignore an unknown check while preserving known diagnostics", async () => {
    const b = data(await invoke(["--api", API, "--json"]), "needs_key");
    const future = [...b.checks, { id: "future.check", code: "future_code", severity: "info", hint: "Future advice.", nextAction: null }];
    const known = (checks: any[]) => checks.filter((c) => CHECKS.some(([id]) => id === c.id));
    expect(known(future)).toEqual(b.checks);
    check({ checks: known(future) }, "key.absent");
  });

  it.each([false, true])("31: forced internal failure uses fixed caller-free bytes (JSON=%s)", async (json) => {
    // First prove registration, so a missing command fails an assertion rather
    // than escaping via the unknown-command formatter outside run()'s try.
    data(await invoke(["--api", API, "--key", API_KEY, "--json"]));
    const r = await invoke(["--api", API, "--key", API_KEY, ...(json ? ["--json"] : [])], { failOutputOnce: true });
    expect(r.code).toBe(1);
    if (json) {
      expect(r.stdout).toBe(`${JSON.stringify(FIXED_ERROR, null, 2)}\n`);
      expect(object(r)).toEqual(FIXED_ERROR);
      expect(r.stderr).toBe("");
    } else {
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("Error (unexpected_error): Unexpected internal failure.\n");
    }
    noSecrets(r, [cwd, "internal-caller-canary"]);
  });

  it.each([
    ["unknown flag", ["--not-a-flag"]], ["new anonymous flag", ["--anonymous"]],
    ["write/repair flag", ["--repair"]], ["surplus path", ["dist", "extra"]],
    ["surplus after --", ["dist", "--", "extra"]], ["missing api value", ["--api"]],
  ])("8: %s is usage error, not diagnosed data or unknown command", async (_name, args) => {
    const r = await invoke(["--json", ...args]);
    expect(r.code).toBe(2);
    const b = object(r);
    expect(b).toMatchObject({ ok: false, exitCode: 2, error: { code: "usage" } });
    expect(b).not.toHaveProperty("status");
    expect(b).not.toHaveProperty("schema");
    expect(b.error.hint).toContain("--help");
  });

  it("-q preserves the entire diagnosed JSON result instead of suppressing facts", async () => {
    const first = await invoke(["--api", API, "--json"]);
    data(first, "needs_key");
    const quiet = await invoke(["--api", API, "--json", "-q"]);
    data(quiet, "needs_key");
    expect(quiet.stdout).toBe(first.stdout);
  });

  it("human output states origin/source/key kind and health, with stable warning/error codes", async () => {
    await putCredentials(saved());
    await fs.writeFile(link, "{broken");
    const r = await invoke([]);
    expect(r.code).toBe(0);
    const text = r.stdout + r.stderr;
    expect(text).toContain(API);
    expect(text).toMatch(/default/i);
    expect(text).toMatch(/saved/i);
    expect(text).toContain("api_key");
    expect(text).toContain("malformed_project_link");
    expect(text).toContain("KOFRA_CONFIG_DIR");
    noSecrets(r, [config]);
    const missing = await invoke(["--api", API], { env: { KOFRA_CONFIG_DIR: join(work, "absent-config") } });
    expect(missing.code).toBe(3);
    expect(missing.stdout + missing.stderr).toContain("not_logged_in");
    expect(missing.stdout + missing.stderr).toContain("<effective-origin>");
  });
});
