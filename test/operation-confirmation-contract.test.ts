import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createKofra, type OperationDefinition } from "@kofra/server";
import { freshInstance, jsonBody } from "./helpers";
import { connectMcp } from "./mcp-helpers";

const inputSchema = z.object({ name: z.string().min(1), confirm: z.string() });

function destructiveOperation(calls: unknown[], input: z.ZodType = inputSchema): OperationDefinition {
  return {
    id: "acceptance_remove_named_resource",
    toolset: "core",
    method: "POST",
    path: "/api/v1/acceptance/remove-named-resource",
    scopes: ["sites:write"],
    summary: "Remove a named resource",
    description: "Check declarative destructive-operation confirmation. Confirm must exactly match the resource name before the handler runs.",
    input,
    output: z.object({ deleted: z.boolean() }),
    confirm: "name",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async handler(args) {
      calls.push(args);
      return { deleted: true };
    },
  };
}

// The handler deliberately has no confirmation logic: the registry must enforce it.
describe("declarative operation confirmation (SPEC 6.5)", () => {
  it("rejects a mismatched REST confirmation before invoking the handler", async () => {
    const calls: unknown[] = [];
    const operation = destructiveOperation(calls);
    const dw = await freshInstance({}, { operations: [operation] });
    const result = await dw.json(operation.path, {
      key: dw.ownerKey,
      ...jsonBody({ name: "release-notes", confirm: "another-resource" }),
    });

    expect.soft(calls, "mismatched confirmation must not execute the operation").toEqual([]);
    expect.soft(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "confirm_mismatch", hint: expect.any(String), details: { expected: "release-notes" } },
    });
    expect(result.body.error.hint.trim().length).toBeGreaterThan(0);
  });

  it("executes the REST handler once when confirmation matches exactly", async () => {
    const calls: unknown[] = [];
    const operation = destructiveOperation(calls);
    const dw = await freshInstance({}, { operations: [operation] });
    const result = await dw.json(operation.path, {
      key: dw.ownerKey,
      ...jsonBody({ name: "release-notes", confirm: "release-notes" }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ deleted: true });
    expect(calls).toEqual([{ name: "release-notes", confirm: "release-notes" }]);
  });

  it("rejects missing REST confirmation through input validation before invoking the handler", async () => {
    const calls: unknown[] = [];
    const operation = destructiveOperation(calls);
    const dw = await freshInstance({}, { operations: [operation] });
    const result = await dw.json(operation.path, {
      key: dw.ownerKey,
      ...jsonBody({ name: "release-notes" }),
    });

    expect(result.status).toBe(400);
    expect(result.body.error.code).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(result.body.error.code).not.toBe("confirm_mismatch");
    expect(result.body.error.hint.trim().length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it("rejects a mismatched MCP confirmation before invoking the handler", async () => {
    const calls: unknown[] = [];
    const operation = destructiveOperation(calls);
    const dw = await freshInstance({}, { operations: [operation] });
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const result = await mcp.call(operation.id, { name: "release-notes", confirm: "another-resource" });

      expect.soft(calls, "mismatched confirmation must not execute the operation").toEqual([]);
      expect.soft(result.isError).toBe(true);
      expect(result.data).toMatchObject({
        error: { code: "confirm_mismatch", hint: expect.any(String), details: { expected: "release-notes" } },
      });
      expect(result.data.error.hint.trim().length).toBeGreaterThan(0);
    } finally {
      await mcp.client.close();
    }
  });

  it("executes the MCP handler once when confirmation matches exactly", async () => {
    const calls: unknown[] = [];
    const operation = destructiveOperation(calls);
    const dw = await freshInstance({}, { operations: [operation] });
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const result = await mcp.call(operation.id, { name: "release-notes", confirm: "release-notes" });

      expect(result.isError).toBe(false);
      expect(result.data).toEqual({ deleted: true });
      expect(calls).toEqual([{ name: "release-notes", confirm: "release-notes" }]);
    } finally {
      await mcp.client.close();
    }
  });

  it("rejects missing MCP confirmation through input validation before invoking the handler", async () => {
    const calls: unknown[] = [];
    const operation = destructiveOperation(calls);
    const dw = await freshInstance({}, { operations: [operation] });
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const result = await mcp.call(operation.id, { name: "release-notes" });

      expect(result.isError).toBe(true);
      expect(calls).toEqual([]);
    } finally {
      await mcp.client.close();
    }
  });

  it.each([
    ["missing confirmation", z.object({ name: z.string().min(1) })],
    ["optional confirmation", z.object({ name: z.string().min(1), confirm: z.string().optional() })],
    ["non-string confirmation", z.object({ name: z.string().min(1), confirm: z.number() })],
    ["nullable confirmation", z.object({ name: z.string().min(1), confirm: z.string().nullable() })],
    ["missing target", z.object({ confirm: z.string() })],
    ["optional target", z.object({ name: z.string().optional(), confirm: z.string() })],
    ["non-string target", z.object({ name: z.number(), confirm: z.string() })],
    ["nullable target", z.object({ name: z.string().nullable(), confirm: z.string() })],
  ])("rejects registration with %s rather than ignoring confirm metadata", (_label, input) => {
    const calls: unknown[] = [];
    expect(() => createKofra({ operations: [destructiveOperation(calls, input)] })).toThrow();
    expect(calls).toEqual([]);
  });
});
