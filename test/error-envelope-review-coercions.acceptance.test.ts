import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody, manifestEntry, type Instance } from "./helpers";
import { connectLegacyMcp, connectMcp, type ToolCall } from "./mcp-helpers";

// Independent review regressions: exercise real REST/MCP boundaries, not service mocks.
const poison = { toString: null };
const numberPoison = { valueOf: null, toString: null };
const slug = "24680";
const siteApi = `/api/v1/sites/${slug}`;

function fields(error: Record<string, any>): Array<{ path: string; message: string }> {
  expect(error.details?.fields, "client errors identify actionable fields").toBeInstanceOf(Array);
  return error.details.fields.map((field: Record<string, any>) => ({
    path: String(field.path ?? field.field).replace(/\[(\d+)\]/g, ".$1"),
    message: field.message ?? field.problem,
  }));
}

function clientError(result: { status: number; body: Record<string, any> }, paths: string[], code?: string) {
  expect(result.status, JSON.stringify(result.body)).toBe(400);
  expect(result.body.error.code).not.toBe("internal_error");
  if (code) expect(result.body.error.code).toBe(code);
  expect(result.body.error.retryable).toBe(false);
  const diagnostics = fields(result.body.error);
  expect(diagnostics.map((field) => field.path)).toEqual(expect.arrayContaining(paths));
  for (const path of paths) {
    expect(diagnostics.find((field) => field.path === path)?.message).toEqual(expect.any(String));
    expect(diagnostics.find((field) => field.path === path)?.message.trim().length).toBeGreaterThan(0);
  }
}

// Compare rows, blob bytes and cache values, not just counts: an UPDATE is a mutation too.
async function storage() {
  const rows: Record<string, unknown[]> = {};
  for (const table of ["sites", "versions", "version_files", "blobs", "blob_scopes"]) {
    const result = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    rows[table] = result.results.map((row) => JSON.stringify(row)).sort();
  }
  const objects = await env.FILES.list();
  expect(objects.truncated, "fixture fits in one R2 page").toBe(false);
  const blobs = await Promise.all(objects.objects.map(async ({ key }) => {
    const object = await env.FILES.get(key);
    expect(object).not.toBeNull();
    return { key, bytes: Array.from(new Uint8Array(await object!.arrayBuffer())),
      httpMetadata: object!.httpMetadata, customMetadata: object!.customMetadata };
  }));
  const keys = await env.CACHE.list();
  expect(keys.list_complete, "fixture fits in one KV page").toBe(true);
  const cache = await Promise.all(keys.keys.map(async ({ name }) => ({
    name, value: await env.CACHE.get(name),
  })));
  return { rows, blobs: blobs.sort((a, b) => a.key.localeCompare(b.key)), cache: cache.sort((a, b) => a.name.localeCompare(b.name)) };
}

async function fixture() {
  const instance = await freshInstance();
  const created = await instance.json("/api/v1/sites", {
    key: instance.ownerKey, ...jsonBody({ slug }),
  });
  expect(created.status).toBe(201);
  const seeded = await patch(instance, {
    files: ["index.txt", "keep.txt", "123"].map((path) => ({ path, content: "seed" })),
  });
  expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
  expect(seeded.body.version.live).toBe(true);
  return { instance, versionId: seeded.body.version.id as string };
}

function patch(instance: Instance, body: unknown) {
  return instance.json(`${siteApi}/files`, {
    key: instance.ownerKey, ...jsonBody(body), method: "PATCH",
  });
}

async function rejectedWithoutMutation(instance: Instance, request: () => Promise<{ status: number; body: Record<string, any> }>, paths: string[], code?: string) {
  const before = await storage();
  const result = await request();
  expect(await storage(), "rejected input leaves D1, R2 and KV unchanged").toEqual(before);
  clientError(result, paths, code);
}

describe("F1 REST deploy and create-site coercions", () => {
  for (const name of ["baseVersionId", "message"] as const) {
    it(`rejects deploy ${name} poison with a field error and no writes`, async () => {
      const { instance } = await fixture();
      const { bytes: _bytes, ...entry } = await manifestEntry("new.txt", "new bytes");
      await rejectedWithoutMutation(instance, () => instance.json(`${siteApi}/deploys`, {
        key: instance.ownerKey, ...jsonBody({ files: [entry], [name]: poison }),
      }), [name]);
    });
  }

  for (const name of ["title", "password"] as const) {
    it(`rejects create-site ${name} poison before creating anything`, async () => {
      const instance = await freshInstance();
      await rejectedWithoutMutation(instance, () => instance.json("/api/v1/sites", {
        key: instance.ownerKey, ...jsonBody({ slug: "poison-create", [name]: poison }),
      }), [name]);
    });
  }

  for (const value of [1234, "release text"]) {
    it(`preserves create-site and deploy coercion for ${typeof value}`, async () => {
      const instance = await freshInstance();
      const created = await instance.json("/api/v1/sites", {
        key: instance.ownerKey, ...jsonBody({ slug, title: value, password: value }),
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const site = await env.DB.prepare("SELECT title, password_hash FROM sites WHERE slug = ?")
        .bind(slug).first<{ title: string; password_hash: string }>();
      expect(site?.title).toBe(String(value));
      expect(site?.password_hash).toEqual(expect.any(String));
      const { bytes: _bytes, ...entry } = await manifestEntry("new.txt", "new bytes");
      const deployed = await instance.json(`${siteApi}/deploys`, {
        key: instance.ownerKey, ...jsonBody({ files: [{ ...entry, size: String(entry.size), sha256: entry.sha256.toUpperCase() }], message: value, baseVersionId: "" }),
      });
      expect(deployed.status, JSON.stringify(deployed.body)).toBe(201);
      const version = await env.DB.prepare("SELECT message FROM versions WHERE id = ?")
        .bind(deployed.body.deploy.id).first<{ message: string }>();
      expect(version?.message).toBe(String(value));
      const file = await env.DB.prepare("SELECT size, sha256 FROM version_files WHERE version_id = ?")
        .bind(deployed.body.deploy.id).first();
      expect(file).toEqual({ size: entry.size, sha256: entry.sha256 });
    });
  }

  it("accepts the current string baseVersionId rather than rejecting all supplied references", async () => {
    const { instance, versionId } = await fixture();
    const { bytes: _bytes, ...entry } = await manifestEntry("new.txt", "new bytes");
    const result = await instance.json(`${siteApi}/deploys`, {
      key: instance.ownerKey, ...jsonBody({ files: [entry], baseVersionId: versionId, message: null }),
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(await env.DB.prepare("SELECT base_version_id, message FROM versions WHERE id = ?")
      .bind(result.body.deploy.id).first()).toEqual({ base_version_id: versionId, message: null });
  });

  it("preserves invalid_path and all malformed manifest sibling fields", async () => {
    const { instance } = await fixture();
    await rejectedWithoutMutation(instance, () => instance.json(`${siteApi}/deploys`, {
      key: instance.ownerKey,
      ...jsonBody({ files: [{ path: "../escape", size: numberPoison, sha256: poison, contentType: 42 }] }),
    }), ["files.0.path", "files.0.size", "files.0.sha256", "files.0.contentType"], "invalid_path");
  });

  it("preserves invalid_manifest for a bad MIME value on a valid manifest entry", async () => {
    const { instance } = await fixture();
    const { bytes: _bytes, ...entry } = await manifestEntry("new.txt", "new bytes");
    await rejectedWithoutMutation(instance, () => instance.json(`${siteApi}/deploys`, {
      key: instance.ownerKey, ...jsonBody({ files: [{ ...entry, contentType: 42 }] }),
    }), ["files.0.contentType"], "invalid_manifest");
  });
});

const sourcePoisons = [
  ["sha256", { sha256: poison, size: 4 }, "files.1.sha256"],
  ["size", { sha256: "a".repeat(64), size: numberPoison }, "files.1.size"],
  ["copyFrom.site", { copyFrom: { site: poison, version: 1, path: "123" } }, "files.1.copyFrom.site"],
  ["copyFrom.version", { copyFrom: { site: slug, version: poison, path: "123" } }, "files.1.copyFrom.version"],
  ["copyFrom.path", { copyFrom: { site: slug, version: 1, path: poison } }, "files.1.copyFrom.path"],
] as const;

describe("F2 REST partial-update coercions", () => {
  for (const [name, source, path] of sourcePoisons) {
    it(`rejects ${name} poison without committing earlier valid writes, deletes or moves`, async () => {
      const { instance } = await fixture();
      await rejectedWithoutMutation(instance, () => patch(instance, {
        files: [{ path: "inline.txt", content: "must not be stored" }, { path: "bad.txt", ...source }],
        delete: ["keep.txt"], move: [{ from: "index.txt", to: "moved.txt" }],
      }), [path]);
    });
  }

  for (const name of ["baseVersionId", "message"] as const) {
    it(`rejects PATCH ${name} poison with a field error and no mutation`, async () => {
      const { instance } = await fixture();
      await rejectedWithoutMutation(instance, () => patch(instance, {
        files: [{ path: "new.txt", content: "new bytes" }], [name]: poison,
      }), [name]);
    });
  }

  it("collects malformed fields from multiple source entries without a 500", async () => {
    const { instance } = await fixture();
    await rejectedWithoutMutation(instance, () => patch(instance, {
      files: [
        { path: "bad-hash.txt", sha256: poison, size: 4 },
        { path: "bad-size.txt", sha256: "a".repeat(64), size: numberPoison },
        { path: "../escape", content: "bad path" },
        { path: "copy.txt", copyFrom: { site: poison, version: poison, path: poison } },
      ],
    }), ["files.0.sha256", "files.1.size", "files.2.path", "files.3.copyFrom.site", "files.3.copyFrom.version", "files.3.copyFrom.path"]);
  });

  it("retains semantic source-path validation when there is no coercion exception", async () => {
    const { instance } = await fixture();
    await rejectedWithoutMutation(instance, () => patch(instance, {
      files: [{ path: "../escape", content: "bad path" }],
    }), ["files.0.path"], "invalid_request");
  });

  for (const base of [1, "1", "live"]) {
    it(`preserves stored/copy source coercions and ${JSON.stringify(base)} base references`, async () => {
      const { instance } = await fixture();
      const entry = await manifestEntry("123", "seed");
      const result = await patch(instance, {
        files: [
          { path: "stored.txt", sha256: entry.sha256.toUpperCase(), size: "4" },
          { path: "copied.txt", copyFrom: { site: Number(slug), version: 1, path: 123 } },
          { path: "inline.txt", content: "new bytes" },
        ],
        baseVersionId: base, message: 1234,
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.version.live).toBe(true);
      expect(result.body.version.number).toBe(2);
      expect(await env.DB.prepare("SELECT message FROM versions WHERE id = ?")
        .bind(result.body.version.id).first()).toEqual({ message: "1234" });
      const files = await env.DB.prepare("SELECT path, sha256, size FROM version_files WHERE version_id = ? AND path IN ('stored.txt', 'copied.txt') ORDER BY path")
        .bind(result.body.version.id).all();
      expect(files.results).toEqual(["copied.txt", "stored.txt"].map((path) => ({ path, sha256: entry.sha256, size: 4 })));
      const page = await instance.call(`/s/${slug}/inline.txt?raw=1`);
      expect(page.status).toBe(200);
      expect(await page.text()).toBe("new bytes");
    });
  }
});

const prototypeNames = ["toString", "constructor", "hasOwnProperty"];
const ownNames = Object.fromEntries(prototypeNames.map((name) => [name, "own value"]));

function missingFields(result: ToolCall, expected: string[]) {
  expect(result.isError).toBe(true);
  expect(result.data.error?.code).toBe("invalid_request");
  expect(result.data.error?.retryable).toBe(false);
  const diagnostics = fields(result.data.error);
  expect(diagnostics.map((field) => field.path).sort()).toEqual([...expected].sort());
  for (const diagnostic of diagnostics) {
    expect(diagnostic.message).toEqual(expect.any(String));
    expect(diagnostic.message.trim().length).toBeGreaterThan(0);
  }
}

for (const [protocol, connect] of [["modern", connectMcp], ["legacy", connectLegacyMcp]] as const) {
  describe(`F3 ${protocol} MCP own-property diagnostics`, () => {
    async function probe(schema: Record<string, unknown>) {
      const dispatched: unknown[] = [];
      const instance = await freshInstance({}, { mcpTools: [{
        name: "own_property_probe", description: "Own-property diagnostic regression fixture.",
        inputSchema: { type: "object", ...schema },
        async handler(args) { dispatched.push(structuredClone(args)); return { received: args }; },
      }] });
      const client = await connect(instance, instance.ownerKey);
      return { ...client, dispatched };
    }

    // Do not declare prototype names in properties: cfworker 4.1.1 has a separate
    // engine limitation there. Required/dependency names need not be properties.
    for (const keyword of ["dependentRequired", "dependencies"] as const) {
      for (const trigger of ["toString", "constructor"]) {
        it(`${keyword}: an inherited ${trigger} cannot add a spurious y diagnostic`, async () => {
          const client = await probe({
            ...(keyword === "dependencies" ? { $schema: "http://json-schema.org/draft-07/schema#" } : {}),
            properties: { a: { type: "string" }, x: { type: "string" }, y: { type: "string" } },
            [keyword]: { a: ["x"], [trigger]: ["y"] },
          });
          try {
            // Supplying y makes this a valid control even under the pinned engine's
            // separate inherited-trigger limitation; the invalid case below pins diagnostics.
            const valid = { a: "1", x: "present", y: "present" };
            const accepted = await client.call("own_property_probe", valid);
            expect(accepted.isError).toBe(false);
            expect(accepted.data.received).toEqual(valid);
            expect(client.dispatched).toEqual([valid]);
            const absent = await client.call("own_property_probe", { a: "1" });
            expect(client.dispatched, "invalid input never dispatches").toEqual([valid]);
            missingFields(absent, ["x"]);
            const ownTrigger = await client.call("own_property_probe", { [trigger]: "own value" });
            expect(client.dispatched).toEqual([valid]);
            missingFields(ownTrigger, ["y"]);
            const ownValid = { [trigger]: "own value", y: "present" };
            expect((await client.call("own_property_probe", ownValid)).isError).toBe(false);
            expect(client.dispatched).toEqual([valid, ownValid]);
          } finally { await client.client.close(); }
        });
      }

      it(`${keyword}: inherited missing names do not satisfy dependencies`, async () => {
        const client = await probe({
          ...(keyword === "dependencies" ? { $schema: "http://json-schema.org/draft-07/schema#" } : {}),
          properties: { a: { type: "string" }, x: { type: "string" } },
          [keyword]: { a: ["x", ...prototypeNames] },
        });
        try {
          const valid = { a: "1", x: "present", ...ownNames };
          const accepted = await client.call("own_property_probe", valid);
          expect(accepted.isError).toBe(false);
          expect(accepted.data.received).toEqual(valid);
          expect(client.dispatched).toEqual([valid]);
          const rejected = await client.call("own_property_probe", { a: "1" });
          expect(client.dispatched, "invalid input never dispatches").toEqual([valid]);
          missingFields(rejected, ["x", ...prototypeNames]);
        } finally { await client.client.close(); }
      });
    }

    for (const nested of [false, true]) {
      it(`required: inherited names are missing ${nested ? "inside an object" : "at the root"}`, async () => {
        const required = { type: "object", properties: { x: { type: "string" } }, required: ["x", ...prototypeNames] };
        const client = await probe(nested ? { properties: { box: required }, required: ["box"] } : required);
        try {
          const complete = { x: "present", ...ownNames };
          const valid = nested ? { box: complete } : complete;
          const accepted = await client.call("own_property_probe", valid);
          expect(accepted.isError).toBe(false);
          expect(accepted.data.received).toEqual(valid);
          expect(client.dispatched).toEqual([valid]);
          const rejected = await client.call("own_property_probe", nested ? { box: {} } : {});
          expect(client.dispatched, "invalid input never dispatches").toEqual([valid]);
          missingFields(rejected, ["x", ...prototypeNames].map((name) => `${nested ? "box." : ""}${name}`));
        } finally { await client.client.close(); }
      });
    }
  });
}
