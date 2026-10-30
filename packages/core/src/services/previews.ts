import type { DropwayContext } from "../context";
import { siteUrl } from "../context";
import { hmacHex, timingSafeEqualStr } from "../lib/crypto";
import type { Principal } from "../principal";
import type { LiveSite } from "./live";
import { canAccess, findSite, type SiteRow, type VersionRow } from "./sites";
import { capabilityDecision } from "./policy";
import { parseSiteConfigJson } from "./site-config";

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const payload = (siteId: string, versionId: string, expiresAt: number) => `dw-preview:${siteId}:${versionId}:${expiresAt}`;

/** A bearer capability for one version, independent of the eventually consistent live pointer. */
export async function versionPreviewUrl(dc: DropwayContext, principal: Principal, site: Pick<SiteRow, "id" | "slug" | "tenant_id">, version: Pick<VersionRow, "id" | "number">): Promise<string | undefined> {
  try {
    const url = new URL(siteUrl(dc, `${site.slug}--v${version.number}`));
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
    if (!(await capabilityDecision(dc, principal, "version_previews", { siteId: site.id, tenantId: site.tenant_id })).allowed) return undefined;
    const expiresAt = Date.now() + PREVIEW_TTL_MS;
    const signature = await hmacHex(dc.config.signingSecret, payload(site.id, version.id, expiresAt));
    url.searchParams.set("dw_preview", `${expiresAt}.${signature}`);
    return url.toString();
  } catch {
    // Callers invoke this after the version is already committed live. Preserve
    // that success response without the optional link rather than reporting a
    // false failure; log only the event, never the secret or signed URL.
    console.error(JSON.stringify({ event: "version_preview_url_failed", operation: "versionPreviewUrl" }));
    return undefined;
  }
}

/**
 * Per-isolate cache of immutable ready-version file maps: one preview page
 * load fetches many assets from the same version, and each load would
 * otherwise re-read every manifest row from D1. Only the file map is reused;
 * authorization and ready-status checks run on every request before it.
 */
const FILES_TTL_MS = 5_000;
const FILES_MAX = 32;
const filesMemory = new Map<string, { at: number; files: LiveSite["files"] }>();

async function versionFiles(dc: DropwayContext, versionId: string): Promise<LiveSite["files"]> {
  const hit = filesMemory.get(versionId);
  if (hit && Date.now() - hit.at < FILES_TTL_MS) return hit.files;
  const files: LiveSite["files"] = Object.create(null);
  const { results } = await dc.env.DB.prepare("SELECT path, sha256, size, content_type FROM version_files WHERE version_id = ?")
    .bind(versionId).all<{ path: string; sha256: string; size: number; content_type: string }>();
  for (const file of results) files[file.path] = [file.sha256, file.size, file.content_type];
  if (filesMemory.size >= FILES_MAX) filesMemory.delete(filesMemory.keys().next().value!);
  filesMemory.set(versionId, { at: Date.now(), files });
  return files;
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
  const version = await dc.env.DB.prepare("SELECT id, config_json FROM versions WHERE site_id = ? AND number = ? AND status = 'ready'")
    .bind(site.id, number).first<{ id: string; config_json: string | null }>();
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

  const files = await versionFiles(dc, version.id);
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
      noindex: site.noindex === 1,
      viewers: site.viewers !== 0,
      config: parseSiteConfigJson(version.config_json),
      passwordHash: site.password_hash,
      expiresAt: site.expires_at,
      files,
    },
  };
}
