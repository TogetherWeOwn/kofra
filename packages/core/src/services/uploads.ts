import type { DropwayContext } from "../context";
import { appOrigin } from "../context";
import { canAccess, serializeVersion, type SiteRow, type VersionRow } from "./sites";
import { missingForScope } from "./deploys";
import { blobScope } from "./blobs";
import { createUploadToken, PENDING_VERSION_TTL_MS } from "./upload-tokens";
import type { Principal } from "../principal";

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
