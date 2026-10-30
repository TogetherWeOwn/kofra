import type { AtomicWriteExtension } from "../adapters";
import type { DropwayContext } from "../context";
import { conflict, type ApiError } from "../errors";
import type { SiteRow } from "./sites";

/** Abort the whole delete batch if a rename, claim or expiry renewal overtook its read. */
export function assertSiteDeletionState(dc: DropwayContext, site: SiteRow): D1PreparedStatement {
  return dc.env.DB.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM sites WHERE id = ? AND slug = ? AND tenant_id IS ? AND created_by IS ?
      AND slug_chosen = ? AND expires_at IS ? AND claim_token_hash IS ? AND deleted_at IS NULL
  ) THEN 1 ELSE json_extract('{}', 'dropway_delete_site_changed') END`)
    .bind(site.id, site.slug, site.tenant_id, site.created_by, site.slug_chosen, site.expires_at, site.claim_token_hash);
}

/** Recognize only our transaction assertion, never an unrelated SQL failure. */
export function siteDeletionStateChanged(error: unknown): boolean {
  return String(error).includes("JSON path") && String(error).includes("dropway_delete_site_changed");
}

/** Only SQL errors reach the mappers; preparation errors keep their identity. */
export async function atomicWrite(
  dc: DropwayContext,
  core: readonly D1PreparedStatement[],
  extension?: AtomicWriteExtension,
  mapCoreError?: (error: unknown) => ApiError | undefined,
): Promise<void> {
  try {
    await dc.env.DB.batch([...core, ...(extension?.statements ?? [])]);
  } catch (error) {
    throw mapCoreError?.(error) ?? extension?.mapError?.(error) ?? error;
  }
}

/** Do not confuse another table's UNIQUE constraint with a site-name collision. */
export function siteSlugError(error: unknown, slug: string, hint: string): ApiError | undefined {
  if (/\bUNIQUE constraint failed: sites\.slug(?=:|$)/.test(String(error)) || /\btransfer_slug_reserved(?=:|$)/.test(String(error))) {
    return conflict("slug_taken", `The site name "${slug}" is taken.`, hint);
  }
  // Race backstop for R-59 holds (the common case already got a precise error
  // from checkNameAvailable before the batch ran).
  if (/\bslug_name_held(?=:|$)/.test(String(error)) || /\bslug_name_redirect(?=:|$)/.test(String(error))) {
    return conflict("slug_reserved", `The site name "${slug}" is held for its previous owner.`, hint);
  }
  return undefined;
}
