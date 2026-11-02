import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { idempotencyScope, type MemberPrincipal } from "@kofra/core";
import { freshInstance, jsonBody, type Instance } from "./helpers";
import { connectLegacyMcp, connectMcp } from "./mcp-helpers";

function publish(dw: Instance, key: string, input: unknown, retryKey: string) {
  return dw.json("/api/v1/publish-sources", {
    key, ...jsonBody(input),
    headers: { "Content-Type": "application/json", "Idempotency-Key": retryKey },
  });
}

async function fixture() {
  const dw = await freshInstance();
  const member = await dw.json("/api/v1/members", {
    key: dw.ownerKey, ...jsonBody({ email: "replay-member@example.com", role: "member" }),
  });
  expect(member.status).toBe(201);
  const key: string = member.body.apiKey.key;
  const siteA = await publish(dw, key, { site: "replay-site-a", files: [{ path: "index.html", content: "A" }] }, "create-a");
  expect(siteA.status).toBe(200);
  const input = { site: "replay-site-b", title: "B private metadata", files: [{ path: "index.html", content: "B" }] };
  const siteB = await publish(dw, key, input, "create-b");
  expect(siteB.status).toBe(200);
  const restricted = await dw.json("/api/v1/keys", {
    key: dw.ownerKey, ...jsonBody({
      memberId: member.body.member.id, site: "replay-site-a", scopes: ["sites:read", "sites:write"],
    }),
  });
  expect(restricted.status).toBe(201);
  expect(restricted.body.scopes).toEqual(expect.arrayContaining(["sites:read", "sites:write"]));
  const own = await dw.json("/api/v1/sites/replay-site-a", { key: restricted.body.key });
  expect(own.status).toBe(200);
  expect(own.body.site.slug).toBe("replay-site-a");
  return { dw, member, key, restricted: restricted.body, siteA: siteA.body, siteB: siteB.body, input };
}

describe("publish-sources authorization-bound replay", () => {
  it("same credential/input replays, but changed input conflicts without another version", async () => {
    const { dw, key, siteB, input } = await fixture();
    const replay = await publish(dw, key, input, "create-b");
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, slug: "replay-site-b", version: { id: siteB.version.id } });
    const changed = await publish(dw, key, { ...input, title: "changed" }, "create-b");
    expect(changed.status).toBe(422);
    expect(changed.body.error.code).toBe("idempotency_key_reused");
    const versions = await dw.json("/api/v1/sites/replay-site-b/versions", { key });
    expect(versions.status).toBe(200);
    expect(versions.body.versions.map((version: { id: string }) => version.id)).toEqual([siteB.version.id]);
  });

  it("does not disclose B to another key for the same member restricted to A", async () => {
    const { dw, restricted, input } = await fixture();
    const cold = await publish(dw, restricted.key, input, "fresh-denial");
    expect(cold.status).toBe(404);
    expect(cold.body).not.toHaveProperty("site");
    const replay = await publish(dw, restricted.key, input, "create-b");
    expect.soft(replay.status).toBe(404);
    expect.soft(replay.body).not.toHaveProperty("site");
    expect.soft(replay.body).not.toHaveProperty("version");
    expect.soft(JSON.stringify(replay.body)).not.toContain("B private metadata");
  });

  it("does not disclose B after the exact same API credential becomes restricted to A", async () => {
    const { dw, member, key, input } = await fixture();
    // Model an authorization change, not credential replacement. Only emulated D1
    // is changed; all subsequent authorization and replay are real public requests.
    await env.DB.prepare("UPDATE api_keys SET site_id = (SELECT id FROM sites WHERE slug = ?) WHERE id = ?")
      .bind("replay-site-a", member.body.apiKey.id).run();
    const own = await dw.json("/api/v1/sites/replay-site-a", { key });
    expect(own.status).toBe(200);
    const cold = await publish(dw, key, input, "changed-credential-fresh-denial");
    expect(cold.status).toBe(404);
    const replay = await publish(dw, key, input, "create-b");
    expect.soft(replay.status).toBe(404);
    expect.soft(replay.body).not.toHaveProperty("site");
    expect.soft(replay.body).not.toHaveProperty("version");
  });

  it("rechecks reduced scopes before a cached result is returned", async () => {
    const { dw, member, key, input } = await fixture();
    await env.DB.prepare("UPDATE api_keys SET scopes = ? WHERE id = ?")
      .bind("sites:read", member.body.apiKey.id).run();
    expect((await dw.json("/api/v1/sites/replay-site-a", { key })).status).toBe(200);
    const replay = await publish(dw, key, input, "create-b");
    expect(replay.status).toBe(403);
    expect(replay.body.error.code).toBe("insufficient_scope");
    expect(replay.body).not.toHaveProperty("site");
  });
});

describe("MCP replay uses the same authorization boundary", () => {
  it.each(["modern", "legacy"] as const)("prevents restricted-member replay through the %s client", async (protocol) => {
    const { dw, key, restricted, input } = await fixture();
    const connect = protocol === "legacy" ? connectLegacyMcp : connectMcp;
    const unrestricted = await connect(dw, key);
    const limited = await connect(dw, restricted.key);
    try {
      const args = { ...input, idempotencyKey: "mcp-boundary" };
      const first = await unrestricted.call("publish_site", args);
      expect(first.isError).toBe(false);
      expect(first.data.slug).toBe("replay-site-b");
      const same = await unrestricted.call("publish_site", args);
      expect(same.isError).toBe(false);
      expect(same.data).toMatchObject({ replayed: true, version: { id: first.data.version.id } });
      const cold = await limited.call("publish_site", { ...args, idempotencyKey: "mcp-fresh-denial" });
      expect(cold.isError).toBe(true);
      expect(cold.data.error.code).toBe("site_not_found");
      const denied = await limited.call("publish_site", args);
      expect.soft(denied.isError).toBe(true);
      expect.soft(denied.data).not.toHaveProperty("site");
      expect.soft(denied.data).not.toHaveProperty("version");
    } finally {
      await unrestricted.client.close();
      await limited.client.close();
    }
  });
});

// The shared public primitive is also consumed by legacy REST and MCP callers.
// These are equivalence/isolation contracts, not pins to its private key format.
const principal: MemberPrincipal = {
  kind: "member", tenantId: "tenant-a", memberId: "member-a", keyId: "key-a",
  role: "member", scopes: ["sites:read", "sites:write"], siteId: null,
  via: "api_key", ip: "192.0.2.1",
};

describe("shared idempotency authorization identity", () => {
  it.each([
    { label: "tenant", change: { tenantId: "tenant-b" } },
    { label: "role", change: { role: "admin" as const } },
    { label: "scope restrictions", change: { scopes: ["sites:read"] as const } },
    { label: "site restriction", change: { siteId: "site-a" } },
  ])("isolates changed $label even when member and credential IDs match", ({ change }) => {
    expect(idempotencyScope({ ...principal, ...change })).not.toBe(idempotencyScope(principal));
  });

  it("is stable for equivalent permissions regardless of scope ordering or caller IP", () => {
    expect(idempotencyScope({ ...principal, scopes: ["sites:write", "sites:read"], ip: "192.0.2.2" }))
      .toBe(idempotencyScope(principal));
  });
});
