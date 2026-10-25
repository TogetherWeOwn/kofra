import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  ApiError, clearLiveMemoryCache, defaultPolicy,
  type Limits, type PublishEvent, type SiteOwner, type UsageEvent,
} from "@dropway/core";
import { freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";
import { create as createTransfer, get as getTransfer, instance as transferInstance } from "./transfer-fixtures";

/**
 * Protected Test Author regressions. Keep existing acceptance files unchanged.
 * These exercise real disposable Worker/D1/R2/KV boundaries, not service mocks.
 * Breaks caught: post-commit reload failures, source-owned destination policy,
 * removed transfer/manifest/quota guards, and missing duplicate publication events.
 */
const FILES = [
  { path: "index.html", content: "<h1>Copy me</h1>", contentType: "text/html; charset=utf-8" },
  { path: "docs/résumé.txt", content: "résumé\n", contentType: "text/plain; charset=utf-8" },
  { path: "empty.txt", content: "", contentType: "text/plain; charset=utf-8" },
];
const CLIENT = "duplicate-regression/1.0";
const MESSAGE = "Independent destination snapshot";
type Owner = { siteId: string | null; tenantId: string | null };

// Includes deleted rows: a hidden orphan or a reserved slug is not a clean refusal.
async function counts() {
  return env.DB.prepare(`SELECT (SELECT COUNT(*) FROM sites) AS sites,
    (SELECT COUNT(*) FROM versions) AS versions,
    (SELECT COUNT(*) FROM version_files) AS files`).first<{ sites: number; versions: number; files: number }>();
}

async function snapshot(slug: string) {
  const site = await env.DB.prepare("SELECT * FROM sites WHERE slug = ?").bind(slug).first<Record<string, any>>();
  expect(site, `fixture site ${slug}`).not.toBeNull();
  const versions = (await env.DB.prepare("SELECT * FROM versions WHERE site_id = ? ORDER BY number").bind(site!.id).all()).results;
  const files = (await env.DB.prepare(`SELECT vf.* FROM version_files vf JOIN versions v ON v.id = vf.version_id
    WHERE v.site_id = ? ORDER BY v.number, vf.path`).bind(site!.id).all()).results;
  return { site: site!, versions, files };
}

async function usage() {
  return (await env.DB.prepare("SELECT tenant_id, key, value FROM usage_counters ORDER BY tenant_id, key").all()).results;
}

async function publish(dw: Instance, slug: string, files = FILES) {
  const result = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ slug, files }) });
  expect(result.status, `fixture publish: ${JSON.stringify(result.body)}`).toBe(201);
  return result.body;
}

function duplicate(dw: Instance, source: string, target: string, idempotencyKey?: string) {
  return dw.json(`/api/v1/sites/${source}/duplicate`, {
    key: dw.ownerKey, ...jsonBody({ newSlug: target, message: MESSAGE }),
    headers: { "Content-Type": "application/json", "X-Kofra-Client": CLIENT,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
  });
}

function refusal(result: { status: number; body: any }, status: number, code: string) {
  expect.soft(result.status, JSON.stringify(result.body)).toBe(status);
  expect.soft(result.body.error).toMatchObject({ code, hint: expect.any(String) });
  if (result.body.error) expect(result.body.error.hint.trim().length).toBeGreaterThan(0);
}

async function noOrphan(dw: Instance, source: string, target: string, before: Awaited<ReturnType<typeof counts>>, saved: Awaited<ReturnType<typeof snapshot>>, savedUsage: Awaited<ReturnType<typeof usage>>) {
  expect.soft(await counts(), "no orphan site/version/file rows").toEqual(before);
  expect.soft(await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind(target).first(), "destination name is not retained").toBeNull();
  expect.soft(await snapshot(source), "source metadata and manifest unchanged").toEqual(saved);
  expect.soft(await usage(), "refusal preserves real usage").toEqual(savedUsage);
  const reused = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: target }) });
  expect.soft(reused.status, "refused destination slug is immediately reusable").toBe(201);
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

afterEach(() => { vi.restoreAllMocks(); clearLiveMemoryCache(); });

describe("duplicate committed response reliability", () => {
  it.each([1, 2])("returns and replays complete metadata if destination version reload %i fails", async (failRead) => {
    const dw = await freshInstance();
    const source = "reload-source";
    const target = "reload-copy";
    await publish(dw, source);
    const saved = await snapshot(source);
    const before = (await counts())!;
    const entries = await Promise.all(FILES.map((f) => manifestEntry(f.path, f.content, f.contentType)));
    const expected = entries.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, content_type: f.contentType }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const prepare = env.DB.prepare.bind(env.DB);
    let destinationReads = 0;
    let injected = false;
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!/^\s*SELECT\b[\s\S]*\bFROM\s+versions\b/i.test(sql)) return statement;
      const bind = statement.bind.bind(statement);
      vi.spyOn(statement, "bind").mockImplementation((...values) => {
        const bound = bind(...values);
        const first = bound.first.bind(bound);
        vi.spyOn(bound, "first").mockImplementation(async (columnName?: string) => {
          // Use the real DB to identify ONLY a committed destination read. Neither
          // source/precommit reads nor the fault detector itself are intercepted.
          const copy = await prepare("SELECT id, current_version_id FROM sites WHERE slug = ?").bind(target)
            .first<{ id: string; current_version_id: string | null }>();
          if (copy?.current_version_id && values.some((v) => v === copy.id || v === copy.current_version_id)) {
            destinationReads++;
            if (!injected && destinationReads === failRead) {
              injected = true;
              throw new Error("fixture one-shot committed destination version read failure");
            }
          }
          return Reflect.apply(first, bound, columnName === undefined ? [] : [columnName]);
        });
        return bound;
      });
      return statement;
    });

    const first = await duplicate(dw, source, target, `reload-${failRead}`);
    // A fix may eliminate either or both redundant reads; occurrence is not required.
    vi.restoreAllMocks();
    const retry = await duplicate(dw, source, target, `reload-${failRead}`);
    const copy = await snapshot(target);
    const version = copy.versions[0] as Record<string, any>;
    expect(copy.versions).toHaveLength(1);
    expect.soft(first.status, `initial response (fault injected=${injected}): ${JSON.stringify(first.body)}`).toBe(201);
    expect.soft(retry.status, JSON.stringify(retry.body)).toBe(201);
    const metadata = {
      id: version.id, number: 1, status: "ready", fileCount: 3,
      totalBytes: entries.reduce((n, f) => n + f.size, 0),
      source: "api", client: CLIENT, message: MESSAGE,
      createdAt: new Date(version.created_at).toISOString(), finalizedAt: new Date(version.finalized_at).toISOString(),
    };
    expect(version.created_at).toEqual(expect.any(Number));
    expect(version.finalized_at).toEqual(expect.any(Number));
    expect(version.finalized_at).toBeGreaterThanOrEqual(version.created_at);
    const summary = { id: version.id, number: 1, status: "ready", live: true, fileCount: 3, totalBytes: metadata.totalBytes, message: MESSAGE };
    expect.soft(first.body).toMatchObject({ site: { slug: target, currentVersionId: version.id, currentVersion: metadata }, version: summary });
    expect.soft(retry.body).toMatchObject({ replayed: true, site: { slug: target, currentVersionId: version.id, currentVersion: metadata }, version: summary });
    expect(await counts()).toEqual({ sites: before.sites + 1, versions: before.versions + 1, files: before.files + 3 });
    const copiedManifest = copy.files.map((f: any) => ({ path: f.path, size: f.size, sha256: f.sha256, content_type: f.content_type }));
    expect(copiedManifest).toEqual(expected);
    expect(await snapshot(source)).toEqual(saved);
    clearLiveMemoryCache();
    const listed = await dw.json(`/api/v1/sites/${target}/files`, { key: dw.ownerKey });
    expect(listed.status).toBe(200);
    expect(listed.body.files).toHaveLength(3);
    for (const file of FILES) {
      const entry = listed.body.files.find((f: any) => f.path === file.path);
      expect(entry).toBeDefined();
      const served = await dw.call(entry.rawUrl, { key: dw.ownerKey });
      expect(served.status).toBe(200);
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(new TextEncoder().encode(file.content));
    }
  });
});

const CAPS: { cap: keyof Limits; value: number; status: number; code: string }[] = [
  { cap: "maxFiles", value: 1, status: 400, code: "too_many_files" },
  { cap: "maxFileBytes", value: 4, status: 413, code: "file_too_large" },
  { cap: "maxSiteBytes", value: 4, status: 413, code: "site_too_large" },
];

describe("duplicate destination policy and independent refusal gates", () => {
  it.each(CAPS)("uses actual destination $cap, not permissive source or null preflight limits", async ({ cap, value, status, code }) => {
    let armed = false;
    let sourceId: string;
    const owners: Owner[] = [];
    const names: { siteId: string; slug: string }[] = [];
    const events = sinks();
    const dw = await freshInstance({}, { hooks: events.hooks, adapters: { metering: events.metering, policy: {
      ...defaultPolicy,
      siteNameMutation(_p, input) { names.push(input); return { statements: [] }; },
      limits(_p, owner, dc) {
        if (armed) owners.push({ ...owner });
        return { ...dc.config.limits, ...(armed && owner.siteId !== null && owner.siteId !== sourceId ? { [cap]: value } : {}) };
      },
    } } });
    await publish(dw, "dest-cap-source");
    const saved = await snapshot("dest-cap-source");
    sourceId = saved.site.id;
    const control = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "dest-cap-control" }) });
    expect(control.status).toBe(201);
    armed = true;
    const entries = await Promise.all(FILES.map((f) => manifestEntry(f.path, f.content, f.contentType)));
    const ordinary = await dw.json("/api/v1/sites/dest-cap-control/deploys", { key: dw.ownerKey, ...jsonBody({ files: entries }) });
    refusal(ordinary, status, code);
    expect(owners).toContainEqual({ siteId: (await snapshot("dest-cap-control")).site.id, tenantId: saved.site.tenant_id });
    owners.length = 0;
    events.clear();
    const before = await counts();
    const savedUsage = await usage();
    const result = await duplicate(dw, "dest-cap-source", "dest-cap-copy");
    refusal(result, status, code);
    const allocated = names.find((n) => n.slug === "dest-cap-copy");
    expect.soft(allocated, "allocate a concrete identity before destination-only policy enforcement").toBeDefined();
    if (allocated) expect.soft(owners).toContainEqual({ siteId: allocated.siteId, tenantId: saved.site.tenant_id });
    events.expectNoDeploy();
    await noOrphan(dw, "dest-cap-source", "dest-cap-copy", before, saved, savedUsage);
  });

  it("manifest validation refuses a cap lowered for every owner after source publication", async () => {
    let armed = false;
    const events = sinks();
    const dw = await freshInstance({}, { hooks: events.hooks, adapters: { metering: events.metering, policy: {
      ...defaultPolicy, limits: (_p, _o, dc) => ({ ...dc.config.limits, ...(armed ? { maxFiles: 1 } : {}) }),
    } } });
    await publish(dw, "uniform-cap-source");
    const saved = await snapshot("uniform-cap-source");
    const before = await counts();
    const savedUsage = await usage();
    armed = true;
    events.clear();
    refusal(await duplicate(dw, "uniform-cap-source", "uniform-cap-copy"), 400, "too_many_files");
    events.expectNoDeploy();
    await noOrphan(dw, "uniform-cap-source", "uniform-cap-copy", before, saved, savedUsage);
  });

  it.each(["destination", "all"])("enforces %s storage quota even when a deduplicated copy adds zero bytes", async (scope) => {
    let armed = false;
    let sourceId: string;
    let limit = 0;
    const owners: (SiteOwner | null)[] = [];
    const names: { siteId: string; slug: string }[] = [];
    const events = sinks();
    const dw = await freshInstance({}, { hooks: events.hooks, adapters: { metering: events.metering, policy: {
      ...defaultPolicy,
      siteNameMutation(_p, input) { names.push(input); return { statements: [] }; },
      quota(_p, key, owner) {
        if (!armed || key !== "storage_bytes") return null;
        owners.push(owner && { ...owner });
        // null preflights and the source deliberately remain permissive in the
        // destination case; only the new destination identity has the low quota.
        return scope === "all" || (owner?.siteId != null && owner.siteId !== sourceId) ? limit : null;
      },
    } } });
    await publish(dw, "quota-source");
    // Distinct real existing storage, not a fabricated usage counter.
    await publish(dw, "quota-other", [{ path: "other.txt", content: "existing tenant bytes", contentType: "text/plain" }]);
    const saved = await snapshot("quota-source");
    sourceId = saved.site.id;
    const me = await dw.json("/api/v1/me", { key: dw.ownerKey });
    expect(me.status).toBe(200);
    const used = me.body.usage.storage_bytes;
    expect(used).toBe(FILES.reduce((n, f) => n + new TextEncoder().encode(f.content).length, 0) + 21);
    limit = used - 1;
    const control = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "quota-control" }) });
    expect(control.status).toBe(201);
    armed = true;
    const entries = await Promise.all(FILES.map((f) => manifestEntry(f.path, f.content, f.contentType)));
    refusal(await dw.json("/api/v1/sites/quota-control/deploys", { key: dw.ownerKey, ...jsonBody({ files: entries }) }), 403, "limit_reached");
    owners.length = 0;
    const before = await counts();
    const savedUsage = await usage();
    events.clear();
    refusal(await duplicate(dw, "quota-source", "quota-copy"), 403, "limit_reached");
    if (scope === "destination") {
      const allocated = names.find((n) => n.slug === "quota-copy");
      expect.soft(allocated).toBeDefined();
      if (allocated) expect.soft(owners).toContainEqual({ siteId: allocated.siteId, tenantId: saved.site.tenant_id });
    }
    events.expectNoDeploy();
    await noOrphan(dw, "quota-source", "quota-copy", before, saved, savedUsage);
  });

  it("refuses a real transfer created by the calling owner, rather than failing source authorization", async () => {
    const events = sinks();
    const dw = await transferInstance({}, { hooks: events.hooks, adapters: { metering: events.metering } });
    const transfer = await createTransfer(dw, { slug: "owner-transfer", files: FILES });
    const transferBefore = await getTransfer(dw, transfer);
    const saved = await snapshot(transfer.slug);
    const before = await counts();
    const savedUsage = await usage();
    events.clear();
    refusal(await duplicate(dw, transfer.slug, "transfer-copy"), 409, "transfer_immutable");
    events.expectNoDeploy();
    expect(await getTransfer(dw, transfer)).toEqual(transferBefore);
    await noOrphan(dw, transfer.slug, "transfer-copy", before, saved, savedUsage);
  });

  it("beforeDeploy refusal leaves no destination and no deploy event", async () => {
    let armed = false;
    const events = sinks();
    const dw = await freshInstance({}, { hooks: events.hooks, adapters: { metering: events.metering, policy: {
      ...defaultPolicy,
      beforeDeploy() { if (armed) throw new ApiError(403, "fixture_deploy_refused", "Publication refused.", "Keep the source live."); },
    } } });
    await publish(dw, "hook-refusal-source");
    const saved = await snapshot("hook-refusal-source");
    const before = await counts();
    const savedUsage = await usage();
    events.clear();
    armed = true;
    refusal(await duplicate(dw, "hook-refusal-source", "hook-refusal-copy"), 403, "fixture_deploy_refused");
    events.expectNoDeploy();
    await noOrphan(dw, "hook-refusal-source", "hook-refusal-copy", before, saved, savedUsage);
  });
});

describe("duplicate publication extension contract", () => {
  it("emits exactly one destination deploy hook and meter event, with none on replay", async () => {
    const events = sinks();
    const deployments: unknown[] = [];
    const dw = await freshInstance({}, { hooks: events.hooks, adapters: { metering: events.metering, policy: {
      ...defaultPolicy, beforeDeploy(principal, input) { deployments.push({ principal, input }); },
    } } });
    const source = await publish(dw, "event-source");
    const saved = await snapshot("event-source");
    events.clear();
    deployments.length = 0;
    const first = await duplicate(dw, "event-source", "event-copy", "event-once");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const site = (await snapshot("event-copy")).site;
    const version = first.body.version;
    const bytes = FILES.reduce((n, f) => n + new TextEncoder().encode(f.content).length, 0);
    expect(version.id).not.toBe(source.version.id);
    expect(site.id).not.toBe(saved.site.id);
    const me = await dw.json("/api/v1/me", { key: dw.ownerKey });
    expect(me.status).toBe(200);
    const common = { siteId: site.id, tenantId: saved.site.tenant_id, versionId: version.id, fileCount: 3, totalBytes: bytes };
    expect(events.published).toEqual([{
      kind: "deploy", site: { id: site.id, slug: "event-copy", tenantId: saved.site.tenant_id, url: `${ORIGIN}/s/event-copy/` },
      version: { id: version.id, number: 1, fileCount: 3, totalBytes: bytes },
      principal: expect.objectContaining({ kind: "member", role: "owner", tenantId: saved.site.tenant_id,
        memberId: (saved.versions[0] as Record<string, any>).created_by }), at: expect.any(Number),
    }]);
    expect(deployments).toEqual([{ principal: events.published[0]!.principal,
      input: { siteId: site.id, tenantId: saved.site.tenant_id, fileCount: 3, totalBytes: bytes, newBytes: 0 } }]);
    expect(events.metered.filter((e) => e.type === "deploy")).toEqual([{ type: "deploy", ...common, at: expect.any(Number) }]);
    const replay = await duplicate(dw, "event-source", "event-copy", "event-once");
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ replayed: true, site: { slug: "event-copy", currentVersionId: version.id }, version: { id: version.id } });
    expect(events.published).toHaveLength(1);
    expect(events.metered.filter((e) => e.type === "deploy")).toHaveLength(1);
    expect(deployments).toHaveLength(1);
    expect(await snapshot("event-source")).toEqual(saved);
  });
});
