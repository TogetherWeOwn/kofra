/**
 * Protected acceptance: serve an embeddable live-version badge (SITE-BADGE).
 *
 * Item TOG-43036 for the TOG-43039 build. These tests fail on main: no badge
 * route exists, so every badge address answers 404/401/308/410 today. The
 * builder makes them pass on this branch without editing this file or its
 * protected helpers (test/site-badge.helpers.ts).
 *
 * Contract (badge address = site URL + "badge.svg", in every serving mode):
 * - (1) A public, live, unexpired ordinary site gets 200 + a small flat SVG
 *   naming the live version (vN) and a coarse relative age (minute/hour/day
 *   wording, never an exact timestamp). Headers: Content-Type image/svg+xml,
 *   X-Content-Type-Options nosniff, Cache-Control public, max-age=300.
 *   The SVG is static markup with escaped text only: no script, no event
 *   handlers, no external references, no user-controlled markup.
 * - (2-7) Passworded, expired, missing, transfer-mode, renamed-away and
 *   taken-down sites all get 200 + the byte-identical generic "not available"
 *   SVG with identical headers: no version, count or timing details, no
 *   credentials accepted or required, no Set-Cookie. Probing reveals nothing.
 * - (8) Path and subdomain modes are equivalent; the implementation must not
 *   hard-code a serving path (every address here derives from API responses).
 * - (9) The badge reflects a republish within the cache window (immediately:
 *   no stale server-side badge bytes).
 * - (10) A 50-request hotlink burst stays within BURST_BUDGET binding reads:
 *   the existing live-pointer path, no per-request D1 scan, no R2 reads.
 * - (11) The dashboard embed snippet is pinned in
 *   packages/server/test/site-badge-snippet.acceptance.test.ts (the Workers
 *   test runtime cannot evaluate scripts; browser-code tests live there).
 *
 * Fixtures are disposable workerd instances (freshInstance): no production,
 * no private fixtures. Anchors (page/API status before each badge read) are
 * positive controls: they pass on main and prove the fixture reached the
 * intended state, so a badge failure means the feature is missing, not that
 * the setup broke.
 *
 * Run: npx vitest run test/site-badge.acceptance.test.ts
 */
import { describe, expect, it } from "vitest";
import { freshInstance } from "./helpers";
import { create as createTransfer, get as getTransfer, instance as transferInstance, SITES } from "./transfer-fixtures";
import {
  BURST_BUDGET,
  BURST_REQUESTS,
  IMAGE_REQUEST,
  badgeUrl,
  countBindingReads,
  deleteSite,
  expectBadgeHeaders,
  expectGenericBadge,
  expectScriptFreeBadge,
  expectVersionedBadge,
  expireSite,
  lockSite,
  publishAnonymous,
  publishSite,
  renameSite,
  republishSite,
  siblingBadgeUrl,
  subdomainBadgeUrl,
  unlockCookie,
} from "./site-badge.helpers";

const SUBDOMAIN_APP = "https://badge-app.test";
const SUBDOMAIN_DOMAIN = "badge-sites.test";
const PASSWORD = "badge-fixture-password-1";

describe("live-version badge: public site (case 1)", () => {
  it("serves a versioned, script-free SVG with the badge headers", async () => {
    const dw = await freshInstance();
    const site = await publishSite(dw, "badge-public");
    const page = await dw.call(`${site.url}`);
    expect(page.status, "fixture serves its page").toBe(200);

    const res = await dw.call(badgeUrl(site.url));
    expectBadgeHeaders(res);
    const svg = await res.text();
    expectScriptFreeBadge(svg);
    expectVersionedBadge(svg, 1);
  });

  it("serves the identical badge to cross-site image hotlink requests", async () => {
    const dw = await freshInstance();
    const site = await publishSite(dw, "badge-hotlink");
    const plain = await (await dw.call(badgeUrl(site.url))).text();
    const hotlinked = await dw.call(badgeUrl(site.url), { headers: { ...IMAGE_REQUEST } });
    expectBadgeHeaders(hotlinked);
    expect(await hotlinked.text(), "hotlink bytes equal plain bytes").toBe(plain);
  });
});

describe("live-version badge: refusal matrix (cases 2-7)", () => {
  const refusals = new Map<string, { status: number; contentType: string | null; cacheControl: string | null; nosniff: string | null; body: string }>();

  async function collect(caseName: string, res: Response): Promise<string> {
    const body = await res.text();
    refusals.set(caseName, {
      status: res.status,
      contentType: res.headers.get("content-type"),
      cacheControl: res.headers.get("cache-control"),
      nosniff: res.headers.get("x-content-type-options"),
      body,
    });
    return body;
  }

  it("passworded sites get the generic badge, even with a valid unlock cookie (case 2)", async () => {
    const dw = await freshInstance();
    const site = await publishSite(dw, "badge-locked");
    await lockSite(dw, site.slug, PASSWORD);
    const gated = await dw.call(site.url);
    expect(gated.status, "fixture is really gated").toBe(401);
    expect(await gated.text()).toMatch(/password/i);

    const anonymous = await dw.call(badgeUrl(site.url));
    const svg = await collect("passworded", anonymous);
    expectBadgeHeaders(anonymous);
    expectScriptFreeBadge(svg);
    expectGenericBadge(svg);

    const cookie = await unlockCookie(dw, site.url, PASSWORD);
    const unlockedPage = await dw.call(site.url, { headers: { Cookie: cookie } });
    expect(unlockedPage.status, "unlock cookie really opens the site").toBe(200);
    const authed = await dw.call(badgeUrl(site.url), { headers: { Cookie: cookie } });
    expectBadgeHeaders(authed);
    expect(await authed.text(), "badge accepts no credentials: unlocked reads stay generic").toBe(svg);

    const crossSite = await dw.call(badgeUrl(site.url), { headers: { ...IMAGE_REQUEST } });
    expectBadgeHeaders(crossSite);
    expect(await crossSite.text(), "cross-site embeds of a gated site stay generic").toBe(svg);
  });

  it("expired sites get the generic badge (case 3)", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const site = await publishAnonymous(dw);
    await expireSite(site.slug);
    const gone = await dw.call(site.url);
    expect(gone.status, "fixture is really expired").toBe(410);

    const res = await dw.call(badgeUrl(site.url));
    const svg = await collect("expired", res);
    expectBadgeHeaders(res);
    expectScriptFreeBadge(svg);
    expectGenericBadge(svg);
  });

  it("missing sites get the generic badge (case 4)", async () => {
    const dw = await freshInstance();
    const known = await publishSite(dw, "badge-known");
    const missingPage = await dw.call(siblingBadgeUrl(known.url, "badge-never-published").replace(/badge\.svg$/, ""));
    expect(missingPage.status, "fixture slug is really unpublished").toBe(404);

    const res = await dw.call(siblingBadgeUrl(known.url, "badge-never-published"));
    const svg = await collect("missing", res);
    expectBadgeHeaders(res);
    expectScriptFreeBadge(svg);
    expectGenericBadge(svg);
  });

  it("transfer-mode sites get the generic badge without counting a download (case 5)", async () => {
    const dw = await transferInstance();
    const transfer = await createTransfer(dw);
    expect(transfer.slug).toBeTruthy();

    const res = await dw.call(`${SITES}/${transfer.slug}/badge.svg`);
    const svg = await collect("transfer", res);
    expectBadgeHeaders(res);
    expectScriptFreeBadge(svg);
    expectGenericBadge(svg);

    const after = await getTransfer(dw, transfer);
    expect(after.files.map((f) => f.downloads), "badge reads never count as downloads").toEqual([0, 0]);
    expect(after.recipients.map((r) => r.downloads), "badge reads never attribute a recipient").toEqual([0]);
  });

  it("renamed-away slugs get the generic badge while the new name stays versioned (case 6)", async () => {
    const dw = await freshInstance();
    const site = await publishSite(dw, "badge-old-name");
    await renameSite(dw, site.slug, "badge-new-name");
    const oldPage = await dw.call(site.url);
    expect(oldPage.status, "old name still redirects (existing R-59 behavior)").toBe(308);
    expect(oldPage.headers.get("location")).toContain("badge-new-name");

    const res = await dw.call(badgeUrl(site.url));
    const svg = await collect("renamed-away", res);
    expectBadgeHeaders(res);
    expectScriptFreeBadge(svg);
    expectGenericBadge(svg);

    const current = await dw.json("/api/v1/sites/badge-new-name", { key: dw.ownerKey });
    expect(current.status).toBe(200);
    const fresh = await dw.call(badgeUrl((current.body.site as { url: string }).url));
    expectBadgeHeaders(fresh);
    expectVersionedBadge(await fresh.text(), 1);
  });

  it("taken-down sites get the generic badge (case 7)", async () => {
    const dw = await freshInstance();
    const site = await publishSite(dw, "badge-taken-down");
    await deleteSite(dw, site.slug);
    const gone = await dw.call(site.url);
    expect(gone.status, "fixture is really deleted").toBe(404);

    const res = await dw.call(badgeUrl(site.url));
    const svg = await collect("taken-down", res);
    expectBadgeHeaders(res);
    expectScriptFreeBadge(svg);
    expectGenericBadge(svg);
  });

  it("all six refusal badges are byte-identical with identical headers", () => {
    expect(refusals.size, "every refusal case recorded its badge").toBe(6);
    const entries = [...refusals.entries()];
    const first = entries[0]![1];
    for (const [name, r] of entries) {
      expect(r.status, `${name} status`).toBe(200);
      expect(r.body, `${name} bytes equal the ${entries[0]![0]} bytes`).toBe(first.body);
      expect(r.contentType, `${name} content-type`).toBe(first.contentType);
      expect(r.cacheControl, `${name} cache-control`).toBe(first.cacheControl);
      expect(r.nosniff, `${name} nosniff`).toBe(first.nosniff);
    }
  });
});

describe("live-version badge: serving modes (case 8)", () => {
  it("serves the versioned badge at the subdomain-mode address", async () => {
    const dw = await freshInstance({ appOrigin: SUBDOMAIN_APP, sitesMode: "subdomain", sitesDomain: SUBDOMAIN_DOMAIN });
    const site = await publishSite(dw, "badge-subdomain");
    expect(site.url, "subdomain mode uses no path prefix").not.toContain("/s/");
    const page = await dw.call(site.url);
    expect(page.status, "fixture serves its page").toBe(200);

    const res = await dw.call(badgeUrl(site.url));
    expectBadgeHeaders(res);
    const svg = await res.text();
    expectScriptFreeBadge(svg);
    expectVersionedBadge(svg, 1);
  });

  it("generic badge bytes are identical across path and subdomain modes", async () => {
    const pathDw = await freshInstance();
    const known = await publishSite(pathDw, "badge-modes");
    const pathRes = await pathDw.call(siblingBadgeUrl(known.url, "badge-modes-missing"));
    expectBadgeHeaders(pathRes);
    const pathSvg = await pathRes.text();

    const subDw = await freshInstance({ appOrigin: SUBDOMAIN_APP, sitesMode: "subdomain", sitesDomain: SUBDOMAIN_DOMAIN });
    const subRes = await subDw.call(subdomainBadgeUrl(SUBDOMAIN_DOMAIN, "badge-modes-missing"));
    expectBadgeHeaders(subRes);
    const subSvg = await subRes.text();

    expect(subSvg, "generic bytes do not vary by serving mode").toBe(pathSvg);
    expect(subRes.headers.get("content-type")).toBe(pathRes.headers.get("content-type"));
    expect(subRes.headers.get("cache-control")).toBe(pathRes.headers.get("cache-control"));
  });
});

describe("live-version badge: republish freshness (case 9)", () => {
  it("reflects a republish within the cache window", async () => {
    const dw = await freshInstance();
    const site = await publishSite(dw, "badge-fresh");
    const before = await (await dw.call(badgeUrl(site.url))).text();
    expectVersionedBadge(before, 1);
    expect(before).not.toContain("v2");

    await republishSite(dw, site.slug);
    const afterRes = await dw.call(badgeUrl(site.url));
    expectBadgeHeaders(afterRes);
    const after = await afterRes.text();
    expectScriptFreeBadge(after);
    expectVersionedBadge(after, 2);
    expect(after).not.toContain("v1");
  });
});

describe("live-version badge: hotlink burst budget (case 10)", () => {
  it("serves 50 sequential badge reads within the binding-read budget", async () => {
    const dw = await freshInstance();
    const site = await publishSite(dw, "badge-burst");
    const url = badgeUrl(site.url);
    const warm = await dw.call(url);
    expectBadgeHeaders(warm);
    const first = await warm.text();
    expectVersionedBadge(first, 1);

    const { counts, restore } = countBindingReads();
    try {
      for (let i = 0; i < BURST_REQUESTS; i++) {
        const res = await dw.call(url);
        expect(res.status, `burst request ${i}`).toBe(200);
        expect(await res.text(), `burst request ${i} bytes`).toBe(first);
      }
    } finally {
      restore();
    }
    expect(counts.d1Prepares, `D1 prepares for ${BURST_REQUESTS} badge reads`).toBeLessThanOrEqual(BURST_BUDGET.d1Prepares);
    expect(counts.kvGets, `KV gets for ${BURST_REQUESTS} badge reads`).toBeLessThanOrEqual(BURST_BUDGET.kvGets);
    expect(counts.r2Reads, `R2 reads for ${BURST_REQUESTS} badge reads`).toBe(BURST_BUDGET.r2Reads);
  });
});
