import { createExecutionContext, env } from "cloudflare:test";
import { clearLiveMemoryCache, getLiveSite, liveKey, type LiveSite } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { afterEach, describe, expect, it } from "vitest";
import { form, freshInstance } from "./helpers";

afterEach(() => clearLiveMemoryCache());

describe("live cache miss races", () => {
  for (const mutation of ["publish", "delete", "password"] as const) {
    it(`does not let a delayed miss overwrite a completed ${mutation}`, async () => {
      const dw = await freshInstance();
      const slug = `cache-race-${mutation}`;
      const first = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "old" }, { slug }) });
      expect(first.status).toBe(201);
      await env.CACHE.delete(liveKey(slug));
      clearLiveMemoryCache();

      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const pending: Promise<unknown>[] = [];
      const cache = new Proxy(env.CACHE, {
        get(target, prop) {
          if (prop === "put") return async (...args: Parameters<KVNamespace["put"]>) => {
            await gate;
            return target.put(...args);
          };
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const base = dw.dropway.context(env as unknown as ServerBindings, createExecutionContext());
      const dc = { ...base, env: { ...base.env, CACHE: cache }, waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
      const old = await getLiveSite(dc, slug);
      expect(old?.versionId).toBeTruthy();

      if (mutation === "publish") {
        const updated = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "new" }, { slug }) });
        expect(updated.status).toBe(200);
      } else if (mutation === "delete") {
        const deleted = await dw.json(`/api/v1/sites/${slug}`, { method: "DELETE", key: dw.ownerKey });
        expect(deleted.status).toBe(200);
      } else {
        const locked = await dw.json(`/api/v1/sites/${slug}`, {
          method: "PATCH", key: dw.ownerKey, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "now-protected" }),
        });
        expect(locked.status).toBe(200);
      }
      release();
      await Promise.all(pending);
      clearLiveMemoryCache();
      const page = await dw.call(`/s/${slug}/?raw=1`);
      expect(page.status).toBe(mutation === "publish" ? 200 : mutation === "delete" ? 404 : 401);
      if (mutation === "publish") expect(await page.text()).toBe("new");
    });
  }

  for (const [mutation, status] of [["publish", 200], ["delete", 404], ["password", 401]] as const) {
    it(`does not restore stale memory or KV when a D1 snapshot finishes after ${mutation}`, async () => {
      const dw = await freshInstance();
      const slug = `cache-d1-${mutation}`;
      const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "old" }, { slug }) });
      expect(published.status).toBe(201);
      await env.CACHE.delete(liveKey(slug));
      clearLiveMemoryCache();

      let release!: () => void;
      let captured!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const snapshotRead = new Promise<void>((resolve) => { captured = resolve; });
      // Delay the real file-query result, not KV: the stale put would be invoked
      // only after deletion has completed, without relying on KV write reordering.
      const db = new Proxy(env.DB, {
        get(target, prop) {
          if (prop === "prepare") return (query: string) => {
            const statement = target.prepare(query);
            if (!query.startsWith("SELECT path, sha256, size, content_type FROM version_files")) return statement;
            return new Proxy(statement, {
              get(target, prop) {
                if (prop === "bind") return (...args: unknown[]) => {
                  const bound = target.bind(...args);
                  return new Proxy(bound, {
                    get(target, prop) {
                      if (prop === "all") return async () => {
                        const result = await target.all();
                        captured();
                        await gate;
                        return result;
                      };
                      const value = Reflect.get(target, prop, target);
                      return typeof value === "function" ? value.bind(target) : value;
                    },
                  });
                };
                const value = Reflect.get(target, prop, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          };
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const pending: Promise<unknown>[] = [];
      const base = dw.dropway.context(env as unknown as ServerBindings, createExecutionContext());
      const dc = { ...base, env: { ...base.env, DB: db }, waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
      const read = getLiveSite(dc, slug);
      try {
        await snapshotRead;
        if (mutation === "publish") {
          const updated = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "new" }, { slug }) });
          expect(updated.status).toBe(200);
        } else if (mutation === "delete") {
          const deleted = await dw.json(`/api/v1/sites/${slug}`, { method: "DELETE", key: dw.ownerKey });
          expect(deleted.status).toBe(200);
        } else {
          const locked = await dw.json(`/api/v1/sites/${slug}`, {
            method: "PATCH", key: dw.ownerKey, headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: "now-protected" }),
          });
          expect(locked.status).toBe(200);
        }
      } finally {
        release();
      }
      await read;
      await Promise.all(pending);
      // Do not clear memory first: an old D1 read must not replace the memory
      // state established by the completed mutation, even for the normal TTL.
      const page = await dw.call(`/s/${slug}/?raw=1`);
      expect(page.status).toBe(status);
      if (mutation === "publish") expect(await page.text()).toBe("new");
      clearLiveMemoryCache();
      const uncached = await dw.call(`/s/${slug}/?raw=1`);
      expect(uncached.status).toBe(status);
      if (mutation === "publish") expect(await uncached.text()).toBe("new");
    });
  }

  it("never writes an unprotected fill to KV when a password is set during the miss's D1 read", async () => {
    const dw = await freshInstance();
    const slug = "cache-fill-password";
    const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "private" }, { slug }) });
    expect(published.status).toBe(201);
    await env.CACHE.delete(liveKey(slug));
    clearLiveMemoryCache();

    let release!: () => void;
    let captured!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshotRead = new Promise<void>((resolve) => { captured = resolve; });
    // Hold the miss's file query after the site row (still unprotected) was read.
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (query: string) => {
          const statement = target.prepare(query);
          if (!query.startsWith("SELECT path, sha256, size, content_type FROM version_files")) return statement;
          return new Proxy(statement, {
            get(target, prop) {
              if (prop === "bind") return (...args: unknown[]) => {
                const bound = target.bind(...args);
                return new Proxy(bound, {
                  get(target, prop) {
                    if (prop === "all") return async () => {
                      const result = await target.all();
                      captured();
                      await gate;
                      return result;
                    };
                    const value = Reflect.get(target, prop, target);
                    return typeof value === "function" ? value.bind(target) : value;
                  },
                });
              };
              const value = Reflect.get(target, prop, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const unprotectedPuts: string[] = [];
    const cache = new Proxy(env.CACHE, {
      get(target, prop) {
        if (prop === "put") return async (...args: Parameters<KVNamespace["put"]>) => {
          if (args[0] === liveKey(slug) && JSON.parse(args[1] as string).passwordHash === null) unprotectedPuts.push(args[0]);
          return target.put(...args);
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const pending: Promise<unknown>[] = [];
    const base = dw.dropway.context(env as unknown as ServerBindings, createExecutionContext());
    const read = getLiveSite({ ...base, env: { ...base.env, DB: db, CACHE: cache }, waitUntil: (p: Promise<unknown>) => { pending.push(p); } }, slug);
    try {
      await snapshotRead;
      const locked = await dw.json(`/api/v1/sites/${slug}`, {
        method: "PATCH", key: dw.ownerKey, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "now-protected" }),
      });
      expect(locked.status).toBe(200);
    } finally {
      release();
    }
    expect((await read)?.passwordHash).toBeNull();
    await Promise.all(pending);
    expect(unprotectedPuts).toEqual([]);
    expect((await dw.call(`/s/${slug}/?raw=1`)).status).toBe(401);
  });

  it("does not restore unprotected memory from a delayed KV hit after a password change", async () => {
    const dw = await freshInstance();
    const slug = "cache-kv-read-race";
    const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "private" }, { slug }) });
    expect(published.status).toBe(201);
    clearLiveMemoryCache();

    let release!: () => void;
    let captured!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const snapshotRead = new Promise<void>((resolve) => { captured = resolve; });
    const cache = new Proxy(env.CACHE, {
      get(target, prop) {
        if (prop === "get") return async (...args: Parameters<KVNamespace["get"]>) => {
          const value = await target.get(...args);
          captured();
          await gate;
          return value;
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const base = dw.dropway.context(env as unknown as ServerBindings, createExecutionContext());
    const read = getLiveSite({ ...base, env: { ...base.env, CACHE: cache } }, slug);
    try {
      await snapshotRead;
      const locked = await dw.json(`/api/v1/sites/${slug}`, {
        method: "PATCH", key: dw.ownerKey, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "now-protected" }),
      });
      expect(locked.status).toBe(200);
    } finally {
      release();
    }
    await read;
    expect((await dw.call(`/s/${slug}/?raw=1`)).status).toBe(401);
  });

  it("ignores an old-format manifest that may have been poisoned before upgrade", async () => {
    const dw = await freshInstance();
    const slug = "cache-upgrade";
    const first = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "old" }, { slug }) });
    expect(first.status).toBe(201);
    const stale = JSON.parse((await env.CACHE.get(liveKey(slug)))!);
    stale.v = 4;
    const next = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "new" }, { slug }) });
    expect(next.status).toBe(200);
    await env.CACHE.put(liveKey(slug), JSON.stringify(stale));
    clearLiveMemoryCache();
    const page = await dw.call(`/s/${slug}/?raw=1`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("new");
  });

  it("does not cache an empty file map when the selected version is deleted mid-read", async () => {
    const dw = await freshInstance();
    const slug = "cache-files-deleted";
    const v1 = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "one" }, { slug }) });
    expect(v1.status).toBe(201);
    const v2 = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "two" }, { slug }) });
    expect(v2.status).toBe(200);
    await env.CACHE.delete(liveKey(slug));
    clearLiveMemoryCache();

    let release!: () => void;
    let captured!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const siteRead = new Promise<void>((resolve) => { captured = resolve; });
    // Hold the file query until after the read selected v2 as current: it then
    // runs after v2 was rolled back and deleted, and returns no rows.
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (query: string) => {
          const statement = target.prepare(query);
          if (!query.startsWith("SELECT path, sha256, size, content_type FROM version_files")) return statement;
          return new Proxy(statement, {
            get(target, prop) {
              if (prop === "bind") return (...args: unknown[]) => {
                const bound = target.bind(...args);
                return new Proxy(bound, {
                  get(target, prop) {
                    if (prop === "all") return async () => {
                      captured();
                      await gate;
                      return target.all();
                    };
                    const value = Reflect.get(target, prop, target);
                    return typeof value === "function" ? value.bind(target) : value;
                  },
                });
              };
              const value = Reflect.get(target, prop, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const pending: Promise<unknown>[] = [];
    const base = dw.dropway.context(env as unknown as ServerBindings, createExecutionContext());
    const read = getLiveSite({ ...base, env: { ...base.env, DB: db }, waitUntil: (p: Promise<unknown>) => { pending.push(p); } }, slug);
    try {
      await siteRead;
      const restored = await dw.json(`/api/v1/sites/${slug}/versions/${v1.body.version.id}/restore`, { method: "POST", key: dw.ownerKey });
      expect(restored.status).toBe(200);
      const deleted = await dw.json(`/api/v1/sites/${slug}/versions/${v2.body.version.id}`, {
        method: "DELETE", key: dw.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: slug }),
      });
      expect(deleted.status).toBe(200);
    } finally {
      release();
    }
    const stale = await read;
    await Promise.all(pending);
    expect(stale?.versionId).toBe(v2.body.version.id);
    // The fill of {v2, no files} was verified against D1 and dropped; KV holds nothing or v1.
    const kv = await env.CACHE.get<LiveSite>(liveKey(slug), "json");
    expect(kv === null || kv.versionId === v1.body.version.id).toBe(true);
    const page = await dw.call(`/s/${slug}/?raw=1`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("one");
  });
});
