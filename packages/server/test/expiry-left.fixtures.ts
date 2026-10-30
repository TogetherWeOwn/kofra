/** Protected acceptance fixtures: only the Test Author may change this file. */
export const now = Date.parse("2026-10-26T12:00:00.000Z");
export const minute = 60_000;
export const hour = 60 * minute;
export const day = 24 * hour;
export const instant = (offset: number) => new Date(now + offset).toISOString();
export const slug = "expiry-fixture";
export const base = `/api/v1/sites/${slug}`;
export type Surface = "sites" | "site" | "keys";
export const surfaces: Surface[] = ["sites", "site", "keys"];
export const paths = { sites: "/dashboard", site: `/dashboard/sites/${slug}`, keys: "/dashboard/keys" };
export const roots = { sites: "dw-sites", site: "dw-site", keys: "dw-keys" };
export const marker = '<img src=x onerror="window.__expiryMarkupExecuted=true">';
export const account = { principal: "member", scopes: ["sites:read", "sites:write", "sites:delete", "keys:write"],
  siteRestriction: null, member: { id: "member-fixture", email: "expiry@example.test", role: "owner" } };
export function site(expiresAt?: string | null) {
  return { id: "site-fixture", slug, title: "Timing fixture", description: "", url: `https://files.example.test/${slug}/`,
    expiresAt, createdAt: instant(-day), updatedAt: instant(-hour), currentVersion: null, currentVersionId: null,
    settings: { spa: false, renderMarkdown: true, crossOriginIsolation: false, passwordProtected: false } };
}
export function key(expiresAt?: string | null) {
  return { id: "key-fixture", name: "Expiry fixture key", prefix: "dw_fixture", scopes: ["sites:read"],
    siteId: null, current: false, createdAt: instant(-day), lastUsedAt: null, expiresAt };
}
export function reply(path: string, expiresAt?: string | null) {
  if (path === "/api/v1/me") return account;
  if (path === "/api/v1/sites") return { sites: [site(expiresAt)], nextCursor: null };
  if (path === base) return { site: site(expiresAt) };
  if (path === `${base}/versions`) return { versions: [], currentVersionId: null };
  if (path === "/api/v1/keys") return { keys: [key(expiresAt)] };
  throw Error(`Unexpected fixture request: ${path}`);
}
export const reads = {
  sites: ["/api/v1/me", "/api/v1/sites?limit=100"],
  site: ["/api/v1/me", base, `${base}/versions?limit=100`],
  keys: ["/api/v1/me", "/api/v1/sites?limit=200", "/api/v1/keys"],
};

// Literal expectations, derived from the spec and the existing ago() rounding.
// Date fallback uses the browser's own locale, never a hard-coded timezone.
export const boundaries = [
  { label: "one second", offset: 1000, want: "Expires in under a minute" },
  { label: "44 seconds", offset: 44_000, want: "Expires in under a minute" },
  { label: "45 seconds", offset: 45_000, want: "Expires in 1 min" },
  { label: "59 minutes", offset: 59 * minute, want: "Expires in 59 min" },
  { label: "minute rounding below hour", offset: 59 * minute + 29_000, want: "Expires in 59 min" },
  { label: "minute rounding to hour", offset: 59 * minute + 30_000, want: "Expires in 1 h" },
  { label: "one hour", offset: hour, want: "Expires in 1 h" },
  { label: "three hours", offset: 3 * hour, want: "Expires in 3 h" },
  { label: "23 hours", offset: 23 * hour, want: "Expires in 23 h" },
  { label: "hour rounding to day", offset: 23 * hour + 30 * minute, want: "Expires in 1 day" },
  { label: "one day", offset: day, want: "Expires in 1 day" },
  { label: "two days", offset: 2 * day, want: "Expires in 2 days" },
  { label: "29 days", offset: 29 * day, want: "Expires in 29 days" },
  { label: "just expired", offset: -10_000, want: "Expired just now" },
  { label: "already past", offset: -3 * hour, want: "Expired 3 h ago" },
  { label: "two days past", offset: -2 * day, want: "Expired 2 days ago" },
];
