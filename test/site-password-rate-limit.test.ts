import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { form, freshInstance, type Instance } from "./helpers";

async function lockedSite(dw: Instance, slug: string): Promise<string> {
  const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "private content" }, { slug }) });
  expect(pub.status).toBe(201);
  const access = await dw.json(`/api/v1/sites/${slug}/access`, {
    method: "PUT", key: dw.ownerKey, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "password", password: "1234" }),
  });
  expect(access.status).toBe(200);
  return pub.body.url;
}

function attempt(dw: Instance, url: string, password: string, ip?: string): Promise<Response> {
  return dw.call(new URL("__dropway/password", url).href, {
    method: "POST", headers: ip ? { "CF-Connecting-IP": ip } : {}, body: new URLSearchParams({ password }),
  });
}

describe.each([
  { name: "path", config: {} },
  { name: "subdomain", config: { appOrigin: "https://app.test", sitesMode: "subdomain" as const, sitesDomain: "sites.test" } },
])("site password throttling in $name mode", ({ config }) => {
  it("blocks a single IP before accepting further passwords, without blocking existing cookies", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const unlocked = await attempt(dw, url, "1234", "192.0.2.1");
    expect(unlocked.status).toBe(303);
    const cookie = unlocked.headers.get("set-cookie")!.split(";")[0]!;
    for (let n = 0; n < 10; n++) expect((await attempt(dw, url, `bad${n}`, "192.0.2.2")).status).toBe(401);
    const limited = await attempt(dw, url, "1234", "192.0.2.2");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("set-cookie")).toBeNull();
    expect(limited.headers.get("cache-control")).toContain("no-store");
    expect(limited.headers.get("access-control-allow-origin")).toBeNull();
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
    expect((await attempt(dw, url, "1234", "192.0.2.1")).status).toBe(429);
    expect((await attempt(dw, other, "1234", "192.0.2.1")).status).toBe(429);
    expect((await attempt(dw, other, "1234", "192.0.2.2")).status).toBe(303);
  });

  it("limits distributed guesses for a site without blocking another site", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const other = await lockedSite(dw, "other-site");
    for (let n = 0; n < 30; n++) expect((await attempt(dw, url, `bad${n}`, `192.0.2.${n + 1}`)).status).toBe(401);
    const limited = await attempt(dw, url, "1234", "198.51.100.1");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("set-cookie")).toBeNull();
    expect(limited.headers.get("cache-control")).toContain("no-store");
    expect(limited.headers.get("access-control-allow-origin")).toBeNull();
    expect((await attempt(dw, other, "1234", "198.51.100.2")).status).toBe(303);
  });
  it("atomically caps concurrent guesses", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const responses = await Promise.all(Array.from({ length: 12 }, (_, n) => attempt(dw, url, `bad${n}`, "192.0.2.1")));
    expect(responses.filter((r) => r.status === 401)).toHaveLength(10);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(2);
    expect(responses.every((r) => !r.headers.has("set-cookie"))).toBe(true);
  });

  it("renews the budget after the fixed window expires", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    for (let n = 0; n < 10; n++) expect((await attempt(dw, url, "wrong", "192.0.2.1")).status).toBe(401);
    expect((await attempt(dw, url, "1234", "192.0.2.1")).status).toBe(429);
    // Simulate persisted buckets from a past window without changing cookie or site clocks.
    await env.DB.prepare("UPDATE transfer_unlock_buckets SET window = 0").run();
    expect((await attempt(dw, url, "1234", "192.0.2.1")).status).toBe(303);
  });

  it("uses a shared fallback bucket when the trusted IP header is absent", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    for (let n = 0; n < 10; n++) expect((await attempt(dw, url, "wrong")).status).toBe(401);
    expect((await attempt(dw, url, "1234")).status).toBe(429);
  });

  it("fails closed when shared attempt storage is unavailable", async () => {
    const dw = await freshInstance(config);
    const url = await lockedSite(dw, "protected-site");
    const unlocked = await attempt(dw, url, "1234", "192.0.2.1");
    expect(unlocked.status).toBe(303);
    const cookie = unlocked.headers.get("set-cookie")!.split(";")[0]!;
    await env.DB.prepare("DROP TABLE transfer_unlock_buckets").run();
    const unavailable = await attempt(dw, url, "1234", "192.0.2.2");
    expect(unavailable.status).toBe(503);
    expect(Number(unavailable.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(unavailable.headers.get("set-cookie")).toBeNull();
    expect(unavailable.headers.get("cache-control")).toContain("no-store");
    expect(await unavailable.text()).not.toContain("private content");
    expect((await dw.call(url, { headers: { Cookie: cookie } })).status).toBe(200);
  });
});
