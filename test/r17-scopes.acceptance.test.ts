import { describe, expect, it } from "vitest";
import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { deleteSite, sha256Hex } from "@dropway/core";
import { type ServerBindings } from "@dropway/server";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import { commandRows, registry } from "./operation-fixtures";

// SPEC 11.4 and ROADMAP R-17. These are new keys, not legacy keys upgraded by 0002.
async function keyWith(dw: Instance, scopes: string[], site?: string): Promise<string> {
  const result = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ name: "acceptance", scopes, site }) });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.key;
}

async function publish(dw: Instance, slug: string, content: string) {
  const result = await dw.json("/api/v1/publish", {
    key: dw.ownerKey, ...jsonBody({ slug, files: [{ path: "index.html", content }] }),
  });
  expect([200, 201]).toContain(result.status);
  return result.body;
}

describe("R-17 scope grants", () => {
  it.each(["sites:delete", "data:write", "secrets:write", "admin"])("an owner can mint and authenticate a %s key", async (scope) => {
    const dw = await freshInstance();
    const key = await keyWith(dw, [scope]);
    const me = await dw.json("/api/v1/me", { key });
    expect(me.status).toBe(200);
    expect(me.body.scopes).toEqual([scope]);
  });

  it("an admin can hold all four new scopes", async () => {
    const dw = await freshInstance();
    const member = await dw.json("/api/v1/members", {
      key: dw.ownerKey, ...jsonBody({ email: "admin@example.test", role: "admin" }),
    });
    expect(member.status).toBe(201);
    const me = await dw.json("/api/v1/me", { key: member.body.apiKey.key });
    expect(me.body.scopes).toEqual(expect.arrayContaining(["sites:delete", "data:write", "secrets:write", "admin"]));
  });

  it("members receive delete and data permissions but not administrative or secret permissions", async () => {
    const dw = await freshInstance();
    const member = await dw.json("/api/v1/members", {
      key: dw.ownerKey, ...jsonBody({ email: "member@example.test", role: "member" }),
    });
    expect(member.status).toBe(201);
    expect(member.body.apiKey.scopes).toEqual(expect.arrayContaining(["sites:delete", "data:write"]));
    expect(member.body.apiKey.scopes).not.toEqual(expect.arrayContaining(["secrets:write"]));
    expect(member.body.apiKey.scopes).not.toEqual(expect.arrayContaining(["admin"]));
    const granted = await dw.json("/api/v1/keys", {
      key: member.body.apiKey.key, ...jsonBody({ scopes: ["sites:delete", "data:write"] }),
    });
    expect(granted.status).toBe(201);
  });

  it.each(["admin", "secrets:write"])("a member cannot mint a %s key even when the owner requests it", async (scope) => {
    const dw = await freshInstance();
    const member = await dw.json("/api/v1/members", {
      key: dw.ownerKey, ...jsonBody({ email: "limited@example.test", role: "member", scopes: [scope] }),
    });
    expect(member.status).toBe(403);
    expect(member.body.error.code).toBe("scope_not_grantable");
  });

  it("a narrowed owner key cannot grant the new admin scope", async () => {
    const dw = await freshInstance();
    const key = await keyWith(dw, ["sites:read", "keys:write"]);
    const denied = await dw.json("/api/v1/keys", { key, ...jsonBody({ scopes: ["admin"] }) });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("scope_not_grantable");
  });
});

describe("R-17 deletion authorization", () => {
  it("the core deleteSite service refuses a newly minted write-only key", async () => {
    const dw = await freshInstance();
    await publish(dw, "service-delete", "unchanged");
    const key = await keyWith(dw, ["sites:read", "sites:write"]);
    const ctx = createExecutionContext();
    const dc = dw.dropway.context(env as unknown as ServerBindings, ctx);
    const principal = await dc.adapters.identity.resolve(new Request(`${ORIGIN}/api/v1/me`, { headers: { Authorization: `Bearer ${key}` } }), dc);
    try {
      await expect(deleteSite(dc, principal, "service-delete")).rejects.toMatchObject({ status: 403, code: "insufficient_scope" });
      expect((await dw.json("/api/v1/sites/service-delete", { key: dw.ownerKey })).status).toBe(200);
    } finally {
      await waitOnExecutionContext(ctx);
    }
  });

  it.each(["REST", "MCP"])("%s refuses site deletion with sites:write but no sites:delete", async (surface) => {
    const dw = await freshInstance();
    await publish(dw, "keep-site", "keep");
    const key = await keyWith(dw, ["sites:read", "sites:write"]);
    if (surface === "REST") {
      const result = await dw.json("/api/v1/sites/keep-site", { key, method: "DELETE" });
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("insufficient_scope");
      expect(result.body.error.hint.trim().length).toBeGreaterThan(0);
    } else {
      const mcp = await connectMcp(dw, key);
      try {
        const result = await mcp.call("delete_site", { site: "keep-site", confirm: "keep-site" });
        expect(result.isError).toBe(true);
        expect(result.data.error.code).toBe("insufficient_scope");
      } finally { await mcp.client.close(); }
    }
    expect((await dw.json("/api/v1/sites/keep-site", { key: dw.ownerKey })).status).toBe(200);
  });

  it.each(["REST", "MCP"])("%s refuses non-live version deletion with sites:write alone", async (surface) => {
    const dw = await freshInstance();
    const first = await publish(dw, "keep-history", "first");
    await publish(dw, "keep-history", "second");
    const key = await keyWith(dw, ["sites:read", "sites:write"]);
    if (surface === "REST") {
      const result = await dw.json(`/api/v1/sites/keep-history/versions/${first.version.id}`, { key, method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "keep-history" }) });
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("insufficient_scope");
    } else {
      const mcp = await connectMcp(dw, key);
      try {
        const result = await mcp.call("delete_version", { site: "keep-history", version: first.version.id, confirm: "keep-history" });
        expect(result.isError).toBe(true);
        expect(result.data.error.code).toBe("insufficient_scope");
      } finally { await mcp.client.close(); }
    }
    const versions = await dw.json("/api/v1/sites/keep-history/versions", { key: dw.ownerKey });
    expect(versions.body.versions.map((v: { id: string }) => v.id)).toContain(first.version.id);
  });

  it("a read + delete key can delete a site without sites:write", async () => {
    const dw = await freshInstance();
    await publish(dw, "delete-only", "remove");
    const key = await keyWith(dw, ["sites:read", "sites:delete"]);
    const result = await dw.json("/api/v1/sites/delete-only", { key, method: "DELETE" });
    expect(result.status).toBe(200);
    expect(result.body.deleted).toBe(true);
    expect((await dw.json("/api/v1/sites/delete-only", { key: dw.ownerKey })).status).toBe(404);
  });

  it("a site-restricted delete key cannot delete another site", async () => {
    const dw = await freshInstance();
    await publish(dw, "allowed-site", "a");
    await publish(dw, "other-site", "b");
    const key = await keyWith(dw, ["sites:read", "sites:delete"], "allowed-site");
    expect((await dw.json("/api/v1/sites/other-site", { key, method: "DELETE" })).status).toBe(404);
    expect((await dw.json("/api/v1/sites/other-site", { key: dw.ownerKey })).status).toBe(200);
    expect((await dw.json("/api/v1/sites/allowed-site", { key, method: "DELETE" })).status).toBe(200);
  });

  it("read-only keys still cannot delete and write-only keys can still publish", async () => {
    const dw = await freshInstance();
    await publish(dw, "existing-controls", "one");
    const reader = await keyWith(dw, ["sites:read"]);
    const denied = await dw.json("/api/v1/sites/existing-controls", { key: reader, method: "DELETE" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("insufficient_scope");
    const writer = await keyWith(dw, ["sites:read", "sites:write"]);
    const result = await dw.json("/api/v1/publish", {
      key: writer, ...jsonBody({ slug: "existing-controls", files: [{ path: "index.html", content: "two" }] }),
    });
    expect(result.status).toBe(200);
  });

  it.each(["delete_site", "delete_version", "delete_folder"])("%s advertises sites:delete in the registry and command table", async (id) => {
    const dw = await freshInstance();
    const op = registry(dw).find((entry) => entry.id === id);
    expect(op, `${id} must be registered`).toBeDefined();
    expect(op!.scopes).toContain("sites:delete");
    expect(op!.scopes).not.toContain("sites:write");
    const table = await dw.json("/api/v1/operations");
    const row = commandRows(table.body).find((entry) => entry.id === id);
    expect(row?.scopes).toContain("sites:delete");
  });

  it.each(["REST", "MCP"])("%s delete_folder rejects write-only keys without removing the folder", async (surface) => {
    const dw = await freshInstance();
    const tenant = await env.DB.prepare("SELECT id FROM tenants LIMIT 1").first<{ id: string }>();
    await env.DB.prepare("INSERT INTO folders (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)")
      .bind("acceptance-folder", tenant!.id, "Keep", Date.now()).run();
    const key = await keyWith(dw, ["sites:read", "sites:write"]);
    if (surface === "REST") {
      const result = await dw.json("/api/v1/folders/acceptance-folder", { key, method: "DELETE" });
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("insufficient_scope");
    } else {
      const mcp = await connectMcp(dw, key);
      try {
        expect((await mcp.tools()).map((tool) => tool.name), "delete_folder must be exposed through MCP").toContain("delete_folder");
        const result = await mcp.call("delete_folder", { folder: "acceptance-folder", confirm: "Keep" });
        expect(result.isError).toBe(true);
        expect(result.data.error.code).toBe("insufficient_scope");
      } finally { await mcp.client.close(); }
    }
    expect(await env.DB.prepare("SELECT id FROM folders WHERE id = ?").bind("acceptance-folder").first()).not.toBeNull();
  });
});

describe("R-17 migration compatibility on real D1", () => {
  it.each([
    { scopes: "sites:read sites:write", want: ["sites:read", "sites:write", "sites:delete"] },
    { scopes: "sites:write", want: ["sites:write", "sites:delete"] },
    { scopes: "sites:read", want: ["sites:read"] },
    { scopes: "sites:write sites:delete", want: ["sites:write", "sites:delete"] },
    { scopes: "sites:write_extra keys:write", want: ["sites:write_extra", "keys:write"] },
  ])("upgrades legacy scopes '$scopes' once, preserving all other scopes", async ({ scopes, want }) => {
    await reset();
    const first = env.TEST_MIGRATIONS.filter((m) => /^0001/.test(m.name));
    expect(first).toHaveLength(1);
    await applyD1Migrations(env.DB, first);
    await env.DB.prepare("INSERT INTO tenants (id, created_at) VALUES ('legacy-tenant', ?)").bind(Date.now()).run();
    await env.DB.prepare("INSERT INTO members (id, tenant_id, role, created_at) VALUES ('legacy-member', 'legacy-tenant', 'owner', ?)").bind(Date.now()).run();
    await env.DB.prepare("INSERT INTO api_keys (id, tenant_id, member_id, prefix, key_hash, scopes, created_at) VALUES ('legacy-key', 'legacy-tenant', 'legacy-member', 'dw_legacy', ?, ?, ?)")
      .bind(await sha256Hex("dw_legacy_acceptance_only"), scopes, Date.now()).run();
    const remaining = env.TEST_MIGRATIONS.filter((m) => !/^0001/.test(m.name));
    await applyD1Migrations(env.DB, remaining);
    await applyD1Migrations(env.DB, remaining);
    const row = await env.DB.prepare("SELECT scopes FROM api_keys WHERE id = 'legacy-key'").first<{ scopes: string }>();
    const actual = row!.scopes.split(/\s+/).filter(Boolean);
    expect(actual.sort()).toEqual([...want].sort());
  });

  it("the migrated legacy write key actually retains REST deletion", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => /^0001/.test(m.name)));
    await env.DB.prepare("INSERT INTO tenants (id, created_at) VALUES ('legacy-tenant', ?)").bind(Date.now()).run();
    await env.DB.prepare("INSERT INTO members (id, tenant_id, role, created_at) VALUES ('legacy-member', 'legacy-tenant', 'owner', ?)").bind(Date.now()).run();
    await env.DB.prepare("INSERT INTO api_keys (id, tenant_id, member_id, prefix, key_hash, scopes, created_at) VALUES ('legacy-key', 'legacy-tenant', 'legacy-member', 'dw_legacy', ?, 'sites:read sites:write', ?)")
      .bind(await sha256Hex("dw_legacy_acceptance_only"), Date.now()).run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => !/^0001/.test(m.name)));
    // Use the app without resetting or minting a replacement key after migration.
    const { createDropway } = await import("@dropway/server");
    const app = createDropway();
    const request = async (path: string, method: string, input?: unknown) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`${ORIGIN}${path}`, {
        method, headers: { Authorization: "Bearer dw_legacy_acceptance_only", "Content-Type": "application/json" },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }), env as unknown as ServerBindings, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    expect((await request("/api/v1/sites", "POST", { slug: "legacy-site" })).status).toBe(201);
    expect((await request("/api/v1/sites/legacy-site", "DELETE")).status).toBe(200);
  });
});
