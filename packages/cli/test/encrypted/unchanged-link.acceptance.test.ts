/**
 * Protected failing-first contract: unchanged manifest success recovers its public
 * link with get_site, never by repeating publish. Real Chromium executes the
 * disposable Worker's HTML and hashed first-party asset without source rewriting.
 * Only individual-site read responses are fault-injected below. Existing changed,
 * ZIP and anonymous controls keep their real Worker protocol.
 */
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { startFixture, tree, totalBytes, type Fixture } from "./unchanged-link.fixture";

const require = createRequire(import.meta.url);
let fixture: Fixture;
let browser: Browser;
let serial = 0;
const contexts: BrowserContext[] = [];
beforeAll(async () => {
  fixture = await startFixture();
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);
afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
afterAll(async () => { await browser?.close(); await fixture?.dispose(); });

type Call = { method: string; path: string; samePrincipal: boolean };
type View = { page: Page; context: BrowserContext; calls: Call[]; errors: string[]; forbidden: string[] };
const main = (v: View) => v.page.locator("#dw-main");
const writes = (v: View) => v.calls.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method));
const readPath = (call: Call) => call.method === "GET" && /^\/api\/v1\/sites\/[^/]+$/.test(call.path);
const retry = (v: View) => main(v).getByRole("button", { name: /retry|try again/i });
const receipt = (v: View) => main(v).getByRole("textbox", { name: /public (?:details|receipt)|publish receipt/i });
const copyDetails = (v: View) => main(v).getByRole("button", { name: /copy public details/i });
async function settle(v: View) {
  await v.page.evaluate(() => new Promise<void>(resolve => {
    const frame = (globalThis as any).requestAnimationFrame;
    frame(() => frame(resolve));
  }));
}
async function visit(anonymous = false): Promise<View> {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1100, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  contexts.push(context);
  if (!anonymous) await context.addInitScript(key => sessionStorage.setItem("dropway.key", key), fixture.ownerKey);
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  const view: View = { context, page, calls: [], errors: [], forbidden: [] };
  // Observe requests independently of route handling, including fault-injected GETs.
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) view.calls.push({ method: request.method(), path: url.pathname, samePrincipal: request.headers().authorization === `Bearer ${fixture.ownerKey}` });
  });
  page.on("pageerror", error => view.errors.push(error.message));
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== fixture.origin) {
      view.forbidden.push("off-origin request");
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  const scripts: string[] = [];
  page.on("response", response => { if (/\/__dropway\/ui\/app-[a-f0-9]+\.js$/.test(response.url()) && response.status() === 200) scripts.push(response.url()); });
  const response = await page.goto(fixture.origin + (anonymous ? "/" : "/dashboard/publish"), { waitUntil: "networkidle" });
  expect(response!.status()).toBe(200);
  expect(response!.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(scripts.length, "use the actual Worker-served UI, not a reconstructed publisher").toBeGreaterThan(0);
  await main(view).getByRole("button", { name: /^publish$/i }).waitFor();
  return view;
}
async function select(v: View, files = tree) {
  await v.page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(files);
  await expect.poll(() => main(v).getByRole("button", { name: /^publish$/i }).isEnabled()).toBe(true);
}
async function update(v: View, slug: string) {
  await v.page.locator('input[type="radio"][value="update"]').check();
  await expect.poll(() => v.page.locator("#dw-pub-site option").allTextContents()).toContain(slug);
  await v.page.locator("#dw-pub-site").selectOption(slug);
  await select(v);
}
async function publish(v: View) {
  const response = v.page.waitForResponse(r => r.request().method() === "POST" && /\/deploys$/.test(new URL(r.url()).pathname));
  await main(v).getByRole("button", { name: /^publish$/i }).click();
  const result = await response;
  expect(result.ok()).toBe(true);
  return await result.json();
}
async function unchanged(v: View) {
  const result = await publish(v);
  expect(result.unchanged, "real backend confirms the selected bytes match").toBe(true);
  await expect.poll(() => main(v).innerText()).toMatch(/nothing changed/i);
  return result;
}
async function publicDetails(v: View, url: string, version: { id: string; number: number; fileCount: number; totalBytes: number }) {
  const open = main(v).getByRole("link", { name: /^open site$/i });
  await expect.poll(() => open.count(), { message: "unchanged success exposes the recovered Open site action" }).toBe(1);
  expect(await open.getAttribute("href")).toBe(url);
  expect(await main(v).getByRole("button", { name: /^copy url$/i }).count()).toBe(1);
  expect(await copyDetails(v).count()).toBe(1);
  expect(await receipt(v).count(), "receipt remains selectable and labelled").toBe(1);
  const text = await receipt(v).inputValue();
  expect(text).toContain(url);
  expect(text).toContain(version.id);
  expect(text).toMatch(new RegExp(`(?:version[^\\n]*\\b${version.number}\\b|\\bv${version.number}\\b)`, "i"));
  expect(text).toMatch(new RegExp(`files?[^\\n\\d]*${version.fileCount}\\b`, "i"));
  expect(text).toMatch(new RegExp(`bytes?[^\\n\\d]*${version.totalBytes}\\b`, "i"));
  expect(text).not.toMatch(/immutable (?:public |live )?(?:url|link)|(?:public |live )(?:url|link)[^\n]*immutable/i);
  expect(text).not.toMatch(/dwc_|dwu_|dw_preview|Bearer |unlock|fixture-secret-|index\.html/i);
  // Compare only a boolean so real disposable credentials never appear in output.
  expect(text.includes(fixture.ownerKey), "public details must not contain the signed-in key").toBe(false);
  const before = [...v.calls];
  await main(v).getByRole("button", { name: /^copy url$/i }).click();
  expect(await v.page.evaluate(() => (globalThis as any).navigator.clipboard.readText())).toBe(url);
  await copyDetails(v).click();
  expect(await v.page.evaluate(() => (globalThis as any).navigator.clipboard.readText())).toBe(text);
  expect(v.calls, "copy controls perform no HTTP requests").toEqual(before);
  expect(v.errors).toEqual([]);
  expect(v.forbidden).toEqual([]);
  return text;
}
async function readFixture(v: View, slug: string, handler: (route: Route, body: any) => Promise<void>) {
  await v.page.route(url => url.origin === fixture.origin && url.pathname === `/api/v1/sites/${slug}`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    expect(response.status(), "fault injection starts from a real authorized get_site response").toBe(200);
    return handler(route, await response.json());
  });
}
async function reply(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

// Missing read, guessed URL, a second finalize/upload or substituted live identity
// must each break a consumer-visible assertion below.
describe("unchanged manifest: usable public link", () => {
  it("publishes the same tree twice in Chromium and recovers a link without another version/upload/finalize", async () => {
    const v = await visit();
    const slug = `browser-repeat-${++serial}`;
    await v.page.locator("#dw-pub-slug").fill(slug);
    await select(v);
    const finalized = v.page.waitForResponse(r => /\/finalize$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
    expect((await publish(v)).unchanged).not.toBe(true);
    const ready = await (await finalized).json();
    expect(ready.live).toBe(true);
    const version = ready.site.currentVersion;
    expect(version).toMatchObject({ number: 1, fileCount: 2, totalBytes });
    await publicDetails(v, `${fixture.origin}/s/${slug}/`, version);
    expect(writes(v).filter(c => /\/blobs\//.test(c.path))).toHaveLength(2);
    expect(writes(v).filter(c => /\/finalize$/.test(c.path))).toHaveLength(1);

    await v.page.goto(`${fixture.origin}/dashboard/publish`, { waitUntil: "networkidle" });
    await update(v, slug);
    const before = v.calls.length;
    const result = await unchanged(v);
    expect(result.deploy.id).toBe(version.id);
    await publicDetails(v, `${fixture.origin}/s/${slug}/`, version);
    const second = v.calls.slice(before);
    expect(second.filter(readPath), "recover through one authorized get_site").toHaveLength(1);
    expect(second.every(c => c.samePrincipal)).toBe(true);
    expect(writes({ ...v, calls: second })).toEqual([{ method: "POST", path: `/api/v1/sites/${slug}/deploys`, samePrincipal: true }]);
    expect((await fixture.json(`/api/v1/sites/${slug}/versions`)).versions).toHaveLength(1);
    expect(await v.page.locator("#dw-pub-site").inputValue()).toBe(slug);
  });

  it.each([
    ["separate path origin", "https://files.example.test/renamed-authoritative/"],
    ["subdomain mode", "https://renamed-authoritative.pages.example.test/"],
  ])("uses %s get_site URL but not its later live-version identity", async (_mode, url) => {
    const slug = `browser-authority-${++serial}`;
    const seeded = await fixture.seed(slug);
    const v = await visit();
    await update(v, slug);
    await readFixture(v, slug, async (route, body) => {
      await reply(route, { ...body, site: { ...body.site, slug: "renamed-authoritative", url,
        currentVersionId: "ver-later-live", currentVersion: { ...body.site.currentVersion, id: "ver-later-live", number: 999, fileCount: 41, totalBytes: 9001 },
        claimToken: "fixture-secret-claim", upload: { headers: { Authorization: "Bearer fixture-secret-upload" } }, unlockToken: "fixture-secret-unlock",
      } });
    });
    const before = v.calls.length;
    const result = await unchanged(v);
    expect(result.deploy.id).toBe(seeded.version.id);
    const text = await publicDetails(v, url, seeded.version);
    expect(text).not.toMatch(/ver-later-live|\bv999\b|9001/);
    expect(v.calls.slice(before).filter(readPath)).toHaveLength(1);
    expect(v.calls.slice(before).every(c => c.samePrincipal)).toBe(true);
    expect(writes({ ...v, calls: v.calls.slice(before) })).toHaveLength(1);
  });
});

describe("unchanged manifest: read failure is not publish failure", () => {
  it.each(["503", "missing", "empty", "unsafe scheme", "credential URL", "secret query"])("%s keeps success and retries only the authorized read by keyboard", async fault => {
    const slug = `browser-retry-${++serial}`;
    const seeded = await fixture.seed(slug);
    const v = await visit();
    await update(v, slug);
    let reads = 0;
    await readFixture(v, slug, async (route, body) => {
      reads++;
      if (reads > 1) return reply(route, body);
      if (fault === "503") return reply(route, { error: { code: "link_read_unavailable", message: "The site read is temporarily unavailable.", hint: "Retry the site read." } }, 503);
      const site = { ...body.site };
      if (fault === "missing") delete site.url;
      else site.url = fault === "empty" ? "" : fault === "unsafe scheme" ? "javascript:alert(1)" : fault === "secret query" ? "https://files.example.test/site/?unlock=fixture-secret-unlock" : "https://user:fixture-secret-password@files.example.test/site/?unlock=fixture-secret-unlock";
      return reply(route, { ...body, site });
    });
    const before = v.calls.length;
    await unchanged(v);
    await expect.poll(() => reads, { message: "unchanged publish follows up with get_site" }).toBe(1);
    const announcements = main(v).locator('[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]');
    await expect.poll(async () => (await announcements.allInnerTexts()).join("\n")).toMatch(/(?:link|url)[\s\S]*(?:unavailable|could not|couldn't|unable|retriev|retry)/i);
    expect(await main(v).innerText()).not.toMatch(/publish(?:ing)? (?:failed|failure)/i);
    expect(await main(v).getByRole("link", { name: /^open site$/i }).count()).toBe(0);
    expect(await copyDetails(v).count()).toBe(0);
    expect(await main(v).getByRole("button", { name: /^copy url$/i }).count()).toBe(0);
    expect(await retry(v).count(), "link-read recovery has a labelled button").toBe(1);
    expect(await retry(v).isEnabled()).toBe(true);
    await retry(v).focus();
    expect(await retry(v).evaluate(el => el === el.ownerDocument.activeElement)).toBe(true);
    const beforeRetry = v.calls.length;
    await v.page.keyboard.press("Enter");
    await publicDetails(v, `${fixture.origin}/s/${slug}/`, seeded.version);
    expect(reads).toBe(2);
    expect(v.calls.slice(beforeRetry), "retry repeats GET only; never republishes/uploads/finalizes").toHaveLength(1);
    expect(v.calls.slice(beforeRetry).every(c => readPath(c) && c.samePrincipal)).toBe(true);
    expect(writes({ ...v, calls: v.calls.slice(before) })).toEqual([{ method: "POST", path: `/api/v1/sites/${slug}/deploys`, samePrincipal: true }]);
    expect((await fixture.json(`/api/v1/sites/${slug}/versions`)).versions).toHaveLength(1);
    expect(await v.page.locator("#dw-pub-site").inputValue()).toBe(slug);
    expect(await main(v).innerText()).toMatch(/nothing changed/i);
  });

  it("renders hostile returned slug text inert while keeping only the clean authoritative URL public", async () => {
    const slug = `browser-hostile-${++serial}`;
    const seeded = await fixture.seed(slug);
    const v = await visit();
    await update(v, slug);
    await readFixture(v, slug, async (route, body) => {
      await reply(route, { ...body, site: { ...body.site, slug: '<img src=x onerror="globalThis.injected=true">', url: "https://files.example.test/clean/" } });
    });
    await unchanged(v);
    await publicDetails(v, "https://files.example.test/clean/", seeded.version);
    await settle(v);
    expect(await main(v).locator('img[src="x"], [onerror], script:not([type="application/json"])').count()).toBe(0);
    expect(await v.page.evaluate(() => (globalThis as any).injected)).toBeUndefined();
  });
});

// These controls must remain GREEN at handoff. They prove the new recovery branch
// is not being imposed on unrelated successful publishing protocols.
describe("publisher protocol regression controls", () => {
  it("keeps ZIP on one-shot publishing with a public response-derived receipt", async () => {
    const v = await visit();
    const slug = `browser-zip-${++serial}`;
    await v.page.locator("#dw-pub-slug").fill(slug);
    const zipped = zipSync({ "index.html": strToU8("zip fixture") });
    await select(v, [{ name: "bundle.zip", mimeType: "application/zip", buffer: Buffer.from(zipped) }]);
    const response = v.page.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/publish" && r.request().method() === "POST");
    const before = v.calls.length;
    await main(v).getByRole("button", { name: /^publish$/i }).click();
    const result = await (await response).json();
    await publicDetails(v, result.url, result.version);
    expect(writes({ ...v, calls: v.calls.slice(before) })).toEqual([{ method: "POST", path: "/api/v1/publish", samePrincipal: true }]);
    expect(v.calls.slice(before).filter(readPath)).toHaveLength(0);
  });

  it("keeps anonymous manifest publishing and separately labelled claim-token copy", async () => {
    const v = await visit(true);
    await select(v);
    const finalized = v.page.waitForResponse(r => /\/finalize$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
    await publish(v);
    const result = await (await finalized).json();
    await publicDetails(v, result.url, result.site.currentVersion);
    const claim = main(v).getByRole("button", { name: /copy claim token/i });
    expect(await claim.count()).toBe(1);
    const before = v.calls.length;
    await claim.click();
    const copied = await v.page.evaluate(() => (globalThis as any).navigator.clipboard.readText());
    expect(copied.startsWith("dwc_"), "only explicit claim-copy reveals a claim credential").toBe(true);
    expect((await receipt(v).inputValue()).includes(copied), "public receipt excludes the separate claim credential").toBe(false);
    expect(v.calls.slice(before)).toEqual([]);
    expect(v.calls.filter(readPath)).toHaveLength(0);
  });
});
