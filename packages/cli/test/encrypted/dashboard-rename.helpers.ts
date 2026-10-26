/** Disposable Worker + real served dashboard; no source imports or script rewriting. */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { expect } from "vitest";
import type { Browser, BrowserContext, Locator, Page, Route } from "playwright";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const bootstrap = "dashboard-rename-disposable-bootstrap-0123456789";
let work: string;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let browser: Browser | undefined;
let ownerKey: string;
let serial = 0;
export let origin: string;

export type Site = {
  slug: string; url: string; title: string | null; description: string | null;
  settings: Record<string, unknown>; currentVersionId: string | null;
  links: Record<string, string>; [key: string]: unknown;
};
export type RenameResult = {
  renamed: boolean; oldSlug: string; slug: string; url: string;
  redirectUntil?: string | null; site: Site;
};
export type Write = { method: string; path: string; query: string; body: string | null; authenticated: boolean };
export type View = {
  context: BrowserContext; page: Page; site: Site; writes: Write[];
  violations: string[]; errors: string[]; scripts: string[];
  gate?: ReturnType<typeof deferred>;
  expectedWrites?: number;
  rename?: (route: Route, view: View) => Promise<void>;
};
const views: View[] = [];

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export async function startWorker() {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "dashboard-rename-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-dashboard-rename-test", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "dashboard-rename-test", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "dashboard-rename-test-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config, dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  origin = (await worker.url).origin;
  expect(new URL(origin).hostname, "never run acceptance against a deployed instance").toBe("127.0.0.1");
  const setup = await api("/api/v1/setup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "rename-fixture@example.test" }),
  }, bootstrap);
  ownerKey = setup.apiKey.key;
}

export async function start() {
  await startWorker();
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
}

export async function stop() {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
}

export async function api(path: string, init: RequestInit = {}, key = ownerKey): Promise<any> {
  expect(path.startsWith("/api/v1/"), "fixture calls are local API paths only").toBe(true);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  const response = await fetch(origin + path, { ...init, headers });
  const body: any = await response.json();
  // Do not include response bodies or authorization values in assertion output.
  expect(response.ok, `disposable fixture ${init.method ?? "GET"} ${path}: ${response.status}`).toBe(true);
  return (!init.method || init.method === "GET") && body.site ? body.site : body;
}

export async function fixtureSite(title?: string): Promise<Site> {
  const slug = `rename-fixture-${++serial}`;
  const data = new FormData();
  data.set("slug", slug);
  data.append("index.html", new File(["<h1>Disposable rename fixture</h1>"], "index.html", { type: "text/html" }));
  await api("/api/v1/publish", { method: "POST", body: data });
  if (title) await api(`/api/v1/sites/${slug}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
  });
  const site: Site = await api(`/api/v1/sites/${slug}`);
  expect(site.slug).toBe(slug);
  return site;
}

export async function fixtureFetch(path: string, init: RequestInit = {}) {
  const url = new URL(path, origin);
  expect(url.origin, "VM calls may only reach the disposable Worker").toBe(origin);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${ownerKey}`);
  return fetch(url, { ...init, headers });
}

export async function open(options: {
  mobile?: boolean; allowDelete?: boolean; title?: string;
  rename?: View["rename"];
} = {}): Promise<View> {
  const site = await fixtureSite(options.title);
  const slug = site.slug;
  const context = await browser!.newContext({ serviceWorkers: "block", locale: "en-US", timezoneId: "UTC",
    viewport: options.mobile ? { width: 360, height: 800 } : { width: 1100, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  const view: View = { context, page, site, writes: [], violations: [], errors: [], scripts: [], rename: options.rename };
  views.push(view);
  page.on("pageerror", error => view.errors.push(error.message));
  page.on("response", response => {
    const url = new URL(response.url());
    if (/^\/__dropway\/ui\/app-[a-f0-9]+\.js$/.test(url.pathname) && response.status() === 200) view.scripts.push(url.pathname);
  });
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      view.violations.push(`${request.method()} off-origin`);
      return route.abort("blockedbyclient");
    }
    if (!["GET", "HEAD"].includes(request.method())) {
      view.writes.push({ method: request.method(), path: url.pathname, query: url.search,
        body: request.postData(), authenticated: request.headers().authorization === `Bearer ${ownerKey}` });
      if (request.method() === "POST" && url.pathname === `/api/v1/sites/${slug}/rename`) {
        if (view.rename) return view.rename(route, view);
        return route.continue();
      }
      if (options.allowDelete && request.method() === "DELETE" && url.pathname === `/api/v1/sites/${slug}`) return route.continue();
      view.violations.push(`${request.method()} ${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    // Site reads and the actual dashboard HTML/asset are served by the Worker.
    // Only controlled success fixtures replace the returned identity's GET.
    return route.continue();
  });
  await page.goto(`${origin}/login`, { waitUntil: "networkidle" });
  await page.getByLabel(/api key/i).fill(ownerKey);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(`${origin}/dashboard`);
  const response = await page.goto(`${origin}/dashboard/sites/${slug}`, { waitUntil: "networkidle" });
  expect(response!.status()).toBe(200);
  const csp = response!.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self'");
  expect(csp.match(/script-src[^;]*/)?.[0]).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(view.scripts.length, "Chromium executed the Worker-served hashed dashboard asset").toBeGreaterThan(0);
  expect(view.writes, "opening settings must not mutate a site").toEqual([]);
  await expect.poll(() => page.getByRole("heading", { name: /settings/i }).count()).toBeGreaterThan(0);
  return view;
}

export async function closeViews() {
  for (const view of views.splice(0)) {
    view.gate?.resolve();
    try {
      expect(view.violations, "no off-origin request or mutation beyond existing rename/delete endpoints").toEqual([]);
      expect(view.errors, "real dashboard must not throw uncaught browser exceptions").toEqual([]);
      if (view.expectedWrites !== undefined) expect(view.writes, "no late duplicate mutation before teardown").toHaveLength(view.expectedWrites);
      expect(view.writes.every(write => write.authenticated), "keep the signed-in principal without logging its key").toBe(true);
    } finally { await view.context.close(); }
  }
}

export const main = (view: View) => view.page.locator("#dw-main");
export const proposed = (view: View) => view.page.getByRole("textbox", { name: /(?:new|proposed).*(?:slug|name)|(?:slug|name).*(?:new|proposed)/i });
export const renameForm = (view: View) => proposed(view).locator("xpath=ancestor::form[1]");
export const submit = (view: View) => renameForm(view).getByRole("button", { name: /rename|save|confirm/i });
export const cancel = (view: View) => renameForm(view).getByRole("button", { name: /cancel/i });
export const announcements = (view: View) => view.page.locator('[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]');

export async function ready(view: View) {
  await expect.poll(() => proposed(view).count(), { message: "settings expose one labelled proposed-name textbox" }).toBe(1);
  expect(await proposed(view).isVisible(), "rename is operable in the existing settings page").toBe(true);
  expect(await renameForm(view).count(), "rename uses a real form for native keyboard submission").toBe(1);
  expect(await submit(view).count()).toBe(1);
  expect(await cancel(view).count(), "cancel is explicit and non-destructive").toBe(1);
  expect(await main(view).innerText()).toContain(view.site.slug);
}

export async function frame(view: View) {
  await view.page.evaluate(() => new Promise<void>(resolve => {
    const raf = (globalThis as any).requestAnimationFrame;
    raf(() => raf(resolve));
  }));
}

export async function hrefs(view: View) {
  return main(view).locator('a[href]').evaluateAll(links => links.map(link => (link as any).href).sort());
}

export async function fillAndSubmit(view: View, name: string) {
  await ready(view);
  await proposed(view).fill(name);
  await submit(view).click();
}

export function writesAreRename(view: View, name: string, count = 1) {
  view.expectedWrites = count;
  expect(view.writes).toHaveLength(count);
  for (const write of view.writes) {
    expect(write.method).toBe("POST");
    expect(write.path).toBe(`/api/v1/sites/${view.site.slug}/rename`);
    expect(write.query, "no release, override, force, or privilege-changing flags").toBe("");
    expect(JSON.parse(write.body ?? "null")).toEqual({ newSlug: name });
  }
}

export async function reply(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export function result(view: View, options: { slug?: string; url?: string; redirectUntil?: string | null; renamed?: boolean } = {}): RenameResult {
  const slug = options.slug ?? "server-canonical-name";
  const url = options.url ?? `${origin}/s/${slug}/`;
  const self = `${origin}/api/v1/sites/${slug}`;
  return { renamed: options.renamed ?? true, oldSlug: view.site.slug, slug, url,
    redirectUntil: options.redirectUntil === undefined ? "2041-02-03T04:05:06.000Z" : options.redirectUntil,
    site: { ...view.site, slug, url, links: { ...view.site.links, self, deploys: `${self}/deploys`, versions: `${self}/versions`, files: `${self}/files` } },
  };
}

export async function serveIdentity(view: View, response: RenameResult) {
  const read = (body: unknown) => (route: Route) => route.request().method() === "GET" ? reply(route, body) : route.fallback();
  await view.context.route(`${origin}/api/v1/sites/${response.slug}`, read({ site: response.site }));
  await view.context.route(`${origin}/api/v1/sites/${response.slug}/deploys*`, read({ deploys: [], nextCursor: null }));
  await view.context.route(`${origin}/api/v1/sites/${response.slug}/versions*`, read({ versions: [], nextCursor: null, currentVersionId: response.site.currentVersionId }));
}

export async function navigateReturned(view: View, slug: string) {
  const target = `${origin}/dashboard/sites/${encodeURIComponent(slug)}`;
  if (view.page.url() !== target) {
    const manage = main(view).locator(`a[href="/dashboard/sites/${encodeURIComponent(slug)}"], a[href="${target}"]`);
    await expect.poll(() => manage.count(), { message: "management uses the response slug, not the proposed or old slug" }).toBeGreaterThan(0);
    await manage.first().click();
  }
  await view.page.waitForURL(target);
}

export async function visibleText(locator: Locator) {
  return (await locator.allInnerTexts()).join("\n");
}
