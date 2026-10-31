import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  ApiError, clearLiveMemoryCache, defaultIdentity, getSiteFor, refreshLive, restoreVersion,
  type PublishEvent, type SiteRow, type UsageEvent, type VersionRow,
} from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { form, freshInstance, jsonBody, ORIGIN } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import { effectSpies, interleave, isMutation, worldState } from "./interleave-harness";

/**
 * Independent regressions for the restore conflict diagnostic: fix the
 * implementation, not these assertions.
 *
 * The failed-fence diagnostic reads the original site row, then the target, then
 * the live-version metadata. Each read must stay bound to the ownership snapshot
 * the request was authorized against. A real owner who claims an anonymous site
 * after the original-row check, and publishes a new live version, must never have
 * that version's identity, number, client or time returned to the obsolete claim
 * principal. All competitors use real services (claim, publish) and real D1/R2/KV.
 */
const WINNER_TIME = 1_700_000_000_222;
const WINNER_CLIENT = "winner-client/2.0";
const OWNER_CLIENT = "new-owner-live-client/9.9";
const MEMBER_SLUG = "restore-diagnostics";

afterEach(() => {
  vi.restoreAllMocks();
  clearLiveMemoryCache();
});

type Kind = "member" | "claim";
type Surface = "service" | "REST" | "MCP";

async function fixture(kind: Kind) {
  const published: PublishEvent[] = [];
  const metered: UsageEvent[] = [];
  const dw = await freshInstance(kind === "claim" ? { anonymous: { enabled: true } } : {}, {
    hooks: [{ onPublish: (event) => { published.push(event); } }],
    adapters: { metering: { record: (event) => { metered.push(event); } } },
  });
  let slug = MEMBER_SLUG;
  let claimToken = "";
  const publish = async (label: string, client: string | null, status: number) => {
    const headers: Record<string, string> = client ? { "X-Kofra-Client": client } : {};
    if (kind === "member") {
      const r = await dw.json("/api/v1/publish", {
        method: "POST", key: dw.ownerKey, headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ slug, files: [{ path: "index.html", content: `<h1>${label}</h1>`, contentType: "text/html" }] }),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(status);
      return;
    }
    const r = await dw.json("/api/v1/publish", {
      method: "POST", key: claimToken || null, headers, body: form({ "index.html": `<h1>${label}</h1>` }),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    if (!claimToken) {
      slug = r.body.slug;
      claimToken = r.body.claimToken;
      expect(claimToken).toMatch(/^dwc_/);
    }
  };
  await publish("Restore target", null, 201);
  await publish("Concurrent winner", WINNER_CLIENT, 200);
  await publish("Initial live", null, 200);
  const bearer = kind === "member" ? dw.ownerKey : claimToken;
  const ctx = createExecutionContext();
  const dc = dw.dropway.context(env as unknown as ServerBindings, ctx);
  const principal = await defaultIdentity.resolve(new Request(`${ORIGIN}/api/v1/me`, {
    headers: { Authorization: `Bearer ${bearer}` },
  }), dc);
  expect(principal.kind).toBe(kind);
  const site = await getSiteFor(dc, principal, slug, "sites:write");
  expect(site.tenant_id === null, "claim fixtures are anonymous, member fixtures are owned").toBe(kind === "claim");
  const versions = (await env.DB.prepare("SELECT * FROM versions WHERE site_id = ? ORDER BY number")
    .bind(site.id).all<VersionRow>()).results;
  expect(versions).toHaveLength(3);
  const [target, winner, live] = versions;
  if (!target || !winner || !live) throw new Error("Fixture needs three ready versions.");
  expect(winner.client).toBe(WINNER_CLIENT);
  expect(site.current_version_id).toBe(live.id);
  await waitOnExecutionContext(ctx);
  published.length = 0;
  metered.length = 0;
  return {
    kind, dw, dc, principal, site, slug, claimToken, bearer, target, winner, live, published, metered,
    flush: () => waitOnExecutionContext(ctx),
  };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

function observe(h: Harness) {
  return effectSpies(() => { h.published.length = 0; h.metered.length = 0; }, () => [h.published, h.metered]);
}

async function moveLive(h: Harness, versionId: string) {
  await env.DB.prepare("UPDATE sites SET current_version_id = ?, updated_at = ? WHERE id = ?")
    .bind(versionId, WINNER_TIME, h.site.id).run();
  await refreshLive(h.dc, h.site.id);
  await h.flush();
}

/** A real owner claims the anonymous site, then publishes a new ready live version. */
async function claimAndPublish(h: Harness) {
  const claim = await h.dw.json(`/api/v1/sites/${h.slug}/claim`, {
    key: h.dw.ownerKey, ...jsonBody({ claimToken: h.claimToken }),
  });
  expect(claim.status, JSON.stringify(claim.body)).toBe(200);
  const pub = await h.dw.json("/api/v1/publish", {
    method: "POST", key: h.dw.ownerKey,
    headers: { "Content-Type": "application/json", "X-Kofra-Client": OWNER_CLIENT },
    body: JSON.stringify({ slug: h.slug, files: [{ path: "index.html", content: "<h1>New owner live</h1>", contentType: "text/html" }] }),
  });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  await h.flush();
  const owned = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(h.site.id).first<SiteRow>();
  expect(owned?.tenant_id, "the real owner's tenant now holds the site").not.toBeNull();
  expect(owned?.deleted_at).toBeNull();
  const live = await env.DB.prepare("SELECT * FROM versions WHERE id = ?").bind(owned!.current_version_id).first<VersionRow>();
  expect(live).toMatchObject({ status: "ready", client: OWNER_CLIENT });
  expect(live!.id).not.toBe(h.winner.id);
  expect(live!.id).not.toBe(h.target.id);
  return live!;
}

interface Outcome {
  status: number | undefined;
  isError: boolean;
  error: { code?: string; message?: string; hint?: string; details?: Record<string, any> } | undefined;
  body: any;
  /** Everything the caller can read, structured and textual. */
  wire: string;
}

/** Prepare one restore invocation; returns the function that performs it. */
async function restoreInvoker(h: Harness, surface: Surface, ref: string): Promise<() => Promise<Outcome>> {
  if (surface === "service") {
    return async () => {
      try {
        const value = await restoreVersion(h.dc, h.principal, h.site, ref);
        return { status: 200, isError: false, error: undefined, body: value, wire: JSON.stringify(value) };
      } catch (error: unknown) {
        if (!(error instanceof ApiError)) throw error;
        const body = error.toJSON();
        return { status: error.status, isError: true, error: body.error, body, wire: JSON.stringify(body) };
      }
    };
  }
  if (surface === "REST") {
    return async () => {
      const r = await h.dw.json(`/api/v1/sites/${h.slug}/versions/${encodeURIComponent(ref)}/restore`, {
        method: "POST", key: h.bearer,
      });
      return { status: r.status, isError: r.status >= 400, error: r.body?.error, body: r.body, wire: JSON.stringify(r.body) };
    };
  }
  const mcp = await connectMcp(h.dw, h.bearer);
  return async () => {
    try {
      const r = await mcp.call("restore_version", { site: h.slug, version: ref });
      return { status: undefined, isError: r.isError, error: r.data?.error, body: r.data, wire: r.text + JSON.stringify(r.data) };
    } finally {
      await mcp.client.close();
    }
  };
}

/** The joined live-version metadata read that `versionConflict` performs after the fence failed. */
const diagnosticRead = (h: Harness) => (sql: string, values: unknown[]) =>
  /\bcurrent_version_id\b/i.test(sql) && /\bJOIN\b/i.test(sql) && values.includes(h.site.id);

describe("restore conflict diagnostics stay bound to the ownership snapshot", () => {
  it.each(["service", "REST", "MCP"] as const)(
    "%s: a claim principal gets site_not_found, never the new owner's live metadata, when the site is claimed and republished before the diagnostic query",
    async (surface) => {
      const h = await fixture("claim");
      const invoke = await restoreInvoker(h, surface, h.target.id);
      const effects = observe(h);
      let expected: Awaited<ReturnType<typeof worldState>> | undefined;
      let newLive: VersionRow | undefined;
      const ctl = interleave({
        // Real value-fence loss: live moves from the initial version to the winner.
        beforeBatch: () => moveLive(h, h.winner.id),
        // The ownership change lands after the original-row check, before the metadata query.
        beforeSelect: {
          matches: diagnosticRead(h),
          compete: async () => {
            newLive = await claimAndPublish(h);
            expected = await worldState([h.slug]);
            effects.clear();
            vi.mocked(env.DB.batch).mockClear();
            ctl.forget();
          },
        },
      });
      const result = await invoke();
      await h.flush();
      ctl.done();
      const wire = result.wire;
      expect.soft(result.isError, wire).toBe(true);
      if (surface !== "MCP") expect.soft(result.status, wire).toBe(404);
      expect.soft(result.error, wire).toMatchObject({
        code: "site_not_found", message: `No site "${h.slug}" that this key can access.`,
      });
      expect.soft(result.body, "no restore or already-live success shape").not.toHaveProperty("restored");
      expect.soft(result.body).not.toHaveProperty("alreadyLive");
      for (const key of ["liveVersionId", "liveVersionNumber", "liveVersionClient", "liveVersionAt", "yourBase", "liveClient"]) {
        expect.soft(result.error?.details ?? {}, `${key} would disclose the new owner's publication`).not.toHaveProperty(key);
      }
      expect.soft(wire, "the new owner's version id must not reach the obsolete claim principal").not.toContain(newLive!.id);
      expect.soft(wire, "the new owner's client attribution must not leak").not.toContain(OWNER_CLIENT);
      expect.soft(wire, "no conflict wording that names a live version").not.toMatch(/live version is v\d/i);
      expect.soft(ctl.statements.filter(isMutation), "the refused request prepares no mutation").toEqual([]);
      expect.soft(vi.mocked(env.DB.batch).mock.calls.length, "no second fenced write and no automatic retry").toBe(0);
      expect.soft(await worldState([h.slug]), "the refusal preserves the complete post-competitor state").toEqual(expected);
      effects.expectNoEffects();
    },
  );
});

describe("restore conflict controls: same-owner metadata and NULL ownership are retained", () => {
  describe.each(["member", "claim"] as const)("%s principal", (kind) => {
    it.each(["service", "REST", "MCP"] as const)("%s: a real live-pointer conflict still reports 409 with the live version's metadata", async (surface) => {
      const h = await fixture(kind);
      const invoke = await restoreInvoker(h, surface, h.target.id);
      const effects = observe(h);
      let expected: Awaited<ReturnType<typeof worldState>> | undefined;
      const ctl = interleave({
        beforeBatch: async () => {
          await moveLive(h, h.winner.id);
          expected = await worldState([h.slug]);
          effects.clear();
          ctl.forget();
        },
      });
      const result = await invoke();
      await h.flush();
      ctl.done();
      expect.soft(result.isError, result.wire).toBe(true);
      if (surface !== "MCP") expect.soft(result.status, result.wire).toBe(409);
      expect.soft(result.error, result.wire).toMatchObject({ code: "version_conflict" });
      expect.soft(result.error?.message).toContain(`v${h.winner.number}`);
      expect.soft(result.error?.details, "the unchanged owner may see the live publication it lost to").toMatchObject({
        liveVersionId: h.winner.id,
        liveVersionNumber: h.winner.number,
        liveVersionClient: WINNER_CLIENT,
        liveVersionAt: h.winner.finalized_at,
      });
      expect.soft(result.body, "a lost fence is never an already-live success").not.toHaveProperty("alreadyLive");
      expect.soft(ctl.statements.filter(isMutation), "no retry and no further write").toEqual([]);
      expect.soft(await worldState([h.slug])).toEqual(expected);
      effects.expectNoEffects();
    });
  });

  it("a concurrent move to the requested target on an anonymous (NULL tenant) site is still a 409, not an already-live success", async () => {
    const h = await fixture("claim");
    const invoke = await restoreInvoker(h, "service", h.target.id);
    const effects = observe(h);
    let expected: Awaited<ReturnType<typeof worldState>> | undefined;
    const ctl = interleave({
      beforeBatch: async () => {
        await moveLive(h, h.target.id);
        expected = await worldState([h.slug]);
        effects.clear();
        ctl.forget();
      },
    });
    const result = await invoke();
    await h.flush();
    ctl.done();
    expect.soft(result.status, result.wire).toBe(409);
    expect.soft(result.error, result.wire).toMatchObject({ code: "version_conflict" });
    expect.soft(result.error?.details).toMatchObject({ liveVersionId: h.target.id, liveVersionNumber: h.target.number });
    expect.soft(result.body).not.toHaveProperty("alreadyLive");
    expect.soft(ctl.statements.filter(isMutation)).toEqual([]);
    expect.soft(await worldState([h.slug])).toEqual(expected);
    effects.expectNoEffects();
  });
});
