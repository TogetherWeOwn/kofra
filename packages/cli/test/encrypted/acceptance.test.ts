/**
 * Black-box acceptance for encrypted CLI publishing. No product crypto helpers,
 * envelope parser, mock loader, CSP override, or authentication bypass.
 *
 * Browser prerequisite (dependencies declared only in this test harness):
 *   npm ci --include=dev
 *   npm ci --prefix packages/cli/test/encrypted --include=dev
 *   packages/cli/test/encrypted/node_modules/.bin/playwright install --with-deps chromium
 *   npm run test:cli -- test/encrypted/acceptance.test.ts
 *
 * Optional: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH selects an existing Chromium.
 * Temporary Worker config/state and fixtures stay under PAPERCLIP_RUN_SCRATCH_DIR
 * (or the OS temp directory outside the managed runner). No remote Worker calls.
 *
 * Observation seam: execute the actual HTTP-delivered loader in Chromium and
 * observe its real WebCrypto decrypt calls. The fragment must contain a raw
 * 32-byte key encoded as base64/base64url or hex, bare or in a named component.
 * No envelope property names, product exports, or loader selectors are required.
 * The fixture deliberately exercises only relative script/fetch asset URLs.
 */
import { execFile } from "node:child_process";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { strToU8, zipSync } from "fflate";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, type Io } from "../../src/main.ts";
import { workerEntry } from "../encrypted-mutation-worker.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const marker = "private-r47-page-c9a1d4";
const assetMarker = "private-r47-asset-4e07fb";
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Private fixture</title></head><body><h1>${marker}</h1><script src="./assets/app.js"></script></body></html>`;
const script = `Promise.all(['./bytes.bin', './index.html', './assets/app.js'].map(path => fetch(path).then(r => { if (!r.ok) throw Error('fixture fetch failed'); return r.arrayBuffer(); }).then(b => Array.from(new Uint8Array(b))))).then(([bytes, page, source]) => { window.fixtureResult = { asset: '${assetMarker}', bytes, page, source }; document.querySelector('h1').dataset.ready = 'yes'; });`;
// Includes zero, invalid UTF-8 and every byte value; a text-only round trip fails.
const binary = Buffer.from(Array.from({ length: 521 }, (_, i) => (i * 73 + 19) % 256));
const files = { "index.html": Buffer.from(html), "assets/app.js": Buffer.from(script), "bytes.bin": binary };
const bootstrap = "encrypted-acceptance-bootstrap-0123456789abcdef";

type Wire = { method: string; url: string; headers: string; body: Buffer };
type Ran = { code: number; stdout: string; stderr: string; json: any; wire: Wire[] };
type Decrypt = {
  algorithm: string; bits: number; iv: number[]; aad: number[] | null;
  tagLength: number; ciphertext: number[]; plaintext?: number[]; rejected?: boolean;
};
// Runtime-loaded so test authoring doesn't change product manifests. Absence is a
// harness error, not an encrypted-publish failure or a reason to silently skip.
const require = createRequire(import.meta.url);
let browser: any;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let api: string;
let work: string;
let fixture: string;
let configDir: string;
let apiKey: string;

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "encrypted-acceptance-"));
  configDir = join(work, "credentials");
  fixture = join(work, "fixture");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(fixture, path, ".."), { recursive: true });
    await writeFile(join(fixture, path), content);
  }
  // Dedicated local configuration, not the root deploy config or shared state.
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-encrypted-acceptance", main: await workerEntry(root, work),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "encrypted-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "encrypted-acceptance-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config,
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  api = (await worker.url).origin;
  const setup = await cli(["setup", "--email", "encrypted@example.com", "--json"], { bootstrap: true });
  expect(setup.code, setup.stdout + setup.stderr).toBe(0);
  apiKey = JSON.parse(await readFile(join(configDir, "credentials.json"), "utf8")).instances[api].key;
  const { chromium } = require("playwright");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function cli(args: string[], opts: { bootstrap?: boolean } = {}): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  const wire: Wire[] = [];
  const io: Io = {
    stdout: t => void (stdout += t), stderr: t => void (stderr += t),
    stdinIsTTY: false, stderrIsTTY: false, readStdin: async () => "",
    prompt: async () => { throw new Error("acceptance must not prompt"); },
    cwd: work,
    env: { KOFRA_API: api, KOFRA_CONFIG_DIR: configDir, ...(opts.bootstrap ? { KOFRA_BOOTSTRAP_KEY: bootstrap } : {}) },
    fetch: async request => {
      expect(new URL(request.url).origin, "CLI must only contact the local Worker").toBe(api);
      const body = Buffer.from(await request.clone().arrayBuffer());
      wire.push({ method: request.method, url: request.url, headers: JSON.stringify([...request.headers]), body });
      return fetch(request);
    },
  };
  const code = await run(args, io);
  let json: any = null;
  try { json = JSON.parse(stdout); } catch { /* help is human text */ }
  return { code, stdout, stderr, json, wire };
}

async function encrypted(): Promise<Ran> {
  const result = await cli(["publish", fixture, "--encrypt", "--json", "--no-save"]);
  expect(result.code, `encrypted publish must succeed; got ${result.stdout}${result.stderr}`).toBe(0);
  expect(result.json?.ok).toBe(true);
  expect(typeof result.json?.url).toBe("string");
  expect(new URL(result.json.url).hash.length, "the share key belongs in a fragment").toBeGreaterThan(1);
  return result;
}

/** Encoding-neutral at the envelope boundary; only standard raw key encodings. */
function fragmentKey(url: string): { token: string; bytes: Buffer } {
  const fragment = decodeURIComponent(new URL(url).hash.slice(1));
  const candidates = [fragment, ...fragment.split(/[=&:!~.]/)];
  for (const token of candidates) {
    if (/^[0-9a-f]{64}$/i.test(token)) return { token, bytes: Buffer.from(token, "hex") };
    if (/^[A-Za-z0-9_+/-]{43}=?$/.test(token)) {
      const bytes = Buffer.from(token, "base64url");
      if (bytes.length === 32) return { token, bytes };
    }
  }
  throw new Error("share fragment must carry a 256-bit key (base64url/base64/hex); no envelope layout is assumed");
}

function assertPrivate(wire: Wire[], key?: ReturnType<typeof fragmentKey>) {
  const forbidden: Buffer[] = [Buffer.from(marker), Buffer.from(assetMarker), ...Object.values(files).flatMap(bytes => [bytes, Buffer.from(bytes.toString("base64")), Buffer.from(bytes.toString("base64url")), Buffer.from(bytes.toString("hex"))])];
  if (key) forbidden.push(key.bytes, Buffer.from(key.token), Buffer.from(encodeURIComponent(key.token)), Buffer.from(key.bytes.toString("hex")), Buffer.from(key.bytes.toString("base64")), Buffer.from(key.bytes.toString("base64url")));
  for (const request of wire) {
    const metadata = Buffer.from(decodeURIComponent(request.url) + request.headers);
    for (const value of forbidden) {
      // Boolean assertions avoid printing generated key material on failure.
      expect(metadata.includes(value), "request URL/query/headers disclose key or file contents").toBe(false);
      expect(request.body.includes(value), "request body discloses key or file contents").toBe(false);
    }
  }
}

/** Observe, don't replace, the browser's real authenticated decryption. */
function observeCrypto() {
  const state = { decrypts: [] as Decrypt[] };
  (globalThis as any).__encryptedAcceptance = state;
  const prototype = Object.getPrototypeOf((globalThis as any).crypto.subtle);
  const decrypt = prototype.decrypt;
  const bytes = (b: any): number[] => Array.from(new Uint8Array(b instanceof ArrayBuffer ? b : b.buffer, b instanceof ArrayBuffer ? 0 : b.byteOffset, b.byteLength));
  prototype.decrypt = async function (algorithm: any, key: any, data: any) {
    const a = typeof algorithm === "string" ? { name: algorithm } : algorithm;
    const record: Decrypt = {
      algorithm: a.name, bits: key.algorithm.length,
      iv: "iv" in a ? bytes(a.iv) : [], aad: "additionalData" in a && a.additionalData ? bytes(a.additionalData) : null,
      tagLength: "tagLength" in a ? a.tagLength ?? 128 : 128, ciphertext: bytes(data),
    };
    state.decrypts.push(record);
    try {
      const result = await decrypt.call(this, algorithm, key, data);
      record.plaintext = Array.from(new Uint8Array(result));
      return result;
    } catch (error) {
      record.rejected = true;
      throw error;
    }
  };
}

type Mutation = { ciphertext: Buffer; byte: "ciphertext" | "tag" };
async function visit(url: string, mutation?: Mutation, viewport?: { width: number; height: number }) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  await context.addInitScript(observeCrypto);
  const wire: Wire[] = [];
  let altered = 0;
  await context.route("**/*", async (route: any) => {
    const req = route.request();
    wire.push({ method: req.method(), url: req.url(), headers: JSON.stringify(await req.allHeaders()), body: req.postDataBuffer() ?? Buffer.alloc(0) });
    if (new URL(req.url()).origin !== api) return route.abort("blockedbyclient");
    if (!mutation) return route.continue();
    const response = await route.fetch();
    let body: Buffer = await response.body();
    const changed = Buffer.from(mutation.ciphertext);
    changed[mutation.byte === "tag" ? changed.length - 1 : 0]! ^= 1;
    // Find the observed cipher bytes in transport, not an arbitrary envelope field.
    // Handles a raw blob as well as JSON/base64, hex, or embedded loader data.
    const variants = [
      [mutation.ciphertext, changed],
      [Buffer.from(mutation.ciphertext.toString("base64")), Buffer.from(changed.toString("base64"))],
      [Buffer.from(mutation.ciphertext.toString("base64url")), Buffer.from(changed.toString("base64url"))],
      [Buffer.from(mutation.ciphertext.toString("hex")), Buffer.from(changed.toString("hex"))],
    ];
    for (const [from, to] of variants) {
      const index = body.indexOf(from!);
      if (index < 0) continue;
      body = Buffer.concat([body.subarray(0, index), to!, body.subarray(index + from!.length)]);
      altered++;
      break;
    }
    await route.fulfill({ response, body });
  });
  const page = await context.newPage();
  const responses: any[] = [];
  page.on("response", (response: any) => responses.push(response));
  const response = await page.goto(url, { waitUntil: "networkidle" });
  return {
    context, page, wire, response, responses,
    altered: () => altered,
    records: async (): Promise<Decrypt[]> => (await Promise.all(page.frames().map((f: any) => f.evaluate(() => (globalThis as any).__encryptedAcceptance?.decrypts ?? [])))).flat(),
    fixtureResults: async (): Promise<any[]> => (await Promise.all(page.frames().map((f: any) => f.evaluate(() => (globalThis as any).fixtureResult ?? null)))).filter(Boolean),
    texts: async (): Promise<string> => (await Promise.all(page.frames().map((f: any) => f.locator("body").innerText()))).join("\n"),
  };
}

async function restored(view: Awaited<ReturnType<typeof visit>>, exactHtml = true) {
  // A result is only set by the actual decrypted external script after real
  // relative fetches; merely displaying HTML or stubbing a decrypt helper cannot
  // satisfy this. Ordinary unencrypted HTML intentionally gets a path-mode shim;
  // the encrypted loader must restore original bytes, not server-rewritten HTML.
  await expect.poll(view.fixtureResults, { timeout: 5000 }).toContainEqual(expect.objectContaining({
    asset: assetMarker, bytes: [...binary], source: [...files["assets/app.js"]],
    ...(exactHtml ? { page: [...files["index.html"]] } : {}),
  }));
  expect(await view.texts()).toContain(marker);
  expect(view.context.serviceWorkers()).toHaveLength(0);
}

async function authenticatedRecords(view: Awaited<ReturnType<typeof visit>>, keyBytes: Buffer) {
  const records = (await view.records()).filter(record => record.plaintext);
  expect(records.length, "the shipped browser loader must actually decrypt authenticated ciphertext").toBeGreaterThan(0);
  const key = await webcrypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  for (const record of records) {
    expect(record.algorithm).toBe("AES-GCM");
    expect(record.bits).toBe(256);
    expect(record.iv.length).toBeGreaterThanOrEqual(12);
    expect(record.tagLength).toBe(128);
    const plaintext = await webcrypto.subtle.decrypt({
      name: "AES-GCM", iv: Buffer.from(record.iv), tagLength: record.tagLength,
      ...(record.aad ? { additionalData: Buffer.from(record.aad) } : {}),
    }, key, Buffer.from(record.ciphertext));
    expect(Buffer.from(plaintext).equals(Buffer.from(record.plaintext!)), "independent WebCrypto must authenticate the browser's exact bytes with the fragment key").toBe(true);
  }
  return records;
}

describe("encrypted publish acceptance against a real local Worker and Chromium", () => {
  it("control: ordinary publishing still serves exact bytes and working relative assets under the real sandbox", async () => {
    const result = await cli(["publish", fixture, "--json", "--no-save"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(new URL(result.json.url).hash).toBe("");
    for (const [path, bytes] of Object.entries(files)) {
      const response = await fetch(new URL(`${path}?raw=1`, result.json.url));
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    }
    const view = await visit(result.json.url);
    try {
      expect(view.response.headers()["content-security-policy"]).toMatch(/sandbox/);
      expect(view.response.headers()["content-security-policy"]).not.toMatch(/allow-same-origin/);
      await restored(view, false);
    } finally { await view.context.close(); }
  });

  it("harness control: observes real browser WebCrypto success and tag rejection without replacing decryption", async () => {
    const view = await visit(`${api}/login`);
    try {
      await view.page.evaluate(async () => {
        const subtle = (globalThis as any).crypto.subtle;
        const key = await subtle.importKey("raw", new Uint8Array(32).fill(7), "AES-GCM", false, ["encrypt", "decrypt"]);
        const parameters = { name: "AES-GCM", iv: new Uint8Array(12).fill(9) };
        const ciphertext = await subtle.encrypt(parameters, key, new Uint8Array([0, 128, 255]));
        await subtle.decrypt(parameters, key, ciphertext);
        const altered = new Uint8Array(ciphertext);
        altered[altered.length - 1]! ^= 1;
        try { await subtle.decrypt(parameters, key, altered); } catch { /* authentication must fail */ }
      });
      const records = await view.records();
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ algorithm: "AES-GCM", bits: 256, iv: Array(12).fill(9), plaintext: [0, 128, 255] });
      expect(records[1]).toMatchObject({ rejected: true });
      expect(records[1]!.plaintext).toBeUndefined();
      await authenticatedRecords(view, Buffer.alloc(32, 7));
    } finally { await view.context.close(); }
  });

  it("publishes ciphertext only, with the 256-bit share key exclusively in the fragment", async () => {
    const result = await encrypted();
    const key = fragmentKey(result.json.url);
    expect(key.bytes.length).toBe(32);
    expect(result.wire.some(request => request.method === "PUT" || request.method === "POST")).toBe(true);
    assertPrivate(result.wire, key);
    const linkless = new URL(result.json.url);
    linkless.hash = "";
    const response = await fetch(linkless);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.includes(marker), "server response must not contain the private page").toBe(false);
    expect(body.includes(assetMarker), "server response must not contain the private script").toBe(false);
    expect(body.includes(key.token), "server must not receive/reflect the key").toBe(false);
    // Authenticated read-back is another server surface, not just the public URL.
    const listing = await fetch(`${api}/api/v1/sites/${result.json.slug}/files`, { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(listing.ok).toBe(true);
    expect((await listing.text()).includes(key.token)).toBe(false);
  });

  it("the shipped first-party loader restores usable HTML, script and exact binary bytes; independent AES-GCM authenticates them", async () => {
    const result = await encrypted();
    const key = fragmentKey(result.json.url);
    const view = await visit(result.json.url);
    try {
      await restored(view);
      const loaderRecords = await authenticatedRecords(view, key.bytes);
      for (const record of loaderRecords) {
        expect(record.aad, "the shipped loader must bind the container magic as AES-GCM additional data").not.toBeNull();
        expect(Buffer.from(record.aad!).toString(), "loader additional data must be the container magic").toBe("DWENC001");
      }
      assertPrivate([...result.wire, ...view.wire], key);
      expect(view.response.headers()["content-security-policy"], "first-party loader must retain a CSP").toBeTruthy();
      // An app-origin first-party loader may mount an opaque sandboxed content
      // frame. Test the content's privileges, not an arbitrary loader URL/CSP.
      // The content must not gain the app origin even if it is mounted in an iframe.
      const contentFrames = [];
      for (const frame of view.page.frames()) {
        if (await frame.evaluate(() => Boolean((globalThis as any).fixtureResult))) contentFrames.push(frame);
      }
      expect(contentFrames.length).toBeGreaterThan(0);
      for (const frame of contentFrames) {
        expect(await frame.evaluate(() => {
          try { (globalThis as any).localStorage.setItem("encrypted-acceptance", "x"); return true; } catch { return false; }
        }), "decrypted user content must not access app-origin storage").toBe(false);
      }
    } finally { await view.context.close(); }
  });

  it("fresh publishes use fresh IVs, including identical input bytes", async () => {
    const ivs = new Set<string>();
    for (let publish = 0; publish < 2; publish++) {
      const result = await encrypted();
      const key = fragmentKey(result.json.url);
      const view = await visit(result.json.url);
      try {
        await restored(view);
        const records = await authenticatedRecords(view, key.bytes);
        const seenCipher = new Set<string>();
        for (const record of records) {
          const cipher = Buffer.from(record.ciphertext).toString("hex");
          if (seenCipher.has(cipher)) continue; // Re-reading the same blob is not another encryption.
          seenCipher.add(cipher);
          const iv = Buffer.from(record.iv).toString("hex");
          expect(ivs.has(iv), "IV must not be reused for another encrypted payload or publish").toBe(false);
          ivs.add(iv);
        }
      } finally { await view.context.close(); }
    }
  });

  it("fresh keys: identical publishes use independent 32-byte keys and cannot cross-authenticate", async () => {
    const first = await encrypted();
    const second = await encrypted();
    const firstKey = fragmentKey(first.json.url);
    const secondKey = fragmentKey(second.json.url);
    expect(firstKey.bytes.length).toBe(32);
    expect(secondKey.bytes.length).toBe(32);
    expect(firstKey.bytes.equals(secondKey.bytes), "fresh IVs do not substitute for a fresh per-publish key").toBe(false);
    const view = await visit(second.json.url);
    try {
      await restored(view);
      const records = await authenticatedRecords(view, secondKey.bytes);
      const wrongKey = await webcrypto.subtle.importKey("raw", firstKey.bytes, "AES-GCM", false, ["decrypt"]);
      for (const record of records) {
        let authenticated = false;
        try {
          await webcrypto.subtle.decrypt({
            name: "AES-GCM", iv: Buffer.from(record.iv), tagLength: record.tagLength,
            ...(record.aad ? { additionalData: Buffer.from(record.aad) } : {}),
          }, wrongKey, Buffer.from(record.ciphertext));
          authenticated = true;
        } catch { /* the first publish's key must not unlock the second */ }
        expect(authenticated, "the first fragment key must fail authentication of the second container").toBe(false);
      }
    } finally { await view.context.close(); }
  });

  it.each(["missing", "malformed", "wrong"] as const)("%s fragment key fails closed and is never sent to an endpoint", async kind => {
    const result = await encrypted();
    const key = fragmentKey(result.json.url);
    const url = new URL(result.json.url);
    let wrong: ReturnType<typeof fragmentKey> | undefined;
    if (kind === "missing") url.hash = "";
    if (kind === "malformed") url.hash = "not-a-valid-key";
    if (kind === "wrong") {
      const bytes = Buffer.from(key.bytes);
      bytes[0]! ^= 1;
      const token = /^[0-9a-f]{64}$/i.test(key.token) ? bytes.toString("hex") : key.token.includes("+") || key.token.includes("/") || key.token.endsWith("=") ? bytes.toString("base64") : bytes.toString("base64url");
      url.hash = decodeURIComponent(url.hash).replace(key.token, token);
      wrong = { bytes, token };
    }
    const view = await visit(url.href);
    try {
      const text = await view.texts();
      expect(text, "loader must explain missing/invalid keys or authentication failure").toMatch(/key|decrypt|invalid|authenticat|unable|incorrect|failed/i);
      expect(text.includes(marker), "no unauthenticated private HTML").toBe(false);
      expect(await view.fixtureResults(), "private script must never execute").toEqual([]);
      expect((await view.records()).some(record => record.plaintext), "no successful decrypt with a missing/wrong key").toBe(false);
      assertPrivate(view.wire, key);
      if (wrong) assertPrivate(view.wire, wrong);
    } finally { await view.context.close(); }
  });

  it.each(["ciphertext", "tag"] as const)("altered %s is rejected by the shipped loader before showing private content", async byte => {
    const result = await encrypted();
    const key = fragmentKey(result.json.url);
    const good = await visit(result.json.url);
    let ciphertext: Buffer;
    try {
      await restored(good);
      const records = await authenticatedRecords(good, key.bytes);
      // Target the entry document when files are encrypted separately. Otherwise
      // target the first authenticated container, without parsing its envelope.
      const entry = records.find(record => Buffer.from(record.plaintext!).includes(Buffer.from(html))) ?? records[0]!;
      ciphertext = Buffer.from(entry.ciphertext);
    } finally { await good.context.close(); }
    const bad = await visit(result.json.url, { ciphertext, byte });
    try {
      expect(bad.altered(), "harness must alter real on-wire ciphertext, not merely fail to load a URL").toBeGreaterThan(0);
      expect((await bad.records()).some(record => record.rejected), "WebCrypto must reject the altered authentication input").toBe(true);
      expect((await bad.texts()).includes(marker), "unauthenticated document must not be displayed").toBe(false);
      expect(await bad.fixtureResults()).toEqual([]);
      assertPrivate(bad.wire, key);
    } finally { await bad.context.close(); }
  });

  it("SPA refusal: --encrypt --spa is a local exit-2 error with zero HTTP mutations", async () => {
    const result = await cli(["publish", fixture, "--encrypt", "--spa", "--json", "--no-save"]);
    expect(result.wire.filter(request => !["GET", "HEAD", "OPTIONS"].includes(request.method)).length, "SPA refusal must precede site, deploy and blob mutations").toBe(0);
    expect(result.code).toBe(2);
    expect(result.json?.error?.code).toBe("encrypted_spa_unsupported");
    expect(result.json?.error?.hint).toMatch(/spa|static|remove|without/i);
  }, 5000);

  it("encrypted wait: polls raw ciphertext without sending a fragment key and reports live", async () => {
    const result = await cli(["publish", fixture, "--encrypt", "--wait", "--wait-timeout", "1", "--json", "--no-save"]);
    expect(result.code, "encrypted --wait must succeed within its explicit one-second readiness bound").toBe(0);
    expect(result.json?.live).toBe(true);
    const polls = result.wire.filter(request => ["GET", "HEAD"].includes(request.method) && !new URL(request.url).pathname.startsWith("/api/"));
    expect(polls.length, "--wait must actually perform a readiness request").toBeGreaterThan(0);
    for (const request of polls) {
      const url = new URL(request.url);
      expect(url.pathname.endsWith("/encrypted.bin"), "encrypted --wait must poll ciphertext, never the HTML loader").toBe(true);
      expect(url.searchParams.get("raw")).toBe("1");
      expect(url.hash.length, "even the Request handed to fetch must not carry the share fragment").toBe(0);
    }
    assertPrivate(result.wire, fragmentKey(result.json.url));
  }, 8000);

  it("CLI raw overflow: 16 MiB + 1 source bytes returns exit 6 before any HTTP mutation", async () => {
    const dir = join(work, "raw-overflow");
    await mkdir(dir);
    await writeFile(join(dir, "index.html"), new Uint8Array(16 * 1024 * 1024 + 1));
    const result = await cli(["publish", dir, "--encrypt", "--json", "--no-save"]);
    expect(result.wire.filter(request => !["GET", "HEAD", "OPTIONS"].includes(request.method)).length).toBe(0);
    expect(result.code).toBe(6);
    expect(result.json?.error?.code).toBe("encrypted_input_too_large");
    expect(result.json?.error?.hint).toMatch(/smaller|reduce|remove|split|limit/i);
  });

  it("CLI path refusal: a real Unix backslash filename is rejected before any HTTP mutation", async () => {
    const dir = join(work, "invalid-path");
    await mkdir(dir);
    await writeFile(join(dir, "index.html"), "<h1>valid entry</h1>");
    await writeFile(join(dir, "unrelated\\\\asset.txt"), "invalid-path-synthetic-asset");
    const result = await cli(["publish", dir, "--encrypt", "--json", "--no-save"]);
    expect(result.wire.filter(request => !["GET", "HEAD", "OPTIONS"].includes(request.method)).length, "an unrelated invalid asset must not create an orphan site or upload").toBe(0);
    expect(result.code).toBe(6);
    expect(result.json?.error?.code).toBe("encrypted_invalid_path");
    expect(result.json?.error?.hint).toMatch(/rename|remove/i);
  });

  it("valid Unicode, spaces and punctuation survive the real CLI/loader without silent path normalization", async () => {
    const dir = join(work, "unicode-paths");
    const path = "assets/你好 café + (v1)! &@.txt";
    const contents = "unicode-path-exact-bytes-19bc";
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "index.html"), `<h1>Unicode paths</h1><script src="./app.js"></script>`);
    await writeFile(join(dir, "app.js"), `fetch('./${path}').then(r => { if (!r.ok) throw Error('missing original path'); return r.text(); }).then(text => { window.unicodePathResult = text; });`);
    await writeFile(join(dir, path), contents);
    const result = await cli(["publish", dir, "--encrypt", "--json", "--no-save"]);
    expect(result.code === 0, "valid paths must remain supported").toBe(true);
    const view = await visit(result.json.url);
    try {
      await expect.poll(async () => (await Promise.all(view.page.frames().map((frame: any) => frame.evaluate(() => (globalThis as any).unicodePathResult ?? null)))).filter(Boolean), { timeout: 3000 }).toEqual([contents]);
    } finally { await view.context.close(); }
  });

  it("hostile bundled content can navigate synthetic decrypted bytes to the same app under the shipped CSP", async () => {
    const dir = join(work, "hostile-content");
    const syntheticSecret = "synthetic-private-navigation-bytes-30c7";
    await mkdir(dir);
    await writeFile(join(dir, "index.html"), '<h1>Executable trust fixture</h1><script src="./hostile.js"></script>');
    await writeFile(join(dir, "private.txt"), syntheticSecret);
    await writeFile(join(dir, "hostile.js"), `fetch('./private.txt').then(r => r.text()).then(secret => { location.href = ${JSON.stringify(api + "/health?leak=")} + encodeURIComponent(secret); });`);
    const result = await cli(["publish", dir, "--encrypt", "--json", "--no-save"]);
    expect(result.code === 0, "executable sites are supported; this is a trust warning, not a script ban").toBe(true);
    const view = await visit(result.json.url);
    try {
      const leaked = (url: string) => { const u = new URL(url); return u.origin === api && u.pathname === "/health" && u.searchParams.get("leak") === syntheticSecret; };
      await expect.poll(() => view.responses.some((response: any) => leaked(response.url())), { timeout: 3000 }).toBe(true);
      expect(view.wire.some(request => leaked(request.url)), "the navigation request really carried bytes read from another decrypted bundled file").toBe(true);
      expect(view.response.headers()["content-security-policy"]).toMatch(/frame-src[^;]*'self'/);
      const frameResponse = view.responses.find((response: any) => new URL(response.url()).pathname === "/__dropway/encrypted-frame");
      expect(Boolean(frameResponse), "hostile content must execute in the shipped HTTP-delivered frame").toBe(true);
      expect((await frameResponse.allHeaders())["content-security-policy"], "navigation leaks despite connect-src none; do not weaken that policy").toMatch(/connect-src\s+'none'/);
      const sandbox = await view.page.locator("iframe").getAttribute("sandbox");
      expect(sandbox).toContain("allow-scripts");
      expect(sandbox).not.toContain("allow-same-origin");
      assertPrivate(view.wire, fragmentKey(result.json.url));
    } finally { await view.context.close(); }
  });

  it.each(["before decryption", "after decryption"])("loader warning %s: trust ALL bundled executable content; navigation can leak data", async phase => {
    const result = await encrypted();
    const url = new URL(result.json.url);
    if (phase === "before decryption") url.hash = "";
    const view = await visit(url.href);
    try {
      if (phase === "after decryption") await restored(view);
      const text = await view.page.locator("body").innerText();
      expect(text, "warning must be visible independently of the decrypted child frame").toMatch(/trust(?:ed)?[\s\S]{0,120}(?:scripts?|executable|content)|(?:scripts?|executable|content)[\s\S]{0,120}trust/i);
      expect(text).toMatch(/all|every|only.{0,80}trust/i);
      expect(text).toMatch(/navigat/i);
      expect(text).toMatch(/leak|disclos|send.{0,60}(?:data|content)|(?:data|content).{0,60}(?:leave|escape)/i);
      expect(text).not.toMatch(/network[- ]free|no[- ]network|no network (?:access|requests)|cannot (?:make|send) network/i);
    } finally { await view.context.close(); }
  });

  it.each([
    ["desktop", { width: 1280, height: 800 }],
    ["narrow", { width: 360, height: 640 }],
  ] as const)("loader warning after decryption stays in the viewport and unobscured: %s", async (_name, viewport) => {
    const result = await encrypted();
    const view = await visit(result.json.url, undefined, viewport);
    try {
      await restored(view);
      await authenticatedRecords(view, fragmentKey(result.json.url).bytes);
      // A full-viewport content iframe can hide the warning while innerText and
      // ordinary visibility checks still pass. Sample the actual warning's text
      // lines, not its container's box (which may include empty space).
      const warning = await view.page.evaluate(() => {
        const { document, innerWidth, innerHeight } = globalThis as any;
        const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */);
        const text: string[] = [];
        const lines = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.parentElement?.closest("script,style,noscript")) continue;
          if (!/trust|navigat|leak|disclos/i.test(node.textContent)) continue;
          text.push(node.textContent);
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.width <= 0 || rect.height <= 0) continue;
            const y = rect.top + rect.height / 2;
            lines.push({
              inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
              samples: [0.1, 0.5, 0.9].map(fraction => {
                const x = rect.left + rect.width * fraction;
                const hit = document.elementFromPoint(x, y);
                return { x, y, hit: hit?.tagName ?? null, unobscured: hit === node.parentElement };
              }),
            });
          }
        }
        return { text: text.join(" "), lines };
      });
      expect(warning.text).toMatch(/trust/i);
      expect(warning.text).toMatch(/navigat/i);
      expect(warning.text).toMatch(/leak|disclos|send.{0,60}(?:data|content)/i);
      expect(warning.lines.length, "the actual warning text must have rendered lines after successful authenticated restoration").toBeGreaterThan(0);
      for (const line of warning.lines) {
        expect(line.inViewport, "each warning text line must fit in the viewport without scrolling").toBe(true);
        for (const sample of line.samples) {
          expect(sample.unobscured, `warning text must be hit-testable after restoration; elementFromPoint(${sample.x}, ${sample.y}) hit ${sample.hit}`).toBe(true);
        }
      }
    } finally { await view.context.close(); }
  });

  it("packaged threat guidance requires trusted executable content and makes no network-free promise", async () => {
    const guide = await readFile(join(root, "packages/cli/README.md"), "utf8");
    expect(guide).toMatch(/trust(?:ed)?[\s\S]{0,120}(?:scripts?|executable|content)|(?:scripts?|executable|content)[\s\S]{0,120}trust/i);
    expect(guide).toMatch(/navigat/i);
    expect(guide).toMatch(/leak|disclos|send.{0,60}(?:data|content)/i);
    expect(guide).not.toMatch(/network[- ]free|no[- ]network|no network (?:access|requests)|cannot (?:make|send) network/i);
  });

  it.each([24 * 1024 * 1024 - 1, 24 * 1024 * 1024, 24 * 1024 * 1024 + 1])("loader stream cap: %i chunked bytes with no Content-Length", async targetBytes => {
    const result = await encrypted();
    const context = await browser.newContext();
    const wire: Wire[] = [];
    try {
      await context.addInitScript(() => {
        const state = { calls: 0, successes: 0, rejections: 0 };
        (globalThis as any).__streamCrypto = state;
        const prototype = Object.getPrototypeOf(crypto.subtle);
        const decrypt = prototype.decrypt;
        prototype.decrypt = async function (...args: any[]) {
          state.calls++;
          try { const bytes = await decrypt.apply(this, args); state.successes++; return bytes; }
          catch (error) { state.rejections++; throw error; }
        };
      });
      // Substitute only the encrypted network response body. The actual HTTP
      // loader, response CSP and native WebCrypto remain untouched. Padding an
      // otherwise genuine binary container preserves its magic/header but breaks
      // authentication. Accepted-size controls must therefore reach real crypto
      // and report auth failure, not a transport-size or format refusal.
      await context.addInitScript(({ targetBytes }: { targetBytes: number }) => {
        const state = { pulls: 0, bytes: 0, cancels: 0, ends: 0, substituted: 0, contentLength: "unset" as string | null };
        (globalThis as any).__streamAcceptance = state;
        const original = globalThis.fetch;
        globalThis.fetch = async function (...args: Parameters<typeof fetch>) {
          const response = await original.apply(this, args);
          const input = args[0];
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, (globalThis as any).location.href);
          if (!url.pathname.endsWith("/encrypted.bin")) return response;
          const prefix = new Uint8Array(await response.arrayBuffer());
          if (prefix.byteLength >= targetBytes) throw Error("stream fixture must fit beneath the chosen boundary");
          let offset = 0;
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              state.pulls++;
              if (offset === targetBytes) { state.ends++; controller.close(); return; }
              const length = Math.min(256 * 1024, targetBytes - offset);
              const chunk = new Uint8Array(length).fill(32);
              if (offset < prefix.byteLength) chunk.set(prefix.subarray(offset, Math.min(offset + length, prefix.byteLength)));
              offset += length;
              state.bytes += length;
              controller.enqueue(chunk);
            },
            cancel() { state.cancels++; },
          }, { highWaterMark: 0 });
          const headers = new Headers(response.headers);
          headers.delete("Content-Length");
          headers.delete("Content-Encoding");
          const replacement = new Response(stream, { status: response.status, headers });
          state.contentLength = replacement.headers.get("Content-Length");
          state.substituted++;
          return replacement;
        };
      }, { targetBytes });
      await context.route("**/*", async (route: any) => {
        const request = route.request();
        if (new URL(request.url()).origin !== api) return route.abort("blockedbyclient");
        wire.push({ method: request.method(), url: request.url(), headers: JSON.stringify(await request.allHeaders()), body: request.postDataBuffer() ?? Buffer.alloc(0) });
        return route.continue();
      });
      const page = await context.newPage();
      const response = await page.goto(result.json.url, { waitUntil: "networkidle" });
      expect(response.headers()["content-security-policy"]).toBeTruthy();
      await expect.poll(async () => page.evaluate(() => {
        const stream = (globalThis as any).__streamAcceptance;
        return stream.cancels + stream.ends;
      }), { timeout: 5000 }).toBeGreaterThan(0);
      const state = await page.evaluate(() => (globalThis as any).__streamAcceptance);
      expect(state.substituted).toBe(1);
      expect(state.contentLength).toBeNull();
      expect(state.bytes).toBe(targetBytes);
      if (targetBytes > 24 * 1024 * 1024) {
        expect(state.cancels, "the shipped loader must cancel immediately after crossing its encoded bound").toBe(1);
        expect(state.ends, "oversized responses must not be drained to completion").toBe(0);
        expect(await page.evaluate(() => (globalThis as any).__streamCrypto.calls), "size refusal must happen before ANY decrypt call").toBe(0);
        expect(await page.locator("iframe").count(), "no decrypted content frame after size refusal").toBe(0);
        expect(await page.locator("body").innerText()).toMatch(/large|limit|size|24\s*MiB/i);
      } else {
        expect(state.cancels).toBe(0);
        await expect.poll(async () => page.evaluate(() => (globalThis as any).__streamCrypto.rejections), { timeout: 5000 }).toBe(1);
        expect(await page.evaluate(() => (globalThis as any).__streamCrypto.calls), "accepted boundary must reach native authenticated crypto, not a size/format error").toBe(1);
        const text = await page.locator("body").innerText();
        expect(text).toMatch(/incorrect key|damaged ciphertext|authenticat/i);
        expect(text).not.toMatch(/too large|invalid encrypted site format/i);
      }
      assertPrivate(wire, fragmentKey(result.json.url));
    } finally { await context.close(); }
  });

  it("encrypted dry-run is recognized and never contacts the Worker", async () => {
    const result = await cli(["publish", fixture, "--encrypt", "--dry-run", "--json", "--no-save"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.json?.ok).toBe(true);
    expect(result.wire).toEqual([]);
  });

  it("zip input is either encrypted or specifically refused before any plaintext upload", async () => {
    const zip = join(work, "input.zip");
    await writeFile(zip, zipSync({ "index.html": strToU8(html), "assets/app.js": strToU8(script), "bytes.bin": binary }));
    const result = await cli(["publish", zip, "--encrypt", "--json", "--no-save"]);
    if (result.code === 0) {
      expect(result.json?.ok).toBe(true);
      const key = fragmentKey(result.json.url);
      assertPrivate(result.wire, key);
      // A ZIP is not made confidential just by avoiding uncompressed strings.
      const zipBytes = await readFile(zip);
      expect(result.wire.some(request => request.body.includes(zipBytes))).toBe(false);
      const view = await visit(result.json.url);
      try { await restored(view); await authenticatedRecords(view, key.bytes); }
      finally { await view.context.close(); }
    } else {
      expect([2, 6]).toContain(result.code);
      expect(result.json?.error?.code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(result.json?.error?.message, "refusal must identify the unsupported encrypted input, not an unknown flag").toMatch(/zip|archive/i);
      expect(result.json?.error?.message).toMatch(/encrypt/i);
      expect(result.json?.error?.hint).toBeTruthy();
      expect(result.wire.filter(request => ["POST", "PUT", "PATCH"].includes(request.method))).toEqual([]);
    }
  });

  it("missing encrypted input is explicitly refused before creating or uploading anything", async () => {
    const result = await cli(["publish", join(work, "missing"), "--encrypt", "--json", "--no-save"]);
    expect(result.code).not.toBe(0);
    expect(result.json?.error?.code).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(result.json?.error?.message, "must validate the missing input, not reject an unknown flag").toMatch(/missing|not found|no such|exist/i);
    expect(result.json?.error?.hint).toBeTruthy();
    expect(result.wire.filter(request => ["POST", "PUT", "PATCH"].includes(request.method))).toEqual([]);
  });

  it("publish help and the packaged CLI guide explain storage confidentiality, link loss and the host/recipient limits", async () => {
    const result = await cli(["publish", "--help"]);
    expect(result.code).toBe(0);
    const help = result.stdout + result.stderr;
    expect(help).toContain("--encrypt");
    // Wording is intentionally semantic, not an exact prose snapshot. The long
    // explanation may live in the guide already included in the npm package.
    const guide = `${help}\n${await readFile(join(root, "packages/cli/README.md"), "utf8")}`;
    expect(guide).toMatch(/AES[- ]?256[- ]?GCM/i);
    expect(guide).toMatch(/fragment/i);
    expect(guide).toMatch(/stor(age|ed)|at.rest/i);
    expect(guide).toMatch(/anyone.{0,100}(link|key|URL)|(link|key|URL).{0,100}anyone/is);
    expect(guide).toMatch(/(lost|lose|loss).{0,100}(recover|access|decrypt)|(recover|access|decrypt).{0,100}(lost|lose|loss)/is);
    expect(guide).toMatch(/metadata|file.?names|file.?sizes/i);
    expect(guide).toMatch(/(malicious|untrusted|compromised).{0,100}(host|server)|(host|server).{0,100}(malicious|untrusted|compromised)/is);
    expect(guide).toMatch(/(replace|alter|modify|change).{0,100}(loader|code|script)|(loader|code|script).{0,100}(replace|alter|modify|change)/is);
    expect(guide).toMatch(/compromised.{0,60}(recipient|browser|device)|(recipient|browser|device).{0,60}compromised/is);
  });
});
