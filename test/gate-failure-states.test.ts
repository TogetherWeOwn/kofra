import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshInstance } from "./helpers";
import { attempt, freezePasswordClock, lockedSite, passwordForm, postForm, SITE_PASSWORD, WINDOW_MS } from "./site-password-fixtures";
import { create, instance as transferInstance, PASSWORD as TRANSFER_PASSWORD } from "./transfer-fixtures";

/** S3: lockout pages state the wait in minutes instead of "try again later". */
describe("site gate lockout copy", () => {
  let windowStart: number;
  beforeEach(() => { windowStart = freezePasswordClock(); });
  afterEach(() => { vi.useRealTimers(); });

  it("states the IP-budget wait in minutes, rounded up", async () => {
    const dw = await freshInstance();
    const url = await lockedSite(dw, "protected-site");
    for (let n = 0; n < 10; n++) expect((await attempt(dw, url, `bad${n}`, "192.0.2.1")).status).toBe(401);
    const limited = await attempt(dw, url, SITE_PASSWORD, "192.0.2.1", { Accept: "text/html" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
    const html = await limited.text();
    expect(html).toContain("Too many attempts for now");
    expect(html).toContain("about 10 minutes");
    expect(html).toContain("ask whoever sent you the link");
    // The page still carries the site context it always did.
    expect(limited.headers.get("x-kofra-site")).toBe("protected-site");

    vi.setSystemTime(windowStart + 423_456);
    const remaining = await attempt(dw, url, SITE_PASSWORD, "192.0.2.1", { Accept: "text/html" });
    expect(remaining.status).toBe(429);
    expect(remaining.headers.get("retry-after")).toBe("477");
    expect(await remaining.text()).toContain("about 8 minutes");
  });

  it("states the site-budget wait in minutes, floored at about a minute", async () => {
    const dw = await freshInstance();
    const url = await lockedSite(dw, "protected-site");
    for (let n = 0; n < 30; n++) expect((await attempt(dw, url, `bad${n}`, `192.0.2.${n + 1}`)).status).toBe(401);
    vi.setSystemTime(windowStart + WINDOW_MS - 30_000);
    const limited = await attempt(dw, url, SITE_PASSWORD, "198.51.100.1", { Accept: "text/html" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(await limited.text()).toContain("about a minute");
  });

  it("explains an unavailable password check without blaming the visitor", async () => {
    const dw = await freshInstance();
    const url = await lockedSite(dw, "protected-site");
    await env.DB.prepare("DROP TABLE transfer_unlock_buckets").run();
    const res = await attempt(dw, url, SITE_PASSWORD, "192.0.2.2", { Accept: "text/html" });
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Password check unavailable");
    expect(html).toContain("This instance can't check passwords right now.");
    expect(html).not.toContain("private content");
  });
});

describe("transfer unlock lockout copy", () => {
  it("states the wait in minutes on the HTML form", async () => {
    const dw = await transferInstance();
    const transfer = await create(dw, { slug: "limited-parcel", password: TRANSFER_PASSWORD });
    for (let n = 0; n < 10; n++) {
      const form = await passwordForm(dw, transfer.url, "192.0.2.1");
      const res = await postForm(dw, form, "wrong-transfer-password", "192.0.2.1", { Origin: new URL(transfer.url).origin });
      expect(res.status).toBe(403);
    }
    const form = await passwordForm(dw, transfer.url, "192.0.2.1");
    const limited = await postForm(dw, form, "wrong-transfer-password", "192.0.2.1", {
      Accept: "text/html", Origin: new URL(transfer.url).origin,
    });
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    const wait = retryAfter <= 60 ? "about a minute" : `about ${Math.ceil(retryAfter / 60)} minutes`;
    expect(await limited.text()).toContain(`Too many password attempts. Wait ${wait}, then try again.`);
  });
});
