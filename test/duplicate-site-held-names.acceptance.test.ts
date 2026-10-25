import { afterEach, describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  ApiError, clearLiveMemoryCache, createTenantWithOwner, defaultPolicy, mintApiKey,
  type PolicyAdapter, type PublishEvent, type SiteOwner, type UsageEvent,
} from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, jsonBody, manifestEntry, type Instance } from "./helpers";

/**
 * Protected Test Author acceptance: incorporate unchanged, implement elsewhere.
 * Catches premature hold reclamation on refused copies, including a zero-row
 * transactional make-live, without banning valid same-tenant reclamation.
 * All writes use disposable Worker/D1/R2/KV handlers or tenant/key setup services.
 */
const SOURCE = "held-copy-source";
const TARGET = "held-copy-target";
const FILES = [
  { path: "index.html", content: "<h1>Source A</h1>", contentType: "text/html; charset=utf-8" },
  { path: "docs/résumé.txt", content: "résumé\n", contentType: "text/plain; charset=utf-8" },
  { path: "empty.txt", content: "", contentType: "text/plain; charset=utf-8" },
];
const NEXT = [{ path: "index.html", content: "Source B", contentType: "text/html" }];
type Row = Record<string, any>;
type Usage = { tenant_id: string; key: string; value: number };

async function holds() {
  return (await env.DB.prepare("SELECT * FROM slug_tombstones WHERE slug = ? ORDER BY id").bind(TARGET).all<Row>()).results;
}

async function graph(excludeSiteId: string | null = null) {
  const sites = (await env.DB.prepare("SELECT * FROM sites WHERE (? IS NULL OR id != ?) ORDER BY id")
    .bind(excludeSiteId, excludeSiteId).all<Row>()).results;
  const versions = (await env.DB.prepare("SELECT * FROM versions WHERE (? IS NULL OR site_id != ?) ORDER BY id")
    .bind(excludeSiteId, excludeSiteId).all<Row>()).results;
  const files = (await env.DB.prepare(`SELECT vf.* FROM version_files vf JOIN versions v ON v.id = vf.version_id
    WHERE (? IS NULL OR v.site_id != ?) ORDER BY vf.version_id, vf.path`)
    .bind(excludeSiteId, excludeSiteId).all<Row>()).results;
  const usage = (await env.DB.prepare("SELECT tenant_id, key, value FROM usage_counters ORDER BY tenant_id, key").all<Usage>()).results;
  if (excludeSiteId) {
    const provisional = await env.DB.prepare("SELECT tenant_id, current_version_id FROM sites WHERE id = ?")
      .bind(excludeSiteId).first<{ tenant_id: string; current_version_id: string | null }>();
    expect(provisional, "only exclude the new, non-live destination").toMatchObject({ current_version_id: null });
    // Expected state AFTER refusal removes exactly this provisional site slot.
    // This adjusts an expectation only; no usage counter is ever written by tests.
    for (const row of usage) if (row.tenant_id === provisional!.tenant_id && row.key === "sites") row.value--;
  }
  return { sites, versions, files, usage };
}

async function publish(dw: Instance, slug: string, files = FILES, status = 201, key = dw.ownerKey) {
  const result = await dw.json("/api/v1/publish", { key, ...jsonBody({ slug, files }) });
  expect(result.status, `fixture publish ${slug}: ${JSON.stringify(result.body)}`).toBe(status);
  return result.body;
}

function allocate(dw: Instance, key: string) {
  return dw.json("/api/v1/sites", { key, ...jsonBody({ slug: TARGET }) });
}

function duplicate(dw: Instance, key: string, idempotencyKey?: string) {
  return dw.json(`/api/v1/sites/${SOURCE}/duplicate`, {
    key, ...jsonBody({ newSlug: TARGET }),
    headers: { "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
  });
}

function refusal(result: { status: number; body: any }, status: number, code: string, soft = false) {
  const check = soft ? expect.soft : expect;
  check(result.status, JSON.stringify(result.body)).toBe(status);
  check(result.body.error).toMatchObject({ code, hint: expect.any(String) });
  if (result.body.error) check(result.body.error.hint.trim().length).toBeGreaterThan(0);
}

function sinks() {
  const published: PublishEvent[] = [];
  const metered: UsageEvent[] = [];
  return {
    published, metered,
    hooks: [{ onPublish(event: PublishEvent) { published.push(event); } }],
    metering: { record(event: UsageEvent) { metered.push(event); } },
    clear() { published.length = 0; metered.length = 0; },
    expectNoDeploy() {
      expect.soft(published).toEqual([]);
      expect.soft(metered.filter((e) => e.type === "deploy")).toEqual([]);
    },
  };
}

async function fixture(policy: PolicyAdapter = defaultPolicy, events = sinks()) {
  const dw = await freshInstance({ multiTenant: true }, {
    hooks: events.hooks, adapters: { policy, metering: events.metering },
  });
  const source = await publish(dw, SOURCE);
  await publish(dw, TARGET, [{ path: "previous.txt", content: "previous owner bytes", contentType: "text/plain" }]);
  const former = (await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind(TARGET).first<{ id: string }>())!;
  const deleted = await dw.json(`/api/v1/sites/${TARGET}`, { method: "DELETE", key: dw.ownerKey });
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  const original = await holds();
  expect(original).toHaveLength(1);
  const sourceRow = await env.DB.prepare("SELECT * FROM sites WHERE slug = ?").bind(SOURCE).first<Row>();
  expect(original[0]).toMatchObject({
    id: expect.any(String), slug: TARGET, tenant_id: sourceRow!.tenant_id,
    site_id: former.id, reason: expect.any(String), created_at: expect.any(Number),
    hold_until: expect.any(Number), released_at: null, release_reason: null, released_by: null,
  });
  expect(original[0]!.hold_until).toBeGreaterThan(Date.now());
  const oldSite = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(former.id).first<Row>();
  expect(oldSite, "the soft-deleted former holder is legitimate retained state").not.toBeNull();
  expect(oldSite!.deleted_at).not.toBeNull();

  const ctx = createExecutionContext();
  let writer: string;
  let foreign: string;
  try {
    const dc = dw.dropway.context(env as unknown as ServerBindings, ctx);
    const owner = await env.DB.prepare("SELECT id FROM members WHERE tenant_id = ? AND role = 'owner'")
      .bind(sourceRow!.tenant_id).first<{ id: string }>();
    writer = (await mintApiKey(dc, { tenantId: sourceRow!.tenant_id, memberId: owner!.id, scopes: ["sites:read", "sites:write"] })).key;
    const other = await createTenantWithOwner(dc, { tenant: { name: "Other tenant" }, owner: { name: "Other owner" } });
    expect(other.tenant.id).not.toBe(sourceRow!.tenant_id);
    foreign = (await mintApiKey(dc, { tenantId: other.tenant.id, memberId: other.owner.id, scopes: ["sites:read", "sites:write"] })).key;
  } finally {
    await waitOnExecutionContext(ctx);
  }
  const release = await dw.json("/api/v1/slugs/release", {
    key: writer, ...jsonBody({ slug: TARGET, reason: "Writer must not release", confirm: TARGET }),
  });
  expect(release.status, "writer has read/write scopes, not admin release authority").toBe(403);
  refusal(await allocate(dw, foreign), 409, "slug_reserved");
  expect(await holds(), "neither forbidden release nor foreign allocation alters the genuine hold").toEqual(original);
  events.clear();
  return { dw, writer, foreign, original, source, sourceRow: sourceRow!, events };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function retained(f: Fixture, expected: Awaited<ReturnType<typeof graph>>) {
  expect.soft(await holds(), "exact original tombstone, including audit fields and expiry, survives refusal").toEqual(f.original);
  expect.soft(await graph(), "no provisional rows or usage drift; source and soft-deleted former holder preserved").toEqual(expected);
  f.events.expectNoDeploy();
  // Check after all snapshots: a regression really allocates the name here.
  refusal(await allocate(f.dw, f.foreign), 409, "slug_reserved", true);
}

function destinationPolicy() {
  let armed = false;
  const names = new Map<string, string>();
  const owners: (SiteOwner | null)[] = [];
  const isDestination = (owner: SiteOwner | null) => armed && owner?.siteId != null && owner.siteId === names.get(TARGET);
  const policy: PolicyAdapter = {
    ...defaultPolicy,
    siteNameMutation(_principal, input) { names.set(input.slug, input.siteId); return { statements: [] }; },
  };
  return {
    policy, owners, isDestination,
    arm() { armed = true; owners.length = 0; },
    expectOwner(f: Fixture) {
      const siteId = names.get(TARGET);
      expect(siteId).toBeDefined();
      expect(siteId).not.toBe(f.original[0]!.site_id);
      expect(owners).toContainEqual({ siteId, tenantId: f.sourceRow.tenant_id });
    },
  };
}

afterEach(() => { clearLiveMemoryCache(); });

describe("duplicate refusal preserves prior held-name protection", () => {
  it("destination-only maxFiles refusal cannot release a same-tenant hold", async () => {
    const p = destinationPolicy();
    p.policy.limits = (_principal, owner, dc) => {
      if (p.isDestination(owner)) p.owners.push({ ...owner });
      return { ...dc.config.limits, ...(p.isDestination(owner) ? { maxFiles: 1 } : {}) };
    };
    const f = await fixture(p.policy);
    const before = await graph();
    p.arm();
    refusal(await duplicate(f.dw, f.writer), 400, "too_many_files");
    p.expectOwner(f);
    await retained(f, before);
  });

  it("destination-only storage quota refusal preserves the hold despite zero new bytes", async () => {
    const p = destinationPolicy();
    let quota = 0;
    p.policy.quota = (_principal, key, owner) => {
      if (key !== "storage_bytes" || !p.isDestination(owner)) return null;
      p.owners.push(owner && { ...owner });
      return quota;
    };
    const f = await fixture(p.policy);
    await publish(f.dw, "held-quota-existing", [{ path: "extra.txt", content: "distinct existing storage", contentType: "text/plain" }]);
    const me = await f.dw.json("/api/v1/me", { key: f.dw.ownerKey });
    expect(me.status).toBe(200);
    expect(me.body.usage.storage_bytes).toBeGreaterThan(0);
    quota = me.body.usage.storage_bytes - 1;
    const before = await graph();
    f.events.clear();
    p.arm();
    refusal(await duplicate(f.dw, f.writer), 403, "limit_reached");
    p.expectOwner(f);
    await retained(f, before);
  });

  it("beforeDeploy rejection preserves the hold throughout preparation and afterward", async () => {
    let armed = false;
    let reached = false;
    let f: Fixture;
    const policy: PolicyAdapter = { ...defaultPolicy, async beforeDeploy(_principal, input) {
      if (!armed) return;
      armed = false;
      reached = true;
      expect(input).toMatchObject({ tenantId: f.sourceRow.tenant_id, fileCount: 3, newBytes: 0 });
      expect.soft(await holds(), "no early reclaim window that best-effort restoration could hide").toEqual(f.original);
      throw new ApiError(403, "fixture_deploy_refused", "Publication refused.", "Keep the original name protection.");
    } };
    f = await fixture(policy);
    const before = await graph();
    armed = true;
    refusal(await duplicate(f.dw, f.writer), 403, "fixture_deploy_refused");
    expect(reached).toBe(true);
    await retained(f, before);
  });

  it("captured source A disappearing in beforeDeploy refuses without consuming the hold", async () => {
    let armed = false;
    let reached = false;
    let f: Fixture;
    let expected: Awaited<ReturnType<typeof graph>>;
    const policy: PolicyAdapter = { ...defaultPolicy, async beforeDeploy(_principal, input) {
      if (!armed) return;
      armed = false; // Nested real publication must not recurse.
      expect(input).toMatchObject({ tenantId: f.sourceRow.tenant_id, fileCount: 3, newBytes: 0 });
      const b = await publish(f.dw, SOURCE, NEXT, 200);
      expect(b.version.id).not.toBe(f.source.version.id);
      const deleted = await f.dw.json(`/api/v1/sites/${SOURCE}/versions/${f.source.version.id}`, { method: "DELETE", key: f.dw.ownerKey });
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      expect(await env.DB.prepare("SELECT id FROM versions WHERE id = ?").bind(f.source.version.id).first()).toBeNull();
      expect((await env.DB.prepare("SELECT * FROM version_files WHERE version_id = ?").bind(f.source.version.id).all()).results).toEqual([]);
      expected = await graph(input.siteId);
      expect(expected.sites.find((s) => s.id === f.sourceRow.id)!.current_version_id).toBe(b.version.id);
      f.events.clear(); // B legitimately emits; the refused copy must not.
      reached = true;
    } };
    f = await fixture(policy);
    armed = true;
    refusal(await duplicate(f.dw, f.writer), 409, "version_conflict");
    expect(reached).toBe(true);
    await retained(f, expected!);
  });

  it("late real storage growth refuses transactionally without consuming the hold", async () => {
    const p = destinationPolicy();
    let quota = 0;
    let reached = false;
    let f: Fixture;
    let expected: Awaited<ReturnType<typeof graph>>;
    p.policy.quota = (_principal, key, owner) => {
      if (key !== "storage_bytes" || !p.isDestination(owner)) return null;
      p.owners.push(owner && { ...owner });
      return quota;
    };
    p.policy.beforeDeploy = async (_principal, input) => {
      if (!p.isDestination(input)) return;
      expect(input).toMatchObject({ tenantId: f.sourceRow.tenant_id, newBytes: 0 });
      const preflight = await f.dw.json("/api/v1/me", { key: f.dw.ownerKey });
      expect(preflight.body.usage.storage_bytes).toBeLessThanOrEqual(quota);
      expect.soft(await holds(), "hold must not be reclaimed before a possibly zero-row make-live").toEqual(f.original);
      await publish(f.dw, "held-quota-growth", [{ path: "growth.txt", content: "new storage written during destination preparation", contentType: "text/plain" }]);
      const grown = await f.dw.json("/api/v1/me", { key: f.dw.ownerKey });
      expect(grown.body.usage.storage_bytes).toBeGreaterThan(quota);
      expected = await graph(input.siteId);
      f.events.clear(); // Ignore only the legitimate growth publication.
      reached = true;
    };
    f = await fixture(p.policy);
    const me = await f.dw.json("/api/v1/me", { key: f.dw.ownerKey });
    quota = me.body.usage.storage_bytes; // Preflight fits exactly; copy adds zero.
    p.arm();
    refusal(await duplicate(f.dw, f.writer), 403, "limit_reached");
    expect(reached, "real storage growth must occur after permissive preflight").toBe(true);
    p.expectOwner(f);
    await retained(f, expected!);
  });
});

describe("held-name duplicate and release controls", () => {
  it("writer successfully reclaims its own hold with an exact live copy and same-key replay", async () => {
    const f = await fixture();
    const before = await graph();
    const first = await duplicate(f.dw, f.writer, "held-name-copy-once");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const copy = await env.DB.prepare("SELECT * FROM sites WHERE slug = ? AND deleted_at IS NULL").bind(TARGET).first<Row>();
    expect(copy).toMatchObject({ tenant_id: f.sourceRow.tenant_id, current_version_id: first.body.version.id });
    expect(copy!.id).not.toBe(f.sourceRow.id);
    expect(copy!.id).not.toBe(f.original[0]!.site_id);
    const version = await env.DB.prepare("SELECT * FROM versions WHERE id = ?").bind(copy!.current_version_id).first<Row>();
    const entries = await Promise.all(FILES.map((file) => manifestEntry(file.path, file.content, file.contentType)));
    const expected = entries.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size, content_type: file.contentType }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    expect(version).toMatchObject({ site_id: copy!.id, number: 1, status: "ready", file_count: 3, total_bytes: entries.reduce((sum, file) => sum + file.size, 0) });
    const actual = (await env.DB.prepare("SELECT path, sha256, size, content_type FROM version_files WHERE version_id = ? ORDER BY path")
      .bind(version!.id).all()).results;
    expect(actual).toEqual(expected);
    expect((await holds()).filter((h) => h.released_at === null && h.hold_until > Date.now())).toEqual([]);
    const saved = await graph();
    const replay = await duplicate(f.dw, f.writer, "held-name-copy-once");
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ replayed: true, site: { slug: TARGET, currentVersionId: version!.id }, version: { id: version!.id } });
    expect(await graph()).toEqual(saved);
    // Compare original rows directly: the valid new site's rows are the only additions.
    expect(saved.sites.filter((s) => s.id !== copy!.id)).toEqual(before.sites);
    expect(saved.versions.filter((v) => v.site_id !== copy!.id)).toEqual(before.versions);
    expect(saved.files.filter((file) => file.version_id !== version!.id)).toEqual(before.files);
    expect(saved.usage).toEqual(before.usage.map((row) => ({ ...row,
      value: row.value + (row.tenant_id === f.sourceRow.tenant_id && row.key === "sites" ? 1 : 0),
    })));
    refusal(await allocate(f.dw, f.foreign), 409, "slug_taken");
    expect(f.events.published).toHaveLength(1);
    expect(f.events.published[0]).toMatchObject({ kind: "deploy", site: { id: copy!.id, slug: TARGET } });
    expect(f.events.metered.filter((e) => e.type === "deploy")).toHaveLength(1);
    clearLiveMemoryCache();
    const listed = await f.dw.json(`/api/v1/sites/${TARGET}/files`, { key: f.writer });
    expect(listed.status).toBe(200);
    expect(listed.body.files).toHaveLength(FILES.length);
    for (const file of FILES) {
      const entry = listed.body.files.find((item: Row) => item.path === file.path);
      expect(entry).toBeDefined();
      const served = await f.dw.call(entry.rawUrl, { key: f.writer });
      expect(served.status).toBe(200);
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(new TextEncoder().encode(file.content));
    }
  });

  it("foreign writer cannot duplicate its own live source into another tenant's hold", async () => {
    const f = await fixture();
    await publish(f.dw, "foreign-copy-source", FILES, 201, f.foreign);
    const before = await graph();
    f.events.clear();
    const result = await f.dw.json("/api/v1/sites/foreign-copy-source/duplicate", {
      key: f.foreign, ...jsonBody({ newSlug: TARGET }),
    });
    refusal(result, 409, "slug_reserved");
    await retained(f, before);
  });

  it("authorized admin release retains the audit row and permits foreign allocation", async () => {
    const f = await fixture();
    const released = await f.dw.json("/api/v1/slugs/release", {
      key: f.dw.ownerKey, ...jsonBody({ slug: TARGET, reason: "Explicit administrative release", confirm: TARGET }),
    });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.released).toBe(true);
    const rows = await holds();
    expect(rows).toHaveLength(1);
    const { released_at, release_reason, released_by, ...unchanged } = rows[0]!;
    const { released_at: _at, release_reason: _reason, released_by: _by, ...original } = f.original[0]!;
    expect(unchanged).toEqual(original);
    expect(released_at).toEqual(expect.any(Number));
    expect(release_reason).toBe("Explicit administrative release");
    expect(released_by).toEqual(expect.any(String));
    expect((await allocate(f.dw, f.foreign)).status).toBe(201);
    expect(await holds(), "allocation must not erase administrative release audit history").toEqual(rows);
  });
});
