import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { clearLiveMemoryCache, type PublishEvent, type UsageEvent } from "@dropway/core";
import { freshInstance, jsonBody, manifestEntry } from "./helpers";

/**
 * Protected Test Author acceptance: incorporate unchanged, implement elsewhere.
 * A successful same-tenant duplicate must not delete an administratively released
 * name's audit row. Removing the copy-batch released_at fence must fail this case.
 * Publication, deletion, release and duplication all use real disposable handlers.
 */
const SOURCE = "released-audit-source";
const TARGET = "released-audit-target";
const RELEASE_REASON = "Explicit administrative release for a new copy";
const FILES = [
  { path: "index.html", content: "<h1>Original source</h1>", contentType: "text/html; charset=utf-8" },
  { path: "docs/résumé.txt", content: "résumé\n", contentType: "text/plain; charset=utf-8" },
  { path: "empty.txt", content: "", contentType: "text/plain; charset=utf-8" },
];
type Row = Record<string, any>;

async function auditRows() {
  return (await env.DB.prepare("SELECT * FROM slug_tombstones WHERE slug = ? ORDER BY id")
    .bind(TARGET).all<Row>()).results;
}

async function graph() {
  return {
    sites: (await env.DB.prepare("SELECT * FROM sites ORDER BY id").all<Row>()).results,
    versions: (await env.DB.prepare("SELECT * FROM versions ORDER BY id").all<Row>()).results,
    files: (await env.DB.prepare("SELECT * FROM version_files ORDER BY version_id, path").all<Row>()).results,
    usage: (await env.DB.prepare("SELECT tenant_id, key, value FROM usage_counters ORDER BY tenant_id, key").all<Row>()).results,
  };
}

afterEach(() => { clearLiveMemoryCache(); });

describe("duplicate retains administratively released name audit history", () => {
  it("preserves the complete released row through a live same-tenant copy and same-key replay", async () => {
    const published: PublishEvent[] = [];
    const metered: UsageEvent[] = [];
    const dw = await freshInstance({}, {
      hooks: [{ onPublish(event) { published.push(event); } }],
      adapters: { metering: { record(event) { metered.push(event); } } },
    });
    const source = await dw.json("/api/v1/publish", {
      key: dw.ownerKey, ...jsonBody({ slug: SOURCE, files: FILES }),
    });
    expect(source.status, JSON.stringify(source.body)).toBe(201);
    const target = await dw.json("/api/v1/publish", {
      key: dw.ownerKey, ...jsonBody({ slug: TARGET, files: [
        { path: "former.txt", content: "Former holder, not the copied manifest", contentType: "text/plain" },
      ] }),
    });
    expect(target.status, JSON.stringify(target.body)).toBe(201);
    const beforeDelete = await graph();
    const sourceRow = beforeDelete.sites.find((s) => s.slug === SOURCE)!;
    const former = beforeDelete.sites.find((s) => s.slug === TARGET)!;
    expect(former.tenant_id).toBe(sourceRow.tenant_id);
    const deleted = await dw.json(`/api/v1/sites/${TARGET}`, { method: "DELETE", key: dw.ownerKey });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    const held = await auditRows();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      id: expect.any(String), slug: TARGET, site_id: former.id, tenant_id: sourceRow.tenant_id,
      reason: expect.any(String), created_at: expect.any(Number), hold_until: expect.any(Number),
      released_at: null, released_by: null, release_reason: null,
    });
    expect(held[0]!.reason.length).toBeGreaterThan(0);
    expect(held[0]!.hold_until).toBeGreaterThan(Date.now());
    const deletedFormer = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(former.id).first<Row>();
    expect(deletedFormer!.deleted_at).toEqual(expect.any(Number));

    const released = await dw.json("/api/v1/slugs/release", {
      key: dw.ownerKey, ...jsonBody({ slug: TARGET, reason: RELEASE_REASON, confirm: TARGET }),
    });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.released).toBe(true);
    const savedAudit = await auditRows();
    expect(savedAudit).toHaveLength(1);
    const { released_at, release_reason, released_by, ...savedIdentity } = savedAudit[0]!;
    const { released_at: _at, release_reason: _reason, released_by: _by, ...heldIdentity } = held[0]!;
    expect(savedIdentity).toEqual(heldIdentity);
    expect(released_at).toEqual(expect.any(Number));
    expect(released_at).toBeGreaterThanOrEqual(held[0]!.created_at);
    expect(release_reason).toBe(RELEASE_REASON);
    expect(released_by).toEqual(expect.any(String));
    expect(released_by.length).toBeGreaterThan(0);

    const beforeCopy = await graph();
    published.length = 0;
    metered.length = 0;
    const duplicate = () => dw.json(`/api/v1/sites/${SOURCE}/duplicate`, {
      key: dw.ownerKey, ...jsonBody({ newSlug: TARGET }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": "released-audit-copy-once" },
    });
    const first = await duplicate();
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(await auditRows(), "successful duplicate must retain the complete released audit row unchanged").toEqual(savedAudit);

    const copied = await graph();
    const copy = copied.sites.find((s) => s.slug === TARGET && s.deleted_at === null)!;
    expect(copy).toMatchObject({ tenant_id: sourceRow.tenant_id, current_version_id: first.body.version.id });
    expect(copy.id).not.toBe(sourceRow.id);
    expect(copy.id).not.toBe(former.id);
    expect(first.body.site).toMatchObject({ slug: TARGET, currentVersionId: copy.current_version_id });
    const version = copied.versions.find((v) => v.id === copy.current_version_id)!;
    expect(version.id).not.toBe(source.body.version.id);
    const entries = await Promise.all(FILES.map((file) => manifestEntry(file.path, file.content, file.contentType)));
    const expected = entries.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size, content_type: file.contentType }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    expect(version).toMatchObject({
      site_id: copy.id, number: 1, status: "ready", file_count: FILES.length,
      total_bytes: entries.reduce((sum, file) => sum + file.size, 0),
    });
    expect(copied.files.filter((file) => file.version_id === version.id)
      .map(({ path, sha256, size, content_type }) => ({ path, sha256, size, content_type }))).toEqual(expected);
    // Only the new destination's rows may differ, never the source or former holder.
    expect(copied.sites.filter((s) => s.id !== copy.id)).toEqual(beforeCopy.sites);
    expect(copied.versions.filter((v) => v.site_id !== copy.id)).toEqual(beforeCopy.versions);
    expect(copied.files.filter((file) => file.version_id !== version.id)).toEqual(beforeCopy.files);
    expect(copied.usage).toEqual(beforeCopy.usage.map((row) => ({ ...row,
      value: row.value + (row.tenant_id === sourceRow.tenant_id && row.key === "sites" ? 1 : 0),
    })));
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: "deploy", site: { id: copy.id, slug: TARGET } });
    expect(metered.filter((event) => event.type === "deploy")).toHaveLength(1);
    const eventsBeforeReplay = { published: [...published], metered: [...metered] };
    const replay = await duplicate();
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body).toMatchObject({
      replayed: true, site: { slug: TARGET, currentVersionId: version.id }, version: { id: version.id },
    });
    expect(await auditRows(), "same-key replay must retain the same row without an extra audit entry").toEqual(savedAudit);
    expect(await graph(), "replay must not create rows or alter source, destination or usage").toEqual(copied);
    expect({ published, metered }, "replay must not emit additional publish or metering events").toEqual(eventsBeforeReplay);

    clearLiveMemoryCache();
    for (const slug of [TARGET, SOURCE]) {
      const listed = await dw.json(`/api/v1/sites/${slug}/files`, { key: dw.ownerKey });
      expect(listed.status).toBe(200);
      expect(listed.body.files).toHaveLength(FILES.length);
      for (const file of FILES) {
        const entry = listed.body.files.find((item: Row) => item.path === file.path);
        expect(entry).toBeDefined();
        const served = await dw.call(entry.rawUrl, { key: dw.ownerKey });
        expect(served.status).toBe(200);
        expect(new Uint8Array(await served.arrayBuffer())).toEqual(new TextEncoder().encode(file.content));
      }
    }
  });
});
