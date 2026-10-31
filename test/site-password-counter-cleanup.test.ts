import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { runCleanup } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Instance } from "./helpers";
import { attempt, lockedSite, SITE_PASSWORD } from "./site-password-fixtures";
import { create, instance, siteFile, state } from "./transfer-fixtures";

// Scheduled deletion of stale password-counter rows must make bounded
// progress per invocation and eventually drain, never delete retained
// windows, and never disturb the transfer-expiry work sharing the sweep.
// The per-invocation bound mirrors this repository's existing documented
// scheduled-cleanup batch: at most 500 expired records per invocation
// (docs/ARCHITECTURE.md, idempotency-record retention).
const WINDOW_MS = 15 * 60_000;
const NOW = 1_800_000_000_000;
const WINDOW = Math.floor(NOW / WINDOW_MS);
const MAX_PER_INVOCATION = 500;
const BACKLOG = 1001;

interface Bucket { bucket: string; window: number; attempts: number }

const staleRow = (index: number): Bucket => ({
  bucket: `stale-counter-${String(index).padStart(4, "0")}`,
  // All strictly older than the retained adjacent window (WINDOW - 1).
  window: WINDOW - 2 - (index % 5),
  attempts: (index % 30) + 1,
});

async function seed(rows: Bucket[]) {
  for (let start = 0; start < rows.length; start += 100) {
    await env.DB.batch(rows.slice(start, start + 100).map((row) => env.DB.prepare(
      "INSERT INTO transfer_unlock_buckets (bucket, window, attempts) VALUES (?, ?, ?)",
    ).bind(row.bucket, row.window, row.attempts)));
  }
}

async function stored(): Promise<Bucket[]> {
  return (await env.DB.prepare("SELECT bucket, window, attempts FROM transfer_unlock_buckets ORDER BY bucket").all<Bucket>()).results;
}

async function cleanupAt(dw: Instance): Promise<Record<string, number>> {
  const ctx = createExecutionContext();
  try {
    return await runCleanup(dw.dropway.context(env as unknown as ServerBindings, ctx), NOW) as unknown as Record<string, number>;
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

describe("scheduled stale password-counter cleanup", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("drains a stale backlog in bounded batches, retains active windows and still expires transfers", async () => {
    const dw = await instance({});
    const url = await lockedSite(dw, "retained-counter-site");
    const transfer = await create(dw, { slug: "expiring-parcel" });
    await state(transfer, { expires_at: NOW - 1 });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    // A genuine current-window counter written through the real handler.
    expect((await attempt(dw, url, "wrong", "192.0.2.1")).status).toBe(401);

    const backlog = Array.from({ length: BACKLOG }, (_, index) => staleRow(index));
    const retainedSeed: Bucket[] = [
      { bucket: "retained-adjacent", window: WINDOW - 1, attempts: 7 },
      { bucket: "retained-current", window: WINDOW, attempts: 8 },
      { bucket: "retained-future", window: WINDOW + 1, attempts: 9 },
    ];
    await seed([...retainedSeed, ...backlog.toReversed()]);
    const before = await stored();
    const retained = before.filter((row) => row.window >= WINDOW - 1);
    expect(before.filter((row) => row.window < WINDOW - 1), "seeded backlog must exceed one batch").toHaveLength(BACKLOG);
    expect(retained).toEqual(expect.arrayContaining(retainedSeed));
    expect(retained.some((row) => row.window === WINDOW && row.attempts === 1),
      "the real handler must have written a current-window counter").toBe(true);

    let staleBefore = BACKLOG;
    let runs = 0;
    while (staleBefore > 0 && runs < 10) {
      const report = await cleanupAt(dw);
      runs++;
      const rows = await stored();
      const stale = rows.filter((row) => row.window < WINDOW - 1);
      const deleted = staleBefore - stale.length;
      expect.soft(deleted, "every invocation must make progress").toBeGreaterThan(0);
      expect.soft(deleted, "every invocation must stay within the batch bound").toBeLessThanOrEqual(MAX_PER_INVOCATION);
      if (runs === 1) {
        expect.soft(stale.length, "one invocation must not swallow the whole backlog").toBeGreaterThan(0);
        expect.soft(report.expiredTransfers, "transfer expiry sharing the sweep is unchanged").toBe(1);
      } else {
        expect.soft(report.expiredTransfers, "transfer expiry is claimed exactly once").toBe(0);
      }
      expect.soft(rows.filter((row) => row.window >= WINDOW - 1),
        "current, adjacent and future windows survive every invocation byte-for-byte").toEqual(retained);
      staleBefore = stale.length;
    }
    expect(staleBefore, "bounded invocations must eventually drain the backlog").toBe(0);
    expect(runs).toBeGreaterThan(1);
    expect((await dw.call(siteFile(transfer))).status, "the expired transfer stays expired after the sweep").toBe(410);

    const again = await cleanupAt(dw);
    expect(again.expiredTransfers).toBe(0);
    expect(await stored()).toEqual(retained);

    // Retained counters are still live budgets, not stranded rows: the same
    // visitor's current-window allowance continues from the retained count.
    for (let n = 0; n < 9; n++) expect((await attempt(dw, url, "wrong", "192.0.2.1")).status).toBe(401);
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.1")).status).toBe(429);
  });
});
