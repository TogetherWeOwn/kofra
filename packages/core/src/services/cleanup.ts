import type { DropwayContext } from "../context";
import { siteUrl } from "../context";
import { blobKey } from "./blobs";
import { emit, meter } from "./events";
import { dropLive } from "./live";
import { convertRedirectsStatements, insertTombstone, purgeExpiredHolds } from "./slug-holds";
import { cleanupTransfers } from "./transfer-cleanup";
import { assertSiteDeletionState, siteDeletionStateChanged } from "./atomic-write";
import { cleanupExpiredMultipartUploads } from "./uploads";
import type { SiteRow } from "./sites";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface CleanupReport {
  expiredSites: number;
  expiredTransfers: number;
  purgedTransfers: number;
  purgedSites: number;
  abandonedDeploys: number;
  deletedBlobs: number;
  expiredUploads: number;
}

/**
 * Hourly housekeeping (Worker cron):
 * 1. expire anonymous sites past expires_at (soft delete, name tombstoned);
 * 2. purge rows of sites deleted more than an hour ago (tombstones survive);
 * 3. drop pending deploys older than a day;
 * 4. delete blobs no version references any more (older than a day);
 * 5. purge expired, unreleased name holds (released rows are the audit trail);
 * 6. purge expired idempotency records, oldest first.
 * Each step is bounded so one run stays well inside Worker limits.
 */
export async function runCleanup(dc: DropwayContext, now = Date.now()): Promise<CleanupReport> {
  const report: CleanupReport = { expiredSites: 0, purgedSites: 0, abandonedDeploys: 0, deletedBlobs: 0, expiredUploads: 0, ...await cleanupTransfers(dc, now) };
  const db = dc.env.DB;

  // 1. Expire anonymous sites.
  const { results: expired } = await db
    .prepare("SELECT * FROM sites WHERE mode = 'site' AND expires_at IS NOT NULL AND expires_at < ? AND deleted_at IS NULL LIMIT 200")
    .bind(now)
    .all<SiteRow>();
  for (const s of expired) {
    const holdUntil = now + (s.slug_chosen === 1 ? dc.config.slugHolds.chosenMs : dc.config.slugHolds.generatedMs);
    try {
      await db.batch([
        assertSiteDeletionState(dc, s),
        db
          .prepare("UPDATE sites SET deleted_at = ?, deleted_slug = slug, slug = ?, claim_token_hash = NULL WHERE id = ? AND deleted_at IS NULL")
          .bind(now, `~deleted~${s.id}`, s.id),
        insertTombstone(dc, { slug: s.slug, tenantId: s.tenant_id, siteId: s.id, chosen: s.slug_chosen === 1, holdUntil, reason: "expired", createdAt: now, deletedAt: now }),
        ...convertRedirectsStatements(dc, { siteId: s.id, tenantId: s.tenant_id, reason: "expired", now, deletedAt: now }),
      ]);
    } catch (error) {
      // A changed row is reconsidered from fresh state on the next cron run.
      if (siteDeletionStateChanged(error)) continue;
      throw error;
    }
    await dropLive(dc, s.slug);
    emit(dc, "onDelete", { site: { id: s.id, slug: s.slug, tenantId: s.tenant_id, url: siteUrl(dc, s.slug) }, principal: null, reason: "expired", at: now });
    meter(dc, { type: "site_deleted", tenantId: s.tenant_id, siteId: s.id, at: now });
    report.expiredSites++;
  }

  // 2. Purge deleted sites (rows only; their blobs become orphans for step 4,
  // their tombstones keep holding the names).
  const { results: gone } = await db
    .prepare("SELECT id FROM sites WHERE mode = 'site' AND deleted_at IS NOT NULL AND deleted_at < ? LIMIT 50")
    .bind(now - HOUR)
    .all<{ id: string }>();
  for (const s of gone) {
    await db.batch([
      db.prepare("DELETE FROM version_files WHERE version_id IN (SELECT id FROM versions WHERE site_id = ?)").bind(s.id),
      db.prepare("DELETE FROM versions WHERE site_id = ?").bind(s.id),
      db.prepare("DELETE FROM blob_scopes WHERE scope = ?").bind(`s:${s.id}`),
      // Defensive: deletes convert redirects to tombstones, so none should be left.
      db.prepare("DELETE FROM slug_redirects WHERE site_id = ?").bind(s.id),
      db.prepare("DELETE FROM sites WHERE id = ?").bind(s.id),
    ]);
    report.purgedSites++;
  }

  // 5. Expired holds.
  const purgedHolds = await purgeExpiredHolds(dc, now);

  // Expired resumable uploads: abort their R2 multipart uploads and drop the
  // session rows (at most 500 per run; staged bytes go with them).
  report.expiredUploads = await cleanupExpiredMultipartUploads(dc, now);

  // 3. Abandoned uploads. Transfer references belong to cleanupTransfers, even
  // before publication: its live retention fence and purge accounting must win.
  const abandoned = `status = 'pending' AND created_at < ?
    AND NOT EXISTS (SELECT 1 FROM transfers t WHERE t.site_id = versions.site_id)`;
  const { results: stale } = await db
    .prepare(`SELECT id FROM versions WHERE ${abandoned} LIMIT 200`)
    .bind(now - DAY)
    .all<{ id: string }>();
  for (const v of stale) {
    const result = await db.batch([
      db.prepare(`DELETE FROM version_files WHERE version_id = ?
        AND EXISTS (SELECT 1 FROM versions WHERE id = ? AND ${abandoned})`).bind(v.id, v.id, now - DAY),
      db.prepare(`DELETE FROM versions WHERE id = ? AND ${abandoned}`).bind(v.id, now - DAY),
    ]);
    if (result[1]?.meta.changes) report.abandonedDeploys++;
  }

  // 4. Unreferenced blobs. The row is deleted only if still unreferenced at that instant;
  // only then is the R2 object removed. (Known gap: a re-upload of the same bytes in the
  // milliseconds between those two steps would be lost; the next finalize reports it missing.)
  const { results: orphans } = await db
    .prepare(
      `SELECT b.sha256 FROM blobs b
        WHERE b.created_at < ? AND NOT EXISTS (SELECT 1 FROM version_files vf WHERE vf.sha256 = b.sha256)
        LIMIT 500`,
    )
    .bind(now - DAY)
    .all<{ sha256: string }>();
  for (const b of orphans) {
    const [del] = await db.batch([
      db.prepare("DELETE FROM blobs WHERE sha256 = ? AND NOT EXISTS (SELECT 1 FROM version_files WHERE sha256 = ?)").bind(b.sha256, b.sha256),
      db.prepare("DELETE FROM blob_scopes WHERE sha256 = ? AND NOT EXISTS (SELECT 1 FROM blobs WHERE sha256 = ?)").bind(b.sha256, b.sha256),
    ]);
    if (del?.meta.changes) {
      await dc.env.FILES.delete(blobKey(b.sha256));
      report.deletedBlobs++;
    }
  }
  // 6. One statement selects and deletes against current expiry, so a reclaimed
  // key cannot be removed using a stale snapshot of its previous owner.
  const purgedKeys = await db.prepare(
    `DELETE FROM idempotency_keys WHERE expires_at <= ? AND key_hash IN (
      SELECT key_hash FROM idempotency_keys WHERE expires_at <= ?
      ORDER BY expires_at, key_hash LIMIT 500
    )`,
  ).bind(now, now).run();
  const purgedIdempotencyKeys = Number(purgedKeys.meta.changes ?? 0);
  if (report.expiredSites || report.purgedSites || report.abandonedDeploys || report.deletedBlobs || report.expiredUploads || purgedHolds.tombstones || purgedHolds.redirects || purgedIdempotencyKeys) {
    console.log(JSON.stringify({ event: "cleanup", ...report, purgedHolds, purgedIdempotencyKeys }));
  }
  return report;
}
