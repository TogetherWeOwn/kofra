import type { DropwayContext } from "../context";
import { badRequest } from "../errors";

/**
 * Content-addressed file storage. Every file is stored once in R2 at
 * blobs/<sha256>; versions only reference hashes, so identical files across
 * versions and sites cost nothing extra.
 */
export const blobKey = (sha256: string) => `blobs/${sha256}`;

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Files above this size are streamed from R2 and never touch the Cache API. */
export const BLOB_CACHE_MAX_BYTES = 25 * 1024 * 1024;

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
 * Blobs over BLOB_CACHE_MAX_BYTES skip the cache in both directions. Whether the Cache API works
 * on *.workers.dev hostnames is recorded in docs/SELF_HOST.md.
 */
export async function readBlob(dc: DropwayContext, sha256: string, size: number): Promise<BlobBody | null> {
  const cache = typeof caches !== "undefined" && size <= BLOB_CACHE_MAX_BYTES ? caches.default : null;
  const key = edgeCacheKey(dc.requestUrl, sha256);
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit?.body) return { body: hit.body, size };
  }
  const obj = await dc.env.FILES.get(blobKey(sha256));
  if (!obj) return null;
  if (!cache || obj.size > BLOB_CACHE_MAX_BYTES) return { body: obj.body, size: obj.size };
  const [a, b] = obj.body.tee();
  dc.waitUntil(
    cache.put(key, new Response(b, { headers: { "Cache-Control": IMMUTABLE, "Content-Length": String(obj.size), ETag: `"${sha256}"` } })).catch(() => {}),
  );
  return { body: a, size: obj.size };
}

/** Read a byte range straight from R2 (Range requests: video, audio, large wasm). */
export async function readBlobRange(dc: DropwayContext, sha256: string, range: { offset: number; length: number }) {
  const obj = await dc.env.FILES.get(blobKey(sha256), { range });
  return obj ? obj.body : null;
}

export async function readBlobText(dc: DropwayContext, sha256: string, size: number): Promise<string | null> {
  const b = await readBlob(dc, sha256, size);
  if (!b) return null;
  return b.body ? new Response(b.body).text() : "";
}

/**
 * Write bytes to R2 at blobs/<sha256>, letting R2 verify the SHA-256 while it
 * streams in, then record the blob and the scope that proved it holds it.
 */
export async function putVerifiedBlob(
  dc: DropwayContext,
  scope: string,
  sha: string,
  body: ReadableStream | ArrayBuffer | Uint8Array,
  size: number,
  contentType: string | null,
): Promise<void> {
  await writeVerifiedBlob(dc, sha, body, size, contentType);
  const now = Date.now();
  await dc.env.DB.batch([
    dc.env.DB.prepare("INSERT OR IGNORE INTO blobs (sha256, size, created_at) VALUES (?, ?, ?)").bind(sha, size, now),
    dc.env.DB.prepare("INSERT OR IGNORE INTO blob_scopes (scope, sha256, created_at) VALUES (?, ?, ?)").bind(scope, sha, now),
  ]);
}

/** Storage only; multipart completion commits ownership against live D1 state. */
export async function writeVerifiedBlob(
  dc: DropwayContext,
  sha: string,
  body: ReadableStream | ArrayBuffer | Uint8Array,
  size: number,
  contentType: string | null,
): Promise<void> {
  try {
    let value: ReadableStream | ArrayBuffer | Uint8Array = body;
    if (body instanceof ReadableStream) {
      // R2 needs a known length for streams.
      const fixed = new FixedLengthStream(size);
      body.pipeTo(fixed.writable).catch(() => {});
      value = fixed.readable;
    }
    await dc.env.FILES.put(blobKey(sha), value, { sha256: sha, httpMetadata: contentType ? { contentType } : undefined });
  } catch (e) {
    const msg = String(e);
    if (/checksum|sha-?256|digest|match/i.test(msg)) {
      throw badRequest("hash_mismatch", "The uploaded bytes do not match the SHA-256 in the URL.", "Upload the exact file bytes; do not re-encode or compress them.");
    }
    if (/length|size|bytes/i.test(msg)) throw badRequest("size_mismatch", "The upload length does not match Content-Length.", "Send the raw file as the body.");
    throw e;
  }
}
