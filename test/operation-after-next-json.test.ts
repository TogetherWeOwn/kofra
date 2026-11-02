import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOperation, readJson, type CreateKofraOptions, type OperationDefinition } from "@kofra/server";
import { freshInstance } from "./helpers";

// Regression: removing readJson's cache population must break post-dispatch
// inspection, even though no middleware consumed the body before the handler.
const path = "/api/v1/after-next-json-contract";
const schema = z.object({ text: z.string(), items: z.array(z.number()) });
const raw = ' \n{\t"text" : " café ☕ 😀 ", "items" : [ 3, 1, 4 ] }\r\n\t';
const expected = { text: " café ☕ 😀 ", items: [3, 1, 4] };
const readers = ["none", "json", "text", "arrayBuffer"] as const;
type Reader = typeof readers[number];
type Transport = "generated" | "custom HTTP";

async function fixture(reader: Reader, transport: Transport) {
  const observed: unknown[] = [];
  const calls: unknown[] = [];
  const order: string[] = [];
  const apiMiddleware: NonNullable<CreateKofraOptions["apiMiddleware"]> = [async (c, next) => {
    // Intentionally no body read, clone or cache priming before dispatch.
    await next();
    if (c.req.header("X-Inspect-Body") === "after-next" && reader !== "none") {
      order.push("after next");
      const value = await c.req[reader]();
      observed.push(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    }
  }];
  const operation = defineOperation({
    id: "after_next_json_contract", toolset: "core", method: "POST", path, scopes: [],
    summary: "Echo JSON before middleware inspection", description: "Preserve original JSON for after-next API middleware.",
    input: schema, output: schema, jsonBodyMaxBytes: 128,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async handler(input) { order.push("handler"); calls.push(input); return input; },
    ...(transport === "custom HTTP" ? { http: { async handler(c) {
      const input = await readJson(c, 128);
      order.push("handler");
      calls.push(input);
      return c.json(input);
    } } } satisfies Partial<OperationDefinition> : {}),
  });
  const dw = await freshInstance({}, { operations: [operation], apiMiddleware });
  return { dw, observed, calls, order };
}

for (const transport of ["generated", "custom HTTP"] as const) {
  describe(`${transport} JSON inspection strictly after await next()`, () => {
    it.each(readers)("preserves successful dispatch and original body for %s inspection", async (reader) => {
      const { dw, observed, calls, order } = await fixture(reader, transport);
      const result = await dw.json(path, {
        key: dw.ownerKey, method: "POST",
        headers: { "Content-Type": "application/json", "X-Inspect-Body": "after-next" },
        body: raw,
      });

      expect.soft(result.status).toBe(200);
      expect.soft(result.body).toEqual(expected);
      expect.soft(calls).toEqual([expected]);
      expect.soft(order).toEqual(reader === "none" ? ["handler"] : ["handler", "after next"]);
      if (reader === "none") {
        expect(observed).toEqual([]);
      } else if (reader === "json") {
        expect(observed).toEqual([expected]);
      } else if (reader === "text") {
        expect(observed).toEqual([raw]);
      } else {
        // Compare bytes, not decoded text: whitespace and UTF-8 must survive.
        expect(observed).toEqual([new TextEncoder().encode(raw)]);
      }
    });
  });
}
