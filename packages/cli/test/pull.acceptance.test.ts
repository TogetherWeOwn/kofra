/**
 * Protected pull contract. Only HTTP is substituted for malicious manifests,
 * corrupt bytes and deterministic read failures which a healthy Worker cannot
 * produce. The real command/parser/client/filesystem/output run in every case.
 * Run: npm run test:cli -- test/pull.acceptance.test.ts
 * A new mkdtemp is reset after each test. No instance credentials or network.
 */
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { object, pullHarness, receipt, sentinelKey, sha256, tree, type Ran } from "./fixtures/pull-harness";

const api = "https://pull-fixture.example";
const site = "pull-fixture";
const versionId = "ver_immutable_old_fixture";
const base = `/api/v1/sites/${site}`;
const bytes = Buffer.from([0, 255, 128, 13, 10, 195, 40, 254]);
let h: Awaited<ReturnType<typeof pullHarness>>;
let dir: string;
let violations: string[];
type Mode = { path?: string; corruption?: "hash" | "size" | "short" | "missing_hash" | "stream"; status?: number; pageList?: boolean; large?: boolean };

const version = { id: versionId, number: 1, status: "ready", live: false, fileCount: 1, totalBytes: bytes.length,
  source: "api", message: "old release", client: "fixture", createdAt: "2026-01-01T00:00:00.000Z", finalizedAt: "2026-01-01T00:00:01.000Z" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
  h = await pullHarness();
  dir = join(h.cwd, "download");
  violations = [];
  vi.stubGlobal("fetch", async () => { throw new Error("Unexpected network outside acceptance transport"); });
});
afterEach(async () => { vi.unstubAllGlobals(); await h?.dispose(); });

function transport(mode: Mode = {}, expectedKey = sentinelKey) {
  const content = mode.large || mode.corruption === "stream" ? Buffer.alloc(2 * 1_048_576 + 23, 173) : bytes;
  const paths = mode.pageList ? ["first.bin", "nested/second.bin"] : [mode.path ?? "bytes.bin"];
  const rows = paths.map(path => ({ path, size: content.length + (mode.corruption === "size" ? 1 : 0),
    ...(mode.corruption === "missing_hash" ? {} : { sha256: mode.corruption === "hash" ? "0".repeat(64) : sha256(content) }),
    contentType: "application/octet-stream", kind: "binary", extension: "bin",
    url: `${api}/s/${site}/${path}`, rawUrl: `${api}${base}/files/${path.split("/").map(encodeURIComponent).join("/")}` }));
  const v = { ...version, fileCount: rows.length, totalBytes: rows.reduce((sum, row) => sum + row.size, 0) };
  let sequence = 0;
  const badRequest = (message: string) => { violations.push(message); throw new Error(message); };
  return {
    content, rows,
    fetch: async (request: Request): Promise<Response> => {
      expect(request.headers.get("Authorization")).toBe(`Bearer ${expectedKey}`);
      const url = new URL(request.url);
      if (url.pathname === base) return json({ site: { id: "site_fixture", slug: site, currentVersionId: versionId,
        currentVersion: v, url: `${api}/s/${site}/`, title: null, description: null, anonymous: false, settings: {},
        expiresAt: null, createdAt: v.createdAt, updatedAt: v.finalizedAt,
        links: { versions: `${api}${base}/versions`, files: `${api}${base}/files` } } });
      if (url.pathname.startsWith(`${base}/versions/`)) {
        const ref = decodeURIComponent(url.pathname.slice(`${base}/versions/`.length));
        if (!["live", "1", "v1", versionId].includes(ref)) return json({ error: { code: "version_not_found", message: "Version not found.", hint: "Choose a visible version." } }, 404);
        sequence = Math.max(sequence, 1);
        return json({ site, version: v, missing: [] });
      }
      if (url.pathname === `${base}/versions`) return badRequest("pull must resolve directly, never scan bounded version history");
      if (url.pathname === `${base}/files`) {
        if (url.searchParams.get("version") !== versionId) return badRequest("manifest must use the immutable version id");
        sequence = 2;
        const index = mode.pageList && url.searchParams.get("cursor") === "page-two" ? 1 : 0;
        return json({ site, version: v, files: mode.pageList ? [rows[index]] : rows, total: rows.length,
          nextCursor: mode.pageList && index === 0 ? "page-two" : null });
      }
      const paged = url.pathname === "/api/v1/read-file";
      const raw = url.pathname.startsWith(`${base}/files/`);
      if (!paged && !raw) return badRequest(`unexpected endpoint: ${url.pathname}`);
      if (sequence !== 2) return badRequest("file reads must follow the pinned manifest");
      if (url.searchParams.get("version") !== versionId) return badRequest("every file read must use the immutable version id");
      const path = paged ? url.searchParams.get("path") : decodeURIComponent(url.pathname.slice(`${base}/files/`.length));
      if (!paths.includes(path!)) return badRequest("file read must come from the listed manifest");
      if (mode.status) return json({ error: { code: "fixture_read_failed", message: "Fixture file could not be read.", hint: "Retry with a readable file." } }, mode.status);
      const row = rows.find(row => row.path === path)!;
      const source = mode.corruption === "short" ? content.subarray(0, content.length - 1) : content;
      if (raw) {
        let offset = 0;
        const response = new Response(new ReadableStream({ pull(controller) {
          if (mode.corruption === "stream" && offset > 0) { controller.error(new TypeError("fixture connection interrupted after bytes")); return; }
          if (offset >= source.length) { controller.close(); return; }
          controller.enqueue(new Uint8Array(source.subarray(offset, offset + 65_536)));
          offset += 65_536;
        } }), { headers: { "Content-Type": "application/octet-stream" } });
        // Raw bytes must be consumed as a stream, not via a whole-body helper.
        if (mode.large) {
          for (const method of ["arrayBuffer", "text", "json", "blob", "bytes"] as const) {
            Object.defineProperty(response, method, { value: async () => { throw new Error("whole-file buffering is forbidden by the pull contract"); } });
          }
        }
        return response;
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (mode.corruption === "stream" && offset > 0) throw new TypeError("fixture connection interrupted after a page");
      const length = Number(url.searchParams.get("length") ?? 65_536);
      if (!Number.isSafeInteger(length) || length < 1 || length > 1_048_576) return badRequest("read_file pages must respect the existing 1 MiB maximum");
      const part = source.subarray(offset, offset + length);
      const next = offset + part.length;
      return json({ path, versionId, contentType: row.contentType, kind: row.kind, size: row.size, sha256: row.sha256,
        encoding: "base64", offset, length: part.length, content: part.toString("base64"),
        truncated: next < source.length, nextOffset: next < source.length ? next : null, url: row.url, rawUrl: row.rawUrl });
    },
  };
}

async function pull(mode: Mode = {}, flags: string[] = [], target = dir): Promise<Ran> {
  const fixture = transport(mode);
  const r = await h.cli(["pull", site, target, ...flags, "--json"], { api, fetch: fixture.fetch });
  expect(violations, "only the existing read endpoints, correctly pinned").toEqual([]);
  return r;
}
function failure(r: Ran, path: string) {
  expect(r.code, r.stdout + r.stderr).toBeGreaterThan(0);
  expect(r.code).toBeLessThanOrEqual(7);
  const body = receipt(r, site, versionId, dir);
  expect(body.files.some((file: any) => file.path === path), "failed file must not count as pulled").toBe(false);
  expect(body.failures).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
  return body;
}

// These controls distinguish fixture/protocol mistakes from the absent command.
describe("pull transport controls (green on baseline)", () => {
  it("exercises the same manifest and bounded binary page through existing generic api", async () => {
    const fixture = transport();
    const listed = await h.cli(["api", "GET", `${base.slice(7)}/files?version=${versionId}`, "--json"], { api, fetch: fixture.fetch });
    expect(listed.code, listed.stdout + listed.stderr).toBe(0);
    expect(object(listed).files).toEqual(fixture.rows);
    const page = await h.cli(["api", "GET", `/read-file?site=${site}&path=bytes.bin&version=${versionId}`, "--json"], { api, fetch: fixture.fetch });
    expect(page.code).toBe(0);
    expect(object(page)).toMatchObject({ content: "AP+ADQrDKP4=", size: 8, sha256: sha256(bytes), versionId });
    expect(violations).toEqual([]);
  });
});

describe("pull immutable version and output contract", () => {
  it.each([undefined, "live", "v1", "1", versionId])("resolves %s before listing/reading and writes verified receipt rows", async ref => {
    const r = await pull({}, ref === undefined ? [] : ["--version", ref]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const body = receipt(r, site, versionId, dir);
    expect(body.files).toEqual([{ path: "bytes.bin", size: 8, sha256: sha256(bytes) }]);
    expect(body.failures).toEqual([]);
    expect(await tree(dir)).toEqual({ "bytes.bin": bytes.toString("base64") });
    const manifest = r.wire.findIndex(w => w.url.pathname === `${base}/files`);
    expect(manifest).toBeGreaterThan(0);
    if (ref && ref !== "live") {
      expect(r.wire.slice(0, manifest).some(w => w.url.pathname === `${base}/versions/${ref}`)).toBe(true);
    } else {
      expect(r.wire.slice(0, manifest).some(w => w.url.pathname === base || w.url.pathname === `${base}/versions/live`)).toBe(true);
    }
  });

  it("follows manifest continuation instead of silently pulling only page one", async () => {
    const r = await pull({ pageList: true });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(receipt(r, site, versionId, dir).files.map((f: any) => f.path).sort()).toEqual(["first.bin", "nested/second.bin"]);
    expect(await tree(dir)).toEqual({ "first.bin": bytes.toString("base64"), "nested/second.bin": bytes.toString("base64") });
    expect(r.wire.some(w => w.url.searchParams.get("cursor") === "page-two")).toBe(true);
  });

  it("downloads a multi-page binary without a whole raw-response buffer", async () => {
    const r = await pull({ large: true });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const content = Buffer.alloc(2 * 1_048_576 + 23, 173);
    expect(await readFile(join(dir, "bytes.bin"))).toEqual(content);
    expect(receipt(r, site, versionId, dir).files).toEqual([{ path: "bytes.bin", size: content.length, sha256: sha256(content) }]);
    const pages = r.wire.filter(w => w.url.pathname === "/api/v1/read-file");
    if (pages.length) expect(pages.length).toBeGreaterThan(2);
  });

  it("lets explicit instance/key flags override conflicting environment settings without persisting them", async () => {
    const r = await h.cli(["pull", site, dir, "--api", api, "--key", sentinelKey, "--json"], {
      api, fetch: transport().fetch, env: { KOFRA_API: "https://unused-instance.example", KOFRA_API_KEY: "dw_wrong_env_fixture" },
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(receipt(r, site, versionId, dir).files).toHaveLength(1);
    expect(r.stdout + r.stderr).not.toContain("dw_wrong_env_fixture");
    expect(await readFile(join(dir, "bytes.bin"))).toEqual(bytes);
  });

  it("uses saved instance/key when env is absent and lets env key override the saved key", async () => {
    const savedKey = "dw_saved_pull_fixture_not_a_live_key";
    await writeFile(join(h.config, "credentials.json"), JSON.stringify({ default: api, instances: { [api]: { key: savedKey } } }), { mode: 0o600 });
    for (const env of [{ KOFRA_API: undefined, KOFRA_API_KEY: undefined }, { KOFRA_API: undefined, KOFRA_API_KEY: sentinelKey }]) {
      const target = join(h.cwd, env.KOFRA_API_KEY ? "env-key" : "saved-key");
      const r = await h.cli(["pull", site, target, "--json"], { api, fetch: transport({}, env.KOFRA_API_KEY ?? savedKey).fetch, env });
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(receipt(r, site, versionId, target).files).toHaveLength(1);
      expect(r.stdout + r.stderr).not.toContain(savedKey);
    }
  });
});

describe("pull local safety", () => {
  it("refuses a nonempty destination before any local write with a stable usage error", async () => {
    await mkdir(dir);
    await writeFile(join(dir, "keep.txt"), "keep these bytes");
    const before = await tree(h.work);
    const r = await pull();
    expect(r.code).toBe(2);
    const body = object(r);
    expect(body).toMatchObject({ ok: false, exitCode: 2, error: { code: expect.stringMatching(/^[a-z][a-z0-9_]*$/), hint: expect.any(String) } });
    expect(body.error.code).not.toBe("unknown_command");
    expect(body.error.hint.length).toBeGreaterThan(0);
    expect(await tree(h.work)).toEqual(before);
    const again = await pull();
    expect(object(again).error.code).toBe(body.error.code);
  });

  it("accepts an existing empty destination", async () => {
    await mkdir(dir);
    const r = await pull();
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(receipt(r, site, versionId, dir).failures).toEqual([]);
    expect(await readFile(join(dir, "bytes.bin"))).toEqual(bytes);
  });

  it("--force overwrites only pulled paths, preserving and reporting unrelated nested files", async () => {
    await mkdir(join(dir, "local"), { recursive: true });
    await writeFile(join(dir, "bytes.bin"), "stale bytes");
    await writeFile(join(dir, "local", "keep.txt"), "local only");
    const r = await pull({}, ["--force"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(receipt(r, site, versionId, dir).files).toHaveLength(1);
    expect(await tree(dir)).toEqual({ "bytes.bin": bytes.toString("base64"), "local/keep.txt": Buffer.from("local only").toString("base64") });
    expect(r.stderr, "extra local paths must be reported outside the fixed JSON receipt").toContain("local/keep.txt");
  });

  it.each(["../escape.bin", "nested/../../escape.bin", "/absolute.bin", "\\absolute.bin", "C:\\escape.bin", "C:/escape.bin", "C:escape.bin", "nested\\..\\escape.bin", "//server/share.bin", "nested//empty.bin", "nested/", "", "./dot.bin", "nested/../dot.bin"])("counts hostile manifest path %j as a failure without writing it anywhere", async path => {
    const before = await tree(h.work);
    const r = await pull({ path });
    failure(r, path);
    expect(await tree(h.work), "bad manifest path must not create a file, in or outside the target").toEqual(before);
  });

  it("cannot follow an existing local directory symlink outside the destination under --force", async () => {
    await mkdir(dir);
    const outside = join(h.cwd, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "bytes.bin"), "outside sentinel");
    await symlink(outside, join(dir, "linked"), "dir");
    const r = await pull({ path: "linked/bytes.bin" }, ["--force"]);
    failure(r, "linked/bytes.bin");
    expect(await readFile(join(outside, "bytes.bin"), "utf8")).toBe("outside sentinel");
  });
});

describe("pull integrity and failure accounting", () => {
  it.each(["hash", "size", "short", "missing_hash", "stream"] as const)("does not count or leave a complete-looking file on %s failure", async corruption => {
    const r = await pull({ corruption });
    failure(r, "bytes.bin");
    expect(await tree(dir), "failed download must not leave a complete-looking or temporary file").toEqual({});
  });

  it("failed --force replacement preserves the old same-path bytes or removes the failed target, never corrupted new bytes", async () => {
    await mkdir(dir);
    await writeFile(join(dir, "bytes.bin"), "old complete file");
    await writeFile(join(dir, "extra.txt"), "keep me");
    const r = await pull({ corruption: "hash" }, ["--force"]);
    failure(r, "bytes.bin");
    const output = await tree(dir);
    expect(output["bytes.bin"] === undefined || output["bytes.bin"] === Buffer.from("old complete file").toString("base64")).toBe(true);
    expect(output["extra.txt"]).toBe(Buffer.from("keep me").toString("base64"));
    expect(Object.keys(output).every(path => ["bytes.bin", "extra.txt"].includes(path))).toBe(true);
  });

  it.each([[401, 3], [403, 3], [404, 4], [413, 6], [503, 7]])("keeps a file's HTTP %s in failures and uses existing exit %s", async (status, exit) => {
    const r = await pull({ status });
    expect(r.code, r.stdout + r.stderr).toBe(exit);
    const body = failure(r, "bytes.bin");
    expect(body.failures).toContainEqual({ path: "bytes.bin", code: "fixture_read_failed", message: "Fixture file could not be read." });
    expect(await tree(dir)).toEqual({});
  });
});

describe("pull discovery and arity", () => {
  it("advertises pull beside the existing commands in global help", async () => {
    const r = await h.cli(["help"], { api, fetch: transport().fetch });
    expect(r.code).toBe(0);
    expect(r.wire).toEqual([]);
    expect(r.stdout).toMatch(/^\s+pull\s/m);
    for (const existing of ["publish", "read-file", "files", "versions"]) expect(r.stdout).toContain(existing);
  });

  it.each([["help", "pull"], ["pull", "--help"]])("discovers syntax, safety and integrity through %j without network", async (...args) => {
    const r = await h.cli(args, { api, fetch: transport().fetch });
    expect(r.code).toBe(0);
    expect(r.wire).toEqual([]);
    expect(r.stdout).toMatch(/pull\s+<[^>]+>\s+<[^>]+>/);
    for (const flag of ["--version", "--force", "--json"]) expect(r.stdout).toContain(flag);
    expect(r.stdout).toMatch(/sha.?256|hash|verif/i);
    expect(r.stdout).toMatch(/non.?empty|empty.*director/i);
    expect(r.stdout).toMatch(/preserv|never delet|not delet|keep.*local/i);
  });

  it.each([[], [site], [site, "download", "surplus"], [site, "download", "--version"], [site, "download", "--froce"]])("rejects bad arguments %j before any request or local write", async (...args) => {
    const before = await tree(h.work);
    const r = await h.cli(["pull", ...args, "--json"], { api, fetch: transport().fetch });
    expect(r.code).toBe(2);
    expect(r.wire).toEqual([]);
    const body = object(r);
    expect(body).toMatchObject({ ok: false, exitCode: 2, error: { code: expect.any(String), hint: expect.any(String) } });
    expect(body.error.code, "command must be recognized before usage validation").not.toBe("unknown_command");
    expect(body.error.hint.length).toBeGreaterThan(0);
    expect(await tree(h.work)).toEqual(before);
  });
});
