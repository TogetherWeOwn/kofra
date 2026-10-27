/** Test-only disposable Worker fixture. No remote bindings or production requests. */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { expect } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
export const slug = "keyboard-mode-fixture";
export const longPath = `documents/${"long-filename-".repeat(7)}résumé 雪 # & 100%.html`;
export const fixtures = {
  "index.html": "<!doctype html><title>Mode fixture</title><h1>Rendered fixture</h1>",
  "note.txt": "Keyboard mode fixture\nSecond line\n",
  [longPath]: "<!doctype html><title>Unicode fixture</title><p>Long filename</p>",
  "bytes.bin": new Uint8Array([0, 255, 0, 128, 1, 2, 3]),
  "photo.png": Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
};

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Expected loopback port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
export async function startFixture(separate = false) {
  const work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "view-mode-keyboard-"));
  const origin = `http://127.0.0.1:${await freePort()}`;
  const sites = separate ? origin.replace("127.0.0.1", "localhost") : origin;
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  const bootstrap = "view-mode-disposable-bootstrap-fixture-only";
  let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
  let browser: Browser | undefined;
  try {
    await writeFile(config, JSON.stringify({
      name: "dropway-view-mode-keyboard-test", main: join(root, "apps/worker/src/index.ts"),
      compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
      vars: { APP_ORIGIN: origin, SITES_MODE: "path", SITES_ORIGIN: separate ? sites : "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
      d1_databases: [{ binding: "DB", database_name: "view-mode-keyboard", migrations_dir: join(root, "packages/core/migrations") }],
      r2_buckets: [{ binding: "FILES", bucket_name: "view-mode-keyboard-files" }], kv_namespaces: [{ binding: "CACHE" }],
    }));
    await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
      cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    });
    worker = await unstable_startWorker({ config,
      dev: { server: { hostname: "127.0.0.1", port: Number(new URL(origin).port) }, inspector: false, persist, watch: false, logLevel: "error" },
      bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
    });
    await worker.ready;
    const setup = await fetch(`${origin}/api/v1/setup`, {
      method: "POST", headers: { Authorization: `Bearer ${bootstrap}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "keyboard-fixture@example.test" }),
    });
    expect(setup.status, "local setup fixture").toBe(201);
    const ownerKey: string = (await setup.json() as any).apiKey.key;
    const form = new FormData(); form.set("slug", slug);
    for (const [path, bytes] of Object.entries(fixtures)) form.append("files", new File([bytes], path));
    const published = await fetch(`${origin}/api/v1/publish`, { method: "POST", headers: { Authorization: `Bearer ${ownerKey}` }, body: form });
    expect(published.status, "local published file fixture").toBe(201);
    const { chromium } = require("playwright");
    const launched: Browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    browser = launched;
    return {
      origin, sites, ownerKey, browser: launched,
      async dispose() { await browser?.close(); await worker?.dispose(); await rm(work, { recursive: true, force: true }); },
    };
  } catch (error) {
    await browser?.close(); await worker?.dispose(); await rm(work, { recursive: true, force: true }); throw error;
  }
}
export type Fixture = Awaited<ReturnType<typeof startFixture>>;
export function viewerPath(path: string) { return `/v/${slug}/${path.split("/").map(encodeURIComponent).join("/")}`; }
export async function visit(fixture: Fixture, path = "index.html", width = 1100, mode = "") {
  const context: BrowserContext = await fixture.browser.newContext({ viewport: { width, height: 900 } });
  const calls: string[] = [];
  const errors: string[] = [];
  await context.addInitScript(key => {
    const w = globalThis as any;
    if (w.top === w) w.sessionStorage.setItem("dropway.key", key);
  }, fixture.ownerKey);
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (![fixture.origin, fixture.sites].includes(url.origin)) return route.abort("blockedbyclient");
    calls.push(`${request.method()} ${url.href}`);
    await route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(2500);
  page.on("pageerror", error => errors.push(error.message));
  try {
    const response = await page.goto(`${fixture.origin}${viewerPath(path)}${mode ? `?mode=${mode}` : ""}`, { waitUntil: "networkidle" });
    expect(response?.status(), "real app-origin viewer shell").toBe(200);
    await page.getByRole("tablist", { name: "View mode", exact: true }).getByRole("tab").first().waitFor();
    await page.locator("iframe").waitFor();
    return { context, page, calls, errors, shellCsp: response!.headers()["content-security-policy"] ?? "" };
  } catch (error) {
    const diagnostic = await page.locator("body").innerText();
    await context.close(); throw Error(`${String(error)}\nViewer: ${diagnostic}\nErrors: ${errors.join("; ")}\nRequests: ${calls.join("; ")}`);
  }
}
export type View = Awaited<ReturnType<typeof visit>>;
export async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    const w = globalThis as any;
    w.requestAnimationFrame(() => w.requestAnimationFrame(() => resolve()));
  }));
}
