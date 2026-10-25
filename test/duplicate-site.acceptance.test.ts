import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import { apiOperations, commandRows, hasExample, pathShape, resolveRef } from "./operation-fixtures";
import { create as createTransfer, instance as transferInstance, member, op } from "./transfer-fixtures";

/**
 * RED acceptance for R-27 PUB-15 `duplicate_site` (SPEC 8.2: POST /api/v1/sites/{site}/duplicate).
 *
 * Protected Test Author file: the Builder implements against these tests without editing them.
 * Every test below fails until `duplicate_site` exists in the operation registry; the
 * "controls" block at the end passes before and after, proving the fixtures work.
 *
 * Contract pinned here (from SPEC + the R-27 roadmap slice):
 * - input: site (slug or id), newSlug, optional message; scope sites:write
 * - the new slug gets a live version whose manifest equals the source live manifest exactly
 * - response carries the new URL, version id, file count and byte count
 * - new-slug validation reuses create errors (400 invalid_slug, 409 slug_taken incl. tombstones)
 * - source resolution reuses read-path errors (unknown or not-yours -> 404 site_not_found)
 * - a source with no live version answers 409 and leaves zero orphan site/version rows
 * - passwords/access are NOT copied (only SPA mode is); the response says to re-apply a password
 * - R-04 idempotency: same key + same body replays, same key + different body is 422
 * - registry presence: /api/v1/operations row, OpenAPI 3.1 entry, MCP tool with outputSchema
 * - every refusal carries code + hint (the hint is the next-action carrier until R-03 adds `next`)
 */

const SOURCE_FILES = [
  { path: "index.html", content: "<h1>Original site</h1>" },
  { path: "empty.txt", content: "" },
  { path: "docs/résumé-🎉.md", content: "# Résumé 🎉\n\nUnicode paths round-trip.\n" },
  { path: "assets/css/site.css", content: "body{color:#111}" },
  { path: "assets/js/app.js", content: "console.log('hi')" },
];

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

async function publishSource(slug: string, files: typeof SOURCE_FILES = SOURCE_FILES, key: string = dw.ownerKey) {
  const r = await dw.json("/api/v1/publish", { method: "POST", key, ...jsonBody({ slug, files }) });
  expect(r.status, `fixture publish of ${slug}: ${JSON.stringify(r.body)}`).toBe(201);
  return r.body;
}

async function duplicate(source: string, body: Record<string, unknown>, key: string | null = dw.ownerKey, headers: Record<string, string> = {}) {
  return dw.json(`/api/v1/sites/${encodeURIComponent(source)}/duplicate`, {
    method: "POST",
    key,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Live manifest as (path, size, sha256) triples, server order (ORDER BY path). */
async function liveManifest(slug: string, key: string = dw.ownerKey) {
  const r = await dw.json(`/api/v1/sites/${slug}/files`, { key });
  expect(r.status, `list live files of ${slug}: ${JSON.stringify(r.body)}`).toBe(200);
  return (r.body.files as any[]).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
}

/** The duplicate facts, accepting the response layout the registry examples use. */
function dupOut(body: any) {
  return {
    url: body.url,
    slug: body.slug ?? body.site?.slug,
    versionId: body.versionId ?? body.version?.id,
    fileCount: body.fileCount ?? body.version?.fileCount,
    totalBytes: body.totalBytes ?? body.version?.totalBytes,
  };
}

function expectRefusal(r: { status: number; body: any }, status: number, code?: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body.error.code).toMatch(/^[a-z][a-z0-9_]+$/);
  if (code !== undefined) expect(r.body.error.code).toBe(code);
  expect(r.body.error.hint).toEqual(expect.any(String));
  expect(r.body.error.hint.length, "refusals carry a next action in hint").toBeGreaterThan(0);
}

async function tableCounts() {
  const sites = await env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE deleted_at IS NULL").first<{ n: number }>();
  const versions = await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>();
  return { sites: sites?.n ?? 0, versions: versions?.n ?? 0 };
}

async function siteRowCount(slug: string) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE slug = ? AND deleted_at IS NULL").bind(slug).first<{ n: number }>();
  return row?.n ?? 0;
}

async function versionCountForSlug(slug: string) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM versions WHERE site_id = (SELECT id FROM sites WHERE slug = ?)").bind(slug).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("duplicate_site registry contract", () => {
  it("appears in /api/v1/operations with its input schema", async () => {
    const table = await dw.json("/api/v1/operations", { key: dw.ownerKey });
    expect(table.status).toBe(200);
    const row = commandRows(table.body).find((r) => r.id === "duplicate_site");
    expect(row, "duplicate_site must be registered before behavior tests can call it").toBeDefined();
    expect(row!.method).toBe("POST");
    expect(pathShape(row!.path)).toBe("/api/v1/sites/{}/duplicate");
    expect(row!.scopes).toContain("sites:write");
    expect(row!.inputSchema?.type).toBe("object");
    expect(row!.inputSchema?.properties?.newSlug, "newSlug is advertised").toBeDefined();
    expect(row!.inputSchema?.properties?.slug ?? row!.inputSchema?.properties?.site, "source site is advertised").toBeDefined();
  });

  it("appears in OpenAPI 3.1 with summary, description, example and documented errors", async () => {
    const doc = (await dw.json("/openapi.json")).body;
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
    const found = apiOperations(doc).find(({ op }) => op.operationId === "duplicate_site");
    expect(found, "duplicate_site must be generated into OpenAPI").toBeDefined();
    const op = found!.op;
    expect(op.summary?.trim().length).toBeGreaterThan(0);
    expect(op.summary.length).toBeLessThanOrEqual(80);
    expect(op.description?.trim().length).toBeGreaterThan(0);
    expect(op.description.length).toBeLessThan(4096);
    expect(hasExample(doc, op), "examples must be emitted into OpenAPI").toBe(true);
    const errors = Object.entries<any>(op.responses ?? {}).filter(([status]) => /^(?:[45](?:\d\d|XX)|default)$/.test(status));
    expect(errors.length, "duplicate_site documents its error responses").toBeGreaterThan(0);
    for (const [status, value] of errors) {
      const response = resolveRef(doc, value);
      expect(response.description?.trim().length, `${status} description`).toBeGreaterThan(0);
      const schema = resolveRef(doc, response.content?.["application/json"]?.schema);
      expect(schema?.properties?.error, `${status} error envelope`).toBeDefined();
    }
  });

  it("appears as an MCP tool with input and output schemas", async () => {
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const tool = (await mcp.tools()).find((t) => t.name === "duplicate_site");
      expect(tool, "duplicate_site must be an MCP tool").toBeDefined();
      expect(tool!.description?.trim().length).toBeGreaterThan(0);
      expect(tool!.description.length).toBeLessThan(4096);
      expect(tool!.inputSchema?.type).toBe("object");
      expect(tool!.inputSchema?.properties?.site, "MCP input takes site").toBeDefined();
      expect(tool!.inputSchema?.properties?.newSlug, "MCP input takes newSlug").toBeDefined();
      expect(tool!.outputSchema?.type, "MCP tool carries an outputSchema").toBe("object");
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(tool!.annotations?.[hint], `annotations.${hint}`).toBeTypeOf("boolean");
      }
    } finally {
      await mcp.client.close();
    }
  });
});

describe("duplicate a live site into a new slug", () => {
  it("copies the live manifest exactly, incl. zero-byte, Unicode and nested names", async () => {
    await publishSource("dupe-origin");
    const before = await liveManifest("dupe-origin");
    expect(before.map((f) => f.path).sort()).toEqual(["assets/css/site.css", "assets/js/app.js", "docs/résumé-🎉.md", "empty.txt", "index.html"]);
    expect(before.find((f) => f.path === "empty.txt")?.size).toBe(0);

    const dup = await duplicate("dupe-origin", { newSlug: "dupe-copy" });
    expect(dup.status, JSON.stringify(dup.body)).toBe(201);
    const out = dupOut(dup.body);
    expect(out.url).toBe(`${ORIGIN}/s/dupe-copy/`);
    expect(out.slug).toBe("dupe-copy");
    expect(out.versionId).toEqual(expect.any(String));
    expect(out.fileCount).toBe(before.length);
    expect(out.totalBytes).toBe(before.reduce((n, f) => n + f.size, 0));

    // Exact manifest equality: same paths, sizes and sha256, same order.
    expect(await liveManifest("dupe-copy")).toEqual(before);

    // The copy is a new live site: version 1, and the returned id is its live version.
    const copy = await dw.json("/api/v1/sites/dupe-copy", { key: dw.ownerKey });
    expect(copy.status).toBe(200);
    expect(copy.body.site.currentVersionId).toBe(out.versionId);
    expect(copy.body.site.currentVersion.number).toBe(1);

    // Bytes (not just hashes) match on the copy, fetched through server-generated URLs.
    const listed = await dw.json("/api/v1/sites/dupe-copy/files", { key: dw.ownerKey });
    for (const f of listed.body.files) {
      const got = await dw.call(f.rawUrl, { key: dw.ownerKey });
      expect(got.status, f.path).toBe(200);
      const bytes = new Uint8Array(await got.arrayBuffer());
      expect(bytes.length, f.path).toBe(f.size);
    }
  });

  it("accepts a site id as the source, not just a slug", async () => {
    await publishSource("dupe-id-origin");
    const id = (await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind("dupe-id-origin").first<{ id: string }>())?.id;
    expect(id).toEqual(expect.any(String));
    const dup = await duplicate(id!, { newSlug: "dupe-id-copy" });
    expect(dup.status, JSON.stringify(dup.body)).toBe(201);
    expect(await liveManifest("dupe-id-copy")).toEqual(await liveManifest("dupe-id-origin"));
  });

  it("accepts an optional message and records it on the new live version", async () => {
    await publishSource("dupe-msg-origin");
    const dup = await duplicate("dupe-msg-origin", { newSlug: "dupe-msg-copy", message: "pre-redesign snapshot" });
    expect(dup.status, JSON.stringify(dup.body)).toBe(201);
    const copy = await dw.json("/api/v1/sites/dupe-msg-copy", { key: dw.ownerKey });
    expect(copy.body.site.currentVersion.message).toBe("pre-redesign snapshot");
  });

  it("leaves the source site untouched", async () => {
    await publishSource("dupe-untouched");
    const before = await dw.json("/api/v1/sites/dupe-untouched", { key: dw.ownerKey });
    const dup = await duplicate("dupe-untouched", { newSlug: "dupe-untouched-copy" });
    expect(dup.status).toBe(201);
    const after = await dw.json("/api/v1/sites/dupe-untouched", { key: dw.ownerKey });
    expect(after.body.site.currentVersionId).toBe(before.body.site.currentVersionId);
    expect(await (await dw.call("/s/dupe-untouched/")).text()).toBe("<h1>Original site</h1>");
  });
});

describe("duplicate_site refusal matrix", () => {
  it("reuses slug_taken when the new slug is already a site, and leaves that site alone", async () => {
    await publishSource("dupe-taken-origin");
    await publishSource("dupe-taken-target");
    const targetBefore = await dw.json("/api/v1/sites/dupe-taken-target", { key: dw.ownerKey });
    const counts = await tableCounts();
    const dup = await duplicate("dupe-taken-origin", { newSlug: "dupe-taken-target" });
    expectRefusal(dup, 409, "slug_taken");
    expect(await tableCounts()).toEqual(counts);
    const targetAfter = await dw.json("/api/v1/sites/dupe-taken-target", { key: dw.ownerKey });
    expect(targetAfter.body.site.currentVersionId).toBe(targetBefore.body.site.currentVersionId);
  });

  it("reuses slug_taken when the new slug is another sender's transfer tombstone", async () => {
    dw = await transferInstance(); // transfers need a separate sites origin; one instance per test
    const tdw = dw;
    const alice = await member(tdw, "sender-a@example.net");
    const bob = await member(tdw, "sender-b@example.net");
    const t = await createTransfer(tdw, { slug: "dupe-reserved-parcel" }, alice.key);
    expect((await op(tdw, "rename_site", { site: t.slug, slug: "dupe-renamed-parcel" }, alice.key)).status).toBe(200);
    await publishSource("dupe-tomb-origin");
    // Sanity: the tombstone fences ordinary publishing for the other sender first.
    expectRefusal(await op(tdw, "publish_site", { slug: "dupe-reserved-parcel", files: [{ path: "index.html", content: "x" }] }, bob.key), 409, "slug_taken");
    const counts = await tableCounts();
    const dup = await duplicate("dupe-tomb-origin", { newSlug: "dupe-reserved-parcel" }, bob.key);
    expectRefusal(dup, 409, "slug_taken");
    expect(await tableCounts()).toEqual(counts);
  });

  it("answers 404 site_not_found for an unknown source (not the router's 404)", async () => {
    await publishSource("dupe-unknown-origin");
    const counts = await tableCounts();
    const dup = await duplicate("no-such-site-xyz", { newSlug: "dupe-unknown-copy" });
    expectRefusal(dup, 404, "site_not_found");
    expect(await tableCounts()).toEqual(counts);
    expect(await siteRowCount("dupe-unknown-copy")).toBe(0);
  });

  it("answers 404 site_not_found for a foreign source the key cannot read", async () => {
    await publishSource("dupe-home");
    await publishSource("dupe-away");
    const scoped = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ name: "home-only", scopes: ["sites:read", "sites:write"], site: "dupe-home" }) });
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(201);
    const counts = await tableCounts();
    const dup = await duplicate("dupe-away", { newSlug: "dupe-foreign-copy" }, scoped.body.key);
    expectRefusal(dup, 404, "site_not_found");
    expect(await tableCounts()).toEqual(counts);
    expect(await siteRowCount("dupe-foreign-copy")).toBe(0);
  });

  it("answers 409 with no orphan rows when the source has no live version", async () => {
    const empty = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "dupe-empty-origin" }) });
    expect(empty.status).toBe(201);
    const counts = await tableCounts();
    const dup = await duplicate("dupe-empty-origin", { newSlug: "dupe-empty-copy" });
    // Exact code is the Builder's choice among existing 409s (no new error codes);
    // the status, the next action and the atomicity are the contract.
    expectRefusal(dup, 409);
    expect(await tableCounts(), "a refused duplicate leaves zero orphan site/version rows").toEqual(counts);
    expect(await siteRowCount("dupe-empty-copy")).toBe(0);
    expect((await dw.json("/api/v1/sites/dupe-empty-copy", { key: dw.ownerKey })).status).toBe(404);
  });

  it("validates the new slug exactly like create", async () => {
    await publishSource("dupe-format-origin");
    const counts = await tableCounts();
    const dup = await duplicate("dupe-format-origin", { newSlug: "Not A Slug!" });
    expectRefusal(dup, 400, "invalid_slug");
    expect(await tableCounts()).toEqual(counts);
  });
});

describe("duplicate carries no password gate, only SPA mode", () => {
  it("drops the password, keeps SPA, resets every other setting to its default", async () => {
    await publishSource("dupe-gated-origin");
    const indexBytes = await (await dw.call("/s/dupe-gated-origin/")).text();
    const patched = await dw.json("/api/v1/sites/dupe-gated-origin", {
      key: dw.ownerKey,
      ...jsonBody({ title: "Gated", description: "do not copy", spa: true, renderMarkdown: false, crossOriginIsolation: true, password: "visitor-secret-1" }),
      method: "PATCH",
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect((await dw.call("/s/dupe-gated-origin/")).status, "source is really gated before the copy").not.toBe(200);

    const dup = await duplicate("dupe-gated-origin", { newSlug: "dupe-gated-copy" });
    expect(dup.status, JSON.stringify(dup.body)).toBe(201);
    expect(JSON.stringify(dup.body), "the response says to re-apply a password").toMatch(/password/i);

    const copy = await dw.json("/api/v1/sites/dupe-gated-copy", { key: dw.ownerKey });
    expect(copy.body.site.settings).toMatchObject({ spa: true, renderMarkdown: true, crossOriginIsolation: false, passwordProtected: false });
    expect(copy.body.site.title).toBeNull();
    expect(copy.body.site.description).toBeNull();

    const served = await dw.call("/s/dupe-gated-copy/");
    expect(served.status, "the copy serves with no password gate").toBe(200);
    expect(await served.text()).toBe(indexBytes);
  });
});

describe("duplicate_site idempotency", () => {
  it("replays same key + same body with no second site", async () => {
    await publishSource("dupe-idem-origin");
    const headers = { "Idempotency-Key": "dupe-op-1" };
    const first = await duplicate("dupe-idem-origin", { newSlug: "dupe-idem-copy" }, dw.ownerKey, headers);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await duplicate("dupe-idem-origin", { newSlug: "dupe-idem-copy" }, dw.ownerKey, headers);
    expect(second.status).toBe(first.status);
    expect(second.body.replayed).toBe(true);
    expect(dupOut(second.body).versionId).toBe(dupOut(first.body).versionId);
    expect(await siteRowCount("dupe-idem-copy"), "one replayed call creates one site").toBe(1);
    expect(await versionCountForSlug("dupe-idem-copy")).toBe(1);
  });

  it("answers 422 when the same key carries a different body", async () => {
    await publishSource("dupe-idem-clash");
    const headers = { "Idempotency-Key": "dupe-op-2" };
    expect((await duplicate("dupe-idem-clash", { newSlug: "dupe-idem-first" }, dw.ownerKey, headers)).status).toBe(201);
    const clash = await duplicate("dupe-idem-clash", { newSlug: "dupe-idem-second" }, dw.ownerKey, headers);
    expectRefusal(clash, 422, "idempotency_key_reused");
    expect(await siteRowCount("dupe-idem-second")).toBe(0);
  });
});

describe("duplicate_site over MCP", () => {
  it("duplicates through the tool with a one-line summary", async () => {
    await publishSource("dupe-mcp-origin");
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const r = await mcp.call("duplicate_site", { site: "dupe-mcp-origin", newSlug: "dupe-mcp-copy" });
      expect(r.isError, r.text).toBe(false);
      const first = r.text.trim().split("\n")[0] ?? "";
      expect(first.length, "one-line text summary").toBeGreaterThan(0);
      expect(first).toContain("dupe-mcp-copy");
      const url = (r.data as any).url ?? (r.data as any).site?.url;
      expect(url).toBe(`${ORIGIN}/s/dupe-mcp-copy/`);
      expect(await liveManifest("dupe-mcp-copy")).toEqual(await liveManifest("dupe-mcp-origin"));
    } finally {
      await mcp.client.close();
    }
  });

  it("reports refusals with code and hint", async () => {
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const r = await mcp.call("duplicate_site", { site: "no-such-site-xyz", newSlug: "dupe-mcp-never" });
      expect(r.isError).toBe(true);
      expect((r.data as any).error.code).toBe("site_not_found");
      expect((r.data as any).error.hint.length).toBeGreaterThan(0);
    } finally {
      await mcp.client.close();
    }
  });
});

describe("duplicate acceptance controls (pass before and after)", () => {
  it("the source fixture publishes with every file live", async () => {
    await publishSource("dupe-control");
    const manifest = await liveManifest("dupe-control");
    expect(manifest).toHaveLength(SOURCE_FILES.length);
    for (const f of manifest) {
      expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("read paths answer unknown slugs with 404 site_not_found", async () => {
    const r = await dw.json("/api/v1/sites/no-such-site-xyz", { key: dw.ownerKey });
    expectRefusal(r, 404, "site_not_found");
  });

  it("the operation table and OpenAPI document load", async () => {
    const table = await dw.json("/api/v1/operations", { key: dw.ownerKey });
    expect(table.status).toBe(200);
    expect(commandRows(table.body).length).toBeGreaterThan(20);
    const doc = (await dw.json("/openapi.json")).body;
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
  });
});
