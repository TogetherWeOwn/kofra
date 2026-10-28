import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { putVerifiedBlob, readBlobRange, runCleanup } from "@dropway/core";
import { cleanupBlobs } from "../packages/core/src/services/blob-cleanup";
import type { ServerBindings } from "@dropway/server";
import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody, manifestEntry, type Instance } from "./helpers";

const DAY = 86_400_000;

async function storedKey(sha: string) {
  return (await env.DB.prepare("SELECT storage_key FROM blobs WHERE sha256 = ?").bind(sha).first<{ storage_key: string }>())?.storage_key;
}

function context(dw: Instance, files = env.FILES) {
  return dw.dropway.context({ ...env, FILES: files } as unknown as ServerBindings, createExecutionContext());
}

// Keep real R2 pagination/bytes, but make its upload timestamps old enough to sweep.
function oldInventory(limit = 100) {
  return new Proxy(env.FILES, {
    get(target, prop) {
      if (prop === "list") return async (options: R2ListOptions) => {
        const page = await target.list({ ...options, limit });
        return { ...page, objects: page.objects.map((object) => ({ ...object, uploaded: new Date(Date.now() - 2 * DAY) })) };
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("orphan cleanup and concurrent publication", () => {
  it.each([
    { legacy: true, finalizeBeforeDelete: true },
    { legacy: true, finalizeBeforeDelete: false },
    { legacy: false, finalizeBeforeDelete: true },
    { legacy: false, finalizeBeforeDelete: false },
  ])("keeps republished bytes (legacy=$legacy, finalizeBeforeDelete=$finalizeBeforeDelete)", async ({ legacy, finalizeBeforeDelete }) => {
    const dw = await freshInstance();
    const file = await manifestEntry("index.html", "<p>freshly republished</p>");
    const oldKey = `blobs/${file.sha256}${legacy ? "" : `/${crypto.randomUUID()}`}`;
    await env.FILES.put(oldKey, file.bytes);
    await env.DB.prepare("INSERT INTO blobs (sha256, size, created_at, storage_key) VALUES (?, ?, ?, ?)")
      .bind(file.sha256, file.size, Date.now() - 2 * DAY, legacy ? null : oldKey).run();
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "orphan-race" }) })).status).toBe(201);
    let deployId = "";
    let injected = false;
    const finalize = () => dw.json(`/api/v1/sites/orphan-race/deploys/${deployId}/finalize`, { method: "POST", key: dw.ownerKey });
    const files = new Proxy(env.FILES, {
      get(target, prop) {
        if (prop === "delete") return async (key: string) => {
          if (key === oldKey && !injected) {
            injected = true;
            const { bytes: _bytes, ...entry } = file;
            const deploy = await dw.json("/api/v1/sites/orphan-race/deploys", { key: dw.ownerKey, ...jsonBody({ files: [entry] }) });
            expect(deploy.status).toBe(201);
            deployId = deploy.body.deploy.id;
            const uploaded = await dw.json(`/api/v1/blobs/${file.sha256}`, { method: "PUT", key: dw.ownerKey, body: file.bytes, headers: { "Content-Length": String(file.size) } });
            expect(uploaded.status).toBe(201);
            if (finalizeBeforeDelete) expect((await finalize()).status).toBe(200);
          }
          return target.delete(key);
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ctx = createExecutionContext();
    await runCleanup(dw.dropway.context({ ...env, FILES: files } as unknown as ServerBindings, ctx));
    await waitOnExecutionContext(ctx);
    expect(injected).toBe(true);
    if (!finalizeBeforeDelete) expect((await finalize()).status).toBe(200);
    const response = await dw.call("/s/orphan-race/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>freshly republished</p>");
    expect(await env.FILES.head(oldKey)).toBeNull();
    const current = await storedKey(file.sha256);
    expect(current).not.toBe(oldKey);
    expect(await (await env.FILES.get(current!))!.text()).toBe("<p>freshly republished</p>");
  });
});

describe("generation fencing and garbage collection recovery", () => {
  it("keeps legacy bytes when a manifest already references them", async () => {
    const dw = await freshInstance();
    const file = await manifestEntry("index.html", "legacy bytes");
    const key = `blobs/${file.sha256}`;
    await env.FILES.put(key, file.bytes);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO blobs (sha256, size, created_at) VALUES (?, ?, ?)").bind(file.sha256, file.size, Date.now() - 2 * DAY),
      env.DB.prepare("INSERT INTO blob_scopes (scope, sha256, created_at) SELECT 't:' || id, ?, ? FROM tenants").bind(file.sha256, Date.now()),
    ]);
    const { bytes: _bytes, ...entry } = file;
    const deploy = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "legacy-retained", files: [entry] }) });
    expect(deploy.status).toBe(201);
    expect(deploy.body.deploy.missing).toEqual([]);
    await cleanupBlobs(context(dw, oldInventory()), Date.now());
    expect((await dw.json(`/api/v1/sites/legacy-retained/deploys/${deploy.body.deploy.deploy.id}/finalize`, { method: "POST", key: dw.ownerKey })).status).toBe(200);
    const delivered = await dw.call("/s/legacy-retained/");
    expect(delivered.status).toBe(200);
    expect(await delivered.text()).toBe("legacy bytes");
  });

  it("deduplicates concurrent verified writers without dropping either scope's proof", async () => {
    const dw = await freshInstance();
    const file = await manifestEntry("a.txt", "concurrent proof");
    // Both physical writes complete before either attaches its metadata.
    let writes = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const files = new Proxy(env.FILES, {
      get(target, prop) {
        if (prop === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
          const result = await target.put(...args);
          if (++writes === 2) release();
          await ready;
          return result;
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await Promise.all(["t:first", "t:second"].map((scope) => putVerifiedBlob(context(dw, files), scope, file.sha256, file.bytes, file.size, null)));
    const key = await storedKey(file.sha256);
    expect(key).toMatch(new RegExp(`^blobs/${file.sha256}/`));
    expect((await env.FILES.list({ prefix: `blobs/${file.sha256}` })).objects.map((o) => o.key)).toEqual([key]);
    expect(await (await env.FILES.get(key!))!.text()).toBe("concurrent proof");
    expect((await env.DB.prepare("SELECT scope FROM blob_scopes ORDER BY scope").all()).results).toEqual([{ scope: "t:first" }, { scope: "t:second" }]);
    expect((await env.DB.prepare("SELECT * FROM blob_uploads").all()).results).toEqual([]);
  });

  it("fences an upload paused after R2.put when GC retires its reservation", async () => {
    const dw = await freshInstance();
    const file = await manifestEntry("a.txt", "late writer");
    const files = new Proxy(env.FILES, {
      get(target, prop) {
        if (prop === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
          const result = await target.put(...args);
          await env.DB.prepare("UPDATE blob_uploads SET created_at = ?").bind(Date.now() - 2 * DAY).run();
          await cleanupBlobs(context(dw, oldInventory()), Date.now());
          return result;
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(putVerifiedBlob(context(dw, files), "t:writer", file.sha256, file.bytes, file.size, null)).rejects.toMatchObject({ code: "missing_blobs", status: 409 });
    expect((await env.DB.prepare("SELECT * FROM blobs").all()).results).toEqual([]);
    expect((await env.DB.prepare("SELECT * FROM blob_scopes").all()).results).toEqual([]);
    expect((await env.FILES.list()).objects).toEqual([]);
    await putVerifiedBlob(context(dw), "t:writer", file.sha256, file.bytes, file.size, null);
    expect(await (await env.FILES.get((await storedKey(file.sha256))!))!.text()).toBe("late writer");
  });

  it("recovers bytes written after their reservation was already retired", async () => {
    const dw = await freshInstance();
    const file = await manifestEntry("a.txt", "crashed late writer");
    const key = `blobs/${file.sha256}/${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO blob_uploads (storage_key, created_at) VALUES (?, ?)").bind(key, Date.now() - 2 * DAY).run();
    await cleanupBlobs(context(dw), Date.now());
    expect((await env.DB.prepare("SELECT * FROM blob_uploads").all()).results).toEqual([]);
    // The writer finishes R2.put, then crashes before attempting D1 attachment.
    await env.FILES.put(key, file.bytes);
    await cleanupBlobs(context(dw, oldInventory()), Date.now());
    expect(await env.FILES.head(key)).toBeNull();
  });

  it("retries a failed old-generation deletion without harming its replacement", async () => {
    const dw = await freshInstance();
    const file = await manifestEntry("a.txt", "retry delete");
    await putVerifiedBlob(context(dw), "t:writer", file.sha256, file.bytes, file.size, null);
    const oldKey = (await storedKey(file.sha256))!;
    await env.DB.prepare("UPDATE blobs SET created_at = ?").bind(Date.now() - 2 * DAY).run();
    const files = new Proxy(env.FILES, {
      get(target, prop) {
        if (prop === "delete") return async () => { throw new Error("transient R2 delete failure"); };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(cleanupBlobs(context(dw, files), Date.now())).rejects.toThrow("transient R2 delete failure");
    expect(await env.DB.prepare("SELECT * FROM blobs").first()).toBeNull();
    expect(await env.FILES.head(oldKey)).not.toBeNull();
    await putVerifiedBlob(context(dw), "t:writer", file.sha256, file.bytes, file.size, null);
    const newKey = (await storedKey(file.sha256))!;
    expect(newKey).not.toBe(oldKey);
    await cleanupBlobs(context(dw, oldInventory()), Date.now());
    expect(await env.FILES.head(oldKey)).toBeNull();
    expect(await (await env.FILES.get(newKey))!.text()).toBe("retry delete");
  });

  it("advances its bounded inventory cursor beyond retained objects", async () => {
    const dw = await freshInstance();
    const a = "0".repeat(64), b = "1".repeat(64), c = "2".repeat(64);
    for (const sha of [a, b, c]) await env.FILES.put(`blobs/${sha}`, "fixture");
    for (const sha of [a, b]) {
      // Recent metadata must survive even if R2's object is old.
      await env.DB.prepare("INSERT INTO blobs (sha256, size, created_at) VALUES (?, 7, ?)").bind(sha, Date.now()).run();
    }
    await cleanupBlobs(context(dw, oldInventory(2)), Date.now());
    expect((await env.DB.prepare("SELECT cursor FROM blob_gc_cursor").first<{ cursor: string }>())?.cursor).toEqual(expect.any(String));
    expect(await env.FILES.head(`blobs/${c}`)).not.toBeNull();
    await cleanupBlobs(context(dw, oldInventory(2)), Date.now());
    expect(await env.FILES.head(`blobs/${c}`)).toBeNull();
    expect(await env.FILES.head(`blobs/${a}`)).not.toBeNull();
    expect(await env.FILES.head(`blobs/${b}`)).not.toBeNull();
    expect((await env.DB.prepare("SELECT cursor FROM blob_gc_cursor").first<{ cursor: string | null }>())?.cursor).toBeNull();
  });
});

describe("generation migration and stale snapshots", () => {
  it("preserves existing verified bytes and scope proofs through the additive migration", async () => {
    const dw = await freshInstance();
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => !/^0007/.test(m.name)));
    const file = await manifestEntry("legacy.txt", "legacy migration bytes");
    await env.FILES.put(`blobs/${file.sha256}`, file.bytes);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO blobs (sha256, size, created_at) VALUES (?, ?, 123)").bind(file.sha256, file.size),
      env.DB.prepare("INSERT INTO blob_scopes (scope, sha256, created_at) VALUES ('t:legacy', ?, 123)").bind(file.sha256),
    ]);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await env.DB.prepare("SELECT * FROM blobs").first()).toEqual({ sha256: file.sha256, size: file.size, created_at: 123, storage_key: null });
    expect(await env.DB.prepare("SELECT * FROM blob_scopes").first()).toEqual({ scope: "t:legacy", sha256: file.sha256, created_at: 123 });
    const range = await readBlobRange(context(dw), file.sha256, { offset: 0, length: 6 });
    expect(range).not.toBeNull();
    expect(await new Response(range).text()).toBe("legacy");
  });

  it("does not retire a replacement generation from a stale cleaner snapshot", async () => {
    const dw = await freshInstance();
    const file = await manifestEntry("a.txt", "stale snapshot");
    await putVerifiedBlob(context(dw), "t:writer", file.sha256, file.bytes, file.size, null);
    const oldKey = (await storedKey(file.sha256))!;
    await env.DB.prepare("UPDATE blobs SET created_at = ?").bind(Date.now() - 2 * DAY).run();
    let raced = false;
    let replacementKey: string | undefined;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            // Another cleaner retires the snapshot's generation, then a new
            // upload arrives before the first cleaner's destructive transaction.
            await cleanupBlobs(context(dw), Date.now());
            await putVerifiedBlob(context(dw), "t:writer", file.sha256, file.bytes, file.size, null);
            replacementKey = await storedKey(file.sha256);
          }
          return target.batch(statements);
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const dc = { ...context(dw), env: { ...context(dw).env, DB: db } };
    expect(await cleanupBlobs(dc, Date.now())).toBe(0);
    expect(raced).toBe(true);
    expect(replacementKey).toBeDefined();
    expect(replacementKey).not.toBe(oldKey);
    expect(await storedKey(file.sha256)).toBe(replacementKey);
    expect(await (await env.FILES.get(replacementKey!))!.text()).toBe("stale snapshot");
    expect((await env.DB.prepare("SELECT scope FROM blob_scopes").all()).results).toEqual([{ scope: "t:writer" }]);
  });
});

describe("failed verification does not reserve storage", () => {
  it("removes the upload reservation when R2 rejects the checksum", async () => {
    const dw = await freshInstance();
    const file = await manifestEntry("a.txt", "expected bytes");
    const wrong = new Uint8Array(file.size).fill(120);
    await expect(putVerifiedBlob(context(dw), "t:writer", file.sha256, wrong, file.size, null)).rejects.toMatchObject({ code: "hash_mismatch", status: 400 });
    expect((await env.DB.prepare("SELECT * FROM blob_uploads").all()).results).toEqual([]);
    expect((await env.DB.prepare("SELECT * FROM blobs").all()).results).toEqual([]);
    expect((await env.DB.prepare("SELECT * FROM blob_scopes").all()).results).toEqual([]);
    expect((await env.FILES.list()).objects).toEqual([]);
  });
});
