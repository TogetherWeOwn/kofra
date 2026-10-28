import { env } from "cloudflare:test";
import { clearLiveMemoryCache } from "@dropway/core";
import { afterEach, expect, it, vi } from "vitest";
import { form, freshInstance, jsonBody, manifestEntry } from "./helpers";

afterEach(() => { vi.restoreAllMocks(); clearLiveMemoryCache(); });

async function pendingVersion() {
  const dw = await freshInstance();
  const slug = "finalize-cache-fault";
  const first = await dw.json("/api/v1/publish", {
    method: "POST", key: dw.ownerKey,
    body: form({ "index.txt": "old published version\n" }, { slug }),
  });
  expect(first.status).toBe(201);
  const key = `live:${slug}`;
  expect((await env.CACHE.get<{ versionId: string }>(key, "json"))?.versionId).toBe(first.body.version.id);

  const entry = await manifestEntry("index.txt", "new published version\n");
  const deploy = await dw.json(`/api/v1/sites/${slug}/deploys`, {
    key: dw.ownerKey, ...jsonBody({ files: [{ path: entry.path, size: entry.size, sha256: entry.sha256 }] }),
  });
  expect(deploy.status).toBe(201);
  const upload = await dw.json(`/api/v1/blobs/${entry.sha256}`, {
    method: "PUT", key: dw.ownerKey, body: entry.bytes,
    headers: { "Content-Length": String(entry.size) },
  });
  expect(upload.status).toBe(201);
  const versionId: string = deploy.body.deploy.id;
  const url = `/api/v1/sites/${slug}/deploys/${versionId}/finalize`;
  return { dw, slug, key, versionId, oldVersionId: first.body.version.id as string, url,
    finalize: () => dw.json(url, { method: "POST", key: dw.ownerKey }) };
}

function failLivePut(key: string) {
  const put = env.CACHE.put.bind(env.CACHE);
  return vi.spyOn(env.CACHE, "put").mockImplementation(async (k, value, options) => {
    if (k === key) throw new Error("injected KV failure");
    return put(k, value, options);
  });
}

async function expectCommittedWithStaleCache(fixture: Awaited<ReturnType<typeof pendingVersion>>) {
  const state = await env.DB.prepare(
    "SELECT s.current_version_id, v.status FROM sites s JOIN versions v ON v.id = s.current_version_id WHERE s.slug = ?",
  ).bind(fixture.slug).first<{ current_version_id: string; status: string }>();
  expect(state).toMatchObject({ current_version_id: fixture.versionId, status: "ready" });
  expect((await env.CACHE.get<{ versionId: string }>(fixture.key, "json"))?.versionId).toBe(fixture.oldVersionId);
}

it("repairs the live manifest when finalize is retried after the KV write fails", async () => {
  const fixture = await pendingVersion();
  const fault = failLivePut(fixture.key);
  expect((await fixture.finalize()).status).toBe(500);
  await expectCommittedWithStaleCache(fixture);
  // A replay must not silently succeed while the cache is still unavailable.
  expect((await fixture.finalize()).status).toBe(500);
  fault.mockRestore();

  const retry = await fixture.finalize();
  expect(retry.status).toBe(200);
  expect(retry.body).toMatchObject({ replayed: true, live: true });
  expect((await env.CACHE.get<{ versionId: string }>(fixture.key, "json"))?.versionId).toBe(fixture.versionId);
  clearLiveMemoryCache();
  expect(await (await fixture.dw.call(`/s/${fixture.slug}/index.txt`)).text()).toBe("new published version\n");
});

it("repairs the live manifest when a competing finalize commits after the pending read", async () => {
  const fixture = await pendingVersion();
  const batch = env.DB.batch.bind(env.DB);
  // Pause at the missing-blob batch, after this finalize has read a pending
  // version. Let a real competing finalize commit and fail its KV write first.
  const interleave = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
    interleave.mockRestore();
    const result = await batch(statements);
    const fault = failLivePut(fixture.key);
    try {
      expect((await fixture.finalize()).status).toBe(500);
      await expectCommittedWithStaleCache(fixture);
    } finally { fault.mockRestore(); }
    return result;
  });

  const result = await fixture.finalize();
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ replayed: true, live: true });
  expect((await env.CACHE.get<{ versionId: string }>(fixture.key, "json"))?.versionId).toBe(fixture.versionId);
  clearLiveMemoryCache();
  expect(await (await fixture.dw.call(`/s/${fixture.slug}/index.txt`)).text()).toBe("new published version\n");
});

it("replays an old version without rolling back the current live manifest", async () => {
  const fixture = await pendingVersion();
  expect((await fixture.finalize()).status).toBe(200);
  const current = await env.CACHE.get(fixture.key);
  expect(current).not.toBeNull();
  // A cache miss also needs repair, but from the current D1 pointer, not the
  // historical ready version the caller happens to be replaying.
  await env.CACHE.delete(fixture.key);
  clearLiveMemoryCache();
  const replay = await fixture.dw.json(`/api/v1/sites/${fixture.slug}/deploys/${fixture.oldVersionId}/finalize`, {
    method: "POST", key: fixture.dw.ownerKey,
  });
  expect(replay.status).toBe(200);
  expect(replay.body).toMatchObject({ replayed: true, live: false });
  expect(await env.CACHE.get(fixture.key)).toBe(current);
  clearLiveMemoryCache();
  expect(await (await fixture.dw.call(`/s/${fixture.slug}/index.txt`)).text()).toBe("new published version\n");
});

it("authorizes a ready-version replay before repairing the live manifest", async () => {
  const fixture = await pendingVersion();
  const fault = failLivePut(fixture.key);
  expect((await fixture.finalize()).status).toBe(500);
  fault.mockRestore();
  const denied = await fixture.dw.json(fixture.url, { method: "POST" });
  expect(denied.status).toBe(401);
  await expectCommittedWithStaleCache(fixture);
});
