import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createKofra, defineOperation, type OperationDefinition } from "@kofra/server";
import { BOOTSTRAP, form, freshInstance, jsonBody } from "./helpers";

// All requests enter the public factory and run inside workerd. These handlers
// deliberately have no service-level guards: operation metadata must protect them.
function operation(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return defineOperation({
    id: "review_transport", toolset: "core", method: "POST",
    path: "/api/v1/review-transport", scopes: [],
    summary: "Exercise operation transport boundaries",
    description: "Return a small result through the public operation registration boundary.",
    input: z.object({}), output: z.object({ count: z.number() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async handler() { return { count: 1 }; },
    ...overrides,
  });
}

describe("custom HTTP operation authorization", () => {
  it.each([
    { credential: "absent", status: 401 },
    { credential: "bootstrap", status: 403 },
    { credential: "reader", status: 403 },
  ])("rejects $credential before invoking a private members:write adapter", async ({ credential, status }) => {
    let calls = 0;
    const dw = await freshInstance({}, { operations: [operation({
      scopes: ["members:write"],
      http: { handler(c) { calls++; return c.json({ count: 1 }); } },
    })] });
    const reader = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ scopes: ["sites:read"] }) });
    expect(reader.status).toBe(201);
    const key = credential === "bootstrap" ? BOOTSTRAP : credential === "reader" ? reader.body.key : null;
    const denied = await dw.json("/api/v1/review-transport", { key, ...jsonBody({}) });
    expect.soft(denied.status).toBe(status);
    expect.soft(denied.body).toHaveProperty("error.code");
    expect.soft(calls).toBe(0);
    const allowed = await dw.json("/api/v1/review-transport", { key: dw.ownerKey, ...jsonBody({}) });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ count: 1 });
    expect(calls).toBe(1);
  });

  it("retains explicit anonymous opt-in for a custom HTTP adapter", async () => {
    let calls = 0;
    const dw = await freshInstance({}, { operations: [operation({
      anonymous: true,
      http: { handler(c) { calls++; return c.json({ count: 2 }); } },
    })] });
    const result = await dw.json("/api/v1/review-transport", jsonBody({}));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ count: 2 });
    expect(calls).toBe(1);
  });

  it("preserves core setup/recovery, public discovery, anonymous publishing and claim compatibility", async () => {
    // freshInstance itself proves bootstrap setup still succeeds through the core adapter.
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const recovery = await dw.json("/api/v1/setup/recover", { key: BOOTSTRAP, method: "POST" });
    expect(recovery.status).toBe(201);
    expect((await dw.json("/api/v1/me", { key: recovery.body.apiKey.key })).body.member.role).toBe("owner");
    const publicTable = await dw.json("/api/v1/operations");
    expect(publicTable.status).toBe(200);
    const bootstrapTable = await dw.json("/api/v1/operations", { key: BOOTSTRAP });
    expect(bootstrapTable.status).toBe(200);
    expect(bootstrapTable.body).toEqual(publicTable.body);
    const published = await dw.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "anonymous fixture" }) });
    expect(published.status).toBe(201);
    const updated = await dw.json("/api/v1/publish", { method: "POST", key: published.body.claimToken, body: form({ "index.html": "claim update" }) });
    expect(updated.status).toBe(200);
    expect(updated.body.slug).toBe(published.body.slug);
    const claimed = await dw.json(`/api/v1/sites/${published.body.slug}/claim`, {
      key: dw.ownerKey, ...jsonBody({ claimToken: published.body.claimToken }),
    });
    expect(claimed.status).toBe(200);
    expect(claimed.body.site.anonymous).toBe(false);
  });
});

// Small finite streams make consumption/cancellation observable without load testing.
function trackedBody(chunks: string[]) {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[pulled++]!));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

async function boundedInstance(calls: unknown[]) {
  // Forward-compatible metadata is intentionally supplied without an unsafe cast.
  // The baseline does not implement it; the builder adds this optional public field.
  const bounded = { ...operation({
    input: z.object({ text: z.string() }),
    async handler(input) { calls.push(input); return { count: (input as { text: string }).text.length }; },
  }), jsonBodyMaxBytes: 128 };
  return freshInstance({}, { operations: [bounded] });
}

describe("generated JSON body byte bounds", () => {
  it("defaults to a finite 8 MiB cap without allocating an oversized fixture", async () => {
    let calls = 0;
    const dw = await freshInstance({}, { operations: [operation({ async handler() { calls++; return { count: 1 }; } })] });
    const body = trackedBody(['not JSON']);
    const result = await dw.json("/api/v1/review-transport", {
      key: dw.ownerKey, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "8388609" }, body: body.stream,
    });
    expect.soft(result.status).toBe(413);
    expect.soft(body.pulled()).toBe(0);
    expect(calls).toBe(0);
  });

  it("rejects an oversized declared Content-Length before reading or parsing", async () => {
    const calls: unknown[] = [];
    const dw = await boundedInstance(calls);
    const body = trackedBody(['not JSON']);
    const result = await dw.json("/api/v1/review-transport", {
      key: dw.ownerKey, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "129" }, body: body.stream,
    });
    expect.soft(result.status).toBe(413);
    expect.soft(body.pulled()).toBe(0);
    expect(calls).toEqual([]);
  });

  it("cancels a streamed overflow before consuming the rest or invoking the handler", async () => {
    const calls: unknown[] = [];
    const dw = await boundedInstance(calls);
    const chunks = ['{"text":"', "x".repeat(64), "x".repeat(64), "x".repeat(64), '"}'];
    const body = trackedBody(chunks);
    const result = await dw.json("/api/v1/review-transport", {
      key: dw.ownerKey, method: "POST", headers: { "Content-Type": "application/json" }, body: body.stream,
    });
    expect.soft(result.status).toBe(413);
    expect.soft(body.cancelled()).toBe(true);
    expect.soft(body.pulled()).toBeLessThan(chunks.length);
    expect.soft(calls).toEqual([]);
  });

  it("counts actual UTF-8 bytes, not JavaScript string length", async () => {
    const calls: unknown[] = [];
    const dw = await boundedInstance(calls);
    // 71 UTF-16 code units, but 131 UTF-8 bytes including the JSON envelope.
    const body = JSON.stringify({ text: "é".repeat(60) });
    expect(body.length).toBe(71);
    expect(new TextEncoder().encode(body).length).toBe(131);
    const result = await dw.json("/api/v1/review-transport", {
      key: dw.ownerKey, method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    expect.soft(result.status).toBe(413);
    expect.soft(calls).toEqual([]);
  });

  it("accepts an exactly-at-limit body and rejects the next byte", async () => {
    const calls: unknown[] = [];
    const dw = await boundedInstance(calls);
    const normal = await dw.json("/api/v1/review-transport", { key: dw.ownerKey, ...jsonBody({ text: "x".repeat(117) }) });
    expect(normal.status).toBe(200);
    expect(normal.body).toEqual({ count: 117 });
    expect(calls).toEqual([{ text: "x".repeat(117) }]);
    const overflow = await dw.json("/api/v1/review-transport", { key: dw.ownerKey, ...jsonBody({ text: "x".repeat(118) }) });
    expect.soft(overflow.status).toBe(413);
    expect.soft(calls).toHaveLength(1);
  });
});

describe("raw body retry definition safety", () => {
  it("rejects generated rawBody plus tool.idempotent at definition time", () => {
    expect(() => operation({
      rawBody: true, tool: { idempotent: true }, mcp: { exclude: "Requires original HTTP bytes" },
    })).toThrow(/raw|idempot|unsupported/i);
  });

  it("keeps non-idempotent raw bytes unread until the handler consumes them", async () => {
    const body = trackedBody(["first ", "é", " last"]);
    const raw = {
      ...operation({
        rawBody: true, tool: { idempotent: false }, mcp: { exclude: "Requires original HTTP bytes" },
        output: z.object({ content: z.string(), initiallyUsed: z.boolean(), initiallyPulled: z.number() }),
        async handler(_input, ctx) {
          const initiallyUsed = ctx.request.bodyUsed;
          const initiallyPulled = body.pulled();
          const content = new TextDecoder().decode(await ctx.request.arrayBuffer());
          return { content, initiallyUsed, initiallyPulled };
        },
      }), jsonBodyMaxBytes: 1,
    };
    const dw = await freshInstance({}, { operations: [raw] });
    const result = await dw.json("/api/v1/review-transport", {
      key: dw.ownerKey, method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: body.stream,
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ content: "first é last", initiallyUsed: false, initiallyPulled: 0 });
    expect(body.cancelled()).toBe(false);
  });

  it("allows a legacy custom HTTP adapter to own raw-body idempotency", async () => {
    const op = operation({
      rawBody: true, tool: { idempotent: true }, mcp: { exclude: "Legacy raw HTTP adapter" },
      http: { async handler(c) { return c.json({ content: await c.req.text() }); } },
    });
    expect(() => createKofra({ operations: [op] })).not.toThrow();
    const dw = await freshInstance({}, { operations: [op] });
    const result = await dw.json("/api/v1/review-transport", { key: dw.ownerKey, method: "POST", body: "legacy bytes" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ content: "legacy bytes" });
  });
});

describe("typed URL scalar binding", () => {
  it.each([
    { path: "42", status: 200, expected: { id: 42 } },
    { path: "not-a-number", status: 400, expected: null },
    { path: "1.5", status: 400, expected: null },
  ])("decodes integer path $path with status $status", async ({ path, status, expected }) => {
    const calls: unknown[] = [];
    const schema = z.object({ id: z.number().int() });
    const dw = await freshInstance({}, { operations: [operation({
      method: "GET", path: "/api/v1/review-items/{id}", input: schema, output: schema,
      async handler(input) { calls.push(input); return input; },
    })] });
    const result = await dw.json(`/api/v1/review-items/${path}`, { key: dw.ownerKey });
    expect(result.status).toBe(status);
    if (expected) {
      expect(result.body).toEqual(expected);
      expect(calls).toEqual([expected]);
    } else expect(calls).toEqual([]);
  });

  it.each([
    { query: "count=2&enabled=true", status: 200, expected: { count: 2, enabled: true } },
    { query: "count=2&enabled=false", status: 200, expected: { count: 2, enabled: false } },
    { query: "count=wrong&enabled=true", status: 400, expected: null },
    { query: "count=2&enabled=wrong", status: 400, expected: null },
    { query: "count=null&enabled=false", status: 400, expected: null },
    { query: "count=2&enabled=null", status: 400, expected: null },
  ])("decodes nullable URL scalars without inventing values: $query", async ({ query, status, expected }) => {
    const calls: unknown[] = [];
    const schema = z.object({ count: z.number().nullable(), enabled: z.boolean().nullable() });
    const dw = await freshInstance({}, { operations: [operation({
      method: "GET", input: schema, output: schema,
      async handler(input) { calls.push(input); return input; },
    })] });
    const result = await dw.json(`/api/v1/review-transport?${query}`, { key: dw.ownerKey });
    // A transport may explicitly support JSON null, but must never turn it into 0/false.
    if (query.includes("null") && result.status === 200) {
      const nullInput = query.startsWith("count=null") ? { count: null, enabled: false } : { count: 2, enabled: null };
      expect(result.body).toEqual(nullInput);
      expect(calls).toEqual([nullInput]);
    } else {
      expect(result.status).toBe(status);
      if (expected) expect(result.body).toEqual(expected);
      expect(calls).toEqual(expected ? [expected] : []);
    }
  });

  it.each([{ count: "2", enabled: true }, { count: 2, enabled: "false" }])("does not coerce JSON body strings: %j", async (input) => {
    const calls: unknown[] = [];
    const dw = await freshInstance({}, { operations: [operation({
      input: z.object({ count: z.number().nullable(), enabled: z.boolean().nullable() }),
      async handler(value) { calls.push(value); return { count: 1 }; },
    })] });
    const result = await dw.json("/api/v1/review-transport", { key: dw.ownerKey, ...jsonBody(input) });
    expect(result.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

// Run the isolated in-memory mutants in operation-review.mutants.config.ts.
// Removing the private guard, reversing URL/body precedence, or bypassing the
// output parser must turn the corresponding safety contract red.
describe("generated REST safety contracts", () => {
  it.each([{ key: null, status: 401 }, { key: BOOTSTRAP, status: 403 }])("private guard rejects $status before dispatch", async ({ key, status }) => {
    let calls = 0;
    const dw = await freshInstance({}, { operations: [operation({ async handler() { calls++; return { count: 1 }; } })] });
    const denied = await dw.json("/api/v1/review-transport", { key, ...jsonBody({}) });
    expect.soft(denied.status).toBe(status);
    expect.soft(calls).toBe(0);
    const allowed = await dw.json("/api/v1/review-transport", { key: dw.ownerKey, ...jsonBody({}) });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ count: 1 });
  });

  it("generated anonymous:true explicitly permits an unauthenticated caller", async () => {
    let calls = 0;
    const dw = await freshInstance({}, { operations: [operation({ anonymous: true, async handler() { calls++; return { count: 3 }; } })] });
    const result = await dw.json("/api/v1/review-transport", jsonBody({}));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ count: 3 });
    expect(calls).toBe(1);
  });

  it.each(["POST", "PATCH"] as const)("URL wins over a conflicting %s JSON resource name", async (method) => {
    const calls: unknown[] = [];
    const schema = z.object({ name: z.string(), count: z.number() });
    const dw = await freshInstance({}, { operations: [operation({
      method, path: "/api/v1/review-items/{name}", input: schema, output: schema,
      async handler(input) { calls.push(input); return input; },
    })] });
    const result = await dw.json("/api/v1/review-items/url-resource", {
      key: dw.ownerKey, ...jsonBody({ name: "body-resource", count: 7 }), method,
    });
    expect(result.status).toBe(200);
    expect.soft(result.body).toEqual({ name: "url-resource", count: 7 });
    expect.soft(calls).toEqual([{ name: "url-resource", count: 7 }]);
  });

  it("invalid output returns only a 500 invalid_operation_output error, not success data", async () => {
    let calls = 0;
    const dw = await freshInstance({}, { operations: [operation({
      async handler() { calls++; return { count: "7" }; },
    })] });
    const result = await dw.json("/api/v1/review-transport", { key: dw.ownerKey, ...jsonBody({}) });
    expect.soft(result.status).toBe(500);
    expect.soft(result.body).toMatchObject({ error: { code: "invalid_operation_output" } });
    expect.soft(result.body).not.toHaveProperty("count");
    expect(calls).toBe(1);
  });

  it("valid output returns the numeric success payload", async () => {
    const dw = await freshInstance({}, { operations: [operation()] });
    const result = await dw.json("/api/v1/review-transport", { key: dw.ownerKey, ...jsonBody({}) });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ count: 1 });
    expect(result.body).not.toHaveProperty("error");
  });
});
