import type { DropwayContext } from "../context";

/**
 * The "live manifest": everything the edge needs to serve a site, cached in KV
 * under live:<slug>. D1 is the source of truth; KV is rewritten on every change
 * (finalize, restore, settings, claim, delete) and rebuilt from D1 on a miss.
 * Files are stored compactly as path -> [sha256, size, contentType].
 * v3: filename maps are prototype-less, so legal names like __proto__ survive
 * as own keys; older cached entries are treated as a miss and rebuilt from D1.
 * v4: adds the live version's number and go-live time (the embeddable badge reads
 * them from this entry, so it costs no extra D1 or R2 read); v3 entries are rebuilt.
 * v5: read fills are verified against D1 (fillLive); v4 entries may hold an unverified
 * fill that overwrote a later change, so they are rebuilt too.
 */
export interface LiveSite {
  /** Older versions are stale (rebuilt on read); fresh writes are LIVE_VERSION. */
  v: 2 | 3 | 4 | 5;
  siteId: string;
  slug: string;
  tenantId: string | null;
  versionId: string | null;
  /** Sequence number of the live version (null: nothing live). Always set on v4 entries. */
  versionNumber?: number | null;
  /** When the live version was finalized, epoch ms (null: nothing live). Always set on v4 entries. */
  versionAt?: number | null;
  spa: boolean;
  renderMarkdown: boolean;
  crossOriginIsolation: boolean;
  passwordHash: string | null;
  expiresAt: number | null;
  files: Record<string, [sha256: string, size: number, contentType: string]>;
}

export const liveKey = (slug: string) => `live:${slug}`;

const LIVE_VERSION = 5;

/** KV's minimum expirationTtl; caps a read-path fill that D1 could not verify. */
const UNVERIFIED_FILL_TTL_SECONDS = 60;

/** Copy own file entries into a prototype-less map, preserving an own __proto__ key. */
function ownFiles(files: LiveSite["files"]): LiveSite["files"] {
  const out: LiveSite["files"] = Object.create(null);
  for (const k of Object.keys(files)) out[k] = files[k]!;
  return out;
}

/** Per-isolate memory cache: one page load fetches many files from the same site. */
const MEMORY_TTL_MS = 5_000;
const MEMORY_MAX = 500;
const memory = new Map<string, { at: number; live: LiveSite | null }>();
/**
 * Per-slug read fence, shared by a slug's in-flight reads and released by the last one.
 * refreshLive and dropLive remove it, so a read that started before a change cannot put
 * its older snapshot back into memory (a password change or delete would be undone for
 * up to MEMORY_TTL_MS).
 */
const reading = new Map<string, { active: number }>();

function remember(slug: string, live: LiveSite | null) {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value!);
  memory.set(slug, { at: Date.now(), live });
}

/** For tests. */
export function clearLiveMemoryCache() {
  memory.clear();
  reading.clear();
}

/** For tests: distinct slugs with an in-flight read fence. */
export function getLiveReadFenceCountForTests(): number {
  return reading.size;
}

export async function getLiveSite(dc: DropwayContext, slug: string): Promise<LiveSite | null> {
  const hit = memory.get(slug);
  if (hit && Date.now() - hit.at < MEMORY_TTL_MS) return hit.live;
  const fence = reading.get(slug) ?? { active: 0 };
  reading.set(slug, fence);
  fence.active++;
  try {
    const cached = await dc.env.CACHE.get<LiveSite>(liveKey(slug), { type: "json", cacheTtl: dc.config.liveCacheTtlSeconds }).catch(() => null);
    if (cached && cached.v === LIVE_VERSION && cached.files && typeof cached.files === "object") {
      cached.files = ownFiles(cached.files);
      if (reading.get(slug) === fence) remember(slug, cached);
      return cached;
    }
    const live = await loadLiveSiteFromD1(dc, { slug });
    if (reading.get(slug) === fence) remember(slug, live);
    if (live) dc.waitUntil(fillLive(dc, live).catch(() => {}));
    return live;
  } finally {
    if (--fence.active === 0 && reading.get(slug) === fence) reading.delete(slug);
  }
}

/**
 * Read-path fill. The D1 read above may predate a deploy whose refreshLive lands before this put, so
 * the put could overwrite a fresher manifest. Re-read D1 after the put: a change committed before the
 * re-read is seen and the key is dropped (the next read rebuilds it); one committed after it is
 * followed by its own refreshLive, which lands after this put. Either way a stale fill cannot stick.
 * If the re-read itself fails, keep serving the fill (D1 may be down) but cap it to KV's minimum TTL
 * so an unverified entry is re-checked soon instead of living on.
 */
async function fillLive(dc: DropwayContext, live: LiveSite): Promise<void> {
  await putLive(dc, live);
  let now: LiveSite | null;
  try {
    // The site row is enough: a finalized version's files never change, and a version deleted
    // mid-read (its file query came back empty) is no longer current, so its id differs here.
    now = await loadLiveSiteFromD1(dc, { siteId: live.siteId }, false);
  } catch {
    await putLive(dc, live, UNVERIFIED_FILL_TTL_SECONDS);
    return;
  }
  if (!now || !sameSettings(now, live)) await dropLive(dc, live.slug);
}

/** Field-by-field equality of everything but the file map. */
function sameSettings(a: LiveSite, b: LiveSite): boolean {
  const { files: _af, ...ar } = a;
  const { files: _bf, ...br } = b;
  const keys = Object.keys(ar) as (keyof typeof ar)[];
  return keys.length === Object.keys(br).length && keys.every((k) => ar[k] === br[k]);
}

/** withFiles = false skips the version_files query and returns an empty file map. */
export async function loadLiveSiteFromD1(dc: DropwayContext, by: { slug?: string; siteId?: string }, withFiles = true): Promise<LiveSite | null> {
  const site = await dc.env.DB.prepare(
    `SELECT s.id, s.slug, s.tenant_id, s.current_version_id, s.spa, s.render_markdown, s.cross_origin_isolation, s.password_hash, s.expires_at,
            v.number AS version_number, COALESCE(v.finalized_at, v.created_at) AS version_at
       FROM sites s LEFT JOIN versions v ON v.id = s.current_version_id WHERE s.${by.siteId ? "id" : "slug"} = ? AND s.deleted_at IS NULL`,
  )
    .bind(by.siteId ?? by.slug)
    .first<{
      id: string;
      slug: string;
      tenant_id: string | null;
      current_version_id: string | null;
      version_number: number | null;
      version_at: number | null;
      spa: number;
      render_markdown: number;
      cross_origin_isolation: number;
      password_hash: string | null;
      expires_at: number | null;
    }>();
  if (!site) return null;
  const files: LiveSite["files"] = Object.create(null);
  if (site.current_version_id && withFiles) {
    const { results } = await dc.env.DB.prepare("SELECT path, sha256, size, content_type FROM version_files WHERE version_id = ?")
      .bind(site.current_version_id)
      .all<{ path: string; sha256: string; size: number; content_type: string }>();
    for (const f of results) files[f.path] = [f.sha256, f.size, f.content_type];
  }
  return {
    v: LIVE_VERSION,
    siteId: site.id,
    slug: site.slug,
    tenantId: site.tenant_id,
    versionId: site.current_version_id,
    versionNumber: site.version_number,
    versionAt: site.version_at,
    spa: site.spa === 1,
    renderMarkdown: site.render_markdown === 1,
    crossOriginIsolation: site.cross_origin_isolation === 1,
    passwordHash: site.password_hash,
    expiresAt: site.expires_at,
    files,
  };
}

async function putLive(dc: DropwayContext, live: LiveSite, maxTtlSeconds?: number): Promise<void> {
  const opts: KVNamespacePutOptions = {};
  if (live.expiresAt) {
    // Keep the key a little past expiry so visitors get a clear "expired" page, then let KV drop it.
    opts.expirationTtl = Math.max(60, Math.ceil((live.expiresAt - Date.now()) / 1000) + 3600);
  }
  if (maxTtlSeconds !== undefined) opts.expirationTtl = Math.min(opts.expirationTtl ?? maxTtlSeconds, maxTtlSeconds);
  await dc.env.CACHE.put(liveKey(live.slug), JSON.stringify(live), opts);
}

/** Rebuild the KV entry for a site from D1. Call after any change that affects serving. */
export async function refreshLive(dc: DropwayContext, siteId: string): Promise<LiveSite | null> {
  const live = await loadLiveSiteFromD1(dc, { siteId });
  if (live) {
    reading.delete(live.slug);
    remember(live.slug, live);
    await putLive(dc, live);
  }
  return live;
}

export async function dropLive(dc: DropwayContext, slug: string): Promise<void> {
  reading.delete(slug);
  memory.delete(slug);
  await dc.env.CACHE.delete(liveKey(slug));
}
