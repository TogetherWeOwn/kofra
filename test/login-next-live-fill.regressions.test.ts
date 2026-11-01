import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { dropwayClient } from "../packages/server/src/ui/client";
import { clearLiveMemoryCache, getLiveSite, liveKey, loadLiveSiteFromD1, refreshLive, type DropwayContext, type LiveSite } from "@dropway/core";
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
    return res.body as { slug: string };
  }

  it("a fill whose D1 read lost a race with a deploy does not overwrite the deploy's manifest", async () => {
    const dw = await freshInstance();
    const { slug } = await publish(dw, "live-fill-race");
    await env.CACHE.delete(liveKey(slug));
    clearLiveMemoryCache();
    const put = env.CACHE.put.bind(env.CACHE);
    let raced = false;
    await withDc(dw, async (dc) => {
      // The fill read D1 before the deploy; hold its put until the deploy has committed and refreshed KV.
      vi.spyOn(env.CACHE, "put").mockImplementation(async (key, value, opts) => {
        if (key === liveKey(slug) && !raced) {
          raced = true;
          await env.DB.prepare("UPDATE sites SET spa = 1 WHERE slug = ?").bind(slug).run();
          const fresh = await loadLiveSiteFromD1(dc, { slug });
          await refreshLive(dc, fresh!.siteId);
        }
        return put(key, value, opts);
      });
      expect((await getLiveSite(dc, slug))!.spa).toBe(false);
    });
    expect(raced).toBe(true);
    const kv = await env.CACHE.get<LiveSite>(liveKey(slug), "json");
    expect(kv === null || kv.spa === true).toBe(true);
    vi.restoreAllMocks();
    clearLiveMemoryCache();
    expect((await withDc(dw, (dc) => getLiveSite(dc, slug)))!.spa).toBe(true);
  });

  it("a fill for an unchanged site stays cached without an expiry", async () => {
    const dw = await freshInstance();
    const { slug } = await publish(dw, "live-fill-durable");
    await env.CACHE.delete(liveKey(slug));
    clearLiveMemoryCache();
    const put = vi.spyOn(env.CACHE, "put");
    const live = await withDc(dw, (dc) => getLiveSite(dc, slug));
    const fills = put.mock.calls.filter((c) => c[0] === liveKey(slug));
    expect(fills).toHaveLength(1);
    expect((fills[0]![2] as KVNamespacePutOptions | undefined)?.expirationTtl).toBeUndefined();
    const kv = await env.CACHE.get<LiveSite>(liveKey(slug), "json");
    expect(kv?.versionId).toBe(live!.versionId);
  });

  it("a fill whose D1 verification fails stays cached, capped to a short TTL", async () => {
    const dw = await freshInstance();
    const { slug } = await publish(dw, "live-fill-d1-down");
    await env.CACHE.delete(liveKey(slug));
    clearLiveMemoryCache();
    const put = env.CACHE.put.bind(env.CACHE);
    const prepare = env.DB.prepare.bind(env.DB);
    let d1Down = false;
    const puts = vi.spyOn(env.CACHE, "put").mockImplementation(async (key, value, opts) => {
      // D1 goes away right after the fill's first put, so the verification read fails.
      if (key === liveKey(slug)) d1Down = true;
      return put(key, value, opts);
    });
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (d1Down) throw new Error("D1 unavailable");
      return prepare(sql);
    });
    const live = await withDc(dw, (dc) => getLiveSite(dc, slug));
    const fills = puts.mock.calls.filter((c) => c[0] === liveKey(slug));
    vi.restoreAllMocks();
    const kv = await env.CACHE.get<LiveSite>(liveKey(slug), "json");
    expect(kv?.versionId).toBe(live!.versionId);
    expect((fills.at(-1)![2] as KVNamespacePutOptions | undefined)?.expirationTtl).toBeLessThanOrEqual(60);
  });
});
