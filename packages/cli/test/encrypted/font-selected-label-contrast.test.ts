/** Browser regression for selected font-size label contrast in both color schemes. */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
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
    if (fontUnavailable && request.resourceType() === "font") return route.abort("failed");
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


it("selected preset label meets WCAG AA text contrast in light and dark themes", async () => {
  for (const width of [320, 1100]) {
    const view = await visit(width, false);
    try {
      for (const scheme of ["light", "dark"] as const) {
        await view.page.emulateMedia({ colorScheme: scheme });
        for (const size of [32, 16, 64]) {
          const radio = view.page.getByRole("radio", { name: new RegExp(`^${size}\\s*px`, "i") });
          await radio.check();
          const ratio = await radio.evaluate((input: any) => {
            const label = input.closest("label");
            const style = (globalThis as any).getComputedStyle(label);
            function rgb(color: string): number[] {
              const match = color.match(/^rgba?\(([^)]+)\)$/);
              if (!match) throw new Error(`Unexpected color: ${color}`);
              return match[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
            }
            const foreground = rgb(style.color);
            let node = label;
            let background: number[] = [];
            while (node) {
              background = rgb((globalThis as any).getComputedStyle(node).backgroundColor);
              if (background.length < 4 || background[3] === 1) break;
              if (background[3] !== 0) throw new Error("Translucent background needs compositing");
              node = node.parentElement;
            }
            if (!node) throw new Error("No opaque background found");
            function luminance(channels: number[]) {
              const linear = channels.slice(0, 3).map(value => {
                const c = value / 255;
                return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
              });
              return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
            }
            const a = luminance(foreground), b = luminance(background);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          });
          expect(ratio, `${scheme}, ${width}px, ${size}px selected`).toBeGreaterThanOrEqual(4.5);
        }
      }
    } finally { await close(view); }
  }
}, 120_000);
