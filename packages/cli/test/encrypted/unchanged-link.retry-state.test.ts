/**
 * Regression coverage for the unchanged-publish link retry: the destination is
 * frozen while the follow-up read is in flight, and keyboard focus lands on the
 * replacement control afterwards. Same real-Chromium + disposable Worker setup as
 * the acceptance suite; only individual-site read responses are held or faulted.
 */
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { startFixture, tree, type Fixture } from "./unchanged-link.fixture";

const require = createRequire(import.meta.url);
let fixture: Fixture;
let browser: Browser;
let serial = 0;
const contexts: BrowserContext[] = [];
const pages: Page[] = [];
beforeAll(async () => {
  fixture = await startFixture();
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);
afterEach(async () => {
  await Promise.all(pages.splice(0).map(page => page.unrouteAll({ behavior: "ignoreErrors" })));
  await Promise.all(contexts.splice(0).map(context => context.close()));
});
afterAll(async () => { await browser?.close(); await fixture?.dispose(); });

const main = (page: Page) => page.locator("#dw-main");
const retryButton = (page: Page) => main(page).getByRole("button", { name: /retry/i });
const openSite = (page: Page) => main(page).getByRole("link", { name: /^open site$/i });
const activeIs = (page: Page, locator: ReturnType<Page["locator"]>) => locator.evaluate(el => el === el.ownerDocument.activeElement);

async function publishUnchanged(slug: string, readHandler: (route: Route, body: any, n: number) => Promise<void>) {
  await fixture.seed(slug);
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1100, height: 900 } });
  contexts.push(context);
  await context.addInitScript(key => sessionStorage.setItem("dropway.key", key), fixture.ownerKey);
  const page = await context.newPage();
  pages.push(page);
  page.setDefaultTimeout(5000);
  await page.goto(fixture.origin + "/dashboard/publish", { waitUntil: "networkidle" });
  await page.locator('input[type="radio"][value="update"]').check();
  await page.locator("#dw-pub-site").selectOption(slug);
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(tree);
  await expect.poll(() => main(page).getByRole("button", { name: /^publish$/i }).isEnabled()).toBe(true);
  let reads = 0;
  await page.route(url => url.origin === fixture.origin && url.pathname === `/api/v1/sites/${slug}`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    return readHandler(route, await response.json(), ++reads);
  });
  await main(page).getByRole("button", { name: /^publish$/i }).click();
  await expect.poll(() => main(page).innerText()).toMatch(/nothing changed/i);
  return { page, reads: () => reads };
}
const fail = (route: Route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "link_read_unavailable", message: "unavailable", hint: "retry" } }) });
const ok = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

describe("unchanged manifest: link retry state", () => {
  it("freezes the destination controls while the retried read is in flight and releases them after", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slug = `retry-busy-${++serial}`;
    const { page, reads } = await publishUnchanged(slug, async (route, body, n) => {
      if (n === 1) return fail(route);
      await gate;
      return ok(route, body);
    });
    const frozen = ['input[type="radio"][value="new"]', 'input[type="radio"][value="update"]', "#dw-pub-site"];
    // The publish's own lock releases just after the result renders; wait for that before holding the retry.
    for (const selector of frozen) await expect.poll(() => page.locator(selector).isDisabled(), { message: `${selector} is usable between publish and retry` }).toBe(false);
    await retryButton(page).click();
    await expect.poll(reads).toBe(2);
    for (const selector of frozen) expect(await page.locator(selector).isDisabled(), `${selector} is frozen during the retry`).toBe(true);
    release();
    await expect.poll(() => openSite(page).count()).toBe(1);
    for (const selector of frozen) expect(await page.locator(selector).isDisabled(), `${selector} is released after the retry`).toBe(false);
    expect(await page.locator("#dw-pub-site").inputValue()).toBe(slug);
  });

  it("keeps keyboard focus on the replacement control after a retry, and never steals it on first render", async () => {
    const slug = `retry-focus-${++serial}`;
    const { page, reads } = await publishUnchanged(slug, async (route, body, n) => (n <= 2 ? fail(route) : ok(route, body)));
    expect(await activeIs(page, retryButton(page)), "first render does not move focus to the retry control").toBe(false);
    await retryButton(page).focus();
    await page.keyboard.press("Enter");
    await expect.poll(reads).toBe(2);
    await expect.poll(() => retryButton(page).isEnabled()).toBe(true);
    expect(await activeIs(page, retryButton(page)), "a failed retry leaves focus on the replacement retry button").toBe(true);
    await page.keyboard.press("Enter");
    await expect.poll(() => openSite(page).count()).toBe(1);
    expect(await activeIs(page, openSite(page)), "a successful retry moves focus to Open site").toBe(true);
  });
});
