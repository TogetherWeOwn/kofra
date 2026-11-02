import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { clearLiveMemoryCache, forbidden, runCleanup } from "@kofra/core";
import type { ServerBindings } from "@kofra/server";
import { form, freshInstance, jsonBody } from "./helpers";

describe("anonymous publishing (opt-in)", () => {
  it("expires after 24h, returns a claim token that can update the site, and can be claimed", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const before = Date.now();
    const pub = await dw.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "anon v1" }) });
    expect(pub.status).toBe(201);
    expect(pub.body.claimToken).toMatch(/^dwc_/);
    expect(pub.body.site.anonymous).toBe(true);
    const expires = Date.parse(pub.body.expiresAt);
    expect(expires - before).toBeGreaterThan(23.9 * 3600_000);
    expect(expires - before).toBeLessThan(24.1 * 3600_000);
    const page = await dw.call(`/s/${pub.body.slug}/`);
    expect(page.headers.get("x-robots-tag")).toBe("noindex");

    // Anonymous callers cannot pick a slug or set a password.
    const named = await dw.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "x" }, { slug: "my-name" }) });
    expect(named.status).toBe(403);

    // The claim token updates the same site.
    const upd = await dw.json("/api/v1/publish", { method: "POST", key: pub.body.claimToken, body: form({ "index.html": "anon v2" }) });
    expect(upd.status).toBe(200);
    expect(upd.body.slug).toBe(pub.body.slug);
    const updatedPage = await dw.call(`/s/${pub.body.slug}/`);
    expect(updatedPage.status).toBe(200);
    const html = await updatedPage.text();
    expect(html).toContain("anon v2");
    expect(html.match(/<a\b[^>]*>Report abuse<\/a>/g)).toHaveLength(1);
    expect(html).toMatch(/position\s*:\s*fixed\b/i);
    // Served anonymous HTML is decorated; raw and authenticated read-back keep the updated bytes.
    const raw = await dw.call(`/s/${pub.body.slug}/?raw=1`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("anon v2");
    const stored = await dw.call(`/api/v1/sites/${pub.body.slug}/files/index.html`, { key: pub.body.claimToken });
    expect(stored.status).toBe(200);
    expect(await stored.text()).toBe("anon v2");

    // Claim into the tenant: no more expiry, token stops working.
    const claim = await dw.json(`/api/v1/sites/${pub.body.slug}/claim`, { key: dw.ownerKey, ...jsonBody({ claimToken: pub.body.claimToken }) });
    expect(claim.status).toBe(200);
    expect(claim.body.site.anonymous).toBe(false);
    expect(claim.body.site.expiresAt).toBeNull();
    const stale = await dw.json("/api/v1/publish", { method: "POST", key: pub.body.claimToken, body: form({ "index.html": "v3" }) });
    expect(stale.status).toBe(401);
  });

  it("expired sites answer 410 and are removed by the hourly cleanup", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const pub = await dw.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "short-lived" }) });
    await env.DB.prepare("UPDATE sites SET expires_at = ? WHERE slug = ?").bind(Date.now() - 1000, pub.body.slug).run();
    await env.CACHE.delete(`live:${pub.body.slug}`);
    clearLiveMemoryCache();
    const gone = await dw.call(`/s/${pub.body.slug}/`);
    expect(gone.status).toBe(410);

    const ctx = createExecutionContext();
    const report = await runCleanup(dw.kofra.context(env as unknown as ServerBindings, ctx));
    await waitOnExecutionContext(ctx);
    expect(report.expiredSites).toBe(1);
    clearLiveMemoryCache();
    expect((await dw.call(`/s/${pub.body.slug}/`)).status).toBe(404);
  });

  it("rate limits anonymous site creation per IP", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true, sitesPerHourPerIp: 2 } });
    const ip = { "CF-Connecting-IP": "203.0.113.9" };
    expect((await dw.json("/api/v1/publish", { method: "POST", headers: ip, body: form({ "index.html": "1" }) })).status).toBe(201);
    expect((await dw.json("/api/v1/publish", { method: "POST", headers: ip, body: form({ "index.html": "2" }) })).status).toBe(201);
    const third = await dw.json("/api/v1/publish", { method: "POST", headers: ip, body: form({ "index.html": "3" }) });
    expect(third.status).toBe(429);
    expect(third.res.headers.get("retry-after")).toBe("3600");
    const other = await dw.json("/api/v1/publish", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.10" }, body: form({ "index.html": "4" }) });
    expect(other.status).toBe(201);
  });

  it("anonymous uploads never dedupe against tenant files (no cross-owner probing)", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "secret.txt": "tenant-only content" }) });
    const anon = await dw.json("/api/v1/publish", { method: "POST", body: form({ "secret.txt": "tenant-only content" }) });
    expect(anon.body.uploaded).toBe(1);
    expect(anon.body.reused).toBe(0);
  });
});

describe("extension points", () => {
  it("hooks fire on publish and policy adapters can refuse", async () => {
    const events: string[] = [];
    const dw = await freshInstance(
      {},
      {
        hooks: { onPublish: (e) => void events.push(`${e.kind}:${e.site.slug}:${e.version.number}`) },
        adapters: {
          policy: {
            limits: (_p, _o, d) => d.config.limits,
            beforeDeploy: (_p, input) => {
              if (input.fileCount > 2) throw forbidden("Too many files for this policy.", "Publish fewer files.", "policy_denied");
            },
          },
        },
        routes: [({ api }) => api.get("/ping", (c) => c.json({ pong: c.get("principal").kind }))],
      },
    );
    await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "x" }, { slug: "hooked" }) });
    expect(events).toEqual(["deploy:hooked:1"]);
    const blocked = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "a.txt": "1", "b.txt": "2", "c.txt": "3" }) });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("policy_denied");
    const ping = await dw.json("/api/v1/ping", { key: dw.ownerKey });
    expect(ping.body).toEqual({ pong: "member" });
  });
});
