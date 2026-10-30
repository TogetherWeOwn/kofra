import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createDropway, defineOperation } from "@dropway/server";
import { BOOTSTRAP, freshInstance, jsonBody, type Instance } from "./helpers";
import { commandRows } from "./operation-fixtures";

// Exercise the public app factory and HTTP surfaces with real D1/R2/KV emulation.
describe("operation command table: REST wire input", () => {
  it.each([
    { id: "list_versions", method: "GET", path: "/api/v1/sites/{slug}/versions", required: ["slug"] },
    { id: "get_version", method: "GET", path: "/api/v1/sites/{slug}/versions/{id}", required: ["slug", "id"] },
    { id: "restore_version", method: "POST", path: "/api/v1/sites/{slug}/versions/{id}/restore", required: ["slug", "id"] },
    { id: "delete_version", method: "DELETE", path: "/api/v1/sites/{slug}/versions/{id}", required: ["slug", "id", "confirm"] },
    { id: "finalize_version", method: "POST", path: "/api/v1/sites/{slug}/versions/{id}/finalize", required: ["slug", "id"] },
    { id: "revoke_api_key", method: "DELETE", path: "/api/v1/keys/{id}", required: ["id"] },
  ])("$id requires its REST path fields, not MCP-only arguments", async ({ id, method, path, required }) => {
    const dw = await freshInstance();
    const result = await dw.json("/api/v1/operations");
    expect(result.status).toBe(200);
    const row = commandRows(result.body).find((entry) => entry.id === id);
    expect(row).toMatchObject({ id, method, path });
    expect(row!.inputSchema.type).toBe("object");
    expect.soft([...(row!.inputSchema.required ?? [])].sort()).toEqual([...required].sort());
    for (const name of required) {
      expect.soft(row!.inputSchema.properties[name], `${id}: ${name} is a wire parameter`).toMatchObject({ type: "string" });
    }
    for (const name of ["site", "version", "versionId", "key", "confirm", "idempotencyKey"]) {
      if (id === "delete_version" && name === "confirm") continue;
      expect.soft(row!.inputSchema.properties, `${id}: ${name} is MCP-only`).not.toHaveProperty(name);
    }
    if (id === "list_versions") {
      expect(row!.inputSchema.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 500 });
    }
  });

  it("create_version combines the REST slug parameter with its required files body", async () => {
    const dw = await freshInstance();
    const result = await dw.json("/api/v1/operations");
    expect(result.status).toBe(200);
    const row = commandRows(result.body).find((entry) => entry.id === "create_version");
    expect(row).toMatchObject({ method: "POST", path: "/api/v1/sites/{slug}/versions" });
    expect.soft([...(row!.inputSchema.required ?? [])].sort()).toEqual(["files", "slug"]);
    expect(row!.inputSchema.properties).toMatchObject({ slug: { type: "string" }, files: { type: "array" } });
    expect(row!.inputSchema.properties).not.toHaveProperty("site");
  });

  it("create_api_key advertises the optional REST body fields rather than MCP defaults", async () => {
    const dw = await freshInstance();
    const result = await dw.json("/api/v1/operations");
    expect(result.status).toBe(200);
    const row = commandRows(result.body).find((entry) => entry.id === "create_api_key");
    expect(row).toMatchObject({ method: "POST", path: "/api/v1/keys" });
    expect.soft(row!.inputSchema.required ?? []).toEqual([]);
    expect.soft(row!.inputSchema.properties).toMatchObject({
      name: { type: "string" }, scopes: { oneOf: [{ type: "array" }, { type: "string" }] },
      expiresInDays: { type: "number" }, memberId: { type: "string" }, site: { type: "string" },
    });
    expect(row!.inputSchema.properties).not.toHaveProperty("idempotencyKey");
  });

  it("list_api_keys advertises the REST query's string values for all", async () => {
    const dw = await freshInstance();
    const result = await dw.json("/api/v1/operations");
    expect(result.status).toBe(200);
    const row = commandRows(result.body).find((entry) => entry.id === "list_api_keys");
    expect(row).toMatchObject({ method: "GET", path: "/api/v1/keys" });
    expect(row!.inputSchema.required ?? []).toEqual([]);
    expect(row!.inputSchema.properties.all).toMatchObject({ type: "string", enum: ["1", "true"] });
  });
});

describe("public operation discovery", () => {
  it("returns the same public command table with the bootstrap credential as without one", async () => {
    const dw = await freshInstance();
    const anonymous = await dw.json("/api/v1/operations");
    expect(anonymous.status).toBe(200);
    expect(commandRows(anonymous.body).length).toBeGreaterThan(20);
    const bootstrap = await dw.json("/api/v1/operations", { key: BOOTSTRAP });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body).toEqual(anonymous.body);
  });
});

function reviewOperation(id: string, path: string, aliases: { method: string; path: string }[] = []) {
  return defineOperation({
    id, toolset: "sites", method: "POST", path, aliases, scopes: ["sites:read"],
    summary: "Read a review item",
    description: "Return a review item identifier to exercise operation route registration.",
    input: z.object({ id: z.string().optional(), slug: z.string().optional() }),
    output: z.object({ operation: z.string(), item: z.string() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async handler(input) { return { operation: id, item: input.id ?? input.slug ?? "collection" }; },
  });
}

describe("operation route uniqueness", () => {
  it("still registers and dispatches routes with genuinely different static paths", async () => {
    const dw = await freshInstance({}, { operations: [
      reviewOperation("review_item_id", "/api/v1/review-items/{id}"),
      reviewOperation("review_archived_slug", "/api/v1/review-archive/{slug}"),
    ] });
    const item = await dw.json("/api/v1/review-items/item-one", { key: dw.ownerKey, ...jsonBody({}) });
    expect(item.status).toBe(200);
    expect(item.body).toEqual({ operation: "review_item_id", item: "item-one" });
    const archive = await dw.json("/api/v1/review-archive/item-two", { key: dw.ownerKey, ...jsonBody({}) });
    expect(archive.status).toBe(200);
    expect(archive.body).toEqual({ operation: "review_archived_slug", item: "item-two" });
  });

  it("rejects a POST route and a post alias for the same path at app construction", () => {
    expect(() => createDropway({ operations: [reviewOperation(
      "review_case_collision", "/api/v1/review-items",
      [{ method: "post", path: "/api/v1/review-items" }],
    )] })).toThrowError(/duplicate.*route/i);
  });

  it("rejects structurally identical routes even when their path parameter names differ", () => {
    expect(() => createDropway({ operations: [
      reviewOperation("review_item_id", "/api/v1/review-items/{id}"),
      reviewOperation("review_item_slug", "/api/v1/review-items/{slug}"),
    ] })).toThrowError(/duplicate.*route/i);
  });
});

function publishSources(dw: Instance, body: unknown, idempotencyKey?: string) {
  return dw.json("/api/v1/publish-sources", {
    key: dw.ownerKey, ...jsonBody(body),
    headers: {
      "Content-Type": "application/json", "X-Kofra-Client": "rest-parity-test/1.0",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
  });
}

describe("REST source publishing", () => {
  it("records api, not mcp, on both the published result and persisted version", async () => {
    const dw = await freshInstance();
    const result = await publishSources(dw, { site: "rest-attribution", files: [{ path: "index.html", content: "from REST" }] });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "live", created: true, slug: "rest-attribution" });
    expect.soft(result.body.version.source).toBe("api");
    expect(result.body.version.client).toBe("rest-parity-test/1.0");
    const versions = await dw.json("/api/v1/sites/rest-attribution/versions", { key: dw.ownerKey });
    expect(versions.status).toBe(200);
    expect(versions.body.versions).toHaveLength(1);
    expect(versions.body.versions[0]).toMatchObject({ id: result.body.version.id, source: "api" });
  });

  it("replays a site-less JSON request without allocating another site or version", async () => {
    const dw = await freshInstance();
    const body = { files: [{ path: "index.html", content: "publish exactly once" }] };
    const first = await publishSources(dw, body, "rest-siteless-replay");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      status: "live", created: true, slug: expect.any(String), url: expect.any(String),
      site: { slug: expect.any(String) }, version: { id: expect.any(String), number: 1 },
    });
    const second = await publishSources(dw, body, "rest-siteless-replay");
    expect(second.status).toBe(200);
    expect.soft(second.body).toMatchObject({
      replayed: true, slug: first.body.slug, url: first.body.url,
      site: { slug: first.body.slug }, version: { id: first.body.version.id, number: 1 },
    });
    const sites = await dw.json("/api/v1/sites", { key: dw.ownerKey });
    expect(sites.status).toBe(200);
    expect.soft(sites.body.sites.map((site: { slug: string }) => site.slug)).toEqual([first.body.slug]);
    const versions = await dw.json(`/api/v1/sites/${first.body.slug}/versions`, { key: dw.ownerKey });
    expect(versions.status).toBe(200);
    expect(versions.body.versions.map((version: { id: string }) => version.id)).toEqual([first.body.version.id]);
    const page = await dw.call(first.body.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("publish exactly once");
  });

  it("rejects the same site-less request key with a different body before creating a site", async () => {
    const dw = await freshInstance();
    const first = await publishSources(dw, { files: [{ path: "index.html", content: "original body" }] }, "rest-siteless-conflict");
    expect(first.status).toBe(200);
    const conflict = await publishSources(dw, { files: [{ path: "index.html", content: "changed body" }] }, "rest-siteless-conflict");
    expect.soft(conflict.status).toBe(422);
    expect.soft(conflict.body).toMatchObject({ error: { code: "idempotency_key_reused" } });
    const sites = await dw.json("/api/v1/sites", { key: dw.ownerKey });
    expect(sites.status).toBe(200);
    expect(sites.body.sites.map((site: { slug: string }) => site.slug)).toEqual([first.body.slug]);
  });
});
