import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { clearLiveMemoryCache, sha256Hex } from "@dropway/core";
import { form, freshInstance, jsonBody, type Instance } from "./helpers";

// R-14 / SRV-06. Exercise HTTP serving with real workerd D1/R2/KV/Cache API.
// Spies call through: counts measure binding I/O, not a fake cache's behavior.
// clearLiveMemoryCache models a second isolate in the SAME data center; it must
// not remove the shared Cache API entry. Local results cannot prove workers.dev
// hit rates or worldwide freshness (those need the deployment experiment).
let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});
afterEach(() => vi.restoreAllMocks());

async function publish(slug: string, files: Record<string, string>) {
  const res = await dw.json("/api/v1/publish", {
    method: "POST", key: dw.ownerKey, body: form(files, { slug }),
  });
  expect(res.status).toBeOneOf([200, 201]);
  return res.body;
}

async function read(slug: string, path = "payload.txt", headers?: HeadersInit) {
  const res = await dw.call(`/s/${slug}/${path}`, { headers });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes, text: () => new TextDecoder().decode(bytes) };
}

function observeCache() {
  // Observe the runtime prototype so caches.open() and caches.default, even
  // when represented by different JS handles, remain real and are both counted.
  const prototype = Object.getPrototypeOf(caches.default) as Cache;
  return { match: vi.spyOn(prototype, "match"), put: vi.spyOn(prototype, "put") };
}

function keyUrl(key: RequestInfo | URL): string {
  return typeof key === "string" ? key : key instanceof URL ? key.href : key.url;
}

function blobKeys(calls: Array<[RequestInfo | URL, ...unknown[]]>, hash: string) {
  return calls.map(([key]) => keyUrl(key)).filter((url) => new URL(url).pathname.includes(hash));
}

function bindingReads(calls: ReadonlyArray<readonly unknown[]>, key: string) {
  // KV.get has single-key and multi-key overloads; the observed arguments, not
  // Vitest's selection of the last overload's type, identify live-pointer reads.
  return calls.filter((call) => call[0] === key);
}

describe("R-14: immutable blob cache", () => {
  // Break caught: removing the blob cache, or doing a speculative R2 read on a hit.
  it("serves the second same-center request with no R2 get or head", async () => {
    await publish("cache-repeat", { "payload.txt": "repeatable bytes" });
    const get = vi.spyOn(env.FILES, "get");
    const head = vi.spyOn(env.FILES, "head");
    const first = await read("cache-repeat");
    expect(first.res.status).toBe(200);
    expect(first.text()).toBe("repeatable bytes");
    expect(get.mock.calls.length).toBeLessThanOrEqual(1);
    get.mockClear();
    head.mockClear();

    clearLiveMemoryCache();
    const second = await read("cache-repeat");
    expect(second.res.status).toBe(200);
    expect(second.text()).toBe("repeatable bytes");
    expect(second.res.headers.get("etag")).toBe(first.res.headers.get("etag"));
    expect(get).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
  });

  // Break caught: caching under a site/path/version instead of content hash.
  it("shares one immutable sha256 cache entry across sites and filenames", async () => {
    const content = "identical bytes on two sites";
    const hash = await sha256Hex(content);
    const cache = observeCache();
    await publish("cache-one", { "payload.txt": content });
    await publish("cache-two", { "other.txt": content });
    const get = vi.spyOn(env.FILES, "get");
    const first = await read("cache-one");
    expect(first.text()).toBe(content);
    expect(get.mock.calls.length).toBeLessThanOrEqual(1);
    const keys = blobKeys(cache.put.mock.calls, hash);
    expect(keys).toHaveLength(1);
    const stored = await caches.default.match(keys[0]!);
    expect(stored).toBeDefined();
    expect(await stored!.text()).toBe(content);
    expect(stored!.headers.get("cache-control")).toMatch(/\bimmutable\b/);

    get.mockClear();
    clearLiveMemoryCache();
    const second = await read("cache-two", "other.txt");
    expect(second.res.status).toBe(200);
    expect(second.text()).toBe(content);
    expect(get).not.toHaveBeenCalled();
    expect(blobKeys(cache.match.mock.calls, hash)).toContain(keys[0]);
    expect(blobKeys(cache.put.mock.calls, hash)).toHaveLength(1);
  });

  // Break caught: a URL-keyed byte cache returning an earlier published body.
  it("publishing new bytes cannot reuse the old content-addressed body", async () => {
    const cache = observeCache();
    await publish("cache-update", { "payload.txt": "before" });
    expect((await read("cache-update")).text()).toBe("before");
    await publish("cache-update", { "payload.txt": "after" });
    // Simulate pointer expiry without deleting the old immutable blob entry.
    // Discover the key at the cache boundary rather than pinning its hostname.
    clearLiveMemoryCache();
    for (const [key] of cache.put.mock.calls) {
      if (new URL(keyUrl(key)).pathname.endsWith("/ptr/cache-update")) await caches.default.delete(key);
    }
    const updated = await read("cache-update");
    expect(updated.res.status).toBe(200);
    expect(updated.text()).toBe("after");
  });

  // Break caught: serving a cached full response for Range, or caching a 206.
  it.each([false, true])("Range bypasses the blob cache (already warm: %s)", async (warm) => {
    const content = "0123456789abcdef";
    const hash = await sha256Hex(content);
    await publish("cache-range", { "payload.txt": content });
    if (warm) expect((await read("cache-range")).text()).toBe(content);
    const cache = observeCache();
    const get = vi.spyOn(env.FILES, "get");
    for (const [range, want, contentRange] of [
      ["bytes=2-5", "2345", "bytes 2-5/16"],
      ["bytes=10-13", "abcd", "bytes 10-13/16"],
    ]) {
      const part = await read("cache-range", "payload.txt", { Range: range! });
      expect(part.res.status).toBe(206);
      expect(part.res.headers.get("content-range")).toBe(contentRange);
      expect(part.text()).toBe(want);
    }
    expect(get).toHaveBeenCalledTimes(2);
    // Pointer lookups are allowed; only blob lookups/writes must be bypassed.
    expect(blobKeys(cache.match.mock.calls, hash)).toEqual([]);
    expect(blobKeys(cache.put.mock.calls, hash)).toEqual([]);
    expect((await read("cache-range")).text()).toBe(content);
  });

  // Break caught: feeding a >25 MB stream into Cache API or reusing it on GET.
  it("streams files above 25 MB from R2 on every request without blob-cache I/O", async () => {
    // Safely above either decimal/binary interpretation of the approximate cap.
    const bytes = new Uint8Array(26 * 1024 * 1024).fill(97);
    bytes[0] = 65;
    bytes[bytes.length - 1] = 90;
    const hash = await sha256Hex(bytes);
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "cache-large" }) });
    expect(created.status).toBe(201);
    const pending = await dw.json("/api/v1/sites/cache-large/deploys", {
      key: dw.ownerKey,
      ...jsonBody({ files: [{ path: "large.bin", sha256: hash, size: bytes.length, contentType: "application/octet-stream" }] }),
    });
    expect(pending.status).toBe(201);
    const upload = await dw.call(`/api/v1/blobs/${hash}`, {
      method: "PUT", key: dw.ownerKey, body: bytes, headers: { "Content-Length": String(bytes.length) },
    });
    expect(upload.status).toBe(201);
    await upload.text();
    const finalized = await dw.json(`/api/v1/sites/cache-large/deploys/${pending.body.deploy.id}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(finalized.status).toBe(200);

    const cache = observeCache();
    const get = vi.spyOn(env.FILES, "get");
    for (let i = 0; i < 2; i++) {
      const served = await read("cache-large", "large.bin");
      expect(served.res.status).toBe(200);
      expect(served.bytes).toHaveLength(bytes.length);
      expect(await sha256Hex(served.bytes)).toBe(hash);
    }
    expect(get).toHaveBeenCalledTimes(2);
    expect(blobKeys(cache.match.mock.calls, hash)).toEqual([]);
    expect(blobKeys(cache.put.mock.calls, hash)).toEqual([]);
  });
});

describe("R-14: 10-second Cache API pointer memo before KV", () => {
  // Break caught: retaining only an isolate-local memo, so every cold isolate hits KV.
  it("a cold isolate reuses the Cache API pointer without reading KV", async () => {
    const cache = observeCache();
    await publish("cache-pointer", { "payload.txt": "pointer bytes" });
    clearLiveMemoryCache();
    const get = vi.spyOn(env.CACHE, "get");
    expect((await read("cache-pointer")).text()).toBe("pointer bytes");
    // Publishing is allowed to prewarm the memo; at most one cold KV read.
    expect(bindingReads(get.mock.calls, "live:cache-pointer").length).toBeLessThanOrEqual(1);
    get.mockClear();
    clearLiveMemoryCache();

    const second = await read("cache-pointer");
    expect(second.res.status).toBe(200);
    expect(second.text()).toBe("pointer bytes");
    expect(bindingReads(get.mock.calls, "live:cache-pointer")).toEqual([]);
    const keys = cache.put.mock.calls.map(([key]) => keyUrl(key));
    const pointerKey = keys.find((url) => new URL(url).pathname.endsWith("/ptr/cache-pointer"));
    expect(pointerKey, "a ptr/<slug> entry must exist in the runtime Cache API").toBeDefined();
    const pointer = await caches.default.match(pointerKey!);
    expect(pointer).toBeDefined();
    expect(pointer!.headers.get("cache-control")).toMatch(/(?:^|[,\s])max-age=10(?:[,\s]|$)/);
  });

  // Break caught: a publish or restore serving the previous memo instead of the new live version.
  it("invalidates the cached pointer on publish and on restore", async () => {
    const ptr = "https://dropway.invalid/__dropway/ptr/cache-invalidate";
    const v1 = await publish("cache-invalidate", { "payload.txt": "v1" });
    // Warm the memo from a cold isolate (waitUntil fills are flushed per call).
    clearLiveMemoryCache();
    expect((await read("cache-invalidate")).text()).toBe("v1");
    expect(await caches.default.match(ptr)).toBeDefined();

    // A publish drops the memo; the next cold read serves the new bytes from KV.
    await publish("cache-invalidate", { "payload.txt": "v2" });
    expect(await caches.default.match(ptr)).toBeUndefined();
    clearLiveMemoryCache();
    expect((await read("cache-invalidate")).text()).toBe("v2");

    // A restore drops the refilled memo too; the next cold read serves the restored bytes.
    expect(await caches.default.match(ptr)).toBeDefined();
    const restored = await dw.json(`/api/v1/sites/cache-invalidate/versions/${v1.version.id}/restore`, {
      method: "POST", key: dw.ownerKey,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.restored).toBe(true);
    expect(await caches.default.match(ptr)).toBeUndefined();
    clearLiveMemoryCache();
    expect((await read("cache-invalidate")).text()).toBe("v1");
  });

  // Break caught: a persistent/long-lived pointer memo hiding KV changes.
  it("refreshes an expired Cache API pointer from KV after 10 seconds", async () => {
    await publish("cache-expiry", { "payload.txt": "expiring pointer" });
    clearLiveMemoryCache();
    expect((await read("cache-expiry")).text()).toBe("expiring pointer");
    const get = vi.spyOn(env.CACHE, "get");
    // First prove a memo hit; otherwise a system with NO pointer cache would
    // vacuously pass the expiry assertion by always reading KV.
    clearLiveMemoryCache();
    expect((await read("cache-expiry")).text()).toBe("expiring pointer");
    expect(bindingReads(get.mock.calls, "live:cache-expiry")).toEqual([]);
    // Native workerd Cache API expiry uses wall time, not Vitest's fake JS clock.
    await new Promise((resolve) => setTimeout(resolve, 11_100));
    clearLiveMemoryCache();
    expect((await read("cache-expiry")).text()).toBe("expiring pointer");
    expect(bindingReads(get.mock.calls, "live:cache-expiry")).toHaveLength(1);
  });
});
