/** Existing Worker contract behind the native CLI's direct version reads. */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { freshInstance, form, jsonBody, type Instance } from "./helpers";

let instance: Instance;
let firstId: string;
const SLUG = "explicit-version-history";
const BASE = `/api/v1/sites/${SLUG}`;
const NEWEST = "ver_fixture_601";
const PENDING = "ver_fixture_pending";
const MISSING_HASH = "f".repeat(64);

beforeEach(async () => {
  instance = await freshInstance();
  // Actual publish establishes valid blobs/ownership for the original manifest.
  const published = await instance.json("/api/v1/publish", {
    method: "POST", key: instance.ownerKey,
    body: form({ "index.html": "<p>original</p>", "docs/old note.txt": "old note" }, { slug: SLUG, message: "original release" }),
  });
  expect(published.status).toBe(201);
  firstId = published.body.version.id;
  const row = await env.DB.prepare("SELECT site_id, created_at FROM versions WHERE id = ?")
    .bind(firstId).first<{ site_id: string; created_at: number }>();
  if (!row) throw new Error("Disposable published version missing");
  // Seed immutable ready metadata, not 600 unnecessary uploads. The CLI's
  // list window must exclude the real published version at number 1.
  for (let start = 2; start <= 601; start += 50) {
    await env.DB.batch(Array.from({ length: Math.min(50, 602 - start) }, (_, offset) => {
      const number = start + offset;
      return env.DB.prepare(`INSERT INTO versions
        (id, site_id, number, status, file_count, total_bytes, manifest_hash, source, client, message, created_at, finalized_at)
        SELECT ?, site_id, ?, 'ready', file_count, total_bytes, manifest_hash, source, client, ?, ?, ?
        FROM versions WHERE id = ?`)
        .bind(number === 601 ? NEWEST : `ver_fixture_${number}`, number, `release ${number}`,
          row.created_at + number * 1000, row.created_at + number * 1000 + 1, firstId);
    }));
  }
  await env.DB.prepare("UPDATE sites SET current_version_id = ? WHERE id = ?").bind(NEWEST, row.site_id).run();
  await env.DB.prepare(`INSERT INTO version_files (version_id, path, sha256, size, content_type)
    SELECT ?, path, sha256, size, content_type FROM version_files WHERE version_id = ?`).bind(NEWEST, firstId).run();
  await env.DB.prepare(`INSERT INTO versions
    (id, site_id, number, status, file_count, total_bytes, manifest_hash, source, client, message, created_at)
    VALUES (?, ?, 602, 'pending', 1, 8, ?, 'api', 'acceptance/1', 'not finalized', ?)`)
    .bind(PENDING, row.site_id, "e".repeat(64), row.created_at + 602_000).run();
  await env.DB.prepare("INSERT INTO version_files (version_id, path, sha256, size, content_type) VALUES (?, 'pending.txt', ?, 8, 'text/plain')")
    .bind(PENDING, MISSING_HASH).run();
});

const read = (path: string) => instance.json(path, { key: instance.ownerKey });

describe("direct version REST prerequisites for native CLI inspection", () => {
  it("resolves old vN, N and opaque IDs even when a 500-row list excludes that version, then lists its files", async () => {
    const list = await read(`${BASE}/versions?limit=500`);
    expect(list.status).toBe(200);
    expect(list.body.versions).toHaveLength(500);
    expect(list.body.versions[0]).toMatchObject({ id: NEWEST, number: 601, live: true });
    expect(list.body.versions[499].number).toBe(102);
    expect(list.body.versions.some((version: { id: string }) => version.id === firstId)).toBe(false);
    expect(list.body.nextCursor).toBeUndefined();
    for (const ref of ["v1", "1", firstId]) {
      const result = await read(`${BASE}/versions/${encodeURIComponent(ref)}`);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ site: SLUG, missing: [], version: {
        id: firstId, number: 1, status: "ready", live: false, fileCount: 2,
        message: "original release", source: "publish", createdAt: expect.any(String), finalizedAt: expect.any(String),
      } });
      const listedFiles = await read(`${BASE}/files?version=${encodeURIComponent(result.body.version.id)}`);
      expect(listedFiles.status).toBe(200);
      expect(listedFiles.body.version).toMatchObject({ id: firstId, number: 1 });
      expect(listedFiles.body.files.map((file: { path: string }) => file.path)).toEqual(["docs/old note.txt", "index.html"]);
    }
  });

  it("resolves explicit live, vN, N and ID to canonical live metadata", async () => {
    for (const ref of ["live", "v601", "601", NEWEST]) {
      const result = await read(`${BASE}/versions/${ref}`);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ site: SLUG, missing: [], version: { id: NEWEST, number: 601, status: "ready", live: true } });
    }
  });

  it("returns pending metadata and missing manifest hashes without finalizing the upload", async () => {
    for (const ref of ["v602", "602", PENDING]) {
      const result = await read(`${BASE}/versions/${ref}`);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ site: SLUG, missing: [MISSING_HASH], version: {
        id: PENDING, number: 602, status: "pending", live: false, finalizedAt: null,
        fileCount: 1, totalBytes: 8, message: "not finalized", client: "acceptance/1",
      } });
    }
    const state = await env.DB.prepare("SELECT status FROM versions WHERE id = ?").bind(PENDING).first<{ status: string }>();
    expect(state?.status).toBe("pending");
    const current = await env.DB.prepare("SELECT current_version_id FROM sites WHERE slug = ?").bind(SLUG).first<{ current_version_id: string }>();
    expect(current?.current_version_id).toBe(NEWEST);
  });

  it("returns non-disclosing version_not_found for absent and different-site version IDs", async () => {
    const foreign = await instance.json("/api/v1/publish", {
      ...jsonBody({ slug: "foreign-version-site", files: [{ path: "index.html", content: "foreign metadata sentinel" }], message: "foreign metadata sentinel" }),
      key: instance.ownerKey,
    });
    expect(foreign.status).toBe(201);
    for (const ref of ["ver_definitely_absent", foreign.body.version.id]) {
      const result = await read(`${BASE}/versions/${ref}`);
      expect(result.status).toBe(404);
      expect(result.body.error.code).toBe("version_not_found");
      expect(result.body.error.hint).toEqual(expect.any(String));
      expect(result.body.error.hint.length).toBeGreaterThan(0);
      expect(result.body.version).toBeUndefined();
      expect(JSON.stringify(result.body)).not.toContain("foreign metadata sentinel");
      expect(JSON.stringify(result.body)).not.toContain(instance.ownerKey);
    }
  });
});
