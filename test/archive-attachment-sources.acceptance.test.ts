import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
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
    const tooMany = await capped.json("/api/v1/publish", {
      ...jsonBody({ archiveUrl: "https://93.184.216.34/two.zip" }),
      key: capped.ownerKey,
    });
    expect(tooMany.status).toBeGreaterThanOrEqual(400);
    expectApiError(tooMany.body);
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
