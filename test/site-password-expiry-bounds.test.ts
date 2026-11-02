import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, refreshLive, setSiteAccess, verifyPassword } from "@kofra/core";
import type { ServerBindings } from "@kofra/server";
import { form, freshInstance, jsonBody, ORIGIN } from "./helpers";
import { attempt, freezePasswordClock, lockedSite, SITE_PASSWORD } from "./site-password-fixtures";

const IP = "192.0.2.10";

async function siteGet(dw: Awaited<ReturnType<typeof freshInstance>>, url: string, cookie: string) {
  return dw.call(url, { headers: { Accept: "text/html", Cookie: cookie } });
}

describe("site-password cookie expiry (M1)", () => {
  beforeEach(() => { freezePasswordClock(); });
  afterEach(() => { vi.useRealTimers(); });

  it("mints an expiring unlock cookie that verifies until its own until, then fails closed", async () => {
    const dw = await freshInstance();
    const url = await lockedSite(dw, "expiry-site");
    const unlocked = await attempt(dw, url, SITE_PASSWORD, IP);
    expect(unlocked.status).toBe(303);
    const setCookie = unlocked.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^dw_pw_expiry_site=\d+\.[a-f0-9]{64}; Path=\/s\/expiry-site\/; Max-Age=604800; HttpOnly; Secure; SameSite=None$/);
    const cookie = setCookie.split(";")[0]!;
    const until = Number(cookie.split("=")[1]!.split(".")[0]);
    expect(Number.isSafeInteger(until)).toBe(true);
    expect(until).toBeGreaterThan(Date.now());
    expect(until).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60_000);

    const page = await siteGet(dw, url, cookie);
    expect(page!.status).toBe(200);
    expect(await page!.text()).toContain("private content");

    // The browser keeps sending the cookie, but the server rejects it past `until`.
    vi.setSystemTime(until + 1000);
    const expired = await siteGet(dw, url, cookie);
    expect(expired!.status).toBe(401);
  });

  it("accepts a fresh cookie on an edge whose clock runs slightly behind", async () => {
    const dw = await freshInstance();
    const url = await lockedSite(dw, "expiry-skew");
    const unlocked = await attempt(dw, url, SITE_PASSWORD, IP);
    expect(unlocked.status).toBe(303);
    const cookie = unlocked.headers.get("set-cookie")!.split(";")[0]!;
    // The issuing edge's clock runs ahead of this validator: a fresh cookie's
    // `until` sits just past our now + TTL, within the same skew the form-token check allows.
    vi.setSystemTime(Date.now() - 30_000);
    const page = await siteGet(dw, url, cookie);
    expect(page!.status).toBe(200);
  });

  it("rejects forged, malformed and pre-change cookies without unlocking", async () => {
    const dw = await freshInstance();
    const url = await lockedSite(dw, "expiry-forgery");
    const unlocked = await attempt(dw, url, SITE_PASSWORD, IP);
    expect(unlocked.status).toBe(303);
    const cookie = unlocked.headers.get("set-cookie")!.split(";")[0]!;
    const name = cookie.split("=")[0]!;
    const [until, signature] = cookie.split("=")[1]!.split(".");

    const forged = `${name}=${until}.${signature!.slice(0, -1)}${signature!.slice(-1) === "0" ? "1" : "0"}`;
    expect((await siteGet(dw, url, forged))!.status).toBe(401);
    // Pre-change cookies were a bare truncated HMAC with no `until`.
    expect((await siteGet(dw, url, `${name}=${"a".repeat(40)}`))!.status).toBe(401);
    for (const malformed of ["not-a-cookie", `${name}=`, `${name}=${until}`, `${name}=abc.${"b".repeat(64)}`, `${name}=${"x".repeat(101)}`]) {
      expect((await siteGet(dw, url, malformed))!.status, malformed).toBe(401);
    }
    // Nothing above mints a session: the password still works afterwards.
    expect((await attempt(dw, url, SITE_PASSWORD, "192.0.2.11")).status).toBe(303);
  });

  it("revokes outstanding cookies when the password rotates", async () => {
    const dw = await freshInstance();
    const url = await lockedSite(dw, "expiry-rotation");
    const unlocked = await attempt(dw, url, SITE_PASSWORD, IP);
    expect(unlocked.status).toBe(303);
    const cookie = unlocked.headers.get("set-cookie")!.split(";")[0]!;
    expect((await siteGet(dw, url, cookie))!.status).toBe(200);

    const rotated = await dw.json("/api/v1/sites/expiry-rotation/access", {
      key: dw.ownerKey, ...jsonBody({ mode: "password", password: "rotated-password-2" }), method: "PUT",
    });
    expect(rotated.status).toBe(200);
    expect((await siteGet(dw, url, cookie))!.status).toBe(401);

    const relocked = await attempt(dw, url, "rotated-password-2", "192.0.2.12");
    expect(relocked.status).toBe(303);
    const fresh = relocked.headers.get("set-cookie")!.split(";")[0]!;
    expect(fresh).not.toBe(cookie);
    expect((await siteGet(dw, url, fresh))!.status).toBe(200);
  });
});

describe("verifyPassword bounds (L2)", () => {
  const password = "some-long-test-password";

  it("accepts the pinned format and rejects a wrong password", async () => {
    const stored = await hashPassword(password);
    expect(await verifyPassword(password, stored)).toBe(true);
    expect(await verifyPassword("another-long-password", stored)).toBe(false);
    expect(await verifyPassword(password, await hashPassword(password, 1))).toBe(true);
  });

  it("returns false instead of throwing for out-of-range iterations", async () => {
    const stored = await hashPassword(password);
    const [, , salt, hash] = stored.split("$");
    for (const iter of ["0", "100001", "1000000", "-5", "abc", "", "10.5", "0x64", "1e5", " 100", "9999999999999999999999"]) {
      await expect(verifyPassword(password, `pbkdf2$${iter}$${salt}$${hash}`)).resolves.toBe(false);
    }
  });

  it("returns false instead of throwing for malformed salt and hash encodings", async () => {
    const stored = await hashPassword(password);
    const [, iter, salt, hash] = stored.split("$");
    const badSalts = [
      salt!.slice(0, 30), `${salt}aa`, salt!.slice(0, 31), salt!.toUpperCase(), "zz".repeat(16), "", "0".repeat(31) + "g",
    ];
    for (const bad of badSalts) {
      await expect(verifyPassword(password, `pbkdf2$${iter}$${bad}$${hash}`)).resolves.toBe(false);
    }
    const badHashes = [
      hash!.slice(0, 62), `${hash}bb`, hash!.toUpperCase(), "", "not hex at all, far too short",
    ];
    for (const bad of badHashes) {
      await expect(verifyPassword(password, `pbkdf2$${iter}$${salt}$${bad}`)).resolves.toBe(false);
    }
    await expect(verifyPassword(password, "pbkdf1$100000$abcdef$1234")).resolves.toBe(false);
    await expect(verifyPassword(password, "pbkdf2$100000$abcdef")).resolves.toBe(false);
  });
});

describe("site-password minimum of 8 (L3)", () => {
  it("rejects newly set 7-character passwords at the API boundary", async () => {
    const dw = await freshInstance();
    const pub = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form({ "index.html": "minimum content" }, { slug: "minimum-site" }),
    });
    expect(pub.status).toBe(201);

    const access = await dw.json("/api/v1/sites/minimum-site/access", {
      key: dw.ownerKey, ...jsonBody({ mode: "password", password: "1234567" }), method: "PUT",
    });
    expect(access.status).toBe(400);
    expect(access.body.error.code).toBe("invalid_request");

    const created = await dw.json("/api/v1/sites", {
      key: dw.ownerKey, ...jsonBody({ slug: "minimum-create", password: "1234567" }),
    });
    expect(created.status).toBe(400);
    // Create-site passes the raw value through to the service, which refuses it.
    expect(created.body.error.code).toBe("invalid_password");
  });

  it("rejects 7-character passwords in the service with invalid_password", async () => {
    const dw = await freshInstance();
    const pub = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form({ "index.html": "minimum content" }, { slug: "minimum-service" }),
    });
    expect(pub.status).toBe(201);
    const ctx = createExecutionContext();
    try {
      const dc = dw.kofra.context(env as unknown as ServerBindings, ctx);
      const principal = await dc.adapters.identity.resolve(
        new Request(`${ORIGIN}/api/v1/me`, { headers: { Authorization: `Bearer ${dw.ownerKey}` } }), dc);
      await expect(setSiteAccess(dc, principal, "minimum-service", { mode: "password", password: "1234567" }))
        .rejects.toMatchObject({ status: 400, code: "invalid_password" });
    } finally { await waitOnExecutionContext(ctx); }
  });

  it("still unlocks a site whose existing password predates the minimum", async () => {
    const dw = await freshInstance();
    const pub = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form({ "index.html": "legacy content" }, { slug: "legacy-short-pw" }),
    });
    expect(pub.status).toBe(201);
    const url: string = pub.body.url;
    // A password set before the 8-character minimum stays stored and keeps working.
    await env.DB.prepare("UPDATE sites SET password_hash = ? WHERE slug = ?")
      .bind(await hashPassword("1234"), "legacy-short-pw").run();
    const ctx = createExecutionContext();
    const site = await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind("legacy-short-pw").first<{ id: string }>();
    await refreshLive(dw.kofra.context(env as unknown as ServerBindings, ctx), site!.id);
    await waitOnExecutionContext(ctx);

    expect((await dw.call(url, { headers: { Accept: "text/html" } })).status).toBe(401);
    const unlocked = await attempt(dw, url, "1234", "192.0.2.50");
    expect(unlocked.status).toBe(303);
    const cookie = unlocked.headers.get("set-cookie")!.split(";")[0]!;
    const page = await siteGet(dw, url, cookie);
    expect(page!.status).toBe(200);
    expect(await page!.text()).toContain("legacy content");
  });
});
