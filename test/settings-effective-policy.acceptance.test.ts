/**
 * Acceptance source of truth: GET /api/v1/me already returns caller-effective
 * capabilities, limits, and usage, and /dashboard/settings already serves the
 * shells the effective-policy section extends.
 *
 * Acceptance-owned contract, paired with the RED client suite in
 * packages/server/test/settings-effective-policy.test.ts. The follow-up build
 * runs this file unchanged and must never edit it. Every test here is a
 * passing control on the baseline: if one fails, the foundation moved.
 */

import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { ApiError, CAPABILITIES, type PolicyAdapter } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { BOOTSTRAP, freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";

async function boundJson(dw: Instance, bindings: ServerBindings, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${dw.ownerKey}`);
  const response = await dw.dropway.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("settings effective policy: /me source of truth", () => {
  it("default /me returns global defaults, the full capability vocabulary, and zeroed usage", async () => {
    const dw = await freshInstance();
    const me = await dw.json("/api/v1/me", { key: dw.ownerKey });
    expect(me.status).toBe(200);
    expect(me.body.limits).toMatchObject({
      maxFileBytes: 104857600,
      maxFiles: 2500,
      maxSiteBytes: 10737418240,
      oneShotMaxBytes: 26214400,
    });
    expect(Object.keys(me.body.capabilities).sort()).toEqual([...CAPABILITIES].sort());
    expect(me.body.usage).toMatchObject({ sites: 0, storage_bytes: 0 });
  });

  it("lowered effective limits reach one caller while defaults stay put elsewhere", async () => {
    const policy: PolicyAdapter = {
      limits: (p, _owner, dc) =>
        p.kind === "member" && p.role !== "owner"
          ? { ...dc.config.limits, maxFileBytes: 8388608, maxFiles: 120, maxSiteBytes: 536870912, oneShotMaxBytes: 4194304 }
          : dc.config.limits,
      quota: (p, key, _owner, dc) => {
        if (p.kind !== "member" || p.role === "owner") return dc.config.quotas[key];
        if (key === "sites") return 5;
        if (key === "storage_bytes") return 1073741824;
        return dc.config.quotas[key];
      },
    };
    const dw = await freshInstance({}, { adapters: { policy } });
    for (const slug of ["effective-one", "effective-two"]) {
      const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug }) });
      expect(created.status).toBe(201);
    }
    const member = await dw.json("/api/v1/members", {
      key: dw.ownerKey,
      ...jsonBody({ email: "limited@example.test", role: "member" }),
    });
    expect(member.status).toBe(201);
    const memberMe = await dw.json("/api/v1/me", { key: member.body.apiKey.key });
    expect(memberMe.body.limits).toMatchObject({
      maxFileBytes: 8388608,
      maxFiles: 120,
      maxSiteBytes: 536870912,
      oneShotMaxBytes: 4194304,
      sites: 5,
      storage_bytes: 1073741824,
    });
    expect(memberMe.body.usage).toMatchObject({ sites: 2 });
    const ownerMe = await dw.json("/api/v1/me", { key: dw.ownerKey });
    expect(ownerMe.body.limits).toMatchObject({ maxFileBytes: 104857600, maxFiles: 2500, sites: null });
    const settings = await dw.call("/dashboard/settings");
    expect(settings.status).toBe(200);
    const html = await settings.text();
    expect(html, "the instance section keeps showing configuration defaults").toContain("100 MB");
    expect(html).toContain("2,500");
  });

  it("zero and null quotas round-trip as 0 and null, never coerced", async () => {
    const policy: PolicyAdapter = {
      limits: (_p, _o, dc) => dc.config.limits,
      quota: (_p, key) => (key === "sites" ? 0 : null),
    };
    const dw = await freshInstance({}, { adapters: { policy } });
    const me = await dw.json("/api/v1/me", { key: dw.ownerKey });
    expect(me.status).toBe(200);
    expect(me.body.limits.sites).toBe(0);
    expect(me.body.limits.storage_bytes).toBeNull();
    expect(me.body.limits.maxFiles).toBe(2500);
  });

  it("a custom refusal with markup-looking text stays verbatim for the client to render as text", async () => {
    const message = "Refused for <b>zebrastripe</b> & <img src=x onerror=alert(1)>.";
    const hint = "Ask <i>quillback</i> & retry <script>alert(1)</script>.";
    const policy: PolicyAdapter = {
      limits: (_p, _o, dc) => dc.config.limits,
      capability: (_p, capability) =>
        capability === "site_password"
          ? { allowed: false, error: new ApiError(403, "acme_refused_for_review", message, hint) }
          : { allowed: true },
    };
    const dw = await freshInstance({}, { adapters: { policy } });
    const me = await dw.json("/api/v1/me", { key: dw.ownerKey });
    expect(me.body.capabilities.site_password).toMatchObject({
      allowed: false,
      error: { code: "acme_refused_for_review", message, hint },
    });
    expect(me.body.capabilities.members).toEqual({ allowed: true });
  });

  it("a missing BROWSER binding reports screenshots unavailable even when the adapter allows it", async () => {
    const policy: PolicyAdapter = {
      limits: (_p, _o, dc) => dc.config.limits,
      capability: async () => ({ allowed: true }),
    };
    const dw = await freshInstance({}, { adapters: { policy } });
    const bindings = { ...env } as unknown as ServerBindings & Record<string, unknown>;
    delete bindings.BROWSER;
    const me = await boundJson(dw, bindings, "/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.capabilities.screenshots.allowed).toBe(false);
    expect(me.body.capabilities.screenshots.error.code).toBe("feature_unavailable");
    expect(JSON.stringify(me.body.capabilities.screenshots.error.details.requires)).toContain("BROWSER");
  });

  it("site-scoped and non-admin callers receive the same policy shape", async () => {
    const dw = await freshInstance();
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "scoped-home" }) });
    expect(created.status).toBe(201);
    const scoped = await dw.json("/api/v1/keys", {
      key: dw.ownerKey,
      ...jsonBody({ name: "scoped", scopes: ["sites:read", "sites:write"], site: "scoped-home" }),
    });
    expect(scoped.status).toBe(201);
    const scopedMe = await dw.json("/api/v1/me", { key: scoped.body.key });
    expect(scopedMe.status).toBe(200);
    expect(scopedMe.body.siteRestriction, "site-scoped keys name their site").not.toBeNull();
    for (const field of ["capabilities", "limits", "usage"]) {
      expect(scopedMe.body[field], `site-scoped /me includes ${field}`).toBeDefined();
    }
    const member = await dw.json("/api/v1/members", {
      key: dw.ownerKey,
      ...jsonBody({ email: "plain@example.test", role: "member" }),
    });
    expect(member.status).toBe(201);
    const memberMe = await dw.json("/api/v1/me", { key: member.body.apiKey.key });
    expect(memberMe.body.scopes).not.toContain("members:write");
    for (const field of ["capabilities", "limits", "usage"]) {
      expect(memberMe.body[field], `member /me includes ${field}`).toBeDefined();
    }
  });

  it("the settings page keeps its shells, CSP, and secret hygiene for the follow-up to extend", async () => {
    const dw = await freshInstance();
    const res = await dw.call("/dashboard/settings");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await res.text();
    for (const shell of ["Your account", "Members", "This instance", "Anonymous publishing"]) {
      expect(html).toContain(shell);
    }
    expect(html, "the bootstrap secret value never reaches the page").not.toContain(BOOTSTRAP);
    expect(html, "no API key value is server-rendered").not.toContain(dw.ownerKey);
  });
});
