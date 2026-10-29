/**
 * Real-server acceptance for the destructive-confirmation canonical-slug contract.
 * A disposable local Worker (workerd with local D1/R2/KV) serves the real API:
 * site names resolve case-insensitively, the stored slug is canonical lowercase,
 * and DELETE of a version requires `confirm` to equal that canonical slug exactly.
 * The real CLI and the real served dashboard are driven with a NON-canonical name.
 * No production or staging calls; only test files are changed.
 * Run: npm run test:cli -- test/encrypted/canonical-version-delete.acceptance.test.ts
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { run, type Io } from "../../src/main.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
const BOOTSTRAP = "canonical-delete-disposable-bootstrap-0123456789";

let work: string;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let browser: Browser | undefined;
let origin: string;
let ownerKey: string;
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "canonical-delete-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-canonical-delete-test", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "canonical-delete-test", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "canonical-delete-test-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"),
    "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config, dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: BOOTSTRAP } },
  });
  await worker.ready;
  origin = (await worker.url).origin;
  const setup = await post("/api/v1/setup", { email: "canonical@example.test" }, BOOTSTRAP);
  ownerKey = setup.apiKey.key;
  const { chromium } = require("playwright");
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
}, 120_000);

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function post(path: string, body: unknown, key: string) {
  const response = await fetch(origin + path, { method: "POST", headers: {
    Authorization: `Bearer ${key}`, "Content-Type": "application/json",
  }, body: JSON.stringify(body) });
  expect(response.ok, `disposable fixture setup ${path}: ${response.status}`).toBe(true);
  return response.json() as Promise<any>;
}

/** Real publishes: version N has index.html "<label N>"; the last one is live. */
async function seedSite(slug: string, versions: number) {
  for (let n = 1; n <= versions; n++) {
    await post("/api/v1/publish", { slug, files: [{ path: "index.html", content: `<h1>${slug} v${n}</h1>`, contentType: "text/html" }] }, ownerKey);
  }
}

async function history(slug: string) {
  const response = await fetch(`${origin}/api/v1/sites/${slug}/versions?limit=100`, { headers: { Authorization: `Bearer ${ownerKey}` } });
  expect(response.status).toBe(200);
  const body = await response.json() as { currentVersionId: string; versions: { id: string; number: number; live: boolean }[] };
  return { live: body.currentVersionId, numbers: body.versions.map(version => version.number).sort((a, b) => a - b), versions: body.versions };
}

const confirmationOf = (url: string, body: string | null) =>
  new URL(url).searchParams.get("confirm") ?? (body ? JSON.parse(body).confirm : undefined);

async function cli(args: string[], answer?: string) {
  const config = await mkdtemp(join(work, "cli-"));
  const requests: { method: string; url: string; body: string }[] = [];
  const prompts: string[] = [];
  let output = "";
  const io: Io = {
    cwd: config, env: { KOFRA_CONFIG_DIR: join(config, "config"), KOFRA_API_KEY: ownerKey },
    stdout: s => { output += s; }, stderr: s => { output += s; },
    stdinIsTTY: answer !== undefined, stderrIsTTY: answer !== undefined,
    readStdin: async () => "", prompt: async question => { prompts.push(question); return answer ?? ""; },
    fetch: async req => {
      requests.push({ method: req.method, url: req.url, body: await req.clone().text() });
      return fetch(req);
    },
  };
  const code = await run([...args, "--api", origin], io);
  return { code, output, requests, prompts, writes: requests.filter(request => !["GET", "HEAD"].includes(request.method)) };
}

describe("server contract this suite relies on (control: passes before and after the client fixes)", () => {
  it("resolves a non-canonical name case-insensitively but demands the canonical slug as confirmation", async () => {
    await seedSite("real-rest-control", 3);
    const target = (await history("real-rest-control")).versions.find(version => version.number === 1)!;
    const send = (confirm: string) => fetch(`${origin}/api/v1/sites/Real-REST-Control/versions/${target.id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirm }),
    });
    const refused = await send("Real-REST-Control");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: "confirm_mismatch" } });
    expect((await history("real-rest-control")).numbers, "a refused confirmation deletes nothing").toEqual([1, 2, 3]);
    const accepted = await send("real-rest-control");
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ deleted: true, id: target.id });
    expect((await history("real-rest-control")).numbers).toEqual([2, 3]);
  });
});

describe("real CLI against the real server with a non-canonical site name", () => {
  it("--yes deletes the historical version because the canonical stored slug is confirmed", async () => {
    await seedSite("real-cli-yes", 3);
    const before = await history("real-cli-yes");
    expect(before.numbers).toEqual([1, 2, 3]);
    const r = await cli(["delete", "Real-CLI-Yes", "--version", "v1", "--yes"]);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]!.method).toBe("DELETE");
    expect(confirmationOf(r.writes[0]!.url, r.writes[0]!.body), "the wire confirmation is the canonical stored slug").toBe("real-cli-yes");
    expect(r.code, r.output).toBe(0);
    const after = await history("real-cli-yes");
    expect(after.numbers, "only v1 is gone; the newer versions remain").toEqual([2, 3]);
    expect(after.live, "the live version is untouched").toBe(before.live);
  });

  it("an accepted typed prompt deletes with the canonical slug; a refused one sends no mutation", async () => {
    await seedSite("real-cli-prompt", 3);
    const refused = await cli(["delete", "Real-CLI-Prompt", "--version", "v1"], "not-the-site");
    expect(refused.prompts).toHaveLength(1);
    expect(refused.code).not.toBe(0);
    expect(refused.writes).toEqual([]);
    expect((await history("real-cli-prompt")).numbers).toEqual([1, 2, 3]);
    const accepted = await cli(["delete", "Real-CLI-Prompt", "--version", "v1"], "Real-CLI-Prompt");
    expect(accepted.prompts).toHaveLength(1);
    expect(accepted.prompts[0]!.toLowerCase()).toContain("real-cli-prompt");
    expect(accepted.writes).toHaveLength(1);
    expect(confirmationOf(accepted.writes[0]!.url, accepted.writes[0]!.body)).toBe("real-cli-prompt");
    expect(accepted.code, accepted.output).toBe(0);
    expect((await history("real-cli-prompt")).numbers).toEqual([2, 3]);
  });
});

/** Sign in and open the dashboard site page at an explicit (possibly non-canonical) path. */
async function openDashboard(pathSlug: string) {
  const context = await browser!.newContext({ serviceWorkers: "block", viewport: { width: 1100, height: 900 } });
  contexts.push(context);
  const page: Page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  const writes: { method: string; url: string; body: string | null; status?: number }[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (!["GET", "HEAD"].includes(request.method())) writes.push({ method: request.method(), url: request.url(), body: request.postData() });
  });
  page.on("response", response => {
    const request = response.request();
    if (["GET", "HEAD"].includes(request.method())) return;
    const write = writes.find(candidate => candidate.url === request.url() && candidate.status === undefined);
    if (write) write.status = response.status();
  });
  await page.goto(`${origin}/login`);
  await page.getByLabel(/api key/i).fill(ownerKey);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 15_000 });
  writes.length = 0;
  const response = await page.goto(`${origin}/dashboard/sites/${pathSlug}`, { waitUntil: "networkidle" });
  expect(response!.status()).toBe(200);
  const versions = page.locator("section").filter({ has: page.getByRole("heading", { name: /^versions$/i }) });
  const row = (number: number) => versions.getByRole("row").filter({ hasText: new RegExp(`\\bv${number}\\b`) });
  await expect.poll(() => row(1).count(), { message: "the non-canonical path loads the site's history" }).toBe(1);
  return { page, row, writes, errors };
}

describe("served dashboard opened at a non-canonical path", () => {
  it("cancelling the existing dialog sends no delete and leaves the history intact", async () => {
    await seedSite("dash-cancel-site", 3);
    const view = await openDashboard("DASH-CANCEL-SITE");
    await view.row(1).getByRole("button", { name: /^delete version 1$/i }).click();
    const dialog = view.page.getByRole("dialog");
    expect(await dialog.innerText()).toContain("Delete v1?");
    await dialog.getByRole("button", { name: /^cancel$/i }).click();
    await view.page.waitForTimeout(300);
    expect(view.writes).toEqual([]);
    expect(await view.row(1).count()).toBe(1);
    expect((await history("dash-cancel-site")).numbers).toEqual([1, 2, 3]);
    expect(view.errors).toEqual([]);
  });

  it("an accepted delete sends the canonical loaded slug and removes only that version", async () => {
    await seedSite("dash-accept-site", 3);
    const before = await history("dash-accept-site");
    const view = await openDashboard("DASH-ACCEPT-SITE");
    await view.row(1).getByRole("button", { name: /^delete version 1$/i }).click();
    const dialog = view.page.getByRole("dialog");
    expect(await dialog.innerText()).toContain("Delete v1?");
    await dialog.getByRole("button", { name: /^delete version$/i }).click();
    await expect.poll(() => view.writes.filter(write => write.method === "DELETE").length).toBe(1);
    const write = view.writes.find(candidate => candidate.method === "DELETE")!;
    expect(new URL(write.url).pathname.toLowerCase()).toContain("/api/v1/sites/dash-accept-site/versions/");
    expect(confirmationOf(write.url, write.body), "the wire confirmation is the canonical site.slug the page loaded, not the typed path").toBe("dash-accept-site");
    await expect.poll(() => write.status, { message: "the real server accepted the confirmation" }).toBe(200);
    await expect.poll(() => view.row(1).count(), { message: "a successful delete refreshes the displayed history" }).toBe(0);
    const after = await history("dash-accept-site");
    expect(after.numbers).toEqual([2, 3]);
    expect(after.live, "the live version is untouched").toBe(before.live);
    expect(view.errors).toEqual([]);
  });
});
