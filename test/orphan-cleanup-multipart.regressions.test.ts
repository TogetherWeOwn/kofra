import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@dropway/core";
import { cleanupBlobs } from "../packages/core/src/services/blob-cleanup";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, type Instance } from "./helpers";
import { accepted, complete, DAY, finalize, pending, putPart, session } from "./resumable-upload.helpers";

// Multipart completion promotes verified bytes through the same generation
// fence as PUT /api/v1/blobs: a fresh blobs/<sha256>/<uuid> key, attached only
// while its D1 reservation exists. A cleaner holding a stale snapshot of the
// same hash must never delete what a multipart completion just promoted.

const bytes = new TextEncoder().encode("multipart generation fence bytes");
afterEach(() => vi.restoreAllMocks());

async function storedKey(sha: string) {
  return (await env.DB.prepare("SELECT storage_key FROM blobs WHERE sha256 = ?").bind(sha).first<{ storage_key: string | null }>())?.storage_key;
}

function context(dw: Instance, files: R2Bucket = env.FILES) {
  return dw.dropway.context({ ...env, FILES: files } as unknown as ServerBindings, createExecutionContext());
}

async function served(dw: Instance, site: string) {
  const res = await dw.call(`/s/${site}/data.bin?raw=1`);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

describe("multipart completion and orphan cleanup", () => {
  it.each([true, false])("keeps bytes a multipart upload promotes while a cleaner retires the old object (legacy=%s)", async (legacy) => {
    const dw = await freshInstance({ multiTenant: true });
    const sha = await sha256Hex(bytes);
    const oldKey = `blobs/${sha}${legacy ? "" : `/${crypto.randomUUID()}`}`;
    await env.FILES.put(oldKey, bytes);
    await env.DB.prepare("INSERT INTO blobs (sha256, size, created_at, storage_key) VALUES (?, ?, ?, ?)")
      .bind(sha, bytes.length, Date.now() - 2 * DAY, legacy ? null : oldKey).run();

    let site = "";
    const files = new Proxy(env.FILES, {
      get(target, prop) {
        // The cleaner has retired the row; a whole multipart publish lands
        // before its R2 delete of the snapshot's key.
        if (prop === "delete") return async (key: string | string[]) => {
          if (key === oldKey && !site) {
            const p = await pending(dw, sha, bytes.length, "multipart-orphan-race");
            const s = await session(dw, p);
            accepted(await putPart(dw, s, 1, bytes, p.token));
            accepted(await complete(dw, s, p.token));
            accepted(await finalize(dw, p));
            site = p.site;
          }
          return target.delete(key);
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await cleanupBlobs(context(dw, files), Date.now())).toBe(1);
    expect(site).not.toBe("");
    const current = await storedKey(sha);
    expect(current).toMatch(new RegExp(`^blobs/${sha}/[0-9a-f-]{36}$`));
    expect(current).not.toBe(oldKey);
    expect(await env.FILES.head(oldKey)).toBeNull();
    expect(await served(dw, site)).toEqual(bytes);
  });

  it("refuses to attach a slow completion whose reservation cleanup retired, and a retry recovers", async () => {
    const dw = await freshInstance({ multiTenant: true });
    const p = await pending(dw, await sha256Hex(bytes), bytes.length, "multipart-slow-writer");
    const s = await session(dw, p);
    accepted(await putPart(dw, s, 1, bytes, p.token));

    // Hold the first promotion until cleanup, a day later, has retired its reservation.
    const put = env.FILES.put.bind(env.FILES);
    let release!: () => void;
    const released = new Promise<void>((done) => { release = done; });
    let entered!: () => void;
    const reached = new Promise<void>((done) => { entered = done; });
    let held = false;
    vi.spyOn(env.FILES, "put").mockImplementation((async (key: string, value: unknown, options?: unknown) => {
      if (key.startsWith("blobs/") && !held) {
        held = true;
        entered();
        await released;
      }
      return put(key, value as never, options as never);
    }) as never);
    const completing = complete(dw, s, p.token);
    await reached;
    const [promoting] = (await env.DB.prepare("SELECT storage_key FROM blob_uploads").all<{ storage_key: string }>()).results;
    expect(promoting?.storage_key).toMatch(new RegExp(`^blobs/${p.sha256}/`));
    await cleanupBlobs(context(dw), Date.now() + 2 * DAY);
    expect((await env.DB.prepare("SELECT * FROM blob_uploads").all()).results).toEqual([]);
    release();
    const refused = await completing;
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("missing_blobs");
    expect(await storedKey(p.sha256)).toBeUndefined();
    vi.restoreAllMocks();

    // Staging was kept, so completing again promotes a fresh generation.
    accepted(await complete(dw, s, p.token));
    const current = await storedKey(p.sha256);
    expect(current).toMatch(new RegExp(`^blobs/${p.sha256}/`));
    expect(current).not.toBe(promoting!.storage_key);
    accepted(await finalize(dw, p));
    expect(await served(dw, p.site)).toEqual(bytes);
  });

  it("keeps a zero-byte completion open when cleanup retired its reservation, so a retry proves scope", async () => {
    const dw = await freshInstance({ multiTenant: true });
    const empty = new Uint8Array(0);
    const p = await pending(dw, await sha256Hex(empty), 0, "multipart-empty-slow-writer");
    const s = await session(dw, p);

    const put = env.FILES.put.bind(env.FILES);
    let release!: () => void;
    const released = new Promise<void>((done) => { release = done; });
    let entered!: () => void;
    const reached = new Promise<void>((done) => { entered = done; });
    let held = false;
    vi.spyOn(env.FILES, "put").mockImplementation((async (key: string, value: unknown, options?: unknown) => {
      if (key.startsWith("blobs/") && !held) {
        held = true;
        entered();
        await released;
      }
      return put(key, value as never, options as never);
    }) as never);
    const completing = complete(dw, s, p.token);
    await reached;
    await cleanupBlobs(context(dw), Date.now() + 2 * DAY);
    expect((await env.DB.prepare("SELECT * FROM blob_uploads").all()).results).toEqual([]);
    release();
    const refused = await completing;
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("missing_blobs");
    expect(await storedKey(p.sha256)).toBeUndefined();
    const row = await env.DB.prepare("SELECT status FROM upload_sessions WHERE id = ?").bind(s.id).first<{ status: string }>();
    expect(row?.status).toBe("completing");
    vi.restoreAllMocks();

    accepted(await complete(dw, s, p.token));
    expect(await storedKey(p.sha256)).toMatch(new RegExp(`^blobs/${p.sha256}/`));
    const scopes = await env.DB.prepare("SELECT scope FROM blob_scopes WHERE sha256 = ?").bind(p.sha256).all();
    expect(scopes.results).toHaveLength(1);
    accepted(await finalize(dw, p));
    expect(await served(dw, p.site)).toEqual(empty);
  });
});
