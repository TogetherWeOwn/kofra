import type { DropwayContext } from "../context";
import { blobKey } from "./blobs";

const DAY = 86_400_000;

/** Retire metadata first, then delete only that generation's immutable key. */
export async function cleanupBlobs(dc: DropwayContext, now: number): Promise<number> {
  const db = dc.env.DB;
  let deleted = 0;
  const { results: orphans } = await db.prepare(
    `SELECT b.sha256, b.storage_key FROM blobs b
     WHERE b.created_at < ? AND NOT EXISTS (SELECT 1 FROM version_files vf WHERE vf.sha256 = b.sha256)
     LIMIT 500`,
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
  for (const object of page.objects) {
    if (object.uploaded.getTime() >= now - DAY) continue;
    const sha = /^blobs\/([a-f0-9]{64})(?:\/[^/]+)?$/.exec(object.key)?.[1];
    if (!sha) continue;
    const current = `SELECT 1 FROM blobs WHERE sha256 = ? AND COALESCE(storage_key, 'blobs/' || sha256) = ?`;
    const [, referenced] = await db.batch([
      // Atomic with the read: either an uploader attached before this batch,
      // or it loses its reservation and cannot attach after our delete decision.
      db.prepare(`DELETE FROM blob_uploads WHERE storage_key = ? AND NOT EXISTS (${current})`)
        .bind(object.key, sha, object.key),
      db.prepare(current).bind(sha, object.key),
    ]);
    if (!referenced?.results.length) await dc.env.FILES.delete(object.key);
  }
  await db.prepare("UPDATE blob_gc_cursor SET cursor = ? WHERE id = 1")
    .bind(page.truncated ? page.cursor : null).run();
  return deleted;
}
