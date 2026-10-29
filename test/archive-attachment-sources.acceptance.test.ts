import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync, strToU8, Zip, ZipPassThrough } from "fflate";
import { ApiError, unzipFiles } from "@dropway/core";
import { freshInstance, jsonBody, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";

// Failing-first acceptance contract for PUB-14 (R-35):
// `archiveUrl` as a top-level alternative to `files` in POST /api/v1/publish
// and MCP publish_site, plus chat-client attachments
// (`{ download_url, file_name }`) as per-file sources.
// Only the external network is mocked; auth, routing, validation, D1, R2 and
// KV are real. Proposed contract (RED until implemented):
// - Public HTTPS ZIP fetched with the existing URL-source protections,
//   extracted, common root stripped consistently with the existing ZIP
//   publisher.
// - attachments normalize download_url/file_name to url/path, with optional
//   contentType/headers consistent with existing URL sources.
// - Conflicting source fields, files+archiveUrl, and unsafe names fail before
//   creating a site.
// - Malformed ZIP, traversal, expanded size/file-count budgets, SSRF/private
//   redirect refusal, credential drop after cross-origin hops, and the shared
//   streaming budget are enforced.
// Error-name policy: assert existing stable codes only where the contract is
// already settled (fetch_blocked, file_too_large, invalid_request); otherwise
// accept any non-2xx ApiError envelope with a stable snake_case code + hint.

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const SNAKE = /^[a-z][a-z0-9_]*$/;

function expectApiError(body: Record<string, any>, codes?: string[]) {
  expect(body.error).toMatchObject({ code: expect.any(String), hint: expect.any(String) });
  expect(body.error.code).toMatch(SNAKE);
  expect(body.error.hint.length).toBeGreaterThan(0);
  if (codes) expect(codes).toContain(body.error.code);
}

async function expectNoSites() {
  const sites = await dw.json("/api/v1/sites", { key: dw.ownerKey });
  expect(sites.body.sites).toHaveLength(0);
}

function externalFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    return handler(request.url, {
      headers: request.headers,
      signal: request.signal,
      method: request.method,
      redirect: request.redirect,
    });
  });
}

function zipResponse(files: Record<string, string>): Response {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) entries[path] = strToU8(text);
  return new Response(zipSync(entries) as unknown as BodyInit, {
    headers: { "Content-Type": "application/zip" },
  });
}

function zipBytesResponse(zip: Uint8Array): Response {
  return new Response(zip as unknown as BodyInit, { headers: { "Content-Type": "application/zip" } });
}

/**
 * Build a stored (uncompressed) ZIP from an ordered entry list, so legal
 * names like "__proto__" and repeated names survive fixture construction:
 * an object literal cannot carry either. Small benign text entries only.
 */
function buildStoredZip(entries: Array<[string, string]>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((err, chunk, final) => {
      if (err) { reject(err); return; }
      chunks.push(chunk);
      if (!final) return;
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      resolve(out);
    });
    for (const [name, text] of entries) {
      const file = new ZipPassThrough(name);
      zip.add(file);
      file.push(strToU8(text), true);
    }
    zip.end();
  });
}

/**
 * Rewrite only the declared uncompressed-size fields (local + central
 * headers) of a small stored ZIP, leaving the stored bytes untouched. This
 * is the bounded declaration/output disagreement seam: a few KB of fixture
 * bytes whose headers claim far fewer than the extractor will produce.
 */
function withDeclaredUncompressedSize(zip: Uint8Array, declared: number): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = dv.getUint32(i, true);
    if (sig === 0x04034b50) dv.setUint32(i + 22, declared, true);
    if (sig === 0x02014b50) dv.setUint32(i + 24, declared, true);
  }
  return out;
}

/** Settings + live-cache state of an existing site, as a refusal must preserve it. */
async function siteSnapshot(inst: Instance, slug: string) {
  const got = await inst.json(`/api/v1/sites/${slug}`, { key: inst.ownerKey });
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  const row = await env.DB.prepare("SELECT title, password_hash, current_version_id FROM sites WHERE slug = ?")
    .bind(slug)
    .first<{ title: string | null; password_hash: string | null; current_version_id: string | null }>();
  expect(row).not.toBeNull();
  const liveRaw = await env.CACHE.get(`live:${slug}`);
  expect(liveRaw, "a live site must have a live-cache entry").not.toBeNull();
  const live = JSON.parse(liveRaw!);
  return {
    title: got.body.site.title,
    settings: got.body.site.settings,
    currentVersionId: got.body.site.currentVersionId,
    passwordHash: row!.password_hash,
    livePasswordHash: live.passwordHash,
    liveVersionId: live.versionId,
    liveFiles: Object.keys(live.files).sort().map((path) => [path, live.files[path]]),
  };
}

async function createProtectedSite(inst: Instance, slug: string) {
  const created = await inst.json("/api/v1/publish", {
    ...jsonBody({ site: slug, title: "Old title", spa: true, password: "old-password", files: [{ path: "index.html", content: "oldv1!" }] }),
    key: inst.ownerKey,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.status).toBe("live");
  const before = await siteSnapshot(inst, slug);
  expect(before.settings.passwordProtected).toBe(true);
  expect(before.passwordHash).toEqual(expect.any(String));
  expect(before.livePasswordHash).toBe(before.passwordHash);
  return before;
}

async function readRaw(url: string, path: string) {
  const res = await dw.call(new URL(`${path}?raw=1`, url).href);
  expect(res.status).toBe(200);
  return new TextDecoder().decode(await res.arrayBuffer());
}

async function publishRest(body: Record<string, unknown>) {
  return dw.json("/api/v1/publish", { ...jsonBody(body), key: dw.ownerKey });
}

async function publishMcp(body: Record<string, unknown>) {
  const mcp = await connectMcp(dw, dw.ownerKey);
  try {
    return await mcp.call("publish_site", body);
  } finally {
    await mcp.client.close();
  }
}

describe("archiveUrl publishes a zip from a URL", () => {
  it("REST fetches, extracts and strips the common root like the ZIP publisher", async () => {
    externalFetch((url) => {
      if (url !== "https://93.184.216.34/site.zip") return new Response("unexpected", { status: 400 });
      return zipResponse({ "dist/index.html": "<p>archive</p>", "dist/css/site.css": "p{}" });
    });
    const result = await publishRest({ site: "archive-site", archiveUrl: "https://93.184.216.34/site.zip" });
    expect(result.status).toBe(201);
    expect(result.body.status).toBe("live");
    expect(result.body.files.total).toBe(2);
    expect(await readRaw(result.body.url, "index.html")).toBe("<p>archive</p>");
    expect(await readRaw(result.body.url, "css/site.css")).toBe("p{}");
  });

  it("MCP archiveUrl reaches the same live result (REST/MCP parity)", async () => {
    externalFetch((url) => {
      if (url !== "https://93.184.216.34/site.zip") return new Response("unexpected", { status: 400 });
      return zipResponse({ "dist/index.html": "<p>archive</p>" });
    });
    const result = await publishMcp({ site: "mcp-archive", archiveUrl: "https://93.184.216.34/site.zip" });
    expect(result.isError).toBe(false);
    expect(result.data.status).toBe("live");
    expect(result.data.files.total).toBe(1);
    expect(await readRaw(result.data.url, "index.html")).toBe("<p>archive</p>");
  });

  it("keeps entries without a common root untouched", async () => {
    externalFetch(() => zipResponse({ "index.html": "<h1>flat</h1>", "assets/app.js": "console.log(1)" }));
    const result = await publishRest({ archiveUrl: "https://93.184.216.34/flat.zip" });
    expect(result.status).toBe(201);
    expect(await readRaw(result.body.url, "index.html")).toBe("<h1>flat</h1>");
    expect(await readRaw(result.body.url, "assets/app.js")).toBe("console.log(1)");
  });

  it("REST and MCP reject files+archiveUrl together before creating a site", async () => {
    externalFetch(() => zipResponse({ "index.html": "unused" }));
    const rest = await publishRest({
      files: [{ path: "a.txt", content: "inline" }],
      archiveUrl: "https://93.184.216.34/site.zip",
    });
    expect(rest.status).toBeGreaterThanOrEqual(400);
    expectApiError(rest.body);
    await expectNoSites();

    const mcp = await publishMcp({
      files: [{ path: "a.txt", content: "inline" }],
      archiveUrl: "https://93.184.216.34/site.zip",
    });
    expect(mcp.isError).toBe(true);
    expectApiError(mcp.data);
    await expectNoSites();
  });

  it("rejects a malformed archive with the settled ZIP error and no site", async () => {
    externalFetch(() => new Response("not a zip at all", { headers: { "Content-Type": "application/zip" } }));
    const result = await publishRest({ archiveUrl: "https://93.184.216.34/broken.zip" });
    expect(result.status).toBe(400);
    expectApiError(result.body, ["invalid_zip"]);
    await expectNoSites();
  });

  it("rejects traversal and absolute entry names with the settled path error and no site", async () => {
    for (const evil of ["../evil.txt", "/abs.txt", "a/../../evil.txt"]) {
      externalFetch(() => zipResponse({ [evil]: "escape", "index.html": "ok" }));
      const result = await publishRest({ archiveUrl: "https://93.184.216.34/evil.zip" });
      expect(result.status, evil).toBe(400);
      expectApiError(result.body, ["invalid_path"]);
      await expectNoSites();
    }
  });

  it("refuses expanded bytes even when the compressed ZIP fits every download and one-shot cap", async () => {
    const capped = await freshInstance({ limits: { maxFileBytes: 10_000, maxSiteBytes: 1_000, oneShotMaxBytes: 10_000 }, urlFetchMaxBytes: 10_000 });
    const archive = zipSync({ "large.txt": strToU8("z".repeat(4_000)) });
    expect(archive.length).toBeLessThan(1_000);
    externalFetch(() => new Response(archive as unknown as BodyInit, { headers: { "Content-Type": "application/zip" } }));
    const result = await capped.json("/api/v1/publish", { ...jsonBody({ archiveUrl: "https://93.184.216.34/compressed.zip" }), key: capped.ownerKey });
    expect(result.status).toBe(413);
    expectApiError(result.body, ["site_too_large"]);
    expect((await capped.json("/api/v1/sites", { key: capped.ownerKey })).body.sites).toHaveLength(0);
  });

  it("enforces expanded size and file-count budgets without creating a site", async () => {
    const small = await freshInstance({ limits: { maxFileBytes: 8 } });
    externalFetch(() => zipResponse({ "big.txt": "123456789" }));
    const tooLarge = await small.json("/api/v1/publish", {
      ...jsonBody({ archiveUrl: "https://93.184.216.34/big.zip" }),
      key: small.ownerKey,
    });
    expect(tooLarge.status).toBeGreaterThanOrEqual(400);
    expectApiError(tooLarge.body, ["file_too_large"]);
    expect((await small.json("/api/v1/sites", { key: small.ownerKey })).body.sites).toHaveLength(0);

    const capped = await freshInstance({ limits: { maxFiles: 1 } });
    externalFetch(() => zipResponse({ "a.txt": "a", "b.txt": "b" }));
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let hashedEntries = 0;
    vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
      if (data.byteLength === 1) hashedEntries++;
      return digest(algorithm, data);
    });
    const tooMany = await capped.json("/api/v1/publish", {
      ...jsonBody({ archiveUrl: "https://93.184.216.34/two.zip" }),
      key: capped.ownerKey,
    });
    expect(tooMany.status).toBeGreaterThanOrEqual(400);
    expectApiError(tooMany.body, ["too_many_files"]);
    expect(hashedEntries, "an over-count archive must be rejected before entry hashing").toBe(0);
    expect((await capped.json("/api/v1/sites", { key: capped.ownerKey })).body.sites).toHaveLength(0);
  });
});

describe("archiveUrl reuses URL-source protections", () => {
  it("refuses non-HTTPS and private archive URLs without creating a site", async () => {
    externalFetch(() => new Response("unsafe bytes"));
    for (const url of ["http://93.184.216.34/site.zip", "https://10.0.0.1/site.zip", "https://127.0.0.1/site.zip"]) {
      const result = await publishRest({ archiveUrl: url });
      expect(result.status, url).toBeGreaterThanOrEqual(400);
      expectApiError(result.body, ["fetch_blocked"]);
      await expectNoSites();
    }
  });

  it("rechecks private redirect targets and refuses downgrades", async () => {
    externalFetch((url) => {
      if (url === "https://93.184.216.34/start") {
        return new Response(null, { status: 302, headers: { Location: "https://10.0.0.1/private.zip" } });
      }
      return new Response("unsafe bytes");
    });
    const rerouted = await publishRest({ archiveUrl: "https://93.184.216.34/start" });
    expect(rerouted.status).toBeGreaterThanOrEqual(400);
    expectApiError(rerouted.body, ["fetch_blocked", "fetch_failed"]);
    await expectNoSites();

    externalFetch((url) =>
      url.startsWith("https:")
        ? new Response(null, { status: 302, headers: { Location: "http://93.184.216.34/plain.zip" } })
        : new Response("downgraded bytes"),
    );
    const downgraded = await publishRest({ archiveUrl: "https://93.184.216.34/start" });
    expect(downgraded.status).toBeGreaterThanOrEqual(400);
    expectApiError(downgraded.body, ["fetch_blocked", "fetch_failed"]);
    await expectNoSites();
  });

  it("permits three public redirects but refuses the fourth", async () => {
    externalFetch((url) => {
      const step = Number(new URL(url).pathname.slice(1));
      if (step < 3) return new Response(null, { status: 302, headers: { Location: `/${step + 1}` } });
      return zipResponse({ "index.html": "third hop" });
    });
    const ok = await publishRest({ archiveUrl: "https://93.184.216.34/0" });
    expect(ok.status).toBe(201);
    expect(await readRaw(ok.body.url, "index.html")).toBe("third hop");

    externalFetch((url) => {
      const step = Number(new URL(url).pathname.slice(1));
      if (step < 4) return new Response(null, { status: 302, headers: { Location: `/${step + 1}` } });
      return zipResponse({ "index.html": "too far" });
    });
    const tooFar = await publishRest({ archiveUrl: "https://93.184.216.34/0" });
    expect(tooFar.status).toBeGreaterThanOrEqual(400);
    expectApiError(tooFar.body, ["fetch_blocked", "fetch_failed"]);
  });

  it("strips attachment caller headers after a cross-origin redirect and publishes exact bytes", async () => {
    // archiveUrl is a bare string with no caller-header input, so the
    // credential boundary is pinned through attachment headers instead:
    // same-origin retains, cross-origin strips, bytes still publish.
    const seen: { url: string; headers: Headers }[] = [];
    externalFetch((url, init) => {
      seen.push({ url, headers: new Headers(init?.headers) });
      if (url === "https://93.184.216.34/start") {
        return new Response(null, { status: 302, headers: { Location: "https://93.184.216.35/end" } });
      }
      if (url === "https://93.184.216.35/end") {
        return new Response("attachment bytes", { headers: { "Content-Type": "text/plain" } });
      }
      return new Response("unexpected external URL", { status: 400 });
    });
    const result = await publishRest({
      files: [{
        download_url: "https://93.184.216.34/start",
        file_name: "asset.bin",
        headers: { "X-Asset-Key": "fixture-only" },
      }],
    });
    expect(result.status).toBe(201);
    expect(result.body.status).toBe("live");
    expect(await readRaw(result.body.url, "asset.bin")).toBe("attachment bytes");
    expect(seen.map((hop) => hop.url)).toEqual(["https://93.184.216.34/start", "https://93.184.216.35/end"]);
    expect(seen[0]!.headers.get("X-Asset-Key")).toBe("fixture-only");
    expect(seen[1]!.headers.get("X-Asset-Key")).toBeNull();
  });
});

describe("chat-client attachments as file sources", () => {
  it("REST normalizes download_url/file_name to url/path", async () => {
    externalFetch((url) => {
      if (url !== "https://93.184.216.34/asset") return new Response("unexpected", { status: 400 });
      return new Response("attachment bytes", { headers: { "Content-Type": "text/plain" } });
    });
    const result = await publishRest({
      files: [{ download_url: "https://93.184.216.34/asset", file_name: "photo.txt" }],
    });
    expect(result.status).toBe(201);
    expect(result.body.status).toBe("live");
    expect(await readRaw(result.body.url, "photo.txt")).toBe("attachment bytes");
  });

  it("MCP accepts the same attachment shape (REST/MCP parity)", async () => {
    externalFetch(() => new Response("mcp attachment bytes", { headers: { "Content-Type": "text/plain" } }));
    const result = await publishMcp({
      files: [{ download_url: "https://93.184.216.34/asset", file_name: "note.txt" }],
    });
    expect(result.isError).toBe(false);
    expect(result.data.status).toBe("live");
    expect(await readRaw(result.data.url, "note.txt")).toBe("mcp attachment bytes");
  });

  it("passes optional contentType and headers consistently with URL sources", async () => {
    externalFetch((url, init) => {
      if (url !== "https://93.184.216.34/asset") return new Response("unexpected", { status: 400 });
      if (new Headers(init?.headers).get("X-Asset-Key") !== "fixture-only") {
        return new Response("missing header", { status: 403 });
      }
      return new Response("typed bytes", { headers: { "Content-Type": "application/octet-stream" } });
    });
    const result = await publishRest({
      files: [{
        download_url: "https://93.184.216.34/asset",
        file_name: "data.bin",
        contentType: "application/octet-stream",
        headers: { "X-Asset-Key": "fixture-only" },
      }],
    });
    expect(result.status).toBe(201);
    expect(await readRaw(result.body.url, "data.bin")).toBe("typed bytes");
    const files = await dw.json(`/api/v1/sites/${result.body.site.id}/files`, { key: dw.ownerKey });
    expect(JSON.stringify(files.body)).not.toContain("fixture-only");
  });

  it("rejects conflicting source fields inside one attachment entry", async () => {
    externalFetch(() => new Response("must not be fetched"));
    const conflicts: Record<string, unknown>[] = [
      { download_url: "https://93.184.216.34/a", file_name: "a.txt", content: "inline" },
      { download_url: "https://93.184.216.34/a", file_name: "a.txt", url: "https://93.184.216.34/a" },
      { download_url: "https://93.184.216.34/a", file_name: "a.txt", path: "different.txt" },
    ];
    for (const file of conflicts) {
      const rest = await publishRest({ files: [file] });
      expect(rest.status, JSON.stringify(file)).toBeGreaterThanOrEqual(400);
      expectApiError(rest.body, ["invalid_request"]);
      await expectNoSites();

      const mcp = await publishMcp({ files: [file] });
      expect(mcp.isError, JSON.stringify(file)).toBe(true);
      expect(mcp.data.error.code).toBe("invalid_request");
      await expectNoSites();
    }
  });

  it("rejects unsafe attachment file names with the settled path error and no site", async () => {
    externalFetch(() => new Response("must not be fetched"));
    for (const file_name of ["../evil.txt", "/abs.txt"]) {
      const result = await publishRest({ files: [{ download_url: "https://93.184.216.34/a", file_name }] });
      expect(result.status, file_name).toBe(400);
      expectApiError(result.body, ["invalid_path"]);
      await expectNoSites();
    }
  });

  it("applies SSRF and budget guards to attachment fetches", async () => {
    externalFetch(() => new Response("unsafe bytes"));
    const blocked = await publishRest({ files: [{ download_url: "https://10.0.0.1/a", file_name: "a.txt" }] });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expectApiError(blocked.body, ["fetch_blocked"]);
    await expectNoSites();
  });

  it("enforces the shared aggregate budget across streamed attachment bodies", async () => {
    // 1,000-byte aggregate cap: the ~150-byte request JSON always fits, each
    // 600-byte streamed body is legal alone, but two together exceed it.
    const capped = await freshInstance({ limits: { oneShotMaxBytes: 1_000 }, urlFetchMaxBytes: 10_000 });
    const chunked = (n: number) => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < n; i += 100) controller.enqueue(new TextEncoder().encode("x".repeat(Math.min(100, n - i))));
        controller.close();
      },
    }));
    externalFetch((url) => {
      if (url === "https://93.184.216.34/first") return chunked(600);
      if (url === "https://93.184.216.34/sibling") return chunked(600);
      return new Response("unexpected external URL", { status: 400 });
    });
    const post = (files: unknown[]) => capped.json("/api/v1/publish", { ...jsonBody({ files }), key: capped.ownerKey });
    // Control: one streamed body fits the budget and publishes.
    const single = await post([{ download_url: "https://93.184.216.34/first", file_name: "first.bin" }]);
    expect(single.status).toBe(201);
    expect(single.body.status).toBe("live");
    expect(await readRaw(single.body.url, "first.bin")).toBe("x".repeat(600));
    // Both bodies exceed the shared budget: refused, and no second site exists.
    // The too_large family is the settled budget code (streaming-budget tests).
    const over = await post([
      { download_url: "https://93.184.216.34/first", file_name: "first.bin" },
      { download_url: "https://93.184.216.34/sibling", file_name: "sibling.bin" },
    ]);
    expect(over.status).toBeGreaterThanOrEqual(400);
    expectApiError(over.body);
    expect(over.body.error.code).toMatch(/too_large/);
    expect((await capped.json("/api/v1/sites", { key: capped.ownerKey })).body.sites).toHaveLength(1);
  });
});

// Review round: a refused REPLACEMENT archive must be validated before any
// settings of the existing site change. Applying updateSite ahead of manifest
// validation would strip the live site's password (and rewrite its live
// cache) even though the new version is then refused.
describe("rejected replacement archives leave an existing site untouched", () => {
  it("archiveUrl per-file refusal keeps password, other settings and the live cache; a valid replacement still applies them", async () => {
    const capped = await freshInstance({ limits: { maxFileBytes: 8 } });
    const before = await createProtectedSite(capped, "keep-per-file");
    externalFetch(() => zipResponse({ "big.txt": "123456789" })); // 9 bytes over an 8-byte per-file cap
    const refusedRes = await capped.json("/api/v1/publish", {
      ...jsonBody({ site: "keep-per-file", title: "New title", spa: false, password: null, archiveUrl: "https://93.184.216.34/big.zip" }),
      key: capped.ownerKey,
    });
    expect(refusedRes.status, JSON.stringify(refusedRes.body)).toBe(413);
    expectApiError(refusedRes.body, ["file_too_large"]);
    expect(await siteSnapshot(capped, "keep-per-file")).toEqual(before);
    // The old password still gates the live bytes: no unauthenticated read.
    const gated = await capped.call("/s/keep-per-file/index.html?raw=1");
    expect(gated.status).toBe(401);
    expect(await gated.text()).not.toContain("oldv1!");

    // Positive control: the same settings change DOES apply with a valid archive,
    // so the unchanged assertions above cannot pass vacuously.
    externalFetch(() => zipResponse({ "index.html": "new" }));
    const ok = await capped.json("/api/v1/publish", {
      ...jsonBody({ site: "keep-per-file", title: "New title", spa: false, password: null, archiveUrl: "https://93.184.216.34/ok.zip" }),
      key: capped.ownerKey,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
    expect(ok.body.status).toBe("live");
    const after = await siteSnapshot(capped, "keep-per-file");
    expect(after.title).toBe("New title");
    expect(after.settings).toMatchObject({ spa: false, passwordProtected: false });
    expect(after.livePasswordHash).toBeNull();
  });

  it("archiveUrl aggregate refusal keeps an existing site's password, settings and live cache", async () => {
    const capped = await freshInstance({ limits: { maxFileBytes: 100, maxSiteBytes: 10 } });
    const before = await createProtectedSite(capped, "keep-aggregate");
    // Each entry fits the per-file cap; together they exceed the site cap.
    externalFetch(() => zipResponse({ "a.txt": "123456", "b.txt": "abcdef" }));
    const refusedRes = await capped.json("/api/v1/publish", {
      ...jsonBody({ site: "keep-aggregate", title: "New title", spa: false, password: null, archiveUrl: "https://93.184.216.34/two.zip" }),
      key: capped.ownerKey,
    });
    expect(refusedRes.status, JSON.stringify(refusedRes.body)).toBe(413);
    expectApiError(refusedRes.body, ["site_too_large"]);
    expect(await siteSnapshot(capped, "keep-aggregate")).toEqual(before);
  });

  it("uploaded-ZIP per-file refusal keeps an existing site's password, settings and live cache", async () => {
    const capped = await freshInstance({ limits: { maxFileBytes: 8 } });
    const before = await createProtectedSite(capped, "keep-uploaded");
    const zip = zipSync({ "big.txt": strToU8("123456789") });
    const refusedRes = await capped.json("/api/v1/publish?slug=keep-uploaded&title=New%20title&spa=false&password=", {
      method: "POST", key: capped.ownerKey, headers: { "Content-Type": "application/zip" }, body: zip,
    });
    expect(refusedRes.status, JSON.stringify(refusedRes.body)).toBe(413);
    expectApiError(refusedRes.body, ["file_too_large"]);
    expect(await siteSnapshot(capped, "keep-uploaded")).toEqual(before);
  });
});

// Review round: extraction budgets apply to ACTUAL produced bytes, not to
// sizes declared in ZIP headers, and inconsistent accounting is refused
// before extracted entries are hashed or published. Declared-size summing
// alone admits stored entries whose real bytes exceed every budget.
describe("archive extraction enforces actual output accounting", () => {
  // Await-tolerant: a streaming extractor may make this seam asynchronous.
  async function thrown(fn: () => unknown): Promise<unknown> {
    try { await fn(); } catch (e) { return e; }
    return null;
  }

  it("extractor refuses aggregate stored output beyond budget when declared sizes lie small", async () => {
    const zip = withDeclaredUncompressedSize(zipSync({
      "a.txt": [strToU8("a".repeat(700)), { level: 0 }],
      "b.txt": [strToU8("b".repeat(700)), { level: 0 }],
    }), 10);
    const err = await thrown(() => unzipFiles(zip, 1_000));
    expect(err, "1400 actual bytes must not pass a 1000-byte budget on declared sizes alone").toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(413);
    expect((err as ApiError).code).toMatch(/too_large/);
  });

  it("extractor rejects an entry whose actual length disagrees with its declared length, even under budget", async () => {
    const zip = withDeclaredUncompressedSize(zipSync({ "a.txt": [strToU8("x".repeat(50)), { level: 0 }] }), 10);
    const err = await thrown(() => unzipFiles(zip, 10_000));
    expect(err, "declared 10 vs actual 50 must not be published as if the accounting agreed").toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toMatch(SNAKE);
    expect((err as ApiError).hint?.length).toBeGreaterThan(0);
  });

  it("extractor still accepts honest stored entries and returns exact bytes (control)", async () => {
    const zip = zipSync({ "a.txt": [strToU8("x".repeat(50)), { level: 0 }], "index.html": strToU8("hi") });
    const files = await unzipFiles(zip, 1_000);
    expect(files.map((f) => f.path).sort()).toEqual(["a.txt", "index.html"]);
    expect(new TextDecoder().decode(files.find((f) => f.path === "a.txt")!.bytes)).toBe("x".repeat(50));
    expect(new TextDecoder().decode(files.find((f) => f.path === "index.html")!.bytes)).toBe("hi");
  });

  it.each(["archiveUrl", "uploaded zip"] as const)("%s refuses a lying stored entry over the per-file cap before hashing its bytes", async (caller) => {
    const capped = await freshInstance({ limits: { maxFileBytes: 100, maxSiteBytes: 100_000, oneShotMaxBytes: 100_000 }, urlFetchMaxBytes: 100_000 });
    const zip = withDeclaredUncompressedSize(zipSync({ "big.txt": [strToU8("z".repeat(4_000)), { level: 0 }] }), 10);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let hashedEntryBytes = 0;
    vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
      if ((data as ArrayBufferView | ArrayBuffer).byteLength === 4_000) hashedEntryBytes++;
      return digest(algorithm, data as any);
    });
    externalFetch(() => zipBytesResponse(zip));
    const result = caller === "archiveUrl"
      ? await capped.json("/api/v1/publish", { ...jsonBody({ archiveUrl: "https://93.184.216.34/lying.zip" }), key: capped.ownerKey })
      : await capped.json("/api/v1/publish", { method: "POST", key: capped.ownerKey, headers: { "Content-Type": "application/zip" }, body: zip });
    expect(result.status, JSON.stringify(result.body)).toBeGreaterThanOrEqual(400);
    expectApiError(result.body);
    expect(result.body.error.code).toMatch(/too_large|invalid_zip/);
    expect(hashedEntryBytes, "actual-output refusal must happen before the refused entry is hashed").toBe(0);
    expect((await capped.json("/api/v1/sites", { key: capped.ownerKey })).body.sites).toHaveLength(0);
  });
});

// Review round: individual ZIP entries must survive extraction as entries.
// A filename-keyed plain object loses a legal "__proto__" entry entirely and
// silently overwrites exact duplicates, so neither the manifest validator
// nor the reader ever sees them.
describe("archive extraction preserves individual entries", () => {
  it.each(["archiveUrl", "uploaded zip"] as const)("%s publishes a legal __proto__ file alongside index.html with exact bytes", async (caller) => {
    const zip = await buildStoredZip([["__proto__", "proto-bytes"], ["index.html", "<p>home</p>"]]);
    externalFetch(() => zipBytesResponse(zip));
    const result = caller === "archiveUrl"
      ? await publishRest({ site: "proto-archive", archiveUrl: "https://93.184.216.34/proto.zip" })
      : await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, headers: { "Content-Type": "application/zip" }, body: zip });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    if (caller === "archiveUrl") {
      expect(result.body.status).toBe("live");
      expect(result.body.files.total).toBe(2);
    } else {
      expect((result.body.files as string[]).sort()).toEqual(["__proto__", "index.html"]);
    }
    expect(await readRaw(result.body.url, "__proto__")).toBe("proto-bytes");
    expect(await readRaw(result.body.url, "index.html")).toBe("<p>home</p>");
  });

  it.each(["archiveUrl", "uploaded zip"] as const)("%s rejects exact duplicate entry names instead of silently keeping the last one", async (caller) => {
    const zip = await buildStoredZip([["index.html", "first"], ["index.html", "second"]]);
    externalFetch(() => zipBytesResponse(zip));
    const result = caller === "archiveUrl"
      ? await publishRest({ archiveUrl: "https://93.184.216.34/dup.zip" })
      : await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, headers: { "Content-Type": "application/zip" }, body: zip });
    expect(result.status, JSON.stringify(result.body)).toBeGreaterThanOrEqual(400);
    expectApiError(result.body, ["duplicate_path", "invalid_zip"]);
    await expectNoSites();
  });

  it("rejects duplicate normalized paths before mutating an existing site", async () => {
    const inst = await freshInstance();
    const before = await createProtectedSite(inst, "keep-dup-normalized");
    const zip = await buildStoredZip([["./dup.txt", "one"], ["dup.txt", "two"]]);
    externalFetch(() => zipBytesResponse(zip));
    const result = await inst.json("/api/v1/publish", {
      ...jsonBody({ site: "keep-dup-normalized", title: "New title", spa: false, password: null, archiveUrl: "https://93.184.216.34/dupn.zip" }),
      key: inst.ownerKey,
    });
    expect(result.status, JSON.stringify(result.body)).toBeGreaterThanOrEqual(400);
    expectApiError(result.body, ["duplicate_path", "invalid_zip"]);
    expect(await siteSnapshot(inst, "keep-dup-normalized")).toEqual(before);
  });
});
