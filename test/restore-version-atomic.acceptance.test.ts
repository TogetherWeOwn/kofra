import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  ApiError, clearLiveMemoryCache, defaultIdentity, dropLive, getSiteFor, refreshLive, restoreVersion,
  type PublishEvent, type SiteRow, type UsageEvent, type VersionRow,
} from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";

/**
 * Protected independent acceptance tests. Fix the service, not these assertions.
 * All SQL and storage operations use disposable workerd bindings. The interception
 * only delays delivery of a real target SELECT result; it never fabricates rows,
 * change counts, errors or successful writes, and adds no production test hook.
 */
const SLUG = "restore-atomic";
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
  await publish(dw, SLUG, "<h1>Old ready target</h1>");
  await publish(dw, SLUG, "<h1>Concurrent winner</h1>", 200);
  await publish(dw, SLUG, "<h1>Expected live</h1>", 200);
  const ctx = createExecutionContext();
  const dc = dw.dropway.context(env as unknown as ServerBindings, ctx);
  const principal = await defaultIdentity.resolve(new Request(`${ORIGIN}/api/v1/me`, {
    headers: { Authorization: `Bearer ${dw.ownerKey}` },
  }), dc);
  if (principal.kind !== "member") throw new Error("Fixture owner did not resolve.");
  const site = await getSiteFor(dc, principal, SLUG, "sites:write");
  const versions = (await env.DB.prepare("SELECT * FROM versions WHERE site_id = ? ORDER BY number")
    .bind(site.id).all<VersionRow>()).results;
  expect(versions).toHaveLength(3);
  const [target, winner, live] = versions;
  if (!target || !winner || !live) throw new Error("Fixture needs three ready versions.");
  await env.DB.prepare("UPDATE sites SET updated_at = ? WHERE id = ?").bind(ANCHOR_TIME, site.id).run();
  const load = () => getSiteFor(dc, principal, SLUG, "sites:write");
  const flush = () => waitOnExecutionContext(ctx);
  await refreshLive(dc, site.id);
  await flush();
  published.length = 0;
  metered.length = 0;
  return { dw, dc, principal, site: await load(), target, winner, live, published, metered, load, flush };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

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
      expect.soft(put, "loser must not refresh live KV").not.toHaveBeenCalled();
      expect.soft(remove, "loser must not invalidate live KV").not.toHaveBeenCalled();
      expect.soft(r2put).not.toHaveBeenCalled();
      expect.soft(r2delete).not.toHaveBeenCalled();
      expect.soft(h.published, "loser must not emit onPublish/restore").toEqual([]);
      expect.soft(h.metered).toEqual([]);
    },
    put,
  };
}

async function snapshot(siteId: string) {
  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first<SiteRow>();
  const versions = (await env.DB.prepare("SELECT * FROM versions WHERE site_id = ? ORDER BY number")
    .bind(siteId).all()).results;
  const files = (await env.DB.prepare(`SELECT vf.* FROM version_files vf JOIN versions v ON v.id = vf.version_id
    WHERE v.site_id = ? ORDER BY vf.version_id, vf.path`).bind(siteId).all()).results;
  return { site, versions, files, cache: await env.CACHE.get(`live:${SLUG}`) };
}

async function outcome<T>(promise: Promise<T>) {
  try { return { ok: true as const, value: await promise }; }
  catch (error: unknown) { return { ok: false as const, error }; }
}

function expectError(result: Awaited<ReturnType<typeof outcome>>, status: number, code: string) {
  expect.soft(result, "must refuse instead of reporting a successful restore").toMatchObject({ ok: false, error: { status, code } });
  expect.soft(result.ok ? undefined : result.error, "must be a clean API error, not a D1 exception").toBeInstanceOf(ApiError);
  if (!result.ok && result.error instanceof ApiError) expect.soft(result.error.hint).toEqual(expect.any(String));
}

/** Pause AFTER reading the target but BEFORE the service receives that snapshot. */
function afterTargetLookup(h: Harness, compete: () => Promise<void>) {
  const prepare = env.DB.prepare.bind(env.DB);
  let calls = 0;
  vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!/^\s*SELECT\b[\s\S]*\bFROM\s+versions\b/i.test(sql)) return statement;
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...values) => {
      const bound = bind(...values);
      if (!values.includes(h.target.id) || !values.includes(h.site.id)) return bound;
      const first = bound.first.bind(bound);
      vi.spyOn(bound, "first").mockImplementation(async (columnName?: string) => {
        const row = await Reflect.apply(first, bound, columnName === undefined ? [] : [columnName]);
        if (calls === 0) {
          calls++;
          expect(row, "the interrupted read must contain the real ready target").toMatchObject({ id: h.target.id, status: "ready" });
          await compete();
        }
        return row;
      });
      return bound;
    });
    return statement;
  });
  return () => expect(calls, "the deterministic after-target-read interleaving must execute once").toBe(1);
}

async function race(
  h: Harness,
  compete: () => Promise<void>,
  status: number,
  code: string,
) {
  const effects = observe(h);
  let expected: Awaited<ReturnType<typeof snapshot>> | undefined;
  const assertInterleaving = afterTargetLookup(h, async () => {
    await compete();
    // Competitor effects are complete before observing the resumed loser.
    await h.flush();
    expected = await snapshot(h.site.id);
    effects.clear();
  });
  const result = await outcome(restoreVersion(h.dc, h.principal, h.site, h.target.id));
  await h.flush();
  assertInterleaving();
  expectError(result, status, code);
  expect.soft(await snapshot(h.site.id), "loser cannot alter the winner's pointer/timestamp, versions, files or cache").toEqual(expected);
  effects.expectNoEffects();
}

describe("atomic restore: preserved behavior", () => {
  it("restores a ready historical version without copying files and emits exactly one restore", async () => {
    const h = await fixture();
    const before = await snapshot(h.site.id);
    const effects = observe(h);
    const result = await restoreVersion(h.dc, h.principal, h.site, h.target.id);
    await h.flush();
    expect(result).toMatchObject({ restored: true, alreadyLive: false, version: { id: h.target.id, number: 1, status: "ready", live: true } });
    const after = await snapshot(h.site.id);
    expect(after.site).toMatchObject({ current_version_id: h.target.id });
    expect(after.site!.updated_at).toBeGreaterThan(ANCHOR_TIME);
    expect(after.versions).toEqual(before.versions);
    expect(after.files).toEqual(before.files);
    expect(JSON.parse(after.cache!)).toMatchObject({ versionId: h.target.id, tenantId: h.site.tenant_id });
    expect(effects.put).toHaveBeenCalledTimes(1);
    expect(h.published).toHaveLength(1);
    expect(h.published[0]).toMatchObject({ kind: "restore", site: { id: h.site.id }, version: { id: h.target.id, number: 1 }, principal: h.principal });
    expect(vi.mocked(env.FILES.put)).not.toHaveBeenCalled();
    expect(vi.mocked(env.FILES.delete)).not.toHaveBeenCalled();
  });

  it("keeps an already-live restore write-free, including timestamp, cache and events", async () => {
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

  it("accepts an exact NULL expected-live pointer when no competitor moved it", async () => {
    const h = await fixture();
    await env.DB.prepare("UPDATE sites SET current_version_id = NULL WHERE id = ?").bind(h.site.id).run();
    h.site = await h.load();
    expect(h.site.current_version_id).toBeNull();
    const result = await restoreVersion(h.dc, h.principal, h.site, h.target.id);
    await h.flush();
    expect(result).toMatchObject({ restored: true, alreadyLive: false, version: { id: h.target.id } });
    expect((await snapshot(h.site.id)).site!.current_version_id).toBe(h.target.id);
  });

  it("loads a fresh service anchor instead of rejecting a pre-entry live move as a conflict", async () => {
    const h = await fixture();
    await env.DB.prepare("UPDATE sites SET current_version_id = ?, updated_at = ? WHERE id = ?")
      .bind(h.winner.id, WINNER_TIME, h.site.id).run();
    await refreshLive(h.dc, h.site.id);
    // The caller's row is legitimately stale before service entry, not during its CAS.
    expect(h.site.current_version_id).toBe(h.live.id);
    const result = await restoreVersion(h.dc, h.principal, h.site, h.target.id);
    await h.flush();
    expect(result).toMatchObject({ restored: true, alreadyLive: false, version: { id: h.target.id } });
    expect((await snapshot(h.site.id)).site!.current_version_id).toBe(h.target.id);
  });

  it("does not mistake a stale caller snapshot for an already-live no-op", async () => {
    const h = await fixture();
    await env.DB.prepare("UPDATE sites SET current_version_id = ? WHERE id = ?").bind(h.target.id, h.site.id).run();
    h.site = await h.load();
    await env.DB.prepare("UPDATE sites SET current_version_id = ?, updated_at = ? WHERE id = ?")
      .bind(h.winner.id, WINNER_TIME, h.site.id).run();
    await refreshLive(h.dc, h.site.id);
    const effects = observe(h);
    const result = await restoreVersion(h.dc, h.principal, h.site, h.target.id);
    await h.flush();
    expect.soft(result).toMatchObject({ restored: true, alreadyLive: false, version: { id: h.target.id } });
    expect.soft((await snapshot(h.site.id)).site!.current_version_id).toBe(h.target.id);
    expect.soft(effects.put).toHaveBeenCalledTimes(1);
    expect.soft(h.published).toHaveLength(1);
  });

  it.each(["missing", "pending", "foreign"] as const)("refuses a %s target without effects", async (kind) => {
    const h = await fixture();
    let id = "ver_missing";
    if (kind === "pending") {
      await env.DB.prepare("UPDATE versions SET status = 'pending' WHERE id = ?").bind(h.target.id).run();
      id = h.target.id;
    } else if (kind === "foreign") {
      await publish(h.dw, "other-site", "<h1>Not this site's version</h1>");
      const other = await getSiteFor(h.dc, h.principal, "other-site", "sites:write");
      id = other.current_version_id!;
    }
    const before = await snapshot(h.site.id);
    const effects = observe(h);
    expectError(await outcome(restoreVersion(h.dc, h.principal, h.site, id)), 404, "version_not_found");
    await h.flush();
    expect(await snapshot(h.site.id)).toEqual(before);
    effects.expectNoEffects();
  });

  it("refuses transfer mode before restoring even its already-live version", async () => {
    const h = await fixture();
    // Only the existing service mode guard is under test; no transfer lifecycle is created.
    await env.DB.prepare("UPDATE sites SET mode = 'transfer' WHERE id = ?").bind(h.site.id).run();
    h.site = await h.load();
    const before = await snapshot(h.site.id);
    const effects = observe(h);
    expectError(await outcome(restoreVersion(h.dc, h.principal, h.site, h.live.id)), 409, "transfer_immutable");
    await h.flush();
    expect(await snapshot(h.site.id)).toEqual(before);
    effects.expectNoEffects();
  });
});

describe("atomic restore: target-read interleavings", () => {
  it("refuses a competing live move with version_conflict and preserves the winner", async () => {
    const h = await fixture();
    await race(h, async () => {
      await env.DB.prepare("UPDATE sites SET current_version_id = ?, updated_at = ? WHERE id = ?")
        .bind(h.winner.id, WINNER_TIME, h.site.id).run();
      await refreshLive(h.dc, h.site.id);
    }, 409, "version_conflict");
  });

  it("treats NULL expected live as exact NULL, not a wildcard", async () => {
    const h = await fixture();
    await env.DB.prepare("UPDATE sites SET current_version_id = NULL WHERE id = ?").bind(h.site.id).run();
    h.site = await h.load();
    await race(h, async () => {
      await env.DB.prepare("UPDATE sites SET current_version_id = ?, updated_at = ? WHERE id = ?")
        .bind(h.winner.id, WINNER_TIME, h.site.id).run();
      await refreshLive(h.dc, h.site.id);
    }, 409, "version_conflict");
  });

  it("also refuses a non-NULL expected live pointer concurrently cleared to NULL", async () => {
    const h = await fixture();
    await race(h, async () => {
      await env.DB.prepare("UPDATE sites SET current_version_id = NULL, updated_at = ? WHERE id = ?")
        .bind(WINNER_TIME, h.site.id).run();
      await refreshLive(h.dc, h.site.id);
    }, 409, "version_conflict");
  });

  it("reports version_not_found when the ready target is deleted after lookup", async () => {
    const h = await fixture();
    await race(h, async () => {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM version_files WHERE version_id = ?").bind(h.target.id),
        env.DB.prepare("DELETE FROM versions WHERE id = ?").bind(h.target.id),
      ]);
    }, 404, "version_not_found");
  });

  it("rechecks target readiness inside the write fence", async () => {
    const h = await fixture();
    await race(h, async () => {
      await env.DB.prepare("UPDATE versions SET status = 'pending' WHERE id = ?").bind(h.target.id).run();
    }, 404, "version_not_found");
  });

  it("rechecks target site ownership inside the write fence", async () => {
    const h = await fixture();
    await publish(h.dw, "other-site", "<h1>Other site</h1>");
    const other = await getSiteFor(h.dc, h.principal, "other-site", "sites:write");
    await race(h, async () => {
      await env.DB.prepare("UPDATE versions SET site_id = ?, number = 2 WHERE id = ?")
        .bind(other.id, h.target.id).run();
    }, 404, "version_not_found");
  });

  it("cannot mutate a site whose tenant changed after authorization and target lookup", async () => {
    const h = await fixture();
    await env.DB.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)")
      .bind("tenant_other", "Other tenant", ANCHOR_TIME).run();
    await race(h, async () => {
      await env.DB.prepare("UPDATE sites SET tenant_id = ?, updated_at = ? WHERE id = ?")
        .bind("tenant_other", WINNER_TIME, h.site.id).run();
      await refreshLive(h.dc, h.site.id);
    }, 404, "site_not_found");
  });

  it("cannot mutate a soft-deleted site after target lookup", async () => {
    const h = await fixture();
    await race(h, async () => {
      await env.DB.prepare("UPDATE sites SET deleted_at = ?, updated_at = ? WHERE id = ?")
        .bind(WINNER_TIME, WINNER_TIME, h.site.id).run();
      await dropLive(h.dc, SLUG);
    }, 404, "site_not_found");
  });
});

describe("atomic restore: existing HTTP authorization", () => {
  it.each(["anonymous", "read-only", "other-site-key"] as const)("refuses %s access without mutation", async (kind) => {
    const h = await fixture();
    let key: string | undefined;
    if (kind !== "anonymous") {
      let siteId: string | undefined;
      if (kind === "other-site-key") {
        await publish(h.dw, "other-site", "<h1>Other site</h1>");
        siteId = (await getSiteFor(h.dc, h.principal, "other-site", "sites:write")).id;
      }
      const r = await h.dw.json("/api/v1/keys", {
        key: h.dw.ownerKey,
        ...jsonBody({ name: kind, scopes: kind === "read-only" ? ["sites:read"] : ["sites:read", "sites:write"], ...(siteId ? { site: "other-site" } : {}) }),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      key = r.body.key;
      expect(key).toEqual(expect.any(String));
      expect(r.body.siteId).toBe(siteId ?? null);
    }
    const before = await snapshot(h.site.id);
    const effects = observe(h);
    const r = await h.dw.json(`/api/v1/sites/${SLUG}/versions/${h.target.id}/restore`, { method: "POST", key });
    expect(r.status, JSON.stringify(r.body)).toBe(kind === "anonymous" ? 401 : kind === "read-only" ? 403 : 404);
    if (kind !== "anonymous") expect(r.body.error.code).toBe(kind === "read-only" ? "insufficient_scope" : "site_not_found");
    expect(await snapshot(h.site.id)).toEqual(before);
    effects.expectNoEffects();
  });
});
