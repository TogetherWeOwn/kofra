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
type Options = { rows?: Row[]; state?: "anonymous" | "forbidden" | "manifest-failed"; width?: number; mode?: "source" | "raw" };
let browser: any;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let work: string;
let api: string;
let key: string;
let slug: string;
let manifest: Record<string, any>;
let mixed: Row[];

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "tree-kind-acceptance-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-tree-kind-acceptance", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "tree-kind-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "tree-kind-acceptance-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config,
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: "local-tree-kind-bootstrap-fixture-only" } },
  });
  await worker.ready;
  api = (await worker.url).origin;
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
  const requests: { method: string; url: string }[] = [];
  const external: string[] = [];
  const errors: string[] = [];
  let manifestLoads = 0;
  await context.route("**/*", async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ method: request.method(), url: request.url() });
    if (url.origin !== api) { external.push(url.origin); return route.abort("blockedbyclient"); }
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
  const path = options.state ? "" : "index.html";
  const target = `/v/${slug}/${path}${options.mode ? `?mode=${options.mode}` : ""}`;
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
      expect(await snapshot(view)).toEqual(before);
      await view.query.fill("");
      await expect.poll(() => visiblePaths(view)).toEqual(allPaths);
      await view.page.waitForLoadState("networkidle");
      expect(await snapshot(view)).toEqual(before);
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
      expect(await snapshot(view)).toEqual(before);
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
      view.page.on("framenavigated", () => frameNavigations++);
      await view.kind.selectOption("pdf");
      await view.query.fill("REPORT");
      await expect.poll(() => visiblePaths(view)).toEqual(["docs/REPORT.pdf"]);
      await count(view, 1, 10);
      expect(await snapshot(view)).toEqual(before);
      await view.reset.click();
      await count(view, 10, 10);
      await view.page.waitForLoadState("networkidle");
      expect(await snapshot(view)).toEqual(before);
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
