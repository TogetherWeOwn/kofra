/** Protected acceptance: real image/SVG viewers, not a replacement HTML page.
 * Extends the existing isolated Node/Playwright + disposable Wrangler harness.
 * Run: npm run test:cli -- test/encrypted/image-backgrounds.browser.acceptance.test.ts
 * Setup: npm ci --include=dev; npm ci --prefix packages/cli/test/encrypted --include=dev
 * Browser: use installed Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH optional).
 * IMAGE_BACKGROUND_EVIDENCE_DIR keeps screenshots outside disposable state.
 * Breaks caught: script-dependent/non-native choices; selection/zoom resetting
 * each other; wrong stage pixels; invisible focus/state; clipped mobile controls;
 * unscrollable actual-size artwork; background paint missing at the far scroll
 * corner; a zero-height stage when wrapped chrome exhausts a short window;
 * persistence/network side effects; SVG script.
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
import { imageBackgroundFiles, portraitImageFile } from "../../../../test/fixtures/image-backgrounds";

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
  for (const [site, files] of [[slug, imageBackgroundFiles], [`${slug}-solo`, [imageBackgroundFiles[0]]], [`${slug}-portrait`, [portraitImageFile]],
    // Same portrait bytes under long sibling names: their Previous/Next links
    // are the wrapping chrome that can exhaust a short window's height.
    [`${slug}-short`, [{ path: "a-long-previous-artwork-name.png", type: "image/png", bytes: portraitImageFile.bytes }, portraitImageFile,
      { path: "z-long-next-artwork-name.png", type: "image/png", bytes: portraitImageFile.bytes }]]] as const) {
    const form = new FormData(); form.set("slug", site);
    for (const file of files) form.append(file.path, new File([file.bytes], file.path, { type: file.type }));
    const published = await fetch(`${origin}/api/v1/publish`, { method: "POST", headers: { Authorization: `Bearer ${ownerKey}` }, body: form });
    expect(published.status, await published.text()).toBe(201);
  }
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);

afterAll(async () => {
  await browser?.close(); await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

type View = { context: BrowserContext; page: Page; wire: string[]; external: string[] };
type VisitOptions = { height?: number; forcedColors?: "active" | "none"; site?: string; dimensions?: readonly [number, number] };
async function visit(path: string, theme: "light" | "dark", width: number, scripts = false, embed = false, options: VisitOptions = {}): Promise<View> {
  const context = await browser.newContext({ javaScriptEnabled: scripts, colorScheme: theme, viewport: { width, height: options.height ?? 900 }, forcedColors: options.forcedColors ?? "none", deviceScaleFactor: 1 });
  const wire: string[] = [], external: string[] = [];
  await context.route("**/*", route => {
    const url = route.request().url(); wire.push(url);
    if (new URL(url).origin !== origin) { external.push(url); return route.abort("blockedbyclient"); }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(2500);
  page.setDefaultNavigationTimeout(5000);
  try {
    const site = options.site ?? slug;
    const response = await page.goto(`${origin}/s/${site}/${path}${embed ? "?view=1&embed=1" : ""}`, { waitUntil: "networkidle" });
    expect(response!.status()).toBe(200);
    const img = page.locator(".dw-stage img");
    await expect.poll(() => img.evaluate((el, [width, height]) => { const image = el as any; return image.complete && image.naturalWidth === width && image.naturalHeight === height; }, options.dimensions ?? [1600, 1000])).toBe(true);
    expect(await img.getAttribute("src")).toBe(`/s/${site}/${path}`);
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

/** Focus must survive scrolling/clipping and paint above sticky chrome. */
async function focusIsExposed(locator: Locator) {
  await focusIsVisible(locator);
  const state = await locator.evaluate(el => {
    const g = globalThis as any, labels = Array.from((el as any).labels ?? []) as any[];
    const owns = (hit: any) => hit === el || el.contains(hit) || labels.some(label => label === hit || label.contains(hit));
    const box = el.getBoundingClientRect(), center = g.document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const rings = [el, ...labels].flatMap(target => {
      const style = g.getComputedStyle(target), b = target.getBoundingClientRect();
      const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0, shadow = style.boxShadow !== "none" && style.boxShadow !== "";
      if (!outline && !shadow) return [];
      const extent = outline ? Math.max(0, parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth)) :
        Math.max(0, ...(style.boxShadow.match(/-?\d+(?:\.\d+)?px/g) ?? []).map((length: string) => Math.abs(parseFloat(length))));
      let left = 0, top = 0, right = g.innerWidth, bottom = g.innerHeight;
      for (let parent = target.parentElement; parent; parent = parent.parentElement) {
        const css = g.getComputedStyle(parent), r = parent.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(css.overflowX)) { left = Math.max(left, r.left + parent.clientLeft); right = Math.min(right, r.left + parent.clientLeft + parent.clientWidth); }
        if (/auto|scroll|hidden|clip/.test(css.overflowY)) { top = Math.max(top, r.top + parent.clientTop); bottom = Math.min(bottom, r.top + parent.clientTop + parent.clientHeight); }
      }
      const header = g.document.querySelector(".dw-vbar"), h = header?.getBoundingClientRect();
      if (h && h.bottom > 0 && h.left < b.right + extent && h.right > b.left - extent) top = Math.max(top, h.bottom);
      const corners = [[b.left + 1, b.top + 1], [b.right - 1, b.top + 1], [b.left + 1, b.bottom - 1], [b.right - 1, b.bottom - 1]];
      return [{ x: b.x, y: b.y, right: b.right, bottom: b.bottom, extent, clip: { left, top, right, bottom },
        exposed: b.left - extent >= left && b.right + extent <= right && b.top - extent >= top && b.bottom + extent <= bottom &&
          corners.every(([x, y]) => owns(g.document.elementFromPoint(x, y))) }];
    });
    return { centerExposed: owns(center), hit: center?.outerHTML, rings };
  });
  expect(state.centerExposed, `focused control is unobscured: ${JSON.stringify(state)}`).toBe(true);
  expect(state.rings.some(ring => ring.exposed), `focus ring is within the visible unclipped scrollport: ${JSON.stringify(state)}`).toBe(true);
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

/** Geometry of the bitmap, excluding contain-letterboxing and every ancestor clip. */
async function bitmapGeometry(page: Page) {
  return page.locator(".dw-stage img").evaluate(el => {
    const g = globalThis as any, image = el as any, r = image.getBoundingClientRect(), css = g.getComputedStyle(image);
    const x = r.x + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft), y = r.y + parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop);
    const width = image.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight), height = image.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
    const scale = css.objectFit === "contain" ? Math.min(width / image.naturalWidth, height / image.naturalHeight) :
      css.objectFit === "scale-down" ? Math.min(1, width / image.naturalWidth, height / image.naturalHeight) : 1;
    const w = /contain|scale-down|none/.test(css.objectFit) ? image.naturalWidth * scale : width;
    const h = /contain|scale-down|none/.test(css.objectFit) ? image.naturalHeight * scale : height;
    const [positionX, positionY] = css.objectPosition.split(" ");
    const offset = (position: string, space: number) => position.endsWith("%") ? parseFloat(position) * space / 100 : parseFloat(position);
    const bitmap = { x: x + offset(positionX, width - w), y: y + offset(positionY, height - h), width: w, height: h };
    const visible = { left: Math.max(0, bitmap.x), top: Math.max(0, bitmap.y), right: Math.min(g.innerWidth, bitmap.x + w), bottom: Math.min(g.innerHeight, bitmap.y + h) };
    for (let parent = image.parentElement; parent; parent = parent.parentElement) {
      const style = g.getComputedStyle(parent), b = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) { visible.left = Math.max(visible.left, b.left + parent.clientLeft); visible.right = Math.min(visible.right, b.left + parent.clientLeft + parent.clientWidth); }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) { visible.top = Math.max(visible.top, b.top + parent.clientTop); visible.bottom = Math.min(visible.bottom, b.top + parent.clientTop + parent.clientHeight); }
    }
    const header = g.document.querySelector(".dw-vbar")?.getBoundingClientRect();
    if (header && header.bottom > 0) visible.top = Math.max(visible.top, header.bottom);
    // The fixture's outer quarter is transparent, its middle half opaque.
    // Pick an actually visible 24px strip, never a full-page/off-scrollport pixel.
    let transparent: { x: number; y: number } | null = null, artwork: { x: number; y: number } | null = null;
    for (let py = Math.ceil(visible.top) + 16; py < visible.bottom - 16 && (!transparent || !artwork); py += 8) {
      for (let px = Math.ceil(visible.left) + 16; px + 24 < visible.right - 16; px += 8) {
        if (![0, 12, 23].every(dx => g.document.elementFromPoint(px + dx, py) === image)) continue;
        artwork ??= { x: px, y: py };
        if (py < bitmap.y + h / 4 || py >= bitmap.y + h * 3 / 4 || px + 23 < bitmap.x + w / 4 || px >= bitmap.x + w * 3 / 4) { transparent ??= { x: px, y: py }; break; }
      }
    }
    return { bitmap, visible, transparent, artwork, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
  });
}

async function capture(view: View, file: typeof imageBackgroundFiles[number], label: string, background: Background, actual: boolean) {
  const geometry = await bitmapGeometry(view.page), box = geometry.bitmap;
  const stem = `${label}-${background}-${actual ? "actual" : "fit"}`;
  const png = await view.page.screenshot({ path: join(evidence, `${stem}.png`) });
  const pixels = screenshotPixels(png), opaque = file.path === "opaque.png";
  const point = opaque ? geometry.artwork : geometry.transparent;
  expect(point, `a visible ${opaque ? "opaque" : "transparent"} fixture strip must exist inside all clips: ${JSON.stringify(geometry)}`).not.toBeNull();
  const tones = Array.from({ length: 24 }, (_, n) => pixels.at(point!.x + n, point!.y));
  await writeFile(join(evidence, `${stem}.json`), JSON.stringify({ background, actual, geometry, tones }, null, 2));
  if (!actual) {
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    expect(x).toBeGreaterThanOrEqual(geometry.visible.left); expect(x).toBeLessThan(geometry.visible.right);
    expect(y).toBeGreaterThanOrEqual(geometry.visible.top); expect(y).toBeLessThan(geometry.visible.bottom);
    expect(pixels.at(x, y), "center artwork pixel").toEqual([file.shade, file.shade, file.shade]);
  }
  // An opaque Actual-size bitmap can cover the entire scrollport: it proves
  // opacity, not a background that cannot be seen. Transparent fixtures do both.
  if (opaque) expect(tones.every(tone => tone.join(",") === "96,96,96"), "opaque control pixels stay opaque in both sizes").toBe(true);
  else if (background === "Light") expect(tones, "white stage through visible transparent pixels").toEqual(Array.from({ length: 24 }, () => [255, 255, 255]));
  else if (background === "Dark") expect(tones, "black stage through visible transparent pixels").toEqual(Array.from({ length: 24 }, () => [0, 0, 0]));
  else expect(new Set(tones.map(tone => tone.join(","))).size, "visible checkerboard through transparent border").toBeGreaterThan(1);
}

async function pageColors(page: Page) {
  return page.evaluate(() => {
    const g = globalThis as any;
    return [g.document.documentElement, g.document.body].map(el => {
      const style = g.getComputedStyle(el); return [style.backgroundColor, style.backgroundImage, style.color];
    });
  });
}

/** Move only user-scrollable ancestors; hidden/clip remain real constraints. */
async function reachableEdges(page: Page) {
  return page.locator(".dw-stage img").evaluate(el => {
    const g = globalThis as any, image = el as any, doc = g.document.scrollingElement;
    const parents: any[] = [];
    for (let parent = image.parentElement; parent; parent = parent.parentElement) parents.push(parent);
    const saved = parents.map(parent => ({ parent, x: parent.scrollLeft, y: parent.scrollTop }));
    const allowed = (parent: any, axis: "X" | "Y") => {
      const overflow = g.getComputedStyle(parent)[`overflow${axis}`];
      if (parent === doc) return !/hidden|clip/.test(overflow) && !/hidden|clip/.test(g.getComputedStyle(g.document.body)[`overflow${axis}`]);
      return /auto|scroll/.test(overflow);
    };
    const port = (parent: any) => {
      if (parent === doc) return { left: 0, top: 0, right: g.innerWidth, bottom: g.innerHeight };
      const b = parent.getBoundingClientRect();
      return { left: b.left + parent.clientLeft, top: b.top + parent.clientTop, right: b.left + parent.clientLeft + parent.clientWidth, bottom: b.top + parent.clientTop + parent.clientHeight };
    };
    const points = [{ name: "left", x: 0, y: 0.5 }, { name: "right", x: 1, y: 0.5 }, { name: "top", x: 0.5, y: 0 }, { name: "bottom", x: 0.5, y: 1 }];
    try {
      return points.map(point => {
        for (const parent of parents) parent.scrollTo({ left: allowed(parent, "X") ? 0 : parent.scrollLeft, top: allowed(parent, "Y") ? 0 : parent.scrollTop, behavior: "instant" });
        const position = () => { const b = image.getBoundingClientRect(); return { x: b.left + 2 + (b.width - 4) * point.x, y: b.top + 2 + (b.height - 4) * point.y }; };
        // Inner-to-outer, with a bounded second pass after the document moves.
        for (let pass = 0; pass < 2; pass++) for (const parent of parents) {
          const p = position(), clip = port(parent);
          if (parent === doc) {
            const h = g.document.querySelector(".dw-vbar")?.getBoundingClientRect();
            if (h && h.bottom > 0 && h.left <= p.x && h.right >= p.x) clip.top = Math.max(clip.top, h.bottom);
          }
          // Keep the probe off a scrollport's rounded corners while still
          // checking the bitmap's edge (2px inset), not just its middle.
          parent.scrollTo({
            left: parent.scrollLeft + (allowed(parent, "X") ? p.x - Math.min(Math.max(p.x, clip.left + 16), clip.right - 16) : 0),
            top: parent.scrollTop + (allowed(parent, "Y") ? p.y - Math.min(Math.max(p.y, clip.top + 16), clip.bottom - 16) : 0), behavior: "instant",
          });
        }
        const p = position(), clip = { left: 0, top: 0, right: g.innerWidth, bottom: g.innerHeight };
        for (const parent of parents) {
          if (parent === doc) continue;
          const css = g.getComputedStyle(parent), b = port(parent);
          if (/auto|scroll|hidden|clip/.test(css.overflowX)) { clip.left = Math.max(clip.left, b.left); clip.right = Math.min(clip.right, b.right); }
          if (/auto|scroll|hidden|clip/.test(css.overflowY)) { clip.top = Math.max(clip.top, b.top); clip.bottom = Math.min(clip.bottom, b.bottom); }
        }
        const h = g.document.querySelector(".dw-vbar")?.getBoundingClientRect();
        if (h && h.bottom > 0 && h.left <= p.x && h.right >= p.x) clip.top = Math.max(clip.top, h.bottom);
        const hit = g.document.elementFromPoint(p.x, p.y);
        return { edge: point.name, point: p, clip, hit: hit?.tagName, reached: p.x >= clip.left && p.x < clip.right && p.y >= clip.top && p.y < clip.bottom && hit === image,
          offsets: parents.filter(parent => parent.scrollLeft || parent.scrollTop).map(parent => ({ tag: parent.tagName, class: parent.className, x: parent.scrollLeft, y: parent.scrollTop })) };
      });
    } finally {
      for (const { parent, x, y } of saved) parent.scrollTo({ left: x, top: y, behavior: "instant" });
    }
  });
}

async function assertReachableEdges(page: Page) {
  const edges = await reachableEdges(page);
  expect(edges.filter(edge => !edge.reached), `all Actual-size image edges are reachable through every clip: ${JSON.stringify(edges)}`).toEqual([]);
}

/** Scroll only user-scrollable ancestors to their far right/bottom extremes. */
async function scrollToFarCorner(page: Page) {
  const state = await page.locator(".dw-stage img").evaluate(el => {
    const g = globalThis as any, image = el as any, doc = g.document.scrollingElement;
    const offsets: { tag: string; class: string; x: number; y: number }[] = [];
    for (let parent = image.parentElement; parent; parent = parent.parentElement) {
      const style = g.getComputedStyle(parent);
      const scrollsX = parent === doc ? !/hidden|clip/.test(style.overflowX) : /auto|scroll/.test(style.overflowX);
      const scrollsY = parent === doc ? !/hidden|clip/.test(style.overflowY) : /auto|scroll/.test(style.overflowY);
      if (!scrollsX && !scrollsY) continue;
      parent.scrollTo({ left: scrollsX ? parent.scrollWidth : parent.scrollLeft, top: scrollsY ? parent.scrollHeight : parent.scrollTop, behavior: "instant" });
      offsets.push({ tag: parent.tagName, class: parent.className, x: parent.scrollLeft, y: parent.scrollTop });
    }
    const box = image.getBoundingClientRect();
    return { offsets, right: box.right, bottom: box.bottom, viewport: [g.innerWidth, g.innerHeight] };
  });
  // A 1600x1000 Actual-size bitmap in a 360px viewport exposes its far
  // corner only after well over a thousand pixels of horizontal travel;
  // the small post-wheel samples elsewhere never reach it.
  expect(Math.max(...state.offsets.map(offset => offset.x)), `far horizontal scroll extreme reached: ${JSON.stringify(state)}`).toBeGreaterThan(1000);
  expect(Math.max(...state.offsets.map(offset => offset.y)), `far vertical scroll extreme reached: ${JSON.stringify(state)}`).toBeGreaterThan(300);
  return state;
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
    await assertReachableEdges(page);
  } else expect(state.width).toBeLessThanOrEqual(width);
  const boxes = await page.locator(".dw-mediabar label, .dw-mediabar select")
    .or(page.getByRole("radiogroup", { name: /background/i }).locator("label")).evaluateAll(elements => elements.map(el => {
    const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, right: b.right, bottom: b.bottom };
  }));
  for (const box of boxes.filter(b => b.width > 0)) {
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width + 1);
    expect(box.bottom, "wrapped controls precede and do not cover the image stage").toBeLessThanOrEqual(stage.y + 1);
  }
}

describe("product regressions", () => {
  for (const theme of ["light", "dark"] as const) for (const file of [imageBackgroundFiles[0], imageBackgroundFiles[2]]) {
    for (const actual of [false, true]) for (const background of names) {
      it(`forced colors: ${file.path}, ${theme} system scheme, ${background}, ${actual ? "Actual" : "Fit"} keeps an inspection surface`, async () => {
        const view = await visit(file.path, theme, 1100, false, false, { forcedColors: "active" });
        try {
          expect(await view.page.evaluate(() => (globalThis as any).matchMedia("(forced-colors: active)").matches)).toBe(true);
          await choose(view.page, background);
          if (actual) {
            await tabTo(view.page, view.page.getByLabel("Actual size", { exact: true }));
            await view.page.keyboard.press("Space");
          }
          const adaptation = await view.page.locator("input").evaluateAll(elements => elements.flatMap(el => [el, ...Array.from((el as any).labels ?? [])])
            .map(el => (globalThis as any).getComputedStyle(el).forcedColorAdjust));
          expect(adaptation.length).toBeGreaterThan(0);
          expect(adaptation, "controls and labels retain system forced-color adaptation").not.toContain("none");
          await capture(view, file, `forced-${file.path}-${theme}`, background, actual);
        } finally { await view.context.close(); }
      });
    }
  }

  it("scrolled keyboard focus exposes Checker and its ring below the sticky header", async () => {
    const view = await visit("light.png", "light", 360, false, false, { height: 640, site: `${slug}-solo` });
    try {
      const zoom = view.page.getByLabel("Actual size", { exact: true });
      await tabTo(view.page, zoom); await view.page.keyboard.press("Space");
      expect(await zoom.isChecked()).toBe(true);
      // Separate native key events: allow each smooth page scroll to settle.
      await view.page.keyboard.press("ArrowDown"); await view.page.waitForTimeout(250);
      await view.page.keyboard.press("ArrowDown"); await view.page.waitForTimeout(250);
      expect(await view.page.evaluate(() => (globalThis as any).scrollY)).toBeGreaterThan(0);
      await view.page.keyboard.press("Tab");
      const checker = view.page.getByRole("radio", { name: "Checker", exact: true });
      expect(await checker.evaluate(el => (globalThis as any).document.activeElement === el)).toBe(true);
      await view.page.screenshot({ path: join(evidence, "focus-after-scroll.png") });
      await focusIsExposed(checker);
    } finally { await view.context.close(); }
  });

  for (const { width, height } of [{ width: 340, height: 600 }, { width: 360, height: 480 }, { width: 1100, height: 900 }]) for (const embed of [false, true]) {
    it(`portrait Fit: ${width}x${height}, ${embed ? "embed" : "ordinary"} fits below real wrapped controls and retains Actual-size edges`, async () => {
      const view = await visit(portraitImageFile.path, "light", width, false, embed, { height, site: `${slug}-portrait`, dimensions: [600, 1200] });
      try {
        expect(await view.page.evaluate(() => (globalThis as any).scrollY), "initial Fit has not been scrolled into view").toBe(0);
        expect(await view.page.getByRole("link", { name: /Previous|Next/ }).count()).toBe(0);
        expect(await view.page.locator(".dw-mediabar").innerText()).not.toMatch(/\b\d+ of \d+\b/);
        const { bitmap } = await bitmapGeometry(view.page);
        const controlsBottom = await view.page.locator(".dw-vbar, .dw-mediabar")
          .or(view.page.getByRole("radiogroup", { name: /background/i })).evaluateAll(elements => Math.max(0, ...elements.map(el => el.getBoundingClientRect().bottom)));
        await view.page.screenshot({ path: join(evidence, `portrait-${width}-${height}-${embed ? "embed" : "ordinary"}-fit.png`) });
        await writeFile(join(evidence, `portrait-${width}-${height}-${embed ? "embed" : "ordinary"}.json`), JSON.stringify({ bitmap, controlsBottom, width, height }, null, 2));
        expect.soft(bitmap.y, "Fit bitmap begins below the actual chrome/controls").toBeGreaterThanOrEqual(controlsBottom - 1);
        expect.soft(bitmap.x).toBeGreaterThanOrEqual(0);
        expect.soft(bitmap.x + bitmap.width).toBeLessThanOrEqual(width + 1);
        expect.soft(bitmap.y + bitmap.height, "initial portrait Fit bitmap fits the remaining viewport, not an obsolete fixed header allowance").toBeLessThanOrEqual(height + 1);
        expect(bitmap.width / bitmap.height).toBeCloseTo(0.5, 2);
        const zoom = view.page.getByLabel("Actual size", { exact: true });
        await tabTo(view.page, zoom); await view.page.keyboard.press("Space");
        expect(await zoom.isChecked()).toBe(true);
        const actual = (await view.page.locator(".dw-stage img").boundingBox())!;
        expect(actual.width).toBe(600); expect(actual.height).toBe(1200);
        await assertReachableEdges(view.page); // Includes vertical-only desktop overflow.
      } finally { await view.context.close(); }
    });
  }

  for (const embed of [false, true]) for (const forced of [false, true]) {
    it(`far-scroll SVG surface: ${embed ? "embed" : "ordinary"}, ${forced ? "forced" : "normal"} colors, Light at Actual size paints the bottom-right corner`, async () => {
      const file = imageBackgroundFiles.find(candidate => candidate.path === "light.svg")!;
      const view = await visit(file.path, "dark", 360, false, embed, { height: 480, ...(forced ? { forcedColors: "active" as const } : {}) });
      try {
        if (forced) expect(await view.page.evaluate(() => (globalThis as any).matchMedia("(forced-colors: active)").matches)).toBe(true);
        await choose(view.page, "Light");
        const zoom = view.page.getByLabel("Actual size", { exact: true });
        await tabTo(view.page, zoom); await view.page.keyboard.press("Space");
        expect(await zoom.isChecked()).toBe(true); expect(await selected(view.page)).toBe("Light");
        await assertReachableEdges(view.page);
        const scrolled = await scrollToFarCorner(view.page);
        const { bitmap, visible } = await bitmapGeometry(view.page);
        expect.soft(bitmap.x + bitmap.width, `right bitmap edge is inside the far-corner scrollport: ${JSON.stringify({ scrolled, bitmap, visible })}`).toBeLessThanOrEqual(visible.right + 1);
        expect.soft(bitmap.y + bitmap.height, `bottom bitmap edge is inside the far-corner scrollport: ${JSON.stringify({ scrolled, bitmap, visible })}`).toBeLessThanOrEqual(visible.bottom + 1);
        await writeFile(join(evidence, `far-scroll-${embed ? "embed" : "ordinary"}-${forced ? "forced" : "normal"}.json`), JSON.stringify({ scrolled, bitmap, visible }, null, 2));
        // capture() samples a transparent strip that is actually visible and
        // hit-tests as the image in this scrolled position, so white tones
        // prove the Light surface extends under the whole bitmap, not just
        // under its first viewport-width column.
        await capture(view, file, `far-scroll-light-svg-${embed ? "embed" : "ordinary"}-${forced ? "forced" : "normal"}`, "Light", true);
      } finally { await view.context.close(); }
    });
  }

  for (const { width, height } of [{ width: 360, height: 300 }, { width: 640, height: 240 }]) {
    it(`short-window Fit fallback: portrait with long-named siblings at ${width}x${height} keeps a nonzero scroll-reachable image`, async () => {
      const view = await visit(portraitImageFile.path, "light", width, false, false, { height, site: `${slug}-short`, dimensions: [600, 1200] });
      try {
        // The wrapping Previous/Next chrome is the scenario, not decoration:
        // without these siblings this case could pass vacuously.
        expect(await view.page.getByRole("link", { name: /Previous: a-long-previous-artwork-name\.png/ }).count()).toBe(1);
        expect(await view.page.getByRole("link", { name: /Next: z-long-next-artwork-name\.png/ }).count()).toBe(1);
        expect(await view.page.locator(".dw-mediabar").innerText()).toMatch(/\b2 of 3\b/);
        const geometry = await bitmapGeometry(view.page);
        const documentState = await view.page.evaluate(() => {
          const g = globalThis as any;
          return { scrollHeight: g.document.scrollingElement.scrollHeight, stageClientHeight: g.document.querySelector(".dw-stage").clientHeight };
        });
        await view.page.screenshot({ path: join(evidence, `short-window-${width}-${height}.png`) });
        await writeFile(join(evidence, `short-window-${width}-${height}.json`), JSON.stringify({ geometry, documentState, width, height }, null, 2));
        // Intentional overflow fallback: the bitmap need not fit the short
        // window (the six portrait cases above pin that where space allows),
        // but it must not collapse to zero with no way to scroll to it.
        expect.soft(documentState.stageClientHeight, "stage retains a nonzero height when chrome exhausts the window").toBeGreaterThan(0);
        expect.soft(geometry.bitmap.width, "Fit bitmap retains a nonzero width").toBeGreaterThan(0);
        expect.soft(geometry.bitmap.height, "Fit bitmap retains a nonzero height").toBeGreaterThan(0);
        expect(geometry.bitmap.width / geometry.bitmap.height).toBeCloseTo(0.5, 2);
        expect(documentState.scrollHeight, "the fallback stage overflows the document so the user can scroll to it").toBeGreaterThan(height);
        await assertReachableEdges(view.page);
      } finally { await view.context.close(); }
    });
  }
});

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
  const file = imageBackgroundFiles.find(candidate => candidate.path === path)!;
  const view = await visit(path, "dark", 360, false, true);
  try {
    expect(await view.page.locator(".dw-vbar").count()).toBe(0);
    expect(await selected(view.page)).toBe("Checker");
    const zoom = view.page.getByLabel("Actual size", { exact: true });
    for (const background of names) {
      if (await zoom.isChecked()) { await tabTo(view.page, zoom); await view.page.keyboard.press("Space"); }
      await choose(view.page, background);
      expect(await zoom.isChecked()).toBe(false);
      await layout(view.page, 360, false); await capture(view, file, `embed-${path}`, background, false);
      await tabTo(view.page, zoom); await view.page.keyboard.press("Space");
      expect(await zoom.isChecked()).toBe(true); expect(await selected(view.page)).toBe(background);
      await layout(view.page, 360, true); await capture(view, file, `embed-${path}`, background, true);
    }
    expect(await selected(view.page)).toBe("Dark"); expect(await zoom.isChecked()).toBe(true);
    // Real user wheel input complements the exhaustive ancestor-scroll probes.
    const image = view.page.locator(".dw-stage img"), before = (await image.boundingBox())!;
    const stage = (await view.page.locator(".dw-stage").boundingBox())!;
    await view.page.mouse.move(180, Math.min(850, stage.y + 100)); await view.page.mouse.wheel(200, 0);
    await expect.poll(async () => (await image.boundingBox())!.x, { message: "horizontal wheel reaches the inner scrollport" }).toBeLessThan(before.x - 1);
    await view.page.keyboard.press("PageDown");
    await expect.poll(async () => (await image.boundingBox())!.y, { message: "keyboard scrolling can use the outer document" }).toBeLessThan(before.y - 1);
    // Do not take pixel coordinates halfway through the native PageDown animation.
    let previous = "", stable = 0;
    await expect.poll(async () => {
      const position = JSON.stringify(await image.boundingBox());
      stable = position === previous ? stable + 1 : 0; previous = position; return stable;
    }, { message: "user scroll settles before coordinate sampling" }).toBeGreaterThanOrEqual(2);
    await assertReachableEdges(view.page);
    await capture(view, file, `embed-${path}-scrolled`, "Dark", true);
  } finally { await view.context.close(); }
});
