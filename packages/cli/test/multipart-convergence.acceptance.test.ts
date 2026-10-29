/**
 * Multipart convergence through the ACTUAL CLI publish code and the ACTUAL
 * SDK transport, with only the network boundary replaced by a deterministic
 * in-memory instance double. File sizes are declared over the 95 MiB
 * multipart threshold; bodies stay tiny because the double accounts parts
 * from session geometry, exactly like the server does from Content-Length.
 *
 * Pinned contracts:
 * - Two distinct large files converge under one isolate's 96 MiB part-buffer
 *   admission bound (server default part geometry is 50 MiB, so two first
 *   parts cannot be in flight together) without burning the SDK's four
 *   quick attempts while a sibling is still making progress. Smaller
 *   geometry, lower effective concurrency and admission-aware waiting are
 *   all acceptable implementation choices; this double models the real
 *   admission arithmetic so each one can pass.
 * - On terminal failure, publish settles/cancels siblings BEFORE it settles:
 *   no part/complete mutation may land after the publish promise settles.
 * - A network-dropped part PUT whose retry overlaps the still-running
 *   original gets retryable 409 part_busy; the client waits/refreshes and
 *   converges with bounded attempts. Arbitrary 409s and nonretryable
 *   part_conflict are never retried.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropwayClient } from "../src/client.ts";
import { publish, type PublishResult, type SourceFile } from "../src/publish.ts";

const MiB = 1024 * 1024;
const LARGE = 96 * MiB;
const ADMISSION_BUDGET = 96 * MiB;
const DEFAULT_PART = 50 * MiB;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

interface FakeSession {
  id: string;
  sha256: string;
  size: number;
  partSize: number;
  parts: Map<number, number>;
  completed: boolean;
  completes: number;
}

type Outcome = { ok: true; v: PublishResult } | { ok: false; e: any };

function errorJson(status: number, code: string, retryable: boolean, retryAfterSeconds: number | null, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({
    error: { code, message: `fixture ${code}`, hint: `fixture hint for ${code}`, retryable, retryAfterSeconds, docs: `/docs/errors#${code}`, next: [] },
    requestId: "fixture-request",
  }), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

class FakeInstance {
  calls: string[] = [];
  sessions = new Map<string, FakeSession>();
  refusals = 0;
  finalizeCalls = 0;
  partAttempts = new Map<string, number>();
  private sizes = new Map<string, number>();
  private sessionSeq = 0;
  private reserved = 0;
  private waiters: Array<{ pred: () => boolean; resolve: () => void }> = [];

  // Test-controlled hooks.
  holdFirstPart = false;
  private heldUsed = false;
  private releaseHeld: () => void = () => {};
  private heldPromise = new Promise<void>((done) => { this.releaseHeld = done; });
  partScript: ((fake: FakeInstance, session: FakeSession, partNumber: number, attempt: number) => Promise<Response | null> | Response | null) | null = null;
  terminalForSha: string | null = null;
  terminalSeen = false;

  releaseFirstPart() { this.releaseHeld(); }

  private notify() {
    const ready = this.waiters.filter((w) => w.pred());
    this.waiters = this.waiters.filter((w) => !ready.includes(w));
    for (const w of ready) w.resolve();
  }

  /** True when the predicate is observed, false when the quiescence bound expires. */
  waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
    if (pred()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = { pred, resolve: () => { clearTimeout(timer); resolve(true); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(pred());
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private partSizeFor(session: FakeSession, partNumber: number) {
    const start = (partNumber - 1) * session.partSize;
    return Math.min(session.partSize, session.size - start);
  }

  private acknowledge(session: FakeSession, partNumber: number) {
    session.parts.set(partNumber, this.partSizeFor(session, partNumber));
    return json({ partNumber, size: this.partSizeFor(session, partNumber), etag: `etag-${session.id}-${partNumber}` }, 201);
  }

  acknowledgeFromScript(session: FakeSession, partNumber: number) {
    session.parts.set(partNumber, this.partSizeFor(session, partNumber));
    this.notify();
  }

  attemptsFor(sessionId: string, partNumber: number) {
    return this.partAttempts.get(`${sessionId}:${partNumber}`) ?? 0;
  }

  private sessionView(session: FakeSession) {
    return {
      id: session.id, versionId: "ver_fake_1", sha256: session.sha256, size: session.size,
      partSize: session.partSize,
      parts: [...session.parts.entries()].map(([partNumber, size]) => ({ partNumber, size, etag: `etag-${session.id}-${partNumber}` })),
      status: session.completed ? "completed" : "active",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
  }

  fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    this.calls.push(`${req.method} ${path}`);
    this.notify();
    try {
      return await this.route(req, path);
    } finally {
      this.notify();
    }
  };

  private async route(req: Request, path: string): Promise<Response> {
    const deploy = /^\/sites\/([^/]+)\/deploys$/.exec(path);
    if (req.method === "POST" && deploy) {
      const body = JSON.parse(await req.text()) as { files: Array<{ sha256: string; size: number }> };
      for (const f of body.files) this.sizes.set(f.sha256, f.size);
      return json({
        unchanged: false,
        deploy: { id: "ver_fake_1", number: 1, siteSlug: deploy[1] },
        missing: body.files.map((f) => f.sha256),
        uploads: body.files.map((f) => ({ sha256: f.sha256, size: f.size, url: `/blobs/${f.sha256}`, method: "PUT" })),
        finalizeUrl: `/sites/${deploy[1]}/deploys/ver_fake_1/finalize`,
      });
    }
    if (req.method === "POST" && path === "/uploads") {
      const body = JSON.parse(await req.text()) as { sha256: string; partSize?: number };
      const existing = [...this.sessions.values()].find((s) => s.sha256 === body.sha256);
      if (existing) return json(this.sessionView(existing));
      const partSize = Number.isInteger(body.partSize) && (body.partSize as number) > 0 ? (body.partSize as number) : DEFAULT_PART;
      const session: FakeSession = {
        id: `upl_fake_${++this.sessionSeq}`, sha256: body.sha256,
        size: this.sizes.get(body.sha256) ?? 0, partSize,
        parts: new Map(), completed: false, completes: 0,
      };
      this.sessions.set(session.id, session);
      return json(this.sessionView(session), 201);
    }
    const partPut = /^\/uploads\/([^/]+)\/parts\/(\d+)$/.exec(path);
    if (req.method === "PUT" && partPut) {
      const session = this.sessions.get(partPut[1]!)!;
      const partNumber = Number(partPut[2]);
      const key = `${session.id}:${partNumber}`;
      const attempt = (this.partAttempts.get(key) ?? 0) + 1;
      this.partAttempts.set(key, attempt);
      await req.body?.cancel().catch(() => {});
      if (this.terminalForSha === session.sha256) {
        this.terminalSeen = true;
        this.notify();
        return errorJson(400, "invalid_part", false, null);
      }
      if (this.partScript) {
        const scripted = await this.partScript(this, session, partNumber, attempt);
        if (scripted) return scripted;
      }
      const size = this.partSizeFor(session, partNumber);
      if (this.holdFirstPart && !this.heldUsed) {
        this.heldUsed = true;
        this.reserved += size;
        this.notify();
        await this.heldPromise;
        this.reserved -= size;
        return this.acknowledge(session, partNumber);
      }
      if (this.reserved + size > ADMISSION_BUDGET) {
        this.refusals++;
        this.notify();
        return errorJson(503, "upload_busy", true, 1, { "Retry-After": "1" });
      }
      this.reserved += size;
      await Promise.resolve();
      this.reserved -= size;
      return this.acknowledge(session, partNumber);
    }
    const getSession = /^\/uploads\/([^/]+)$/.exec(path);
    if (req.method === "GET" && getSession) return json(this.sessionView(this.sessions.get(getSession[1]!)!));
    const completeCall = /^\/uploads\/([^/]+)\/complete$/.exec(path);
    if (req.method === "POST" && completeCall) {
      const session = this.sessions.get(completeCall[1]!)!;
      session.completes++;
      session.completed = true;
      this.notify();
      return json({ sha256: session.sha256, size: session.size, stored: true });
    }
    if (req.method === "PUT" && path.startsWith("/blobs/")) {
      await req.body?.cancel().catch(() => {});
      return json({ stored: true }, 201);
    }
    const finalize = /^\/sites\/([^/]+)\/deploys\/[^/]+\/finalize$/.exec(path);
    if (req.method === "POST" && finalize) {
      this.finalizeCalls++;
      const siteUrl = `https://fake.test/s/${finalize[1]}/`;
      return json({ url: siteUrl, site: { slug: finalize[1], url: siteUrl, currentVersion: { id: "ver_fake_1", number: 1 } }, warnings: [] });
    }
    return errorJson(404, "route_not_found", false, null);
  };
}

function source(path: string, shaChar: string, size = LARGE): SourceFile {
  return { path, size, sha256: shaChar.repeat(64), body: async () => new Uint8Array([7]) };
}

function clientFor(fake: FakeInstance) {
  return new DropwayClient({ api: "https://fake.test", token: "dw_fixture", fetch: fake.fetch, backoffMs: 1 });
}

function track(promise: Promise<PublishResult>): Promise<Outcome> {
  return promise.then((v): Outcome => ({ ok: true, v }), (e): Outcome => ({ ok: false, e }));
}

async function expectNoStrayCallsAfterSettle(fake: FakeInstance) {
  const atSettle = fake.calls.length;
  await new Promise((done) => setTimeout(done, 30));
  expect(fake.calls.length, "no request may land after the publish promise has settled").toBe(atSettle);
}

describe("CLI multipart admission convergence (actual CLI + SDK, fake transport)", () => {
  it("publishes two distinct large files while one part is held at the admission boundary", async () => {
    const fake = new FakeInstance();
    fake.holdFirstPart = true;
    const published = track(publish(clientFor(fake), [source("a.bin", "a"), source("b.bin", "b")], { site: "admission" }));
    // Deterministic release point: admission-aware waiting shows up as extra
    // refusals, smaller geometry as a sibling completing, serialization as
    // quiescence bounded by the waitFor timeout. A publish that already
    // failed also releases the hold so stray work stays observable.
    await Promise.race([
      published,
      fake.waitFor(() => fake.refusals >= 4 || [...fake.sessions.values()].some((s) => s.completed), 2_000),
    ]);
    fake.releaseFirstPart();
    const outcome = await published;
    expect(outcome.ok, outcome.ok ? "" : `publish failed with ${outcome.e?.code ?? outcome.e}`).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.v).toMatchObject({ uploaded: 2, reused: 0, bytesUploaded: 2 * LARGE, files: 2 });
    expect(fake.finalizeCalls).toBe(1);
    expect(fake.sessions.size).toBe(2);
    for (const session of fake.sessions.values()) {
      expect(session.completed).toBe(true);
      expect(session.completes).toBe(1);
    }
    await expectNoStrayCallsAfterSettle(fake);
  }, 30_000);

  it("reports a terminal sibling failure only after in-flight siblings settle, with no stray mutation afterwards", async () => {
    const fake = new FakeInstance();
    fake.holdFirstPart = true;
    fake.terminalForSha = "b".repeat(64);
    const published = track(publish(clientFor(fake), [source("a.bin", "a"), source("b.bin", "b")], { site: "terminal-sibling" }));
    await Promise.race([published, fake.waitFor(() => fake.terminalSeen, 2_000)]);
    fake.releaseFirstPart();
    const outcome = await published;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.e.code).toBe("invalid_part");
    expect(fake.finalizeCalls).toBe(0);
    const bSession = [...fake.sessions.values()].find((s) => s.sha256 === "b".repeat(64));
    if (bSession) expect(fake.attemptsFor(bSession.id, 1), "a nonretryable refusal must not be retried").toBe(1);
    await expectNoStrayCallsAfterSettle(fake);
  }, 30_000);
});

describe("CLI part_busy convergence (actual CLI + SDK, fake transport)", () => {
  it("waits/refreshes through retryable part_busy after a network drop and completes the publish", async () => {
    const fake = new FakeInstance();
    // Attempt 1 drops at the network while the original write continues
    // server-side; attempts 2-5 observe its exclusive claim; by attempt 5
    // the original has landed, so a refresh may skip the part and a re-PUT
    // replays it. Either way the client must outlive the old four-attempt
    // budget instead of failing the whole publish on the first 409.
    fake.partScript = (instance, session, partNumber, attempt) => {
      if (partNumber !== 1) return null;
      if (attempt === 1) throw new Error("fixture network drop");
      if (attempt >= 2 && attempt <= 5) {
        if (attempt === 5) instance.acknowledgeFromScript(session, 1);
        return errorJson(409, "part_busy", true, null);
      }
      return null;
    };
    const outcome = await track(publish(clientFor(fake), [source("big.bin", "c")], { site: "part-busy" }));
    expect(outcome.ok, outcome.ok ? "" : `publish failed with ${outcome.e?.code ?? outcome.e}`).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.v).toMatchObject({ uploaded: 1, files: 1 });
    const session = [...fake.sessions.values()][0]!;
    expect(fake.attemptsFor(session.id, 1)).toBeGreaterThanOrEqual(5);
    expect(session.completes).toBe(1);
    expect(fake.finalizeCalls).toBe(1);
    await expectNoStrayCallsAfterSettle(fake);
  }, 30_000);

  it.each([
    ["part_conflict", false],
    ["version_conflict", true],
  ] as const)("does not retry a part PUT refused with %s (retryable=%s)", async (code, retryable) => {
    const fake = new FakeInstance();
    fake.partScript = (_instance, _session, partNumber, attempt) =>
      partNumber === 1 && attempt === 1 ? errorJson(409, code, retryable, null) : null;
    const outcome = await track(publish(clientFor(fake), [source("big.bin", "d")], { site: `no-retry-${code}` }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.e.code).toBe(code);
    const session = [...fake.sessions.values()][0]!;
    expect(fake.attemptsFor(session.id, 1)).toBe(1);
    expect(session.completes).toBe(0);
    expect(fake.finalizeCalls).toBe(0);
  }, 30_000);

  it("bounds part_busy waiting: a forever-busy part eventually fails instead of retrying without limit", async () => {
    const fake = new FakeInstance();
    fake.partScript = (_instance, _session, partNumber) =>
      partNumber === 1 ? errorJson(409, "part_busy", true, null) : null;
    vi.useFakeTimers();
    let settled = false;
    const published = publish(clientFor(fake), [source("big.bin", "e")], { site: "forever-busy" })
      .then((v): Outcome => ({ ok: true, v }), (e): Outcome => ({ ok: false, e }))
      .then((outcome) => { settled = true; return outcome; });
    let timerFailure: unknown = null;
    try {
      await vi.runAllTimersAsync();
    } catch (e) {
      timerFailure = e;
    }
    expect(timerFailure, "an unbounded retry loop keeps scheduling timers forever").toBeNull();
    expect(settled, "publish must settle under bounded waiting even when the part never frees").toBe(true);
    const outcome = await published;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.e.code).toBe("part_busy");
    const session = [...fake.sessions.values()][0]!;
    expect(fake.attemptsFor(session.id, 1), "waiting must outlive the old immediate-throw behavior").toBeGreaterThanOrEqual(2);
    expect(fake.finalizeCalls).toBe(0);
  }, 30_000);
});

describe("CLI upload_busy beyond the SDK retry window (actual CLI + SDK, fake transport)", () => {
  const sdkAttempts = 4;
  const retryClient = (fake: FakeInstance) => new DropwayClient({
    api: "https://fake.test", token: "dw_fixture", fetch: fake.fetch,
    attempts: sdkAttempts, backoffMs: 1,
  });

  // Removing the outer 503/upload_busy retry must fail this case even when
  // smaller parts mean ordinary two-file publication never needs admission.
  it("outlives the SDK's short upload_busy retries, then completes and finalizes exactly once", async () => {
    vi.useFakeTimers({ loopLimit: 200 });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fake = new FakeInstance();
    const busyLimit = sdkAttempts + 1;
    let busyResponses = 0;
    fake.partScript = (_instance, _session, partNumber, attempt) => {
      if (partNumber !== 1 || attempt > busyLimit) return null;
      busyResponses++;
      return errorJson(503, "upload_busy", true, 1, { "Retry-After": "1" });
    };
    let callsAtSettle: string[] = [];
    const published = track(publish(retryClient(fake), [source("busy.bin", "f")], { site: "outer-upload-busy" }))
      .then((outcome) => { callsAtSettle = [...fake.calls]; return outcome; });
    await vi.runAllTimersAsync();
    const outcome = await published;

    expect(busyResponses, "the fake transport must really return admission refusals").toBeGreaterThan(0);
    expect(outcome.ok, outcome.ok ? "" : `publish failed with ${outcome.e?.code} after ${busyResponses} upload_busy responses`).toBe(true);
    if (!outcome.ok) return;
    expect(busyResponses).toBe(busyLimit);
    expect(outcome.v).toMatchObject({ uploaded: 1, files: 1, bytesUploaded: LARGE });
    expect(fake.sessions.size).toBe(1);
    const session = [...fake.sessions.values()][0]!;
    expect(fake.attemptsFor(session.id, 1), "success must require another CLI attempt after the SDK exhausts its window").toBe(busyLimit + 1);
    expect(session.parts.size).toBe(Math.ceil(LARGE / session.partSize));
    expect(session.completed).toBe(true);
    expect(session.completes).toBe(1);
    expect(fake.finalizeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.calls, "no requests may land after publication settles").toEqual(callsAtSettle);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["upload_busy", false],
    ["service_unavailable", true],
  ] as const)("does not extend the SDK retry window for 503 %s (retryable=%s)", async (code, retryable) => {
    vi.useFakeTimers({ loopLimit: 200 });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fake = new FakeInstance();
    let refusals = 0;
    fake.partScript = (_instance, _session, partNumber) => {
      if (partNumber !== 1) return null;
      refusals++;
      return errorJson(503, code, retryable, 1, { "Retry-After": "1" });
    };
    let callsAtSettle: string[] = [];
    const published = track(publish(retryClient(fake), [source("refused.bin", "f")], { site: `outer-refuses-${code}` }))
      .then((outcome) => { callsAtSettle = [...fake.calls]; return outcome; });
    await vi.runAllTimersAsync();
    const outcome = await published;

    expect(outcome.ok, "only retryable upload_busy can enter the CLI's admission wait").toBe(false);
    if (outcome.ok) return;
    expect(outcome.e).toMatchObject({ status: 503, code, retryable });
    expect(refusals, "the SDK may retry safe 5xx requests, but the outer CLI must not prolong these errors").toBe(sdkAttempts);
    const session = [...fake.sessions.values()][0]!;
    expect(fake.attemptsFor(session.id, 1)).toBe(sdkAttempts);
    expect(session.parts.size).toBe(0);
    expect(session.completes).toBe(0);
    expect(fake.finalizeCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.calls, "terminal refusal leaves no stray requests after settlement").toEqual(callsAtSettle);
    expect(vi.getTimerCount()).toBe(0);
  });
});
