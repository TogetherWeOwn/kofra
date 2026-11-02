import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import * as core from "@kofra/core";
import { ApiError, setSiteAccess, type KofraContext, type PolicyAdapter, type Principal, type SiteOwner } from "@kofra/core";
import { type ServerBindings } from "@kofra/server";
import { form, freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import { echoOperation, type OperationFixture } from "./operation-fixtures";

// SPEC 6.3's new optional members remain local so the RED branch still typechecks.
type PolicyContract = PolicyAdapter & {
  capability?(p: Principal, capability: string, owner: SiteOwner | null, dc: KofraContext):
    { allowed: true } | { allowed: false; error: ApiError } | Promise<{ allowed: true } | { allowed: false; error: ApiError }>;
  quota?(p: Principal, key: string, owner: SiteOwner | null, dc: KofraContext): number | null | Promise<number | null>;
  beforeOperation?(p: Principal, op: { id: string }, input: unknown, dc: KofraContext): void | Promise<void>;
};
const limits: PolicyAdapter["limits"] = (_p, _owner, dc) => dc.config.limits;
const CAPABILITIES = [
  "anonymous_publish", "url_fetch", "large_uploads", "version_previews", "site_password", "site_restricted", "site_private",
  "share_links", "embed_allowlist", "custom_domains", "mounts", "vanity_names", "site_data", "variables", "proxy_routes", "drives",
  "functions", "analytics", "screenshots", "ai_metadata", "search", "comments", "webhooks", "code_mode", "members", "api_keys", "audit_log",
];
const QUOTA_KEYS = [
  "sites", "storage_bytes", "custom_domains", "members", "api_keys_per_member", "folders", "variables", "drives",
  "site_data_records_per_site", "share_links_per_site", "webhooks", "analytics_retention_days", "versions_per_site",
];

async function boundJson(dw: Instance, bindings: ServerBindings, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${dw.ownerKey}`);
  const response = await dw.kofra.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function site(dw: Instance, slug = "policy-site") {
  const result = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug }) });
  expect(result.status).toBe(201);
  const row = await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind(slug).first<{ id: string }>();
  expect(row, "resolve the stored id, not the public site's serialized fields").not.toBeNull();
  return row!;
}

function passwordPolicy(): PolicyContract {
  return {
    limits,
    async capability(_p, capability) {
      return capability === "site_password"
        ? { allowed: false, error: new ApiError(403, "limit_reached", "Password protection is disabled here.", "Ask the instance administrator to enable passwords.", { feature: "site_password" }) }
        : { allowed: true };
    },
  };
}

describe("R-17 capability policy", () => {
  it.each([["CAPABILITIES", CAPABILITIES], ["QUOTA_KEYS", QUOTA_KEYS]] as const)("exports the closed %s vocabulary", (name, values) => {
    expect(Reflect.get(core, name)).toEqual(values);
  });

  it.each(["access", "settings"])("REST %s preserves the adapter's site_password error and hint, with no state change", async (route) => {
    const dw = await freshInstance({}, { adapters: { policy: passwordPolicy() } });
    const created = await site(dw);
    const result = await dw.json(route === "access" ? "/api/v1/sites/policy-site/access" : "/api/v1/sites/policy-site", {
      key: dw.ownerKey, ...jsonBody(route === "access" ? { mode: "password", password: "acceptance-password" } : { password: "acceptance-password" }),
      method: route === "access" ? "PUT" : "PATCH",
    });
    expect(result.status).toBe(403);
    expect(result.body.error).toMatchObject({
      code: "limit_reached", message: "Password protection is disabled here.",
      hint: "Ask the instance administrator to enable passwords.", details: { feature: "site_password" },
    });
    // Exact message/hint assertions also reject core-added commercial wording.
    const row = await env.DB.prepare("SELECT password_hash FROM sites WHERE id = ?").bind(created.id).first<{ password_hash: string | null }>();
    expect(row!.password_hash).toBeNull();
  });

  it.each([false, true])("denies an initial password create (with deploy: %s) without persisting or metering a site", async (withDeploy) => {
    const events: string[] = [];
    const dw = await freshInstance({}, { adapters: {
      policy: passwordPolicy(), metering: { record(event) { events.push(event.type); } },
    } });
    events.length = 0;
    const result = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({
      slug: "denied-password-create", password: "acceptance-password",
      ...(withDeploy ? { files: [await manifestEntry("index.txt", "four")] } : {}),
    }) });
    expect(result.status).toBe(403);
    expect(result.body.error).toMatchObject({
      code: "limit_reached", message: "Password protection is disabled here.",
      hint: "Ask the instance administrator to enable passwords.", details: { feature: "site_password" },
    });
    expect(await env.DB.prepare("SELECT id FROM sites WHERE slug = 'denied-password-create'").first()).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>())!.n).toBe(0);
    expect((await env.FILES.list({ prefix: "blobs/" })).objects).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it("MCP set_site_access preserves the same policy refusal", async () => {
    const dw = await freshInstance({}, { adapters: { policy: passwordPolicy() } });
    await site(dw);
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const result = await mcp.call("set_site_access", { site: "policy-site", mode: "password", password: "acceptance-password" });
      expect(result.isError).toBe(true);
      expect(result.data.error).toMatchObject({ code: "limit_reached", hint: "Ask the instance administrator to enable passwords." });
    } finally { await mcp.client.close(); }
  });

  it("direct core setSiteAccess cannot bypass a capability refusal", async () => {
    const dw = await freshInstance({}, { adapters: { policy: passwordPolicy() } });
    await site(dw);
    const ctx = createExecutionContext();
    const dc = dw.kofra.context(env as unknown as ServerBindings, ctx);
    const p = await dc.adapters.identity.resolve(new Request(`${ORIGIN}/api/v1/me`, { headers: { Authorization: `Bearer ${dw.ownerKey}` } }), dc);
    try {
      await expect(setSiteAccess(dc, p, "policy-site", { mode: "password", password: "acceptance-password" }))
        .rejects.toMatchObject({ status: 403, code: "limit_reached", hint: "Ask the instance administrator to enable passwords." });
    } finally { await waitOnExecutionContext(ctx); }
  });

  it("default policy still allows passwords without optional cloud bindings", async () => {
    const dw = await freshInstance();
    await site(dw);
    const result = await dw.json("/api/v1/sites/policy-site/access", {
      key: dw.ownerKey, ...jsonBody({ mode: "password", password: "acceptance-password" }), method: "PUT",
    });
    expect(result.status).toBe(200);
    const row = await env.DB.prepare("SELECT password_hash FROM sites WHERE slug = 'policy-site'").first<{ password_hash: string | null }>();
    expect(row!.password_hash).toBeTruthy();
  });

  it.each([
    ["screenshots", "BROWSER"], ["ai_metadata", "AI"], ["site_data", "SITE_DATA"], ["functions", "LOADER"], ["code_mode", "LOADER"],
  ])("whoami reports %s unavailable when %s is removed, even if an adapter allows it", async (capability, binding) => {
    const policy: PolicyContract = { limits, capability: async () => ({ allowed: true }) };
    const dw = await freshInstance({}, { adapters: { policy } });
    const bindings = { ...env } as unknown as ServerBindings & Record<string, unknown>;
    delete bindings[binding];
    const me = await boundJson(dw, bindings, "/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.capabilities, "whoami must describe capability availability").toBeDefined();
    expect(me.body.capabilities).toHaveProperty(capability);
    const decision = me.body.capabilities[capability];
    // The spec fixes the semantics, not an extra whoami wrapper around the decision.
    expect(decision.allowed ?? decision.available).toBe(false);
    expect(JSON.stringify(decision)).toContain("feature_unavailable");
    expect(JSON.stringify(decision)).toContain(binding);
  });

  it("the default policy reports a missing BROWSER binding as unavailable", async () => {
    const dw = await freshInstance();
    const bindings = { ...env } as unknown as ServerBindings & Record<string, unknown>;
    delete bindings.BROWSER;
    const me = await boundJson(dw, bindings, "/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.capabilities, "default policy must report capability availability").toBeDefined();
    const decision = me.body.capabilities.screenshots;
    expect(decision, "screenshots must have an availability decision").toBeDefined();
    expect(decision.allowed ?? decision.available).toBe(false);
    expect(JSON.stringify(decision)).toContain("feature_unavailable");
    expect(JSON.stringify(decision)).toContain("BROWSER");
  });

  it("registry capability metadata refuses an unavailable feature before its handler", async () => {
    const op = { ...echoOperation(), capability: "screenshots" as const };
    const policy: PolicyContract = { limits, capability: () => ({ allowed: true }) };
    const extra = { operations: [op], adapters: { policy } };
    const dw = await freshInstance({}, extra);
    const bindings = { ...env } as unknown as ServerBindings & Record<string, unknown>;
    delete bindings.BROWSER;
    const result = await boundJson(dw, bindings, "/api/v1/acceptance/echo", jsonBody({ message: "not rendered" }));
    expect(result.status).toBe(501);
    expect(result.body.error).toMatchObject({ code: "feature_unavailable", details: { requires: expect.anything() } });
    expect(JSON.stringify(result.body.error.details.requires)).toContain("BROWSER");
  });
});

describe("R-17 quotas", () => {
  it.each([0, 1])("adapter sites quota %s rejects the next create without leaving an orphan", async (quota) => {
    const policy: PolicyContract = { limits, quota: async (_p, key) => key === "sites" ? quota : null };
    const dw = await freshInstance({}, { adapters: { policy } });
    if (quota === 1) await site(dw, "first-site");
    const result = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "over-limit" }) });
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("limit_reached");
    expect(await env.DB.prepare("SELECT id FROM sites WHERE slug = 'over-limit'").first()).toBeNull();
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE deleted_at IS NULL").first<{ n: number }>();
    expect(count!.n).toBe(quota);
  });

  it("concurrent creates cannot both consume the last site slot", async () => {
    const policy: PolicyContract = { limits, quota: (_p, key) => key === "sites" ? 1 : null };
    const dw = await freshInstance({}, { adapters: { policy } });
    const results = await Promise.all(["concurrent-one", "concurrent-two"].map((slug) =>
      dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug }) })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 403]);
    const refused = results.find((r) => r.status === 403)!;
    expect(refused.body.error.code).toBe("limit_reached");
    const rows = await env.DB.prepare("SELECT slug FROM sites WHERE deleted_at IS NULL").all<{ slug: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.slug).toBe(results[0]!.status === 201 ? "concurrent-one" : "concurrent-two");
    const me = await dw.json("/api/v1/me", { key: dw.ownerKey });
    expect(me.status).toBe(200);
    expect(me.body.usage).toMatchObject({ sites: 1, storage_bytes: 0 });
  });

  it("null adapter quotas mean unlimited rather than zero", async () => {
    const policy: PolicyContract = { limits, quota: () => null };
    const dw = await freshInstance({}, { adapters: { policy } });
    await site(dw, "unlimited-one");
    await site(dw, "unlimited-two");
  });

  it("the default sites quota reads QUOTA_SITES from the supplied instance bindings", async () => {
    const dw = await freshInstance();
    const bindings = { ...env, QUOTA_SITES: "1" } as unknown as ServerBindings;
    const first = await boundJson(dw, bindings, "/api/v1/sites", jsonBody({ slug: "configured-one" }));
    expect(first.status).toBe(201);
    const refused = await boundJson(dw, bindings, "/api/v1/sites", jsonBody({ slug: "configured-two" }));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("limit_reached");
  });

  it("the default storage quota reads QUOTA_STORAGE_BYTES before recording a deploy", async () => {
    const dw = await freshInstance();
    const created = await site(dw);
    const bindings = { ...env, QUOTA_STORAGE_BYTES: "3" } as unknown as ServerBindings;
    const result = await boundJson(dw, bindings, "/api/v1/publish", jsonBody({ slug: "policy-site", files: [{ path: "index.txt", content: "four" }] }));
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("limit_reached");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM versions WHERE site_id = ?").bind(created.id).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("storage quota uses incremental unique bytes, not total manifest bytes", async () => {
    let limit: number | null = null;
    const policy: PolicyContract = { limits, quota: (_p, key) => key === "storage_bytes" ? limit : null };
    const dw = await freshInstance({}, { adapters: { policy } });
    const first = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ slug: "storage-one", files: [{ path: "a.txt", content: "four" }] }) });
    expect(first.status).toBe(201);
    limit = 4;
    const reused = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ slug: "storage-two", files: [{ path: "renamed.txt", content: "four" }] }) });
    expect(reused.status).toBe(201);
    const over = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ slug: "storage-two", files: [{ path: "new.txt", content: "!" }] }) });
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe("limit_reached");
  });
});

describe("R-17 beforeOperation", () => {
  it.each(["REST", "MCP"])("%s passes validated defaults and the authenticated principal before dispatch", async (surface) => {
    const steps: string[] = [];
    const seen: { principal: Principal; op: string; input: unknown }[] = [];
    const policy: PolicyContract = { limits, async beforeOperation(principal, op, input) {
      if (op.id === "acceptance_echo") { steps.push("policy"); seen.push({ principal, op: op.id, input }); }
    } };
    const op = echoOperation({ async handler(input) { steps.push("handler"); return input; } });
    const dw = await freshInstance({}, { operations: [op], adapters: { policy } });
    if (surface === "REST") {
      expect((await dw.json("/api/v1/acceptance/echo", { key: dw.ownerKey, ...jsonBody({ message: "parsed" }) })).body).toEqual({ message: "parsed", count: 1 });
    } else {
      const mcp = await connectMcp(dw, dw.ownerKey);
      try {
        const result = await mcp.call("acceptance_echo", { message: "parsed" });
        expect(result.isError).toBe(false);
        expect(result.data).toEqual({ message: "parsed", count: 1 });
      } finally { await mcp.client.close(); }
    }
    expect(steps).toEqual(["policy", "handler"]);
    expect(seen).toEqual([{ principal: expect.objectContaining({ kind: "member", role: "owner" }), op: "acceptance_echo", input: { message: "parsed", count: 1 } }]);
  });

  it.each(["REST", "MCP"])("%s returns beforeOperation's stable refusal without invoking the handler", async (surface) => {
    const policy: PolicyContract = { limits, async beforeOperation(_p, op) {
      if (op.id === "acceptance_echo") throw new ApiError(409, "instance_maintenance", "Writes are paused.", "Retry after the maintenance window.");
    } };
    let handlerCalls = 0;
    const op = echoOperation({ async handler(input) { handlerCalls++; return input; } });
    const dw = await freshInstance({}, { operations: [op], adapters: { policy } });
    if (surface === "REST") {
      const result = await dw.json("/api/v1/acceptance/echo", { key: dw.ownerKey, ...jsonBody({ message: "denied" }) });
      expect(result.status).toBe(409);
      expect(result.body.error).toMatchObject({ code: "instance_maintenance", hint: "Retry after the maintenance window." });
    } else {
      const mcp = await connectMcp(dw, dw.ownerKey);
      try {
        const result = await mcp.call("acceptance_echo", { message: "denied" });
        expect(result.isError).toBe(true);
        expect(result.data.error).toMatchObject({ code: "instance_maintenance", hint: "Retry after the maintenance window." });
      } finally { await mcp.client.close(); }
    }
    expect(handlerCalls).toBe(0);
  });

  it.each(["REST", "MCP"])("%s publish cannot bypass beforeOperation or leave a new site after refusal", async (surface) => {
    const policy: PolicyContract = { limits, beforeOperation(_p, op) {
      if (op.id === "publish_site") throw new ApiError(403, "publishing_paused", "Publishing is paused.", "Retry later.");
    } };
    const dw = await freshInstance({}, { adapters: { policy } });
    if (surface === "REST") {
      const result = await dw.json("/api/v1/publish", { key: dw.ownerKey, method: "POST", body: form({ "index.txt": "four" }) });
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("publishing_paused");
    } else {
      const mcp = await connectMcp(dw, dw.ownerKey);
      try {
        const result = await mcp.call("publish_site", { files: [{ path: "index.txt", content: "four" }] });
        expect(result.isError).toBe(true);
        expect(result.data.error.code).toBe("publishing_paused");
      } finally { await mcp.client.close(); }
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM sites").first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it.each([false, true])("raw REST passes parsed path/query defaults to policy and honors refusal (refuse: %s)", async (refuse) => {
    const seen: unknown[] = [];
    const policy: PolicyContract = { limits, beforeOperation(principal, op, input) {
      if (op.id !== "acceptance_raw_policy") return;
      expect(principal).toMatchObject({ kind: "member", role: "owner" });
      seen.push(input);
      if (refuse) throw new ApiError(409, "raw_write_paused", "Raw writes are paused.", "Retry after maintenance.");
    } };
    const op = echoOperation({
      id: "acceptance_raw_policy", path: "/api/v1/acceptance/raw/{name}", rawBody: true,
      mcp: { exclude: "Requires original request bytes" }, cli: undefined,
      input: z.object({ name: z.string().min(1), count: z.coerce.number().int().min(1).max(3).default(1) }),
      output: z.object({ name: z.string(), count: z.number(), content: z.string() }),
      async handler(input, ctx) {
        const content = await ctx.request.text();
        await ctx.dw.env.CACHE.put("acceptance-raw-handler", content);
        return { ...input, content };
      },
    });
    const dw = await freshInstance({}, { operations: [op], adapters: { policy } });
    const invalid = await dw.json("/api/v1/acceptance/raw/parsed%20name?count=0", {
      key: dw.ownerKey, method: "POST", headers: { "Content-Type": "text/plain" }, body: "invalid input",
    });
    expect(invalid.status).toBe(400);
    expect(seen).toEqual([]);
    expect(await env.CACHE.get("acceptance-raw-handler")).toBeNull();
    const content = '{ "name": "body-name", "count": 3 }\r\n';
    const result = await dw.json("/api/v1/acceptance/raw/parsed%20name", {
      key: dw.ownerKey, method: "POST", headers: { "Content-Type": "application/json" }, body: content,
    });
    expect(result.status).toBe(refuse ? 409 : 200);
    expect(seen).toEqual([{ name: "parsed name", count: 1 }]);
    if (refuse) {
      expect(result.body.error).toMatchObject({ code: "raw_write_paused", hint: "Retry after maintenance." });
      expect(await env.CACHE.get("acceptance-raw-handler")).toBeNull();
    } else {
      expect(result.body).toEqual({ name: "parsed name", count: 1, content });
      expect(await env.CACHE.get("acceptance-raw-handler")).toBe(content);
    }
  });

  it("MCP publish replay must honor a new beforeOperation refusal before exposing the cached result", async () => {
    let paused = false;
    const policy: PolicyContract = { limits, beforeOperation(_p, op) {
      if (paused && op.id === "publish_site") throw new ApiError(403, "publishing_paused", "Publishing is paused.", "Retry after maintenance.");
    } };
    const dw = await freshInstance({}, { adapters: { policy } });
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const args = { site: "replay-policy", files: [{ path: "index.txt", content: "once" }], idempotencyKey: "acceptance-replay-policy" };
      const first = await mcp.call("publish_site", args);
      expect(first.isError).toBe(false);
      expect(first.data.version.id).toEqual(expect.any(String));
      const allowed = await mcp.call("publish_site", args);
      expect(allowed.isError).toBe(false);
      expect(allowed.data).toMatchObject({ replayed: true, version: { id: first.data.version.id } });
      paused = true;
      const refused = await mcp.call("publish_site", args);
      expect(refused.isError).toBe(true);
      expect(refused.data.error).toMatchObject({ code: "publishing_paused", message: "Publishing is paused.", hint: "Retry after maintenance." });
      expect(refused.data).not.toHaveProperty("version");
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>())!.n).toBe(1);
      paused = false;
      const resumed = await mcp.call("publish_site", args);
      expect(resumed.isError).toBe(false);
      expect(resumed.data).toMatchObject({ replayed: true, version: { id: first.data.version.id } });
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>())!.n).toBe(1);
    } finally { await mcp.client.close(); }
  });

  it.each(["policy", "binding"])("MCP extension replay rechecks capability after %s availability changes", async (change) => {
    let allowed = true;
    let calls = 0;
    const capability = change === "binding" ? "screenshots" as const : "site_password" as const;
    const policy: PolicyContract = { limits, capability(_p, name) {
      return !allowed && change === "policy" && name === capability
        ? { allowed: false, error: new ApiError(403, "capability_paused", "Feature is paused.", "Ask the instance administrator.") }
        : { allowed: true };
    } };
    const op = { ...echoOperation({
      output: z.object({ message: z.string(), count: z.number(), replayed: z.boolean().optional() }),
      async handler(input) { calls++; return input; },
    }), capability, tool: { idempotent: true } };
    const dw = await freshInstance({}, { operations: [op], adapters: { policy } });
    // Binding-presence sentinel only: echo never calls the browser or any external service.
    let bindings = { ...env, BROWSER: { fetch: async () => new Response("unused") } } as unknown as ServerBindings & Record<string, unknown>;
    const bound: Instance = { ...dw, kofra: { ...dw.kofra,
      fetch: (request, _env, ctx) => dw.kofra.fetch(request, bindings, ctx),
    } };
    const mcp = await connectMcp(bound, dw.ownerKey);
    try {
      const args = { message: "cached capability", count: 1, idempotencyKey: "acceptance-replay-capability" };
      expect((await mcp.call("acceptance_echo", args)).isError).toBe(false);
      const cached = await mcp.call("acceptance_echo", args);
      expect(cached.isError, cached.text).toBe(false);
      expect(cached.data).toMatchObject({ message: "cached capability", count: 1, replayed: true });
      expect(calls).toBe(1);
      allowed = false;
      if (change === "binding") {
        bindings = { ...env } as unknown as ServerBindings & Record<string, unknown>;
        delete bindings.BROWSER;
      }
      const refused = await mcp.call("acceptance_echo", args);
      expect(refused.isError).toBe(true);
      if (change === "binding") {
        expect(refused.data.error.code).toBe("feature_unavailable");
        expect(JSON.stringify(refused.data.error.details.requires)).toContain("BROWSER");
      } else {
        expect(refused.data.error).toMatchObject({ code: "capability_paused", hint: "Ask the instance administrator." });
      }
      expect(refused.data).not.toHaveProperty("message");
      expect(calls).toBe(1);
    } finally { await mcp.client.close(); }
  });

  it("runs for core registry operations, not only extension operations", async () => {
    const seen: string[] = [];
    const policy: PolicyContract = { limits, beforeOperation(_p, op) { seen.push(op.id); } };
    const dw = await freshInstance({}, { adapters: { policy } });
    seen.length = 0;
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey })).status).toBe(200);
    expect((await dw.json("/api/v1/me", { key: dw.ownerKey })).status).toBe(200);
    expect(seen).toEqual(["list_sites", "whoami"]);
  });

  it("does not invoke policy or the handler before scope and input validation pass", async () => {
    const steps: string[] = [];
    const policy: PolicyContract = { limits, beforeOperation(_p, op) { if (op.id === "acceptance_echo") steps.push("policy"); } };
    const op: OperationFixture = echoOperation({ scopes: ["sites:write"], async handler(input) { steps.push("handler"); return input; } });
    const dw = await freshInstance({}, { operations: [op], adapters: { policy } });
    const key = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ scopes: ["sites:read"] }) });
    expect(key.status).toBe(201);
    const unauthorized = await dw.json("/api/v1/acceptance/echo", { key: key.body.key, ...jsonBody({ message: "valid" }) });
    expect(unauthorized.status).toBe(403);
    const invalid = await dw.json("/api/v1/acceptance/echo", { key: dw.ownerKey, ...jsonBody({ message: "", count: 0 }) });
    expect(invalid.status).toBe(400);
    expect(steps).toEqual([]);
  });
});
