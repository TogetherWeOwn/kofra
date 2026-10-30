/** Real Chromium HTTP-cache contract; routing/interception would disable the cache being tested. */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Browser, CDPSession, Page } from "playwright";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const html = '<!doctype html><html><head><meta charset="utf-8"><title>Cache metadata</title><link rel="icon" href="data:,"></head><body><h1>The document bytes never change.</h1></body></html>';
const bootstrap = "header-cache-browser-fixture-only";
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let browser: Browser | undefined;
let work: string;
let origin: string;
let ownerKey: string;

type Wire = { url?: string; conditional?: string; status?: number; language?: string; effectiveStatus?: number; effectiveLanguage?: string };
function header(headers: Record<string, unknown>, name: string) {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry ? String(entry[1]) : undefined;
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "header-cache-browser-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-header-cache-browser", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "header-cache-browser", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "header-cache-browser-files" }], kv_namespaces: [{ binding: "CACHE" }],
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
    body: JSON.stringify({ email: "cache-browser@example.test" }),
  });
  expect(setup.status).toBe(201);
  ownerKey = (await setup.json() as { apiKey: { key: string } }).apiKey.key;
  const { chromium } = require("playwright") as typeof import("playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function publish(slug: string, language: string | null, version: number) {
  const files = [{ path: "index.html", content: html }];
  if (language !== null) files.push({ path: "_headers", content: `/index.html\n  Content-Language: ${language}\n` });
  const response = await fetch(`${origin}/api/v1/publish`, {
    method: "POST", headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ site: slug, files }),
  });
  const body = await response.json() as { version: { number: number }; warnings: { code: string }[] };
  expect(response.status, JSON.stringify(body)).toBe(version === 1 ? 201 : 200);
  expect(body.version.number).toBe(version);
  expect(body.warnings.filter(warning => warning.code === "invalid_hosting_rule")).toEqual([]);
}

async function observe(page: Page, url: string) {
  const session: CDPSession = await page.context().newCDPSession(page);
  const wires = new Map<string, Wire>();
  function entry(id: string) {
    if (!wires.has(id)) wires.set(id, {});
    return wires.get(id)!;
  }
  // Passive CDP events preserve Chromium's own conditional requests and cache merging.
  session.on("Network.requestWillBeSent", event => { entry(event.requestId).url = event.request.url; });
  session.on("Network.requestWillBeSentExtraInfo", event => { entry(event.requestId).conditional = header(event.headers, "if-none-match"); });
  session.on("Network.responseReceivedExtraInfo", event => {
    Object.assign(entry(event.requestId), { status: event.statusCode, language: header(event.headers, "content-language") });
  });
  session.on("Network.responseReceived", event => {
    Object.assign(entry(event.requestId), { effectiveStatus: event.response.status, effectiveLanguage: header(event.response.headers, "content-language") });
  });
  await session.send("Network.enable");
  return {
    session,
    responses: () => [...wires.values()].filter(wire => wire.url === url),
    navigate: async () => {
      const response = await page.goto(url, { waitUntil: "networkidle" });
      expect(response).not.toBeNull();
      expect(response!.status()).toBe(200);
      expect(await page.locator("h1").textContent()).toBe("The document bytes never change.");
      return response!;
    },
  };
}

describe("served header metadata in Chromium's real HTTP cache", () => {
  it("revalidates an unchanged representation with an actual conditional request and wire 304", async () => {
    const slug = "browser-header-stable";
    await publish(slug, "fr", 1);
    const context = await browser!.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const observed = await observe(page, `${origin}/s/${slug}/index.html`);
      const first = await observed.navigate();
      const etag = (await first.allHeaders()).etag;
      expect(etag).toBeTruthy();
      const repeated = await observed.navigate();
      expect((await repeated.allHeaders())["content-language"]).toBe("fr");
      expect(observed.responses()).toHaveLength(2);
      expect(observed.responses()[1], JSON.stringify(observed.responses())).toMatchObject({ conditional: etag, status: 304, language: "fr" });
      await observed.session.detach();
    } finally { await context.close(); }
  }, 60_000);

  it.each([{ change: "removed", language: null }, { change: "changed", language: "en" }])("does not retain cached v1 metadata when Content-Language is $change", async ({ change, language }) => {
    const slug = `browser-header-${change}`;
    await publish(slug, "fr", 1);
    const context = await browser!.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const observed = await observe(page, `${origin}/s/${slug}/index.html`);
      const first = await observed.navigate();
      const etag = (await first.allHeaders()).etag;
      expect(etag).toBeTruthy();
      expect((await first.allHeaders())["content-language"]).toBe("fr");
      await observed.navigate();
      expect(observed.responses()).toHaveLength(2);
      expect(observed.responses()[1], JSON.stringify(observed.responses())).toMatchObject({ conditional: etag, status: 304 });
      await publish(slug, language, 2);
      const current = await observed.navigate();
      const effective = await current.allHeaders();
      const wires = observed.responses();
      const diagnostic = `effective Content-Language=${effective["content-language"] ?? "absent"}; wire observations=${JSON.stringify(wires)}`;
      expect(wires).toHaveLength(3);
      expect(wires[2]?.effectiveStatus, diagnostic).toBe(200);
      expect(wires[2]?.effectiveLanguage ?? null, diagnostic).toBe(language);
      expect(effective["content-language"] ?? null, diagnostic).toBe(language);
      expect(wires[2]?.conditional, diagnostic).toBe(etag);
      expect(wires[2]?.status, diagnostic).toBe(200);
      expect(effective.etag).toBeTruthy();
      expect(effective.etag).not.toBe(etag);
      await observed.session.detach();
    } finally { await context.close(); }
  }, 60_000);
});
