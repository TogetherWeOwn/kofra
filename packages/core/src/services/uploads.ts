import type { DropwayContext } from "../context";
import { appOrigin } from "../context";
import { canAccess, serializeVersion, type SiteRow, type VersionRow } from "./sites";
import { missingForScope } from "./deploys";
import { blobScope, putVerifiedBlob } from "./blobs";
import { createUploadToken, PENDING_VERSION_TTL_MS, uploadExpired } from "./upload-tokens";
import { hasScope, type Principal } from "../principal";
import { ApiError, badRequest, conflict, forbidden, isApiError, notFound, unauthorized } from "../errors";
import { newId, sha256Hex, SHA256_RE, toHex } from "../lib/crypto";
import { meter } from "./events";

/** One file a pending version still needs, with a ready-to-run upload request. */
export interface UploadItem {
  path: string;
  paths: string[];
  sha256: string;
  size: number;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  curl: string;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Fresh upload items for `missing` hashes of a pending version (new dwu_ token). */
export async function uploadItemsFor(dc: DropwayContext, version: VersionRow, entries: Array<{ path: string; sha256: string; size: number; contentType: string }>, missing: Iterable<string>): Promise<UploadItem[]> {
  const authorization = `Bearer ${await createUploadToken(dc, version)}`;
  const bySha = new Map<string, Array<{ path: string; size: number; contentType: string }>>();
  for (const e of entries) bySha.set(e.sha256, [...(bySha.get(e.sha256) ?? []), e]);
  const origin = appOrigin(dc);
  const items: UploadItem[] = [];
  for (const sha of missing) {
    const es = bySha.get(sha);
    if (!es?.length) continue;
    const url = `${origin}/api/v1/blobs/${sha}`;
    const ct = es[0]!.contentType;
    items.push({
      path: es[0]!.path,
      paths: es.map((e) => e.path),
      sha256: sha,
      size: es[0]!.size,
      method: "PUT",
      url,
      headers: { "Content-Type": ct, Authorization: authorization },
      curl: `curl -fsS -X PUT ${shellQuote(url)} -H ${shellQuote(`Authorization: ${authorization}`)} -H ${shellQuote(`Content-Type: ${ct}`)} --data-binary @${shellQuote(es[0]!.path)}`,
    });
  }
  return items;
}

/**
 * Status of one version for get_version: serialized version, missing hashes,
 * and — for writers only — fresh upload items for what is still missing.
 * Read-only principals never receive a dwu_ write capability here.
 */
export async function getVersionStatus(dc: DropwayContext, site: SiteRow, version: VersionRow, caller?: Principal) {
  let missing: string[] = [];
  let entries: Array<{ path: string; sha256: string; size: number; contentType: string }> = [];
  if (version.status === "pending") {
    const { results } = await dc.env.DB.prepare("SELECT path, sha256, size, content_type FROM version_files WHERE version_id = ? ORDER BY path")
      .bind(version.id)
      .all<{ path: string; sha256: string; size: number; content_type: string }>();
    entries = results.map((r) => ({ path: r.path, sha256: r.sha256, size: r.size, contentType: r.content_type }));
    missing = await missingForScope(dc, blobScope({ tenantId: site.tenant_id, siteId: site.id }), entries.map((e) => e.sha256));
  }
  const upload =
    missing.length && caller && canAccess(caller, site, "sites:write")
      ? {
          versionId: version.id,
          expiresAt: new Date(version.created_at + PENDING_VERSION_TTL_MS).toISOString(),
          items: await uploadItemsFor(dc, version, entries, missing),
        }
      : undefined;
  return {
    version: serializeVersion(version, site.current_version_id),
    missing,
    ...(upload ? { upload, uploads: upload.items } : {}),
  };
}

// ---------------------------------------------------------- resumable multipart

export const MULTIPART_MIN_PART_BYTES = 10 * 1024 * 1024;
export const MULTIPART_MAX_PART_BYTES = 95 * 1024 * 1024;
export const MULTIPART_DEFAULT_PART_BYTES = 50 * 1024 * 1024;
/** Owner-created sessions live at most a day; capability-created ones keep the capability's earlier expiry. */
export const MULTIPART_SESSION_TTL_MS = 24 * 3600_000;

export interface MultipartPartView {
  partNumber: number;
  size: number;
  etag: string;
}

export interface MultipartUploadView {
  id: string;
  versionId: string;
  sha256: string;
  size: number;
  partSize: number;
  parts: MultipartPartView[];
  status: string;
  expiresAt: string;
}

interface SessionRow {
  id: string;
  version_id: string;
  site_id: string;
  sha256: string;
  size: number;
  part_size: number;
  part_count: number;
  r2_key: string;
  r2_upload_id: string;
  status: "active" | "completing" | "completed" | "failed";
  staged: number;
  content_type: string | null;
  created_at: number;
  expires_at: number;
  completed_at: number | null;
}

interface PendingTarget {
  version: VersionRow;
  site: SiteRow;
  size: number;
  contentType: string;
  scope: string;
}

const partCountFor = (size: number, partSize: number) => (size === 0 ? 0 : Math.ceil(size / partSize));
const partSizeFor = (session: Pick<SessionRow, "size" | "part_size" | "part_count">, partNumber: number) =>
  partNumber < session.part_count ? session.part_size : session.size - session.part_size * (session.part_count - 1);

/**
 * Resolve the pending manifest file a multipart session may stage. Every
 * multipart operation runs this again, so a deleted site, a finalized
 * version, an expired anonymous site or an expired/false upload capability
 * stops the session at once. Foreign versions read as missing.
 */
async function pendingTarget(dc: DropwayContext, p: Principal, versionId: string, sha256: string): Promise<PendingTarget> {
  const now = Date.now();
  if (p.kind === "upload") {
    if (now >= p.expiresAt) throw uploadExpired();
    // A foreign session reads exactly like an unknown id: 403 here would let
    // an upload-only token probe which sessions exist. The message echoes no ids.
    if (p.versionId !== versionId) throw notFound("upload_not_found", "No upload session this upload token can access.", "Start one with POST /api/v1/uploads using this token's pending version.");
  } else if (p.kind !== "member" && p.kind !== "claim") {
    throw unauthorized("Resumable uploads need an API key, claim token or version-scoped upload token.");
  }
  const version = await dc.env.DB.prepare("SELECT * FROM versions WHERE id = ?").bind(versionId).first<VersionRow>();
  if (!version) throw notFound("version_not_found", `No version ${versionId}.`, "Publish with a sha256 source first to create a pending version.");
  const site = await dc.env.DB.prepare("SELECT * FROM sites WHERE id = ? AND deleted_at IS NULL").bind(version.site_id).first<SiteRow>();
  if (!site) throw notFound("version_not_found", `No version ${versionId}.`, "Publish with a sha256 source first to create a pending version.");
  if (p.kind === "upload") {
    if (p.expiresAt !== version.created_at + PENDING_VERSION_TTL_MS || version.created_at + PENDING_VERSION_TTL_MS <= now) throw uploadExpired();
  } else if (p.kind === "member") {
    if (site.tenant_id !== p.tenantId || (p.siteId && p.siteId !== site.id) || (site.mode === "transfer" && site.created_by !== p.memberId)) {
      throw notFound("version_not_found", `No version ${versionId} that this key can access.`, "List your sites with GET /api/v1/sites.");
    }
    if (!hasScope(p, "sites:write")) throw forbidden('This key lacks the "sites:write" scope.', "Use a key with that scope.", "insufficient_scope");
  } else if (p.kind === "claim") {
    if (site.id !== p.siteId || site.tenant_id !== null) throw notFound("version_not_found", `No version ${versionId} that this claim token can access.`);
  }
  if (version.status !== "pending") {
    throw conflict("upload_closed", "This version is no longer pending, so it accepts no uploads.", "Publish again to create a new pending version.");
  }
  if (site.expires_at && site.expires_at <= now) throw uploadExpired();
  const file = await dc.env.DB.prepare("SELECT size, content_type FROM version_files WHERE version_id = ? AND sha256 = ? LIMIT 1")
    .bind(version.id, sha256)
    .first<{ size: number; content_type: string }>();
  if (!file) {
    if (p.kind === "upload") throw forbidden("This upload token does not authorize that blob or pending version.", "Use this version's upload.items headers and only its listed sha256 values.");
    throw notFound("blob_not_expected", "No pending deploy you control lists a file with this SHA-256.", "Create a pending version first; stage only the sha256 values it reports as missing.");
  }
  return { version, site, size: file.size, contentType: file.content_type, scope: blobScope({ tenantId: site.tenant_id, siteId: site.id }) };
}

async function sessionParts(dc: DropwayContext, sessionId: string): Promise<Array<MultipartPartView & { sha256: string }>> {
  // Only acknowledged parts (a real R2 etag) resume or complete. Claimed
  // rows with an empty etag are in-flight uploads, not resumable state.
  const { results } = await dc.env.DB.prepare("SELECT part_number, size, etag, sha256 FROM upload_parts WHERE session_id = ? AND etag <> '' ORDER BY part_number")
    .bind(sessionId)
    .all<{ part_number: number; size: number; etag: string; sha256: string }>();
  return results.map((r) => ({ partNumber: r.part_number, size: r.size, etag: r.etag, sha256: r.sha256 }));
}

/** One part's claim row, acknowledged or still in flight, if any. */
async function sessionClaim(dc: DropwayContext, sessionId: string, partNumber: number): Promise<{ partNumber: number; size: number; etag: string; sha256: string } | null> {
  const row = await dc.env.DB.prepare("SELECT part_number, size, etag, sha256 FROM upload_parts WHERE session_id = ? AND part_number = ?")
    .bind(sessionId, partNumber)
    .first<{ part_number: number; size: number; etag: string; sha256: string }>();
  return row ? { partNumber: row.part_number, size: row.size, etag: row.etag, sha256: row.sha256 } : null;
}

/** True when R2 reports the multipart upload itself no longer exists (aborted/expired), as opposed to a failed part write. */
function isClosedMultipartUpload(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 10024 || code === "NoSuchUpload") return true;
  return /NoSuchUpload|specified multipart upload does not exist/.test(String((e as Error | null)?.message ?? e));
}

async function sessionView(dc: DropwayContext, session: SessionRow): Promise<MultipartUploadView> {
  const parts = (await sessionParts(dc, session.id)).map(({ sha256: _digest, ...part }) => part);
  return {
    id: session.id,
    versionId: session.version_id,
    sha256: session.sha256,
    size: session.size,
    partSize: session.part_size,
    parts,
    status: session.status,
    expiresAt: new Date(session.expires_at).toISOString(),
  };
}

async function loadSession(dc: DropwayContext, sessionId: string): Promise<SessionRow> {
  const session = await dc.env.DB.prepare("SELECT * FROM upload_sessions WHERE id = ?").bind(sessionId).first<SessionRow>();
  if (!session) throw notFound("upload_not_found", `No upload session ${sessionId}.`, "Start one with POST /api/v1/uploads.");
  return session;
}

/** Load a session and re-authorize its pending target and lifetime for this call. */
async function authorizedSession(dc: DropwayContext, p: Principal, sessionId: string): Promise<{ session: SessionRow; target: PendingTarget }> {
  const session = await loadSession(dc, sessionId);
  const target = await pendingTarget(dc, p, session.version_id, session.sha256);
  if (target.size !== session.size) throw conflict("upload_closed", "This upload session no longer matches its pending manifest file.", "Start a new upload session.");
  if (session.expires_at <= Date.now()) throw uploadExpired();
  return { session, target };
}

/** POST /api/v1/uploads: start a real R2 multipart upload bound to one pending manifest file. */
export async function createMultipartUpload(
  dc: DropwayContext,
  p: Principal,
  input: { versionId: unknown; sha256: unknown; partSize?: unknown },
): Promise<MultipartUploadView> {
  if (typeof input?.versionId !== "string" || !input.versionId) {
    throw badRequest("invalid_request", "versionId is required.", "Publish with a sha256 source first and pass the pending version id.", { fields: [{ path: "versionId", message: "is required" }] });
  }
  const sha256 = typeof input.sha256 === "string" ? input.sha256.toLowerCase() : "";
  if (!SHA256_RE.test(sha256)) throw badRequest("invalid_sha256", "sha256 must be 64 hex characters.", "Compute it with `sha256sum <file>` or `shasum -a 256 <file>`.");
  const partSize = input.partSize === undefined || input.partSize === null ? MULTIPART_DEFAULT_PART_BYTES : input.partSize;
  if (typeof partSize !== "number" || !Number.isInteger(partSize) || partSize < MULTIPART_MIN_PART_BYTES || partSize > MULTIPART_MAX_PART_BYTES) {
    throw badRequest("invalid_part", `partSize must be an integer between ${MULTIPART_MIN_PART_BYTES} and ${MULTIPART_MAX_PART_BYTES} bytes.`, "Omit partSize for the 50 MiB default or choose a size in that range.");
  }
  const target = await pendingTarget(dc, p, input.versionId, sha256);
  const now = Date.now();
  let expiresAt = now + MULTIPART_SESSION_TTL_MS;
  if (p.kind === "upload") expiresAt = Math.min(expiresAt, p.expiresAt);
  if (target.site.expires_at) expiresAt = Math.min(expiresAt, target.site.expires_at);
  const id = newId("upl");
  const key = `uploads/${id}`;
  const handle = await dc.env.FILES.createMultipartUpload(key);
  const session: SessionRow = {
    id,
    version_id: target.version.id,
    site_id: target.site.id,
    sha256,
    size: target.size,
    part_size: partSize,
    part_count: partCountFor(target.size, partSize),
    r2_key: handle.key,
    r2_upload_id: handle.uploadId,
    status: "active",
    staged: 0,
    content_type: target.contentType,
    created_at: now,
    expires_at: expiresAt,
    completed_at: null,
  };
  try {
    await dc.env.DB.prepare(
      `INSERT INTO upload_sessions (id, version_id, site_id, sha256, size, part_size, part_count, r2_key, r2_upload_id, status, staged, content_type, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
    ).bind(id, session.version_id, session.site_id, sha256, session.size, partSize, session.part_count, handle.key, handle.uploadId, target.contentType, now, expiresAt).run();
  } catch (e) {
    await handle.abort().catch(() => {});
    throw e;
  }
  return sessionView(dc, session);
}

/** GET /api/v1/uploads/{id}: the durable acknowledgement list a client resumes from. */
export async function getMultipartUpload(dc: DropwayContext, p: Principal, sessionId: string): Promise<MultipartUploadView> {
  const { session } = await authorizedSession(dc, p, sessionId);
  return sessionView(dc, session);
}

/** Read exactly `expected` body bytes; any other actual length is a size mismatch. */
async function readPartBody(body: ReadableStream | null, expected: number): Promise<Uint8Array> {
  const out = new Uint8Array(expected);
  if (!body) {
    if (expected === 0) return out;
    throw badRequest("size_mismatch", "The part upload has no body.", "Send the raw part bytes as the request body.");
  }
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > expected) {
        await reader.cancel().catch(() => {});
        throw badRequest("size_mismatch", `The part body is longer than the ${expected} bytes this part must hold.`, "Send exactly the bytes of this part.", { expected });
      }
      out.set(value, total);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== expected) {
    throw badRequest("size_mismatch", `The part body is ${total} bytes but this part must hold ${expected}.`, "Send exactly the bytes of this part.", { expected, received: total });
  }
  return out;
}

/** PUT /api/v1/uploads/{id}/parts/{n}: acknowledge one part's exact bytes. Identical retries replay; changed bytes are refused. */
export async function uploadMultipartPart(
  dc: DropwayContext,
  p: Principal,
  sessionId: string,
  partNumberInput: string,
  body: ReadableStream | null,
  contentLength: number | null,
): Promise<MultipartPartView> {
  const cancel = () => body?.cancel().catch(() => {});
  if (!/^[1-9]\d*$/.test(partNumberInput)) {
    await cancel();
    throw badRequest("invalid_part", "The part number in the URL must be a positive integer.", "Parts are numbered from 1; GET the upload session to see the acknowledged parts.");
  }
  const partNumber = Number(partNumberInput);
  let authorized: Awaited<ReturnType<typeof authorizedSession>>;
  try {
    authorized = await authorizedSession(dc, p, sessionId);
  } catch (e) {
    await cancel();
    throw e;
  }
  let { session } = authorized;
  if (session.status !== "active") {
    await cancel();
    throw conflict("upload_closed", "This upload session accepts no more parts.", "Start a new upload session for this pending version.");
  }
  if (partNumber > session.part_count) {
    await cancel();
    throw badRequest("invalid_part", `Part ${partNumber} is outside this file's ${session.part_count} expected part(s).`, "GET the upload session to see which parts it expects.");
  }
  const expected = partSizeFor(session, partNumber);
  if (contentLength === null || !Number.isFinite(contentLength)) {
    await cancel();
    throw new ApiError(411, "length_required", "Send a Content-Length header with the part upload.", "Upload the raw part bytes as the request body (no multipart, no chunked encoding).");
  }
  if (contentLength !== expected) {
    await cancel();
    throw badRequest("size_mismatch", `Part ${partNumber} must hold ${expected} bytes but the upload declares ${contentLength}.`, "Send exactly the bytes of this part.", { expected, received: contentLength });
  }
  const bytes = await readPartBody(body, expected);
  const digest = await sha256Hex(bytes);
  const existing = (await sessionParts(dc, session.id)).find((part) => part.partNumber === partNumber);
  if (existing) {
    if (existing.sha256 === digest) return { partNumber, size: expected, etag: existing.etag };
    throw conflict("part_conflict", `Part ${partNumber} was already acknowledged with different bytes.`, "Resume with the acknowledged bytes, or start a new upload session to change them.");
  }
  // The target or session may have closed while the part streamed in; check
  // again before any byte reaches R2, then claim the part before uploading,
  // so concurrent first PUTs cannot both mutate R2 and then disagree about
  // whose etag won. The claim row carries an empty etag until R2 confirms.
  session = (await authorizedSession(dc, p, sessionId)).session;
  if (session.status !== "active") throw conflict("upload_closed", "This upload session accepts no more parts.", "Start a new upload session for this pending version.");
  const now = Date.now();
  const claimed = await dc.env.DB.prepare(
    `INSERT OR IGNORE INTO upload_parts (session_id, part_number, size, etag, sha256, created_at)
     SELECT ?, ?, ?, '', ?, ? WHERE EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND status = 'active')`,
  ).bind(session.id, partNumber, expected, digest, now, session.id).run();
  if (!claimed.meta.changes) {
    const raced = await sessionClaim(dc, session.id, partNumber);
    if (raced?.etag && raced.sha256 === digest) return { partNumber, size: expected, etag: raced.etag };
    if (raced && !raced.etag && raced.sha256 === digest) {
      // An identical upload is still in flight; same bytes mean the same
      // R2 etag, so uploading again below converges instead of conflicting.
    } else if (raced) {
      // Another writer owns this part (acknowledged or still uploading):
      // refuse before R2 so the winner's bytes stay intact. Retryable: the
      // caller can resume with the acknowledged bytes once they land.
      throw new ApiError(409, "part_conflict", `Part ${partNumber} was already claimed with different bytes.`, "Resume with the acknowledged bytes, or start a new upload session to change them.", undefined, { retryable: true });
    } else {
      throw conflict("upload_closed", "This upload session accepts no more parts.", "Start a new upload session for this pending version.");
    }
  }
  let uploaded: { etag: string };
  try {
    uploaded = await dc.env.FILES.resumeMultipartUpload(session.r2_key, session.r2_upload_id).uploadPart(partNumber, bytes);
  } catch (e) {
    // The session may have been aborted after the final authority check
    // above. A closed R2 handle is a 409, never a 500; genuine storage
    // failures still propagate. The unacknowledged claim row stays out of
    // resume/complete views and dies with the session.
    if (!isApiError(e) && isClosedMultipartUpload(e)) {
      throw conflict("upload_closed", "This upload session was closed before the part reached storage.", "Start a new upload session for this pending version.");
    }
    throw e;
  }
  const acknowledged = await dc.env.DB.prepare("UPDATE upload_parts SET etag = ? WHERE session_id = ? AND part_number = ? AND etag = ''")
    .bind(uploaded.etag, session.id, partNumber).run();
  if (!acknowledged.meta.changes) {
    const raced = await sessionClaim(dc, session.id, partNumber);
    if (raced?.etag) return { partNumber, size: expected, etag: raced.etag };
    throw conflict("upload_closed", "This upload session accepts no more parts.", "Start a new upload session for this pending version.");
  }
  return { partNumber, size: expected, etag: uploaded.etag };
}

/** Streaming SHA-256 of the staged object, without holding its bytes in memory. */
async function hashStagedObject(dc: DropwayContext, key: string): Promise<{ hash: string; size: number }> {
  const obj = await dc.env.FILES.get(key);
  if (!obj) throw new ApiError(502, "blob_missing", "The completed upload's staged bytes could not be read.", "Retry shortly; if it repeats, start a new upload session.");
  if (typeof DigestStream === "function") {
    const digestStream = new DigestStream("SHA-256");
    await obj.body.pipeTo(digestStream);
    return { hash: toHex(await digestStream.digest), size: obj.size };
  }
  // Non-Workers fallback (types/tests only): the Workers runtime provides DigestStream.
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return { hash: await sha256Hex(bytes), size: obj.size };
}

async function markSession(dc: DropwayContext, sessionId: string, status: SessionRow["status"]): Promise<void> {
  await dc.env.DB.prepare("UPDATE upload_sessions SET status = ?, completed_at = ? WHERE id = ?")
    .bind(status, status === "completed" ? Date.now() : null, sessionId)
    .run();
}

/** POST /api/v1/uploads/{id}/complete: assemble, hash-verify, then promote to blobs/<sha256>. Safe to repeat. */
export async function completeMultipartUpload(dc: DropwayContext, p: Principal, sessionId: string): Promise<{ sha256: string; size: number; stored: true }> {
  const loaded = await authorizedSession(dc, p, sessionId);
  let { session } = loaded;
  const { target } = loaded;
  const done = { sha256: session.sha256, size: session.size, stored: true as const };
  if (session.status === "completed") return done;
  if (session.status === "failed") {
    throw badRequest("hash_mismatch", "The uploaded bytes do not match the SHA-256 in the manifest.", "Start a new upload session and upload the exact file bytes; do not re-encode or compress them.");
  }
  if (session.status === "active") {
    const parts = await sessionParts(dc, session.id);
    const missing: number[] = [];
    for (let n = 1; n <= session.part_count; n++) {
      const part = parts.find((part) => part.partNumber === n);
      if (!part || part.size !== partSizeFor(session, n)) missing.push(n);
    }
    if (missing.length) {
      throw conflict("upload_incomplete", `${missing.length} part(s) of this upload have not been acknowledged yet.`, "PUT each missing part, then call complete again.", { missingParts: missing });
    }
    const claimed = await dc.env.DB.prepare("UPDATE upload_sessions SET status = 'completing' WHERE id = ? AND status = 'active'").bind(session.id).run();
    if (!claimed.meta.changes) session = await loadSession(dc, session.id);
    else session = { ...session, status: "completing" };
    if (session.status === "completed") return done;
    if (session.status === "failed") throw badRequest("hash_mismatch", "The uploaded bytes do not match the SHA-256 in the manifest.", "Start a new upload session and upload the exact file bytes.");
  }

  // A previous attempt may have promoted the verified bytes and then lost
  // its response. The scope check keeps that shortcut owner-scoped: another
  // owner's identical blob never verifies this session's bytes.
  if ((await missingForScope(dc, target.scope, [session.sha256])).length === 0 && session.staged === 1) {
    await dc.env.FILES.delete(session.r2_key).catch(() => {});
    await markSession(dc, session.id, "completed");
    return done;
  }

  if (session.size === 0) {
    const emptyHash = await sha256Hex(new Uint8Array(0));
    await dc.env.FILES.resumeMultipartUpload(session.r2_key, session.r2_upload_id).abort().catch(() => {});
    if (session.sha256 !== emptyHash) {
      await markSession(dc, session.id, "failed");
      throw badRequest("hash_mismatch", "The uploaded bytes do not match the SHA-256 in the manifest.", "Start a new upload session and upload the exact file bytes.");
    }
    await putVerifiedBlob(dc, target.scope, session.sha256, new Uint8Array(0), 0, session.content_type);
    await markSession(dc, session.id, "completed");
    return done;
  }

  if (session.staged !== 1) {
    const parts = await sessionParts(dc, session.id);
    if (parts.length !== session.part_count) {
      throw conflict("upload_incomplete", "Parts of this upload have not been acknowledged yet.", "PUT each missing part, then call complete again.");
    }
    try {
      await dc.env.FILES.resumeMultipartUpload(session.r2_key, session.r2_upload_id).complete(parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })));
    } catch (e) {
      if (!(await dc.env.FILES.head(session.r2_key).catch(() => null))) throw e;
    }
    await dc.env.DB.prepare("UPDATE upload_sessions SET staged = 1 WHERE id = ?").bind(session.id).run();
    session = { ...session, staged: 1 };
  }

  const staged = await hashStagedObject(dc, session.r2_key);
  if (staged.size !== session.size || staged.hash !== session.sha256) {
    await dc.env.FILES.delete(session.r2_key).catch(() => {});
    await dc.env.DB.batch([
      dc.env.DB.prepare("UPDATE upload_sessions SET status = 'failed', staged = 0 WHERE id = ?").bind(session.id),
    ]);
    throw badRequest("hash_mismatch", "The uploaded bytes do not match the SHA-256 in the manifest.", "Start a new upload session and upload the exact file bytes; do not re-encode or compress them.");
  }
  const verified = await dc.env.FILES.get(session.r2_key);
  if (!verified) throw new ApiError(502, "blob_missing", "The completed upload's staged bytes could not be read.", "Retry shortly; if it repeats, start a new upload session.");
  await putVerifiedBlob(dc, target.scope, session.sha256, verified.body, session.size, session.content_type);
  meter(dc, { type: "blob_upload", tenantId: target.site.tenant_id, sha256: session.sha256, bytes: session.size, at: Date.now() });
  await dc.env.FILES.delete(session.r2_key);
  await markSession(dc, session.id, "completed");
  return done;
}

/**
 * Abort and drop at most 500 expired upload sessions (the cron's bounded
 * slice). Sessions that already completed only lose their session rows; the
 * R2 multipart handles of unfinished ones are aborted first.
 */
export async function cleanupExpiredMultipartUploads(dc: DropwayContext, now = Date.now()): Promise<number> {
  const { results } = await dc.env.DB.prepare("SELECT * FROM upload_sessions WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 500")
    .bind(now)
    .all<SessionRow>();
  let cleaned = 0;
  for (const session of results) {
    if (session.status === "active" || (session.status === "completing" && session.staged !== 1)) {
      try {
        await dc.env.FILES.resumeMultipartUpload(session.r2_key, session.r2_upload_id).abort();
      } catch {
        // The upload may have completed between the list and here; staged
        // bytes are deleted below either way.
        await dc.env.FILES.delete(session.r2_key).catch(() => {});
      }
    } else if (session.staged === 1) {
      await dc.env.FILES.delete(session.r2_key).catch(() => {});
    }
    const batch = await dc.env.DB.batch([
      dc.env.DB.prepare("DELETE FROM upload_parts WHERE session_id = ?").bind(session.id),
      dc.env.DB.prepare("DELETE FROM upload_sessions WHERE id = ? AND expires_at <= ?").bind(session.id, now),
    ]);
    if (batch[1]?.meta.changes) cleaned++;
  }
  return cleaned;
}
