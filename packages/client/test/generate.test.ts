import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitClient, emitInterface, jsonSchemaToTs, toMethodName, toTypeName } from "../../../scripts/generate-client.mjs";

describe("jsonSchemaToTs", () => {
  it("maps scalar types", () => {
    expect(jsonSchemaToTs({ type: "string" })).toBe("string");
    expect(jsonSchemaToTs({ type: "integer" })).toBe("number");
    expect(jsonSchemaToTs({ type: "number" })).toBe("number");
    expect(jsonSchemaToTs({ type: "boolean" })).toBe("boolean");
    expect(jsonSchemaToTs({ type: "null" })).toBe("null");
  });

  it("maps union type arrays", () => {
    expect(jsonSchemaToTs({ type: ["string", "null"] })).toBe("string | null");
    expect(jsonSchemaToTs({ type: ["number", "null"] })).toBe("number | null");
  });

  it("maps enum and const to literal unions", () => {
    expect(jsonSchemaToTs({ type: "string", enum: ["live", "unchanged", "awaiting_upload"] })).toBe(
      '"live" | "unchanged" | "awaiting_upload"',
    );
    expect(jsonSchemaToTs({ type: "string", const: "transfer" })).toBe('"transfer"');
    expect(jsonSchemaToTs({ type: "string", enum: ["owner", "admin", "member"] })).toBe('"owner" | "admin" | "member"');
  });

  it("maps anyOf/oneOf to unions", () => {
    expect(jsonSchemaToTs({ anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }] })).toBe("string | null");
    expect(jsonSchemaToTs({ oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] })).toBe(
      "string[] | string",
    );
  });

  it("maps arrays", () => {
    expect(jsonSchemaToTs({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(jsonSchemaToTs({ type: "array", items: {} })).toBe("unknown[]");
    expect(jsonSchemaToTs({ type: "array" })).toBe("unknown[]");
  });

  it("maps an empty schema to unknown", () => {
    expect(jsonSchemaToTs({})).toBe("unknown");
  });

  it("maps records and absent property lists", () => {
    expect(jsonSchemaToTs({ type: "object", properties: {}, additionalProperties: {} })).toBe("Record<string, unknown>");
    expect(jsonSchemaToTs({ type: "object", additionalProperties: { type: "string" } })).toBe("Record<string, string>");
    expect(jsonSchemaToTs({ type: "object" })).toBe("Record<string, unknown>");
  });

  it("marks required properties and quotes unsafe names", () => {
    const ts = jsonSchemaToTs({
      type: "object",
      properties: { slug: { type: "string" }, message: { type: "string" }, "x-kofra": { type: "string" } },
      required: ["slug"],
      additionalProperties: {},
    });
    expect(ts).toContain("slug: string;");
    expect(ts).toContain("message?: string;");
    expect(ts).toContain('"x-kofra"?: string;');
  });

  it("keeps nested objects inline and carries descriptions as comments", () => {
    const ts = jsonSchemaToTs({
      type: "object",
      properties: {
        site: {
          type: "object",
          description: "The site.",
          properties: { slug: { type: "string" } },
          required: ["slug"],
        },
      },
      required: ["site"],
    });
    expect(ts).toContain("/** The site. */");
    expect(ts).toContain("site: {");
    expect(ts).toContain("slug: string;");
  });

  it("fails loudly on schema shapes it does not handle", () => {
    for (const schema of [
      { $ref: "#/$defs/x" },
      { not: { type: "string" } },
      { prefixItems: [{ type: "string" }] },
      { patternProperties: { "^x-": { type: "string" } } },
      { enum: [] },
      { anyOf: [] },
      { oneOf: [] },
    ]) {
      expect(() => jsonSchemaToTs(schema), JSON.stringify(schema)).toThrowError();
    }
  });
});

describe("naming", () => {
  it("derives method and type names from operation ids", () => {
    expect(toMethodName("create_site")).toBe("createSite");
    expect(toMethodName("whoami")).toBe("whoami");
    expect(toTypeName("create_site")).toBe("CreateSite");
    expect(toTypeName("list_api_keys")).toBe("ListApiKeys");
  });
});

describe("emitInterface", () => {
  it("emits a documented exported interface", () => {
    const text = emitInterface("CreateSiteInput", {
      type: "object",
      properties: { slug: { type: "string", description: "Omit for a generated name." } },
      additionalProperties: {},
    });
    expect(text).toContain("export interface CreateSiteInput");
    expect(text).toContain("slug?: string;");
    expect(text).toContain("Omit for a generated name.");
  });
});

describe("emitClient", () => {
  const ops = [
    {
      id: "get_site",
      method: "GET",
      path: "/api/v1/sites/{slug}",
      summary: "Get a site",
      rawBody: false,
      responseType: null,
      input: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"], additionalProperties: {} },
      output: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"], additionalProperties: {} },
    },
    {
      id: "whoami",
      method: "GET",
      path: "/api/v1/me",
      summary: "Who am I",
      rawBody: false,
      responseType: null,
      input: { type: "object", properties: {} },
      output: { type: "object", properties: { kind: { type: "string" } }, additionalProperties: {} },
    },
  ];

  it("emits input/output interfaces, the operation table and typed methods", () => {
    const text = emitClient(ops);
    expect(text).toContain("DO NOT EDIT");
    expect(text).toContain("export interface GetSiteInput");
    expect(text).toContain("export interface GetSiteOutput");
    expect(text).toContain("export interface WhoamiOutput");
    expect(text).toContain("get_site");
    expect(text).toContain('method: "GET"');
    expect(text).toContain('path: "/api/v1/sites/{slug}"');
    expect(text).toContain("async getSite(input: GetSiteInput");
    expect(text).toContain('this.call<GetSiteInput, GetSiteOutput>(OPERATIONS["get_site"], input, opts)');
    expect(text).toContain("Promise<GetSiteOutput>");
  });

  it("makes the input optional when the operation takes no properties", () => {
    const text = emitClient(ops);
    expect(text).toContain("async whoami(input?: WhoamiInput");
  });
});

describe("generated client freshness", () => {
  it("matches what the generator produces from the current registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dropway-client-"));
    const out = join(dir, "generated.ts");
    await new Promise<void>((resolve, reject) => {
      execFile("node", ["scripts/generate-client.mjs", "--out", out], { cwd: join(__dirname, "..", "..", "..") }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    const checkedIn = readFileSync(join(__dirname, "..", "src", "generated.ts"), "utf8");
    expect(readFileSync(out, "utf8")).toBe(checkedIn);
  }, 60_000);
});
