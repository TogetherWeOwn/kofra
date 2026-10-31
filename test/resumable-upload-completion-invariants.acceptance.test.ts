import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCleanup, sha256Hex } from "@dropway/core";
import { freshInstance } from "./helpers";
import { accepted, complete, context, finalize, pending, putPart, session, start, unregistered, type Pending, type Session } from "./resumable-upload.helpers";

// Completion-state invariants under deterministic binding barriers (real
// emulated D1/R2, ordering only from the barriers, never from elapsed time):
// A. A late concurrent completer must never overwrite another completer's
//    durable corrupt-cleanup intent or terminal state. Whatever each call
//    answers, the session must settle recoverably: a retry or a fresh start
//    must permit an exact-byte replacement upload that completes and finalizes.
// B. When verified bytes have been promoted to blob storage but the owner
//    registration is then refused (target deleted, or lifetime expired during
//    assembly/storage), the refusal confers no scope or success, and the
//    promoted object must stay represented by durable cleanup inventory so
//    normal bounded cleanup eventually removes it. A live neighbor's objects
//    — including a shared pre-existing object with the same hash — must survive.

const bytes = new TextEncoder().encode("completion invariant exact bytes");
const DAY = 86_400_000;
afterEach(() => vi.restoreAllMocks());

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// The timer only bounds a broken fixture; ordering comes from the barriers.
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("completion barrier did not settle")), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture() {
  const dw = await freshInstance({ multiTenant: true });
  const p = await pending(dw, await sha256Hex(bytes), bytes.length);
  return { dw, p, s: await session(dw, p) };
}

async function expectServedExactly(dw: Awaited<ReturnType<typeof freshInstance>>, p: Pending) {
  const served = await dw.call(`/s/${p.site}/data.bin?raw=1`);
  expect(served.status).toBe(200);
  const actual = new Uint8Array(await served.arrayBuffer());
  expect(actual).toEqual(bytes);
  expect(await sha256Hex(actual)).toBe(p.sha256);
}

describe("concurrent completion preserves corrupt-cleanup intent", () => {
  it("a late assembly acknowledgement never strands a completing session without its staged object", async () => {
    const { dw, p, s } = await fixture();
    const corrupt = bytes.slice(); corrupt[0] = bytes[0]! ^ 255;
    accepted(await putPart(dw, s, 1, corrupt, p.token));

    // Barrier 1: hold the FIRST R2 assembly (completer A) after it claimed
    // the session for completion, before any staged object exists.
    const assemblyEntered = signal();
    const assemblyRelease = signal();
    const resume = env.FILES.resumeMultipartUpload.bind(env.FILES);
    let assemblies = 0;
    vi.spyOn(env.FILES, "resumeMultipartUpload").mockImplementation((key, id) => {
      const handle = resume(key, id);
      return {
        key: handle.key, uploadId: handle.uploadId,
        uploadPart: handle.uploadPart.bind(handle),
        async complete(parts) {
          assemblies++;
          if (assemblies === 1) {
            assemblyEntered.resolve();
            await assemblyRelease.promise;
          }
          return handle.complete(parts);
        },
        abort: handle.abort.bind(handle),
      };
    });
    // Barrier 2: hold the FIRST staged-object deletion. The completer that
    // discovers the hash mismatch reaches it only after persisting its
    // cleanup intent, so at this point that intent is durable.
    const deleteEntered = signal();
    const deleteRelease = signal();
    const del = env.FILES.delete.bind(env.FILES);
    let stagedDeletes = 0;
    vi.spyOn(env.FILES, "delete").mockImplementation((async (key: string | string[]) => {
      if (typeof key === "string" && key.startsWith("uploads/")) {
        stagedDeletes++;
        if (stagedDeletes === 1) {
          deleteEntered.resolve();
          await deleteRelease.promise;
        }
      }
      return del(key as never);
    }) as never);
    // Barrier 3: hold the SECOND staged-object read (the late completer's
    // verification read). Reaching it means the late completer has already
    // recorded its assembly acknowledgement; holding the read itself (before
    // call-through) lets the cleanup completer finish deleting first.
    const readEntered = signal();
    const readRelease = signal();
    const get = env.FILES.get.bind(env.FILES);
    let stagedReads = 0;
    vi.spyOn(env.FILES, "get").mockImplementation((async (key: string, options?: unknown) => {
      if (typeof key === "string" && key.startsWith("uploads/")) {
        stagedReads++;
        if (stagedReads === 2) {
          readEntered.resolve();
          await readRelease.promise;
        }
      }
      return get(key, options as never);
    }) as never);

    const completingA = complete(dw, s, p.token);
    let resultA;
    let resultB;
    try {
      await bounded(Promise.race([assemblyEntered.promise, completingA.then(() => { throw new Error("completer A returned before reaching R2 assembly"); })]));
      const completingB = complete(dw, s, p.token);
      await bounded(Promise.race([deleteEntered.promise, completingB.then(() => { throw new Error("completer B returned before reaching staged deletion"); })]));
      assemblyRelease.resolve();
      await bounded(Promise.race([readEntered.promise, completingA.then(() => { throw new Error("completer A returned before its verification read"); })]));
      deleteRelease.resolve();
      resultB = await bounded(completingB);
    } finally {
      readRelease.resolve();
      assemblyRelease.resolve();
      deleteRelease.resolve();
      resultA = await bounded(completingA);
    }
    vi.restoreAllMocks();

    // Corrupt bytes must never produce success, from either completer, and
    // every refusal is a shaped API error rather than an unhandled failure.
    for (const result of [resultA, resultB!]) {
      expect(result.status, JSON.stringify(result.body)).toBeGreaterThanOrEqual(400);
      expect(result.body.error?.code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(result.body.error?.hint).toEqual(expect.any(String));
    }
    await unregistered(p.sha256);

    // The interleave must settle into a recoverable/terminal state: retrying
    // complete reaches the terminal hash refusal, or start safely replaces
    // the session. Resuming a completing session whose staged object is gone
    // (complete 502s forever, start returns the same id) is the wedge.
    const retry = await complete(dw, s, p.token);
    let next: Session;
    if (retry.status === 400 && retry.body.error?.code === "hash_mismatch") {
      next = await session(dw, p);
    } else {
      const resumed = await start(dw, p);
      accepted(resumed);
      expect(resumed.body.id, `complete retry was ${retry.status} ${retry.body.error?.code}; start must not resume a session whose staged object was deleted`).not.toBe(s.id);
      next = resumed.body as Session;
    }
    expect(next.id).not.toBe(s.id);
    // The old allocation is out of the unfinished set and its staged storage
    // is owned by nobody: eventually cleaned, never silently leaked.
    const oldRow = await env.DB.prepare("SELECT status FROM upload_sessions WHERE id = ?").bind(s.id).first<{ status: string }>();
    expect(oldRow?.status ?? "gone", "the wedged session must leave the active/completing allocation").not.toBe("completing");
    expect(oldRow?.status ?? "gone").not.toBe("active");
    expect(await env.FILES.head(`uploads/${s.id}`)).toBeNull();

    // Exact-byte replacement flows end to end on the replacement session.
    accepted(await putPart(dw, next, 1, bytes, p.token));
    accepted(await complete(dw, next, p.token));
    accepted(await finalize(dw, p));
    await expectServedExactly(dw, p);
  });
});

// Hold the first promotion write to blob storage, run `invalidate` while the
// verified bytes are in flight to blobs/<sha256>, then release it so the
// physical write lands before the (now refused) metadata registration.
function holdFirstBlobPromotion() {
  const entered = signal();
  const release = signal();
  const put = env.FILES.put.bind(env.FILES);
  let held = false;
  vi.spyOn(env.FILES, "put").mockImplementation((async (key: string, value: unknown, options?: unknown) => {
    if (typeof key === "string" && key.startsWith("blobs/") && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return put(key, value as never, options as never);
  }) as never);
  return {
    async reached(request: Promise<unknown>) {
      await bounded(Promise.race([entered.promise, request.then(() => { throw new Error("complete returned before reaching blob promotion"); })]));
    },
    release: release.resolve,
  };
}

async function blobInventory(sha256: string) {
  return {
    object: await env.FILES.head(`blobs/${sha256}`),
    row: await env.DB.prepare("SELECT sha256 FROM blobs WHERE sha256 = ?").bind(sha256).first(),
    scopes: ((await env.DB.prepare("SELECT scope FROM blob_scopes WHERE sha256 = ?").bind(sha256).all<{ scope: string }>()).results.map((r) => r.scope)),
  };
}

describe("refused owner registration retains durable inventory of promoted bytes", () => {
  it.each(["target deleted", "lifetime expired"] as const)(
    "%s during promotion: refusal confers no scope, and normal cleanup eventually removes the promoted object",
    async (mode) => {
      const { dw, p, s } = await fixture();
      accepted(await putPart(dw, s, 1, bytes, p.token));
      // Live neighbor in the same tenant with different bytes: bounded
      // cleanup below must never touch referenced live data.
      const neighborBytes = new TextEncoder().encode("live neighbor content");
      const q = await pending(dw, await sha256Hex(neighborBytes), neighborBytes.length, "promotion-neighbor");
      const t = await session(dw, q);
      accepted(await putPart(dw, t, 1, neighborBytes, q.token));
      accepted(await complete(dw, t, q.token));
      accepted(await finalize(dw, q));

      const barrier = holdFirstBlobPromotion();
      const completing = complete(dw, s, p.token);
      let result;
      try {
        await barrier.reached(completing);
        if (mode === "target deleted") {
          accepted(await dw.json(`/api/v1/sites/${p.site}`, { method: "DELETE", key: p.key }));
        } else {
          // Capability-created session: its lifetime ends with the upload
          // token's one-hour pending-version window.
          vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_001);
        }
      } finally {
        barrier.release();
        result = await bounded(completing);
      }
      vi.restoreAllMocks();

      // The registration is refused: no success and no ownership scope for
      // the invalidated target.
      expect(result.status, JSON.stringify(result.body)).toBeGreaterThanOrEqual(400);
      expect(result.body.error?.code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(result.body.error?.hint).toEqual(expect.any(String));
      const after = await blobInventory(p.sha256);
      expect(after.scopes, "a refused registration must confer no blob scope").toEqual([]);
      // The promoted object may still be physically present at this point —
      // that is fine only while some durable cleanup obligation (whose shape
      // this test deliberately does not prescribe) represents it. The ticks
      // below are the behavioral proof that such an obligation exists: with
      // none, bounded cleanup has no way to ever find the object.

      // Normal bounded cleanup, advanced past every grace window (deleted-site
      // purge after an hour, orphan blobs after a day), drains the obligation
      // over successive ticks.
      const t0 = Date.now();
      for (const at of [t0 + DAY + 3_600_000, t0 + 2 * DAY + 3_600_000, t0 + 3 * DAY + 3_600_000]) {
        await context(dw, (dc) => runCleanup(dc, at));
        if ((await env.FILES.head(`blobs/${p.sha256}`)) === null) break;
      }
      expect.soft(await env.FILES.head(`blobs/${p.sha256}`),
        "promoted bytes from a refused registration must eventually clean up").toBeNull();
      // The session's staged object is drained by the same normal cleanup.
      expect(await env.FILES.head(`uploads/${s.id}`)).toBeNull();
      // Neighbor control: live referenced data survives those same ticks.
      const neighborServed = await dw.call(`/s/${q.site}/data.bin?raw=1`);
      expect(neighborServed.status).toBe(200);
      expect(new Uint8Array(await neighborServed.arrayBuffer())).toEqual(neighborBytes);
    },
  );

  it("a shared pre-existing verified object survives a refused second registration and later cleanup", async () => {
    const { dw, p, s } = await fixture();
    // A live neighbor site in the same tenant already owns the exact same
    // bytes: blobs/<sha> is shared, referenced, and must not be deleted when
    // this session's own registration is refused.
    const q = await pending(dw, p.sha256, bytes.length, "shared-owner-neighbor");
    const t = await session(dw, q);
    accepted(await putPart(dw, t, 1, bytes, q.token));
    accepted(await complete(dw, t, q.token));
    accepted(await finalize(dw, q));
    await expectServedExactly(dw, q);
    const before = await blobInventory(p.sha256);
    expect(before.object).not.toBeNull();
    expect(before.row).not.toBeNull();
    expect(before.scopes.length).toBeGreaterThan(0);

    accepted(await putPart(dw, s, 1, bytes, p.token));
    const barrier = holdFirstBlobPromotion();
    const completing = complete(dw, s, p.token);
    let result;
    try {
      await barrier.reached(completing);
      accepted(await dw.json(`/api/v1/sites/${p.site}`, { method: "DELETE", key: p.key }));
    } finally {
      barrier.release();
      result = await bounded(completing);
    }
    vi.restoreAllMocks();
    expect(result.status, JSON.stringify(result.body)).toBeGreaterThanOrEqual(400);

    const t0 = Date.now();
    for (const at of [t0 + DAY + 3_600_000, t0 + 2 * DAY + 3_600_000, t0 + 3 * DAY + 3_600_000]) {
      await context(dw, (dc) => runCleanup(dc, at));
    }
    // The refused session's staging drains; the shared object and the
    // neighbor's registration remain, and the neighbor still serves exactly.
    expect(await env.FILES.head(`uploads/${s.id}`)).toBeNull();
    const after = await blobInventory(p.sha256);
    expect(after.object, "cleanup must not delete a shared object a live owner still references").not.toBeNull();
    expect(after.row).not.toBeNull();
    expect(after.scopes).toEqual(before.scopes);
    await expectServedExactly(dw, q);
  });
});
