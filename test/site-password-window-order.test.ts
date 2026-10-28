import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshInstance, type Instance } from "./helpers";
import { attempt, delayedCounterWrite, freezePasswordClock, lockedSite, passwordForm, postForm, SITE_PASSWORD, transferAttempt, WINDOW_MS } from "./site-password-fixtures";
import { create, instance as transferInstance, PASSWORD as TRANSFER_PASSWORD, type Transfer } from "./transfer-fixtures";

interface Bucket { bucket: string; window: number; attempts: number }
async function buckets(): Promise<Bucket[]> {
  return (await env.DB.prepare("SELECT bucket, window, attempts FROM transfer_unlock_buckets ORDER BY bucket").all<Bucket>()).results;
}

async function assertNoRollback(before: Bucket[]) {
  const after = await buckets();
  for (const row of before) {
    const persisted = after.find((candidate) => candidate.bucket === row.bucket);
    expect.soft(persisted, "a delayed reservation cannot delete a current bucket").toBeDefined();
    expect.soft(persisted?.window, "a delayed reservation cannot move any bucket backward").toBeGreaterThanOrEqual(row.window);
    if (persisted?.window === row.window) expect.soft(persisted.attempts, "current attempts cannot be erased").toBeGreaterThanOrEqual(row.attempts);
  }
}

async function transferAllowance(dw: Instance, transfer: Transfer, distributed: boolean): Promise<number> {
  for (let n = 0; n < 200; n++) {
    const res = await transferAttempt(dw, transfer, "wrong-transfer-password", distributed ? `203.0.113.${n + 1}` : "203.0.113.1");
    if (res.status === 429) return n;
    expect(res.status).toBe(403);
  }
  throw new Error("the transfer control did not exhaust its finite allowance");
}

describe.each([
  { name: "path", config: {} },
  { name: "subdomain", config: { appOrigin: "https://app.test", sitesMode: "subdomain" as const, sitesDomain: "sites.test" } },
])("monotonic password counter windows in $name mode", ({ config }) => {
  let windowStart: number;
  beforeEach(() => { windowStart = freezePasswordClock(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    { bucket: "IP", ordinal: 1, allowance: 10 },
    { bucket: "site", ordinal: 2, allowance: 30 },
  ])("a delayed previous-window $bucket reservation cannot erase the current exhausted allowance", async ({ bucket, ordinal, allowance }) => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const form = await passwordForm(dw, url);
    vi.setSystemTime(windowStart + WINDOW_MS - 1);
    const delayed = delayedCounterWrite(ordinal);
    const pending = postForm(dw, form, SITE_PASSWORD, "192.0.2.200", {}, delayed.db);
    let response: Response;
    try {
      await Promise.race([delayed.arrived, pending.then(() => { throw new Error("request completed without reaching the delayed reservation"); })]);
      vi.setSystemTime(windowStart + WINDOW_MS + 5 * 60_000);
      for (let n = 0; n < allowance; n++) {
        expect((await attempt(dw, url, "wrong", bucket === "IP" ? "192.0.2.200" : `192.0.2.${n + 1}`)).status).toBe(401);
      }
      const probeIp = bucket === "IP" ? "192.0.2.200" : "198.51.100.1";
      const exhausted = await attempt(dw, url, SITE_PASSWORD, probeIp);
      expect(exhausted.status, "the current allowance must really be exhausted before the old write arrives").toBe(429);
      expect(exhausted.headers.get("retry-after")).toBe("600");
      const before = await buckets();
      delayed.release();
      response = await pending;
      await assertNoRollback(before);
      expect.soft(response.status, "late previous-window work cannot bypass current admission").toBe(429);
      expect.soft(response.headers.get("set-cookie")).toBeNull();
      const next = await attempt(dw, url, SITE_PASSWORD, probeIp);
      expect.soft(next.status, "the delayed write must not reopen the exhausted current allowance").toBe(429);
      expect.soft(next.headers.get("retry-after")).toBe("600");
      expect.soft(next.headers.get("set-cookie")).toBeNull();
    } finally {
      delayed.release();
      await pending;
    }
  });

  it.each([
    { bucket: "IP", ordinal: 1, distributed: false },
    { bucket: "transfer", ordinal: 2, distributed: true },
  ])("the shared helper also preserves an exhausted transfer $bucket window after a delayed write", async ({ bucket, ordinal, distributed }) => {
    const dw = await transferInstance(config);
    const control = await create(dw, { slug: "control-parcel", password: TRANSFER_PASSWORD });
    const transfer = await create(dw, { slug: "delayed-parcel", password: TRANSFER_PASSWORD });
    const allowance = await transferAllowance(dw, control, distributed);
    expect(allowance).toBeGreaterThan(0);
    const form = await passwordForm(dw, transfer.url);
    vi.setSystemTime(windowStart + WINDOW_MS - 1);
    const delayed = delayedCounterWrite(ordinal);
    const pending = postForm(dw, form, TRANSFER_PASSWORD, "192.0.2.200", { Origin: new URL(transfer.url).origin }, delayed.db);
    try {
      await Promise.race([delayed.arrived, pending.then(() => { throw new Error("request completed without reaching the delayed reservation"); })]);
      vi.setSystemTime(windowStart + WINDOW_MS + 5 * 60_000);
      for (let n = 0; n < allowance; n++) {
        expect((await transferAttempt(dw, transfer, "wrong-transfer-password", distributed ? `192.0.2.${n + 1}` : "192.0.2.200")).status).toBe(403);
      }
      const probeIp = distributed ? "198.51.100.1" : "192.0.2.200";
      expect((await transferAttempt(dw, transfer, TRANSFER_PASSWORD, probeIp)).status, `the current transfer ${bucket} allowance must be exhausted`).toBe(429);
      const before = await buckets();
      delayed.release();
      const response = await pending;
      await assertNoRollback(before);
      expect.soft(response.status).toBe(429);
      expect.soft(response.headers.get("set-cookie")).toBeNull();
      const next = await transferAttempt(dw, transfer, TRANSFER_PASSWORD, probeIp);
      expect.soft(next.status).toBe(429);
      expect.soft(next.headers.get("set-cookie")).toBeNull();
    } finally {
      delayed.release();
      await pending;
    }
  });
});
