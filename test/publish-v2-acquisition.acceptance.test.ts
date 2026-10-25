import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { ApiError, defaultIdentity } from "@dropway/core";
import { freshInstance, jsonBody, type Instance } from "./helpers";
import { connectMcp, type McpTestClient } from "./mcp-helpers";

type Surface = "REST" | "MCP";
type Outcome = { status?: number; isError: boolean; body: Record<string, any> };

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 3000);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function clients(dw: Instance, surface: Surface, headers: Record<string, string> = {}) {
  const connected: McpTestClient[] = [];
  try {
    if (surface === "MCP") {
      connected.push(await connectMcp(dw, dw.ownerKey, { headers }));
      connected.push(await connectMcp(dw, dw.ownerKey, { headers }));
    }
  } catch (error) {
    await Promise.all(connected.map((mcp) => mcp.client.close()));
    throw error;
  }
  return {
    async invoke(index: number, body: Record<string, unknown>, key: string): Promise<Outcome> {
      if (surface === "MCP") {
        const result = await connected[index]!.call("publish_site", { ...body, idempotencyKey: key });
        return { isError: result.isError, body: result.data };
      }
      const init = jsonBody(body);
      const result = await dw.json("/api/v1/publish", { ...init, key: dw.ownerKey, headers: { ...init.headers, ...headers, "Idempotency-Key": key } });
      return { status: result.status, isError: result.status >= 400, body: result.body };
    },
    close: () => Promise.all(connected.map((mcp) => mcp.client.close())),
  };
}

function expectError(result: Outcome, surface: Surface, status: number, code: string) {
  expect(result.isError).toBe(true);
  if (surface === "REST") expect(result.status).toBe(status);
  expect(result.body.error.code).toBe(code);
  if (status === 409) expect(result.body.error.retryable).toBe(true);
}

async function expectRows(sites: number, versions = sites) {
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sites").first<{ n: number }>())?.n).toBe(sites);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>())?.n).toBe(versions);
}

for (const surface of ["REST", "MCP"] as const) describe(`${surface} atomic publish idempotency acquisition`, () => {
  it.each([false, true])("races independent requests before either claims the key (different bodies = %s)", async (different) => {
    const admitted = signal();
    let armed = false;
    let arrivals = 0;
    let executions = 0;
    const dw = await freshInstance({}, { adapters: {
      identity: { async resolve(request, dc) {
        const principal = await defaultIdentity.resolve(request, dc);
        // Rendezvous is BEFORE acquisition, not a hold inside the first publish.
        // Both requests then race the real D1/KV claim; neither storage is mocked.
        if (armed && request.method === "POST" && request.headers.has("X-Acquisition-Race")) {
          arrivals++;
          if (arrivals === 2) admitted.resolve();
          await bounded(admitted.promise, "both independent calls must reach identity before acquisition");
        }
        return principal;
      } },
      policy: { limits: (_p, _o, dc) => dc.config.limits, beforeCreateSite() { executions++; } },
    } });
    const pair = await clients(dw, surface, { "X-Acquisition-Race": "yes" });
    const body = { files: [{ path: "once.txt", content: "first body" }] };
    const other = different ? { files: [{ path: "once.txt", content: "second body" }] } : body;
    try {
      armed = true;
      // No await or winner-entered barrier between these two independent calls.
      const results = await Promise.all([pair.invoke(0, body, "simultaneous"), pair.invoke(1, other, "simultaneous")]);
      armed = false;
      expect(arrivals).toBe(2);
      const winners = results.filter((result) => !result.isError && result.body.replayed !== true);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.body.status).toBe("live");
      if (surface === "REST") expect(winners[0]!.status).toBe(201);
      const loser = results.find((result) => result !== winners[0])!;
      if (different) expectError(loser, surface, 422, "idempotency_key_reused");
      else if (loser.isError) expectError(loser, surface, 409, "idempotency_in_progress");
      else expect(loser.body).toEqual({ ...winners[0]!.body, replayed: true });
      expect(executions).toBe(1);
      await expectRows(1);
      const winnerIndex = results.indexOf(winners[0]!);
      const replay = await pair.invoke(1, winnerIndex === 0 ? body : other, "simultaneous");
      expect(replay.isError).toBe(false);
      expect(replay.body).toEqual({ ...winners[0]!.body, replayed: true });
      expect(executions).toBe(1);
      await expectRows(1);
      const bytes = await dw.call(`/api/v1/sites/${winners[0]!.body.site.slug}/files/once.txt`, { key: dw.ownerKey });
      expect(bytes.status).toBe(200);
      expect(await bytes.text()).toBe(winnerIndex === 0 ? "first body" : different ? "second body" : "first body");
    } finally {
      armed = false;
      admitted.resolve();
      await pair.close();
    }
  });

  it("releases a failed execution's own claim, never the winner's or another key's claim", async () => {
    const failingEntered = signal();
    const fail = signal();
    const guardEntered = signal();
    const releaseGuard = signal();
    let attempts = 0;
    let guardedExecutions = 0;
    const dw = await freshInstance({}, { adapters: { policy: {
      limits: (_p, _o, dc) => dc.config.limits,
      async beforeCreateSite(_principal, input) {
        if (input.slug === "failed-claim-retry" && ++attempts === 1) {
          failingEntered.resolve();
          await fail.promise;
          throw new ApiError(503, "acceptance_publish_failed", "Disposable publish failed.", "Retry the same request.");
        }
        if (input.slug === "unrelated-held-claim") {
          guardedExecutions++;
          guardEntered.resolve();
          await releaseGuard.promise;
        }
      },
    } } });
    const pair = await clients(dw, surface);
    const body = { site: "failed-claim-retry", files: [{ path: "retry.txt", content: "eventually stored once" }] };
    const guardBody = { site: "unrelated-held-claim", files: [{ path: "guard.txt", content: "unrelated claim stays held" }] };
    const failing = pair.invoke(0, body, "retry-own-claim");
    let guarded: Promise<Outcome> | undefined;
    try {
      await bounded(Promise.race([
        failingEntered.promise, failing.then(() => { throw new Error("publish returned before reaching the failure fixture"); }),
      ]), "publish must enter the policy failure fixture");
      // A contender that never acquired the key must not remove the active claim
      // when its conflict or different-body error unwinds.
      expectError(await bounded(pair.invoke(1, body, "retry-own-claim"), "duplicate must not wait for the winner"), surface, 409, "idempotency_in_progress");
      expectError(await pair.invoke(1, { ...body, files: [{ path: "retry.txt", content: "different" }] }, "retry-own-claim"), surface, 422, "idempotency_key_reused");
      expectError(await pair.invoke(1, body, "retry-own-claim"), surface, 409, "idempotency_in_progress");
      expect(attempts).toBe(1);
      await expectRows(0);

      guarded = pair.invoke(1, guardBody, "unrelated-claim");
      await bounded(Promise.race([
        guardEntered.promise, guarded.then(() => { throw new Error("unrelated publish returned before the hold"); }),
      ]), "unrelated claim must be active before the failure");
      fail.resolve();
      expectError(await failing, surface, 503, "acceptance_publish_failed");
      // Own claim must be released on failure so this is a real execution, not a replay.
      const retry = await pair.invoke(0, body, "retry-own-claim");
      expect(retry.isError).toBe(false);
      expect(retry.body.status).toBe("live");
      expect(retry.body.replayed).not.toBe(true);
      expect(attempts).toBe(2);
      expectError(await pair.invoke(0, guardBody, "unrelated-claim"), surface, 409, "idempotency_in_progress");
      expect(guardedExecutions).toBe(1);
      await expectRows(1);
      releaseGuard.resolve();
      const guardResult = await guarded;
      expect(guardResult.isError).toBe(false);
      const replay = await pair.invoke(0, body, "retry-own-claim");
      expect(replay.isError).toBe(false);
      expect(replay.body).toEqual({ ...retry.body, replayed: true });
      const guardReplay = await pair.invoke(1, guardBody, "unrelated-claim");
      expect(guardReplay.isError).toBe(false);
      expect(guardReplay.body).toEqual({ ...guardResult.body, replayed: true });
      expect(attempts).toBe(2);
      expect(guardedExecutions).toBe(1);
      await expectRows(2);
    } finally {
      fail.resolve();
      releaseGuard.resolve();
      await Promise.allSettled([failing, ...(guarded ? [guarded] : [])]);
      await pair.close();
    }
  });

  it("a late failure of an expired claim cannot delete its same-key successor", async () => {
    const oldEntered = signal();
    const failOld = signal();
    const successorEntered = signal();
    const finishSuccessor = signal();
    let successorExecutions = 0;
    const dw = await freshInstance({}, { adapters: { policy: {
      limits: (_p, _o, dc) => dc.config.limits,
      async beforeCreateSite(_principal, input) {
        if (input.slug === "expired-claim-owner") {
          oldEntered.resolve();
          await failOld.promise;
          throw new ApiError(503, "acceptance_old_claim_failed", "Old execution failed.", "Retry the current request.");
        }
        if (input.slug === "successor-claim-owner") {
          successorExecutions++;
          successorEntered.resolve();
          await finishSuccessor.promise;
        }
      },
    } } });
    const pair = await clients(dw, surface);
    const oldBody = { site: "expired-claim-owner", files: [{ path: "old.txt", content: "must never commit" }] };
    const nextBody = { site: "successor-claim-owner", files: [{ path: "new.txt", content: "successor owns this key" }] };
    const old = pair.invoke(0, oldBody, "reclaimed-key");
    let successor: Promise<Outcome> | undefined;
    let duplicate: Promise<Outcome> | undefined;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await bounded(Promise.race([
        oldEntered.promise, old.then(() => { throw new Error("old request did not enter the hold"); }),
      ]), "old claim must be acquired");
      // SPEC 9: keys are retained for 24 h. Advance the clock, not live storage,
      // so a fresh execution may acquire the expired key while the old one hangs.
      clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
      successor = pair.invoke(1, nextBody, "reclaimed-key");
      await bounded(Promise.race([
        successorEntered.promise, successor.then(() => { throw new Error("expired key was not acquired by the successor"); }),
      ]), "successor must own the expired key");
      failOld.resolve();
      expectError(await old, surface, 503, "acceptance_old_claim_failed");
      duplicate = pair.invoke(0, nextBody, "reclaimed-key");
      expectError(await bounded(duplicate, "old failure must not erase the successor's active claim"), surface, 409, "idempotency_in_progress");
      expectError(await pair.invoke(0, oldBody, "reclaimed-key"), surface, 422, "idempotency_key_reused");
      expect(successorExecutions).toBe(1);
      await expectRows(0);
      finishSuccessor.resolve();
      const current = await successor;
      expect(current.isError).toBe(false);
      const replay = await pair.invoke(0, nextBody, "reclaimed-key");
      expect(replay.isError).toBe(false);
      expect(replay.body).toEqual({ ...current.body, replayed: true });
      expect(successorExecutions).toBe(1);
      await expectRows(1);
    } finally {
      failOld.resolve();
      finishSuccessor.resolve();
      await Promise.allSettled([old, ...(successor ? [successor] : []), ...(duplicate ? [duplicate] : [])]);
      clock?.mockRestore();
      await pair.close();
    }
  });
});
