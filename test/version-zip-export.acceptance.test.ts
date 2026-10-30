/**
 * PROTECTED ACCEPTANCE TESTS — VERSION-ZIP: download exact version bytes as a ZIP.
 *
 * RED-first: every `export_version` test below FAILS on main (no such operation exists) and must
 * pass UNCHANGED after the build. Builder: build on this exact pushed branch and NEVER edit
 * this file. If a test pins the wrong contract, send it back to the test author with evidence.
 *
 * Contract pinned here (VERSION-ZIP: exact version-ZIP export):
 * - New `export_version` operation in the registry: GET
 *   /api/v1/sites/{slug}/versions/{version}/export, scopes ["sites:read"], toolset "versions".
 *   Input site plus version ("live", "vN", "N" or id, same resolver as read paths).
 * - Streams `application/zip` of exactly that version's served manifest bytes as an attachment
 *   named `<slug>-v<N>.zip` (resolved version number, identical for every ref spelling).
 * - Deterministic bytes: entries sorted by path (manifest byte order), one fixed timestamp on
 *   every entry, no data descriptors. Two exports of one version are byte-identical.
 * - Pinned vN/N/id refs carry `Cache-Control: private, max-age=31536000, immutable`.
 *   The mutable live alias (including accepted case/whitespace forms) carries `private, no-cache`.
 * - GET and HEAD preserve headers set by configured API middleware before `await next()`.
 *   HEAD has GET's metadata but no body or blob reads; unread GET bodies do not read blobs.
 * - Over-cap file count -> 413 `export_too_many_files`; over-cap total bytes -> 413
 *   `export_too_large`. Caps derive from the effective policy limits. Refusals name the
 *   version's counts in the message, carry details {fileCount,totalBytes,limit} and a
 *   file-by-file hint (read_file / list_files).
 * - Unknown or foreign site -> 404 `site_not_found`; unknown version -> 404 `version_not_found`;
 *   transfer slugs -> 403 `transfer_download_required` (versions only, never transfers).
 *   Auth equals version-read auth: owner credentials required, gated sites stay gated.
 * - Streaming: the first ZIP bytes are emitted before all blobs are read (proven by gating
 *   R2 reads, not by timing). Binary payload is `mcp.exclude` with a recorded REST reason;
 *   agents use REST / `kofra api`. JSON errors carry code, hint and next action.
 *
 * Harness: disposable workerd instances (fresh D1/R2/KV per test via freshInstance), no
 * production traffic, no new dependencies (fflate is already a core dependency).
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { defaultPolicy, sha256Hex, type Limits, type PolicyAdapter } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";
import { apiOperations, commandRows, hasExample, registry, resolveRef } from "./operation-fixtures";
import { connectMcp } from "./mcp-helpers";
import { create as createTransfer, instance as transferInstance } from "./transfer-fixtures";

const u8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

/** Incompressible bytes in workerd-safe 64 KiB getRandomValues chunks. */
function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536) crypto.getRandomValues(out.subarray(at, Math.min(n, at + 65536)));
  return out;
}

interface FixtureFile {
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
  contentType?: string;
}

interface Published {
  slug: string;
  versionId: string;
  versionNumber: number;
  files: FixtureFile[];
  totalBytes: number;
}

/** Create a site and publish `files` as its first version through the manifest flow. */
async function publishManifest(dw: Instance, slug: string, files: FixtureFile[]): Promise<Published> {
  const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug }) });
  expect(created.status, `setup: create site ${slug}: ${JSON.stringify(created.body)}`).toBe(201);
  const deployed = await deployVersion(dw, slug, files);
  return { slug, ...deployed, files, totalBytes: files.reduce((n, f) => n + f.bytes.length, 0) };
}

/** Publish `files` as a new version of an existing site. */
async function deployVersion(dw: Instance, slug: string, files: FixtureFile[]): Promise<{ versionId: string; versionNumber: number }> {
  const manifest = await Promise.all(
    files.map(async (f) => ({
      path: f.path,
      size: f.bytes.length,
      sha256: await sha256Hex(f.bytes),
      ...(f.contentType ? { contentType: f.contentType } : {}),
    })),
  );
  const deploy = await dw.json(`/api/v1/sites/${encodeURIComponent(slug)}/deploys`, {
    key: dw.ownerKey,
    ...jsonBody({ files: manifest }),
  });
  expect(deploy.status, `setup: deploy on ${slug}: ${JSON.stringify(deploy.body)}`).toBe(201);
  const missing = new Set<string>(deploy.body.missing as string[]);
  for (const entry of manifest) {
    if (!missing.has(entry.sha256)) continue;
    const file = files.find((f) => f.path === entry.path)!;
    const up = await dw.json(`/api/v1/blobs/${entry.sha256}`, {
      method: "PUT",
      key: dw.ownerKey,
      body: file.bytes,
      headers: { "Content-Length": String(file.bytes.length) },
    });
    expect([200, 201], `setup: upload ${entry.path}: ${JSON.stringify(up.body)}`).toContain(up.status);
  }
  const fin = await dw.json(`/api/v1/sites/${encodeURIComponent(slug)}/deploys/${deploy.body.deploy.id}/finalize`, {
    method: "POST",
    key: dw.ownerKey,
  });
  expect(fin.status, `setup: finalize on ${slug}: ${JSON.stringify(fin.body)}`).toBe(200);
  expect(fin.body.live).toBe(true);
  return { versionId: deploy.body.deploy.id as string, versionNumber: deploy.body.deploy.number as number };
}

/** The served manifest of one version: path -> {sha256,size}, straight from list_files. */
async function listManifest(dw: Instance, slug: string, versionId: string): Promise<Map<string, { sha256: string; size: number }>> {
  const r = await dw.json(`/api/v1/sites/${encodeURIComponent(slug)}/files?version=${encodeURIComponent(versionId)}`, {
    key: dw.ownerKey,
  });
  expect(r.status, `setup: list files of ${slug}: ${JSON.stringify(r.body)}`).toBe(200);
  const out = new Map<string, { sha256: string; size: number }>();
  for (const f of r.body.files as Array<{ path: string; sha256: string; size: number }>) {
    out.set(f.path, { sha256: f.sha256, size: f.size });
  }
  return out;
}

/** Resolve the export route from the advertised operation table, never from a second route table. */
async function exportRequest(dw: Instance, slug: string, version: string): Promise<{ method: string; url: string }> {
  const table = await dw.json("/api/v1/operations");
  expect(table.status).toBe(200);
  const row = commandRows(table.body).find((r) => r.id === "export_version");
  expect(row, "GET /api/v1/operations must list export_version (VERSION-ZIP not implemented)").toBeDefined();
  const params = [...String(row!.path).matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  expect(params, `export_version path must carry site and version params (got ${row!.path})`).toHaveLength(2);
  const url = String(row!.path)
    .replace(`{${params[0]}}`, encodeURIComponent(slug))
    .replace(`{${params[1]}}`, encodeURIComponent(version));
  return { method: String(row!.method), url };
}

async function getExport(dw: Instance, slug: string, version: string, key: string | null = dw.ownerKey): Promise<Response> {
  const { method, url } = await exportRequest(dw, slug, version);
  return dw.call(url, { method, key, headers: { Accept: "application/zip" } });
}

async function getExportJson(dw: Instance, slug: string, version: string, key: string | null = dw.ownerKey) {
  const res = await getExport(dw, slug, version, key);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* Non-JSON bodies fail the envelope assertions below. */
  }
  return { status: res.status, body: body as Record<string, any>, res };
}

const LIVE_CACHE = "private, no-cache";
const PINNED_CACHE = "private, max-age=31536000, immutable";

function expectZipHeaders(res: Response, slug: string, versionNumber: number, cacheControl: string): void {
  expect(res.headers.get("content-type")).toMatch(/^application\/zip\b/);
  const disposition = res.headers.get("content-disposition") ?? "";
  expect(disposition).toMatch(/attachment/);
  expect(disposition).toContain(`filename="${slug}-v${versionNumber}.zip"`);
  expect(res.headers.get("cache-control")).toBe(cacheControl);
}

/** JSON errors carry a stable code, a message, a hint (the next action) and a request id. */
function expectErrorJson(body: Record<string, any>): void {
  expect(body?.error?.code).toMatch(/^[a-z][a-z0-9_]*$/);
  expect(body?.error?.message).toEqual(expect.any(String));
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(body?.error?.hint).toEqual(expect.any(String));
  expect(body.error.hint.length).toBeGreaterThan(0);
  expect(body?.requestId).toEqual(expect.any(String));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface ZipEntryMeta {
  name: string;
  datetime: number;
}

/** Walk the ZIP local headers (names, DOS datetimes) without trusting the central directory. */
function zipLocalEntries(bytes: Uint8Array): ZipEntryMeta[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  const out: ZipEntryMeta[] = [];
  let off = 0;
  for (;;) {
    expect(view.getUint32(off, true), `ZIP local header signature at offset ${off}`).toBe(0x04034b50);
    const flags = view.getUint16(off + 8, true);
    expect(flags & 0x08, "deterministic exports must not use data descriptors (sizes are known from the manifest)").toBe(0);
    const datetime = view.getUint32(off + 10, true);
    const compSize = view.getUint32(off + 18, true);
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    out.push({ name: text.decode(bytes.subarray(off + 30, off + 30 + nameLen)), datetime });
    off += 30 + nameLen + extraLen + compSize;
    if (off >= bytes.length) break;
    if (view.getUint32(off, true) === 0x02014b50) break; // Central directory: all entries seen.
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gate R2 blob reads: the first `blobs/*` get proceeds, later ones wait until `release()`.
 * This proves streaming structurally (bytes flow before all blobs are read), not by timing.
 */
function gateR2AfterFirstBlob(dw: Instance): { calls: string[]; release(): void; restore(): void } {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let opened = 0;
  const originalCall = dw.call;
  const originalJson = dw.json;
  const files = env.FILES;
  const originalGet = files.get.bind(files);
  const gatedGet = (async (...args: Parameters<typeof originalGet>) => {
    const key = String(args[0]);
    if (key.startsWith("blobs/")) {
      opened += 1;
      calls.push(key);
      if (opened > 1) await gate;
    }
    return originalGet(...args);
  }) as typeof files.get;
  const gatedFiles = Object.create(files, { get: { value: gatedGet } }) as typeof files;
  const bindings = { ...env, FILES: gatedFiles } as unknown as ServerBindings;
  dw.call = async (path, init = {}) => {
    const { key, origin, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (key) headers.set("Authorization", `Bearer ${key}`);
    const url = path.startsWith("http") ? path : `${origin ?? ORIGIN}${path}`;
    const ctx = createExecutionContext();
    const res = await dw.dropway.fetch(new Request(url, { ...rest, headers, redirect: "manual" }), bindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  dw.json = async (path, init) => {
    const res = await dw.call(path, init);
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* Preserve non-JSON bodies for envelope assertions. */
    }
    return { status: res.status, body, res };
  };
  return {
    calls,
    release: () => release(),
    restore: () => {
      dw.call = originalCall;
      dw.json = originalJson;
    },
  };
}

/** A disposable instance whose policy limits can be tightened after publishing. */
async function strictPolicyInstance(): Promise<{ dw: Instance; setOverride(o: Partial<Limits> | null): void }> {
  let override: Partial<Limits> | null = null;
  const policy: PolicyAdapter = {
    ...defaultPolicy,
    limits: (p, owner, dc) => ({ ...defaultPolicy.limits(p, owner, dc), ...override }),
  };
  const dw = await freshInstance({}, { adapters: { policy } });
  return { dw, setOverride: (o) => (override = o) };
}

describe("export_version: registry, operations table, MCP and OpenAPI contract", () => {
  it("is a read-only GET versions operation with site+version params and usable schemas", async () => {
    const dw = await freshInstance();
    const op = registry(dw).find((o) => o.id === "export_version");
    expect(op, "operation registry must define export_version (VERSION-ZIP not implemented)").toBeDefined();
    expect(op!.method).toBe("GET");
    expect(op!.path).toMatch(/^\/api\/v1\/sites\/\{[^}]+\}\/versions\/\{[^}]+\}\/export$/);
    expect(op!.scopes).toEqual(["sites:read"]);
    expect(op!.toolset).toBe("versions");
    expect(op!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(op!.summary.trim().length).toBeGreaterThan(0);
    expect(op!.summary.length).toBeLessThanOrEqual(80);
    expect(op!.description.trim().length).toBeGreaterThan(0);
    expect(op!.description.length).toBeLessThan(4096);
    expect(op!.examples?.length ?? 0, "every operation needs a concrete example").toBeGreaterThan(0);
  });

  it("is listed in the public CLI command table (usable via `kofra api`)", async () => {
    const dw = await freshInstance();
    const table = await dw.json("/api/v1/operations");
    expect(table.status).toBe(200);
    const row = commandRows(table.body).find((r) => r.id === "export_version");
    expect(row, "GET /api/v1/operations must list export_version").toBeDefined();
    expect(row!.method).toBe("GET");
    expect(String(row!.path)).toMatch(/^\/api\/v1\/sites\/\{[^}]+\}\/versions\/\{[^}]+\}\/export$/);
    expect(row!.scopes).toEqual(["sites:read"]);
    expect(row!.inputSchema?.type).toBe("object");
  });

  it("is mcp.exclude with a recorded REST reason, absent from tools/list (R-02 rule)", async () => {
    const dw = await freshInstance();
    const op = registry(dw).find((o) => o.id === "export_version");
    expect(op, "operation registry must define export_version").toBeDefined();
    const mcpDef = op!.mcp;
    const reason = mcpDef && "exclude" in mcpDef ? mcpDef.exclude : "";
    expect(reason.trim().length, "binary payload needs a recorded mcp.exclude reason").toBeGreaterThan(0);
    expect(reason, "reason must point agents at REST").toMatch(/REST/i);
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const names = (await mcp.tools()).map((t) => t.name);
      expect(names).toContain("get_version");
      expect(names, "binary export_version must stay out of tools/list").not.toContain("export_version");
    } finally {
      await mcp.client.close();
    }
  });

  it("is documented in the OpenAPI 3.1 document with summary, example and error responses", async () => {
    const dw = await freshInstance();
    const doc = (await dw.json("/openapi.json")).body as Record<string, any>;
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
    const found = apiOperations(doc).filter(({ op }) => op.operationId === "export_version");
    expect(found, "/openapi.json must document export_version").toHaveLength(1);
    const { path, method, op } = found[0]!;
    expect(method).toBe("get");
    expect(path).toMatch(/^\/api\/v1\/sites\/\{[^}]+\}\/versions\/\{[^}]+\}\/export$/);
    expect(op.summary?.trim().length).toBeGreaterThan(0);
    expect(op.summary.length).toBeLessThanOrEqual(80);
    expect(op.description?.trim().length).toBeGreaterThan(0);
    expect(op.description.length).toBeLessThan(4096);
    expect(hasExample(doc, op), "OpenAPI must carry the operation example").toBe(true);
    const err = resolveRef(doc, op.responses?.default ?? op.responses?.["400"]);
    expect(err?.description?.trim().length, "error responses need descriptions").toBeGreaterThan(0);
    const schema = resolveRef(doc, err.content?.["application/json"]?.schema);
    expect(schema?.properties?.error, "error responses need the error envelope schema").toBeDefined();
  });

  it("declares an application/zip binary response and x-mcp-exclude in OpenAPI", async () => {
    const dw = await freshInstance();
    const doc = (await dw.json("/openapi.json")).body as Record<string, any>;
    const found = apiOperations(doc).filter(({ op }) => op.operationId === "export_version");
    expect(found, "/openapi.json must document export_version").toHaveLength(1);
    const { op } = found[0]!;
    expect(op.responses?.["200"]?.content?.["application/zip"]?.schema).toMatchObject({ type: "string", format: "binary" });
    expect(op["x-mcp-exclude"]).toEqual(expect.any(String));
    expect(String(op["x-mcp-exclude"]).trim().length).toBeGreaterThan(0);
    expect(String(op["x-mcp-exclude"])).toMatch(/REST/i);
    expect(op).not.toHaveProperty("x-mcp-tool");
  });
});

describe("export_version: exact-bytes round-trip", () => {
  const EDGE_FILES: FixtureFile[] = [
    { path: "index.html", bytes: u8("<h1>zip round-trip</h1>") },
    { path: "docs/café-✓.html", bytes: u8("<p>unicode path ✓</p>") },
    { path: "a/b/c/deep.txt", bytes: u8("nested\n") },
    { path: "empty.bin", bytes: new Uint8Array(0), contentType: "application/octet-stream" },
  ];

  it.each(["live", "LIVE", " LiVe ", "\tlIvE\n"])("answers application/zip as an attachment with no-cache for mutable ref %j", async (ref) => {
    const dw = await freshInstance();
    const pub = await publishManifest(dw, "zip-headers", [EDGE_FILES[0]!]);
    const res = await getExport(dw, pub.slug, ref);
    expect(res.status).toBe(200);
    try {
      expectZipHeaders(res, pub.slug, pub.versionNumber, LIVE_CACHE);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    } finally {
      if (!res.bodyUsed) await res.body?.cancel();
    }
  });

  it("round-trips every file with sha equality to the version manifest, incl. Unicode/zero-byte/nested names", async () => {
    const dw = await freshInstance();
    const pub = await publishManifest(dw, "zip-roundtrip", EDGE_FILES);
    const manifest = await listManifest(dw, pub.slug, pub.versionId);
    expect(manifest.size).toBe(EDGE_FILES.length);
    const res = await getExport(dw, pub.slug, "live");
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const out = unzipSync(bytes);
    expect(Object.keys(out).sort()).toEqual([...manifest.keys()].sort());
    for (const [path, entry] of manifest) {
      const data = out[path];
      expect(data, `zip holds ${path}`).toBeDefined();
      expect(data!.length).toBe(entry.size);
      expect(await sha256Hex(data!)).toBe(entry.sha256);
    }
  });

  it("sorts entries by path and fixes every entry timestamp", async () => {
    const dw = await freshInstance();
    const pub = await publishManifest(dw, "zip-order", EDGE_FILES);
    const manifest = await listManifest(dw, pub.slug, pub.versionId);
    const res = await getExport(dw, pub.slug, "live");
    expect(res.status).toBe(200);
    const entries = zipLocalEntries(new Uint8Array(await res.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual([...manifest.keys()].sort());
    expect(new Set(entries.map((e) => e.datetime)).size, "all entries share one fixed timestamp").toBe(1);
  });

  it("resolves live/vN/N/id refs to the right bytes with the resolved version in the filename", async () => {
    const dw = await freshInstance();
    const v1 = await publishManifest(dw, "zip-refs", [{ path: "index.html", bytes: u8("version-one") }]);
    expect(v1.versionNumber).toBe(1);
    const v2 = await deployVersion(dw, v1.slug, [{ path: "index.html", bytes: u8("version-two") }]);
    expect(v2.versionNumber).toBe(2);
    const cases: Array<{ ref: string; number: number; text: string; cache: string }> = [
      { ref: "v2", number: 2, text: "version-two", cache: PINNED_CACHE },
      { ref: "2", number: 2, text: "version-two", cache: PINNED_CACHE },
      { ref: v2.versionId, number: 2, text: "version-two", cache: PINNED_CACHE },
      { ref: "v1", number: 1, text: "version-one", cache: PINNED_CACHE },
      { ref: "1", number: 1, text: "version-one", cache: PINNED_CACHE },
      { ref: v1.versionId, number: 1, text: "version-one", cache: PINNED_CACHE },
      { ref: "live", number: 2, text: "version-two", cache: LIVE_CACHE },
    ];
    for (const c of cases) {
      const res = await getExport(dw, v1.slug, c.ref);
      expect(res.status, `ref ${c.ref}`).toBe(200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const out = unzipSync(bytes);
      expect(new TextDecoder().decode(out["index.html"]), `ref ${c.ref} bytes`).toBe(c.text);
      expectZipHeaders(res, v1.slug, c.number, c.cache);
    }
  });

  it("advances live exports after publish while vN/N/id ZIPs stay byte-stable", async () => {
    const dw = await freshInstance();
    const v1 = await publishManifest(dw, "zip-live-publish", [{ path: "index.html", bytes: u8("version-one") }]);
    const liveRefs = ["live", "LIVE", " LiVe ", "\tlIvE\n"];
    for (const ref of liveRefs) {
      const res = await getExport(dw, v1.slug, ref);
      expect(res.status, `initial live ref ${JSON.stringify(ref)}`).toBe(200);
      expect(res.headers.get("content-disposition")).toContain('filename="zip-live-publish-v1.zip"');
      const out = unzipSync(new Uint8Array(await res.arrayBuffer()));
      expect(new TextDecoder().decode(out["index.html"])).toBe("version-one");
    }
    const pinned = new Map<string, Uint8Array>();
    for (const ref of ["v1", "1", v1.versionId]) {
      const res = await getExport(dw, v1.slug, ref);
      expect(res.status).toBe(200);
      expectZipHeaders(res, v1.slug, 1, PINNED_CACHE);
      pinned.set(ref, new Uint8Array(await res.arrayBuffer()));
    }

    const v2 = await deployVersion(dw, v1.slug, [{ path: "index.html", bytes: u8("version-two") }]);
    expect(v2.versionNumber).toBe(2);
    for (const ref of liveRefs) {
      const res = await getExport(dw, v1.slug, ref);
      expect(res.status, `republished live ref ${JSON.stringify(ref)}`).toBe(200);
      expect(res.headers.get("content-disposition")).toContain('filename="zip-live-publish-v2.zip"');
      const out = unzipSync(new Uint8Array(await res.arrayBuffer()));
      expect(new TextDecoder().decode(out["index.html"])).toBe("version-two");
    }
    for (const [ref, before] of pinned) {
      const res = await getExport(dw, v1.slug, ref);
      expect(res.status).toBe(200);
      expectZipHeaders(res, v1.slug, 1, PINNED_CACHE);
      const after = new Uint8Array(await res.arrayBuffer());
      expect(bytesEqual(after, before), `pinned ref ${ref} stays byte-identical after publish`).toBe(true);
      expect(new TextDecoder().decode(unzipSync(after)["index.html"])).toBe("version-one");
    }
  });

  it("is deterministic: two exports of one version are byte-identical", async () => {
    const dw = await freshInstance();
    const pub = await publishManifest(dw, "zip-deterministic", EDGE_FILES);
    const first = new Uint8Array(await (await getExport(dw, pub.slug, "live")).arrayBuffer());
    const second = new Uint8Array(await (await getExport(dw, pub.slug, "v1")).arrayBuffer());
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(first.length);
    expect(await sha256Hex(second)).toBe(await sha256Hex(first));
  });
});

describe("export_version: application response contract", () => {
  it.each(["GET", "HEAD"])("preserves headers set before await next() by configured API middleware on %s", async (method) => {
    const dw = await freshInstance({}, {
      apiMiddleware: [async (c, next) => {
        c.header("X-Export-Identity", c.get("principal").kind);
        await next();
      }],
    });
    const pub = await publishManifest(dw, "zip-middleware", [{ path: "index.html", bytes: u8("middleware bytes") }]);
    const { url } = await exportRequest(dw, pub.slug, "v1");
    const res = await dw.call(url, { method, key: dw.ownerKey });
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expectZipHeaders(res, pub.slug, 1, PINNED_CACHE);
    if (method === "GET") {
      expect(new TextDecoder().decode(unzipSync(bytes)["index.html"])).toBe("middleware bytes");
    } else {
      expect(bytes.length).toBe(0);
    }
    expect(res.headers.get("X-Export-Identity"), `${method} must retain middleware's prepared response header`).toBe("member");
  });

  it.each(["live", "LIVE", " LiVe ", "\tlIvE\n"])("does not mark mutable ref %j immutable on HEAD", async (ref) => {
    const dw = await freshInstance();
    const pub = await publishManifest(dw, "zip-head-live", [{ path: "index.html", bytes: u8("head bytes") }]);
    const { url } = await exportRequest(dw, pub.slug, ref);
    const res = await dw.call(url, { method: "HEAD", key: dw.ownerKey });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expectZipHeaders(res, pub.slug, 1, LIVE_CACHE);
  });

  it("returns GET metadata and an empty body on HEAD without reading any R2 blobs", async () => {
    const dw = await freshInstance();
    const pub = await publishManifest(dw, "zip-head-lazy", [
      { path: "first.txt", bytes: u8("first blob") },
      { path: "second.txt", bytes: u8("second blob") },
    ]);
    const get = await getExport(dw, pub.slug, "v1");
    expect(get.status).toBe(200);
    expectZipHeaders(get, pub.slug, 1, PINNED_CACHE);
    expect(Object.keys(unzipSync(new Uint8Array(await get.arrayBuffer())))).toEqual(["first.txt", "second.txt"]);
    const { url } = await exportRequest(dw, pub.slug, "v1");
    const gate = gateR2AfterFirstBlob(dw);
    try {
      const head = await dw.call(url, { method: "HEAD", key: dw.ownerKey });
      expect(head.status).toBe(get.status);
      for (const name of ["content-type", "content-disposition", "cache-control", "content-length", "x-content-type-options"]) {
        expect(head.headers.get(name), `HEAD metadata ${name} matches GET`).toBe(get.headers.get(name));
      }
      expect((await head.arrayBuffer()).byteLength).toBe(0);
      await sleep(0); // Allow scheduled stream pulls a turn before checking the read spy.
      expect(gate.calls, "HEAD must not read even the first blob").toHaveLength(0);
    } finally {
      gate.release();
      gate.restore();
    }
  });
});

describe("export_version: cap refusals derive from policy limits", () => {
  const THREE_FILES: FixtureFile[] = [
    { path: "one.txt", bytes: u8("0000000000") },
    { path: "two.txt", bytes: u8("1111111111") },
    { path: "three.txt", bytes: u8("2222222222") },
  ];

  it("refuses an over-count version with 413 export_too_many_files naming counts plus a file-by-file hint", async () => {
    const { dw, setOverride } = await strictPolicyInstance();
    const pub = await publishManifest(dw, "zip-cap-count", THREE_FILES);
    setOverride({ maxFiles: 2 });
    const r = await getExportJson(dw, pub.slug, "live");
    expect(r.status).toBe(413);
    expectErrorJson(r.body);
    expect(r.body.error.code).toBe("export_too_many_files");
    expect(r.body.error.message).toContain("3");
    expect(r.body.error.message).toContain(String(pub.totalBytes));
    expect(r.body.error.details).toMatchObject({ fileCount: 3, totalBytes: pub.totalBytes, limit: 2 });
    expect(r.body.error.hint).toMatch(/file.by.file|one file at a time|read_file|list_files/i);
  });

  it("refuses an over-bytes version with 413 export_too_large naming counts plus a file-by-file hint", async () => {
    const { dw, setOverride } = await strictPolicyInstance();
    const pub = await publishManifest(dw, "zip-cap-bytes", THREE_FILES);
    setOverride({ maxSiteBytes: pub.totalBytes - 1 });
    const r = await getExportJson(dw, pub.slug, "live");
    expect(r.status).toBe(413);
    expectErrorJson(r.body);
    expect(r.body.error.code).toBe("export_too_large");
    expect(r.body.error.message).toContain("3");
    expect(r.body.error.message).toContain(String(pub.totalBytes));
    expect(r.body.error.details).toMatchObject({ fileCount: 3, totalBytes: pub.totalBytes, limit: pub.totalBytes - 1 });
    expect(r.body.error.hint).toMatch(/file.by.file|one file at a time|read_file|list_files/i);
  });

  it("exports a version exactly at the caps", async () => {
    const { dw, setOverride } = await strictPolicyInstance();
    const pub = await publishManifest(dw, "zip-cap-edge", THREE_FILES);
    setOverride({ maxFiles: 3, maxSiteBytes: pub.totalBytes });
    const res = await getExport(dw, pub.slug, "live");
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expectZipHeaders(res, pub.slug, pub.versionNumber, LIVE_CACHE);
  });
});

describe("export_version: auth matrix", () => {
  it("answers 404 site_not_found for an unknown site", async () => {
    const dw = await freshInstance();
    const r = await getExportJson(dw, "no-such-site-abcdef", "live");
    expect(r.status).toBe(404);
    expectErrorJson(r.body);
    expect(r.body.error.code).toBe("site_not_found");
  });

  it("answers 404, never 403, for a foreign site", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const anon = await dw.json("/api/v1/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [{ path: "index.html", content: "anonymous" }] }),
    });
    expect(anon.status, `setup: anonymous publish: ${JSON.stringify(anon.body)}`).toBe(201);
    const r = await getExportJson(dw, anon.body.slug as string, "live", dw.ownerKey);
    expect(r.status).toBe(404);
    expectErrorJson(r.body);
    expect(r.body.error.code).toBe("site_not_found");
  });

  it("answers 404 version_not_found for an unknown version", async () => {
    const dw = await freshInstance();
    const pub = await publishManifest(dw, "zip-unknown-ver", [{ path: "index.html", bytes: u8("x") }]);
    const r = await getExportJson(dw, pub.slug, "v99");
    expect(r.status).toBe(404);
    expectErrorJson(r.body);
    expect(r.body.error.code).toBe("version_not_found");
  });

  it("requires credentials: no key answers 401", async () => {
    const dw = await freshInstance();
    const pub = await publishManifest(dw, "zip-no-key", [{ path: "index.html", bytes: u8("x") }]);
    const r = await getExportJson(dw, pub.slug, "live", null);
    expect(r.status).toBe(401);
    expectErrorJson(r.body);
  });

  it("requires the sites:read scope: a narrower key answers 403 insufficient_scope", async () => {
    const dw = await freshInstance();
    const pub = await publishManifest(dw, "zip-scope", [{ path: "index.html", bytes: u8("x") }]);
    const created = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ name: "narrow", scopes: ["keys:write"] }) });
    expect(created.status, `setup: narrow key: ${JSON.stringify(created.body)}`).toBe(201);
    const r = await getExportJson(dw, pub.slug, "live", created.body.key as string);
    expect(r.status).toBe(403);
    expectErrorJson(r.body);
    expect(r.body.error.code).toBe("insufficient_scope");
  });

  it("refuses transfer slugs with 403 transfer_download_required (versions only)", async () => {
    const tdw = await transferInstance();
    const t = await createTransfer(tdw, { slug: "zip-refused-parcel" });
    const r = await getExportJson(tdw, t.slug, "live", tdw.ownerKey);
    expect(r.status).toBe(403);
    expectErrorJson(r.body);
    expect(r.body.error.code).toBe("transfer_download_required");
  });

  it("keeps gated sites gated: owner credentials export, anonymous callers get 401", async () => {
    const dw = await freshInstance();
    const pub = await publishManifest(dw, "zip-gated", [{ path: "index.html", bytes: u8("secret") }]);
    const locked = await dw.json(`/api/v1/sites/${pub.slug}/access`, {
      ...jsonBody({ mode: "password", password: "correct-horse-1979" }),
      method: "PUT",
      key: dw.ownerKey,
    });
    expect(locked.status, `setup: password gate: ${JSON.stringify(locked.body)}`).toBe(200);
    const allowed = await getExport(dw, pub.slug, "live", dw.ownerKey);
    expect(allowed.status).toBe(200);
    expect((await allowed.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const denied = await getExportJson(dw, pub.slug, "live", null);
    expect(denied.status).toBe(401);
    expectErrorJson(denied.body);
    expectZipHeaders(allowed, pub.slug, pub.versionNumber, LIVE_CACHE);
  });
});

describe("export_version: streaming", () => {
  it("reads no R2 blobs until the GET body has a reader, then streams the exact files", async () => {
    const dw = await freshInstance();
    const pub = await publishManifest(dw, "zip-unread", [
      { path: "first.txt", bytes: u8("first unread blob") },
      { path: "second.txt", bytes: u8("second unread blob") },
    ]);
    const gate = gateR2AfterFirstBlob(dw);
    let res: Response | undefined;
    try {
      res = await getExport(dw, pub.slug, "v1");
      expect(res.status).toBe(200);
      expectZipHeaders(res, pub.slug, 1, PINNED_CACHE);
      expect(res.body).not.toBeNull();
      expect(res.bodyUsed).toBe(false);
      expect(res.body!.locked).toBe(false);
      await sleep(0); // No reader exists, even after scheduled stream pulls get a turn.
      expect(gate.calls, "an unread GET must not prefetch even the first blob").toHaveLength(0);
      gate.release();
      const out = unzipSync(new Uint8Array(await res.arrayBuffer()));
      expect(Object.keys(out)).toEqual(["first.txt", "second.txt"]);
      expect(new TextDecoder().decode(out["first.txt"])).toBe("first unread blob");
      expect(new TextDecoder().decode(out["second.txt"])).toBe("second unread blob");
      expect(gate.calls).toHaveLength(2);
      expect(new Set(gate.calls).size).toBe(2);
    } finally {
      gate.release();
      if (res && !res.bodyUsed) await res.body?.cancel();
      gate.restore();
    }
  });

  it("emits ZIP bytes before all blobs are read and never re-reads a blob", async () => {
    const dw = await freshInstance();
    const files: FixtureFile[] = Array.from({ length: 6 }, (_, i) => ({
      path: `blob-${i}.bin`,
      bytes: randomBytes(128 * 1024),
      contentType: "application/octet-stream",
    }));
    const pub = await publishManifest(dw, "zip-stream", files);
    const totalBytes = pub.totalBytes;
    expect(totalBytes).toBe(6 * 128 * 1024);
    const gate = gateR2AfterFirstBlob(dw);
    try {
      const res = await getExport(dw, pub.slug, "v1");
      expect(res.status).toBe(200);
      expectZipHeaders(res, pub.slug, pub.versionNumber, PINNED_CACHE);
      expect(res.body, "export must stream a body").not.toBeNull();
      const reader = res.body!.getReader();
      const first = await Promise.race([
        reader.read().then((r) => ({ kind: "chunk" as const, ...r })),
        sleep(10_000).then(() => ({ kind: "timeout" as const })),
      ]);
      if (first.kind !== "chunk") {
        gate.release();
        await reader.cancel().catch(() => {});
        throw new Error("export did not stream its first bytes within 10s while later blob reads were gated: it buffers the whole version");
      }
      expect(first.done, "first read must yield ZIP bytes").toBe(false);
      const head = first.value!;
      expect(head.length).toBeGreaterThan(2);
      expect(head[0]).toBe(0x50); // 'P'
      expect(head[1]).toBe(0x4b); // 'K'
      expect(head[2]).toBe(0x03);
      expect(head[3]).toBe(0x04);
      gate.release();
      const chunks: Uint8Array[] = [head];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
      const size = chunks.reduce((n, c) => n + c.length, 0);
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.length;
      }
      const out = unzipSync(bytes);
      expect(Object.keys(out).sort()).toEqual(files.map((f) => f.path).sort());
      for (const f of files) {
        expect(bytesEqual(out[f.path]!, f.bytes), `${f.path} round-trips exactly`).toBe(true);
      }
      const uniqueReads = new Set(gate.calls);
      expect(gate.calls.length, "total R2 reads must equal file count, including duplicates").toBe(files.length);
      expect(uniqueReads.size, `one R2 read per blob, no re-reads (got ${gate.calls.length} reads)`).toBe(files.length);
    } finally {
      gate.release();
      gate.restore();
    }
  });
});

describe("controls (green on main, before and after the build)", () => {
  it("publishes a manifest version and reads it back through versions and files", async () => {
    const dw = await freshInstance();
    const pub = await publishManifest(dw, "control-site", [{ path: "index.html", bytes: u8("control") }]);
    const versions = await dw.json(`/api/v1/sites/${pub.slug}/versions`, { key: dw.ownerKey });
    expect(versions.status).toBe(200);
    expect(versions.body.versions).toHaveLength(1);
    const one = await dw.json(`/api/v1/sites/${pub.slug}/versions/live`, { key: dw.ownerKey });
    expect(one.status).toBe(200);
    expect(one.body.version.fileCount).toBe(1);
    const manifest = await listManifest(dw, pub.slug, pub.versionId);
    expect(manifest.get("index.html")?.sha256).toBe(await sha256Hex(u8("control")));
  });

  it("keeps the operations table and the OpenAPI 3.1 baseline valid", async () => {
    const dw = await freshInstance();
    const table = await dw.json("/api/v1/operations");
    expect(table.status).toBe(200);
    expect(commandRows(table.body).some((r) => r.id === "list_versions")).toBe(true);
    const doc = (await dw.json("/openapi.json")).body as Record<string, any>;
    expect(doc.openapi).toMatch(/^3\.1\.\d+$/);
    expect(apiOperations(doc).some(({ op }) => op.operationId === "get_version")).toBe(true);
  });

  it("reads single files byte-exact (the file-by-file path cap hints point to)", async () => {
    const dw = await freshInstance();
    const want = u8("file by file");
    await publishManifest(dw, "control-file", [{ path: "docs/note.txt", bytes: want }]);
    const res = await dw.call("/api/v1/sites/control-file/files/docs/note.txt", { key: dw.ownerKey });
    expect(res.status).toBe(200);
    expect(bytesEqual(new Uint8Array(await res.arrayBuffer()), want)).toBe(true);
  });

  it("lists MCP tools with get_version", async () => {
    const dw = await freshInstance();
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const names = (await mcp.tools()).map((t) => t.name);
      expect(names.length).toBeGreaterThan(20);
      expect(names).toContain("get_version");
    } finally {
      await mcp.client.close();
    }
  });

  it("answers JSON errors with code and hint on unknown routes", async () => {
    const dw = await freshInstance();
    const r = await dw.json("/api/v1/does-not-exist", { key: dw.ownerKey });
    expect(r.status).toBe(404);
    expectErrorJson(r.body);
    expect(r.body.error.code).toBe("route_not_found");
  });
});
