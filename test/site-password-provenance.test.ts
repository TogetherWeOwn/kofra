import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshInstance, ORIGIN, type Instance } from "./helpers";
import { attempt, freezePasswordClock, lockedSite, passwordForm, postForm, SITE_PASSWORD } from "./site-password-fixtures";
import { attributeUrl } from "./transfer-fixtures";

const NAV = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
const FRAME = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" };

async function assertUnlock(dw: Instance, url: string, other: string, response: Response, ip: string) {
  expect(response.status).toBe(303);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  const cookie = setCookie!.split(";")[0]!;
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  const content = await dw.call(url, { headers: { Cookie: cookie, "CF-Connecting-IP": ip, ...NAV, "Sec-Fetch-Site": "same-origin" } });
  expect(content.status).toBe(200);
  expect(await content.text()).toContain("private content");
  const isolated = await dw.call(other, { headers: { Cookie: cookie, ...NAV, "Sec-Fetch-Site": "same-origin" } });
  expect(isolated.status).toBe(401);
  expect(await isolated.text()).not.toContain("private content");
}

describe.each([
  { name: "path", config: {} },
  { name: "subdomain", config: { appOrigin: "https://app.test", sitesMode: "subdomain" as const, sitesDomain: "sites.test" } },
])("site password submission provenance in $name mode", ({ name, config }) => {
  beforeEach(() => { freezePasswordClock(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    { label: "foreign top-level navigation", origin: "https://foreign.test", fetchSite: "cross-site", dest: "document" },
    { label: "foreign framed navigation", origin: "https://foreign.test", fetchSite: "cross-site", dest: "iframe" },
    { label: "same-site sibling navigation", origin: name === "path" ? "https://sibling.dropway.test" : "https://sibling.sites.test", fetchSite: "same-site", dest: "document" },
    { label: "foreign Origin without Fetch Metadata", origin: "https://foreign.test" },
    { label: "unsolicited opaque top-level form", origin: "null", fetchSite: "cross-site", dest: "document" },
    { label: "unsolicited opaque framed form", origin: "null", fetchSite: "cross-site", dest: "iframe" },
    { label: "foreign navigation without Origin", fetchSite: "cross-site", dest: "document" },
  ])("rejects $label before charging the visitor or site", async ({ origin, fetchSite, dest }) => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    const form = await passwordForm(dw, url);
    const headers = new Headers({ "CF-Connecting-IP": "192.0.2.1" });
    if (origin) headers.set("Origin", origin);
    if (fetchSite) headers.set("Sec-Fetch-Site", fetchSite);
    if (dest) {
      headers.set("Sec-Fetch-Mode", "navigate");
      headers.set("Sec-Fetch-Dest", dest);
    }
    const unsolicited = [];
    for (let n = 0; n < 12; n++) {
      // An unsolicited sender has not received this visitor's form fields.
      const res = await dw.call(form.action, { method: "POST", headers, body: new URLSearchParams({ password: n % 2 ? "wrong" : SITE_PASSWORD }) });
      unsolicited.push({ status: res.status, cookie: res.headers.has("set-cookie"), cors: res.headers.get("access-control-allow-origin"), privateContent: (await res.text()).includes("private content") });
    }
    expect.soft(unsolicited, "all foreign forms must be refused without a cookie or disclosure").toEqual(
      Array.from({ length: 12 }, () => ({ status: 403, cookie: false, cors: null, privateContent: false })),
    );
    // The attacked IP retains all ten ordinary-site attempts, including on an unrelated site.
    const legitimate = [];
    for (let n = 0; n < 10; n++) {
      const target = n % 2 ? url : other;
      legitimate.push((await attempt(dw, target, n === 0 ? SITE_PASSWORD : "wrong", "192.0.2.1")).status);
    }
    expect.soft(legitimate, "foreign submissions must leave all ten IP attempts intact").toEqual([303, 401, 401, 401, 401, 401, 401, 401, 401, 401]);
    expect((await attempt(dw, other, SITE_PASSWORD, "192.0.2.1")).status).toBe(429);
    // Five legitimate attempts hit this site above; all 25 remaining site attempts must survive.
    const remaining = [];
    for (let n = 0; n < 25; n++) remaining.push((await attempt(dw, url, "wrong", `198.51.100.${n + 1}`)).status);
    expect.soft(remaining, "foreign submissions must not consume the site allowance either").toEqual(Array(25).fill(401));
    expect((await attempt(dw, url, SITE_PASSWORD, "203.0.113.1")).status).toBe(429);
  });

  it("does not trust a foreign non-opaque Origin even with the actual form fields", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const form = await passwordForm(dw, url);
    const res = await postForm(dw, form, SITE_PASSWORD, "192.0.2.1", { Origin: "https://foreign.test", ...FRAME, "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).not.toContain("private content");
    for (let n = 0; n < 10; n++) expect((await attempt(dw, url, "wrong", "192.0.2.1")).status).toBe(401);
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.1")).status).toBe(429);
  });

  it("preserves legitimate same-origin forms using the returned action and fields", async () => {
    const dw = await freshInstance(name === "path"
      ? { appOrigin: ORIGIN, sitesOrigin: "https://isolated-sites.test", sitesSandbox: false }
      : { ...config, sitesSandbox: false });
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    const form = await passwordForm(dw, url, { ...NAV, "Sec-Fetch-Site": "same-origin" });
    expect(form.status).toBe(401);
    expect(form.csp).not.toMatch(/\bsandbox\b/);
    const res = await postForm(dw, form, SITE_PASSWORD, "192.0.2.1", { Origin: new URL(url).origin, ...NAV, "Sec-Fetch-Site": "same-origin" });
    await assertUnlock(dw, url, other, res, "192.0.2.1");
  });

  it("preserves headerless programmatic clients without weakening the password or cookie scope", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    expect((await attempt(dw, url, "wrong", "192.0.2.1")).status).toBe(401);
    await assertUnlock(dw, url, other, await attempt(dw, url, SITE_PASSWORD, "192.0.2.1"), "192.0.2.1");
  });

  it("preserves the app-embedded password form and its cookie isolation", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    const app = name === "subdomain" ? "https://app.test" : ORIGIN;
    const viewerUrl = `${app}/v/protected-site/`;
    const viewer = await dw.call(viewerUrl, { headers: NAV });
    expect(viewer.status).toBe(200);
    let frame: string | null = null;
    await new HTMLRewriter().on("iframe[src]", { element(element) { frame = element.getAttribute("src"); } }).transform(viewer).text();
    expect(frame, "use the iframe actually served by the app").not.toBeNull();
    const form = await passwordForm(dw, attributeUrl(frame!, viewerUrl), {
      ...FRAME, "Sec-Fetch-Site": new URL(url).origin === app ? "same-origin" : "cross-site", Referer: viewerUrl,
    });
    const sandboxed = name === "path";
    if (sandboxed) {
      expect(form.csp).toMatch(/\bsandbox\b/);
      expect(form.csp).not.toContain("allow-same-origin");
    } else expect(form.csp).not.toMatch(/\bsandbox\b/);
    const res = await postForm(dw, form, SITE_PASSWORD, "192.0.2.1", {
      Origin: sandboxed ? "null" : new URL(form.action).origin,
      ...FRAME, "Sec-Fetch-Site": sandboxed ? "cross-site" : "same-origin",
    });
    await assertUnlock(dw, url, other, res, "192.0.2.1");
  });

  it.each(["document", "iframe"])("preserves a real opaque-sandbox %s form with its returned fields", async (dest) => {
    const dw = await freshInstance({ ...config, sitesSandbox: true });
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    const form = await passwordForm(dw, url, { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": dest, "Sec-Fetch-Site": "cross-site" });
    expect(form.csp).toMatch(/\bsandbox\b/);
    expect(form.csp).not.toContain("allow-same-origin");
    const res = await postForm(dw, form, SITE_PASSWORD, "192.0.2.1", {
      Origin: "null", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": dest, "Sec-Fetch-Site": "cross-site",
    });
    await assertUnlock(dw, url, other, res, "192.0.2.1");
  });
});
