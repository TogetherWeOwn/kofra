import type { DropwayContext } from "../context";
import { appOrigin, siteUrl } from "../context";
import { ApiError, badRequest, conflict, forbidden, notFound, rateLimited, unauthorized } from "../errors";
import { hashPassword, newId, newSecret, sha256Hex } from "../lib/crypto";
import { generateSlug, validateSlug } from "../lib/slug";
import { hasScope, type Principal, type Scope } from "../principal";
import { CLAIM_TOKEN_PREFIX } from "./identity";
import { dropLive, refreshLive } from "./live";
import { emit, meter } from "./events";
import { requireCapability, requireQuota, quotaExceeded } from "./policy";
import { getUsage, incrementalBytes, PROJECTED_STORAGE_SQL, usageStatements } from "./usage";
import { assertSiteDeletionState, atomicWrite, siteDeletionStateChanged, siteSlugError } from "./atomic-write";
import { checkNameAvailable, convertRedirectsStatements, insertTombstone, reclaimTombstone } from "./slug-holds";

export interface SiteRow {
  id: string;
  mode?: "site" | "transfer";
  slug: string;
  /** 1 when the current name was explicitly chosen, 0 when generated (decides the R-59 hold after delete/expiry). */
  slug_chosen: number;
  tenant_id: string | null;
  created_by: string | null;
  folder_id: string | null;
  title: string | null;
  description: string | null;
  spa: number;
  render_markdown: number;
  cross_origin_isolation: number;
  password_hash: string | null;
  current_version_id: string | null;
  claim_token_hash: string | null;
  creator_ip_hash: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface VersionRow {
  id: string;
  site_id: string;
  number: number;
  status: "pending" | "ready";
  file_count: number;
  total_bytes: number;
  manifest_hash: string;
  base_version_id: string | null;
  source: string;
  client: string | null;
  message: string | null;
  created_by: string | null;
  created_at: number;
  finalized_at: number | null;
}

export interface SiteSettingsInput {
  title?: string | null;
  description?: string | null;
  spa?: boolean;
  renderMarkdown?: boolean;
  crossOriginIsolation?: boolean;
  /** Set a visitor password; null removes it. */
  password?: string | null;
}

const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);

/** May `p` read (sites:read) or change (sites:write) this site? */
export function canAccess(p: Principal, site: Pick<SiteRow, "id" | "tenant_id"> & Partial<Pick<SiteRow, "mode" | "created_by">>, scope: Scope): boolean {
  if (site.mode === "transfer" && (p.kind !== "member" || site.created_by !== p.memberId)) return false;
  if (p.kind === "member") return site.tenant_id === p.tenantId && hasScope(p, scope) && (!p.siteId || p.siteId === site.id);
  if (p.kind === "claim") return site.id === p.siteId && site.tenant_id === null;
  return false;
}

export async function findSite(dc: DropwayContext, slug: string): Promise<SiteRow | null> {
  return dc.env.DB.prepare("SELECT * FROM sites WHERE slug = ? AND deleted_at IS NULL").bind(slug.toLowerCase()).first<SiteRow>();
}

/** Load a site the caller may access. Unknown and foreign sites both 404, so existence never leaks. */
export async function getSiteFor(dc: DropwayContext, p: Principal, slug: string, scope: Scope = "sites:read"): Promise<SiteRow> {
  if (p.kind === "anonymous") throw unauthorized("This needs the site owner's API key, or the claim token of an anonymous site.");
  if (p.kind === "bootstrap") throw forbidden("The bootstrap key can only set up the instance.", "Use the owner API key from POST /api/v1/setup.");
  const site = await findSite(dc, slug);
  if (!site || !canAccess(p, site, "sites:read")) {
    throw notFound("site_not_found", `No site "${slug}" that this key can access.`, "List your sites with GET /api/v1/sites.");
  }
  if (!canAccess(p, site, scope)) {
    throw forbidden(`This key lacks the "${scope}" scope for "${slug}".`, "Use a key with that scope.", "insufficient_scope");
  }
  return site;
}

export async function getVersion(dc: DropwayContext, siteId: string, versionId: string): Promise<VersionRow | null> {
  return dc.env.DB.prepare("SELECT * FROM versions WHERE id = ? AND site_id = ?").bind(versionId, siteId).first<VersionRow>();
}

export function serializeVersion(v: VersionRow, liveVersionId: string | null) {
  return {
    id: v.id,
    number: v.number,
    status: v.status,
    live: v.id === liveVersionId,
    fileCount: v.file_count,
    totalBytes: v.total_bytes,
    source: v.source,
    client: v.client,
    message: v.message,
    createdAt: iso(v.created_at),
    finalizedAt: iso(v.finalized_at),
  };
}

export function serializeSite(dc: DropwayContext, site: SiteRow, current?: VersionRow | null) {
  const api = `${appOrigin(dc)}/api/v1/sites/${site.slug}`;
  return {
    slug: site.slug,
    url: siteUrl(dc, site.slug),
    title: site.title,
    description: site.description,
    anonymous: site.tenant_id === null,
    expiresAt: iso(site.expires_at),
    settings: {
      spa: site.spa === 1,
      renderMarkdown: site.render_markdown === 1,
      crossOriginIsolation: site.cross_origin_isolation === 1,
      passwordProtected: !!site.password_hash,
    },
    currentVersionId: site.current_version_id,
    currentVersion: current ? serializeVersion(current, site.current_version_id) : null,
    createdAt: iso(site.created_at),
    updatedAt: iso(site.updated_at),
    links: { self: api, deploys: `${api}/deploys`, versions: `${api}/versions`, files: `${api}/files` },
  };
}

/** serializeSite, loading the current version row. */
export async function describeSite(dc: DropwayContext, site: SiteRow) {
  const current = site.current_version_id ? await getVersion(dc, site.id, site.current_version_id) : null;
  return serializeSite(dc, site, current);
}

function boolField(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1" || v === 1) return true;
  if (v === "false" || v === "0" || v === 0) return false;
  throw badRequest("invalid_field", `${name} must be true or false.`);
}

/** Parse the settings fields shared by create, publish and PATCH. */
export function parseSettings(body: Record<string, unknown>): SiteSettingsInput {
  const out: SiteSettingsInput = {};
  if ("title" in body) out.title = body.title == null ? null : String(body.title).slice(0, 200);
  if ("description" in body) out.description = body.description == null ? null : String(body.description).slice(0, 2000);
  const spa = boolField(body.spa, "spa");
  if (spa !== undefined) out.spa = spa;
  const md = boolField(body.renderMarkdown, "renderMarkdown");
  if (md !== undefined) out.renderMarkdown = md;
  const coi = boolField(body.crossOriginIsolation, "crossOriginIsolation");
  if (coi !== undefined) out.crossOriginIsolation = coi;
  if ("password" in body) {
    if (body.password === null || body.password === "") out.password = null;
    else {
      const pw = String(body.password);
      if (pw.length < 4 || pw.length > 200) throw badRequest("invalid_password", "Passwords must be 4-200 characters.");
      out.password = pw;
    }
  }
  return out;
}

/** Salted hash of the caller IP, for anonymous rate limits without storing raw IPs. */
export async function ipHash(dc: DropwayContext, ip: string): Promise<string> {
  return (await sha256Hex(`${dc.config.signingSecret}:${ip}`)).slice(0, 32);
}

export function anonymousDisabled(): ApiError {
  return unauthorized(
    "This instance does not accept anonymous publishing.",
    "Send `Authorization: Bearer dw_...` with an API key from the instance owner. (Self-hosters: set ANONYMOUS_PUBLISH=true to allow anonymous sites.)",
    "anonymous_publish_disabled",
  );
}

export interface CreateSiteOptions {
  /**
   * Runs after every permission, rate-limit and policy check, just before the row
   * is written. Throw to refuse without creating anything (used to validate the
   * first deploy's manifest up front).
   */
  beforeInsert?(owner: { tenantId: string | null }): void | Promise<void>;
}

export async function createSite(
  dc: DropwayContext,
  p: Principal,
  input: { slug?: string | null } & SiteSettingsInput,
  opts: CreateSiteOptions = {},
): Promise<{ site: SiteRow; claimToken: string | null }> {
  if (p.kind === "bootstrap") throw forbidden("The bootstrap key cannot own sites.", "Use the owner API key returned by POST /api/v1/setup.");
  if (p.kind === "claim") throw forbidden("A claim token controls exactly one anonymous site.", "Use an API key to create more sites.");
  if (p.kind === "member") {
    if (!hasScope(p, "sites:write")) throw forbidden('This key lacks the "sites:write" scope.', undefined, "insufficient_scope");
    if (p.siteId) throw forbidden("This key is restricted to one site and cannot create others.", undefined, "key_site_restricted");
  }
  const anonymous = p.kind === "anonymous";
  const now = Date.now();
  let creatorIp: string | null = null;

  if (anonymous) {
    if (!dc.config.anonymous.enabled) throw anonymousDisabled();
    await requireCapability(dc, p, "anonymous_publish");
    if (input.slug) throw forbidden("Choosing a site name needs an API key.", "Omit slug to get a generated name.");
    if (input.password) throw forbidden("Password protection needs an API key.");
    creatorIp = await ipHash(dc, p.ip);
    const recent = await dc.env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE creator_ip_hash = ? AND created_at > ?")
      .bind(creatorIp, now - 3600_000)
      .first<{ n: number }>();
    const cap = dc.config.anonymous.sitesPerHourPerIp;
    if ((recent?.n ?? 0) >= cap) {
      throw rateLimited(`Anonymous publishing is limited to ${cap} new sites per hour per IP.`, "Wait and retry, update your existing site with its claim token, or use an API key.", 3600);
    }
  }
  const tenantId = p.kind === "member" ? p.tenantId : null;
  const wanted = input.slug ? validateSlug(input.slug) : null;
  if (wanted) await checkNameAvailable(dc, wanted, tenantId, null);
  const owner = { siteId: null, tenantId };
  if (input.password) await requireCapability(dc, p, "site_password", owner);
  const siteQuota = tenantId === null ? null : await requireQuota(dc, p, "sites", owner, (await getUsage(dc, tenantId)).sites, 1);
  await dc.adapters.policy.beforeCreateSite?.(p, { slug: wanted, tenantId }, dc);
  await opts.beforeInsert?.({ tenantId });

  const claimToken = anonymous ? newSecret(CLAIM_TOKEN_PREFIX) : null;
  const claimHash = claimToken ? await sha256Hex(claimToken) : null;
  const passwordHash = input.password ? await hashPassword(input.password) : null;

  for (let attempt = 0; attempt < 6; attempt++) {
    const site: SiteRow = {
      id: newId("site"),
      mode: "site",
      slug: wanted ?? generateSlug(),
      slug_chosen: wanted ? 1 : 0,
      tenant_id: tenantId,
      created_by: p.kind === "member" ? p.memberId : "anonymous",
      folder_id: null,
      title: input.title ?? null,
      description: input.description ?? null,
      spa: input.spa ? 1 : 0,
      render_markdown: input.renderMarkdown === false ? 0 : 1,
      cross_origin_isolation: input.crossOriginIsolation ? 1 : 0,
      password_hash: passwordHash,
      current_version_id: null,
      claim_token_hash: claimHash,
      creator_ip_hash: creatorIp,
      expires_at: anonymous ? now + dc.config.anonymous.ttlMs : null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    try {
      const extension = await dc.adapters.policy.siteNameMutation?.(p, {
        operation: "create", siteId: site.id, tenantId, slug: site.slug, previousSlug: null,
      }, dc);
      await atomicWrite(dc, [
        // Reclaim the tenant's own hold on this name, if any, before the
        // INSERT fires the hold triggers. Anonymous creations never reclaim.
        ...(tenantId !== null ? [reclaimTombstone(dc, site.slug, tenantId)] : []),
        // Refuse inside the batch so neither core nor extension writes can commit
        // when another create consumed the last slot during preparation.
        dc.env.DB.prepare(`SELECT CASE WHEN ? IS NULL OR
          (SELECT COUNT(*) FROM sites WHERE tenant_id = ? AND deleted_at IS NULL) < ?
          THEN 1 ELSE json_extract('{}', 'dropway_sites_quota') END`).bind(siteQuota, tenantId, siteQuota),
        dc.env.DB.prepare(
          `INSERT INTO sites (id, slug, slug_chosen, tenant_id, created_by, title, description, spa, render_markdown, cross_origin_isolation,
             password_hash, claim_token_hash, creator_ip_hash, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          site.id, site.slug, site.slug_chosen, site.tenant_id, site.created_by, site.title, site.description, site.spa, site.render_markdown,
          site.cross_origin_isolation, site.password_hash, site.claim_token_hash, site.creator_ip_hash, site.expires_at,
          site.created_at, site.updated_at,
        ), ...usageStatements(dc, tenantId),
      ], extension, (error) => {
        if (String(error).includes("JSON path") && String(error).includes("dropway_sites_quota")) {
          return quotaExceeded("sites", siteQuota!);
        }
        return siteSlugError(error, site.slug, "Pick another slug, or omit it to get a generated one.");
      });
    } catch (e) {
      if (wanted || !(e instanceof ApiError) || e.status !== 409 || (e.code !== "slug_taken" && e.code !== "slug_reserved")) throw e;
      continue;
    }
    meter(dc, { type: "site_created", tenantId, siteId: site.id, anonymous, at: now });
    return { site, claimToken };
  }
  throw new ApiError(503, "slug_generation_failed", "Could not generate a free site name.", "Retry the request.");
}

export async function listSites(dc: DropwayContext, p: Principal, opts: { limit?: number; cursor?: string | null } = {}) {
  if (p.kind !== "member") throw unauthorized("Listing sites needs an API key.");
  if (!hasScope(p, "sites:read")) throw forbidden('This key lacks the "sites:read" scope.', undefined, "insufficient_scope");
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  let before = Number.MAX_SAFE_INTEGER;
  let beforeId = "~";
  if (opts.cursor) {
    let decoded = "";
    try {
      decoded = atob(opts.cursor);
    } catch {
      /* invalid below */
    }
    const [t, id] = decoded.split("|");
    before = Number(t);
    beforeId = id ?? "~";
    if (!decoded || !Number.isFinite(before)) throw badRequest("invalid_cursor", "cursor is not valid.", "Pass the nextCursor value from the previous page.");
  }
  const { results } = await dc.env.DB.prepare(
    `SELECT s.*, v.id AS v_id, v.number AS v_number, v.status AS v_status, v.file_count AS v_file_count, v.total_bytes AS v_total_bytes,
            v.manifest_hash AS v_manifest_hash, v.base_version_id AS v_base_version_id, v.source AS v_source, v.client AS v_client,
            v.message AS v_message, v.created_by AS v_created_by, v.created_at AS v_created_at, v.finalized_at AS v_finalized_at
       FROM sites s LEFT JOIN versions v ON v.id = s.current_version_id
      WHERE s.tenant_id = ? AND s.deleted_at IS NULL AND (s.mode <> 'transfer' OR s.created_by = ?) ${p.siteId ? "AND s.id = ?" : ""}
        AND (s.created_at < ? OR (s.created_at = ? AND s.id < ?))
      ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
  )
    .bind(...[p.tenantId, p.memberId, ...(p.siteId ? [p.siteId] : []), before, before, beforeId, limit + 1])
    .all<SiteRow & Record<string, unknown>>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return {
    sites: page.map((r) => {
      const v: VersionRow | null = r.v_id
        ? {
            id: r.v_id as string,
            site_id: r.id,
            number: r.v_number as number,
            status: r.v_status as VersionRow["status"],
            file_count: r.v_file_count as number,
            total_bytes: r.v_total_bytes as number,
            manifest_hash: r.v_manifest_hash as string,
            base_version_id: r.v_base_version_id as string | null,
            source: r.v_source as string,
            client: r.v_client as string | null,
            message: r.v_message as string | null,
            created_by: r.v_created_by as string | null,
            created_at: r.v_created_at as number,
            finalized_at: r.v_finalized_at as number | null,
          }
        : null;
      return serializeSite(dc, r, v);
    }),
    nextCursor: results.length > limit && last ? btoa(`${last.created_at}|${last.id}`) : null,
  };
}

export async function updateSite(dc: DropwayContext, p: Principal, slug: string, input: SiteSettingsInput): Promise<SiteRow> {
  const site = await getSiteFor(dc, p, slug, "sites:write");
  if (site.mode === "transfer") throw conflict("transfer_immutable", "Use update_transfer to change delivery settings.", "Transfer passwords need current-password proof in the same call.");
  if (input.password && site.tenant_id === null) throw forbidden("Password protection needs an account. Claim the site first.");
  if (input.password) await requireCapability(dc, p, "site_password", { siteId: site.id, tenantId: site.tenant_id });
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, val: unknown) => {
    sets.push(`${col} = ?`);
    binds.push(val);
  };
  if (input.title !== undefined) set("title", input.title);
  if (input.description !== undefined) set("description", input.description);
  if (input.spa !== undefined) set("spa", input.spa ? 1 : 0);
  if (input.renderMarkdown !== undefined) set("render_markdown", input.renderMarkdown ? 1 : 0);
  if (input.crossOriginIsolation !== undefined) set("cross_origin_isolation", input.crossOriginIsolation ? 1 : 0);
  if (input.password !== undefined) set("password_hash", input.password ? await hashPassword(input.password) : null);
  if (!sets.length) return site;
  set("updated_at", Date.now());
  await dc.env.DB.prepare(`UPDATE sites SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, site.id).run();
  await refreshLive(dc, site.id);
  return (await dc.env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(site.id).first<SiteRow>())!;
}

/** Soft-delete: the name is tombstoned for its previous tenant (R-59); rows and unreferenced files are removed by the hourly cleanup. */
export async function deleteSite(dc: DropwayContext, p: Principal, slug: string): Promise<{ deleted: true; slug: string }> {
  const site = await getSiteFor(dc, p, slug, "sites:delete");
  const now = Date.now();
  const holdUntil = now + (site.slug_chosen === 1 ? dc.config.slugHolds.chosenMs : dc.config.slugHolds.generatedMs);
  // Transfers keep their permanent sender-owned reservations (XFR-04 instead of a time-boxed hold).
  const holdStatements = site.mode === "transfer"
    ? []
    : [
        insertTombstone(dc, { slug: site.slug, tenantId: site.tenant_id, siteId: site.id, chosen: site.slug_chosen === 1, holdUntil, reason: "delete", createdAt: now, deletedAt: now }),
        ...convertRedirectsStatements(dc, { siteId: site.id, tenantId: site.tenant_id, reason: "delete", now, deletedAt: now }),
      ];
  let results: D1Result[];
  try {
    results = await dc.env.DB.batch([
      assertSiteDeletionState(dc, site),
      dc.env.DB.prepare(`UPDATE sites SET deleted_at = ?, deleted_slug = slug, slug = ?, claim_token_hash = NULL
        WHERE id = ? AND deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM transfers WHERE site_id = sites.id AND legal_hold <> 0)`)
        .bind(now, `~deleted~${site.id}`, site.id),
      ...holdStatements,
      ...usageStatements(dc, site.tenant_id),
    ]);
  } catch (error) {
    if (siteDeletionStateChanged(error)) throw conflict("site_changed", "The site changed while preparing its deletion.", "Reload the site and retry deleting its current name.");
    throw error;
  }
  const [, deleted] = results;
  if (!deleted?.meta.changes) throw conflict("transfer_conflict", "This delivery is held or no longer available.", "Release the hold before deleting it; revocation remains available.");
  await dropLive(dc, site.slug);
  emit(dc, "onDelete", { site: { id: site.id, slug: site.slug, tenantId: site.tenant_id, url: siteUrl(dc, site.slug) }, principal: p, reason: "api", at: now });
  meter(dc, { type: "site_deleted", tenantId: site.tenant_id, siteId: site.id, at: now });
  return { deleted: true, slug: site.slug };
}

/**
 * Undo a site created earlier in the same call whose first deploy then failed,
 * so a failed create leaves nothing behind: the slug is free at once and the row
 * no longer counts toward per-IP or plan limits. Only a site that never went
 * live is removed (the guard makes a concurrent successful finalize win).
 * Uploaded blobs stay until the hourly cleanup collects unreferenced ones.
 */
export async function discardNewSite(dc: DropwayContext, site: Pick<SiteRow, "id" | "slug" | "tenant_id">): Promise<boolean> {
  const db = dc.env.DB;
  const neverLive = `EXISTS (SELECT 1 FROM sites s WHERE s.id = ? AND s.current_version_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM transfers t WHERE t.site_id = s.id AND (t.legal_hold <> 0 OR t.takedown_at IS NOT NULL)))`;
  try {
    const results = await db.batch([
      db.prepare(`DELETE FROM version_files WHERE version_id IN (SELECT id FROM versions WHERE site_id = ?) AND ${neverLive}`).bind(site.id, site.id),
      db.prepare(`DELETE FROM versions WHERE site_id = ? AND ${neverLive}`).bind(site.id, site.id),
      db.prepare(`DELETE FROM blob_scopes WHERE scope = ? AND ${neverLive}`).bind(`s:${site.id}`, site.id),
      db.prepare(`DELETE FROM sites WHERE id = ? AND ${neverLive}`).bind(site.id, site.id),
      ...usageStatements(dc, site.tenant_id),
    ]);
    const removed = (results[3]?.meta.changes ?? 0) > 0;
    if (removed) {
      await dropLive(dc, site.slug);
      meter(dc, { type: "site_deleted", tenantId: site.tenant_id, siteId: site.id, at: Date.now() });
    }
    return removed;
  } catch (e) {
    // Never mask the error that made the create fail; the site is left for its owner to delete.
    console.error(JSON.stringify({ event: "discard_new_site_failed", siteId: site.id, error: String(e) }));
    return false;
  }
}

/** Move an anonymous site into the caller's tenant: it stops expiring and the claim token stops working. */
export async function claimSite(dc: DropwayContext, p: Principal, slug: string, claimToken: unknown): Promise<SiteRow> {
  if (p.kind !== "member") throw unauthorized("Claiming a site needs an API key of the tenant that should own it.");
  if (!hasScope(p, "sites:write") || p.siteId) throw forbidden("This key cannot claim sites.", "Use a key with the sites:write scope.", "insufficient_scope");
  if (typeof claimToken !== "string" || !claimToken.startsWith(CLAIM_TOKEN_PREFIX)) {
    throw badRequest("claim_token_required", "Send the claimToken returned when the anonymous site was created.", 'Body: {"claimToken": "dwc_..."}');
  }
  const site = await findSite(dc, slug);
  if (site && site.mode !== "transfer" && site.tenant_id === p.tenantId && site.claim_token_hash === null) return site; // retry-safe
  if (!site || site.claim_token_hash !== (await sha256Hex(claimToken))) {
    throw notFound("site_not_found", `No anonymous site "${slug}" matches this claim token.`);
  }
  if (site.tenant_id) throw conflict("already_claimed", "This site already belongs to an account.");
  const owner = { siteId: site.id, tenantId: p.tenantId };
  const usage = await getUsage(dc, p.tenantId);
  const siteQuota = await requireQuota(dc, p, "sites", owner, usage.sites, 1);
  const { results: files } = await dc.env.DB.prepare(`SELECT vf.sha256, MAX(vf.size) AS size FROM version_files vf
    JOIN versions v ON v.id = vf.version_id WHERE v.site_id = ? AND v.status = 'ready' GROUP BY vf.sha256`).bind(site.id).all<{ sha256: string; size: number }>();
  const newBytes = await incrementalBytes(dc, p.tenantId, null, files);
  const storageQuota = await requireQuota(dc, p, "storage_bytes", owner, usage.storage_bytes, newBytes);
  await dc.adapters.policy.beforeCreateSite?.(p, { slug: site.slug, tenantId: p.tenantId }, dc);
  const now = Date.now();
  const [claimed] = await dc.env.DB.batch([
    dc.env.DB.prepare(`UPDATE sites SET tenant_id = ?, created_by = ?, claim_token_hash = NULL, expires_at = NULL, creator_ip_hash = NULL, updated_at = ?
      WHERE id = ? AND tenant_id IS NULL AND deleted_at IS NULL AND claim_token_hash = ?
        AND (? IS NULL OR (SELECT COUNT(*) FROM sites WHERE tenant_id = ? AND deleted_at IS NULL) < ?)
        AND (? IS NULL OR (${PROJECTED_STORAGE_SQL}) <= ?)`).bind(
      p.tenantId, p.memberId, now, site.id, site.claim_token_hash,
      siteQuota, p.tenantId, siteQuota,
      storageQuota, p.tenantId, site.id, null, storageQuota,
    ),
    // The tenant now owns the files the anonymous uploader proved it had.
    dc.env.DB.prepare(`INSERT OR IGNORE INTO blob_scopes (scope, sha256, created_at)
      SELECT ?, sha256, ? FROM blob_scopes WHERE scope = ?
       AND EXISTS (SELECT 1 FROM sites WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL)`).bind(
      `t:${p.tenantId}`, now, `s:${site.id}`, site.id, p.tenantId,
    ),
    ...usageStatements(dc, p.tenantId),
  ]);
  if (!claimed?.meta.changes) {
    const fresh = await findSite(dc, slug);
    if (!fresh) throw notFound("site_not_found", "The anonymous site is no longer available.");
    if (fresh.tenant_id === p.tenantId) return fresh;
    if (fresh?.tenant_id) throw conflict("already_claimed", "This site already belongs to an account.");
    if (siteQuota !== null && (await getUsage(dc, p.tenantId)).sites >= siteQuota) throw quotaExceeded("sites", siteQuota);
    if (storageQuota !== null) throw quotaExceeded("storage_bytes", storageQuota);
    throw notFound("site_not_found", "The anonymous site is no longer available.");
  }
  await refreshLive(dc, site.id);
  return { ...site, tenant_id: p.tenantId, created_by: p.memberId, claim_token_hash: null, expires_at: null, creator_ip_hash: null, updated_at: now };
}
