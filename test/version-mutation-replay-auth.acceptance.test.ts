import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { ApiError, clearLiveMemoryCache, defaultPolicy } from "@dropway/core";
import { jsonBody } from "./helpers";
import {
  ACTIONS, OTHER, SLUG, SURFACES, expectFailure, expectReplay, expectSuccess,
  fixture, input, observe, pointer, publish, snapshot, transport,
} from "./version-mutation-replay.helpers";

afterEach(() => { vi.restoreAllMocks(); clearLiveMemoryCache(); });

for (const surface of SURFACES) for (const action of ACTIONS) describe(`${surface} ${action} fresh authorization before replay`, () => {
  it.each([
    { kind: "reduced scope", status: 403, code: "insufficient_scope" },
    { kind: "different site restriction", status: 404, code: "site_not_found" },
    { kind: "revoked credential", status: 401, code: "invalid_api_key" },
    { kind: "foreign ownership", status: 404, code: "site_not_found" },
    { kind: "deleted site", status: 404, code: "site_not_found" },
  ] as const)("refuses $kind without exposing a prior receipt", async ({ kind, status, code }) => {
    const h = await fixture();
    const t = await transport(h, surface);
    try {
      const a = input(h, action);
      expectSuccess(await t.invoke(action, a));
      if (kind === "reduced scope") {
        await env.DB.prepare("UPDATE api_keys SET scopes = 'sites:read' WHERE id = ?").bind(h.actor.id).run();
      } else if (kind === "different site restriction") {
        await env.DB.prepare("UPDATE api_keys SET site_id = ? WHERE id = ?").bind(h.other.id, h.actor.id).run();
      } else if (kind === "revoked credential") {
        await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").bind(Date.now(), h.actor.id).run();
      } else if (kind === "foreign ownership") {
        await env.DB.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('tenant_replay_other', 'Other owner', ?)").bind(Date.now()).run();
        await env.DB.prepare("UPDATE sites SET tenant_id = 'tenant_replay_other' WHERE id = ?").bind(h.site.id).run();
      } else {
        await env.DB.prepare("UPDATE sites SET deleted_at = ? WHERE id = ?").bind(Date.now(), h.site.id).run();
      }
      const before = await snapshot();
      const observed = observe(h);
      const warm = await t.invoke(action, a);
      expectFailure(warm, status, code);
      expect.soft(JSON.stringify(warm.body)).not.toContain(h.actor.key);
      observed.expectNoAction();
      expect.soft(await snapshot()).toEqual(before);
    } finally { await t.close(); }
  });

  it("rechecks a new policy refusal even though the result was previously persisted", async () => {
    let paused = false;
    const h = await fixture({ adapters: { policy: {
      ...defaultPolicy,
      beforeOperation(_p, op) {
        if (paused && op.id === `${action}_version`) {
          throw new ApiError(403, "version_actions_paused", "Version actions are paused.", "Retry after maintenance.");
        }
      },
    } } });
    const t = await transport(h, surface);
    try {
      const a = input(h, action);
      const first = await t.invoke(action, a);
      expectSuccess(first);
      paused = true;
      const before = await snapshot();
      const observed = observe(h);
      expectFailure(await t.invoke(action, a), 403, "version_actions_paused");
      observed.expectNoAction();
      expect.soft(await snapshot()).toEqual(before);
      paused = false;
      observed.clear();
      expectReplay(await t.invoke(action, a), first);
      observed.expectNoAction();
    } finally { await t.close(); }
  });

  it("does not share results with another credential for the same member and permissions", async () => {
    const h = await fixture();
    const minted = await h.dw.json("/api/v1/keys", {
      key: h.dw.ownerKey, ...jsonBody({ name: "independent caller", scopes: ["sites:read", "sites:write", "sites:delete"] }),
    });
    expect(minted.status).toBe(201);
    const first = await transport(h, surface);
    const second = await transport(h, surface, minted.body.key);
    try {
      const a = input(h, action);
      expectSuccess(await first.invoke(action, a));
      if (action === "restore") {
        await publish(h.dw, "publish before another credential acts");
        const result = await second.invoke(action, a);
        expectSuccess(result);
        expect(result.body).toMatchObject({ restored: true, alreadyLive: false, version: { id: h.target } });
        expect(await pointer(h)).toBe(h.target);
        expect(h.published.filter(event => event.kind === "restore")).toHaveLength(2);
      } else {
        expectFailure(await second.invoke(action, a), 404, "version_not_found");
      }
    } finally { await first.close(); await second.close(); }
  });

  it("does not turn an old slug into authority to replay against a replacement site", async () => {
    const h = await fixture();
    const t = await transport(h, surface);
    try {
      const a = input(h, action, "1", SLUG);
      expectSuccess(await t.invoke(action, a));
      const renamed = await h.dw.json(`/api/v1/sites/${SLUG}/rename`, {
        key: h.dw.ownerKey, ...jsonBody({ newSlug: "mutation-original-renamed" }),
      });
      expect(renamed.status).toBe(200);
      const retargeted = await h.dw.json(`/api/v1/sites/${OTHER}/rename`, {
        key: h.dw.ownerKey, ...jsonBody({ newSlug: SLUG }),
      });
      expect(retargeted.status).toBe(200);
      const before = await snapshot();
      const observed = observe(h);
      expectFailure(await t.invoke(action, a), 422, "idempotency_key_reused");
      observed.expectNoAction();
      expect.soft(await snapshot(), "neither original nor replacement may be changed").toEqual(before);
    } finally { await t.close(); }
  });
});

for (const surface of SURFACES) describe(`${surface} delete replay canonical confirmation`, () => {
  it.each(["wrong", "uppercase", "site id", "missing"])("runs %s confirmation validation before target lookup or cached result", async kind => {
    const h = await fixture();
    const t = await transport(h, surface);
    try {
      const a = input(h, "delete");
      expectSuccess(await t.invoke("delete", a));
      const before = await snapshot();
      const observed = observe(h);
      const confirm = kind === "wrong" ? "another-name" : kind === "uppercase" ? SLUG.toUpperCase() : kind === "site id" ? h.site.id : undefined;
      const r = await t.invoke("delete", { ...a, confirm });
      expect.soft(r.isError, JSON.stringify(r.body)).toBe(true);
      if (surface === "REST") expect.soft(r.status).toBe(400);
      // Missing MCP input is a schema refusal rather than a service ApiError.
      if (kind !== "missing") expect.soft(r.body.error?.code).toBe("confirm_mismatch");
      expect.soft(r.body).not.toHaveProperty("deleted");
      observed.expectNoAction();
      expect.soft(await snapshot()).toEqual(before);
    } finally { await t.close(); }
  });

  it("binds confirmation in the input hash while validating against the newly canonical slug", async () => {
    const h = await fixture();
    const t = await transport(h, surface);
    try {
      const a = input(h, "delete");
      expectSuccess(await t.invoke("delete", a));
      const renamed = await h.dw.json(`/api/v1/sites/${SLUG}/rename`, {
        key: h.dw.ownerKey, ...jsonBody({ newSlug: "mutation-new-canonical" }),
      });
      expect(renamed.status).toBe(200);
      const before = await snapshot();
      const observed = observe(h);
      expectFailure(await t.invoke("delete", a), 400, "confirm_mismatch");
      observed.expectNoAction();
      observed.clear();
      // This confirmation is now valid, but it is different submitted input.
      // A deleted target must not turn the key collision into a misleading 404.
      expectFailure(await t.invoke("delete", { ...a, confirm: "mutation-new-canonical" }), 422, "idempotency_key_reused");
      observed.expectNoAction();
      expect.soft(await snapshot()).toEqual(before);
    } finally { await t.close(); }
  });
});
