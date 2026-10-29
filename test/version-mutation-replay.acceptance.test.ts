import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { clearLiveMemoryCache } from "@dropway/core";
import { jsonBody } from "./helpers";
import {
  ACTIONS, OTHER, SLUG, SURFACES, claims, expectFailure, expectReplay, expectSuccess,
  fixture, input, observe, pointer, publish, snapshot, transport,
} from "./version-mutation-replay.helpers";

afterEach(() => { vi.restoreAllMocks(); clearLiveMemoryCache(); });

for (const surface of SURFACES) describe(`${surface} version-action result replay`, () => {
  it.each(["id", "1", "v1", "live"])("replays the original restore receipt for %s after publication and target deletion", async ref => {
    const h = await fixture();
    const t = await transport(h, surface);
    try {
      const a = input(h, "restore", ref === "id" ? h.target : ref);
      // The server committed and produced this receipt, but its delivery to the
      // caller was lost. Later state must not be used to manufacture a receipt.
      const first = await t.invoke("restore", a);
      expectSuccess(first);
      expect(first.body).toMatchObject({ restored: ref !== "live", alreadyLive: ref === "live",
        version: { id: ref === "live" ? h.live : h.target, live: true } });
      const winner = await publish(h.dw, "another actor publishes after the lost response");
      const removed = await h.dw.json(`/api/v1/sites/${SLUG}/versions/${first.body.version.id}`, {
        key: h.dw.ownerKey, method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: SLUG }),
      });
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      const before = await snapshot();
      const observed = observe(h);
      expectReplay(await t.invoke("restore", a), first);
      observed.expectNoAction();
      expect.soft(await pointer(h), "explicit replay cannot roll back another actor's publish").toBe(winner);
      expect.soft(await snapshot()).toEqual(before);
    } finally { await t.close(); }
  });

  it.each(["id", "1", "v1"])("replays a completed deletion addressed by %s after its row is gone", async ref => {
    const h = await fixture();
    const t = await transport(h, surface);
    try {
      const a = input(h, "delete", ref === "id" ? h.target : ref);
      const first = await t.invoke("delete", a);
      expectSuccess(first);
      expect(first.body).toMatchObject({ deleted: true, id: h.target });
      expect(await env.DB.prepare("SELECT id FROM versions WHERE id = ?").bind(h.target).first()).toBeNull();
      const before = await snapshot();
      const observed = observe(h);
      expectReplay(await t.invoke("delete", a), first);
      observed.expectNoAction();
      expect.soft(await snapshot()).toEqual(before);
    } finally { await t.close(); }
  });

  for (const action of ACTIONS) describe(action, () => {
    it("hashes the original submitted reference, not the resolved target", async () => {
      const h = await fixture();
      const t = await transport(h, surface);
      try {
        expectSuccess(await t.invoke(action, input(h, action)));
        const before = await snapshot();
        const observed = observe(h);
        // id and v1 refer to the same version on the first request; they are
        // nevertheless different submitted intent under a reused key.
        expectFailure(await t.invoke(action, input(h, action, "v1")), 422, "idempotency_key_reused");
        observed.expectNoAction();
        expect.soft(await snapshot()).toEqual(before);
      } finally { await t.close(); }
    });

    it("binds the key's input to the authorized immutable site, not just version number", async () => {
      const h = await fixture();
      const t = await transport(h, surface);
      try {
        expectSuccess(await t.invoke(action, input(h, action, "1")));
        const before = await snapshot();
        const observed = observe(h);
        const other = { site: h.other.id, version: "1", ...(action === "delete" ? { confirm: OTHER } : {}) };
        expectFailure(await t.invoke(action, other), 422, "idempotency_key_reused");
        observed.expectNoAction();
        expect.soft(await snapshot()).toEqual(before);
      } finally { await t.close(); }
    });

    it("keeps unkeyed calls compatible without promising replay", async () => {
      const h = await fixture();
      const t = await transport(h, surface);
      try {
        const a = input(h, action);
        expectSuccess(await t.invoke(action, a, null));
        if (action === "restore") {
          await publish(h.dw, "a new unkeyed restore is deliberate intent");
          const again = await t.invoke(action, a, null);
          expectSuccess(again);
          expect(again.body).toMatchObject({ restored: true, alreadyLive: false, version: { id: h.target } });
          expect(await pointer(h)).toBe(h.target);
        } else {
          expectFailure(await t.invoke(action, a, null), 404, "version_not_found");
        }
        expect(await claims()).toEqual([]);
      } finally { await t.close(); }
    });

    it.each(["has space", "non-ascii-é", "x".repeat(256)])("rejects an invalid key before any action (%s)", async key => {
      const h = await fixture();
      const t = await transport(h, surface);
      try {
        const before = await snapshot();
        const observed = observe(h);
        expectFailure(await t.invoke(action, input(h, action), key), 400, "invalid_idempotency_key");
        observed.expectNoAction();
        expect.soft(await snapshot()).toEqual(before);
        expect.soft(await claims()).toEqual([]);
      } finally { await t.close(); }
    });
  });

  it("uses independent restore and version-delete operation namespaces", async () => {
    const h = await fixture();
    const t = await transport(h, surface);
    try {
      expectSuccess(await t.invoke("restore", input(h, "restore")));
      const deleted = await t.invoke("delete", input(h, "delete", h.second));
      expectSuccess(deleted);
      expect(deleted.body).toMatchObject({ deleted: true, id: h.second });
      const before = await snapshot();
      const observed = observe(h);
      expectReplay(await t.invoke("delete", input(h, "delete", h.second)), deleted);
      observed.expectNoAction();
      expect.soft(await snapshot()).toEqual(before);
    } finally { await t.close(); }
  });

  it("restores by immutable site identity across rename without recomputing its stored receipt", async () => {
    const h = await fixture();
    const t = await transport(h, surface);
    try {
      const a = input(h, "restore");
      const first = await t.invoke("restore", a);
      expectSuccess(first);
      const renamed = await h.dw.json(`/api/v1/sites/${SLUG}/rename`, {
        key: h.dw.ownerKey, ...jsonBody({ newSlug: "mutation-renamed" }),
      });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      const winner = await publish(h.dw, "publish after rename", "mutation-renamed");
      const before = await snapshot();
      const observed = observe(h);
      expectReplay(await t.invoke("restore", a), first);
      observed.expectNoAction();
      expect.soft(await pointer(h)).toBe(winner);
      expect.soft(await snapshot()).toEqual(before);
    } finally { await t.close(); }
  });
});

for (const action of ACTIONS) it(`${action} cannot retrieve a REST result from the MCP namespace`, async () => {
  const h = await fixture();
  const rest = await transport(h, "REST");
  const mcp = await transport(h, "MCP");
  try {
    const a = input(h, action);
    expectSuccess(await rest.invoke(action, a));
    if (action === "restore") {
      await publish(h.dw, "intervening actor before cross-transport request");
      const fresh = await mcp.invoke(action, a);
      expectSuccess(fresh);
      expect(fresh.body).toMatchObject({ restored: true, alreadyLive: false, version: { id: h.target } });
      expect(await pointer(h)).toBe(h.target);
      expect(h.published.filter(event => event.kind === "restore")).toHaveLength(2);
    } else {
      expectFailure(await mcp.invoke(action, a), 404, "version_not_found");
    }
  } finally { await rest.close(); await mcp.close(); }
});
