import {
  RESERVED_SLUGS,
  appOrigin,
  extname,
  getLiveSite,
  looksLikeSlug,
  requestPathToFilePath,
  resolveVersionAddress,
  siteUrl,
  type DropwayContext,
} from "@dropway/core";
import { isNavigation, resolvePath, type ServeMode } from "./serve";

/**
 * Decide whether a request is for a published site or for the app.
 *
 * Modes (config.sitesMode):
 * - subdomain: <slug>.<sitesDomain>/<path> is a site; everything else is the app.
 * - path, separate sites origin (config.sitesOrigin): <sitesOrigin>/<slug>/<path> is a site;
 *   the app origin redirects /<prefix>/<slug>/... there and never serves user content.
 * - path, shared origin: <appOrigin>/<prefix>/<slug>/<path> is a site (always sandboxed).
 *
 * Path mode is interim (all sites share one origin). Absolute paths inside a
 * site (for example <script src="/assets/app.js">) escape the /<slug>/ prefix;
 * they are resolved with the Referer: if the referring page belongs to site X
 * and X has that file, the request is redirected (307) to X's canonical URL.
 * Redirecting (rather than serving in place) keeps module graphs and CSS url()
 * resolving under the right site, keeps caches per site, and makes service
 * worker registration at "/" impossible (browsers refuse redirected SW scripts).
 */
export type SiteRoute =
  | { kind: "site"; slug: string; path: string; mode: ServeMode }
  | { kind: "redirect"; location: string; status: 301 | 307 | 308; byReferer: boolean }
  | { kind: "sites_home" }
  | { kind: "sites_not_found" }
  | { kind: "gone"; mode: ServeMode }
  | { kind: "app" };

const isSiteSlug = (s: string | undefined): s is string => !!s && looksLikeSlug(s) && !RESERVED_SLUGS.has(s);

const VERSION_ADDRESS_RE = /^(.+)--v(\d{1,9})$/;

/** Split a `<base>--v<N>` version address; null for anything else (including reserved bases). */
function parseVersionAddress(segment: string | undefined): { base: string; num: number } | null {
  if (!segment) return null;
  const m = VERSION_ADDRESS_RE.exec(segment);
  if (!m || !isSiteSlug(m[1])) return null;
  const num = Number(m[2]);
  return Number.isSafeInteger(num) && num >= 1 ? { base: m[1]!, num } : null;
}

/**
 * R-59: route a version address. Deleted versions are gone (410, never another
 * site's bytes); a renamed-away base 308s to the same address under the current
 * name. Live previews (R-13) and unknown names return null: today's behavior.
 */
async function versionAddressRoute(
  dw: DropwayContext,
  parsed: { base: string; num: number },
  locationFor: (current: string) => string,
  mode: ServeMode,
): Promise<SiteRoute | null> {
  const resolved = await resolveVersionAddress(dw, parsed.base, parsed.num);
  if (resolved.kind === "redirect") return { kind: "redirect", location: locationFor(resolved.slug), status: 308, byReferer: false };
  if (resolved.kind === "gone") return { kind: "gone", mode };
  return null;
}

/** The site a same-origin Referer points into, given the path prefix sites live under ("" = origin root). */
function refererSlug(req: Request, url: URL, prefix: string): string | null {
  const ref = req.headers.get("referer");
  if (!ref) return null;
  let r: URL;
  try {
    r = new URL(ref);
  } catch {
    return null;
  }
  if (r.origin !== url.origin) return null;
  if (prefix && !r.pathname.startsWith(`${prefix}/`)) return null;
  const slug = r.pathname.slice(prefix.length).split("/")[1];
  return isSiteSlug(slug) ? slug : null;
}

/** Does site `slug` have something to serve at this absolute path (no SPA/404 fallbacks)? */
async function siteHasPath(dw: DropwayContext, slug: string, pathname: string, req: Request, base: string): Promise<boolean> {
  const live = await getLiveSite(dw, slug);
  if (!live || !live.versionId || (live.expiresAt && live.expiresAt < Date.now())) return false;
  const p = requestPathToFilePath(pathname);
  if (p === null) return false;
  return resolvePath(live, p, req, { kind: "path", base, sandbox: true, rewrite: null }, false).kind !== "not_found";
}

/**
 * App routes a Referer redirect must never steal: extensionful paths (an SPA route never
 * looks like a file name) and the app's own top-level routes. Container routes (dashboard,
 * file browser) are matched by first segment: a real app link from inside a site must reach
 * the app, and SPA routes under those prefixes keep today's behaviour (they stay app paths).
 */
const APP_NAV_EXACT = new Set(["/", "/health", "/login", "/connect", "/claim", "/mcp", "/api", "/dashboard", "/view"]);
const APP_NAV_PREFIXES = ["dashboard", "v", "view", "api", "mcp", "docs", ".well-known", "__dropway"];

/**
 * SPA navigation fallback by Referer (SRV-02): site X is an SPA and this is a page navigation
 * (not a sub-resource) from inside X to a path X itself lacks. The redirect target is then
 * served by the SPA fallback of X, so root-relative client routes keep working in path mode.
 */
async function spaNavigationRedirect(dw: DropwayContext, slug: string, req: Request, pathname: string): Promise<boolean> {
  if (!isNavigation(req) || extname(pathname) || pathname.includes("//")) return false;
  if (APP_NAV_EXACT.has(pathname) || APP_NAV_PREFIXES.includes(pathname.split("/")[1] ?? "")) return false;
  const p = requestPathToFilePath(pathname);
  if (p === null || p === "" || p.endsWith("/")) return false;
  const live = await getLiveSite(dw, slug);
  if (!live || !live.versionId || (live.expiresAt && live.expiresAt < Date.now())) return false;
  return live.spa && !!live.files["index.html"];
}

/**
 * A former path-mode sites origin (config.legacySitesOrigins): <origin>/<slug>/<rest>?q answers
 * 308 to <current site URL><rest>?q, so old links, embeds and bookmarks keep working. An absolute
 * path from a page of site X there (Referer) goes to X. Never cached: a rollback works at once.
 */
function legacySitesRoute(dw: DropwayContext, req: Request, url: URL): SiteRoute {
  if (url.pathname === "/") return dw.config.appOrigin ? { kind: "redirect", location: dw.config.appOrigin, status: 308, byReferer: false } : { kind: "sites_not_found" };
  const first = url.pathname.split("/")[1];
  if (isSiteSlug(first)) return { kind: "redirect", location: siteUrl(dw, first) + url.pathname.slice(first.length + 2) + url.search, status: 308, byReferer: false };
  const ref = refererSlug(req, url, "");
  if (ref) return { kind: "redirect", location: siteUrl(dw, ref) + url.pathname.slice(1) + url.search, status: 307, byReferer: true };
  return { kind: "sites_not_found" };
}

export async function routeSiteRequest(dw: DropwayContext, req: Request): Promise<SiteRoute> {
  const c = dw.config;
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const readOnly = method === "GET" || method === "HEAD";

  if (c.legacySitesOrigins.includes(url.origin)) return legacySitesRoute(dw, req, url);

  if (c.sitesMode === "subdomain" && c.sitesDomain) {
    const host = url.hostname.toLowerCase();
    if (host.endsWith(`.${c.sitesDomain}`)) {
      const label = host.slice(0, -(c.sitesDomain.length + 1));
      if (isSiteSlug(label)) return { kind: "site", slug: label, path: url.pathname, mode: { kind: "subdomain", base: "/", sandbox: c.sitesSandbox, rewrite: null } };
      const versioned = parseVersionAddress(label);
      if (versioned) {
        const routed = await versionAddressRoute(
          dw,
          versioned,
          (current) => {
            const target = new URL(url);
            target.hostname = `${current}--v${versioned.num}.${c.sitesDomain}`;
            return target.toString();
          },
          { kind: "subdomain", base: "/", sandbox: c.sitesSandbox, rewrite: null },
        );
        if (routed) return routed;
      }
      // Reserved labels are never user sites: www goes to the app; the rest (files, fallback,
      // customers, ...) belong to the platform and answer 404 here unless an embedding app
      // handles those hosts first. Dotted and malformed labels have no certificate or site.
      if (label === "www" && c.appOrigin) return { kind: "redirect", location: c.appOrigin, status: 301, byReferer: false };
      return { kind: "sites_not_found" };
    }
    if (host === c.sitesDomain) return { kind: "redirect", location: appOrigin(dw), status: 301, byReferer: false };
    const prefix = c.sitesPathPrefix;
    if (url.pathname.startsWith(`${prefix}/`)) {
      const rest = url.pathname.slice(prefix.length + 1);
      const slug = rest.split("/")[0];
      if (isSiteSlug(slug)) return { kind: "redirect", location: siteUrl(dw, slug) + rest.slice(slug.length + 1) + url.search, status: 301, byReferer: false };
      if (parseVersionAddress(slug)) {
        return { kind: "redirect", location: `https://${slug}.${c.sitesDomain}/${rest.slice(slug!.length + 1)}${url.search}`, status: 301, byReferer: false };
      }
    }
    return { kind: "app" };
  }

  // Path mode with a separate, sites-only origin.
  if (c.sitesOrigin && url.origin === c.sitesOrigin) {
    if (url.pathname === "/") return { kind: "sites_home" };
    const first = url.pathname.split("/")[1];
    const ref = refererSlug(req, url, "");
    if (readOnly && ref && ref !== first && (await siteHasPath(dw, ref, url.pathname, req, `/${ref}/`))) {
      return { kind: "redirect", location: `/${ref}${url.pathname}${url.search}`, status: 307, byReferer: true };
    }
    // SPA inference must yield to destination sites (including empty/expired ones)
    // and version addresses, whose own routing decides 301/308/404/410 responses.
    if (readOnly && ref && ref !== first && !parseVersionAddress(first) &&
      (await spaNavigationRedirect(dw, ref, req, url.pathname)) && !(isSiteSlug(first) && (await getLiveSite(dw, first)))) {
      return { kind: "redirect", location: `/${ref}${url.pathname}${url.search}`, status: 307, byReferer: true };
    }
    if (isSiteSlug(first)) {
      if (url.pathname === `/${first}`) return { kind: "redirect", location: `/${first}/${url.search}`, status: 301, byReferer: false };
      return { kind: "site", slug: first, path: url.pathname.slice(first.length + 1), mode: { kind: "path", base: `/${first}/`, sandbox: c.sitesSandbox, rewrite: { base: `/${first}/`, keep: [] } } };
    }
    const versionedSitesOrigin = parseVersionAddress(first);
    if (versionedSitesOrigin) {
      const routed = await versionAddressRoute(
        dw,
        versionedSitesOrigin,
        (current) => `${c.sitesOrigin}/${current}--v${versionedSitesOrigin.num}${url.pathname.slice(first!.length + 1)}${url.search}`,
        { kind: "path", base: `/${first}/`, sandbox: c.sitesSandbox, rewrite: { base: `/${first}/`, keep: [] } },
      );
      if (routed) return routed;
    }
    return { kind: "sites_not_found" };
  }

  // Path mode on the app origin.
  const prefix = c.sitesPathPrefix;
  if (url.pathname.startsWith(`${prefix}/`)) {
    const rest = url.pathname.slice(prefix.length + 1);
    const slug = rest.split("/")[0];
    const versionedPrefix = parseVersionAddress(slug);
    if (versionedPrefix && c.sitesOrigin) {
      return { kind: "redirect", location: `${c.sitesOrigin}/${rest}${url.search}`, status: 301, byReferer: false };
    }
    if (versionedPrefix) {
      const base = `${prefix}/${slug}/`;
      const routed = await versionAddressRoute(
        dw,
        versionedPrefix,
        (current) => `${appOrigin(dw)}${prefix}/${current}--v${versionedPrefix.num}${rest.slice(slug!.length)}${url.search}`,
        { kind: "path", base, sandbox: true, rewrite: { base, keep: [`${prefix}/`] } },
      );
      if (routed) return routed;
    }
    if (isSiteSlug(slug)) {
      // With a separate sites origin, user content is never served from the app origin.
      if (c.sitesOrigin) return { kind: "redirect", location: `${c.sitesOrigin}/${rest}${url.search}`, status: 301, byReferer: false };
      if (rest === slug) return { kind: "redirect", location: `${prefix}/${slug}/${url.search}`, status: 301, byReferer: false };
      const base = `${prefix}/${slug}/`;
      return { kind: "site", slug, path: rest.slice(slug.length), mode: { kind: "path", base, sandbox: true, rewrite: { base, keep: [`${prefix}/`] } } };
    }
    return { kind: "app" };
  }
  if (!c.sitesOrigin && readOnly) {
    const ref = refererSlug(req, url, prefix);
    if (ref && (await siteHasPath(dw, ref, url.pathname, req, `${prefix}/${ref}/`))) {
      return { kind: "redirect", location: `${prefix}/${ref}${url.pathname}${url.search}`, status: 307, byReferer: true };
    }
    if (ref && (await spaNavigationRedirect(dw, ref, req, url.pathname))) {
      return { kind: "redirect", location: `${prefix}/${ref}${url.pathname}${url.search}`, status: 307, byReferer: true };
    }
  }
  return { kind: "app" };
}

/** Response for a redirect route. Referer-based redirects must never be cached (they depend on the Referer). */
export function redirectResponse(route: Extract<SiteRoute, { kind: "redirect" }>): Response {
  const h = new Headers({ Location: route.location, "Access-Control-Allow-Origin": "*" });
  if (route.byReferer) {
    h.set("Cache-Control", "no-store");
    h.set("Vary", "Referer");
    h.set("X-Kofra-Resolved-By", "referer");
  }
  // 308 = a legacy origin moved: not cached, so moving back works at once.
  if (route.status === 308) h.set("Cache-Control", "no-store");
  return new Response(null, { status: route.status, headers: h });
}
