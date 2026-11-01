import type { Limits } from "../config";
import type { DropwayContext } from "../context";
import { appOrigin, siteFileUrl, siteUrl } from "../context";
import { ApiError, badRequest, conflict, notFound, tooLarge, unauthorized, forbidden } from "../errors";
import { PENDING_VERSION_TTL_MS, uploadExpired } from "./upload-tokens";
import { newId, sha256Hex, SHA256_RE } from "../lib/crypto";
import { extname, isTextual, normaliseContentType } from "../lib/mime";
import { encodePath, normaliseFilePath } from "../lib/paths";
import { findSecrets, lineAt } from "../lib/secrets";
import { detectFileKind } from "../lib/filetypes";
import { stringField } from "../lib/input";
import { hasScope, type Principal } from "../principal";
import { blobScope, putVerifiedBlob } from "./blobs";
import { emit, meter } from "./events";
import { refreshLive } from "./live";
import { createSite, discardNewSite, getSiteFor, getVersion, serializeVersion, type SiteRow, type SiteSettingsInput, type VersionRow } from "./sites";
import { requireQuota, quotaExceeded } from "./policy";
import { getUsage, incrementalBytes, PROJECTED_STORAGE_SQL, usageStatements } from "./usage";

/** One entry of a deploy manifest as sent by clients. */
export interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
  contentType?: string | null;
}

export interface NormalisedEntry {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
}

export interface Warning {
  code: string;
  message: string;
  /** File the warning is about, when it concerns one file. */
  path?: string;
  /** 1-based line inside `path`, when the exact location is known. */
  line?: number;
  /** What to change so the warning goes away. */
  fix?: string;
}

export interface DeployOptions {
  /** Internal first-version path; never parsed from an HTTP input. */
  transferCreate?: boolean;
  message?: unknown;
  /** How the version was made: "api", "publish", "zip", "restore"... */
  source?: string;
  /** Client attribution, from the X-Kofra-Client header (e.g. "claude-code/1.0"). */
  client?: string | null;
  /** Optimistic concurrency: fail with 409 version_conflict if the live version is no longer this one. */
  baseVersionId?: unknown;
}

/** Validate metadata before a transport applies settings or a service starts a deploy. */
export function parseDeployOptions(opts: DeployOptions = {}) {
  return {
    ...opts,
    baseVersionId: opts.baseVersionId == null || opts.baseVersionId === "" ? null : stringField(opts.baseVersionId, "baseVersionId"),
    message: opts.message == null ? null : stringField(opts.message, "message").slice(0, 500),
  };
}

/** Validate and normalise a manifest against size/count limits. */
export function validateManifest(files: unknown, lim: Limits): { entries: NormalisedEntry[]; totalBytes: number } {
  if (!Array.isArray(files) || files.length === 0) {
    throw badRequest("files_required", "files must be a non-empty array.", 'Send {"files":[{"path":"index.html","size":123,"sha256":"<hex>","contentType":"text/html"}]}.');
  }
  if (files.length > lim.maxFiles) {
    throw badRequest("too_many_files", `A version can have at most ${lim.maxFiles} files.`, "Split the content across several sites or trim build output (source maps, duplicates). Never drop files silently.", {
      limit: lim.maxFiles,
      received: files.length,
    });
  }
  const seen = new Set<string>();
  const sizes = new Map<string, number>();
  const entries: NormalisedEntry[] = [];
  let totalBytes = 0;
  let firstError: ApiError | undefined;
  const fields: Array<{ path: string; message: string }> = [];
  const invalid = (error: ApiError, path: string) => {
    firstError ??= error;
    fields.push({ path, message: error.message });
  };
  files.forEach((raw, i) => {
    const f = raw as Partial<ManifestEntry>;
    const field = `files.${i}`;
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      invalid(badRequest("invalid_manifest", "Each file must be an object with path, size and sha256."), field);
      return;
    }
    let path = "";
    try {
      path = String(f.path ?? "");
      path = normaliseFilePath(path);
      if (seen.has(path)) invalid(badRequest("duplicate_path", `The path "${path}" appears more than once.`), `${field}.path`);
      // __dropway/ is the server's own namespace inside a site (password form, report link).
      if (path === "__dropway" || path.startsWith("__dropway/")) {
        invalid(badRequest("reserved_path", `Paths under __dropway/ are reserved for the server ("${path}").`, "Rename the folder, for example to _dropway/ or assets/."), `${field}.path`);
      }
      seen.add(path);
    } catch (error) {
      invalid(error instanceof ApiError ? error : badRequest("invalid_path", "File path must be a string."), `${field}.path`);
    }
    // JSON objects can shadow toString/valueOf. A failed coercion is still a
    // client field error, and must not discard errors collected from siblings.
    let size = NaN;
    try { size = Number(f.size); } catch { /* validated below */ }
    if (!Number.isInteger(size) || size < 0) {
      invalid(badRequest("invalid_size", `size for "${path}" must be a non-negative integer (bytes).`), `${field}.size`);
    } else if (size > lim.maxFileBytes) {
      invalid(tooLarge("file_too_large", `"${path}" is ${size} bytes; the per-file limit is ${lim.maxFileBytes}.`, "Compress or split the file.", { path, size, limit: lim.maxFileBytes }), `${field}.size`);
    }
    let sha256 = "";
    try { sha256 = String(f.sha256 ?? "").toLowerCase(); } catch { /* validated below */ }
    if (!SHA256_RE.test(sha256)) invalid(badRequest("invalid_sha256", `sha256 for "${path}" must be 64 hex characters.`, "Compute it with `sha256sum <file>` or `shasum -a 256 <file>`."), `${field}.sha256`);
    if (f.contentType != null && typeof f.contentType !== "string") {
      invalid(badRequest("invalid_manifest", `contentType for "${path}" must be a string or null.`, "Send a MIME type string, null, or omit contentType to infer it from the path."), `${field}.contentType`);
    } else {
      entries.push({ path, size, sha256, contentType: normaliseContentType(f.contentType, path) });
    }
    // Same-hash entries must agree on size. Only valid rows enter the map,
    // mirroring the pre-collector throw-before-record order as a field error.
    if (SHA256_RE.test(sha256) && Number.isInteger(size) && size >= 0) {
      if (sizes.has(sha256) && sizes.get(sha256) !== size) invalid(badRequest("size_mismatch", `Files with the same SHA-256 must declare the same size.`, "Use the actual file byte length for every occurrence of a hash."), `${field}.size`);
      sizes.set(sha256, size);
    }
    totalBytes += size;
  });
  if (firstError) {
    throw Object.assign(firstError, { details: { ...firstError.details, fields } });
  }
  if (totalBytes > lim.maxSiteBytes) {
    throw tooLarge("site_too_large", `This version is ${totalBytes} bytes; the limit is ${lim.maxSiteBytes}.`, "Split the content across several sites.", {
      totalBytes,
      limit: lim.maxSiteBytes,
    });
  }
  return { entries, totalBytes };
}

/** Stable digest of a manifest, used to detect byte-identical republishes. */
export async function manifestHash(entries: NormalisedEntry[]): Promise<string> {
  const lines = entries.map((e) => `${e.path}\u0000${e.sha256}\u0000${e.contentType}`).sort();
  return sha256Hex(lines.join("\n"));
}

/** Split values into JSON arrays of at most ~maxBytes each (D1 caps a bound value at 2 MB). */
function jsonChunks<T>(items: T[], maxBytes = 800_000): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 2;
  for (const item of items) {
    const s = JSON.stringify(item);
    if (cur.length && size + s.length + 1 > maxBytes) {
      out.push(`[${cur.join(",")}]`);
      cur = [];
      size = 2;
    }
    cur.push(s);
    size += s.length + 1;
  }
  if (cur.length) out.push(`[${cur.join(",")}]`);
  return out;
}

/** sha256 values from `shas` that the given scope has not yet proven it holds. */
export async function missingForScope(dc: DropwayContext, scope: string, shas: string[]): Promise<string[]> {
  const unique = [...new Set(shas)];
  if (!unique.length) return [];
  const present = new Set<string>();
  const stmts = jsonChunks(unique).map((json) =>
    dc.env.DB.prepare(
      `SELECT bs.sha256 FROM blob_scopes bs JOIN blobs b ON b.sha256 = bs.sha256
        WHERE bs.scope = ? AND bs.sha256 IN (SELECT value FROM json_each(?))`,
    ).bind(scope, json),
  );
  const results = await dc.env.DB.batch<{ sha256: string }>(stmts);
  for (const r of results) for (const row of r.results) present.add(row.sha256);
  return unique.filter((s) => !present.has(s));
}

/** Only compare verified bytes this owner has proven it holds; never reveal another tenant's blob. */
async function validateStoredSizes(dc: DropwayContext, site: SiteRow, entries: NormalisedEntry[]): Promise<void> {
  const scope = blobScope(siteOwner(site));
  for (const json of jsonChunks(entries.map((e) => [e.path, e.sha256, e.size]))) {
    const mismatch = await dc.env.DB.prepare(`SELECT json_extract(j.value, '$[0]') AS path, b.size AS expected,
        json_extract(j.value, '$[2]') AS received FROM json_each(?) j
      JOIN blob_scopes bs ON bs.sha256 = json_extract(j.value, '$[1]') AND bs.scope = ?
      JOIN blobs b ON b.sha256 = bs.sha256
     WHERE b.size != json_extract(j.value, '$[2]') LIMIT 1`).bind(json, scope).first<{ path: string; expected: number; received: number }>();
    if (mismatch) throw badRequest("size_mismatch", `The declared size of "${mismatch.path}" differs from its verified bytes.`, "Use the actual file byte length from its stored manifest.", mismatch);
  }
}

function siteOwner(site: SiteRow) {
  return { siteId: site.id, tenantId: site.tenant_id };
}

/**
 * Start a deploy: record a pending version with its full manifest and report
 * which files still need uploading. Files this owner already stored are reused.
 * A byte-identical manifest returns { unchanged: true } and records nothing.
 */
export async function createDeploy(dc: DropwayContext, p: Principal, site: SiteRow, files: unknown, opts: DeployOptions = {}) {
  site = await getSiteFor(dc, p, site.slug, "sites:write");
  if (site.mode === "transfer" && !opts.transferCreate) throw conflict("transfer_immutable", "Transfer files cannot be replaced.", "Create a new transfer instead.");
  const owner = siteOwner(site);
  const lim = await dc.adapters.policy.limits(p, owner, dc);
  const { entries, totalBytes } = validateManifest(files, lim);
  // Validate client metadata before any storage or policy work, so a
  // malformed baseVersionId/message fails closed without side effects.
  const { baseVersionId, message } = parseDeployOptions(opts);
  await validateStoredSizes(dc, site, entries);
  const newBytes = site.mode === "transfer" ? 0 : await incrementalBytes(dc, site.tenant_id, site.id, entries);
  await dc.adapters.policy.beforeDeploy?.(p, { siteId: site.id, tenantId: site.tenant_id, fileCount: entries.length, totalBytes, newBytes }, dc);

  if (baseVersionId && baseVersionId !== site.current_version_id) throw await versionConflict(dc, site);

  const hash = await manifestHash(entries);
  const origin = appOrigin(dc);
  const versionLinks = { versions: `${origin}/api/v1/sites/${site.slug}/versions`, deploys: `${origin}/api/v1/sites/${site.slug}/deploys` };
  if (site.current_version_id) {
    const current = await getVersion(dc, site.id, site.current_version_id);
    if (current && current.manifest_hash === hash) {
      const serialized = { ...serializeVersion(current, site.current_version_id), siteSlug: site.slug };
      return {
        unchanged: true,
        deploy: serialized,
        version: serialized,
        missing: [] as string[],
        uploads: [] as Array<Record<string, unknown>>,
        finalizeUrl: null,
        links: versionLinks,
        next: "Nothing changed: the live version already has exactly these files. No new version was created.",
      };
    }
  }

  await requireQuota(dc, p, "storage_bytes", owner, (await getUsage(dc, site.tenant_id)).storage_bytes, newBytes);

  const now = Date.now();
  const version: VersionRow = {
    id: newId("ver"),
    site_id: site.id,
    number: 0,
    status: "pending",
    file_count: entries.length,
    total_bytes: totalBytes,
    manifest_hash: hash,
    base_version_id: baseVersionId,
    source: opts.source ?? "api",
    client: opts.client ? String(opts.client).slice(0, 120) : null,
    message,
    created_by: p.kind === "member" ? p.memberId : p.kind,
    created_at: now,
    finalized_at: null,
  };
  const stmts: D1PreparedStatement[] = [
    dc.env.DB.prepare(
      `INSERT INTO versions (id, site_id, number, status, file_count, total_bytes, manifest_hash, base_version_id, source, client, message, created_by, created_at)
       VALUES (?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM versions WHERE site_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      version.id, site.id, site.id, version.status, version.file_count, version.total_bytes, version.manifest_hash,
      version.base_version_id, version.source, version.client, version.message, version.created_by, version.created_at,
    ),
  ];
  // One statement per ~800 KB of manifest, whatever the file count (D1 limits bound parameters, not value size).
  for (const json of jsonChunks(entries.map((e) => [e.path, e.sha256, e.size, e.contentType]))) {
    stmts.push(
      dc.env.DB.prepare(
        `INSERT INTO version_files (version_id, path, sha256, size, content_type)
         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
           FROM json_each(?)`,
      ).bind(version.id, json),
    );
  }
  await dc.env.DB.batch(stmts);
  const numbered = await dc.env.DB.prepare("SELECT number FROM versions WHERE id = ?").bind(version.id).first<{ number: number }>();
  version.number = numbered?.number ?? 1;

  // Check presence only after the manifest rows exist, so cleanup never deletes a blob we are about to reuse.
  const missing = await missingForScope(dc, blobScope(siteOwner(site)), entries.map((e) => e.sha256));
  const bySha = new Map<string, NormalisedEntry[]>();
  for (const e of entries) bySha.set(e.sha256, [...(bySha.get(e.sha256) ?? []), e]);
  const base = `${origin}/api/v1/sites/${site.slug}/versions/${version.id}`;
  const serialized = { ...serializeVersion(version, site.current_version_id), siteSlug: site.slug };
  return {
    unchanged: false,
    deploy: serialized,
    version: serialized,
    links: versionLinks,
    missing,
    uploads: missing.map((sha) => {
      const es = bySha.get(sha)!;
      return {
        sha256: sha,
        size: es[0]!.size,
        paths: es.map((e) => e.path),
        method: "PUT",
        url: `${origin}/api/v1/blobs/${sha}`,
        headers: { "Content-Type": es[0]!.contentType },
      };
    }),
    finalizeUrl: `${base}/finalize`,
    next:
      missing.length === 0
        ? `All files are already stored. POST ${base}/finalize to go live.`
        : `PUT the raw bytes of each of the ${missing.length} missing files to its upload url (same Authorization header), then POST ${base}/finalize.`,
  };
}

/** Check a manifest against the caps for a site that does not exist yet (throws the same errors as createDeploy). */
export async function precheckManifest(dc: DropwayContext, p: Principal, tenantId: string | null, files: unknown): Promise<void> {
  validateManifest(files, await dc.adapters.policy.limits(p, { siteId: null, tenantId }, dc));
}

/**
 * Create a site and, when `files` is given, start its first deploy (POST /api/v1/sites).
 * The manifest is checked before the site row exists, and if the deploy is still
 * refused (for example by a policy adapter) the new site is removed again, so a
 * failed call never leaves an empty site, a taken slug or a used rate-limit slot.
 */
export async function createSiteWithDeploy(
  dc: DropwayContext,
  p: Principal,
  input: { slug?: string | null } & SiteSettingsInput,
  files: unknown,
  opts: DeployOptions = {},
) {
  const withFiles = files !== undefined;
  if (withFiles) opts = parseDeployOptions(opts);
  const { site, claimToken } = await createSite(dc, p, input, {
    beforeInsert: withFiles ? (owner) => precheckManifest(dc, p, owner.tenantId, files) : undefined,
  });
  if (!withFiles) return { site, claimToken, deploy: null };
  // A new anonymous site is deployed with its own claim token from here on.
  const deployer: Principal = claimToken ? { kind: "claim", siteId: site.id, ip: p.ip } : p;
  try {
    return { site, claimToken, deploy: await createDeploy(dc, deployer, site, files, opts) };
  } catch (e) {
    await discardNewSite(dc, site);
    throw e;
  }
}

/** Read live metadata together, still bound to the authorized site's ownership snapshot. */
export async function versionConflict(dc: DropwayContext, site: SiteRow, base?: VersionRow, hint?: string): Promise<ApiError> {
  const live = await dc.env.DB.prepare(
    `SELECT s.current_version_id AS id, v.number, v.client, v.finalized_at
       FROM sites s LEFT JOIN versions v ON v.id = s.current_version_id AND v.site_id = s.id
      WHERE s.id = ? AND s.tenant_id IS ? AND s.deleted_at IS NULL`,
  ).bind(site.id, site.tenant_id).first<{ id: string | null; number: number | null; client: string | null; finalized_at: number | null }>();
  if (!live) {
    return notFound("site_not_found", `No site "${site.slug}" that this key can access.`, "List your sites with GET /api/v1/sites.");
  }
  return new ApiError(
    409,
    "version_conflict",
    `The live version is ${live?.number != null ? `v${live.number}` : "none"}; someone published since your base version.`,
    hint ?? "Call get_site to see what changed, re-apply your change, and pass the live version id as baseVersionId.",
    {
      liveVersionId: live?.id ?? null,
      liveVersionNumber: live?.number ?? null,
      liveVersionClient: live?.client ?? null,
      liveVersionAt: live?.finalized_at ?? null,
      ...(base ? { yourBase: base.id, yourBaseNumber: base.number, liveClient: live?.client ?? null } : {}),
    },
    { next: [{ tool: "get_site", args: { site: site.slug }, why: "Read the live version before re-applying your change." }] },
  );
}

/** Store a blob uploaded by a client. R2 verifies the SHA-256 while it streams in. */
export async function uploadBlob(
  dc: DropwayContext,
  p: Principal,
  shaInput: string,
  body: ReadableStream | null,
  contentLength: number | null,
  contentType: string | null,
) {
  const cancel = () => body?.cancel().catch(() => {});
  if (p.kind !== "member" && p.kind !== "claim" && p.kind !== "upload") {
    await cancel();
    throw unauthorized("Uploads need an API key, claim token or version-scoped upload token.");
  }
  if (p.kind === "member" && !hasScope(p, "sites:write")) {
    await cancel();
    throw forbidden('This key lacks the "sites:write" scope.', undefined, "insufficient_scope");
  }
  const sha = shaInput.toLowerCase();
  if (!SHA256_RE.test(sha)) {
    await cancel();
    throw badRequest("invalid_sha256", "The URL must end in the file's 64-character hex SHA-256.");
  }
  let sql = `SELECT vf.size, s.id AS site_id, s.tenant_id FROM version_files vf
               JOIN versions v ON v.id = vf.version_id
               JOIN sites s ON s.id = v.site_id
              WHERE vf.sha256 = ? AND v.status = 'pending' AND s.deleted_at IS NULL`;
  const binds: unknown[] = [sha];
  if (p.kind === "upload") {
    if (Date.now() >= p.expiresAt) { await cancel(); throw uploadExpired(); }
    sql += " AND v.id = ? AND v.created_at + ? = ? AND v.created_at + ? > ? AND (s.expires_at IS NULL OR s.expires_at > ?)";
    binds.push(p.versionId, PENDING_VERSION_TTL_MS, p.expiresAt, PENDING_VERSION_TTL_MS, Date.now(), Date.now());
  } else if (p.kind === "member") {
    sql += " AND s.tenant_id = ?";
    binds.push(p.tenantId);
    if (p.siteId) {
      sql += " AND s.id = ?";
      binds.push(p.siteId);
    }
  } else {
    sql += " AND s.id = ? AND s.tenant_id IS NULL";
    binds.push(p.siteId);
  }
  const expected = await dc.env.DB.prepare(sql + " LIMIT 1").bind(...binds).first<{ size: number; site_id: string; tenant_id: string | null }>();
  if (!expected) {
    await cancel();
    if (p.kind === "upload") throw forbidden("This upload token does not authorize that blob or pending version.", "Use this version's upload.items headers and URL.");
    throw notFound(
      "blob_not_expected",
      "No pending deploy you control lists a file with this SHA-256.",
      "Create a version with POST /api/v1/sites/:slug/versions first (alias: /deploys); upload only the sha256 values it returns as missing.",
    );
  }
  const scope = blobScope({ tenantId: expected.tenant_id, siteId: expected.site_id });
  const already = (await missingForScope(dc, scope, [sha])).length === 0;
  if (already) {
    await cancel();
    return { sha256: sha, size: expected.size, stored: true, existed: true };
  }
  if (contentLength === null || !Number.isFinite(contentLength)) {
    await cancel();
    throw new ApiError(411, "length_required", "Send a Content-Length header with the upload.", "Upload the raw file bytes as the request body (no multipart, no chunked encoding).");
  }
  if (contentLength !== expected.size) {
    await cancel();
    throw badRequest("size_mismatch", `The deploy declared ${expected.size} bytes for this file but the upload is ${contentLength} bytes.`, "Re-check the file and its size in the manifest.", {
      expected: expected.size,
      received: contentLength,
    });
  }
  await putVerifiedBlob(dc, scope, sha, body ?? new Uint8Array(0), expected.size, contentType);
  meter(dc, { type: "blob_upload", tenantId: expected.tenant_id, sha256: sha, bytes: expected.size, at: Date.now() });
  return { sha256: sha, size: expected.size, stored: true, existed: false };
}

/** Atomically make a pending version live. Retrying a finished finalize is safe. */
export async function finalizeDeploy(dc: DropwayContext, p: Principal, site: SiteRow, versionId: string, transferCreate = false) {
  site = await getSiteFor(dc, p, site.slug, "sites:write");
  if (site.mode === "transfer" && !transferCreate) throw conflict("transfer_immutable", "Transfer files cannot be replaced.", "Create a new transfer instead.");
  const version = await getVersion(dc, site.id, versionId);
  if (!version) throw notFound("deploy_not_found", `No version ${versionId} on site ${site.slug}.`, "Start one with POST /api/v1/sites/:slug/versions (alias: /deploys).");
  if (version.status === "ready") {
    return { version, replayed: true, live: version.id === site.current_version_id, warnings: await deployWarnings(dc, site, version.id) };
  }
  const scope = blobScope(siteOwner(site));
  const missingPredicate = `FROM version_files vf
       LEFT JOIN blob_scopes bs ON bs.sha256 = vf.sha256 AND bs.scope = ?
       LEFT JOIN blobs b ON b.sha256 = vf.sha256
      WHERE vf.version_id = ? AND (bs.sha256 IS NULL OR b.sha256 IS NULL)`;
  const [missingResult, missingCount] = await dc.env.DB.batch<{ sha256: string } | { n: number }>([
    dc.env.DB.prepare(`SELECT DISTINCT vf.sha256 ${missingPredicate} LIMIT 200`).bind(scope, version.id),
    dc.env.DB.prepare(`SELECT COUNT(DISTINCT vf.sha256) AS n ${missingPredicate}`).bind(scope, version.id),
  ]);
  const missingRows = (missingResult?.results ?? []) as Array<{ sha256: string }>;
  const totalMissing = (missingCount?.results?.[0] as { n: number } | undefined)?.n ?? missingRows.length;
  if (missingRows.length) {
    const shown = totalMissing > missingRows.length ? ` (first ${missingRows.length} listed)` : "";
    throw conflict("missing_blobs", `${totalMissing} file(s) of this deploy have not been uploaded yet${shown}.`, "PUT each missing sha256 to /api/v1/blobs/:sha256, then finalize again.", {
      missing: missingRows.map((r) => r.sha256),
      ...(totalMissing > missingRows.length ? { totalMissing } : {}),
    });
  }
  const { results: files } = await dc.env.DB.prepare("SELECT path, sha256, size, content_type AS contentType FROM version_files WHERE version_id = ?").bind(version.id).all<NormalisedEntry>();
  validateManifest(files, await dc.adapters.policy.limits(p, siteOwner(site), dc));
  await validateStoredSizes(dc, site, files);
  const newBytes = site.mode === "transfer" ? 0 : await incrementalBytes(dc, site.tenant_id, site.id, files);
  const storageQuota = await requireQuota(dc, p, "storage_bytes", siteOwner(site), (await getUsage(dc, site.tenant_id)).storage_bytes, newBytes);
  const now = Date.now();
  const [upd] = await dc.env.DB.batch([
    // Check quota and base against transaction-local state; parallel pending deploys reserve no storage.
    dc.env.DB.prepare(
      `UPDATE sites SET current_version_id = ?, updated_at = ?
        WHERE id = ? AND tenant_id IS ? AND deleted_at IS NULL AND (? IS NULL OR current_version_id IS ?)
          AND EXISTS (SELECT 1 FROM versions WHERE id = ? AND status = 'pending')
          AND (? IS NULL OR (${PROJECTED_STORAGE_SQL}) <= ?)`,
    ).bind(version.id, now, site.id, site.tenant_id, version.base_version_id, version.base_version_id,
      version.id, storageQuota, site.tenant_id, site.id, version.id, storageQuota),
    dc.env.DB.prepare(`UPDATE versions SET status = 'ready', finalized_at = ? WHERE id = ? AND status = 'pending'
      AND EXISTS (SELECT 1 FROM sites WHERE id = ? AND current_version_id = ? AND updated_at = ? AND deleted_at IS NULL)`)
      .bind(now, version.id, site.id, version.id, now),
    ...usageStatements(dc, site.tenant_id),
  ]);
  if (!upd?.meta.changes) {
    const fresh = await getSiteFor(dc, p, site.slug, "sites:write");
    const latest = await getVersion(dc, site.id, version.id);
    if (latest?.status === "ready") return { version: latest, replayed: true, live: latest.id === fresh.current_version_id, warnings: await deployWarnings(dc, site, version.id) };
    if (version.base_version_id && fresh.current_version_id !== version.base_version_id) throw await versionConflict(dc, fresh);
    if (storageQuota !== null) throw quotaExceeded("storage_bytes", storageQuota);
    throw await versionConflict(dc, fresh);
  }
  await refreshLive(dc, site.id);
  const finalized: VersionRow = { ...version, status: "ready", finalized_at: now };
  const ref = { id: site.id, slug: site.slug, tenantId: site.tenant_id, url: siteUrl(dc, site.slug) };
  emit(dc, "onPublish", {
    kind: "deploy",
    site: ref,
    version: { id: finalized.id, number: finalized.number, fileCount: finalized.file_count, totalBytes: finalized.total_bytes },
    principal: p,
    at: now,
  });
  meter(dc, { type: "deploy", tenantId: site.tenant_id, siteId: site.id, versionId: finalized.id, fileCount: finalized.file_count, totalBytes: finalized.total_bytes, at: now });
  return { version: finalized, replayed: false, live: true, warnings: await deployWarnings(dc, site, version.id) };
}

/** Bounds for the finalize-time content scan: small text files only, capped counts per warning kind. */
const WARN_SCAN_MAX_BYTES = 256 * 1024;
const WARN_SCAN_MAX_FILES = 50;
const WARN_MAX_PER_CODE = 10;
const WARN_MAX_SECRETS = 20;

const WARN_HTML_RE = /\.html?$/i;
const WARN_CSS_RE = /\.css$/i;
const WARN_JS_RE = /\.(?:mjs|cjs|js)$/i;
/** Root-relative URLs (`/x`, but not protocol-relative `//x`) in markup, styles and scripts. */
const ROOT_ABS_HTML_RE = /\b(?:src|href|action|poster)\s*=\s*["']\/(?!\/)|\burl\(\s*["']?\/(?!\/)/;
const ROOT_ABS_CSS_RE = /\burl\(\s*["']?\/(?!\/)|@import\s+["']\/(?!\/)/;
const ROOT_ABS_JS_RE = /\b(?:fetch|importScripts)\(\s*["'`]\/(?!\/)|\bimport\s*\(\s*["']\/(?!\/)|\bfrom\s+["']\/(?!\/)|\bimport\s+["']\/(?!\/)|\bnew\s+(?:Request|EventSource|WebSocket)\(\s*["'`]\/(?!\/)/;
const BROWSER_STORAGE_RE = /\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie\b/;

/**
 * Publish warnings (PUB-12): computed from the stored bytes at finalize, so one-shot publish,
 * manifest finalize and the agent publish paths all return the same list. Warnings never
 * include matched secret values. Content scanning is bounded (text files up to
 * {@link WARN_SCAN_MAX_BYTES}, at most {@link WARN_SCAN_MAX_FILES} files read, per-code caps),
 * so a huge version pays a constant, small extra cost at finalize.
 */
export async function deployWarnings(dc: DropwayContext, site: SiteRow, versionId: string): Promise<Warning[]> {
  const warnings: Warning[] = [];
  // Advisory reads must not turn an already-published version into an API failure.
  // Keep this guard local to the scan: authorization and finalization still fail normally.
  type StoredEntry = NormalisedEntry & { storageKey: string | null };
  const files = await dc.env.DB.prepare(
    `SELECT vf.path, vf.sha256, vf.size, vf.content_type AS contentType,
       COALESCE(b.storage_key, 'blobs/' || b.sha256) AS storageKey
     FROM version_files vf LEFT JOIN blobs b ON b.sha256 = vf.sha256
     WHERE vf.version_id = ? ORDER BY vf.path`,
  )
    .bind(versionId)
    .all<StoredEntry>()
    .then((result) => result.results)
    .catch(() => null);
  if (files === null) return warnings;

  const hasIndex = files.some((f) => /^(index\.html?|index\.md|readme\.md)$/i.test(f.path));
  if (!hasIndex && files.length > 1) {
    warnings.push({
      code: "no_index",
      message: "There is no index.html (or index.md / README.md) at the root, so the site root shows a file listing. Link to files by path.",
      fix: "Add an index.html (or index.md / README.md) at the root of the published folder.",
    });
  }
  const wasm = files.find((f) => /\.wasm(\.br|\.gz)?$/i.test(f.path));
  if (wasm && site.cross_origin_isolation !== 1) {
    warnings.push({
      code: "wasm_without_coi",
      path: wasm.path,
      message: "This version ships WebAssembly without cross-origin isolation, so SharedArrayBuffer (WASM threads) will not be available. Single-threaded builds need nothing.",
      fix: 'If the module uses threads, PATCH the site with {"crossOriginIsolation": true} and republish.',
    });
  }

  // Bounded text access, shared across the checks below (one read per blob at most).
  // Direct R2 range reads, deliberately not readBlob: the scan must not write hot blobs
  // into the shared edge cache as a side effect of publishing.
  const texts = new Map<string, Promise<string | null>>();
  let scanned = 0;
  const textFor = (f: StoredEntry): Promise<string | null> => {
    let pending = texts.get(f.sha256);
    if (!pending) {
      pending =
        !f.storageKey || f.size > WARN_SCAN_MAX_BYTES || scanned >= WARN_SCAN_MAX_FILES
          ? Promise.resolve(null)
          : ((scanned += 1),
            dc.env.FILES.get(f.storageKey, { range: { offset: 0, length: f.size } })
              .then((obj) => (obj ? obj.text() : null))
              .catch(() => null));
      texts.set(f.sha256, pending);
    }
    return pending;
  };

  // invalid_config: `.dropway/*.json` is the site's config namespace (stored, never served);
  // a file there that is not valid JSON can never take effect.
  const configFiles = files.filter((f) => /^\.dropway\/[^/]+\.json$/i.test(f.path));
  // textFor reserves its shared read budget synchronously in file order, so parallel
  // reads keep the same deterministic ceiling; warnings are still emitted in order.
  const configTexts = await Promise.all(configFiles.map(textFor));
  let configWarnings = 0;
  for (const [i, f] of configFiles.entries()) {
    if (configWarnings >= WARN_MAX_PER_CODE) break;
    const text = configTexts[i]!;
    if (text === null) continue;
    try {
      JSON.parse(text);
    } catch {
      configWarnings++;
      warnings.push({
        code: "invalid_config",
        path: f.path,
        message: `"${f.path}" is not valid JSON, so it is ignored as configuration.`,
        fix: "Fix the JSON syntax (for example with `jq . <file>`), or remove the file, and republish.",
      });
    }
  }

  const pathMode = dc.config.sitesMode === "path";
  // Effective sandbox for this site, mirroring serve-time behaviour: the configured
  // sandbox (forced on when sites share the app origin), plus anonymous sites under
  // SITES_SANDBOX=auto on a dedicated sites origin.
  const sandboxed = dc.config.sitesSandbox || (site.tenant_id === null && dc.config.sitesSandboxAnonymous);
  const siteBase = dc.config.sitesOrigin ? `/${site.slug}/` : `${dc.config.sitesPathPrefix}/${site.slug}/`;

  // spa_without_base: in path mode an SPA served under /<slug>/ needs a <base> (or fully
  // relative URLs) so client-side routes resolve assets inside the site prefix.
  if (pathMode && site.spa === 1) {
    const index = files.find((f) => /^index\.html?$/i.test(f.path));
    if (index) {
      const text = await textFor(index);
      if (text !== null && !/<base[\s>]/i.test(text)) {
        warnings.push({
          code: "spa_without_base",
          path: index.path,
          message: "This SPA has no <base> element. In path mode the site lives under a prefix, so deep client-side routes can resolve relative asset URLs outside the site.",
          fix: `Add <base href="${siteBase}"> to <head>, or build with a relative base (Vite: base: "./", Angular: --base-href ${siteBase}).`,
        });
      }
    }
  }

  const scanFiles = files.map((f) => ({
    f,
    isHtml: WARN_HTML_RE.test(f.path),
    isCss: WARN_CSS_RE.test(f.path),
    isJs: WARN_JS_RE.test(f.path),
    maybeSecret: isTextual(f.contentType) || (f.path.split("/").pop() ?? f.path).startsWith(".env"),
  })).filter(({ isHtml, isCss, isJs, maybeSecret }) =>
    (pathMode && (isHtml || isCss || isJs)) || (sandboxed && (isHtml || isJs)) || maybeSecret);
  const scanTexts = await Promise.all(scanFiles.map(({ f }) => textFor(f)));
  let rootAbsWarnings = 0;
  let storageWarnings = 0;
  let secretWarnings = 0;
  for (const [i, { f, isHtml, isCss, isJs, maybeSecret }] of scanFiles.entries()) {
    const wantRootAbs = pathMode && rootAbsWarnings < WARN_MAX_PER_CODE && (isHtml || isCss || isJs);
    const wantStorage = sandboxed && storageWarnings < WARN_MAX_PER_CODE && (isHtml || isJs);
    const wantSecret = secretWarnings < WARN_MAX_SECRETS && maybeSecret;
    if (!wantRootAbs && !wantStorage && !wantSecret) continue;
    const text = scanTexts[i]!;
    if (text === null) continue;

    if (wantRootAbs) {
      const m = (isCss ? ROOT_ABS_CSS_RE : isJs ? ROOT_ABS_JS_RE : ROOT_ABS_HTML_RE).exec(text) ?? (isHtml ? ROOT_ABS_JS_RE.exec(text) : null);
      if (m) {
        rootAbsWarnings++;
        warnings.push({
          code: "root_absolute_paths",
          path: f.path,
          line: lineAt(text, m.index),
          message: `"${f.path}" uses root-absolute URLs (starting with /). In path mode they point outside this site's prefix; HTML/CSS references and common runtime calls are rewritten for you, but import specifiers, location.href and history.pushState with root-relative URLs are not.`,
          fix: `Use relative URLs (./assets/app.js), or set the framework base to ${siteBase} (Vite: base: "${siteBase}").`,
        });
      }
    }
    if (wantStorage) {
      const m = BROWSER_STORAGE_RE.exec(text);
      if (m) {
        storageWarnings++;
        warnings.push({
          code: "uses_browser_storage",
          path: f.path,
          line: lineAt(text, m.index),
          message: `"${f.path}" uses browser storage (localStorage/sessionStorage/IndexedDB/cookies), but this site is served sandboxed with an opaque origin, so storage is unavailable and these calls will throw or lose data.`,
          fix: "Guard storage access (try/catch with an in-memory fallback), or serve the site unsandboxed: subdomain mode, or SITES_SANDBOX=false on a dedicated sites origin for non-anonymous sites.",
        });
      }
    }
    if (wantSecret) {
      for (const finding of findSecrets(f.path, text)) {
        if (secretWarnings >= WARN_MAX_SECRETS) break;
        secretWarnings++;
        warnings.push({
          code: "possible_secret",
          path: finding.path,
          line: finding.line,
          message: `"${finding.path}" line ${finding.line} looks like a ${finding.kind} credential. Published files are public to anyone with the link.`,
          fix: "Remove the credential from the file, revoke or rotate it (assume it is leaked), republish, then delete this version with delete_version so the leaked copy is gone.",
        });
      }
    }
  }
  return warnings;
}

export async function getDeployStatus(dc: DropwayContext, site: SiteRow, versionId: string) {
  const version = await getVersion(dc, site.id, versionId);
  if (!version) throw notFound("deploy_not_found", `No version ${versionId} on site ${site.slug}.`);
  let missing: string[] = [];
  if (version.status === "pending") {
    const { results } = await dc.env.DB.prepare("SELECT DISTINCT sha256 FROM version_files WHERE version_id = ?").bind(version.id).all<{ sha256: string }>();
    missing = await missingForScope(dc, blobScope(siteOwner(site)), results.map((r) => r.sha256));
  }
  return { deploy: serializeVersion(version, site.current_version_id), missing };
}

export async function listVersions(dc: DropwayContext, site: SiteRow, opts: { limit?: number } = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500);
  const { results } = await dc.env.DB.prepare("SELECT * FROM versions WHERE site_id = ? AND status = 'ready' ORDER BY number DESC LIMIT ?")
    .bind(site.id, limit)
    .all<VersionRow>();
  return results.map((v) => serializeVersion(v, site.current_version_id));
}

/** Guidance for a restore that lost a live-pointer race: re-inspect, then make a fresh deliberate call. */
const RESTORE_CONFLICT_HINT =
  "Call get_site to inspect the current live version, then decide on a fresh intentional restore invocation. Do not automatically retry this restore.";

/** Make an older finalized version live again (a pointer flip; no files are copied). */
export async function restoreVersion(dc: DropwayContext, p: Principal, site: SiteRow, versionId: string, opts?: { symbolicLive?: boolean }) {
  const originalSiteId = site.id;
  site = await getSiteFor(dc, p, site.slug, "sites:write");
  if (site.id !== originalSiteId) {
    throw notFound("site_not_found", `No site "${site.slug}" that this key can access.`, "List your sites with GET /api/v1/sites.");
  }
  if (site.mode === "transfer") throw conflict("transfer_immutable", "Transfer files cannot be restored.", "Create a new transfer instead.");
  // A symbolic "live" ref must resolve against this fresh anchor, never against the id a
  // caller resolved from an older snapshot: that stale id would flip a moved pointer back.
  let targetId = versionId;
  if (opts?.symbolicLive) {
    if (!site.current_version_id) {
      throw notFound("version_not_found", `Site ${site.slug} has no live version yet.`, "Publish files first with publish_site.");
    }
    targetId = site.current_version_id;
  }
  const version = await getVersion(dc, site.id, targetId);
  if (!version || version.status !== "ready") {
    throw notFound("version_not_found", `No finalized version ${targetId} on site ${site.slug}.`, "List versions with GET /api/v1/sites/:slug/versions.");
  }
  if (version.id === site.current_version_id) return { restored: false, alreadyLive: true, version: serializeVersion(version, version.id) };
  const now = Date.now();
  const [upd] = await dc.env.DB.batch([
    dc.env.DB.prepare(
      `UPDATE sites SET current_version_id = ?, updated_at = ?
        WHERE id = ? AND tenant_id IS ? AND deleted_at IS NULL AND current_version_id IS ?
          AND EXISTS (SELECT 1 FROM versions WHERE id = ? AND site_id = ? AND status = 'ready')`,
    ).bind(version.id, now, site.id, site.tenant_id, site.current_version_id, version.id, site.id),
  ]);
  if (!upd?.meta.changes) {
    // Bind diagnostics to the original site by immutable id: the addressed slug may now
    // resolve to a different same-tenant site, whose metadata must never leak into this error.
    const original = await dc.env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(site.id).first<SiteRow>();
    if (!original || original.deleted_at !== null || original.slug !== site.slug || original.tenant_id !== site.tenant_id) {
      throw notFound("site_not_found", `No site "${site.slug}" that this key can access.`, "List your sites with GET /api/v1/sites.", { slug: site.slug });
    }
    const latest = await getVersion(dc, site.id, version.id);
    if (!latest || latest.status !== "ready") {
      throw notFound("version_not_found", `No finalized version ${versionId} on site ${site.slug}.`, "List versions with GET /api/v1/sites/:slug/versions.");
    }
    throw await versionConflict(dc, original, undefined, RESTORE_CONFLICT_HINT);
  }
  await refreshLive(dc, site.id);
  emit(dc, "onPublish", {
    kind: "restore",
    site: { id: site.id, slug: site.slug, tenantId: site.tenant_id, url: siteUrl(dc, site.slug) },
    version: { id: version.id, number: version.number, fileCount: version.file_count, totalBytes: version.total_bytes },
    principal: p,
    at: now,
  });
  return { restored: true, alreadyLive: false, version: serializeVersion(version, version.id) };
}

/** Permanently delete one non-live version (for example one that leaked a secret). */
export async function deleteVersion(dc: DropwayContext, p: Principal, site: SiteRow, versionId: string) {
  const originalSiteId = site.id;
  site = await getSiteFor(dc, p, site.slug, "sites:delete");
  if (site.id !== originalSiteId) {
    throw notFound("site_not_found", `No site "${site.slug}" that this key can access.`, "List your sites with GET /api/v1/sites.");
  }
  if (site.mode === "transfer") throw conflict("transfer_immutable", "Transfer files cannot be deleted separately.", "Revoke the transfer; retained bytes are purged by cleanup when not held.");
  const version = await getVersion(dc, site.id, versionId);
  if (!version) throw notFound("version_not_found", `No version ${versionId} on site ${site.slug}.`);
  if (version.id === site.current_version_id) throw conflict("version_is_live", "You cannot delete the live version.", "Restore or publish another version first.");
  try {
    await dc.env.DB.batch([
      // A SQL failure, not a zero-row DELETE, refuses the whole batch before any
      // manifest or usage write. CASE keeps the diagnostic bound to this site.
      dc.env.DB.prepare(`SELECT CASE
        WHEN s.id IS NULL THEN json_extract('{}', 'kofra_delete_version_site_changed')
        WHEN s.mode = 'transfer' THEN json_extract('{}', 'kofra_delete_version_transfer')
        WHEN v.id IS NULL THEN json_extract('{}', 'kofra_delete_version_missing')
        WHEN s.current_version_id = v.id THEN json_extract('{}', 'kofra_delete_version_live')
        ELSE 1 END
        FROM (SELECT 1) AS anchor
        LEFT JOIN sites AS s ON s.id = ? AND s.slug = ? AND s.tenant_id IS ? AND s.deleted_at IS NULL
        LEFT JOIN versions AS v ON v.id = ? AND v.site_id = s.id`)
        .bind(site.id, site.slug, site.tenant_id, version.id),
      dc.env.DB.prepare("DELETE FROM version_files WHERE version_id = ?").bind(version.id),
      dc.env.DB.prepare("DELETE FROM versions WHERE id = ?").bind(version.id),
      ...usageStatements(dc, site.tenant_id),
    ]);
  } catch (error) {
    const message = String(error);
    if (!message.includes("JSON path")) throw error;
    if (message.includes("kofra_delete_version_site_changed")) {
      throw notFound("site_not_found", `No site "${site.slug}" that this key can access.`, "List your sites with GET /api/v1/sites.", { slug: site.slug });
    }
    if (message.includes("kofra_delete_version_transfer")) {
      throw conflict("transfer_immutable", "Transfer files cannot be deleted separately.", "Revoke the transfer; retained bytes are purged by cleanup when not held.");
    }
    if (message.includes("kofra_delete_version_missing")) {
      throw notFound("version_not_found", `No version ${versionId} on site ${site.slug}.`);
    }
    if (message.includes("kofra_delete_version_live")) {
      throw conflict("version_is_live", "You cannot delete the live version.", "Restore or publish another version first.");
    }
    throw error;
  }
  return { deleted: true, id: version.id };
}

export interface FileRow {
  path: string;
  sha256: string;
  size: number;
  content_type: string;
}

/** The file manifest of the live version (or of `versionId`), with public and raw URLs. */
export async function listFiles(dc: DropwayContext, site: SiteRow, versionId: string | null) {
  const vid = versionId ?? site.current_version_id;
  if (!vid) return { version: null, files: [] };
  // One batch is one consistent snapshot: a concurrent deleteVersion batch commits
  // either fully before this read (version row gone, 404 below) or fully after it
  // (complete manifest). The file_count check fails closed on any torn remainder.
  const [versionResult, filesResult] = await dc.env.DB.batch([
    dc.env.DB.prepare("SELECT * FROM versions WHERE id = ? AND site_id = ?").bind(vid, site.id),
    dc.env.DB.prepare("SELECT path, sha256, size, content_type FROM version_files WHERE version_id = ? ORDER BY path").bind(vid),
  ]);
  const version = ((versionResult?.results ?? []) as unknown as VersionRow[])[0] ?? null;
  if (!version) throw notFound("version_not_found", `No version ${vid} on site ${site.slug}.`);
  const results = (filesResult?.results ?? []) as unknown as FileRow[];
  if (results.length !== version.file_count) {
    throw notFound("version_not_found", `No version ${vid} on site ${site.slug}.`, undefined, {
      fileCount: version.file_count,
      files: results.length,
    });
  }
  const api = `${appOrigin(dc)}/api/v1/sites/${site.slug}/files/`;
  return {
    version: serializeVersion(version, site.current_version_id),
    files: results.map((f) => ({
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      contentType: f.content_type,
      kind: detectFileKind(f.path, f.content_type),
      extension: extname(f.path),
      url: siteFileUrl(dc, site.slug, f.path),
      rawUrl: api + encodePath(f.path),
    })),
  };
}

export async function getFile(dc: DropwayContext, site: SiteRow, path: string, versionId?: string | null): Promise<FileRow | null> {
  if (site.mode === "transfer") throw forbidden("Transfer bytes are only available as sites-host downloads.", "Use the transfer page's download links.", "transfer_download_required");
  const vid = versionId ?? site.current_version_id;
  if (!vid) return null;
  // The version must belong to this site, and a pending version's bytes are only
  // readable once this owner has uploaded them: its manifest can name any sha256.
  return dc.env.DB.prepare(
    `SELECT vf.path, vf.sha256, vf.size, vf.content_type
       FROM version_files vf
       JOIN versions v ON v.id = vf.version_id AND v.site_id = ?
      WHERE vf.version_id = ? AND vf.path = ?
        AND (v.status = 'ready' OR EXISTS (SELECT 1 FROM blob_scopes bs WHERE bs.sha256 = vf.sha256 AND bs.scope = ?))`,
  )
    .bind(site.id, vid, path, blobScope(siteOwner(site)))
    .first<FileRow>();
}
