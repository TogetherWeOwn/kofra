import { siteUrl, type DropwayContext } from "../context";
import type { Principal } from "../principal";
import { badRequest } from "../errors";
import type { SiteRow } from "./sites";
import { deleteVersion, restoreVersion } from "./deploys";
import { idempotencyScope, validateIdempotencyKey, withIdempotency } from "./idempotency";
import { getSiteByRef, isLiveVersionRef, requireConfirm, resolveVersionRef } from "./site-ops";

interface VersionActionOptions {
  transport: "rest" | "mcp";
  idempotencyKey?: unknown;
}

async function replayVersionAction<T>(
  dc: DropwayContext, p: Principal, action: "restore" | "delete", siteRef: unknown,
  versionRef: unknown, confirm: unknown, opts: VersionActionOptions, run: (site: SiteRow) => Promise<T>,
) {
  // Re-authorize even a completed key, but do not require a deleted target to exist.
  const site = await getSiteByRef(dc, p, siteRef, action === "restore" ? "sites:write" : "sites:delete");
  if (action === "delete") requireConfirm(confirm, site.slug);
  if (opts.idempotencyKey === "") {
    throw badRequest("invalid_idempotency_key", "The idempotency key must not be empty.", "Use a fresh UUID per logical operation, and reuse it only for the exact same request.");
  }
  const { result, replayed } = await withIdempotency(dc, {
    scope: idempotencyScope(p), operation: `${opts.transport}:${action}_version`,
    key: validateIdempotencyKey(opts.idempotencyKey),
    input: { site: site.id, version: versionRef, ...(action === "delete" ? { confirm } : {}) },
    retainOnError: true,
  }, () => run(site));
  return replayed ? { ...result, replayed: true as const } : result;
}

/** Replay the first restore receipt, never a fresh interpretation of a version reference. */
export async function restoreVersionByRef(dc: DropwayContext, p: Principal, siteRef: unknown, versionRef: unknown, opts: VersionActionOptions) {
  return replayVersionAction(dc, p, "restore", siteRef, versionRef, undefined, opts, async site => {
    const symbolicLive = isLiveVersionRef(versionRef);
    const versionId = symbolicLive ? "live" : (await resolveVersionRef(dc, site, versionRef)).id;
    const result = await restoreVersion(dc, p, site, versionId, { symbolicLive });
    return { ...result, slug: site.slug, url: siteUrl(dc, site.slug) };
  });
}

/** Confirm and authorize before replay; resolve the target only for the claim's owner. */
export async function deleteVersionByRef(dc: DropwayContext, p: Principal, siteRef: unknown, versionRef: unknown, confirm: unknown, opts: VersionActionOptions) {
  return replayVersionAction(dc, p, "delete", siteRef, versionRef, confirm, opts, async site => {
    const version = await resolveVersionRef(dc, site, versionRef);
    return deleteVersion(dc, p, site, version.id);
  });
}
