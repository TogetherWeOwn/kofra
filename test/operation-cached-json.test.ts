import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOperation, readJson, type CreateKofraOptions, type OperationDefinition } from "@kofra/server";
import { freshInstance } from "./helpers";

// Real public factory/workerd requests. A middleware read must not break a
// downstream parser, or let it count reserialized JSON instead of original bytes.
const path = "/api/v1/cached-json-contract";
const maxBytes = 128;
const schema = z.object({ text: z.string(), items: z.array(z.number()) });
const readers = ["none", "json", "text", "arrayBuffer"] as const;
type Reader = typeof readers[number];
const transports = ["generated", "custom HTTP"] as const;
type Transport = typeof transports[number];

function inspection(reader: Reader, observed: unknown[]): NonNullable<CreateKofraOptions["apiMiddleware"]> {
  return [async (c, next) => {
    // Do not consume the helper's setup request or unrelated core requests.
    if (reader !== "none" && c.req.header("X-Inspect-Body") === "yes") {
      const value = await c.req[reader]();
      observed.push(value instanceof ArrayBuffer ? new TextDecoder().decode(value) : value);
    }
    await next();
  }];
}

async function fixture(reader: Reader, transport: Transport) {
  const observed: unknown[] = [];
  const calls: unknown[] = [];
  const operation = defineOperation({
    id: "cached_json_contract", toolset: "core", method: "POST", path, scopes: [],
    summary: "Echo cached JSON input", description: "Exercise supported body-inspecting API middleware.",
    input: schema, output: schema, jsonBodyMaxBytes: maxBytes,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async handler(input) { calls.push(input); return input; },
    ...(transport === "custom HTTP" ? { http: { async handler(c) {
      const input = await readJson(c, maxBytes);
      calls.push(input);
      return c.json(input);
    } } } satisfies Partial<OperationDefinition> : {}),
  });
  const dw = await freshInstance({}, { operations: [operation], apiMiddleware: inspection(reader, observed) });
  return { dw, observed, calls };
}

// Finite, tiny byte chunks (including split UTF-8 characters), not a load test.
function streamed(text: string) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 7, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, pulled: () => offset, cancelled: () => cancelled };
}

function headers(length?: number) {
  return { "Content-Type": "application/json", "X-Inspect-Body": "yes", ...(length === undefined ? {} : { "Content-Length": String(length) }) };
}

function expectInspection(reader: Reader, observed: unknown[], raw: string, parsed: unknown) {
  expect(observed).toEqual(reader === "none" ? [] : [reader === "json" ? parsed : raw]);
}

for (const transport of transports) {
  describe(`${transport} JSON after API middleware`, () => {
    it.each(readers)("preserves the complete original parsed input after %s inspection", async (reader) => {
      const { dw, observed, calls } = await fixture(reader, transport);
      const raw = ' \n{\t"text" : " café ☕ 😀 ", "items": [3, 1, 4] }\r\n';
      const expected = { text: " café ☕ 😀 ", items: [3, 1, 4] };
      const body = streamed(raw);
      const result = await dw.json(path, { key: dw.ownerKey, method: "POST", headers: headers(), body: body.stream });
      expectInspection(reader, observed, raw, expected);
      expect.soft(result.status).toBe(200);
      expect.soft(result.body).toEqual(expected);
      expect(calls).toEqual([expected]);
    });

    it.each(readers)("accepts exactly 128 original UTF-8 bytes after %s inspection", async (reader) => {
      const { dw, observed, calls } = await fixture(reader, transport);
      const json = '{"text":"é","items":[]}';
      const raw = json + " ".repeat(128 - new TextEncoder().encode(json).length);
      expect(new TextEncoder().encode(raw)).toHaveLength(128);
      const expected = { text: "é", items: [] };
      const result = await dw.json(path, { key: dw.ownerKey, method: "POST", headers: headers(), body: streamed(raw).stream });
      expectInspection(reader, observed, raw, expected);
      expect.soft(result.status).toBe(200);
      expect.soft(result.body).toEqual(expected);
      expect(calls).toEqual([expected]);
    });

    it.each(readers)("rejects 129 original bytes including whitespace after %s inspection", async (reader) => {
      const { dw, observed, calls } = await fixture(reader, transport);
      const json = '{"text":"é","items":[]}';
      const raw = json + " ".repeat(129 - new TextEncoder().encode(json).length);
      expect(new TextEncoder().encode(raw)).toHaveLength(129);
      // Reserializing a cached parsed value would wrongly put this under budget.
      expect(new TextEncoder().encode(json).length).toBeLessThan(128);
      const result = await dw.json(path, { key: dw.ownerKey, method: "POST", headers: headers(), body: streamed(raw).stream });
      expectInspection(reader, observed, raw, { text: "é", items: [] });
      expect.soft(result.status).toBe(413);
      expect.soft(result.body).toHaveProperty("error.code");
      expect(calls).toEqual([]);
    });

    it.each(readers)("counts UTF-8 bytes rather than string length after %s inspection", async (reader) => {
      const { dw, observed, calls } = await fixture(reader, transport);
      const expected = { text: "é".repeat(60), items: [] };
      const raw = JSON.stringify(expected);
      expect(raw.length).toBeLessThan(128);
      expect(new TextEncoder().encode(raw).length).toBeGreaterThan(128);
      const result = await dw.json(path, { key: dw.ownerKey, method: "POST", headers: headers(), body: streamed(raw).stream });
      expectInspection(reader, observed, raw, expected);
      expect.soft(result.status).toBe(413);
      expect.soft(result.body).toHaveProperty("error.code");
      expect(calls).toEqual([]);
    });

    it.each(["json", "text", "arrayBuffer"] as const)("retains Content-Length rejection after %s inspection", async (reader) => {
      const { dw, calls } = await fixture(reader, transport);
      const raw = '{"text":"small parsed value","items":[]}';
      const result = await dw.json(path, { key: dw.ownerKey, method: "POST", headers: headers(129), body: streamed(raw).stream });
      expect.soft(result.status).toBe(413);
      expect(calls).toEqual([]);
    });

    it("rejects an over-budget Content-Length before pulling an uncached stream", async () => {
      const { dw, calls } = await fixture("none", transport);
      const body = streamed("not JSON");
      const result = await dw.json(path, { key: dw.ownerKey, method: "POST", headers: headers(129), body: body.stream });
      expect.soft(result.status).toBe(413);
      expect.soft(body.pulled()).toBe(0);
      expect(calls).toEqual([]);
    });

    it("cancels an uncached streamed overflow without reading the finite tail", async () => {
      const { dw, calls } = await fixture("none", transport);
      const body = streamed(JSON.stringify({ text: "x".repeat(180), items: [] }));
      const result = await dw.json(path, { key: dw.ownerKey, method: "POST", headers: headers(), body: body.stream });
      expect.soft(result.status).toBe(413);
      expect.soft(body.cancelled()).toBe(true);
      expect.soft(body.pulled()).toBeLessThan(180);
      expect(calls).toEqual([]);
    });
  });
}

describe("existing core readJson adapter after API middleware", () => {
  it.each(readers)("creates a usable key after %s inspection", async (reader) => {
    const observed: unknown[] = [];
    const dw = await freshInstance({}, { apiMiddleware: inspection(reader, observed) });
    const raw = ' \n{ "name" : "café ☕ key", "scopes" : [ "sites:read" ] }\t';
    const result = await dw.json("/api/v1/keys", { key: dw.ownerKey, method: "POST", headers: headers(), body: streamed(raw).stream });
    expectInspection(reader, observed, raw, { name: "café ☕ key", scopes: ["sites:read"] });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ name: "café ☕ key", scopes: ["sites:read"] });
    const usable = await dw.json("/api/v1/sites", { key: result.body.key });
    expect(usable.status).toBe(200);
    expect(usable.body.sites).toEqual([]);
  });
});
