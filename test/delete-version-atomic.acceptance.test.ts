import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  ApiError, clearLiveMemoryCache, createDeploy, defaultIdentity, deleteVersion, dropLive,
  finalizeDeploy, getSiteFor, refreshLive, restoreVersion,
  type PublishEvent, type SiteRow, type UsageEvent, type VersionRow,
} from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";

/** Independent acceptance: real disposable D1 transactions, never fabricated write results. */
const SLUG = "delete-atomic";
const OTHER = "delete-unrelated";
const MOVED_AT = 1_700_000_000_333;

afterEach(() => {
  vi.restoreAllMocks();
  clearLiveMemoryCache();
});

async function publish(dw: Instance, slug: string, label: string, status = 201) {
  const r = await dw.json("/api/v1/publish", {
    key: dw.ownerKey,
    ...jsonBody({ slug, files: [
      { path: "index.html", content: `<h1>${label}</h1>`, contentType: "text/html" },
      { path: "nested/data.txt", content: `unique ${label}`, contentType: "text/plain" },
      { path: "shared.txt", content: "shared immutable bytes", contentType: "text/plain" },
    ] }),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(status);
}

async function fixture() {
  const published: PublishEvent[] = [];
  const metered: UsageEvent[] = [];
  const deleted: unknown[] = [];
  const dw = await freshInstance({}, {
    hooks: [{ onPublish: event => { published.push(event); }, onDelete: event => { deleted.push(event); } }],
    adapters: { metering: { record: event => { metered.push(event); } } },
  });
  await publish(dw, SLUG, "historical target");
  await publish(dw, SLUG, "initial live", 200);
  await publish(dw, OTHER, "unrelated site");
  const ctx = createExecutionContext();
  const dc = dw.dropway.context(env as unknown as ServerBindings, ctx);
  const principal = await defaultIdentity.resolve(new Request(`${ORIGIN}/api/v1/me`, {
    headers: { Authorization: `Bearer ${dw.ownerKey}` },
  }), dc);
  if (principal.kind !== "member") throw new Error("Fixture owner did not resolve.");
  const site = await getSiteFor(dc, principal, SLUG, "sites:delete");
  const other = await getSiteFor(dc, principal, OTHER, "sites:delete");
  const versions = (await env.DB.prepare("SELECT * FROM versions WHERE site_id = ? ORDER BY number")
    .bind(site.id).all<VersionRow>()).results;
  expect(versions).toHaveLength(2);
  const [target, live] = versions;
  if (!target || !live) throw new Error("Fixture needs two ready versions.");
  const flush = () => waitOnExecutionContext(ctx);
  await flush();
  return { dw, dc, principal, site, other, target, live, published, metered, deleted, flush };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

async function snapshot() {
  // Include ALL child rows, not a parent join that would hide orphaned manifests.
  const sites = (await env.DB.prepare("SELECT * FROM sites ORDER BY id").all<SiteRow>()).results;
  const versions = (await env.DB.prepare("SELECT * FROM versions ORDER BY id").all()).results;
  const files = (await env.DB.prepare("SELECT * FROM version_files ORDER BY version_id, path").all()).results;
  const usage = (await env.DB.prepare("SELECT * FROM usage_counters ORDER BY tenant_id, key").all()).results;
  const blobs = (await env.DB.prepare("SELECT * FROM blobs ORDER BY sha256").all()).results;
  const scopes = (await env.DB.prepare("SELECT * FROM blob_scopes ORDER BY scope, sha256").all()).results;
  const names = [...new Set([...sites.map(site => site.slug), SLUG, OTHER])].sort();
  const cache = await Promise.all(names.map(async slug => [slug, await env.CACHE.get(`live:${slug}`)]));
  return { sites, versions, files, usage, blobs, scopes, cache };
}

function observe(h: Harness) {
  const put = vi.spyOn(env.CACHE, "put");
  const remove = vi.spyOn(env.CACHE, "delete");
  const r2put = vi.spyOn(env.FILES, "put");
  const r2delete = vi.spyOn(env.FILES, "delete");
  const clear = () => {
    put.mockClear(); remove.mockClear(); r2put.mockClear(); r2delete.mockClear();
    h.published.length = 0; h.metered.length = 0; h.deleted.length = 0;
  };
  clear();
  return { clear, expectNoEffects() {
    expect.soft(put, "refusal must not refresh live cache").not.toHaveBeenCalled();
    expect.soft(remove, "refusal must not invalidate live cache").not.toHaveBeenCalled();
    expect.soft(r2put).not.toHaveBeenCalled();
    expect.soft(r2delete).not.toHaveBeenCalled();
    expect.soft(h.published).toEqual([]);
    expect.soft(h.metered).toEqual([]);
    expect.soft(h.deleted).toEqual([]);
  } };
}

async function outcome<T>(promise: Promise<T>) {
  try { return { ok: true as const, value: await promise }; }
  catch (error: unknown) { return { ok: false as const, error }; }
}

function expectError(result: Awaited<ReturnType<typeof outcome>>, status: number, code: string) {
  expect.soft(result).toMatchObject({ ok: false, error: { status, code } });
  expect.soft(result.ok ? undefined : result.error).toBeInstanceOf(ApiError);
}

/** Delay delivery of exactly one actual target SELECT; all competitors use real services/SQL. */
function afterTargetRead(siteId: string, target: VersionRow, compete: () => Promise<void>) {
  const prepare = env.DB.prepare.bind(env.DB);
  let calls = 0;
  vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (!/^\s*SELECT\b[\s\S]*\bFROM\s+versions\b/i.test(sql)) return statement;
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...values) => {
      const bound = bind(...values);
      if (!values.includes(siteId) || !values.includes(target.id)) return bound;
      const first = bound.first.bind(bound);
      vi.spyOn(bound, "first").mockImplementation(async (columnName?: string) => {
        const row = await Reflect.apply(first, bound, columnName === undefined ? [] : [columnName]);
        if (calls === 0) {
          calls++;
          expect(row).toMatchObject({ id: target.id, site_id: siteId, status: target.status });
          await compete();
        }
        return row;
      });
      return bound;
    });
    return statement;
  });
  return () => expect(calls, "deterministic real-read interleaving executes once").toBe(1);
}

function beforeBatch(compete: () => Promise<void>) {
  const batch = env.DB.batch.bind(env.DB);
  let calls = 0;
  vi.spyOn(env.DB, "batch").mockImplementation(async <T = unknown>(statements: D1PreparedStatement[]) => {
    if (calls === 0) {
      calls++;
      await compete();
    }
    return batch<T>(statements);
  });
  return () => expect(calls, "interleave after all preflight reads but before the real transaction").toBe(1);
}

async function racedDelete(
  h: Harness, compete: () => Promise<void>, status: number, code: string, target = h.target,
  boundary: "target-read" | "batch" = "target-read",
) {
  const effects = observe(h);
  let expected: Awaited<ReturnType<typeof snapshot>> | undefined;
  const competeAndSnapshot = async () => {
    await compete();
    await h.flush();
    expected = await snapshot();
    effects.clear();
  };
  const interleaved = boundary === "target-read"
    ? afterTargetRead(h.site.id, target, competeAndSnapshot)
    : beforeBatch(competeAndSnapshot);
  const result = await outcome(deleteVersion(h.dc, h.principal, h.site, target.id));
  await h.flush();
  interleaved();
  expectError(result, status, code);
  expect.soft(await snapshot(), "refused deletion preserves complete post-competitor state, including unrelated rows and usage").toEqual(expected);
  effects.expectNoEffects();
}

async function pending(h: Harness, uploaded: boolean) {
  const files = uploaded
    ? (await env.DB.prepare("SELECT path, sha256, size, content_type AS contentType FROM version_files WHERE version_id = ? ORDER BY path")
      .bind(h.target.id).all()).results
    : [await manifestEntry("draft.txt", "not uploaded yet", "text/plain")];
  const result = await createDeploy(h.dc, h.principal, h.site, files, { baseVersionId: h.live.id });
  expect(result.unchanged).toBe(false);
  expect(result.missing.length).toBe(uploaded ? 0 : 1);
  const row = await env.DB.prepare("SELECT * FROM versions WHERE id = ?").bind(result.version.id).first<VersionRow>();
  expect(row).toMatchObject({ status: "pending", site_id: h.site.id });
  if (!row) throw new Error("Pending target missing.");
  return row;
}

async function storageValue(tenantId: string) {
  const row = await env.DB.prepare("SELECT value FROM usage_counters WHERE tenant_id = ? AND key = 'storage_bytes'")
    .bind(tenantId).first<{ value: number }>();
  expect(row).not.toBeNull();
  return row!.value;
}

async function assertValidLive(h: Harness, id: string) {
  expect(await env.DB.prepare("SELECT current_version_id FROM sites WHERE id = ?").bind(h.site.id).first()).toEqual({ current_version_id: id });
  expect(await env.DB.prepare("SELECT id, status FROM versions WHERE site_id = ? AND id = ?").bind(h.site.id, id).first()).toEqual({ id, status: "ready" });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM version_files WHERE version_id = ?").bind(id).first()).toEqual({ n: 3 });
}

describe("atomic delete: restore and finalize ordering", () => {
  it("refuses a stale deletion after real restore makes its target live, retaining manifest and usage", async () => {
    const h = await fixture();
    await racedDelete(h, async () => {
      const restored = await restoreVersion(h.dc, h.principal, h.site, h.target.id);
      expect(restored).toMatchObject({ restored: true, version: { id: h.target.id, live: true } });
      await h.flush();
      await assertValidLive(h, h.target.id);
    }, 409, "version_is_live");
    await assertValidLive(h, h.target.id);
  });

  it("refuses restore when real deletion wins before its fence, without a dangling live pointer or restore effects", async () => {
    const h = await fixture();
    const effects = observe(h);
    let expected: Awaited<ReturnType<typeof snapshot>> | undefined;
    const interleaved = afterTargetRead(h.site.id, h.target, async () => {
      expect(await deleteVersion(h.dc, h.principal, h.site, h.target.id)).toEqual({ deleted: true, id: h.target.id });
      await h.flush();
      expected = await snapshot();
      expect(expected.versions).not.toContainEqual(expect.objectContaining({ id: h.target.id }));
      expect(expected.files).not.toContainEqual(expect.objectContaining({ version_id: h.target.id }));
      effects.clear();
    });
    const result = await outcome(restoreVersion(h.dc, h.principal, h.site, h.target.id));
    await h.flush();
    interleaved();
    expectError(result, 404, "version_not_found");
    expect.soft(await snapshot()).toEqual(expected);
    await assertValidLive(h, h.live.id);
    effects.expectNoEffects();
  });

  it("refuses stale deletion after real pending finalization publishes the target", async () => {
    const h = await fixture();
    const target = await pending(h, true);
    await racedDelete(h, async () => {
      const finalized = await finalizeDeploy(h.dc, h.principal, h.site, target.id);
      expect(finalized).toMatchObject({ replayed: false, live: true, version: { id: target.id, status: "ready" } });
      await h.flush();
      await assertValidLive(h, target.id);
    }, 409, "version_is_live", target);
    await assertValidLive(h, target.id);
  });
});

describe("atomic delete: transaction-boundary fencing", () => {
  it.each(["restore", "finalize", "membership", "ownership", "deleted-site"] as const)("fences %s after every preflight read, before ANY child or usage mutation", async kind => {
    const h = await fixture();
    const target = kind === "finalize" ? await pending(h, true) : h.target;
    if (kind === "ownership") {
      await env.DB.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)")
        .bind("tenant_competitor", "Competing owner", MOVED_AT).run();
    }
    await racedDelete(h, async () => {
      if (kind === "restore") {
        expect(await restoreVersion(h.dc, h.principal, h.site, target.id)).toMatchObject({ restored: true, version: { id: target.id } });
      } else if (kind === "finalize") {
        expect(await finalizeDeploy(h.dc, h.principal, h.site, target.id)).toMatchObject({ live: true, version: { id: target.id, status: "ready" } });
      } else if (kind === "membership") {
        await env.DB.prepare("UPDATE versions SET site_id = ?, number = 2 WHERE id = ?").bind(h.other.id, target.id).run();
      } else if (kind === "ownership") {
        await env.DB.prepare("UPDATE sites SET tenant_id = ? WHERE id = ?").bind("tenant_competitor", h.site.id).run();
        await refreshLive(h.dc, h.site.id);
      } else {
        await env.DB.prepare("UPDATE sites SET deleted_at = ? WHERE id = ?").bind(MOVED_AT, h.site.id).run();
        await dropLive(h.dc, SLUG);
      }
    }, kind === "restore" || kind === "finalize" ? 409 : 404,
    kind === "restore" || kind === "finalize" ? "version_is_live" : kind === "membership" ? "version_not_found" : "site_not_found", target, "batch");
  });
});

describe("atomic delete: stale authorization and membership", () => {
  it("refuses a target already removed by a real competing deletion", async () => {
    const h = await fixture();
    await racedDelete(h, async () => {
      expect(await deleteVersion(h.dc, h.principal, h.site, h.target.id)).toEqual({ deleted: true, id: h.target.id });
    }, 404, "version_not_found");
  });

  it("refuses a target moved to another site after lookup without deleting its children", async () => {
    const h = await fixture();
    await racedDelete(h, async () => {
      await env.DB.prepare("UPDATE versions SET site_id = ?, number = 2 WHERE id = ?").bind(h.other.id, h.target.id).run();
    }, 404, "version_not_found");
  });

  it("refuses an original site that becomes soft-deleted after target lookup", async () => {
    const h = await fixture();
    await racedDelete(h, async () => {
      await env.DB.prepare("UPDATE sites SET deleted_at = ?, updated_at = ? WHERE id = ?").bind(MOVED_AT, MOVED_AT, h.site.id).run();
      await dropLive(h.dc, SLUG);
    }, 404, "site_not_found");
  });

  it("refuses ownership drift after target lookup without deleting foreign-owned history", async () => {
    const h = await fixture();
    await env.DB.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)")
      .bind("tenant_competitor", "Competing owner", MOVED_AT).run();
    await racedDelete(h, async () => {
      await env.DB.prepare("UPDATE sites SET tenant_id = ?, updated_at = ? WHERE id = ?")
        .bind("tenant_competitor", MOVED_AT, h.site.id).run();
      await refreshLive(h.dc, h.site.id);
    }, 404, "site_not_found");
  });

  it("binds refusal to the original site when its addressed slug is occupied by a replacement", async () => {
    const h = await fixture();
    await racedDelete(h, async () => {
      await env.DB.batch([
        env.DB.prepare("UPDATE sites SET slug = 'delete-retired', deleted_at = ?, updated_at = ? WHERE id = ?")
          .bind(MOVED_AT, MOVED_AT, h.site.id),
        env.DB.prepare("UPDATE sites SET slug = ?, updated_at = ? WHERE id = ?")
          .bind(SLUG, MOVED_AT, h.other.id),
      ]);
      await dropLive(h.dc, SLUG);
      await dropLive(h.dc, OTHER);
      await refreshLive(h.dc, h.other.id);
    }, 404, "site_not_found");
  });
});

describe("atomic delete: preserved behavior and whole-batch rollback", () => {
  it("deletes exactly one safe historical manifest and recomputes usage without touching unrelated state", async () => {
    const h = await fixture();
    const before = await snapshot();
    const bytes = await storageValue(h.principal.tenantId);
    const targetFiles = before.files.filter(file => file.version_id === h.target.id);
    const elsewhere = new Set(before.files.filter(file => file.version_id !== h.target.id).map(file => file.sha256));
    const removedBytes = targetFiles.filter(file => !elsewhere.has(file.sha256)).reduce((sum, file) => sum + Number(file.size), 0);
    expect(removedBytes).toBeGreaterThan(0);
    const effects = observe(h);
    expect(await deleteVersion(h.dc, h.principal, h.site, h.target.id)).toEqual({ deleted: true, id: h.target.id });
    await h.flush();
    const after = await snapshot();
    expect(after.sites).toEqual(before.sites);
    expect(after.versions).toEqual(before.versions.filter(version => version.id !== h.target.id));
    expect(after.files).toEqual(before.files.filter(file => file.version_id !== h.target.id));
    expect(after.cache).toEqual(before.cache);
    expect(after.blobs).toEqual(before.blobs);
    expect(after.scopes).toEqual(before.scopes);
    expect(await storageValue(h.principal.tenantId)).toBe(bytes - removedBytes);
    await assertValidLive(h, h.live.id);
    effects.expectNoEffects();
  });

  it("allows safe pending deletion with a missing upload without changing the live pointer or usage values", async () => {
    const h = await fixture();
    const target = await pending(h, false);
    const before = await snapshot();
    const bytes = await storageValue(h.principal.tenantId);
    const effects = observe(h);
    expect(await deleteVersion(h.dc, h.principal, h.site, target.id)).toEqual({ deleted: true, id: target.id });
    await h.flush();
    const after = await snapshot();
    expect(after.sites).toEqual(before.sites);
    expect(after.versions).toEqual(before.versions.filter(version => version.id !== target.id));
    expect(after.files).toEqual(before.files.filter(file => file.version_id !== target.id));
    expect(after.cache).toEqual(before.cache);
    expect(after.blobs).toEqual(before.blobs);
    expect(after.scopes).toEqual(before.scopes);
    expect(await storageValue(h.principal.tenantId)).toBe(bytes);
    await assertValidLive(h, h.live.id);
    effects.expectNoEffects();
  });

  it("rolls back manifest, parent and earlier usage statements on a real late SQL failure", async () => {
    const h = await fixture();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM version_files WHERE version_id = ?").bind(h.target.id).first()).toEqual({ n: 3 });
    expect(await storageValue(h.principal.tenantId)).toBeGreaterThan(0);
    // Old timestamps make rollback of the earlier counter update observable too.
    await env.DB.prepare("UPDATE usage_counters SET updated_at = ? WHERE tenant_id = ?")
      .bind(MOVED_AT, h.principal.tenantId).run();
    // This is a disposable schema trigger, not a mocked failure or product mutant.
    // It aborts AFTER the storage update, following both DELETEs and the sites counter.
    await env.DB.prepare(`CREATE TRIGGER acceptance_late_usage_failure AFTER UPDATE ON usage_counters
      WHEN NEW.key = 'storage_bytes' BEGIN SELECT RAISE(ABORT, 'acceptance_late_delete_failure'); END;`).run();
    const before = await snapshot();
    const effects = observe(h);
    const result = await outcome(deleteVersion(h.dc, h.principal, h.site, h.target.id));
    await h.flush();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error)).toContain("acceptance_late_delete_failure");
    expect(await snapshot(), "D1 rolls back child/parent deletion AND the prior usage update").toEqual(before);
    await assertValidLive(h, h.live.id);
    effects.expectNoEffects();
  });

  it.each(["missing", "foreign", "live", "transfer", "deleted-site"] as const)("preserves state on entry %s refusal", async kind => {
    const h = await fixture();
    let id = h.target.id;
    let status = 404;
    let code = "version_not_found";
    if (kind === "missing") id = "ver_missing";
    if (kind === "foreign") id = h.other.current_version_id!;
    if (kind === "live") { id = h.live.id; status = 409; code = "version_is_live"; }
    if (kind === "transfer") {
      await env.DB.prepare("UPDATE sites SET mode = 'transfer' WHERE id = ?").bind(h.site.id).run();
      status = 409; code = "transfer_immutable";
    }
    if (kind === "deleted-site") {
      await env.DB.prepare("UPDATE sites SET deleted_at = ? WHERE id = ?").bind(MOVED_AT, h.site.id).run();
      await dropLive(h.dc, SLUG);
      code = "site_not_found";
    }
    const before = await snapshot();
    const effects = observe(h);
    expectError(await outcome(deleteVersion(h.dc, h.principal, h.site, id)), status, code);
    await h.flush();
    expect(await snapshot()).toEqual(before);
    effects.expectNoEffects();
  });

  it.each(["read-only", "other-site-key"] as const)("preserves site-scoped authorization for %s", async kind => {
    const h = await fixture();
    const key = await h.dw.json("/api/v1/keys", {
      key: h.dw.ownerKey,
      ...jsonBody({ name: kind, scopes: kind === "read-only" ? ["sites:read"] : ["sites:read", "sites:delete"],
        ...(kind === "other-site-key" ? { site: OTHER } : {}) }),
    });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    const principal = await defaultIdentity.resolve(new Request(`${ORIGIN}/api/v1/me`, {
      headers: { Authorization: `Bearer ${key.body.key}` },
    }), h.dc);
    const before = await snapshot();
    const effects = observe(h);
    expectError(await outcome(deleteVersion(h.dc, principal, h.site, h.target.id)), kind === "read-only" ? 403 : 404,
      kind === "read-only" ? "insufficient_scope" : "site_not_found");
    await h.flush();
    expect(await snapshot()).toEqual(before);
    effects.expectNoEffects();
  });
});
