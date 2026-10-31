import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { ALL_SCOPES, hasScope, requireMember, type MemberPrincipal } from "@dropway/core";
import { BOOTSTRAP, form, freshInstance, jsonBody, type Instance } from "./helpers";

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

describe("setup and bootstrap key", () => {
  it("creates exactly one owner on a single-tenant instance", async () => {
    const again = await dw.json("/api/v1/setup", { key: BOOTSTRAP, ...jsonBody({}) });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_set_up");
    const tenants = await env.DB.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>();
    expect(tenants?.n).toBe(1);
  });

  it("stores only a hash of each API key", async () => {
    const row = await env.DB.prepare("SELECT key_hash, prefix FROM api_keys LIMIT 1").first<{ key_hash: string; prefix: string }>();
    expect(row?.key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.key_hash).not.toContain(dw.ownerKey);
    expect(dw.ownerKey.startsWith(row!.prefix)).toBe(true);
  });

  it("the bootstrap key cannot publish, but can mint a recovery owner key", async () => {
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: BOOTSTRAP, body: form({ "index.html": "x" }) });
    expect(pub.status).toBe(403);
    const rec = await dw.json("/api/v1/setup/recover", { method: "POST", key: BOOTSTRAP });
    expect(rec.status).toBe(201);
    const me = await dw.json("/api/v1/me", { key: rec.body.apiKey.key });
    expect(me.body.member.role).toBe("owner");
  });

  it("rejects unknown and malformed credentials with agent-friendly errors", async () => {
    const bad = await dw.json("/api/v1/sites", { key: "dw_not-a-real-key" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("invalid_api_key");
    expect(bad.body.error.hint).toBeTruthy();
    const none = await dw.json("/api/v1/sites");
    expect(none.status).toBe(401);
    const malformed = await dw.json("/api/v1/sites", { headers: { Authorization: "Basic abc" } });
    expect(malformed.body.error.code).toBe("invalid_authorization");
  });

  it("answers unknown API routes with JSON and a hint", async () => {
    const res = await dw.json("/api/v1/nope", { key: dw.ownerKey });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("route_not_found");
  });
});

describe("scoped API keys and members", () => {
  it("a read-only key can list but not publish", async () => {
    const k = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ name: "reader", scopes: ["sites:read"] }) });
    expect(k.status).toBe(201);
    expect(k.body.scopes).toEqual(["sites:read"]);
    expect((await dw.json("/api/v1/sites", { key: k.body.key })).status).toBe(200);
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: k.body.key, body: form({ "index.html": "x" }) });
    expect(pub.status).toBe(403);
    expect(pub.body.error.code).toBe("insufficient_scope");
  });

  it("a key can never grant more than it holds", async () => {
    const k = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ scopes: "sites:read keys:write" }) });
    const escalate = await dw.json("/api/v1/keys", { key: k.body.key, ...jsonBody({ scopes: ["sites:write"] }) });
    expect(escalate.status).toBe(403);
    expect(escalate.body.error.code).toBe("scope_not_grantable");
  });

  it("a site-restricted key only touches its site", async () => {
    await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "a" }, { slug: "site-one" }) });
    await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "b" }, { slug: "site-two" }) });
    const k = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ name: "deployer", scopes: ["sites:read", "sites:write"], site: "site-one" }) });
    const ok = await dw.json("/api/v1/publish", { method: "POST", key: k.body.key, body: form({ "index.html": "a2" }, { slug: "site-one" }) });
    expect(ok.status).toBe(200);
    const other = await dw.json("/api/v1/sites/site-two", { key: k.body.key });
    expect(other.status).toBe(404);
    const create = await dw.json("/api/v1/publish", { method: "POST", key: k.body.key, body: form({ "index.html": "c" }) });
    expect(create.status).toBe(403);
    const list = await dw.json("/api/v1/sites", { key: k.body.key });
    expect(list.body.sites.map((s: { slug: string }) => s.slug)).toEqual(["site-one"]);
  });

  it("a site-restricted key holds no tenant-wide powers", async () => {
    await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "a" }, { slug: "site-one" }) });
    const other = await dw.json("/api/v1/members", { key: dw.ownerKey, ...jsonBody({ email: "dev@example.com", role: "member" }) });
    const otherKeyId = other.body.apiKey.id;
    // Default scopes ("*") on a site key leave out members:write and admin; asking for them is refused.
    const k = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ name: "site-all", site: "site-one" }) });
    expect(k.status).toBe(201);
    expect(k.body.scopes).not.toContain("members:write");
    expect(k.body.scopes).not.toContain("admin");
    for (const scope of ["members:write", "admin"]) {
      const r = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ site: "site-one", scopes: [scope] }) });
      expect(r.status, scope).toBe(403);
      expect(r.body.error.code).toBe("scope_not_grantable");
    }
    // A site key stored with tenant scopes (e.g. minted before this rule) still cannot use them.
    await env.DB.prepare("UPDATE api_keys SET scopes = ? WHERE id = ?").bind(ALL_SCOPES.join(" "), k.body.id).run();
    const siteKey = k.body.key;
    expect((await dw.json("/api/v1/members", { key: siteKey, ...jsonBody({ email: "x@example.com", role: "admin" }) })).status).toBe(403);
    const patch = await dw.json(`/api/v1/members/${other.body.member.id}`, { ...jsonBody({ role: "admin" }), method: "PATCH", key: siteKey });
    expect(patch.status, JSON.stringify(patch.body)).toBe(403);
    expect((await dw.json(`/api/v1/members/${other.body.member.id}`, { method: "DELETE", key: siteKey })).status).toBe(403);
    expect((await dw.json("/api/v1/keys", { key: siteKey, ...jsonBody({ memberId: other.body.member.id }) })).status).toBe(403);
    const all = await dw.json("/api/v1/keys?all=1", { key: siteKey });
    expect(all.body.keys.map((x: { id: string }) => x.id)).not.toContain(otherKeyId);
    expect((await dw.json(`/api/v1/keys/${otherKeyId}`, { method: "DELETE", key: siteKey })).status).toBe(404);
    // Nothing changed: the other member and their key are intact, and no member was added.
    expect((await dw.json("/api/v1/sites", { key: other.body.apiKey.key })).status).toBe(200);
    const members = await dw.json("/api/v1/members", { key: dw.ownerKey });
    expect(members.body.members.map((m: { email: string; role: string }) => `${m.email}:${m.role}`).sort()).toEqual(["dev@example.com:member", "owner@example.com:owner"]);
    // The key still works on its own site.
    expect((await dw.json("/api/v1/sites/site-one", { key: siteKey })).status).toBe(200);
  });

  it("a site-restricted principal from any identity adapter cannot use tenant-wide scopes", () => {
    const p: MemberPrincipal = {
      kind: "member", tenantId: "t", memberId: "m", role: "owner", scopes: ALL_SCOPES, keyId: null, siteId: "site_1", via: "session", ip: "",
    };
    for (const scope of ["members:write", "admin"] as const) {
      expect(hasScope(p, scope)).toBe(false);
      expect(() => requireMember(p, scope)).toThrow(/restricted to one site/);
    }
    expect(requireMember(p, "sites:write")).toBe(p);
    expect(hasScope({ ...p, siteId: null }, "members:write")).toBe(true);
  });

  it("revoked keys stop working", async () => {
    const k = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ name: "temp" }) });
    const del = await dw.json(`/api/v1/keys/${k.body.id}`, { method: "DELETE", key: dw.ownerKey });
    expect(del.body.revoked).toBe(true);
    expect((await dw.json("/api/v1/sites", { key: k.body.key })).status).toBe(401);
  });

  it("members get their own key; removing a member revokes it; sites stay with the tenant", async () => {
    const m = await dw.json("/api/v1/members", { key: dw.ownerKey, ...jsonBody({ email: "dev@example.com", role: "member" }) });
    expect(m.status).toBe(201);
    const memberKey = m.body.apiKey.key;
    expect(m.body.apiKey.scopes).not.toContain("members:write");
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: memberKey, body: form({ "index.html": "by member" }, { slug: "member-site" }) });
    expect(pub.status).toBe(201);
    // Members cannot manage members.
    expect((await dw.json("/api/v1/members", { key: memberKey, ...jsonBody({ email: "x@example.com" }) })).status).toBe(403);
    // The owner sees the member's site (same tenant).
    expect((await dw.json("/api/v1/sites/member-site", { key: dw.ownerKey })).status).toBe(200);
    await dw.json(`/api/v1/members/${m.body.member.id}`, { method: "DELETE", key: dw.ownerKey });
    expect((await dw.json("/api/v1/sites", { key: memberKey })).status).toBe(401);
    expect((await dw.json("/api/v1/sites/member-site", { key: dw.ownerKey })).status).toBe(200);
  });

  it("the last owner cannot be removed", async () => {
    const me = await dw.json("/api/v1/me", { key: dw.ownerKey });
    const res = await dw.json(`/api/v1/members/${me.body.member.id}`, { method: "DELETE", key: dw.ownerKey });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("last_owner");
  });
});
