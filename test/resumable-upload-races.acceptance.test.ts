import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCleanup, sha256Hex } from "@dropway/core";
import { freshInstance } from "./helpers";
import { accepted, complete, context, finalize, foreignKey, pending, putPart, refused, session, start, state, unregistered } from "./resumable-upload.helpers";

const bytes = new TextEncoder().encode("first writer's exact multipart bytes");
afterEach(() => vi.restoreAllMocks());

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// The timer only bounds a broken fixture; ordering comes entirely from the
// binding barrier, never from elapsed time or a sleep.
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("multipart binding barrier did not settle")), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

// Pause exactly the first uploadPart at the storage boundary, after the API's
// authority checks but before any physical part mutation. Everything else,
// including all D1 claims and real R2 reads/writes/complete/abort, calls through.
function holdFirstPart() {
  const entered = signal();
  const release = signal();
  const resume = env.FILES.resumeMultipartUpload.bind(env.FILES);
  let held = false;
  vi.spyOn(env.FILES, "resumeMultipartUpload").mockImplementation((key, id) => {
    const handle = resume(key, id);
    return {
      key: handle.key, uploadId: handle.uploadId,
      async uploadPart(number, body, options) {
        if (!held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return handle.uploadPart(number, body, options);
      },
      complete: handle.complete.bind(handle), abort: handle.abort.bind(handle),
    };
  });
  return {
    async reached(request: Promise<unknown>) {
      await bounded(Promise.race([entered.promise, request.then(() => {
        throw new Error("PUT returned before reaching real R2 uploadPart");
      })]));
    },
    release: release.resolve,
  };
}

async function fixture() {
  const dw = await freshInstance({ multiTenant: true });
  const p = await pending(dw, await sha256Hex(bytes), bytes.length);
  return { dw, p, s: await session(dw, p) };
}

describe("multipart first-writer fencing at the real R2 boundary", () => {
  // Removing a pre-storage exclusive part claim must fail this test: two
  // first PUTs must not acknowledge an etag for bytes another writer replaces.
  it("rejects a different concurrent first PUT before it can replace the claimed part", async () => {
    const { dw, p, s } = await fixture();
    const barrier = holdFirstPart();
    const first = putPart(dw, s, 1, bytes, p.token);
    const changed = bytes.slice(); changed[0] = bytes[0]! ^ 255;
    let contender;
    let retry;
    let winner;
    try {
      await barrier.reached(first);
      contender = await bounded(putPart(dw, s, 1, changed, p.token));
      retry = await bounded(putPart(dw, s, 1, changed, p.token));
    } finally {
      barrier.release();
      winner = await bounded(first);
    }
    // Complete/read-back before assertions, so a RED run also records whether
    // the race left a usable upload rather than abandoning an outstanding PUT.
    const finished = await complete(dw, s, p.token);
    expect.soft(contender!.status, JSON.stringify(contender!.body)).toBe(409);
    expect.soft(retry!.status, JSON.stringify(retry!.body)).toBe(409);
    expect.soft(winner.status, JSON.stringify(winner.body)).toBe(201);
    expect.soft(finished.status, JSON.stringify(finished.body)).toBe(200);
    if (contender!.status === 409 && retry!.status === 409) {
      await refused(dw, contender!, [409]);
      await refused(dw, retry!, [409]);
      expect(retry!.body.error.code).toBe(contender!.body.error.code);
      expect(contender!.body.error.code).not.toBe("upload_closed");
      expect(contender!.body.error.retryable).toBe(true);
      expect(retry!.body.error.retryable).toBe(true);
    }
    // Even a failed implementation must not hide corruption behind a 2xx.
    if (finished.status === 200) {
      accepted(await finalize(dw, p));
      const served = await dw.call(`/s/${p.site}/data.bin?raw=1`);
      expect(served.status).toBe(200);
      const actual = new Uint8Array(await served.arrayBuffer());
      expect(actual).toEqual(bytes);
      expect(await sha256Hex(actual)).toBe(p.sha256);
    }
  });

  it("rejects an identical concurrent PUT without desynchronizing the R2 etag", async () => {
    const { dw, p, s } = await fixture();
    const barrier = holdFirstPart();
    const first = putPart(dw, s, 1, bytes, p.token);
    let contender;
    let winner;
    try {
      await barrier.reached(first);
      contender = await bounded(putPart(dw, s, 1, bytes, p.token));
    } finally {
      barrier.release();
      winner = await bounded(first);
    }
    expect.soft(contender!.status, JSON.stringify(contender!.body)).toBe(409);
    expect.soft(contender!.body.error?.retryable).toBe(true);
    expect.soft(contender!.body.error?.code).toBe("part_busy");
    accepted(winner);
    const replay = await putPart(dw, s, 1, bytes, p.token);
    accepted(replay);
    expect(replay.body.etag).toBe(winner.body.etag);
    accepted(await complete(dw, s, p.token));
    accepted(await finalize(dw, p));
    const served = await dw.call(`/s/${p.site}/data.bin?raw=1`);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
  });

  // A closure after the final authority check is not an ordinary active-R2
  // outage. The API must translate the real closed-handle rejection to 409.
  it("returns upload_closed when cleanup aborts a PUT paused after authority checks", async () => {
    const dw = await freshInstance({ multiTenant: true });
    const p = await pending(dw, await sha256Hex(bytes), bytes.length);
    const s = await session(dw, p, null, p.token);
    const neighborBytes = new TextEncoder().encode("active cleanup neighbor");
    const q = await pending(dw, await sha256Hex(neighborBytes), neighborBytes.length, "active-neighbor");
    const neighbor = await session(dw, q);
    // Capability-created session expires after one hour; owner-created neighbor
    // and both pending versions remain live. No clock mock or schema edits.
    const afterCapabilityExpiry = Date.now() + 3_600_001;
    const barrier = holdFirstPart();
    const uploading = putPart(dw, s, 1, bytes, p.key);
    let result;
    try {
      await barrier.reached(uploading);
      await context(dw, (dc) => runCleanup(dc, afterCapabilityExpiry));
    } finally {
      barrier.release();
      result = await bounded(uploading);
    }
    expect.soft(result.status, JSON.stringify(result.body)).toBe(409);
    expect.soft(result.body.error?.code).toBe("upload_closed");
    expect(result.body.error?.hint).toEqual(expect.any(String));
    await unregistered(p.sha256);
    expect((await state(dw, s, p.key)).body.parts).toBeUndefined();
    // Positive control: cleanup did not merely break every R2 binding.
    accepted(await putPart(dw, neighbor, 1, neighborBytes, q.key));
    accepted(await complete(dw, neighbor, q.key));
  });

  it("does not mislabel a genuine active-R2 failure as upload_closed", async () => {
    const { dw, p, s } = await fixture();
    const resume = env.FILES.resumeMultipartUpload.bind(env.FILES);
    vi.spyOn(env.FILES, "resumeMultipartUpload").mockImplementation((key, id) => {
      const handle = resume(key, id);
      return {
        key: handle.key, uploadId: handle.uploadId,
        async uploadPart() { throw new Error("fixture active R2 outage"); },
        complete: handle.complete.bind(handle), abort: handle.abort.bind(handle),
      };
    });
    const result = await putPart(dw, s, 1, bytes, p.token);
    expect(result.status).toBe(500);
    expect(result.body.error.code).not.toBe("upload_closed");
    vi.restoreAllMocks();
    expect((await state(dw, s, p.token)).body.parts).toEqual([]);
    await unregistered(p.sha256);
    accepted(await putPart(dw, s, 1, bytes, p.token));
    accepted(await complete(dw, s, p.token));
  });
});

describe("foreign multipart session non-disclosure across credential boundaries", () => {
  // Checking the version only after disclosing a foreign session produces
  // distinguishable 403/404 responses, even without returning file bytes.
  for (const owner of ["same tenant", "foreign tenant"] as const) {
    for (const credential of ["upload token", "member key"] as const) {
      it.each(["GET", "part", "complete"] as const)(`${owner}, ${credential}: %s hides an existing foreign session exactly like an unknown id`, async (route) => {
        const { dw, p } = await fixture();
        const key = owner === "same tenant" ? p.key : await foreignKey(dw);
        const foreignBytes = new TextEncoder().encode("foreign manifest data, not the caller's blob");
        const foreignHash = await sha256Hex(foreignBytes);
        const q = await pending(dw, foreignHash, foreignBytes.length, "private-session", key);
        const s = await session(dw, q);
        accepted(await putPart(dw, s, 1, foreignBytes, q.token));
        const before = (await state(dw, s, q.token)).body.parts;
        expect(before).toHaveLength(1);
        const caller = credential === "upload token" ? p.token : (owner === "same tenant" ? await foreignKey(dw) : p.key);
        // Member keys may access other versions in their own tenant; the privacy
        // boundary here is a different tenant. Upload tokens are version-bound.
        const request = (id: string) => {
          const target = { ...s, id };
          if (route === "GET") return state(dw, target, caller);
          if (route === "part") return putPart(dw, target, 1, foreignBytes, caller);
          return complete(dw, target, caller);
        };
        const unknown = await request(crypto.randomUUID());
        const existing = await request(s.id);
        for (const result of [unknown, existing]) {
          expect.soft(result.status, JSON.stringify(result.body)).toBe(404);
          expect.soft(result.body.error?.code).toBe("upload_not_found");
          expect(result.body.error?.hint).toEqual(expect.any(String));
          expect(Object.keys(result.body).filter((key) => !["error", "requestId"].includes(key))).toEqual([]);
          const wire = JSON.stringify(result.body);
          for (const secret of [foreignHash, q.versionId, s.id, q.site]) expect(wire).not.toContain(secret);
        }
        expect(existing.body.error).toEqual(unknown.body.error);
        expect((await state(dw, s, q.token)).body.parts).toEqual(before);
        await unregistered(foreignHash);
        accepted(await complete(dw, s, q.token));
        accepted(await finalize(dw, q));
        const served = await dw.call(`/s/${q.site}/data.bin?raw=1`);
        expect(served.status).toBe(200);
        expect(new Uint8Array(await served.arrayBuffer())).toEqual(foreignBytes);
      });
    }
  }
});

describe("multipart session allocation and resume", () => {
  it("atomically converges concurrent starts to one live session and resumes its parts", async () => {
    const dw = await freshInstance({ multiTenant: true });
    const p = await pending(dw, await sha256Hex(bytes), bytes.length);
    const starts = await Promise.all(Array.from({ length: 8 }, () => start(dw, p)));
    for (const result of starts) accepted(result);
    const ids = new Set(starts.map((result) => result.body.id));
    expect(ids.size).toBe(1);
    const s = starts[0]!.body as Awaited<ReturnType<typeof session>>;
    accepted(await putPart(dw, s, 1, bytes, p.token));
    // A restarted client can use POST as a lookup, even if its requested
    // part size changed. It must follow the returned session's geometry.
    const resumed = await start(dw, p, null, p.token);
    accepted(resumed);
    expect(resumed.body).toMatchObject({ id: s.id, partSize: s.partSize, parts: [expect.objectContaining({ partNumber: 1 })] });
    const rows = await env.DB.prepare("SELECT id FROM upload_sessions WHERE version_id = ? AND sha256 = ? AND status IN ('active', 'completing')").bind(p.versionId, p.sha256).all();
    expect(rows.results).toHaveLength(1);
    accepted(await complete(dw, s, p.token));
    accepted(await finalize(dw, p));
  });
});

describe("authorization after the request body streams", () => {
  it.each(["deleted site", "finalized version", "expired capability", "closed session"] as const)("fences a %s before R2 or acknowledgement", async (mode) => {
    const { dw, p, s } = await fixture();
    const entered = signal();
    const release = signal();
    let delivered = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (delivered) { controller.close(); return; }
        delivered = true;
        entered.resolve();
        await release.promise;
        controller.enqueue(bytes);
        controller.close();
      },
    }, { highWaterMark: 0 });
    const uploading = dw.json(`/api/v1/uploads/${s.id}/parts/1`, { method: "PUT", key: p.token, headers: { "Content-Length": String(bytes.length) }, body });
    let result;
    try {
      await bounded(Promise.race([entered.promise, uploading.then(() => { throw new Error("PUT returned before reading its body"); })]));
      if (mode === "deleted site") accepted(await dw.json(`/api/v1/sites/${p.site}`, { method: "DELETE", key: p.key }));
      if (mode === "finalized version") {
        accepted(await dw.json(`/api/v1/blobs/${p.sha256}`, { method: "PUT", key: p.key, headers: { "Content-Length": String(bytes.length) }, body: bytes }));
        accepted(await finalize(dw, p));
      }
      if (mode === "expired capability") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_001);
      if (mode === "closed session") await env.DB.prepare("UPDATE upload_sessions SET status = 'completing' WHERE id = ?").bind(s.id).run();
    } finally {
      release.resolve();
      result = await bounded(uploading);
    }
    expect([401, 404, 409, 410], JSON.stringify(result.body)).toContain(result.status);
    expect(result.body.error?.code).not.toBe("internal_error");
    const parts = await env.DB.prepare("SELECT * FROM upload_parts WHERE session_id = ?").bind(s.id).all();
    expect(parts.results).toEqual([]);
    // R2 still has no part: even with authority checks removed, this probe
    // observes the real storage mutation rather than just a rejected response.
    const row = await env.DB.prepare("SELECT r2_key, r2_upload_id FROM upload_sessions WHERE id = ?").bind(s.id).first<{ r2_key: string; r2_upload_id: string }>();
    await expect(env.FILES.resumeMultipartUpload(row!.r2_key, row!.r2_upload_id).complete([{ partNumber: 1, etag: "not-uploaded" }])).rejects.toThrow();
    if (mode !== "finalized version") await unregistered(p.sha256);
  });
});

describe("durable multipart cleanup obligations", () => {
  it("keeps expired session ownership after a transient abort failure and retries", async () => {
    const { dw, p, s } = await fixture();
    accepted(await putPart(dw, s, 1, bytes, p.token));
    const resume = env.FILES.resumeMultipartUpload.bind(env.FILES);
    let fail = true;
    vi.spyOn(env.FILES, "resumeMultipartUpload").mockImplementation((key, id) => {
      const handle = resume(key, id);
      return { key: handle.key, uploadId: handle.uploadId,
        uploadPart: handle.uploadPart.bind(handle), complete: handle.complete.bind(handle),
        async abort() { if (fail) { fail = false; throw new Error("transient abort failure"); } await handle.abort(); },
      };
    });
    const afterExpiry = Date.now() + 86_400_001;
    await context(dw, (dc) => runCleanup(dc, afterExpiry));
    expect(await env.DB.prepare("SELECT id FROM upload_sessions WHERE id = ?").bind(s.id).first()).not.toBeNull();
    await context(dw, (dc) => runCleanup(dc, afterExpiry));
    expect(await env.DB.prepare("SELECT id FROM upload_sessions WHERE id = ?").bind(s.id).first()).toBeNull();
    await unregistered(p.sha256);
  });
});

describe("bounded isolate memory for multipart bodies", () => {
  it("backpressures concurrent large parts and releases the reservation on body failure", async () => {
    const dw = await freshInstance({ multiTenant: true });
    const size = 50 * 1024 * 1024;
    const p = await pending(dw, "a".repeat(64), size);
    const s = await session(dw, p, size);
    const q = await pending(dw, "b".repeat(64), size, "memory-neighbor");
    const t = await session(dw, q, size);
    const entered = signal();
    const release = signal();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) { entered.resolve(); await release.promise; controller.close(); },
    }, { highWaterMark: 0 });
    const first = dw.json(`/api/v1/uploads/${s.id}/parts/1`, { method: "PUT", key: p.token, headers: { "Content-Length": String(size) }, body });
    let contender;
    let failed;
    try {
      await bounded(Promise.race([entered.promise, first.then(() => { throw new Error("body was not read"); })]));
      contender = await dw.json(`/api/v1/uploads/${t.id}/parts/1`, { method: "PUT", key: q.token, headers: { "Content-Length": String(size) } });
    } finally { release.resolve(); failed = await bounded(first); }
    expect.soft(contender!.status, JSON.stringify(contender!.body)).toBe(503);
    expect.soft(contender!.body.error?.retryable).toBe(true);
    expect.soft(contender!.body.error?.code).toBe("upload_busy");
    expect(failed.status).toBe(400);
    expect(failed.body.error.code).toBe("size_mismatch");
    // A new body reaches the normal length check once the first reservation
    // is released; a leaked reservation would keep returning 503 here.
    const retry = await dw.json(`/api/v1/uploads/${t.id}/parts/1`, { method: "PUT", key: q.token, headers: { "Content-Length": String(size) } });
    expect(retry.status).toBe(400);
    expect(retry.body.error.code).toBe("size_mismatch");
    expect((await state(dw, s, p.token)).body.parts).toEqual([]);
    expect((await state(dw, t, q.token)).body.parts).toEqual([]);
  });
});

describe("multipart acknowledgement failure recovery", () => {
  it("retries after R2 succeeded but the D1 acknowledgement failed", async () => {
    const { dw, p, s } = await fixture();
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.startsWith("UPDATE upload_parts SET etag")) return statement;
      const bind = statement.bind.bind(statement);
      vi.spyOn(statement, "bind").mockImplementation((...values) => {
        const bound = bind(...values);
        vi.spyOn(bound, "run").mockRejectedValueOnce(new Error("fixture acknowledgement outage"));
        return bound;
      });
      return statement;
    });
    const failed = await putPart(dw, s, 1, bytes, p.token);
    expect(failed.status).toBe(500);
    vi.restoreAllMocks();
    expect((await state(dw, s, p.token)).body.parts).toEqual([]);
    accepted(await putPart(dw, s, 1, bytes, p.token));
    accepted(await complete(dw, s, p.token));
    accepted(await finalize(dw, p));
    const served = await dw.call(`/s/${p.site}/data.bin?raw=1`);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
  });
});

describe("interrupted part claim recovery", () => {
  it("aborts a stale claimed session before replacing it, so a delayed writer cannot corrupt the replacement", async () => {
    const { dw, p, s } = await fixture();
    const barrier = holdFirstPart();
    const uploading = putPart(dw, s, 1, bytes, p.token);
    let replacement;
    let delayed;
    try {
      await barrier.reached(uploading);
      // Model a Worker lost after its claim: POST can reclaim it after a
      // bounded grace, but must first close the old physical R2 handle.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000 + 1);
      replacement = await start(dw, p);
    } finally { barrier.release(); delayed = await bounded(uploading); }
    accepted(replacement!);
    expect.soft(replacement!.body.id).not.toBe(s.id);
    expect.soft(delayed.status, JSON.stringify(delayed.body)).toBe(409);
    expect.soft(delayed.body.error?.code).toBe("upload_closed");
    const next = replacement!.body as Awaited<ReturnType<typeof session>>;
    accepted(await putPart(dw, next, 1, bytes, p.token));
    accepted(await complete(dw, next, p.token));
    accepted(await finalize(dw, p));
    const served = await dw.call(`/s/${p.site}/data.bin?raw=1`);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
  });
});

describe("failed verification retains storage ownership", () => {
  it("retains the cap until corrupt staging has actually been deleted", async () => {
    const { dw, p, s } = await fixture();
    const corrupt = bytes.slice(); corrupt[0] = bytes[0]! ^ 255;
    accepted(await putPart(dw, s, 1, corrupt, p.token));
    vi.spyOn(env.FILES, "delete").mockRejectedValueOnce(new Error("fixture staging deletion outage"));
    const failed = await complete(dw, s, p.token);
    expect(failed.status, JSON.stringify(failed.body)).toBe(500);
    expect(failed.body.error.retryable).toBe(true);
    const resumed = await start(dw, p);
    accepted(resumed);
    expect(resumed.body).toMatchObject({ id: s.id, status: "completing" });
    await unregistered(p.sha256);
    vi.restoreAllMocks();
    const rejected = await complete(dw, s, p.token);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe("hash_mismatch");
    const next = await session(dw, p);
    expect(next.id).not.toBe(s.id);
    accepted(await putPart(dw, next, 1, bytes, p.token));
    accepted(await complete(dw, next, p.token));
    accepted(await finalize(dw, p));
    const served = await dw.call(`/s/${p.site}/data.bin?raw=1`);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
  });
});

describe("promotion cleanup retry fencing", () => {
  it("does not report completion or release the cap while promoted staging deletion still fails", async () => {
    const { dw, p, s } = await fixture();
    accepted(await putPart(dw, s, 1, bytes, p.token));
    vi.spyOn(env.FILES, "delete")
      .mockRejectedValueOnce(new Error("fixture first staging deletion outage"))
      .mockRejectedValueOnce(new Error("fixture repeated staging deletion outage"));
    const first = await complete(dw, s, p.token);
    expect(first.status).toBe(500);
    const retry = await complete(dw, s, p.token);
    expect(retry.status, JSON.stringify(retry.body)).toBe(500);
    expect(retry.body.error.retryable).toBe(true);
    const resumed = await start(dw, p);
    accepted(resumed);
    expect(resumed.body).toMatchObject({ id: s.id, status: "completing" });
    vi.restoreAllMocks();
    accepted(await complete(dw, s, p.token));
    accepted(await finalize(dw, p));
    const served = await dw.call(`/s/${p.site}/data.bin?raw=1`);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
  });
});
