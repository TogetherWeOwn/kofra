import type { DropwayContext } from "../context";
import { badRequest, conflict } from "../errors";

/** Legacy physical key. New uploads use a unique generation under this prefix. */
export const blobKey = (sha256: string) => `blobs/${sha256}`;

/** Resolve the verified generation, retaining existing pre-migration objects. */
export async function storedBlobKey(dc: DropwayContext, sha256: string): Promise<string | null> {
  const row = await dc.env.DB.prepare("SELECT storage_key FROM blobs WHERE sha256 = ?")
    .bind(sha256).first<{ storage_key: string | null }>();
  return row ? row.storage_key ?? blobKey(sha256) : null;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Scope that owns blobs for dedupe: the tenant, or the anonymous site itself. */
export function blobScope(owner: { tenantId: string | null; siteId: string }): string {
  return owner.tenantId ? `t:${owner.tenantId}` : `s:${owner.siteId}`;
}

function edgeCacheKey(requestUrl: URL | null, sha256: string): Request {
  // Blobs are immutable, so one edge-cache entry per sha256 serves every site on the zone.
  const host = requestUrl?.host ?? "dropway.invalid";
  return new Request(`https://${host}/__dropway/blob/${sha256}`);
}

export interface BlobBody {
  body: ReadableStream | null;
  size: number;
}

/**
 * Read a whole blob: Cache API first (edge, free), then R2; fills the cache in the background.
 * The Cache API is a no-op on *.workers.dev hostnames and starts working on custom domains.
 */
export async function readBlob(dc: DropwayContext, sha256: string, size: number): Promise<BlobBody | null> {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = edgeCacheKey(dc.requestUrl, sha256);
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit?.body) return { body: hit.body, size };
  }
  const storageKey = await storedBlobKey(dc, sha256);
  if (!storageKey) return null;
  const obj = await dc.env.FILES.get(storageKey);
  if (!obj) return null;
  if (!cache || obj.size > 50 * 1024 * 1024) return { body: obj.body, size: obj.size };
  const [a, b] = obj.body.tee();
  dc.waitUntil(
    cache.put(key, new Response(b, { headers: { "Cache-Control": IMMUTABLE, "Content-Length": String(obj.size), ETag: `"${sha256}"` } })).catch(() => {}),
  );
  return { body: a, size: obj.size };
}

/** Read a byte range straight from R2 (Range requests: video, audio, large wasm). */
export async function readBlobRange(dc: DropwayContext, sha256: string, range: { offset: number; length: number }) {
  const storageKey = await storedBlobKey(dc, sha256);
  if (!storageKey) return null;
  const obj = await dc.env.FILES.get(storageKey, { range });
  return obj ? obj.body : null;
}

export async function readBlobText(dc: DropwayContext, sha256: string, size: number): Promise<string | null> {
  const b = await readBlob(dc, sha256, size);
  if (!b) return null;
  return b.body ? new Response(b.body).text() : "";
}

/**
 * Verify bytes into a fresh physical generation, then atomically attach it (or
 * reuse the existing verified generation) and record the scope's proof. A
 * cleanup of an older generation can never delete this upload's bytes.
 */
export async function putVerifiedBlob(
  dc: DropwayContext,
  scope: string,
  sha: string,
  body: ReadableStream | ArrayBuffer | Uint8Array,
  size: number,
  contentType: string | null,
): Promise<void> {
  const storageKey = await writeVerifiedBlob(dc, sha, body, size, contentType);
  const db = dc.env.DB;
  const now = Date.now();
  const attach = attachStatements(dc, sha, size, storageKey, now);
  const result = await db.batch<{ storage_key: string | null }>([
    attach.insert,
    db.prepare(`INSERT OR IGNORE INTO blob_scopes (scope, sha256, created_at)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM blob_uploads WHERE storage_key = ?)
      AND EXISTS (SELECT 1 FROM blobs WHERE sha256 = ?)`)
      .bind(scope, sha, now, storageKey, sha),
    attach.select,
    attach.release,
  ]);
  await settleAttach(dc, storageKey, result[2]?.results[0]);
}

/**
 * Storage only: reserve a fresh generation and let R2 verify the SHA-256 while
 * it streams in. The caller attaches the returned key with attachStatements in
 * its own D1 batch (multipart completion fences that against live ownership).
 */
export async function writeVerifiedBlob(
  dc: DropwayContext,
  sha: string,
  body: ReadableStream | ArrayBuffer | Uint8Array,
  size: number,
  contentType: string | null,
): Promise<string> {
  const storageKey = `${blobKey(sha)}/${crypto.randomUUID()}`;
  const db = dc.env.DB;
  await db.prepare("INSERT INTO blob_uploads (storage_key, created_at) VALUES (?, ?)")
    .bind(storageKey, Date.now()).run();
  try {
    let value: ReadableStream | ArrayBuffer | Uint8Array = body;
    if (body instanceof ReadableStream) {
      // R2 needs a known length for streams.
      const fixed = new FixedLengthStream(size);
      body.pipeTo(fixed.writable).catch(() => {});
      value = fixed.readable;
    }
    await dc.env.FILES.put(storageKey, value, { sha256: sha, httpMetadata: contentType ? { contentType } : undefined });
  } catch (e) {
    // Invalid bytes must not accumulate reservations until the next daily GC.
    // If D1 itself is unavailable, the bounded reservation sweep is the fallback.
    await db.prepare("DELETE FROM blob_uploads WHERE storage_key = ?").bind(storageKey).run().catch(() => {});
    const msg = String(e);
    if (/checksum|sha-?256|digest|match/i.test(msg)) {
      throw badRequest("hash_mismatch", "The uploaded bytes do not match the SHA-256 in the URL.", "Upload the exact file bytes; do not re-encode or compress them.");
    }
    if (/length|size|bytes/i.test(msg)) throw badRequest("size_mismatch", "The upload length does not match Content-Length.", "Send the raw file as the body.");
    throw e;
  }
  return storageKey;
}

/**
 * Batch pieces that attach a reserved generation: `insert` before any scope
 * statement, then `select` (pass its row to settleAttach) and `release` last.
 * Without the reservation (GC retired it) nothing attaches.
 */
export function attachStatements(dc: DropwayContext, sha: string, size: number, storageKey: string, now: number) {
  const db = dc.env.DB;
  return {
    insert: db.prepare(`INSERT OR IGNORE INTO blobs (sha256, size, created_at, storage_key)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM blob_uploads WHERE storage_key = ?)`)
      .bind(sha, size, now, storageKey, storageKey),
    select: db.prepare(`SELECT storage_key FROM blobs WHERE sha256 = ?
      AND EXISTS (SELECT 1 FROM blob_uploads WHERE storage_key = ?)`)
      .bind(sha, storageKey),
    release: db.prepare("DELETE FROM blob_uploads WHERE storage_key = ?").bind(storageKey),
  };
}

/** Interpret attachStatements' `select` row once the batch has committed. */
export async function settleAttach(dc: DropwayContext, storageKey: string, stored: { storage_key: string | null } | undefined): Promise<void> {
  // A slow/crashed writer's reservation may have been retired by GC. It must
  // not attach bytes after GC decided to delete this physical key.
  if (!stored) {
    throw conflict("missing_blobs", "This upload expired while its bytes were being stored.", "Upload the bytes again, then finalize the deploy.");
  }
  if (stored.storage_key !== storageKey) {
    // Another verified writer won deduplication. A failed delete is recovered
    // by the bounded inventory sweep; do not turn a successful upload into 500.
    await dc.env.FILES.delete(storageKey).catch(() => {});
  }
}
