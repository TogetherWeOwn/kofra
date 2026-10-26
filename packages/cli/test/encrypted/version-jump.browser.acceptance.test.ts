/** Protected dashboard acceptance, colocated with the existing isolated
 * Playwright dependency/harness (not an encrypted-publishing feature).
 * Only a disposable loopback Worker is started. Never use a remote config.
 * Run: npx vitest run -c packages/cli/vitest.config.ts test/encrypted/version-jump.browser.acceptance.test.ts
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "playwright";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const slug = "version-jump-fixture";
const base = `/api/v1/sites/${slug}`;
const bootstrap = "version-jump-disposable-bootstrap-0123456789";
let work: string;
let origin: string;
let ownerKey: string;
let browser: Browser;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
const versions: Array<{ id: string; number: number }> = [];
async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("Expected loopback port");
  await new Promise<void>((resolve, reject) => socket.close(e => e ? reject(e) : resolve()));
  return address.port;
}
async function api(path: string, init: RequestInit = {}, key = ownerKey) {
  const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${key}`);
  const response = await fetch(origin + path, { ...init, headers });
  const body: any = await response.json();
  expect(response.ok, `disposable API ${path}: ${response.status} ${JSON.stringify(body)}`).toBe(true);
  return body;
}
async function publish(text: string) {
  const body = new FormData(); body.set("slug", slug); body.append("note.txt", new File([text], "note.txt"));
  const result = await api("/api/v1/publish", { method: "POST", body });
  return result.version as { id: string; number: number };
}
beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "version-jump-"));
  origin = `http://127.0.0.1:${await freePort()}`;
  const config = join(work, "wrangler.json"); const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-version-jump-test", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: origin, SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "version-jump", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "version-jump-files" }], kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({ config,
    dev: { server: { hostname: "127.0.0.1", port: Number(new URL(origin).port) }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  const setup = await api("/api/v1/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "version-fixture@example.com" }) }, bootstrap);
  ownerKey = setup.apiKey.key;
  for (let n = 1; n <= 105; n++) versions.push(await publish(`release ${n}\n`));
  const list = await api(`${base}/versions?limit=100`);
  expect(list.versions).toHaveLength(100);
  expect(list.versions.some((v: { id: string }) => v.id === versions[0]!.id)).toBe(false);
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);
afterAll(async () => {
  await browser?.close(); await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});
async function visit(mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 360, height: 800 } : { width: 1100, height: 900 }, acceptDownloads: true });
  await context.addInitScript(key => sessionStorage.setItem("dropway.key", key), ownerKey);
  const calls: string[] = [];
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (url.pathname.startsWith("/api/")) calls.push(route.request().url());
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(2200);
  await page.goto(`${origin}/dashboard/sites/${slug}`, { waitUntil: "networkidle" });
  await page.locator("#files tbody tr").waitFor();
  return { context, page, calls };
}
function input(page: Page) { return page.getByRole("textbox", { name: /version/i }).filter({ visible: true }); }
function open(page: Page) { return page.getByRole("button", { name: /^(open|go)(\s+version)?$/i }); }
async function selected(page: Page, number: number) {
  // Exact version boundary: "Files in v1" is a substring of "Files in v105",
  // so a plain toContain would pass while still showing v105. \b after the
  // number only matches when no further digit follows.
  await expect.poll(() => page.locator("#files").innerText()).toMatch(new RegExp(`Files in v${number}\\b`));
}
async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    const frame = (globalThis as any).requestAnimationFrame;
    frame(() => frame(() => resolve()));
  }));
}
it.each([false, true])("Enter opens a version outside the 100-row window, with usable focus/layout (mobile=%s)", async mobile => {
  const view = await visit(mobile);
  try {
    expect(await input(view.page).count(), "labelled version-reference input").toBe(1);
    await input(view.page).fill("v1"); await frames(view.page);
    expect(view.calls.filter(u => new URL(u).pathname.startsWith(`${base}/versions/`))).toEqual([]);
    await input(view.page).press("Enter"); await selected(view.page, 1);
    // page.url() is Node-side CDP-cached frame state; poll so the
    // navigatedWithinDocument event can land before asserting.
    await expect.poll(() => new URL(view.page.url()).searchParams.get("version")).toBe(versions[0]!.id);
    expect(view.calls.filter(u => new URL(u).pathname.startsWith(`${base}/versions/`)).map(u => new URL(u).pathname)).toEqual([`${base}/versions/v1`]);
    expect(view.calls.filter(u => new URL(u).pathname === `${base}/files`).map(u => new URL(u).searchParams.get("version"))).toEqual([versions[104]!.id, versions[0]!.id]);
    expect(await view.page.getByRole("button", { name: /^restore$/i }).count()).toBe(99);
    // Existing history controls carry aria-label="Delete version N" (visible
    // text stays "Delete"); match that accessible naming, not /^delete$/i.
    expect(await view.page.getByRole("button", { name: /^delete version \d+$/i }).count()).toBe(99);
    expect(await view.page.evaluate(() => {
      const doc = (globalThis as any).document;
      return !!doc.activeElement && doc.activeElement !== doc.body && doc.activeElement.isConnected;
    })).toBe(true);
    for (const locator of [input(view.page), open(view.page)]) {
      const box = await locator.boundingBox(); expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.width).toBeGreaterThan(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(mobile ? 361 : 1101);
    }
    await view.page.reload({ waitUntil: "networkidle" }); await selected(view.page, 1);
  } finally { await view.context.close(); }
});
it("invalid and missing references announce recovery without replacing the last valid selection", async () => {
  const view = await visit(true);
  try {
    expect(await input(view.page).count(), "labelled version-reference input").toBe(1);
    await input(view.page).fill("v1"); await open(view.page).click(); await selected(view.page, 1);
    // The open-v1 flow's route events can lag the DOM poll; settle them before
    // capturing the baseline so the invalid submit below is measured alone.
    await expect.poll(() => view.calls.some(u => new URL(u).pathname === `${base}/versions/v1`)).toBe(true);
    await expect.poll(() => view.calls.some(u => {
      const req = new URL(u);
      return req.pathname === `${base}/files` && req.searchParams.get("version") === versions[0]!.id;
    })).toBe(true);
    // page.url() is Node-side CDP-cached frame state; settle it before
    // capturing the baseline URL the invalid submit must preserve.
    await expect.poll(() => new URL(view.page.url()).searchParams.get("version")).toBe(versions[0]!.id);
    const url = view.page.url(); const count = view.calls.length;
    await input(view.page).fill(".."); await input(view.page).press("Enter"); await frames(view.page);
    expect(view.calls).toHaveLength(count);
    expect(await input(view.page).evaluate(el => (globalThis as any).document.activeElement === el)).toBe(true);
    const announcements = view.page.locator('[role="alert"], [aria-live="polite"], [aria-live="assertive"]');
    await expect.poll(async () => (await announcements.allTextContents()).join(" ")).toMatch(/reference|valid|version/i);
    await input(view.page).fill("ver_absent"); await open(view.page).click();
    await expect.poll(async () => (await announcements.allTextContents()).join(" ")).toMatch(/check|try|choose|not found/i);
    await selected(view.page, 1); expect(view.page.url()).toBe(url);
  } finally { await view.context.close(); }
});
it("an inspected live-row download stays on its immutable bytes after a new publish", async () => {
  const view = await visit();
  try {
    await selected(view.page, 105);
    await publish("release 106\n");
    const attachment = view.page.waitForEvent("download");
    await view.page.locator("#files").getByRole("button", { name: /^download$/i }).click();
    const downloaded = await attachment;
    expect(downloaded.suggestedFilename()).toBe("note.txt");
    const path = await downloaded.path(); expect(path).not.toBeNull();
    const requests = view.calls.filter(u => new URL(u).pathname === `${base}/files/note.txt`);
    expect(requests).toHaveLength(1);
    expect.soft(new URL(requests[0]!).searchParams.get("version")).toBe(versions[104]!.id);
    expect.soft(await readFile(path!, "utf8")).toBe("release 105\n");
  } finally { await view.context.close(); }
});
