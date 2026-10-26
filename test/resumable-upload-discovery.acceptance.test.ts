import { describe, expect, it } from "vitest";
import { freshInstance } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import { apiOperations, commandRows, pathShape, registry, resolveRef } from "./operation-fixtures";

// Match by documented wire shape: operation ids are the Builder's registry choice.
const routes = [
  { method: "POST", shape: "/api/v1/uploads" },
  { method: "GET", shape: "/api/v1/uploads/{}" },
  { method: "PUT", shape: "/api/v1/uploads/{}/parts/{}" },
  { method: "POST", shape: "/api/v1/uploads/{}/complete" },
];

describe("resumable upload public operation/discovery contract", () => {
  it("registers every upload route in REST, OpenAPI, command discovery and MCP or an explicit exclusion", async () => {
    const dw = await freshInstance();
    const definitions = registry(dw);
    const rows = commandRows((await dw.json("/api/v1/operations")).body);
    const doc = (await dw.json("/openapi.json")).body;
    const api = apiOperations(doc);
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const names = (await mcp.tools()).map((t) => t.name);
      const llms = await (await dw.call("/llms-full.txt")).text();
      for (const { method, shape } of routes) {
        const matches = definitions.filter((op) => op.method === method && pathShape(op.path) === shape);
        expect(matches, `${method} ${shape} must have exactly one operation definition`).toHaveLength(1);
        const op = matches[0]!;
        expect(rows.find((r) => r.id === op.id)).toMatchObject({ method, scopes: ["sites:write"] });
        const documented = api.filter((r) => r.method.toUpperCase() === method && pathShape(r.path) === shape);
        expect(documented).toHaveLength(1);
        expect(documented[0]!.op.operationId).toBe(op.id);
        if (method === "PUT") {
          expect(op.rawBody).toBe(true);
          expect(op.mcp).toMatchObject({ exclude: expect.any(String) });
          expect((op.mcp as { exclude: string }).exclude.trim().length).toBeGreaterThan(0);
          expect(names).not.toContain(op.id);
          const request = resolveRef(doc, documented[0]!.op.requestBody);
          expect(request.content).toHaveProperty("application/octet-stream");
        } else if (op.mcp && "exclude" in op.mcp) {
          expect(op.mcp.exclude.trim().length).toBeGreaterThan(0);
          expect(names).not.toContain(op.id);
        } else {
          expect(names).toContain(op.id);
          expect(llms).toContain(op.id);
        }
      }
    } finally { await mcp.client.close(); }
  });

  it("the publish registry schema actually accepts archiveUrl and attachment alternatives", async () => {
    const dw = await freshInstance();
    const op = registry(dw).find((r) => r.id === "publish_site")!;
    expect(op).toBeDefined();
    expect(op.input.safeParse({ archiveUrl: "https://93.184.216.34/site.zip" }).success).toBe(true);
    expect(op.input.safeParse({ files: [{ download_url: "https://93.184.216.34/a", file_name: "a.txt" }] }).success).toBe(true);
    expect(op.input.safeParse({ archiveUrl: "https://93.184.216.34/site.zip", files: [{ path: "x", content: "x" }] }).success).toBe(false);
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const tool = (await mcp.tools()).find((t) => t.name === "publish_site");
      expect(tool).toBeDefined();
      expect(JSON.stringify(tool.inputSchema)).toContain("archiveUrl");
      expect(JSON.stringify(tool.inputSchema)).toContain("download_url");
      expect(JSON.stringify(tool.inputSchema)).toContain("file_name");
    } finally { await mcp.client.close(); }
    const doc = (await dw.json("/openapi.json")).body;
    const publish = apiOperations(doc).find(({ op: item }) => item.operationId === "publish_site")!;
    const request = resolveRef(doc, publish.op.requestBody);
    const schema = resolveRef(doc, request.content["application/json"].schema);
    expect(JSON.stringify(schema)).toContain("archiveUrl");
    expect(JSON.stringify(schema)).toContain("download_url");
  });
});
