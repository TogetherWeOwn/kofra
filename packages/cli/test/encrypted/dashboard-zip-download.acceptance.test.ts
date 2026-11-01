/**
 * PROTECTED acceptance: actual served dashboard -> native ZIP download -> unzip/hash.
 * Test Author owns this file. Builder must run it unchanged, never weaken it.
 * Local disposable Worker only: no deployment, remote instances or production data.
 * Run: npm run test:cli -- test/encrypted/dashboard-zip-download.acceptance.test.ts
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser } from "playwright";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("playwright") as typeof import("playwright");
const { unzipSync } = require("fflate") as typeof import("fflate");
const slug = "dashboard-zip-fixture";
const bootstrap = "disposable-dashboard-zip-bootstrap-0123456789";
const fixtures = [
  { "index.html": "<h1>historical version</h1>\n", "assets/info.txt": "first exact bytes\n" },
  { "index.html": "<h1>newer version</h1>\n", "assets/info.txt": "second different bytes\n" },
];
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
let work: string;
let origin: string;
let ownerKey: string;
let browser: Browser;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
const versions: Array<{ id: string; number: number }> = [];

async function port() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("Local port unavailable");
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function api(path: string, init: RequestInit = {}, key = ownerKey) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  const response = await fetch(origin + path, { ...init, headers });
  expect(response.ok, `disposable fixture ${init.method ?? "GET"} ${path}: HTTP ${response.status}`).toBe(true);
  return response.json() as Promise<any>;
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "dashboard-zip-"));
  origin = `http://127.0.0.1:${await port()}`;
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-dashboard-zip-test", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    vars: { APP_ORIGIN: origin, SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "dashboard-zip", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "dashboard-zip-files" }], kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config, dev: { server: { hostname: "127.0.0.1", port: Number(new URL(origin).port) }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  const setup = await api("/api/v1/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "zip@example.com" }) }, bootstrap);
  ownerKey = setup.apiKey.key;
  for (const files of fixtures) {
    const form = new FormData();
    form.set("slug", slug);
    for (const [path, text] of Object.entries(files)) form.append(path, new File([text], path.split("/").pop()!));
    const published = await api("/api/v1/publish", { method: "POST", body: form });
    versions.push(published.version);
  }
  expect(versions.map(version => version.number)).toEqual([1, 2]);
  for (let i = 0; i < versions.length; i++) {
    const manifest = await api(`/api/v1/sites/${slug}/files?version=${versions[i]!.id}`);
    expect(manifest.files).toEqual(expect.arrayContaining(Object.entries(fixtures[i]!).map(([path, text]) => expect.objectContaining({ path, sha256: digest(text), size: Buffer.byteLength(text) }))));
  }
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

it.each([
  { selected: 0, key: "Enter", width: 1100 },
  { selected: 1, key: "Space", width: 360 },
])("downloads selected version $selected with $key at width $width while live moves", async ({ selected, key, width }) => {
  // Restore before opening the page so v2 is a loaded live row in both cases.
  await api(`/api/v1/sites/${slug}/versions/${versions[1]!.id}/restore`, { method: "POST" });
  const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true, serviceWorkers: "block" });
  const wire: Array<{ path: string; method: string; authorized: boolean; query: string }> = [];
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const version = versions[selected]!;
  const expectedPath = `/api/v1/sites/${slug}/versions/${version.id}/export`;
  let started = false;
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    wire.push({ path: url.pathname, method: request.method(), query: url.search, authorized: request.headers()["authorization"] === `Bearer ${ownerKey}` });
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (request.method() !== "GET") return route.abort("blockedbyclient");
    if (url.pathname === expectedPath) { started = true; await gate; }
    return route.continue();
  });
  try {
    await page.goto(`${origin}/login`, { waitUntil: "networkidle" });
    await page.getByLabel(/api key/i).fill(ownerKey);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL("**/dashboard");
    const response = await page.goto(`${origin}/dashboard/sites/${slug}`, { waitUntil: "networkidle" });
    expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
    const row = page.getByRole("row").filter({ hasText: new RegExp(`\\bv${version.number}\\b`) });
    await row.getByRole("button", { name: /^files$/i }).click();
    const section = page.locator("#files");
    await expect.poll(() => section.innerText()).toContain(`Files in v${version.number}`);
    const filter = section.locator('input[type="search"]');
    await filter.fill("assets");
    const existingActions = await row.getByRole("button").allTextContents();
    expect(existingActions.join(" ")).toMatch(/Restore|Files/);
    wire.length = 0;
    // Row and currently selected detail are equally valid places for this control.
    const rowAction = row.getByRole("button", { name: /download zip/i });
    const action = await rowAction.count() ? rowAction : section.getByRole("button", { name: /download zip/i });
    expect(await action.count(), "served dashboard must expose Download ZIP for a loaded version").toBe(1);
    expect(await action.isVisible()).toBe(true);
    expect(await action.isEnabled()).toBe(true);
    expect(await action.ariaSnapshot()).toMatch(/button.*Download ZIP/i);
    await action.scrollIntoViewIfNeeded();
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    await action.focus();
    expect(await action.evaluate(element => element === (globalThis as any).document.activeElement)).toBe(true);
    let downloaded = false;
    page.on("download", () => { downloaded = true; });
    const downloadPromise = page.waitForEvent("download");
    await page.keyboard.press(key);
    await expect.poll(() => started, { timeout: 3000 }).toBe(true);
    expect(downloaded, "no partial archive before the response finishes").toBe(false);
    // The page still displays the old snapshot, but the server's live pointer moves.
    await api(`/api/v1/sites/${slug}/versions/${versions[0]!.id}/restore`, { method: "POST" });
    const current = await api(`/api/v1/sites/${slug}/versions`);
    expect(current.currentVersionId).toBe(versions[0]!.id);
    release();
    const download = await downloadPromise;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe(`${slug}-v${version.number}.zip`);
    const bytes = await readFile((await download.path())!);
    const entries = unzipSync(new Uint8Array(bytes));
    expect(Object.keys(entries).sort()).toEqual(["assets/info.txt", "index.html"]);
    for (const [path, text] of Object.entries(fixtures[selected]!)) expect(digest(entries[path]!)).toBe(digest(text));
    const exports = wire.filter(request => request.path.endsWith("/export"));
    expect(exports).toEqual([{ path: expectedPath, method: "GET", authorized: true, query: "" }]);
    expect(wire.every(request => request.method === "GET")).toBe(true);
    expect(wire.some(request => request.path.startsWith("/s/") || request.path.includes("/versions/live/"))).toBe(false);
    expect(await filter.inputValue()).toBe("assets");
    expect(await section.innerText()).toContain(`Files in v${version.number}`);
    expect(await row.getByRole("button").allTextContents()).toEqual(existingActions);
    await expect.poll(() => action.isEnabled()).toBe(true);
    const leaked = await page.evaluate(credential => {
      const document = (globalThis as any).document;
      const elements = Array.from(document.querySelectorAll("*")) as Array<{ attributes: ArrayLike<{ value: string }> }>;
      return elements.some(element => Array.from(element.attributes).some(attribute => attribute.value.includes(credential) || /dwc_|dwu_|dw_preview/.test(attribute.value)));
    }, ownerKey);
    expect(leaked, "credentials never become DOM attributes or filenames").toBe(false);
    expect(errors).toEqual([]);
  } finally { release(); await context.close(); }
}, 30_000);
