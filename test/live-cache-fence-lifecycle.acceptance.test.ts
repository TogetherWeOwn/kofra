import { createExecutionContext, env } from "cloudflare:test";
import { clearLiveMemoryCache, getLiveReadFenceCountForTests, getLiveSite, liveKey } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { afterEach, describe, expect, it } from "vitest";
import { form, freshInstance, type Instance } from "./helpers";

/**
 * Acceptance contract for the live-read fence lifetime.
 *
 * `getLiveReadFenceCountForTests()` is a read-only test helper exported from
 * `@dropway/core`. It must return the number of distinct slugs that currently
 * hold a live-read fence (at least one in-flight `getLiveSite` read). Two
 * overlapping readers of the same slug share one fence, so they count once;
 * readers of different slugs count independently.
 *
 * Every count assertion below runs with NO intervening mutation and NO
 * `clearLiveMemoryCache()` between the read settling and the assertion, so a
 * build that drops the ordinary finally cleanup leaves the count above zero
 * and fails here. (The afterEach clear is only inter-test cleanup, after all
 * assertions in a test have run.)
 */

afterEach(() => clearLiveMemoryCache());

async function publish(dw: Instance, slug: string, body = "hello") {
  const res = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": body }, { slug }) });
  expect(res.status).toBe(201);
}

function baseContext(dw: Instance) {
  return dw.dropway.context(env as unknown as ServerBindings, createExecutionContext());
}

/** A CACHE proxy whose get() calls each block on their own gate, in entry order. */
function gatedCache() {
  const releases: Array<() => void> = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  let entered = 0;
  const cache = new Proxy(env.CACHE, {
    get(target, prop) {
      if (prop === "get") return async (...args: Parameters<KVNamespace["get"]>) => {
        const value = await target.get(...args);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        releases.push(release);
        entered++;
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.n <= entered) waiters.splice(i, 1)[0]!.resolve();
        }
        await gate;
        return value;
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    cache,
    async waitForEntered(n: number) {
      if (entered < n) await new Promise<void>((resolve) => { waiters.push({ n, resolve }); });
    },
    release(index: number) { releases[index]?.(); },
    releaseAll() { for (const release of releases) release(); },
  };
}

/** A DB proxy that rejects every read, so getLiveSite itself rejects. */
function failingDb() {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return () => { throw new Error("d1 unavailable (acceptance test)"); };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A CACHE proxy that always misses, forcing the D1 path. */
function missingCache() {
  return new Proxy(env.CACHE, {
    get(target, prop) {
      if (prop === "get") return async () => null;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("live read fence lifecycle", () => {
  it("releases the fence after a successful KV-hit read settles", async () => {
    const dw = await freshInstance();
    const slug = "fence-hit";
    await publish(dw, slug);
    clearLiveMemoryCache();
    expect(getLiveReadFenceCountForTests()).toBe(0);

    const gated = gatedCache();
    const base = baseContext(dw);
    const read = getLiveSite({ ...base, env: { ...base.env, CACHE: gated.cache } }, slug);
    try {
      await gated.waitForEntered(1);
      expect(getLiveReadFenceCountForTests()).toBe(1);
      gated.release(0);
      const live = await read;
      expect(live?.slug).toBe(slug);
      // No mutation, no clear: ordinary completion alone must release it.
      expect(getLiveReadFenceCountForTests()).toBe(0);
    } finally {
      gated.releaseAll();
    }
  });

  it("releases the fence after a successful D1 miss read settles", async () => {
    const dw = await freshInstance();
    const slug = "fence-miss";
    await publish(dw, slug);
    await env.CACHE.delete(liveKey(slug));
    clearLiveMemoryCache();
    expect(getLiveReadFenceCountForTests()).toBe(0);

    const live = await getLiveSite(baseContext(dw), slug);
    expect(live?.slug).toBe(slug);
    expect(getLiveReadFenceCountForTests()).toBe(0);
  });

  it("releases the fence after a read of an unknown slug settles", async () => {
    const dw = await freshInstance();
    clearLiveMemoryCache();
    expect(getLiveReadFenceCountForTests()).toBe(0);

    const live = await getLiveSite(baseContext(dw), "fence-no-such-site");
    expect(live).toBeNull();
    expect(getLiveReadFenceCountForTests()).toBe(0);
  });

  it("releases the fence after a rejected read settles", async () => {
    const dw = await freshInstance();
    const slug = "fence-rejected";
    await publish(dw, slug);
    await env.CACHE.delete(liveKey(slug));
    clearLiveMemoryCache();
    expect(getLiveReadFenceCountForTests()).toBe(0);

    const base = baseContext(dw);
    const read = getLiveSite({ ...base, env: { ...base.env, DB: failingDb() } }, slug);
    await expect(read).rejects.toThrow("d1 unavailable (acceptance test)");
    expect(getLiveReadFenceCountForTests()).toBe(0);
  });

  for (const order of ["first-started finishes first", "second-started finishes first"] as const) {
    it(`keeps one shared fence for two overlapping same-slug readers until the last settles (${order})`, async () => {
      const dw = await freshInstance();
      const slug = order === "first-started finishes first" ? "fence-pair-fifo" : "fence-pair-lifo";
      await publish(dw, slug);
      clearLiveMemoryCache();
      expect(getLiveReadFenceCountForTests()).toBe(0);

      const gated = gatedCache();
      const base = baseContext(dw);
      const dc = { ...base, env: { ...base.env, CACHE: gated.cache } };
      const first = getLiveSite(dc, slug);
      try {
        await gated.waitForEntered(1);
        const second = getLiveSite(dc, slug);
        await gated.waitForEntered(2);
        // Two outstanding readers of one slug hold a single fence.
        expect(getLiveReadFenceCountForTests()).toBe(1);

        const [earlyGate, earlyRead, lateGate, lateRead] =
          order === "first-started finishes first" ? [0, first, 1, second] as const : [1, second, 0, first] as const;
        gated.release(earlyGate);
        expect((await earlyRead)?.slug).toBe(slug);
        // One reader of this slug is still outstanding: fence must remain.
        expect(getLiveReadFenceCountForTests()).toBe(1);

        gated.release(lateGate);
        expect((await lateRead)?.slug).toBe(slug);
        expect(getLiveReadFenceCountForTests()).toBe(0);
      } finally {
        gated.releaseAll();
        await first.catch(() => null);
      }
    });
  }

  it("keeps the fence when one overlapping same-slug reader rejects while another remains", async () => {
    const dw = await freshInstance();
    const slug = "fence-pair-reject";
    await publish(dw, slug);
    clearLiveMemoryCache();
    expect(getLiveReadFenceCountForTests()).toBe(0);

    const gated = gatedCache();
    const base = baseContext(dw);
    const survivor = getLiveSite({ ...base, env: { ...base.env, CACHE: gated.cache } }, slug);
    try {
      await gated.waitForEntered(1);
      expect(getLiveReadFenceCountForTests()).toBe(1);

      const rejected = getLiveSite({ ...base, env: { ...base.env, CACHE: missingCache(), DB: failingDb() } }, slug);
      await expect(rejected).rejects.toThrow("d1 unavailable (acceptance test)");
      // The rejecting reader settled, but the survivor still holds the fence.
      expect(getLiveReadFenceCountForTests()).toBe(1);

      gated.release(0);
      expect((await survivor)?.slug).toBe(slug);
      expect(getLiveReadFenceCountForTests()).toBe(0);
    } finally {
      gated.releaseAll();
      await survivor.catch(() => null);
    }
  });

  it("counts fences for different slugs independently", async () => {
    const dw = await freshInstance();
    await publish(dw, "fence-slug-a", "a");
    await publish(dw, "fence-slug-b", "b");
    clearLiveMemoryCache();
    expect(getLiveReadFenceCountForTests()).toBe(0);

    const gated = gatedCache();
    const base = baseContext(dw);
    const dc = { ...base, env: { ...base.env, CACHE: gated.cache } };
    const readA = getLiveSite(dc, "fence-slug-a");
    try {
      await gated.waitForEntered(1);
      const readB = getLiveSite(dc, "fence-slug-b");
      await gated.waitForEntered(2);
      expect(getLiveReadFenceCountForTests()).toBe(2);

      gated.release(0);
      expect((await readA)?.slug).toBe("fence-slug-a");
      expect(getLiveReadFenceCountForTests()).toBe(1);

      gated.release(1);
      expect((await readB)?.slug).toBe("fence-slug-b");
      expect(getLiveReadFenceCountForTests()).toBe(0);
    } finally {
      gated.releaseAll();
      await readA.catch(() => null);
    }
  });
});
