import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCleanup, sha256Hex } from "@dropway/core";
import { freshInstance } from "./helpers";
import { accepted, complete, context, finalize, foreignKey, pending, putPart, refused, session, state, unregistered } from "./resumable-upload.helpers";

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

describe("foreign multipart session non-disclosure to upload-only credentials", () => {
  // Checking the version only after disclosing a foreign session produces
  // distinguishable 403/404 responses, even without returning file bytes.
  for (const owner of ["same tenant", "foreign tenant"] as const) {
    it.each(["GET", "part", "complete"] as const)(`${owner}: %s hides an existing foreign session exactly like an unknown id`, async (route) => {
      const { dw, p } = await fixture();
      const key = owner === "same tenant" ? p.key : await foreignKey(dw);
      const foreignBytes = new TextEncoder().encode("foreign manifest data, not the caller's blob");
      const foreignHash = await sha256Hex(foreignBytes);
      const q = await pending(dw, foreignHash, foreignBytes.length, "private-session", key);
      const s = await session(dw, q);
      accepted(await putPart(dw, s, 1, foreignBytes, q.token));
      const before = (await state(dw, s, q.token)).body.parts;
      expect(before).toHaveLength(1);
      const request = (id: string) => {
        const target = { ...s, id };
        if (route === "GET") return state(dw, target, p.token);
        if (route === "part") return putPart(dw, target, 1, foreignBytes, p.token);
        return complete(dw, target, p.token);
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
      expect((await state(dw, s, q.token)).body.parts).toEqual(before);
      await unregistered(foreignHash);
      accepted(await complete(dw, s, q.token));
      accepted(await finalize(dw, q));
      const served = await dw.call(`/s/${q.site}/data.bin?raw=1`);
      expect(served.status).toBe(200);
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(foreignBytes);
    });
  }
});
