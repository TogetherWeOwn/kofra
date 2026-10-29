import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect } from "vitest";
import { createTenantWithOwner, mintApiKey, type DropwayContext } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { jsonBody, type Instance } from "./helpers";

export const MiB = 1024 * 1024;
export const DAY = 86_400_000;
export type Reply = { status: number; body: Record<string, any>; res: Response };
export type Pending = { site: string; versionId: string; sha256: string; size: number; key: string; token: string };
export type Session = { id: string; sha256: string; size: number; partSize: number; parts: { partNumber: number; size: number; etag: string }[] };

export function accepted(reply: Reply) {
  expect(reply.status, JSON.stringify(reply.body)).toBeGreaterThanOrEqual(200);
  expect(reply.status, JSON.stringify(reply.body)).toBeLessThan(300);
}

export async function refused(dw: Instance, reply: Reply, statuses = [400, 401, 403, 404, 409, 410, 411, 413, 422]) {
  expect(statuses, JSON.stringify(reply.body)).toContain(reply.status);
  expect(reply.body.error).toMatchObject({ code: expect.stringMatching(/^[a-z][a-z0-9_]*$/), hint: expect.any(String) });
  expect(reply.body.error.hint.length).toBeGreaterThan(0);
  expect(reply.body.error.code, "a missing route is not a security/validation refusal").not.toBe("route_not_found");
  const catalog = await dw.call("/docs/errors");
  expect(catalog.status).toBe(200);
  expect(await catalog.text(), "new refusal codes must enter the public error catalog").toContain(reply.body.error.code);
}

// `null` means omit the field entirely (a generated site name / the server
// partSize default); explicit `undefined` would trigger the default parameter.
export async function pending(dw: Instance, sha256: string, size: number, site: string | null = "multipart-fixture", key = dw.ownerKey): Promise<Pending> {
  const result = await dw.json("/api/v1/publish", { ...jsonBody({ ...(site === null ? {} : { site }), files: [{ path: "data.bin", sha256, size }] }), key });
  expect(result.status, JSON.stringify(result.body)).toBe(202);
  expect(result.body.status).toBe("awaiting_upload");
  const authorization = new Headers(result.body.upload.items[0].headers).get("Authorization")!;
  expect(authorization).toMatch(/^Bearer dwu_/);
  return { site: result.body.site.slug, versionId: result.body.version.id, sha256, size, key, token: authorization.slice(7) };
}

export function start(dw: Instance, p: Pending, partSize: number | null = 10 * MiB, key = p.key) {
  return dw.json("/api/v1/uploads", { ...jsonBody({ versionId: p.versionId, sha256: p.sha256, ...(partSize === null ? {} : { partSize }) }), key });
}

export async function session(dw: Instance, p: Pending, partSize: number | null = 10 * MiB, key = p.key): Promise<Session> {
  const result = await start(dw, p, partSize, key);
  accepted(result);
  expect(result.body).toMatchObject({ id: expect.any(String), sha256: p.sha256, size: p.size, partSize: partSize ?? 50 * MiB, parts: [] });
  return result.body as Session;
}

export function putPart(dw: Instance, s: Session, partNumber: number | string, bytes: Uint8Array, key: string, length: string | null = String(bytes.length)) {
  return dw.json(`/api/v1/uploads/${s.id}/parts/${partNumber}`, {
    method: "PUT", key, body: bytes,
    headers: length === null ? {} : { "Content-Length": length },
  });
}

export function state(dw: Instance, s: Session, key: string) {
  return dw.json(`/api/v1/uploads/${s.id}`, { key });
}

export function complete(dw: Instance, s: Session, key: string, body?: unknown) {
  return dw.json(`/api/v1/uploads/${s.id}/complete`, { ...jsonBody(body ?? {}), key });
}

export function finalize(dw: Instance, p: Pending, key = p.key) {
  return dw.json(`/api/v1/sites/${p.site}/deploys/${p.versionId}/finalize`, { method: "POST", key });
}

export async function context<T>(dw: Instance, fn: (dc: DropwayContext) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  try { return await fn(dw.dropway.context(env as unknown as ServerBindings, ctx)); }
  finally { await waitOnExecutionContext(ctx); }
}

export async function foreignKey(dw: Instance) {
  return context(dw, async (dc) => {
    const { tenant, owner } = await createTenantWithOwner(dc, { owner: { email: "other@example.test" } });
    return (await mintApiKey(dc, { tenantId: tenant.id, memberId: owner.id, scopes: ["sites:read", "sites:write", "sites:delete", "admin"] })).key;
  });
}

export async function unregistered(sha256: string) {
  expect(await env.FILES.head(`blobs/${sha256}`)).toBeNull();
  expect(await env.DB.prepare("SELECT sha256 FROM blobs WHERE sha256 = ?").bind(sha256).first()).toBeNull();
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM blob_scopes WHERE sha256 = ?").bind(sha256).first<{ n: number }>())?.n).toBe(0);
}
