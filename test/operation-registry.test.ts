import { beforeEach, describe, expect, it } from "vitest";
import { freshInstance, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import { apiOperations, commandRows, hasExample, pathShape, registry, resolveRef } from "./operation-fixtures";

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance({ anonymous: { enabled: true } });
});

describe("operation registry: existing REST contracts", () => {
  it("represents every mounted v1 route, including legacy paths, as an operation or alias", () => {
    const operations = registry(dw);
    const registered = new Set(operations.flatMap((op) => [
      `${op.method} ${pathShape(op.path)}`,
      ...(op.aliases ?? []).map((alias) => `${alias.method.toUpperCase()} ${pathShape(alias.path)}`),
    ]));
    const routes = dw.dropway.app.routes.filter((route) => route.path.startsWith("/api/v1") && route.method !== "ALL" && route.method !== "OPTIONS");
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) {
      // Hono can implement HEAD implicitly through GET; SPEC 6.5 has no HEAD method.
      const method = route.method === "HEAD" ? "GET" : route.method;
      expect(registered.has(`${method} ${pathShape(route.path)}`), `${route.method} ${route.path}`).toBe(true);
    }
    // These paths predate the registry; neither migration nor route discovery may drop them.
    // /deploys is the pre-rename name; it stays working as an alias of /versions.
    for (const route of [
      "POST /api/v1/publish",
      "GET /api/v1/me",
      "POST /api/v1/setup",
      "POST /api/v1/setup/recover",
      "POST /api/v1/sites/{}/deploys",
      "POST /api/v1/sites/{}/versions",
      "POST /api/v1/sites/{}/deploys/{}/finalize",
      "POST /api/v1/sites/{}/versions/{}/finalize",
      "PUT /api/v1/blobs/{}",
      "GET /api/v1/sites/{}/versions",
      "PATCH /api/v1/sites/{}/files",
    ]) expect(registered.has(route), route).toBe(true);
  });

  it("gives every core operation a unique snake_case id and usable zod input/output schemas", () => {
    const operations = registry(dw);
    const ids = operations.map((op) => op.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of operations) {
      expect(op.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(op.input?.safeParse, `${op.id} input`).toBeTypeOf("function");
      expect(op.output?.safeParse, `${op.id} output`).toBeTypeOf("function");
      expect(op.summary.trim().length, op.id).toBeGreaterThan(0);
      expect(op.summary.length, op.id).toBeLessThanOrEqual(80);
      expect(op.description.trim().length, op.id).toBeGreaterThan(0);
      expect(op.description.length, op.id).toBeLessThan(4096);
    }
  });

  it("publishes every operation as an MCP tool or records a nonempty exclusion reason", async () => {
    const operations = registry(dw);
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const tools = await mcp.tools();
      const names = tools.map((tool) => tool.name);
      for (const op of operations) {
        if (op.mcp && "exclude" in op.mcp) {
          expect(op.mcp.exclude.trim().length, op.id).toBeGreaterThan(0);
          expect(names, `${op.id} is explicitly excluded`).not.toContain(op.id);
        } else {
          expect(names, `${op.id} has no mcp.exclude reason`).toContain(op.id);
        }
        if (op.rawBody) expect(op.mcp && "exclude" in op.mcp, `${op.id} reads raw bytes`).toBe(true);
      }
      for (const tool of tools) {
        expect(operations.some((op) => op.id === tool.name), `${tool.name} is not in the registry`).toBe(true);
        expect(tool.description.trim().length, tool.name).toBeGreaterThan(0);
        expect(tool.description.length, tool.name).toBeLessThan(4096);
        expect(tool.outputSchema?.type, tool.name).toBe("object");
        for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
          expect(tool.annotations?.[hint], `${tool.name}.${hint}`).toBeTypeOf("boolean");
        }
      }
    } finally {
      await mcp.client.close();
    }
  });

  it("returns stable, duplicate-free tools/list ordering across requests and fresh app instances", async () => {
    const first = await connectMcp(dw, dw.ownerKey);
    let names: string[];
    try {
      names = (await first.tools()).map((tool) => tool.name);
      expect(names.length).toBeGreaterThan(20);
      expect(new Set(names).size).toBe(names.length);
      expect((await first.tools()).map((tool) => tool.name)).toEqual(names);
    } finally {
      await first.client.close();
    }
    const other = await freshInstance({ anonymous: { enabled: true } });
    const second = await connectMcp(other, other.ownerKey);
    try {
      expect((await second.tools()).map((tool) => tool.name)).toEqual(names);
    } finally {
      await second.client.close();
    }
  });
});

describe("GET /api/v1/operations: public CLI command table", () => {
  it("is discoverable without credentials and returns schemas rather than zod internals or handlers", async () => {
    const result = await dw.json("/api/v1/operations");
    expect(result.status).toBe(200);
    expect(result.res.headers.get("content-type")).toContain("application/json");
    const rows = commandRows(result.body);
    expect(rows.length).toBeGreaterThan(20);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(["GET", "POST", "PUT", "PATCH", "DELETE"]).toContain(row.method);
      expect(row.path).toMatch(/^\/api\/v1(?:\/|$)/);
      expect(Array.isArray(row.scopes), row.id).toBe(true);
      expect(row.inputSchema?.type, row.id).toBe("object");
      expect(row.inputSchema).not.toHaveProperty("_def");
      expect(row).not.toHaveProperty("handler");
      if (row.cli) {
        expect(Array.isArray(row.cli.command), row.id).toBe(true);
        expect(row.cli.command.length, row.id).toBeGreaterThan(0);
        for (const segment of row.cli.command) expect(segment.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("lists the entire registry exactly once and preserves the documented versions command", async () => {
    const result = await dw.json("/api/v1/operations");
    expect(result.status).toBe(200);
    const rows = commandRows(result.body);
    expect(rows.map((row) => row.id).sort()).toEqual(registry(dw).map((op) => op.id).sort());
    expect(rows.find((row) => row.id === "list_versions")).toMatchObject({
      method: "GET",
      scopes: ["sites:read"],
      inputSchema: { type: "object" },
      cli: { command: ["versions", "ls"] },
    });
    expect(pathShape(rows.find((row) => row.id === "list_versions")!.path)).toBe("/api/v1/sites/{}/versions");
  });
});

describe("generated OpenAPI operation quality", () => {
  it("serves an OpenAPI 3.1 document with unique operation ids", async () => {
    const result = await dw.json("/openapi.json");
    expect(result.status).toBe(200);
    const doc = result.body;
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
    expect(doc.info.title.trim().length).toBeGreaterThan(0);
    expect(doc.info.version.trim().length).toBeGreaterThan(0);
    const operations = apiOperations(doc);
    expect(operations.length).toBeGreaterThan(20);
    const ids = operations.map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { path, method, op } of operations) {
      const label = `${method} ${path}`;
      expect(op.operationId, label).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("requires nonempty summaries and model-sized descriptions on every v1 operation", async () => {
    const doc = (await dw.json("/openapi.json")).body;
    const missing: string[] = [];
    for (const { path, method, op } of apiOperations(doc)) {
      const label = `${method.toUpperCase()} ${path}`;
      if (typeof op.summary !== "string" || !op.summary.trim()) missing.push(`${label}: summary`);
      else expect(op.summary.length, label).toBeLessThanOrEqual(80);
      if (typeof op.description !== "string" || !op.description.trim()) missing.push(`${label}: description`);
      else expect(op.description.length, label).toBeLessThan(4096);
    }
    expect(missing).toEqual([]);
  });

  it("includes a concrete example for every v1 operation", async () => {
    const doc = (await dw.json("/openapi.json")).body;
    const missing = apiOperations(doc).filter(({ op }) => !hasExample(doc, op)).map(({ path, method }) => `${method.toUpperCase()} ${path}`);
    expect(missing, "examples must be emitted into OpenAPI, not only stored in registry metadata").toEqual([]);
  });

  it("documents JSON error responses with descriptions and schemas for every v1 operation", async () => {
    const doc = (await dw.json("/openapi.json")).body;
    const missing: string[] = [];
    for (const { path, method, op } of apiOperations(doc)) {
      const errors = Object.entries<any>(op.responses ?? {}).filter(([status]) => /^(?:[45](?:\d\d|XX)|default)$/.test(status));
      if (errors.length === 0) missing.push(`${method.toUpperCase()} ${path}`);
      for (const [status, value] of errors) {
        const response = resolveRef(doc, value);
        expect(response.description?.trim().length, `${method} ${path} ${status}`).toBeGreaterThan(0);
        const schema = resolveRef(doc, response.content?.["application/json"]?.schema);
        expect(schema, `${method} ${path} ${status} error schema`).toBeDefined();
        expect(schema.properties?.error, `${method} ${path} ${status} error envelope`).toBeDefined();
      }
    }
    expect(missing, "even REST-only operations need documented errors").toEqual([]);
  });
});
