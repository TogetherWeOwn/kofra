import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { ApiError, withIdempotency } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance } from "./helpers";
import { bounded, claims, signal } from "./version-mutation-replay.helpers";

const TTL = 24 * 60 * 60 * 1000;
afterEach(() => { vi.restoreAllMocks(); });

async function fixture() {
  const dw = await freshInstance();
  const ctx = createExecutionContext();
  return { dc: dw.dropway.context(env as unknown as ServerBindings, ctx), flush: () => waitOnExecutionContext(ctx) };
}

const options = () => ({
  scope: "acceptance-credential", operation: "acceptance_version_action", key: "one-intent",
  input: { siteId: "immutable-fixture-site", version: "v1" },
  // A structural variable keeps this acceptance file type-correct before the
  // new optional property exists; the assertion is runtime claim behavior.
  retainOnError: true,
});

describe("opt-in conservative idempotency claim retention", () => {
  it("preserves the original thrown error and a committed effect without releasing its pending claim", async () => {
    const h = await fixture();
    const failure = new Error("post-effect callback failure, not proof of rollback");
    const opts = options();
    let executions = 0;
    const run = async () => {
      executions++;
      await env.CACHE.put("acceptance-committed-action", `execution-${executions}`);
      throw failure;
    };
    try {
      const before = Date.now();
      await expect(withIdempotency(h.dc, opts, run)).rejects.toBe(failure);
      const after = Date.now();
      expect(await env.CACHE.get("acceptance-committed-action")).toBe("execution-1");
      const rows = await claims();
      expect.soft(rows, "callback exception retains, rather than releases, the owner's claim").toHaveLength(1);
      if (rows[0]) {
        expect.soft(rows[0]).toMatchObject({ state: "pending", result_json: null });
        expect.soft(rows[0].expires_at).toBeGreaterThanOrEqual(before + TTL);
        expect.soft(rows[0].expires_at).toBeLessThanOrEqual(after + TTL);
      }
      await expect(withIdempotency(h.dc, opts, run)).rejects.toMatchObject({ status: 409, code: "idempotency_in_progress" });
      expect.soft(executions).toBe(1);
      expect.soft(await env.CACHE.get("acceptance-committed-action")).toBe("execution-1");
    } finally { await h.flush(); }
  });

  it("does not replace the original callback error with a claim-cleanup failure", async () => {
    const h = await fixture();
    const failure = new ApiError(503, "acceptance_original_failure", "Original uncertain failure.", "Do not assume rollback.");
    await env.DB.prepare(`CREATE TRIGGER acceptance_forbid_claim_release BEFORE DELETE ON idempotency_keys
      BEGIN SELECT RAISE(ABORT, 'acceptance unexpected claim release'); END;`).run();
    try {
      await expect(withIdempotency(h.dc, options(), async () => { throw failure; })).rejects.toBe(failure);
      expect((await claims()).map(row => row.state)).toEqual(["pending"]);
    } finally {
      await env.DB.exec("DROP TRIGGER IF EXISTS acceptance_forbid_claim_release");
      await h.flush();
    }
  });

  it.each(["omitted", "false"] as const)("keeps existing publish-style release behavior when retainOnError is %s", async kind => {
    const h = await fixture();
    const failure = new Error("ordinary callback failure");
    const { retainOnError: _retention, ...base } = options();
    const opts = kind === "omitted" ? base : { ...base, retainOnError: false };
    try {
      await expect(withIdempotency(h.dc, opts, async () => { throw failure; })).rejects.toBe(failure);
      expect(await claims()).toEqual([]);
      const result = await withIdempotency(h.dc, opts, async () => ({ receipt: "retried deliberately" }));
      expect(result).toEqual({ result: { receipt: "retried deliberately" }, replayed: false });
    } finally { await h.flush(); }
  });

  it("does not turn an unkeyed callback exception into a replay guarantee", async () => {
    const h = await fixture();
    const failure = new Error("unkeyed failure");
    try {
      await expect(withIdempotency(h.dc, { ...options(), key: null }, async () => { throw failure; })).rejects.toBe(failure);
      expect(await claims()).toEqual([]);
    } finally { await h.flush(); }
  });

  it("never steals a pending claim before 24 hours but permits reclaim after its bounded expiry", async () => {
    const h = await fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const opts = options();
    try {
      await expect(withIdempotency(h.dc, opts, async () => { throw new Error("unknown callback outcome"); })).rejects.toThrow("unknown callback outcome");
      const original = (await claims())[0];
      expect.soft(original).toMatchObject({ state: "pending", expires_at: now + TTL });
      clock.mockReturnValue(now + TTL - 1);
      let earlyExecutions = 0;
      await expect(withIdempotency(h.dc, opts, async () => { earlyExecutions++; return "too early"; }))
        .rejects.toMatchObject({ status: 409, code: "idempotency_in_progress" });
      expect.soft(earlyExecutions).toBe(0);
      expect.soft((await claims())[0]).toEqual(original);
      clock.mockReturnValue(now + TTL + 1);
      const next = { ...opts, input: { ...opts.input, version: "v2" } };
      expect(await withIdempotency(h.dc, next, async () => "new bounded intent")).toEqual({ result: "new bounded intent", replayed: false });
      const successor = (await claims())[0];
      expect(successor).toMatchObject({ state: "done", expires_at: now + 2 * TTL + 1 });
      if (original) expect(successor!.owner_token).not.toBe(original.owner_token);
      expect(await withIdempotency(h.dc, next, async () => "must not execute")).toEqual({ result: "new bounded intent", replayed: true });
    } finally { clock.mockRestore(); await h.flush(); }
  });

  it.each(["late success", "late failure"] as const)("fences %s from an expired owner away from its successor's result", async kind => {
    const h = await fixture();
    const entered = signal();
    const release = signal();
    const opts = options();
    const failure = new Error("late expired-owner callback failure");
    const old = withIdempotency(h.dc, opts, async () => {
      entered.resolve();
      await release.promise;
      if (kind === "late failure") throw failure;
      return { receipt: "expired owner" };
    }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try {
      await bounded(entered.promise, "old owner must acquire a real D1 claim");
      const original = (await claims())[0]!;
      await env.DB.prepare("UPDATE idempotency_keys SET expires_at = ? WHERE key_hash = ?").bind(Date.now() - 1, original.key_hash).run();
      const next = { ...opts, input: { ...opts.input, version: "v2" } };
      const successorResult = await withIdempotency(h.dc, next, async () => ({ receipt: "successor" }));
      expect(successorResult).toEqual({ result: { receipt: "successor" }, replayed: false });
      const successor = await claims();
      expect(successor[0]!.owner_token).not.toBe(original.owner_token);
      release.resolve();
      const settled = await old;
      if (kind === "late failure") expect(settled).toEqual({ ok: false, error: failure });
      else expect(settled).toMatchObject({ ok: true, value: { result: { receipt: "expired owner" } } });
      expect(await claims(), "a late callback may neither overwrite nor delete its successor").toEqual(successor);
      expect(await withIdempotency(h.dc, next, async () => ({ receipt: "must not run" })))
        .toEqual({ result: { receipt: "successor" }, replayed: true });
    } finally { release.resolve(); await old; await h.flush(); }
  });
});
