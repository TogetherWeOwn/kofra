import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError } from "@kofra/core";
import { freshInstance, jsonBody } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import { commandRows, defineOperation, echoOperation, hasExample, operationInstance, resolveRef } from "./operation-fixtures";

// All registration uses the documented extension boundary, never a deep import or REST mock.
describe("operation extension contract (SPEC 6.5)", () => {
  it("exports defineOperation and dispatches its zod definition through REST", async () => {
    const op = defineOperation(echoOperation());
    const dw = await operationInstance([op]);
    const result = await dw.json("/api/v1/acceptance/echo", { key: dw.ownerKey, ...jsonBody({ message: "hello", count: 2 }) });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ message: "hello", count: 2 });
  });

  it("accepts an OperationDefinition directly and applies input defaults before the handler", async () => {
    const dw = await operationInstance([echoOperation()]);
    const result = await dw.json("/api/v1/acceptance/echo", { key: dw.ownerKey, ...jsonBody({ message: "default count" }) });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ message: "default count", count: 1 });
  });

  it.each([
    ["empty message", { message: "", count: 1 }],
    ["count below minimum", { message: "hello", count: 0 }],
    ["count above maximum", { message: "hello", count: 4 }],
    ["noninteger count", { message: "hello", count: 1.5 }],
    ["wrong type", { message: 17, count: 1 }],
  ])("rejects %s before dispatching an extension handler", async (_label, input) => {
    const calls: unknown[] = [];
    const dw = await operationInstance([echoOperation({ async handler(args) { calls.push(args); return args; } })]);
    const result = await dw.json("/api/v1/acceptance/echo", { key: dw.ownerKey, ...jsonBody(input) });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(result.body.error.hint.trim().length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it("binds flat GET input from path and query parameters", async () => {
    const dw = await operationInstance([echoOperation({
      id: "acceptance_greet",
      method: "GET",
      path: "/api/v1/acceptance/greet/{name}",
      input: z.object({ name: z.string(), suffix: z.string().default("!") }),
      output: z.object({ greeting: z.string() }),
      async handler(input) { return { greeting: `Hello ${input.name}${input.suffix}` }; },
    })]);
    const result = await dw.json("/api/v1/acceptance/greet/Ada%20Lovelace?suffix=%3F", { key: dw.ownerKey });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ greeting: "Hello Ada Lovelace?" });
  });

  it("keeps aliases working with the same validation and defaults as the canonical route", async () => {
    const dw = await operationInstance([echoOperation({ aliases: [{ method: "PUT", path: "/api/v1/acceptance/old-echo" }] })]);
    const alias = await dw.json("/api/v1/acceptance/old-echo", { key: dw.ownerKey, ...jsonBody({ message: "legacy" }), method: "PUT" });
    expect(alias.status).toBe(200);
    expect(alias.body).toEqual({ message: "legacy", count: 1 });
    const invalid = await dw.json("/api/v1/acceptance/old-echo", { key: dw.ownerKey, ...jsonBody({ message: "legacy", count: 4 }), method: "PUT" });
    expect(invalid.status).toBe(400);
    const canonical = await dw.json("/api/v1/acceptance/echo", { key: dw.ownerKey, ...jsonBody({ message: "legacy" }) });
    expect(canonical.status).toBe(200);
    expect(canonical.body).toEqual({ message: "legacy", count: 1 });
  });

  it("generates OpenAPI input/output schemas, constraints and examples from the extension", async () => {
    const dw = await operationInstance([echoOperation()]);
    const doc = (await dw.json("/openapi.json")).body;
    const op = doc.paths["/api/v1/acceptance/echo"]?.post;
    expect(op, "extension operations must be present in generated OpenAPI").toBeDefined();
    expect(op).toMatchObject({ operationId: "acceptance_echo", summary: "Echo a short message" });
    expect(op.description).toContain("Count must be between 1 and 3");
    const input = resolveRef(doc, resolveRef(doc, op.requestBody).content["application/json"].schema);
    expect(input).toMatchObject({ type: "object", required: ["message"], properties: {
      message: { type: "string", minLength: 1, maxLength: 40 },
      count: { type: "integer", minimum: 1, maximum: 3, default: 1 },
    } });
    const output = resolveRef(doc, resolveRef(doc, op.responses["200"]).content["application/json"].schema);
    expect(output).toMatchObject({ type: "object", properties: { message: { type: "string" }, count: { type: "integer" } } });
    expect(output.required).toEqual(expect.arrayContaining(["message", "count"]));
    expect(hasExample(doc, op)).toBe(true);
  });

  it("adds the extension's schema, scope and CLI path to the live command table", async () => {
    const dw = await operationInstance([echoOperation()]);
    const result = await dw.json("/api/v1/operations");
    expect(result.status).toBe(200);
    const row = commandRows(result.body).find((entry) => entry.id === "acceptance_echo");
    expect(row).toMatchObject({
      id: "acceptance_echo", method: "POST", path: "/api/v1/acceptance/echo", scopes: ["sites:read"],
      inputSchema: { type: "object", properties: { message: { type: "string", minLength: 1, maxLength: 40 }, count: { type: "integer", minimum: 1, maximum: 3, default: 1 } } },
      cli: { command: ["acceptance", "echo"], positional: ["message"] },
    });
  });

  it("lists the operation as an MCP tool with generated schemas and executes it", async () => {
    const dw = await operationInstance([echoOperation()]);
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const tools = await mcp.tools();
      const tool = tools.find((entry) => entry.name === "acceptance_echo");
      expect(tool, "an operation needs no separate mcpTools registration").toBeDefined();
      expect(tool.inputSchema).toMatchObject({ type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 3, default: 1 } } });
      expect(tool.outputSchema).toMatchObject({ type: "object", properties: { message: { type: "string" }, count: { type: "integer" } } });
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      const result = await mcp.call("acceptance_echo", { message: "from MCP" });
      expect(result.isError).toBe(false);
      expect(result.data).toEqual({ message: "from MCP", count: 1 });
    } finally {
      await mcp.client.close();
    }
  });

  it("enforces the same input constraints through MCP before running the handler", async () => {
    const calls: unknown[] = [];
    const dw = await operationInstance([echoOperation({ async handler(input) { calls.push(input); return input; } })]);
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      expect((await mcp.tools()).map((tool) => tool.name)).toContain("acceptance_echo");
      const result = await mcp.call("acceptance_echo", { message: "bad count", count: 4 });
      expect(result.isError).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      await mcp.client.close();
    }
  });

  it("preserves ApiError code and remediation on both REST and MCP", async () => {
    const dw = await operationInstance([echoOperation({ async handler() {
      throw new ApiError(409, "acceptance_conflict", "The fixture is busy.", "Retry with a different message.");
    } })]);
    const rest = await dw.json("/api/v1/acceptance/echo", { key: dw.ownerKey, ...jsonBody({ message: "conflict" }) });
    expect(rest.status).toBe(409);
    expect(rest.body.error).toMatchObject({ code: "acceptance_conflict", hint: "Retry with a different message." });
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const result = await mcp.call("acceptance_echo", { message: "conflict" });
      expect(result.isError).toBe(true);
      expect(result.data.error).toMatchObject({ code: "acceptance_conflict", hint: "Retry with a different message." });
    } finally {
      await mcp.client.close();
    }
  });

  it("passes the resolved principal, context, request, client and idempotency key to the handler", async () => {
    const dw = await operationInstance([echoOperation({
      output: z.object({ principal: z.string(), appOrigin: z.string(), path: z.string(), client: z.string().nullable(), idempotencyKey: z.string().nullable() }),
      async handler(_input, ctx) {
        return { principal: ctx.principal.kind, appOrigin: ctx.dw.config.appOrigin, path: new URL(ctx.request.url).pathname, client: ctx.client, idempotencyKey: ctx.idempotencyKey };
      },
    })]);
    const result = await dw.json("/api/v1/acceptance/echo", {
      key: dw.ownerKey, ...jsonBody({ message: "context" }),
      headers: { "Content-Type": "application/json", "X-Kofra-Client": "acceptance/1.0", "Idempotency-Key": "operation-context-1" },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ principal: "member", appOrigin: "https://dropway.test", path: "/api/v1/acceptance/echo", client: "acceptance/1.0", idempotencyKey: "operation-context-1" });
  });

  it("enforces all declared scopes on REST and MCP rather than leaving them to extension handlers", async () => {
    const calls: unknown[] = [];
    const dw = await operationInstance([echoOperation({ scopes: ["sites:read", "sites:write"], async handler(input) { calls.push(input); return input; } })]);
    const key = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ name: "operation reader", scopes: ["sites:read"] }) });
    expect(key.status).toBe(201);
    const rest = await dw.json("/api/v1/acceptance/echo", { key: key.body.key, ...jsonBody({ message: "denied" }) });
    expect(rest.status).toBe(403);
    expect(rest.body.error.code).toBe("insufficient_scope");
    const mcp = await connectMcp(dw, key.body.key);
    try {
      const denied = await mcp.call("acceptance_echo", { message: "denied" });
      expect(denied.isError).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      await mcp.client.close();
    }
  });

  it("honours mcp.exclude without removing the extension's REST route or documentation", async () => {
    const dw = await operationInstance([echoOperation({ mcp: { exclude: "REST-only integration diagnostic" } })]);
    const rest = await dw.json("/api/v1/acceptance/echo", { key: dw.ownerKey, ...jsonBody({ message: "REST only" }) });
    expect(rest.status).toBe(200);
    const doc = (await dw.json("/openapi.json")).body;
    expect(doc.paths["/api/v1/acceptance/echo"]?.post?.operationId).toBe("acceptance_echo");
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      expect((await mcp.tools()).map((tool) => tool.name)).not.toContain("acceptance_echo");
    } finally {
      await mcp.client.close();
    }
  });

  it("generates instance-local docs and tool registrations without leaking extensions into the default app", async () => {
    const dw = await operationInstance([echoOperation()]);
    expect((await dw.json("/openapi.json")).body.paths["/api/v1/acceptance/echo"]).toBeDefined();
    const plain = await freshInstance();
    expect(plain.kofra.mcpTools.map((tool) => tool.name)).not.toContain("acceptance_echo");
    const doc = await plain.json("/openapi.json");
    expect(doc.status).toBe(200);
    expect(doc.body.paths["/api/v1/acceptance/echo"]).toBeUndefined();
  });
});
