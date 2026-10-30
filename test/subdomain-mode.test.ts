import { beforeEach, describe, expect, it } from "vitest";
import { MAX_SLUG_LENGTH, RESERVED_SLUGS, resolveConfig, validateSlug } from "@dropway/core";
import { form, freshInstance, type Instance } from "./helpers";

// Subdomain mode after a move from a path-mode sites origin (OLD) and a workers.dev app.
const APP = "https://app.test";
const OLD = "https://old-sites.test";
const site = (slug: string) => `https://${slug}.sites.test`;
const NAV = { Accept: "text/html,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" };
const FRAME = { Accept: "text/html,*/*;q=0.8", "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "cross-site" };

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance({ appOrigin: APP, sitesMode: "subdomain", sitesDomain: "sites.test", legacySitesOrigins: [OLD] });
  for (const slug of ["my-site", "locked-site"]) {
    const pub = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({ "index.html": `<script src="app.js"></script>${slug}`, "app.js": "window.secret = 42;", "a/b/c.txt": "c" }, { slug }),
    });
    expect(pub.status).toBe(201);
  }
  const lock = await dw.json("/api/v1/sites/locked-site/access", { method: "PUT", key: dw.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "password", password: "secret1" }) });
  expect(lock.status).toBe(200);
});

/** Unlock locked-site; returns the Set-Cookie header and the cookie pair to send back. */
async function unlock(headers: Record<string, string> = NAV) {
  const res = await dw.call(`${site("locked-site")}/__dropway/password`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
    body: "password=secret1&next=%2F",
  });
  expect(res.status).toBe(303);
  const setCookie = res.headers.get("set-cookie")!;
  return { setCookie, cookie: setCookie.split(";")[0]! };
}

describe("legacy path-mode sites origin (P1): 308 to the site's own origin, path and query kept", () => {
  const matrix: Array<[string, string, string?]> = [
    ["/my-site/", `${site("my-site")}/`],
    ["/my-site", `${site("my-site")}/`],
    ["/my-site/index.html", `${site("my-site")}/index.html`],
    ["/my-site/a/b/c.txt", `${site("my-site")}/a/b/c.txt`],
    ["/my-site/?q=1", `${site("my-site")}/?q=1`],
    ["/my-site/page?x=1&y=two", `${site("my-site")}/page?x=1&y=two`],
    ["/my-site/a/", `${site("my-site")}/a/`],
    ["/my-site/space%20name.html", `${site("my-site")}/space%20name.html`],
    ["/my-site/report.md?raw=1", `${site("my-site")}/report.md?raw=1`],
    ["/my-site/app.js?view=source&embed=1", `${site("my-site")}/app.js?view=source&embed=1`],
    ["/locked-site/", `${site("locked-site")}/`],
    ["/locked-site/__dropway/password", `${site("locked-site")}/__dropway/password`, "POST"],
    ["/my-site/a/b/c.txt", `${site("my-site")}/a/b/c.txt`, "HEAD"],
    ["/never-published/x", `${site("never-published")}/x`],
    ["/", APP],
  ];
  for (const [path, location, method] of matrix) {
    it(`${method ?? "GET"} ${path}`, async () => {
      const res = await dw.call(`${OLD}${path}`, { method: method ?? "GET", headers: NAV, ...(method === "POST" ? { body: "password=x" } : {}) });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(location);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  }

  it("sends an absolute path from an old page (Referer) to that site, uncached", async () => {
    const res = await dw.call(`${OLD}/assets/app.js?v=3`, { headers: { Referer: `${OLD}/my-site/index.html` } });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${site("my-site")}/assets/app.js?v=3`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("Referer");
  });

  it("answers 404 for reserved, malformed and unreferenced paths", async () => {
    for (const path of ["/assets/app.js", "/www/x", "/a--b/x", "/MY-SITE/x", "/x/"]) {
      const res = await dw.call(`${OLD}${path}`, { headers: { ...NAV, Referer: "https://elsewhere.test/my-site/" } });
      expect(res.status, path).toBe(404);
    }
  });

  it("serves the sites themselves on their new origin", async () => {
    const res = await dw.call(`${site("my-site")}/a/b/c.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("c");
  });

  it("parses LEGACY_SITES_ORIGINS and never lists the current app or sites origin", () => {
    const c = resolveConfig({ APP_ORIGIN: APP, SITES_MODE: "subdomain", SITES_DOMAIN: "sites.test", LEGACY_SITES_ORIGINS: `${OLD}/, ${APP} bad ${OLD}` });
    expect(c.legacySitesOrigins).toEqual([OLD]);
    expect(resolveConfig({ SITES_ORIGIN: OLD, LEGACY_SITES_ORIGINS: OLD }).legacySitesOrigins).toEqual([]);
    expect(resolveConfig({}).legacySitesOrigins).toEqual([]);
  });

  it("keeps a legacy origin that SITES_ORIGIN still names in subdomain mode (ignored there), and redirects it", async () => {
    // An operator moving from option B leaves SITES_ORIGIN set to the old sites Worker and lists it as legacy.
    const vars = { APP_ORIGIN: APP, SITES_MODE: "subdomain", SITES_DOMAIN: "sites.test", SITES_ORIGIN: OLD, LEGACY_SITES_ORIGINS: OLD };
    const c = resolveConfig(vars);
    expect(c.sitesOrigin).toBeNull();
    expect(c.legacySitesOrigins).toEqual([OLD]);
    // The same vars as a deployed Worker: old links redirect instead of showing the app.
    const { appOrigin, sitesMode, sitesDomain, sitesOrigin, legacySitesOrigins } = c;
    const moved = await freshInstance({ appOrigin, sitesMode, sitesDomain, sitesOrigin, legacySitesOrigins });
    const res = await moved.call(`${OLD}/my-site/a/b/c.txt?q=1`, { headers: NAV });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${site("my-site")}/a/b/c.txt?q=1`);
  });
});

describe("reserved labels on the sites domain (P2)", () => {
  it("www goes to the app; platform and malformed labels are never user sites", async () => {
    const www = await dw.call("https://www.sites.test/anything", { headers: NAV });
    expect(www.status).toBe(301);
    expect(www.headers.get("location")).toBe(APP);
    const apex = await dw.call("https://sites.test/", { headers: NAV });
    expect(apex.status).toBe(301);
    for (const host of ["files", "fallback", "customers", "kofra", "api", "a.b", "my-site--v2", "x"]) {
      const res = await dw.call(`https://${host}.sites.test/`, { headers: NAV });
      expect(res.status, host).toBe(404);
      expect(res.headers.get("x-kofra-site"), host).toBeNull();
    }
  });

  it("reserves kofra, fallback and customers (files and dropway already were)", () => {
    for (const s of ["kofra", "fallback", "customers", "files", "dropway", "www"]) {
      expect(RESERVED_SLUGS.has(s), s).toBe(true);
      expect(() => validateSlug(s)).toThrow(/reserved/);
    }
  });
});

describe("preview label length (P4)", () => {
  it("caps new site names so <slug>--v<N> fits one DNS label (63) for N up to 9999", async () => {
    expect(MAX_SLUG_LENGTH + "--v9999".length).toBe(63);
    const longest = `a${"b".repeat(MAX_SLUG_LENGTH - 2)}c`;
    expect(validateSlug(longest)).toBe(longest);
    expect(() => validateSlug(`${longest}d`)).toThrow(/not a valid site name/);
    const res = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "x" }, { slug: `${longest}d` }) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_slug");
    expect(res.body.error.hint).toContain("3-56 characters");
  });
});

describe("password gate in subdomain mode (P3, P7, viewer)", () => {
  it("sets a __Host- Lax cookie at top level and serves the site with it", async () => {
    const { setCookie, cookie } = await unlock();
    expect(setCookie).toMatch(/^__Host-dw_pw_locked_site=[a-f0-9]{40}; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/);
    const page = await dw.call(`${site("locked-site")}/`, { headers: { ...NAV, Cookie: cookie } });
    expect(page.status).toBe(200);
    // The old, unprefixed name is not accepted in subdomain mode.
    const legacyName = await dw.call(`${site("locked-site")}/`, { headers: { ...NAV, Cookie: cookie.replace("__Host-", "") } });
    expect(legacyName.status).toBe(401);
  });

  it("works inside the app's file viewer, a cross-site frame: the form may be framed by the app only, and the cookie is partitioned", async () => {
    const form401 = await dw.call(`${site("locked-site")}/`, { headers: FRAME });
    expect(form401.status).toBe(401);
    expect(form401.headers.get("content-security-policy")).toContain(`frame-ancestors ${APP}`);
    const { setCookie, cookie } = await unlock(FRAME);
    expect(setCookie).toMatch(/^__Host-dw_pwe_locked_site=[a-f0-9]{40}; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=None; Partitioned$/);
    const framed = await dw.call(`${site("locked-site")}/?view=1&embed=1`, { headers: { ...FRAME, Cookie: cookie } });
    expect(framed.status).toBe(200);
    // The framed page's own sub-resources are same-origin.
    const js = await dw.call(`${site("locked-site")}/app.js`, { headers: { "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "same-origin", Cookie: cookie } });
    expect(js.status).toBe(200);
    // The viewer page frames the site's own origin, through its __dropway/open with the embed, so the gate is
    // drawn without a header and footer of its own inside the app.
    const viewer = await dw.call(`${APP}/v/locked-site/`, { headers: NAV });
    expect(await viewer.text()).toContain(`src="${site("locked-site")}/__dropway/open?next=%2F&amp;embed=1"`);
    const gate = await dw.call(`${site("locked-site")}/__dropway/open?next=%2F&embed=1`, { headers: FRAME });
    expect(gate.status).toBe(401);
    expect(await gate.text()).not.toContain('<header class="k-sitehead"');
    expect(viewer.headers.get("content-security-policy")).toContain("frame-src 'self' https://*.sites.test");
  });

  it("gated responses carry no CORS and CORP same-origin; other sites cannot load them even when unlocked", async () => {
    const { cookie } = await unlock();
    const page = await dw.call(`${site("locked-site")}/`, { headers: { ...NAV, Cookie: cookie } });
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const gate = await dw.call(`${site("locked-site")}/`, { headers: NAV });
    expect(gate.status).toBe(401);
    expect(gate.headers.get("access-control-allow-origin")).toBeNull();
    expect(gate.headers.get("cross-origin-resource-policy")).toBe("same-origin");

    for (const [fetchSite, dest] of [["same-site", "script"], ["cross-site", "image"], ["same-site", "empty"], ["cross-site", "style"]] as const) {
      const res = await dw.call(`${site("locked-site")}/app.js`, { headers: { "Sec-Fetch-Site": fetchSite, "Sec-Fetch-Dest": dest, "Sec-Fetch-Mode": "no-cors", Cookie: cookie } });
      expect(res.status, `${fetchSite} ${dest}`).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(await res.text()).not.toContain("secret");
    }
    // Same-origin requests and clients without Fetch Metadata (curl) still work with the cookie.
    expect((await dw.call(`${site("locked-site")}/app.js`, { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "script", Cookie: cookie } })).status).toBe(200);
    expect((await dw.call(`${site("locked-site")}/app.js`, { headers: { Cookie: cookie } })).status).toBe(200);
    // Navigations from other sites still reach the gate (links and frames work).
    expect((await dw.call(`${site("locked-site")}/`, { headers: { ...NAV, "Sec-Fetch-Site": "cross-site" } })).status).toBe(401);
  });

  it("preflights for a gated site grant nothing; public sites are unchanged", async () => {
    const pre = await dw.call(`${site("locked-site")}/app.js`, { method: "OPTIONS", headers: { Origin: site("my-site"), "Access-Control-Request-Method": "GET" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    const pubPre = await dw.call(`${site("my-site")}/app.js`, { method: "OPTIONS", headers: { Origin: site("locked-site"), "Access-Control-Request-Method": "GET" } });
    expect(pubPre.headers.get("access-control-allow-origin")).toBe("*");
    const pub = await dw.call(`${site("my-site")}/app.js`, { headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors" } });
    expect(pub.status).toBe(200);
    expect(pub.headers.get("access-control-allow-origin")).toBe("*");
    expect(pub.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
  });
});

describe("password gate in path mode", () => {
  it("keeps the unprefixed cookie scoped to the site path, and sandboxed gated sites keep their sub-resources", async () => {
    const path = await freshInstance();
    const pub = await path.json("/api/v1/publish", { method: "POST", key: path.ownerKey, body: form({ "index.html": "x", "app.js": "y" }, { slug: "path-locked" }) });
    expect(pub.status).toBe(201);
    await path.json("/api/v1/sites/path-locked/access", { method: "PUT", key: path.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "password", password: "secret1" }) });
    const res = await path.call("/s/path-locked/__dropway/password", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=secret1" });
    expect(res.status).toBe(303);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^dw_pw_path_locked=[a-f0-9]{40}; Path=\/s\/path-locked\/; Max-Age=604800; HttpOnly; Secure; SameSite=None$/);
    // Shared-origin sites are sandboxed (opaque origin): their own requests are cross-site, so no 403 and CORP stays cross-origin.
    const js = await path.call("/s/path-locked/app.js", { headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "script", Cookie: setCookie.split(";")[0]! } });
    expect(js.status).toBe(200);
    expect(js.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(js.headers.get("access-control-allow-origin")).toBeNull();
  });
});
