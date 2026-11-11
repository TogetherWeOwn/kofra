import { describe, expect, it } from "vitest";
import { resolveConfig } from "@kofra/core";
import { form, freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";

// In path mode on a separate sites origin every site shares one web origin, so a
// fetch from one site's page to another site's path is same-origin and carries
// the victim site's path-scoped cookie. These tests pin the refusal of that
// cross-site-path fetch for gated and preview assets, while same-site fetches
// and direct navigations keep working. Sandboxed serving (the default there)
// is the primary isolation; the Referer-prefix refusal covers the explicit
// SITES_SANDBOX=false opt-out.
const SITES = "https://sites.example";
const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" };
const SECRET = "gated-secret-body";

async function publishLocked(dw: Instance, slug: string) {
  const pub = await dw.json("/api/v1/publish", {
    method: "POST",
    key: dw.ownerKey,
    body: form({ "index.html": "<p>home</p>", "data.txt": SECRET }, { slug }),
  });
  expect(pub.status).toBe(201);
  const lock = await dw.json(`/api/v1/sites/${slug}/access`, {
    method: "PUT",
    key: dw.ownerKey,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "password", password: "secret12" }),
  });
  expect(lock.status).toBe(200);
  const unlock = await dw.call(`${SITES}/${slug}/__dropway/password`, {
    method: "POST",
    headers: { ...NAV, "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
    body: "password=secret12&next=%2F",
  });
  expect(unlock.status).toBe(303);
  return unlock.headers.get("set-cookie")!.split(";")[0]!;
}

describe("cross-site-path fetch on a separate sites origin (unsandboxed opt-out)", () => {
  it("refuses a fetch from another site's page context, serves same-site fetches and navigations", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: SITES, sitesSandbox: false });
    const cookie = await publishLocked(dw, "victim-site");
    const asset = `${SITES}/victim-site/data.txt`;

    // Attacker page context: same-origin fetch, victim cookie, attacker Referer.
    const attack = await dw.call(asset, {
      headers: {
        Cookie: cookie,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        Referer: `${SITES}/attacker-site/index.html`,
      },
    });
    expect(attack.status).toBe(403);
    expect(await attack.text()).not.toContain(SECRET);

    // Same-site fetch: Referer under the victim's own prefix.
    const sameSite = await dw.call(asset, {
      headers: {
        Cookie: cookie,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        Referer: `${SITES}/victim-site/index.html`,
      },
    });
    expect(sameSite.status).toBe(200);
    expect(await sameSite.text()).toBe(SECRET);

    // A browser fetch with no Referer suppressed the initiator: refused.
    const suppressed = await dw.call(asset, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "empty" },
    });
    expect(suppressed.status).toBe(403);
    expect(await suppressed.text()).not.toContain(SECRET);

    // Programmatic clients without Fetch Metadata keep working with the cookie.
    const cli = await dw.call(asset, { headers: { Cookie: cookie } });
    expect(cli.status).toBe(200);

    // Top-level navigation with the cookie still serves, even from another site.
    const nav = await dw.call(`${SITES}/victim-site/`, {
      headers: { ...NAV, Cookie: cookie, "Sec-Fetch-Site": "same-origin", Referer: `${SITES}/attacker-site/` },
    });
    expect(nav.status).toBe(200);
    expect(await nav.text()).toContain("home");
  });

  it("refuses a cross-site-path fetch of a version preview asset", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: SITES, sitesSandbox: false });
    const pub = await dw.json<{ versionUrl: string }>("/api/v1/publish", {
      key: dw.ownerKey,
      ...jsonBody({ site: "victim-site", files: [{ path: "index.html", content: "<p>preview</p>" }, { path: "data.txt", content: SECRET }] }),
    });
    expect(pub.status).toBe(201);
    const redeem = await dw.call(pub.body.versionUrl);
    expect(redeem.status).toBe(303);
    const cookie = redeem.headers.get("set-cookie")!.split(";")[0]!;
    const asset = `${SITES}/victim-site--v1/data.txt`;

    const attack = await dw.call(asset, {
      headers: {
        Cookie: cookie,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Dest": "empty",
        Referer: `${SITES}/attacker-site/index.html`,
      },
    });
    expect(attack.status).toBe(404);
    expect(await attack.text()).not.toContain(SECRET);

    const sameSite = await dw.call(asset, {
      headers: {
        Cookie: cookie,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Dest": "empty",
        Referer: `${SITES}/victim-site--v1/index.html`,
      },
    });
    expect(sameSite.status).toBe(200);
    expect(await sameSite.text()).toBe(SECRET);

    const nav = await dw.call(`${SITES}/victim-site--v1/`, {
      headers: { ...NAV, Cookie: cookie, "Sec-Fetch-Site": "same-origin", Referer: `${SITES}/attacker-site/` },
    });
    expect(nav.status).toBe(200);
    expect(await nav.text()).toContain("preview");
  });
});

describe("sandbox default on a separate sites origin", () => {
  it("SITES_SANDBOX=auto sandboxes every site in path mode on a separate sites origin", () => {
    const pick = (vars: Record<string, string>) => {
      const c = resolveConfig(vars);
      return [c.sitesSandbox, c.sitesSandboxAnonymous];
    };
    const sitesOrigin = { APP_ORIGIN: ORIGIN, SITES_ORIGIN: SITES };
    expect(pick(sitesOrigin)).toEqual([true, true]);
    expect(pick({ ...sitesOrigin, SITES_SANDBOX: "auto" })).toEqual([true, true]);
    expect(pick({ ...sitesOrigin, SITES_SANDBOX: "true" })).toEqual([true, false]);
    expect(pick({ ...sitesOrigin, SITES_SANDBOX: "false" })).toEqual([false, false]);
    expect(pick({ SITES_MODE: "subdomain", SITES_DOMAIN: "sites.test" })).toEqual([false, false]);
  });

  it("serves keyed sites sandboxed by default, with their own sub-resources working", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: SITES });
    const cookie = await publishLocked(dw, "victim-site");
    const page = await dw.call(`${SITES}/victim-site/`, { headers: { ...NAV, Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    // A sandboxed page's own requests are cross-site, so they are left to the cookie.
    const js = await dw.call(`${SITES}/victim-site/data.txt`, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "empty" },
    });
    expect(js.status).toBe(200);
    expect(await js.text()).toBe(SECRET);
  });
});
