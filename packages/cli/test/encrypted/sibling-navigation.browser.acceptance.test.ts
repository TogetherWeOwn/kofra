/**
 * Protected real-browser contract, intentionally RED until the paired build.
 * npm run test:cli -- test/encrypted/sibling-navigation.browser.acceptance.test.ts
 * Uses the existing test-only Playwright install; no production/staging requests.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const slug = "sibling-browser-fixture";
const hostile = '01 <img src=x onerror=alert(1)> & "quote" #?.md';
const unicode = "03 café 雪 100%.txt";
const current = "02 current.csv";
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let work: string;
let origin: string;
let browser: import("playwright").Browser;

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "sibling-browser-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-sibling-browser-test", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "sibling-browser", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "sibling-browser-files" }], kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config, dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: "sibling-browser-bootstrap-fixture-only" } },
  });
  await worker.ready;
  origin = (await worker.url).origin;
  const setup = await fetch(`${origin}/api/v1/setup`, {
    method: "POST", headers: { Authorization: "Bearer sibling-browser-bootstrap-fixture-only", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "sibling-browser@example.test" }),
  });
  expect(setup.status, "disposable owner setup").toBe(201);
  const key = (await setup.json() as any).apiKey.key;
  const files = Object.entries({
    [`docs/${unicode}`]: "last\n", [`docs/${current}`]: "name,value\nfixture,7\n", [`docs/${hostile}`]: "# First\n",
    "docs/nested/ignore.txt": "never a direct sibling\n",
  }).map(([path, content]) => ({ path, content }));
  // JSON preserves literal quotes in the live paths, unlike multipart filenames.
  const published = await fetch(`${origin}/api/v1/publish`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ site: slug, files }),
  });
  expect(published.status, "disposable folder publishes").toBe(201);
  await published.arrayBuffer();
  const live = await fetch(`${origin}/api/v1/sites/${slug}/files`, { headers: { Authorization: `Bearer ${key}` } });
  expect(live.status, "disposable live manifest loads").toBe(200);
  const result = await live.json() as { files: { path: string }[] };
  expect(result.files.map(file => file.path).sort(), "live manifest preserves literal fixture names").toEqual(files.map(file => file.path).sort());
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

describe("plain sibling anchors in a disposable browser", () => {
  it.each([{ width: 320, colorScheme: "light" }, { width: 360, colorScheme: "dark" }] as const)("works without JavaScript at $width px in $colorScheme mode, with visible keyboard focus", async options => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: options.width, height: 800 }, colorScheme: options.colorScheme });
    try {
      const requests: string[] = [];
      await context.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort("blockedbyclient");
        requests.push(url.pathname);
        return route.continue();
      });
      const page = await context.newPage();
      const response = await page.goto(`${origin}/s/${slug}/docs/${encodeURIComponent(current)}?view=1&claim=fixture-claim&unlock=fixture-unlock&token=fixture-token`, { waitUntil: "networkidle" });
      expect(response?.status()).toBe(200);
      const bar = page.locator(".dw-vbar");
      const links = bar.locator('a[rel="prev"], a[rel="next"]');
      expect(await links.count(), "two real sibling anchors, not buttons or script handlers").toBe(2);
      for (const [rel, name, text] of [["prev", hostile, "Previous"], ["next", unicode, "Next"]]) {
        const link = bar.locator(`a[rel="${rel}"]`);
        expect(await link.innerText()).toContain(text);
        expect(await link.getAttribute("title")).toContain(name);
        // Use the browser's accessible-name algorithm, not a source-text approximation.
        expect(await bar.getByRole("link", { name: name!, exact: false }).count()).toBeGreaterThan(0);
        expect(await link.getAttribute("href")).toBe(`/s/${slug}/docs/${encodeURIComponent(name!)}`);
        expect(await link.isVisible()).toBe(true);
      }
      expect(await bar.locator("img, [onerror], [onclick]").count()).toBe(0);
      const layout = await bar.evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth, pageScroll: element.ownerDocument.documentElement.scrollWidth, viewport: element.ownerDocument.defaultView!.innerWidth }));
      expect(layout.scroll).toBeLessThanOrEqual(layout.width + 1);
      expect(layout.pageScroll).toBeLessThanOrEqual(layout.viewport + 1);
      const next = bar.locator('a[rel="next"]');
      let focused = false;
      for (let i = 0; i < await page.locator("a, button, input, [tabindex]").count() + 2; i++) {
        await page.keyboard.press("Tab");
        if (await next.evaluate(element => element === element.ownerDocument.activeElement)) { focused = true; break; }
      }
      expect(focused, "Next is reachable by keyboard without script").toBe(true);
      const focus = await next.evaluate(element => {
        const style = element.ownerDocument.defaultView!.getComputedStyle(element);
        return { outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== "transparent", shadow: style.boxShadow !== "none" };
      });
      expect(focus.outline || focus.shadow, "keyboard focus has a visible outline or ring").toBe(true);
      expect(requests.some(path => path.startsWith("/api/")), "navigation adds no API/manifest endpoint").toBe(false);
      await next.click();
      await page.waitForLoadState("networkidle");
      expect(page.url()).toBe(`${origin}/s/${slug}/docs/${encodeURIComponent(unicode)}`);
      expect(new URL(page.url()).search).toBe("");
      expect(await page.locator('.dw-vbar a[rel="next"]').count()).toBe(0);
      expect(await page.locator('.dw-vbar a[rel="prev"]').count()).toBe(1);
    } finally { await context.close(); }
  });
});
