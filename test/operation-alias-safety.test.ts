import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildOpenApi, defineOperation, type OperationDefinition } from "@kofra/server";

function operation(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return {
    id: "alias_safety_probe",
    toolset: "core",
    method: "GET",
    path: "/api/v1/alias-safety",
    scopes: ["sites:read"],
    summary: "Check operation alias safety",
    description: "Return a diagnostic result to exercise operation alias registration and documentation.",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async handler() { return { ok: true }; },
    ...overrides,
  };
}

describe("operation alias validation", () => {
  it("accepts a valid operation and an alias within /api/v1", () => {
    const registered = defineOperation(operation({
      aliases: [{ method: "POST", path: "/api/v1/alias-safety/legacy" }],
    }));
    expect(registered.path).toBe("/api/v1/alias-safety");
    expect(registered.aliases).toEqual([{ method: "POST", path: "/api/v1/alias-safety/legacy" }]);
  });

  it("rejects __proto__ as an alias path", () => {
    expect(() => defineOperation(operation({
      aliases: [{ method: "GET", path: "__proto__" }],
    }))).toThrow();
  });

  it("rejects __proto__ as an alias method", () => {
    expect(() => defineOperation(operation({
      aliases: [{ method: "__proto__", path: "/api/v1/alias-safety/legacy" }],
    }))).toThrow();
  });

  it("rejects a canonical path in /api/v10 rather than /api/v1", () => {
    expect(() => defineOperation(operation({ path: "/api/v10/alias-safety" }))).toThrow();
  });

  it("rejects an alias path in /api/v10 rather than /api/v1", () => {
    expect(() => defineOperation(operation({
      aliases: [{ method: "GET", path: "/api/v10/alias-safety/legacy" }],
    }))).toThrow();
  });
});

describe("OpenAPI dictionary safety", () => {
  it.each([
    { label: "path", alias: { method: "GET", path: "__proto__" } },
    { label: "method", alias: { method: "__proto__", path: "/api/v1/alias-safety/legacy" } },
  ])("represents an unvalidated __proto__ $label as own data without polluting Object.prototype", ({ alias }) => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    let doc: ReturnType<typeof buildOpenApi>;
    let after: typeof before;
    try {
      // Deliberately bypass defineOperation: the public generator also accepts raw metadata.
      doc = buildOpenApi("https://dropway.test", "Alias safety", [operation({ aliases: [alias] })]);
      after = Object.getOwnPropertyDescriptors(Object.prototype);
    } finally {
      // Restore before invoking assertion machinery: a polluted `get` can break it too.
      for (const key of Reflect.ownKeys(Object.prototype)) {
        if (!Object.hasOwn(before, key)) Reflect.deleteProperty(Object.prototype, key);
      }
      Object.defineProperties(Object.prototype, before);
    }
    expect(after).toEqual(before);
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);

    const method = alias.method.toLowerCase();
    expect(Object.hasOwn(doc.paths, alias.path)).toBe(true);
    expect(Object.hasOwn(doc.paths[alias.path], method)).toBe(true);
    expect(doc.paths[alias.path][method]).toHaveProperty("responses.200");
    expect(Object.hasOwn(doc.paths, "/api/v1/alias-safety")).toBe(true);
    expect(Object.hasOwn(doc.paths["/api/v1/alias-safety"], "get")).toBe(true);

    // Own entries must survive delivery as JSON, not disappear into a map's prototype.
    const delivered = JSON.parse(JSON.stringify(doc));
    expect(Object.hasOwn(delivered.paths, alias.path)).toBe(true);
    expect(Object.hasOwn(delivered.paths[alias.path], method)).toBe(true);
    expect(delivered.paths[alias.path][method]).toHaveProperty("responses.200");
  });
});
