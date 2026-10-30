/**
 * Independent browser acceptance for the API-key Sites dashboard.
 *
 * Prerequisites and runner (the existing test-only Chromium harness):
 *   npm ci --include=dev
 *   npm ci --prefix packages/cli/test/encrypted --include=dev
 *   packages/cli/test/encrypted/node_modules/.bin/playwright install --with-deps chromium
 *   npm run test:cli -- test/encrypted/dashboard-sites-paging.acceptance.test.ts
 * Optional: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH selects installed Chromium.
 *
 * Only the list response is controlled. The shell, CSP, script, sign-in and
 * read-only principal are real, from a disposable loopback Worker. No production
 * calls, session activation, source transforms or product implementation mocks.
 * No writes are allowed in the browser; local setup/key creation precede paging.
 * The current HTTP response has no separate `id`: `slug` is its stable site
 * identity. Do not invent an API field or dedupe by title, URL or row position.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const cursorA = "2026-10-22T12:00:00.000Z|site+one/=&% snow";
const cursorB = "2026-10-21T12:00:00.000Z|site?two+#雪";
const bootstrap = "sites-paging-local-fixture-bootstrap-0123456789";
let work: string;
let origin: string;
let readerKey: string;
let browser: any;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
const fixtures: Fixture[] = [];

type Site = ReturnType<typeof site>;
type List = { sites: Site[]; nextCursor: string | null };
type Step = { body: List | { error: { code: string; message: string; hint: string } }; status?: number; gate?: ReturnType<typeof deferred> };
type Wire = { method: string; path: string; cursor: string | null; limit: string | null; query: string[]; authorization: string | undefined; body: string | null };
type Fixture = { context: any; page: any; wire: Wire[]; violations: string[]; errors: string[]; steps: Step[] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function site(slug: string, title: string | null) {
  const self = `${origin}/api/v1/sites/${slug}`;
  return {
    slug, title, url: `${origin}/s/${slug}/`, description: null,
    anonymous: false, expiresAt: null,
    settings: { spa: false, renderMarkdown: true, crossOriginIsolation: false, passwordProtected: false },
    currentVersionId: null, currentVersion: null,
    createdAt: "2026-10-22T12:00:00.000Z", updatedAt: "2026-10-22T12:00:00.000Z",
    links: { self, deploys: `${self}/deploys`, versions: `${self}/versions`, files: `${self}/files` },
  };
}

const pageOf = (sites: Site[], nextCursor: string | null): Step => ({ body: { sites, nextCursor } });
const unavailable = (): Step => ({ status: 503, body: { error: {
  code: "temporarily_unavailable", message: "This page could not be loaded.", hint: "Retry this page.",
} } });

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "sites-paging-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-sites-paging-test", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "sites-paging-test", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "sites-paging-test-files" }],
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
  const setup = await fetch(`${origin}/api/v1/setup`, {
    method: "POST", headers: { Authorization: `Bearer ${bootstrap}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "sites-paging@example.test" }),
  });
  expect(setup.status).toBe(201);
  const owner = await setup.json() as { apiKey: { key: string } };
  const key = await fetch(`${origin}/api/v1/keys`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.apiKey.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "sites-paging-reader", scopes: ["sites:read"] }),
  });
  expect(key.status).toBe(201);
  readerKey = (await key.json() as { key: string }).key;
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
}, 120_000);

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const step of f.steps) step.gate?.resolve();
    try {
      expect(f.violations, "no off-origin calls, unexpected endpoints, writes, or unbounded pages").toEqual([]);
      expect(f.errors, "real dashboard must not throw browser exceptions").toEqual([]);
      assertWire(f);
    } finally { await f.context.close(); }
  }
});

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function open(steps: Step[], controlledClock = false) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  if (controlledClock) await page.clock.install();
  page.setDefaultTimeout(2500);
  const wire: Wire[] = [];
  const violations: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await context.route("**/*", async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") {
      violations.push(`${request.method()} ${url.origin === origin ? url.pathname : "off-origin"}`);
      return route.abort("blockedbyclient");
    }
    if (url.pathname === "/api/v1/sites") {
      const index = wire.length;
      wire.push({ method: request.method(), path: url.pathname, cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit"), query: [...url.searchParams.keys()].sort(),
        authorization: request.headers().authorization, body: request.postData(),
      });
      const step = steps[index];
      if (!step) {
        violations.push("unexpected extra list request");
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify(unavailable().body) });
      }
      await step.gate?.promise;
      return route.fulfill({ status: step.status ?? 200, contentType: "application/json", body: JSON.stringify(step.body) });
    }
    if (!["/login", "/dashboard", "/api/v1/me", "/favicon.ico"].includes(url.pathname)
      && !/^\/__dropway\/ui\/app-[a-f0-9]{8}\.js$/.test(url.pathname)
      && !/^\/__dropway\/ui\/kofra-[a-f0-9]{8}\.css$/.test(url.pathname)
      && !/^\/__dropway\/fonts\/[a-z0-9.-]+\.woff2$/.test(url.pathname)
      && !/^\/__dropway\/ui\/art\/[a-z0-9.-]+\.svg$/.test(url.pathname)) {
      violations.push(`unexpected GET ${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  const fixture = { context, page, wire, violations, errors, steps };
  fixtures.push(fixture);
  await page.goto(`${origin}/login?next=/dashboard`);
  await page.locator('#dw-signin input[name="key"]').fill(readerKey);
  const dashboardResponse = page.waitForResponse((response: any) => response.url() === `${origin}/dashboard`);
  await page.locator('#dw-signin button[type="submit"]').click();
  const response = await dashboardResponse;
  expect(response.status()).toBe(200);
  const csp = response.headers()["content-security-policy"];
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp.match(/script-src[^;]*/)?.[0]).not.toMatch(/unsafe-inline|unsafe-eval/);
  await page.waitForURL(`${origin}/dashboard`);
  await expect.poll(() => wire.length).toBe(1);
  return fixture;
}

function assertWire(f: Fixture) {
  for (const request of f.wire) {
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/api/v1/sites");
    expect(request.authorization === `Bearer ${readerKey}`, "keep the original sites:read principal; never log the credential").toBe(true);
    expect(request.body).toBeNull();
    expect(request.query.every(key => ["cursor", "limit"].includes(key)), "filtering is local, not a new search API").toBe(true);
    const limit = Number(request.limit ?? 50);
    expect(Number.isInteger(limit) && limit >= 1 && limit <= 200, "one bounded server page per activation").toBe(true);
  }
  expect(f.wire[0]?.cursor).toBeNull();
  expect(f.wire.every(request => request.limit === f.wire[0]?.limit), "keep the selected page size").toBe(true);
}

const search = (f: Fixture) => f.page.locator('#dw-sites input:not([type="hidden"])').first();
const rows = (f: Fixture) => f.page.locator('#dw-sites a[href^="/dashboard/sites/"]');
const visibleRows = (f: Fixture) => f.page.locator('#dw-sites a[href^="/dashboard/sites/"]:visible');
const more = (f: Fixture) => f.page.getByRole("button", { name: /load more/i });
async function slugs(f: Fixture, visible = true): Promise<string[]> {
  return (visible ? visibleRows(f) : rows(f)).evaluateAll((links: any[]) => links.map(link => new URL(link.href).pathname.split("/").pop()));
}
async function settled(f: Fixture) {
  // Flush rendering/task turns, not a network-idle wait that deferred pages block.
  await f.page.evaluate(() => new Promise<void>(resolve => (globalThis as any).requestAnimationFrame(() => (globalThis as any).requestAnimationFrame(resolve))));
}
async function loaded(f: Fixture, expected: string[]) {
  await expect.poll(() => slugs(f)).toEqual(expected);
}
async function terminal(f: Fixture) {
  expect(await more(f).isVisible().catch(() => false) && await more(f).isEnabled().catch(() => false), "no usable Load more after the final or already-consumed cursor").toBe(false);
}
async function counts(f: Fixture, expected: string) {
  // Break: swapping matched/loaded quantities, counting hidden rows as matches,
  // or claiming a complete total while a next page is still available.
  await expect.poll(() => f.page.locator("#dw-sites-count").innerText()).toBe(expected);
}
async function feedback(f: Fixture) {
  const text = await f.page.locator("#dw-main").innerText();
  expect(text, "actionable inline page failure, not just a toast").toMatch(/could not|couldn't|failed|unable|error|unavailable/i);
  expect(text, "tell the person how to retry this bounded page").toMatch(/retry|try again|load more/i);
}

// Break: append bypasses the current predicate, or filtering becomes a remote query.
describe("Sites dashboard: filtering a bounded loaded subset", () => {
  it("keeps one case-insensitive slug/title predicate across three explicitly loaded pages", async () => {
    const f = await open([
      pageOf([site("needle-path", "Other"), site("orchard", "Trees")], cursorA),
      pageOf([site("page-two", "NEEDLE title"), site("stone", null)], cursorB),
      pageOf([site("needle-last", null), site("cloud", "Cloud")], null),
    ]);
    await loaded(f, ["needle-path", "orchard"]);
    await counts(f, "2 sites+.");
    await search(f).fill("needle");
    await loaded(f, ["needle-path"]);
    await counts(f, "1 match of 2 loaded sites+.");
    await more(f).click();
    await loaded(f, ["needle-path", "page-two"]);
    await counts(f, "2 matches of 4 loaded sites+.");
    expect(f.wire.map(request => request.cursor)).toEqual([null, cursorA]);
    await more(f).click();
    await loaded(f, ["needle-path", "page-two", "needle-last"]);
    expect(f.wire.map(request => request.cursor)).toEqual([null, cursorA, cursorB]);
    await counts(f, "3 matches of 6 loaded sites.");
    await terminal(f);
    await search(f).fill("");
    await loaded(f, ["needle-path", "orchard", "page-two", "stone", "needle-last", "cloud"]);
    await counts(f, "6 sites.");
    expect(f.wire).toHaveLength(3);
  });

  // Break: an in-flight closure applies the query captured at activation time.
  it("applies the latest query when a deferred page arrives without stealing input focus", async () => {
    const gate = deferred();
    const f = await open([
      pageOf([site("needle-start", "Needle"), site("orchard-start", "Orchard")], cursorA),
      { ...pageOf([site("needle-late", "Needle"), site("late", "Orchard title")], cursorB), gate },
    ]);
    await loaded(f, ["needle-start", "orchard-start"]);
    await search(f).fill("needle");
    await more(f).click();
    await expect.poll(() => f.wire.length).toBe(2);
    await search(f).fill("orchard");
    await loaded(f, ["orchard-start"]);
    gate.resolve();
    await loaded(f, ["orchard-start", "late"]);
    expect(await search(f).inputValue()).toBe("orchard");
    expect(await search(f).evaluate((el: any) => el === el.ownerDocument.activeElement)).toBe(true);
    await counts(f, "2 matches of 4 loaded sites+.");
    expect(f.wire.map(request => request.cursor)).toEqual([null, cursorA]);
  });

  it("labels the control as filtering loaded sites, not global/backend search", async () => {
    const f = await open([pageOf([site("first", "First")], cursorA)]);
    await loaded(f, ["first"]);
    const input = search(f);
    const label = await input.evaluate((el: any) => [
      el.getAttribute("aria-label"), el.placeholder,
      ...Array.from(el.labels ?? [], (label: any) => label.textContent),
      ...String(el.getAttribute("aria-describedby") ?? "").split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent),
    ].filter(Boolean).join(" "));
    expect(label).toMatch(/filter|search/i);
    expect(label).toMatch(/loaded/i);
    expect(label).not.toMatch(/all sites|global|server search/i);
  });

  it("distinguishes zero local matches from zero loaded sites and still offers the next page", async () => {
    const f = await open([
      pageOf([site("first", "First")], cursorA),
      pageOf([], null),
    ]);
    await loaded(f, ["first"]);
    await counts(f, "1 site+.");
    await search(f).fill("not-loaded-yet");
    await loaded(f, []);
    await counts(f, "0 matches of 1 loaded site+.");
    await settled(f);
    expect(f.wire).toHaveLength(1);
    expect(await more(f).isEnabled(), "a local zero-match result must still allow the next bounded page").toBe(true);
    await more(f).click();
    await counts(f, "0 matches of 1 loaded site.");
    await loaded(f, []);
    await terminal(f);
    await search(f).fill("");
    await loaded(f, ["first"]);
    await counts(f, "1 site.");
    await search(f).fill("FIRST");
    await loaded(f, ["first"]);
    await counts(f, "1 match of 1 loaded site.");
    expect(f.wire.map(request => request.cursor)).toEqual([null, cursorA]);
  });
});

describe("Sites dashboard: cursor and stable-identity integrity", () => {
  // Break: no shared synchronous in-flight guard (native disabled alone is insufficient).
  it("guards rapid duplicate activation for the same cursor and exposes truthful loading", async () => {
    const gate = deferred();
    const f = await open([
      pageOf([site("first", "First")], cursorA),
      { ...pageOf([site("second", "Second")], cursorB), gate },
      pageOf([site("unexpected", "Must not be fetched")], null),
    ]);
    await loaded(f, ["first"]);
    // dispatchEvent intentionally bypasses native button suppression to exercise
    // the handler guard, as well as the native disabled/loading affordance.
    await more(f).evaluate((button: any) => {
      button.dispatchEvent(new (globalThis as any).MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new (globalThis as any).MouseEvent("click", { bubbles: true }));
    });
    await expect.poll(() => f.wire.length).toBeGreaterThanOrEqual(2);
    await settled(f);
    expect.soft(f.wire.map(request => request.cursor), "at most one request for the pending cursor").toEqual([null, cursorA]);
    const button = f.page.locator("#dw-sites button").filter({ hasText: /load|loading/i }).first();
    expect.soft(await button.isDisabled(), "disable while the request is pending").toBe(true);
    const state = `${await button.innerText()} ${await button.getAttribute("aria-busy")} ${await f.page.locator("#dw-sites").innerText()}`;
    expect.soft(state, "announce loading, not a misleading idle control").toMatch(/loading|true/i);
    gate.resolve();
    await loaded(f, ["first", "second"]);
    await expect.poll(() => more(f).isEnabled()).toBe(true);
    expect(f.wire).toHaveLength(2);
  });

  // Break: appending raw rows, deduping by title/URL, sorting locally, or counting duplicates.
  it("deduplicates overlapping pages by response identity and keeps first-seen server order", async () => {
    const f = await open([
      pageOf([site("zebra", "Same title"), site("alpha", "Alpha")], cursorA),
      pageOf([site("alpha", "Alpha"), site("middle", "Same title"), site("middle", "Same title")], cursorB),
      pageOf([site("zebra", "Same title"), site("last", "Last")], null),
    ]);
    await loaded(f, ["zebra", "alpha"]);
    await more(f).click();
    await expect.poll(() => f.wire.length).toBe(2);
    await settled(f);
    expect.soft(await slugs(f, false)).toEqual(["zebra", "alpha", "middle"]);
    await more(f).click();
    await expect.poll(() => f.wire.length).toBe(3);
    await settled(f);
    expect(await slugs(f, false)).toEqual(["zebra", "alpha", "middle", "last"]);
    await counts(f, "4 sites.");
    await terminal(f);
  });

  // Break: a successful cursor is offered twice (including non-adjacent cycles).
  it.each(["repeat", "cycle"])("does not consume a successful cursor twice: %s", async kind => {
    const f = await open([
      pageOf([site("first", "First")], cursorA),
      pageOf([site("second", "Second")], kind === "repeat" ? cursorA : cursorB),
      pageOf([site("third", "Third")], cursorA),
    ]);
    await loaded(f, ["first"]);
    await more(f).click();
    await loaded(f, ["first", "second"]);
    if (kind === "cycle") {
      await more(f).click();
      await loaded(f, ["first", "second", "third"]);
    }
    await terminal(f);
    await settled(f);
    expect(f.wire.map(request => request.cursor)).toEqual(kind === "repeat" ? [null, cursorA] : [null, cursorA, cursorB]);
  });

  it("ends on a null cursor without prefetching and leaves all original site links intact", async () => {
    const f = await open([
      pageOf([site("zebra", "Zebra")], cursorA),
      pageOf([site("alpha", "Alpha")], null),
    ]);
    await loaded(f, ["zebra"]);
    await settled(f);
    expect(f.wire).toHaveLength(1);
    await more(f).click();
    await loaded(f, ["zebra", "alpha"]);
    await terminal(f);
    await counts(f, "2 sites.");
    for (const slug of ["zebra", "alpha"]) {
      expect(await f.page.locator(`#dw-sites a[href="/dashboard/sites/${slug}"]`).count()).toBe(1);
      expect(await f.page.locator(`#dw-sites a[href="${origin}/s/${slug}/"]`).count(), "use the server's share URL").toBeGreaterThan(0);
    }
    await settled(f);
    expect(f.wire.map(request => request.cursor)).toEqual([null, cursorA]);
  });
});

describe("Sites dashboard: non-destructive failure and accessible retry", () => {
  // Break: catch clears the list or advances the cursor, or automatically retries.
  it("preserves loaded rows and query on a second-page error, then retries exactly that cursor", async () => {
    const f = await open([
      pageOf([site("needle-first", "Needle"), site("orchard", "Trees")], cursorA),
      unavailable(),
      pageOf([site("needle-retry", "Needle"), site("stone", "Stone")], cursorB),
      pageOf([site("needle-last", "Needle")], null),
    ]);
    await loaded(f, ["needle-first", "orchard"]);
    await search(f).fill("needle");
    await more(f).click();
    await expect.poll(() => f.wire.length).toBe(2);
    await settled(f);
    expect.soft(await slugs(f, false), "a later-page error must not delete previously loaded rows").toEqual(["needle-first", "orchard"]);
    await loaded(f, ["needle-first"]);
    expect(await search(f).inputValue()).toBe("needle");
    await feedback(f);
    await counts(f, "1 match of 2 loaded sites+.");
    const retry = f.page.getByRole("button", { name: /retry|try again|load more/i }).first();
    expect(await retry.isEnabled(), "failure must leave an explicit non-busy retry").toBe(true);
    expect(await retry.getAttribute("aria-busy")).not.toBe("true");
    await settled(f);
    expect(f.wire).toHaveLength(2);
    await retry.focus();
    await f.page.keyboard.press("Enter");
    await loaded(f, ["needle-first", "needle-retry"]);
    expect(f.wire.map(request => request.cursor)).toEqual([null, cursorA, cursorA]);
    await counts(f, "2 matches of 4 loaded sites+.");
    expect(await f.page.locator("#dw-main").innerText(), "clear stale failure feedback after success").not.toMatch(/this page could not be loaded/i);
    await more(f).click();
    await loaded(f, ["needle-first", "needle-retry", "needle-last"]);
    await terminal(f);
    expect(f.wire.map(request => request.cursor)).toEqual([null, cursorA, cursorA, cursorB]);
  });

  // Break: timer-driven retries or delayed prefetch without a fresh activation.
  it("does not fetch ahead or automatically retry a failed page as browser timers advance", async () => {
    const f = await open([
      pageOf([site("first", "First")], cursorA),
      unavailable(),
      pageOf([site("unrequested", "Must require an explicit retry")], null),
    ], true);
    await loaded(f, ["first"]);
    await f.page.clock.fastForward(60_000);
    await settled(f);
    expect(f.wire.map(request => request.cursor), "one initial page, no delayed fetch-all loop").toEqual([null]);
    await more(f).click();
    await expect.poll(() => f.page.locator("#dw-main").innerText()).toMatch(/could not|failed|unable|unavailable/i);
    await f.page.clock.fastForward(60_000);
    await settled(f);
    expect(f.wire.map(request => request.cursor), "failed cursors may only retry on explicit user action").toEqual([null, cursorA]);
  });

  // Break: a first-page error disables retry because no table has been shown yet.
  it("distinguishes an empty first page from a failed first page and supports explicit keyboard retry", async () => {
    const empty = await open([pageOf([], null)]);
    await expect.poll(() => empty.page.locator("#dw-sites").innerText()).toMatch(/no sites|no .*sites|publish.*first|nothing.*yet/i);
    await loaded(empty, []);
    await terminal(empty);
    expect(await empty.page.locator("#dw-main").innerText()).not.toMatch(/could not|failed|unable|unavailable/i);
    expect(empty.wire.map(request => request.cursor)).toEqual([null]);
    const failed = await open([
      unavailable(),
      pageOf([site("recovered-first", "First"), site("recovered-second", "Second")], cursorA),
      pageOf([site("recovered-last", "Last")], null),
    ], true);
    await expect.poll(() => failed.page.locator("#dw-main").innerText()).toMatch(/could not|failed|unable|unavailable/i);
    await feedback(failed);
    expect(await failed.page.locator("#dw-sites").innerText()).not.toMatch(/no sites yet|publish your first/i);
    const retry = failed.page.getByRole("button", { name: /retry|try again|load more/i }).first();
    expect(await retry.isVisible(), "show a retry even before the first successful page").toBe(true);
    expect(await retry.isEnabled(), "a failed first page must leave an operable retry").toBe(true);
    expect(await retry.getAttribute("aria-busy")).not.toBe("true");
    await failed.page.clock.fastForward(60_000);
    await settled(failed);
    expect(failed.wire.map(request => request.cursor), "do not automatically retry the failed first page").toEqual([null]);
    await retry.focus();
    await failed.page.keyboard.press("Enter");
    await loaded(failed, ["recovered-first", "recovered-second"]);
    expect(await slugs(failed, false)).toEqual(["recovered-first", "recovered-second"]);
    expect(failed.wire.map(request => request.cursor), "retry the initial request without a cursor").toEqual([null, null]);
    await counts(failed, "2 sites+.");
    expect(await failed.page.locator("#dw-main").innerText(), "clear stale first-page failure feedback after success").not.toMatch(/this page could not be loaded|retry this page/i);
    expect(await more(failed).isEnabled()).toBe(true);
    expect(await more(failed).getAttribute("aria-busy")).not.toBe("true");
    await more(failed).click();
    await loaded(failed, ["recovered-first", "recovered-second", "recovered-last"]);
    expect(await slugs(failed, false)).toEqual(["recovered-first", "recovered-second", "recovered-last"]);
    await counts(failed, "3 sites.");
    await terminal(failed);
    await failed.page.clock.fastForward(60_000);
    await settled(failed);
    expect(failed.wire.map(request => request.cursor)).toEqual([null, null, cursorA]);
  });

  // Break: replacing/removing the focused control, or mouse-only activation.
  it.each(["Enter", "Space"])("supports %s activation and restores usable focus after a bounded page", async key => {
    const gate = deferred();
    const f = await open([
      pageOf([site("first", "First")], cursorA),
      { ...pageOf([site("second", "Second")], cursorB), gate },
    ]);
    await loaded(f, ["first"]);
    await more(f).focus();
    await f.page.keyboard.press(key);
    await expect.poll(() => f.wire.length).toBe(2);
    const active = f.page.locator("#dw-sites button").filter({ hasText: /load|loading/i }).first();
    expect.soft(await active.isDisabled()).toBe(true);
    gate.resolve();
    await loaded(f, ["first", "second"]);
    expect(await more(f).isEnabled()).toBe(true);
    expect(await more(f).evaluate((el: any) => el === el.ownerDocument.activeElement), "do not lose keyboard focus to body or a new row").toBe(true);
    expect(f.wire.map(request => request.cursor)).toEqual([null, cursorA]);
  });

  // Break: new error/filter/count rendering interpolates API data as HTML.
  it("renders hostile titles as text while preserving read-only authorization and links", async () => {
    const title = '<img src="/unexpected-image" onerror="globalThis.pagingInjected=true"> Needle';
    const f = await open([
      pageOf([site("first", "First")], cursorA),
      pageOf([site("literal-title", title)], null),
    ]);
    await loaded(f, ["first"]);
    await more(f).click();
    await loaded(f, ["first", "literal-title"]);
    expect(await f.page.locator("#dw-sites").innerText()).toContain(title);
    expect(await f.page.locator("#dw-sites img, #dw-sites script").count()).toBe(0);
    expect(await f.page.evaluate(() => (globalThis as any).pagingInjected ?? false)).toBe(false);
    await search(f).fill("needle");
    await loaded(f, ["literal-title"]);
    expect(await f.page.locator(`#dw-sites a[href="${origin}/s/literal-title/"]`).count()).toBeGreaterThan(0);
    expect(await f.context.cookies(), "API-key flow must not activate sessions").toEqual([]);
    assertWire(f);
  });
});
