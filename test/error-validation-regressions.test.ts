import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody, manifestEntry } from "./helpers";
import { connectMcp, connectLegacyMcp } from "./mcp-helpers";

// Validation must reject without dispatching or writing, and must not treat
// JSON Schema annotations as supplied data. Exercise both public MCP clients.
function fieldPaths(fields: unknown): string[] {
  expect(fields, "validation errors include details.fields").toBeDefined();
  const paths = Array.isArray(fields)
    ? fields.map((field) => typeof field === "string" ? field : field.path ?? field.field)
    : Object.keys(fields as object);
  return paths.map((path) => (Array.isArray(path) ? path.join(".") : String(path)).replace(/\[(\d+)\]/g, ".$1"));
}

for (const [protocol, connect] of [["modern", connectMcp], ["legacy", connectLegacyMcp]] as const) {
  describe(`${protocol} MCP JSON Schema validation regressions`, () => {
    for (const [keyword, dependency] of [
      ["dependentRequired", { dependentRequired: { mode: ["token"] } }],
      ["dependentSchemas", { dependentSchemas: { mode: { required: ["token"] } } }],
    ] as const) {
      it(`registers an extension with ${keyword}, dispatches valid input, and refuses a missing dependency`, async () => {
        const dispatched: unknown[] = [];
        const instance = await freshInstance({}, { mcpTools: [{
          name: "dependency_probe",
          description: "Requires a token when mode is supplied.",
          inputSchema: {
            type: "object",
            properties: { mode: { type: "string" }, token: { type: "string" } },
            ...dependency,
          },
          async handler(args) { dispatched.push(structuredClone(args)); return { received: args }; },
        }] });
        const client = await connect(instance, instance.ownerKey);
        try {
          const accepted = await client.call("dependency_probe", { mode: "read", token: "fixture" });
          expect(accepted.isError).toBe(false);
          expect(accepted.data.received).toEqual({ mode: "read", token: "fixture" });
          expect(dispatched).toEqual([{ mode: "read", token: "fixture" }]);
          const rejected = await client.call("dependency_probe", { mode: "read" });
          expect.soft(rejected.isError).toBe(true);
          expect.soft(dispatched, "invalid calls never reach the extension").toHaveLength(1);
          expect(rejected.data.error?.code).toBe("invalid_request");
          expect(fieldPaths(rejected.data.error?.details?.fields).length).toBeGreaterThan(0);
        } finally { await client.client.close(); }
      });
    }

    it("rejects an absent required property even when its schema has a default", async () => {
      const dispatched: unknown[] = [];
      const instance = await freshInstance({}, { mcpTools: [{
        name: "required_default_probe",
        description: "A default is an annotation, not an argument.",
        inputSchema: {
          type: "object", required: ["mode"],
          properties: { mode: { type: "string", default: "read" } },
        },
        async handler(args) { dispatched.push(structuredClone(args)); return { received: args }; },
      }] });
      const client = await connect(instance, instance.ownerKey);
      try {
        const rejected = await client.call("required_default_probe", {});
        expect.soft(rejected.isError).toBe(true);
        expect.soft(dispatched, "a default must not authorize handler dispatch").toEqual([]);
        expect(rejected.data.error?.code).toBe("invalid_request");
        expect(fieldPaths(rejected.data.error?.details?.fields)).toContain("mode");
      } finally { await client.client.close(); }
    });

    it("does not inject optional defaults into empty arguments", async () => {
      const instance = await freshInstance({}, { mcpTools: [{
        name: "optional_default_probe",
        description: "Returns the exact arguments the extension receives.",
        inputSchema: { type: "object", properties: { mode: { type: "string", default: "read" } } },
        async handler(args) { return { received: args }; },
      }] });
      const client = await connect(instance, instance.ownerKey);
      try {
        const result = await client.call("optional_default_probe", {});
        expect(result.isError).toBe(false);
        expect(result.data.received).toEqual({});
      } finally { await client.client.close(); }
    });

    it("passes valid known and unknown argument values through unchanged", async () => {
      const instance = await freshInstance({}, { mcpTools: [{
        name: "argument_identity_probe",
        description: "Preserves extension input including permitted unknown keys.",
        inputSchema: {
          type: "object", additionalProperties: true,
          properties: { mode: { type: "string", default: "read" } },
        },
        async handler(args) { return { received: args }; },
      }] });
      const client = await connect(instance, instance.ownerKey);
      try {
        const result = await client.call("argument_identity_probe", {
          mode: "write", extra: { flag: false, count: 0, empty: "", nullable: null, list: [1, "two"] },
        });
        expect(result.isError).toBe(false);
        expect(result.data.received).toEqual({
          mode: "write", extra: { flag: false, count: 0, empty: "", nullable: null, list: [1, "two"] },
        });
      } finally { await client.client.close(); }
    });
  });
}

async function storedDeploys() {
  return {
    versions: await env.DB.prepare("SELECT COUNT(*) AS count FROM versions").first<number>("count"),
    files: await env.DB.prepare("SELECT COUNT(*) AS count FROM version_files").first<number>("count"),
  };
}

async function deployFixture() {
  const instance = await freshInstance();
  const site = await instance.json("/api/v1/sites", { key: instance.ownerKey, ...jsonBody({ slug: "invalid-manifest-probe" }) });
  expect(site.status).toBe(201);
  return instance;
}

describe("REST manifest contentType runtime validation", () => {
  it("collects bad path, size, hash and contentType as a client error without a deploy write", async () => {
    const instance = await deployFixture();
    const before = await storedDeploys();
    const result = await instance.json("/api/v1/sites/invalid-manifest-probe/deploys", {
      key: instance.ownerKey,
      ...jsonBody({ files: [{ path: "../x", size: -1, sha256: "bad", contentType: 42 }] }),
    });
    expect(await storedDeploys()).toEqual(before);
    expect.soft(result.status).toBe(400);
    // Compatibility deploys retain the first semantic error, not the schema-parser code.
    expect(result.body.error?.code).toBe("invalid_path");
    expect(fieldPaths(result.body.error?.details?.fields)).toEqual(expect.arrayContaining([
      "files.0.path", "files.0.size", "files.0.sha256", "files.0.contentType",
    ]));
  });

  for (const contentType of [42, false, {}, []]) {
    it(`rejects ${JSON.stringify(contentType)} as the only invalid manifest field without writing`, async () => {
      const instance = await deployFixture();
      const entry = await manifestEntry("index.html", "valid bytes");
      const before = await storedDeploys();
      const result = await instance.json("/api/v1/sites/invalid-manifest-probe/deploys", {
        key: instance.ownerKey,
        ...jsonBody({ files: [{ path: entry.path, size: entry.size, sha256: entry.sha256, contentType }] }),
      });
      expect(await storedDeploys()).toEqual(before);
      expect.soft(result.status).toBe(400);
      expect(result.body.error?.code).toBe("invalid_manifest");
      expect(fieldPaths(result.body.error?.details?.fields)).toContain("files.0.contentType");
    });
  }

  for (const [label, optional] of [
    ["missing", {}], ["null", { contentType: null }], ["string", { contentType: "text/html" }],
  ] as const) {
    it(`accepts a ${label} contentType on an otherwise valid manifest`, async () => {
      const instance = await deployFixture();
      const entry = await manifestEntry("index.html", "valid bytes");
      const result = await instance.json("/api/v1/sites/invalid-manifest-probe/deploys", {
        key: instance.ownerKey,
        ...jsonBody({ files: [{ path: entry.path, size: entry.size, sha256: entry.sha256, ...optional }] }),
      });
      expect(result.status).toBe(201);
      expect(result.body.deploy.id).toEqual(expect.any(String));
      expect(await storedDeploys()).toEqual({ versions: 1, files: 1 });
    });
  }
});
