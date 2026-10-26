import type { DropwayContext } from "../context";
import { siteUrl } from "../context";
import { hmacHex, timingSafeEqualStr } from "../lib/crypto";
import type { Principal } from "../principal";
import type { LiveSite } from "./live";
import { canAccess, findSite, type SiteRow, type VersionRow } from "./sites";
import { capabilityDecision } from "./policy";

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const payload = (siteId: string, versionId: string, expiresAt: number) => `dw-preview:${siteId}:${versionId}:${expiresAt}`;

/** A bearer capability for one version, independent of the eventually consistent live pointer. */
export async function versionPreviewUrl(dc: DropwayContext, principal: Principal, site: Pick<SiteRow, "id" | "slug" | "tenant_id">, version: Pick<VersionRow, "id" | "number">): Promise<string | undefined> {
  if (!(await capabilityDecision(dc, principal, "version_previews", { siteId: site.id, tenantId: site.tenant_id })).allowed) return undefined;
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const signature = await hmacHex(dc.config.signingSecret, payload(site.id, version.id, expiresAt));
  return `${siteUrl(dc, `${site.slug}--v${version.number}`)}?dw_preview=${expiresAt}.${signature}`;
}

/** Read a ready version from D1 only, after checking its owner or exact signed capability. */
export async function readVersionPreview(
  dc: DropwayContext,
  principal: Principal,
  slug: string,
  number: number,
  token: string | null,
): Promise<{ live: LiveSite; expiresAt: number | null } | null> {
  const site = await findSite(dc, slug);
  if (!site || site.mode === "transfer" || (site.expires_at !== null && site.expires_at < Date.now())) return null;
  if (!(await capabilityDecision(dc, principal, "version_previews", { siteId: site.id, tenantId: site.tenant_id })).allowed) return null;
  const version = await dc.env.DB.prepare("SELECT id FROM versions WHERE site_id = ? AND number = ? AND status = 'ready'")
    .bind(site.id, number).first<{ id: string }>();
  if (!version) return null;
  let expiresAt: number | null = null;
  if (token !== null) {
    const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(token);
    if (!match) return null;
    expiresAt = Number(match[1]);
    if (Date.now() >= expiresAt || expiresAt > Date.now() + PREVIEW_TTL_MS || !timingSafeEqualStr(
      await hmacHex(dc.config.signingSecret, payload(site.id, version.id, expiresAt)), match[2]!,
    )) return null;
  } else if (!canAccess(principal, site, "sites:read")) return null;

  const files: LiveSite["files"] = Object.create(null);
  const { results } = await dc.env.DB.prepare("SELECT path, sha256, size, content_type FROM version_files WHERE version_id = ?")
    .bind(version.id).all<{ path: string; sha256: string; size: number; content_type: string }>();
  for (const file of results) files[file.path] = [file.sha256, file.size, file.content_type];
  return {
    expiresAt,
    live: {
      v: 3,
      siteId: site.id,
      slug: site.slug,
      tenantId: site.tenant_id,
      versionId: version.id,
      spa: site.spa === 1,
      renderMarkdown: site.render_markdown === 1,
      crossOriginIsolation: site.cross_origin_isolation === 1,
      passwordHash: site.password_hash,
      expiresAt: site.expires_at,
      files,
    },
  };
}
