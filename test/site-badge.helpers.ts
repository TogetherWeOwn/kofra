/**
 * Shared fixtures and assertions for the live-version badge acceptance contract
 * (test/site-badge.acceptance.test.ts). Protected: the Builder must not edit
 * this file; the paired build makes the acceptance tests pass without touching it.
 *
 * Every badge address is derived from a site URL the API returned
 * (publish/transfer `url` + "badge.svg"), so a badge implementation that only
 * answers one serving mode fails the other mode's cases. Nothing here hard-codes
 * a serving path.
 */
import { env } from "cloudflare:test";
import { expect } from "vitest";
import { clearLiveMemoryCache } from "@dropway/core";
import { form, type Instance } from "./helpers";

export interface PublishedSite {
  slug: string;
  url: string;
}

/** Badge address for a live site URL the API returned (always ends in "/"). */
export function badgeUrl(siteUrl: string): string {
  expect(siteUrl.endsWith("/"), `site URL shape: ${siteUrl}`).toBe(true);
  return `${siteUrl}badge.svg`;
}

/**
 * Badge address for a slug that has no site, derived from a known site URL in
 * the same instance by swapping the slug segment (path modes only).
 */
export function siblingBadgeUrl(knownSiteUrl: string, slug: string): string {
  const u = new URL(knownSiteUrl);
  const segs = u.pathname.split("/").filter(Boolean);
  expect(segs.length, `derive a sibling badge address from ${knownSiteUrl}`).toBeGreaterThan(0);
  segs[segs.length - 1] = slug;
  return `${u.origin}/${segs.join("/")}/badge.svg`;
}

/** Badge address on a subdomain-mode sites domain (mirrors subdomain-mode.test.ts). */
export function subdomainBadgeUrl(sitesDomain: string, slug: string): string {
  return `https://${slug}.${sitesDomain}/badge.svg`;
}

/** How a README `<img>` (or GitHub's camo proxy) fetches the badge: cross-site, no cookies. */
export const IMAGE_REQUEST = {
  Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
  "Sec-Fetch-Dest": "image",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
} as const;

export async function publishSite(dw: Instance, slug: string, files: Record<string, string> = { "index.html": `<h1>${slug}</h1>` }): Promise<PublishedSite> {
  const res = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(files, { slug }) });
  expect(res.status, `publish ${slug}: ${JSON.stringify(res.body)}`).toBe(201);
  expect(res.body.url).toMatch(/^https:\/\/.+\/$/);
  return { slug: res.body.slug as string, url: res.body.url as string };
}

export async function republishSite(dw: Instance, slug: string, files: Record<string, string> = { "index.html": `<h1>${slug} v2</h1>` }): Promise<PublishedSite> {
  const res = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(files, { slug }) });
  expect(res.status, `republish ${slug}: ${JSON.stringify(res.body)}`).toBe(200);
  return { slug: res.body.slug as string, url: res.body.url as string };
}

export async function publishAnonymous(dw: Instance, files: Record<string, string> = { "index.html": "badge anon v1" }): Promise<PublishedSite> {
  const res = await dw.json("/api/v1/publish", { method: "POST", body: form(files) });
  expect(res.status, `anonymous publish: ${JSON.stringify(res.body)}`).toBe(201);
  return { slug: res.body.slug as string, url: res.body.url as string };
}

export async function lockSite(dw: Instance, slug: string, password: string): Promise<void> {
  const res = await dw.json(`/api/v1/sites/${slug}/access`, {
    method: "PUT",
    key: dw.ownerKey,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "password", password }),
  });
  expect(res.status, `lock ${slug}: ${JSON.stringify(res.body)}`).toBe(200);
}

/** POST the site password form; returns the "name=value" unlock cookie pair. */
export async function unlockCookie(dw: Instance, siteUrl: string, password: string): Promise<string> {
  const res = await dw.call(`${siteUrl}__dropway/password`, {
    method: "POST",
    headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
    body: `password=${encodeURIComponent(password)}&next=${encodeURIComponent("/")}`,
  });
  expect(res.status, "password POST must unlock (303)").toBe(303);
  const pair = res.headers.get("set-cookie")?.split(";")[0];
  expect(pair, "unlock sets a cookie").toBeTruthy();
  return pair as string;
}

/** Backdate a site's expiry and drop every cached live pointer (mirrors anonymous.test.ts). */
export async function expireSite(slug: string): Promise<void> {
  await env.DB.prepare("UPDATE sites SET expires_at = ? WHERE slug = ?").bind(Date.now() - 1000, slug).run();
  await env.CACHE.delete(`live:${slug}`);
  clearLiveMemoryCache();
}

export async function renameSite(dw: Instance, slug: string, newSlug: string): Promise<void> {
  const res = await dw.json(`/api/v1/sites/${slug}/rename`, {
    method: "POST",
    key: dw.ownerKey,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newSlug }),
  });
  expect(res.status, `rename ${slug}: ${JSON.stringify(res.body)}`).toBe(200);
  expect(res.body.renamed).toBe(true);
}

export async function deleteSite(dw: Instance, slug: string): Promise<void> {
  const res = await dw.call(`/api/v1/sites/${slug}`, { method: "DELETE", key: dw.ownerKey });
  expect(res.status, `delete ${slug}`).toBe(200);
}

/**
 * The badge response contract: 200 with identical headers for versioned and
 * generic badges, so probing reveals nothing by status or header, and nothing
 * that sets client state.
 */
export function expectBadgeHeaders(res: Response): void {
  expect(res.status, "badge answers 200 (embeddable; probing reveals nothing by status)").toBe(200);
  expect(res.headers.get("content-type")).toBe("image/svg+xml");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  expect(res.headers.get("set-cookie"), "badge never mints a session").toBeNull();
}

function tagNames(svg: string): string[] {
  const out: string[] = [];
  for (const m of svg.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)/g)) out.push((m[1] as string).toLowerCase());
  return out;
}

/** Attribute names with quoted values blanked first, so `>` and `=` inside text cannot confuse the scan. */
function attrNames(svg: string): string[] {
  const unvalued = svg.replace(/"[^"]*"/g, `""`).replace(/'[^']*'/g, `''`);
  const out: string[] = [];
  for (const m of unvalued.matchAll(/([A-Za-z][A-Za-z0-9-:]*)\s*=/g)) out.push((m[1] as string).toLowerCase());
  return out;
}

const FORBIDDEN_TAGS = new Set([
  "a", "animate", "animatemotion", "animatetransform", "audio", "canvas", "embed",
  "foreignobject", "iframe", "image", "object", "script", "set", "use", "video",
]);

/** Static markup with escaped text only: no script, no handlers, no external references. */
export function expectScriptFreeBadge(svg: string): void {
  const trimmed = svg.trim();
  expect(trimmed.startsWith("<svg"), `badge is an SVG document (got ${JSON.stringify(trimmed.slice(0, 80))})`).toBe(true);
  expect(trimmed.endsWith("</svg>")).toBe(true);
  const tags = tagNames(svg);
  expect(tags.length).toBeGreaterThan(0);
  expect(tags[0]).toBe("svg");
  for (const t of tags) expect(FORBIDDEN_TAGS.has(t), `forbidden SVG element <${t}>`).toBe(false);
  const attrs = attrNames(svg);
  for (const name of attrs) {
    expect(name.startsWith("on"), `event-handler attribute ${name}`).toBe(false);
    expect(["href", "src", "xlink:href", "data", "action", "formaction"].includes(name), `reference attribute ${name}`).toBe(false);
  }
  expect(svg.toLowerCase()).not.toContain("<script");
  expect(svg).not.toContain("javascript:");
  expect(svg).not.toContain("url(");
  expect(svg).not.toContain("data:");
  const withoutXmlns = svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "");
  expect(withoutXmlns, "no external references beyond the SVG namespace").not.toMatch(/https?:\/\//);
}

function expectNoExactTimestamps(svg: string): void {
  expect(svg, "no calendar date").not.toMatch(/\d{4}-\d{2}-\d{2}/);
  expect(svg, "no clock time").not.toMatch(/\d{1,2}:\d{2}/);
  expect(svg, "no epoch timestamp").not.toMatch(/\b\d{10,13}\b/);
}

/** A public site's badge names the live version and a coarse relative age ("just now" or "... ago"). */
export function expectVersionedBadge(svg: string, version: number): void {
  expect(svg).toContain(`v${version}`);
  expect(svg).toMatch(/kofra/i);
  expect(svg, "coarse relative age (minute/hour/day wording, never an exact timestamp)").toMatch(/just now|\bago\b/i);
  expectNoExactTimestamps(svg);
}

/** The refusal badge: identical for every gated/missing state, with no version, count or timing. */
export function expectGenericBadge(svg: string): void {
  expect(svg).toMatch(/not available/i);
  expect(svg, "generic badge carries no version").not.toMatch(/v[0-9]+/);
  expect(svg, "generic badge carries no timing").not.toMatch(/just now|\bago\b/i);
  expectNoExactTimestamps(svg);
}

export interface BindingReadCounts {
  d1Prepares: number;
  kvGets: number;
  r2Reads: number;
}

/**
 * Count binding reads (D1 prepares, KV gets, R2 get/head) until `restore()`.
 * Fixture setup must finish before wrapping; only the measured requests run inside.
 */
export function countBindingReads(): { counts: BindingReadCounts; restore: () => void } {
  const counts: BindingReadCounts = { d1Prepares: 0, kvGets: 0, r2Reads: 0 };
  const db = env.DB;
  const cache = env.CACHE;
  const files = env.FILES;
  const origPrepare = db.prepare;
  const origKvGet = cache.get;
  const origR2Get = files.get;
  const origR2Head = files.head;
  const boundPrepare = origPrepare.bind(db) as unknown as (query: string) => unknown;
  const boundKvGet = origKvGet.bind(cache) as unknown as (...args: unknown[]) => unknown;
  const boundR2Get = origR2Get.bind(files) as unknown as (...args: unknown[]) => unknown;
  const boundR2Head = origR2Head.bind(files) as unknown as (...args: unknown[]) => unknown;
  db.prepare = ((query: string) => {
    counts.d1Prepares += 1;
    return boundPrepare(query);
  }) as unknown as typeof db.prepare;
  cache.get = ((...args: unknown[]) => {
    counts.kvGets += 1;
    return boundKvGet(...args);
  }) as unknown as typeof cache.get;
  files.get = ((...args: unknown[]) => {
    counts.r2Reads += 1;
    return boundR2Get(...args);
  }) as unknown as typeof files.get;
  files.head = ((...args: unknown[]) => {
    counts.r2Reads += 1;
    return boundR2Head(...args);
  }) as unknown as typeof files.head;
  return {
    counts,
    restore: () => {
      db.prepare = origPrepare;
      cache.get = origKvGet;
      files.get = origR2Get;
      files.head = origR2Head;
    },
  };
}

/**
 * Hotlink-burst budget for BURST_REQUESTS sequential badge reads after warmup.
 * One D1 prepare per request is the transfer-mode check serveSite already pays;
 * the live manifest itself must come from the memory/KV path (no per-request D1
 * scan, no R2 blob reads). Without the cache the same burst costs ~150 D1
 * prepares, so this budget distinguishes the specified read path.
 */
export const BURST_REQUESTS = 50;
export const BURST_BUDGET: BindingReadCounts = { d1Prepares: 60, kvGets: 5, r2Reads: 0 };
