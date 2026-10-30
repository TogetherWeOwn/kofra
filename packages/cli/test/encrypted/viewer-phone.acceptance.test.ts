/**
 * Protected paired tests: actual disposable Worker + Chromium, never production.
 * Run: npm run test:cli -- test/encrypted/viewer-phone.acceptance.test.ts
 * Uses the existing test-only Playwright/jsQR dependencies, no new dependency.
 * Each run migrates a fresh local D1 and disposes the Worker and its state.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Locator, Page } from "playwright";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const bootstrap = "viewer-phone-disposable-bootstrap-0123456789";
const password = "phone-fixture-password-0123456789";
const slug = "viewer-phone-public";
const gatedSlug = "viewer-phone-locked";
const hostilePath = 'folder/雪 & <phone> "quote" #?.md';
const longPath = `${"雪".repeat(190)}.md`;
const supportedLongPath = `${"雪".repeat(60)}.md`;
// With the local origin and site prefix this is 157 canonical ASCII bytes:
// large enough to expose subpixel module sizing in the displayed QR.
const screenDecodePath = `${"screen-".repeat(15)}scan.md`;
let work: string;
let origin: string;
let ownerKey: string;
let browser: Browser;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;

async function port(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("expected a local TCP port");
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function api(path: string, body: unknown, method = "POST", key = ownerKey) {
  const response = await fetch(origin + path, {
    method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data: any = await response.json();
  expect(response.ok, `disposable fixture ${path}: ${response.status} ${JSON.stringify(data)}`).toBe(true);
  return data;
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "viewer-phone-"));
  origin = `http://127.0.0.1:${await port()}`;
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-viewer-phone-test", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: origin, SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "viewer-phone", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "viewer-phone-files" }], kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config, dev: { server: { hostname: "127.0.0.1", port: Number(new URL(origin).port) }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  ownerKey = (await api("/api/v1/setup", { email: "phone@example.test" }, "POST", bootstrap)).apiKey.key;
  for (const name of [slug, gatedSlug]) {
    await api("/api/v1/publish", { slug: name, files: [
      { path: "notes.md", content: "# Open this file on a phone\n\nDisposable fixture.\n" },
      { path: hostilePath, content: "# Hostile but inert filename\n" },
      { path: longPath, content: "# Long public URL\n" },
      { path: screenDecodePath, content: "# Decode the on-screen public URL\n" },
      { path: supportedLongPath, content: "# Supported long public URL\n\n" + "An ordinary Markdown paragraph keeps this document tall enough to scroll.\n\n".repeat(200) },
    ] });
  }
  await api(`/api/v1/sites/${gatedSlug}/access`, { mode: "password", password }, "PUT");
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

const fileUrl = (name = slug, path = "notes.md") => `${origin}/s/${name}/${path.split("/").map(encodeURIComponent).join("/")}`;

async function visit(url: string, options: { js?: boolean; width?: number; height?: number; cookie?: string; expectedStatus?: number } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: options.js ?? false, deviceScaleFactor: 1, viewport: { width: options.width ?? 360, height: options.height ?? 800 } });
  if (options.cookie) await context.addCookies([{ name: options.cookie.split("=")[0]!, value: options.cookie.slice(options.cookie.indexOf("=") + 1), url: origin }]);
  const wire: string[] = [];
  const errors: string[] = [];
  await context.route("**/*", async route => {
    wire.push(route.request().url());
    if (new URL(route.request().url()).origin !== origin) return route.abort("blockedbyclient");
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  page.on("pageerror", error => errors.push(error.message));
  const response = await page.goto(url);
  expect(response!.status()).toBe(options.expectedStatus ?? 200);
  return { context, page, wire, errors, response: response! };
}

function phoneControl(page: Page): Locator {
  return page.locator(".dw-vbar summary, .dw-vbar label").filter({ hasText: /\bPhone\b/i });
}

async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate(el => (globalThis as any).document.activeElement === el)) return;
  }
  throw new Error("Phone disclosure is not reachable in the native Tab order.");
}

async function openPhone(page: Page) {
  const control = phoneControl(page);
  expect(await control.count(), "viewer bar must expose one native Phone disclosure").toBe(1);
  // Use keyboard only. Summary receives focus directly; a checkbox pattern
  // receives focus through its associated native input, not an inert label.
  const tag = await control.evaluate(el => (el as any).tagName.toLowerCase());
  if (tag === "summary") {
    await tabTo(page, control);
    await page.keyboard.press("Enter");
  } else {
    const id = await control.getAttribute("for");
    expect(id, "Phone label must be associated with its keyboard-operable checkbox").toBeTruthy();
    const checkbox = page.locator(`input[id="${id}"]`);
    expect(await checkbox.getAttribute("type")).toBe("checkbox");
    await tabTo(page, checkbox);
    await page.keyboard.press("Space");
  }
  const svg = page.locator(".dw-phone-panel svg");
  expect(await svg.count(), "Phone reveals an inline SVG, not a remote QR image").toBe(1);
  expect(await svg.isVisible()).toBe(true);
  expect(await svg.getAttribute("aria-label") || await svg.getAttribute("aria-labelledby") || await svg.locator("title").first().textContent().catch(() => null), "QR image must have an accessible label").toBeTruthy();
  return svg;
}

// Decode the actual served SVG, not its label or any payload data attribute.
// Rasterization runs in an isolated blank page because the viewer CSP must NOT
// be changed to permit a test-only data URL, canvas script or network service.
async function decodeSvg(svg: string): Promise<string> {
  const decoder = await browser.newPage();
  try {
    const pixels = await decoder.evaluate(async source => {
      const g = globalThis as any;
      const image = new g.Image();
      image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source);
      await image.decode();
      const canvas = g.document.createElement("canvas");
      canvas.width = 768; canvas.height = 768;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, 768, 768);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0, 768, 768);
      return Array.from(ctx.getImageData(0, 0, 768, 768).data as Iterable<number>);
    }, svg);
    return decodePixels(pixels, 768, 768).payload;
  } finally { await decoder.close(); }
}

// Decode the element screenshot at its displayed dimensions, not a larger SVG
// redraw. Only PNG unpacking happens on the blank page; no resize or smoothing
// can repair the actual DPR-1 pixels that the person sees in the viewer.
async function decodeOnScreen(svg: Locator) {
  const png = await svg.screenshot({ type: "png" });
  const decoder = await browser.newPage();
  try {
    const pixels = await decoder.evaluate(async source => {
      const g = globalThis as any;
      const image = new g.Image();
      image.src = "data:image/png;base64," + source;
      await image.decode();
      const canvas = g.document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data as Iterable<number>) };
    }, png.toString("base64"));
    return { ...decodePixels(pixels.data, pixels.width, pixels.height), width: pixels.width, height: pixels.height };
  } finally { await decoder.close(); }
}

function decodePixels(data: number[], width: number, height: number) {
  const bytes = new Uint8ClampedArray(data);
  const code = require("jsqr")(bytes, width, height);
  expect(code, "jsQR must decode actual QR pixels, not a payload attribute").toBeTruthy();
  return { payload: code.data as string, digest: createHash("sha256").update(bytes).digest("hex") };
}

async function dashboardPixels(url: string) {
  const context = await browser.newContext();
  try {
    await context.route("**/*", async route => {
      const request = route.request();
      const target = new URL(request.url());
      if (target.origin !== origin) return route.abort("blockedbyclient");
      if (target.pathname === `/api/v1/sites/${slug}` && request.method() === "GET") {
        const response = await route.fetch();
        const body = await response.json();
        body.site.url = url;
        return route.fulfill({ response, json: body });
      }
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${origin}/login`);
    await page.getByLabel(/api key/i).fill(ownerKey);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL("**/dashboard");
    await page.goto(`${origin}/dashboard/sites/${slug}`);
    await page.waitForSelector('[data-testid="site-qr-image"]');
    const pixels = await page.evaluate(async () => {
      const g = globalThis as any;
      const img = g.document.querySelector('[data-testid="site-qr-image"]');
      await img.decode();
      const canvas = g.document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return { width: canvas.width, height: canvas.height, data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data as Iterable<number>) };
    });
    return decodePixels(pixels.data, pixels.width, pixels.height);
  } finally { await context.close(); }
}

// Baseline pixel vectors freeze the pre-extraction vendored dashboard output.
// Hashes are characterized from the served PNG, while jsQR independently checks
// meaning. No QR encoder is copied into the tests.
it.each([
  ["https://files.example.test/", "1e4d639a595f4495acf12a440e57efac42af123402131cc7ba40c14071d16a84"],
  ["https://files.example.test/folder/%E9%9B%AA%20%26%20phone.md", "f0fc5875450921310a86a4bf6140345f84195dc013fd9e4b5d4454f2d99afe17"],
  [`https://files.example.test/${"a".repeat(160)}/`, "a6d9849a048f5bf4b477769290b2e4b94193b88b2bae92e8ad53d617606cdc7f"],
])("preserves the pre-extraction dashboard QR pixels for %s", async (url, digest) => {
  const actual = await dashboardPixels(url);
  expect(actual.payload).toBe(url);
  expect(actual.digest).toBe(digest);
});

async function assertPlainLink(page: Page, url: string) {
  const link = page.locator(".dw-phone-panel a").filter({ hasText: url });
  expect(await link.count(), "full canonical URL must also be readable and keyboard-reachable").toBe(1);
  expect(await link.getAttribute("href")).toBe(url);
  expect(await link.isVisible()).toBe(true);
  await link.focus();
  expect(await link.evaluate(el => (globalThis as any).document.activeElement === el)).toBe(true);
}

it.each([false, true])("canonical QR decodes with JavaScript enabled=%s, no grant/query/fragment or third-party request", async js => {
  const clean = fileUrl();
  const view = await visit(`${clean}?view=1&claim=sentinel-claim&unlock=sentinel-unlock&share=sentinel-share&token=sentinel-token#private`, { js });
  try {
    const svg = await openPhone(view.page);
    expect(await decodeSvg(await svg.evaluate(el => (el as any).outerHTML))).toBe(clean);
    await assertPlainLink(view.page, clean);
    expect(view.wire.every(url => new URL(url).origin === origin)).toBe(true);
    expect(view.wire.filter(url => /\/(?:qr|barcode|chart)(?:[/?#]|$)/i.test(url))).toEqual([]);
    expect(view.errors).toEqual([]);
    const csp = view.response.headers()["content-security-policy"]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp.match(/(?:^|;\s*)script-src\s+([^;]+)/)?.[1] ?? "'none'").toBe("'none'");
  } finally { await view.context.close(); }
});

it("hostile percent-encoded filename decodes to the same public URL, not escaped markup or a double encoding", async () => {
  const clean = fileUrl(slug, hostilePath);
  const view = await visit(`${clean}?view=1`);
  try {
    const svg = await openPhone(view.page);
    expect(await decodeSvg(await svg.evaluate(el => (el as any).outerHTML))).toBe(clean);
    await assertPlainLink(view.page, clean);
    expect(await view.page.locator("phone").count()).toBe(0);
    expect(view.errors).toEqual([]);
  } finally { await view.context.close(); }
});

it("keyboard disclosure and its URL remain inside a 320px viewport with JavaScript disabled", async () => {
  const view = await visit(`${fileUrl()}?view=1`, { width: 320 });
  try {
    const svg = await openPhone(view.page);
    const box = await svg.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(321);
    expect(box!.width).toBeGreaterThanOrEqual(100);
    expect(await view.page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
    await assertPlainLink(view.page, fileUrl());
    const control = phoneControl(view.page);
    const tag = await control.evaluate(el => (el as any).tagName.toLowerCase());
    if (tag === "summary") { await control.focus(); await view.page.keyboard.press("Enter"); }
    else { const id = await control.getAttribute("for"); await view.page.locator(`input[id="${id}"]`).focus(); await view.page.keyboard.press("Space"); }
    expect(await svg.isVisible()).toBe(false);
  } finally { await view.context.close(); }
});

it("decodes a 150–160-byte canonical URL from the actual displayed QR at DPR 1", async () => {
  const clean = fileUrl(slug, screenDecodePath);
  expect(Buffer.byteLength(clean, "utf8")).toBeGreaterThanOrEqual(150);
  expect(Buffer.byteLength(clean, "utf8")).toBeLessThanOrEqual(160);
  const view = await visit(`${clean}?view=1&token=not-public`, { js: false, width: 360 });
  try {
    const svg = await openPhone(view.page);
    expect(await view.page.evaluate(() => (globalThis as any).devicePixelRatio)).toBe(1);
    const modules = await svg.evaluate(el => (el as unknown as { viewBox: { baseVal: { width: number } } }).viewBox.baseVal.width);
    expect(modules).toBeGreaterThanOrEqual(70);
    const box = (await svg.boundingBox())!;
    const screenshot = await decodeOnScreen(svg);
    expect(screenshot.payload).toBe(clean);
    // Screenshot clips round fractional element coordinates outwards, which
    // can add one edge pixel without changing the displayed scale.
    expect(screenshot.width).toBeGreaterThanOrEqual(box.width);
    expect(screenshot.width).toBeLessThanOrEqual(Math.ceil(box.width) + 1);
    expect(screenshot.height).toBeGreaterThanOrEqual(box.height);
    expect(screenshot.height).toBeLessThanOrEqual(Math.ceil(box.height) + 1);
    expect(box.width / modules, "displayed QR modules must occupy whole CSS pixels").toBe(Math.floor(box.width / modules));
    await assertPlainLink(view.page, clean);
    expect(view.errors).toEqual([]);
  } finally { await view.context.close(); }
});

it.each([
  { name: "short public URL", path: "notes.md", width: 480, height: 240 },
  { name: "screen-decode URL", path: screenDecodePath, width: 568, height: 320 },
  { name: "screen-decode URL", path: screenDecodePath, width: 480, height: 240 },
  { name: "supported long Unicode URL", path: supportedLongPath, width: 480, height: 240 },
])("native scrolling exposes the complete no-script $name QR at $width×$height", async ({ path, width, height }) => {
  const clean = fileUrl(slug, path);
  const urlBytes = Buffer.byteLength(clean, "utf8");
  expect(urlBytes).toBeLessThan(1273);
  if (path === supportedLongPath) expect(urlBytes).toBeGreaterThanOrEqual(580);
  const view = await visit(`${clean}?view=1&token=not-public`, { js: false, width, height });
  try {
    if (path === supportedLongPath) {
      const document = await view.page.evaluate(() => {
        const scroll = (globalThis as any).document.scrollingElement;
        return { height: scroll.scrollHeight, viewport: scroll.clientHeight };
      });
      expect(document.height, "the long-URL fixture must be scrollable before opening Phone").toBeGreaterThan(document.viewport);
    }
    const svg = await openPhone(view.page);
    expect(await view.page.evaluate(() => (globalThis as any).devicePixelRatio)).toBe(1);
    const markup = await svg.evaluate(el => (el as any).outerHTML as string);
    const svgBytes = Buffer.byteLength(markup, "utf8");
    expect(svgBytes).toBeLessThanOrEqual(128 * 1024);
    await assertPlainLink(view.page, clean);
    expect(view.errors).toEqual([]);
    expect(view.wire.every(url => new URL(url).origin === origin)).toBe(true);

    // Let the browser scroll any ancestors, including the document. Do not
    // assume a panel selector, fixed position, max-height or scroll container.
    await svg.scrollIntoViewIfNeeded();
    const exposure = await svg.evaluate(el => {
      const g = globalThis as any;
      const rect = el.getBoundingClientRect();
      const image = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      const clips = [{ name: "viewport", x: true, y: true, left: 0, top: 0, right: g.document.documentElement.clientWidth, bottom: g.document.documentElement.clientHeight }];
      const rootStyle = g.getComputedStyle(g.document.documentElement);
      for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
        // Root scrolling clips at the viewport, not its scrolled DOM rect.
        if (ancestor === g.document.scrollingElement || ancestor === g.document.documentElement) continue;
        const style = g.getComputedStyle(ancestor);
        const paint = /\b(?:paint|strict|content)\b/.test(style.contain);
        const bodyViewport = ancestor === g.document.body && rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible";
        const x = paint || (!bodyViewport && /^(?:auto|scroll|hidden|clip|overlay)$/.test(style.overflowX));
        const y = paint || (!bodyViewport && /^(?:auto|scroll|hidden|clip|overlay)$/.test(style.overflowY));
        if (!x && !y) continue;
        const box = ancestor.getBoundingClientRect();
        const left = box.left + ancestor.clientLeft;
        const top = box.top + ancestor.clientTop;
        clips.push({ name: `${ancestor.tagName}.${ancestor.className}`, x, y, left, top, right: left + ancestor.clientWidth, bottom: top + ancestor.clientHeight });
      }
      return { image, clips, modules: (el as unknown as { viewBox: { baseVal: { width: number } } }).viewBox.baseVal.width };
    });
    expect(exposure.modules).toBeGreaterThan(0);
    const pixelsPerModule = exposure.image.width / exposure.modules;
    expect(pixelsPerModule).toBeGreaterThanOrEqual(1);
    expect(pixelsPerModule, "viewport fitting must not blur modules through fractional sizing").toBe(Math.floor(pixelsPerModule));
    expect(exposure.image.height).toBe(exposure.image.width);
    // The entire SVG includes its quiet zone. client metrics/native scroll
    // offsets round to CSS pixels, so tolerate only one edge pixel of rounding.
    for (const clip of exposure.clips) {
      const where = `${clip.name}: ${JSON.stringify({ urlBytes, svgBytes, image: exposure.image, clip, modules: exposure.modules })}`;
      if (clip.x) {
        expect(exposure.image.width, `the complete QR must fit horizontally within ${where}`).toBeLessThanOrEqual(clip.right - clip.left + 1);
        expect(exposure.image.left, where).toBeGreaterThanOrEqual(clip.left - 1);
        expect(exposure.image.right, where).toBeLessThanOrEqual(clip.right + 1);
      }
      if (clip.y) {
        expect(exposure.image.height, `the complete QR must fit vertically within ${where}`).toBeLessThanOrEqual(clip.bottom - clip.top + 1);
        expect(exposure.image.top, where).toBeGreaterThanOrEqual(clip.top - 1);
        expect(exposure.image.bottom, where).toBeLessThanOrEqual(clip.bottom + 1);
      }
    }
  } finally { await view.context.close(); }
});

it("overflow has no QR but retains the full usable link on a narrow no-script page", async () => {
  const clean = fileUrl(slug, longPath);
  const view = await visit(`${clean}?view=1&token=not-public`, { width: 320 });
  try {
    expect(await view.page.locator(".dw-phone-panel svg").count()).toBe(0);
    const control = phoneControl(view.page);
    if (await control.count()) {
      const tag = await control.evaluate(el => (el as any).tagName.toLowerCase());
      if (tag === "summary") { await control.focus(); await view.page.keyboard.press("Enter"); }
      else { const id = await control.getAttribute("for"); await view.page.locator(`input[id="${id}"]`).focus(); await view.page.keyboard.press("Space"); }
    }
    await assertPlainLink(view.page, clean);
    expect(await view.page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);
    expect(view.errors).toEqual([]);
  } finally { await view.context.close(); }
});

it("unlocked desktop encodes only the public URL and a fresh phone still encounters the password gate", async () => {
  const clean = fileUrl(gatedSlug);
  const locked = await fetch(`${clean}?view=1`);
  expect(await locked.text()).toMatch(/password/i);
  const unlocked = await fetch(`${origin}/s/${gatedSlug}/__dropway/password`, {
    method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams({ password, next: `/s/${gatedSlug}/notes.md?view=1` }),
  });
  expect(unlocked.status).toBe(303);
  const cookie = unlocked.headers.get("set-cookie")!.split(";")[0]!;
  const view = await visit(`${clean}?view=1`, { cookie });
  try {
    const svg = await openPhone(view.page);
    const decoded = await decodeSvg(await svg.evaluate(el => (el as any).outerHTML));
    expect(decoded).toBe(clean);
    expect(await view.page.content()).not.toContain(password);
    const phone = await visit(decoded, { expectedStatus: 401 });
    try {
      expect(await phone.page.locator('input[type="password"]').count()).toBe(1);
      expect(await phone.page.locator(".dw-phone-panel svg").count()).toBe(0);
    } finally { await phone.context.close(); }
  } finally { await view.context.close(); }
});

it("embed mode and directory listings omit the Phone disclosure", async () => {
  for (const url of [`${fileUrl()}?view=1&embed=1`, `${origin}/s/${slug}/folder/`]) {
    const view = await visit(url);
    try {
      expect(await phoneControl(view.page).count()).toBe(0);
      expect(await view.page.locator(".dw-phone-panel svg").count()).toBe(0);
    } finally { await view.context.close(); }
  }
});
