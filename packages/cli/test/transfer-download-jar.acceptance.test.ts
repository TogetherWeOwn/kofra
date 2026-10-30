import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface Transfer {
  id: string;
  url: string;
  files: Array<{ path: string; downloads: number }>;
  recipients: Array<{ url: string; downloads: number }>;
}

// A real libcurl cookie jar selects, replaces and sends cookies. Never extract
// proofs or manually restore overwritten cookies. This is HTTP-client coverage,
// not a claim that a browser's download manager resumed an interrupted download.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const exec = promisify(execFile);
const bootstrap = "disposable-download-jar-bootstrap-0123456789";
const minute = 60_000;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let work: string;
let origin: string;
let sitesOrigin: string;
let ownerKey: string;
let now: number;
let sequence = 0;
let operations: Array<{ id: string; method: string; path: string }>;

async function localPort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Disposable Worker needs a loopback port");
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

beforeAll(async () => {
  await exec("curl", ["--version"]);
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "download-jar-"));
  const port = await localPort();
  origin = `http://127.0.0.1:${port}`;
  sitesOrigin = `http://localhost:${port}`;
  const entry = join(work, "clock-worker.mjs");
  // Only this disposable entry accepts the clock header. Product requests,
  // signatures, D1, R2 and accounting are real; the client jar's clock is NOT
  // changed, so server-side proof expiry must reject even a still-carried cookie.
  await writeFile(entry, `
import app from ${JSON.stringify(join(root, "apps/worker/src/index.ts"))};
const realNow = Date.now;
export default {
  async fetch(request, env, ctx) {
    const value = request.headers.get("X-Acceptance-Time");
    if (value !== null) Date.now = () => Number(value);
    try {
      const response = await app.fetch(request, env, ctx);
      const result = new Response(response.body, response);
      const cookie = request.headers.get("Cookie");
      result.headers.set("X-Acceptance-Cookie-Bytes", String(cookie ? new TextEncoder().encode(cookie).byteLength + 10 : 0));
      return result;
    } finally { Date.now = realNow; }
  }
};
`);
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-download-jar-test", main: entry,
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    vars: { APP_ORIGIN: origin, SITES_MODE: "path", SITES_ORIGIN: sitesOrigin, SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "download-jar", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "download-jar-files" }], kv_namespaces: [{ binding: "CACHE" }],
  }));
  await exec(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config, dev: { server: { hostname: "127.0.0.1", port: Number(new URL(origin).port) }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  now = Date.now();
  const setup = await fetch(`${origin}/api/v1/setup`, {
    method: "POST", headers: { Authorization: `Bearer ${bootstrap}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "download-jar@example.net" }),
  });
  expect(setup.status).toBe(201);
  ownerKey = (await setup.json() as { apiKey: { key: string } }).apiKey.key;
  const catalog = await fetch(`${origin}/api/v1/operations`, { headers: { Authorization: `Bearer ${ownerKey}` } });
  expect(catalog.status).toBe(200);
  operations = (await catalog.json() as { operations: typeof operations }).operations;
}, 120_000);

beforeEach(() => { now = Date.now(); });
afterAll(async () => {
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function operation(name: string, args: Record<string, unknown>) {
  const definition = operations.find((entry) => entry.id === name);
  expect(definition, `the real registry advertises ${name}`).toBeDefined();
  const body = { ...args };
  const path = definition!.path.replace(/\{([^}]+)\}/g, (_, field: string) => {
    expect(body[field]).toBeDefined();
    const value = encodeURIComponent(String(body[field]));
    delete body[field];
    return value;
  });
  const url = new URL(path, origin);
  const method = definition!.method.toUpperCase();
  if (method === "GET") for (const [key, value] of Object.entries(body)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method, headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json", "X-Acceptance-Time": String(now) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as { transfer?: Transfer; error?: unknown } & Transfer;
  expect(response.status, `disposable fixture ${name}: ${JSON.stringify(result.error)}`).toBe(name === "create_transfer" ? 201 : 200);
  return result.transfer ?? result;
}

async function createTransfer(overrides: Record<string, unknown> = {}) {
  return operation("create_transfer", {
    slug: `cookie-jar-${++sequence}`, expiresAt: now + 7_200_000,
    files: [
      { path: "notes.txt", content: "transfer sample bytes", contentType: "text/plain" },
      { path: "unstarted.txt", content: "unstarted file bytes", contentType: "text/plain" },
    ],
    recipients: ["first@example.net", "second@example.net", "unstarted@example.net"],
    ...overrides,
  });
}

async function links(t: Transfer, recipient?: number) {
  const pageUrl = recipient === undefined ? t.url : t.recipients[recipient]!.url;
  expect(new URL(pageUrl).origin).toBe(origin);
  const page = await fetch(pageUrl, { headers: { Accept: "text/html", "X-Acceptance-Time": String(now) } });
  expect(page.status).toBe(200);
  const html = await page.text();
  const hrefs = [...html.matchAll(/<a\b[^>]*\bhref=(["'])(.*?)\1/gi)]
    .map((match) => new URL(match[2]!.replace(/&amp;/g, "&"), pageUrl).href);
  return t.files.map((file) => {
    const url = hrefs.find((href) => new URL(href).origin === sitesOrigin && decodeURIComponent(new URL(href).pathname).endsWith(`/${file.path}`));
    expect(url, `rendered download link for ${file.path}`).toBeDefined();
    return url!;
  });
}

async function client() {
  const jar = join(work, `cookies-${++sequence}.txt`);
  let largestCookieHeader = 0;
  return {
    get largestCookieHeader() { return largestCookieHeader; },
    async metadata() {
      const rows = (await readFile(jar, "utf8")).split(/\r?\n/)
        .filter((line) => line && (!line.startsWith("#") || line.startsWith("#HttpOnly_"))).map((line) => line.split("\t"));
      return { storedCookies: rows.length, expiryCount: new Set(rows.map((row) => row[4])).size };
    },
    async get(url: string, range = "bytes=8-") {
      expect(new URL(url).origin, "curl may only contact the disposable loopback sites origin").toBe(sitesOrigin);
      const id = ++sequence;
      const headersPath = join(work, `headers-${id}.txt`);
      const bodyPath = join(work, `body-${id}.txt`);
      const { stdout, stderr } = await exec("curl", [
        "--silent", "--show-error", "--verbose", "--max-time", "15", "--noproxy", "*",
        "--resolve", `localhost:${new URL(origin).port}:127.0.0.1`,
        "--cookie", jar, "--cookie-jar", jar, "--dump-header", headersPath, "--output", bodyPath,
        "--write-out", "%{http_code}", "--header", `Range: ${range}`, "--header", `X-Acceptance-Time: ${now}`, url,
      ], { maxBuffer: 1024 * 1024 });
      // Inspect the header emitted by libcurl, not a hand-built cookie map. Do
      // not print credentials: report only the UTF-8 byte count including CRLF.
      const sent = stderr.split(/\r?\n/).filter((line) => line.startsWith("> Cookie:"));
      for (const line of sent) largestCookieHeader = Math.max(largestCookieHeader, Buffer.byteLength(line.slice(2)) + 2);
      const wire = await readFile(headersPath, "utf8");
      const headers = new Headers();
      for (const line of wire.trim().split(/\r?\n/).slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      const receivedBytes = Number(headers.get("X-Acceptance-Cookie-Bytes"));
      expect(Number.isFinite(receivedBytes), "the disposable boundary reports the actually received cookie size").toBe(true);
      largestCookieHeader = Math.max(largestCookieHeader, receivedBytes);
      return { status: Number(stdout), headers, body: await readFile(bodyPath, "utf8"), sentCookies: receivedBytes > 0 };
    },
  };
}

describe("download continuations in a real client cookie jar", () => {
  it("keeps two recipient starts and a general-link start independent, scoped and fixed-lived", async () => {
    const t = await createTransfer({ downloadLimit: 3 });
    const first = await links(t, 0);
    const second = await links(t, 1);
    const unstarted = await links(t, 2);
    const general = await links(t);
    const urls = [first[0]!, second[0]!, general[0]!];
    const startedAt = now;
    const jar = await client();
    for (let index = 0; index < urls.length; index++) {
      now = startedAt + index * 2 * minute;
      const start = await jar.get(urls[index]!, "bytes=0-7");
      expect(start.status).toBe(206);
      expect(start.body).toBe("transfer");
    }
    now = startedAt + 14 * minute;
    for (const [index, url] of urls.entries()) {
      const resumed = await jar.get(url);
      expect.soft(resumed.status, `previously counted link ${index} still has its own continuation`).toBe(206);
      expect.soft(resumed.body).toBe(" sample bytes");
      expect.soft(resumed.headers.get("Set-Cookie")).toBeNull();
      expect(resumed.sentCookies, "positive control: libcurl actually carried the saved cookies").toBe(true);
    }
    for (const url of [unstarted[0]!, first[1]!, general[1]!]) {
      const refused = await jar.get(url);
      expect.soft(refused.status, "carried credentials cannot authorize an unstarted recipient or file").toBe(410);
      expect.soft(refused.body).not.toBe(" sample bytes");
    }
    // Later starts and successful resumptions cannot renew any earlier scope.
    for (const [minutes, expected] of [[15, [410, 206, 206]], [17, [410, 410, 206]], [19, [410, 410, 410]]] as const) {
      now = startedAt + minutes * minute + 1;
      for (let index = 0; index < urls.length; index++) {
        const resumed = await jar.get(urls[index]!);
        expect.soft(resumed.status, `link ${index} at minute ${minutes} retains its original expiry`).toBe(expected[index]);
        if (expected[index] === 206) expect.soft(resumed.body).toBe(" sample bytes");
      }
    }
    expect(jar.largestCookieHeader).toBeLessThan(8 * 1024);
    const saved = await operation("get_transfer", { transfer: t.id });
    expect(saved.files.map((file) => file.downloads)).toEqual([3, 0]);
    expect(saved.recipients.map((recipient) => recipient.downloads)).toEqual([1, 1, 0]);
  });

  it("preserves 80 active file starts under 8 KiB of outgoing cookies without broadening scope or expiry", async () => {
    const files = Array.from({ length: 81 }, (_, index) => ({ path: `part-${index}.txt`, content: "transfer sample bytes", contentType: "text/plain" }));
    const t = await createTransfer({ files, downloadLimit: 80 });
    const general = await links(t);
    const recipient = await links(t, 0);
    const startedAt = now;
    const jar = await client();
    for (let index = 0; index < 80; index++) {
      now = startedAt + (index === 0 ? 0 : 6 * minute);
      const start = await jar.get(general[index]!, "bytes=0-7");
      expect(start.status, `supported file start ${index}`).toBe(206);
      expect(start.body).toBe("transfer");
    }
    process.stdout.write(`${JSON.stringify({ stage: "after 80 counted starts", downloadLinks: general.length, ...await jar.metadata() })}\n`);
    expect((await jar.get(general[0]!, "")).status, "positive control: the counted-start allowance really is exhausted").toBe(410);
    now = startedAt + 14 * minute;
    const lost: Array<{ file: number; status: number; wrongBytes: boolean; renewed: boolean }> = [];
    for (let index = 0; index < 80; index++) {
      const resumed = await jar.get(general[index]!);
      const wrongBytes = resumed.body !== " sample bytes";
      const renewed = resumed.headers.get("Set-Cookie") !== null;
      if (resumed.status !== 206 || wrongBytes || renewed) lost.push({ file: index, status: resumed.status, wrongBytes, renewed });
      expect(resumed.sentCookies, "the actual jar, not a separately saved proof, must carry the continuation").toBe(true);
    }
    expect.soft(lost, "every active file must retain its exact suffix without renewing its fixed lifetime").toEqual([]);
    for (const url of [general[80]!, recipient[0]!]) {
      const refused = await jar.get(url);
      expect.soft(refused.status, "a many-file credential is not blanket transfer or recipient authorization").toBe(410);
      expect.soft(refused.body).not.toBe(" sample bytes");
    }
    now = startedAt + 15 * minute + 1;
    expect.soft((await jar.get(general[0]!)).status, "later starts did not extend the first file's lifetime").toBe(410);
    for (const index of [1, 39, 79]) {
      const resumed = await jar.get(general[index]!);
      expect.soft(resumed.status, `later file ${index} keeps its independent live window`).toBe(206);
      expect.soft(resumed.body).toBe(" sample bytes");
    }
    now = startedAt + 21 * minute + 1;
    for (const index of [1, 39, 79]) expect.soft((await jar.get(general[index]!)).status, "resuming did not renew the later file window").toBe(410);
    process.stdout.write(`${JSON.stringify({ fixture: "80-file cookie jar", countedStarts: 80, maximumCookieHeaderBytes: jar.largestCookieHeader })}\n`);
    expect.soft(jar.largestCookieHeader, "largest actual outgoing Cookie header, including its name and CRLF").toBeLessThan(8 * 1024);
    const saved = await operation("get_transfer", { transfer: t.id });
    expect(saved.files.map((file) => file.downloads)).toEqual([...Array<number>(80).fill(1), 0]);
    expect(saved.recipients.map((recipient) => recipient.downloads)).toEqual([0, 0, 0]);
  }, 120_000);
});
