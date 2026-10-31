import type { DropwayContext } from "../context";

/**
 * The "live manifest": everything the edge needs to serve a site, cached in KV
 * under live:<slug>. D1 is the source of truth; KV is rewritten on every change
 * (finalize, restore, settings, claim, delete); misses are read from D1.
 * Files are stored compactly as path -> [sha256, size, contentType].
 * v3: filename maps are prototype-less, so legal names like __proto__ survive
 * as own keys; older cached entries are treated as a miss and read from D1.
 * v4: adds the live version's number and go-live time (the embeddable badge reads
 * them from this entry, so it costs no extra D1 or R2 read).
 * v5: rejects older entries that may have been poisoned by delayed miss fills.
 */
export interface LiveSite {
  /** Older versions are stale (read from D1); fresh writes are LIVE_VERSION. */
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
// Shared only by outstanding reads of a slug, then released. Mutations remove
// the fence so older reads cannot replace their memory state, including deletes.
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

/** For tests: distinct slugs with outstanding read fences. */
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
    const live = await loadLiveSiteFromD1(dc, { slug }, true);
    if (reading.get(slug) === fence) remember(slug, live);
    // Never fill the mutable live pointer from a miss: this D1 snapshot may
    // have been superseded on another isolate. Only immutable version files
    // may be filled from reads; serving settings stay in the short-lived cache.
    return live;
  } finally {
    if (--fence.active === 0 && reading.get(slug) === fence) reading.delete(slug);
  }
}

// Mutations use the default authoritative file read; serving misses may reuse
// immutable version files, but always select the current settings/version in D1.
export async function loadLiveSiteFromD1(dc: DropwayContext, by: { slug?: string; siteId?: string }, cacheVersionFiles = false): Promise<LiveSite | null> {
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
  const files = site.current_version_id
    ? await loadVersionFiles(dc, site.id, site.current_version_id, cacheVersionFiles)
    : Object.create(null) as LiveSite["files"];
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

async function loadVersionFiles(dc: DropwayContext, siteId: string, versionId: string, cacheFiles: boolean): Promise<LiveSite["files"]> {
  const key = `live-files:v1:${siteId}:${versionId}`;
  if (cacheFiles) {
    const cached = await dc.env.CACHE.get<LiveSite["files"]>(key, { type: "json", cacheTtl: dc.config.liveCacheTtlSeconds }).catch(() => null);
    if (cached && typeof cached === "object" && !Array.isArray(cached)) return ownFiles(cached);
  }
  const files: LiveSite["files"] = Object.create(null);
  const { results } = await dc.env.DB.prepare("SELECT path, sha256, size, content_type FROM version_files WHERE version_id = ?")
    .bind(versionId)
    .all<{ path: string; sha256: string; size: number; content_type: string }>();
  for (const f of results) files[f.path] = [f.sha256, f.size, f.content_type];
  if (cacheFiles && results.length > 0) {
    // Finalized versions never change. A delayed fill can only cache those
    // exact files, not revive a slug, change its password or replace its pointer.
    // No rows means the version was deleted after the site row was read (files
    // are deleted atomically); caching {} would outlive it, e.g. across a D1 restore.
    dc.waitUntil(dc.env.CACHE.put(key, JSON.stringify(files), { expirationTtl: 86_400 }).catch(() => {}));
  }
  return files;
}

async function putLive(dc: DropwayContext, live: LiveSite): Promise<void> {
  const opts: KVNamespacePutOptions = {};
  if (live.expiresAt) {
    // Keep the key a little past expiry so visitors get a clear "expired" page, then let KV drop it.
    opts.expirationTtl = Math.max(60, Math.ceil((live.expiresAt - Date.now()) / 1000) + 3600);
  }
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
