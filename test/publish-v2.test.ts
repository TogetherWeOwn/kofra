import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";
import { b64, connectMcp } from "./mcp-helpers";

// Acceptance contract: docs/ROADMAP.md R-04 and docs/SPEC.md 9.2 / 11.7.
// These tests deliberately exercise public REST/MCP surfaces, not service internals.
let dw: Instance;
const bindings = env as unknown as Record<string, unknown>;
let previousFetchCap: unknown;

beforeEach(async () => {
  previousFetchCap = bindings.URL_FETCH_MAX_BYTES;
  dw = await freshInstance();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousFetchCap === undefined) delete bindings.URL_FETCH_MAX_BYTES;
  else bindings.URL_FETCH_MAX_BYTES = previousFetchCap;
});

function largeBase64(size: number) {
  // Avoid spreading a cap-sized binary into a single JavaScript argument list.
  return btoa("\0".repeat(size));
}

function publish(body: Record<string, unknown>, key?: string) {
  const init = jsonBody(body);
  if (key) init.headers = { ...init.headers, "Idempotency-Key": key };
  return dw.json("/api/v1/publish", { ...init, key: dw.ownerKey });
}

function expectResult(body: Record<string, any>, status: string, counters: Record<string, number>) {
  expect(body.status).toBe(status);
  expect(body.url).toEqual(expect.stringMatching(/^https:\/\//));
  expect(body.versionUrl).toEqual(expect.stringMatching(/^https:\/\//));
  expect(body.versionUrl).not.toBe(body.url);
  expect(body.site.id).toEqual(expect.any(String));
  expect(body.version.id).toEqual(expect.any(String));
  expect(body.files).toEqual(counters);
  expect(body.warnings).toEqual(expect.any(Array));
  expect(body.next).toEqual(expect.any(Array));
  for (const warning of body.warnings) {
    expect(warning).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  }
  for (const next of body.next) {
    expect(next).toMatchObject({ tool: expect.any(String), why: expect.any(String) });
  }
}

async function publishTool(body: Record<string, unknown>) {
  const mcp = await connectMcp(dw, dw.ownerKey);
  try { return await mcp.call("publish_site", body); }
  finally { await mcp.client.close(); }
}

async function pending(site: string, text: string): Promise<Record<string, any> & { entry: Awaited<ReturnType<typeof manifestEntry>>; item: any }> {
  const entry = await manifestEntry("data.txt", text);
  const result = await publishTool({ site, files: [{ path: entry.path, sha256: entry.sha256, size: entry.size }] });
  expect(result.isError).toBe(false);
  expect(result.data.status).toBe("awaiting_upload");
  expect(result.data.upload.items).toHaveLength(1);
  return { ...result.data, entry, item: result.data.upload.items[0] };
}

function tokenHeaders(item: Record<string, any>) {
  const headers = new Headers(item.headers);
  expect(headers.get("Authorization")).toEqual(expect.stringMatching(/^Bearer dwu_\S+$/));
  return headers;
}

async function readRaw(url: string, path: string) {
  const res = await dw.call(new URL(`${path}?raw=1`, url).href);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

// Only the external network is replaced: auth, routing, validation, D1, R2 and KV are real.
function externalFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    return handler(request.url, { headers: request.headers, signal: request.signal, method: request.method, redirect: request.redirect });
  });
}

async function expectFetchBlocked(url: string) {
  const result = await publishTool({ files: [{ path: "blocked.txt", url }] });
  expect(result.isError).toBe(true);
  expect(result.data.error.code).toBe("fetch_blocked");
  const sites = await dw.json("/api/v1/sites", { key: dw.ownerKey });
  expect(sites.body.sites).toHaveLength(0);
}

describe("R-04 flat FileInput and PublishResult", () => {
  it("REST stores UTF-8 and base64 bytes without changing their content", async () => {
    const bytes = new Uint8Array([0, 255, 128, 1, 2]);
    const result = await publish({ site: "flat-bytes", files: [
      { path: "greeting.txt", content: "héllo 🌍", encoding: "utf8" },
      { path: "data.bin", content: b64(bytes), encoding: "base64" },
    ] });
    expect(result.status).toBe(201);
    expect(await readRaw(result.body.url, "greeting.txt")).toEqual(new TextEncoder().encode("héllo 🌍"));
    expect(await readRaw(result.body.url, "data.bin")).toEqual(bytes);
  });

  it("MCP accepts the same flat sources and returns the PublishResult contract", async () => {
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const result = await mcp.call("publish_site", { files: [{ path: "a.txt", content: "hello" }] });
      expect(result.isError).toBe(false);
      expectResult(result.data, "live", { total: 1, stored: 1, reused: 0, fetched: 0, pending: 0 });
      expect(await readRaw(result.data.url, "a.txt")).toEqual(new TextEncoder().encode("hello"));
    } finally { await mcp.client.close(); }
  });

  it("REST live result has versionUrl, counters, warnings and next", async () => {
    const result = await publish({ files: [{ path: "a.txt", content: "first" }] });
    expect(result.status).toBe(201);
    expectResult(result.body, "live", { total: 1, stored: 1, reused: 0, fetched: 0, pending: 0 });
  });

  it("identical republish is unchanged and keeps the exact version and versionUrl", async () => {
    const input = { site: "unchanged-result", files: [{ path: "a.txt", content: "same" }] };
    const first = await publish(input);
    const again = await publish(input);
    expect(again.status).toBeGreaterThanOrEqual(200);
    expect(again.status).toBeLessThan(300);
    expectResult(again.body, "unchanged", { total: 1, stored: 0, reused: 1, fetched: 0, pending: 0 });
    expect(again.body.version.id).toBe(first.body.version.id);
    expect(again.body.versionUrl).toBe(first.body.versionUrl);
  });

  it("sha256 plus size reuses bytes already held by this owner", async () => {
    const entry = await manifestEntry("copy.txt", "already stored");
    await publish({ site: "seed-digest", files: [{ path: "source.txt", content: "already stored" }] });
    const result = await publish({ files: [{ path: entry.path, sha256: entry.sha256, size: entry.size }] });
    expect(result.status).toBe(201);
    expect(result.body.status).toBe("live");
    expect(result.body.files).toMatchObject({ total: 1, reused: 1, pending: 0 });
    expect(await readRaw(result.body.url, "copy.txt")).toEqual(entry.bytes);
  });

  it("copyFrom can name an earlier immutable version, not just the live bytes", async () => {
    const first = await publish({ site: "copy-origin", files: [{ path: "source.txt", content: "old bytes" }] });
    await publish({ site: "copy-origin", files: [{ path: "source.txt", content: "new bytes" }] });
    const result = await publish({ files: [{ path: "copied.txt", copyFrom: { site: "copy-origin", version: first.body.version.id, path: "source.txt" } }] });
    expect(result.status).toBe(201);
    expect(result.body.status).toBe("live");
    expect(await readRaw(result.body.url, "copied.txt")).toEqual(new TextEncoder().encode("old bytes"));
  });

  const sources = [
    { content: "inline" },
    { url: "https://93.184.216.34/a" },
    { sha256: "a".repeat(64), size: 3 },
    { copyFrom: { site: "other", path: "a.txt" } },
  ];
  const invalidSources = [{ name: "no source", file: {} }];
  for (let a = 0; a < sources.length; a++) {
    for (let b = a + 1; b < sources.length; b++) {
      invalidSources.push({ name: `source pair ${a + 1}/${b + 1}`, file: { ...sources[a], ...sources[b] } });
    }
  }
  it.each(invalidSources)("rejects $name with invalid_request and a field location", async ({ file }) => {
    externalFetch(() => new Response("network source must not be used"));
    const result = await publish({ files: [{ path: "a.txt", ...file }] });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("invalid_request");
    expect(result.body.error.details.fields).toEqual(expect.arrayContaining([expect.objectContaining({ field: "files[0]" })]));
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey })).body.sites).toHaveLength(0);
  });

  it.each([
    { sha256: "a".repeat(64) }, { size: 3 }, { sha256: "not-a-digest", size: 3 },
  ])("MCP rejects incomplete or invalid digest source %j", async (file) => {
    const result = await publishTool({ files: [{ path: "a.txt", ...file }] });
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ error: { code: "invalid_request", details: { fields: expect.any(Array) } } });
    expect(result.data.error.details.fields.length).toBeGreaterThan(0);
    for (const field of result.data.error.details.fields) expect(field.field).toMatch(/^files\[0\]/);
  });

  it("MCP stores UTF-8 and base64, then reuses a digest and copies a pinned version", async () => {
    const bytes = new Uint8Array([0, 255, 128]);
    const first = await publishTool({ site: "source-fixtures", files: [
      { path: "text.txt", content: "héllo 🌍" }, { path: "bytes.bin", content: b64(bytes), encoding: "base64" },
    ] });
    expect(first.isError).toBe(false);
    expect(await readRaw(first.data.url, "text.txt")).toEqual(new TextEncoder().encode("héllo 🌍"));
    expect(await readRaw(first.data.url, "bytes.bin")).toEqual(bytes);
    await publishTool({ site: "source-fixtures", files: [{ path: "text.txt", content: "replacement" }] });
    const entry = await manifestEntry("digest.txt", "héllo 🌍");
    const result = await publishTool({ files: [
      { path: "digest.txt", sha256: entry.sha256, size: entry.size },
      { path: "copy.bin", copyFrom: { site: "source-fixtures", version: first.data.version.id, path: "bytes.bin" } },
    ] });
    expect(result.isError).toBe(false);
    expect(result.data.files).toMatchObject({ total: 2, reused: 2, pending: 0 });
    expect(await readRaw(result.data.url, "digest.txt")).toEqual(entry.bytes);
    expect(await readRaw(result.data.url, "copy.bin")).toEqual(bytes);
  });

  it("MCP identical republish is unchanged and keeps its version", async () => {
    const input = { site: "mcp-unchanged", files: [{ path: "a.txt", content: "same" }] };
    const first = await publishTool(input);
    const again = await publishTool(input);
    expect(first.isError).toBe(false);
    expect(again.isError).toBe(false);
    expect(again.data.status).toBe("unchanged");
    expect(again.data.version.id).toBe(first.data.version.id);
  });

  it("MCP reports all missing/conflicting source fields in one error", async () => {
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const result = await mcp.call("publish_site", { files: [
        { path: "a.txt" }, { path: "b.txt", content: "b", url: "https://93.184.216.34/b" },
      ] });
      expect(result.isError).toBe(true);
      expect(result.data.error.code).toBe("invalid_request");
      expect(result.data.error.details.fields.map((field: any) => field.field)).toEqual(["files[0]", "files[1]"]);
    } finally { await mcp.client.close(); }
  });
});

describe("R-04 URL sources", () => {
  it("fetches a public HTTPS source, passes request headers, and stores exact bytes", async () => {
    externalFetch((url, init) => {
      if (url !== "https://93.184.216.34/file" || new Headers(init?.headers).get("X-Asset-Key") !== "fixture-only") {
        return new Response("wrong URL or missing header", { status: 403 });
      }
      return new Response("fetched bytes", { headers: { "Content-Type": "text/plain" } });
    });
    const result = await publishTool({ files: [{ path: "remote.txt", url: "https://93.184.216.34/file", headers: { "X-Asset-Key": "fixture-only" } }] });
    expect(result.isError).toBe(false);
    expect(result.data.files).toMatchObject({ total: 1, fetched: 1, pending: 0 });
    expect(await readRaw(result.data.url, "remote.txt")).toEqual(new TextEncoder().encode("fetched bytes"));
    const files = await dw.json(`/api/v1/sites/${result.data.site.id}/files`, { key: dw.ownerKey });
    expect(JSON.stringify(files.body)).not.toContain("fixture-only");
  });

  const refused = [
    "http://93.184.216.34/x", "ftp://93.184.216.34/x",
    "https://10.0.0.1/x", "https://172.16.0.1/x", "https://192.168.1.1/x",
    "https://127.0.0.1/x", "https://127.255.255.254/x", "https://169.254.169.254/x",
    "https://[::1]/x", "https://[fc00::1]/x", "https://[fe80::1]/x",
    "https://[::ffff:127.0.0.1]/x", "https://localhost/x", "https://printer.local/x",
  ];
  it.each(refused)("refuses unsafe source %s without creating a site", async (url) => {
    // A bypass receives a successful response, so a missing guard cannot pass by network failure.
    externalFetch(() => new Response("unsafe bytes"));
    await expectFetchBlocked(url);
  });

  it.each([1, 2, 3])("rechecks private redirect targets at hop %i", async (hop) => {
    externalFetch((url) => {
      const step = Number(new URL(url).pathname.slice(1));
      if (step < hop) return new Response(null, { status: 302, headers: { Location: step + 1 === hop ? "https://10.0.0.1/private" : `https://93.184.216.34/${step + 1}` } });
      return new Response("unsafe bytes");
    });
    await expectFetchBlocked("https://93.184.216.34/0");
  });

  it("rechecks HTTPS after a redirect instead of following a downgrade", async () => {
    externalFetch((url) => url.startsWith("https:")
      ? new Response(null, { status: 302, headers: { Location: "http://93.184.216.34/plain" } })
      : new Response("downgraded bytes"));
    await expectFetchBlocked("https://93.184.216.34/start");
  });

  it("permits three public redirects", async () => {
    externalFetch((url) => {
      const step = Number(new URL(url).pathname.slice(1));
      return step < 3 ? new Response(null, { status: 302, headers: { Location: `/${step + 1}` } }) : new Response("third hop");
    });
    const result = await publishTool({ files: [{ path: "a.txt", url: "https://93.184.216.34/0" }] });
    expect(result.isError).toBe(false);
    expect(await readRaw(result.data.url, "a.txt")).toEqual(new TextEncoder().encode("third hop"));
  });

  it("refuses a fourth redirect even when the eventual response is successful", async () => {
    externalFetch((url) => {
      const step = Number(new URL(url).pathname.slice(1));
      return step < 4 ? new Response(null, { status: 302, headers: { Location: `/${step + 1}` } }) : new Response("too far");
    });
    const result = await publishTool({ files: [{ path: "a.txt", url: "https://93.184.216.34/0" }] });
    expect(result.isError).toBe(true);
    expect(["fetch_failed", "fetch_blocked"]).toContain(result.data.error.code);
  });

  it.each(["declared", "streamed"])("enforces URL_FETCH_MAX_BYTES on %s bytes", async (mode) => {
    bindings.URL_FETCH_MAX_BYTES = "8";
    dw = await freshInstance(); // Configure the binding before this app caches its config.
    externalFetch(() => mode === "declared"
      ? new Response("123456789", { headers: { "Content-Length": "9" } })
      : new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("1234")); controller.enqueue(new TextEncoder().encode("56789")); controller.close(); } })));
    const result = await publishTool({ files: [{ path: "a.txt", url: "https://93.184.216.34/large" }] });
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe("file_too_large");
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey })).body.sites).toHaveLength(0);
  });

  it("accepts a URL source exactly at URL_FETCH_MAX_BYTES", async () => {
    bindings.URL_FETCH_MAX_BYTES = "8";
    dw = await freshInstance(); // Configure the binding before this app caches its config.
    externalFetch(() => new Response("12345678"));
    const result = await publishTool({ files: [{ path: "a.txt", url: "https://93.184.216.34/exact" }] });
    expect(result.isError).toBe(false);
    expect(await readRaw(result.data.url, "a.txt")).toEqual(new TextEncoder().encode("12345678"));
  });

});

describe("R-04 upload capabilities", () => {
  it("awaiting_upload is a complete PublishResult with an actionable finalize step", async () => {
    const result = await pending("pending-result", "missing bytes");
    expectResult(result, "awaiting_upload", { total: 1, stored: 0, reused: 0, fetched: 0, pending: 1 });
    expect(result.upload).toMatchObject({ versionId: result.version.id, expiresAt: expect.any(String), finalize: { tool: "finalize_version", args: { site: expect.any(String), versionId: result.version.id } } });
    expect(Date.parse(result.upload.expiresAt)).toBeGreaterThan(Date.now());
    expect(result.next).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "finalize_version" })]));
  });

  it("returns a ready curl line and dwu_ headers that upload without an API key", async () => {
    const result = await pending("upload-token", "upload with a scoped capability");
    const headers = tokenHeaders(result.item);
    expect(result.item).toMatchObject({ path: "data.txt", sha256: result.entry.sha256, size: result.entry.size, method: "PUT", url: `${ORIGIN}/api/v1/blobs/${result.entry.sha256}` });
    expect(result.item.curl).toContain(result.item.url);
    expect(result.item.curl).toContain(headers.get("Authorization"));
    expect(result.item.curl).toMatch(/^curl\s/);
    const uploadsFile = /(?:-T|--upload-file)(?:\s+|=)['"]?data\.txt['"]?/.test(result.item.curl);
    const sendsBinary = /--data-binary(?:\s+|=)['"]?@['"]?data\.txt['"]?/.test(result.item.curl);
    const puts = /(?:-X|--request)(?:\s+|=)['"]?PUT/.test(result.item.curl);
    expect(uploadsFile || (puts && sendsBinary)).toBe(true);
    headers.set("Content-Length", String(result.entry.size));
    const put = await dw.call(result.item.url, { method: "PUT", headers, body: result.entry.bytes });
    expect(put.status).toBe(201);
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const finalized = await mcp.call(result.upload.finalize.tool, result.upload.finalize.args);
      expect(finalized.isError).toBe(false);
      expect(finalized.data.status).toBe("live");
      expect(await readRaw(finalized.data.url, "data.txt")).toEqual(result.entry.bytes);
    } finally { await mcp.client.close(); }
  });

  it("refuses another pending version's upload token with 403", async () => {
    const a = await pending("version-a", "bytes A");
    const b = await pending("version-b", "bytes B");
    const wrong = tokenHeaders(b.item);
    wrong.set("Authorization", tokenHeaders(a.item).get("Authorization")!);
    wrong.set("Content-Length", String(b.entry.size));
    expect((await dw.call(b.item.url, { method: "PUT", headers: wrong, body: b.entry.bytes })).status).toBe(403);
    const right = tokenHeaders(b.item);
    right.set("Content-Length", String(b.entry.size));
    expect((await dw.call(b.item.url, { method: "PUT", headers: right, body: b.entry.bytes })).status).toBe(201);
  });

  it("rejects a tampered upload capability instead of trusting an unsigned scope", async () => {
    const result = await pending("tampered-token", "signed bytes");
    const headers = tokenHeaders(result.item);
    const auth = headers.get("Authorization")!;
    expect(auth.split(".")).toHaveLength(3); // SPEC 11.4: dwu_<versionId>.<exp>.<hmac>
    const at = auth.lastIndexOf(".") + 1;
    headers.set("Authorization", auth.slice(0, at) + (auth[at] === "a" ? "b" : "a") + auth.slice(at + 1));
    headers.set("Content-Length", String(result.entry.size));
    const response = await dw.call(result.item.url, { method: "PUT", headers, body: result.entry.bytes });
    expect([401, 403]).toContain(response.status);
  });

  it("expires the upload token with its pending version", async () => {
    const result = await pending("expired-token", "expired bytes");
    const headers = tokenHeaders(result.item);
    headers.set("Content-Length", String(result.entry.size));
    const expiredAt = Date.parse(result.upload.expiresAt) + 1000;
    expect(Number.isFinite(expiredAt)).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(expiredAt);
    const response = await dw.json(result.item.url, { method: "PUT", headers, body: result.entry.bytes });
    expect(response.status).toBe(410);
    expect(response.body.error.code).toBe("upload_expired");
  });
});

describe("R-04 idempotency", () => {
  it("REST same key and body replays the first response without creating a second site", async () => {
    const input = { files: [{ path: "a.txt", content: "one creation" }] };
    const first = await publish(input, "rest-replay");
    expect(first.status).toBe(201);
    const replay = await publish(input, "rest-replay");
    expect(replay.status).toBeGreaterThanOrEqual(200);
    expect(replay.status).toBeLessThan(300);
    expect(replay.body).toEqual({ ...first.body, replayed: true });
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey })).body.sites).toHaveLength(1);
  });

  it("REST same key with a changed body is 422 idempotency_key_reused", async () => {
    await publish({ files: [{ path: "a.txt", content: "one" }] }, "rest-changed");
    const result = await publish({ files: [{ path: "a.txt", content: "two" }] }, "rest-changed");
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe("idempotency_key_reused");
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey })).body.sites).toHaveLength(1);
  });

  it("MCP same key and body replays the first structured result", async () => {
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const input = { idempotencyKey: "mcp-replay", files: [{ path: "a.txt", content: "MCP creation" }] };
      const first = await mcp.call("publish_site", input);
      expect(first.isError).toBe(false);
      const replay = await mcp.call("publish_site", input);
      expect(replay.isError).toBe(false);
      expect(replay.data).toEqual({ ...first.data, replayed: true });
      expect((await dw.json("/api/v1/sites", { key: dw.ownerKey })).body.sites).toHaveLength(1);
    } finally { await mcp.client.close(); }
  });

  it("MCP same key with a changed body reports idempotency_key_reused", async () => {
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const first = await mcp.call("publish_site", { idempotencyKey: "mcp-changed", files: [{ path: "a.txt", content: "one" }] });
      expect(first.isError).toBe(false);
      const result = await mcp.call("publish_site", { idempotencyKey: "mcp-changed", files: [{ path: "a.txt", content: "two" }] });
      expect(result.isError).toBe(true);
      expect(result.data.error.code).toBe("idempotency_key_reused");
    } finally { await mcp.client.close(); }
  });

  it.each(["REST", "MCP"])("%s concurrent duplicate is retryable instead of executing twice", async (surface) => {
    let entered!: () => void;
    let release!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const holding = new Promise<void>((resolve) => { release = resolve; });
    externalFetch(async () => { entered(); await holding; return new Response("once"); });
    const input = { files: [{ path: "a.txt", url: "https://93.184.216.34/held" }] };
    const mcp = surface === "MCP" ? await connectMcp(dw, dw.ownerKey) : undefined;
    const duplicateMcp = mcp ? await connectMcp(dw, dw.ownerKey) : undefined;
    const invoke = (client = mcp) => client ? client.call("publish_site", { ...input, idempotencyKey: "concurrent" }) : publish(input, "concurrent");
    let barrierTimer: ReturnType<typeof setTimeout> | undefined;
    let duplicateTimer: ReturnType<typeof setTimeout> | undefined;
    const first = invoke();
    let second: ReturnType<typeof invoke> | undefined;
    try {
      const reachedSource = await Promise.race([
        entering.then(() => true), first.then(() => false),
        new Promise((resolve) => { barrierTimer = setTimeout(() => resolve(false), 2000); }),
      ]);
      expect(reachedSource, "first publish must accept the URL source before exercising concurrent idempotency").toBe(true);
      second = invoke(duplicateMcp);
      const duplicate: any = await Promise.race([second, new Promise((resolve) => { duplicateTimer = setTimeout(() => resolve({ status: "duplicate waited instead of returning a conflict" }), 2000); })]);
      if (mcp) expect(duplicate.isError).toBe(true);
      else expect(duplicate.status).toBe(409);
      const error = mcp ? duplicate.data.error : duplicate.body.error;
      expect(error).toMatchObject({ code: "idempotency_in_progress", retryable: true });
    } finally {
      if (barrierTimer !== undefined) clearTimeout(barrierTimer);
      if (duplicateTimer !== undefined) clearTimeout(duplicateTimer);
      release();
      await first;
      if (second) await second;
      if (duplicateMcp) await duplicateMcp.client.close();
      if (mcp) await mcp.client.close();
    }
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey })).body.sites).toHaveLength(1);
  });
});

describe("R-04 inline caps", () => {
  for (const surface of ["REST", "MCP"]) it.each([
    { name: "UTF-8 per file", files: [{ path: "a.txt", content: "é".repeat(524_289) }] },
    { name: "base64 decoded bytes per file", files: [{ path: "a.bin", content: largeBase64(262_145), encoding: "base64" }] },
    { name: "UTF-8 aggregate", files: Array.from({ length: 5 }, (_, i) => ({ path: `${i}.txt`, content: "x".repeat(900_000) })) },
    { name: "base64 aggregate", files: Array.from({ length: 5 }, (_, i) => ({ path: `${i}.bin`, content: largeBase64(220_000), encoding: "base64" })) },
  ])(`${surface} refuses $name with a CLI/upload-links remediation hint`, async ({ files }) => {
    let error: Record<string, any>;
    if (surface === "REST") {
      const result = await publish({ files });
      expect(result.status).toBe(413);
      error = result.body.error;
    } else {
      const request = publishTool({ files });
      await expect(request, "MCP must return inline_too_large, not reject at the transport boundary").resolves.toMatchObject({ isError: true });
      const result = await request;
      error = result.data.error;
    }
    expect(error).toMatchObject({ code: "inline_too_large", hint: expect.any(String) });
    expect(error.hint).toMatch(/CLI|npx kofra/i);
    expect(error.hint).toMatch(/upload links/i);
  });

  it.each([
    { name: "UTF-8", file: { path: "exact.txt", content: "x".repeat(1_048_576) } },
    // 196608 bytes encode to 262144 characters: within either reading of the base64 cap.
    { name: "base64", file: { path: "exact.bin", content: largeBase64(196_608), encoding: "base64" } },
  ])("accepts $name exactly at the per-file cap", async ({ file }) => {
    const result = await publish({ files: [file] });
    expect(result.status).toBe(201);
    expect((await readRaw(result.body.url, file.path)).length).toBe(file.encoding === "base64" ? 196_608 : 1_048_576);
  });
});
