import type { DropwayContext } from "../context";
import { blobKey } from "./blobs";

const DAY = 86_400_000;

/**
 * Retire metadata first, then delete only that generation's immutable key.
 * At most 201 binding calls for orphans plus 6 for reservations and the
 * inventory page (runCleanup's budget depends on these bounds).
 */
export async function cleanupBlobs(dc: DropwayContext, now: number): Promise<number> {
  const db = dc.env.DB;
  let deleted = 0;
  const { results: orphans } = await db.prepare(
    `SELECT b.sha256, b.storage_key FROM blobs b
     WHERE b.created_at < ? AND NOT EXISTS (SELECT 1 FROM version_files vf WHERE vf.sha256 = b.sha256)
     LIMIT 100`,
  ).bind(now - DAY).all<{ sha256: string; storage_key: string | null }>();
  for (const b of orphans) {
    const [del] = await db.batch([
      // Fence a stale cleaner's snapshot as well as newly established references.
      db.prepare(`DELETE FROM blobs WHERE sha256 = ? AND storage_key IS ?
        AND NOT EXISTS (SELECT 1 FROM version_files WHERE sha256 = ?)`)
        .bind(b.sha256, b.storage_key, b.sha256),
      db.prepare("DELETE FROM blob_scopes WHERE sha256 = ? AND NOT EXISTS (SELECT 1 FROM blobs WHERE sha256 = ?)")
        .bind(b.sha256, b.sha256),
    ]);
    if (del?.meta.changes) {
      await dc.env.FILES.delete(b.storage_key ?? blobKey(b.sha256));
      deleted++;
    }
  }

  // Failed/incomplete uploads must not accumulate D1 reservations forever.
  // A late R2.put can still finish, but cannot attach without its reservation;
  // the inventory sweep below will eventually see and reclaim its bytes.
  await db.prepare(`DELETE FROM blob_uploads WHERE storage_key IN (
    SELECT storage_key FROM blob_uploads WHERE created_at < ? ORDER BY created_at LIMIT 500
  )`).bind(now - DAY).run();

  // One bounded page per run, not just the first page: this also recovers R2
  // objects left by crashes between stores and failures after metadata retirement.
  const state = await db.prepare("SELECT cursor FROM blob_gc_cursor WHERE id = 1").first<{ cursor: string | null }>();
  const page = await dc.env.FILES.list({ prefix: "blobs/", limit: 100, cursor: state?.cursor ?? undefined });
  const keys = page.objects
    .filter((object) => object.uploaded.getTime() < now - DAY && /^blobs\/[a-f0-9]{64}(?:\/[^/]+)?$/.test(object.key))
    .map((object) => object.key);
  if (keys.length) {
    // 'blobs/' is 6 characters, so the hash starts at 7 and the blobs lookup stays on its key.
    const current = (key: string) => `EXISTS (SELECT 1 FROM blobs b WHERE b.sha256 = substr(${key}, 7, 64)
      AND COALESCE(b.storage_key, 'blobs/' || b.sha256) = ${key})`;
    const json = JSON.stringify(keys);
    const [, referenced] = await db.batch<{ key: string }>([
      // Atomic with the read: either an uploader attached before this batch,
      // or it loses its reservation and cannot attach after our delete decision.
      db.prepare(`DELETE FROM blob_uploads WHERE storage_key IN (SELECT value FROM json_each(?))
        AND NOT ${current("blob_uploads.storage_key")}`).bind(json),
      db.prepare(`SELECT value AS key FROM json_each(?) WHERE ${current("value")}`).bind(json),
    ]);
    const keep = new Set(referenced?.results.map((row) => row.key));
    const unreferenced = keys.filter((key) => !keep.has(key));
    if (unreferenced.length) await dc.env.FILES.delete(unreferenced);
  }
  await db.prepare("UPDATE blob_gc_cursor SET cursor = ? WHERE id = 1")
    .bind(page.truncated ? page.cursor : null).run();
  return deleted;
}
