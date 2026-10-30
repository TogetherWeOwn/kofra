import {
  appOrigin,
  baseType,
  encodePath,
  extname,
  getLiveSite,
  hmacHex,
  isHtml,
  isTextual,
  isApiError,
  spendSitePasswordAttempt,
  meter,
  emit,
  precompressed,
  readBlob,
  readBlobRange,
  requestPathToFilePath,
  resolveSlugRedirect,
  siteUrl,
  timingSafeEqualStr,
  verifyPassword,
  type DropwayContext,
  type LiveSite,
} from "@dropway/core";
import { escapeHtml, systemPage } from "./html";
import { findViewer, toViewerFile, VIEWER_CHROME_VERSION, VIEWER_CSP, VIEWERS, type ViewMode, type Viewer } from "./viewers";
import { renderListing } from "./viewers/listing";
import { MAX_CSS_REWRITE_BYTES, rewriteCss, rewriteHtml, type PathRewrite } from "./path-rewrite";
import { PATH_SHIM_VERSION, pathShimScript } from "./path-shim";
import { injectReportLink, REPORT_LINK_VERSION } from "./report-link";
import { badgeFor, badgeResponse } from "./site-badge";
import { serveTransfer } from "./transfers";
import { attachmentDisposition } from "./content-disposition";

/**
 * How a site is being served.
 * - subdomain: https://<slug>.<SITES_DOMAIN>/... (each site its own origin; recommended)
 * - path:      <origin>/<prefix>/<slug>/... (interim; sandboxed with CSP unless configured otherwise)
 */
export interface ServeMode {
  kind: "subdomain" | "path";
  /** URL path prefix of the site root, always ending in "/". */
  base: string;
  /** Add a CSP sandbox (opaque origin) to every response. */
  sandbox: boolean;
  /** Path mode: prefix root-relative URLs in HTML and CSS (null = serve bytes untouched). */
  rewrite: PathRewrite | null;
  /** Keep runtime URLs in path scope when a preview suppresses the Referer. */
  pathShim?: boolean;
  /** Authorized version-preview serving, not the live site (set only by the preview path). */
  preview?: boolean;
}

export const INDEX_NAMES = ["index.html", "index.htm", "index.md", "README.md", "readme.md"];

/** CSP sandbox for user content that must not share an origin's storage, cookies or service workers. */
export const SITE_SANDBOX =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock";

const PASSWORD_PATH = "__dropway/password";
const PASSWORD_FORM_TTL = 15 * 60_000;
/** Edges' clocks differ slightly: a form issued by one may look this far ahead to another. */
const PASSWORD_FORM_CLOCK_SKEW = 60_000;
/** Cloudflare's shared source address for cross-zone Worker subrequests; the edge-added CF-Worker header names the zone. */
const CROSS_ZONE_WORKER_IP = "2a06:98c0:3600::103";
/** Reserved at a site root: the provider-served live-version badge (a published file of this name is not served). */
const BADGE_PATH = "badge.svg";

export type Resolved =
  | { kind: "file"; path: string; status: number }
  | { kind: "redirect"; location: string }
  | { kind: "listing"; dir: string }
  | { kind: "not_found" };

/** A top-level page load (or iframe) rather than fetch(), <img>, <script>... */
export function isNavigation(req: Request): boolean {
  const dest = req.headers.get("sec-fetch-dest");
  if (dest) return dest === "document" || dest === "iframe" || dest === "frame";
  return (req.headers.get("accept") ?? "").includes("text/html");
}

/** Private configuration paths are stored with the version but never served. */
function isPrivatePath(p: string): boolean {
  return p === ".dropway" || p.startsWith(".dropway/");
}

/** A directory counts for serving only when it holds at least one non-private entry. */
function hasVisibleChildren(files: LiveSite["files"], dir: string): boolean {
  for (const k in files) if (k.startsWith(dir) && !isPrivatePath(k)) return true;
  return false;
}

/**
 * The longest proper ancestor directory of `filePath` (with trailing "/")
 * that prefixes at least one non-private path in the live manifest, or null when no
 * ancestor folder has files. The site root never counts. Computed from the
 * already-loaded manifest only. Object.keys keeps an ancestor folder named
 * `__proto__` ordinary manifest data.
 */
function nearestManifestAncestor(files: LiveSite["files"], filePath: string): string | null {
  // Empty segments (leading, trailing or repeated "/") are filtered out below.
  const segments = filePath.split("/").filter(Boolean);
  const paths = Object.keys(files);
  for (let len = segments.length - 1; len >= 1; len--) {
    const dir = `${segments.slice(0, len).join("/")}/`;
    if (paths.some((k) => k.startsWith(dir) && !isPrivatePath(k))) return dir;
  }
  return null;
}

/**
 * Find which manifest entry answers a request path ("" = site root).
 * With fallbacks=false (used for Referer resolution) SPA and 404.html fallbacks are skipped.
 */
export function resolvePath(live: LiveSite, p: string, req: Request, mode: ServeMode, fallbacks = true): Resolved {
  const files = live.files;
  const search = new URL(req.url).search;
  // .dropway and .dropway/* are stored with the version (site configuration) but never
  // served: not as a file, not raw, not as a listing, and not through the SPA fallback.
  // A directory holding only private entries therefore answers as if it were absent.
  if (isPrivatePath(p)) return { kind: "not_found" };
  if (p === "" || p.endsWith("/")) {
    for (const name of INDEX_NAMES) if (files[p + name]) return { kind: "file", path: p + name, status: 200 };
    if (p === "") {
      const keys = Object.keys(files);
      if (keys.length === 1 && keys[0] !== ".dropway" && !keys[0]!.startsWith(".dropway/")) return { kind: "file", path: keys[0]!, status: 200 };
    }
    if (hasVisibleChildren(files, p)) return { kind: "listing", dir: p };
  } else {
    if (files[p]) return { kind: "file", path: p, status: 200 };
    if (hasVisibleChildren(files, `${p}/`)) return { kind: "redirect", location: `${mode.base}${encodePath(p)}/${search}` };
    if (files[`${p}.html`]) return { kind: "file", path: `${p}.html`, status: 200 };
    if (files[`${p}.htm`]) return { kind: "file", path: `${p}.htm`, status: 200 };
  }
  if (!fallbacks) return { kind: "not_found" };
  if (live.spa && (isNavigation(req) || !extname(p)) && files["index.html"]) return { kind: "file", path: "index.html", status: 200 };
  if (files["404.html"]) return { kind: "file", path: "404.html", status: 404 };
  return { kind: "not_found" };
}

/** Long-lived caching only for build outputs whose names carry a content hash (Vite, webpack, Next, Astro). */
export function cacheControlFor(path: string, live: LiveSite): string {
  if (live.passwordHash) return "private, no-store";
  const fingerprinted =
    /^(assets|_next\/static|static|_astro|build|_app\/immutable|dist)\//.test(path) &&
    /[.\-_](?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{8,}\.[a-z0-9]+(\.(br|gz))?$/.test(path);
  return fingerprinted ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";
}

/**
 * Headers on every response for user content. Public sites are readable from anywhere (CORS *,
 * CORP cross-origin). Password-protected sites are not: no CORS, and CORP same-origin unless the
 * site is sandboxed (an opaque-origin page would then be refused its own images and scripts).
 */
export function securityHeaders(h: Headers, live: LiveSite | null, mode: ServeMode) {
  const gated = !!live?.passwordHash;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Strict-Transport-Security", "max-age=31536000");
  if (gated) h.delete("Access-Control-Allow-Origin");
  else h.set("Access-Control-Allow-Origin", "*");
  h.set("X-Robots-Tag", live?.expiresAt ? "noindex" : "all");
  if (live) {
    h.set("X-Kofra-Site", live.slug);
    if (live.versionId) h.set("X-Kofra-Version", live.versionId);
    if (live.crossOriginIsolation) {
      h.set("Cross-Origin-Opener-Policy", "same-origin");
      h.set("Cross-Origin-Embedder-Policy", "require-corp");
      h.set("Cross-Origin-Resource-Policy", "same-origin");
    } else {
      h.set("Cross-Origin-Resource-Policy", gated && !mode.sandbox ? "same-origin" : "cross-origin");
    }
  }
  if (mode.sandbox) {
    const existing = h.get("Content-Security-Policy");
    h.set("Content-Security-Policy", existing ? `${existing}; ${SITE_SANDBOX}` : SITE_SANDBOX);
  }
}

export function systemResponse(
  dw: DropwayContext,
  req: Request,
  mode: ServeMode,
  live: LiveSite | null,
  status: number,
  code: string,
  title: string,
  message: string,
  extra = "",
): Response {
  const h = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  h.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");
  securityHeaders(h, live, mode);
  const origin = appOrigin(dw);
  const body =
    req.method === "HEAD"
      ? null
      : systemPage({ code, title, message: message.replace("{app}", `<a href="${escapeHtml(origin)}">${escapeHtml(dw.config.instanceName)}</a>`), extra });
  return new Response(body, { status, headers: h });
}

async function passwordCookieValue(dw: DropwayContext, live: LiveSite): Promise<string> {
  return (await hmacHex(dw.config.signingSecret, `${live.siteId}:${live.passwordHash}`)).slice(0, 40);
}

/**
 * Gate cookie names. Subdomain mode uses the __Host- prefix (Path=/, no Domain), so a sibling
 * <x>.<SITES_DOMAIN> cannot set or overwrite it. `embedded` is the CHIPS (Partitioned) cookie set
 * when the password is entered inside a frame, which only the app may host (the dashboard file
 * viewer on another site): it lives in that top-level site's partition only.
 */
const cookieName = (live: LiveSite, mode: ServeMode, embedded = false) =>
  `${mode.kind === "subdomain" ? "__Host-" : ""}dw_pw${embedded ? "e" : ""}_${live.slug.replace(/[^a-z0-9]/g, "_")}`;

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** The trusted edge's view of the visitor. Forwarding headers are never identity; only the synthetic address is split by zone. */
function passwordVisitor(req: Request): string {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const zone = req.headers.get("CF-Worker");
  return zone && ip.toLowerCase() === CROSS_ZONE_WORKER_IP ? `${ip}|worker:${zone}` : ip;
}

async function passwordFormSignature(dw: DropwayContext, req: Request, live: LiveSite, mode: ServeMode, until: number): Promise<string> {
  return hmacHex(dw.config.signingSecret, JSON.stringify([
    "site-password-form", new URL(req.url).origin, mode.base, live.siteId, live.passwordHash,
    passwordVisitor(req), until,
  ]));
}

async function passwordSubmissionAllowed(dw: DropwayContext, req: Request, live: LiveSite, mode: ServeMode): Promise<boolean> {
  const origin = req.headers.get("Origin");
  const site = req.headers.get("Sec-Fetch-Site");
  if (origin && origin !== "null") return origin === new URL(req.url).origin && site !== "cross-site" && site !== "same-site";
  if (origin !== "null") return site !== "cross-site" && site !== "same-site";
  // Sandboxes and no-referrer pages can both send Origin: null. Require the
  // visitor's short-lived form proof without reading or charging its body.
  const token = new URL(req.url).searchParams.get("dw_form") ?? "";
  const match = /^(\d{1,16})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return false;
  const until = Number(match[1]);
  const now = Date.now();
  if (!Number.isSafeInteger(until) || until <= now || until > now + PASSWORD_FORM_TTL + PASSWORD_FORM_CLOCK_SKEW) return false;
  return timingSafeEqualStr(match[2]!, await passwordFormSignature(dw, req, live, mode, until));
}

async function handlePassword(dw: DropwayContext, req: Request, live: LiveSite, mode: ServeMode, filePath: string): Promise<Response | null> {
  if (!live.passwordHash) return null;
  const expected = await passwordCookieValue(dw, live);
  if (readCookie(req, cookieName(live, mode)) === expected || readCookie(req, cookieName(live, mode, true)) === expected) return null;

  if (req.method === "POST" && filePath === PASSWORD_PATH) {
    if (!await passwordSubmissionAllowed(dw, req, live, mode)) {
      return systemResponse(dw, req, mode, live, 403, "403", "Password form refused", "Reload this site's password form and try again.");
    }
    try {
      await spendSitePasswordAttempt(dw, live.siteId, passwordVisitor(req));
    } catch (error) {
      const limited = isApiError(error) && error.status === 429;
      const response = systemResponse(dw, req, mode, live, limited ? 429 : 503, limited ? "429" : "503",
        limited ? "Too many password attempts" : "Password unlock unavailable", "Please try again later.");
      response.headers.set("Retry-After", String(limited ? error.retryAfterSeconds : 1));
      return response;
    }
    const form = await req.formData().catch(() => null);
    const password = form?.get("password");
    const next = String(form?.get("next") ?? mode.base);
    const safeNext = next.startsWith(mode.base) && !next.startsWith("//") ? next : mode.base;
    if (typeof password === "string" && (await verifyPassword(password, live.passwordHash))) {
      const h = new Headers({ Location: safeNext, "Cache-Control": "no-store" });
      const dest = req.headers.get("sec-fetch-dest");
      const attrs = `Path=${mode.base}; Max-Age=604800; HttpOnly; Secure`;
      if (mode.sandbox) {
        // Sandboxed pages have an opaque origin, so their sub-resource requests count as cross-site.
        h.append("Set-Cookie", `${cookieName(live, mode)}=${expected}; ${attrs}; SameSite=None`);
      } else if (dest === "iframe" || dest === "frame") {
        // Entered in the app's file viewer, a cross-site frame once sites have their own domain:
        // a Lax cookie would not be sent there, so use a cookie partitioned to that top-level site.
        h.append("Set-Cookie", `${cookieName(live, mode, true)}=${expected}; ${attrs}; SameSite=None; Partitioned`);
      } else {
        h.append("Set-Cookie", `${cookieName(live, mode)}=${expected}; ${attrs}; SameSite=Lax`);
      }
      return new Response(null, { status: 303, headers: h });
    }
    return passwordForm(dw, req, live, mode, safeNext, true);
  }
  const u = new URL(req.url);
  return passwordForm(dw, req, live, mode, u.pathname + u.search, false);
}

async function passwordForm(dw: DropwayContext, req: Request, live: LiveSite, mode: ServeMode, next: string, failed: boolean): Promise<Response> {
  const until = Date.now() + PASSWORD_FORM_TTL;
  const action = `${mode.base}${PASSWORD_PATH}?dw_form=${until}.${await passwordFormSignature(dw, req, live, mode, until)}`;
  const extra = `<form method="post" action="${escapeHtml(action)}" style="display:flex;gap:.5rem">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<input type="password" name="password" placeholder="Password" required autofocus style="flex:1;padding:.6rem .8rem;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)">
<button style="padding:.6rem 1rem;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer">Open</button></form>
${failed ? '<p style="color:var(--accent)">That password is not right.</p>' : ""}`;
  const r = systemResponse(dw, req, mode, live, 401, "PASSWORD", "This site is password protected", "Enter the password to view it.", extra);
  // Only the app (its file viewer) may frame the form; X-Frame-Options covers browsers without CSP 2.
  r.headers.set("Content-Security-Policy", `${r.headers.get("Content-Security-Policy")}; frame-ancestors ${appOrigin(dw)}`);
  r.headers.set("X-Frame-Options", "DENY");
  return r;
}

function parseRange(header: string | null, size: number): { offset: number; length: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { offset: start, length: end - start + 1 };
}

function etagMatches(req: Request, etag: string): boolean {
  const inm = req.headers.get("if-none-match");
  if (!inm) return false;
  return inm.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v === etag || v === `W/${etag}`;
  });
}

// Viewer ids and etagExtra output may be any string — including lone
// (unpaired) UTF-16 surrogates, on which encodeURIComponent throws URIError.
// Normalize those to U+FFFD first (same approach as content-disposition.ts);
// valid surrogate pairs pass through untouched.
function etagSegment(value: string): string {
  return encodeURIComponent(
    value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) =>
      m.length === 2 ? m : "\uFFFD",
    ),
  );
}

const flag = (sp: URLSearchParams, name: string) => sp.has(name) && sp.get(name) !== "0" && sp.get(name) !== "false";

/** Which view a request asks for: ?view=source, ?view=1, or a browser navigation (top level or iframe). null = raw bytes. */
export function requestedViewMode(req: Request, sp: URLSearchParams): ViewMode | null {
  const view = sp.get("view");
  if (view === "source") return "source";
  if (flag(sp, "view")) return "view";
  if (!isNavigation(req)) return null;
  const dest = req.headers.get("sec-fetch-dest");
  return dest === "iframe" || dest === "frame" ? "frame" : "document";
}

/**
 * Serve one request for a published site. `pathname` is relative to the site
 * root (the URL path in subdomain mode; the part after /<prefix>/<slug> in path mode).
 */
export async function serveSite(
  req: Request,
  dw: DropwayContext,
  slug: string,
  pathname: string,
  mode: ServeMode,
  viewers: readonly Viewer[] = VIEWERS,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  // Transfer gates never depend on an eventually consistent live manifest.
  const transfer = await dw.env.DB.prepare("SELECT mode FROM sites WHERE slug = ? UNION ALL SELECT 'transfer' AS mode FROM transfer_slug_tombstones WHERE slug = ? AND NOT EXISTS (SELECT 1 FROM sites WHERE slug = ?) LIMIT 1").bind(slug, slug, slug).first<{ mode: string }>();
  const badge = (method === "GET" || method === "HEAD") && requestPathToFilePath(pathname) === BADGE_PATH;
  if (transfer?.mode === "transfer") {
    // The badge never reaches the transfer handler: no download is counted or attributed.
    if (badge) return badgeResponse(badgeFor(null), method);
    const path = requestPathToFilePath(pathname);
    if (path === null) return new Response("Not found", { status: 404 });
    return serveTransfer(req, dw, slug, path);
  }
  // Credentials, cookies and Fetch Metadata are never read: the same bytes for everyone.
  // Not recorded as a site request (no analytics point, no usage meter, no hook).
  if (badge) return badgeResponse(badgeFor(await getLiveSite(dw, slug)), method);
  if (method === "OPTIONS") {
    // Password-protected sites are not readable cross-origin, so their preflights grant nothing.
    const gated = !!(await getLiveSite(dw, slug))?.passwordHash;
    const headers: Record<string, string> = { "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Max-Age": "86400" };
    if (!gated) headers["Access-Control-Allow-Origin"] = "*";
    return new Response(null, { status: 204, headers });
  }

  const filePath = requestPathToFilePath(pathname);
  if (filePath === null) return systemResponse(dw, req, mode, null, 400, "400", "Bad request", "That address could not be decoded.");

  const live = await getLiveSite(dw, slug);
  if (!live) {
    // R-59: a renamed site's old name 308s to the current name, path and query
    // kept. Never cached: the hold ends and the name may be reused.
    const redirect = await resolveSlugRedirect(dw, slug);
    if (redirect) {
      return new Response(null, {
        status: 308,
        headers: {
          Location: siteUrl(dw, redirect.slug) + pathname.replace(/^\//, "") + url.search,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    }
    return systemResponse(dw, req, mode, null, 404, "404", "Nothing is published here", "There is no site at this address. It may have been deleted. See {app}.");
  }
  return serveSiteContent(req, dw, live, pathname, mode, viewers);
}

/** Serve an already resolved manifest. Preview callers authorize and load their version in D1 first. */
export async function serveSiteContent(
  req: Request,
  dw: DropwayContext,
  live: LiveSite,
  pathname: string,
  mode: ServeMode,
  viewers: readonly Viewer[] = VIEWERS,
): Promise<Response> {
  const started = Date.now();
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const filePath = requestPathToFilePath(pathname);
  if (filePath === null) return systemResponse(dw, req, mode, live, 400, "400", "Bad request", "That address could not be decoded.");
  // Anonymous sites are untrusted: sandbox them even where other sites are not.
  if (!mode.sandbox && live.tenantId === null && dw.config.sitesSandboxAnonymous) mode = { ...mode, sandbox: true };
  if (live.expiresAt && live.expiresAt < Date.now()) {
    return systemResponse(dw, req, mode, live, 410, "EXPIRED", "This site has expired", "Anonymous sites are temporary. Publish again, or claim a site with an API key to keep it. See {app}.");
  }

  // Password-protected sites only answer navigations (top level or frames, such as the app's file
  // viewer) and their own pages' requests. Until the sites domain is on the Public Suffix List,
  // <a>.<domain> and <b>.<domain> are the same site, so a Lax gate cookie alone would let one
  // site load another's unlocked scripts with <script src>. Sandboxed pages are opaque origins
  // whose own requests count as cross-site, so they are left to the cookie.
  if (live.passwordHash && !mode.sandbox && !isNavigation(req)) {
    const site = req.headers.get("sec-fetch-site");
    if (site === "same-site" || site === "cross-site") {
      return systemResponse(dw, req, mode, live, 403, "403", "Not available here", "This site is password protected, so other sites cannot load it.");
    }
  }
  const gate = await handlePassword(dw, req, live, mode, filePath);
  if (gate) return gate;

  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } });
  }
  if (!live.versionId) return systemResponse(dw, req, mode, live, 404, "EMPTY", "Nothing published yet", "This site exists but has no live version yet. See {app}.");

  const resolved = resolvePath(live, filePath, req, mode);
  let response: Response;
  let bytes = 0;
  if (resolved.kind === "redirect") {
    response = new Response(null, { status: 301, headers: { Location: resolved.location } });
    securityHeaders(response.headers, live, mode);
  } else if (resolved.kind === "not_found") {
    // Post-gate only (like listings): lead back to the site instead of a dead end.
    const ancestor = nearestManifestAncestor(live.files, filePath);
    const recovery =
      `<nav aria-label="Where to go next"><ul>` +
      `<li><a href="${escapeHtml(mode.base)}">Site home</a></li>` +
      (ancestor ? `<li><a href="${escapeHtml(mode.base + encodePath(ancestor))}">Folder: /${escapeHtml(ancestor)}</a></li>` : "") +
      `<li><a href="${escapeHtml(`${appOrigin(dw)}/v/${live.slug}/${encodePath(ancestor ?? "")}`)}">Browse files</a></li>` +
      `</ul></nav>`;
    response = systemResponse(dw, req, mode, live, 404, "404", "Page not found", `There is no file at <code>/${escapeHtml(filePath).replaceAll("{", "&#123;")}</code> on this site.`, recovery);
  } else if (resolved.kind === "listing") {
    response = renderListing(live, resolved.dir, mode, `${appOrigin(dw)}/v/${live.slug}/${encodePath(resolved.dir)}`, url.searchParams.get("sort"), url.origin);
    securityHeaders(response.headers, live, mode);
  } else {
    response = await serveFile(req, dw, url, live, mode, resolved.path, resolved.status, viewers);
    bytes = Number(response.headers.get("Content-Length") ?? 0);
  }
  recordHit(dw, req, live, filePath, response.status, bytes, Date.now() - started);
  return response;
}

async function serveFile(
  req: Request,
  dw: DropwayContext,
  url: URL,
  live: LiveSite,
  mode: ServeMode,
  path: string,
  status: number,
  viewers: readonly Viewer[],
): Promise<Response> {
  const [sha256, size, contentType] = live.files[path]!;
  const file = toViewerFile(path, sha256, size, contentType);
  const sp = url.searchParams;
  const raw = flag(sp, "raw");
  const download = flag(sp, "download");
  const head = req.method === "HEAD";
  const viewMode = raw || download ? null : requestedViewMode(req, sp);
  const viewer = viewMode ? findViewer(file, live, viewers, viewMode) : null;
  const report = live.tenantId === null && !raw && !download && !precompressed(path) && baseType(contentType) === "text/html";
  const reportVariant = report ? `-report${REPORT_LINK_VERSION}` : "";
  const reportUrl = new URL(`${mode.base}__dropway/report`, url).href;

  // Rendered views: see ./viewers (one per file kind, plus ?view=source).
  if (viewer && viewMode) {
    const embed = flag(sp, "embed");
    // Every page, including image/SVG and embeds, names manifest metadata.
    // A sole-file root can resolve to a new path with identical bytes, and MIME
    // can change independently too. Content-only render fragments stay reusable.
    const folderVariant = `-folder${live.versionId}`;
    // The shared chrome revision retires every full-page validator when
    // viewerPage markup/CSS changes, including extension viewers whose own
    // version cannot know about an internal chrome change.
    const etag = `W/"${etagSegment(viewer.id)}@${viewer.version ?? 1}-${sha256}${etagSegment(viewer.etagExtra?.(file, live) ?? "")}${folderVariant}-chrome${VIEWER_CHROME_VERSION}${embed ? "-e" : ""}${reportVariant}"`;
    const h = new Headers();
    if (status === 200 && etagMatches(req, etag)) {
      h.set("ETag", etag);
      securityHeaders(h, live, mode);
      return new Response(null, { status: 304, headers: h });
    }
    const fileUrl = url.pathname;
    const readBytes = async (offset = 0, length = size - offset): Promise<Uint8Array> => {
      const len = Math.max(0, Math.min(length, size - offset));
      if (len === 0) return new Uint8Array(0);
      const body = offset === 0 && len === size ? (await readBlob(dw, sha256, size))?.body : await readBlobRange(dw, sha256, { offset, length: len });
      return body ? new Uint8Array(await new Response(body).arrayBuffer()) : new Uint8Array(0);
    };
    const rendered = await viewer.render({
      dw,
      request: req,
      url,
      live,
      file,
      mode: viewMode,
      embed,
      preview: mode.preview === true,
      fileUrl,
      viewUrl: `${fileUrl}?view=1`,
      sourceUrl: `${fileUrl}?view=source`,
      rawUrl: `${fileUrl}?raw=1`,
      downloadUrl: `${fileUrl}?download=1`,
      siteBase: mode.base,
      appViewerUrl: `${appOrigin(dw)}/v/${live.slug}/${encodePath(path)}`,
      readBytes,
      readText: async () => {
        const b = await readBlob(dw, sha256, size);
        return b?.body ? new Response(b.body).text() : "";
      },
    });
    const out = new Headers(rendered.headers);
    if (!out.has("Content-Security-Policy")) out.set("Content-Security-Policy", VIEWER_CSP);
    // A viewer may mark its page non-storable (a fallback for a transient
    // failure, never a verdict on the stored bytes). Honor that policy and
    // withhold the success ETag: revalidating the fallback as if it were
    // the healthy render would strand browsers on it after recovery.
    const viewerCacheControl = out.get("Cache-Control");
    if (status >= 400 || viewerCacheControl?.includes("no-store")) out.delete("ETag");
    else out.set("ETag", etag);
    out.set("Cache-Control", status >= 400 || live.passwordHash ? "private, no-store" : viewerCacheControl ?? "public, max-age=0, must-revalidate");
    out.set("Vary", "Accept, Sec-Fetch-Dest");
    // Headers.set throws on CR, LF and NUL: a viewer id containing them would
    // 500 an otherwise healthy render. Omit this diagnostic header for such
    // ids; the ETag above already carries the encoded identity.
    if (!viewer.id.includes("\r") && !viewer.id.includes("\n") && !viewer.id.includes("\0")) {
      out.set("X-Kofra-Viewer", viewer.id);
    }
    out.delete("Content-Length");
    securityHeaders(out, live, mode);
    let page = new Response(head ? null : rendered.body, { status, headers: out });
    // Only generated viewer pages pass here: leave authored error HTML/raw bytes
    // alone, but never advertise a fallback file as the missing resource.
    if (status >= 400 && !head) {
      page = new HTMLRewriter().on('head meta[property^="og:"], head meta[name="description"], head meta[name^="twitter:"]', {
        element(el) { el.remove(); },
      }).transform(page);
    }
    if (mode.rewrite && !head) page = rewriteHtml(page, mode.rewrite);
    return report && !head ? injectReportLink(page, reportUrl) : page;
  }

  // Path mode: HTML and CSS get root-relative URLs prefixed with the site base.
  const rewriteKind = mode.rewrite && !raw && !download && !precompressed(path) ? (isHtml(contentType) ? "html" : baseType(contentType) === "text/css" && size <= MAX_CSS_REWRITE_BYTES ? "css" : null) : null;
  if (rewriteKind || report) {
    // Sandboxed pages and private previews send no Referer, so they need runtime URL repair.
    const shim = rewriteKind === "html" && (mode.sandbox || mode.pathShim === true);
    const etag = `W/"${rewriteKind ? "pm-" : ""}${sha256}${shim ? `-js${PATH_SHIM_VERSION}` : ""}${reportVariant}"`;
    const h = new Headers({ "Content-Type": contentType, ETag: etag, "Cache-Control": cacheControlFor(path, live) });
    if (rewriteKind) h.set("X-Kofra-Rewritten", "path-prefix");
    securityHeaders(h, live, mode);
    if (etagMatches(req, etag)) return new Response(null, { status: 304, headers: h });
    if (head) return new Response(null, { status, headers: h });
    const blob = await readBlob(dw, sha256, size);
    if (!blob) return blobMissing(dw, req, mode, live, path);
    if (rewriteKind === "css" && mode.rewrite) {
      const css = blob.body ? await new Response(blob.body).text() : "";
      return new Response(rewriteCss(css, mode.rewrite), { status, headers: h });
    }
    let page = new Response(blob.body, { status, headers: h });
    if (rewriteKind === "html" && mode.rewrite) page = rewriteHtml(page, mode.rewrite, shim ? { inject: pathShimScript(mode.rewrite) } : {});
    return report ? injectReportLink(page, reportUrl) : page;
  }

  const etag = `"${sha256}"`;
  const h = new Headers();
  h.set("ETag", etag);
  h.set("Accept-Ranges", "bytes");
  h.set("Cache-Control", cacheControlFor(path, live));
  if (findViewer(file, live, viewers, "document") || findViewer(file, live, viewers, "frame")) h.set("Vary", "Accept, Sec-Fetch-Dest");
  const pre = !raw && !download ? precompressed(path) : null;
  if (raw && (isTextual(contentType) || isHtml(contentType))) {
    // ?raw=1 shows the source: never let the browser render it.
    h.set("Content-Type", "text/plain; charset=utf-8");
    h.set("X-Kofra-Original-Content-Type", contentType);
  } else if (pre) {
    h.set("Content-Type", pre.contentType);
    h.set("Content-Encoding", pre.encoding);
  } else {
    h.set("Content-Type", contentType);
  }
  if (download) h.set("Content-Disposition", attachmentDisposition(path.split("/").pop() ?? "file"));
  securityHeaders(h, live, mode);

  if (etagMatches(req, etag)) return new Response(null, { status: 304, headers: h });

  const range = status === 200 && !pre ? parseRange(req.headers.get("range"), size) : null;
  if (range === "invalid") {
    h.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers: h });
  }
  const init: ResponseInit & { encodeBody?: "manual" | "automatic" } = { status, headers: h };
  if (pre) init.encodeBody = "manual";
  if (range) {
    h.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    h.set("Content-Length", String(range.length));
    init.status = 206;
    if (head) return new Response(null, init);
    const body = await readBlobRange(dw, sha256, range);
    if (!body) return blobMissing(dw, req, mode, live, path);
    return new Response(body, init);
  }
  h.set("Content-Length", String(size));
  if (head || size === 0) return new Response(null, init);
  const blob = await readBlob(dw, sha256, size);
  if (!blob) return blobMissing(dw, req, mode, live, path);
  return new Response(blob.body, init);
}

function blobMissing(dw: DropwayContext, req: Request, mode: ServeMode, live: LiveSite, path: string): Response {
  console.error(JSON.stringify({ event: "blob_missing", slug: live.slug, version: live.versionId, url: req.url }));
  // Rebuild the retry href from the serving base and the manifest path only:
  // never copy the raw request URL or its query into the page.
  const retry = `<p><a href="${escapeHtml(mode.base + encodePath(path))}">Try again</a></p>`;
  return systemResponse(dw, req, mode, live, 502, "502", "File unavailable", "This file is listed in the site but its contents could not be read. Try again shortly.", retry);
}

function recordHit(dw: DropwayContext, req: Request, live: LiveSite, path: string, status: number, bytes: number, ms: number) {
  try {
    const cf = (req as Request & { cf?: { country?: string } }).cf;
    let ref = "";
    try {
      ref = req.headers.get("referer") ? new URL(req.headers.get("referer")!).hostname : "";
    } catch {
      ref = "";
    }
    dw.env.ANALYTICS?.writeDataPoint({
      indexes: [live.siteId],
      blobs: [live.slug, "/" + path, String(status), cf?.country ?? "", ref, isNavigation(req) ? "page" : "asset", live.versionId ?? "", live.tenantId ?? ""],
      doubles: [1, ms, bytes],
    });
  } catch {
    // analytics must never break serving
  }
  meter(dw, { type: "site_request", tenantId: live.tenantId, siteId: live.siteId, status, bytes, at: Date.now() });
  emit(dw, "onRequest", { site: { id: live.siteId, slug: live.slug, tenantId: live.tenantId, versionId: live.versionId }, path, status, bytes, ms, request: req });
}
