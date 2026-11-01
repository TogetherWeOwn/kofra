import type { DropwayContext } from "../context";
import { dropLive } from "./live";
import { TRANSFER_DAY, transferEvent, type TransferRow } from "./transfers";

/** Expiry is independent of legal hold. Only manifest/byte purge is fenced. */
export async function cleanupTransfers(dc: DropwayContext, now: number) {
  const db = dc.env.DB;
  const { results: expired } = await db.prepare(`UPDATE transfers SET expired_at = ?, revision = revision + 1
    WHERE id IN (SELECT id FROM transfers WHERE expires_at < ? AND expired_at IS NULL AND revoked_at IS NULL AND deleted_at IS NULL LIMIT 200)
    AND expired_at IS NULL AND revoked_at IS NULL AND deleted_at IS NULL RETURNING *`).bind(now, now).all<TransferRow>();
  for (const t of expired) transferEvent(dc, t, "transfer.expired");
  const { results: candidates } = await db.prepare(`SELECT * FROM transfers WHERE purged_at IS NULL AND legal_hold = 0 AND takedown_at IS NULL
    AND (deleted_at < ? OR revoked_at < ? OR expires_at < ?) LIMIT 50`)
    .bind(now - TRANSFER_DAY, now - TRANSFER_DAY, now - TRANSFER_DAY).all<TransferRow>();
  let purgedTransfers = 0;
  for (const t of candidates) {
    // A D1 batch is one transaction. Every destructive statement checks the live fence.
    const fence = `EXISTS (SELECT 1 FROM transfers WHERE id = ? AND legal_hold = 0 AND takedown_at IS NULL AND purged_at IS NULL
      AND (deleted_at < ? OR revoked_at < ? OR expires_at < ?))`;
    const binds = [t.id, now - TRANSFER_DAY, now - TRANSFER_DAY, now - TRANSFER_DAY];
    const result = await db.batch([
      db.prepare(`DELETE FROM version_files WHERE version_id IN (SELECT id FROM versions WHERE site_id = ?) AND ${fence}`).bind(t.site_id, ...binds),
      db.prepare(`UPDATE sites SET current_version_id = NULL WHERE id = ? AND ${fence}`).bind(t.site_id, ...binds),
      db.prepare(`DELETE FROM versions WHERE site_id = ? AND ${fence}`).bind(t.site_id, ...binds),
      db.prepare(`UPDATE transfers SET purged_at = ? WHERE id = ? AND ${fence}`).bind(now, t.id, ...binds),
      db.prepare(`DELETE FROM sites WHERE id = ? AND deleted_at IS NOT NULL AND EXISTS
        (SELECT 1 FROM transfers WHERE id = ? AND purged_at = ? AND legal_hold = 0 AND takedown_at IS NULL)`).bind(t.site_id, t.id, now),
    ]);
    if (result[3]?.meta.changes) {
      await dropLive(dc, t.slug);
      purgedTransfers++;
    }
  }
  // Bounded like the other scheduled sweeps: a large stale backlog drains over successive invocations.
  const staleWindow = Math.floor(now / 900_000) - 1;
  await db.prepare("DELETE FROM transfer_unlock_buckets WHERE bucket IN (SELECT bucket FROM transfer_unlock_buckets WHERE window < ? LIMIT 500)")
    .bind(staleWindow).run();
  return { expiredTransfers: expired.length, purgedTransfers };
}
