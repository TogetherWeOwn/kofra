import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { claimSite, deleteSite, mintApiKey, renameSite, runCleanup } from "@dropway/core";
import { asOwner } from "./atomic-extensions.helpers";
import { freshInstance, jsonBody, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import { create as createTransfer, instance as transferInstance } from "./transfer-fixtures";

async function create(dw: Instance, slug: string, key = dw.ownerKey) {
  const res = await dw.json("/api/v1/sites", { ...jsonBody({ slug }), key });
  expect(res.status).toBe(201);
  return res.body;
}

async function otherTenantKey(dw: Instance) {
  const { createTenantWithOwner } = await import("@dropway/core");
  return asOwner(dw, async (dc) => {
    const { tenant, owner } = await createTenantWithOwner(dc, { owner: { name: "Other owner" } });
    return (await mintApiKey(dc, { tenantId: tenant.id, memberId: owner.id, scopes: ["admin", "sites:read", "sites:write", "sites:delete"] })).key;
  });
}

const holds = async (slug: string) => (await env.DB.prepare("SELECT * FROM slug_tombstones WHERE slug = ?").bind(slug).all()).results;

/** Inject a real competing mutation after the service's reads, before its batch. */
function beforeBatch(action: () => Promise<unknown>) {
  const batch = env.DB.batch.bind(env.DB);
  const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
    spy.mockRestore();
    await action();
    return batch(statements);
  });
  return spy;
}

describe("link permanence review: release authorization", () => {
  it.each(["redirect", "tombstone"])("tenant admins cannot release another tenant's %s via REST or MCP", async (kind) => {
    const dw = await freshInstance({ multiTenant: true });
    await create(dw, "victim-name");
    await asOwner(dw, async (dc, p) => {
      if (kind === "redirect") await renameSite(dc, p, "victim-name", "victim-new");
      else await deleteSite(dc, p, "victim-name");
    });
    const other = await otherTenantKey(dw);
    const input = { slug: "victim-name", reason: "Dispute", confirm: "victim-name" };
    const rest = await dw.json("/api/v1/slugs/release", { ...jsonBody(input), key: other });
    expect(rest.status).toBe(403);
    const mcp = await connectMcp(dw, other);
    try {
      const result = await mcp.call("release_slug", input);
      expect(result.isError).toBe(true);
      expect(result.data.error.code).toBe("forbidden");
    } finally { await mcp.client.close(); }
    const acquire = await dw.json("/api/v1/sites", { ...jsonBody({ slug: "victim-name" }), key: other });
    expect(acquire.status).toBe(409);
    expect(acquire.body.error.code).toBe("slug_reserved");
    expect((await holds("victim-name")).every((h) => h.released_at === null)).toBe(true);
  });

  it("a site-restricted admin key cannot release even its tenant's hold", async () => {
    const dw = await freshInstance();
    await create(dw, "scoped-name");
    const key = await asOwner(dw, async (dc, p) => {
      const renamed = await renameSite(dc, p, "scoped-name", "scoped-new");
      return (await mintApiKey(dc, { tenantId: p.tenantId, memberId: p.memberId, scopes: ["admin"], siteId: renamed.site.id })).key;
    });
    const res = await dw.json("/api/v1/slugs/release", { ...jsonBody({ slug: "scoped-name", reason: "Dispute", confirm: "scoped-name" }), key });
    expect(res.status).toBe(403);
    expect((await env.DB.prepare("SELECT slug FROM slug_redirects WHERE slug = 'scoped-name'").all()).results).toHaveLength(1);
  });

  it("tenant admins cannot release ownerless expiry holds", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const anon = await dw.json("/api/v1/sites", jsonBody({}));
    expect(anon.status).toBe(201);
    const slug = anon.body.site.slug;
    await env.DB.prepare("UPDATE sites SET expires_at = 1 WHERE slug = ?").bind(slug).run();
    await asOwner(dw, (dc) => runCleanup(dc));
    const res = await dw.json("/api/v1/slugs/release", { ...jsonBody({ slug, reason: "Dispute", confirm: slug }), key: dw.ownerKey });
    expect(res.status).toBe(403);
    expect((await holds(slug))[0]!.released_at).toBeNull();
  });

  it("a tenant change after release preflight cannot release the new owner's redirect", async () => {
    const dw = await freshInstance({ multiTenant: true });
    await create(dw, "moved-name");
    const other = await otherTenantKey(dw);
    const otherTenant = await env.DB.prepare("SELECT tenant_id FROM members WHERE name = 'Other owner'").first<{ tenant_id: string }>();
    await asOwner(dw, (dc, p) => renameSite(dc, p, "moved-name", "moved-new"));
    const spy = beforeBatch(() => env.DB.prepare("UPDATE sites SET tenant_id = ? WHERE slug = 'moved-new'").bind(otherTenant!.tenant_id).run());
    try {
      const res = await dw.json("/api/v1/slugs/release", { ...jsonBody({ slug: "moved-name", reason: "Dispute", confirm: "moved-name" }), key: dw.ownerKey });
      expect(res.status).toBe(403);
    } finally { spy.mockRestore(); }
    expect((await env.DB.prepare("SELECT slug FROM slug_redirects WHERE slug = 'moved-name'").all()).results).toHaveLength(1);
    const acquire = await dw.json("/api/v1/sites", { ...jsonBody({ slug: "moved-name" }), key: other });
    expect(acquire.status).toBe(409);
    expect(await holds("moved-name")).toHaveLength(0);
  });
});

describe("link permanence review: expired redirects", () => {
  it.each(["delete", "expiry"])("%s does not revive expired aliases or block their new tenant's reclaim", async (mode) => {
    const dw = await freshInstance({ multiTenant: true });
    await create(dw, "old-alias");
    await asOwner(dw, (dc, p) => renameSite(dc, p, "old-alias", "current-name"));
    await env.DB.prepare("UPDATE slug_redirects SET hold_until = 1 WHERE slug = 'old-alias'").run();
    const other = await otherTenantKey(dw);
    await create(dw, "old-alias", other);
    if (mode === "delete") {
      expect((await dw.call("/api/v1/sites/current-name", { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    } else {
      await env.DB.prepare("UPDATE sites SET tenant_id = NULL, expires_at = 1 WHERE slug = 'current-name'").run();
      await asOwner(dw, (dc) => runCleanup(dc));
    }
    expect(await holds("old-alias")).toHaveLength(0);
    expect((await env.DB.prepare("SELECT slug FROM slug_redirects WHERE slug = 'old-alias'").all()).results).toHaveLength(0);
    expect((await dw.call("/api/v1/sites/old-alias", { method: "DELETE", key: other })).status).toBe(200);
    await create(dw, "old-alias", other);
  });
});

describe("link permanence review: transfer warning", () => {
  it("MCP transfer renames do not advertise a nonexistent redirect", async () => {
    const dw = await transferInstance();
    const transfer = await createTransfer(dw, { slug: "parcel-before" });
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const res = await mcp.call("rename_site", { site: transfer.slug, newSlug: "parcel-after" });
      expect(res.isError).toBe(false);
      expect(res.data.renamed).toBe(true);
      expect(res.data.redirectUntil).toBeNull();
      expect(res.data.warnings).toEqual([]);
    } finally { await mcp.client.close(); }
  });
});

describe("link permanence review: delete and expiry races", () => {
  it("delete refuses a stale slug after a competing rename, then retry holds the actual freed name", async () => {
    const dw = await freshInstance();
    await create(dw, "race-before");
    await asOwner(dw, async (dc, p) => {
      const spy = beforeBatch(() => renameSite(dc, p, "race-before", "race-after"));
      try {
        await expect(deleteSite(dc, p, "race-before")).rejects.toMatchObject({ status: 409, code: "site_changed" });
      } finally { spy.mockRestore(); }
      expect(await holds("race-before")).toHaveLength(0);
      expect(await holds("race-after")).toHaveLength(0);
      await deleteSite(dc, p, "race-after");
    });
    expect(await holds("race-after")).toHaveLength(1);
    const other = await otherTenantKey(dw);
    const res = await dw.json("/api/v1/sites", { ...jsonBody({ slug: "race-after" }), key: other });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("slug_reserved");
  });

  it("cleanup skips a stale renamed row and holds its actual name on the next run", async () => {
    const dw = await freshInstance();
    await create(dw, "expiry-before");
    await env.DB.prepare("UPDATE sites SET expires_at = 1 WHERE slug = 'expiry-before'").run();
    await asOwner(dw, async (dc, p) => {
      const spy = beforeBatch(() => renameSite(dc, p, "expiry-before", "expiry-after"));
      try { expect((await runCleanup(dc)).expiredSites).toBe(0); }
      finally { spy.mockRestore(); }
      expect(await holds("expiry-before")).toHaveLength(0);
      expect(await holds("expiry-after")).toHaveLength(0);
      expect((await runCleanup(dc)).expiredSites).toBe(1);
    });
    expect(await holds("expiry-after")).toHaveLength(1);
    const other = await otherTenantKey(dw);
    const res = await dw.json("/api/v1/sites", { ...jsonBody({ slug: "expiry-after" }), key: other });
    expect(res.status).toBe(409);
  });

  it("a claim between cleanup selection and deletion preserves the claimed site", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const anon = await dw.json("/api/v1/sites", jsonBody({}));
    expect(anon.status).toBe(201);
    const slug = anon.body.site.slug;
    await env.DB.prepare("UPDATE sites SET expires_at = 1 WHERE slug = ?").bind(slug).run();
    await asOwner(dw, async (dc, p) => {
      const spy = beforeBatch(() => claimSite(dc, p, slug, anon.body.claimToken));
      try { expect((await runCleanup(dc)).expiredSites).toBe(0); }
      finally { spy.mockRestore(); }
      expect(await holds(slug)).toHaveLength(0);
      const site = await env.DB.prepare("SELECT tenant_id, deleted_at, expires_at FROM sites WHERE slug = ?").bind(slug).first();
      expect(site).toMatchObject({ tenant_id: p.tenantId, deleted_at: null, expires_at: null });
    });
  });
});
