import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { ServerBindings } from "@dropway/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshInstance, type Instance } from "./helpers";
import { attempt, delayedCounterWrite, freezePasswordClock, lockedSite, passwordForm, postForm, SITE_PASSWORD, transferAttempt, WINDOW_MS } from "./site-password-fixtures";
import { create, instance as transferInstance, PASSWORD as TRANSFER_PASSWORD } from "./transfer-fixtures";

async function bodyProbe(dw: Instance, url: string, ip: string, password = SITE_PASSWORD) {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    pulls++;
    controller.enqueue(new TextEncoder().encode(new URLSearchParams({ password }).toString()));
    controller.close();
  } }, { highWaterMark: 0 });
  const req = new Request(new URL("__dropway/password", url), {
    method: "POST", headers: { "CF-Connecting-IP": ip, "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  const ctx = createExecutionContext();
  try {
    const res = await dw.dropway.fetch(req, env as unknown as ServerBindings, ctx);
    await waitOnExecutionContext(ctx);
    return { res, pulls, bodyUsed: req.bodyUsed };
  } finally {
    if (req.body && !req.body.locked) await req.body.cancel();
  }
}

async function transferIpAllowance(dw: Instance, transfer: Awaited<ReturnType<typeof create>>, ip: string): Promise<number> {
  for (let n = 0; n < 200; n++) {
    const res = await transferAttempt(dw, transfer, "wrong-transfer-password", ip);
    if (res.status === 429) return n;
    expect(res.status).toBe(403);
  }
  throw new Error("transfer positive control did not reach its finite IP allowance");
}

describe.each([
  { name: "path", config: {} },
  { name: "subdomain", config: { appOrigin: "https://app.test", sitesMode: "subdomain" as const, sitesDomain: "sites.test" } },
])("site password throttling in $name mode", ({ config }) => {
  let windowStart: number;
  beforeEach(() => { windowStart = freezePasswordClock(); });
  afterEach(() => { vi.useRealTimers(); });

  it("blocks a single IP before accepting further passwords, without blocking existing cookies", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const unlocked = await attempt(dw, url, SITE_PASSWORD, "192.0.2.1");
    expect(unlocked.status).toBe(303);
    const cookie = unlocked.headers.get("set-cookie")!.split(";")[0]!;
    for (let n = 0; n < 10; n++) expect((await attempt(dw, url, `bad${n}`, "192.0.2.2")).status).toBe(401);
    const limited = await attempt(dw, url, SITE_PASSWORD, "192.0.2.2");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
    expect(limited.headers.get("set-cookie")).toBeNull();
    expect(limited.headers.get("cache-control")).toContain("no-store");
    expect(limited.headers.get("access-control-allow-origin")).toBeNull();
    vi.setSystemTime(windowStart + 423_456);
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.2")).headers.get("retry-after")).toBe("477");
    const content = await dw.call(url, { headers: { Cookie: cookie, "CF-Connecting-IP": "192.0.2.2" } });
    expect(content.status).toBe(200);
    expect(await content.text()).toContain("private content");
  });

  it("shares the IP budget across ordinary sites", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    for (let n = 0; n < 10; n++) {
      expect((await attempt(dw, n % 2 ? url : other, `bad${n}`, "192.0.2.1")).status).toBe(401);
    }
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.1")).status).toBe(429);
    expect((await attempt(dw, other, SITE_PASSWORD, "192.0.2.1")).status).toBe(429);
    expect((await attempt(dw, other, SITE_PASSWORD, "192.0.2.2")).status).toBe(303);
  });

  it("limits distributed guesses for a site without blocking another site", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    for (let n = 0; n < 30; n++) expect((await attempt(dw, url, `bad${n}`, `192.0.2.${n + 1}`)).status).toBe(401);
    const limited = await attempt(dw, url, SITE_PASSWORD, "198.51.100.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
    expect(limited.headers.get("set-cookie")).toBeNull();
    expect(limited.headers.get("cache-control")).toContain("no-store");
    expect(limited.headers.get("access-control-allow-origin")).toBeNull();
    vi.setSystemTime(windowStart + 423_456);
    const remaining = await attempt(dw, url, SITE_PASSWORD, "198.51.100.2");
    expect(remaining.status).toBe(429);
    expect(remaining.headers.get("retry-after")).toBe("477");
    expect((await attempt(dw, other, SITE_PASSWORD, "198.51.100.3")).status).toBe(303);
  });

  it("atomically caps concurrent guesses from one IP", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const responses = await Promise.all(Array.from({ length: 12 }, (_, n) => attempt(dw, url, `bad${n}`, "192.0.2.1")));
    expect(responses.filter((r) => r.status === 401)).toHaveLength(10);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(2);
    expect(responses.every((r) => !r.headers.has("set-cookie"))).toBe(true);
  });

  it("atomically caps 30 distinct-IP site attempts and renews the exhausted site allowance", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const form = await passwordForm(dw, url);
    const writes = Array.from({ length: 35 }, () => delayedCounterWrite(2));
    const pending = writes.map((write, n) => postForm(dw, form, `bad${n}`, `192.0.2.${n + 1}`, {}, write.db));
    let responses: Response[];
    try {
      // All distinct-IP requests reach the site write before any of those writes execute.
      await Promise.all(writes.map((write, n) => Promise.race([
        write.arrived, pending[n]!.then(() => { throw new Error("request missed the concurrent site reservation barrier"); }),
      ])));
      for (const write of writes) write.release();
      responses = await Promise.all(pending);
    } finally {
      for (const write of writes) write.release();
      await Promise.all(pending);
    }
    expect(responses.filter((r) => r.status === 401)).toHaveLength(30);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(5);
    expect(responses.filter((r) => r.status === 429).every((r) => r.headers.get("retry-after") === "600")).toBe(true);
    expect(responses.every((r) => !r.headers.has("set-cookie"))).toBe(true);
    expect((await attempt(dw, url, SITE_PASSWORD, "198.51.100.1")).status).toBe(429);

    vi.setSystemTime(windowStart + WINDOW_MS + 5 * 60_000);
    expect((await attempt(dw, url, SITE_PASSWORD, "198.51.100.1")).status).toBe(303);
    const renewed = await Promise.all(Array.from({ length: 29 }, (_, n) => attempt(dw, url, "wrong", `203.0.113.${n + 1}`)));
    expect(renewed.every((r) => r.status === 401)).toBe(true);
    const limited = await attempt(dw, url, SITE_PASSWORD, "198.51.100.2");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
  });

  it("renews the exhausted IP budget only after the fixed window expires", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    for (let n = 0; n < 10; n++) expect((await attempt(dw, url, "wrong", "192.0.2.1")).status).toBe(401);
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.1")).status).toBe(429);
    vi.setSystemTime(windowStart + WINDOW_MS + 5 * 60_000);
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.1")).status).toBe(303);
    for (let n = 0; n < 9; n++) expect((await attempt(dw, url, "wrong", "192.0.2.1")).status).toBe(401);
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.1")).status).toBe(429);
  });

  it("counts cookie-less successes without refunding or resetting earlier IP attempts", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    let cookie = "";
    for (let n = 0; n < 10; n++) {
      const success = n === 4 || n === 7;
      const res = await attempt(dw, url, success ? SITE_PASSWORD : "wrong", "192.0.2.1");
      expect(res.status).toBe(success ? 303 : 401);
      if (success) cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    }
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.1")).status).toBe(429);
    expect((await attempt(dw, other, SITE_PASSWORD, "192.0.2.1")).status).toBe(429);
    const content = await dw.call(url, { headers: { Cookie: cookie, "CF-Connecting-IP": "192.0.2.1" } });
    expect(content.status).toBe(200);
    expect(await content.text()).toContain("private content");
    expect((await dw.call(other, { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await attempt(dw, other, SITE_PASSWORD, "192.0.2.2")).status).toBe(303);
  });

  it("counts cookie-less successes without refunding or resetting earlier site attempts", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    let cookie = "";
    for (let n = 0; n < 30; n++) {
      const success = n === 14 || n === 24;
      const res = await attempt(dw, url, success ? SITE_PASSWORD : "wrong", `192.0.2.${n + 1}`);
      expect(res.status).toBe(success ? 303 : 401);
      if (success) cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    }
    expect((await attempt(dw, url, SITE_PASSWORD, "198.51.100.1")).status).toBe(429);
    const content = await dw.call(url, { headers: { Cookie: cookie, "CF-Connecting-IP": "198.51.100.1" } });
    expect(content.status).toBe(200);
    expect(await content.text()).toContain("private content");
    expect((await dw.call(other, { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await attempt(dw, other, SITE_PASSWORD, "198.51.100.2")).status).toBe(303);
  });

  it("does not debit transfer attempts when the ordinary-site IP and site allowances are exhausted", async () => {
    const dw = await transferInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const control = await create(dw, { slug: "control-parcel", password: TRANSFER_PASSWORD });
    const transfer = await create(dw, { slug: "independent-parcel", password: TRANSFER_PASSWORD });
    const allowance = await transferIpAllowance(dw, control, "192.0.2.2");
    expect(allowance).toBeGreaterThan(0);
    for (let n = 0; n < 10; n++) expect((await attempt(dw, url, "wrong", "192.0.2.1")).status).toBe(401);
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.1")).status).toBe(429);
    for (let n = 0; n < 20; n++) expect((await attempt(dw, url, "wrong", `198.51.100.${n + 1}`)).status).toBe(401);
    expect((await attempt(dw, url, SITE_PASSWORD, "198.51.100.100")).status).toBe(429);
    for (let n = 0; n < allowance; n++) {
      const res = await transferAttempt(dw, transfer, n === 0 ? TRANSFER_PASSWORD : "wrong-transfer-password", "192.0.2.1");
      expect(res.status).toBe(n === 0 ? 303 : 403);
    }
    expect((await transferAttempt(dw, transfer, TRANSFER_PASSWORD, "192.0.2.1")).status).toBe(429);
    expect((await transferAttempt(dw, transfer, TRANSFER_PASSWORD, "192.0.2.3")).status).toBe(303);
  });

  it("does not debit ordinary-site attempts when the transfer IP and resource allowances are exhausted", async () => {
    const dw = await transferInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const transfer = await create(dw, { slug: "limited-parcel", password: TRANSFER_PASSWORD });
    const other = await create(dw, { slug: "other-parcel", password: TRANSFER_PASSWORD });
    expect(await transferIpAllowance(dw, transfer, "192.0.2.1")).toBeGreaterThan(0);
    expect((await transferAttempt(dw, other, TRANSFER_PASSWORD, "192.0.2.1")).status).toBe(429);
    expect((await transferAttempt(dw, other, TRANSFER_PASSWORD, "192.0.2.2")).status).toBe(303);
    let resourceLimited = false;
    for (let n = 0; n < 200; n++) {
      const res = await transferAttempt(dw, transfer, "wrong-transfer-password", `198.51.100.${n + 1}`);
      if (res.status === 429) { resourceLimited = true; break; }
      expect(res.status).toBe(403);
    }
    expect(resourceLimited, "the transfer itself must also be exhausted independently of IP").toBe(true);
    expect((await transferAttempt(dw, transfer, TRANSFER_PASSWORD, "203.0.113.1")).status).toBe(429);
    expect((await transferAttempt(dw, other, TRANSFER_PASSWORD, "203.0.113.1")).status).toBe(303);
    for (let n = 0; n < 10; n++) expect((await attempt(dw, url, n === 0 ? SITE_PASSWORD : "wrong", "192.0.2.1")).status).toBe(n === 0 ? 303 : 401);
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.1")).status).toBe(429);
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.3")).status).toBe(303);
    for (let n = 0; n < 19; n++) expect((await attempt(dw, url, "wrong", `203.0.113.${n + 10}`)).status).toBe(401);
    expect((await attempt(dw, url, SITE_PASSWORD, "203.0.113.100")).status).toBe(429);
  });

  it("uses a shared fallback bucket when the trusted IP header is absent", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    for (let n = 0; n < 10; n++) expect((await attempt(dw, url, "wrong")).status).toBe(401);
    expect((await attempt(dw, url, SITE_PASSWORD)).status).toBe(429);
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.1")).status).toBe(303);
  });

  it.each(["IP", "site"])("rejects an exhausted %s allowance without consuming the request body", async (bucket) => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    for (let n = 0; n < (bucket === "IP" ? 10 : 30); n++) {
      expect((await attempt(dw, url, "wrong", bucket === "IP" ? "192.0.2.1" : `192.0.2.${n + 1}`)).status).toBe(401);
    }
    const probe = await bodyProbe(dw, url, bucket === "IP" ? "192.0.2.1" : "198.51.100.1");
    expect(probe.res.status).toBe(429);
    expect(probe.res.headers.get("retry-after")).toBe("600");
    expect(probe.pulls, "refused work must not read even the first body chunk").toBe(0);
    expect(probe.bodyUsed).toBe(false);
    expect(probe.res.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    { password: SITE_PASSWORD, status: 303, cookie: true },
    { password: "wrong", status: 401, cookie: false },
  ])("consumes an admitted body and verifies the streamed password: $status (probe control)", async ({ password, status, cookie }) => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const probe = await bodyProbe(dw, url, "192.0.2.1", password);
    expect(probe.res.status).toBe(status);
    expect(probe.pulls).toBeGreaterThan(0);
    expect(probe.res.headers.has("set-cookie")).toBe(cookie);
  });

  it("fails closed without reading a body when storage is unavailable, but keeps valid cookies usable", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const unlocked = await attempt(dw, url, SITE_PASSWORD, "192.0.2.1");
    expect(unlocked.status).toBe(303);
    const cookie = unlocked.headers.get("set-cookie")!.split(";")[0]!;
    await env.DB.prepare("DROP TABLE transfer_unlock_buckets").run();
    const probe = await bodyProbe(dw, url, "192.0.2.2");
    expect(probe.res.status).toBe(503);
    expect(probe.pulls).toBe(0);
    expect(probe.bodyUsed).toBe(false);
    expect(Number(probe.res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(probe.res.headers.get("set-cookie")).toBeNull();
    expect(probe.res.headers.get("cache-control")).toContain("no-store");
    expect(await probe.res.text()).not.toContain("private content");
    const content = await dw.call(url, { headers: { Cookie: cookie, "CF-Connecting-IP": "192.0.2.2" } });
    expect(content.status).toBe(200);
    expect(await content.text()).toContain("private content");
  });
});
