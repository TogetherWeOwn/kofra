import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { dropwayClient } from "../packages/server/src/ui/client";
import { clearLiveMemoryCache, getLiveSite, liveKey, READ_FILL_TTL_SECONDS, refreshLive, type DropwayContext } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, jsonBody, type Instance } from "./helpers";

const ORIGIN = "https://dash.example.test";

/** Extract the shipped safeNext(n) from the dashboard script and bind it to a fake location. */
function realSafeNext(): (n: string | null) => string {
  const src = dropwayClient.toString();
  const start = src.indexOf("function safeNext(n)");
  if (start === -1) throw new Error("safeNext not found in client source");
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}" && --depth === 0) {
      // eslint-disable-next-line no-new-func
      return new Function("location", `${src.slice(start, i + 1)}; return safeNext;`)({ origin: ORIGIN });
    }
  }
  throw new Error("unbalanced braces in safeNext extraction");
}

describe("login next redirect stays on this origin", () => {
  const safeNext = realSafeNext();

  it.each(["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "//x", "/\\x", "/\t\\x", "/.//x", "https://evil.example/", "dashboard", "", null])(
    "%j falls back to /dashboard",
    (n) => {
      expect(safeNext(n)).toBe("/dashboard");
    },
  );

  it("keeps a same-origin path, query and hash", () => {
    expect(safeNext("/sites/a?x=1#h")).toBe("/sites/a?x=1#h");
    expect(safeNext("/dashboard/keys")).toBe("/dashboard/keys");
  });

  it("every accepted value resolves to this origin", () => {
    for (const n of ["/sites/a?x=1#h", "/\t/evil.example", "/.//x", "/\\x"]) {
      expect(new URL(safeNext(n), ORIGIN).origin).toBe(ORIGIN);
    }
  });
});

describe("live manifest read-path fill cannot stick", () => {
  afterEach(() => vi.restoreAllMocks());

  async function withDc<T>(dw: Instance, fn: (dc: DropwayContext) => Promise<T>): Promise<T> {
    const ctx = createExecutionContext();
    const dc = dw.dropway.context(env as unknown as ServerBindings, ctx);
    try {
      return await fn(dc);
    } finally {
      await waitOnExecutionContext(ctx);
    }
  }

  async function publish(dw: Instance, slug: string) {
    const res = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ slug, files: [{ path: "index.html", content: "<p>hi</p>" }] }) });
    expect(res.status).toBe(201);
    return res.body as { slug: string; siteId?: string; site?: { id: string } };
  }

  function livePuts(spy: { mock: { calls: unknown[][] } }, slug: string) {
    return spy.mock.calls.filter((c) => c[0] === liveKey(slug)).map((c) => (c[2] ?? {}) as KVNamespacePutOptions);
  }

  it("a KV miss refills with a short expirationTtl", async () => {
    const dw = await freshInstance();
    const { slug } = await publish(dw, "live-fill-ttl");
    await env.CACHE.delete(liveKey(slug));
    clearLiveMemoryCache();
    const put = vi.spyOn(env.CACHE, "put");
    await withDc(dw, (dc) => getLiveSite(dc, slug));
    const puts = livePuts(put, slug);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.expirationTtl).toBe(READ_FILL_TTL_SECONDS);
  });

  it("refreshLive keeps writing a long-lived entry", async () => {
    const dw = await freshInstance();
    const { slug } = await publish(dw, "live-fill-refresh");
    clearLiveMemoryCache();
    const siteId = await withDc(dw, async (dc) => (await getLiveSite(dc, slug))!.siteId);
    const put = vi.spyOn(env.CACHE, "put");
    await withDc(dw, (dc) => refreshLive(dc, siteId));
    const puts = livePuts(put, slug);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.expirationTtl).toBeUndefined();
  });
});
