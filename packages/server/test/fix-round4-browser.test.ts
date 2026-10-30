import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker } from "./e2e-design/shots.mjs";

/**
 * Security Print fix round 4 (CEO TOG-39281, judge B4 F1 and F2), in a real browser against the core Worker:
 * - F1: a page that shows a secret once has no colour switch (DESIGN.md section 7, Mode switch), including the
 *   secrets the dashboard shows after load (a new owner key on /login, a new API key, a claim token).
 * - F2: a site's name and "#token=" never split at a hyphen (DESIGN.md section 7, Code): the claim page and the
 *   site-origin report page.
 * The Workers test runtime cannot run a browser, so this runs on Node with the harness's Worker (Miniflare) and the
 * Playwright Chromium CI installs (CHROME_PATH overrides it).
 */

// The page.evaluate() callbacks run in the browser; this Node test's tsconfig has no DOM library.
declare const document: any;
declare const location: any;
declare const innerWidth: number;

const APP = "https://kofra.test";
const BOOT = "round4-bootstrap-secret-0123456789abcdef";
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
let tmp: string;
let worker: Awaited<ReturnType<typeof startWorker>>;
let browser: Browser;
let owner: string;
let anonSlug: string;

async function api(path: string, init: RequestInit & { key?: string } = {}) {
  const { key, ...rest } = init;
  const res = await worker.mf.dispatchFetch(`${APP}/api/v1${path}`, { ...rest, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(rest.headers as Record<string, string> | undefined) } } as never);
  const body = (await res.json()) as Record<string, any>;
  if (res.status >= 400) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

/** A browser context whose requests to the instance's origins go to the Worker; `key` signs the dashboard in. */
async function open(opts: { key?: string; width?: number } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...PHONE, viewport: { width: opts.width ?? 390, height: 844 }, ignoreHTTPSErrors: true, reducedMotion: "reduce" });
  await context.route("**/*", async (route) => {
    const req = route.request();
    if (!/^https:\/\/([a-z0-9-]+\.)?kofra(-sites)?\.test\//.test(req.url())) return route.abort();
    const body = req.postDataBuffer();
    const res = await worker.mf.dispatchFetch(req.url(), { method: req.method(), headers: await req.allHeaders(), body: body && req.method() !== "GET" && req.method() !== "HEAD" ? body : undefined, redirect: "manual" } as never);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
  });
  if (opts.key) await context.addInitScript((key) => location.hostname === "kofra.test" && sessionStorage.setItem("dropway.key", key), opts.key);
  return { context, page: await context.newPage() };
}

/** Whether the colour switch shows, and whether the header is marked switch-less (k-noswitch). */
const header = (page: Page) =>
  page.evaluate(() => {
    const form = document.getElementById("dw-mode");
    return { switchShown: !!form && form.getClientRects().length > 0, noswitch: document.querySelector(".k-top")!.classList.contains("k-noswitch") };
  });

/** The text of every inline code element under `sel` that the browser laid out on more than one line. */
const split = (page: Page, sel: string) =>
  page.evaluate((s) => [...document.querySelectorAll(s)].filter((el: any) => el.getClientRects().length > 1).map((el: any) => el.textContent), sel);

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "kofra-round4-"));
  worker = await startWorker(tmp, { ADMIN_BOOTSTRAP_KEY: BOOT });
  owner = (await api("/setup", { method: "POST", key: BOOT, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@kofra.test" }) })).apiKey.key;
  // Multipart by hand (as the harness does): Node's FormData is not the one Miniflare's fetch serialises.
  const boundary = "----round4";
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="index.html"; filename="index.html"\r\nContent-Type: text/html\r\n\r\n<h1>Temp</h1>\r\n--${boundary}--\r\n`;
  anonSlug = (await api("/publish", { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body })).slug;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox", "--font-render-hinting=none"] });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await worker?.mf.dispose();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("F1: no colour switch while a secret is shown once", () => {
  it("API keys: creating a key hides the switch (header k-noswitch); it comes back when the key's block goes", async () => {
    const { context, page } = await open({ key: owner });
    try {
      await page.goto(`${APP}/dashboard/keys`);
      await page.waitForSelector("#dw-keys tbody tr");
      expect(await header(page)).toEqual({ switchShown: true, noswitch: false });
      await page.fill("#dw-k-name", "round 4 key");
      await page.click("text=Create key");
      await page.waitForSelector("#dw-keys .k-keyout");
      expect(await header(page)).toEqual({ switchShown: false, noswitch: true });
      // The key's use is set as code: its environment variable name never splits.
      expect(await page.textContent("#dw-keys .k-keyout p.k-small code.k-tok")).toBe("KOFRA_API_KEY");
      await page.evaluate(() => document.querySelector("[data-once]")!.remove());
      await page.waitForFunction(() => !document.getElementById("dw-mode")!.hidden);
      expect(await header(page)).toEqual({ switchShown: true, noswitch: false });
    } finally {
      await context.close();
    }
  });

  it("sign-in page: a new owner key (Lost the owner key?) hides the switch", async () => {
    const { context, page } = await open();
    try {
      await page.goto(`${APP}/login`);
      expect(await header(page)).toEqual({ switchShown: true, noswitch: false });
      await page.click("summary");
      await page.fill("#dw-recover-secret", BOOT);
      await page.click("#dw-recover button[type=submit]");
      await page.waitForSelector("#dw-recover .k-keyout");
      expect(await header(page)).toEqual({ switchShown: false, noswitch: true });
      expect(await page.textContent("#dw-recover .k-keyout p.k-small code.k-tok")).toBe("Authorization: Bearer <key>");
    } finally {
      await context.close();
    }
  });

  it("anonymous publish (home page): the claim token (shown once) hides the switch", async () => {
    const { context, page } = await open();
    try {
      await page.goto(`${APP}/`);
      await page.waitForSelector("#dw-quick .k-dropzone");
      expect(await header(page)).toEqual({ switchShown: true, noswitch: false });
      await page.locator("#dw-quick input[type=file]:not([webkitdirectory])").setInputFiles([{ name: "index.html", mimeType: "text/html", buffer: Buffer.from("<h1>anon</h1>") }]);
      await page.click('#dw-quick button:text-is("Publish")');
      await page.waitForSelector("#dw-quick [data-once] code");
      expect(await header(page)).toEqual({ switchShown: false, noswitch: true });
      // The published address wraps only between its parts, never inside the site's name or "kofra-sites".
      const parts = await page.locator("#dw-quick .k-keyout-row code.k-brk span").allTextContents();
      expect(parts[0]).toBe("https://");
      expect(parts.slice(2)).toEqual([".kofra-sites", ".test/"]);
    } finally {
      await context.close();
    }
  });

  it("a block that is not a secret (a member's publish result) keeps the switch", async () => {
    const { context, page } = await open({ key: owner });
    try {
      await page.goto(`${APP}/dashboard/publish`);
      await page.waitForSelector(".k-dropzone");
      await page.locator("#dw-publish input[type=file]:not([webkitdirectory])").setInputFiles([{ name: "index.html", mimeType: "text/html", buffer: Buffer.from("<h1>member</h1>") }]);
      await page.fill("#dw-pub-slug", "round4-member-site");
      await page.click("text=Publish >> nth=-1");
      await page.waitForSelector("#dw-publish .k-keyout");
      expect(await header(page)).toEqual({ switchShown: true, noswitch: false });
    } finally {
      await context.close();
    }
  });
});

describe("F2: a site's name never splits at a hyphen", () => {
  for (const width of [390, 320]) {
    it(`claim page at ${width}px: the name and #token= are whole tokens (code.k-tok), each on one line`, async () => {
      const { context, page } = await open({ width });
      try {
        // B4's name (merry-quartz-rf3bew), the generated name of this run, and the longest generated shape.
        for (const slug of ["merry-quartz-rf3bew", anonSlug, "plucky-sparrow-a1b2c3"]) {
          await page.goto(`${APP}/claim?slug=${slug}`);
          await page.evaluate(async () => void (await document.fonts.ready));
          expect(await page.locator(".k-state code.k-tok").allTextContents()).toEqual([slug, "#token="]);
          expect(await split(page, ".k-state p code")).toEqual([]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
      } finally {
        await context.close();
      }
    });

    it(`report page at ${width}px: the address wraps only after "/" and before "." (code.k-brk)`, async () => {
      const { context, page } = await open({ width });
      try {
        await page.goto(`https://${anonSlug}.kofra-sites.test/__dropway/report`);
        await page.evaluate(async () => void (await document.fonts.ready));
        expect(await page.locator(".k-state code.k-brk span").allTextContents()).toEqual(["https://", anonSlug, ".kofra-sites", ".test/"]);
        expect(await split(page, ".k-state code.k-brk span")).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally {
        await context.close();
      }
    });

    it(`publish result at ${width}px: the address breaks only at <wbr>; a name longer than a phone line may break inside itself`, async () => {
      const { context, page } = await open({ key: owner, width });
      try {
        // 39 characters, a name a member may choose (up to 56): longer than the 24 a 320px line holds.
        const slug = `a-long-member-site-name-for-phones-w${width}`;
        expect(slug.length).toBe(39);
        await page.goto(`${APP}/dashboard/publish`);
        await page.waitForSelector(".k-dropzone");
        await page.locator("#dw-publish input[type=file]:not([webkitdirectory])").setInputFiles([{ name: "index.html", mimeType: "text/html", buffer: Buffer.from(`<h1>${slug}</h1>`) }]);
        await page.fill("#dw-pub-slug", slug);
        await page.click("text=Publish >> nth=-1");
        await page.waitForSelector("#dw-publish .k-keyout-row code.k-brk a");
        await page.evaluate(async () => void (await document.fonts.ready));
        // The parts in order: nowrap spans for the short ones, the long name as a bare text node, <wbr> between them.
        const parts = await page.evaluate(() =>
          [...document.querySelector("#dw-publish .k-keyout-row code.k-brk a").childNodes].map((n: any) => (n.nodeType === 3 ? `text:${n.textContent}` : `${n.localName}:${n.textContent}`)),
        );
        expect(parts).toEqual(["span:https://", "wbr:", `text:${slug}`, "wbr:", "span:.kofra-sites", "wbr:", "span:.test/"]);
        expect(await split(page, "#dw-publish .k-keyout-row code.k-brk span")).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        // The address stays inside its dashed box: it wraps rather than running past the box's right edge.
        expect(
          await page.evaluate(() => {
            const code = document.querySelector("#dw-publish .k-keyout-row code.k-brk");
            const box = code.getBoundingClientRect();
            return [...code.getClientRects()].every((r: any) => r.right <= box.right + 0.5) && code.scrollWidth <= code.clientWidth;
          }),
        ).toBe(true);
      } finally {
        await context.close();
        await api(`/sites/${encodeURIComponent(`a-long-member-site-name-for-phones-w${width}`)}`, { method: "DELETE", key: owner }).catch(() => {});
      }
    });
  }
});
