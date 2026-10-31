// rebrand:keep-file
// Exercise deploy output, not a Vite transform or a dev rebuild of the sources.
import { execFile } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { createTestHarness, unstable_readConfig, type TestHarness } from "wrangler";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeDocument } from "../../cli/test/encrypted/dashboard-rename-vm-dom.helpers";
import { normalizeQrNotice, QR_COPYRIGHT, QR_MIT_TERMS } from "../../../test/qr-license.fixture";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));
let scratch: string | undefined;
let worker: TestHarness | undefined;
let origin: string;
let html: string;
let scriptPath: string;
let script: string;
let asset: Response;

async function dispose() {
  const running = worker;
  worker = undefined;
  try { await running?.close(); }
  finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
}

beforeAll(async () => {
  try {
    scratch = await mkdtemp(join(tmpdir(), "kofra-dashboard-artifact-"));
    const outdir = join(scratch, "build");
    const configPath = join(root, "wrangler.jsonc");
    const config = unstable_readConfig({ config: configPath });
    const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
    const buildEnv: NodeJS.ProcessEnv = { CI: "true", WRANGLER_SEND_METRICS: "false" };
    for (const name of ["PATH", "HOME", "TMPDIR", "SystemRoot", "LD_LIBRARY_PATH"]) {
      if (process.env[name]) buildEnv[name] = process.env[name];
    }
    // No build/minify/legal-comment overrides: use the actual deploy pipeline
    // and checked-in config. --dry-run never deploys or binds remote services.
    await exec(process.execPath, [wrangler, "deploy", "--dry-run", "--config", configPath, "--outdir", outdir], {
      cwd: root, env: buildEnv, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
    });
    // Native prebuiltWorkerDir loads these emitted modules without rebuilding
    // source. The harness supplies disposable local Miniflare/workerd bindings
    // from the same config, including compatibility flags and Analytics Engine.
    worker = createTestHarness({ root, workers: [{ configPath, prebuiltWorkerDir: outdir }] });
    origin = (await worker.listen()).url.origin;
    const bindings = await worker.getWorker().getEnv();
    for (const binding of config.d1_databases) {
      const db: D1Database = bindings[binding.binding];
      const migrations = await readD1Migrations(join(root, binding.migrations_dir!));
      for (const migration of migrations) await db.batch(migration.queries.map(sql => db.prepare(sql)));
    }
    const page = await fetch(`${origin}/dashboard/publish`);
    expect(page.status, "built Worker serves its dashboard shell over HTTP").toBe(200);
    html = await page.text();
    const path = /<script\b[^>]*\bsrc="(\/__dropway\/ui\/app-[a-f0-9]+\.js)"[^>]*>/.exec(html)?.[1];
    expect(path, "discover the current hashed asset from the built Worker's shell").toBeTruthy();
    scriptPath = path!;
    asset = await fetch(new URL(scriptPath, origin));
    expect(asset.status, scriptPath).toBe(200);
    script = await asset.text();
  } catch (error) {
    await dispose();
    throw error;
  }
}, 120_000);
afterAll(dispose, 30_000);

it("serves the discovered deploy-built dashboard asset as immutable JavaScript", () => {
  expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(script.length).toBeGreaterThan(0);
});

it("retains the complete original QR copyright and MIT terms in deploy-built HTTP bytes", () => {
  const notice = normalizeQrNotice(script);
  const message = `${scriptPath}, ${Buffer.byteLength(script)} bytes: the browser must receive the original QR notice`;
  expect(notice.includes(QR_COPYRIGHT), `${message} (copyright)`).toBe(true);
  expect(notice.includes(normalizeQrNotice(QR_MIT_TERMS)), `${message} (complete permission, inclusion condition and disclaimer)`).toBe(true);
});

it("boots the same deploy-built script without a module loader and sends a signed-out publisher to sign-in", () => {
  // Reuse the existing DOM/VM harness, without claiming browser/layout coverage.
  // Only the script and boot JSON obtained from this built Worker's HTTP paths
  // are executed; no client or QR implementation is imported into this test.
  const doc = new FakeDocument();
  const page = /<body\b[^>]*\bdata-page="([^"]+)"/.exec(html)?.[1];
  expect(page).toBe("publish");
  doc.body.setAttribute("data-page", page!);
  const boot = /<script\b(?=[^>]*\bid="dw-boot")[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  expect(boot).toBeTruthy();
  for (const [tag, id, text] of [["script", "dw-boot", boot!], ["div", "dw-account", ""], ["div", "dw-publish", ""], ["div", "dw-toasts", ""]]) {
    expect(html).toContain(`id="${id}"`);
    const element = doc.createElement(tag!);
    element.id = id!;
    element.textContent = text!;
    doc.body.appendChild(element);
  }
  class Storage {
    values = new Map<string, string>();
    getItem(key: string) { return this.values.get(key) ?? null; }
    setItem(key: string, value: string) { this.values.set(key, String(value)); }
    removeItem(key: string) { this.values.delete(key); }
  }
  const errors: unknown[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const location = {
    origin, pathname: "/dashboard/publish", search: "", href: `${origin}/dashboard/publish`,
    replace(value: string) { this.href = new URL(value, origin).href; },
  };
  const sandbox: Record<string, unknown> = {
    document: doc, location, sessionStorage: new Storage(), localStorage: new Storage(),
    crypto: webcrypto, Headers, Request, Response, URL, URLSearchParams, Blob, TextEncoder, FormData, AbortController,
    console: { ...console, error: (...args: unknown[]) => errors.push(args) },
    fetch: async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, origin);
      if (url.origin !== origin || !["GET", "HEAD"].includes(init.method ?? "GET")) throw Error("unexpected fixture request");
      return fetch(url, init);
    },
    setTimeout: (fn: () => void, delay?: number) => {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  try {
    new vm.Script(script, { filename: scriptPath }).runInNewContext(sandbox, { timeout: 5000 });
    const destination = new URL(location.href);
    expect(destination.origin).toBe(origin);
    expect(destination.pathname).toBe("/login");
    expect(destination.searchParams.get("next")).toBe("/dashboard/publish");
    expect(errors).toEqual([]);
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
});
