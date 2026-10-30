/**
 * Protected print-media acceptance tests; no product implementation is included.
 * Real disposable Worker + Chromium, no remote deployment or mocked documents.
 * Run: npm run test:cli -- test/encrypted/viewer-print.acceptance.test.ts
 * Uses existing test-only Playwright installation; optional Chromium executable
 * and LD_LIBRARY_PATH overrides are the same as the other browser suites.
 * Print emulation asserts layout/fragmentation CSS, NOT actual PDF pagination.
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
import { printCapFiles, printCsvHeaders, printFiles } from "../../../../test/viewer-print.fixtures";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
let browser: any;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let work: string;
let origin: string;
let slug: string;
const widths = [480, 794]; // Narrow printable area and approximately A4 at 96 dpi.
const documents = Object.keys(printFiles);

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "viewer-print-acceptance-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-viewer-print-acceptance", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "viewer-print-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "viewer-print-acceptance-files" }], kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config, dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: "local-print-bootstrap-fixture-only" } },
  });
  await worker.ready;
  origin = (await worker.url).origin;
  const setup = await fetch(`${origin}/api/v1/setup`, {
    method: "POST", headers: { Authorization: "Bearer local-print-bootstrap-fixture-only", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "print-fixture@example.test" }),
  });
  expect(setup.status, "disposable owner initializes").toBe(201);
  const key = (await setup.json() as any).apiKey.key;
  const form = new FormData();
  for (const [path, file] of Object.entries(printFiles)) form.append("files", new File([file.content], path, { type: file.contentType }));
  for (const [path, content] of Object.entries(printCapFiles)) form.append("files", new File([content], path));
  form.append("files", new File(['<!doctype html><style>body{color:rgb(128,0,128)}@media print{body{color:rgb(0,128,0)}}</style><p>Application-owned printing</p>'], "own.html", { type: "text/html" }));
  const published = await fetch(`${origin}/api/v1/publish`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  expect(published.status, "real synthetic documents publish locally").toBe(201);
  slug = (await published.json() as any).slug;
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function visit(path: string, width = 794, colorScheme = "light") {
  // JavaScript is disabled: printing must not require a new script or listener.
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, javaScriptEnabled: false });
  const requests: string[] = [];
  const external: string[] = [];
  await context.route("**/*", (route: any) => {
    const url = route.request().url();
    requests.push(url);
    if (new URL(url).origin !== origin) { external.push(url); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(`${origin}/s/${slug}/${path}`, { waitUntil: "networkidle" });
    expect(response.status()).toBe(200);
    return { page, context, requests, external };
  } catch (error) { await context.close(); throw error; }
}

async function screenSnapshot(page: any) {
  return page.evaluate(() => ({
    styles: [...(globalThis as any).document.querySelectorAll("body, main, pre, code, table, th, td, .dw-vbar")].slice(0, 40).map((element) => {
      const css = (globalThis as any).getComputedStyle(element);
      return [element.tagName, css.color, css.backgroundColor, css.fontSize, css.whiteSpace, css.overflowX, css.overflowY, css.maxHeight, css.display];
    }),
    details: [...(globalThis as any).document.querySelectorAll("details")].map((element) => element.open),
  }));
}

const appearances = documents.flatMap(path => widths.flatMap(width => ["light", "dark"].map(theme => ({ path, width, theme }))));
describe("print appearance without screen or request side effects", () => {
  it.each(appearances)("$path at $width px, $theme screen", async ({ path, width, theme }) => {
    const view = await visit(path, width, theme);
    try {
      const { page } = view;
      const before = await screenSnapshot(page);
      expect(before.styles[0].slice(1, 3), "preserve the redesign light/dark screen tokens").toEqual(theme === "dark"
        ? ["rgb(238, 234, 224)", "rgb(15, 22, 38)"] : ["rgb(20, 20, 20)", "rgb(244, 239, 226)"]);
      expect(await page.locator(".dw-vbar").isVisible(), "normal screen keeps the existing viewer toolbar").toBe(true);
      const beforeRequests = [...view.requests];
      await page.emulateMedia({ media: "print" });
      const colors = await page.evaluate(() => {
        const css = (globalThis as any).getComputedStyle((globalThis as any).document.body);
        return { ink: css.color, paper: css.backgroundColor, font: parseFloat(css.fontSize) };
      });
      expect.soft(colors.ink, "print ink is black even when the screen theme is dark").toBe("rgb(0, 0, 0)");
      expect.soft(colors.paper, "print paper is white").toBe("rgb(255, 255, 255)");
      expect.soft(colors.font, "print text remains readable").toBeGreaterThanOrEqual(12);
      for (const control of await page.locator(".dw-vbar a, .dw-vbar button, nav a, button").all()) {
        expect.soft(await control.isVisible(), "viewer actions/navigation must not print").toBe(false);
      }
      const printedText = await page.locator("body").innerText();
      expect.soft(printedText, "keep visible path/title context after omitting controls").toContain(path);
      const marker: Record<string, string> = { "report.md": "A printable synthetic report.", "report.ts": "const line99", "report.txt": "const line99", "report.json": "Quarterly report", "report.csv": "row-159", "report.ipynb": "notebook-output-sentinel" };
      expect.soft(printedText, "the actual disclosed document must remain printable").toContain(marker[path]);
      const coloredContent = await page.locator("main, pre, code, th, td, [class^=hljs-], .dw-jk, .dw-js").evaluateAll((elements: any[]) =>
        elements.filter(element => element.getClientRects().length && (globalThis as any).getComputedStyle(element).display !== "none")
          .filter(element => (globalThis as any).getComputedStyle(element).color !== "rgb(0, 0, 0)")
          .map(element => ({ tag: element.tagName, class: element.className, color: (globalThis as any).getComputedStyle(element).color })).slice(0, 5));
      expect.soft(coloredContent, "content/highlight tokens use black print ink").toEqual([]);
      expect(view.requests, "switching media does not fetch a script, stylesheet or document").toEqual(beforeRequests);
      expect(view.external).toEqual([]);
      await page.emulateMedia({ media: "screen" });
      expect(await screenSnapshot(page), "print overrides must not stick to the light/dark screen").toEqual(before);
    } finally { await view.context.close(); }
  });
});

const layouts = ["report.ts", "report.txt", "report.md", "report.json", "report.csv", "report.ipynb"].flatMap(path => widths.map(width => ({ path, width })));
describe("print layout exposes already-rendered content", () => {
  it.each(layouts)("$path fits $width px without a scrolling viewport", async ({ path, width }) => {
    const view = await visit(path, width);
    try {
      const { page } = view;
      if (path === "report.json") await page.getByText("Pretty", { exact: true }).click();
      const visiblePre = await page.locator("pre:visible").count();
      await page.emulateMedia({ media: "print" });
      expect(await page.locator("pre:visible").count(), "do not hide exposed code/output or force hidden panes into print").toBe(visiblePre);
      if (path === "report.csv" && process.env.PRINT_EVIDENCE_DIR) {
        await page.screenshot({ path: join(process.env.PRINT_EVIDENCE_DIR, `csv-print-${width}.png`), fullPage: true });
        await page.pdf({ path: join(process.env.PRINT_EVIDENCE_DIR, `csv-print-${width}.pdf`), width: `${width}px`, height: "1123px", printBackground: true, displayHeaderFooter: false });
      }
      const clipped = await page.locator("main, pre, code, table, table *, pre *, main div, main section, main article").evaluateAll((elements: any[]) =>
        elements.filter(element => element.getClientRects().length && !element.closest("details:not([open])"))
          .filter(element => {
            const css = (globalThis as any).getComputedStyle(element);
            return (element.scrollWidth > element.clientWidth + 2 && element.clientWidth > 0 && ["auto", "scroll", "hidden", "clip"].includes(css.overflowX)) ||
              (element.scrollHeight > element.clientHeight + 2 && element.clientHeight > 0 && ["auto", "scroll", "hidden", "clip"].includes(css.overflowY));
          }).map(element => ({ tag: element.tagName, class: element.className })).slice(0, 8));
      expect.soft(clipped, "no constrained scroll/overflow ancestor may clip disclosed content").toEqual([]);
      const extent = await page.evaluate(() => ({ width: (globalThis as any).document.documentElement.clientWidth, content: (globalThis as any).document.documentElement.scrollWidth }));
      expect.soft(extent.content, "no content may extend beyond the printable area").toBeLessThanOrEqual(extent.width + 2);
      for (const pre of await page.locator("pre:visible").all()) {
        const css = await pre.evaluate((element: any) => {
          const style = (globalThis as any).getComputedStyle(element);
          return { whiteSpace: style.whiteSpace, maxHeight: style.maxHeight, width: element.clientWidth, scroll: element.scrollWidth };
        });
        expect.soft(["pre-wrap", "break-spaces", "normal"], "long code lines must wrap in print").toContain(css.whiteSpace);
        expect.soft(css.maxHeight, "remove viewport-height clipping in print").toBe("none");
        expect.soft(css.scroll).toBeLessThanOrEqual(css.width + 2);
      }
      if (path === "report.csv") {
        expect(await page.locator("thead th:not(.rn)").allTextContents()).toEqual(printCsvHeaders);
        expect(await page.locator("thead th:not(.rn):visible").count(), "do not silently drop header columns").toBe(8);
        expect(await page.locator("tbody tr").last().locator("td:not(.rn):visible").count(), "do not silently drop data columns").toBe(8);
        expect(await page.locator("tbody tr").count()).toBe(160);
        expect(await page.locator("tbody tr").last().innerText()).toContain("row-159");
        const table = await page.locator("table").evaluate((element: any) => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
        expect.soft(table.width).toBeLessThanOrEqual(width);
        expect(table.height, "fixture is taller than one normal paper page").toBeGreaterThan(1123);
        expect(await page.locator("thead").evaluate((element: any) => (globalThis as any).getComputedStyle(element).display)).toBe("table-header-group");
        expect.soft(await page.locator("tbody tr").first().evaluate((element: any) => (globalThis as any).getComputedStyle(element).breakInside), "sensible row boundaries").toMatch(/avoid/);
        const croppedCells = await page.locator("th, td").evaluateAll((cells: any[]) => cells.filter(cell => cell.scrollWidth > cell.clientWidth + 2).length);
        expect.soft(croppedCells, "all columns and long paths fit rather than silently cropping cells").toBe(0);
      }
    } finally { await view.context.close(); }
  });
});

describe("print disclosure and application boundaries", () => {
  it.each([
    ["capped.txt", /truncat|first.*(?:MiB|MB|bytes)/i],
    ["capped.csv", /showing the first 2[,.]?000 rows/i],
    ["capped.json", /more \(see the Pretty or Raw view\)/],
    ["capped.ipynb", /…/],
  ] as const)("%s keeps its existing truncation notice visible in print", async (path, notice) => {
    const view = await visit(path);
    try {
      await view.page.emulateMedia({ media: "print" });
      const warning = view.page.getByText(notice).first();
      expect(await warning.count(), "the existing renderer must expose its cap notice").toBe(1);
      expect(await warning.isVisible(), "print rules must not hide existing cap notices").toBe(true);
      expect(await view.page.locator("body").innerText()).not.toMatch(/UNRENDERED_(?:CODE|NOTEBOOK)_TAIL/);
    } finally { await view.context.close(); }
  });

  it.each(documents)("%s embedded document receives print treatment without viewer controls", async (path) => {
    const view = await visit(`${path}?view=1&embed=1`, 480, "dark");
    try {
      expect(await view.page.locator(".dw-vbar").count()).toBe(0);
      await view.page.emulateMedia({ media: "print" });
      const colors = await view.page.locator("body").evaluate((element: any) => {
        const css = (globalThis as any).getComputedStyle(element);
        return [css.color, css.backgroundColor];
      });
      expect(colors).toEqual(["rgb(0, 0, 0)", "rgb(255, 255, 255)"]);
      expect(await view.page.locator("body").innerText()).toContain(path);
    } finally { await view.context.close(); }
  });

  it.each(["report.md", "report.json", "report.ipynb"])("%s preserves both folded and disclosed details", async (path) => {
    const view = await visit(path);
    try {
      const details = view.page.locator("body > :not(header.dw-vbar) details").first();
      expect(await details.count(), "fixture must exercise real rendered disclosure markup").toBe(1);
      for (const open of [false, true]) {
        await details.evaluate((element: any, value: boolean) => { element.open = value; }, open);
        const child = details.locator(":scope > :not(summary)").first();
        const visible = await child.isVisible();
        expect(visible, "fixture disclosure is observable on screen").toBe(open);
        await view.page.emulateMedia({ media: "print" });
        expect(await details.evaluate((element: any) => element.open)).toBe(open);
        expect(await child.isVisible(), "print CSS must not force folded content open or hide disclosed output").toBe(visible);
        await view.page.emulateMedia({ media: "screen" });
      }
    } finally { await view.context.close(); }
  });

  it("omits capability/navigation query strings from printable path context", async () => {
    const view = await visit("report.md?bearer=fixture-bearer&claim=fixture-claim&dw_preview=fixture-preview&unlock=fixture-unlock");
    try {
      await view.page.emulateMedia({ media: "print" });
      const text = await view.page.locator("body").innerText();
      expect.soft(text).toContain("report.md");
      expect(text).not.toMatch(/fixture-(?:bearer|claim|preview|unlock)/);
      const generated = await view.page.locator("a").evaluateAll((links: any[]) => links.filter(link => (globalThis as any).getComputedStyle(link).display !== "none").map(link =>
        `${(globalThis as any).getComputedStyle(link, "::before").content} ${(globalThis as any).getComputedStyle(link, "::after").content}`).join(" "));
      expect(generated, "do not print hrefs as generated content").not.toMatch(/fixture-|bearer=|claim=|dw_preview=|unlock=/);
    } finally { await view.context.close(); }
  });

  it("leaves HTML application's own print CSS in charge", async () => {
    const view = await visit("own.html");
    try {
      await view.page.emulateMedia({ media: "print" });
      expect(await view.page.locator("body").evaluate((element: any) => (globalThis as any).getComputedStyle(element).color)).toBe("rgb(0, 128, 0)");
      expect(await view.page.locator(".dw-vbar").count()).toBe(0);
    } finally { await view.context.close(); }
  });
});
