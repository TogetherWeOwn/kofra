/** Dashboard-only manifest checksum acceptance. Run with test:cli; never against a remote instance. */
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
import type { Browser, BrowserContext, Locator, Page, Route } from "playwright";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const bootstrap = "manifest-checksum-disposable-bootstrap-0123456789";
const slug = "manifest-checksum-fixture";
const dangerousPath = 'notes/<img src=x onerror=alert(1)>.txt';
const contents = [
  { "left/report.txt": "first exact artifact\n", "right/report.txt": "another basename\n", [dangerousPath]: "literal filename\n" },
  { "left/report.txt": "second exact artifact\n".repeat(83), "right/report.txt": "different second file\n", [dangerousPath]: "literal filename\n" },
];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const expected = contents.map(files => Object.entries(files).map(([path, text]) => ({ path, sha256: digest(text), size: Buffer.byteLength(text), text })));
let work: string;
let origin: string;
let ownerKey: string;
let browser: Browser;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let versions: Array<{ id: string; number: number }>;
let manifest: any[];

type Wire = { method: string; url: string };
type View = { context: BrowserContext; page: Page; wire: Wire[]; csp: string; consoleErrors: string[] };

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
  const body: any = await response.json();
  expect(response.ok, `disposable fixture API ${path}: ${response.status} ${JSON.stringify(body)}`).toBe(true);
  return body;
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "manifest-checksum-"));
  origin = `http://127.0.0.1:${await port()}`;
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-manifest-checksum-test", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: origin, SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "manifest-checksum", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "manifest-checksum-files" }], kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config, dev: { server: { hostname: "127.0.0.1", port: Number(new URL(origin).port) }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  const setup = await api("/api/v1/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "checksum@example.com" }) }, bootstrap);
  ownerKey = setup.apiKey.key;
  versions = [];
  for (const files of contents) {
    const form = new FormData();
    form.set("slug", slug);
    for (const [path, text] of Object.entries(files)) form.append(path, new File([text], path.split("/").pop()!));
    const published = await api("/api/v1/publish", { method: "POST", body: form });
    versions.push(published.version);
  }
  manifest = await Promise.all(versions.map(version => api(`/api/v1/sites/${slug}/files?version=${version.id}`)));
  // The oracle is independent Node crypto over fixture bytes, not the server's hash helper.
  for (let i = 0; i < manifest.length; i++) {
    expect(manifest[i].version.id).toBe(versions[i]!.id);
    expect(manifest[i].files).toEqual(expect.arrayContaining(expected[i]!.map(({ path, sha256, size }) => expect.objectContaining({ path, sha256, size }))));
  }
  await api("/api/v1/sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "manifest-empty-fixture" }) });
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function visit(options: { route?: (route: Route) => Promise<void>; clipboard?: "success" | "rejected" | "unavailable"; anonymous?: boolean; mobile?: boolean; site?: string } = {}): Promise<View> {
  const context = await browser.newContext({ viewport: options.mobile ? { width: 360, height: 800 } : { width: 1100, height: 900 } });
  await context.addInitScript(({ clipboard }) => {
    const page = globalThis as any;
    const document = page.document;
    const state = { writes: [] as string[], prompts: [] as string[], alerts: [] as string[] };
    page.__manifestAcceptance = state;
    page.alert = (text: unknown) => { state.alerts.push(String(text)); };
    page.prompt = (_message: unknown, value?: string) => { state.prompts.push(value ?? ""); return null; };
    if (clipboard !== "success") {
      const original = document.execCommand.bind(document);
      document.execCommand = (command: string, ...args: unknown[]) => command.toLowerCase() === "copy" ? false : original(command, ...args);
    }
    Object.defineProperty(page.navigator, "clipboard", { configurable: true, value: clipboard === "unavailable" ? undefined : {
      writeText: async (text: string) => {
        state.writes.push(text);
        if (clipboard === "rejected") throw new DOMException("Clipboard denied", "NotAllowedError");
      },
    } });
  }, { clipboard: options.clipboard ?? "success" });
  const wire: Wire[] = [];
  await context.route("**/*", async route => {
    const request = route.request();
    wire.push({ method: request.method(), url: request.url() });
    if (new URL(request.url()).origin !== origin) return route.abort("blockedbyclient");
    if (options.route) return options.route(route);
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  const consoleErrors: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto(`${origin}/login`, { waitUntil: "networkidle" });
  if (!options.anonymous) {
    await page.getByLabel(/api key/i).fill(ownerKey);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL("**/dashboard");
  }
  const response = await page.goto(`${origin}/dashboard/sites/${options.site ?? slug}`, { waitUntil: "networkidle" });
  const csp = response!.headers()["content-security-policy"] ?? "";
  expect(wire.filter(request => request.method !== "GET"), "dashboard bootstrap is read-only").toEqual([]);
  expect(wire.filter(request => new URL(request.url).pathname.startsWith(`/api/v1/sites/${slug}/files/`) || isArtifactPath(new URL(request.url).pathname)), "opening the dashboard must not prefetch artifact bytes").toEqual([]);
  wire.length = 0; // Assertions below observe the explicit selection, not dashboard bootstrap.
  return { context, page, wire, csp, consoleErrors };
}

/** Site content served under /s/. The embed snippet's own badge image is first-party chrome, not an artifact read (SITE-BADGE). */
function isArtifactPath(pathname: string): boolean {
  return pathname.startsWith("/s/") && !/^\/s\/[^/]+\/badge\.svg$/.test(pathname);
}

function versionRow(page: Page, number: number) {
  return page.getByRole("row").filter({ hasText: new RegExp(`\\bv${number}\\b`) });
}
async function select(page: Page, number: number) {
  await versionRow(page, number).getByRole("button", { name: /^files$/i }).click();
}
function fileRequests(wire: Wire[]) {
  return wire.filter(request => new URL(request.url).pathname === `/api/v1/sites/${slug}/files`);
}
function checksumButton(page: Page) {
  return page.getByRole("button", { name: /copy sha-?256/i });
}
async function state(page: Page): Promise<{ writes: string[]; prompts: string[]; alerts: string[] }> {
  return page.evaluate(() => (globalThis as any).__manifestAcceptance);
}
async function metadata(locator: Locator) {
  return locator.evaluate(element => {
    const node = element as any;
    const fields = Array.from(node.querySelectorAll("input, textarea")) as Array<{ value: string; getBoundingClientRect(): { width: number } }>;
    return [node.innerText, ...fields.filter(field => field.getBoundingClientRect().width > 0).map(field => field.value)].join("\n");
  });
}
async function hasDigest(page: Page, sha256: string) {
  await expect.poll(() => metadata(panel(page)), { timeout: 3000 }).toContain(sha256);
}

it.each([1, 2])("pins a selected v%i manifest request to its immutable ID, including a live row", async number => {
  const view = await visit();
  try {
    await select(view.page, number);
    await expect.poll(() => fileRequests(view.wire).length).toBe(1);
    const request = new URL(fileRequests(view.wire)[0]!.url);
    expect(request.searchParams.get("version"), "never resolve a selected live row through the moving live pointer").toBe(versions[number - 1]!.id);
    await hasDigest(view.page, expected[number - 1]![0]!.sha256);
    expect(await metadata(panel(view.page))).toContain(versions[number - 1]!.id);
    expect(await panel(view.page).getByRole("heading").innerText()).toMatch(new RegExp(`\\bv${number}\\b`));
    metadataOnly(view.wire);
  } finally { await view.context.close(); }
});

function panel(page: Page) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: /files in/i }) });
}
function fileRow(page: Page, path: string) {
  return panel(page).getByRole("row").filter({ hasText: path });
}
function announcements(page: Page) {
  return page.locator('[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]');
}
function isManifest(route: Route) {
  return new URL(route.request().url()).pathname === `/api/v1/sites/${slug}/files`;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    const frame = (globalThis as any).requestAnimationFrame;
    frame(() => frame(() => resolve()));
  }));
}
function metadataOnly(wire: Wire[]) {
  expect(wire.filter(request => request.method !== "GET"), "viewing/copying checksums must not mutate anything").toEqual([]);
  expect(wire.filter(request => new URL(request.url).pathname.startsWith(`/api/v1/sites/${slug}/files/`)), "no content request merely to display or copy a digest").toEqual([]);
  expect(wire.filter(request => isArtifactPath(new URL(request.url).pathname)), "Open links remain links, not background verification requests").toEqual([]);
  expect(wire.filter(request => new URL(request.url).pathname.startsWith("/api/")).every(request => isManifestUrl(request.url)), "the manifest remains the only metadata source; no second export endpoint").toBe(true);
}
function isManifestUrl(url: string) {
  return new URL(url).pathname === `/api/v1/sites/${slug}/files`;
}

it("uses response identity, exact byte size, path and checksum as one association, not the clicked row label", async () => {
  let armed = false;
  const view = await visit({ route: async route => {
    if (armed && isManifest(route)) return route.fulfill({ json: manifest[1] });
    return route.continue();
  } });
  try {
    armed = true;
    await select(view.page, 1);
    await expect.poll(() => metadata(panel(view.page))).toContain(versions[1]!.id);
    expect(await panel(view.page).getByRole("heading").innerText()).toMatch(/\bv2\b/);
    for (const file of expected[1]!) {
      const row = fileRow(view.page, file.path);
      expect(await metadata(row)).toContain(file.sha256);
      const numericText = (await row.innerText()).replace(/[,  ]/g, "");
      expect(numericText, `exact bytes for ${file.path}, not only a rounded KB value`).toMatch(new RegExp(`\\b${file.size}\\s*(?:bytes?|B)\\b`, "i"));
      await row.getByRole("button", { name: /copy sha-?256/i }).click();
      expect((await state(view.page)).writes.at(-1)).toBe(file.sha256);
    }
    expect((await state(view.page)).writes).toEqual(expected[1]!.map(file => file.sha256));
    metadataOnly(view.wire);
  } finally { await view.context.close(); }
});

it.each(["success", "error"])("ignores a slower v1 %s after v2 has won the selection", async completion => {
  const entered = deferred();
  const release = deferred();
  const settled = deferred();
  const newerServed = deferred();
  let armed = false;
  const view = await visit({ route: async route => {
    if (!armed || !isManifest(route)) return route.continue();
    if (new URL(route.request().url()).searchParams.get("version") !== versions[0]!.id) {
      await route.fulfill({ json: manifest[1] });
      newerServed.resolve();
      return;
    }
    entered.resolve();
    await release.promise;
    try {
      if (completion === "error") await route.fulfill({ status: 503, json: { error: { code: "temporarily_unavailable", message: "Earlier manifest failed", hint: "Retry later." } } });
      else await route.fulfill({ json: manifest[0] });
    } finally { settled.resolve(); }
  } });
  try {
    armed = true;
    await select(view.page, 1);
    await entered.promise;
    await select(view.page, 2);
    await newerServed.promise;
    await flush(view.page);
    await expect.poll(() => panel(view.page).getByRole("heading").innerText()).toMatch(/\bv2\b/);
    release.resolve();
    await settled.promise;
    await flush(view.page);
    expect(await panel(view.page).getByRole("heading").innerText(), "late completion must not replace the latest selected version").toMatch(/\bv2\b/);
    await hasDigest(view.page, expected[1]![0]!.sha256);
    expect(await metadata(panel(view.page))).toContain(versions[1]!.id);
    expect(await metadata(panel(view.page))).not.toContain(expected[0]![0]!.sha256);
    expect(await view.page.locator("body").innerText()).not.toContain("Earlier manifest failed");
    await fileRow(view.page, "left/report.txt").getByRole("button", { name: /copy sha-?256/i }).click();
    expect((await state(view.page)).writes).toEqual([expected[1]![0]!.sha256]);
    metadataOnly(view.wire);
  } finally { release.resolve(); await view.context.close(); }
});

it("never leaves the previous version's enabled copy target attached to a newly pending selection", async () => {
  const entered = deferred();
  const release = deferred();
  let armed = false;
  const view = await visit({ route: async route => {
    if (armed && isManifest(route)) { entered.resolve(); await release.promise; return route.fulfill({ json: manifest[1] }); }
    return route.continue();
  } });
  try {
    await select(view.page, 1);
    await hasDigest(view.page, expected[0]![0]!.sha256);
    armed = true;
    await select(view.page, 2);
    await entered.promise;
    expect(await checksumButton(view.page).filter({ visible: true }).count() === 0 || await checksumButton(view.page).evaluateAll(buttons => buttons.every(button => (button as any).disabled)), "hide or disable stale copy actions while a different manifest is pending").toBe(true);
    release.resolve();
    await hasDigest(view.page, expected[1]![0]!.sha256);
    await fileRow(view.page, "left/report.txt").getByRole("button", { name: /copy sha-?256/i }).click();
    expect((await state(view.page)).writes).toEqual([expected[1]![0]!.sha256]);
  } finally { release.resolve(); await view.context.close(); }
});

it("keeps a live-row snapshot bound to v2 even if the real local live pointer moves to v1 before retrieval", async () => {
  const entered = deferred();
  const release = deferred();
  let armed = false;
  const view = await visit({ route: async route => {
    if (armed && isManifest(route)) { entered.resolve(); await release.promise; }
    return route.continue();
  } });
  try {
    armed = true;
    await select(view.page, 2);
    await entered.promise;
    await api(`/api/v1/sites/${slug}/versions/${versions[0]!.id}/restore`, { method: "POST" });
    release.resolve();
    await expect.poll(() => metadata(panel(view.page))).toContain(expected[1]![0]!.path);
    expect(new URL(fileRequests(view.wire)[0]!.url).searchParams.get("version")).toBe(versions[1]!.id);
    await hasDigest(view.page, expected[1]![0]!.sha256);
    expect(await metadata(panel(view.page))).toContain(versions[1]!.id);
    expect(await metadata(panel(view.page))).not.toContain(expected[0]![0]!.sha256);
    expect(await view.page.getByRole("link", { name: /^open site$/i }).getAttribute("href")).toBe(`${origin}/s/${slug}/`);
    metadataOnly(view.wire);
  } finally {
    release.resolve();
    await view.context.close();
    await api(`/api/v1/sites/${slug}/versions/${versions[1]!.id}/restore`, { method: "POST" });
  }
});

it("copies only the requested full digest by keyboard, keeps focus and announces actual success", async () => {
  const view = await visit();
  try {
    await select(view.page, 1);
    const copy = fileRow(view.page, "left/report.txt").getByRole("button", { name: /copy sha-?256/i });
    await expect.poll(() => copy.count()).toBe(1);
    expect((await state(view.page)).writes, "no automatic clipboard write on load/selection").toEqual([]);
    await copy.focus();
    await view.page.keyboard.press("Enter");
    await expect.poll(async () => (await state(view.page)).writes).toEqual([expected[0]![0]!.sha256]);
    await expect.poll(() => announcements(view.page).allTextContents()).toEqual(expect.arrayContaining([expect.stringMatching(/copied/i)]));
    expect(await fileRow(view.page, "left/report.txt").evaluate(row => {
      const active = (globalThis as any).document.activeElement;
      return row.contains(active) && active?.tagName === "BUTTON" && /copy|copied|sha.?256/i.test(active.getAttribute("aria-label") ?? active.textContent ?? "");
    }), "copy must not lose the keyboard focus (even when its label changes)").toBe(true);
    await view.page.keyboard.press("Space");
    await expect.poll(async () => (await state(view.page)).writes).toEqual([expected[0]![0]!.sha256, expected[0]![0]!.sha256]);
    metadataOnly(view.wire);
  } finally { await view.context.close(); }
});

it.each(["rejected", "unavailable"] as const)("offers the exact manual copy fallback without claiming success when clipboard is %s", async clipboard => {
  const view = await visit({ clipboard });
  try {
    await select(view.page, 1);
    const copy = fileRow(view.page, "right/report.txt").getByRole("button", { name: /copy sha-?256/i });
    await copy.click();
    await flush(view.page);
    const observed = await state(view.page);
    expect(observed.writes).toEqual(clipboard === "rejected" ? [expected[0]![1]!.sha256] : []);
    await hasDigest(view.page, expected[0]![1]!.sha256);
    const feedback = (await announcements(view.page).allTextContents()).join("\n");
    expect(feedback, "a rejected/unavailable clipboard never succeeded").not.toMatch(/\bcopied\b/i);
    expect(feedback, "failure/manual-copy instructions must be announced").toMatch(/(?:fail|unable|could not|cannot|unavailable|manual|select|copy.*yourself)/i);
    expect(observed.prompts.every(value => value === expected[0]![1]!.sha256), "a prompt fallback must offer the full selected checksum, not a URL or abbreviated digest").toBe(true);
    metadataOnly(view.wire);
  } finally { await view.context.close(); }
});

it("keeps every digest selectable and fully available on a narrow screen, with honest manifest-only framing", async () => {
  const view = await visit({ mobile: true });
  try {
    await select(view.page, 1);
    await hasDigest(view.page, expected[0]![0]!.sha256);
    for (const file of expected[0]!) {
      const selected = await fileRow(view.page, file.path).evaluate((row, sha256) => {
        const { document, window, HTMLInputElement, HTMLTextAreaElement, getComputedStyle } = globalThis as any;
        const elements = Array.from(row.querySelectorAll("*")) as any[];
        const element = elements.find(el =>
          (el.textContent === sha256 || el.value === sha256) && el.getBoundingClientRect().width > 0);
        if (!element) return null;
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) { element.select(); return element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0); }
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        return getComputedStyle(element).userSelect === "none" ? null : selection.toString();
      }, file.sha256);
      expect(selected, "all 64 characters remain selectable, not just an ellipsis or title tooltip").toBe(file.sha256);
    }
    expect(await view.page.evaluate(() => {
      const window = globalThis as any;
      return window.document.documentElement.scrollWidth <= window.innerWidth + 1;
    }), "metadata must not force the whole page to a wide table").toBe(true);
    const text = await metadata(panel(view.page));
    expect(text).toMatch(/manifest/i);
    expect(text).toMatch(/checksum/i);
    expect(text).toMatch(/(?:not|doesn.t|does not)[\s\S]*(?:authentic|provenance|safe|verif|live|download)/i);
    expect(text).toMatch(/trusted[\s\S]*(?:source|compar)|(?:source|compar)[\s\S]*trusted/i);
    expect(text).not.toMatch(/\b(?:verified safe|malware[- ]free|independently verified|authenticity verified)\b/i);
    metadataOnly(view.wire);
  } finally { await view.context.close(); }
});

it("preserves directory-prefix filtering and literal hostile paths without changing any copy associations", async () => {
  const view = await visit();
  try {
    await select(view.page, 1);
    await expect.poll(() => fileRow(view.page, dangerousPath).count()).toBe(1);
    expect(await fileRow(view.page, dangerousPath).innerText()).toContain(dangerousPath);
    expect(await panel(view.page).locator("img, script").count()).toBe(0);
    expect((await state(view.page)).alerts).toEqual([]);
    const filter = panel(view.page).getByRole("textbox", { name: /filter/i }).or(panel(view.page).getByPlaceholder(/filter/i));
    await filter.fill("right/");
    await expect.poll(() => fileRow(view.page, "left/report.txt").isVisible()).toBe(false);
    expect(await fileRow(view.page, "right/report.txt").isVisible()).toBe(true);
    await fileRow(view.page, "right/report.txt").getByRole("button", { name: /copy sha-?256/i }).click();
    expect((await state(view.page)).writes).toEqual([expected[0]![1]!.sha256]);
    await filter.fill("nothing-matches/");
    expect(await checksumButton(view.page).filter({ visible: true }).count()).toBe(0);
    await filter.fill("");
    await expect.poll(() => fileRow(view.page, "left/report.txt").isVisible()).toBe(true);
    metadataOnly(view.wire);
  } finally { await view.context.close(); }
});

it("preserves explicit historical downloads without fetching content to display metadata", async () => {
  const view = await visit();
  try {
    await select(view.page, 1);
    await expect.poll(() => fileRow(view.page, "left/report.txt").count()).toBe(1);
    metadataOnly(view.wire);
    const downloadEvent = view.page.waitForEvent("download");
    await fileRow(view.page, "left/report.txt").getByRole("button", { name: /^download$/i }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("report.txt");
    expect(await readFile((await download.path())!, "utf8")).toBe(contents[0]!["left/report.txt"]);
    const content = view.wire.filter(request => new URL(request.url).pathname === `/api/v1/sites/${slug}/files/left/report.txt`);
    expect(content).toHaveLength(1);
    expect(new URL(content[0]!.url).searchParams.get("version")).toBe(versions[0]!.id);
  } finally { await view.context.close(); }
});

it.each([403, 503])("clears stale manifest/checksum actions and shows an honest error on HTTP %i", async status => {
  let armed = false;
  const view = await visit({ route: async route => {
    if (armed && isManifest(route)) return route.fulfill({ status, json: { error: { code: status === 403 ? "forbidden" : "temporarily_unavailable", message: "Selected manifest is unavailable", hint: "Check read access or retry later." } } });
    return route.continue();
  } });
  try {
    armed = true;
    await select(view.page, 1);
    await expect.poll(() => view.page.locator("body").innerText()).toContain("Selected manifest is unavailable");
    expect(await checksumButton(view.page).filter({ visible: true }).count()).toBe(0);
    expect(await view.page.locator("body").innerText()).not.toContain(expected[1]![0]!.sha256);
    expect((await state(view.page)).writes).toEqual([]);
    metadataOnly(view.wire);
  } finally { await view.context.close(); }
});

it("does not manufacture a manifest identity or checksum for a site with no live version", async () => {
  const view = await visit({ site: "manifest-empty-fixture" });
  try {
    expect(await versionRow(view.page, 1).count()).toBe(0);
    expect(await checksumButton(view.page).count()).toBe(0);
    const text = await view.page.locator("body").innerText();
    expect(text).toMatch(/no (?:versions|files|deploy|live)|nothing published|not (?:published|live)|publish.*first/i);
    expect(text).not.toMatch(/\b[a-f0-9]{64}\b/);
    expect((await state(view.page)).writes).toEqual([]);
  } finally { await view.context.close(); }
});

it("keeps anonymous dashboard access denied and retains actual HTTP CSP rather than adding inline scripts", async () => {
  const view = await visit({ anonymous: true });
  try {
    expect(new URL(view.page.url()).pathname).toBe("/login");
    expect(await checksumButton(view.page).count()).toBe(0);
    expect((await state(view.page)).writes).toEqual([]);
    expect(view.csp).toContain("script-src 'self'");
    expect(view.csp).toContain("frame-ancestors 'none'");
    expect(view.csp.split(";").find(directive => /^\s*script-src\s/.test(directive))).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(view.consoleErrors.filter(message => /content security policy|refused to execute/i.test(message))).toEqual([]);
  } finally { await view.context.close(); }
});
