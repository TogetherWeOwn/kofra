import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOperation } from "@kofra/server";
import { form, freshInstance, jsonBody, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";

async function anonymousSite(dw: Instance) {
  const published = await dw.json<{ slug: string; claimToken: string }>("/api/v1/publish", {
    method: "POST", body: form({ "index.html": "anonymous site" }),
  });
  expect(published.status).toBe(201);
  expect(published.body.claimToken).toMatch(/^dwc_/);
  return published.body;
}

async function scopeFixture(scope: "keys:write" | "members:write") {
  const calls: string[] = [];
  const operation = defineOperation({
    id: "claim_scope_diagnostic",
    toolset: "core",
    method: "POST",
    path: "/api/v1/diagnostics/claim-scope",
    scopes: ["sites:read", scope],
    summary: "Report the caller kind",
    description: "A side-effect-free diagnostic that relies only on declared scopes for authorization.",
    input: z.object({}),
    output: z.object({ kind: z.string() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async handler(_input, ctx) {
      calls.push(ctx.principal.kind);
      return { kind: ctx.principal.kind };
    },
  });
  const dw = await freshInstance({ anonymous: { enabled: true } }, { operations: [operation] });
  const site = await anonymousSite(dw);
  return { dw, site, operation, calls };
}

describe("claim-token operation scopes", () => {
  // A valid claim grants site read/write, never key or member administration.
  // The diagnostic deliberately has no handler-level auth check or key/member mutation.
  it.each(["keys:write", "members:write"] as const)("REST refuses %s before invoking an extension handler", async (scope) => {
    const { dw, site, operation, calls } = await scopeFixture(scope);
    const owner = await dw.json(operation.path, { key: dw.ownerKey, ...jsonBody({}) });
    expect(owner.status).toBe(200);
    expect(owner.body).toEqual({ kind: "member" });
    expect(calls).toEqual(["member"]);
    calls.length = 0;

    const denied = await dw.json(operation.path, { key: site.claimToken, ...jsonBody({}) });
    expect.soft(denied.status).toBe(403);
    expect.soft(denied.body).toMatchObject({ error: { code: "insufficient_scope" } });
    expect.soft(calls).toEqual([]);
  });

  it.each(["keys:write", "members:write"] as const)("MCP refuses %s before invoking an extension handler", async (scope) => {
    const { dw, site, operation, calls } = await scopeFixture(scope);
    const owner = await connectMcp(dw, dw.ownerKey);
    try {
      const allowed = await owner.call(operation.id);
      expect(allowed.isError).toBe(false);
      expect(allowed.data).toEqual({ kind: "member" });
      expect(calls).toEqual(["member"]);
    } finally {
      await owner.client.close();
    }
    calls.length = 0;

    const claim = await connectMcp(dw, site.claimToken);
    try {
      const denied = await claim.call(operation.id);
      expect.soft(denied.isError).toBe(true);
      expect.soft(denied.data).toMatchObject({ error: { code: "insufficient_scope" } });
      expect.soft(calls).toEqual([]);
    } finally {
      await claim.client.close();
    }
  });
});

describe("claim-token core site ownership", () => {
  it("REST still lets a claim read and update its own site", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const site = await anonymousSite(dw);
    const own = await dw.json(`/api/v1/sites/${site.slug}`, { key: site.claimToken });
    expect(own.status).toBe(200);
    expect(own.body.site.slug).toBe(site.slug);
    const updated = await dw.json(`/api/v1/sites/${site.slug}`, {
      key: site.claimToken, ...jsonBody({ title: "Updated by its claim" }), method: "PATCH",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.site.title).toBe("Updated by its claim");
    const readBack = await dw.json(`/api/v1/sites/${site.slug}`, { key: site.claimToken });
    expect(readBack.body.site.title).toBe("Updated by its claim");
  });

  it("MCP still lets a claim read and update its own site", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const site = await anonymousSite(dw);
    const claim = await connectMcp(dw, site.claimToken);
    try {
      const own = await claim.call("get_site", { site: site.slug });
      expect(own.isError).toBe(false);
      expect(own.data.site.slug).toBe(site.slug);
      const updated = await claim.call("update_site_settings", { site: site.slug, title: "Updated by its claim" });
      expect(updated.isError).toBe(false);
      expect(updated.data.site.title).toBe("Updated by its claim");
      const readBack = await claim.call("get_site", { site: site.slug });
      expect(readBack.data.site.title).toBe("Updated by its claim");
    } finally {
      await claim.client.close();
    }
  });

  it("REST denies a claim read and write access to a different site", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const own = await anonymousSite(dw);
    const other = await anonymousSite(dw);
    const before = await dw.json(`/api/v1/sites/${other.slug}`, { key: other.claimToken });
    expect(before.status).toBe(200);
    const read = await dw.json(`/api/v1/sites/${other.slug}`, { key: own.claimToken });
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe("site_not_found");
    const write = await dw.json(`/api/v1/sites/${other.slug}`, {
      key: own.claimToken, ...jsonBody({ title: "Must not change" }), method: "PATCH",
    });
    expect(write.status).toBe(404);
    expect(write.body.error.code).toBe("site_not_found");
    const after = await dw.json(`/api/v1/sites/${other.slug}`, { key: other.claimToken });
    expect(after.status).toBe(200);
    expect(after.body.site.title).toBe(before.body.site.title);
  });

  it("MCP denies a claim read and write access to a different site", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const own = await anonymousSite(dw);
    const other = await anonymousSite(dw);
    const before = await dw.json(`/api/v1/sites/${other.slug}`, { key: other.claimToken });
    expect(before.status).toBe(200);
    const claim = await connectMcp(dw, own.claimToken);
    try {
      const read = await claim.call("get_site", { site: other.slug });
      expect(read.isError).toBe(true);
      expect(read.data.error.code).toBe("site_not_found");
      const write = await claim.call("update_site_settings", { site: other.slug, title: "Must not change" });
      expect(write.isError).toBe(true);
      expect(write.data.error.code).toBe("site_not_found");
    } finally {
      await claim.client.close();
    }
    const after = await dw.json(`/api/v1/sites/${other.slug}`, { key: other.claimToken });
    expect(after.status).toBe(200);
    expect(after.body.site.title).toBe(before.body.site.title);
  });
});
