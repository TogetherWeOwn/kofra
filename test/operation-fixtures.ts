import { expect } from "vitest";
import { z } from "zod";
import type { KofraContext, Principal, Scope } from "@kofra/core";
import * as server from "@kofra/server";
import { freshInstance, type Instance } from "./helpers";

// SPEC 6.5's public contract, kept local until the implementation exports its types.
// No fallback implementation: missing public features fail explicit assertions.
export interface OperationFixture {
  id: string;
  toolset: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  aliases?: { method: string; path: string }[];
  scopes: Scope[];
  summary: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  mcp?: { alwaysLoad?: boolean } | { exclude: string };
  cli?: { command: string[]; positional?: string[] };
  rawBody?: boolean;
  examples?: { input: unknown; output: unknown }[];
  handler(input: any, ctx: {
    dw: KofraContext;
    principal: Principal;
    request: Request;
    client: string | null;
    idempotencyKey: string | null;
  }): Promise<any>;
}

export function echoOperation(overrides: Partial<OperationFixture> = {}): OperationFixture {
  return {
    id: "acceptance_echo",
    toolset: "core",
    method: "POST",
    path: "/api/v1/acceptance/echo",
    scopes: ["sites:read"],
    summary: "Echo a short message",
    description: "Echo a message to check an embedding application's operation registration. Returns the message and repeat count. Count must be between 1 and 3.",
    input: z.object({ message: z.string().min(1).max(40), count: z.number().int().min(1).max(3).default(1) }),
    output: z.object({ message: z.string(), count: z.number().int() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    cli: { command: ["acceptance", "echo"], positional: ["message"] },
    examples: [{ input: { message: "hello", count: 2 }, output: { message: "hello", count: 2 } }],
    async handler(input) {
      return { message: input.message, count: input.count };
    },
    ...overrides,
  };
}

export function defineOperation(definition: OperationFixture): OperationFixture {
  const define = Reflect.get(server, "defineOperation");
  expect(define, "@kofra/server must export defineOperation() (SPEC 6.5)").toBeTypeOf("function");
  return define(definition);
}

export function operationInstance(operations: OperationFixture[]): Promise<Instance> {
  // The intentional RED branch must typecheck before the new option is implemented.
  type Options = NonNullable<Parameters<typeof freshInstance>[1]> & { operations: OperationFixture[] };
  return freshInstance({ appOrigin: "https://dropway.test" }, { operations } as Options);
}

export function registry(instance: Instance): OperationFixture[] {
  const operations = Reflect.get(instance.kofra, "operations");
  expect(Array.isArray(operations), "createKofra().operations must expose the registry").toBe(true);
  expect(operations.length, "the registry must include core operations").toBeGreaterThan(0);
  return operations;
}

export function commandRows(body: any): Record<string, any>[] {
  // The spec defines the row fields, not whether the table has an envelope.
  const rows = Array.isArray(body) ? body : body?.operations;
  expect(Array.isArray(rows), "GET /api/v1/operations must return a command table").toBe(true);
  return rows;
}

export const pathShape = (path: string) => path
  .replace(/:[A-Za-z0-9_]+(\{[^}]*\})?/g, "{}")
  .replace(/\{[A-Za-z0-9_]+\}/g, "{}")
  .replace(/\/\*$/, "/{}")
  .replace(/\/$/, "");

export const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

export function apiOperations(doc: any): { path: string; method: string; op: any }[] {
  return Object.entries<Record<string, any>>(doc.paths).flatMap(([path, item]) =>
    path.startsWith("/api/v1")
      ? Object.entries(item).filter(([method]) => HTTP_METHODS.has(method)).map(([method, op]) => ({ path, method, op }))
      : []);
}

export function resolveRef(doc: any, value: any): any {
  const seen = new Set<string>();
  while (value?.$ref) {
    const ref = value.$ref;
    expect(ref, "OpenAPI references must resolve locally").toMatch(/^#\//);
    expect(seen.has(ref), `cyclic reference ${ref}`).toBe(false);
    seen.add(ref);
    value = ref.slice(2).split("/").reduce((node: any, key: string) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
    expect(value, `unresolved reference ${ref}`).toBeDefined();
  }
  return value;
}

export function hasExample(doc: any, value: any, seen = new Set<unknown>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Object.hasOwn(value, "example")) return true;
  if (value.examples && Object.keys(value.examples).length > 0) return true;
  if (value.$ref) return hasExample(doc, resolveRef(doc, value), seen);
  return Object.values(value).some((child) => hasExample(doc, child, seen));
}
