import { describe, expect, it } from "vitest";
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import * as core from "@kofra/core";
import { ApiError, type KofraContext, type PolicyAdapter, type Principal, type SiteOwner } from "@kofra/core";
import { type ServerBindings } from "@kofra/server";
import { freshInstance, jsonBody, manifestEntry, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";

type QuotaPolicy = PolicyAdapter & {
  quota?(p: Principal, key: string, owner: SiteOwner | null, dc: KofraContext): number | null | Promise<number | null>;
};

async function publish(dw: Instance, slug: string, files: { path: string; content: string }[], headers?: HeadersInit) {
  const result = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ slug, files }), ...(headers ? { headers } : {}) });
  expect([200, 201], JSON.stringify(result.body)).toContain(result.status);
  return result.body;
}

async function tenantId(): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM tenants LIMIT 1").first<{ id: string }>();
  expect(row).not.toBeNull();
  return row!.id;
}

async function usage(id: string): Promise<Record<string, number>> {
  const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_counters'").first();
  expect(table, "0002 must create usage_counters in real D1").not.toBeNull();
  const rows = await env.DB.prepare("SELECT key, value FROM usage_counters WHERE tenant_id = ?").bind(id).all<{ key: string; value: number }>();
  return Object.fromEntries(rows.results.map((row) => [row.key, row.value]));
}

async function deploy(dw: Instance, slug: string, content: string) {
  const entry = await manifestEntry("index.txt", content);
  const result = await dw.json(`/api/v1/sites/${slug}/deploys`, {
    key: dw.ownerKey, ...jsonBody({ files: [{ path: entry.path, size: entry.size, sha256: entry.sha256 }] }),
  });
  expect(result.status).toBe(201);
  return { id: result.body.deploy.id as string, entry };
}

async function finalize(dw: Instance, slug: string, id: string) {
  return dw.json(`/api/v1/sites/${slug}/deploys/${id}/finalize`, { key: dw.ownerKey, method: "POST" });
}

describe("R-17 beforeDeploy incremental bytes", () => {
  it("counts each previously unreferenced hash once, not once per manifest path", async () => {
    const inputs: { fileCount: number; totalBytes: number; newBytes: unknown }[] = [];
    const dw = await freshInstance({}, { adapters: { policy: {
      limits: (_p, _o, dc) => dc.config.limits,
      beforeDeploy(_p, input) { inputs.push({ fileCount: input.fileCount, totalBytes: input.totalBytes, newBytes: Reflect.get(input, "newBytes") }); },
    } } });
    await publish(dw, "duplicate-paths", [{ path: "a.txt", content: "four" }, { path: "b.txt", content: "four" }]);
    expect(inputs).toEqual([{ fileCount: 2, totalBytes: 8, newBytes: 4 }]);
  });

  it("reused bytes across sites in one tenant contribute zero newBytes", async () => {
    const values: unknown[] = [];
    const dw = await freshInstance({}, { adapters: { policy: {
      limits: (_p, _o, dc) => dc.config.limits,
      beforeDeploy(_p, input) { values.push(Reflect.get(input, "newBytes")); },
    } } });
    await publish(dw, "first-reference", [{ path: "a.txt", content: "four" }]);
    await publish(dw, "second-reference", [{ path: "b.txt", content: "four" }, { path: "new.txt", content: "!" }]);
    expect(values).toEqual([4, 1]);
  });

  it("computes UTF-8 bytes and preserves zero for an empty file", async () => {
    const values: unknown[] = [];
    const dw = await freshInstance({}, { adapters: { policy: {
      limits: (_p, _o, dc) => dc.config.limits,
      beforeDeploy(_p, input) { values.push(Reflect.get(input, "newBytes")); },
    } } });
    await publish(dw, "unicode-bytes", [{ path: "unicode.txt", content: "☃" }]);
    await publish(dw, "empty-bytes", [{ path: "empty.txt", content: "" }]);
    expect(values).toEqual([3, 0]);
  });

  it("passes newBytes to the manifest deploy path before bytes are uploaded", async () => {
    const inputs: unknown[] = [];
    const dw = await freshInstance({}, { adapters: { policy: {
      limits: (_p, _o, dc) => dc.config.limits,
      beforeDeploy(_p, input) { inputs.push(Reflect.get(input, "newBytes")); },
    } } });
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "pending-bytes" }) })).status).toBe(201);
    await deploy(dw, "pending-bytes", "hello");
    expect(inputs).toEqual([5]);
    expect((await env.FILES.list({ prefix: "blobs/" })).objects).toHaveLength(0);
  });
});

describe("R-17 persisted usage lifecycle", () => {
  it("increments sites once on creation and frees a site slot on deletion", async () => {
    const dw = await freshInstance();
    const id = await tenantId();
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "counted-site" }) })).status).toBe(201);
    expect(await usage(id)).toMatchObject({ sites: 1 });
    const duplicate = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "counted-site" }) });
    expect(duplicate.status).toBe(409);
    expect(await usage(id)).toMatchObject({ sites: 1 });
    expect((await dw.json("/api/v1/sites/counted-site", { key: dw.ownerKey, method: "DELETE" })).status).toBe(200);
    expect(await usage(id)).toMatchObject({ sites: 0 });
    expect((await dw.json("/api/v1/sites/counted-site", { key: dw.ownerKey, method: "DELETE" })).status).toBe(404);
    expect(await usage(id)).toMatchObject({ sites: 0 });
  });

  it("does not charge storage for a pending upload or a failed finalize", async () => {
    const dw = await freshInstance();
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "not-live" }) })).status).toBe(201);
    const pending = await deploy(dw, "not-live", "hello");
    const early = await finalize(dw, "not-live", pending.id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("missing_blobs");
    expect(await usage(await tenantId())).toMatchObject({ sites: 1, storage_bytes: 0 });
    expect((await dw.json(`/api/v1/blobs/${pending.entry.sha256}`, {
      key: dw.ownerKey, method: "PUT", body: pending.entry.bytes, headers: { "Content-Length": "5" },
    })).status).toBe(201);
    expect(await usage(await tenantId())).toMatchObject({ storage_bytes: 0 });
  });

  it("finalize charges unique bytes exactly once, including when the result is replayed", async () => {
    const dw = await freshInstance();
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "finalized-once" }) })).status).toBe(201);
    const pending = await deploy(dw, "finalized-once", "hello");
    expect((await dw.json(`/api/v1/blobs/${pending.entry.sha256}`, {
      key: dw.ownerKey, method: "PUT", body: pending.entry.bytes, headers: { "Content-Length": "5" },
    })).status).toBe(201);
    expect((await finalize(dw, "finalized-once", pending.id)).status).toBe(200);
    expect((await finalize(dw, "finalized-once", pending.id)).body.replayed).toBe(true);
    expect(await usage(await tenantId())).toMatchObject({ sites: 1, storage_bytes: 5 });
  });

  it.each(["sequential", "concurrent"])("%s finalizes recheck storage when two pending deploys would exceed the quota together", async (mode) => {
    const policy: QuotaPolicy = {
      limits: (_p, _o, dc) => dc.config.limits,
      quota: (_p, key) => key === "storage_bytes" ? 5 : null,
    };
    const dw = await freshInstance({}, { adapters: { policy } });
    const slugs = ["pending-quota-one", "pending-quota-two"];
    for (const slug of slugs) expect((await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug }) })).status).toBe(201);
    // Both manifests fit independently while usage is zero, but 4 + 4 exceeds 5.
    const pending = [await deploy(dw, slugs[0]!, "four"), await deploy(dw, slugs[1]!, "FIVE")];
    for (const item of pending) expect((await dw.json(`/api/v1/blobs/${item.entry.sha256}`, {
      key: dw.ownerKey, method: "PUT", body: item.entry.bytes, headers: { "Content-Length": "4" },
    })).status).toBe(201);
    const results = mode === "concurrent"
      ? await Promise.all(pending.map((item, i) => finalize(dw, slugs[i]!, item.id)))
      : [await finalize(dw, slugs[0]!, pending[0]!.id), await finalize(dw, slugs[1]!, pending[1]!.id)];
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(results.find((r) => r.status === 403)!.body.error.code).toBe("limit_reached");
    const ready = await env.DB.prepare("SELECT id FROM versions WHERE status = 'ready'").all<{ id: string }>();
    expect(ready.results).toHaveLength(1);
    const winner = results.findIndex((r) => r.status === 200);
    expect(ready.results[0]!.id).toBe(pending[winner]!.id);
    for (const [i, slug] of slugs.entries()) {
      const row = await env.DB.prepare("SELECT current_version_id FROM sites WHERE slug = ?").bind(slug).first<{ current_version_id: string | null }>();
      expect(row!.current_version_id).toBe(i === winner ? pending[i]!.id : null);
    }
    expect(await usage(await tenantId())).toMatchObject({ sites: 2, storage_bytes: 4 });
    expect((await finalize(dw, slugs[winner]!, pending[winner]!.id)).body.replayed).toBe(true);
    expect(await usage(await tenantId())).toMatchObject({ sites: 2, storage_bytes: 4 });
  });

  it("idempotent publish and unchanged republish do not double-count sites or bytes", async () => {
    const dw = await freshInstance();
    const files = [{ path: "index.txt", content: "four" }];
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "acceptance-usage-once" };
    const first = await publish(dw, "replayed-publish", files, headers);
    const replay = await publish(dw, "replayed-publish", files, headers);
    expect(replay.version.id).toBe(first.version.id);
    const unchanged = await publish(dw, "replayed-publish", files);
    expect(unchanged.unchanged).toBe(true);
    expect(await usage(await tenantId())).toMatchObject({ sites: 1, storage_bytes: 4 });
  });

  it.each(["zero", "conflicting"])("a verified hash cannot be reused with %s declared sizes to corrupt storage accounting", async (shape) => {
    const dw = await freshInstance();
    await publish(dw, "verified-size", [{ path: "index.txt", content: "hello" }]);
    const entry = await manifestEntry("index.txt", "hello");
    const files = [{ path: "zero.txt", sha256: entry.sha256, size: 0 }];
    if (shape === "conflicting") files.push({ path: "real.txt", sha256: entry.sha256, size: 5 });
    const result = await dw.json("/api/v1/sites/verified-size/deploys", { key: dw.ownerKey, ...jsonBody({ files }) });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatchObject({ code: expect.stringMatching(/^[a-z][a-z0-9_]*$/), hint: expect.any(String) });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT size FROM blobs WHERE sha256 = ?").bind(entry.sha256).first<{ size: number }>())!.size).toBe(5);
    expect(await usage(await tenantId())).toMatchObject({ sites: 1, storage_bytes: 5 });
    const served = await dw.call("/s/verified-size/?raw=1");
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("hello");
  });

  it("shared hashes remain charged once until their last active site is deleted", async () => {
    const dw = await freshInstance();
    await publish(dw, "shared-one", [{ path: "a.txt", content: "four" }]);
    await publish(dw, "shared-two", [{ path: "b.txt", content: "four" }]);
    const id = await tenantId();
    expect(await usage(id)).toMatchObject({ sites: 2, storage_bytes: 4 });
    expect((await dw.json("/api/v1/sites/shared-one", { key: dw.ownerKey, method: "DELETE" })).status).toBe(200);
    expect(await usage(id)).toMatchObject({ sites: 1, storage_bytes: 4 });
    expect((await dw.json("/api/v1/sites/shared-two", { key: dw.ownerKey, method: "DELETE" })).status).toBe(200);
    expect(await usage(id)).toMatchObject({ sites: 0, storage_bytes: 0 });
  });

  it("anonymous storage is not charged to the owner until claim transfers ownership", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    await publish(dw, "owned-usage", [{ path: "owned.txt", content: "four" }]);
    const anonymous = await dw.json("/api/v1/publish", jsonBody({ files: [{ path: "anonymous.txt", content: "hello" }] }));
    expect(anonymous.status).toBe(201);
    const id = await tenantId();
    expect(await usage(id)).toMatchObject({ sites: 1, storage_bytes: 4 });
    const claim = await dw.json(`/api/v1/sites/${anonymous.body.slug}/claim`, {
      key: dw.ownerKey, ...jsonBody({ claimToken: anonymous.body.claimToken }),
    });
    expect(claim.status).toBe(200);
    expect(await usage(id)).toMatchObject({ sites: 2, storage_bytes: 9 });
  });

  it.each(["sites", "storage_bytes"])("claim cannot exceed the tenant's %s quota or consume the claim token on refusal", async (resource) => {
    let limit: number | null = null;
    const policy: QuotaPolicy = {
      limits: (_p, _o, dc) => dc.config.limits,
      quota: (_p, key) => key === resource ? limit : null,
    };
    const dw = await freshInstance({ anonymous: { enabled: true } }, { adapters: { policy } });
    await publish(dw, "claim-quota-owned", [{ path: "owned.txt", content: "four" }]);
    const anonymous = await dw.json("/api/v1/publish", jsonBody({ files: [{ path: "anonymous.txt", content: "hello" }] }));
    expect(anonymous.status).toBe(201);
    const slug = anonymous.body.slug as string;
    const before = await env.DB.prepare("SELECT tenant_id, claim_token_hash, expires_at, current_version_id FROM sites WHERE slug = ?").bind(slug).first();
    expect(before).toMatchObject({ tenant_id: null, claim_token_hash: expect.any(String), current_version_id: expect.any(String) });
    limit = resource === "sites" ? 1 : 8;
    const claim = () => dw.json(`/api/v1/sites/${slug}/claim`, {
      key: dw.ownerKey, ...jsonBody({ claimToken: anonymous.body.claimToken }),
    });
    const denied = await claim();
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("limit_reached");
    const after = await env.DB.prepare("SELECT tenant_id, claim_token_hash, expires_at, current_version_id FROM sites WHERE slug = ?").bind(slug).first();
    expect(after).toEqual(before);
    const id = await tenantId();
    expect(await usage(id)).toMatchObject({ sites: 1, storage_bytes: 4 });
    const served = await dw.call(`/s/${slug}/?raw=1`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("hello");
    limit = null;
    expect((await claim()).status).toBe(200);
    expect(await usage(id)).toMatchObject({ sites: 2, storage_bytes: 9 });
    expect((await claim()).status).toBe(200); // The same owner can retry a completed claim safely.
    expect(await usage(id)).toMatchObject({ sites: 2, storage_bytes: 9 });
  });

  it("a policy-refused first deploy leaves neither a site nor charged usage", async () => {
    const dw = await freshInstance({}, { adapters: { policy: {
      limits: (_p, _o, dc) => dc.config.limits,
      beforeDeploy() { throw new ApiError(403, "limit_reached", "No storage is available.", "Remove unused files."); },
    } } });
    const result = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ slug: "refused-usage", files: [{ path: "a.txt", content: "four" }] }) });
    expect(result.status).toBe(403);
    const sites = await env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE deleted_at IS NULL").first<{ n: number }>();
    expect(sites!.n).toBe(0);
    expect(await usage(await tenantId())).toMatchObject({ sites: 0, storage_bytes: 0 });
  });

  it.each(["REST", "MCP"])("%s whoami returns capabilities, limits and current tenant usage", async (surface) => {
    const dw = await freshInstance();
    await publish(dw, "reported-usage", [{ path: "a.txt", content: "four" }]);
    let body: Record<string, any>;
    if (surface === "REST") {
      const me = await dw.json("/api/v1/me", { key: dw.ownerKey });
      expect(me.status).toBe(200);
      body = me.body;
    } else {
      const mcp = await connectMcp(dw, dw.ownerKey);
      try {
        const me = await mcp.call("whoami");
        expect(me.isError).toBe(false);
        body = me.data;
      } finally { await mcp.client.close(); }
    }
    expect(body.capabilities, "whoami must report capabilities").toBeDefined();
    expect(body.capabilities).toHaveProperty("site_password");
    expect(body.limits.maxFileBytes).toBeGreaterThan(0);
    expect(body.usage).toMatchObject({ sites: 1, storage_bytes: 4 });
  });
});

describe("R-17 usage true-up", () => {
  it("recomputeUsage repairs drift from persisted ready versions and excludes pending/deleted sites", async () => {
    const dw = await freshInstance();
    await publish(dw, "trueup-one", [{ path: "a.txt", content: "four" }, { path: "same.txt", content: "four" }]);
    await publish(dw, "trueup-two", [{ path: "b.txt", content: "four" }]);
    await publish(dw, "trueup-deleted", [{ path: "gone.txt", content: "gone!" }]);
    expect((await dw.json("/api/v1/sites/trueup-deleted", { key: dw.ownerKey, method: "DELETE" })).status).toBe(200);
    await deploy(dw, "trueup-one", "pending does not count");
    const recompute = Reflect.get(core, "recomputeUsage") as ((dc: KofraContext, tenantId: string) => Promise<unknown>) | undefined;
    expect(recompute, "@kofra/core must export recomputeUsage()").toBeTypeOf("function");
    const id = await tenantId();
    await env.DB.prepare("UPDATE usage_counters SET value = 999 WHERE tenant_id = ?").bind(id).run();
    const ctx = createExecutionContext();
    try {
      const dc = dw.kofra.context(env as unknown as ServerBindings, ctx);
      await recompute!(dc, id);
      expect(await usage(id)).toMatchObject({ sites: 2, storage_bytes: 4 });
      await recompute!(dc, id);
      expect(await usage(id)).toMatchObject({ sites: 2, storage_bytes: 4 });
    } finally { await waitOnExecutionContext(ctx); }
  });

  it("the daily scheduled entry point repairs usage and emits an attributed storage snapshot", async () => {
    const events: Record<string, unknown>[] = [];
    const dw = await freshInstance({}, { adapters: { metering: { record(event) { events.push({ ...event }); } } } });
    await publish(dw, "nightly-usage", [{ path: "a.txt", content: "four" }]);
    const id = await tenantId();
    const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_counters'").first();
    // Keep the scheduler exercised on the RED baseline, even before 0002 exists.
    if (table) await env.DB.prepare("UPDATE usage_counters SET value = 999 WHERE tenant_id = ?").bind(id).run();
    events.length = 0;
    const ctx = createExecutionContext();
    await dw.kofra.scheduled(createScheduledController({ cron: "0 0 * * *", scheduledTime: Date.UTC(2026, 9, 23) }), env as unknown as ServerBindings, ctx);
    await waitOnExecutionContext(ctx);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "storage_snapshot", tenantId: id, bytes: 4, at: expect.any(Number) })]));
    expect(await usage(id)).toMatchObject({ sites: 1, storage_bytes: 4 });
  });
});
