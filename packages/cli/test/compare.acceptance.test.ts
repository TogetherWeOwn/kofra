/**
 * Independent CLI contract from docs/CLI_COMPARE.md v1. Only HTTP is substituted;
 * dispatch, auth resolution, collector, hashes, formatting and config are real.
 * No compare implementation/helper imports. Never contacts an instance.
 *
 * Run: npm run test:cli -- test/compare.acceptance.test.ts
 * Implemented contract: the paired implementation consumes this behavior.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, type Io } from "../src/main.ts";

const API = "https://compare-fixture.invalid";
const SITE = "explicit-site";
const KEY = "dw_synthetic_compare_sentinel_not_a_credential";
const SECRET = "ghp_" + "a".repeat(36);
const NOTE = "remote_only paths are not deleted by publishing; publish replaces the version, it does not mirror deletions.";
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
type Tree = Record<string, string>;
type Row = Record<string, unknown> & { path: string };
const equalTree = { "a.txt": "alpha", "docs/b.txt": "bravo", "empty.txt": "" };
const localTree = { "a-change.txt": "NEW", "b-grow.txt": "longer", "c-local.txt": "only", "same.txt": "same", "empty.txt": "" };
const remoteTree = { "a-change.txt": "old", "b-grow.txt": "x", "d-remote.txt": "gone", "same.txt": "same", "empty.txt": "" };
const mixedCounts = { changed: 2, localOnly: 1, remoteOnly: 1, unchanged: 2, localTotal: 5, remoteTotal: 5 };
const mixedBytes = { changedLocal: 9, changedRemote: 4, localOnly: 4, remoteOnly: 4, unchanged: 4, localTotal: 17, remoteTotal: 12 };
const version = (id: string, number: number, files: Row[], status = "ready") => ({
  id, number, status, live: number === 2, fileCount: files.length,
  totalBytes: files.reduce((sum, row) => sum + (typeof row.size === "number" && row.size >= 0 ? row.size : 0), 0),
  source: "cli", message: null, client: "acceptance/1", createdAt: "2026-10-24T12:00:00.000Z",
  finalizedAt: status === "ready" ? "2026-10-24T12:00:01.000Z" : null,
});
function rows(tree: Tree): Row[] {
  return Object.entries(tree).map(([path, bytes]) => ({
    path, size: Buffer.byteLength(bytes), sha256: hash(bytes), contentType: "text/plain", kind: "text", extension: "txt",
    // A content-fetch implementation must hit the transport sentinel, never a URL.
    url: `https://content-must-not-be-fetched.invalid/${encodeURIComponent(path)}`,
    rawUrl: `${API}/api/v1/sites/${SITE}/files/${encodeURIComponent(path)}`,
  })).reverse(); // Intentionally not sorted: output must supply its own ordering.
}

type Seen = { method: string; path: string; search: string; authorization: string | null };
type Options = {
  local?: Tree; remote?: Row[]; historical?: Row[]; manifestFiles?: Row[];
  noLive?: boolean; restoredLive?: boolean; redirectManifest?: boolean;
  error?: { status: number; code: string; hint: string }; env?: NodeJS.ProcessEnv;
  target?: string; cwd?: string; tty?: boolean;
};
let work: string;
let cwd: string;
let config: string;

beforeEach(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kofra-compare-"));
  cwd = join(work, "project");
  config = join(work, "config");
  await mkdir(cwd);
  await mkdir(config);
  await writeFile(join(cwd, "dropway.json"), JSON.stringify({ api: API, sites: { ".": "stale-site", dist: "stale-site" } }));
  await writeFile(join(config, "credentials.json"), JSON.stringify({ default: API, instances: { [API]: { key: KEY } } }), { mode: 0o600 });
  // Fail closed if a command accidentally bypasses Io.fetch.
  vi.stubGlobal("fetch", async () => { throw new Error("No network outside the compare acceptance transport"); });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(work, { recursive: true, force: true });
});

async function seed(tree: Tree, dir = join(cwd, "dist")) {
  await mkdir(dir, { recursive: true });
  for (const [path, bytes] of Object.entries(tree)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), bytes);
  }
}

/** Include metadata to catch same-content rewrites; never follow a symlink. */
async function snapshot(dir: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const s = await lstat(path, { bigint: true });
    result.push([name, String(s.mode), String(s.ino), String(s.mtimeNs), String(s.ctimeNs),
      s.isSymbolicLink() ? await readlink(path) : s.isDirectory() ? await snapshot(path) : (await readFile(path)).toString("base64")]);
  }
  return result;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function cli(args: string[], opts: Options = {}) {
  const remote = opts.remote ?? rows(remoteTree);
  const historical = opts.historical ?? rows(equalTree);
  const live = version("ver_live_opaque-B2", 2, remote);
  // Restored live: pointed at by currentVersionId but older than the newest-500
  // page. The decoy newest entry must never donate number/counts to `pinned`.
  const restored = version("ver_restored_opaque-R7", 7, remote);
  const decoy = { ...version("ver_newest_decoy-D9", 9, []), fileCount: 99, totalBytes: 9900 };
  const old = version("ver_historical_opaque-A1", 1, historical);
  const pending = version("ver_pending_opaque-C3", 3, remote, "pending");
  const seen: Seen[] = [];
  const violations: string[] = [];
  let stdout = "";
  let stderr = "";
  let interactive = 0;
  const before = await snapshot(work);
  const startedAt = Date.now();
  const io: Io = {
    cwd: opts.cwd ?? cwd,
    env: opts.env ?? { HOME: work, KOFRA_CONFIG_DIR: config, KOFRA_API: API, KOFRA_API_KEY: KEY },
    stdout: t => void (stdout += t), stderr: t => void (stderr += t),
    stdinIsTTY: opts.tty ?? false, stderrIsTTY: opts.tty ?? false,
    readStdin: async () => { interactive++; throw new Error("compare must not read stdin"); },
    prompt: async () => { interactive++; throw new Error("compare must not prompt"); },
    fetch: async req => {
      const url = new URL(req.url);
      seen.push({ method: req.method, path: url.pathname, search: url.search, authorization: req.headers.get("Authorization") });
      const base = `/api/v1/sites/${SITE}`;
      if (url.origin !== API || req.method !== "GET" || req.headers.has("Idempotency-Key") || seen.length > 2 ||
          !(url.pathname === `${base}/versions` || url.pathname.startsWith(`${base}/versions/`) || url.pathname === `${base}/files`)) {
        violations.push(`${req.method} ${url.pathname}${url.search}`);
        return json({ error: { code: "fixture_transport_refused", message: "Only manifest reads allowed.", hint: "Use the specified two GETs." } }, 400);
      }
      expect(await req.clone().text(), "GETs have no body").toBe("");
      // The injected transport answers redirects literally and never follows
      // them. The client must therefore refuse this metadata redirect itself.
      if (opts.redirectManifest && url.pathname === `${base}/versions`) {
        return new Response(null, { status: 307, headers: { Location: `${API}/api/v1/sites/${SITE}/versions?limit=500` } });
      }
      if (opts.error) return json({ error: { ...opts.error, message: "Fixture read refused." }, requestId: "req_compare_fixture" }, opts.error.status);
      if (url.pathname === `${base}/versions`) {
        expect(url.search, "live pin uses the existing bounded list exactly once").toBe("?limit=500");
        if (opts.restoredLive) return json({ currentVersionId: restored.id, versions: [decoy, old] });
        return json({ currentVersionId: opts.noLive ? null : live.id, versions: [live, old] });
      }
      if (url.pathname.startsWith(`${base}/versions/`)) {
        expect(url.search).toBe("");
        const ref = decodeURIComponent(url.pathname.slice(`${base}/versions/`.length));
        const pinned = ["v1", "1", old.id].includes(ref) ? old : ["v3", "3", pending.id].includes(ref) ? pending : null;
        if (!pinned) return json({ error: { code: "version_not_found", message: "Version not found.", hint: "Run kofra versions explicit-site." } }, 404);
        return json({ site: SITE, version: pinned, missing: pinned.status === "pending" ? ["f".repeat(64)] : [] });
      }
      expect(url.searchParams.size, "raw full manifest: no pagination or content options").toBe(1);
      const id = url.searchParams.get("version");
      expect([live.id, old.id, restored.id], "manifest must be pinned by immutable id, never live/v1").toContain(id);
      const pinned = id === old.id ? old : id === restored.id ? restored : live;
      // Only the ID captured above is served. A live re-check exceeds two GETs.
      return json({ version: pinned, files: opts.manifestFiles ?? (id === old.id ? historical : remote) });
    },
  };
  const code = await run(args, io);
  const endedAt = Date.now();
  expect(violations, "no mutation, content download, unrelated discovery or re-resolution").toEqual([]);
  expect(await snapshot(work), "compare must not create, delete or rewrite project/config files").toEqual(before);
  expect(interactive).toBe(0);
  for (const secret of [KEY, SECRET]) expect(stdout + stderr, "no credential literal in either output stream").not.toContain(secret);
  return { code, stdout, stderr, seen, startedAt, endedAt };
}
type Ran = Awaited<ReturnType<typeof cli>>;
function object(r: Ran): any {
  // Parse ALL stdout: rejects progress, banners, JSONL, arrays and trailing notes.
  const body = JSON.parse(r.stdout);
  expect(body !== null && typeof body === "object" && !Array.isArray(body)).toBe(true);
  return body;
}
async function compare(flags: string[] = [], opts: Options = {}) {
  await seed(opts.local ?? localTree);
  return cli(["compare", opts.target ?? "dist", "--site", SITE, ...flags], opts);
}
function success(r: Ran, opts: { ref?: string; id?: string; number?: number } = {}) {
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const body = object(r);
  expect(body).toMatchObject({ ok: true, schemaVersion: 1, command: "compare", api: API, site: SITE,
    local: { root: join(cwd, "dist"), kind: "dir" },
    pinned: { versionId: opts.id ?? "ver_live_opaque-B2", number: opts.number ?? 2, requestedRef: opts.ref ?? "live" },
    ignored: expect.any(Array), skippedLinks: expect.any(Array), secretsFound: expect.any(Number), warnings: expect.any(Array),
    counts: expect.any(Object), bytes: expect.any(Object), records: expect.any(Array), truncated: expect.any(Boolean),
  });
  const at = Date.parse(body.pinned.resolvedAt);
  expect(Number.isFinite(at)).toBe(true);
  expect(at).toBeGreaterThanOrEqual(r.startedAt);
  expect(at).toBeLessThanOrEqual(r.endedAt);
  expect(r.seen).toHaveLength(2);
  for (const request of r.seen) expect(request.authorization).toBe(`Bearer ${KEY}`);
  expect(r.seen[1]!.path).toBe(`/api/v1/sites/${SITE}/files`);
  expect(new URLSearchParams(r.seen[1]!.search).get("version")).toBe(body.pinned.versionId);
  return body;
}
function failure(r: Ran, code: string, exit: number, hint: RegExp) {
  expect(r.code, r.stdout + r.stderr).toBe(exit);
  const body = object(r);
  expect(body).toMatchObject({ ok: false, exitCode: exit, error: { code, message: expect.any(String), hint: expect.any(String) } });
  expect(body.error.hint).toMatch(hint);
  expect(body.error.hint.trim().length).toBeGreaterThan(0);
  return body;
}

describe("compare: hashes, exact totals and schema v1", () => {
  it("reports an equal three-file tree without listing unchanged records by default", async () => {
    const body = success(await compare(["--json"], { local: equalTree, remote: rows(equalTree) }));
    expect(body.counts).toEqual({ changed: 0, localOnly: 0, remoteOnly: 0, unchanged: 3, localTotal: 3, remoteTotal: 3 });
    expect(body.bytes).toEqual({ changedLocal: 0, changedRemote: 0, localOnly: 0, remoteOnly: 0, unchanged: 10, localTotal: 10, remoteTotal: 10 });
    expect(body.pinned).toMatchObject({ fileCount: 3, totalBytes: 10 });
    expect(body.records).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  it("distinguishes equal-size hash changes, size changes, local-only and remote-only", async () => {
    const body = success(await compare(["--json", "--include-unchanged"]));
    expect(body.counts).toEqual(mixedCounts);
    expect(body.bytes).toEqual(mixedBytes);
    expect(body.pinned).toMatchObject({ fileCount: 5, totalBytes: 12 });
    expect(body.records).toEqual([
      { class: "changed", path: "a-change.txt", localSize: 3, remoteSize: 3, localSha256: hash("NEW"), remoteSha256: hash("old") },
      { class: "changed", path: "b-grow.txt", localSize: 6, remoteSize: 1, localSha256: hash("longer"), remoteSha256: hash("x") },
      { class: "local_only", path: "c-local.txt", size: 4, sha256: hash("only") },
      { class: "remote_only", path: "d-remote.txt", size: 4, sha256: hash("gone") },
      { class: "unchanged", path: "empty.txt", size: 0, sha256: hash("") },
      { class: "unchanged", path: "same.txt", size: 4, sha256: hash("same") },
    ]);
    expect(body.truncated).toBe(false);
  });

  it("does not accept equal hashes with unequal sizes as unchanged", async () => {
    const remote = rows({ "a.txt": "A" });
    remote[0]!.size = 2;
    const body = success(await compare(["--json"], { local: { "a.txt": "A" }, remote }));
    expect(body.counts.changed).toBe(1);
    expect(body.counts.unchanged).toBe(0);
    expect(body.records[0]).toMatchObject({ class: "changed", path: "a.txt", localSize: 1, remoteSize: 2 });
  });

  it("orders case-sensitive POSIX paths by UTF-8 bytes, not locale collation", async () => {
    const tree = { "é.txt": "x", "z.txt": "x", "Z.txt": "x", "a.txt": "x", "A.txt": "x", "docs/日本語.txt": "x", "docs/a space #.txt": "x" };
    const body = success(await compare(["--json", "--include-unchanged"], { local: tree, remote: rows(tree) }));
    expect(body.records.map((r: any) => r.path)).toEqual(["A.txt", "Z.txt", "a.txt", "docs/a space #.txt", "docs/日本語.txt", "z.txt", "é.txt"]);
    expect(body.counts.unchanged).toBe(7);
  });

  it("orders a supplementary-plane path after a U+E000-U+FFFF BMP path (UTF-8 bytes, not UTF-16 units)", async () => {
    // UTF-16 code-unit order would put 😀 (lead surrogate U+D83D) before
    // U+E000; UTF-8 byte order puts U+E000 (EE 80 80) before 😀 (F0 9F 98 80).
    const tree = { "😀.txt": "x", "\uE000.txt": "x", "z.txt": "x" };
    const body = success(await compare(["--json", "--include-unchanged"], { local: tree, remote: rows(tree) }));
    expect(body.records.map((r: any) => r.path)).toEqual(["z.txt", "\uE000.txt", "😀.txt"]);
    expect(body.counts.unchanged).toBe(3);
  });

  it.each([1, 4, 6])("keeps full counts/bytes when --limit=%s cuts only printed records", async limit => {
    const body = success(await compare(["--json", "--include-unchanged", "--limit", String(limit)]));
    expect(body.counts).toEqual(mixedCounts);
    expect(body.bytes).toEqual(mixedBytes);
    expect(body.records).toHaveLength(limit);
    expect(body.truncated).toBe(limit < 6);
    expect(body.records[0].path).toBe("a-change.txt");
  });

  it("does not mark omitted unchanged records as truncation", async () => {
    const body = success(await compare(["--json", "--limit", "4"]));
    expect(body.records).toHaveLength(4);
    expect(body.records.every((r: any) => r.class !== "unchanged")).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.counts).toEqual(mixedCounts);
  });

  it("reads a full raw manifest beyond 1000 rows once and applies default limit 500 honestly", async () => {
    const remote = rows({ ...equalTree, ...Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`remote-${String(i).padStart(4, "0")}.txt`, "x"])) });
    const body = success(await compare(["--json"], { local: equalTree, remote }));
    expect(body.counts).toEqual({ changed: 0, localOnly: 0, remoteOnly: 1001, unchanged: 3, localTotal: 3, remoteTotal: 1004 });
    expect(body.bytes).toEqual({ changedLocal: 0, changedRemote: 0, localOnly: 0, remoteOnly: 1001, unchanged: 10, localTotal: 10, remoteTotal: 1011 });
    expect(body.pinned).toMatchObject({ fileCount: 1004, totalBytes: 1011 });
    expect(body.records).toHaveLength(500);
    expect(body.records[499].path).toBe("remote-0499.txt");
    expect(body.truncated).toBe(true);
  });
});

describe("compare: resolve once, then read only the immutable manifest", () => {
  it.each([{ flags: [] }, { flags: ["--version", "live"] }])("pins live, not rollback's previous version (%j)", async ({ flags }) => {
    const r = await compare(["--json", ...flags]);
    success(r);
    expect(r.seen[0]!.path).toBe(`/api/v1/sites/${SITE}/versions`);
    expect(r.seen[0]!.search).toBe("?limit=500");
  });

  it("compares a restored live version omitted from the newest-500 list, with pinned metadata from the manifest", async () => {
    const r = await compare(["--json"], { restoredLive: true, local: equalTree, remote: rows(equalTree) });
    const body = success(r, { id: "ver_restored_opaque-R7", number: 7 });
    expect(r.seen, "exactly two GETs: list, then the pinned manifest").toHaveLength(2);
    expect(body.pinned).toMatchObject({ versionId: "ver_restored_opaque-R7", number: 7, fileCount: 3, totalBytes: 10 });
    expect(body.counts).toMatchObject({ unchanged: 3, localTotal: 3, remoteTotal: 3 });
  });

  it.each(["v1", "1", "ver_historical_opaque-A1"])("uses get_version for %s even though v2 exists", async ref => {
    const r = await compare(["--json", "--version", ref], { local: equalTree });
    const body = success(r, { ref, id: "ver_historical_opaque-A1", number: 1 });
    expect(r.seen[0]!.path).toBe(`/api/v1/sites/${SITE}/versions/${ref}`);
    expect(body.counts.unchanged).toBe(3);
    expect(body.records).toEqual([]);
  });

  it.each([{ flags: [] }, { flags: ["--version", "live"] }])("refuses an absent live pointer rather than comparing an empty diff (%j)", async ({ flags }) => {
    const r = await compare(["--json", ...flags], { noLive: true });
    failure(r, "no_live_version", 4, /publish|--version/i);
    expect(r.seen).toHaveLength(1);
  });

  it("still compares an explicit historical ref on a site with no live version", async () => {
    const body = success(await compare(["--json", "--version", "v1"], { noLive: true, local: equalTree }), { ref: "v1", id: "ver_historical_opaque-A1", number: 1 });
    expect(body.counts.unchanged).toBe(3);
  });

  it.each(["v3", "3", "ver_pending_opaque-C3"])("refuses pending ref %s before reading its mutable manifest", async ref => {
    const r = await compare(["--json", "--version", ref]);
    failure(r, "version_not_ready", 4, /wait|finaliz/i);
    expect(r.seen).toHaveLength(1);
  });

  it("surfaces version_not_found with a next-action command", async () => {
    const r = await compare(["--json", "--version", "v99"]);
    failure(r, "version_not_found", 4, /kofra versions/);
    expect(r.seen).toHaveLength(1);
  });

  it("refuses a metadata redirect instead of following it to another origin", async () => {
    const r = await compare(["--json"], { redirectManifest: true });
    const body = failure(r, "redirect_refused", 1, /canonical|origin/);
    expect(body.error.status).toBe(307);
    expect(r.seen).toHaveLength(1);
    expect(body.records).toBeUndefined();
  });

  it("refuses a manifest whose row count disagrees with the pinned file count", async () => {
    const r = await compare(["--json"], { manifestFiles: rows(localTree).slice(0, 2) });
    const body = failure(r, "invalid_compare_response", 1, /listed|complete|metadata/);
    expect(body.error.message).toContain("2 files");
    expect(body.error.message).toContain("5");
    expect(r.seen).toHaveLength(2);
    expect(body.records).toBeUndefined();
  });

  it.each([
    { status: 404, code: "site_not_found", hint: "Check the site name with kofra list.", exit: 4 },
    { status: 401, code: "invalid_key", hint: "Run kofra login.", exit: 3 },
    { status: 403, code: "insufficient_scope", hint: "Use a key with sites:read.", exit: 3 },
  ])("preserves existing HTTP $status access controls and error hints", async error => {
    const r = await compare(["--json"], { error });
    const body = failure(r, error.code, error.exit, /kofra|sites:read/);
    expect(body.error.status).toBe(error.status);
    expect(body.error.requestId).toBe("req_compare_fixture");
    expect(r.seen).toHaveLength(1);
    expect(body.records).toBeUndefined();
  });
});

describe("compare: collector parity, count-only secrets and metadata warnings", () => {
  it("uses publish's ignores and skipped directory symlinks and excludes the cwd link", async () => {
    await seed({ "keep.txt": "x", ".env": "excluded", "node_modules/x.txt": "excluded", "drafts/x.txt": "excluded", ".dropwayignore": "drafts/\n", "cert.pem": "excluded" }, cwd);
    await seed({ "must-not-follow.txt": "outside" }, join(work, "outside"));
    await symlink(join(work, "outside"), join(cwd, "linked"), "dir");
    const r = await cli(["compare", ".", "--site", SITE, "--json"], { remote: rows({ "keep.txt": "x" }) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const body = object(r);
    const publish = await cli(["publish", ".", "--dry-run", "--json"]);
    expect(publish.code, publish.stdout + publish.stderr).toBe(0);
    const offline = object(publish);
    expect(publish.seen, "publish --dry-run remains offline").toEqual([]);
    expect(body.ignored).toEqual(offline.ignored);
    expect(body.skippedLinks).toEqual(offline.omissions
      .filter((o: any) => o.reason === "symlink_directory")
      .map((o: any) => o.path));
    expect(body.skippedLinks).toContain("linked");
    expect(body.counts).toMatchObject({ localTotal: 1, remoteTotal: 1, unchanged: 1 });
    expect(body.records).toEqual([]);
    expect(body.local).toEqual({ root: cwd, kind: "dir" });
  });

  it.each([false, true])("reports a secret as a count only and never blocks (human=%s)", async human => {
    const local = { "credential-location-sentinel.txt": `const token = '${SECRET}';\n` };
    const r = await compare(human ? [] : ["--json"], { local, remote: rows(local) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const text = r.stdout + r.stderr;
    expect(text).not.toContain("credential-location-sentinel");
    expect(text).not.toMatch(/github.token|lineNumber|possible_secrets/i);
    if (human) expect(text).toMatch(/secretsFound\s*:\s*1|secret[^\n]{0,40}\b1\b|\b1\b[^\n]{0,40}secret/i);
    else {
      const body = success(r);
      expect(body.secretsFound).toBe(1);
      expect(body.warnings).toEqual([]);
      expect(body.secrets).toBeUndefined();
      expect(body.records).toEqual([]);
    }
  });

  it.each(["empty_hash", "missing_hash", "negative_size"])("never calls %s metadata unchanged", async defect => {
    const remote = rows({ "a.txt": "A" });
    if (defect === "empty_hash") remote[0]!.sha256 = "";
    else if (defect === "missing_hash") delete remote[0]!.sha256;
    else remote[0]!.size = -1;
    const body = success(await compare(["--json"], { local: { "a.txt": "A" }, remote }));
    expect(body.counts).toMatchObject({ changed: 1, unchanged: 0 });
    expect(body.records[0]).toMatchObject({ class: "changed", path: "a.txt", reason: "incomplete_metadata" });
    expect(body.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "incomplete_metadata", path: "a.txt" })]));
  });

  it("bounds per-path incomplete-metadata warnings and admits the warning cap", async () => {
    const remote = rows(equalTree).map(row => ({ ...row, sha256: "" }));
    const body = success(await compare(["--json", "--limit", "1"], { local: equalTree, remote }));
    expect(body.counts).toMatchObject({ changed: 3, unchanged: 0 });
    expect(body.records).toHaveLength(1);
    expect(body.warnings.filter((w: any) => w.code === "incomplete_metadata")).toHaveLength(1);
    expect(JSON.stringify(body.warnings)).toMatch(/cap|limit|truncat/i);
    expect(body.truncated).toBe(true);
  });

  it.each([false, true])("labels a single encrypted.bin manifest as a heuristic, not decryption (human=%s)", async human => {
    const r = await compare(human ? [] : ["--json"], { local: equalTree, remote: rows({ "encrypted.bin": "opaque" }) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const uncertainty = /heuristic|\bmay\b|\bmight\b|\blikely\b|appear|\blooks\b|\bcould\b/i;
    if (human) {
      expect(r.stdout + r.stderr).toMatch(/encrypt/i);
      expect(r.stdout + r.stderr).toMatch(uncertainty);
    } else {
      const body = success(r);
      expect(body.counts).toEqual({ changed: 0, localOnly: 3, remoteOnly: 1, unchanged: 0, localTotal: 3, remoteTotal: 1 });
      const warning = body.warnings.find((w: any) => /encrypt/i.test(w.message ?? ""));
      expect(warning).toMatchObject({ code: expect.any(String), message: expect.stringMatching(uncertainty) });
    }
  });
});

describe("compare: usage errors and instance/key resolution", () => {
  it.each([
    ["--allow-secrets"], ["--save"], ["--no-save"], ["--new"], ["--wait"], ["--encrypt"], ["--spa"],
    ["--base", "v1"], ["--message", "no mutation"], ["--concurrency", "1"], ["--anonymous"], ["--dry-run"],
  ])("rejects publish-only flags %j before requests or writes", async (...flags) => {
    const r = await compare(["--json", ...flags]);
    failure(r, "usage", 2, /help|compare|CLI_COMPARE/);
    expect(r.seen).toEqual([]);
  });

  it.each([
    ["compare", "dist"], ["compare", "--site", SITE], ["compare", "dist", "extra", "--site", SITE],
    ["compare", "dist", "--site"], ["compare", "dist", "--site", SITE, "--version"],
  ])("requires the path and an explicit site on every invocation %j", async (...args) => {
    await seed(localTree);
    const r = await cli([...args, "--json"]);
    failure(r, "usage", 2, /help|site|compare/);
    expect(r.seen).toEqual([]);
  });

  it.each([
    ["--limit", "0"], ["--limit", "100001"], ["--max-files", "0"], ["--max-files", "500001"],
    ["--max-bytes", "0"], ["--max-bytes", "10737418241"], ["--max-bytes", "2GiB"],
    ["--limit", "1.5"], ["--limit", "NaN"], ["--max-files", "1e3"], ["--max-bytes", "Infinity"],
    ["--limit"], ["--max-files"], ["--max-bytes"],
  ])("rejects invalid plain integer bounds %j locally", async (...flags) => {
    const r = await compare(["--json", ...flags]);
    failure(r, "usage", 2, /help|limit|max-files|max-bytes|compare/);
    expect(r.seen).toEqual([]);
  });

  it.each([
    { target: "single.txt", code: "compare_directory_only", hint: /directory|folder/i },
    { target: "archive.zip", code: "compare_zip_unsupported", hint: /extract|folder/i },
    { target: "not-here", code: "path_not_found", hint: /existing|directory|path/i },
  ])("refuses $target with the stable directory-only error", async ({ target, code, hint }) => {
    await writeFile(join(cwd, "single.txt"), "A");
    // A valid empty ZIP (EOCD), so either signature or extension detection works.
    await writeFile(join(cwd, "archive.zip"), Buffer.from("504b0506000000000000000000000000000000000000", "hex"));
    failure(await compare(["--json"], { target }), code, 2, hint);
  });

  it("uses -s and -q and accepts exact caps and the maximum output limit", async () => {
    await seed(equalTree);
    const r = await cli(["compare", "dist", "-s", SITE, "-q", "--json", "--max-files", "3", "--max-bytes", "10", "--limit", "100000"], { remote: rows(equalTree) });
    success(r);
    expect(r.stderr).toBe("");
  });

  it("accepts the maximum permitted cap values without changing the comparison", async () => {
    const body = success(await compare(["--json", "--max-files", "500000", "--max-bytes", "10737418240"]));
    expect(body.counts).toEqual(mixedCounts);
  });

  it("requires an authenticated key, never silently falling back to anonymous", async () => {
    await rm(join(config, "credentials.json"));
    const r = await compare(["--json"], { env: { HOME: work, KOFRA_CONFIG_DIR: config, KOFRA_API: API } });
    failure(r, "not_logged_in", 3, /login|KOFRA_API_KEY|--key/);
    expect(r.seen).toEqual([]);
  });

  it("offers the normal no-instance recovery when no instance is configured", async () => {
    await rm(join(cwd, "dropway.json"));
    await rm(join(config, "credentials.json"));
    const r = await compare(["--json"], { env: { HOME: work, KOFRA_CONFIG_DIR: config } });
    failure(r, "no_instance", 2, /--api|KOFRA_API|login/);
    expect(r.seen).toEqual([]);
  });

  it("retains saved instance/key resolution without taking the site's stale link", async () => {
    success(await compare(["--json"], { env: { HOME: work, KOFRA_CONFIG_DIR: config } }));
  });
});

describe("compare: discoverability and non-TTY output", () => {
  it.each([["help", "compare"], ["compare", "--help"]])("links to the normative spec via %j without resolving an instance", async (...args) => {
    const r = await cli(args, { env: { HOME: work, KOFRA_CONFIG_DIR: join(work, "absent-config") } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.seen).toEqual([]);
    expect(r.stdout).toContain("docs/CLI_COMPARE.md");
    expect(r.stdout).toContain("compare");
    expect(r.stdout).toContain("--site");
  });

  it("advertises compare alongside publish in the command table's global help", async () => {
    const r = await cli(["help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\bcompare\b/);
    expect(r.stdout).toMatch(/\bpublish\b/);
    expect(r.seen).toEqual([]);
  });

  it("prints the pinned id/number, four classes and verbatim no-deletion note without hashes or ANSI", async () => {
    const r = await compare(["--include-unchanged"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    for (const text of ["ver_live_opaque-B2", "v2", "changed", "local_only", "remote_only", "unchanged", NOTE]) expect(r.stdout).toContain(text);
    for (const symbol of ["~ a-change.txt", "+ c-local.txt", "- d-remote.txt", "= same.txt"]) expect(r.stdout).toContain(symbol);
    expect(r.stdout + r.stderr).not.toMatch(/\x1b\[|[a-f0-9]{64}/);
    expect(r.stderr).toBe("");
  });

  it("human errors keep Error (code) and Fix shape on stderr only", async () => {
    const r = await compare(["--version", "v99"]);
    expect(r.code).toBe(4);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Error (version_not_found):");
    expect(r.stderr).toMatch(/Fix: .*kofra versions/);
  });

  it("keeps quiet JSON successful and progress-free even on a terminal", async () => {
    const r = await compare(["--json", "--quiet"], { tty: true });
    success(r);
    expect(r.stderr).toBe("");
  });
});

describe("compare: hostile names stay inert on the human presentation boundary", () => {
  it("escapes terminal controls in a missing-path human error", async () => {
    const hostile = "missing-\u001b[2J\nname.txt";
    const r = await compare([], { target: hostile });
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Error (path_not_found):");
    expect(r.stderr).toContain("missing-\\u001b[2J\\u000aname.txt");
    expect(r.stderr).not.toContain("[2J");
    expect(r.stderr).not.toContain(`${String.fromCharCode(10)}name.txt`);
  });

  it("escapes terminal controls in a successful human record path", async () => {
    const hostile = "hostile-\u001b[34m\nname.txt";
    const tree = { [hostile]: "x" };
    const r = await compare(["--include-unchanged"], { local: tree, remote: rows(tree) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("hostile-\\u001b[34m\\u000aname.txt");
    expect(r.stdout).not.toContain("[34m");
    expect(r.stdout).not.toContain(`${String.fromCharCode(10)}name.txt`);
  });
});
