/**
 * Protected, independently authored browser acceptance. Builders do not edit.
 * Exercises the HTTP-delivered /v UI, not a reconstructed client or source text.
 *
 * Uses the existing Node Vitest + local Worker + isolated Playwright dependency:
 *   npm ci --include=dev
 *   npm ci --prefix packages/cli/test/encrypted --include=dev
 *   npm run test:cli -- test/encrypted/viewer-breadcrumbs.acceptance.test.ts
 * Chromium's declared OS dependencies must already be available in the executor.
 * Launch options match every other suite in this harness. A prerequisite/launch
 * failure is NOT RED feature evidence. Do not override CSP, relax the preview
 * iframe sandbox, add dependencies, or skip to make this run.
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

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const slug = "breadcrumb-notes";
const bootstrap = "breadcrumb-disposable-bootstrap-0123456789abcdef";
const note = "breadcrumbs-note-alpha\nSecond line\n";
// A tag-like segment must not accidentally introduce a slash into the fixture.
const inertDir = "space here/日本語/100% #? & <b>literal";
const specialPath = `${inertDir}/note %?#.txt`;
const specialHref = "/v/breadcrumb-notes/space%20here/%E6%97%A5%E6%9C%AC%E8%AA%9E/100%25%20%23%3F%20%26%20%3Cb%3Eliteral/";
const longSegments = Array.from({ length: 9 }, (_, i) => `chapter-${i + 1}-${"long-readable-name-".repeat(3)}`);
const longPath = `${longSegments.join("/")}/last-note.txt`;
const hiddenName = "not-advertised-by-denied-manifest.txt";
let work: string;
let api: string;
let key: string;
let restrictedKey: string;
let browser: any;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;

type Wire = { method: string; url: string; resource: string };
type View = { page: any; context: any; wire: Wire[]; responses: any[]; bodies: Map<any, Promise<string | null>>; violations: string[] };

async function post(path: string, body: unknown, credential: string) {
  const response = await fetch(`${api}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Never include an API response body in an assertion: setup contains a key.
  expect(response.status, `disposable fixture POST ${path}`).toBe(201);
  return response.json() as Promise<any>;
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "viewer-breadcrumbs-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-viewer-breadcrumb-acceptance", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "breadcrumb-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "breadcrumb-acceptance-files" }], kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"),
    "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config, dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  api = (await worker.url).origin;
  expect(new URL(api).hostname).toBe("127.0.0.1");
  const setup = await post("/api/v1/setup", { email: "breadcrumbs@example.test" }, bootstrap);
  key = setup.apiKey.key;
  const published = await post("/api/v1/publish", { slug, files: [
    { path: "root.txt", content: "root-listing-marker" },
    { path: "docs/guide/note.txt", content: note, contentType: "text/plain" },
    { path: "docs/guide/neighbor.txt", content: "neighbor-beta" },
    { path: "docs/other.txt", content: "other-branch-gamma" },
    { path: "elsewhere/note.txt", content: "wrong-same-basename-zeta" },
    { path: specialPath, content: "special-exact-file-delta" },
    { path: longPath, content: "long-path-exact-file-epsilon" },
    { path: hiddenName, content: "public-file-not-a-manifest-grant" },
  ] }, key);
  expect(published.slug).toBe(slug);
  const limited = await post("/api/v1/keys", { name: "breadcrumb-no-site-read", scopes: ["keys:write"] }, key);
  restrictedKey = limited.key;
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

function encoded(path: string) { return path.split("/").map(encodeURIComponent).join("/"); }
function outer(path: string, mode = "view") { return `${api}/v/${slug}/${encoded(path)}${mode === "view" ? "" : `?mode=${mode}`}`; }
function frameUrl(path: string, mode = "view") {
  if (!path || path.endsWith("/")) return `${api}/s/${slug}/${encoded(path)}`;
  return `${api}/s/${slug}/${encoded(path)}?${mode === "raw" ? "raw=1" : `view=${mode === "source" ? "source" : "1"}&embed=1`}`;
}

async function open(path = "docs/guide/note.txt", mode = "view", credential: string | null = key, narrow = false): Promise<View> {
  const context = await browser.newContext({ viewport: { width: narrow ? 360 : 1100, height: 800 } });
  const wire: Wire[] = [];
  const violations: string[] = [];
  const responses: any[] = [];
  // Bodies are read as they arrive: one is unavailable once its document is gone.
  const bodies = new Map<any, Promise<string | null>>();
  try {
    await context.route("**/*", async (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      wire.push({ method: request.method(), url: request.url(), resource: request.resourceType() });
      if (url.origin !== api || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        violations.push(`${request.method()} ${url.origin}${url.pathname}`);
        return route.abort("blockedbyclient");
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on("response", (response: any) => {
      if (!new URL(response.url()).pathname.startsWith("/api/")) return;
      responses.push(response);
      bodies.set(response, response.text().catch(() => null));
    });
    if (credential) {
      await page.goto(`${api}/login`, { waitUntil: "networkidle" });
      await page.locator('#dw-signin input[name="key"]').fill(credential);
      await page.locator("#dw-signin").getByRole("button", { name: /sign in/i }).click();
      await page.waitForURL((url: URL) => url.pathname !== "/login", { timeout: 15_000 });
      await page.waitForLoadState("networkidle");
    }
    // Sign-in responses are gone after navigation; keep only the viewer's own.
    responses.length = 0;
    bodies.clear();
    const response = await page.goto(outer(path, mode), { waitUntil: "networkidle" });
    expect(response.status()).toBe(200);
    const csp = response.headers()["content-security-policy"];
    // Existing shell CSP: scripts stay first-party only (inline styles predate this card).
    const scripts = csp.split(";").map((directive: string) => directive.trim()).find((directive: string) => directive.startsWith("script-src "));
    expect(scripts).toBe("script-src 'self'");
    return { page, context, wire, responses, bodies, violations };
  } catch (error) { await context.close(); throw error; }
}

async function close(view: View) {
  try {
    expect(view.violations, "browser may neither write nor contact another origin").toEqual([]);
    for (const request of view.wire) {
      expect(new URL(request.url).searchParams.has("version"), "live navigation is not historical access").toBe(false);
    }
  } finally { await view.context.close(); }
}

async function crumbs(page: any) {
  // Select by semantic outcome, not a proposed implementation id or class. The
  // crumbs live in the existing viewer strip (the "Preview" region), not the
  // header's dashboard navigation, which has its own aria-current link.
  const nav = page.getByRole("region", { name: "Preview" }).getByRole("navigation").filter({ has: page.locator('[aria-current="page"]') });
  await expect.poll(() => nav.count(), { timeout: 3000, message: "one labelled breadcrumb navigation with a current location" }).toBe(1);
  const label = await nav.evaluate((element: any) => element.getAttribute("aria-label") ||
    (element.getAttribute("aria-labelledby") || "").split(/\s+/).map((id: string) => element.ownerDocument.getElementById(id)?.textContent || "").join(" "));
  expect(label.trim(), "breadcrumb navigation has an accessible name").not.toBe("");
  const current = nav.locator('[aria-current="page"]');
  expect(await current.count()).toBe(1);
  expect(await current.evaluate((element: any) => element.matches("a,button,input,select,[tabindex]:not([tabindex='-1'])")), "current location is not interactive").toBe(false);
  return { nav, current, label: label.trim() };
}

async function aligned(view: View, path: string, mode = "view", content?: string) {
  await expect.poll(() => view.page.url()).toBe(outer(path, mode));
  const iframe = view.page.locator("iframe");
  expect(await iframe.count()).toBe(1);
  expect(await iframe.getAttribute("src")).toBe(frameUrl(path, mode));
  const frame = await (await iframe.elementHandle()).contentFrame();
  await expect.poll(() => frame.url()).toBe(frameUrl(path, mode));
  const title = await iframe.getAttribute("title");
  expect(title, "preview has a meaningful title for the selected path").toBeTruthy();
  if (path) expect(title).toContain(path.replace(/\/$/, "").split("/").at(-1));
  if (content) await expect.poll(() => frame.locator("body").innerText()).toContain(content);
  const sandbox = await iframe.getAttribute("sandbox");
  expect(sandbox).not.toContain("allow-same-origin");
  const { current } = await crumbs(view.page);
  if (path) expect((await current.innerText()).replace(/\/$/, "")).toBe(path.replace(/\/$/, "").split("/").at(-1));
  // The URL, preview mode, and visibly selected mode control must agree.
  if (path && !path.endsWith("/")) {
    const name = mode === "source" ? /^source$/i : mode === "raw" ? /^raw$/i : /^(rendered|view)$/i;
    const control = view.page.getByRole("button", { name }).or(view.page.getByRole("tab", { name })).or(view.page.getByRole("link", { name })).first();
    expect(await control.count(), "selected mode remains exposed").toBe(1);
    expect(await control.evaluate((element: any) => element.getAttribute("aria-selected") === "true" ||
      element.getAttribute("aria-pressed") === "true" || /(?:^|[\s_-])(active|selected|on)(?:$|[\s_-])/.test(element.className)), "selected mode is visibly marked").toBe(true);
  }
}

async function ancestor(view: View, href: string) {
  const { nav } = await crumbs(view.page);
  const link = nav.locator(`a[href="${href}"]`);
  expect(await link.count(), `one real ancestor link: ${href}`).toBe(1);
  expect((await link.innerText()).trim()).not.toBe("");
  const resolved = new URL(await link.getAttribute("href"), view.page.url());
  expect(resolved.origin).toBe(api);
  expect(resolved.search).toBe("");
  expect(resolved.hash).toBe("");
  return link;
}

function manifestRequests(view: View) {
  return view.wire.filter(r => new URL(r.url).pathname.startsWith("/api/v1/sites/"));
}

describe("live app-origin breadcrumb navigation", () => {
  it("root has one noninteractive current location and no spurious ancestor", async () => {
    const view = await open("");
    try {
      const { nav, current } = await crumbs(view.page);
      expect((await current.innerText()).trim()).not.toBe("");
      expect(await nav.getByRole("link").count()).toBe(0);
      await aligned(view, "", "view", "root.txt");
    } finally { await close(view); }
  });

  it.each([
    { path: "docs/", current: "docs", hrefs: ["/v/breadcrumb-notes/"] },
    { path: "docs/guide/", current: "guide", hrefs: ["/v/breadcrumb-notes/", "/v/breadcrumb-notes/docs/"] },
    { path: "docs/guide/note.txt", current: "note.txt", hrefs: ["/v/breadcrumb-notes/", "/v/breadcrumb-notes/docs/", "/v/breadcrumb-notes/docs/guide/"] },
  ])("$path retains directory identity and exactly its own ancestors", async ({ path, current, hrefs }) => {
    const view = await open(path);
    try {
      const location = await crumbs(view.page);
      expect((await location.current.innerText()).replace(/\/$/, "")).toBe(current);
      const actual = await location.nav.getByRole("link").evaluateAll((links: any[]) => links.map(link => new URL(link.href).pathname));
      expect(actual).toEqual(hrefs);
      await aligned(view, path, "view", path.endsWith("/") ? "guide" === current ? "note.txt" : "guide" : "breadcrumbs-note-alpha");
    } finally { await close(view); }
  });

  it("retains selected-file size/type beside the navigation and labels the current live site truthfully", async () => {
    const view = await open();
    try {
      const { nav, label } = await crumbs(view.page);
      const strip = await nav.evaluate((element: any) => element.parentElement.textContent);
      expect(strip).toContain("text/plain");
      expect(strip).toMatch(new RegExp(`${Buffer.byteLength(note)}\\s*(B|bytes)\\b`, "i"));
      // "Live" may be the navigation's accessible name or visible strip text.
      expect(`${label} ${strip}`, "breadcrumbs say they navigate the live site").toMatch(/\blive\b/i);
      const labelled = `${label} ${await view.page.locator("body").innerText()}`;
      expect(labelled).not.toMatch(/immutable|permalink|snapshot|access granted/i);
    } finally { await close(view); }
  });

  it("current crumb, metadata and preview refer to the actual manifest row, not a same-basename sibling", async () => {
    const view = await open();
    try {
      const rows: any[] = [];
      const collect = (value: any) => {
        if (!value || typeof value !== "object") return;
        if (value.path === "docs/guide/note.txt") rows.push(value);
        for (const child of Object.values(value)) collect(child);
      };
      for (const response of view.responses) {
        const body = response.ok() ? await view.bodies.get(response) : null;
        if (body) collect(JSON.parse(body));
      }
      expect(rows.length, "real Worker manifest includes the selected fixture row").toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.size).toBe(Buffer.byteLength(note));
        expect(row.contentType).toMatch(/^text\/plain(;|$)/);
      }
      await aligned(view, "docs/guide/note.txt", "view", "breadcrumbs-note-alpha");
      const preview = await (await view.page.locator("iframe").elementHandle()).contentFrame();
      expect(await preview.locator("body").innerText()).not.toContain("wrong-same-basename-zeta");
      expect(view.wire.filter(request => new URL(request.url).pathname.startsWith(`/s/${slug}/`) && request.resource !== "document"), "crumb construction does not fetch file contents").toEqual([]);
      expect(view.wire.filter(request => /\/api\/.*\/files\//.test(new URL(request.url).pathname)), "no extra content read-back just for crumbs").toEqual([]);
    } finally { await close(view); }
  });

  it("keyboard Tab reaches an ancestor and Enter navigates once, resetting source to view", async () => {
    const view = await open("docs/guide/note.txt", "source");
    try {
      const link = await ancestor(view, "/v/breadcrumb-notes/docs/guide/");
      await view.page.locator("body").click({ position: { x: 1, y: 1 } });
      let reached = false;
      for (let i = 0; i < 50; i++) {
        await view.page.keyboard.press("Tab");
        if (await link.evaluate((element: any) => element === element.ownerDocument.activeElement)) { reached = true; break; }
      }
      expect(reached, "ancestors participate in normal sequential keyboard focus").toBe(true);
      const length = await view.page.evaluate(() => (globalThis as any).history.length);
      await view.page.keyboard.press("Enter");
      await view.page.waitForLoadState("networkidle");
      await aligned(view, "docs/guide/", "view", "note.txt");
      expect(await view.page.evaluate(() => (globalThis as any).history.length)).toBe(length + 1);
    } finally { await close(view); }
  });

  it("ordinary ancestor clicks stay in the same shell, push once, and return root with p empty", async () => {
    const view = await open();
    try {
      await view.page.evaluate(() => { (globalThis as any).breadcrumbShellWitness = "same-document"; });
      const length = await view.page.evaluate(() => (globalThis as any).history.length);
      const reads = manifestRequests(view).length;
      const storage = await view.page.evaluate(() => {
        const g = globalThis as any; return JSON.stringify([Object.entries(g.localStorage), Object.entries(g.sessionStorage)]);
      });
      await (await ancestor(view, "/v/breadcrumb-notes/docs/")).click();
      await view.page.waitForLoadState("networkidle");
      await aligned(view, "docs/", "view", "guide");
      await (await ancestor(view, "/v/breadcrumb-notes/")).click();
      await view.page.waitForLoadState("networkidle");
      await aligned(view, "", "view", "root.txt");
      expect(await view.page.evaluate(() => (globalThis as any).breadcrumbShellWitness)).toBe("same-document");
      expect(await view.page.evaluate(() => (globalThis as any).history.length)).toBe(length + 2);
      expect(manifestRequests(view).length, "crumb construction reuses the already loaded manifest").toBe(reads);
      const unchangedStorage = await view.page.evaluate((before: string) => {
        const g = globalThis as any; return JSON.stringify([Object.entries(g.localStorage), Object.entries(g.sessionStorage)]) === before;
      }, storage);
      expect(unchangedStorage, "ancestor navigation adds no persisted state (credential values are never printed)").toBe(true);
    } finally { await close(view); }
  });

  it.each(["source", "raw"])("direct %s entry -> ancestor -> Back/Forward restores path, mode, frame and current crumb", async mode => {
    const view = await open("docs/guide/note.txt", mode);
    try {
      await aligned(view, "docs/guide/note.txt", mode, "breadcrumbs-note-alpha");
      const length = await view.page.evaluate(() => (globalThis as any).history.length);
      await (await ancestor(view, "/v/breadcrumb-notes/docs/guide/")).click();
      await view.page.waitForLoadState("networkidle");
      await aligned(view, "docs/guide/", "view", "neighbor.txt");
      expect(await view.page.evaluate(() => (globalThis as any).history.length)).toBe(length + 1);
      await view.page.goBack({ waitUntil: "networkidle" });
      await aligned(view, "docs/guide/note.txt", mode, "breadcrumbs-note-alpha");
      await view.page.goForward({ waitUntil: "networkidle" });
      await aligned(view, "docs/guide/", "view", "neighbor.txt");
      await view.page.goBack({ waitUntil: "networkidle" });
      await aligned(view, "docs/guide/note.txt", mode, "breadcrumbs-note-alpha");
      expect(await view.page.evaluate(() => (globalThis as any).history.length), "popstate/rerender never adds entries").toBe(length + 1);
    } finally { await close(view); }
  });

  it("encoded space, Unicode, percent, hash, question and markup-like text remain literal segments", async () => {
    const view = await open(specialPath);
    try {
      const { nav, current } = await crumbs(view.page);
      expect(await current.innerText()).toBe("note %?#.txt");
      expect(await nav.locator("b,img,script,iframe").count(), "filename markup is text, not DOM").toBe(0);
      expect(await nav.innerText()).toContain("100% #? & <b>literal");
      const link = await ancestor(view, specialHref);
      expect(new URL(await link.getAttribute("href"), api).pathname).toBe(specialHref);
      await link.click();
      await view.page.waitForLoadState("networkidle");
      await aligned(view, `${inertDir}/`, "view", "note %?#.txt");
    } finally { await close(view); }
  });

  it("Control-click preserves native new-tab behavior without navigating the original", async () => {
    const modifier = "Control";
    const view = await open("docs/guide/note.txt", "raw");
    try {
      const length = await view.page.evaluate(() => (globalThis as any).history.length);
      const link = await ancestor(view, "/v/breadcrumb-notes/docs/guide/");
      // Observe default prevention without preventing the native action ourselves.
      await view.page.evaluate(() => {
        (globalThis as any).breadcrumbModifiedEvents = [];
        (globalThis as any).document.addEventListener("click", (event: any) => {
          if (event.ctrlKey || event.metaKey) (globalThis as any).breadcrumbModifiedEvents.push(event.defaultPrevented);
        });
      });
      const popup = view.context.waitForEvent("page", { timeout: 3000 });
      await link.click({ modifiers: [modifier] });
      expect(await view.page.evaluate(() => (globalThis as any).breadcrumbModifiedEvents)).toEqual([false]);
      expect(view.page.url()).toBe(outer("docs/guide/note.txt", "raw"));
      expect(await view.page.evaluate(() => (globalThis as any).history.length)).toBe(length);
      const tab = await popup;
      try {
        await tab.waitForLoadState("networkidle");
        expect(tab.url()).toBe(outer("docs/guide/"));
      } finally { await tab.close(); }
    } finally { await close(view); }
  });

  it("Meta-modified activation is left to the browser, not consumed by go", async () => {
    const view = await open();
    try {
      const link = await ancestor(view, "/v/breadcrumb-notes/docs/");
      // Meta's platform-native action differs on Linux and macOS. Test that the
      // app does not cancel it; Control and middle-click above/below test tabs.
      const accepted = await link.evaluate((element: any) => element.dispatchEvent(new (globalThis as any).MouseEvent("click", {
        bubbles: true, cancelable: true, metaKey: true, button: 0,
      })));
      expect(accepted, "modified anchor activation must not be preventDefault'ed").toBe(true);
    } finally { await close(view); }
  });

  it("middle-click opens the real same-site ancestor href in a new tab", async () => {
    const view = await open();
    try {
      const opened = view.context.waitForEvent("page", { timeout: 3000 });
      await (await ancestor(view, "/v/breadcrumb-notes/docs/")).click({ button: "middle" });
      const tab = await opened;
      try {
        await tab.waitForLoadState("networkidle");
        expect(tab.url()).toBe(outer("docs/"));
        expect(view.page.url()).toBe(outer("docs/guide/note.txt"));
      } finally { await tab.close(); }
    } finally { await close(view); }
  });

  it("a long path wraps at 360px without horizontal clipping and every ancestor remains reachable", async () => {
    const view = await open(longPath, "view", key, true);
    try {
      const { nav } = await crumbs(view.page);
      expect(await nav.getByRole("link").count()).toBe(longSegments.length + 1);
      const geometry = await nav.evaluate((element: any) => {
        const document = element.ownerDocument;
        return {
          viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
          boxes: [...element.querySelectorAll("a,[aria-current]")].map((child: any) => {
            const box = child.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, width: box.width, height: box.height };
          }),
        };
      });
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.viewport + 1);
      for (const box of geometry.boxes) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
      }
      expect(new Set(geometry.boxes.map((box: any) => Math.round(box.top))).size, "deep breadcrumbs wrap instead of truncating").toBeGreaterThan(1);
      await (await ancestor(view, `/v/${slug}/${encoded(longSegments[0]!)}/`)).click();
      await view.page.waitForLoadState("networkidle");
      await aligned(view, `${longSegments[0]}/`, "view", longSegments[1]);
    } finally { await close(view); }
  });

  it("filtering and folder expansion do not change the current selection, history or content requests", async () => {
    const view = await open();
    try {
      await aligned(view, "docs/guide/note.txt", "view", "breadcrumbs-note-alpha");
      const reads = view.wire.length;
      const length = await view.page.evaluate(() => (globalThis as any).history.length);
      const filter = view.page.getByRole("textbox", { name: /filter|search|find/i }).or(view.page.getByPlaceholder(/filter|search|find/i)).first();
      await filter.fill("neighbor");
      await expect.poll(() => view.page.getByText("neighbor.txt", { exact: true }).isVisible()).toBe(true);
      await filter.fill("");
      // The existing tree folds folders with <details>/<summary> (not role=button).
      const folder = view.page.getByRole("complementary", { name: "Files" }).locator("summary").filter({ hasText: /^docs$/ });
      expect(await folder.count()).toBe(1);
      await folder.click();
      await folder.click();
      await aligned(view, "docs/guide/note.txt", "view", "breadcrumbs-note-alpha");
      expect(await view.page.evaluate(() => (globalThis as any).history.length)).toBe(length);
      expect(view.wire.length, "local chrome updates require no extra API or file fetch").toBe(reads);
    } finally { await close(view); }
  });

  it.each(["unauthenticated", "denied"])("%s viewer shows crumbs only from its own URL path and no other filenames", async kind => {
    const view = await open("docs/guide/note.txt", "view", kind === "unauthenticated" ? null : restrictedKey);
    try {
      const siteResponses = view.responses.filter(response => new URL(response.url()).pathname.startsWith(`/api/v1/sites/${slug}`));
      if (kind === "unauthenticated") {
        // Current behavior: a signed-out viewer never asks for the manifest.
        expect(siteResponses.length, "signed-out crumbs need no manifest request").toBe(0);
      } else {
        expect(siteResponses.length, "exercise a real refused manifest request").toBeGreaterThan(0);
        expect(siteResponses.every(response => response.status() === 403), "no successful manifest through a fallback access path").toBe(true);
      }
      const { nav, current } = await crumbs(view.page);
      expect((await current.innerText()).trim()).toBe("note.txt");
      const actual = await nav.getByRole("link").evaluateAll((links: any[]) => links.map(link => new URL(link.href).pathname));
      expect(actual).toEqual(["/v/breadcrumb-notes/", "/v/breadcrumb-notes/docs/", "/v/breadcrumb-notes/docs/guide/"]);
      const text = await view.page.locator("body").innerText();
      for (const name of [hiddenName, "neighbor.txt", "other.txt", "root.txt", "日本語", "chapter-1"]) expect(text).not.toContain(name);
      expect(text).not.toMatch(/access granted|immutable|permalink|snapshot/i);
      expect(view.wire.filter(request => /\/api\/.*\/files\//.test(new URL(request.url).pathname)), "denial never triggers file read-back").toEqual([]);
    } finally { await close(view); }
  });
});
