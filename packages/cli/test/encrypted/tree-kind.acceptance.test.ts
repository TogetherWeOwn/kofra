/**
 * Independent RED interaction contract for the existing /v/:slug file tree.
 * Protected acceptance artifact: the paired implementation must not edit it.
 *
 * Uses the existing Node-Vitest + test-only Playwright harness. Prerequisites:
 *   npm ci --include=dev
 *   npm ci --prefix packages/cli/test/encrypted --include=dev
 *   packages/cli/test/encrypted/node_modules/.bin/playwright install --with-deps chromium
 *   npm run test:cli -- test/encrypted/tree-kind.acceptance.test.ts
 * Optional: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH and the runner's LD_LIBRARY_PATH.
 *
 * The real local Worker delivers the shell, client, styles, CSP and file frames.
 * Only manifest responses are controlled (empty/future kinds and deliberately
 * misleading extensions); authentication and ordinary navigation remain real.
 * No remote deployment, dependency addition, production helper import, source
 * assertions, CSP override or invented browser UI is involved.
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const hostile = '\"><img src=x onerror=globalThis.__treeXss=1>.txt';
const fixtureFiles = {
  "index.html": "<!doctype html><title>Local tree fixture</title><p>Selected fixture frame</p>",
  "assets/Photo.TXT": "Server classifies this as an image despite its suffix and MIME.",
  "assets/nested/diagram.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  "docs/REPORT.pdf": "%PDF-1.7\nfixture",
  "docs/photo.png": "image fixture",
  "src/nested/report.TXT": "const example = true;",
  "src/util.ts": "export const fixture = 1;",
  "archive/capsule.zip": "archive fixture",
  "odd/schema.data": "future server kind",
  "hostile.txt": "literal filename fixture",
};
// Expectations come from the contract, not the product's classifier.
const serverKinds: Record<string, string> = {
  "index.html": "html", "assets/Photo.TXT": "image", "assets/nested/diagram.svg": "svg",
  "docs/REPORT.pdf": "pdf", "docs/photo.png": "image", "src/nested/report.TXT": "code",
  "src/util.ts": "code", "archive/capsule.zip": "archive", "odd/schema.data": "cad_mesh_v2",
  [hostile]: "text",
};
const allPaths = Object.keys(serverKinds).sort();
type Row = { path: string; kind: string; [key: string]: unknown };
type Options = {
  rows?: Row[]; state?: "anonymous" | "forbidden" | "manifest-failed"; width?: number;
  mode?: "source" | "raw"; path?: string; params?: Record<string, string>;
  clipboard?: "success" | "rejected";
};
let browser: any;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let work: string;
let api: string;
let sites: string;
let key: string;

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("expected a local TCP port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
let slug: string;
let manifest: Record<string, any>;
let mixed: Row[];

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "tree-kind-acceptance-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  const port = await availablePort();
  api = `http://127.0.0.1:${port}`;
  sites = `http://127.0.0.2:${port}`;
  await writeFile(config, JSON.stringify({
    name: "dropway-tree-kind-acceptance", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: api, SITES_MODE: "path", SITES_ORIGIN: sites, SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "tree-kind-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "tree-kind-acceptance-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config,
    dev: { server: { hostname: "0.0.0.0", port }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: "local-tree-kind-bootstrap-fixture-only" } },
  });
  await worker.ready;
  expect((await worker.url).port).toBe(String(port));
  const setup = await fetch(`${api}/api/v1/setup`, {
    method: "POST", headers: { Authorization: "Bearer local-tree-kind-bootstrap-fixture-only", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "tree-fixture@example.test" }),
  });
  expect(setup.status, "disposable local owner fixture must initialize").toBe(201);
  key = (await setup.json() as any).apiKey.key;
  const form = new FormData();
  for (const [path, content] of Object.entries(fixtureFiles)) form.append("files", new File([content], path));
  const published = await fetch(`${api}/api/v1/publish`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  expect(published.status, "disposable local manifest fixture must publish").toBe(201);
  slug = (await published.json() as any).slug;
  const files = await fetch(`${api}/api/v1/sites/${slug}/files`, { headers: { Authorization: `Bearer ${key}` } });
  expect(files.status).toBe(200);
  manifest = await files.json() as Record<string, any>;
  expect(Array.isArray(manifest.files), "fixture must use the real public manifest response envelope").toBe(true);
  mixed = manifest.files.map((file: Row) => {
    const path = file.path === "hostile.txt" ? hostile : file.path;
    return { ...file, path, kind: serverKinds[path]! };
  });
  expect(mixed.map(row => row.path).sort()).toEqual(allPaths);
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function visit(options: Options = {}) {
  const context = await browser.newContext({ viewport: { width: options.width ?? 1100, height: 850 } });
  // Observe boundary side effects, never replace the app script or its DOM.
  await context.addInitScript(({ reject }: { reject: boolean }) => {
    const g = globalThis as any;
    g.__browserViewAcceptance = { copies: [] as string[], innerHTMLWrites: 0, intervals: 0 };
    Object.defineProperty(g.navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => {
        g.__browserViewAcceptance.copies.push(text);
        if (reject) throw new DOMException("Clipboard denied", "NotAllowedError");
      },
    } });
    if (reject) {
      const exec = g.document.execCommand.bind(g.document);
      g.document.execCommand = (command: string, ...args: unknown[]) => command.toLowerCase() === "copy" ? false : exec(command, ...args);
    }
    const descriptor = Object.getOwnPropertyDescriptor(g.Element.prototype, "innerHTML")!;
    Object.defineProperty(g.Element.prototype, "innerHTML", { ...descriptor, set(value: string) {
      g.__browserViewAcceptance.innerHTMLWrites++;
      descriptor.set!.call(this, value);
    } });
    const interval = g.setInterval.bind(g);
    g.setInterval = (...args: unknown[]) => { g.__browserViewAcceptance.intervals++; return interval(...args); };
  }, { reject: options.clipboard === "rejected" });
  const requests: { method: string; url: string }[] = [];
  const external: string[] = [];
  const errors: string[] = [];
  let manifestLoads = 0;
  await context.route("**/*", async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ method: request.method(), url: request.url() });
    if (url.origin !== api && url.origin !== sites) { external.push(url.origin); return route.abort("blockedbyclient"); }
    if (options.state === "forbidden" && url.pathname.startsWith(`/api/v1/sites/${slug}`)) {
      return route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "Not authorized", hint: "Use an authorized key." } } });
    }
    if (url.pathname === `/api/v1/sites/${slug}/files`) {
      manifestLoads++;
      if (options.state === "manifest-failed") return route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Manifest unavailable", hint: "Try again later." } } });
      // Keep the complete real response, changing only the loaded inventory.
      return route.fulfill({ status: 200, json: { ...manifest, files: options.rows ?? mixed } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error: Error) => errors.push(error.message));
  page.setDefaultTimeout(2500);
  const path = options.path ?? (options.state ? "" : "index.html");
  const params = new URLSearchParams(options.params);
  if (options.mode) params.set("mode", options.mode);
  const target = `/v/${slug}/${path}${params.size ? `?${params}` : ""}`;
  let response: any;
  try {
    if (options.state !== "anonymous") {
      await page.goto(`${api}/login?next=${encodeURIComponent(target)}`, { waitUntil: "networkidle" });
      await page.locator('input[name="key"]').fill(key);
      await page.getByRole("button", { name: /^sign in$/i }).click();
      await page.waitForURL((url: URL) => url.pathname.startsWith(`/v/${slug}/`));
      await page.waitForLoadState("networkidle");
    }
    // A real navigation also exposes the actual shell's response headers.
    response = await page.goto(`${api}${target}`, { waitUntil: "networkidle" });
    if (!options.state) await expect.poll(() => page.locator("a[data-kind]").count()).toBe((options.rows ?? mixed).length);
    return {
      context, page, requests, external, errors, response,
      manifestLoads: () => manifestLoads,
      kind: page.getByRole("combobox", { name: /(?:file\s*)?kind|file type/i }),
      query: page.getByRole("searchbox", { name: /filter|search|path/i }).or(page.getByRole("textbox", { name: /filter|search|path/i })),
      reset: page.getByRole("button", { name: /clear|reset/i }),
    };
  } catch (error) { await context.close(); throw error; }
}
type View = Awaited<ReturnType<typeof visit>>;

async function visiblePaths(view: View): Promise<string[]> {
  return view.page.locator("a[data-kind]:visible").evaluateAll((links: any[]) => links.map(link => {
    const url = new URL(link.href);
    return decodeURIComponent(url.pathname.replace(/^\/v\/[^/]+\//, ""));
  }).sort());
}

async function count(view: View, matching: number, total: number) {
  // Both numbers must belong to an announced result, not a hidden data attribute
  // or the dashboard's unrelated site/file metric. Wording remains flexible.
  const pattern = new RegExp(`\\b${matching}\\s*(?:of|/)\\s*${total}\\b`, "i");
  const result = view.page.locator('[role="status"], [aria-live="polite"], [aria-live="assertive"]').filter({ hasText: pattern });
  await expect.poll(() => result.count(), { message: `announce ${matching} of ${total} loaded files` }).toBeGreaterThan(0);
  expect(await result.first().isVisible()).toBe(true);
  expect(await result.first().innerText()).toMatch(/file/i);
}

async function kindControl(view: View) {
  expect(await view.kind.count(), "file tree needs one labelled, keyboard-operable file-kind selector").toBe(1);
  expect(await view.kind.isVisible()).toBe(true);
}

async function allValue(view: View): Promise<string> {
  const option = view.kind.getByRole("option", { name: /^all(?:\s+(?:files|kinds|file kinds|types))?$/i });
  expect(await option.count(), "the selector must include All").toBe(1);
  return option.getAttribute("value").then((value: string | null) => value ?? "All");
}

async function snapshot(view: View) {
  return view.page.evaluate(async () => {
    const w = globalThis as any;
    // Compare persistence without ever exposing the disposable sign-in key in
    // assertion output or uploaded logs.
    const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
    const digest = async (storage: any) => hex(await w.crypto.subtle.digest("SHA-256", new w.TextEncoder().encode(JSON.stringify(storage))));
    const frame = w.document.querySelector("iframe");
    const selected = [...w.document.querySelectorAll("a[data-kind]")].filter((a: any) => a.matches('[aria-current], .active, .selected, .is-active, .is-selected'));
    return {
      url: w.location.href, historyLength: w.history.length, state: JSON.stringify(w.history.state),
      frame: frame?.getAttribute("src"), sandbox: frame?.getAttribute("sandbox"),
      selected: selected.map((a: any) => a.getAttribute("href")),
      local: await digest(w.localStorage), session: await digest(w.sessionStorage),
    };
  });
}

// The shareable-state contract deliberately supersedes the former DOM-only URL
// assertion. Keep every independent frame, selection, storage and history-length
// safeguard; URL correctness is asserted explicitly by the lifecycle tests below.
function stableSelection({ url: _url, state: _state, ...rest }: Awaited<ReturnType<typeof snapshot>>) { return rest; }

async function folderVisible(view: View, name: string): Promise<boolean> {
  return (await view.page.locator("summary:visible").filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) }).count()) > 0;
}

describe("loaded-manifest file-kind filtering", () => {
  it("offers All by default and stable server kind values without guessing from extension or MIME", async () => {
    const view = await visit();
    try {
      await kindControl(view);
      expect(await view.kind.inputValue()).toBe(await allValue(view));
      const values = await view.kind.locator("option").evaluateAll((options: any[]) => options.map(o => o.value));
      for (const value of ["html", "image", "svg", "pdf", "code", "archive", "text", "cad_mesh_v2"]) expect(values).toContain(value);
      expect(new Set(values).size, "one choice per distinct server kind").toBe(values.length);
      expect(await view.kind.locator('option[value="cad_mesh_v2"]').innerText()).toMatch(/[a-z]/i);
      expect(await view.kind.locator('option[value="cad_mesh_v2"]').innerText()).not.toMatch(/undefined|\[object Object\]/);
      await count(view, 10, 10);
      await view.kind.selectOption("image");
      await expect.poll(() => visiblePaths(view)).toEqual(["assets/Photo.TXT", "docs/photo.png"]);
      await count(view, 2, 10);
      await view.kind.selectOption("cad_mesh_v2");
      await expect.poll(() => visiblePaths(view)).toEqual(["odd/schema.data"]);
      await count(view, 1, 10);
    } finally { await view.context.close(); }
  });

  it("preserves the existing case-insensitive path query as a working interaction", async () => {
    const view = await visit();
    try {
      const before = await snapshot(view);
      const requests = view.requests.length;
      await view.query.fill("sRc/NeStEd/REPORT");
      await expect.poll(() => visiblePaths(view)).toEqual(["src/nested/report.TXT"]);
      expect(stableSelection(await snapshot(view))).toEqual(stableSelection(before));
      await view.query.fill("");
      await expect.poll(() => visiblePaths(view)).toEqual(allPaths);
      await view.page.waitForLoadState("networkidle");
      expect(stableSelection(await snapshot(view))).toEqual(stableSelection(before));
      expect(view.requests.slice(requests), "the existing path query also operates only on loaded metadata").toEqual([]);
    } finally { await view.context.close(); }
  });

  it("combines query AND kind in either update order and never searches file contents", async () => {
    const view = await visit();
    try {
      await kindControl(view);
      await view.query.fill("REPORT");
      await view.kind.selectOption("code");
      await expect.poll(() => visiblePaths(view)).toEqual(["src/nested/report.TXT"]);
      await count(view, 1, 10);
      await view.kind.selectOption("pdf");
      await expect.poll(() => visiblePaths(view)).toEqual(["docs/REPORT.pdf"]);
      await view.query.fill("photo");
      await expect.poll(() => visiblePaths(view)).toEqual([]);
      await view.kind.selectOption("image");
      await expect.poll(() => visiblePaths(view)).toEqual(["assets/Photo.TXT", "docs/photo.png"]);
      await view.query.fill("Selected fixture frame");
      await expect.poll(() => visiblePaths(view)).toEqual([]);
      await count(view, 0, 10);
    } finally { await view.context.close(); }
  });

  it("keeps matching ancestors discoverable and hides empty branches, including for path-only filtering", async () => {
    const view = await visit();
    try {
      await view.query.fill("src/nested/report");
      await expect.poll(() => visiblePaths(view)).toEqual(["src/nested/report.TXT"]);
      expect(await folderVisible(view, "src")).toBe(true);
      expect(await folderVisible(view, "nested")).toBe(true);
      expect(await folderVisible(view, "archive"), "an unmatched folder must not look like a result").toBe(false);
      await kindControl(view);
      await view.query.fill("");
      await view.kind.selectOption("pdf");
      await expect.poll(() => visiblePaths(view)).toEqual(["docs/REPORT.pdf"]);
      expect(await folderVisible(view, "docs")).toBe(true);
      expect(await folderVisible(view, "assets")).toBe(false);
      expect(await folderVisible(view, "src")).toBe(false);
    } finally { await view.context.close(); }
  });

  it("explains zero matches and resets both controls while restoring the original tree and highlight", async () => {
    const view = await visit();
    try {
      const before = await snapshot(view);
      expect(before.selected.length, "the initial file must have a selected-tree marker").toBe(1);
      await kindControl(view);
      await view.kind.selectOption("pdf");
      await view.query.fill("no-such-loaded-path");
      await expect.poll(() => visiblePaths(view)).toEqual([]);
      await count(view, 0, 10);
      expect(await view.page.getByText(/no (?:matching (?:files|results)|files match|matches|results)/i).first().isVisible()).toBe(true);
      expect(await view.reset.count()).toBe(1);
      await view.reset.click();
      expect(await view.query.inputValue()).toBe("");
      expect(await view.kind.inputValue()).toBe(await allValue(view));
      await expect.poll(() => visiblePaths(view)).toEqual(allPaths);
      await count(view, 10, 10);
      expect(stableSelection(await snapshot(view))).toEqual(stableSelection(before));
    } finally { await view.context.close(); }
  });

  it.each(["source", "raw"] as const)("filtering in %s mode leaves the selected frame, history and storage untouched and performs zero requests", async mode => {
    const view = await visit({ mode });
    try {
      await kindControl(view);
      const before = await snapshot(view);
      expect(before.frame).toBeTruthy();
      expect(before.selected).toHaveLength(1);
      const requests = view.requests.length;
      const manifestLoads = view.manifestLoads();
      let frameNavigations = 0;
      // Canonical URL replaceState is main-frame same-document navigation, not an iframe reload.
      view.page.on("framenavigated", (frame: any) => { if (frame !== view.page.mainFrame()) frameNavigations++; });
      await view.kind.selectOption("pdf");
      await view.query.fill("REPORT");
      await expect.poll(() => visiblePaths(view)).toEqual(["docs/REPORT.pdf"]);
      await count(view, 1, 10);
      expect(stableSelection(await snapshot(view))).toEqual(stableSelection(before));
      await view.reset.click();
      await count(view, 10, 10);
      await view.page.waitForLoadState("networkidle");
      expect(stableSelection(await snapshot(view))).toEqual(stableSelection(before));
      expect(frameNavigations, "filtering must not reload even the same iframe URL").toBe(0);
      expect(view.requests.slice(requests), "no GET, content read, endpoint call or mutation after manifest load").toEqual([]);
      expect(view.manifestLoads()).toBe(manifestLoads);
      expect(view.external).toEqual([]);
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("selecting a matched file still navigates normally and Back restores the prior file", async () => {
    const view = await visit({ mode: "source" });
    try {
      await kindControl(view);
      await view.kind.selectOption("code");
      await view.query.fill("util");
      await expect.poll(() => visiblePaths(view)).toEqual(["src/util.ts"]);
      const before = await snapshot(view);
      await view.page.locator('a[data-kind="code"]:visible').click();
      await expect.poll(() => new URL(view.page.url()).pathname).toBe(`/v/${slug}/src/util.ts`);
      await expect.poll(async () => (await snapshot(view)).frame).toContain("src/util.ts");
      expect((await snapshot(view)).selected).toHaveLength(1);
      await view.page.goBack();
      await expect.poll(() => view.page.url()).toBe(before.url);
      await expect.poll(async () => (await snapshot(view)).frame).toBe(before.frame);
    } finally { await view.context.close(); }
  });

  it.each([0, 1])("handles a %i-file loaded manifest without inventing kinds or inventory", async size => {
    const rows = size ? mixed.filter(row => row.path === "src/util.ts") : [];
    const view = await visit({ rows });
    try {
      await kindControl(view);
      expect(await view.kind.inputValue()).toBe(await allValue(view));
      await count(view, size, size);
      const values: string[] = await view.kind.locator("option").evaluateAll((options: any[]) => options.map(o => o.value));
      const all = await allValue(view);
      expect(values.filter(value => value !== all).sort()).toEqual(size ? ["code"] : []);
      if (size) {
        await view.kind.selectOption("code");
        await expect.poll(() => visiblePaths(view)).toEqual(["src/util.ts"]);
      }
      await view.query.fill("absent");
      await count(view, 0, size);
      await view.reset.click();
      await count(view, size, size);
    } finally { await view.context.close(); }
  });

  it("supports labelled keyboard controls and focused, non-overflowing filtering on a narrow screen", async () => {
    const view = await visit({ width: 375 });
    try {
      await kindControl(view);
      // Native select receives actual keyboard input, not a synthetic change event.
      await view.kind.focus();
      await view.kind.press("Home");
      const choices: string[] = await view.kind.locator("option").evaluateAll((options: any[]) => options.map(o => o.value));
      const index = choices.indexOf("image");
      expect(index).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < index; i++) await view.kind.press("ArrowDown");
      await view.kind.press("Enter");
      expect(await view.kind.inputValue()).toBe("image");
      expect(await view.kind.evaluate((el: any) => el === (globalThis as any).document.activeElement)).toBe(true);
      await view.query.focus();
      await view.query.pressSequentially("photo");
      await count(view, 2, 10);
      expect(await view.query.evaluate((el: any) => el === (globalThis as any).document.activeElement)).toBe(true);
      for (const control of [view.kind, view.query, view.reset]) {
        const box = await control.boundingBox();
        expect(box).toBeTruthy();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(376);
        expect(box.height).toBeGreaterThan(0);
      }
      await view.reset.focus();
      await view.reset.press("Enter");
      await count(view, 10, 10);
      expect(await view.page.evaluate(() => (globalThis as any).document.activeElement !== (globalThis as any).document.body), "reset must preserve meaningful focus").toBe(true);
      await view.page.reload({ waitUntil: "networkidle" });
      expect(await view.kind.inputValue()).toBe(await allValue(view));
      expect(await view.query.inputValue()).toBe("");
    } finally { await view.context.close(); }
  });

  it("renders hostile filenames as literal text under the real CSP before and after filtering", async () => {
    const view = await visit();
    try {
      const csp = (await view.response.allHeaders())["content-security-policy"];
      expect(csp).toContain("script-src 'self'");
      expect(csp.match(/(?:^|;)\s*script-src[^;]*/)?.[0]).not.toMatch(/unsafe-inline|unsafe-eval/);
      await view.query.fill("onerror");
      await expect.poll(() => visiblePaths(view)).toEqual([hostile]);
      const link = view.page.locator('a[data-kind="text"]:visible');
      expect(await link.innerText()).toContain(hostile);
      expect(await link.locator("img, script, svg").count()).toBe(0);
      expect(await view.page.evaluate(() => (globalThis as any).__treeXss)).toBeUndefined();
      await kindControl(view);
      await view.kind.selectOption("text");
      await count(view, 1, 10);
      await view.reset.click();
      expect(await view.page.locator('a[data-kind="text"] img').count()).toBe(0);
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });

  it.each(["anonymous", "forbidden", "manifest-failed"] as const)("%s access retains its existing boundary without exposing fixture filenames or kind choices", async state => {
    const view = await visit({ state });
    try {
      expect(await view.page.locator("a[data-kind]").count()).toBe(0);
      const body = await view.page.locator("body").innerText();
      for (const path of ["Photo.TXT", "REPORT.pdf", "schema.data", hostile]) expect(body).not.toContain(path);
      expect(await view.page.locator('option[value="cad_mesh_v2"]').count()).toBe(0);
      if (state === "anonymous") expect(await view.page.getByRole("link", { name: /sign in/i }).count()).toBeGreaterThan(0);
      else expect(body).toMatch(state === "forbidden" ? /not authorized|forbidden/i : /unavailable|try again|error/i);
      expect(view.requests.every(request => request.method === "GET"), "the file browser must remain read-only").toBe(true);
      expect(view.external).toEqual([]);
    } finally { await view.context.close(); }
  });
});

// Independent shareable-state acceptance extension. This is a RED handoff, not
// an implementation. The three-kind manifest deliberately reuses this suite's
// real served Worker, classifier-independent inventory and keyboard controls.
const threePaths = ["assets/Photo.TXT", "docs/photo.png", "index.html", "src/nested/report.TXT", "src/util.ts"];
const threeKinds = () => mixed.filter(row => threePaths.includes(row.path));
const viewCopy = (view: View) => view.page.getByRole("button", { name: /^copy browser view link$/i });
const publicCopy = (view: View) => view.page.getByRole("button", { name: /^copy link$/i });
const modeControl = (view: View, name: string) => view.page.getByRole("tab", { name, exact: true }).or(view.page.getByRole("button", { name, exact: true })).or(view.page.getByRole("link", { name, exact: true }));
const effects = (view: View): Promise<{ copies: string[]; innerHTMLWrites: number; intervals: number }> => view.page.evaluate(() => (globalThis as any).__browserViewAcceptance);
const frameText = (view: View): Promise<string> => view.page.frameLocator("iframe").first().locator("body").innerText();

async function canonical(view: View, expected: Record<string, string>) {
  await expect.poll(() => Object.fromEntries(new URL(view.page.url()).searchParams), { message: "canonical URL display state" }).toEqual(expected);
}

async function restored(view: View, expected: { path: string; mode: string; filter: string; kind: string; paths: string[] }) {
  await expect.poll(() => new URL(view.page.url()).pathname).toBe(`/v/${slug}/${expected.path}`);
  await expect.poll(() => view.query.inputValue(), { message: "restore literal path filter from URL, not stale DOM/history objects" }).toBe(expected.filter);
  await expect.poll(() => view.kind.inputValue()).toBe(expected.kind || await allValue(view));
  await expect.poll(() => visiblePaths(view)).toEqual(expected.paths);
  await count(view, expected.paths.length, 5);
  await canonical(view, { ...(expected.mode === "view" ? {} : { mode: expected.mode }), ...(expected.filter ? { filter: expected.filter } : {}), ...(expected.kind ? { kind: expected.kind } : {}) });
  const frame = new URL((await snapshot(view)).frame!, api);
  expect(frame.origin).toBe(sites);
  expect(decodeURIComponent(frame.pathname)).toContain(expected.path);
  expect(frame.searchParams.get("filter")).toBeNull();
  expect(frame.searchParams.get("kind")).toBeNull();
}

// URL allowlists are independent of product URL helpers. Synthetic token values
// are canaries, not real credentials; the signed-in fixture key is never logged.
const unsafeParams = {
  token: "canary-token", claim: "canary-claim", preview: "canary-preview", upload_token: "canary-upload",
  access_token: "canary-access", arbitrary: "canary-arbitrary",
};
function cleanURL(raw: string, allowed: string[]) {
  const url = new URL(raw);
  expect(url.username).toBe(""); expect(url.password).toBe(""); expect(url.hash).toBe("");
  expect([...url.searchParams.keys()].every(name => allowed.includes(name)), "only explicit display parameters may be shared").toBe(true);
  for (const canary of Object.values(unsafeParams)) expect(raw).not.toContain(canary);
  expect(raw).not.toContain("canary-history-object");
  return url;
}

function feedback(view: View, pattern: RegExp) {
  return view.page.locator('[role="status"], [aria-live="polite"], [aria-live="assertive"], [role="alert"]').filter({ hasText: pattern });
}

async function copyControl(view: View) {
  expect(await viewCopy(view).count(), "add a distinct explicit Copy browser view link action; do not replace public Copy link").toBe(1);
  expect(await viewCopy(view).isVisible()).toBe(true);
}

describe("shareable file-browser state lifecycle", () => {
  it("preserves existing tree order, server classifications and loaded-file scope while filtering and clearing", async () => {
    const view = await visit({ rows: threeKinds() });
    try {
      const ordered = () => view.page.locator("a[data-kind]:visible").evaluateAll((links: any[]) => links.map(link => ({
        path: decodeURIComponent(new URL(link.href).pathname.replace(/^\/v\/[^/]+\//, "")), kind: link.dataset.kind,
      })));
      const initial = [
        { path: "assets/Photo.TXT", kind: "image" }, { path: "docs/photo.png", kind: "image" },
        { path: "src/nested/report.TXT", kind: "code" }, { path: "src/util.ts", kind: "code" },
        { path: "index.html", kind: "html" },
      ];
      expect(await ordered()).toEqual(initial);
      const before = await snapshot(view);
      const requests = view.requests.length;
      await view.query.fill("src/"); await view.kind.selectOption("code");
      await expect.poll(ordered).toEqual([{ path: "src/nested/report.TXT", kind: "code" }, { path: "src/util.ts", kind: "code" }]);
      await count(view, 2, 5);
      await view.reset.click(); await expect.poll(ordered).toEqual(initial);
      await count(view, 5, 5);
      expect(stableSelection(await snapshot(view))).toEqual(stableSelection(before));
      expect(view.requests.slice(requests)).toEqual([]);
      expect(await effects(view)).toEqual({ copies: [], innerHTMLWrites: 0, intervals: 0 });
    } finally { await view.context.close(); }
  });

  it("restores an encoded initial URL and reload with matching ancestors, counts and unchanged hidden selected content", async () => {
    const view = await visit({ rows: threeKinds(), path: "src/util.ts", mode: "source", params: { filter: "sRc/NeStEd/REPORT", kind: "code" } });
    try {
      const expected = { path: "src/util.ts", mode: "source", filter: "sRc/NeStEd/REPORT", kind: "code", paths: ["src/nested/report.TXT"] };
      await restored(view, expected);
      expect(await folderVisible(view, "src")).toBe(true);
      expect(await folderVisible(view, "nested")).toBe(true);
      expect(await folderVisible(view, "assets")).toBe(false);
      const before = await snapshot(view);
      const content = await frameText(view);
      expect(content).toContain("export const fixture = 1;");
      const loads = view.manifestLoads();
      await view.page.reload({ waitUntil: "networkidle" });
      await restored(view, expected);
      expect(await frameText(view)).toBe(content);
      expect(stableSelection(await snapshot(view))).toEqual(stableSelection(before));
      expect(view.manifestLoads()).toBe(loads + 1);
    } finally { await view.context.close(); }
  });

  it("replaces each keystroke and kind edit in place without requests, storage, polling, DOM injection or iframe navigation", async () => {
    const view = await visit({ rows: threeKinds(), path: "src/util.ts", mode: "source" });
    try {
      const before = await snapshot(view);
      const content = await frameText(view);
      const calls = view.requests.length;
      const loads = view.manifestLoads();
      let frames = 0;
      view.page.on("framenavigated", (frame: any) => { if (frame !== view.page.mainFrame()) frames++; });
      await view.query.focus();
      for (const [letter, value] of [["P", "P"], ["h", "Ph"], ["O", "PhO"], ["t", "PhOt"], ["O", "PhOtO"]]) {
        await view.query.pressSequentially(letter!);
        await canonical(view, { mode: "source", filter: value! });
        expect((await snapshot(view)).historyLength, "typing must replace, not push per keystroke").toBe(before.historyLength);
      }
      await view.kind.selectOption("image");
      await restored(view, { path: "src/util.ts", mode: "source", filter: "PhOtO", kind: "image", paths: ["assets/Photo.TXT", "docs/photo.png"] });
      expect(stableSelection(await snapshot(view))).toEqual(stableSelection(before));
      expect(await frameText(view)).toBe(content);
      await view.kind.selectOption(await allValue(view));
      await canonical(view, { mode: "source", filter: "PhOtO" });
      await view.query.fill("");
      await canonical(view, { mode: "source" });
      await expect.poll(() => visiblePaths(view)).toEqual(threePaths);
      await view.page.waitForLoadState("networkidle");
      expect(view.requests.slice(calls), "filters are local display state over the one loaded manifest").toEqual([]);
      expect(view.manifestLoads()).toBe(loads);
      expect(frames).toBe(0);
      expect(await effects(view)).toEqual({ copies: [], innerHTMLWrites: 0, intervals: 0 });
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("pushes exactly once for file and mode navigation and restores four independent Back/Forward states from URL", async () => {
    const view = await visit({ rows: threeKinds(), path: "index.html", mode: "source" });
    try {
      await view.query.fill("src/"); await view.kind.selectOption("code");
      const start = await snapshot(view);
      const loads = view.manifestLoads();
      const apiCalls = () => view.requests.filter(request => new URL(request.url).pathname.startsWith("/api/"));
      const loadedCalls = [...apiCalls()];
      const first = { path: "index.html", mode: "source", filter: "src/", kind: "code", paths: ["src/nested/report.TXT", "src/util.ts"] };
      const link = view.page.locator('a[data-kind="code"]:visible').filter({ hasText: "report.TXT" });
      await link.click();
      await expect.poll(() => new URL(view.page.url()).pathname).toBe(`/v/${slug}/src/nested/report.TXT`);
      expect((await snapshot(view)).historyLength, "file selection pushes one entry").toBe(start.historyLength + 1);
      // File-tree navigation keeps the existing Rendered default; only filters persist.
      await canonical(view, { filter: "src/", kind: "code" });
      expect(await modeControl(view, "Rendered").getAttribute("aria-selected")).toBe("true");
      await view.query.fill("REPORT");
      const second = { path: "src/nested/report.TXT", mode: "view", filter: "REPORT", kind: "code", paths: ["src/nested/report.TXT"] };
      await restored(view, second);
      const rendered = (await snapshot(view)).frame;
      await modeControl(view, "Raw").click();
      await expect.poll(() => new URL(view.page.url()).searchParams.get("mode")).toBe("raw");
      expect((await snapshot(view)).historyLength, "mode selection pushes one entry").toBe(start.historyLength + 2);
      await canonical(view, { mode: "raw", filter: "REPORT", kind: "code" });
      const raw = (await snapshot(view)).frame;
      expect(raw).not.toBe(rendered);
      await expect.poll(() => frameText(view)).toBe("const example = true;");
      await view.query.fill("no-such-path"); await view.kind.selectOption("image");
      const third = { path: "src/nested/report.TXT", mode: "raw", filter: "no-such-path", kind: "image", paths: [] };
      await restored(view, third);
      await view.page.goBack(); await restored(view, second);
      expect((await snapshot(view)).frame).toBe(rendered);
      await view.page.goBack(); await restored(view, first);
      expect(await frameText(view)).toContain("Selected fixture frame");
      await view.page.goForward(); await restored(view, second);
      await view.page.goForward(); await restored(view, third);
      expect((await snapshot(view)).frame).toBe(raw);
      await expect.poll(() => frameText(view)).toBe("const example = true;");
      expect((await snapshot(view)).historyLength).toBe(start.historyLength + 2);
      expect(view.manifestLoads(), "file/mode/history must reuse loaded inventory").toBe(loads);
      expect(apiCalls(), "navigation/history must not introduce an endpoint or refetch metadata").toEqual(loadedCalls);
    } finally { await view.context.close(); }
  });

  it("Clear removes only filter and kind, restoring All without replacing a hidden current file or raw mode", async () => {
    const view = await visit({ rows: threeKinds(), path: "src/util.ts", mode: "raw", params: { filter: "photo", kind: "image", campaign: "keep-this" } });
    try {
      const before = await snapshot(view);
      const content = await frameText(view);
      const requests = view.requests.length;
      await view.reset.click();
      await canonical(view, { mode: "raw", campaign: "keep-this" });
      expect(await view.query.inputValue()).toBe("");
      expect(await view.kind.inputValue()).toBe(await allValue(view));
      await expect.poll(() => visiblePaths(view)).toEqual(threePaths);
      await count(view, 5, 5);
      expect(new URL(view.page.url()).pathname).toBe(`/v/${slug}/src/util.ts`);
      expect((await snapshot(view)).historyLength).toBe(before.historyLength);
      expect((await snapshot(view)).frame).toBe(before.frame);
      expect(await frameText(view)).toBe(content);
      expect(view.requests.slice(requests)).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("normalizes unknown kind and empty defaults out of the URL without changing inventory or selected content", async () => {
    const view = await visit({ rows: threeKinds(), path: "src/util.ts", mode: "source", params: { kind: "not-a-loaded-kind", filter: "" } });
    try {
      await restored(view, { path: "src/util.ts", mode: "source", filter: "", kind: "", paths: threePaths });
      expect(await frameText(view)).toContain("export const fixture = 1;");
      await view.kind.selectOption("code");
      await canonical(view, { mode: "source", kind: "code" });
      await view.kind.selectOption(await allValue(view));
      await canonical(view, { mode: "source" });
    } finally { await view.context.close(); }
  });

  it("decodes Unicode, plus, percent escapes and hostile punctuation exactly once and matches them literally, never as regex or markup", async () => {
    const literal = 'Ω +%2F&?#.[x](a)*"><img onerror=globalThis.__treeXss=1>';
    const path = `src/nested/${literal}.TXT`;
    const rows = threeKinds().map(row => row.path === "src/nested/report.TXT" ? { ...row, path } : row);
    const view = await visit({ rows, path: "src/util.ts", mode: "source", params: { filter: literal, kind: "code" } });
    try {
      await expect.poll(() => view.query.inputValue()).toBe(literal);
      await expect.poll(() => visiblePaths(view)).toEqual([path]);
      await count(view, 1, 5);
      await canonical(view, { mode: "source", filter: literal, kind: "code" });
      expect(await folderVisible(view, "src")).toBe(true);
      expect(await folderVisible(view, "nested")).toBe(true);
      expect(await view.page.locator('a[data-kind]:visible img, a[data-kind]:visible script').count()).toBe(0);
      expect(await view.page.evaluate(() => (globalThis as any).__treeXss)).toBeUndefined();
      await view.query.fill(".*");
      await expect.poll(() => visiblePaths(view)).toEqual([]);
      await canonical(view, { mode: "source", filter: ".*", kind: "code" });
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("preserves the existing explicit Copy link as a clean public file URL even with browser filters and token canaries", async () => {
    const view = await visit({ rows: threeKinds(), path: "src/util.ts", mode: "source", params: { filter: "photo", kind: "image", ...unsafeParams } });
    try {
      const before = await snapshot(view);
      const requests = view.requests.length;
      expect((await effects(view)).copies).toEqual([]);
      await publicCopy(view).click();
      await expect.poll(async () => (await effects(view)).copies.length).toBe(1);
      const url = cleanURL((await effects(view)).copies[0]!, []);
      expect(url.origin).toBe(sites);
      expect(url.pathname).toBe(`/${slug}/src/util.ts`);
      expect(await snapshot(view)).toEqual(before);
      expect(view.requests.slice(requests)).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("explicitly copies a whitelisted browser-view URL and keeps Copy link a clean public file URL", async () => {
    const view = await visit({ rows: threeKinds(), path: "src/util.ts", mode: "source", params: { filter: "src/ +%2F Ω &?#", kind: "code", ...unsafeParams } });
    try {
      await copyControl(view);
      const requests = view.requests.length;
      await view.page.evaluate(() => {
        const g = globalThis as any;
        g.history.replaceState({ extra: "canary-history-object" }, "", `${g.location.href}#do-not-copy`);
      });
      expect((await effects(view)).copies, "opening or editing a view must never copy automatically").toEqual([]);
      const explanation = await view.page.locator("body").innerText();
      expect(explanation).toMatch(/(?:does not|doesn't|won't) grant (?:\w+ )?access|grants? no (?:\w+ )?access|no (?:additional )?access/i);
      expect(explanation).toMatch(/filter.{0,100}(?:text|literal|included|contains)|(?:contains|includes).{0,100}filter/i);
      await viewCopy(view).click();
      await expect.poll(async () => (await effects(view)).copies.length).toBe(1);
      const browserURL = cleanURL((await effects(view)).copies[0]!, ["mode", "filter", "kind"]);
      expect(browserURL.origin).toBe(api);
      expect(browserURL.pathname).toBe(`/v/${slug}/src/util.ts`);
      expect(Object.fromEntries(browserURL.searchParams)).toEqual({ mode: "source", filter: "src/ +%2F Ω &?#", kind: "code" });
      await expect.poll(() => feedback(view, /copied/i).count()).toBeGreaterThan(0);
      await publicCopy(view).click();
      await expect.poll(async () => (await effects(view)).copies.length).toBe(2);
      const publicURL = cleanURL((await effects(view)).copies[1]!, []);
      expect(publicURL.origin).toBe(sites);
      expect(publicURL.pathname).toBe(`/${slug}/src/util.ts`);
      expect(view.requests.slice(requests)).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("omits empty/default display parameters when explicitly copying the unfiltered browser view", async () => {
    const view = await visit({ rows: threeKinds() });
    try {
      await copyControl(view);
      await viewCopy(view).click();
      await expect.poll(async () => (await effects(view)).copies.length).toBe(1);
      const url = cleanURL((await effects(view)).copies[0]!, []);
      expect(url.origin).toBe(api);
      expect(url.pathname).toBe(`/v/${slug}/index.html`);
    } finally { await view.context.close(); }
  });

  it("reports clipboard rejection truthfully without navigating, automatic retries or false copied feedback", async () => {
    const view = await visit({ rows: threeKinds(), clipboard: "rejected", params: { filter: "photo", kind: "image" } });
    try {
      await copyControl(view);
      const before = await snapshot(view);
      const requests = view.requests.length;
      view.page.on("dialog", (dialog: any) => dialog.dismiss());
      await viewCopy(view).click();
      await expect.poll(async () => (await effects(view)).copies.length).toBe(1);
      await expect.poll(() => feedback(view, /could not|couldn't|unable|failed|denied|not copied|copy manually/i).count()).toBeGreaterThan(0);
      expect(await feedback(view, /^\s*(?:link )?copied[!.]?\s*$/i).count()).toBe(0);
      expect(await snapshot(view)).toEqual(before);
      expect(view.requests.slice(requests)).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("keeps source/raw/download bytes and split-origin sandbox/CSP isolated from browser filters and token canaries", async () => {
    const view = await visit({ rows: threeKinds(), path: "src/util.ts", mode: "source", params: { filter: "photo", kind: "image", ...unsafeParams } });
    try {
      const csp = (await view.response.allHeaders())["content-security-policy"];
      expect(csp).toContain("script-src 'self'");
      expect(csp.match(/(?:^|;)\s*script-src[^;]*/)?.[0]).not.toMatch(/unsafe-inline|unsafe-eval/);
      expect(csp).toContain(sites);
      const frame = await snapshot(view);
      expect(frame.sandbox).toContain("allow-same-origin");
      expect(new URL(frame.frame!, api).origin).toBe(sites);
      expect(await frameText(view)).toContain("export const fixture = 1;");
      await modeControl(view, "Raw").click();
      await expect.poll(() => new URL(view.page.url()).searchParams.get("mode")).toBe("raw");
      await expect.poll(() => frameText(view)).toBe("export const fixture = 1;");
      const download = view.page.waitForEvent("download");
      await view.page.getByRole("button", { name: /^download$/i }).or(view.page.getByRole("link", { name: /^download$/i })).click();
      const file = await download;
      expect(await file.failure()).toBeNull();
      const stream = await file.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString("utf8")).toBe("export const fixture = 1;");
      for (const request of view.requests.filter(request => new URL(request.url).origin === sites || new URL(request.url).pathname.startsWith("/api/"))) {
        expect(request.method).toBe("GET");
        cleanURL(request.url, ["view", "raw", "download", "embed", "limit"]);
      }
      expect(view.external).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("supports narrow-screen keyboard filtering, explicit copying and Clear with meaningful retained focus", async () => {
    const view = await visit({ rows: threeKinds(), width: 375, path: "src/util.ts", mode: "source" });
    try {
      await copyControl(view);
      const before = await snapshot(view);
      await view.query.focus(); await view.query.pressSequentially("photo");
      expect(await view.query.evaluate((el: any) => el === (globalThis as any).document.activeElement)).toBe(true);
      await view.kind.focus(); await view.kind.press("Home");
      const choices: string[] = await view.kind.locator("option").evaluateAll((options: any[]) => options.map(o => o.value));
      const index = choices.indexOf("image");
      expect(index).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < index; i++) await view.kind.press("ArrowDown");
      await view.kind.press("Enter");
      await restored(view, { path: "src/util.ts", mode: "source", filter: "photo", kind: "image", paths: ["assets/Photo.TXT", "docs/photo.png"] });
      for (const control of [view.query, view.kind, view.reset, viewCopy(view), publicCopy(view)]) {
        const box = await control.boundingBox();
        expect(box).toBeTruthy(); expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(376); expect(box.height).toBeGreaterThan(0);
      }
      await viewCopy(view).focus(); await viewCopy(view).press("Enter");
      await expect.poll(async () => (await effects(view)).copies.length).toBe(1);
      expect(await viewCopy(view).evaluate((el: any) => el === (globalThis as any).document.activeElement)).toBe(true);
      await viewCopy(view).press("Space");
      await expect.poll(async () => (await effects(view)).copies.length).toBe(2);
      await view.reset.focus(); await view.reset.press("Enter");
      await canonical(view, { mode: "source" }); await count(view, 5, 5);
      expect(await view.page.evaluate(() => (globalThis as any).document.activeElement !== (globalThis as any).document.body)).toBe(true);
      expect((await snapshot(view)).frame).toBe(before.frame);
      expect((await snapshot(view)).historyLength).toBe(before.historyLength);
    } finally { await view.context.close(); }
  });

  it.each(["anonymous", "forbidden", "manifest-failed"] as const)("a shared URL never bypasses %s access or causes mutation", async state => {
    const view = await visit({ rows: threeKinds(), state, params: { filter: "src/", kind: "code" } });
    try {
      expect(await view.page.locator("a[data-kind]").count()).toBe(0);
      const body = await view.page.locator("body").innerText();
      expect(body).not.toContain("report.TXT"); expect(body).not.toContain("util.ts");
      expect(view.requests.every(request => request.method === "GET")).toBe(true);
      if (state === "anonymous") {
        const signin = view.page.getByRole("link", { name: /sign in/i }).first();
        const href = new URL(await signin.getAttribute("href"), api);
        expect(href.origin).toBe(api);
        expect(href.pathname).toBe("/login");
        expect([...href.searchParams.keys()].every(name => name === "next")).toBe(true);
        const next = href.searchParams.get("next");
        if (next) expect(new URL(next, api).origin).toBe(api);
      }
      expect(view.external).toEqual([]);
    } finally { await view.context.close(); }
  });
});
