import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { form, freshInstance, jsonBody, type Instance } from "./helpers";

// Privilege boundaries between owners, admins and members, and the API key
// lifecycle checks (expiry, revocation, grant ceilings) that keep a key from
// outliving or outgrowing the member it belongs to.

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

const patch = (v: unknown): RequestInit => ({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });

async function addMember(role: "owner" | "admin" | "member", email: string, key = dw.ownerKey) {
  const res = await dw.json("/api/v1/members", { key, ...jsonBody({ email, role }) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.member.id as string, key: res.body.apiKey.key as string };
}

async function ownerId() {
  return (await dw.json("/api/v1/me", { key: dw.ownerKey })).body.member.id as string;
}

async function roleOf(id: string) {
  return (await env.DB.prepare("SELECT role FROM members WHERE id = ?").bind(id).first<{ role: string }>())?.role;
}

describe("owner role is reserved to owners", () => {
  it("an admin cannot add an owner", async () => {
    const admin = await addMember("admin", "admin@example.com");
    const res = await dw.json("/api/v1/members", { key: admin.key, ...jsonBody({ email: "boss@example.com", role: "owner" }) });
    expect(res.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE email = 'boss@example.com'").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("an admin cannot promote themselves or demote an owner", async () => {
    const admin = await addMember("admin", "admin@example.com");
    // A second owner, so only the role guard (not the last-owner rule) can refuse.
    const coOwner = await addMember("owner", "co@example.com");
    const self = await dw.json(`/api/v1/members/${admin.id}`, { key: admin.key, ...patch({ role: "owner" }) });
    expect(self.status).toBe(403);
    const demote = await dw.json(`/api/v1/members/${coOwner.id}`, { key: admin.key, ...patch({ role: "member" }) });
    expect(demote.status).toBe(403);
    expect(await roleOf(admin.id)).toBe("admin");
    expect(await roleOf(coOwner.id)).toBe("owner");
    // Renaming an owner without touching the role stays allowed.
    const rename = await dw.json(`/api/v1/members/${coOwner.id}`, { key: admin.key, ...patch({ name: "Co" }) });
    expect(rename.status, JSON.stringify(rename.body)).toBe(200);
  });

  it("an admin cannot remove an owner, even when another owner remains", async () => {
    const admin = await addMember("admin", "admin@example.com");
    const coOwner = await addMember("owner", "co@example.com");
    const res = await dw.json(`/api/v1/members/${coOwner.id}`, { method: "DELETE", key: admin.key });
    expect(res.status).toBe(403);
    expect((await dw.json("/api/v1/sites", { key: coOwner.key })).status).toBe(200);
  });

  it("the last owner cannot demote themselves; with a second owner they can", async () => {
    const me = await ownerId();
    const alone = await dw.json(`/api/v1/members/${me}`, { key: dw.ownerKey, ...patch({ role: "admin" }) });
    expect(alone.status).toBe(409);
    expect(alone.body.error.code).toBe("last_owner");
    expect(await roleOf(me)).toBe("owner");
    await addMember("owner", "co@example.com");
    const ok = await dw.json(`/api/v1/members/${me}`, { key: dw.ownerKey, ...patch({ role: "admin" }) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await roleOf(me)).toBe("admin");
  });

  it("a demoted member's existing key loses the scopes the new role cannot hold", async () => {
    const admin = await addMember("admin", "admin@example.com");
    expect((await dw.json("/api/v1/members", { key: admin.key, ...jsonBody({ email: "x@example.com" }) })).status).toBe(201);
    const res = await dw.json(`/api/v1/members/${admin.id}`, { key: dw.ownerKey, ...patch({ role: "member" }) });
    expect(res.status).toBe(200);
    // Same key, no re-issue: members:write is gone with the admin role.
    const again = await dw.json("/api/v1/members", { key: admin.key, ...jsonBody({ email: "y@example.com" }) });
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe("insufficient_scope");
  });
});

describe("API key lifecycle", () => {
  it("an expired key is refused with api_key_expired", async () => {
    const k = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ name: "short", expiresInDays: 1 }) });
    expect(k.status).toBe(201);
    expect(Date.parse(k.body.expiresAt)).toBeGreaterThan(Date.now());
    expect((await dw.json("/api/v1/sites", { key: k.body.key })).status).toBe(200);
    await env.DB.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, k.body.id).run();
    const res = await dw.json("/api/v1/sites", { key: k.body.key });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("api_key_expired");
  });

  it.each([0, -1])("refuses expiresInDays %j", async (expiresInDays) => {
    const res = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ expiresInDays }) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_expiry");
  });

  it("refuses an unknown scope", async () => {
    const unknown = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ scopes: "sites:read sites:everything" }) });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("invalid_scope");
  });

  it("a member cannot revoke another member's key without members:write", async () => {
    const a = await addMember("member", "a@example.com");
    const b = await addMember("member", "b@example.com");
    const bKeys = await dw.json("/api/v1/keys", { key: b.key });
    const bKeyId = bKeys.body.keys?.[0]?.id ?? bKeys.body[0]?.id;
    expect(bKeyId).toMatch(/^key_/);
    const res = await dw.json(`/api/v1/keys/${bKeyId}`, { method: "DELETE", key: a.key });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("key_not_found");
    expect((await dw.json("/api/v1/sites", { key: b.key })).status).toBe(200);
    // The owner holds members:write and may revoke it.
    expect((await dw.json(`/api/v1/keys/${bKeyId}`, { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    expect((await dw.json("/api/v1/sites", { key: b.key })).status).toBe(401);
  });

  it("a member cannot mint a key for someone else", async () => {
    const a = await addMember("member", "a@example.com");
    const res = await dw.json("/api/v1/keys", { key: a.key, ...jsonBody({ memberId: await ownerId() }) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("insufficient_scope");
  });

  it("a key minted for a member is capped by that member's role", async () => {
    const m = await addMember("member", "m@example.com");
    const res = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ memberId: m.id, scopes: ["members:write"] }) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("scope_not_grantable");
    const unknown = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ memberId: "mem_nobody" }) });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("member_not_found");
  });

  it("a site-restricted key cannot mint a key for another site, and its keys stay restricted", async () => {
    for (const slug of ["site-one", "site-two"]) {
      const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": slug }, { slug }) });
      expect(pub.status).toBe(201);
    }
    const one = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ scopes: ["sites:read", "keys:write"], site: "site-one" }) });
    expect(one.status).toBe(201);
    const escape = await dw.json("/api/v1/keys", { key: one.body.key, ...jsonBody({ site: "site-two" }) });
    expect(escape.status).toBe(404);
    expect(escape.body.error.code).toBe("site_not_found");
    const child = await dw.json("/api/v1/keys", { key: one.body.key, ...jsonBody({ name: "child" }) });
    expect(child.status).toBe(201);
    expect(child.body.siteId).toBe(one.body.siteId);
    expect((await dw.json("/api/v1/sites/site-two", { key: child.body.key })).status).toBe(404);
  });

  it("caps active keys per member, and revoking one frees a slot", async () => {
    const m = await addMember("member", "m@example.com");
    for (let i = 1; i < 50; i++) {
      const k = await dw.json("/api/v1/keys", { key: m.key, ...jsonBody({ name: `k${i}` }) });
      expect(k.status).toBe(201);
    }
    const over = await dw.json("/api/v1/keys", { key: m.key, ...jsonBody({ name: "k50" }) });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("key_limit");
    const last = await env.DB.prepare("SELECT id FROM api_keys WHERE member_id = ? AND name = 'k49'").bind(m.id).first<{ id: string }>();
    expect((await dw.json(`/api/v1/keys/${last!.id}`, { method: "DELETE", key: m.key })).status).toBe(200);
    expect((await dw.json("/api/v1/keys", { key: m.key, ...jsonBody({ name: "k50" }) })).status).toBe(201);
  });
});
