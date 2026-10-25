/** Independent black-box contract: discovery is not `api <operationId>` execution.
 * Run: npm run test:cli -- test/operations-inspection.acceptance.test.ts
 * Only synthetic catalogs/credentials and loopback HTTP; no product helper imports.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  catalogServer, cleanRoot, cliRoot, jsonError, jsonSuccess, runCli, sandbox,
  savedInstance, tempRoot, tokenSentinels,
} from "./helpers/operations-inspection.ts";

const schemaMarker = "large-schema-only-on-explicit-inspection";
const schema = {
  type: "object", properties: { slug: { type: "string", minLength: 1 }, confirm: { type: "string" },
    note: { type: "string", description: schemaMarker.repeat(120) } },
  required: ["slug", "confirm"], additionalProperties: false,
};
const catalog = [
  { id: "fixture_retire", method: "DELETE", path: "/api/v1/fixture/sites/:slug", scopes: ["sites:delete"],
    inputSchema: schema, cli: { command: ["fixture", "retire"], positional: ["slug"] } },
  { id: "fixture_read_all", method: "GET", path: "/api/v1/fixture/rows", scopes: [],
    inputSchema: { type: "object", properties: {} } },
  { id: "fixture_read", method: "POST", path: "/api/v1/fixture/read", scopes: ["sites:read", "sites:write"],
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    cli: { command: ["extension", "read"], positional: ["name"] } },
];
// Hand-derived golden rows, deliberately unsorted and with optional cli absent.
const compact = [
  { id: "fixture_retire", method: "DELETE", path: "/api/v1/fixture/sites/:slug", scopes: ["sites:delete"],
    cli: { command: ["fixture", "retire"], positional: ["slug"] } },
  { id: "fixture_read_all", method: "GET", path: "/api/v1/fixture/rows", scopes: [] },
  { id: "fixture_read", method: "POST", path: "/api/v1/fixture/read", scopes: ["sites:read", "sites:write"],
    cli: { command: ["extension", "read"], positional: ["name"] } },
];
let root: string;
let server: Awaited<ReturnType<typeof catalogServer>>;
let reply: () => Response;

beforeAll(async () => {
  root = await tempRoot();
  server = await catalogServer(() => reply());
});
beforeEach(() => {
  server.clear();
  reply = () => Response.json({ operations: catalog });
});
afterAll(async () => { await server?.close(); await cleanRoot(root); });

async function cli(args: string[]) {
  return runCli(await sandbox(root), server.origin, args);
}
function oneCatalogGet(result: Awaited<ReturnType<typeof cli>>) {
  expect(result.wire).toHaveLength(1);
  expect(server.requests.map(r => [r.method, r.url, r.body])).toEqual([["GET", "/api/v1/operations", ""]]);
}

describe("native operations inspection: controlled catalog", () => {
  it("lists compact canonical rows in server order, including extensions and absent cli", async () => {
    const result = await cli(["operations", "--json"]);
    expect(jsonSuccess(result).operations).toEqual(compact);
    expect(result.stdout).not.toContain(schemaMarker);
    oneCatalogGet(result);
    expect(result.wire[0]!.headers.authorization).toBeUndefined();
  });

  it("emits byte-stable single-value JSON on repeated list calls", async () => {
    const box = await sandbox(root);
    const a = await runCli(box, server.origin, ["operations", "--json"]);
    const b = await runCli(box, server.origin, ["operations", "--json"]);
    expect(jsonSuccess(a).operations).toEqual(compact);
    expect(jsonSuccess(b).operations).toEqual(compact);
    expect(b.stdout).toBe(a.stdout);
  });

  it("inspects an exact destructive ID without schema or invoking its DELETE path", async () => {
    const result = await cli(["operations", "fixture_retire", "--json"]);
    expect(jsonSuccess(result).operation).toEqual(compact[0]);
    expect(result.stdout).not.toContain(schemaMarker);
    oneCatalogGet(result);
  });

  it("exposes the unmodified input schema only with exact ID plus --schema", async () => {
    const result = await cli(["operations", "fixture_retire", "--schema", "--json"]);
    expect(jsonSuccess(result).operation).toEqual(catalog[0]);
    expect(result.json.operation.inputSchema.required).toEqual(["slug", "confirm"]);
    oneCatalogGet(result);
  });

  it("does not confuse prefix-related extension IDs or execute an advertised POST", async () => {
    const result = await cli(["operations", "fixture_read", "--schema", "--json"]);
    expect(jsonSuccess(result).operation).toEqual(catalog[2]);
    oneCatalogGet(result);
  });

  it("inspects a row with no optional cli without synthesizing command metadata", async () => {
    const result = await cli(["operations", "fixture_read_all", "--json"]);
    expect(jsonSuccess(result).operation).toEqual(compact[1]);
    oneCatalogGet(result);
  });

  it("treats an empty catalog as success, not login-required or command-not-found", async () => {
    reply = () => Response.json({ operations: [] });
    const result = await cli(["operations", "--json"]);
    expect(jsonSuccess(result).operations).toEqual([]);
    oneCatalogGet(result);
  });

  it("accepts a bare catalog array without changing its order or optional metadata", async () => {
    reply = () => Response.json(catalog);
    const result = await cli(["operations", "--json"]);
    expect(jsonSuccess(result).operations).toEqual(compact);
    oneCatalogGet(result);
  });

  it("preserves extension fields and cli metadata instead of stripping unknown properties", async () => {
    reply = () => Response.json({ operations: [{
      id: "extension_preview", method: "PATCH", path: "/api/v1/extension/preview", scopes: ["sites:write"],
      inputSchema: { type: "object", "x-extension-input": true },
      cli: { command: ["extension", "preview"], "x-extension-cli": { mode: "inspect" } },
      "x-extension-metadata": { label: "custom operation", flags: ["preview"] },
    }] });
    const listed = await cli(["operations", "--json"]);
    expect(jsonSuccess(listed).operations).toEqual([{
      id: "extension_preview", method: "PATCH", path: "/api/v1/extension/preview", scopes: ["sites:write"],
      cli: { command: ["extension", "preview"], "x-extension-cli": { mode: "inspect" } },
      "x-extension-metadata": { label: "custom operation", flags: ["preview"] },
    }]);
    const detail = await cli(["operations", "extension_preview", "--schema", "--json"]);
    expect(jsonSuccess(detail).operation).toEqual({
      id: "extension_preview", method: "PATCH", path: "/api/v1/extension/preview", scopes: ["sites:write"],
      inputSchema: { type: "object", "x-extension-input": true },
      cli: { command: ["extension", "preview"], "x-extension-cli": { mode: "inspect" } },
      "x-extension-metadata": { label: "custom operation", flags: ["preview"] },
    });
    expect(listed.wire).toHaveLength(1);
    expect(detail.wire).toHaveLength(1);
  });

  it.each([
    { label: "null root", body: null },
    { label: "missing operations array", body: {} },
    { label: "string root", body: "not a catalog" },
    { label: "unshaped bare row", body: [{ foo: 1 }] },
    { label: "null wrapped row", body: { operations: [null] } },
    { label: "string operations", body: { operations: "x" } },
  ])("refuses malformed catalog: $label", async ({ body }) => {
    reply = () => Response.json(body);
    const result = await cli(["operations", "--json"]);
    expect(jsonError(result, 1)).toMatchObject({ code: "invalid_catalog", hint: expect.stringMatching(/instance|--api|KOFRA_API/i) });
    expect(result.stdout + result.stderr).not.toMatch(/undefined|TypeError/);
    oneCatalogGet(result);
  });

  it.each([
    { field: "id", label: "missing", value: undefined },
    { field: "id", label: "number", value: 7 },
    { field: "id", label: "null", value: null },
    { field: "method", label: "missing", value: undefined },
    { field: "method", label: "number", value: 7 },
    { field: "method", label: "array", value: ["DELETE"] },
    { field: "path", label: "missing", value: undefined },
    { field: "path", label: "number", value: 7 },
    { field: "path", label: "null", value: null },
    { field: "scopes", label: "missing", value: undefined },
    { field: "scopes", label: "null", value: null },
    { field: "scopes", label: "string", value: "sites:delete" },
    { field: "scopes", label: "non-string member", value: ["sites:delete", 7] },
    { field: "inputSchema", label: "missing", value: undefined },
    { field: "inputSchema", label: "null", value: null },
    { field: "inputSchema", label: "array", value: [] },
    { field: "inputSchema", label: "string", value: "object" },
    { field: "inputSchema", label: "boolean", value: true },
    { field: "cli", label: "null", value: null },
    { field: "cli", label: "string", value: "fixture retire" },
    { field: "cli", label: "array", value: [] },
    { field: "cli", label: "missing command", value: {} },
    { field: "cli", label: "string command", value: { command: "fixture retire" } },
    { field: "cli", label: "non-string command member", value: { command: ["fixture", 7] } },
    { field: "cli", label: "string positional", value: { command: ["fixture", "retire"], positional: "slug" } },
    { field: "cli", label: "non-string positional member", value: { command: ["fixture", "retire"], positional: [7] } },
  ])("refuses malformed row field $field: $label even when schema output is omitted", async ({ field, value }) => {
    reply = () => Response.json({ operations: [catalog[1], { ...catalog[0], [field]: value }] });
    const result = await cli(["operations", "--json"]);
    expect(jsonError(result, 1)).toMatchObject({ code: "invalid_catalog", hint: expect.stringMatching(/instance|--api|KOFRA_API/i) });
    expect(result.stdout + result.stderr).not.toMatch(/undefined|TypeError/);
    oneCatalogGet(result);
  });

  it.each([false, true])("treats an explicit empty ID as not found, not list or missing ID (schema=%s)", async schema => {
    const result = await cli(["operations", "", ...(schema ? ["--schema"] : []), "--json"]);
    expect(jsonError(result, 4)).toMatchObject({ code: "operation_not_found", hint: expect.stringMatching(/(?:kofra\s+)?operations/) });
    expect(result.json).not.toHaveProperty("operations");
    expect(result.json).not.toHaveProperty("operation");
    oneCatalogGet(result);
  });

  it.each(["missing_operation", "fixture_re", "FIXTURE_RETIRE", "fixture retire"])(
    "refuses non-exact ID %s with a stable operation error and list remediation", async id => {
      const box = await sandbox(root);
      const a = await runCli(box, server.origin, ["operations", id, "--json"]);
      const b = await runCli(box, server.origin, ["operations", id, "--json"]);
      const error = jsonError(a, 4);
      expect(error.code).not.toBe("unknown_command");
      expect(error.message).toMatch(/operation/i);
      expect(error.hint).toMatch(/(?:kofra\s+)?operations(?:\s+--json)?/);
      expect(jsonError(b, 4)).toEqual(error);
      expect(a.wire).toHaveLength(1); expect(b.wire).toHaveLength(1);
    },
  );

  it.each([
    ["--schema"], ["fixture_read", "extra"], ["--scheam"],
    ["fixture_retire", "--yes"], ["fixture_retire", "--data", "{}"],
    ["--method", "DELETE"], ["--api"],
  ])("rejects invalid arguments %j before any request with usage remediation", async (...args) => {
    const result = await cli(["operations", ...args, "--json"]);
    const error = jsonError(result, 2);
    expect(error.message).not.toMatch(/unknown command.*operations/i);
    expect(error.hint).toMatch(/operations|--api/);
    expect(result.wire).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it("needs an instance but not a key, with actionable missing-instance JSON", async () => {
    const result = await runCli(await sandbox(root), server.origin, ["operations", "--json"], { defaultApi: false });
    const error = jsonError(result, 2);
    expect(error.hint).toMatch(/--api|KOFRA_API/);
    expect(result.wire).toEqual([]);
  });

  it("accepts explicit --api with no config or credential and never creates either", async () => {
    const result = await runCli(await sandbox(root), server.origin,
      ["operations", "--api", server.origin, "--json"], { defaultApi: false });
    expect(jsonSuccess(result).operations).toEqual(compact);
    oneCatalogGet(result);
  });

  it("resolves a keyless project instance without rewriting dropway.json", async () => {
    const box = await sandbox(root);
    await writeFile(join(box.cwd, "dropway.json"), JSON.stringify({ api: server.origin, sites: { dist: "keep-me" } }) + "\n");
    const result = await runCli(box, server.origin, ["operations", "--json"], { defaultApi: false });
    expect(jsonSuccess(result).operations).toEqual(compact);
    oneCatalogGet(result);
  });

  it("resolves a saved default instance with no key and does not fetch or mint keys", async () => {
    const box = await sandbox(root);
    await savedInstance(box, server.origin);
    const result = await runCli(box, server.origin, ["operations", "--json"], { defaultApi: false });
    expect(jsonSuccess(result).operations).toEqual(compact);
    oneCatalogGet(result);
  });

  it("preserves flag > env > project > saved instance precedence", async () => {
    const box = await sandbox(root);
    // Wrongly choosing any lower-precedence origin is refused before real egress.
    const decoy = "http://127.0.0.1:1";
    await savedInstance(box, decoy, tokenSentinels[0]);
    await writeFile(join(box.cwd, "dropway.json"), JSON.stringify({ api: decoy }));
    const result = await runCli(box, server.origin, ["operations", "--api", server.origin, "--json"],
      { env: { KOFRA_API: decoy } });
    expect(jsonSuccess(result).operations).toEqual(compact);
    oneCatalogGet(result);
  });

  it("environment instance beats project and saved defaults", async () => {
    const box = await sandbox(root);
    await savedInstance(box, "http://127.0.0.1:1");
    await writeFile(join(box.cwd, "dropway.json"), JSON.stringify({ api: "http://127.0.0.1:1" }));
    const result = await runCli(box, server.origin, ["operations", "--json"]);
    expect(jsonSuccess(result).operations).toEqual(compact);
    oneCatalogGet(result);
  });

  it("project instance beats saved default", async () => {
    const box = await sandbox(root);
    await savedInstance(box, "http://127.0.0.1:1");
    await writeFile(join(box.cwd, "dropway.json"), JSON.stringify({ api: server.origin }));
    const result = await runCli(box, server.origin, ["operations", "--json"], { defaultApi: false });
    expect(jsonSuccess(result).operations).toEqual(compact);
    oneCatalogGet(result);
  });

  it("retains legacy environment fallback, while modern instance selection wins", async () => {
    const old = "DROPWAY_"; // rebrand:keep
    const box = await sandbox(root);
    const legacy = await runCli(box, server.origin, ["operations", "--json"],
      { defaultApi: false, env: { [old + "API"]: server.origin } });
    expect(jsonSuccess(legacy).operations).toEqual(compact);
    const modern = await runCli(box, server.origin, ["operations", "--json"],
      { env: { [old + "API"]: "http://127.0.0.1:1" } });
    expect(jsonSuccess(modern).operations).toEqual(compact);
  });

  describe.each(["saved", "env", "env with --api", "--key"])("credential-free discovery with %s credentials", source => {
    it.each([
      { label: "list success", id: [], status: 200 },
      { label: "destructive ID success", id: ["fixture_retire"], status: 200 },
      { label: "list refusal", id: [], status: 401 },
      { label: "destructive ID refusal", id: ["fixture_retire"], status: 401 },
    ])("never sends Authorization on $label", async ({ id, status }) => {
      const box = await sandbox(root);
      const flags: string[] = [];
      const env: Record<string, string> = {};
      if (source === "saved") await savedInstance(box, server.origin, tokenSentinels[0]);
      if (source === "env" || source === "env with --api") env.KOFRA_API_KEY = tokenSentinels[1];
      if (source === "env with --api") {
        env.KOFRA_API = "http://127.0.0.1:1";
        flags.push("--api", server.origin);
      }
      if (source === "--key") flags.push("--key", tokenSentinels[3]);
      if (status === 401) reply = () => Response.json({ error: {
        code: "fixture_catalog_refused", message: "Public catalog refused.", hint: "Check the configured instance's discovery endpoint.",
      } }, { status });
      const result = await runCli(box, server.origin, ["operations", ...id, ...flags, "--json"],
        { defaultApi: source !== "saved", env });
      oneCatalogGet(result);
      // Check both the transport guard and the actual server, on EVERY request.
      for (const request of [...result.wire, ...server.requests]) {
        expect(request.headers, "public catalog discovery must not attach configured credentials").not.toHaveProperty("authorization");
      }
      if (status === 401) expect(jsonError(result, 3)).toMatchObject({ code: "fixture_catalog_refused", status: 401 });
      else if (id.length) expect(jsonSuccess(result).operation).toEqual(compact[0]);
      else expect(jsonSuccess(result).operations).toEqual(compact);
    });
  });

  it("never prints configured tokens or changes credentials on success or refusal", async () => {
    const box = await sandbox(root);
    await savedInstance(box, server.origin, tokenSentinels[0]);
    const options = { env: { KOFRA_API_KEY: tokenSentinels[1], KOFRA_BOOTSTRAP_KEY: tokenSentinels[2] } };
    const listed = await runCli(box, server.origin, ["operations", "--json"], options);
    expect(jsonSuccess(listed).operations).toEqual(compact);
    const missing = await runCli(box, server.origin, ["operations", "missing_operation", "--json"], options);
    jsonError(missing, 4);
  });

  it.each([[401, 3, false], [404, 4, false], [429, 7, true], [503, 7, true]] as const)(
    "preserves server %i error code/hint/status and CLI exit %i", async (status, exitCode, retryable) => {
      reply = () => Response.json({ error: { code: "fixture_catalog_unavailable", message: "Catalog unavailable.",
        hint: "Retry catalog discovery against the configured instance.", details: { fixture: true } },
        requestId: "operations-fixture-request" }, { status });
      const result = await cli(["operations", "--json"]);
      expect(jsonError(result, exitCode)).toMatchObject({ code: "fixture_catalog_unavailable", status, retryable,
        hint: "Retry catalog discovery against the configured instance.",
        details: { fixture: true }, requestId: "operations-fixture-request" });
      expect(result.wire.length).toBeGreaterThan(0);
    },
  );

  it("renders concise text list and detail without spilling large schemas", async () => {
    for (const args of [["operations"], ["operations", "fixture_retire"]]) {
      const result = await cli(args);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("fixture_retire");
      expect(result.stdout).toContain("DELETE");
      expect(result.stdout).toContain("/api/v1/fixture/sites/:slug");
      expect(result.stdout).not.toContain(schemaMarker);
      expect(result.stdout.length).toBeLessThan(2000);
    }
  });

  it("shows required scopes and CLI command paths beside each human list operation", async () => {
    const result = await cli(["operations"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const retire = result.stdout.split("\n").find(line => line.includes("fixture_retire"));
    const read = result.stdout.split("\n").find(line => /\bfixture_read\b/.test(line));
    expect(retire).toBeDefined();
    expect(read).toBeDefined();
    for (const value of ["DELETE", "/api/v1/fixture/sites/:slug", "sites:delete", "fixture retire"]) expect(retire).toContain(value);
    for (const value of ["POST", "/api/v1/fixture/read", "sites:read", "sites:write", "extension read"]) expect(read).toContain(value);
    expect(result.stdout).not.toContain(schemaMarker);
    expect(result.stdout).not.toContain("inputSchema");
    expect(result.stdout.length).toBeLessThan(2000);
    oneCatalogGet(result);
  });

  it.each([["help", "operations"], ["operations", "--help"]])("provides offline command help for %j", async (...args) => {
    const result = await cli(args);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/operations/);
    expect(result.stdout).toContain("--schema");
    expect(result.stdout).toContain("--json");
    expect(result.wire).toEqual([]);
  });

  it("advertises native operations in root help without a request", async () => {
    const result = await cli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\s*(?:kofra\s+)?operations(?:\s|$)/m);
    expect(result.wire).toEqual([]);
  });

  it("keeps the existing explicit api GET escape hatch working", async () => {
    const result = await cli(["api", "GET", "/operations", "--json"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.json.operations).toEqual(catalog);
    oneCatalogGet(result);
  });

  it("ships native discovery through the bundled CLI, not only the source launcher", async () => {
    const outfile = join(root, "bundle/dropway.mjs");
    await mkdir(join(root, "bundle"), { recursive: true });
    await build({ entryPoints: [join(cliRoot, "src/cli.ts")], bundle: true, platform: "node", format: "esm",
      target: "node20", outfile, logLevel: "silent" });
    const result = await runCli(await sandbox(root), server.origin, ["operations", "--json"], { entry: outfile });
    expect(jsonSuccess(result).operations).toEqual(compact);
    oneCatalogGet(result);
  });
});
