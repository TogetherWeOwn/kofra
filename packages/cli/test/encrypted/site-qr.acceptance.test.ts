/**
 * Disposable-browser acceptance for the dashboard site-page QR code (SITE-QR).
 *
 * Prerequisites and runner (the existing test-only Chromium harness):
 *   npm ci --include=dev
 *   npm ci --prefix packages/cli/test/encrypted --include=dev
 *   packages/cli/test/encrypted/node_modules/.bin/playwright install --with-deps chromium
 *   npm run test:cli -- test/encrypted/site-qr.acceptance.test.ts
 * Optional: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH selects installed Chromium.
 *
 * Only fixture setup uses the API directly (setup, publish, set password).
 * The dashboard shell, CSP, served script, sign-in and site page are real, from
 * a disposable loopback Worker. No production calls. QR pixels are decoded in
 * the browser with the first-party BarcodeDetector (no third-party service) and
 * compared to the displayed URL. The fast vm contract lives in
 * packages/server/test/site-qr.acceptance.test.ts; this file pins real rendering,
 * keyboard focus, narrow layout and the sentinel leak check end to end.
 *
 * Contract (same selectors as the vm tests; builder implements once):
 * - `#dw-site [data-testid="site-qr"]` with `img[data-testid="site-qr-image"]`
 *   (alt==URL, src=data:image/png, data-qr-payload==URL), adjacent
 *   `[data-testid="site-qr-url"]` text+link, and for gated sites a visible
 *   `[data-testid="site-qr-gated-notice"]` naming the password requirement.
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
import type { Browser, BrowserContext, Page, Route } from "playwright";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const bootstrap = "site-qr-disposable-bootstrap-0123456789abcdef";
const publicSlug = "qr-public-phone";
const gatedSlug = "qr-gated-phone";
const sentinelPassword = "qr-sentinel-pw-9f8e7d6c5b4a-Hunt3r2";
let work: string;
let origin: string;
let ownerKey: string;
let publicUrl: string;
let gatedUrl: string;
let browser: Browser;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;

type Wire = { method: string; url: string };
type View = { context: BrowserContext; page: Page; wire: Wire[]; consoleErrors: string[]; consoleLogs: string[] };

async function port(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("expected a local TCP port");
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function api(path: string, init: RequestInit = {}, key = ownerKey) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  const response = await fetch(origin + path, { ...init, headers });
  const body: any = await response.json().catch(() => null);
  expect(response.ok, `disposable fixture API ${path}: ${response.status} ${JSON.stringify(body)}`).toBe(true);
  return body;
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "site-qr-"));
  origin = `http://127.0.0.1:${await port()}`;
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-site-qr-test", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: origin, SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "site-qr", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "site-qr-files" }], kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config, dev: { server: { hostname: "127.0.0.1", port: Number(new URL(origin).port) }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  const setup = await api("/api/v1/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "qr@example.com" }) }, bootstrap);
  ownerKey = setup.apiKey.key;
  for (const slug of [publicSlug, gatedSlug]) {
    const form = new FormData();
    form.set("slug", slug);
    form.append("index.html", new File([`<h1>${slug}</h1>`], "index.html"));
    const published = await api("/api/v1/publish", { method: "POST", body: form });
    if (slug === publicSlug) publicUrl = published.url;
    else gatedUrl = published.url;
  }
  await api(`/api/v1/sites/${gatedSlug}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: sentinelPassword }) });
  // Guard: the gated fixture really is gated and URLs are clean public live URLs.
  expect(publicUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/qr-public-phone\/$/);
  expect(gatedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/qr-gated-phone\/$/);
  const gated = await api(`/api/v1/sites/${gatedSlug}`);
  expect(gated.site.settings.passwordProtected).toBe(true);
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function visit(slug: string, options: { mobile?: boolean; route?: (route: Route) => Promise<void> } = {}): Promise<View> {
  const context = await browser.newContext({ viewport: options.mobile ? { width: 360, height: 800 } : { width: 1100, height: 900 } });
  const wire: Wire[] = [];
  await context.route("**/*", async route => {
    const request = route.request();
    wire.push({ method: request.method(), url: request.url() });
    if (new URL(request.url()).origin !== origin) return route.abort("blockedbyclient");
    if (options.route) return options.route(route);
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const consoleErrors: string[] = [];
  const consoleLogs: string[] = [];
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
    else consoleLogs.push(message.text());
  });
  page.on("pageerror", (error: Error) => consoleErrors.push(error.message));
  await page.goto(`${origin}/login`, { waitUntil: "networkidle" });
  await page.getByLabel(/api key/i).fill(ownerKey);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL("**/dashboard");
  const response = await page.goto(`${origin}/dashboard/sites/${slug}`, { waitUntil: "networkidle" });
  const csp = response!.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self'");
  expect(csp.match(/script-src[^;]*/)?.[0]).not.toMatch(/unsafe-inline|unsafe-eval/);
  return { context, page, wire, consoleErrors, consoleLogs };
}

async function close(view: View): Promise<void> {
  await view.context.close();
}

/** Decode the rendered QR with the browser's first-party BarcodeDetector. */
async function decodeQr(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const pageGlobal = globalThis as any;
    const doc = pageGlobal.document;
    const img = doc.querySelector('[data-testid="site-qr-image"]');
    if (!img) throw new Error("Missing [data-testid=site-qr-image] for decode.");
    const Detector = pageGlobal.BarcodeDetector;
    if (!Detector) throw new Error("Chromium must support BarcodeDetector for QR decode.");
    const detector = new Detector({ formats: ["qr_code"] });
    if (String(img.tagName).toLowerCase() === "canvas") {
      const codes = await detector.detect(img);
      if (!codes.length) throw new Error("BarcodeDetector found no QR in canvas.");
      return codes[0].rawValue;
    }
    const src = img.currentSrc || img.src;
    if (!String(src).startsWith("data:image/")) throw new Error(`QR src must be a data URL for offline decode (got ${String(src).slice(0, 60)}).`);
    const res = await pageGlobal.fetch(src);
    const blob = await res.blob();
    const bitmap = await pageGlobal.createImageBitmap(blob);
    const codes = await detector.detect(bitmap);
    if (!codes.length) throw new Error("BarcodeDetector found no QR in the rendered image.");
    return codes[0].rawValue;
  });
}

async function displayedUrl(page: Page): Promise<{ text: string; href: string | null; alt: string | null; payload: string | null }> {
  return page.evaluate(() => {
    const doc = (globalThis as any).document;
    const box = doc.querySelector('[data-testid="site-qr"]');
    if (!box) throw new Error("Missing [data-testid=site-qr].");
    const urlBox = box.querySelector('[data-testid="site-qr-url"]');
    if (!urlBox) throw new Error("Missing [data-testid=site-qr-url].");
    const link = String(urlBox.tagName).toLowerCase() === "a" ? urlBox : urlBox.querySelector("a");
    const img = box.querySelector('[data-testid="site-qr-image"]');
    return {
      text: String(urlBox.textContent ?? "").trim(),
      href: link ? (link.href ?? link.getAttribute("href") ?? null) : null,
      alt: img ? (img.getAttribute("alt") ?? img.getAttribute("aria-label") ?? null) : null,
      payload: img ? (img.getAttribute("data-qr-payload") ?? null) : null,
    };
  });
}

it("public site: decoded QR payload equals the displayed clean public live URL", async () => {
  const view = await visit(publicSlug);
  try {
    await view.page.waitForSelector('[data-testid="site-qr"]');
    const shown = await displayedUrl(view.page);
    expect(shown.text).toContain(publicUrl);
    expect(shown.href).toBe(publicUrl);
    expect(shown.alt).toBe(publicUrl);
    expect(shown.payload).toBe(publicUrl);
    expect(await decodeQr(view.page)).toBe(publicUrl);
    // Zero third-party: every request stayed on the disposable origin.
    for (const request of view.wire) {
      expect(new URL(request.url).origin, `same-origin only (got ${request.url})`).toBe(origin);
    }
    expect(view.wire.some(r => new URL(r.url).pathname.includes("qr") && !new URL(r.url).pathname.includes("qr-")), "no QR endpoint").toBe(false);
    expect(view.consoleErrors, "no browser errors").toEqual([]);
    // Existing controls unaffected.
    for (const label of ["Browse files", "Publish update", "Open site", "Versions", "Settings", "Delete site"]) {
      expect(await view.page.locator("#dw-site").getByText(label, { exact: false }).first().isVisible(), `existing control visible: ${label}`).toBe(true);
    }
  } finally { await close(view); }
});

it("gated site: same URL payload plus password notice; password never leaks (sentinel)", async () => {
  const view = await visit(gatedSlug);
  try {
    await view.page.waitForSelector('[data-testid="site-qr"]');
    const shown = await displayedUrl(view.page);
    expect(shown.payload).toBe(gatedUrl);
    expect(await decodeQr(view.page)).toBe(gatedUrl);
    const notice = view.page.locator('[data-testid="site-qr-gated-notice"]');
    expect(await notice.isVisible(), "gated notice visible").toBe(true);
    expect(await notice.innerText(), "notice names the password requirement").toMatch(/password/i);
    // Sentinel: password never in page, payload, logs, errors or wire.
    const html = await view.page.content();
    expect(html).not.toContain(sentinelPassword);
    expect(shown.text).not.toContain(sentinelPassword);
    expect(view.consoleLogs.join("\n")).not.toContain(sentinelPassword);
    expect(view.consoleErrors.join("\n")).not.toContain(sentinelPassword);
    expect(view.wire.map(r => r.url).join("\n")).not.toContain(sentinelPassword);
    const src = await view.page.getAttribute('[data-testid="site-qr-image"]', "src");
    expect(src ?? "").not.toContain(Buffer.from(sentinelPassword).toString("base64").slice(0, 12));
    expect(view.consoleErrors).toEqual([]);
  } finally { await close(view); }
});

it("QR is keyboard-reachable and narrow-safe at 360px", async () => {
  const view = await visit(publicSlug, { mobile: true });
  try {
    await view.page.waitForSelector('[data-testid="site-qr"]');
    // Keyboard: Tab reaches the QR container (URL link or tabindex image).
    await view.page.locator("a.dw-skip").first().focus();
    let reached = false;
    for (let i = 0; i < 40; i++) {
      await view.page.keyboard.press("Tab");
      const inQr = await view.page.evaluate(() => {
        const active = (globalThis as any).document.activeElement;
        return !!(active && active.closest && active.closest('[data-testid="site-qr"]'));
      });
      if (inQr) { reached = true; break; }
    }
    expect(reached, "Tab reaches the QR container").toBe(true);
    // Narrow: no horizontal overflow; QR image scales to the viewport.
    const overflow = await view.page.evaluate(() => {
      const doc = (globalThis as any).document;
      const el = doc.scrollingElement ?? doc.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(overflow.scrollWidth, `no sideways scroll at 360px (scroll ${overflow.scrollWidth} vs client ${overflow.clientWidth})`).toBeLessThanOrEqual(overflow.clientWidth + 1);
    const box = await view.page.locator('[data-testid="site-qr-image"]').boundingBox();
    expect(box, "QR image has a box").not.toBeNull();
    expect(box!.width, "QR fits narrow screens").toBeLessThanOrEqual(360);
    expect(box!.width, "QR is large enough to scan").toBeGreaterThanOrEqual(96);
  } finally { await close(view); }
});

it("loading, error and empty QR states (route-controlled, no new endpoint)", async () => {
  // Loading: delay the site response; QR loading shows, then the QR.
  {
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    const view = await visit(publicSlug, {
      route: async route => {
        const url = new URL(route.request().url());
        if (url.pathname === `/api/v1/sites/${publicSlug}` && route.request().method() === "GET") {
          await gate;
        }
        return route.continue();
      },
    });
    try {
      await view.page.waitForSelector('[data-testid="site-qr-loading"]', { timeout: 3000 });
      release();
      await view.page.waitForSelector('[data-testid="site-qr-image"]');
      expect(await decodeQr(view.page)).toBe(publicUrl);
    } finally { release(); await close(view); }
  }
  // Error: site read fails; QR error (role=alert), no broken image.
  {
    const view = await visit(publicSlug, {
      route: async route => {
        const url = new URL(route.request().url());
        if (url.pathname === `/api/v1/sites/${publicSlug}`) {
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Boom.", hint: "Retry." } }) });
        }
        return route.continue();
      },
    });
    try {
      await view.page.waitForSelector('[data-testid="site-qr-error"]');
      expect(await view.page.getAttribute('[data-testid="site-qr-error"]', "role")).toBe("alert");
      expect(await view.page.locator('[data-testid="site-qr-image"]').count()).toBe(0);
    } finally { await close(view); }
  }
  // Empty: API returns a site without a URL; empty state, existing controls stay.
  {
    const view = await visit(publicSlug, {
      route: async route => {
        const url = new URL(route.request().url());
        if (url.pathname === `/api/v1/sites/${publicSlug}`) {
          const res = await route.fetch();
          const body: any = await res.json();
          body.site.url = null;
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
        }
        return route.continue();
      },
    });
    try {
      await view.page.waitForSelector('[data-testid="site-qr-empty"]');
      expect(await view.page.locator('[data-testid="site-qr-image"]').count()).toBe(0);
      expect(await view.page.locator("#dw-site").getByText("Browse files").first().isVisible(), "existing controls stay").toBe(true);
    } finally { await close(view); }
  }
});
