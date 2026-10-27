/**
 * Disposable-browser acceptance: keyboard focus is visible on the no-script
 * viewer toggles (WCAG 2.4.7). Keyboard only: Tab to the hidden zoom/Tree/
 * Pretty/Wrap inputs and read the *computed* indicator on the visible label
 * in light and dark schemes; Space and arrow keys must keep working exactly
 * as before. Colocated with the existing isolated Playwright harness (not an
 * encrypted-publishing feature); only a disposable loopback Worker runs.
 *
 * Run: npx vitest run -c packages/cli/vitest.config.ts test/encrypted/viewer-toggle-focus.browser.acceptance.test.ts
 * (needs `npm ci --prefix packages/cli/test/encrypted --include=dev` and a
 * Playwright Chromium, as in CI). The fast rendered-CSS/ETag contract lives
 * in test/viewer-toggle-focus.acceptance.test.ts.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "playwright";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const slug = "toggle-focus-fixture";
const bootstrap = "toggle-focus-disposable-bootstrap-0123456789";
// A real 1x1 PNG so the media stage loads an actual image.
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"));

let work: string;
let origin: string;
let ownerKey: string;
let browser: Browser;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;

const fileUrl = (path: string) => `${origin}/s/${slug}/${path}`;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("Expected loopback port");
  await new Promise<void>((resolve, reject) => socket.close(e => e ? reject(e) : resolve()));
  return address.port;
}

async function api(path: string, init: RequestInit = {}, key = ownerKey) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  const response = await fetch(origin + path, { ...init, headers });
  const body: any = await response.json();
  expect(response.ok, `disposable API ${path}: ${response.status} ${JSON.stringify(body)}`).toBe(true);
  return body;
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "toggle-focus-"));
  origin = `http://127.0.0.1:${await freePort()}`;
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-toggle-focus-test", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: origin, SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "toggle-focus", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "toggle-focus-files" }], kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({ config,
    dev: { server: { hostname: "127.0.0.1", port: Number(new URL(origin).port) }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  const setup = await api("/api/v1/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "toggle-fixture@example.com" }) }, bootstrap);
  ownerKey = setup.apiKey.key;
  const body = new FormData();
  body.set("slug", slug);
  body.append("img/logo.png", new File([PNG], "logo.png"));
  body.append("img/icon.svg", new File(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#d9480f"/></svg>'], "icon.svg"));
  body.append("data/config.json", new File(['{"name":"focus","list":[1,2,3],"nested":{"ok":true}}'], "config.json"));
  body.append("src/app.ts", new File(["// toggle focus fixture\nexport const answer: number = 42;\n"], "app.ts"));
  const published = await api("/api/v1/publish", { method: "POST", body });
  expect(String(published.url)).toContain(`/s/${slug}/`);
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function open(path: string, colorScheme: "light" | "dark") {
  const context = await browser.newContext({ colorScheme, viewport: { width: 1100, height: 900 } });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(fileUrl(path), { waitUntil: "load" });
  // The emulated scheme really is in effect for this context.
  expect(await page.evaluate(() => (globalThis as any).matchMedia("(prefers-color-scheme: dark)").matches), `color scheme ${colorScheme}`).toBe(colorScheme === "dark");
  return { context, page };
}

const activeId = (page: Page) => page.evaluate(() => (globalThis as any).document.activeElement?.id ?? null) as Promise<string | null>;

/** Keyboard only: press Tab until the hidden toggle input holds focus. */
async function tabTo(page: Page, id: string) {
  for (let i = 0; i < 30; i++) {
    if ((await activeId(page)) === id) return;
    await page.keyboard.press("Tab");
  }
  expect(await activeId(page), `Tab reaches #${id}`).toBe(id);
}

interface Indicator { outlineStyle: string; outlineWidth: string; boxShadow: string }
const indicator = (page: Page, selector: string) => page.evaluate((sel: string) => {
  const el = (globalThis as any).document.querySelector(sel);
  if (!el) return null;
  const cs = (globalThis as any).getComputedStyle(el);
  return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, boxShadow: cs.boxShadow };
}, selector) as Promise<Indicator | null>;

/** A clearly visible indicator: a real outline (style + width) or a shadow ring. */
const isVisible = (ind: Indicator | null) =>
  !!ind && ((ind.outlineStyle !== "none" && parseFloat(ind.outlineWidth) > 0) || (ind.boxShadow !== "none" && ind.boxShadow !== ""));

const checked = (page: Page, id: string) => page.evaluate((i: string) => (globalThis as any).document.getElementById(i)?.checked === true, id) as Promise<boolean>;
const displayOf = (page: Page, selector: string) => page.evaluate((sel: string) => {
  const el = (globalThis as any).document.querySelector(sel);
  return el ? (globalThis as any).getComputedStyle(el).display as string : null;
}, selector) as Promise<string | null>;
const scriptCount = (page: Page) => page.evaluate(() => (globalThis as any).document.scripts.length) as Promise<number>;

const MEDIABAR_LABEL = '.dw-mediabar label[for="dw-zoom"]';

async function assertZoomFocus(page: Page) {
  expect(await scriptCount(page), "media viewers stay script-free").toBe(0);
  expect(isVisible(await indicator(page, MEDIABAR_LABEL)), "no indicator before focus").toBe(false);
  await tabTo(page, "dw-zoom");
  expect(await checked(page, "dw-zoom"), "toggle starts unchecked").toBe(false);
  expect(isVisible(await indicator(page, MEDIABAR_LABEL)), "Actual size label shows a visible focus indicator while unchecked").toBe(true);
  // Space zooms, as before — and the indicator persists while focus stays.
  await page.keyboard.press("Space");
  expect(await checked(page, "dw-zoom"), "Space checks the zoom toggle").toBe(true);
  const imgMaxWidth = () => page.evaluate(() => (globalThis as any).getComputedStyle((globalThis as any).document.querySelector(".dw-stage img")).maxWidth) as Promise<string>;
  expect(await imgMaxWidth(), "checked state lifts the image size cap (zoom)").toBe("none");
  expect(await activeId(page), "focus stays on the toggle").toBe("dw-zoom");
  expect(isVisible(await indicator(page, MEDIABAR_LABEL)), "indicator persists alongside the checked/zoomed state").toBe(true);
  await page.keyboard.press("Space");
  expect(await checked(page, "dw-zoom"), "Space again unzooms").toBe(false);
  expect(await imgMaxWidth()).not.toBe("none");
  // Pointer paths are unchanged: the mediabar label and the checker stage toggle.
  await page.locator(MEDIABAR_LABEL).click();
  expect(await checked(page, "dw-zoom"), "clicking Actual size still toggles").toBe(true);
  await page.locator(".dw-stage").click();
  expect(await checked(page, "dw-zoom"), "clicking the stage still toggles").toBe(false);
}

it.each(["light", "dark"] as const)("image viewer: zoom toggle focus is visible (%s scheme)", async scheme => {
  const { context, page } = await open("img/logo.png", scheme);
  try { await assertZoomFocus(page); } finally { await context.close(); }
});

it.each(["light", "dark"] as const)("SVG viewer: zoom toggle focus is visible (%s scheme)", async scheme => {
  const { context, page } = await open("img/icon.svg", scheme);
  try { await assertZoomFocus(page); } finally { await context.close(); }
});

it.each(["light", "dark"] as const)("JSON viewer: Tree/Pretty focus is visible, arrows switch panes (%s scheme)", async scheme => {
  const { context, page } = await open("data/config.json", scheme);
  try {
    expect(await scriptCount(page), "JSON viewer stays script-free").toBe(0);
    const tree = '.dw-jtabs label[for="dw-jt-tree"]';
    const pretty = '.dw-jtabs label[for="dw-jt-pretty"]';
    expect(isVisible(await indicator(page, tree)), "no indicator before focus (Tree)").toBe(false);
    expect(isVisible(await indicator(page, pretty)), "no indicator before focus (Pretty)").toBe(false);

    await tabTo(page, "dw-jt-tree");
    expect(isVisible(await indicator(page, tree)), "focused Tree radio outlines the Tree label").toBe(true);
    expect(isVisible(await indicator(page, pretty)), "unfocused Pretty label is not outlined").toBe(false);
    expect(await displayOf(page, ".dw-jtree"), "tree pane shown").not.toBe("none");
    expect(await displayOf(page, ".dw-jpretty"), "pretty pane hidden").toBe("none");

    // Native radio-group behaviour: arrow moves focus and selection together,
    // and the no-script pane switch follows.
    await page.keyboard.press("ArrowRight");
    expect(await activeId(page), "ArrowRight moves focus to Pretty").toBe("dw-jt-pretty");
    expect(await checked(page, "dw-jt-pretty"), "ArrowRight selects Pretty").toBe(true);
    expect(isVisible(await indicator(page, pretty)), "focused Pretty radio outlines the Pretty label").toBe(true);
    expect(isVisible(await indicator(page, tree)), "Tree label indicator follows focus away").toBe(false);
    expect(await displayOf(page, ".dw-jpretty"), "pretty pane shown").not.toBe("none");
    expect(await displayOf(page, ".dw-jtree"), "tree pane hidden").toBe("none");

    await page.keyboard.press("ArrowLeft");
    expect(await activeId(page), "ArrowLeft returns focus to Tree").toBe("dw-jt-tree");
    expect(await checked(page, "dw-jt-tree"), "ArrowLeft re-selects Tree").toBe(true);
    expect(isVisible(await indicator(page, tree)), "Tree label outlined again").toBe(true);
    expect(await displayOf(page, ".dw-jtree"), "tree pane shown again").not.toBe("none");

    // Distinguishable from checked: tabbing out removes the indicator although
    // Tree stays the selected (checked-styled) tab.
    await page.keyboard.press("Tab");
    expect(await activeId(page), "Tab leaves the radio group").not.toBe("dw-jt-tree");
    expect(await checked(page, "dw-jt-tree"), "Tree is still selected").toBe(true);
    expect(isVisible(await indicator(page, tree)), "checked styling alone paints no focus indicator").toBe(false);
  } finally { await context.close(); }
});

it.each(["light", "dark"] as const)("code viewer: Wrap label focus still shows (regression, %s scheme)", async scheme => {
  const { context, page } = await open("src/app.ts", scheme);
  try {
    const wrap = '.dw-codehead label[for="dw-wrap"]';
    expect(isVisible(await indicator(page, wrap)), "no Wrap indicator before focus").toBe(false);
    await tabTo(page, "dw-wrap");
    expect(isVisible(await indicator(page, wrap)), "Wrap label shows its focus indicator").toBe(true);
    await page.keyboard.press("Space");
    expect(await checked(page, "dw-wrap"), "Space still toggles wrap").toBe(true);
  } finally { await context.close(); }
});

it("conditional requests never revalidate the pre-fix styling (disposable runtime)", async () => {
  const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
  for (const [viewerId, path] of [["image", "img/logo.png"], ["svg", "img/icon.svg"], ["json", "data/config.json"]] as const) {
    const res = await fetch(fileUrl(path), { headers: NAV });
    expect(res.status, path).toBe(200);
    const etag = res.headers.get("etag")!;
    const m = new RegExp(`^W/"${viewerId}@(\\d+)-`).exec(etag);
    expect(m, `${viewerId} ETag: ${etag}`).not.toBeNull();
    // Every pre-fix page (image, SVG and JSON alike) was viewer version 2.
    expect(Number(m![1]), `${viewerId} viewer version bumped past the pre-change 2`).toBeGreaterThan(2);
    await res.text();
    const staleTag = etag.replace(/@\d+-/, "@2-");
    expect(staleTag, `${viewerId}: the stale validator differs from the current one`).not.toBe(etag);
    const stale = await fetch(fileUrl(path), { headers: { ...NAV, "If-None-Match": staleTag } });
    expect(stale.status, `${viewerId}: pre-change validator must not match`).toBe(200);
    expect(await stale.text(), `${viewerId}: revalidated body carries a focus indicator rule`).toContain(":focus-visible");
    const current = await fetch(fileUrl(path), { headers: { ...NAV, "If-None-Match": etag } });
    expect(current.status, `${viewerId}: current validator still 304s`).toBe(304);
  }
});
