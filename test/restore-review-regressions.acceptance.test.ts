import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  ApiError, clearLiveMemoryCache, defaultIdentity, deleteVersion, dropLive, getSiteFor, refreshLive, restoreVersion,
  type PublishEvent, type SiteRow, type UsageEvent, type VersionRow,
} from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";

/**
 * Protected independent regressions: fix the implementation, not these assertions.
 * Reads and writes use real disposable D1/R2/KV bindings. Interceptions only delay
 * delivery of real SELECT results; they do not fabricate rows or write outcomes.
 */
const SLUG = "restore-review";
const ANCHOR_TIME = 1_700_000_000_111;
const WINNER_TIME = 1_700_000_000_222;

afterEach(() => {
  vi.restoreAllMocks();
  clearLiveMemoryCache();
});

async function publish(dw: Instance, slug: string, content: string, status = 201) {
  const r = await dw.json("/api/v1/publish", {
    key: dw.ownerKey,
    ...jsonBody({ slug, files: [{ path: "index.html", content, contentType: "text/html" }] }),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(status);
}

async function fixture() {
  const published: PublishEvent[] = [];
  const metered: UsageEvent[] = [];
  const dw = await freshInstance({}, {
    hooks: [{ onPublish: (event) => { published.push(event); } }],
    adapters: { metering: { record: (event) => { metered.push(event); } } },
  });
  await publish(dw, SLUG, "<h1>Restore target</h1>");
  await publish(dw, SLUG, "<h1>Concurrent winner</h1>", 200);
  await publish(dw, SLUG, "<h1>Initial live</h1>", 200);
  const ctx = createExecutionContext();
  const dc = dw.dropway.context(env as unknown as ServerBindings, ctx);
  const principal = await defaultIdentity.resolve(new Request(`${ORIGIN}/api/v1/me`, {
    headers: { Authorization: `Bearer ${dw.ownerKey}` },
  }), dc);
  if (principal.kind !== "member") throw new Error("Fixture owner did not resolve.");
  const load = () => getSiteFor(dc, principal, SLUG, "sites:write");
  const site = await load();
  const versions = (await env.DB.prepare("SELECT * FROM versions WHERE site_id = ? ORDER BY number")
    .bind(site.id).all<VersionRow>()).results;
  expect(versions).toHaveLength(3);
  const [target, winner, live] = versions;
  if (!target || !winner || !live) throw new Error("Fixture needs three ready versions.");
  await env.DB.prepare("UPDATE sites SET updated_at = ? WHERE id = ?").bind(ANCHOR_TIME, site.id).run();
  await refreshLive(dc, site.id);
  await waitOnExecutionContext(ctx);
  published.length = 0;
  metered.length = 0;
  return { dw, dc, principal, site: await load(), target, winner, live, published, metered, load,
    flush: () => waitOnExecutionContext(ctx) };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

async function snapshot(siteId: string, slug = SLUG) {
  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first<SiteRow>();
  const versions = (await env.DB.prepare("SELECT * FROM versions WHERE site_id = ? ORDER BY number")
    .bind(siteId).all()).results;
  const files = (await env.DB.prepare(`SELECT vf.* FROM version_files vf JOIN versions v ON v.id = vf.version_id
    WHERE v.site_id = ? ORDER BY vf.version_id, vf.path`).bind(siteId).all()).results;
  return { site, versions, files, cache: await env.CACHE.get(`live:${slug}`) };
}

function observe(h: Harness) {
  h.published.length = 0;
  h.metered.length = 0;
  const put = vi.spyOn(env.CACHE, "put");
  const remove = vi.spyOn(env.CACHE, "delete");
  const r2put = vi.spyOn(env.FILES, "put");
  const r2delete = vi.spyOn(env.FILES, "delete");
  return {
    clear() {
      put.mockClear();
      remove.mockClear();
      r2put.mockClear();
      r2delete.mockClear();
      h.published.length = 0;
      h.metered.length = 0;
    },
    expectNoEffects() {
      expect.soft(put, "restore must not refresh live KV").not.toHaveBeenCalled();
      expect.soft(remove, "restore must not invalidate live KV").not.toHaveBeenCalled();
      expect.soft(r2put).not.toHaveBeenCalled();
      expect.soft(r2delete).not.toHaveBeenCalled();
      expect.soft(h.published, "restore must not emit a publish event").toEqual([]);
      expect.soft(h.metered).toEqual([]);
    },
  };
}

/** Run a competitor after one real matching read, before its caller receives the row. */
function afterRead(
  table: "sites" | "versions",
  matches: (values: unknown[]) => boolean,
  expectedRow: Record<string, unknown>,
  compete: () => Promise<void>,
  mutations?: string[],
) {
  const prepare = env.DB.prepare.bind(env.DB);
  let pauses = 0;
  vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    if (/^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql)) mutations?.push(sql);
    const statement = prepare(sql);
    if (!new RegExp(`^\\s*SELECT\\b[\\s\\S]*\\bFROM\\s+${table}\\b`, "i").test(sql)) return statement;
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...values) => {
      const bound = bind(...values);
      if (!matches(values)) return bound;
      const first = bound.first.bind(bound);
      vi.spyOn(bound, "first").mockImplementation(async (columnName?: string) => {
        const row = await Reflect.apply(first, bound, columnName === undefined ? [] : [columnName]);
        if (pauses === 0) {
          pauses++;
          expect(row, "interleaving must start from a real expected row").toMatchObject(expectedRow);
          await compete();
        }
        return row;
      });
      return bound;
    });
    return statement;
  });
  return () => expect(pauses, "the deterministic interleaving must execute once").toBe(1);
}

function afterTargetRead(h: Harness, compete: () => Promise<void>) {
  return afterRead("versions", (values) => values.includes(h.target.id) && values.includes(h.site.id),
    { id: h.target.id, site_id: h.site.id, status: "ready" }, compete);
}

async function moveLive(h: Harness, versionId: string) {
  await env.DB.prepare("UPDATE sites SET current_version_id = ?, updated_at = ? WHERE id = ?")
    .bind(versionId, WINNER_TIME, h.site.id).run();
  await refreshLive(h.dc, h.site.id);
  await h.flush();
}

async function outcome<T>(promise: Promise<T>) {
  try { return { ok: true as const, value: await promise }; }
  catch (error: unknown) { return { ok: false as const, error }; }
}

function expectError(result: Awaited<ReturnType<typeof outcome>>, status: number, code: string) {
  expect.soft(result).toMatchObject({ ok: false, error: { status, code } });
  expect.soft(result.ok ? undefined : result.error).toBeInstanceOf(ApiError);
}

async function restoreThrough(h: Harness, surface: "REST" | "MCP", ref: string) {
  if (surface === "REST") {
    return async () => {
      const r = await h.dw.json(`/api/v1/sites/${SLUG}/versions/${encodeURIComponent(ref)}/restore`, {
        method: "POST", key: h.dw.ownerKey,
      });
      expect.soft(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    };
  }
  const mcp = await connectMcp(h.dw, h.dw.ownerKey);
  return async () => {
    try {
      const r = await mcp.call("restore_version", { site: SLUG, version: ref });
      expect.soft(r.isError, r.text).toBe(false);
      return r.data;
    } finally {
      await mcp.client.close();
    }
  };
}

describe("restore review regressions: contract A", () => {
  it("refuses even a concurrent move to the requested target with 409 and no retry or effects", async () => {
    const h = await fixture();
    const effects = observe(h);
    let expected: Awaited<ReturnType<typeof snapshot>> | undefined;
    const interleaved = afterTargetRead(h, async () => {
      await moveLive(h, h.target.id);
      expected = await snapshot(h.site.id);
      effects.clear();
    });
    const batch = vi.spyOn(env.DB, "batch");
    const result = await outcome(restoreVersion(h.dc, h.principal, h.site, h.target.id));
    await h.flush();
    interleaved();
    expectError(result, 409, "version_conflict");
    expect.soft(batch, "one fenced attempt, never retry the overlap as an already-live success").toHaveBeenCalledTimes(1);
    expect.soft(await snapshot(h.site.id)).toEqual(expected);
    effects.expectNoEffects();
  });

  it("keeps entry already-live success write-free", async () => {
    const h = await fixture();
    const before = await snapshot(h.site.id);
    const effects = observe(h);
    const batch = vi.spyOn(env.DB, "batch");
    const prepare = env.DB.prepare.bind(env.DB);
    const mutations: string[] = [];
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (/^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql)) mutations.push(sql);
      return prepare(sql);
    });
    const result = await restoreVersion(h.dc, h.principal, h.site, h.live.id);
    await h.flush();
    expect(result).toMatchObject({ restored: false, alreadyLive: true, version: { id: h.live.id, live: true } });
    expect(await snapshot(h.site.id)).toEqual(before);
    expect(mutations).toEqual([]);
    expect(batch).not.toHaveBeenCalled();
    effects.expectNoEffects();
  });
});

describe("restore review regressions: symbolic versus explicit intent", () => {
  it.each(["REST", "MCP"] as const)("%s symbolic live observes live-at-execution without rolling back a stale snapshot", async (surface) => {
    const h = await fixture();
    const invoke = await restoreThrough(h, surface, "live");
    const effects = observe(h);
    let expected: Awaited<ReturnType<typeof snapshot>> | undefined;
    const interleaved = afterRead("sites", (values) => values.includes(SLUG),
      { id: h.site.id, current_version_id: h.live.id }, async () => {
        await moveLive(h, h.winner.id);
        expected = await snapshot(h.site.id);
        effects.clear();
      });
    const result = await invoke();
    await h.flush();
    interleaved();
    expect.soft(result).toMatchObject({ restored: false, alreadyLive: true, version: { id: h.winner.id, live: true } });
    expect.soft(await snapshot(h.site.id), "symbolic live must preserve the winner, timestamp, files and cache").toEqual(expected);
    effects.expectNoEffects();
  });

  it.each(["REST", "MCP"] as const)("%s symbolic live succeeds write-free after the stale live version is deleted", async (surface) => {
    const h = await fixture();
    const invoke = await restoreThrough(h, surface, "live");
    const effects = observe(h);
    const mutations: string[] = [];
    const batch = vi.spyOn(env.DB, "batch");
    let expected: Awaited<ReturnType<typeof snapshot>> | undefined;
    const interleaved = afterRead("sites", (values) => values.includes(SLUG),
      { id: h.site.id, current_version_id: h.live.id }, async () => {
        await moveLive(h, h.winner.id);
        expect(await deleteVersion(h.dc, h.principal, h.site, h.live.id)).toEqual({ deleted: true, id: h.live.id });
        await h.flush();
        expected = await snapshot(h.site.id);
        expect(expected.site).toMatchObject({ current_version_id: h.winner.id, updated_at: WINNER_TIME });
        expect(expected.versions).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: h.live.id })]));
        expect(expected.files).not.toEqual(expect.arrayContaining([expect.objectContaining({ version_id: h.live.id })]));
        effects.clear();
        mutations.length = 0;
        batch.mockClear();
      }, mutations);
    const result = await invoke();
    await h.flush();
    interleaved();
    expect.soft(result).toMatchObject({ restored: false, alreadyLive: true, version: { id: h.winner.id, live: true } });
    expect.soft(await snapshot(h.site.id), "restore must preserve the winner and the completed non-live deletion").toEqual(expected);
    expect.soft(mutations, "symbolic live must not prepare any mutation after the competitor completes").toEqual([]);
    expect.soft(batch, "symbolic live must not attempt a restore batch").not.toHaveBeenCalled();
    effects.expectNoEffects();
  });

  it.each(["REST", "MCP"] as const)("%s explicit ID retains restore intent even when the caller snapshot says it is live", async (surface) => {
    const h = await fixture();
    const invoke = await restoreThrough(h, surface, h.live.id);
    const interleaved = afterRead("sites", (values) => values.includes(SLUG),
      { id: h.site.id, current_version_id: h.live.id }, () => moveLive(h, h.winner.id));
    const result = await invoke();
    await h.flush();
    interleaved();
    expect(result).toMatchObject({ restored: true, alreadyLive: false, version: { id: h.live.id, live: true } });
    expect((await snapshot(h.site.id)).site).toMatchObject({ current_version_id: h.live.id });
    expect(h.published).toHaveLength(1);
    expect(h.published[0]).toMatchObject({ kind: "restore", site: { id: h.site.id }, version: { id: h.live.id } });
  });
});

describe("restore review regressions: diagnostics", () => {
  it("reports original-site absence after a failed fence, not replacement-site conflict metadata", async () => {
    const h = await fixture();
    const otherSlug = "restore-replacement";
    await publish(h.dw, otherSlug, "<h1>Unrelated replacement</h1>");
    const replacement = await getSiteFor(h.dc, h.principal, otherSlug, "sites:write");
    expect(replacement.id).not.toBe(h.site.id);
    expect(replacement.tenant_id).toBe(h.site.tenant_id);
    const effects = observe(h);
    let originalAfter: Awaited<ReturnType<typeof snapshot>> | undefined;
    let replacementAfter: Awaited<ReturnType<typeof snapshot>> | undefined;
    const interleaved = afterTargetRead(h, async () => {
      // Preserve original version rows so the refusal cannot be explained by a missing target.
      await env.DB.batch([
        env.DB.prepare("UPDATE sites SET slug = ?, deleted_at = ?, updated_at = ? WHERE id = ?")
          .bind("restore-retired", WINNER_TIME, WINNER_TIME, h.site.id),
        env.DB.prepare("UPDATE sites SET slug = ?, updated_at = ? WHERE id = ?")
          .bind(SLUG, WINNER_TIME, replacement.id),
      ]);
      await dropLive(h.dc, SLUG);
      await dropLive(h.dc, otherSlug);
      await refreshLive(h.dc, replacement.id);
      await h.flush();
      expect(await h.load()).toMatchObject({ id: replacement.id, current_version_id: replacement.current_version_id });
      originalAfter = await snapshot(h.site.id, "restore-retired");
      replacementAfter = await snapshot(replacement.id);
      effects.clear();
    });
    const result = await outcome(restoreVersion(h.dc, h.principal, h.site, h.target.id));
    await h.flush();
    interleaved();
    expectError(result, 404, "site_not_found");
    if (!result.ok && result.error instanceof ApiError) {
      expect.soft(result.error.details, "must not disclose the replacement site's live-version metadata").not.toHaveProperty("liveVersionId");
    }
    expect.soft(await snapshot(h.site.id, "restore-retired")).toEqual(originalAfter);
    expect.soft(await snapshot(replacement.id), "restore must never write the replacement site").toEqual(replacementAfter);
    expect.soft(await env.CACHE.get(`live:${otherSlug}`)).toBeNull();
    effects.expectNoEffects();
  });

  it("reports the addressed slug as absent when the original site is renamed but not deleted", async () => {
    const h = await fixture();
    const renamedSlug = "restore-renamed";
    const effects = observe(h);
    let expected: Awaited<ReturnType<typeof snapshot>> | undefined;
    const interleaved = afterTargetRead(h, async () => {
      // Keep the identity, tenant and ready target; only the name and live anchor move.
      await env.DB.prepare("UPDATE sites SET slug = ?, current_version_id = ?, updated_at = ? WHERE id = ?")
        .bind(renamedSlug, h.winner.id, WINNER_TIME, h.site.id).run();
      await dropLive(h.dc, SLUG);
      await refreshLive(h.dc, h.site.id);
      await h.flush();
      expected = await snapshot(h.site.id, renamedSlug);
      expect(expected.site).toMatchObject({ id: h.site.id, slug: renamedSlug, tenant_id: h.site.tenant_id,
        deleted_at: null, current_version_id: h.winner.id, updated_at: WINNER_TIME });
      expect(expected.versions).toContainEqual(expect.objectContaining({ id: h.target.id, site_id: h.site.id, status: "ready" }));
      expect(await env.CACHE.get(`live:${SLUG}`)).toBeNull();
      effects.clear();
    });
    const batch = vi.spyOn(env.DB, "batch");
    const result = await outcome(restoreVersion(h.dc, h.principal, h.site, h.target.id));
    await h.flush();
    interleaved();
    expectError(result, 404, "site_not_found");
    if (!result.ok && result.error instanceof ApiError) {
      expect.soft(result.error.message).toBe(`No site "${SLUG}" that this key can access.`);
      expect.soft(result.error.details).toEqual({ slug: SLUG });
    }
    expect(batch, "the moved live anchor must make the single restore attempt lose its fence").toHaveBeenCalledTimes(1);
    expect(await batch.mock.results[0]!.value).toMatchObject([{ meta: { changes: 0 } }]);
    expect.soft(await snapshot(h.site.id, renamedSlug)).toEqual(expected);
    expect.soft(await env.CACHE.get(`live:${SLUG}`)).toBeNull();
    effects.expectNoEffects();
  });

  it("gives restore-specific conflict guidance without publish-only baseVersionId or automatic retry", async () => {
    const h = await fixture();
    const effects = observe(h);
    let expected: Awaited<ReturnType<typeof snapshot>> | undefined;
    const interleaved = afterTargetRead(h, async () => {
      await moveLive(h, h.winner.id);
      expected = await snapshot(h.site.id);
      effects.clear();
    });
    const result = await outcome(restoreVersion(h.dc, h.principal, h.site, h.target.id));
    await h.flush();
    interleaved();
    expectError(result, 409, "version_conflict");
    if (!result.ok && result.error instanceof ApiError) {
      const hint = result.error.hint ?? "";
      expect.soft(hint, "inspect current state before deciding").toMatch(/get_site|inspect|read|check/i);
      expect.soft(hint, "new intentional restore invocation, not publish re-application").toMatch(/restore/i);
      expect.soft(hint, "require a fresh deliberate invocation").toMatch(/fresh|intentional|deliberate|explicit|decid|again/i);
      expect.soft(hint, "do not automatically retry the failed restore").toMatch(/(?:no|not|never|avoid)[^.]*automat|automat[^.]*(?:disabled|forbidden|not|never)/i);
      expect.soft(hint).not.toMatch(/baseVersionId/i);
    }
    expect.soft(await snapshot(h.site.id)).toEqual(expected);
    effects.expectNoEffects();
  });
});
