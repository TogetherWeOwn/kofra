import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, bearerToken, defaultIdentity, principalFromToken, requestIp, runCleanup, sha256Hex, type Principal } from "@dropway/core";
import { freshInstance, jsonBody, manifestEntry } from "./helpers";
import { accepted, complete, context, DAY, finalize, foreignKey, MiB, pending, putPart, refused, session, start, state, unregistered } from "./resumable-upload.helpers";

// Independent public-wire acceptance tests. Missing routes must fail assertions,
// not imports. No new services or migration/table names are assumed here.
const bytes = new TextEncoder().encode("verified multipart bytes");
afterEach(() => vi.restoreAllMocks());

const instance = () => freshInstance({ multiTenant: true, limits: { maxFileBytes: 200 * MiB, maxSiteBytes: 300 * MiB } });

async function small() {
  const dw = await instance();
  const p = await pending(dw, await sha256Hex(bytes), bytes.length);
  return { dw, p };
}

describe("resumable upload integrity and real R2 multipart", () => {
  it("persists out-of-order acknowledgements, resumes, verifies, finalizes and serves exact bytes", async () => {
    const dw = await instance();
    // 20 MiB + 7: two legal full parts, one legal final part below 10 MiB.
    const data = new Uint8Array(20 * MiB + 7);
    data.fill(17, 0, 10 * MiB);
    data.fill(42, 10 * MiB, 20 * MiB);
    data.set([0, 255, 1, 254, 2, 253, 3], 20 * MiB);
    const hash = await sha256Hex(data);
    const p = await pending(dw, hash, data.length);
    const r2 = vi.spyOn(env.FILES, "createMultipartUpload"); // call-through: never replace R2 storage
    const s = await session(dw, p);
    expect(r2).toHaveBeenCalled();
    const handle = await r2.mock.results[0]!.value;
    expect(handle.key).toMatch(/^uploads\//);
    expect(handle.uploadId).toEqual(expect.any(String));
    accepted(await putPart(dw, s, 2, data.subarray(10 * MiB, 20 * MiB), p.token));
    accepted(await putPart(dw, s, 3, data.subarray(20 * MiB), p.token));
    const resumed = await state(dw, s, p.token);
    accepted(resumed);
    expect(resumed.body.parts).toEqual([
      expect.objectContaining({ partNumber: 2, size: 10 * MiB, etag: expect.any(String) }),
      expect.objectContaining({ partNumber: 3, size: 7, etag: expect.any(String) }),
    ]);
    await unregistered(hash);
    accepted(await putPart(dw, s, 1, data.subarray(0, 10 * MiB), p.token));
    const finished = await complete(dw, s, p.token);
    accepted(finished);
    expect(finished.body).toMatchObject({ sha256: hash, size: data.length });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM blob_scopes WHERE sha256 = ?").bind(hash).first<{ n: number }>())?.n).toBe(1);
    const final = await finalize(dw, p);
    accepted(final);
    const served = await dw.call(`/s/${p.site}/data.bin?raw=1`);
    expect(served.status).toBe(200);
    const actual = new Uint8Array(await served.arrayBuffer());
    // Byte-exactness via length + hash: a 20 MiB toEqual diff OOM-crashes workerd.
    expect(actual.length).toBe(data.length);
    expect(await sha256Hex(actual)).toBe(hash);
    expect((await env.FILES.list({ prefix: "uploads/" })).objects).toEqual([]);
    // A complete multipart handle cannot accept more bytes; plain R2.put-only
    // implementations would not have produced a real multipart handle at all.
    await expect(env.FILES.resumeMultipartUpload(handle.key, handle.uploadId).uploadPart(4, new Uint8Array([1]))).rejects.toThrow();
  }, 120_000);

  it("accepts a final-small-part file and idempotently replays identical part/completion retries", async () => {
    const { dw, p } = await small();
    const s = await session(dw, p, null, p.token);
    expect(s.partSize).toBe(50 * MiB);
    accepted(await putPart(dw, s, 1, bytes, p.token));
    const before = await state(dw, s, p.token);
    accepted(await putPart(dw, s, 1, bytes, p.token));
    expect((await state(dw, s, p.token)).body.parts).toEqual(before.body.parts);
    const first = await complete(dw, s, p.token);
    accepted(first);
    const retry = await complete(dw, s, p.token);
    accepted(retry);
    expect(retry.body).toMatchObject({ sha256: p.sha256, size: p.size });
    accepted(await finalize(dw, p));
    const retryFinalize = await finalize(dw, p);
    accepted(retryFinalize);
    expect(retryFinalize.body.replayed).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM blob_scopes WHERE sha256 = ?").bind(p.sha256).first<{ n: number }>())?.n).toBe(1);
  });

  it.each([10 * MiB, 95 * MiB])("admits the inclusive partSize boundary %i", async (partSize) => {
    const { dw, p } = await small();
    await session(dw, p, partSize);
  });

  it.each([0, 10 * MiB - 1, 95 * MiB + 1, 10 * MiB + 0.5, -1, "10485760"])("refuses invalid partSize %s without starting R2 multipart", async (partSize) => {
    const { dw, p } = await small();
    const r2 = vi.spyOn(env.FILES, "createMultipartUpload");
    const result = await dw.json("/api/v1/uploads", { ...jsonBody({ versionId: p.versionId, sha256: p.sha256, partSize }), key: p.key });
    await refused(dw, result, [400, 422]);
    expect(r2).not.toHaveBeenCalled();
    await unregistered(p.sha256);
  });

  it.each([0, -1, 2, "1.5", "nope"])("refuses invalid or out-of-manifest part index %s", async (index) => {
    const { dw, p } = await small();
    const s = await session(dw, p);
    await refused(dw, await putPart(dw, s, index, bytes, p.token), [400, 404, 422]);
    expect((await state(dw, s, p.token)).body.parts).toEqual([]);
    await unregistered(p.sha256);
  });

  it.each(["missing header", "short declared", "long declared", "short body"])("refuses %s without acknowledging a part", async (kind) => {
    const { dw, p } = await small();
    const s = await session(dw, p);
    const body = kind === "short body" ? bytes.subarray(1) : bytes;
    const length = kind === "missing header" ? null : String(p.size + (kind === "short declared" ? -1 : kind === "long declared" ? 1 : 0));
    await refused(dw, await putPart(dw, s, 1, body, p.token, length), [400, 411, 413, 422]);
    expect((await state(dw, s, p.token)).body.parts).toEqual([]);
    await unregistered(p.sha256);
  });

  it("refuses a short non-final part even though the last part may be small", async () => {
    const dw = await instance();
    const p = await pending(dw, "a".repeat(64), 10 * MiB + 1);
    const s = await session(dw, p);
    await refused(dw, await putPart(dw, s, 1, bytes, p.token), [400, 413, 422]);
    expect((await state(dw, s, p.token)).body.parts).toEqual([]);
  });

  it("refuses completion with missing acknowledged parts, ignoring a client-supplied forged list", async () => {
    const { dw, p } = await small();
    const s = await session(dw, p);
    await refused(dw, await complete(dw, s, p.token, { parts: [{ partNumber: 1, etag: "forged", size: p.size }] }), [400, 409, 422]);
    await unregistered(p.sha256);
    const early = await finalize(dw, p);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("missing_blobs");
  });

  it("refuses a changed acknowledged-part retry and preserves the original good bytes", async () => {
    const { dw, p } = await small();
    const s = await session(dw, p);
    accepted(await putPart(dw, s, 1, bytes, p.token));
    const before = (await state(dw, s, p.token)).body.parts;
    const changed = bytes.slice(); changed[0] = 0;
    const rejected = await putPart(dw, s, 1, changed, p.token);
    await refused(dw, rejected, [400, 409, 422]);
    expect(rejected.body.error.code).toBe("part_conflict");
    expect(rejected.body.error.retryable, "changed acknowledged bytes cannot converge by retrying").toBe(false);
    expect((await state(dw, s, p.token)).body.parts).toEqual(before);
    accepted(await complete(dw, s, p.token));
    accepted(await finalize(dw, p));
    expect(new Uint8Array(await (await dw.call(`/s/${p.site}/data.bin?raw=1`)).arrayBuffer())).toEqual(bytes);
  });

  it("hashes completed R2 bytes before promotion; corrupt data creates no blob or dedupe scope", async () => {
    const { dw, p } = await small();
    const s = await session(dw, p);
    const corrupt = bytes.slice(); corrupt[0] = 0;
    accepted(await putPart(dw, s, 1, corrupt, p.token));
    const result = await complete(dw, s, p.token);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("hash_mismatch");
    await unregistered(p.sha256);
    const other = await foreignKey(dw);
    const another = await pending(dw, p.sha256, p.size, "foreign-unverified", other);
    expect(another.token).toMatch(/^dwu_/);
    expect((await finalize(dw, another)).body.error.code).toBe("missing_blobs");
  });

  it("a foreign preexisting global blob is neither a dedupe oracle nor proof of the new owner's bytes", async () => {
    const { dw, p } = await small();
    const s = await session(dw, p);
    accepted(await putPart(dw, s, 1, bytes, p.token));
    accepted(await complete(dw, s, p.token));
    const generations = async () => (await env.FILES.list({ prefix: `blobs/${p.sha256}` })).objects.map((o) => `${o.key}:${o.etag}`);
    const original = await generations();
    expect(original).toHaveLength(1);
    const other = await foreignKey(dw);
    const q = await pending(dw, p.sha256, p.size, "other-owner", other);
    const foreignSession = await session(dw, q);
    const corrupt = bytes.slice(); corrupt[0] = 0;
    accepted(await putPart(dw, foreignSession, 1, corrupt, q.token));
    expect((await complete(dw, foreignSession, q.token)).body.error.code).toBe("hash_mismatch");
    expect(await generations()).toEqual(original);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM blob_scopes WHERE sha256 = ?").bind(p.sha256).first<{ n: number }>())?.n).toBe(1);
    expect((await finalize(dw, q)).body.error.code).toBe("missing_blobs");
  });
});

describe("multipart authority is bound to pending version, hash and lifetime", () => {
  it("never lets a dwu credential read, publish or finalize, including with a custom identity adapter", async () => {
    const dispatched: string[] = [];
    const dw = await freshInstance({}, { adapters: {
      identity: { async resolve(request, dc) {
        const token = bearerToken(request);
        return token?.startsWith("dwu_") ? principalFromToken(dc, token, requestIp(request)) : defaultIdentity.resolve(request, dc);
      } },
      policy: { limits: (_p, _o, dc) => dc.config.limits, beforeOperation(p, op) { if (p.kind === "upload") dispatched.push(op.id); } },
    } });
    const p = await pending(dw, await sha256Hex(bytes), bytes.length);
    const s = await session(dw, p, 10 * MiB, p.token);
    accepted(await state(dw, s, p.token));
    accepted(await putPart(dw, s, 1, bytes, p.token));
    accepted(await complete(dw, s, p.token));
    dispatched.length = 0;
    await refused(dw, await dw.json("/api/v1/sites", { key: p.token }), [403]);
    await refused(dw, await dw.json("/api/v1/publish", { ...jsonBody({ files: [{ path: "x.txt", content: "not allowed" }] }), key: p.token }), [403]);
    await refused(dw, await finalize(dw, p, p.token), [403]);
    expect(dispatched).toEqual([]);
    accepted(await finalize(dw, p));
  });

  it("refuses every multipart operation for anonymous, foreign-tenant and foreign-version credentials", async () => {
    const { dw, p } = await small();
    const s = await session(dw, p);
    const q = await pending(dw, p.sha256, p.size, "another-pending");
    const other = await foreignKey(dw);
    for (const key of ["", other, q.token]) {
      await refused(dw, await start(dw, p, 10 * MiB, key), [401, 403, 404]);
      await refused(dw, await state(dw, s, key), [401, 403, 404]);
      await refused(dw, await putPart(dw, s, 1, bytes, key), [401, 403, 404]);
      await refused(dw, await complete(dw, s, key), [401, 403, 404]);
    }
    expect((await state(dw, s, p.key)).body.parts).toEqual([]);
    await unregistered(p.sha256);
  });

  it("does not let a valid version credential start a session for another hash", async () => {
    const { dw, p } = await small();
    const result = await start(dw, { ...p, sha256: "b".repeat(64) }, 10 * MiB, p.token);
    await refused(dw, result, [403, 404]);
    await unregistered("b".repeat(64));
  });

  it.each(["deleted", "finalized", "expired capability"])("rechecks %s on GET, PUT and complete", async (mode) => {
    const { dw, p } = await small();
    const s = await session(dw, p, 10 * MiB, p.token);
    if (mode === "deleted") accepted(await dw.json(`/api/v1/sites/${p.site}`, { method: "DELETE", key: p.key }));
    if (mode === "finalized") {
      accepted(await dw.json(`/api/v1/blobs/${p.sha256}`, { method: "PUT", key: p.key, body: bytes, headers: { "Content-Length": String(bytes.length) } }));
      accepted(await finalize(dw, p));
    }
    if (mode === "expired capability") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_001);
    for (const key of mode === "expired capability" ? [p.token] : [p.key, p.token]) {
      await refused(dw, await state(dw, s, key), [401, 403, 404, 409, 410]);
      await refused(dw, await putPart(dw, s, 1, bytes, key), [401, 403, 404, 409, 410]);
      await refused(dw, await complete(dw, s, key), [401, 403, 404, 409, 410]);
    }
  });

  it("caps a capability-created session at that capability's earlier expiry even for an owner resume", async () => {
    const { dw, p } = await small();
    const s = await session(dw, p, 10 * MiB, p.token);
    accepted(await putPart(dw, s, 1, bytes, p.token));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_001);
    for (const key of [p.key, p.token]) {
      await refused(dw, await state(dw, s, key), [401, 403, 404, 409, 410]);
      await refused(dw, await putPart(dw, s, 1, bytes, key), [401, 403, 404, 409, 410]);
      await refused(dw, await complete(dw, s, key), [401, 403, 404, 409, 410]);
    }
    await unregistered(p.sha256);
  });

  it("expires a session when its anonymous pending site expires before the upload credential", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true, ttlMs: 1_000 } });
    const p = await pending(dw, await sha256Hex(bytes), bytes.length, null, "");
    const s = await session(dw, p, 10 * MiB, p.token);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_001);
    await refused(dw, await state(dw, s, p.token), [401, 403, 404, 409, 410]);
    await refused(dw, await putPart(dw, s, 1, bytes, p.token), [401, 403, 404, 409, 410]);
    await refused(dw, await complete(dw, s, p.token), [401, 403, 404, 409, 410]);
    await unregistered(p.sha256);
  });

  it("preserves custom identity refusal for each newly mounted route", async () => {
    const dw = await freshInstance({}, { adapters: { identity: { resolve(request, dc) {
      if (request.headers.has("X-Refuse")) throw new ApiError(401, "fixture_identity_refused", "Refused.", "Use the authorized session.");
      return defaultIdentity.resolve(request, dc);
    } } } });
    const p = await pending(dw, await sha256Hex(bytes), bytes.length);
    const s = await session(dw, p);
    for (const [method, path, body] of [
      ["POST", "/api/v1/uploads", JSON.stringify({ versionId: p.versionId, sha256: p.sha256 })],
      ["GET", `/api/v1/uploads/${s.id}`, undefined],
      ["PUT", `/api/v1/uploads/${s.id}/parts/1`, bytes],
      ["POST", `/api/v1/uploads/${s.id}/complete`, "{}"],
    ] as const) {
      const result = await dw.json(path, { method, key: p.key, headers: { "X-Refuse": "yes", "Content-Type": "application/json" }, body });
      expect(result.status).toBe(401);
      expect(result.body.error).toMatchObject({ code: "fixture_identity_refused", hint: "Use the authorized session." });
    }
  });

  it("independently refuses an expired upload Principal supplied by an embedding identity", async () => {
    let injected: Principal = { kind: "anonymous", ip: "192.0.2.1" };
    const dw = await freshInstance({}, { adapters: { identity: { resolve(request, dc) {
      return request.headers.has("X-Expired-Upload") ? Promise.resolve(injected) : defaultIdentity.resolve(request, dc);
    } } } });
    const p = await pending(dw, await sha256Hex(bytes), bytes.length);
    const s = await session(dw, p);
    injected = { kind: "upload", versionId: p.versionId, expiresAt: Date.now() - 1, ip: "192.0.2.1" };
    const headers = { "X-Expired-Upload": "yes" };
    for (const [method, path, body] of [
      ["POST", "/api/v1/uploads", JSON.stringify({ versionId: p.versionId, sha256: p.sha256 })],
      ["GET", `/api/v1/uploads/${s.id}`, undefined],
      ["PUT", `/api/v1/uploads/${s.id}/parts/1`, bytes],
      ["POST", `/api/v1/uploads/${s.id}/complete`, "{}"],
    ] as const) {
      await refused(dw, await dw.json(path, { method, headers: { ...headers, "Content-Type": "application/json", "Content-Length": String(body?.length ?? 0) }, body }), [401, 403, 404, 410]);
    }
    await unregistered(p.sha256);
  });
});

describe("multipart policy and cleanup contracts", () => {
  it("admits a configured 150 MiB manifest but preserves default anonymous limits", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true }, limits: { maxFileBytes: 200 * MiB, maxSiteBytes: 300 * MiB } });
    const p = await pending(dw, "a".repeat(64), 150 * MiB);
    await session(dw, p);
    const denied = await dw.json("/api/v1/publish", { ...jsonBody({ files: [{ path: "too-big.bin", sha256: "b".repeat(64), size: 25 * MiB + 1 }] }) });
    expect(denied.status).toBe(413);
    expect(denied.body.error.code).toBe("file_too_large");
  });

  it("preserves custom file limits at admission and revalidates lowered policy before finalize", async () => {
    let limit = bytes.length;
    const dw = await freshInstance({}, { adapters: { policy: { limits: (_p, _o, dc) => ({ ...dc.config.limits, maxFileBytes: limit }) } } });
    const denied = await dw.json("/api/v1/publish", { ...jsonBody({ files: [{ path: "over.bin", sha256: "b".repeat(64), size: limit + 1 }] }), key: dw.ownerKey });
    expect(denied.status).toBe(413);
    expect(denied.body.error.code).toBe("file_too_large");
    const p = await pending(dw, await sha256Hex(bytes), bytes.length);
    const s = await session(dw, p);
    accepted(await putPart(dw, s, 1, bytes, p.token));
    accepted(await complete(dw, s, p.token));
    limit--;
    const final = await finalize(dw, p);
    expect(final.status).toBe(413);
    expect(final.body.error.code).toBe("file_too_large");
    expect((await dw.call(`/s/${p.site}/data.bin?raw=1`)).status).toBe(404);
    limit++;
    accepted(await finalize(dw, p));
  });

  it("expires owner sessions within one day; repeated cleanup aborts old staging but preserves a live session", async () => {
    const dw = await instance();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const p = await pending(dw, await sha256Hex(bytes), bytes.length);
    const r2 = vi.spyOn(env.FILES, "createMultipartUpload");
    const expired = await session(dw, p);
    accepted(await putPart(dw, expired, 1, bytes, p.key));
    const handle = await r2.mock.results[0]!.value;
    clock.mockReturnValue(now + DAY + 1);
    const nextBytes = new TextEncoder().encode("a live session after the old one expires");
    const q = await pending(dw, await sha256Hex(nextBytes), nextBytes.length, "cleanup-live");
    const live = await session(dw, q);
    accepted(await putPart(dw, live, 1, nextBytes, q.key));
    await refused(dw, await state(dw, expired, p.key), [404, 409, 410]);
    for (let n = 0; n < 2; n++) await context(dw, (dc) => runCleanup(dc, now + DAY + 1));
    await expect(env.FILES.resumeMultipartUpload(handle.key, handle.uploadId).uploadPart(2, new Uint8Array([1]))).rejects.toThrow();
    const resumed = await state(dw, live, q.key);
    accepted(resumed);
    expect(resumed.body.parts).toHaveLength(1);
    accepted(await complete(dw, live, q.key));
    accepted(await finalize(dw, q));
    await unregistered(p.sha256);
  });

  it("bounds an expired-session cleanup slice and eventually aborts every expired upload, not a live neighbor", async () => {
    const dw = await instance();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    // 501 exceeds the existing native cleanup convention's 500-row slice.
    // This is a test-owned proposed bound, not a guessed session table schema.
    for (let n = 1; n <= 501; n++) {
      const p = await pending(dw, n.toString(16).padStart(64, "0"), 1, "cleanup-backlog");
      await session(dw, p);
    }
    clock.mockReturnValue(now + DAY + 1);
    const liveBytes = new TextEncoder().encode("live cleanup neighbor");
    const livePending = await pending(dw, await sha256Hex(liveBytes), liveBytes.length, "cleanup-neighbor");
    const live = await session(dw, livePending);
    accepted(await putPart(dw, live, 1, liveBytes, livePending.key));
    const aborts: string[] = [];
    const resume = env.FILES.resumeMultipartUpload.bind(env.FILES);
    vi.spyOn(env.FILES, "resumeMultipartUpload").mockImplementation((key, id) => {
      const handle = resume(key, id);
      return {
        key: handle.key, uploadId: handle.uploadId,
        uploadPart: handle.uploadPart.bind(handle), complete: handle.complete.bind(handle),
        async abort() { await handle.abort(); aborts.push(`${key}:${id}`); },
      };
    });
    await context(dw, (dc) => runCleanup(dc, now + DAY + 1));
    expect(aborts.length).toBeGreaterThan(0);
    expect(aborts.length, "one invocation cannot consume an unbounded backlog").toBeLessThanOrEqual(500);
    for (let n = 0; n < 10 && new Set(aborts).size < 501; n++) await context(dw, (dc) => runCleanup(dc, now + DAY + 1));
    expect(new Set(aborts).size).toBe(501);
    accepted(await state(dw, live, livePending.key));
    accepted(await complete(dw, live, livePending.key));
    accepted(await finalize(dw, livePending));
  }, 180_000);

  // Review round: the slice above bounds ROWS, not service calls. 500 rows at
  // abort + delete + one D1 batch each is 1501 internal-service calls before
  // later housekeeping, over the documented 1000-per-invocation budget. This
  // simulation counts real D1 executions (a batch counts once) plus R2/KV
  // calls during runCleanup; storage for seeded sessions is a counting
  // double at the abort boundary, never a live quota test.
  it("keeps one cleanup invocation inside a 1000 internal-service-call budget while later housekeeping still runs and the backlog drains", async () => {
    const dw = await instance();
    const realNow = Date.now();
    const cleanupNow = realNow + 2 * DAY;
    // Fixtures for phases that run AFTER expired-upload cleanup.
    const stale = await pending(dw, await sha256Hex(bytes), bytes.length, "cleanup-budget-stale");
    const orphanSha = "e".repeat(64);
    await env.DB.prepare("INSERT INTO blobs (sha256, size, created_at) VALUES (?, ?, ?)").bind(orphanSha, 3, realNow).run();
    await env.FILES.put(`blobs/${orphanSha}`, new Uint8Array([1, 2, 3]));
    await env.DB.prepare("INSERT INTO idempotency_keys (key_hash, input_hash, owner_token, state, result_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("cleanup-budget-key", "cleanup-budget-input", "cleanup-budget-owner", "done", null, cleanupNow - 1).run();
    // 600 expired unfinished sessions plus one live neighbor (raw rows only;
    // creating 600 real R2 uploads just to count their aborts would test the
    // fixture, not the budget).
    const seedSession = (i: number, expiresAt: number) => env.DB.prepare(
      "INSERT INTO upload_sessions (id, version_id, site_id, sha256, size, part_size, part_count, r2_key, r2_upload_id, status, staged, content_type, created_at, expires_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, NULL, ?, ?, NULL)",
    ).bind(`upl_budget_${i}`, `ver_budget_${i}`, "site_budget", i.toString(16).padStart(64, "0"), 1, 10 * MiB, 1, `uploads/budget-${i}`, `budget-${i}`, realNow, expiresAt);
    for (let startAt = 0; startAt < 600; startAt += 100) {
      await env.DB.batch(Array.from({ length: Math.min(100, 600 - startAt) }, (_, k) => seedSession(startAt + k, cleanupNow - 1_000 + startAt + k)));
    }
    await seedSession(10_001, cleanupNow + DAY).run();
    const sessionsLeft = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_sessions WHERE id LIKE 'upl_budget_%' AND expires_at <= ?").bind(cleanupNow).first<{ n: number }>())!.n;
    expect(await sessionsLeft()).toBe(600);

    let calls = 0;
    let counting = false;
    const count = () => { if (counting) calls++; };
    const prepare = env.DB.prepare.bind(env.DB);
    const wrapStatement = (stmt: any): any => {
      const bind = stmt.bind.bind(stmt);
      vi.spyOn(stmt, "bind").mockImplementation(((...values: unknown[]) => wrapStatement(bind(...values))) as never);
      for (const method of ["run", "all", "first"] as const) {
        const orig = typeof stmt[method] === "function" ? stmt[method].bind(stmt) : null;
        if (!orig) continue;
        vi.spyOn(stmt, method).mockImplementation((async (...args: unknown[]) => { count(); return orig(...args); }) as never);
      }
      return stmt;
    };
    vi.spyOn(env.DB, "prepare").mockImplementation(((sql: string) => wrapStatement(prepare(sql))) as never);
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementation((async (statements: unknown) => { count(); return batch(statements as never); }) as never);
    const del = env.FILES.delete.bind(env.FILES);
    vi.spyOn(env.FILES, "delete").mockImplementation((async (key: string | string[]) => { count(); return del(key); }) as never);
    vi.spyOn(env.FILES, "resumeMultipartUpload").mockImplementation((key, id) => ({
      key, uploadId: id,
      async uploadPart() { throw new Error("counting double accepts no parts"); },
      async complete() { throw new Error("counting double never completes"); },
      async abort() { count(); },
    }));
    for (const method of ["get", "put", "delete"] as const) {
      const orig = (env.CACHE[method] as (...args: any[]) => unknown).bind(env.CACHE);
      vi.spyOn(env.CACHE, method).mockImplementation((async (...args: unknown[]) => { count(); return orig(...args); }) as never);
    }
    const countedCleanup = async () => {
      calls = 0;
      const report = await context(dw, async (dc) => {
        counting = true;
        try { return await runCleanup(dc, cleanupNow); } finally { counting = false; }
      });
      return { report, calls };
    };

    const first = await countedCleanup();
    expect(first.calls, "one runCleanup invocation must fit the documented 1000 internal-service-call budget (each D1 execution, R2 call or KV call = 1; one D1 batch = 1)").toBeLessThanOrEqual(1_000);
    expect(first.report.expiredUploads).toBeGreaterThan(0);
    // Later housekeeping phases still executed in the same invocation.
    expect(first.report.abandonedDeploys).toBeGreaterThanOrEqual(1);
    expect(first.report.deletedBlobs).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare("SELECT id FROM versions WHERE id = ?").bind(stale.versionId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT sha256 FROM blobs WHERE sha256 = ?").bind(orphanSha).first()).toBeNull();
    expect(await env.DB.prepare("SELECT key_hash FROM idempotency_keys WHERE key_hash = 'cleanup-budget-key'").first()).toBeNull();
    // Leftovers stay owned and exactly accounted, then drain on later runs,
    // each inside the same budget; the live neighbor is never touched.
    expect(await sessionsLeft()).toBe(600 - first.report.expiredUploads);
    for (let run = 0; run < 12 && (await sessionsLeft()) > 0; run++) {
      const beforeCount = await sessionsLeft();
      const next = await countedCleanup();
      expect(next.calls).toBeLessThanOrEqual(1_000);
      expect(await sessionsLeft()).toBe(beforeCount - next.report.expiredUploads);
      expect(next.report.expiredUploads).toBeGreaterThan(0);
    }
    expect(await sessionsLeft()).toBe(0);
    expect(await env.DB.prepare("SELECT id FROM upload_sessions WHERE id = 'upl_budget_10001'").first()).not.toBeNull();
  }, 180_000);

  it("does not grant a site-restricted key access to another site's multipart session", async () => {
    const { dw, p } = await small();
    const s = await session(dw, p);
    const own = await dw.json("/api/v1/sites", { ...jsonBody({ slug: "restricted-key-site" }), key: p.key });
    expect(own.status).toBe(201);
    const created = await dw.json("/api/v1/keys", { ...jsonBody({ name: "site-only", site: "restricted-key-site", scopes: ["sites:write", "sites:read"] }), key: p.key });
    expect(created.status).toBe(201);
    const key = created.body.key;
    expect(key).toEqual(expect.any(String));
    for (const result of [await start(dw, p, 10 * MiB, key), await state(dw, s, key), await putPart(dw, s, 1, bytes, key), await complete(dw, s, key)]) {
      await refused(dw, result, [403, 404]);
    }
  });

  it("refuses starting sessions for a nonexistent or already-ready version", async () => {
    const { dw, p } = await small();
    await refused(dw, await start(dw, { ...p, versionId: "missing-version" }), [400, 404]);
    const entry = await manifestEntry("ready.txt", "ready data");
    const live = await dw.json("/api/v1/publish", { ...jsonBody({ site: "already-ready", files: [{ path: entry.path, content: "ready data" }] }), key: p.key });
    expect(live.status).toBe(201);
    await refused(dw, await start(dw, { ...p, versionId: live.body.version.id, sha256: entry.sha256 }), [400, 404, 409, 410]);
  });
});
