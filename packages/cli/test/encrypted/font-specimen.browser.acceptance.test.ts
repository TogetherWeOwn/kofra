/**
 * Protected acceptance artifact: the paired Builder must not edit this file.
 * Real disposable local Worker, real font viewer/CSP, real Chromium, no UI mocks.
 * Uses the same local D1/R2/KV + unstable_startWorker pattern as tree-kind tests.
 *
 * npm ci --include=dev
 * npm ci --prefix packages/cli/test/encrypted --include=dev
 * npm run test:cli -- test/encrypted/font-specimen.browser.acceptance.test.ts
 * Optional: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH and runner LD_LIBRARY_PATH.
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
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { fontSpecimenBytes, FONT_SPECIMEN_PATH } from "../../../../test/fixtures/font-specimen";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
let browser: Browser | undefined;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let work: string;
let origin: string;
let specimen: string;

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "font-specimen-acceptance-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-font-specimen-acceptance", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "font-specimen-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "font-specimen-acceptance-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"),
    "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  const bootstrap = "local-font-specimen-bootstrap-fixture-only";
  worker = await unstable_startWorker({
    config, dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  origin = (await worker.url).origin;
  const setup = await fetch(`${origin}/api/v1/setup`, {
    method: "POST", headers: { Authorization: `Bearer ${bootstrap}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "font-fixture@example.test" }),
  });
  expect(setup.status, "disposable local owner must initialize").toBe(201);
  const key = (await setup.json() as any).apiKey.key;
  const form = new FormData();
  form.append("files", new File([fontSpecimenBytes() as Uint8Array<ArrayBuffer>], FONT_SPECIMEN_PATH));
  const published = await fetch(`${origin}/api/v1/publish`, {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  expect(published.status, "self-created font fixture must publish").toBe(201);
  const slug = (await published.json() as any).slug;
  specimen = `${origin}/s/${slug}/${FONT_SPECIMEN_PATH.split("/").map(encodeURIComponent).join("/")}`;
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

type View = {
  page: Page; context: BrowserContext; requests: { method: string; url: string; body: string | null; type: string }[];
  external: string[]; errors: string[];
};

async function visit(width = 1100, javaScriptEnabled = false, embed = false, fontUnavailable = false): Promise<View> {
  const context = await browser!.newContext({ javaScriptEnabled, serviceWorkers: "block", viewport: { width, height: 850 } });
  const page = await context.newPage();
  page.setDefaultTimeout(2000);
  const view: View = { page, context, requests: [], external: [], errors: [] };
  page.on("pageerror", error => view.errors.push(error.message));
  await context.route("**/*", async route => {
    const request = route.request();
    view.requests.push({ method: request.method(), url: request.url(), body: request.postData(), type: request.resourceType() });
    if (new URL(request.url()).origin !== origin) {
      view.external.push(request.url());
      return route.abort("blockedbyclient");
    }
    if (fontUnavailable && request.resourceType() === "font"
      && new URL(request.url()).pathname === new URL(specimen).pathname) return route.abort("failed");
    return route.continue();
  });
  try {
    const response = await page.goto(specimen + (embed ? "?view=1&embed=1" : ""), { waitUntil: "networkidle" });
    expect(response!.status()).toBe(200);
    expect(response!.headers()["x-kofra-viewer"]).toBe("font");
    await page.evaluate(() => (globalThis as any).document.fonts.ready);
    return view;
  } catch (error) { await context.close(); throw error; }
}

async function close(view: View) {
  try {
    expect(view.external, "font preview must never fetch an external asset or service").toEqual([]);
    expect(view.errors, "the real served viewer must not throw").toEqual([]);
  } finally { await view.context.close(); }
}

const STATIC_SIZES = [12, 16, 20, 28, 40, 56, 72];
const PANGRAM = "The quick brown fox jumps over the lazy dog";
const SAMPLE_LINES = [
  "Transient specimen café é مرحبا नमस्ते 日本語 😀",
  '<img src="https://example.invalid/font-sample-leak"> & <script>not markup</script>',
  "Final multiline specimen line",
];
const editable = (view: View) => view.page.locator('main [contenteditable]:not([contenteditable="false"]), main textarea');

async function text(sample: Locator): Promise<string> {
  return sample.evaluate((element: any) => element.tagName === "TEXTAREA" ? element.value : element.innerText);
}

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 40; step++) {
    if (await target.evaluate((element: any) => element === element.ownerDocument.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  expect.fail("the control/region must be reachable by Tab, not programmatic focus");
}

async function paint(control: Locator): Promise<string> {
  return control.evaluate((element: any) => {
    const w = globalThis as any;
    const label = element.id ? w.document.querySelector(`label[for="${w.CSS.escape(element.id)}"]`) : null;
    const nodes = [...new Set([element, element.closest("label"), label, element.parentElement].filter(Boolean))];
    return JSON.stringify(nodes.map((node: any) => [null, "::before", "::after"].map(pseudo => {
      const s = w.getComputedStyle(node, pseudo);
      if (s.display === "none" || Number(s.opacity) === 0) return null;
      const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 ? [s.outlineStyle, s.outlineWidth, s.outlineColor] : null;
      const border = s.borderStyle !== "none" && s.borderWidth.split(" ").some((value: string) => parseFloat(value) > 0)
        ? [s.borderStyle, s.borderWidth, s.borderColor] : null;
      return [outline, s.boxShadow, border, s.backgroundColor, s.color];
    })));
  });
}

async function sizePicker(view: View) {
  const page = view.page;
  const radios = page.getByRole("radio");
  const select = page.getByRole("combobox", { name: /size/i });
  const radioCount = await radios.count();
  expect(radioCount === 3 || await select.count() === 1,
    "offer three native, labelled sample-size presets: 16px, 32px (default), 64px").toBe(true);
  const radio = radioCount === 3;
  const options = radio ? radios : select.getByRole("option");
  expect(await options.count(), "exactly the three bounded presets, no arbitrary CSS input").toBe(3);
  for (const size of [16, 32, 64]) {
    const named = radio ? page.getByRole("radio", { name: new RegExp(`\\b${size}\\s*px\\b`, "i") })
      : select.getByRole("option", { name: new RegExp(`\\b${size}\\s*px\\b`, "i") });
    expect(await named.count(), `${size}px must have an accessible label`).toBe(1);
  }
  if (radio) {
    expect(await radios.evaluateAll((nodes: any[]) => nodes.every(node => node.tagName === "INPUT" && node.type === "radio"))).toBe(true);
    const names = await radios.evaluateAll((nodes: any[]) => nodes.map(node => node.name));
    expect(names[0], "native radios form one exclusive size group").toBeTruthy();
    expect(new Set(names).size).toBe(1);
    expect(await page.getByRole("radio", { name: /\b32\s*px\b/i }).isChecked(), "32px is checked on each fresh navigation").toBe(true);
  } else {
    expect(await select.evaluate((node: any) => node.tagName)).toBe("SELECT");
    expect(await select.locator("option:checked").innerText()).toMatch(/\b32\s*px\b/i);
  }
  return { radio, select, radios };
}

async function chooseSize(view: View, picker: Awaited<ReturnType<typeof sizePicker>>, size: number) {
  if (picker.radio) {
    const selected = view.page.locator('input[type="radio"]:checked');
    expect(await selected.count()).toBe(1);
    if (await selected.evaluate((node: any) => node === node.ownerDocument.activeElement)) await view.page.keyboard.press("Tab");
    const blurred = await paint(selected);
    await tabTo(view.page, selected);
    expect(await paint(selected), "native presets expose visible keyboard focus").not.toBe(blurred);
    const target = view.page.getByRole("radio", { name: new RegExp(`\\b${size}\\s*px\\b`, "i") });
    for (let attempt = 0; attempt < 3 && !await target.isChecked(); attempt++) await view.page.keyboard.press("ArrowRight");
    expect(await target.isChecked(), "Arrow keys choose the native preset without JavaScript").toBe(true);
    return target;
  }
  if (await picker.select.evaluate((node: any) => node === node.ownerDocument.activeElement)) await view.page.keyboard.press("Tab");
  const blurred = await paint(picker.select);
  await tabTo(view.page, picker.select);
  expect(await paint(picker.select), "native presets expose visible keyboard focus").not.toBe(blurred);
  await view.page.keyboard.press("Home");
  const options = await picker.select.locator("option").allTextContents();
  const index = options.findIndex(label => new RegExp(`\\b${size}\\s*px\\b`, "i").test(label));
  for (let step = 0; step < index; step++) await view.page.keyboard.press("ArrowDown");
  expect(await picker.select.locator("option:checked").innerText()).toMatch(new RegExp(`\\b${size}\\s*px\\b`, "i"));
  return picker.select;
}

async function staticAppearance(view: View) {
  return view.page.locator(".dw-font .big, .dw-font .set, .dw-fs p, .dw-fs span, .dw-font .dw-meta").evaluateAll((nodes: any[]) =>
    nodes.map(node => ({ text: node.textContent, size: (globalThis as any).getComputedStyle(node).fontSize })));
}

async function honestStaticRows(view: View) {
  const rows = view.page.locator(".dw-fs");
  expect(await rows.count(), "retain the existing seven labelled static sizes").toBe(STATIC_SIZES.length);
  for (let index = 0; index < STATIC_SIZES.length; index++) {
    const row = rows.nth(index);
    expect(await row.locator("span").isVisible()).toBe(true);
    expect((await row.locator("span").innerText()).trim()).toBe(`${STATIC_SIZES[index]}px`);
    const specimenText = row.locator("p");
    expect(await specimenText.isVisible()).toBe(true);
    expect((await specimenText.innerText()).trim()).toBe(PANGRAM);
    expect(await specimenText.evaluate((node: any) => (globalThis as any).getComputedStyle(node).fontSize)).toBe(`${STATIC_SIZES[index]}px`);
  }
}

async function completeStatic(view: View) {
  // Inspect actual glyph rectangles, not just textContent (hidden/ellipsized text
  // still has textContent). Accept wrapping OR a real keyboard scroll region.
  const report = await view.page.locator(".dw-fs p, .dw-font .set").evaluateAll((samples: any[]) => {
    const w = globalThis as any;
    const problems: string[] = [];
    const scrollRegions = new Set<number>();
    const all = [...w.document.querySelectorAll("*")];
    if (w.document.documentElement.scrollWidth > w.innerWidth + 2) problems.push("viewport has uncontrolled horizontal overflow");
    for (const sample of samples) {
      for (let ancestor = sample; ancestor && ancestor !== w.document.body; ancestor = ancestor.parentElement) {
        const s = w.getComputedStyle(ancestor);
        const box = ancestor.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || s.visibility === "hidden" || Number(s.opacity) === 0) problems.push("static specimen is not visible");
        if (s.textOverflow === "ellipsis" && ancestor.scrollWidth > ancestor.clientWidth + 2
          && /^(hidden|clip)$/.test(s.overflowX)) problems.push("static specimen still uses ellipsis");
      }
      const walker = w.document.createTreeWalker(sample, 4);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let index = 0; index < node.data.length; index++) {
          if (/\s/.test(node.data[index])) continue;
          const range = w.document.createRange();
          range.setStart(node, index); range.setEnd(node, index + 1);
          const glyph = range.getBoundingClientRect();
          for (let ancestor = node.parentElement; ancestor && ancestor !== w.document.body; ancestor = ancestor.parentElement) {
            const s = w.getComputedStyle(ancestor);
            const box = ancestor.getBoundingClientRect();
            const xOverflow = ancestor.scrollWidth > ancestor.clientWidth + 2;
            const yOverflow = ancestor.scrollHeight > ancestor.clientHeight + 2;
            const scrollX = xOverflow && /^(auto|scroll)$/.test(s.overflowX);
            const scrollY = yOverflow && /^(auto|scroll)$/.test(s.overflowY);
            if (scrollX || scrollY) {
              if (ancestor.tabIndex < 0) problems.push("overflow region is not explicitly keyboard reachable");
              else scrollRegions.add(all.indexOf(ancestor));
              break;
            }
            if (/^(hidden|clip)$/.test(s.overflowX) && (glyph.left < box.left - 2 || glyph.right > box.right + 2)) problems.push("static glyph clipped horizontally");
            if (/^(hidden|clip)$/.test(s.overflowY) && (glyph.top < box.top - 2 || glyph.bottom > box.bottom + 2)) problems.push("static glyph clipped vertically");
          }
        }
      }
    }
    return { count: samples.length, problems: [...new Set(problems)], scrollRegions: [...scrollRegions] };
  });
  expect(report.count, "the alphabet/punctuation set and all seven size rows remain").toBe(8);
  expect(report.problems, "complete static text must be readable rather than hidden or ellipsized").toEqual([]);
  for (const index of report.scrollRegions) {
    const region = view.page.locator("*").nth(index);
    await tabTo(view.page, region);
    const horizontal = await region.evaluate((node: any) => node.scrollWidth > node.clientWidth + 2);
    for (let step = 0; step < 8; step++) await view.page.keyboard.press(horizontal ? "ArrowRight" : "ArrowDown");
    await expect.poll(() => region.evaluate((node: any) => Math.abs(node.scrollLeft) + node.scrollTop)).toBeGreaterThan(0);
  }
}

async function persistence(view: View) {
  return view.page.evaluate(() => {
    const w = globalThis as any;
    const read = (key: string) => {
      try { return JSON.stringify(Object.entries(w[key]).sort()); }
      catch (error) { return (error as Error).name; } // opaque-origin sandbox is deliberately preserved
    };
    return { url: w.location.href, history: JSON.stringify(w.history.state), length: w.history.length,
      local: read("localStorage"), session: read("sessionStorage") };
  });
}

async function typeSample(view: View) {
  const sample = editable(view);
  expect(await sample.count()).toBe(1);
  await tabTo(view.page, sample);
  await view.page.keyboard.press("Control+A");
  for (let index = 0; index < SAMPLE_LINES.length; index++) {
    if (index) await view.page.keyboard.press("Enter");
    await view.page.keyboard.insertText(SAMPLE_LINES[index]!);
  }
  return sample;
}

describe("font specimen browser contract", () => {
  for (const javaScriptEnabled of [false, true]) {
    for (const width of [320, 1100]) {
      for (const size of [16, 32, 64]) {
        it(`${size}px at ${width}px, JS ${javaScriptEnabled ? "on" : "off"}: keyboard-only size and reset affect only editable text`, async () => {
          const view = await visit(width, javaScriptEnabled, width === 320);
          try {
            const sample = editable(view);
            expect(await sample.count()).toBe(1);
            expect(await sample.evaluate((node: any) => (globalThis as any).getComputedStyle(node).fontSize), "32px default before any interaction").toBe("32px");
            const initialText = await text(sample);
            const initialStatic = await staticAppearance(view);
            await honestStaticRows(view);
            const initialRequests = view.requests.length;
            const before = await persistence(view);
            const picker = await sizePicker(view);
            // For default, move away first: choosing 32px is also the reset.
            if (size === 32) await chooseSize(view, picker, 64);
            const target = picker.radio ? view.page.getByRole("radio", { name: new RegExp(`\\b${size}\\s*px\\b`, "i") }) : picker.select;
            const uncheckedPaint = await paint(target);
            const control = await chooseSize(view, picker, size);
            expect(await control.isVisible(), "selected native control must be visible").toBe(true);
            await view.page.keyboard.press("Tab");
            expect(await control.evaluate((node: any) => {
              const s = (globalThis as any).getComputedStyle(node);
              return (s.appearance !== "none" || node.tagName === "SELECT")
                && Number(s.opacity) > 0 && node.getBoundingClientRect().width >= 8;
            }) || await paint(control) !== uncheckedPaint,
            "the selected preset must have a visible native or styled selected state").toBe(true);
            expect(await sample.evaluate((node: any) => (globalThis as any).getComputedStyle(node).fontSize)).toBe(`${size}px`);
            expect(await text(sample), "size changes do not replace the existing editable sample").toBe(initialText);
            expect(await staticAppearance(view), "presets do not resize the alphabet, decorative sample, labels or metadata").toEqual(initialStatic);
            await honestStaticRows(view);
            await completeStatic(view);
            expect(view.requests.slice(initialRequests), "CSS size changes must not submit, navigate, refetch the font, or call an API").toEqual([]);
            expect(await persistence(view)).toEqual(before);
          } finally { await close(view); }
        });
      }
    }
  }

  for (const width of [320, 1100]) {
    it(`${width}px: all static specimens are complete without ellipsis or inaccessible clipping`, async () => {
      const view = await visit(width);
      try { await honestStaticRows(view); await completeStatic(view); }
      finally { await close(view); }
    });

    it(`${width}px: the editable sample is a labelled multiline textbox`, async () => {
      const view = await visit(width);
      try {
        const textbox = view.page.getByRole("textbox", { name: /.+/ });
        expect(await textbox.count(), "contenteditable needs textbox semantics and an accessible name").toBe(1);
        expect(await textbox.evaluate((node: any) => node.tagName === "TEXTAREA" || node.getAttribute("aria-multiline") === "true")).toBe(true);
      } finally { await close(view); }
    });

    it(`${width}px: Tab exposes a visible editable focus indicator with JS disabled`, async () => {
      const view = await visit(width);
      try {
        const sample = editable(view);
        const blurred = await paint(sample);
        await tabTo(view.page, sample);
        expect(await sample.evaluate((node: any) => node.matches(":focus-visible"))).toBe(true);
        expect(await paint(sample), "keyboard focus must change visible paint; outline:0 alone is not an indicator").not.toBe(blurred);
      } finally { await close(view); }
    });
  }

  for (const javaScriptEnabled of [false, true]) {
    it(`JS ${javaScriptEnabled ? "on" : "off"}: multiline Unicode and HTML-like input stays literal, local and transient`, async () => {
      const view = await visit(320, javaScriptEnabled);
      try {
        const before = await persistence(view);
        const cookies = await view.context.cookies();
        const initialRequests = view.requests.length;
        const sample = await typeSample(view);
        const value = await text(sample);
        for (const line of SAMPLE_LINES) expect(value).toContain(line);
        expect(value.split("\n").filter(Boolean).length, "Enter preserves separate editable lines").toBeGreaterThanOrEqual(3);
        expect(await sample.locator("img, script, iframe, a, style").count(), "typed HTML must not become markup").toBe(0);
        expect(await sample.evaluate((node: any) => (globalThis as any).getComputedStyle(node).whiteSpace)).not.toBe("nowrap");
        expect(await sample.evaluate((node: any) => {
          const s = (globalThis as any).getComputedStyle(node);
          return (node.scrollWidth <= node.clientWidth + 2 || /^(auto|scroll)$/.test(s.overflowX))
            && (node.scrollHeight <= node.clientHeight + 2 || /^(auto|scroll)$/.test(s.overflowY));
        }), "multiline input must grow/wrap or remain keyboard-scrollable, never be hidden").toBe(true);
        expect(view.requests.slice(initialRequests), "sample text never leaves the browser or triggers a form submission").toEqual([]);
        expect(await persistence(view)).toEqual(before);
        expect(await view.context.cookies()).toEqual(cookies);
        await view.page.reload({ waitUntil: "networkidle" });
        expect(await text(editable(view)), "reload must not restore user-entered specimen text").not.toContain(SAMPLE_LINES[0]);
      } finally { await close(view); }
    });
  }

  it("JS off: pasting rich HTML uses literal local text, never editable markup", async () => {
    const view = await visit(320);
    try {
      await view.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
      // Seed Chromium's real clipboard on the unsandboxed local app origin.
      // The viewer itself is unmodified and its CSP/JS-disabled mode remain real.
      const seed = await view.context.newPage();
      await seed.goto(origin + "/login", { waitUntil: "networkidle" });
      await seed.bringToFront();
      const plain = "Pasted literal <b>café 😀</b>\nSecond line";
      await seed.evaluate(async ({ plain }) => {
        const w = globalThis as any;
        await w.navigator.clipboard.write([new w.ClipboardItem({
          "text/plain": new w.Blob([plain], { type: "text/plain" }),
          "text/html": new w.Blob(['<b data-font-paste="1">Pasted literal &lt;b&gt;café 😀&lt;/b&gt;</b><p>Second line</p>'], { type: "text/html" }),
        })]);
      }, { plain });
      await seed.close();
      await view.page.bringToFront();
      const before = await persistence(view);
      const initialRequests = view.requests.length;
      const sample = editable(view);
      await tabTo(view.page, sample);
      await view.page.keyboard.press("Control+A");
      await view.page.keyboard.press("Control+V");
      await expect.poll(() => text(sample), { message: "the clipboard text must actually reach the real sample" }).toContain("Pasted literal <b>café 😀</b>");
      expect(await text(sample)).toContain("Second line");
      expect(await sample.locator("b, [data-font-paste], img, script, iframe, a, style").count(), "rich clipboard markup is not inserted into the editable sample").toBe(0);
      expect(await persistence(view)).toEqual(before);
      expect(view.requests.slice(initialRequests)).toEqual([]);
    } finally { await close(view); }
  });

  it("preserves typed Unicode/HTML-like multiline text while changing every size and resetting", async () => {
    const view = await visit(320);
    try {
      const picker = await sizePicker(view);
      const sample = await typeSample(view);
      const typed = await text(sample);
      const before = await persistence(view);
      const initialRequests = view.requests.length;
      for (const size of [16, 64, 32]) {
        await chooseSize(view, picker, size);
        expect(await sample.evaluate((node: any) => (globalThis as any).getComputedStyle(node).fontSize)).toBe(`${size}px`);
        expect(await text(sample)).toBe(typed);
        expect(await sample.locator("img, script, iframe, a, style").count()).toBe(0);
      }
      expect(await persistence(view)).toEqual(before);
      expect(view.requests.slice(initialRequests)).toEqual([]);
    } finally { await close(view); }
  });

  it("keeps a usable editable fallback when the uploaded font resource fails to load", async () => {
    const view = await visit(320, false, false, true);
    try {
      const sample = await typeSample(view);
      for (const line of SAMPLE_LINES) expect(await text(sample)).toContain(line);
      expect(await sample.isVisible()).toBe(true);
      const statuses = await view.page.evaluate(() => [...(globalThis as any).document.fonts]
        .filter((font: any) => font.family === "dw-specimen").map((font: any) => font.status));
      expect(statuses).toEqual(["error"]);
      expect(view.requests.filter(request => request.type === "font"
        && new URL(request.url).pathname === new URL(specimen).pathname)).toHaveLength(1);
    } finally { await close(view); }
  });

  it("loads one escaped sites-origin font resource, preserves fallback, and adds no script or form", async () => {
    const view = await visit();
    try {
      expect(await view.page.locator("script, form").count()).toBe(0);
      const fonts = view.requests.filter(request => request.type === "font"
        && new URL(request.url).pathname === new URL(specimen).pathname);
      expect(fonts, "one font resource path, not a font parser/service or per-size resources").toHaveLength(1);
      expect(new URL(fonts[0]!.url).origin).toBe(origin);
      expect(decodeURIComponent(new URL(fonts[0]!.url).pathname)).toBe(decodeURIComponent(new URL(specimen).pathname));
      expect(fonts[0]!.method).toBe("GET");
      const loaded = await view.page.evaluate(() => [...(globalThis as any).document.fonts]
        .filter((font: any) => font.family === "dw-specimen").map((font: any) => ({ family: font.family, status: font.status })));
      expect(loaded).toEqual([{ family: "dw-specimen", status: "loaded" }]);
      expect(await editable(view).evaluate((node: any) => (globalThis as any).getComputedStyle(node).fontFamily)).toMatch(/serif|system-ui|monospace/i);
    } finally { await close(view); }
  });
});
