import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { runCleanup } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, type Instance } from "./helpers";

const NOW = 1_800_000_000_000;

type KeyRow = {
  key_hash: string;
  input_hash: string;
  owner_token: string;
  state: "pending" | "done";
  result_json: string | null;
  expires_at: number;
};

function row(key: string, state: KeyRow["state"], expiresAt: number): KeyRow {
  return {
    key_hash: key,
    input_hash: `input-${key}`,
    owner_token: `owner-${key}`,
    state,
    // Deliberate whitespace/Unicode catches reserialization of retained results.
    result_json: state === "done" ? '{ "claimToken": "disposable-fixture-only", "label": "雪", "status": "live" }\n' : null,
    expires_at: expiresAt,
  };
}

async function seed(rows: KeyRow[]) {
  for (let start = 0; start < rows.length; start += 100) {
    await env.DB.batch(rows.slice(start, start + 100).map((value) => env.DB.prepare(
      "INSERT INTO idempotency_keys (key_hash, input_hash, owner_token, state, result_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(value.key_hash, value.input_hash, value.owner_token, value.state, value.result_json, value.expires_at)));
  }
}

async function stored() {
  return (await env.DB.prepare("SELECT * FROM idempotency_keys ORDER BY expires_at, key_hash").all<KeyRow>()).results;
}

async function cleanup(dw: Instance) {
  const ctx = createExecutionContext();
  try {
    await runCleanup(dw.dropway.context(env as unknown as ServerBindings, ctx), NOW);
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

describe("publish v2 idempotency-record retention", () => {
  it.each(["done", "pending"] as const)("deletes expired %s rows, including expiry exactly at the supplied cleanup time", async (state) => {
    const dw = await freshInstance();
    await seed([
      row("expired-long-ago", state, NOW - 86_400_000),
      row("expired-one-millisecond-ago", state, NOW - 1),
      row("expires-exactly-now", state, NOW),
    ]);
    expect(await stored()).toHaveLength(3);

    await cleanup(dw);

    expect(await stored()).toEqual([]);
  });

  it("preserves future pending and done records byte-for-byte across repeated cleanup", async () => {
    const dw = await freshInstance();
    const active = [row("active-pending", "pending", NOW + 1), row("active-done", "done", NOW + 86_400_000)];
    await seed(active);
    expect(await stored()).toEqual(active);

    for (let run = 0; run < 3; run++) {
      await cleanup(dw);
      expect(await stored()).toEqual(active);
    }
  });

  it("deletes at most 500 expired records oldest-first per invocation, then drains the backlog without touching active records", async () => {
    const dw = await freshInstance();
    const backlog = Array.from({ length: 1001 }, (_, index) => row(
      `backlog-${String(1001 - index).padStart(4, "0")}`,
      index % 2 === 0 ? "done" : "pending",
      NOW - 1000 + index,
    ));
    const active = [row("active-pending", "pending", NOW + 1), row("active-done", "done", NOW + 2)];
    // Neither insertion order nor primary-key order matches oldest expiry first.
    await seed([...active, ...backlog.toReversed()]);
    expect(await stored()).toEqual([...backlog, ...active]);

    let remaining = backlog;
    for (let run = 0; remaining.length > 0 && run < backlog.length; run++) {
      await cleanup(dw);
      const records = await stored();
      const expired = records.filter((value) => value.expires_at <= NOW);
      const deleted = remaining.length - expired.length;
      expect(deleted).toBeGreaterThan(0);
      expect(deleted).toBeLessThanOrEqual(500);
      if (run === 0) expect(expired.length).toBeGreaterThan(0);
      expect(expired).toEqual(remaining.slice(deleted));
      expect(records.filter((value) => value.expires_at > NOW)).toEqual(active);
      remaining = expired;
    }

    expect(await stored()).toEqual(active);
    await cleanup(dw);
    expect(await stored()).toEqual(active);
  });

  it.each(["pending", "done"] as const)("preserves the current %s owner when an expired key was reclaimed before cleanup", async (state) => {
    const dw = await freshInstance();
    await seed([row("reclaimed-key", "done", NOW - 1)]);
    const successor: KeyRow = {
      ...row("reclaimed-key", state, NOW + 86_400_000),
      input_hash: "successor-input",
      owner_token: "successor-owner-token",
      result_json: state === "done" ? '{ "claimToken": "disposable-successor-only", "status": "live" }\n' : null,
    };
    // Model the committed takeover in real D1; acquisition/fencing races have
    // separate acceptance fixtures. Cleanup must use the current record.
    const update = await env.DB.prepare(
      "UPDATE idempotency_keys SET input_hash = ?, owner_token = ?, state = ?, result_json = ?, expires_at = ? WHERE key_hash = ?",
    ).bind(successor.input_hash, successor.owner_token, successor.state, successor.result_json, successor.expires_at, successor.key_hash).run();
    expect(update.meta.changes).toBe(1);
    expect(await stored()).toEqual([successor]);

    await cleanup(dw);
    await cleanup(dw);

    expect(await stored()).toEqual([successor]);
  });
});
