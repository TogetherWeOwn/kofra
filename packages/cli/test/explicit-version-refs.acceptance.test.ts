/**
 * Native CLI acceptance: explicit version reads must not depend on list history.
 * The transport owns 601 ready versions; the existing list returns only the
 * newest 500. Only HTTP is substituted: command dispatch, config, client,
 * argument parsing and output/error shaping are the real CLI.
 */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, type Io } from "../src/main.ts";

const API = "https://version-fixture.example";
const SITE = "history-site";
// These are disposable sentinel strings, not credentials from an instance.
const ENV_KEY = "dw_acceptance_env_sentinel_not_a_real_key";
const SAVED_KEY = "dw_acceptance_saved_sentinel_not_a_real_key";
const CLAIM = "dwc_acceptance_claim_sentinel_not_a_real_token";
// Mirror the existing HTTP_VERSION wire contract, not internal D1 rows.
const oldVersion = {
  id: "ver_archive_opaque-A_z9", number: 1, status: "ready", live: false,
  fileCount: 2, totalBytes: 31, source: "api", message: "first release", client: "acceptance/1",
  createdAt: "2023-11-14T22:13:20.000Z", finalizedAt: "2023-11-14T22:13:21.000Z",
};
const newestVersion = {
  ...oldVersion, id: "ver_newest", number: 601, live: true,
  message: "current release", createdAt: "2023-11-14T22:23:20.000Z", finalizedAt: "2023-11-14T22:23:21.000Z",
};
const pendingVersion = {
  ...oldVersion, id: "ver_pending", number: 602, status: "pending",
  message: "unfinished upload", createdAt: "2023-11-14T22:23:22.000Z", finalizedAt: null,
};
const history = Array.from({ length: 601 }, (_, i) => i === 0 ? oldVersion : i === 600 ? newestVersion : ({
  ...oldVersion, id: `ver_history_${i + 1}`, number: i + 1,
  createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  finalizedAt: new Date(1_700_000_000_001 + i * 1000).toISOString(),
})).reverse();
const site = {
  slug: SITE, title: "Disposable version history", description: null, anonymous: false,
  expiresAt: null, settings: {}, currentVersionId: "ver_newest", currentVersion: newestVersion,
  url: `${API}/s/${SITE}/`, createdAt: "2023-11-14T22:13:20.000Z", updatedAt: "2023-11-14T22:23:21.000Z",
  links: { versions: `${API}/api/v1/sites/${SITE}/versions`, files: `${API}/api/v1/sites/${SITE}/files` },
};
const files = [
  {
    path: "docs/old note.txt", sha256: "a".repeat(64), size: 11, contentType: "text/plain", kind: "text", extension: "txt",
    url: `${API}/s/${SITE}/docs/old%20note.txt`, rawUrl: `${API}/api/v1/sites/${SITE}/files/docs/old%20note.txt`,
  },
  {
    path: "index.html", sha256: "b".repeat(64), size: 20, contentType: "text/html", kind: "html", extension: "html",
    url: `${API}/s/${SITE}/index.html`, rawUrl: `${API}/api/v1/sites/${SITE}/files/index.html`,
  },
];
const notFound = {
  error: { code: "version_not_found", message: "Version not found.", hint: "List the site's versions and use an id or version number from that list." },
  requestId: "req_version_fixture",
};

type Seen = { method: string; path: string; search: string; body: string };
type Options = { auth?: "saved" | "env"; errorStatus?: number; errorBody?: unknown; emptyConfig?: boolean };
let work: string;
let cwd: string;
let config: string;

beforeEach(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kofra-version-refs-"));
  cwd = join(work, "project");
  config = join(work, "config");
  await mkdir(cwd);
  await mkdir(config);
  await writeFile(join(config, "credentials.json"), JSON.stringify({
    default: API, instances: { [API]: { key: SAVED_KEY, email: "fixture@example.net" } },
  }) + "\n", { mode: 0o600 });
  await writeFile(join(cwd, "dropway.json"), JSON.stringify({ api: API, sites: { dist: SITE } }) + "\n");
  await writeFile(join(cwd, ".env"), `UNRELATED_FIXTURE=${CLAIM}\n`);
  // A missing Io.fetch hookup must fail closed, not contact a real instance.
  vi.stubGlobal("fetch", async () => { throw new Error("Unexpected network outside acceptance transport"); });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(work, { recursive: true, force: true });
});

/** Detect creates, deletes, chmods and same-content rewrites, not just JSON changes. */
async function snapshot(dir: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const s = await stat(path, { bigint: true });
    entries.push([name, String(s.mode), String(s.ino), String(s.mtimeNs), String(s.ctimeNs),
      s.isDirectory() ? await snapshot(path) : (await readFile(path)).toString("base64")]);
  }
  return entries;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function cli(args: string[], options: Options = {}) {
  const before = await snapshot(work);
  const seen: Seen[] = [];
  let stdout = "";
  let stderr = "";
  let prompts = 0;
  const io: Io = {
    stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text),
    stdinIsTTY: false, stderrIsTTY: false, readStdin: async () => "",
    prompt: async () => { prompts++; throw new Error("Read-only CLI must not prompt"); },
    cwd,
    env: {
      KOFRA_CONFIG_DIR: options.emptyConfig ? join(work, "absent-config") : config,
      ...(options.auth === "env" ? { KOFRA_API_KEY: ENV_KEY } : {}),
    },
    fetch: async (req) => {
      const url = new URL(req.url);
      seen.push({ method: req.method, path: url.pathname, search: url.search, body: await req.clone().text() });
      expect(url.origin).toBe(API);
      expect(req.headers.get("authorization")).toBe(`Bearer ${options.auth === "env" ? ENV_KEY : SAVED_KEY}`);
      if (req.method !== "GET") return json({ error: { code: "fixture_mutation_refused", message: "Only GET is permitted." } }, 405);
      const base = `/api/v1/sites/${SITE}`;
      if (url.pathname === base) return json(site);
      if (url.pathname === `${base}/versions`) {
        // Model the real bounded endpoint: no cursor, no full-history promise.
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
        return json({ versions: history.slice(0, limit), currentVersionId: "ver_newest" });
      }
      if (url.pathname.startsWith(`${base}/versions/`)) {
        if (options.errorStatus) return json(options.errorBody ?? notFound, options.errorStatus);
        const ref = decodeURIComponent(url.pathname.slice(`${base}/versions/`.length));
        if (["live", "v601", "601", "ver_newest"].includes(ref)) return json({ site: SITE, version: newestVersion, missing: [] });
        if (["v1", "1", "ver_archive_opaque-A_z9"].includes(ref)) return json({ site: SITE, version: oldVersion, missing: [] });
        if (["v602", "602", "ver_pending"].includes(ref)) return json({ site: SITE, version: pendingVersion, missing: ["a".repeat(64)] });
        return json(notFound, 404);
      }
      if (url.pathname === `${base}/files`) {
        const ref = url.searchParams.get("version") ?? "live";
        const version = ref === "ver_archive_opaque-A_z9" ? oldVersion : newestVersion;
        return json({ version, files });
      }
      return json({ error: { code: "fixture_unexpected_path", message: url.pathname, hint: "Use the existing site/version/files endpoints." } }, 400);
    },
  };
  const code = await run(args, io);
  expect(prompts, "non-TTY must never prompt").toBe(0);
  expect(seen.every((r) => r.method === "GET" && r.body === ""), "read commands must make GET-only, bodyless requests").toBe(true);
  expect(await snapshot(work), "read commands must not change config, credentials, link or project files").toEqual(before);
  expect(stdout + stderr).not.toContain(ENV_KEY);
  expect(stdout + stderr).not.toContain(SAVED_KEY);
  expect(stdout + stderr).not.toContain(CLAIM);
  return { code, stdout, stderr, seen };
}

function machine(result: Awaited<ReturnType<typeof cli>>) {
  // JSON.parse rejects progress, extra JSON values and a human-output fallback.
  const body = JSON.parse(result.stdout);
  expect(body).not.toBeNull();
  expect(Array.isArray(body)).toBe(false);
  expect(typeof body).toBe("object");
  return body;
}

function directRequests(result: Awaited<ReturnType<typeof cli>>, ref: string) {
  const base = `/api/v1/sites/${SITE}`;
  expect(result.seen.filter((r) => r.path === `${base}/versions`), "explicit refs must not fetch bounded history").toEqual([]);
  const direct = result.seen.filter((r) => r.path.startsWith(`${base}/versions/`));
  expect(direct).toEqual([{ method: "GET", path: `${base}/versions/${encodeURIComponent(ref)}`, search: "", body: "" }]);
  expect(result.seen.every((r) => [base, `${base}/versions/${encodeURIComponent(ref)}`, `${base}/files`].includes(r.path))).toBe(true);
}

describe("explicit version inspection outside bounded history", () => {
  it.each([
    ["v1", "ver_archive_opaque-A_z9", 1],
    ["1", "ver_archive_opaque-A_z9", 1],
    ["ver_archive_opaque-A_z9", "ver_archive_opaque-A_z9", 1],
    ["live", "ver_newest", 601],
    ["v601", "ver_newest", 601],
    ["601", "ver_newest", 601],
    ["ver_newest", "ver_newest", 601],
  ])("versions <site> %s returns canonical metadata through one direct GET", async (ref, id, number) => {
    const r = await cli(["versions", SITE, String(ref), "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    directRequests(r, String(ref));
    expect(machine(r)).toMatchObject({ version: { id, number, status: "ready", fileCount: 2, totalBytes: 31 } });
    const v = machine(r).version;
    expect(v.message).toBe(number === 1 ? "first release" : "current release");
    expect(v.createdAt).toBe(number === 1 ? "2023-11-14T22:13:20.000Z" : "2023-11-14T22:23:20.000Z");
    expect(v.finalizedAt).toBe(number === 1 ? "2023-11-14T22:13:21.000Z" : "2023-11-14T22:23:21.000Z");
    expect(v.client).toBe("acceptance/1");
    expect(v.source).toBe("api");
    expect(v.live).toBe(number === 601);
    expect(machine(r).missing).toEqual([]);
  });

  it("inspects pending metadata without filtering it to ready or fetching files", async () => {
    const r = await cli(["versions", SITE, "ver_pending", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    directRequests(r, "ver_pending");
    expect(machine(r)).toMatchObject({ version: {
      id: "ver_pending", number: 602, status: "pending", live: false, finalizedAt: null,
      fileCount: 2, totalBytes: 31, message: "unfinished upload", createdAt: "2023-11-14T22:23:22.000Z",
    }, missing: ["a".repeat(64)] });
    expect(r.seen.some((request) => request.path.endsWith("/files"))).toBe(false);
  });

  it("human inspection identifies the requested old version rather than listing newer rows", async () => {
    const r = await cli(["versions", SITE, "v1"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    directRequests(r, "v1");
    expect(r.stdout).toMatch(/\bv1\b|\bversion\s+1\b/i);
    expect(r.stdout).toContain("first release");
    expect(r.stdout).not.toContain("ver_newest");
  });
});

describe("files --version resolves explicit refs directly", () => {
  it.each([
    ["v1", "ver_archive_opaque-A_z9", 1],
    ["1", "ver_archive_opaque-A_z9", 1],
    ["ver_archive_opaque-A_z9", "ver_archive_opaque-A_z9", 1],
    ["live", "ver_newest", 601],
    ["v601", "ver_newest", 601],
    ["601", "ver_newest", 601],
    ["ver_newest", "ver_newest", 601],
  ])("files <site> --version %s resolves once then lists the canonical version", async (ref, id, number) => {
    const r = await cli(["files", SITE, "--version", String(ref), "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    directRequests(r, String(ref));
    const body = machine(r);
    expect(body).toMatchObject({ version: { id, number }, files: [
      { path: "docs/old note.txt", sha256: "a".repeat(64), size: 11, contentType: "text/plain" },
      { path: "index.html", sha256: "b".repeat(64), size: 20, contentType: "text/html" },
    ] });
    const reads = r.seen.filter((request) => request.path.endsWith("/files"));
    expect(reads).toHaveLength(1);
    expect(new URLSearchParams(reads[0]!.search).get("version")).toBe(id);
  });
});

describe("explicit read errors and segment safety", () => {
  for (const command of ["versions", "files"] as const) {
    const args = (ref: string) => command === "versions"
      ? [command, SITE, ref, "--json"] : [command, SITE, "--version", ref, "--json"];

    it.each(["missing-ref", "foreign-ref"])(`${command} preserves the same non-disclosing 404 for %s`, async (ref) => {
      const r = await cli(args(ref), { errorStatus: 404 });
      expect(r.code, r.stdout + r.stderr).toBe(4);
      expect(machine(r)).toMatchObject({ ok: false, exitCode: 4, error: {
        code: "version_not_found", status: 404, retryable: false,
        message: "Version not found.", hint: notFound.error.hint, requestId: "req_version_fixture",
      } });
      directRequests(r, ref);
      expect(r.seen.some((request) => request.path.endsWith("/files"))).toBe(false);
    });

    it.each([401, 403])(`${command} preserves server auth error and remediation for HTTP %s`, async (status) => {
      const r = await cli(args("v1"), { errorStatus: status, errorBody: {
        error: { code: "fixture_read_refused", message: "Read refused.", hint: "Use a key with sites:read for this instance." },
        requestId: "req_auth_fixture",
      } });
      expect(r.code, r.stdout + r.stderr).toBe(3);
      expect(machine(r)).toMatchObject({ ok: false, exitCode: 3, error: {
        code: "fixture_read_refused", message: "Read refused.", hint: "Use a key with sites:read for this instance.",
        status, retryable: false, requestId: "req_auth_fixture",
      } });
      directRequests(r, "v1");
    });

    it.each(["", ".", ".."])(
      `${command} locally refuses empty or dot-segment ref %j before version or file reads`, async (ref) => {
        const r = await cli(args(ref));
        expect(r.code, r.stdout + r.stderr).toBe(2);
        const body = machine(r);
        expect(body).toMatchObject({ ok: false, exitCode: 2, error: {
          code: "invalid_version_ref", hint: expect.any(String),
        } });
        expect(body.error.hint.trim().length).toBeGreaterThan(0);
        expect(r.seen.filter((request) => request.path !== `/api/v1/sites/${SITE}`),
          "invalid refs must not request a version, bounded list, files or any other endpoint").toEqual([]);
      },
    );

    it.each(["../other", "ver/a?b#c", "ver%2Felsewhere", "https://other.example/v1", "..", "", "bad\nref"])(
      `${command} rejects or safely encodes unusual ref %j without changing the endpoint`, async (ref) => {
        const r = await cli(args(ref));
        expect(r.code).not.toBe(0);
        const body = machine(r);
        expect(body.ok).toBe(false);
        expect(body.error.code).toMatch(/^[a-z][a-z0-9_]+$/);
        expect(body.error.hint).toEqual(expect.any(String));
        expect(body.error.hint.length).toBeGreaterThan(0);
        const reads = r.seen.filter((request) => request.path !== `/api/v1/sites/${SITE}`);
        // A CLI may refuse invalid segments locally; otherwise it must retain
        // the exact ref as one segment and let the existing API reject it.
        if (reads.length) {
          expect(r.code).toBe(4);
          directRequests(r, ref);
          expect(body.error.code).toBe("version_not_found");
          expect(body.error.hint).toBe(notFound.error.hint);
        } else {
          expect(r.code).toBe(2);
        }
      },
    );
  }
});

describe("bounded-list and read-only CLI compatibility", () => {
  it("keeps versions <site> as a bounded newest-first list, without a synthetic cursor", async () => {
    const r = await cli(["versions", SITE, "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const body = machine(r);
    expect(body.versions).toHaveLength(500);
    expect(body.versions[0]).toMatchObject({ id: "ver_newest", number: 601 });
    expect(body.versions[499]).toMatchObject({ id: "ver_history_102", number: 102 });
    expect(body.versions.some((v: { id: string }) => v.id === "ver_archive_opaque-A_z9")).toBe(false);
    expect(body.nextCursor ?? null).toBeNull();
    expect(r.seen.filter((request) => request.path.endsWith("/versions"))).toHaveLength(1);
    expect(r.seen.some((request) => /\/versions\//.test(request.path))).toBe(false);
  });

  it("keeps the live marker in the legacy human list", async () => {
    const r = await cli(["versions", SITE]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/v601\s+live/);
  });

  it("keeps default files as live-version file listing", async () => {
    const r = await cli(["files", SITE, "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(machine(r).files.map((file: { path: string }) => file.path)).toEqual(["docs/old note.txt", "index.html"]);
    expect(r.seen.some((request) => request.path.endsWith("/versions"))).toBe(false);
  });

  it("resolves saved-instance config and env-key precedence without persisting either", async () => {
    const r = await cli(["versions", SITE, "v1", "--json"], { auth: "env" });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    directRequests(r, "v1");
    expect(machine(r)).toMatchObject({ version: { id: "ver_archive_opaque-A_z9" } });
  });

  it("does not create absent credential directories for explicit reads with --api and an env key", async () => {
    const r = await cli(["versions", SITE, "v1", "--api", API, "--json"], { auth: "env", emptyConfig: true });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    directRequests(r, "v1");
    expect(machine(r)).toMatchObject({ version: { id: "ver_archive_opaque-A_z9" } });
  });

  it.each([
    ["versions", SITE, "v1", "--verison", "v2", "--json"],
    ["files", SITE, "--verison", "v1", "--json"],
  ])("refuses unknown read flags without contacting an endpoint: %j", async (...args) => {
    const r = await cli(args);
    expect(r.code).toBe(2);
    expect(machine(r)).toMatchObject({ ok: false, exitCode: 2, error: { hint: expect.any(String) } });
    expect(r.seen).toEqual([]);
  });

  it.each([["--version"], ["version"]])("keeps binary version output, not site inspection: %j", async (...args) => {
    const r = await cli(args);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
    expect(r.seen).toEqual([]);
  });

  it.each([["help", "versions"], ["versions", "--help"]])("discovers optional single-ref inspection in runtime help: %j", async (...args) => {
    const r = await cli(args);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/versions\s+<[^>]+>\s+\[[^\]\n]+\]/i);
    expect(r.stdout).toMatch(/inspect|show|single|one version|details/i);
    expect(r.seen).toEqual([]);
  });
});
