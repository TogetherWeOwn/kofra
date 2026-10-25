import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { clearLiveMemoryCache, defaultPolicy } from "@dropway/core";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";

/**
 * Protected Test Author regressions: implement against these tests without editing them.
 * A vanished source manifest must not produce a successful empty copy. A failed
 * cache warm after commit must not turn a complete copy into a non-replayable error.
 * Only disposable D1/R2/KV bindings and real publish/delete operations are used.
 */
const FILES = [
  { path: "index.html", content: "<h1>Version A</h1>", contentType: "text/html; charset=utf-8" },
  { path: "docs/résumé-🎉.txt", content: "Version A: résumé 🎉\n", contentType: "text/plain; charset=utf-8" },
  { path: "data/record.json", content: '{"version":"A"}\n', contentType: "application/vnd.fixture+json" },
  { path: "empty.txt", content: "", contentType: "text/plain; charset=utf-8" },
];
const NEXT_FILES = [{ path: "index.html", content: "<h1>Version B</h1>", contentType: "text/html; charset=utf-8" }];

type ManifestFile = { path: string; sha256: string; size: number; content_type: string };
type LiveVersion = {
  site_id: string; version_id: string; number: number; status: string;
  file_count: number; total_bytes: number; manifest_hash: string;
};

afterEach(() => {
  vi.restoreAllMocks();
  clearLiveMemoryCache();
});

async function publish(dw: Instance, slug: string, files = FILES, status = 201) {
  const result = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ slug, files }) });
  expect(result.status, `fixture publish ${slug}: ${JSON.stringify(result.body)}`).toBe(status);
  return result.body;
}

async function duplicate(dw: Instance, source: string, newSlug: string, idempotencyKey?: string) {
  return dw.json(`/api/v1/sites/${source}/duplicate`, {
    key: dw.ownerKey,
    ...jsonBody({ newSlug }),
    headers: { "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
  });
}

async function liveVersion(slug: string) {
  const row = await env.DB.prepare(`SELECT s.id AS site_id, v.id AS version_id, v.number,
    v.status, v.file_count, v.total_bytes, v.manifest_hash FROM sites s
    JOIN versions v ON v.id = s.current_version_id WHERE s.slug = ? AND s.deleted_at IS NULL`)
    .bind(slug).first<LiveVersion>();
  expect(row, `fixture live version for ${slug}`).not.toBeNull();
  return row!;
}

async function manifest(versionId: string) {
  return (await env.DB.prepare("SELECT path, sha256, size, content_type FROM version_files WHERE version_id = ? ORDER BY path")
    .bind(versionId).all<ManifestFile>()).results;
}

async function expectedManifest(files = FILES) {
  const entries = await Promise.all(files.map(async (file) => {
    const bytes = new TextEncoder().encode(file.content);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return {
      path: file.path, size: bytes.length, content_type: file.contentType,
      sha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
    };
  }));
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function tableCounts() {
  const row = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM sites) AS sites,
    (SELECT COUNT(*) FROM versions) AS versions, (SELECT COUNT(*) FROM version_files) AS files`)
    .first<{ sites: number; versions: number; files: number }>();
  return row!;
}

async function expectExactCopy(dw: Instance, slug: string, source: LiveVersion, expected: ManifestFile[]) {
  const copy = await liveVersion(slug);
  expect(copy.site_id).not.toBe(source.site_id);
  expect(copy.version_id).not.toBe(source.version_id);
  expect(copy).toMatchObject({
    number: 1, status: "ready", file_count: expected.length,
    total_bytes: expected.reduce((sum, f) => sum + f.size, 0), manifest_hash: source.manifest_hash,
  });
  expect(await manifest(copy.version_id), "committed destination rows must equal the captured source, including content types").toEqual(expected);
  const listed = await dw.json(`/api/v1/sites/${slug}/files`, { key: dw.ownerKey });
  expect(listed.status).toBe(200);
  expect(listed.body.files).toHaveLength(FILES.length);
  for (const file of FILES) {
    const entry = listed.body.files.find((f: { path: string }) => f.path === file.path);
    expect(entry, `destination lists ${file.path}`).toBeDefined();
    const response = await dw.call(entry.rawUrl, { key: dw.ownerKey });
    expect(response.status, file.path).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer()), `served bytes of ${file.path}`).toEqual(new TextEncoder().encode(file.content));
  }
  return copy;
}

async function advanceAndDelete(dw: Instance, slug: string, old: LiveVersion) {
  const published = await publish(dw, slug, NEXT_FILES, 200);
  expect(published.version.id).not.toBe(old.version_id);
  expect((await liveVersion(slug)).version_id).toBe(published.version.id);
  const deleted = await dw.json(`/api/v1/sites/${slug}/versions/${old.version_id}`, { method: "DELETE", key: dw.ownerKey });
  expect(deleted.status, `fixture deletion of nonlive A: ${JSON.stringify(deleted.body)}`).toBe(200);
  expect(await env.DB.prepare("SELECT id FROM versions WHERE id = ?").bind(old.version_id).first()).toBeNull();
  expect(await manifest(old.version_id), "real delete cascaded A's manifest").toEqual([]);
  expect(await manifest(published.version.id), "B remains a complete, different live version").toEqual(await expectedManifest(NEXT_FILES));
  return published.version.id as string;
}

describe("duplicate_site preparation and post-commit reliability", () => {
  it("preserves captured A or refuses cleanly when beforeDeploy publishes B and deletes A", async () => {
    const sourceSlug = "race-source";
    const targetSlug = "race-copy";
    let armed = false;
    let deletedDuringPreparation = false;
    let nextVersionId: string | undefined;
    let source: LiveVersion;
    const dw = await freshInstance({}, { adapters: { policy: {
      ...defaultPolicy,
      async beforeDeploy(_principal, input) {
        if (!armed) return;
        const target = await env.DB.prepare("SELECT slug FROM sites WHERE id = ?").bind(input.siteId).first<{ slug: string }>();
        if (target?.slug !== targetSlug) return;
        // Disarm BEFORE nested publication: source publishing must not recurse.
        armed = false;
        nextVersionId = await advanceAndDelete(dw, sourceSlug, source);
        deletedDuringPreparation = true;
      },
    } } });
    await publish(dw, sourceSlug);
    source = await liveVersion(sourceSlug);
    const expected = await expectedManifest();
    expect(await manifest(source.version_id)).toEqual(expected);
    const before = await tableCounts();
    armed = true;

    const result = await duplicate(dw, sourceSlug, targetSlug);
    expect(deletedDuringPreparation, "fixture must complete real source publish/delete during destination preparation").toBe(true);
    expect((await liveVersion(sourceSlug)).version_id).toBe(nextVersionId);
    expect([201, 409], JSON.stringify(result.body)).toContain(result.status);
    if (result.status === 201) {
      expect(result.body.version).toMatchObject({ fileCount: expected.length, totalBytes: source.total_bytes });
      await expectExactCopy(dw, targetSlug, source, expected);
    } else {
      expect(result.body.error).toMatchObject({ code: "version_conflict", hint: expect.any(String) });
      expect(result.body.error.hint.trim().length).toBeGreaterThan(0);
      // B replaced A: one source version remains; no destination rows may survive.
      expect(await tableCounts()).toEqual({ ...before, files: NEXT_FILES.length });
      expect(await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind(targetSlug).first()).toBeNull();
      const reusable = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: targetSlug }) });
      expect(reusable.status, "refusal must not leave the destination slug taken").toBe(201);
    }
  });

  it("preserves A or returns version_conflict when A vanishes before its manifest read", async () => {
    const dw = await freshInstance();
    const sourceSlug = "early-race-source";
    const targetSlug = "early-race-copy";
    await publish(dw, sourceSlug);
    const source = await liveVersion(sourceSlug);
    const expected = await expectedManifest();
    expect(await manifest(source.version_id)).toEqual(expected);
    const before = await tableCounts();
    let armed = true;
    let deletedBeforeRead = false;
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!armed || !/^\s*SELECT\b[\s\S]*\bFROM\s+version_files\b/i.test(sql)) return statement;
      const bind = statement.bind.bind(statement);
      vi.spyOn(statement, "bind").mockImplementation((...values) => {
        const bound = bind(...values);
        if (values[0] !== source.version_id) return bound;
        const all = bound.all.bind(bound);
        // Gate the real D1 read, not its result: A was selected as live, but its
        // manifest has not been read. Every subsequent query still executes in D1.
        vi.spyOn(bound, "all").mockImplementationOnce(async <T>() => {
          armed = false;
          await advanceAndDelete(dw, sourceSlug, source);
          deletedBeforeRead = true;
          return all<T>();
        });
        return bound;
      });
      return statement;
    });

    const result = await duplicate(dw, sourceSlug, targetSlug);
    expect(deletedBeforeRead, "fixture must delete A before the real manifest SELECT executes").toBe(true);
    expect([201, 409], JSON.stringify(result.body)).toContain(result.status);
    if (result.status === 201) {
      await expectExactCopy(dw, targetSlug, source, expected);
    } else {
      expect(result.body.error).toMatchObject({ code: "version_conflict", hint: expect.any(String) });
      expect(result.body.error.hint.trim().length).toBeGreaterThan(0);
      expect(await tableCounts()).toEqual({ ...before, files: NEXT_FILES.length });
      expect(await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind(targetSlug).first()).toBeNull();
      const reusable = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: targetSlug }) });
      expect(reusable.status, "refusal must not leave the destination slug taken").toBe(201);
    }
  });

  it("returns and replays the committed copy when only its live-cache put fails", async () => {
    const dw = await freshInstance();
    const sourceSlug = "cache-fault-source";
    const targetSlug = "cache-fault-copy";
    await publish(dw, sourceSlug);
    const source = await liveVersion(sourceSlug);
    const expected = await expectedManifest();
    expect(await manifest(source.version_id)).toEqual(expected);
    const before = await tableCounts();
    const put = env.CACHE.put.bind(env.CACHE);
    let failedPuts = 0;
    vi.spyOn(env.CACHE, "put").mockImplementation(async (key, value, options) => {
      if (key === `live:${targetSlug}`) {
        failedPuts++;
        throw new Error("fixture destination live-cache write failure");
      }
      return put(key, value, options);
    });

    const first = await duplicate(dw, sourceSlug, targetSlug, "cache-warm-fault");
    expect(failedPuts, "fixture failed destination live-cache warming, not idempotency writes").toBeGreaterThan(0);
    const committed = await liveVersion(targetSlug);
    expect(await manifest(committed.version_id), "the failure happened after a complete destination commit").toEqual(expected);
    const retry = await duplicate(dw, sourceSlug, targetSlug, "cache-warm-fault");
    expect.soft(first.status, `committed duplicate must return 201: ${JSON.stringify(first.body)}`).toBe(201);
    expect.soft(first.body).toMatchObject({ site: { slug: targetSlug, currentVersionId: committed.version_id }, version: { id: committed.version_id } });
    expect.soft(retry.status, `identical retry must replay: ${JSON.stringify(retry.body)}`).toBe(201);
    expect.soft(retry.body).toMatchObject({ replayed: true, site: { slug: targetSlug, currentVersionId: committed.version_id }, version: { id: committed.version_id } });
    expect(await tableCounts()).toEqual({ sites: before.sites + 1, versions: before.versions + 1, files: before.files + expected.length });

    // Neither isolate memory nor KV can mask a broken D1 fallback.
    clearLiveMemoryCache();
    expect(await env.CACHE.get(`live:${targetSlug}`)).toBeNull();
    await expectExactCopy(dw, targetSlug, source, expected);
    expect((await liveVersion(sourceSlug)).version_id).toBe(source.version_id);
  });

  it("copies exact manifest, content types, counts and served bytes without an injected fault", async () => {
    const dw = await freshInstance();
    await publish(dw, "race-control-source");
    const source = await liveVersion("race-control-source");
    const expected = await expectedManifest();
    expect(await manifest(source.version_id)).toEqual(expected);
    const before = await tableCounts();
    const result = await duplicate(dw, "race-control-source", "race-control-copy");
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const copy = await expectExactCopy(dw, "race-control-copy", source, expected);
    expect(result.body).toMatchObject({
      url: `${ORIGIN}/s/race-control-copy/`, site: { slug: "race-control-copy", currentVersionId: copy.version_id },
      version: { id: copy.version_id, fileCount: expected.length, totalBytes: source.total_bytes },
    });
    expect(await tableCounts()).toEqual({ sites: before.sites + 1, versions: before.versions + 1, files: before.files + expected.length });
  });
});
