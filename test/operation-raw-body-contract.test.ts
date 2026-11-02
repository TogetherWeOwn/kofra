import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createKofra, defineOperation } from "@kofra/server";
import { freshInstance } from "./helpers";
import { connectMcp } from "./mcp-helpers";

function rawOperation(method: "POST" | "PUT" = "POST") {
  return defineOperation({
    id: "raw_example",
    toolset: "core",
    method,
    path: "/api/v1/raw-example/{name}",
    scopes: ["sites:read"],
    summary: "Read a raw request body",
    description: "Return the path name and original request content. Send bytes, not a JSON input object; this operation is REST-only.",
    input: z.object({ name: z.string() }),
    output: z.object({ name: z.string(), content: z.string() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    rawBody: true,
    mcp: { exclude: "Requires the original HTTP request body" },
    async handler(input, ctx) {
      return { name: input.name, content: await ctx.request.text() };
    },
  });
}

// SPEC 6.5: exercise only public registration, HTTP dispatch, docs and MCP discovery.
describe("raw-body extension operation contract", () => {
  it.each([
    { method: "POST" as const, contentType: "text/plain", content: "raw body" },
    { method: "PUT" as const, contentType: "application/octet-stream", content: "raw\r\nbody\u0000é" },
    { method: "POST" as const, contentType: "application/json", content: '{ "name": "body-name", "content": "raw JSON text" }' },
  ])("preserves the original $contentType body and path input on $method", async ({ method, contentType, content }) => {
    const dw = await freshInstance({}, { operations: [rawOperation(method)] });
    const result = await dw.json("/api/v1/raw-example/path%20name", {
      key: dw.ownerKey,
      method,
      headers: { "Content-Type": contentType },
      body: new TextEncoder().encode(content),
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toEqual({ name: "path name", content });
  });

  it.each(["POST", "PUT"] as const)("documents %s raw input as octet-stream by default, not JSON", async (method) => {
    const dw = await freshInstance({}, { operations: [rawOperation(method)] });
    const doc = await dw.json("/openapi.json");
    expect(doc.status).toBe(200);
    const operation = doc.body.paths["/api/v1/raw-example/{name}"]?.[method.toLowerCase()];
    expect(operation).toBeDefined();
    expect(operation.operationId).toBe("raw_example");
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "path", name: "name", required: true, schema: expect.objectContaining({ type: "string" }) }),
    ]));
    expect(operation.requestBody?.content).toHaveProperty("application/octet-stream");
    expect(operation.requestBody.content).not.toHaveProperty("application/json");
  });

  it("excludes a registered raw-body operation from the live MCP tool list", async () => {
    const dw = await freshInstance({}, { operations: [rawOperation()] });
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const names = (await mcp.tools()).map((tool) => tool.name);
      expect(names.length).toBeGreaterThan(0);
      expect(names).not.toContain("raw_example");
    } finally {
      await mcp.client.close();
    }
  });

  it("rejects raw-body registration without explicit MCP exclusion", () => {
    const operation = rawOperation();
    expect(() => createKofra({ operations: [{ ...operation, mcp: undefined }] })).toThrow(/raw.*MCP|MCP.*raw/i);
  });
});
