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
 */
export interface LiveSite {
  /** 2 = stale (rebuilt on read); fresh writes are LIVE_VERSION. */
  v: 2 | 3 | 4;
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

const LIVE_VERSION = 4;

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

function remember(slug: string, live: LiveSite | null) {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value!);
  memory.set(slug, { at: Date.now(), live });
}

/**
 * Cache API pointer memo (R-14): a 10 s copy of the live manifest shared by every isolate in the
 * data center, in front of KV. It is keyed by slug alone, so a publish, settings
 * change or delete in this data center rewrites or drops it (the next read refills it from KV); other data centers see a change within
 * the TTL (plus KV's own cacheTtl on a miss).
 */
const POINTER_TTL_SECONDS = 10;

function pointerRequest(slug: string): Request {
  // A fixed synthetic host, not the request's: the API host that publishes and the site host that
  // serves differ in subdomain and second-Worker setups, and both must reach the same entry.
  return new Request(`https://dropway.invalid/__dropway/ptr/${encodeURIComponent(slug)}`);
}

async function readPointer(dc: DropwayContext, slug: string): Promise<LiveSite | null> {
  if (typeof caches === "undefined") return null;
  try {
    const hit = await caches.default.match(pointerRequest(slug));
    return hit ? await hit.json<LiveSite>() : null;
  } catch {
    return null;
  }
}

async function writePointer(dc: DropwayContext, live: LiveSite): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    await caches.default.put(
      pointerRequest(live.slug),
      new Response(JSON.stringify(live), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${POINTER_TTL_SECONDS}` } }),
    );
  } catch {
    // the memo is an optimisation; KV stays the source
  }
}

async function dropPointer(dc: DropwayContext, slug: string): Promise<void> {
  if (typeof caches !== "undefined") await caches.default.delete(pointerRequest(slug)).catch(() => {});
}

/** For tests. */
export function clearLiveMemoryCache() {
  memory.clear();
}

export async function getLiveSite(dc: DropwayContext, slug: string): Promise<LiveSite | null> {
  const hit = memory.get(slug);
  if (hit && Date.now() - hit.at < MEMORY_TTL_MS) return hit.live;
  const memo = await readPointer(dc, slug);
  if (memo && memo.v === LIVE_VERSION && memo.files && typeof memo.files === "object") {
    memo.files = ownFiles(memo.files);
    remember(slug, memo);
    return memo;
  }
  const cached = await dc.env.CACHE.get<LiveSite>(liveKey(slug), { type: "json", cacheTtl: dc.config.liveCacheTtlSeconds }).catch(() => null);
  if (cached && cached.v === LIVE_VERSION && cached.files && typeof cached.files === "object") {
    dc.waitUntil(writePointer(dc, cached));
    cached.files = ownFiles(cached.files);
    remember(slug, cached);
    return cached;
  }
  const live = await loadLiveSiteFromD1(dc, { slug });
  remember(slug, live);
  if (live) dc.waitUntil(putLive(dc, live).catch(() => {}));
  return live;
}

export async function loadLiveSiteFromD1(dc: DropwayContext, by: { slug?: string; siteId?: string }): Promise<LiveSite | null> {
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
  if (site.current_version_id) {
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
    remember(live.slug, live);
    await putLive(dc, live);
    await dropPointer(dc, live.slug);
  }
  return live;
}

export async function dropLive(dc: DropwayContext, slug: string): Promise<void> {
  memory.delete(slug);
  await dc.env.CACHE.delete(liveKey(slug));
  await dropPointer(dc, slug);
}
