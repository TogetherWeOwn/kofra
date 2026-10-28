import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "./delivery-review-fixtures";
import { freshInstance, type Instance } from "./helpers";
import {
  attempt, delayedCounterRead, delayedCounterWrite, freezePasswordClock, lockedSite, passwordForm, postForm,
  SITE_PASSWORD, transferAttempt, WINDOW_MS,
} from "./site-password-fixtures";
import { create, instance as transferInstance, PASSWORD as TRANSFER_PASSWORD, type Transfer } from "./transfer-fixtures";

// Once an allowance is saturated, refused traffic must stop mutating D1.
// A test-only AFTER INSERT/UPDATE trigger on the real counter table counts
// persisted writes themselves: a conditional statement that matches no row
// may still execute, but it must not fire the trigger, change a row, or
// let attempts grow past the allowance. Positive controls below prove the
// trigger records every admitted write before any "zero more writes" claim.

interface Bucket { bucket: string; window: number; attempts: number }

async function installWriteAudit() {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS counter_write_audit (bucket TEXT NOT NULL, attempts INTEGER NOT NULL)").run();
  await env.DB.prepare("DELETE FROM counter_write_audit").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS counter_write_audit_insert").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS counter_write_audit_update").run();
  await env.DB.prepare(`CREATE TRIGGER counter_write_audit_insert AFTER INSERT ON transfer_unlock_buckets
    BEGIN INSERT INTO counter_write_audit VALUES (NEW.bucket, NEW.attempts); END`).run();
  await env.DB.prepare(`CREATE TRIGGER counter_write_audit_update AFTER UPDATE ON transfer_unlock_buckets
    BEGIN INSERT INTO counter_write_audit VALUES (NEW.bucket, NEW.attempts); END`).run();
}

async function bucketRows(): Promise<Bucket[]> {
  return (await env.DB.prepare("SELECT bucket, window, attempts FROM transfer_unlock_buckets ORDER BY bucket").all<Bucket>()).results;
}

async function auditWrites(bucket?: string): Promise<number> {
  const row = bucket
    ? await env.DB.prepare("SELECT COUNT(*) AS n FROM counter_write_audit WHERE bucket = ?").bind(bucket).first<{ n: number }>()
    : await env.DB.prepare("SELECT COUNT(*) AS n FROM counter_write_audit").first<{ n: number }>();
  return row?.n ?? 0;
}

/** The only row at the allowance ceiling; per-visitor rows stay far below it. */
function saturatedRow(rows: Bucket[], attempts: number): Bucket {
  const matches = rows.filter((row) => row.attempts === attempts);
  expect(matches, `exactly one bucket must be saturated at ${attempts}`).toHaveLength(1);
  return matches[0]!;
}

async function saturatedBodyProbe(dw: Instance, url: string, ip: string) {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    pulls++;
    controller.enqueue(new TextEncoder().encode(new URLSearchParams({ password: SITE_PASSWORD }).toString()));
    controller.close();
  } }, { highWaterMark: 0 });
  try {
    const res = await request(dw, new URL("__dropway/password", url).href, {
      method: "POST", body,
      headers: { "CF-Connecting-IP": ip, "Content-Type": "application/x-www-form-urlencoded" },
    });
    return { res, pulls };
  } finally {
    if (!body.locked) await body.cancel();
  }
}

describe.each([
  { name: "path", config: {} },
  { name: "subdomain", config: { appOrigin: "https://app.test", sitesMode: "subdomain" as const, sitesDomain: "sites.test" } },
])("saturated site password counters in $name mode", ({ config }) => {
  let windowStart: number;
  beforeEach(() => { windowStart = freezePasswordClock(); });
  afterEach(() => { vi.useRealTimers(); });

  it("stops writing once the visitor allowance is exhausted, sequentially and concurrently", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    await installWriteAudit();
    for (let n = 0; n < 10; n++) expect((await attempt(dw, url, "wrong", "192.0.2.1")).status).toBe(401);
    const before = await bucketRows();
    // This visitor is the site's only visitor, so its row and the site row
    // both sit at ten; the row set itself is the saturation snapshot.
    expect(before.map((row) => row.attempts).sort()).toEqual([10, 10]);
    // Positive control: the audit saw all ten admitted visitor writes (and
    // the ten matching site writes), so zero afterwards is meaningful.
    expect(await auditWrites()).toBe(20);

    const probe = await saturatedBodyProbe(dw, url, "192.0.2.1");
    expect.soft(probe.res.status).toBe(429);
    expect.soft(probe.res.headers.get("retry-after")).toBe("600");
    expect.soft(probe.pulls, "saturated refusal must not read the request body").toBe(0);
    expect.soft(probe.res.headers.get("set-cookie")).toBeNull();

    for (let n = 0; n < 5; n++) {
      const refused = await attempt(dw, url, n % 2 ? "wrong" : SITE_PASSWORD, "192.0.2.1");
      expect.soft([refused.status, refused.headers.get("retry-after"), refused.headers.has("set-cookie")]).toEqual([429, "600", false]);
    }
    const concurrent = await Promise.all(Array.from({ length: 12 }, (_, n) => attempt(dw, url, `bad${n}`, "192.0.2.1")));
    expect.soft(concurrent.map((r) => r.status)).toEqual(Array(12).fill(429));
    expect.soft(concurrent.every((r) => !r.headers.has("set-cookie"))).toBe(true);

    expect(await bucketRows(), "saturated refusals must not change any counter row").toEqual(before);
    expect(await auditWrites(), "saturated refusals must not persist any counter write").toBe(20);

    // Renewal still works and mutation resumes in the next window only.
    vi.setSystemTime(windowStart + WINDOW_MS + 5 * 60_000);
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.1")).status).toBe(303);
    expect(await bucketRows()).toEqual(before.map((row) => ({ ...row, window: row.window + 1, attempts: 1 })));
  });

  it("stops writing the site row once the distributed site allowance is exhausted", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    await installWriteAudit();
    for (let n = 0; n < 30; n++) expect((await attempt(dw, url, "wrong", `192.0.2.${n + 1}`)).status).toBe(401);
    const before = await bucketRows();
    const siteBucket = saturatedRow(before, 30);
    expect(await auditWrites(siteBucket.bucket), "positive control: audit saw every admitted site write").toBe(30);

    for (let n = 0; n < 5; n++) {
      const refused = await attempt(dw, url, SITE_PASSWORD, `198.51.100.${n + 1}`);
      expect.soft([refused.status, refused.headers.get("retry-after"), refused.headers.has("set-cookie")]).toEqual([429, "600", false]);
    }
    const concurrent = await Promise.all(Array.from({ length: 8 }, (_, n) => attempt(dw, url, "wrong", `203.0.113.${n + 1}`)));
    expect.soft(concurrent.map((r) => r.status)).toEqual(Array(8).fill(429));

    // Each fresh visitor may still open its own visitor row; the saturated
    // site row itself must be byte-identical and never written again.
    const after = await bucketRows();
    expect(after.filter((row) => before.some((prior) => prior.bucket === row.bucket))).toEqual(before);
    expect(await auditWrites(siteBucket.bucket), "no persisted write may touch the saturated site row").toBe(30);

    expect((await attempt(dw, other, SITE_PASSWORD, "198.51.100.100")).status, "site saturation must not block another site").toBe(303);
    vi.setSystemTime(windowStart + WINDOW_MS + 5 * 60_000);
    expect((await attempt(dw, url, SITE_PASSWORD, "198.51.100.100")).status, "the site allowance renews next window").toBe(303);
    const renewed = (await bucketRows()).find((row) => row.bucket === siteBucket.bucket);
    expect(renewed).toEqual({ bucket: siteBucket.bucket, window: siteBucket.window + 1, attempts: 1 });
  });

  it.each([
    { bucket: "IP", ordinal: 1, allowance: 10 },
    { bucket: "site", ordinal: 2, allowance: 30 },
  ])("a late previous-window $bucket reservation writes nothing into the saturated current window", async ({ bucket, ordinal, allowance }) => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    await installWriteAudit();
    vi.setSystemTime(windowStart + WINDOW_MS - 1);
    const form = await passwordForm(dw, url, "192.0.2.200");
    const delayed = delayedCounterWrite(ordinal);
    const pending = postForm(dw, form, SITE_PASSWORD, "192.0.2.200", {}, delayed.db);
    try {
      await Promise.race([delayed.arrived, pending.then(() => { throw new Error("request completed without reaching the delayed reservation"); })]);
      vi.setSystemTime(windowStart + WINDOW_MS + 5 * 60_000);
      for (let n = 0; n < allowance; n++) {
        expect((await attempt(dw, url, "wrong", bucket === "IP" ? "192.0.2.200" : `192.0.2.${n + 1}`)).status).toBe(401);
      }
      const probeIp = bucket === "IP" ? "192.0.2.200" : "198.51.100.1";
      expect((await attempt(dw, url, SITE_PASSWORD, probeIp)).status, "the current allowance must be exhausted first").toBe(429);
      const before = await bucketRows();
      const writesBefore = await auditWrites();
      // In the site case the delayed request already reserved its visitor
      // row in the previous window; every pre-existing row below must stay
      // identical and no counter write may land after release.
      delayed.release();
      const response = await pending;
      expect.soft(response.status).toBe(429);
      expect.soft(response.headers.get("retry-after")).toBe("600");
      expect.soft(response.headers.get("set-cookie")).toBeNull();
      const after = await bucketRows();
      expect(after.filter((row) => before.some((prior) => prior.bucket === row.bucket)),
        "late work must not mutate a saturated/current row").toEqual(before);
      expect(await auditWrites(), "late work must not persist a counter write").toBe(writesBefore);
    } finally {
      delayed.release();
      await pending;
    }
  });

  it.each([
    { bucket: "visitor", ordinal: 1, allowance: 10 },
    { bucket: "site", ordinal: 2, allowance: 30 },
  ])("admits a valid $bucket submission when its saturated counter renews between refusal and read", async ({ bucket, ordinal, allowance }) => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    await installWriteAudit();

    // Exhaust exactly the target allowance in the current frozen window.
    // The visitor case is this visitor on this site; the site case is
    // distributed across thirty other visitors.
    for (let n = 0; n < allowance; n++) {
      expect((await attempt(dw, url, "wrong", bucket === "visitor" ? "192.0.2.200" : `192.0.2.${n + 1}`)).status).toBe(401);
    }
    const beforeRows = await bucketRows();
    const beforeWrites = await auditWrites();
    const saturated = bucket === "site" ? saturatedRow(beforeRows, allowance) : undefined;
    if (bucket === "visitor") {
      expect(beforeRows.map((row) => row.attempts).sort()).toEqual([10, 10]);
      expect(beforeWrites, "positive control: every admitted write was audited").toBe(20);
    } else {
      expect(beforeWrites, "positive control: every admitted write was audited").toBe(60);
    }

    const targetIp = bucket === "visitor" ? "192.0.2.200" : "198.51.100.200";
    const form = await passwordForm(dw, url, targetIp);
    const delayed = delayedCounterRead(ordinal);
    const pending = postForm(dw, form, SITE_PASSWORD, targetIp, {}, delayed.db);
    let targetVisitorBucket: Bucket | undefined;
    try {
      // The conditional reservation for the target bucket has already run
      // (and, against the snapshot above, could only have matched no row).
      // Its following counter read is the statement now paused.
      await Promise.race([delayed.arrived, pending.then(() => { throw new Error("request completed without pausing before the counter read"); })]);
      expect(delayed.counts()).toEqual({ writes: ordinal, reads: 1 });
      const pausedRows = await bucketRows();
      if (bucket === "visitor") {
        expect(pausedRows, "the refused conditional reservation wrote nothing").toEqual(beforeRows);
        expect(await auditWrites()).toBe(beforeWrites);
      } else {
        // Partial accounting at the pause: this request's visitor
        // reservation (the only new row) already stands in the old window,
        // while the saturated site row is still byte-identical.
        const newRows = pausedRows.filter((row) => !beforeRows.some((prior) => prior.bucket === row.bucket));
        expect(newRows).toHaveLength(1);
        targetVisitorBucket = newRows[0]!;
        expect(targetVisitorBucket.attempts).toBe(1);
        expect(targetVisitorBucket.window).toBe(saturated!.window);
        expect(pausedRows.filter((row) => beforeRows.some((prior) => prior.bucket === row.bucket))).toEqual(beforeRows);
        expect(await auditWrites()).toBe(beforeWrites + 1);
      }

      // Renew the saturated bucket through a real handler in the next
      // window while the first request is still before its counter read.
      // That renewal spends the first attempt of the renewed allowance.
      vi.setSystemTime(windowStart + WINDOW_MS + 5 * 60_000);
      const renewalIp = bucket === "visitor" ? targetIp : "203.0.113.200";
      expect((await attempt(dw, url, "wrong", renewalIp)).status).toBe(401);
      if (bucket === "site") {
        expect((await bucketRows()).find((row) => row.bucket === saturated!.bucket))
          .toEqual({ ...saturated!, window: saturated!.window + 1, attempts: 1 });
      }

      delayed.release();
      const response = await pending;
      expect(response.status, "the retry must admit into the renewed allowance, not keep the old 429").toBe(303);
      const setCookie = response.headers.get("set-cookie");
      expect(setCookie).toContain("HttpOnly");
      const cookie = setCookie!.split(";")[0]!;
      const content = await dw.call(url, { headers: { Cookie: cookie, "CF-Connecting-IP": targetIp } });
      expect(content.status).toBe(200);
      expect(await content.text()).toContain("private content");

      if (bucket === "visitor") {
        // Renewal attempt plus this admitted retry are exactly the first
        // two attempts of both renewed buckets — no more, no fewer.
        expect(await bucketRows()).toEqual(beforeRows.map((row) => ({ ...row, window: row.window + 1, attempts: 2 })));
        expect(await auditWrites()).toBe(beforeWrites + 4);
        // Behaviourally, eight visitor attempts remain on another site...
        for (let n = 0; n < 8; n++) expect((await attempt(dw, other, "wrong", targetIp)).status).toBe(401);
        expect((await attempt(dw, other, SITE_PASSWORD, targetIp)).status).toBe(429);
        // ...and 28 site attempts remain on this site.
        for (let n = 0; n < 28; n++) expect((await attempt(dw, url, "wrong", `198.51.100.${n + 1}`)).status).toBe(401);
        expect((await attempt(dw, url, SITE_PASSWORD, "203.0.113.201")).status).toBe(429);
      } else {
        expect((await bucketRows()).find((row) => row.bucket === saturated!.bucket))
          .toEqual({ ...saturated!, window: saturated!.window + 1, attempts: 2 });
        // The already-spent visitor reservation was not refunded or moved.
        expect((await bucketRows()).find((row) => row.bucket === targetVisitorBucket!.bucket)).toEqual(targetVisitorBucket);
        expect(await auditWrites(), "visitor spend, renewal spend and one retry spend only").toBe(beforeWrites + 4);
        for (let n = 0; n < 28; n++) expect((await attempt(dw, url, "wrong", `198.51.100.${n + 1}`)).status).toBe(401);
        expect((await attempt(dw, url, SITE_PASSWORD, "203.0.113.201")).status).toBe(429);
      }
    } finally {
      delayed.release();
      await pending;
    }
  });
});

async function transferIpAllowance(dw: Instance, transfer: Transfer, ip: string): Promise<number> {
  for (let n = 0; n < 200; n++) {
    const res = await transferAttempt(dw, transfer, "wrong-transfer-password", ip);
    if (res.status === 429) return n;
    expect(res.status).toBe(403);
  }
  throw new Error("the transfer control did not exhaust its finite IP allowance");
}

describe("saturated shared transfer counters", () => {
  beforeEach(() => { freezePasswordClock(); });
  afterEach(() => { vi.useRealTimers(); });

  it("stops writing once the transfer visitor allowance is exhausted", async () => {
    const dw = await transferInstance({});
    const control = await create(dw, { slug: "control-parcel", password: TRANSFER_PASSWORD });
    const allowance = await transferIpAllowance(dw, control, "192.0.2.2");
    expect(allowance).toBeGreaterThan(0);
    const transfer = await create(dw, { slug: "saturated-parcel", password: TRANSFER_PASSWORD });
    await installWriteAudit();
    for (let n = 0; n < allowance; n++) {
      expect((await transferAttempt(dw, transfer, "wrong-transfer-password", "192.0.2.1")).status).toBe(403);
    }
    expect((await transferAttempt(dw, transfer, TRANSFER_PASSWORD, "192.0.2.1")).status,
      "the transfer visitor allowance must be exhausted first").toBe(429);
    const before = await bucketRows();
    const writesBefore = await auditWrites();
    expect(writesBefore, "positive control: audit saw admitted transfer writes").toBeGreaterThan(0);

    for (let n = 0; n < 4; n++) {
      const refused = await transferAttempt(dw, transfer, TRANSFER_PASSWORD, "192.0.2.1");
      expect.soft([refused.status, refused.headers.has("set-cookie")]).toEqual([429, false]);
    }
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => transferAttempt(dw, transfer, TRANSFER_PASSWORD, "192.0.2.1")));
    expect.soft(concurrent.map((r) => r.status)).toEqual(Array(6).fill(429));

    expect(await bucketRows(), "saturated transfer refusals must not change any row").toEqual(before);
    expect(await auditWrites(), "saturated transfer refusals must not persist any write").toBe(writesBefore);
    expect((await transferAttempt(dw, transfer, TRANSFER_PASSWORD, "192.0.2.3")).status,
      "a different visitor keeps the transfer allowance").toBe(303);
  });

  it("stops writing the transfer row once its distributed allowance is exhausted", async () => {
    const dw = await transferInstance({});
    const transfer = await create(dw, { slug: "distributed-parcel", password: TRANSFER_PASSWORD });
    const other = await create(dw, { slug: "neighbour-parcel", password: TRANSFER_PASSWORD });
    await installWriteAudit();
    let allowance = 0;
    for (let n = 0; n < 200; n++) {
      const res = await transferAttempt(dw, transfer, "wrong-transfer-password", `198.51.100.${n + 1}`);
      if (res.status === 429) { allowance = n; break; }
      expect(res.status).toBe(403);
    }
    expect(allowance, "the transfer must exhaust independently of visitor IP").toBeGreaterThan(0);
    const before = await bucketRows();
    // Every distributed visitor row holds a handful of attempts; the single
    // large row is the transfer's own saturated bucket, whatever its key.
    const maxAttempts = Math.max(...before.map((row) => row.attempts));
    const saturated = saturatedRow(before, maxAttempts);
    const saturatedWrites = await auditWrites(saturated.bucket);
    expect(saturatedWrites, "positive control: audit saw admitted transfer-row writes").toBeGreaterThan(0);

    for (let n = 0; n < 4; n++) {
      const refused = await transferAttempt(dw, transfer, TRANSFER_PASSWORD, `203.0.113.${n + 1}`);
      expect.soft([refused.status, refused.headers.has("set-cookie")]).toEqual([429, false]);
    }
    const after = await bucketRows();
    expect(after.filter((row) => before.some((prior) => prior.bucket === row.bucket)),
      "saturated refusals must not change any pre-existing row").toEqual(before);
    expect(await auditWrites(saturated.bucket), "no persisted write may touch the saturated transfer row").toBe(saturatedWrites);
    expect((await transferAttempt(dw, other, TRANSFER_PASSWORD, "203.0.113.100")).status,
      "one saturated transfer must not block another").toBe(303);
  });
});
