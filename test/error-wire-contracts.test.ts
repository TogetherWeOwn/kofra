import { describe, expect, it } from "vitest";
import { ApiError, defaultIdentity, errorCatalogMarkdown } from "@dropway/core";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { freshInstance, jsonBody, ORIGIN } from "./helpers";

const APP = "https://configured-errors.example";

// These existing contracts should stay GREEN. In particular, a falsy delay is
// not an omitted delay, and error documentation belongs to the configured app.
describe("raw HTTP retry headers", () => {
  for (const status of [429, 503]) {
    for (const [label, existing, expected] of [
      ["absent", undefined, "1"], ["explicit", "37", "37"], ["zero", "0", "0"],
    ] as const) {
      it(`uses ${expected} for a raw ${status} with ${label} Retry-After`, async () => {
        const instance = await freshInstance({}, { routes: [({ api }) => {
          api.get("/raw-refusal", () => new Response("raw refusal", {
            status, headers: existing === undefined ? {} : { "Retry-After": existing },
          }));
        }] });
        const response = await instance.call("/api/v1/raw-refusal");
        expect(response.status).toBe(status);
        expect(response.headers.get("Retry-After")).toBe(expected);
        expect(await response.text()).toBe("raw refusal");
      });
    }
  }
});

describe("MCP identity refusal retry headers", () => {
  for (const protocol of ["2026-07-28", "2025-03-26"]) {
    for (const status of [429, 503]) {
      for (const delay of [37, 0]) {
        it(`matches the envelope for protocol ${protocol}, HTTP ${status}, delay ${delay}`, async () => {
          const instance = await freshInstance({}, { adapters: { identity: {
            async resolve(request, dw) {
              if (new URL(request.url).pathname === "/mcp") {
                throw new ApiError(status, "temporarily_unavailable", "Identity temporarily unavailable.", "Retry later.", undefined, {
                  retryable: true, retryAfterSeconds: delay,
                });
              }
              return defaultIdentity.resolve(request, dw);
            },
          } } });
          const modern = protocol === "2026-07-28";
          const response = await instance.call("/mcp", {
            ...jsonBody(modern
              ? { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
              : { jsonrpc: "2.0", id: 1, method: "initialize", params: {
                protocolVersion: protocol, capabilities: {}, clientInfo: { name: "retry-contract", version: "1.0.0" },
              } }),
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": protocol },
          });
          expect(response.status).toBe(status);
          expect(response.headers.get("Retry-After")).toBe(String(delay));
          const body = await response.json<any>();
          expect(body.error).toMatchObject({ code: "temporarily_unavailable", retryable: true, retryAfterSeconds: delay });
          expect(response.headers.get("Retry-After")).toBe(String(body.error.retryAfterSeconds));
        });
      }
    }
  }
});

describe("Worker error documentation routes", () => {
  it("serves the generated Markdown with its Markdown content type", async () => {
    const instance = await freshInstance({ appOrigin: APP });
    const response = await instance.call("/docs/errors.md", { origin: APP });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/markdown(?:;|$)/);
    expect(await response.text()).toBe(errorCatalogMarkdown());
  });

  it("links a real built-in error to an actual HTML row at the configured app origin", async () => {
    expect(APP).not.toBe(ORIGIN);
    const instance = await freshInstance({ appOrigin: APP });
    const refused = await instance.json("/api/v1/sites");
    expect(refused.status).toBe(401);
    const docs = new URL(refused.body.error.docs);
    expect(docs.origin).toBe(APP);
    expect(docs.pathname).toBe("/docs/errors");
    expect(docs.hash).toBe(`#${refused.body.error.code}`);
    const response = await instance.call(docs.href);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html(?:;|$)/);
    const html = await response.text();
    // Check the fragment target on a real row, not just a matching navigation link.
    expect(html).toMatch(new RegExp(`<tr\\b[^>]*\\bid=["']${refused.body.error.code}["']`));
    expect(html).toContain(refused.body.error.code);
  });
});

async function openApiErrorFixture() {
  const instance = await freshInstance({ appOrigin: APP }, { routes: [({ api }) => {
    api.get("/schema-refusal", () => {
      throw new ApiError(503, "temporarily_unavailable", "Try later.", "Read the site before retrying.", undefined, {
        retryAfterSeconds: 37,
        next: [{ tool: "get_site", args: { site: "schema-probe" }, why: "Read the current site." }],
      });
    });
  }] });
  const spec = await instance.json("/openapi.json", { origin: APP });
  expect(spec.status).toBe(200);
  const refused = await instance.json("/api/v1/schema-refusal", { origin: APP });
  expect(refused.status).toBe(503);
  return { schema: spec.body.components.schemas.Error, serialized: refused.body };
}

describe("generated OpenAPI Error schema", () => {
  it("declares the envelope, v2 fields and remediation item fields as required", async () => {
    const { schema } = await openApiErrorFixture();
    expect(schema.required).toEqual(expect.arrayContaining(["error", "requestId"]));
    expect(schema.properties.error.required).toEqual(expect.arrayContaining([
      "code", "message", "retryable", "retryAfterSeconds", "docs", "next",
    ]));
    expect(schema.properties.error.properties.next.items.required).toEqual(expect.arrayContaining(["tool", "args", "why"]));
  });

  it("accepts an actual serialized v2 error including a usable remediation call", async () => {
    const { schema, serialized } = await openApiErrorFixture();
    expect(serialized.error).toMatchObject({
      code: "temporarily_unavailable", retryable: true, retryAfterSeconds: 37,
      docs: `${APP}/docs/errors#temporarily_unavailable`,
      next: [{ tool: "get_site", args: { site: "schema-probe" }, why: "Read the current site." }],
    });
    expect(serialized.requestId).toEqual(expect.any(String));
    const result = await fromJsonSchema(schema)["~standard"].validate(serialized);
    expect(result.issues).toBeUndefined();
  });

  it("rejects omission of every required envelope, error and next-call field", async () => {
    const { schema, serialized } = await openApiErrorFixture();
    const validator = fromJsonSchema(schema)["~standard"];
    expect((await validator.validate(serialized)).issues).toBeUndefined();
    const paths = [
      ["error"], ["requestId"],
      ...["code", "message", "retryable", "retryAfterSeconds", "docs", "next"].map((field) => ["error", field]),
      ...["tool", "args", "why"].map((field) => ["error", "next", "0", field]),
    ];
    for (const path of paths) {
      const omitted = structuredClone(serialized);
      let parent = omitted;
      for (const segment of path.slice(0, -1)) parent = parent[segment!];
      delete parent[path.at(-1)!];
      const result = await validator.validate(omitted);
      expect(result.issues?.length, `missing ${path.join(".")} must be invalid`).toBeGreaterThan(0);
    }
  });
});
