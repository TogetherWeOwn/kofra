/** Supplemental browser regressions; no protected acceptance file is modified. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import type { Browser, Locator, Page } from "playwright";
import { day, hour, instant, key, now, paths, reads, reply, roots, surfaces,
  type Surface } from "../../../server/test/expiry-left.fixtures.ts";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let browser: Browser | undefined;
let work: string;
let origin: string;
beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "expiry-regressions-"));
  const config = join(work, "wrangler.json");
  await writeFile(config, JSON.stringify({ name: "expiry-regressions-disposable",
    main: join(root, "apps/worker/src/index.ts"), compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "expiry-regressions" }],
    r2_buckets: [{ binding: "FILES", bucket_name: "expiry-regressions-files" }],
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

async function open(surface: Surface, options: {
  expiresAt?: string | null;
  keys?: ReturnType<typeof key>[];
  clock?: number;
  touch?: boolean;
} = {}) {
  const context = await browser!.newContext({ serviceWorkers: "block", locale: "en-US", timezoneId: "America/New_York",
    viewport: { width: options.touch ? 800 : 1100, height: 800 }, hasTouch: !!options.touch });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  const calls: string[] = [];
  const violations: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.setFixedTime(new Date(options.clock ?? now));
  await page.addInitScript(() => sessionStorage.setItem("dropway.key", "dw_disposable_fixture"));
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
        const data = url.pathname === "/api/v1/keys" && options.keys
          ? { keys: options.keys } : reply(url.pathname, options.expiresAt);
        return await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
      } catch (error) {
        violations.push(String(error));
        return route.abort("blockedbyclient");
      }
    }
    if (url.pathname !== paths[surface] && url.pathname !== "/favicon.ico"
      && !/^\/__dropway\/ui\/app-[a-f0-9]{8}\.js$/.test(url.pathname)
      && !/^\/__dropway\/ui\/kofra-[a-f0-9]{8}\.css$/.test(url.pathname)
      && !/^\/__dropway\/fonts\/[a-z0-9.-]+\.woff2$/.test(url.pathname)
      && !/^\/__dropway\/ui\/art\/[a-z0-9.-]+\.svg$/.test(url.pathname)) {
      violations.push(`Unexpected app request: ${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  try {
    const response = await page.goto(origin + paths[surface], { waitUntil: "networkidle" });
    expect(response!.status()).toBe(200);
    expect(response!.headers()["content-security-policy"]).toContain("script-src 'self'");
    const container = page.locator(`#${roots[surface]}`);
    await container.locator(surface === "site" ? ".dw-pagehead" : "tbody tr").first().waitFor();
    return { context, page, container, calls, violations, errors,
      bounded() {
        expect([...calls].sort()).toEqual([...reads[surface]].sort());
        expect(violations).toEqual([]);
        expect(errors).toEqual([]);
      } };
  } catch (error) {
    await context.close();
    throw error;
  }
}

// Real sequential Tab navigation, not programmatic focus of the expiry cell.
async function tabTo(page: Page, target: Locator) {
  for (let count = 0; count < 40; count++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate(element => element === (globalThis as any).document.activeElement)) return;
  }
  throw Error("Expiry disclosure is not reachable with sequential Tab navigation");
}

it("reveals distinct local deadlines with Enter and Space without hover", async () => {
  const expiries = ["2026-10-28T03:20:00.000Z", "2026-10-28T04:20:00.000Z"];
  const dates = ["10/27/2026, 11:20:00 PM", "10/28/2026, 12:20:00 AM"];
  const view = await open("keys", { clock: Date.parse("2026-10-27T03:50:00Z"),
    keys: expiries.map((iso, i) => ({ ...key(iso), id: `deadline-${i}`, name: `Deadline ${i}` })) });
  try {
    for (let i = 0; i < expiries.length; i++) {
      const cell = view.container.locator("tbody tr").nth(i).locator("td").nth(3);
      const button = cell.getByRole("button");
      expect(await cell.innerText()).toBe("Expires in 1 day");
      expect(await cell.getAttribute("title")).toBe(expiries[i]);
      expect(await button.count(), "valid expiry must offer a keyboard-operable disclosure").toBe(1);
      await tabTo(view.page, button);
      await view.page.keyboard.press("Enter");
      expect(await button.getAttribute("aria-expanded")).toBe("true");
      expect(await cell.getByText(dates[i]!, { exact: true }).isVisible()).toBe(true);
      const controlled = await button.getAttribute("aria-controls");
      expect(controlled).toBeTruthy();
      expect(await cell.locator(`[id="${controlled}"]`).innerText()).toBe(dates[i]);
      await view.page.keyboard.press("Space");
      expect(await button.getAttribute("aria-expanded")).toBe("false");
      expect(await cell.innerText()).toBe("Expires in 1 day");
    }
    view.bounded();
  } finally { await view.context.close(); }
});

it("reveals and collapses the exact timestamp with touch", async () => {
  const view = await open("keys", { expiresAt: instant(3 * hour), touch: true });
  try {
    const cell = view.container.locator("tbody tr td").nth(3);
    const button = cell.getByRole("button");
    expect(await button.count()).toBe(1);
    await button.tap();
    expect(await cell.getByText("10/26/2026, 11:00:00 AM", { exact: true }).isVisible()).toBe(true);
    if (process.env.PAPERCLIP_RUN_SCRATCH_DIR) await view.page.screenshot({
      path: join(process.env.PAPERCLIP_RUN_SCRATCH_DIR, "expiry-touch-disclosure.png"), fullPage: true });
    await button.tap();
    expect(await cell.innerText()).toBe("Expires in 3 h");
    view.bounded();
  } finally { await view.context.close(); }
});

it("binds mixed key expiry states to their own row and timestamp", async () => {
  const expiries = [instant(2 * day), instant(3 * hour), instant(-3 * hour), null, "not-a-date"];
  const labels = ["Expires in 2 days", "Expires in 3 h", "Expired 3 h ago", "No expiry", ""];
  const view = await open("keys", { keys: expiries.map((iso, i) => ({ ...key(iso), id: `mixed-${i}`, name: `Mixed ${i}` })) });
  try {
    const rows = view.container.locator("tbody tr");
    expect(await rows.count()).toBe(expiries.length);
    for (let i = 0; i < expiries.length; i++) {
      const cell = rows.nth(i).locator("td").nth(3);
      expect(await rows.nth(i).locator("td").first().innerText()).toContain(`Mixed ${i}`);
      expect(await cell.innerText()).toBe(labels[i]);
      expect(await cell.getAttribute("title")).toBe(i < 3 ? expiries[i] : null);
      expect(await cell.getByRole("button").count()).toBe(i < 3 ? 1 : 0);
    }
    view.bounded();
  } finally { await view.context.close(); }
});

for (const surface of surfaces) it(`${surface}: uses the local calendar date across UTC midnight`, async () => {
  const iso = "2026-11-25T00:00:00.000Z";
  const view = await open(surface, { expiresAt: iso });
  try {
    const region = surface === "site" ? view.container.locator(".dw-pagehead") : view.container.locator("tbody tr");
    const node = surface === "site" ? region.locator(`p[title="${iso}"]`)
      : surface === "sites" ? region.locator(`.dw-badge[title="${iso}"]`) : region.locator("td").nth(3);
    expect(await node.innerText()).toBe(surface === "site"
      ? "Expires Nov 24, 2026 · 11/24/2026, 7:00:00 PM" : "Expires Nov 24, 2026");
    expect(await node.getAttribute("title")).toBe(iso);
    view.bounded();
  } finally { await view.context.close(); }
});
