import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { DropwayConfig, DropwayVars, Principal } from "@dropway/core";
import { freshInstance, jsonBody, manifestEntry, type Instance } from "./helpers";

// SPEC 9.2 / 11.4: an upload credential grants PUT authority for one pending
// manifest, never general site authority. All storage and routing are real.
afterEach(() => vi.restoreAllMocks());

async function publish(dw: Instance, body: Record<string, unknown>) {
  return dw.json("/api/v1/publish", { ...jsonBody(body), key: dw.ownerKey });
}

async function pending(dw: Instance, site: string, texts: Record<string, string>) {
  const entries = await Promise.all(Object.entries(texts).map(([path, text]) => manifestEntry(path, text)));
  const result = await publish(dw, { site, files: entries.map(({ bytes, ...entry }) => entry) });
  // The pending response is accepted, not a completed/live creation (201).
  expect(result.status).toBe(202);
  expect(result.body.status).toBe("awaiting_upload");
  expect(result.body.upload.items).toHaveLength(entries.length);
  const token = new Headers(result.body.upload.items[0].headers).get("Authorization")!;
  expect(token).toMatch(/^Bearer dwu_\S+$/);
  return { version: result.body.version as { id: string }, upload: result.body.upload as { expiresAt: string }, entries, token };
}

async function put(dw: Instance, entry: Awaited<ReturnType<typeof manifestEntry>>, token: string) {
  return dw.json(`/api/v1/blobs/${entry.sha256}`, {
    method: "PUT", headers: { Authorization: token, "Content-Length": String(entry.size), "CF-Connecting-IP": "192.0.2.44" }, body: entry.bytes,
  });
}

async function finalize(dw: Instance, site: string, versionId: string, token = `Bearer ${dw.ownerKey}`) {
  // REST still uses /deploys until the R-05 route rename; MCP uses finalize_version.
  return dw.json(`/api/v1/sites/${site}/deploys/${versionId}/finalize`, { method: "POST", headers: { Authorization: token } });
}

function expectForbidden(result: { status: number; body: Record<string, any> }) {
  expect(result.status).toBe(403);
  expect(result.body.error).toMatchObject({ code: expect.any(String), hint: expect.any(String) });
  expect(result.body.error.hint.length).toBeGreaterThan(0);
}

describe("Publish v2 extension API v4 additions", () => {
  it("exposes the upload Principal and URL fetch configuration through public core types", () => {
    // Also checked by npm run typecheck; Vitest does not check these types.
    expectTypeOf<Extract<Principal, { kind: "upload" }>>().toEqualTypeOf<{
      kind: "upload"; versionId: string; expiresAt: number; ip: string;
    }>();
    expectTypeOf<DropwayConfig["urlFetchMaxBytes"]>().toEqualTypeOf<number>();
    expectTypeOf<DropwayVars["URL_FETCH_MAX_BYTES"]>().toEqualTypeOf<string | undefined>();
  });

  it("passes a real issued upload Principal to embedding middleware without member or claim authority", async () => {
    const seen: Principal[] = [];
    const dw = await freshInstance({}, { apiMiddleware: [async (c, next) => {
      const principal = c.get("principal");
      if (principal.kind === "upload") seen.push(principal);
      await next();
    }] });
    const source = await pending(dw, "extension-upload-principal", { "data.txt": "middleware bytes" });
    expect((await put(dw, source.entries[0]!, source.token)).status).toBe(201);
    expect(seen).toEqual([{
      kind: "upload", versionId: source.version.id,
      expiresAt: Date.parse(source.upload.expiresAt), ip: "192.0.2.44",
    }]);
  });

  it.each([false, true])("enforces URL_FETCH_MAX_BYTES with config override = %s", async (override) => {
    const bindings = env as unknown as DropwayVars;
    const previous = bindings.URL_FETCH_MAX_BYTES;
    try {
      bindings.URL_FETCH_MAX_BYTES = "8";
      const dw = await freshInstance(override ? { urlFetchMaxBytes: 4 } : {});
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(override ? "12345" : "123456789"));
      const refused = await publish(dw, { files: [{ path: "remote.txt", url: "https://93.184.216.34/config-boundary" }] });
      expect(refused.status).toBe(413);
      expect(refused.body.error.code).toBe("file_too_large");
      expect((await dw.json("/api/v1/sites", { key: dw.ownerKey })).body.sites).toEqual([]);
      vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(override ? "1234" : "12345678"));
      const accepted = await publish(dw, { files: [{ path: "remote.txt", url: "https://93.184.216.34/config-boundary" }] });
      expect(accepted.status).toBe(201);
      const bytes = await dw.call(`/api/v1/sites/${accepted.body.site.slug}/files/remote.txt`, { key: dw.ownerKey });
      expect(bytes.status).toBe(200);
      expect(await bytes.text()).toBe(override ? "1234" : "12345678");
    } finally {
      if (previous === undefined) delete bindings.URL_FETCH_MAX_BYTES;
      else bindings.URL_FETCH_MAX_BYTES = previous;
    }
  });
});

describe("issued upload token boundaries", () => {
  it("cannot list sites, inspect manifests or read live and pinned version bytes", async () => {
    const dw = await freshInstance();
    const live = await publish(dw, { site: "upload-not-reader", files: [{ path: "secret.txt", content: "owner byte sentinel" }] });
    expect(live.status).toBe(201);
    const source = await pending(dw, "upload-not-reader", { "next.txt": "not uploaded" });
    const base = "/api/v1/sites/upload-not-reader";
    for (const path of [
      "/api/v1/sites", base, `${base}/files`, `${base}/files?version=${source.version.id}`,
      `${base}/versions`, `${base}/versions/${source.version.id}`,
      `${base}/files/secret.txt`, `${base}/files/secret.txt?version=${live.body.version.id}`,
      `${base}/versions/${live.body.version.id}/export`,
    ]) {
      const owner = await dw.call(path, { key: dw.ownerKey });
      expect(owner.status, `positive owner control: ${path}`).toBe(200);
      await owner.arrayBuffer();
      const refused = await dw.json(path, { headers: { Authorization: source.token } });
      expectForbidden(refused);
      expect(JSON.stringify(refused.body)).not.toContain("owner byte sentinel");
    }
    expect((await put(dw, source.entries[0]!, source.token)).status).toBe(201);
  });

  it("cannot publish or finalize, including after it has uploaded all required bytes", async () => {
    const dw = await freshInstance();
    const source = await pending(dw, "upload-not-publisher", { "data.txt": "pending bytes" });
    expect((await put(dw, source.entries[0]!, source.token)).status).toBe(201);
    const init = jsonBody({ site: "upload-created-forbidden", files: [{ path: "data.txt", content: "forbidden" }] });
    expectForbidden(await dw.json("/api/v1/publish", { ...init, headers: { ...init.headers, Authorization: source.token } }));
    expectForbidden(await finalize(dw, "upload-not-publisher", source.version.id, source.token));
    expect((await env.DB.prepare("SELECT status FROM versions WHERE id = ?").bind(source.version.id).first<{ status: string }>())?.status).toBe("pending");
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey })).body.sites).toHaveLength(1);
    expect((await finalize(dw, "upload-not-publisher", source.version.id)).status).toBe(200);
  });

  it.each([
    { method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "upload-boundary", version: "1" } } },
    { method: "tools/list", params: {} },
    { method: "tools/call", params: { name: "whoami", arguments: {} } },
    { method: "tools/call", params: { name: "publish_site", arguments: { files: [{ path: "data.txt", content: "forbidden" }] } } },
  ])("cannot use MCP $method ($params)", async ({ method, params }) => {
    const dw = await freshInstance();
    const source = await pending(dw, "upload-not-mcp", { "data.txt": "scoped bytes" });
    const init = jsonBody({ jsonrpc: "2.0", id: 1, method, params });
    const response = await dw.json("/mcp", {
      ...init, headers: { ...init.headers, Authorization: source.token, Accept: "application/json, text/event-stream" },
    });
    expectForbidden(response);
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey })).body.sites).toHaveLength(1);
    expect((await put(dw, source.entries[0]!, source.token)).status).toBe(201);
  });

  it("loses upload authority immediately on finalization, even for an already stored hash", async () => {
    const dw = await freshInstance();
    const source = await pending(dw, "finalized-upload", { "data.txt": "finalized bytes" });
    expect((await put(dw, source.entries[0]!, source.token)).status).toBe(201);
    expect((await finalize(dw, "finalized-upload", source.version.id)).status).toBe(200);
    expectForbidden(await put(dw, source.entries[0]!, source.token));
    const live = await dw.call("/api/v1/sites/finalized-upload/files/data.txt", { key: dw.ownerKey });
    expect(live.status).toBe(200);
    expect(await live.text()).toBe("finalized bytes");
  });

  it("loses upload authority when its pending version is deleted", async () => {
    const dw = await freshInstance();
    const source = await pending(dw, "deleted-upload", { "data.txt": "deleted bytes" });
    expect((await dw.json(`/api/v1/sites/deleted-upload/versions/${source.version.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "deleted-upload" }), key: dw.ownerKey })).status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM versions WHERE id = ?").bind(source.version.id).first()).toBeNull();
    const refused = await put(dw, source.entries[0]!, source.token);
    expect([403, 410]).toContain(refused.status);
    expect(await env.FILES.head(`blobs/${source.entries[0]!.sha256}`)).toBeNull();
  });

  it("loses upload authority when its site is deleted while the version is pending", async () => {
    const dw = await freshInstance();
    const source = await pending(dw, "deleted-upload-site", { "data.txt": "site deleted bytes" });
    expect((await dw.json("/api/v1/sites/deleted-upload-site", { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    const refused = await put(dw, source.entries[0]!, source.token);
    expect([403, 410]).toContain(refused.status);
    expect(await env.FILES.head(`blobs/${source.entries[0]!.sha256}`)).toBeNull();
  });

  it("a shared SHA on two pending versions cannot widen one token to the other's extra blob", async () => {
    const dw = await freshInstance();
    const a = await pending(dw, "shared-sha-a", { "shared.txt": "shared bytes" });
    const b = await pending(dw, "shared-sha-b", { "shared.txt": "shared bytes", "only-b.txt": "private to manifest B" });
    expect(a.entries[0]!.sha256).toBe(b.entries[0]!.sha256);
    expect(a.version.id).not.toBe(b.version.id);
    expectForbidden(await put(dw, b.entries[1]!, a.token));
    expect((await put(dw, a.entries[0]!, a.token)).status).toBe(201);
    expectForbidden(await put(dw, b.entries[1]!, a.token));
    expect(await env.FILES.head(`blobs/${b.entries[1]!.sha256}`)).toBeNull();
    const state = await dw.json(`/api/v1/sites/shared-sha-b/versions/${b.version.id}`, { key: dw.ownerKey });
    expect(state.status).toBe(200);
    expect(state.body.version.status).toBe("pending");
    expect(state.body.missing).toContain(b.entries[1]!.sha256);
    expect((await put(dw, b.entries[1]!, b.token)).status).toBe(201);
    expect((await finalize(dw, "shared-sha-a", a.version.id)).status).toBe(200);
    expect((await finalize(dw, "shared-sha-b", b.version.id)).status).toBe(200);
  });
});
