import type { DropwayContext } from "../context";
import { appOrigin, siteFileUrl, siteUrl } from "../context";
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized } from "../errors";
import { detectFileKind } from "../lib/filetypes";
import { newId } from "../lib/crypto";
import { isHtml, isTextual } from "../lib/mime";
import { encodePath, normaliseFilePath } from "../lib/paths";
import { validateSlug } from "../lib/slug";
import type { Principal, Scope } from "../principal";
import { readBlob, readBlobRange } from "./blobs";
import { getFile, validateManifest } from "./deploys";
import { emit, meter } from "./events";
import { dropLive, refreshLive } from "./live";
import { quotaExceeded, requireQuota } from "./policy";
import { createSite, discardNewSite, getSiteFor, getVersion, parseSettings, updateSite, type SiteRow, type VersionRow } from "./sites";
import { getUsage, incrementalBytes, PROJECTED_STORAGE_SQL, usageStatements } from "./usage";
import { atomicWrite, siteSlugError } from "./atomic-write";

/**
 * Site and version lookups that accept what agents naturally have in hand
 * (a slug, a site id, or any URL of the site; "live", "v3", "3" or a version id),
 * plus the site operations the MCP server and REST share: rename, access mode,
 * and paged file reads.
 */

/**
 * Turn a site reference into a slug: a slug ("bright-otter-x7k2"), a site id
 * ("site_..."), or any URL of the site (its live URL, a file URL, or its API URL).
 * Does not check access; use getSiteByRef for that.
 */
export async function resolveSiteSlug(dc: DropwayContext, ref: unknown): Promise<string> {
  if (typeof ref !== "string" || !ref.trim()) {
    throw badRequest("invalid_site", "site must be a slug, a site id or a URL of the site.", "Example: \"bright-otter-x7k2\". List your sites with list_sites (GET /api/v1/sites).");
  }
  const s = ref.trim();
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw badRequest("invalid_site", `"${s}" is not a valid URL.`);
    }
    const c = dc.config;
    if (c.sitesMode === "subdomain" && c.sitesDomain && u.hostname.endsWith(`.${c.sitesDomain}`)) {
      return u.hostname.slice(0, -(c.sitesDomain.length + 1)).split("--")[0]!.toLowerCase();
    }
    const segs = u.pathname.split("/").filter(Boolean);
    if (c.sitesOrigin && u.origin === c.sitesOrigin && segs[0]) return segs[0].toLowerCase();
    const prefix = c.sitesPathPrefix.split("/").filter(Boolean);
    if (prefix.length && prefix.every((p, i) => segs[i] === p) && segs[prefix.length]) return segs[prefix.length]!.toLowerCase();
    // API links: <app>/api/v1/sites/<slug>/...
    const api = segs.indexOf("sites");
    if (segs[0] === "api" && api >= 0 && segs[api + 1]) return segs[api + 1]!.toLowerCase();
    throw badRequest("invalid_site", `"${s}" is not a URL of a site on this instance.`, `Site URLs look like ${appOrigin(dc)}${c.sitesPathPrefix}/<slug>/ (or as returned by publish_site).`);
  }
  if (/^site_[a-z0-9]+$/i.test(s)) {
    const row = await dc.env.DB.prepare("SELECT slug FROM sites WHERE id = ? AND deleted_at IS NULL").bind(s).first<{ slug: string }>();
    if (!row) throw notFound("site_not_found", `No site with id "${s}".`, "List your sites with list_sites (GET /api/v1/sites).");
    return row.slug;
  }
  return s.toLowerCase();
}

/** Load a site the caller may access, from any site reference. */
export async function getSiteByRef(dc: DropwayContext, p: Principal, ref: unknown, scope: Scope = "sites:read"): Promise<SiteRow> {
  return getSiteFor(dc, p, await resolveSiteSlug(dc, ref), scope);
}

/**
 * Resolve a version reference on a site: "live" (or empty) for the live version,
 * "v12" or "12" for version number 12, otherwise a version id.
 */
export async function resolveVersionRef(dc: DropwayContext, site: SiteRow, ref: unknown): Promise<VersionRow> {
  const raw = ref === undefined || ref === null ? "live" : String(ref).trim();
  const listHint = "List versions with list_versions (GET /api/v1/sites/{site}/versions).";
  if (raw === "" || raw.toLowerCase() === "live") {
    if (!site.current_version_id) throw notFound("version_not_found", `Site ${site.slug} has no live version yet.`, "Publish files first with publish_site.");
    const v = await dc.env.DB.prepare("SELECT * FROM versions WHERE id = ?").bind(site.current_version_id).first<VersionRow>();
    if (!v) throw notFound("version_not_found", `Site ${site.slug} has no live version.`, listHint);
    return v;
  }
  const num = /^v?(\d{1,9})$/i.exec(raw);
  const v = num
    ? await dc.env.DB.prepare("SELECT * FROM versions WHERE site_id = ? AND number = ?").bind(site.id, Number(num[1])).first<VersionRow>()
    : await dc.env.DB.prepare("SELECT * FROM versions WHERE site_id = ? AND id = ?").bind(site.id, raw).first<VersionRow>();
  if (!v) throw notFound("version_not_found", `No version "${raw}" on site ${site.slug}.`, listHint);
  return v;
}

/** Destructive calls carry an explicit confirmation equal to the thing being destroyed. */
export function requireConfirm(confirm: unknown, expected: string, what = "the site's slug"): void {
  if (confirm !== expected) {
    throw badRequest("confirm_mismatch", `This action is destructive: set confirm to ${what} ("${expected}") to go ahead.`, `Call again with confirm: "${expected}".`, {
      expected,
    });
  }
}

/** Give a site a new slug. Its live URL changes at once; the old URL stops working. */
export async function renameSite(dc: DropwayContext, p: Principal, ref: unknown, newSlug: unknown) {
  if (p.kind !== "member") throw unauthorized("Renaming a site needs an API key.");
  const site = await getSiteByRef(dc, p, ref, "sites:write");
  if (typeof newSlug !== "string") throw badRequest("invalid_slug", "newSlug must be a string.");
  const wanted = validateSlug(newSlug);
  if (wanted === site.slug) return { renamed: false, site, oldSlug: site.slug };
  const extension = await dc.adapters.policy.siteNameMutation?.(p, {
    operation: "rename", siteId: site.id, tenantId: site.tenant_id, slug: wanted, previousSlug: site.slug,
  }, dc);
  const fence = "id = ? AND tenant_id IS ? AND slug = ? AND deleted_at IS NULL";
  await atomicWrite(dc, [
    // CASE is lazy: the deliberately invalid, tagged JSON path aborts a stale
    // attempt INSIDE the transaction, including when the row was hard-deleted.
    dc.env.DB.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM sites WHERE ${fence})
      THEN 1 ELSE json_extract('{}', 'dropway_site_changed') END`).bind(site.id, site.tenant_id, site.slug),
    dc.env.DB.prepare(`UPDATE sites SET slug = ?, updated_at = ? WHERE ${fence}`)
      .bind(wanted, Date.now(), site.id, site.tenant_id, site.slug),
  ], extension, (error) => {
    if (String(error).includes("JSON path") && String(error).includes("dropway_site_changed")) {
      return conflict("site_changed", "The site changed while preparing its rename.", "Reload the site and retry.");
    }
    return siteSlugError(error, wanted, "Pick another name.");
  });
  await dropLive(dc, site.slug);
  await refreshLive(dc, site.id);
  const fresh = (await dc.env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(site.id).first<SiteRow>())!;
  return { renamed: true, site: fresh, oldSlug: site.slug };
}

export interface DuplicateSiteInput {
  newSlug: unknown;
  message?: unknown;
  client?: string | null;
  source?: string;
}

/**
 * Copy a site's live version into a brand-new slug, live at once. Blobs are
 * content-addressed, so this copies manifest pointers only; no bytes move and
 * the source is untouched. Only SPA mode is carried over: the password (and
 * with it the whole access gate), title, description and every other setting
 * reset to the instance default, and the caller re-applies a password. Every
 * refusal happens before the new site row exists, or removes it again, so a
 * refused duplicate leaves no orphan site, version or taken slug.
 */
export async function duplicateSite(dc: DropwayContext, p: Principal, ref: unknown, input: DuplicateSiteInput) {
  if (typeof input.newSlug !== "string") throw badRequest("invalid_slug", "newSlug must be a string.");
  const wanted = validateSlug(input.newSlug);
  const source = await getSiteByRef(dc, p, ref, "sites:write");
  if (source.mode === "transfer") {
    throw conflict("transfer_immutable", "Transfers cannot be duplicated into sites.", "Create a new transfer instead.");
  }
  const live = source.current_version_id ? await getVersion(dc, source.id, source.current_version_id) : null;
  if (!live || live.status !== "ready") {
    throw conflict(
      "version_conflict",
      `Site "${source.slug}" has no live version to duplicate.`,
      `Publish files to "${source.slug}" first (POST /api/v1/publish with {"site": "${source.slug}", ...}), then duplicate again.`,
    );
  }
  const { results: files } = await dc.env.DB.prepare("SELECT path, sha256, size, content_type AS contentType FROM version_files WHERE version_id = ? ORDER BY path")
    .bind(live.id)
    .all<{ path: string; sha256: string; size: number; contentType: string }>();
  // A concurrent publish + delete of the source version between the live read
  // and the manifest read leaves a short capture: refuse as a conflict (409
  // version_conflict), not a client manifest error, before the new site exists.
  const capturedBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (files.length !== live.file_count || capturedBytes !== live.total_bytes) {
    throw conflict(
      "version_conflict",
      `Site "${source.slug}" changed while preparing its duplicate (its live version was replaced).`,
      "Retry the duplicate; the copy starts from the current live version.",
    );
  }
  // The manifest went live once already, so this only re-checks the caps (which a
  // host may have lowered since). It runs before createSite so a refusal is clean.
  const owner = { siteId: source.id, tenantId: source.tenant_id };
  validateManifest(files, await dc.adapters.policy.limits(p, owner, dc));
  const newBytes = await incrementalBytes(dc, source.tenant_id, source.id, files);
  const storageQuota = await requireQuota(dc, p, "storage_bytes", owner, (await getUsage(dc, source.tenant_id)).storage_bytes, newBytes);

  // New-slug validation, collisions (including transfer tombstones), quotas and
  // policy run inside createSite, exactly as for a fresh site.
  const { site } = await createSite(dc, p, { slug: wanted, spa: source.spa === 1 });
  const now = Date.now();
  const versionId = newId("ver");
  const message = input.message == null ? null : String(input.message).slice(0, 500);
  try {
    await dc.adapters.policy.beforeDeploy?.(
      p,
      { siteId: site.id, tenantId: site.tenant_id, fileCount: live.file_count, totalBytes: live.total_bytes, newBytes },
      dc,
    );
    const [, , , madeLive] = await dc.env.DB.batch([
      dc.env.DB.prepare(
        `INSERT INTO versions (id, site_id, number, status, file_count, total_bytes, manifest_hash, base_version_id, source, client, message, created_by, created_at, finalized_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM versions WHERE site_id = ?), 'ready', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        versionId, site.id, site.id, live.file_count, live.total_bytes, live.manifest_hash,
        input.source ?? "api", input.client ? String(input.client).slice(0, 120) : null, message,
        p.kind === "member" ? p.memberId : p.kind, now, now,
      ),
      // Pointer copy: the new version's rows reference the same stored blobs.
      dc.env.DB.prepare(
        `INSERT INTO version_files (version_id, path, sha256, size, content_type)
         SELECT ?, path, sha256, size, content_type FROM version_files WHERE version_id = ?`,
      ).bind(versionId, live.id),
      // Fence the copy inside the transaction: when the source version vanished
      // after capture, the SELECT above copies zero rows and this deliberately
      // invalid, tagged JSON path aborts the batch, so the refusal leaves no
      // orphan version or live pointer (the site still has no live version and
      // discardNewSite removes it).
      dc.env.DB.prepare(`SELECT CASE WHEN (SELECT COUNT(*) FROM version_files WHERE version_id = ?) = ?
        AND COALESCE((SELECT SUM(size) FROM version_files WHERE version_id = ?), 0) = ?
        THEN 1 ELSE json_extract('{}', 'dropway_duplicate_changed') END`).bind(versionId, live.file_count, versionId, live.total_bytes),
      dc.env.DB.prepare(
        `UPDATE sites SET current_version_id = ?, updated_at = ? WHERE id = ? AND current_version_id IS NULL AND deleted_at IS NULL
           AND (? IS NULL OR (${PROJECTED_STORAGE_SQL}) <= ?)`,
      ).bind(versionId, now, site.id, storageQuota, site.tenant_id, site.id, versionId, storageQuota),
      ...usageStatements(dc, site.tenant_id),
    ]);
    if (!madeLive?.meta.changes) {
      if (storageQuota !== null) throw quotaExceeded("storage_bytes", storageQuota);
      throw conflict("version_conflict", "The new site changed while it was being duplicated.", "Retry the duplicate.");
    }
  } catch (e) {
    await discardNewSite(dc, site);
    if (String(e).includes("dropway_duplicate_changed")) {
      throw conflict(
        "version_conflict",
        `Site "${source.slug}" changed while it was being duplicated (its live version was replaced).`,
        "Retry the duplicate; the copy starts from the current live version.",
      );
    }
    throw e;
  }
  // KV is a cache; D1 is the source of truth and serving rebuilds on a miss. A
  // cache failure after commit must not turn a complete copy into an error that
  // retry cannot replay (the slug is taken by the committed copy).
  try {
    await refreshLive(dc, site.id);
  } catch (e) {
    console.error(JSON.stringify({ event: "duplicate_cache_warm_failed", siteId: site.id, error: String(e) }));
  }
  const version = (await getVersion(dc, site.id, versionId))!;
  emit(dc, "onPublish", {
    kind: "deploy",
    site: { id: site.id, slug: site.slug, tenantId: site.tenant_id, url: siteUrl(dc, site.slug) },
    version: { id: version.id, number: version.number, fileCount: version.file_count, totalBytes: version.total_bytes },
    principal: p,
    at: now,
  });
  meter(dc, { type: "deploy", tenantId: site.tenant_id, siteId: site.id, versionId: version.id, fileCount: version.file_count, totalBytes: version.total_bytes, at: now });
  return { site: { ...site, current_version_id: versionId, updated_at: now }, version };
}

export type AccessMode = "public" | "password" | "restricted" | "private";
const ACCESS_MODES: readonly AccessMode[] = ["public", "password", "restricted", "private"];

/** Current access mode of a site (this edition supports public and password). */
export function accessModeOf(site: Pick<SiteRow, "password_hash">): AccessMode {
  return site.password_hash ? "password" : "public";
}

/**
 * Set who can open a site. "public": anyone with the link. "password": visitors
 * enter a password (stored hashed; changing it signs everyone out).
 * "restricted" and "private" are planned and answer feature_unavailable.
 */
export async function setSiteAccess(dc: DropwayContext, p: Principal, ref: unknown, input: { mode?: unknown; password?: unknown }) {
  const mode = String(input.mode ?? "") as AccessMode;
  if (!ACCESS_MODES.includes(mode)) {
    throw badRequest("invalid_access_mode", `mode must be one of ${ACCESS_MODES.join(", ")}.`, 'Use "public" or "password" (with a password).');
  }
  if (mode === "restricted" || mode === "private") {
    throw new ApiError(501, "feature_unavailable", `Access mode "${mode}" is not available on this instance yet.`, 'Use "password" to keep a site away from the public.', {
      requires: "access control (roadmap R-23)",
    });
  }
  const site = await getSiteByRef(dc, p, ref, "sites:write");
  if (mode === "password" && (typeof input.password !== "string" || !input.password)) {
    throw badRequest("password_required", 'mode "password" needs a password (4-200 characters).', 'Call again with password: "<4-200 characters>".');
  }
  const settings = parseSettings({ password: mode === "public" ? null : input.password });
  const updated = await updateSite(dc, p, site.slug, settings);
  return { site: updated, mode: accessModeOf(updated) };
}

export const READ_FILE_DEFAULT_BYTES = 64 * 1024;
export const READ_FILE_MAX_BYTES = 1024 * 1024;

/**
 * Read part or all of one published file. Text types come back as UTF-8 text,
 * other types as base64 (or force either with `encoding`). Large files are read
 * in pages: pass `nextOffset` back as `offset`.
 */
export async function readFileSlice(
  dc: DropwayContext,
  site: SiteRow,
  rawPath: unknown,
  opts: { version?: VersionRow | null; offset?: unknown; length?: unknown; encoding?: unknown } = {},
) {
  const path = normaliseFilePath(String(rawPath ?? ""));
  const versionId = opts.version?.id ?? site.current_version_id;
  if (!versionId) throw notFound("version_not_found", `Site ${site.slug} has no live version yet.`, "Publish files first.");
  const file = await getFile(dc, site, path, versionId);
  if (!file) throw notFound("file_not_found", `No file "${path}" in this version.`, "List files with list_files (GET /api/v1/sites/{site}/files).");
  const offset = Math.max(0, Math.floor(Number(opts.offset ?? 0)) || 0);
  if (offset > file.size) throw badRequest("invalid_range", `offset ${offset} is past the end of the file (${file.size} bytes).`);
  const length = Math.min(READ_FILE_MAX_BYTES, Math.max(1, Math.floor(Number(opts.length ?? READ_FILE_DEFAULT_BYTES)) || READ_FILE_DEFAULT_BYTES));
  const end = Math.min(file.size, offset + length);
  const wanted = String(opts.encoding ?? "auto");
  if (!["auto", "text", "base64"].includes(wanted)) throw badRequest("invalid_encoding", 'encoding must be "auto", "text" or "base64".');
  const textual = isTextual(file.content_type) || isHtml(file.content_type);
  const encoding: "text" | "base64" = wanted === "auto" ? (textual ? "text" : "base64") : (wanted as "text" | "base64");

  let bytes = new Uint8Array(0);
  if (end > offset) {
    const body =
      offset === 0 && end === file.size ? (await readBlob(dc, file.sha256, file.size))?.body : await readBlobRange(dc, file.sha256, { offset, length: end - offset });
    if (body === undefined || body === null) {
      if (file.size > 0) throw new ApiError(502, "blob_missing", "The file is listed but its contents could not be read.", "Retry shortly.", { retryable: true });
    } else {
      bytes = new Uint8Array(await new Response(body).arrayBuffer());
    }
  }
  const content = encoding === "text" ? new TextDecoder().decode(bytes) : bytesToBase64(bytes);
  return {
    path,
    versionId,
    contentType: file.content_type,
    kind: detectFileKind(path, file.content_type),
    size: file.size,
    sha256: file.sha256,
    encoding,
    offset,
    length: bytes.length,
    truncated: end < file.size,
    nextOffset: end < file.size ? end : null,
    content,
    url: siteFileUrl(dc, site.slug, path),
    rawUrl: `${appOrigin(dc)}/api/v1/sites/${site.slug}/files/${encodePath(path)}`,
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** Reject principals that cannot use agent tools at all (anonymous callers, the bootstrap key). */
export function requireAgentPrincipal(p: Principal): void {
  if (p.kind === "anonymous") throw unauthorized();
  if (p.kind === "bootstrap") {
    throw forbidden("The bootstrap key can only set up the instance.", "Use the owner API key returned by POST /api/v1/setup (or mint one with POST /api/v1/setup/recover).");
  }
}
