/**
 * Pins the badge guarantees the main acceptance contract (site-badge.acceptance.test.ts,
 * protected) does not distinguish: no request recording, the reserved root
 * `badge.svg`, the age source, a not-yet-expired site, and HEAD.
 *
 * Run: npx vitest run test/site-badge-guarantees.acceptance.test.ts
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { clearLiveMemoryCache } from "@dropway/core";
import { freshInstance } from "./helpers";
import { badgeUrl, expectBadgeHeaders, expectGenericBadge, expectVersionedBadge, publishAnonymous, publishSite } from "./site-badge.helpers";

describe("badge guarantees", () => {
  it("does not record badge reads as site requests (no meter, no onRequest hook)", async () => {
    const requested: string[] = [];
    const usage: string[] = [];
    const dw = await freshInstance({}, { adapters: { metering: { record: async (e) => { usage.push(e.type); } } }, hooks: [{ onRequest: async (e) => { requested.push(e.path); } }] });
    const site = await publishSite(dw, "badge-unrecorded");
    expect((await dw.call(site.url)).status, "positive control: a page read is recorded").toBe(200);
    expect(requested).toHaveLength(1);
    expect(usage.filter((t) => t === "site_request")).toHaveLength(1);
    for (const method of ["GET", "HEAD"]) expect((await dw.call(badgeUrl(site.url), { method })).status).toBe(200);
    expect(requested, "badge reads fire no onRequest").toHaveLength(1);
    expect(usage.filter((t) => t === "site_request"), "badge reads are not metered").toHaveLength(1);
  });

  it("reserves the root badge.svg but leaves nested badge.svg files alone", async () => {
    const dw = await freshInstance();
    const site = await publishSite(dw, "badge-reserved", { "index.html": "<h1>x</h1>", "badge.svg": "<svg>OWN-ROOT</svg>", "docs/badge.svg": "<svg>OWN-NESTED</svg>" });
    const root = await dw.call(badgeUrl(site.url));
    const rootText = await root.text();
    expect(rootText, "root badge.svg is the live-version badge, not the published file").not.toContain("OWN-ROOT");
    expectVersionedBadge(rootText, 1);
    const nested = await dw.call(`${site.url}docs/badge.svg`);
    expect(nested.status).toBe(200);
    expect(await nested.text()).toBe("<svg>OWN-NESTED</svg>");
  });

  it("takes the badge age from the version's finalized_at, not created_at", async () => {
    const dw = await freshInstance();
    const site = await publishSite(dw, "badge-age");
    const hour = 3_600_000;
    await env.DB.prepare("UPDATE versions SET finalized_at = ?, created_at = ? WHERE site_id = (SELECT id FROM sites WHERE slug = ?)")
      .bind(Date.now() - 3 * hour, Date.now() - 5 * 24 * hour, site.slug)
      .run();
    await env.CACHE.delete(`live:${site.slug}`);
    clearLiveMemoryCache();
    const svg = await (await dw.call(badgeUrl(site.url))).text();
    expect(svg).toContain("3 h ago");
    expect(svg).not.toContain("5 d ago");
  });

  it("still shows a versioned badge for a site that expires in the future", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const site = await publishAnonymous(dw);
    const row = await env.DB.prepare("SELECT expires_at FROM sites WHERE slug = ?").bind(site.slug).first<{ expires_at: number | null }>();
    expect(row?.expires_at, "positive control: anonymous sites carry a future expiry").toBeGreaterThan(Date.now());
    const res = await dw.call(badgeUrl(site.url));
    expectBadgeHeaders(res);
    expectVersionedBadge(await res.text(), 1);
  });

  it("answers HEAD with the GET headers and no body, versioned or generic", async () => {
    const dw = await freshInstance();
    const site = await publishSite(dw, "badge-head");
    const get = await dw.call(badgeUrl(site.url));
    const head = await dw.call(badgeUrl(site.url), { method: "HEAD" });
    expectBadgeHeaders(head);
    expect(await head.text()).toBe("");
    expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(get.headers));
    const missing = await dw.call(badgeUrl(site.url.replace("badge-head", "badge-nowhere")), { method: "HEAD" });
    expectBadgeHeaders(missing);
    expect(await missing.text()).toBe("");
    expect(Object.fromEntries(missing.headers)).toEqual(Object.fromEntries(get.headers));
    expectGenericBadge(await (await dw.call(badgeUrl(site.url.replace("badge-head", "badge-nowhere")))).text());
  });
});
