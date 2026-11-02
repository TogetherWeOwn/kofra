import type { KofraContext } from "@kofra/core";

/**
 * Cache for the expensive part of a viewer page (highlighted code, rendered
 * Markdown, JSON trees, CSV tables), keyed by content: render/<viewer>@<version>/<variant>/<sha256>.
 * The bar and links around it are rebuilt per request, so one cached fragment
 * serves every path and site that holds the same bytes.
 *
 * Two tiers: a small per-isolate memory LRU, then the Cache API (per data
 * center; a no-op on *.workers.dev hostnames, where only the memory tier helps).
 */
const MEMORY_MAX_CHARS = 8 * 1024 * 1024;
const MEMORY_MAX_ENTRY = 1024 * 1024;
const memory = new Map<string, string>();
let memoryChars = 0;

function remember(key: string, html: string) {
  if (html.length > MEMORY_MAX_ENTRY) return;
  memory.delete(key);
  memory.set(key, html);
  memoryChars += html.length;
  while (memoryChars > MEMORY_MAX_CHARS && memory.size) {
    const [k, v] = memory.entries().next().value!;
    memory.delete(k);
    memoryChars -= v.length;
  }
}

/** For tests. */
export function clearRenderMemoryCache() {
  memory.clear();
  memoryChars = 0;
}

function cacheRequest(dw: KofraContext, key: string): Request {
  const host = dw.requestUrl?.host ?? "kofra.invalid";
  return new Request(`https://${host}/__dropway/render/${key}`);
}

export interface RenderResult {
  html: string;
  /** "memory", "edge" or "miss". */
  cache: "memory" | "edge" | "miss";
}

/** Return the cached fragment for `key`, or produce, store and return it. */
export async function cachedRender(dw: KofraContext, key: string, produce: () => Promise<string>): Promise<RenderResult> {
  const mem = memory.get(key);
  if (mem !== undefined) {
    memory.delete(key);
    memory.set(key, mem);
    return { html: mem, cache: "memory" };
  }
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const req = cacheRequest(dw, key);
  if (cache) {
    const hit = await cache.match(req).catch(() => undefined);
    if (hit) {
      const html = await hit.text();
      remember(key, html);
      return { html, cache: "edge" };
    }
  }
  const html = await produce();
  remember(key, html);
  if (cache) {
    dw.waitUntil(
      cache
        .put(req, new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=2592000, immutable" } }))
        .catch(() => {}),
    );
  }
  return { html, cache: "miss" };
}
