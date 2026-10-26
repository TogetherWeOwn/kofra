/**
 * Protected browser complement. Native keyboard/focus and 360px layout are not
 * established by the VM model. Requires the repo's existing test-only Playwright
 * installation AND a Chromium-capable OS (or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH).
 * Run: npx vitest run -c packages/cli/vitest.config.ts test/encrypted/duplicate-dashboard/browser.acceptance.test.ts
 */
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { sourceSlug, startFixture, type Fixture } from "./fixture";

const require = createRequire(import.meta.url);
let fixture: Fixture;
let browser: Browser;
const contexts: BrowserContext[] = [];
beforeAll(async () => {
  fixture = await startFixture();
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);
afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
afterAll(async () => { await browser?.close(); await fixture?.dispose(); });

async function visit(mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 360, height: 800 } : { width: 1100, height: 900 } });
  contexts.push(context);
  await context.addInitScript(({ key }) => { sessionStorage.setItem("dropway.key", key); }, { key: fixture.ownerKey });
  const writes: string[] = [];
  const errors: string[] = [];
  await context.route("**/*", async route => {
    const request = route.request();
    if (new URL(request.url()).origin !== fixture.origin) return route.abort("blockedbyclient");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${fixture.origin}/dashboard/sites/${sourceSlug}`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: /^browse(?: files)?$/i }).waitFor();
  expect(writes).toEqual([]);
  return { page, writes, errors };
}
function opener(page: Page) { return page.getByRole("button", { name: /^duplicate(?: site)?$/i }); }
function destination(page: Page) { return page.getByLabel(/(?:destination|new).*slug|^slug$/i); }
async function isFocused(locator: Locator) { return locator.evaluate(element => element === element.ownerDocument.activeElement); }
async function panel(page: Page) {
  const dialogs = page.getByRole("dialog");
  if (await dialogs.count()) return dialogs.filter({ has: destination(page) });
  return page.locator("form").filter({ has: destination(page) });
}

it("opens and cancels by keyboard, labels both fields, and restores focus without mutation", async () => {
  const { page, writes, errors } = await visit();
  const action = opener(page);
  expect(await action.count(), "site dashboard exposes a Duplicate button").toBe(1);
  await action.focus();
  await page.keyboard.press("Enter");
  await destination(page).waitFor();
  await expect.poll(() => isFocused(destination(page))).toBe(true);
  const form = await panel(page);
  expect(await form.count()).toBe(1);
  expect(await form.getByLabel(/message/i).count()).toBe(1);
  expect(await form.getByRole("button", { name: /^cancel$/i }).count()).toBe(1);
  // AX tree contains the form controls; label text is not merely a placeholder.
  const ax = await form.ariaSnapshot();
  expect(ax).toMatch(/textbox.*(?:slug|destination)/i);
  expect(ax).toMatch(/textbox.*message/i);
  const dialog = await form.evaluate(element => element.tagName === "DIALOG" || element.getAttribute("role") === "dialog");
  if (dialog) await page.keyboard.press("Escape");
  else {
    await form.getByRole("button", { name: /^cancel$/i }).focus();
    await page.keyboard.press("Enter");
  }
  await expect.poll(() => destination(page).isVisible()).toBe(false);
  expect(await isFocused(action)).toBe(true);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

it("keeps modal tab focus inside the dialog, when a modal is used", async () => {
  const { page, writes } = await visit();
  expect(await opener(page).count(), "site dashboard exposes a Duplicate button").toBe(1);
  await opener(page).click();
  await destination(page).waitFor();
  const form = await panel(page);
  const modal = await form.evaluate(element => element.tagName === "DIALOG" || element.getAttribute("aria-modal") === "true");
  if (modal) {
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await form.evaluate(element => element.contains(element.ownerDocument.activeElement)), "modal traps forward Tab").toBe(true);
    }
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await form.evaluate(element => element.contains(element.ownerDocument.activeElement)), "modal traps reverse Tab").toBe(true);
    }
  }
  await form.getByRole("button", { name: /^cancel$/i }).click();
  expect(await isFocused(opener(page))).toBe(true);
  expect(writes).toEqual([]);
});

it("keeps labelled inputs, the protection warning and both actions usable at 360px", async () => {
  const { page, writes, errors } = await visit(true);
  expect(await opener(page).count(), "site dashboard exposes a Duplicate button").toBe(1);
  await opener(page).click();
  await destination(page).waitFor();
  const form = await panel(page);
  expect(await form.innerText()).toMatch(/password|access protection/i);
  for (const control of [destination(page), form.getByLabel(/message/i), form.getByRole("button", { name: /^cancel$/i }), form.getByRole("button", { name: /^(?:duplicate(?: site)?|create copy|copy site)$/i })]) {
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    expect(box, "narrow controls are visible").not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(361);
    expect(box!.width).toBeGreaterThan(0);
  }
  expect(await page.evaluate(() => { const browser = globalThis as any; return browser.document.documentElement.scrollWidth <= browser.innerWidth + 1; }), "no page-wide horizontal scrolling").toBe(true);
  await form.getByRole("button", { name: /^cancel$/i }).click();
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
