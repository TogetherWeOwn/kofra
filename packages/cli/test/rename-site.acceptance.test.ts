/**
 * Independent rename contract: real command dispatch/config/client/output, with
 * only HTTP substituted. No implementation imports beyond the CLI entry point.
 * Run: npm run test:cli -- test/rename-site.acceptance.test.ts
 *
 * Offline plan convention (no resolved identity):
 * { schemaVersion: 1, operation: "rename_site", target: { api, site },
 *   patch: { slug }, localLinksUpdated: false }
 * Human guidance is semantic, not exact prose. Saved project links never move.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { run, type Io } from "../src/main.ts";

const API = "https://rename-fixture.example";
const OTHER = "https://second-fixture.example";
const SOURCE = "old-report";
const TARGET = "new-report";
// Disposable sentinels, never real credentials.
const KEY = "dw_rename_acceptance_not_a_real_key";
const OTHER_KEY = "dw_rename_other_not_a_real_key";
const CLAIM = "dwc_rename_acceptance_not_a_real_token";
const DEADLINE = "2031-02-03T04:05:06.000Z";
const renamedSite = {
  id: "site_identity_opaque_7", slug: TARGET, url: `${API}/s/${TARGET}/`,
  title: "Quarterly report", description: null, anonymous: false, expiresAt: null,
  settings: { spa: true, passwordProtected: true }, currentVersionId: "ver_live_7",
  currentVersion: null, createdAt: "2026-01-02T03:04:05.000Z", updatedAt: "2026-02-03T04:05:06.000Z",
  links: { versions: `${API}/api/v1/sites/${TARGET}/versions`, files: `${API}/api/v1/sites/${TARGET}/files` },
};
const success = {
  renamed: true, oldSlug: SOURCE, slug: TARGET, url: renamedSite.url,
  redirectUntil: DEADLINE, site: renamedSite,
};
type Seen = { method: string; origin: string; path: string; search: string; body: unknown };
type Options = { tty?: boolean; body?: unknown; status?: number; networkFailure?: boolean; noConfig?: boolean };
let work: string;
let cwd: string;
let config: string;
let bundleWork: string;
let bundle: string;

beforeAll(async () => {
  bundleWork = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "rename-binary-"));
  bundle = join(bundleWork, "kofra.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/cli.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", target: "node20", outfile: bundle, logLevel: "silent",
  });
});
afterAll(async () => { if (bundleWork) await rm(bundleWork, { recursive: true, force: true }); });

beforeEach(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "rename-contract-"));
  cwd = join(work, "project");
  config = join(work, "config");
  await mkdir(cwd);
  await mkdir(config);
  await mkdir(join(work, "second-project"));
  await writeFile(join(config, "credentials.json"), JSON.stringify({
    default: API, instances: { [API]: { key: KEY }, [OTHER]: { key: OTHER_KEY } },
  }, null, 2) + "\n", { mode: 0o600 });
  // The saved target deliberately differs: an omitted source must never use it.
  await writeFile(join(cwd, "dropway.json"), '{\n  "api": "https://rename-fixture.example",\n  "sites": { "dist": "saved-not-the-source", "docs": "old-report" }\n}\n');
  await writeFile(join(work, "second-project", "dropway.json"), JSON.stringify({ api: OTHER, sites: { dist: SOURCE } }) + "\n");
  await writeFile(join(cwd, ".env"), `UNRELATED=${CLAIM}\n`);
  await writeFile(join(cwd, "notes.txt"), "Unrelated bytes\r\nno final newline");
  vi.stubGlobal("fetch", async () => { throw new Error("Network outside the injected rename transport is forbidden"); });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (work) await rm(work, { recursive: true, force: true });
});

/** Detect creations/deletions, byte changes, chmod and same-content rewrites. */
async function snapshot(dir: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const s = await stat(path, { bigint: true });
    result.push([name, String(s.mode), String(s.ino), String(s.mtimeNs), String(s.ctimeNs),
      s.isDirectory() ? await snapshot(path) : (await readFile(path)).toString("base64")]);
  }
  return result;
}
function noSecrets(text: string) {
  for (const sentinel of [KEY, OTHER_KEY, CLAIM]) expect(text).not.toContain(sentinel);
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
async function cli(args: string[], options: Options = {}) {
  const before = await snapshot(work);
  const seen: Seen[] = [];
  const transportProblems: string[] = [];
  let stdout = "";
  let stderr = "";
  let prompts = 0;
  const io: Io = {
    cwd, env: { KOFRA_CONFIG_DIR: options.noConfig ? join(work, "absent-config") : config },
    stdinIsTTY: options.tty ?? false, stderrIsTTY: options.tty ?? false,
    stdout: text => void (stdout += text), stderr: text => void (stderr += text),
    prompt: async () => { prompts++; throw new Error("Rename must never prompt"); },
    readStdin: async () => { prompts++; throw new Error("Rename must not read stdin"); },
    fetch: async req => {
      const url = new URL(req.url);
      const raw = await req.clone().text();
      seen.push({ method: req.method, origin: url.origin, path: url.pathname, search: url.search, body: raw ? JSON.parse(raw) : null });
      if (url.origin !== API || req.headers.get("authorization") !== `Bearer ${KEY}`) transportProblems.push("wrong authority or credential");
      if (options.networkFailure) throw new TypeError("fixture connection closed");
      if (req.method !== "POST" || !/^\/api\/v1\/sites\/[^/]+\/rename$/.test(url.pathname)) {
        transportProblems.push("unexpected discovery, lookup or mutation endpoint");
        return json({ error: { code: "fixture_wrong_endpoint", message: "Only the existing rename endpoint is available." } }, 400);
      }
      return json(options.body ?? success, options.status);
    },
  };
  const code = await run(args, io);
  expect(prompts, "--yes is explicit acknowledgement, never an interactive prompt").toBe(0);
  expect(transportProblems).toEqual([]);
  expect(await snapshot(work), "rename must never rewrite mappings, credentials, unrelated instances or files").toEqual(before);
  noSecrets(stdout + stderr);
  return { code, stdout, stderr, seen };
}
function object(r: { stdout: string }) {
  const value = JSON.parse(r.stdout);
  expect(value !== null && typeof value === "object" && !Array.isArray(value), "stdout must contain exactly one JSON object").toBe(true);
  return value;
}
function oneRename(r: Awaited<ReturnType<typeof cli>>, source = SOURCE, slug = TARGET) {
  expect(r.seen).toEqual([{
    method: "POST", origin: API, path: `/api/v1/sites/${encodeURIComponent(source)}/rename`, search: "", body: { newSlug: slug },
  }]);
}
function unchangedLinks(text: string) {
  expect(text).toMatch(/(?:local|project|saved)[^\n]*(?:link|mapping)|(?:link|mapping)[^\n]*(?:local|project|saved)/i);
  expect(text).toMatch(/unchanged|not (?:be )?updated|not (?:be )?rewritten|never (?:updates?|rewrites?)/i);
  expect(text).toMatch(/publish/i);
  expect(text).toMatch(/\blink\b|\bupdate\b/i);
}

// Each refusal must explain this command, not merely pass because it is unknown.
describe("rename explicit arguments and acknowledgement", () => {
  it.each([false, true])("requires --yes before networking and never prompts (TTY=%s)", async tty => {
    const r = await cli(["rename", SOURCE, TARGET, "--json"], { tty });
    expect(r.code).toBe(2);
    expect(r.seen).toEqual([]);
    const body = object(r);
    expect(body).toMatchObject({ ok: false, exitCode: 2 });
    expect(body.error.code).not.toBe("unknown_command");
    expect(`${body.error.message} ${body.error.hint}`).toContain("--yes");
  });

  it.each([
    [], [SOURCE], [SOURCE, TARGET, "extra"],
    [SOURCE, TARGET, "--unknown"], [SOURCE, TARGET, "--release"],
    [SOURCE, TARGET, "--no-redirect"], [SOURCE, TARGET, "--override"],
    [SOURCE, TARGET, "--force"], [SOURCE, TARGET, "--site", "saved-not-the-source"],
  ])("rejects malformed argv locally instead of using a saved target: %j", async (...args) => {
    const r = await cli(["rename", ...args, "--yes", "--json"]);
    expect(r.code).toBe(2);
    expect(r.seen).toEqual([]);
    const body = object(r);
    expect(body).toMatchObject({ ok: false, exitCode: 2, error: { hint: expect.any(String) } });
    expect(body.error.code).not.toBe("unknown_command");
    expect(body.error.hint.trim()).not.toBe("");
  });

  it.each(["--no-yes", "--yes=false"])("does not treat %s as acknowledgement", async flag => {
    const r = await cli(["rename", SOURCE, TARGET, flag, "--json"]);
    expect(r.code).toBe(2);
    expect(r.seen).toEqual([]);
    const body = object(r);
    expect(body.error.code).not.toBe("unknown_command");
  });
});

describe("offline rename plan", () => {
  it.each([false, true])("normalizes an unresolved explicit plan without credentials or --yes (JSON=%s)", async machine => {
    const r = await cli(["rename", SOURCE, "  NEW-REPORT  ", "--api", `${API}/api/v1/`, "--dry-run", ...(machine ? ["--json"] : [])], { noConfig: true });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.seen).toEqual([]);
    if (machine) {
      expect(object(r)).toEqual({
        schemaVersion: 1, operation: "rename_site", target: { api: API, site: SOURCE },
        patch: { slug: TARGET }, localLinksUpdated: false,
      });
      expect(r.stdout).not.toMatch(/site_identity|redirectUntil|renamed/);
    } else {
      expect(r.stdout + r.stderr).toContain(SOURCE);
      expect(r.stdout + r.stderr).toContain(TARGET);
      unchangedLinks(r.stdout + r.stderr);
      expect(r.stdout + r.stderr).not.toContain(DEADLINE);
    }
  });

  it("keeps an opaque source id unresolved offline rather than inventing a slug or id", async () => {
    const r = await cli(["rename", "site_explicit_opaque_9", TARGET, "--dry-run", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.seen).toEqual([]);
    expect(object(r)).toEqual({
      schemaVersion: 1, operation: "rename_site", target: { api: API, site: "site_explicit_opaque_9" },
      patch: { slug: TARGET }, localLinksUpdated: false,
    });
  });
});

describe("one acknowledged rename and truthful output", () => {
  it.each([SOURCE, "site_explicit_opaque_9", `${API}/s/${SOURCE}/`])("uses only the explicit source %s and preserves returned identity", async source => {
    const r = await cli(["rename", source, TARGET, "--yes", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    oneRename(r, source);
    expect(object(r)).toEqual({ ...success, localLinksUpdated: false });
  });

  it("preserves the returned URL rather than reconstructing it from requested names", async () => {
    const body = { ...success, slug: "server-canonical", url: "https://share.example/custom/report/", site: {
      ...renamedSite, slug: "server-canonical", url: "https://share.example/custom/report/",
    } };
    const r = await cli(["rename", SOURCE, TARGET, "--yes", "--json"], { body });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    oneRename(r);
    expect(object(r)).toEqual({ ...body, localLinksUpdated: false });
  });

  it("canonical no-op is success with unchanged identity and no second action", async () => {
    const body = { ...success, renamed: false, oldSlug: SOURCE, slug: SOURCE,
      url: `${API}/s/${SOURCE}/`, redirectUntil: null,
      site: { ...renamedSite, slug: SOURCE, url: `${API}/s/${SOURCE}/` } };
    const r = await cli(["rename", SOURCE, SOURCE.toUpperCase(), "--yes", "--json"], { body });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    oneRename(r, SOURCE, SOURCE);
    expect(object(r)).toEqual({ ...body, localLinksUpdated: false });
  });

  it("JSON preserves a null redirect deadline without making one up", async () => {
    const body = { ...success, redirectUntil: null };
    const r = await cli(["rename", SOURCE, TARGET, "--yes", "--json"], { body });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    oneRename(r);
    expect(object(r)).toEqual({ ...body, localLinksUpdated: false });
  });

  it.each([DEADLINE, null])("human output reports URLs and only the actual redirect deadline %j", async redirectUntil => {
    const r = await cli(["rename", SOURCE, TARGET, "--yes"], { body: { ...success, redirectUntil } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    oneRename(r);
    const text = r.stdout + r.stderr;
    expect(text).toContain(`${API}/s/${SOURCE}/`);
    expect(text).toContain(renamedSite.url);
    unchangedLinks(text);
    expect(text).not.toMatch(/\b\d+[-\s]*(?:hours?|days?|months?|years?)\b|\btransfer/i);
    if (redirectUntil) expect(text).toContain(DEADLINE);
    else {
      expect(text).not.toContain(DEADLINE);
      // Silence or a truthful negative explanation is fine, never a promise.
      for (const line of text.split("\n").filter(line => /redirect/i.test(line))) {
        expect(line).toMatch(/no redirect|not redirect|without[^\n]*redirect|redirect[^\n]*(?:not |none|null|unavailable|disabled)/i);
      }
    }
  });

  it("human no-op identifies no change and still warns about saved mappings", async () => {
    const body = { ...success, renamed: false, oldSlug: SOURCE, slug: SOURCE, redirectUntil: null,
      url: `${API}/s/${SOURCE}/`, site: { ...renamedSite, slug: SOURCE, url: `${API}/s/${SOURCE}/` } };
    const r = await cli(["rename", SOURCE, SOURCE, "--yes"], { body });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    oneRename(r, SOURCE, SOURCE);
    expect(r.stdout + r.stderr).toMatch(/no.?op|unchanged|already|no (?:change|rename)/i);
    unchangedLinks(r.stdout + r.stderr);
  });
});

describe("stable rename refusal and network exits", () => {
  it.each([
    [400, "invalid_slug", 6], [409, "slug_taken", 5], [409, "slug_reserved", 5],
    [404, "site_not_found", 4], [403, "insufficient_scope", 3],
    [403, "policy_refused", 3], [401, "unauthorized", 3],
    [409, "site_changed", 5], [503, "temporarily_unavailable", 7],
  ] as const)("keeps HTTP %s %s and exit %s without retry or fallback", async (status, code, exitCode) => {
    const error = { code, message: "Rename refused by the fixture.", hint: "Resolve this exact refusal before trying again.",
      details: { field: "newSlug" }, retryable: status === 503 };
    const r = await cli(["rename", SOURCE, TARGET, "--yes", "--json"], { status, body: { error, requestId: "req_rename_fixture" } });
    expect(r.code, r.stdout + r.stderr).toBe(exitCode);
    oneRename(r);
    expect(object(r)).toMatchObject({ ok: false, exitCode, error: { ...error, status, requestId: "req_rename_fixture" } });
    expect(object(r)).not.toHaveProperty("renamed");
    expect(object(r)).not.toHaveProperty("site");
  });

  it.each(["foreign-site", "missing-site"])("does not substitute a saved mapping on non-disclosing source refusal: %s", async source => {
    const r = await cli(["rename", source, TARGET, "--yes", "--json"], { status: 404,
      body: { error: { code: "site_not_found", message: "Site not found.", hint: "Check the explicit source and your key." } } });
    expect(r.code, r.stdout + r.stderr).toBe(4);
    oneRename(r, source);
    expect(object(r)).toMatchObject({ ok: false, error: { code: "site_not_found", status: 404 } });
  });

  it("reports transport failure with the existing transient exit and no automatic second mutation", async () => {
    const r = await cli(["rename", SOURCE, TARGET, "--yes", "--json"], { networkFailure: true });
    expect(r.code, r.stdout + r.stderr).toBe(7);
    oneRename(r);
    expect(object(r)).toMatchObject({ ok: false, exitCode: 7, error: { code: "network_error", retryable: true } });
    expect(object(r)).not.toHaveProperty("renamed");
  });

  it("treats shell punctuation as inert argv, rejects or encodes it, and never changes the endpoint", async () => {
    const source = "old;$(touch PWNED)`printf x`&?=#";
    const r = await cli(["rename", source, TARGET, "--yes", "--json"], { status: 404,
      body: { error: { code: "site_not_found", message: "Site not found.", hint: "Use a site slug, id or URL." } } });
    expect([2, 4]).toContain(r.code);
    expect(object(r).error.code).not.toBe("unknown_command");
    if (r.seen.length) oneRename(r, source);
  });
});

describe("runtime discoverability and subprocess boundary", () => {
  it.each([["help", "rename"], ["rename", "--help"]])("explains explicit acknowledgement and unchanged local mappings in help: %j", async (...args) => {
    const r = await cli(args);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.seen).toEqual([]);
    expect(r.stdout).toMatch(/rename\s+<[^>]+>\s+<[^>]+>/);
    expect(r.stdout).toContain("--yes");
    expect(r.stdout).toContain("--dry-run");
    unchangedLinks(r.stdout);
  });

  it("lists rename in top-level runtime help", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.seen).toEqual([]);
    expect(r.stdout).toMatch(/^\s+rename\s+\S/m);
  });

  it("bundled non-TTY CLI refuses without --yes, plans offline, then performs exactly one acknowledged POST", async () => {
    const requests: Array<{ method: string; path: string; body: string }> = [];
    let server: Server | undefined;
    const before = await snapshot(work);
    try {
      server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push({ method: req.method ?? "", path: req.url ?? "", body: Buffer.concat(chunks).toString() });
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(success));
      });
      await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture server has no port");
      const api = `http://127.0.0.1:${address.port}`;
      const invoke = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath, [bundle, ...args, "--api", api, "--json"], {
          cwd, timeout: 10_000,
          env: { PATH: process.env.PATH, HOME: work, KOFRA_CONFIG_DIR: config, KOFRA_API_KEY: KEY, NO_COLOR: "1" },
        }, (error, stdout, stderr) => {
          resolve({ code: typeof error?.code === "number" ? error.code : error ? -1 : 0, stdout, stderr });
        });
      });
      const refused = await invoke(["rename", SOURCE, TARGET]);
      expect(refused.code).toBe(2);
      expect(object(refused).error.code).not.toBe("unknown_command");
      expect(JSON.stringify(object(refused).error)).toContain("--yes");
      expect(requests).toEqual([]);
      const dry = await invoke(["rename", SOURCE, TARGET, "--dry-run"]);
      expect(dry.code, dry.stdout + dry.stderr).toBe(0);
      expect(object(dry)).toMatchObject({ schemaVersion: 1, operation: "rename_site", localLinksUpdated: false });
      expect(requests).toEqual([]);
      const renamed = await invoke(["rename", SOURCE, TARGET, "--yes"]);
      expect(renamed.code, renamed.stdout + renamed.stderr).toBe(0);
      expect(object(renamed)).toEqual({ ...success, localLinksUpdated: false });
      expect(requests).toEqual([{ method: "POST", path: `/api/v1/sites/${SOURCE}/rename`, body: JSON.stringify({ newSlug: TARGET }) }]);
      noSecrets(refused.stdout + refused.stderr + dry.stdout + dry.stderr + renamed.stdout + renamed.stderr);
    } finally {
      if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
      expect(await snapshot(work)).toEqual(before);
    }
  });
});
