import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { clearLiveMemoryCache } from "@dropway/core";
import { createDropway, type ServerBindings } from "@dropway/server";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP, freshInstance, jsonBody, ORIGIN } from "./helpers";

const poison = { toString: null };

type ApiResult = { status: number; body: Record<string, any> };

function expectInvalidField(result: ApiResult, path: string) {
  expect(result.status, JSON.stringify(result.body)).toBe(400);
  expect(result.body.error).toMatchObject({ code: "invalid_field", retryable: false });
  expect(result.body.error.details?.fields).toEqual(expect.arrayContaining([
    expect.objectContaining({ path, message: expect.any(String) }),
  ]));
}

async function siteStorage() {
  const tables = ["sites", "versions", "version_files", "blobs", "blob_scopes"];
  return Object.fromEntries(await Promise.all(tables.map(async (table) => {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    return [table, results.map((row) => JSON.stringify(row)).sort()];
  })));
}

async function memberStorage() {
  const [members, apiKeys] = await Promise.all([
    env.DB.prepare("SELECT * FROM members").all(),
    // Authentication records key use; compare the remaining key fields to detect an orphan key.
    env.DB.prepare("SELECT id, tenant_id, member_id, name, prefix, key_hash, scopes, site_id, created_at, expires_at, revoked_at FROM api_keys").all(),
  ]);
  return {
    members: members.results.map((row) => JSON.stringify(row)).sort(),
    apiKeys: apiKeys.results.map((row) => JSON.stringify(row)).sort(),
  };
}

async function setupStorage() {
  const tables = ["tenants", "members", "api_keys"];
  return Object.fromEntries(await Promise.all(tables.map(async (table) => {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    return [table, results.map((row) => JSON.stringify(row)).sort()];
  })));
}

async function unconfiguredDropway() {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  clearLiveMemoryCache();
  return createDropway();
}

async function bootstrapJson(dropway: ReturnType<typeof createDropway>, body: unknown): Promise<ApiResult> {
  const ctx = createExecutionContext();
  const res = await dropway.fetch(new Request(`${ORIGIN}/api/v1/setup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BOOTSTRAP}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env as unknown as ServerBindings, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: await res.json() };
}

describe("poisoned JSON coercion regressions", () => {
  it("rejects a create-site slug whose string conversion throws before writing", async () => {
    const dw = await freshInstance();
    const before = await siteStorage();
    const result = await dw.json("/api/v1/sites", {
      key: dw.ownerKey,
      ...jsonBody({ slug: poison }),
    });

    expectInvalidField(result, "slug");
    expect(await siteStorage()).toEqual(before);
  });

  it("rejects a one-shot JSON publish slug whose string conversion throws before writing", async () => {
    const dw = await freshInstance();
    const before = await siteStorage();
    const result = await dw.json("/api/v1/publish", {
      key: dw.ownerKey,
      ...jsonBody({ slug: poison, files: [{ path: "index.html", content: "body" }] }),
    });

    expectInvalidField(result, "slug");
    expect(await siteStorage()).toEqual(before);
  });

  it("rejects a one-shot JSON publish path whose string conversion throws before writing", async () => {
    const dw = await freshInstance();
    const before = await siteStorage();
    const result = await dw.json("/api/v1/publish", {
      key: dw.ownerKey,
      ...jsonBody({ files: [{ path: poison, content: "body" }] }),
    });

    expectInvalidField(result, "files.0.path");
    expect(await siteStorage()).toEqual(before);
  });

  it("rejects a one-shot JSON publish content type whose string conversion throws before writing", async () => {
    const dw = await freshInstance();
    const before = await siteStorage();
    const result = await dw.json("/api/v1/publish", {
      key: dw.ownerKey,
      ...jsonBody({ files: [{ path: "index.html", content: "body", contentType: poison }] }),
    });

    expectInvalidField(result, "files.0.contentType");
    expect(await siteStorage()).toEqual(before);
  });

  for (const field of ["name", "role"] as const) {
    it(`rejects an update-member ${field} whose string conversion throws without changing the member`, async () => {
      const dw = await freshInstance();
      const added = await dw.json("/api/v1/members", {
        key: dw.ownerKey,
        ...jsonBody({ email: "member@example.com" }),
      });
      expect(added.status).toBe(201);
      const before = await memberStorage();
      const result = await dw.json(`/api/v1/members/${added.body.member.id}`, {
        key: dw.ownerKey,
        ...jsonBody({ [field]: poison }),
        method: "PATCH",
      });

      expectInvalidField(result, field);
      expect(await memberStorage()).toEqual(before);
    });
  }

  it("rejects a create-member keyName whose string conversion throws without leaving a member behind", async () => {
    const dw = await freshInstance();
    const before = await memberStorage();
    const result = await dw.json("/api/v1/members", {
      key: dw.ownerKey,
      ...jsonBody({ email: "orphan@example.com", keyName: poison }),
    });

    expectInvalidField(result, "keyName");
    expect(await memberStorage()).toEqual(before);
  });

  it("rejects a setup keyName whose string conversion throws before creating an owner", async () => {
    const dropway = await unconfiguredDropway();
    const before = await setupStorage();
    const result = await bootstrapJson(dropway, { email: "owner@example.com", keyName: poison });

    expectInvalidField(result, "keyName");
    expect(await setupStorage()).toEqual(before);
  });
});
