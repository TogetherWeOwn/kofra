import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { expect } from "vitest";

/** Test-only disposable Worker/browser driver. No publisher implementation is copied. */
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const bootstrap = "publish-target-disposable-bootstrap-0123456789";
export const older = "older-intended-destination";
export const alternate = "older-second-destination";
export const listed = "recent-site-200";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve, delivered: false };
}
type Gate = ReturnType<typeof deferred>;
export type Wire = { method: string; path: string; query: string; body: any; authenticated: boolean };
export type Fixture = {
  context: any; page: any; wire: Wire[]; errors: string[]; violations: string[];
  gates: Gate[]; listGate?: Gate; lookups: Map<string, Gate>; failures: Map<string, number>; results: Map<string, unknown>;
};

export class TargetWorld {
  origin = "";
  key = "";
  restrictedKey = "";
  browser: any;
  work = "";
  worker?: Awaited<ReturnType<typeof unstable_startWorker>>;
  fixtures: Fixture[] = [];

  async request(path: string, init: RequestInit = {}, key = this.key) {
    const response = await fetch(this.origin + "/api/v1" + path, {
      ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...init.headers },
    });
    const body = await response.json() as any;
    expect(response.ok, `disposable fixture ${init.method ?? "GET"} ${path}: HTTP ${response.status}`).toBe(true);
    return body;
  }

  async start() {
    this.work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "publish-target-"));
    const config = join(this.work, "wrangler.json");
    const persist = join(this.work, "state");
    await writeFile(config, JSON.stringify({
      name: "dropway-publish-target-test", main: join(root, "apps/worker/src/index.ts"),
      compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
      vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "true" },
      d1_databases: [{ binding: "DB", database_name: "publish-target-test", migrations_dir: join(root, "packages/core/migrations") }],
      r2_buckets: [{ binding: "FILES", bucket_name: "publish-target-test-files" }],
      kv_namespaces: [{ binding: "CACHE" }],
    }));
    await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"),
      "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
      cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    });
    this.worker = await unstable_startWorker({
      config, dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
      bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
    });
    await this.worker.ready;
    this.origin = (await this.worker.url).origin;
    const setup = await this.request("/setup", { method: "POST", body: JSON.stringify({ email: "publisher@example.test" }) }, bootstrap);
    this.key = setup.apiKey.key;
    await this.request("/sites", { method: "POST", body: JSON.stringify({ slug: "deleted-destination" }) });
    await this.request("/sites/deleted-destination", { method: "DELETE" });
    // Real API fixtures: two older destinations, followed by 201 newer sites.
    // One-at-a-time creation avoids relying on random ids to break timestamp ties.
    for (const slug of [older, alternate, ...Array.from({ length: 201 }, (_, i) => `recent-site-${String(i).padStart(3, "0")}`)]) {
      await this.request("/sites", { method: "POST", body: JSON.stringify({ slug }) });
    }
    const first = await this.request("/sites?limit=200");
    expect(first.sites).toHaveLength(200);
    expect(first.nextCursor).toBeTruthy();
    expect(first.sites.some((site: any) => site.slug === older || site.slug === alternate)).toBe(false);
    const restricted = await this.request("/keys", { method: "POST", body: JSON.stringify({
      name: "publish-target-site-only", scopes: ["sites:read", "sites:write"], site: listed,
    }) });
    this.restrictedKey = restricted.key;
    const refused = await fetch(this.origin + `/api/v1/sites/${older}`, { headers: { Authorization: `Bearer ${this.restrictedKey}` } });
    expect(refused.status, "site-restricted fixture must genuinely refuse the older destination").toBe(404);
    const { chromium } = require("playwright");
    this.browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    });
  }

  async open(options: { target?: string; listGate?: Gate; lookups?: Map<string, Gate>; key?: string; anonymous?: boolean; noScript?: boolean; narrow?: boolean } = {}) {
    const context = await this.browser.newContext({
      serviceWorkers: "block", javaScriptEnabled: !options.noScript,
      viewport: options.narrow ? { width: 360, height: 780 } : { width: 1100, height: 820 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(2500);
    const key = options.key ?? this.key;
    const f: Fixture = { context, page, wire: [], errors: [], violations: [], gates: [],
      listGate: options.listGate, lookups: options.lookups ?? new Map(), failures: new Map(), results: new Map() };
    if (f.listGate) f.gates.push(f.listGate);
    f.gates.push(...f.lookups.values());
    this.fixtures.push(f);
    page.on("pageerror", (error: Error) => f.errors.push(error.message));
    page.on("console", (message: any) => {
      if (/content security policy|refused to execute/i.test(message.text())) f.errors.push(message.text());
    });
    await context.route("**/*", async (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (url.origin !== this.origin) {
        f.violations.push("off-origin request");
        return route.abort("blockedbyclient");
      }
      if (url.pathname.startsWith("/api/")) {
        let body: any = request.postData();
        try { body = body ? JSON.parse(body) : null; } catch { /* ZIP and blobs are raw bytes. */ }
        f.wire.push({ method, path: url.pathname, query: url.search, body,
          authenticated: request.headers().authorization === `Bearer ${key}` });
        const list = method === "GET" && url.pathname === "/api/v1/sites";
        const single = method === "GET" && /^\/api\/v1\/sites\/[^/]+$/.test(url.pathname);
        if (list) {
          expect([...url.searchParams.keys()].sort(), "no search endpoint or page sweep").toEqual(["limit"]);
          expect(Number(url.searchParams.get("limit"))).toBeGreaterThan(0);
          expect(Number(url.searchParams.get("limit"))).toBeLessThanOrEqual(200);
        }
        if ((single || list) && f.results.has(url.pathname)) {
          return route.fulfill({ contentType: "application/json", body: JSON.stringify(f.results.get(url.pathname)) });
        }
        if (single && f.failures.has(url.pathname)) {
          const status = f.failures.get(url.pathname)!;
          const gate = f.lookups.get(url.pathname);
          await gate?.promise;
          try {
            return await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: {
              code: status === 404 ? "not_found" : "temporarily_unavailable",
              message: "The requested destination is unavailable.", hint: "Check the slug and try again.",
            } }) });
          } catch { return; /* A cancelled stale lookup is valid. */ }
          finally { if (gate) gate.delivered = true; }
        }
        const gate = list ? f.listGate : single ? f.lookups.get(url.pathname) : undefined;
        if (gate) {
          try {
            const response = await route.fetch({ maxRedirects: 0 });
            await gate.promise;
            return await route.fulfill({ response });
          } catch { return; /* A cancelled stale lookup is valid. */ }
          finally { gate.delivered = true; }
        }
      } else if (method !== "GET" || (!['/login', '/dashboard/publish', '/', '/favicon.ico'].includes(url.pathname)
        && !/^\/__dropway\/ui\/app-[a-f0-9]{8}\.js$/.test(url.pathname))) {
        f.violations.push(`unexpected ${method} ${url.pathname}`);
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    const path = options.anonymous ? "/" : "/dashboard/publish";
    const destination = path + (options.target !== undefined ? "?site=" + encodeURIComponent(options.target) : "");
    if (!options.anonymous && !options.noScript) {
      await page.goto(`${this.origin}/login?next=${encodeURIComponent(destination)}`);
      await page.locator('#dw-signin input[name="key"]').fill(key);
      await page.locator('#dw-signin button[type="submit"]').click();
      await page.waitForURL(this.origin + destination);
    } else {
      await page.goto(this.origin + destination);
    }
    await page.waitForLoadState("load");
    if (!options.noScript) await expect.poll(() => page.locator('#dw-publish button, #dw-quick button').count()).toBeGreaterThan(0);
    return f;
  }

  async closeFixtures() {
    for (const f of this.fixtures.splice(0)) {
      for (const gate of f.gates) gate.resolve();
      try {
        expect(f.violations, "no production/external requests or unexpected shell endpoints").toEqual([]);
        expect(f.errors, "no script exceptions or CSP violations").toEqual([]);
        expect(listReads(f).length, "initial page and at most one refresh; never sweep cursors").toBeLessThanOrEqual(2);
      } finally { await f.context.close(); }
    }
  }

  async stop() {
    await this.browser?.close();
    await this.worker?.dispose();
    if (this.work) await rm(this.work, { recursive: true, force: true });
  }
}

export const selector = (f: Fixture) => f.page.locator("#dw-pub-site");
export const publishButton = (f: Fixture) => f.page.getByRole("button", { name: "Publish", exact: true });
// Hashing, manifest, uploads and finalize share this bounded protocol deadline,
// not the 2.5-second locator/action timeout used by the rest of the driver.
export const publishProtocolTimeout = 15_000;
export async function publishAndWaitForFinalize(f: Fixture, slug?: string) {
  const [response] = await Promise.all([
    f.page.waitForResponse((r: any) => {
      const path = new URL(r.url()).pathname;
      return r.request().method() === "POST" && /^\/api\/v1\/sites\/[^/]+\/deploys\/[^/]+\/finalize$/.test(path)
        && (slug === undefined || path.startsWith(`/api/v1/sites/${slug}/deploys/`));
    }, { timeout: publishProtocolTimeout }),
    publishButton(f).click(),
  ]);
  return response;
}
export const listReads = (f: Fixture) => f.wire.filter(r => r.method === "GET" && r.path === "/api/v1/sites");
export const singleReads = (f: Fixture) => f.wire.filter(r => r.method === "GET" && /^\/api\/v1\/sites\/[^/]+$/.test(r.path));
export const writes = (f: Fixture) => f.wire.filter(r => r.method !== "GET");
export async function settle(f: Fixture) {
  await f.page.evaluate(() => new Promise<void>(resolve => (globalThis as any).requestAnimationFrame(() => (globalThis as any).requestAnimationFrame(resolve))));
}
export async function chooseFiles(f: Fixture) {
  await f.page.locator('#dw-publish input[type="file"]:not([webkitdirectory]), #dw-quick input[type="file"]:not([webkitdirectory])').setInputFiles([
    { name: "index.html", mimeType: "text/html", buffer: Buffer.from("<h1>Disposable update destination</h1>\n") },
    { name: "readme.txt", mimeType: "text/plain", buffer: Buffer.from("intended destination only\n") },
  ]);
}
export async function updateMode(f: Fixture) {
  await f.page.locator('#dw-publish input[type="radio"][value="update"]').check();
}
export async function lookupInput(f: Fixture) {
  const input = f.page.getByRole("textbox", { name: /slug|site|destination/i })
    .and(f.page.locator('#dw-publish input:not(#dw-pub-slug):visible'));
  expect(await input.count(), "update panel offers one labelled explicit-slug lookup").toBe(1);
  return input;
}
export async function lookup(f: Fixture, reference: string, via: "Enter" | "button" = "Enter") {
  const input = await lookupInput(f);
  await input.fill(reference);
  if (via === "Enter") await input.press("Enter");
  else {
    const button = f.page.getByRole("button", { name: /look\s*up|find|resolve|load site/i });
    expect(await button.count(), "lookup has a discoverable keyboard-operable submit button").toBe(1);
    await button.click();
  }
}
export async function resolved(f: Fixture, slug: string) {
  await expect.poll(() => selector(f).inputValue(), { message: "verified destination is selected, not a neighbouring first-page site" }).toBe(slug);
  expect(await selector(f).locator(`option[value="${slug}"]`).count()).toBe(1);
}
export async function failedClosed(f: Fixture) {
  await expect.poll(() => publishButton(f).isDisabled(), { message: "unresolved explicit update must disable Publish even with files selected" }).toBe(true);
  const feedback = f.page.locator('#dw-publish [role="alert"]');
  await expect.poll(() => feedback.innerText()).toMatch(/not found|unavailable|could not|couldn't|failed|unable|refused|error|forbidden/i);
  expect(await feedback.innerText(), "usable recovery instruction").toMatch(/retry|try again|slug|check|choose|look\s*up/i);
  expect(await f.page.locator('#dw-publish input[type="radio"][value="update"]').isChecked()).toBe(true);
  await publishButton(f).evaluate((button: any) => button.click());
  await settle(f);
  expect(writes(f), "a disabled unresolved update must not create or mutate another site").toEqual([]);
}
