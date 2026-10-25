import { describe, expect, it } from "vitest";
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import {
  ApiError, defaultIdentity,
  type DeleteEvent, type Limits, type Principal, type PublishEvent, type SiteRequestEvent, type UsageEvent,
} from "@dropway/core";
import * as server from "@dropway/server";
import { renderAppPage, type McpToolDefinition, type ServerBindings, type Viewer } from "@dropway/server";
import { form, freshInstance, jsonBody, manifestEntry, ORIGIN } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import { create as createTransfer, DAY, input as transferInput, instance as transferInstance, op, update as updateTransfer } from "./transfer-fixtures";

// Public-boundary tests: real routing, services and emulated storage; only the
// adapters supplied by an embedding application are fakes.
async function storedSite(slug: string) {
  const site = await env.DB.prepare("SELECT id, tenant_id FROM sites WHERE slug = ?").bind(slug).first<{ id: string; tenant_id: string | null }>();
  expect(site).not.toBeNull();
  return site!;
}

describe("extension API contract", () => {
  it("exports extension API version 4 from the public server entry point", () => {
    expect(server).toHaveProperty("EXTENSION_API_VERSION", 4);
  });

  it("enforces the extension's transferMaxExpiryDays on creation and update", async () => {
    const dw = await transferInstance({}, { adapters: { policy: {
      limits: (_principal, _owner, dc): Limits => ({ ...dc.config.limits, transferMaxExpiryDays: 2 }),
    } } });
    const t = await createTransfer(dw, { expiresAt: Date.now() + DAY });
    const refusedCreate = await op(dw, "create_transfer", transferInput({ slug: "extension-expiry-refused", expiresAt: Date.now() + 3 * DAY }));
    expect(refusedCreate.status).toBe(400);
    expect(refusedCreate.body.error.hint.length).toBeGreaterThan(0);
    const refusedUpdate = await updateTransfer(dw, t, { expiresAt: Date.now() + 3 * DAY });
    expect(refusedUpdate.status).toBe(400);
    expect(refusedUpdate.body.error.hint.length).toBeGreaterThan(0);
    expect((await updateTransfer(dw, t, { expiresAt: Date.now() + DAY + DAY / 2 })).status).toBe(200);
  });

  it("delivers committed transfer changes to onEvent without letting a failing hook undo them", async () => {
    const events: unknown[] = [];
    const dw = await transferInstance({}, { hooks: [
      { onEvent() { throw new Error("extension event sink unavailable"); } },
      { onEvent(event) { events.push(event); } },
    ] });
    const t = await createTransfer(dw);
    events.length = 0;
    const changed = await updateTransfer(dw, t, { message: "Extension event sample" });
    expect(changed.status).toBe(200);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).toContain(t.id);
    const saved = await op(dw, "get_transfer", { transfer: t.id });
    expect(saved.status).toBe(200);
    expect((saved.body.transfer ?? saved.body).message).toBe("Extension event sample");
    const count = events.length;
    expect((await updateTransfer(dw, t, { message: "Extension event sample" })).status).toBe(200);
    expect(events).toHaveLength(count);
  });

  it("uses an extension identity without an API key and enforces its scopes", async () => {
    let session: Principal = { kind: "anonymous", ip: "192.0.2.1" };
    const dw = await freshInstance({}, {
      adapters: {
        identity: {
          async resolve(request, dc) {
            if (request.headers.has("X-Contract-Session")) return session;
            const principal = await defaultIdentity.resolve(request, dc);
            if (principal.kind === "member") session = { ...principal, via: "contract-session", scopes: ["sites:read"] };
            return principal;
          },
        },
      },
      routes: [({ api }) => api.get("/contract-principal", (c) => c.json(c.get("principal")))],
    });
    expect((await dw.json("/api/v1/me", { key: dw.ownerKey })).status).toBe(200);
    const headers = { "X-Contract-Session": "yes" };
    const resolved = await dw.json("/api/v1/contract-principal", { headers });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ kind: "member", via: "contract-session", scopes: ["sites:read"] });
    expect((await dw.json("/api/v1/sites", { headers })).status).toBe(200);
    const denied = await dw.json("/api/v1/sites", { ...jsonBody({ slug: "scope-denied" }), headers: { ...headers, "Content-Type": "application/json" } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("insufficient_scope");
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey })).body.sites).toEqual([]);
  });

  it("preserves an identity adapter's refusal code and hint", async () => {
    const dw = await freshInstance({}, {
      adapters: { identity: { resolve(request, dc) {
        if (request.headers.has("X-Contract-Invalid")) throw new ApiError(401, "contract_identity_refused", "Invalid session.", "Start a new session.");
        return defaultIdentity.resolve(request, dc);
      } } },
    });
    const denied = await dw.json("/api/v1/sites", { headers: { "X-Contract-Invalid": "yes" } });
    expect(denied.status).toBe(401);
    expect(denied.body.error).toMatchObject({ code: "contract_identity_refused", hint: "Start a new session." });
  });

  it.each<{ cap: keyof Limits; value: number; sizes: number[]; status: number; code: string }>([
    { cap: "maxFileBytes", value: 4, sizes: [5], status: 413, code: "file_too_large" },
    { cap: "maxFiles", value: 1, sizes: [1, 1], status: 400, code: "too_many_files" },
    { cap: "maxSiteBytes", value: 4, sizes: [3, 3], status: 413, code: "site_too_large" },
  ])("enforces policy.limits $cap instead of the instance's larger default", async ({ cap, value, sizes, status, code }) => {
    const owners: Array<{ siteId: string | null; tenantId: string | null }> = [];
    const dw = await freshInstance({}, {
      adapters: { policy: { limits(principal, owner, dc) {
        expect(principal.kind).toBe("member");
        owners.push(owner);
        return { ...dc.config.limits, [cap]: value };
      } } },
    });
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "policy-cap" }) });
    expect(created.status).toBe(201);
    const files = await Promise.all(sizes.map((size, i) => manifestEntry(`${i}.txt`, "x".repeat(size))));
    const denied = await dw.json("/api/v1/sites/policy-cap/deploys", { key: dw.ownerKey, ...jsonBody({ files }) });
    expect(denied.status).toBe(status);
    expect(denied.body.error.code).toBe(code);
    const site = await storedSite("policy-cap");
    expect(owners).toContainEqual({ siteId: site.id, tenantId: site.tenant_id });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>())?.n).toBe(0);
  });

  it("allows a manifest exactly at the extension's file, count and total limits", async () => {
    const dw = await freshInstance({}, { adapters: { policy: { limits: (_p, _o, dc) => ({ ...dc.config.limits, maxFileBytes: 4, maxFiles: 1, maxSiteBytes: 4 }) } } });
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "policy-boundary" }) })).status).toBe(201);
    const entry = await manifestEntry("index.txt", "four");
    const accepted = await dw.json("/api/v1/sites/policy-boundary/deploys", { key: dw.ownerKey, ...jsonBody({ files: [entry] }) });
    expect(accepted.status).toBe(201);
    expect(accepted.body.missing).toEqual([entry.sha256]);
  });

  it("beforeCreateSite can refuse creation without persisting or metering a site", async () => {
    const events: UsageEvent[] = [];
    const inputs: unknown[] = [];
    const dw = await freshInstance({}, { adapters: {
      policy: {
        limits: (_p, _o, dc) => dc.config.limits,
        beforeCreateSite(principal, input) {
          inputs.push({ principal, input });
          throw new ApiError(403, "contract_create_refused", "Creation refused.", "Ask the instance administrator.");
        },
      },
      metering: { record: (event) => void events.push(event) },
    } });
    const denied = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "refused-create" }) });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: "contract_create_refused", hint: "Ask the instance administrator." });
    expect(inputs).toEqual([expect.objectContaining({ principal: expect.objectContaining({ kind: "member" }), input: expect.objectContaining({ slug: "refused-create", tenantId: expect.any(String) }) })]);
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey })).body.sites).toEqual([]);
    expect(events).toEqual([]);
  });

  it("beforeDeploy can refuse a new version without changing the live one", async () => {
    let refuse = false;
    const inputs: unknown[] = [];
    const dw = await freshInstance({}, { adapters: { policy: {
      limits: (_p, _o, dc) => dc.config.limits,
      beforeDeploy(principal, input) {
        inputs.push({ principal, input });
        if (refuse) throw new ApiError(403, "contract_deploy_refused", "Deploy refused.", "Keep the current version.");
      },
    } } });
    const first = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.txt": "old" }, { slug: "refused-deploy" }) });
    expect(first.status).toBe(201);
    refuse = true;
    const denied = await dw.json("/api/v1/sites/refused-deploy/deploys", { key: dw.ownerKey, ...jsonBody({ files: [await manifestEntry("index.txt", "new!")] }) });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: "contract_deploy_refused", hint: "Keep the current version." });
    const site = await storedSite("refused-deploy");
    expect(inputs.at(-1)).toMatchObject({ principal: { kind: "member" }, input: { siteId: site.id, tenantId: site.tenant_id, fileCount: 1, totalBytes: 4 } });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>())?.n).toBe(1);
    expect(await (await dw.call("/s/refused-deploy/")).text()).toBe("old");
  });

  it("delivers all five metering kinds and all three hooks with lifecycle attribution", async () => {
    const usage: UsageEvent[] = [];
    const published: PublishEvent[] = [];
    const deleted: DeleteEvent[] = [];
    const requested: SiteRequestEvent[] = [];
    const dw = await freshInstance({}, {
      adapters: { metering: { record: async (event, dc) => { expect(dc.env.DB).toBe(env.DB); usage.push(event); } } },
      hooks: [
        { onPublish: async (event) => { published.push(event); } },
        { onDelete: async (event) => { deleted.push(event); }, onRequest: async (event) => { requested.push(event); } },
      ],
    });
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "contract-life" }) });
    expect(created.status).toBe(201);
    const site = await storedSite("contract-life");
    const file = await manifestEntry("index.txt", "hello");
    const pending = await dw.json("/api/v1/sites/contract-life/deploys", { key: dw.ownerKey, ...jsonBody({ files: [file] }) });
    expect(pending.status).toBe(201);
    expect((await dw.json(`/api/v1/blobs/${file.sha256}`, { method: "PUT", key: dw.ownerKey, body: file.bytes, headers: { "Content-Length": "5" } })).status).toBe(201);
    const finalized = await dw.json(`/api/v1/sites/contract-life/deploys/${pending.body.deploy.id}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(finalized.status).toBe(200);
    const response = await dw.call("/s/contract-life/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect((await dw.json("/api/v1/sites/contract-life", { method: "DELETE", key: dw.ownerKey })).status).toBe(200);

    expect(usage.map((event) => event.type).sort()).toEqual(["blob_upload", "deploy", "site_created", "site_deleted", "site_request"]);
    const common = { tenantId: site.tenant_id, siteId: site.id, at: expect.any(Number) };
    expect(usage).toContainEqual({ type: "site_created", ...common, anonymous: false });
    expect(usage).toContainEqual({ type: "deploy", ...common, versionId: pending.body.deploy.id, fileCount: 1, totalBytes: 5 });
    expect(usage).toContainEqual({ type: "blob_upload", tenantId: site.tenant_id, sha256: file.sha256, bytes: 5, at: expect.any(Number) });
    expect(usage).toContainEqual({ type: "site_request", ...common, status: 200, bytes: 5 });
    expect(usage).toContainEqual({ type: "site_deleted", ...common });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: "deploy", site: { id: site.id, slug: "contract-life", tenantId: site.tenant_id, url: `${ORIGIN}/s/contract-life/` }, version: { id: pending.body.deploy.id, number: 1, fileCount: 1, totalBytes: 5 }, principal: { kind: "member" }, at: expect.any(Number) });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({ site: { id: site.id, slug: "contract-life", tenantId: site.tenant_id, versionId: pending.body.deploy.id }, status: 200, bytes: 5, ms: expect.any(Number) });
    expect(requested[0]!.request.url).toBe(`${ORIGIN}/s/contract-life/`);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ reason: "api", site: { id: site.id, tenantId: site.tenant_id }, principal: { kind: "member" }, at: expect.any(Number) });
  });

  it("runs API middleware after identity and registers route overrides before core routes", async () => {
    const dw = await freshInstance({}, {
      apiMiddleware: [async (c, next) => {
        c.header("X-Contract-Identity", c.get("principal").kind);
        await next();
      }],
      routes: [({ api }) => api.get("/sites", (c) => c.json({ extension: true, principal: c.get("principal").kind, instance: c.get("dw").config.instanceName }))],
    });
    const overridden = await dw.json("/api/v1/sites", { key: dw.ownerKey });
    expect(overridden.status).toBe(200);
    expect(overridden.body).toMatchObject({ extension: true, principal: "member" });
    expect(overridden.res.headers.get("X-Contract-Identity")).toBe("member");
    expect((await dw.json("/api/v1/me", { key: dw.ownerKey })).status).toBe(200);
  });

  it("mounts an app route with a service context and builds contexts outside requests", async () => {
    const dw = await freshInstance({ instanceName: "Contract instance" }, {
      routes: [({ app }) => app.get("/contract-app", (c) => c.text(c.get("dw").config.instanceName))],
    });
    const response = await dw.call("/contract-app");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Contract instance");
    const context = dw.dropway.context(env as unknown as ServerBindings, createExecutionContext());
    expect(context.config.instanceName).toBe("Contract instance");
    expect(context.env.DB).toBe(env.DB);
  });

  const echo: McpToolDefinition = {
    name: "contract_echo", description: "Echo a value to verify an embedding application's tool registration.",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    scopes: ["sites:read"], toolset: "extra",
    async handler(args, context) { return { value: args.value, principal: context.principal.kind, instance: context.dw.config.instanceName }; },
  };

  it("lists and calls an extension MCP tool through the real protocol endpoint", async () => {
    const dw = await freshInstance({ instanceName: "MCP contract" }, { mcpTools: [echo] });
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const names = (await mcp.tools()).map((tool) => tool.name);
      expect(names).toContain("contract_echo");
      expect(names).toContain("whoami");
      const result = await mcp.call("contract_echo", { value: "through the endpoint" });
      expect(result.isError).toBe(false);
      expect(result.data).toEqual({ value: "through the endpoint", principal: "member", instance: "MCP contract" });
    } finally { await mcp.client.close(); }
  });

  it("passes core and extension tools to an overridden MCP endpoint", async () => {
    const dw = await freshInstance({}, {
      mcpTools: [echo],
      mcp: (tools) => async (c) => c.json({ names: tools.map((tool) => tool.name), instance: c.get("dw").config.instanceName }),
    });
    const response = await dw.json("/mcp", { key: dw.ownerKey });
    expect(response.status).toBe(200);
    expect(response.body.names).toContain("contract_echo");
    expect(response.body.names).toContain("whoami");
  });

  it("renders UI slot content in the dashboard frame and replaces the landing page", async () => {
    const dw = await freshInstance({}, { uiSlots: {
      navItems: [{ label: "Contract docs", href: "/contract/docs" }],
      pages: [{ path: "/dashboard/contract", title: "Contract page", nav: true, handler: (c) => renderAppPage(c, { title: "Contract page", page: "contract", active: "/dashboard/contract", body: "<p>Contract body</p>" }) }],
      landing: (c) => c.text("Contract landing"),
      headHtml: '<meta name="contract-head" content="present">',
      banner: async () => "Contract banner",
      settingsSections: [{ id: "contract-settings", title: "Contract settings", render: async () => "<p>Contract section</p>" }],
      session: { signInPath: "/contract/signin", signOutPath: "/contract/signout" },
    } });
    const page = await dw.call("/dashboard/contract");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await page.text();
    for (const fragment of ["Contract body", 'href="/contract/docs"', 'href="/dashboard/contract"', "Contract banner", 'name="contract-head"', "/contract/signin", "/contract/signout"]) expect(html).toContain(fragment);
    const settings = await dw.call("/dashboard/settings");
    expect(settings.status).toBe(200);
    expect(await settings.text()).toContain("<p>Contract section</p>");
    expect(await (await dw.call("/")).text()).toBe("Contract landing");
  });

  it("tries an extension viewer before core viewers without intercepting raw bytes", async () => {
    const viewer: Viewer = {
      id: "contract-viewer", version: 1, maxBytes: 1024,
      matches: (file) => file.path.endsWith(".md"),
      async render(context) {
        expect(context.mode).toBe("view");
        return new Response(`Contract view: ${await context.readText()}`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      },
    };
    const dw = await freshInstance({}, { viewers: [viewer] });
    const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.md": "# Fixture" }, { slug: "contract-viewer" }) });
    expect(published.status).toBe(201);
    const rendered = await dw.call("/s/contract-viewer/?view=1");
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toBe("Contract view: # Fixture");
    const raw = await dw.call("/s/contract-viewer/?raw=1");
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("# Fixture");
  });

  it("runs the extension's scheduled work with bindings and the supplied controller", async () => {
    const dw = await freshInstance({}, { scheduled: async (dc, controller) => {
      await dc.env.CACHE.put("contract-scheduled", JSON.stringify({ cron: controller.cron, at: controller.scheduledTime, instance: dc.config.instanceName }));
    } });
    const controller = createScheduledController({ cron: "0 * * * *", scheduledTime: 1_792_699_200_000 });
    const context = createExecutionContext();
    await dw.dropway.scheduled(controller, env as unknown as ServerBindings, context);
    await waitOnExecutionContext(context);
    expect(await env.CACHE.get("contract-scheduled", "json")).toMatchObject({ cron: "0 * * * *", at: 1_792_699_200_000, instance: expect.any(String) });
  });
});
