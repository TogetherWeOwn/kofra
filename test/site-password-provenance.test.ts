import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { ServerBindings } from "@dropway/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshInstance, ORIGIN, type Instance } from "./helpers";
import { attempt, formSubmission, freezePasswordClock, lockedSite, passwordForm, postForm, SITE_PASSWORD, WINDOW_MS, type PasswordForm } from "./site-password-fixtures";
import { attributeUrl } from "./transfer-fixtures";

const NAV = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
const FRAME = { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" };
const OPAQUE = { Origin: "null", ...NAV, "Sec-Fetch-Site": "cross-site" };
const VISITOR_IP = "192.0.2.1";

async function submittedBody(dw: Instance, url: string, init: RequestInit & { body: URLSearchParams }) {
  let pulls = 0;
  const bytes = new TextEncoder().encode(init.body.toString());
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    pulls++;
    controller.enqueue(bytes);
    controller.close();
  } }, { highWaterMark: 0 });
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/x-www-form-urlencoded");
  const req = new Request(url, { ...init, headers, body, redirect: "manual" });
  const ctx = createExecutionContext();
  try {
    const res = await dw.dropway.fetch(req, env as unknown as ServerBindings, ctx);
    await waitOnExecutionContext(ctx);
    return { res, pulls, bodyUsed: req.bodyUsed };
  } finally {
    if (req.body && !req.body.locked) await req.body.cancel();
  }
}

/** Forward all opaque form state, changing only the public site's URL root. */
function formAtSite(form: PasswordForm, source: string, destination: string): PasswordForm {
  const from = new URL(source);
  const to = new URL(destination);
  const action = new URL(form.action);
  expect(action.origin).toBe(from.origin);
  expect(action.pathname.startsWith(from.pathname)).toBe(true);
  to.pathname += action.pathname.slice(from.pathname.length);
  to.search = action.search;
  to.hash = action.hash;
  return { ...form, action: to.href };
}

async function assertUncharged(dw: Instance, url: string, other: string, ip: string) {
  // Probe the IP on another site, so spending it cannot mask a debit to the attacked site.
  const ipResults = [];
  for (let n = 0; n < 10; n++) ipResults.push((await attempt(dw, other, n === 0 ? SITE_PASSWORD : "wrong", ip)).status);
  expect.soft(ipResults, "refused provenance must leave all ten IP attempts intact").toEqual([303, 401, 401, 401, 401, 401, 401, 401, 401, 401]);
  expect((await attempt(dw, other, SITE_PASSWORD, ip)).status).toBe(429);
  const siteResults = [];
  for (let n = 0; n < 30; n++) siteResults.push((await attempt(dw, url, "wrong", `198.51.100.${n + 1}`)).status);
  expect.soft(siteResults, "refused provenance must independently leave all 30 site attempts intact").toEqual(Array(30).fill(401));
  expect((await attempt(dw, url, SITE_PASSWORD, "203.0.113.1")).status).toBe(429);
}

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
    const publicEndpoint = new URL("__dropway/password", url).href;
    const headers = new Headers({ "CF-Connecting-IP": VISITOR_IP });
    if (origin) headers.set("Origin", origin);
    if (fetchSite) headers.set("Sec-Fetch-Site", fetchSite);
    if (dest) {
      headers.set("Sec-Fetch-Mode", "navigate");
      headers.set("Sec-Fetch-Dest", dest);
    }
    const unsolicited = [];
    for (let n = 0; n < 12; n++) {
      // A sender knows the public endpoint, not the visitor's action, fields or cookies.
      const probe = await submittedBody(dw, publicEndpoint, { method: "POST", headers, body: new URLSearchParams({ password: n % 2 ? "wrong" : SITE_PASSWORD }) });
      const res = probe.res;
      unsolicited.push({ status: res.status, cookie: res.headers.has("set-cookie"), cors: res.headers.get("access-control-allow-origin"), privateContent: (await res.text()).includes("private content"), pulls: probe.pulls, bodyUsed: probe.bodyUsed });
    }
    expect.soft(unsolicited, "all foreign forms must be refused before body consumption, without a cookie or disclosure").toEqual(
      Array.from({ length: 12 }, () => ({ status: 403, cookie: false, cors: null, privateContent: false, pulls: 0, bodyUsed: false })),
    );
    // The attacked IP retains all ten ordinary-site attempts, including on an unrelated site.
    const legitimate = [];
    for (let n = 0; n < 10; n++) {
      const target = n % 2 ? url : other;
      legitimate.push((await attempt(dw, target, n === 0 ? SITE_PASSWORD : "wrong", VISITOR_IP)).status);
    }
    expect.soft(legitimate, "foreign submissions must leave all ten IP attempts intact").toEqual([303, 401, 401, 401, 401, 401, 401, 401, 401, 401]);
    expect((await attempt(dw, other, SITE_PASSWORD, VISITOR_IP)).status).toBe(429);
    // Five legitimate attempts hit this site above; all 25 remaining site attempts must survive.
    const remaining = [];
    for (let n = 0; n < 25; n++) remaining.push((await attempt(dw, url, "wrong", `198.51.100.${n + 1}`)).status);
    expect.soft(remaining, "foreign submissions must not consume the site allowance either").toEqual(Array(25).fill(401));
    expect((await attempt(dw, url, SITE_PASSWORD, "203.0.113.1")).status).toBe(429);
  });

  it("does not trust a foreign non-opaque Origin even with the actual form state", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    const form = await passwordForm(dw, url, VISITOR_IP);
    const probe = await submittedBody(dw, form.action, formSubmission(form, SITE_PASSWORD, VISITOR_IP, { Origin: "https://foreign.test", ...FRAME, "Sec-Fetch-Site": "cross-site" }));
    expect.soft(probe.res.status).toBe(403);
    expect.soft(probe.pulls).toBe(0);
    expect.soft(probe.bodyUsed).toBe(false);
    expect.soft(probe.res.headers.get("set-cookie")).toBeNull();
    expect(await probe.res.text()).not.toContain("private content");
    await assertUncharged(dw, url, other, VISITOR_IP);
  });

  it.each([
    { label: "a different trusted IP", sourceIp: "192.0.2.10", differentSite: false, expired: false },
    { label: "an identified POST after an unidentified GET", sourceIp: undefined, differentSite: false, expired: false },
    { label: "a different protected site", sourceIp: VISITOR_IP, differentSite: true, expired: false },
    { label: "a stale form after two days", sourceIp: VISITOR_IP, differentSite: false, expired: true },
  ])("refuses transplanted provenance for $label before reading or charging", async ({ sourceIp, differentSite, expired }) => {
    const dw = await freshInstance({ ...config, sitesSandbox: true });
    const source = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    const original = await passwordForm(dw, source, sourceIp, { ...NAV, "Sec-Fetch-Site": "cross-site" });
    expect(original.csp).toMatch(/\bsandbox\b/);
    expect(original.csp).not.toContain("allow-same-origin");
    const target = differentSite ? other : source;
    const unrelated = differentSite ? source : other;
    const forwarded = differentSite ? formAtSite(original, source, target) : original;
    // Use a generous two-day upper bound without decoding the proof or requiring an exact TTL.
    if (expired) vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60_000);
    const probe = await submittedBody(dw, forwarded.action, formSubmission(forwarded, SITE_PASSWORD, VISITOR_IP, OPAQUE));
    expect.soft(probe.res.status, "all returned action/field/cookie state must still be request-bound").toBe(403);
    expect.soft(probe.pulls, "refused provenance must not read a request-body chunk").toBe(0);
    expect.soft(probe.bodyUsed).toBe(false);
    expect.soft(probe.res.headers.get("set-cookie")).toBeNull();
    expect.soft(probe.res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await probe.res.text()).not.toContain("private content");
    await assertUncharged(dw, target, unrelated, VISITOR_IP);

    // Both budgets above were deliberately exhausted; a new window and this visitor's new form must work.
    vi.setSystemTime(Date.now() + WINDOW_MS);
    const fresh = await passwordForm(dw, target, VISITOR_IP, { ...NAV, "Sec-Fetch-Site": "cross-site" });
    await assertUnlock(dw, target, unrelated, await postForm(dw, fresh, SITE_PASSWORD, VISITOR_IP, OPAQUE), VISITOR_IP);
  });

  it("preserves legitimate same-origin forms using the returned action and fields", async () => {
    const dw = await freshInstance(name === "path"
      ? { appOrigin: ORIGIN, sitesOrigin: "https://isolated-sites.test", sitesSandbox: false }
      : { ...config, sitesSandbox: false });
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    const form = await passwordForm(dw, url, VISITOR_IP, { ...NAV, "Sec-Fetch-Site": "same-origin" });
    expect(form.status).toBe(401);
    expect(form.csp).not.toMatch(/\bsandbox\b/);
    const res = await postForm(dw, form, SITE_PASSWORD, VISITOR_IP, { Origin: new URL(url).origin, ...NAV, "Sec-Fetch-Site": "same-origin" });
    await assertUnlock(dw, url, other, res, VISITOR_IP);
  });

  it("preserves headerless programmatic clients without weakening the password or cookie scope", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    expect((await attempt(dw, url, "wrong", VISITOR_IP)).status).toBe(401);
    await assertUnlock(dw, url, other, await attempt(dw, url, SITE_PASSWORD, VISITOR_IP), VISITOR_IP);
  });

  it("preserves the app-embedded password form and its cookie isolation", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    const app = name === "subdomain" ? "https://app.test" : ORIGIN;
    const viewerUrl = `${app}/v/protected-site/`;
    const viewer = await dw.call(viewerUrl, { headers: { ...NAV, "CF-Connecting-IP": VISITOR_IP } });
    expect(viewer.status).toBe(200);
    let frame: string | null = null;
    await new HTMLRewriter().on("iframe[src]", { element(element) { frame = element.getAttribute("src"); } }).transform(viewer).text();
    expect(frame, "use the iframe actually served by the app").not.toBeNull();
    const form = await passwordForm(dw, attributeUrl(frame!, viewerUrl), VISITOR_IP, {
      ...FRAME, "Sec-Fetch-Site": new URL(url).origin === app ? "same-origin" : "cross-site", Referer: viewerUrl,
    });
    const sandboxed = name === "path";
    if (sandboxed) {
      expect(form.csp).toMatch(/\bsandbox\b/);
      expect(form.csp).not.toContain("allow-same-origin");
    } else expect(form.csp).not.toMatch(/\bsandbox\b/);
    const res = await postForm(dw, form, SITE_PASSWORD, VISITOR_IP, {
      Origin: sandboxed ? "null" : new URL(form.action).origin,
      ...FRAME, "Sec-Fetch-Site": sandboxed ? "cross-site" : "same-origin",
    });
    await assertUnlock(dw, url, other, res, VISITOR_IP);
  });

  it.each(["document", "iframe"])("preserves a real opaque-sandbox %s form with its returned fields", async (dest) => {
    const dw = await freshInstance({ ...config, sitesSandbox: true });
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    const form = await passwordForm(dw, url, VISITOR_IP, { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": dest, "Sec-Fetch-Site": "cross-site" });
    expect(form.csp).toMatch(/\bsandbox\b/);
    expect(form.csp).not.toContain("allow-same-origin");
    const res = await postForm(dw, form, SITE_PASSWORD, VISITOR_IP, {
      Origin: "null", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": dest, "Sec-Fetch-Site": "cross-site",
    });
    await assertUnlock(dw, url, other, res, VISITOR_IP);
  });
});
