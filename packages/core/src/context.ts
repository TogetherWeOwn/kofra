import type { KofraConfig } from "./config";
import type { KofraAdapters, KofraHooks } from "./adapters";
import { encodePath } from "./lib/paths";

/** Cloudflare bindings the core needs. Declared in wrangler.jsonc. */
export interface CoreBindings {
  DB: D1Database;
  FILES: R2Bucket;
  CACHE: KVNamespace;
  ANALYTICS?: AnalyticsEngineDataset;
}

/**
 * Everything a service function needs. Built once per request (or per cron run)
 * by packages/server; services never read globals or raw env vars.
 */
export interface KofraContext {
  env: CoreBindings;
  config: KofraConfig;
  adapters: KofraAdapters;
  hooks: readonly KofraHooks[];
  /** URL of the current request (used when config.appOrigin is null). */
  requestUrl: URL | null;
  /** Run work after the response is sent (ExecutionContext.waitUntil). */
  waitUntil(promise: Promise<unknown>): void;
}

/** Public origin of the app and API (no trailing slash). */
export function appOrigin(dc: Pick<KofraContext, "config" | "requestUrl">): string {
  if (dc.config.appOrigin) return dc.config.appOrigin;
  if (dc.requestUrl) return dc.requestUrl.origin;
  return "http://localhost:8787";
}

/** Public URL of a site's root, always ending in "/". Agents should share this URL as returned. */
export function siteUrl(dc: Pick<KofraContext, "config" | "requestUrl">, slug: string): string {
  const c = dc.config;
  if (c.sitesMode === "subdomain" && c.sitesDomain) return `https://${slug}.${c.sitesDomain}/`;
  if (c.sitesOrigin) return `${c.sitesOrigin}/${slug}/`;
  return `${appOrigin(dc)}${c.sitesPathPrefix}/${slug}/`;
}

/** Public URL of one file inside a site. */
export function siteFileUrl(dc: Pick<KofraContext, "config" | "requestUrl">, slug: string, path: string): string {
  return siteUrl(dc, slug) + encodePath(path);
}

/** URL path prefix of a site root on whatever origin serves it ("/" in subdomain mode). */
export function sitePathBase(config: KofraConfig, slug: string): string {
  if (config.sitesMode === "subdomain") return "/";
  if (config.sitesOrigin) return `/${slug}/`;
  return `${config.sitesPathPrefix}/${slug}/`;
}
