/** Protected acceptance: real image/SVG viewers, not a replacement HTML page.
 * Extends the existing isolated Node/Playwright + disposable Wrangler harness.
 * Run: npm run test:cli -- test/encrypted/image-backgrounds.browser.acceptance.test.ts
 * Setup: npm ci --include=dev; npm ci --prefix packages/cli/test/encrypted --include=dev
 * Browser: use installed Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH optional).
 * IMAGE_BACKGROUND_EVIDENCE_DIR keeps screenshots outside disposable state.
 * Breaks caught: script-dependent/non-native choices; selection/zoom resetting
 * each other; wrong stage pixels; invisible focus/state; clipped mobile controls;
 * unscrollable actual-size artwork; persistence/network side effects; SVG script.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unzlibSync } from "fflate";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { imageBackgroundFiles } from "../../../../test/fixtures/image-backgrounds";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const slug = "image-background-fixture";
const bootstrap = "image-background-local-bootstrap-0123456789";
const names = ["Checker", "Light", "Dark"] as const;
type Background = typeof names[number];
let work: string, origin: string, evidence: string;
let browser: Browser;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("Expected loopback port");
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "image-backgrounds-"));
  evidence = process.env.IMAGE_BACKGROUND_EVIDENCE_DIR ?? join(work, "evidence");
  await mkdir(evidence, { recursive: true });
  origin = `http://127.0.0.1:${await freePort()}`;
  const config = join(work, "wrangler.json"), persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-image-background-test", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: origin, SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "image-backgrounds", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "image-background-files" }], kv_namespaces: [{ binding: "CACHE" }],
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
    method: "POST", headers: { Authorization: `Bearer ${bootstrap}`, "Content-Type": "application/json" }, body: JSON.stringify({ email: "image-fixture@example.com" }),
  });
  expect(setup.status).toBe(201);
  const ownerKey = (await setup.json() as any).apiKey.key;
  const form = new FormData(); form.set("slug", slug);
  for (const file of imageBackgroundFiles) form.append(file.path, new File([file.bytes], file.path, { type: file.type }));
  const published = await fetch(`${origin}/api/v1/publish`, { method: "POST", headers: { Authorization: `Bearer ${ownerKey}` }, body: form });
  expect(published.status, await published.text()).toBe(201);
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);

afterAll(async () => {
  await browser?.close(); await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

type View = { context: BrowserContext; page: Page; wire: string[]; external: string[] };
async function visit(path: string, theme: "light" | "dark", width: number, scripts = false, embed = false): Promise<View> {
  const context = await browser.newContext({ javaScriptEnabled: scripts, colorScheme: theme, viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const wire: string[] = [], external: string[] = [];
  await context.route("**/*", route => {
    const url = route.request().url(); wire.push(url);
    if (new URL(url).origin !== origin) { external.push(url); return route.abort("blockedbyclient"); }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(2500);
  try {
    const response = await page.goto(`${origin}/s/${slug}/${path}${embed ? "?view=1&embed=1" : ""}`, { waitUntil: "networkidle" });
    expect(response!.status()).toBe(200);
    const img = page.locator(".dw-stage img");
    await expect.poll(() => img.evaluate(el => { const image = el as any; return image.complete && image.naturalWidth === 1600 && image.naturalHeight === 1000; })).toBe(true);
    expect(await img.getAttribute("src")).toBe(`/s/${slug}/${path}`);
    expect(await img.getAttribute("alt")).toBe(path);
    return { context, page, wire, external };
  } catch (error) { await context.close(); throw error; }
}

/** Keyboard traversal only: no click/check/selectOption/focus shortcuts. */
async function tabTo(page: Page, target: Locator) {
  for (let n = 0; n < 40; n++) {
    if (await target.evaluate(el => (globalThis as any).document.activeElement === el)) return;
    await page.keyboard.press("Tab");
  }
  throw Error("Native control is not reachable with Tab");
}

async function controls(page: Page) {
  const radios = page.getByRole("radio");
  if (await radios.count()) {
    expect(await radios.count(), "exactly three native background radios").toBe(3);
    for (const name of names) expect(await page.getByRole("radio", { name, exact: true }).count(), `native ${name} radio`).toBe(1);
    const attributes = await radios.evaluateAll(elements => elements.map(el => ({ tag: el.tagName, type: el.getAttribute("type"), name: el.getAttribute("name") })));
    expect(attributes.every(el => el.tag === "INPUT" && el.type === "radio")).toBe(true);
    expect(new Set(attributes.map(el => el.name)).size).toBe(1);
    expect(attributes[0]!.name, "native mutually exclusive group").toBeTruthy();
    return { kind: "radio" as const, locator: radios };
  }
  const select = page.getByRole("combobox", { name: /background/i });
  expect(await select.count(), "native labelled Checker/Light/Dark controls must exist with scripts disabled").toBe(1);
  expect(await select.evaluate(el => el.tagName)).toBe("SELECT");
  expect(await select.locator("option").allTextContents()).toEqual([...names]);
  return { kind: "select" as const, locator: select };
}

async function selected(page: Page): Promise<string> {
  const control = await controls(page);
  return control.kind === "radio"
    ? page.getByRole("radio", { checked: true }).evaluate(el => ((el as any).labels?.[0]?.textContent ?? el.getAttribute("aria-label") ?? "").trim())
    : control.locator.locator("option:checked").innerText();
}

async function focusIsVisible(locator: Locator) {
  const visible = await locator.evaluate(el => {
    const g = globalThis as any;
    const targets = [el, ...Array.from((el as any).labels ?? [])] as any[];
    return targets.some(target => {
      const style = g.getComputedStyle(target), box = target.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && Number(style.opacity) > 0 &&
        ((style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none");
    });
  });
  expect(visible, "keyboard focus needs a visible outline or ring on the native control/label").toBe(true);
}

async function selectionIsVisible(page: Page) {
  const control = await controls(page);
  const selectedControl = control.kind === "radio" ? page.getByRole("radio", { checked: true }) : control.locator;
  const visibleNative = await selectedControl.evaluate(el => {
    const style = (globalThis as any).getComputedStyle(el), box = el.getBoundingClientRect();
    return box.width >= 8 && box.height >= 8 && Number(style.opacity) > 0 && style.visibility !== "hidden" && style.appearance !== "none";
  });
  if (visibleNative) return; // The native checked circle/selected text is visible.
  expect(control.kind, "a select cannot hide its selected text").toBe("radio");
  const states = await control.locator.evaluateAll(elements => elements.map(el => {
    const input = el as any, label = input.labels?.[0];
    if (!label) return { checked: input.checked, visible: false, shape: "" };
    const style = (globalThis as any).getComputedStyle(label), box = label.getBoundingClientRect();
    return { checked: input.checked, visible: box.width > 0 && box.height > 0 && Number(style.opacity) > 0,
      shape: [style.fontWeight, style.fontStyle, style.textDecorationLine, style.borderWidth, style.borderStyle, style.outlineWidth, style.outlineStyle, style.boxShadow].join("|") };
  }));
  const checked = states.find(state => state.checked)!;
  expect(checked.visible, "selected background label is visible").toBe(true);
  expect(states.some(state => !state.checked && state.shape !== checked.shape), "hidden radios need a non-color selected cue on their text label").toBe(true);
}

async function choose(page: Page, name: Background) {
  const control = await controls(page);
  if (control.kind === "radio") {
    const checked = page.getByRole("radio", { checked: true });
    expect(await checked.count()).toBe(1);
    await tabTo(page, checked); await focusIsVisible(checked);
    for (let n = 0; n < 3 && await selected(page) !== name; n++) await page.keyboard.press("ArrowRight");
    await focusIsVisible(page.getByRole("radio", { checked: true }));
  } else {
    await tabTo(page, control.locator); await focusIsVisible(control.locator);
    await page.keyboard.press("Home");
    for (let n = 0; n < names.indexOf(name); n++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
  }
  expect(await selected(page)).toBe(name);
  await selectionIsVisible(page);
}

/** Decode Chromium's screenshot in the test runner, not with an injected canvas. */
function screenshotPixels(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20), channels = png[25] === 2 ? 3 : 4;
  expect(png[24]).toBe(8); expect([2, 6]).toContain(png[25]);
  const chunks: Uint8Array[] = [];
  for (let offset = 8; offset < png.length;) {
    const size = view.getUint32(offset);
    if (String.fromCharCode(...png.subarray(offset + 4, offset + 8)) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const compressed = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let cursor = 0; for (const chunk of chunks) { compressed.set(chunk, cursor); cursor += chunk.length; }
  const raw = unzlibSync(compressed), stride = width * channels, pixels = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    if (filter > 4) throw Error(`Unsupported PNG screenshot filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= channels ? pixels[at - channels]! : 0, b = y ? pixels[at - stride]! : 0, c = y && x >= channels ? pixels[at - stride - channels]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      pixels[at] = (raw[y * (stride + 1) + 1 + x]! + predictor) & 255;
    }
  }
  return { width, height, at(x: number, y: number) {
    expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(width); expect(y).toBeLessThan(height);
    return [...pixels.subarray((y * width + x) * channels, (y * width + x) * channels + 3)];
  } };
}

async function capture(view: View, file: typeof imageBackgroundFiles[number], label: string, background: Background, actual: boolean) {
  const elementBox = (await view.page.locator(".dw-stage img").boundingBox())!;
  // object-fit:contain can letterbox inside an img whose width/height attrs
  // are independently capped by CSS. Sample the bitmap, not that letterbox.
  const scale = Math.min(elementBox.width / 1600, elementBox.height / 1000);
  const box = { x: elementBox.x + (elementBox.width - 1600 * scale) / 2, y: elementBox.y + (elementBox.height - 1000 * scale) / 2, width: 1600 * scale, height: 1000 * scale };
  const scroll = await view.page.evaluate(() => ({ x: (globalThis as any).scrollX, y: (globalThis as any).scrollY }));
  const png = await view.page.screenshot({ fullPage: true, path: join(evidence, `${label}-${background}-${actual ? "actual" : "fit"}.png`) });
  // Full natural-size images may be inside an inner scrollport. Fit mode has
  // the complete image onscreen, so screenshot samples are unambiguous there.
  if (actual) return;
  const pixels = screenshotPixels(png);
  const sample = (x: number, y: number) => pixels.at(Math.round(box.x + scroll.x + box.width * x), Math.round(box.y + scroll.y + box.height * y));
  expect(sample(0.5, 0.5), "center artwork pixel").toEqual([file.shade, file.shade, file.shade]);
  if (file.path === "opaque.png") expect(sample(0.1, 0.1)).toEqual([96, 96, 96]);
  else if (background === "Light") expect(sample(0.1, 0.1), "white stage through transparent pixels").toEqual([255, 255, 255]);
  else if (background === "Dark") expect(sample(0.1, 0.1), "black stage through transparent pixels").toEqual([0, 0, 0]);
  else {
    // Sample a 24px strip of transparent border: two visible checker tones,
    // not a solid background or merely a CSS class named 'checker'.
    const y = Math.round(box.y + scroll.y + box.height * 0.1), x = Math.round(box.x + scroll.x + box.width * 0.1);
    const tones = new Set(Array.from({ length: 24 }, (_, n) => pixels.at(x + n, y).join(",")));
    expect(tones.size, "visible checkerboard through transparent border").toBeGreaterThan(1);
  }
}

async function pageColors(page: Page) {
  return page.evaluate(() => {
    const g = globalThis as any;
    return [g.document.documentElement, g.document.body].map(el => {
      const style = g.getComputedStyle(el); return [style.backgroundColor, style.backgroundImage, style.color];
    });
  });
}

async function layout(page: Page, width: number, actual: boolean) {
  const stage = (await page.locator(".dw-stage").boundingBox())!;
  const state = await page.locator(".dw-stage img").evaluate(el => {
    const g = globalThis as any, image = el as any, box = image.getBoundingClientRect();
    let horizontal = false, vertical = false;
    for (let parent = image.parentElement; parent; parent = parent.parentElement) {
      const style = g.getComputedStyle(parent);
      const scrollsX = /auto|scroll/.test(style.overflowX) || parent === g.document.scrollingElement;
      const scrollsY = /auto|scroll/.test(style.overflowY) || parent === g.document.scrollingElement;
      horizontal ||= scrollsX && parent.scrollWidth > parent.clientWidth;
      vertical ||= scrollsY && parent.scrollHeight > parent.clientHeight;
    }
    return { width: box.width, height: box.height, horizontal, vertical };
  });
  if (actual) {
    expect(state.width).toBe(1600); expect(state.height).toBe(1000);
    expect(state.horizontal, "natural-size wide artwork remains horizontally scrollable").toBe(true);
    expect(state.vertical, "natural-size tall artwork remains vertically scrollable").toBe(true);
  } else expect(state.width).toBeLessThanOrEqual(width);
  const boxes = await page.locator(".dw-mediabar label, .dw-mediabar select").evaluateAll(elements => elements.map(el => {
    const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, right: b.right, bottom: b.bottom };
  }));
  for (const box of boxes.filter(b => b.width > 0)) {
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width + 1);
    expect(box.bottom, "wrapped controls precede and do not cover the image stage").toBeLessThanOrEqual(stage.y + 1);
  }
}

for (const theme of ["light", "dark"] as const) for (const width of [360, 1100]) {
  describe(`${theme} app theme at ${width}px, scripts disabled`, () => {
    it.each(imageBackgroundFiles)("$path: 3 backgrounds x 2 sizes compose in both keyboard orders", async file => {
      const view = await visit(file.path, theme, width);
      const label = `${file.path}-${theme}-${width}`;
      try {
        // Records real baseline pixels even while the missing-control assertion
        // below is RED. The opaque fixture never claims to have transparency.
        await capture(view, file, label, "Checker", false);
        expect(await selected(view.page), "Checker is the fresh-navigation default").toBe("Checker");
        await selectionIsVisible(view.page);
        const zoom = view.page.getByLabel("Actual size", { exact: true });
        expect(await zoom.count()).toBe(1); expect(await zoom.isChecked()).toBe(false);
        const colors = await pageColors(view.page), url = view.page.url(), requests = view.wire.length;
        const src = await view.page.locator(".dw-stage img").getAttribute("src");
        for (const background of names) {
          // Background -> zoom -> fit; every background gets both size states.
          await choose(view.page, background);
          expect(await zoom.isChecked()).toBe(false);
          await layout(view.page, width, false); await capture(view, file, label, background, false);
          await tabTo(view.page, zoom); await view.page.keyboard.press("Space");
          expect(await zoom.evaluate(el => (globalThis as any).document.activeElement === el), "zoom keeps keyboard focus").toBe(true);
          expect(await zoom.isChecked()).toBe(true); expect(await selected(view.page)).toBe(background);
          await layout(view.page, width, true); await capture(view, file, label, background, true);
          // Zoom -> background must leave Actual size selected, then toggling
          // back to Fit must retain that background too.
          const next = names[(names.indexOf(background) + 1) % names.length]!;
          await choose(view.page, next); expect(await zoom.isChecked()).toBe(true);
          await tabTo(view.page, zoom); await view.page.keyboard.press("Space");
          expect(await zoom.isChecked()).toBe(false); expect(await selected(view.page)).toBe(next);
          expect(await pageColors(view.page), "only the stage changes, never the app/page theme").toEqual(colors);
          expect(view.page.url()).toBe(url);
          expect(await view.page.locator(".dw-stage img").getAttribute("src")).toBe(src);
          expect(await view.page.locator("canvas,script,input[type=color],object,embed").count()).toBe(0);
        }
        expect(view.external).toEqual([]); expect(view.wire.length, "CSS-only toggles perform no requests").toBe(requests);
        await view.page.reload({ waitUntil: "networkidle" });
        expect(await selected(view.page), "background selection is not persisted").toBe("Checker");
        expect(await zoom.isChecked()).toBe(false);
      } finally { await view.context.close(); }
    }, 30_000);
  });
}

it("baseline regression: all self-created fixtures decode, SVG scripts stay inert even with browser JS enabled", async () => {
  for (const file of imageBackgroundFiles) {
    const view = await visit(file.path, "light", 1100, true);
    try {
      await capture(view, file, `${file.path}-baseline-regression`, "Checker", false);
      expect(await view.page.locator("script,canvas,object,embed").count()).toBe(0);
      expect(await view.page.evaluate(() => (globalThis as any).imageBackgroundScriptRan)).toBeUndefined();
      expect(view.wire.some(url => new URL(url).pathname === "/svg-script-ran")).toBe(false);
      expect(view.external).toEqual([]);
    } finally { await view.context.close(); }
  }
});

it.each([
  { path: "light.png", width: 360 }, { path: "light.svg", width: 360 },
  { path: "light.png", width: 1100 }, { path: "light.svg", width: 1100 },
])("keyboard sizing contract: $path keeps Fit/Actual size and scrolling at $width px without scripts", async ({ path, width }) => {
  const file = imageBackgroundFiles.find(candidate => candidate.path === path)!;
  const view = await visit(path, "light", width);
  try {
    const zoom = view.page.getByLabel("Actual size", { exact: true });
    expect(await zoom.getAttribute("type")).toBe("checkbox");
    expect(await zoom.isChecked()).toBe(false);
    await layout(view.page, width, false);
    await tabTo(view.page, zoom); await view.page.keyboard.press("Space");
    expect(await zoom.isChecked()).toBe(true);
    expect(await zoom.evaluate(el => (globalThis as any).document.activeElement === el)).toBe(true);
    await layout(view.page, width, true);
    await capture(view, file, `${path}-zoom-baseline-${width}`, "Checker", true);
    await view.page.keyboard.press("Space");
    expect(await zoom.isChecked()).toBe(false);
    await layout(view.page, width, false);
  } finally { await view.context.close(); }
});

it.each(["light.png", "light.svg"])("%s: opt-in embed retains no-script background/zoom composition without restoring viewer chrome", async path => {
  const view = await visit(path, "dark", 360, false, true);
  try {
    expect(await view.page.locator(".dw-vbar").count()).toBe(0);
    expect(await selected(view.page)).toBe("Checker");
    await choose(view.page, "Dark");
    const zoom = view.page.getByLabel("Actual size", { exact: true });
    await tabTo(view.page, zoom); await view.page.keyboard.press("Space");
    expect(await zoom.isChecked()).toBe(true); expect(await selected(view.page)).toBe("Dark");
    await layout(view.page, 360, true);
  } finally { await view.context.close(); }
});
