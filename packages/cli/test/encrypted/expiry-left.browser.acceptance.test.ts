/**
 * Protected acceptance contract: only the Test Author may edit this file.
 * Real shell, script, CSS and CSP from a disposable local Worker; controlled
 * read-only API responses. No source transforms, migrations, production calls,
 * new dependencies, or remote assets. All contexts and the Worker are disposed.
 *
 * npm ci --include=dev
 * npm ci --prefix packages/cli/test/encrypted --include=dev
 * packages/cli/test/encrypted/node_modules/.bin/playwright install chromium
 * npm run test:cli -- test/encrypted/expiry-left.browser.acceptance.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import type { Browser } from "playwright";
import { day, hour, instant, marker, now, paths, reads, reply, roots, surfaces,
  type Surface } from "../../../server/test/expiry-left.fixtures.ts";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let browser: Browser | undefined;
let work: string;
let origin: string;
beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "expiry-browser-"));
  const config = join(work, "wrangler.json");
  await writeFile(config, JSON.stringify({ name: "dropway-expiry-disposable-test",
    main: join(root, "apps/worker/src/index.ts"), compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "expiry-disposable" }],
    r2_buckets: [{ binding: "FILES", bucket_name: "expiry-disposable-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  worker = await unstable_startWorker({ config,
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist: false, watch: false, logLevel: "error" },
  });
  await worker.ready;
  origin = (await worker.url).origin;
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function open(surface: Surface, expiresAt?: string | null, width = 360) {
  const context = await browser!.newContext({ serviceWorkers: "block", locale: "en-US", timezoneId: "America/New_York",
    viewport: { width, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  const calls: string[] = [];
  const violations: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.setFixedTime(new Date(now));
  await page.addInitScript(() => {
    const g = globalThis as any;
    g.sessionStorage.setItem("dropway.key", "dw_disposable_fixture");
    g.__expiryTimers = [];
    for (const name of ["setTimeout", "setInterval", "requestAnimationFrame"]) {
      const original = g[name];
      g[name] = (...args: any[]) => { g.__expiryTimers.push(name); return original(...args); };
    }
  });
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") {
      violations.push(`${request.method()} ${url.href}`);
      return route.abort("blockedbyclient");
    }
    if (url.pathname.startsWith("/api/")) {
      calls.push(url.pathname + url.search);
      try {
        return await route.fulfill({ contentType: "application/json", body: JSON.stringify(reply(url.pathname, expiresAt)) });
      } catch (error) {
        violations.push(String(error));
        return route.abort("blockedbyclient");
      }
    }
    if (url.pathname !== paths[surface] && !url.pathname.startsWith("/__dropway/ui/") && url.pathname !== "/favicon.ico") {
      violations.push(`unexpected app-origin request: ${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  try {
    const response = await page.goto(origin + paths[surface], { waitUntil: "networkidle" });
    expect(response!.status()).toBe(200);
    expect(response!.headers()["content-security-policy"]).toContain("script-src 'self'");
    const container = page.locator(`#${roots[surface]}`);
    const region = surface === "site" ? container.locator(".dw-pagehead") : container.locator("tbody tr");
    expect(await region.count(), "the real served script must finish rendering").toBe(1);
    const expiry = surface === "keys" ? region.locator("td").nth(3) : region;
    return { context, page, container, region, expiry, calls, violations, errors };
  } catch (error) {
    await context.close();
    throw error;
  }
}

for (const surface of surfaces) describe(`${surface}: real browser expiry`, () => {
  // Break: add countdown work, fetches or mutations, or change permanent rows.
  // Also proves the narrow fixture works before recording any feature RED.
  it("preserves permanent rows and stays bounded at 360 px", async () => {
    const view = await open(surface);
    try {
      const text = await view.expiry.innerText();
      if (surface === "keys") expect(text).toBe("No expiry");
      else expect(text).not.toMatch(/Expires|Expired|No expiry|Invalid Date/);
      expect([...view.calls].sort()).toEqual([...reads[surface]].sort());
      expect(await view.page.evaluate(() => (globalThis as any).__expiryTimers)).toEqual([]);
      expect(await view.page.evaluate(() => {
        const d = (globalThis as any).document;
        return d.documentElement.scrollWidth <= (globalThis as any).innerWidth;
      }), "the page must not grow beyond the narrow viewport").toBe(true);
      expect(view.errors).toEqual([]);
      expect(view.violations).toEqual([]);
    } finally { await view.context.close(); }
  });

  // Break: only update one surface, omit the exact timestamp, hide the site
  // urgency line on narrow screens, or render UTC instead of local datetime.
  it("renders urgency and an honest timestamp in the real served DOM", async () => {
    const iso = instant((surface === "keys" ? 2 * day : 3 * hour));
    const view = await open(surface, iso);
    try {
      if (process.env.PAPERCLIP_RUN_SCRATCH_DIR) await view.page.screenshot({
        path: join(process.env.PAPERCLIP_RUN_SCRATCH_DIR, `expiry-${surface}-360.png`), fullPage: true });
      const want = surface === "keys" ? "Expires in 2 days" : "Expires in 3 h";
      expect(await view.expiry.textContent()).toContain(want);
      const titles = await view.region.locator("[title]").evaluateAll(elements => elements.map(element => element.getAttribute("title")));
      if (surface === "keys") titles.push(await view.expiry.getAttribute("title"));
      expect(titles).toContain(iso);
      if (surface !== "keys") expect(await view.region.getByText(want, { exact: surface === "sites" }).isVisible()).toBe(true);
      if (surface === "site") {
        const local = await view.page.evaluate(value => new Date(value).toLocaleString(), iso);
        expect(await view.region.innerText()).toContain(local);
      }
      // The unchanged keys expiry column is intentionally hidden at <=640px.
      // It must be visible and truthful on desktop, not just in hidden markup.
      if (surface === "keys") {
        await view.page.setViewportSize({ width: 1100, height: 800 });
        expect(await view.expiry.isVisible()).toBe(true);
        expect(await view.expiry.innerText()).toBe(want);
      }
      expect(view.errors).toEqual([]);
      expect(view.violations).toEqual([]);
    } finally { await view.context.close(); }
  });

  // Break: echo invalid user-controlled data or construct app-origin markup.
  it("omits malformed expiry without interpreting it as HTML", async () => {
    const view = await open(surface, marker);
    try {
      expect(await view.expiry.textContent()).not.toMatch(/Expires|Expired|No expiry|Invalid Date/);
      expect(await view.region.locator("img,script,iframe").count()).toBe(0);
      expect(await view.page.evaluate(() => (globalThis as any).__expiryMarkupExecuted ?? false)).toBe(false);
      expect(view.errors).toEqual([]);
      expect(view.violations).toEqual([]);
    } finally { await view.context.close(); }
  });
});

it("marks an already-past key Expired rather than displaying a negative future", async () => {
  const view = await open("keys", instant(-3 * hour), 1100);
  try {
    expect(await view.expiry.innerText()).toBe("Expired 3 h ago");
    expect(await view.expiry.innerText()).not.toMatch(/in\s*-\d/);
    expect(view.errors).toEqual([]);
    expect(view.violations).toEqual([]);
  } finally { await view.context.close(); }
});
