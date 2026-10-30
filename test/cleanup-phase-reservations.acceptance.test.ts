/**
 * Cross-phase cleanup reservations, with real emulated D1/R2/KV. Raising only
 * anonymous expiry from 50 to 200 must exceed the 1000-call invocation budget
 * when the other slices are full. Setup and observations are never counted;
 * only multipart aborts use a double, so no real storage quota is exercised.
 */
import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { runCleanup, sha256Hex } from "@dropway/core";
import { freshInstance, jsonBody } from "./helpers";
import { context, DAY, MiB } from "./resumable-upload.helpers";

afterEach(() => vi.restoreAllMocks());

function bindingCounter() {
  let enabled = false;
  let calls = { d1: 0, r2: 0, kv: 0 };
  const count = (binding: keyof typeof calls) => { if (enabled) calls[binding]++; };
  const prepare = env.DB.prepare.bind(env.DB);
  const wrap = (statement: any): any => {
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation(((...values: unknown[]) => wrap(bind(...values))) as never);
    for (const method of ["run", "all", "first", "raw"] as const) {
      const original = statement[method].bind(statement);
      vi.spyOn(statement, method).mockImplementation((async (...args: unknown[]) => {
        count("d1");
        return original(...args);
      }) as never);
    }
    return statement;
  };
  vi.spyOn(env.DB, "prepare").mockImplementation(((sql: string) => wrap(prepare(sql))) as never);
  // A batch is one binding call, regardless of how many statements it holds.
  for (const method of ["batch", "exec"] as const) {
    const original = (env.DB[method] as (...args: any[]) => unknown).bind(env.DB);
    vi.spyOn(env.DB, method).mockImplementation((async (...args: unknown[]) => {
      count("d1");
      return original(...args);
    }) as never);
  }
  for (const method of ["get", "head", "put", "delete", "list", "createMultipartUpload"] as const) {
    const original = (env.FILES[method] as (...args: any[]) => unknown).bind(env.FILES);
    vi.spyOn(env.FILES, method).mockImplementation((async (...args: unknown[]) => {
      count("r2");
      return original(...args);
    }) as never);
  }
  vi.spyOn(env.FILES, "resumeMultipartUpload").mockImplementation((key, uploadId) => ({
    key, uploadId,
    async uploadPart() { throw new Error("cleanup fixture accepts no part writes"); },
    async complete() { throw new Error("cleanup fixture never completes an upload"); },
    async abort() { count("r2"); },
  }));
  for (const method of ["get", "getWithMetadata", "put", "delete", "list"] as const) {
    const original = (env.CACHE[method] as (...args: any[]) => unknown).bind(env.CACHE);
    vi.spyOn(env.CACHE, method).mockImplementation((async (...args: unknown[]) => {
      count("kv");
      return original(...args);
    }) as never);
  }
  return {
    async during<T>(fn: () => Promise<T>) {
      calls = { d1: 0, r2: 0, kv: 0 };
      enabled = true;
      try {
        const result = await fn();
        return { result, calls: { ...calls }, total: calls.d1 + calls.r2 + calls.kv };
      } finally { enabled = false; }
    },
  };
}

it("reserves cleanup capacity across saturated phases, drains accounted leftovers, and preserves live neighbors", async () => {
  const dw = await freshInstance();
  const now = Date.now() + 3 * DAY;
  const old = now - 2 * DAY;
  const liveText = "live cleanup neighbor";
  const live = await dw.json("/api/v1/publish", {
    ...jsonBody({ site: "reservation-live", files: [{ path: "index.txt", content: liveText }] }), key: dw.ownerKey,
  });
  expect(live.status, JSON.stringify(live.body)).toBe(201);
  const owner = (await env.DB.prepare("SELECT id, tenant_id FROM members LIMIT 1").first<{ id: string; tenant_id: string }>())!;
  const statements: D1PreparedStatement[] = [];
  const addSite = (id: string, options: {
    tenantId?: string | null; mode?: "site" | "transfer"; expiresAt?: number; deletedAt?: number;
  } = {}) => {
    const tenant = options.tenantId === undefined ? owner.tenant_id : options.tenantId;
    statements.push(env.DB.prepare(
      "INSERT INTO sites (id, slug, tenant_id, created_by, mode, claim_token_hash, expires_at, deleted_at, deleted_slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, options.deletedAt ? `~deleted~${id}` : id, tenant, tenant ? owner.id : null,
      options.mode ?? "site", tenant ? null : `claim-${id}`, options.expiresAt ?? null,
      options.deletedAt ?? null, options.deletedAt ? id : null, old, old));
  };
  const addVersion = (id: string, siteId: string, number: number, status: "pending" | "ready", sha256: string, createdAt = old) => {
    statements.push(env.DB.prepare(
      "INSERT INTO versions (id, site_id, number, status, file_count, total_bytes, manifest_hash, source, created_at) VALUES (?, ?, ?, ?, 1, 1, ?, 'json', ?)",
    ).bind(id, siteId, number, status, sha256, createdAt));
    statements.push(env.DB.prepare(
      "INSERT INTO version_files (version_id, path, sha256, size, content_type) VALUES (?, 'data.txt', ?, 1, 'text/plain')",
    ).bind(id, sha256));
  };
  const addTransfer = (id: string, expiresAt: number, expiredAt: number | null = null, held = false) => {
    const siteId = `site-${id}`;
    addSite(siteId, { mode: "transfer" });
    statements.push(env.DB.prepare(
      "INSERT INTO transfers (id, site_id, tenant_id, member_id, slug, expires_at, expired_at, legal_hold, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, siteId, owner.tenant_id, owner.id, siteId, expiresAt, expiredAt, held ? 1 : 0, old));
    return siteId;
  };
  const youngSha = await sha256Hex(new Uint8Array([5]));
  const heldSha = await sha256Hex(new Uint8Array([6]));
  for (const [sha, createdAt] of [[youngSha, now], [heldSha, old]] as const) {
    statements.push(env.DB.prepare("INSERT INTO blobs (sha256, size, created_at) VALUES (?, 1, ?)").bind(sha, createdAt));
    statements.push(env.DB.prepare("INSERT INTO blob_scopes (scope, sha256, created_at) VALUES (?, ?, ?)").bind(`t:${owner.tenant_id}`, sha, old));
  }

  for (let i = 0; i < 201; i++) addTransfer(`reservation-transfer-expire-${i}`, now - 1);
  for (let i = 0; i < 51; i++) {
    const site = addTransfer(`reservation-transfer-purge-${i}`, old, old);
    addVersion(`reservation-transfer-version-${i}`, site, 1, "ready", youngSha);
  }
  for (let i = 0; i < 201; i++) addSite(`reservation-anonymous-${i}`, { tenantId: null, expiresAt: now - 1 });
  for (let i = 0; i < 26; i++) {
    const id = `reservation-deleted-${i}`;
    addSite(id, { deletedAt: old });
    addVersion(`reservation-deleted-version-${i}`, id, 1, "ready", youngSha);
  }
  const heldSite = addTransfer("reservation-held-transfer", old, old, true);
  addVersion("reservation-held-version", heldSite, 1, "pending", heldSha);
  addTransfer("reservation-live-transfer", now + DAY);
  addSite("reservation-pending-host");
  for (let i = 0; i < 51; i++) addVersion(`reservation-abandoned-${i}`, "reservation-pending-host", i + 1, "pending", youngSha);
  addVersion("reservation-future-pending", "reservation-pending-host", 1000, "pending", youngSha, now);

  const addSession = (id: string, expiresAt: number) => statements.push(env.DB.prepare(
    "INSERT INTO upload_sessions (id, version_id, site_id, sha256, size, part_size, part_count, r2_key, r2_upload_id, status, staged, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, 'active', 0, ?, ?)",
  ).bind(id, `version-${id}`, "reservation-pending-host", "a".repeat(64), 10 * MiB, `uploads/${id}`, `handle-${id}`, old, expiresAt));
  for (let i = 0; i < 101; i++) addSession(`reservation-expired-upload-${i}`, now - 1);
  addSession("reservation-live-upload", now + DAY);

  // Tiny physical objects; these synthetic inventory identifiers are not used
  // as content-integrity fixtures. All cleanup reads/writes still reach R2.
  const orphanPrefix = "e".repeat(60);
  const orphanShas = Array.from({ length: 101 }, (_, i) => orphanPrefix + i.toString(16).padStart(4, "0"));
  for (const sha of orphanShas) {
    statements.push(env.DB.prepare("INSERT INTO blobs (sha256, size, created_at) VALUES (?, 1, ?)").bind(sha, old));
    statements.push(env.DB.prepare("INSERT INTO blob_scopes (scope, sha256, created_at) VALUES (?, ?, ?)").bind(`t:${owner.tenant_id}`, sha, old));
  }
  const addKey = (key: string, expiresAt: number, state: "pending" | "done") => statements.push(env.DB.prepare(
    "INSERT INTO idempotency_keys (key_hash, input_hash, owner_token, state, result_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(key, `input-${key}`, `owner-${key}`, state, state === "done" ? '{"retained":true}' : null, expiresAt));
  const addTombstone = (id: string, until: number, releasedAt: number | null = null) => statements.push(env.DB.prepare(
    "INSERT INTO slug_tombstones (id, slug, site_id, tenant_id, hold_until, reason, created_at, released_at) VALUES (?, ?, ?, ?, ?, 'deleted', ?, ?)",
  ).bind(id, id, "reservation-pending-host", owner.tenant_id, until, old, releasedAt));
  const addRedirect = (slug: string, until: number) => statements.push(env.DB.prepare(
    "INSERT INTO slug_redirects (slug, site_id, hold_until, created_at) VALUES (?, 'reservation-pending-host', ?, ?)",
  ).bind(slug, until, old));
  for (let i = 0; i < 501; i++) {
    addKey(`reservation-expired-key-${i}`, now - 1, i % 2 ? "done" : "pending");
    addTombstone(`reservation-expired-hold-${i}`, now - 1);
    addRedirect(`reservation-expired-redirect-${i}`, now - 1);
  }
  addKey("reservation-live-key", now + DAY, "done");
  addKey("reservation-pending-key", now + DAY, "pending");
  addTombstone("reservation-live-hold", now + DAY);
  addTombstone("reservation-released-hold", now - 1, old);
  addRedirect("reservation-live-redirect", now + DAY);
  for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
  await env.FILES.put(`blobs/${youngSha}`, new Uint8Array([5]));
  await env.FILES.put(`blobs/${heldSha}`, new Uint8Array([6]));
  for (const sha of orphanShas) await env.FILES.put(`blobs/${sha}`, new Uint8Array([7]));
  for (let i = 0; i < 201; i++) await env.CACHE.put(`live:reservation-anonymous-${i}`, "expired-cache-fixture");
  await env.CACHE.put("live:reservation-live-neighbor", "retained-cache-fixture");

  const count = async (sql: string, ...values: unknown[]) =>
    (await env.DB.prepare(sql).bind(...values).first<{ n: number }>())!.n;
  const remaining = async () => ({
    expiredTransfers: await count("SELECT COUNT(*) AS n FROM transfers WHERE id LIKE 'reservation-transfer-expire-%' AND expired_at IS NULL"),
    purgedTransfers: await count("SELECT COUNT(*) AS n FROM transfers WHERE id LIKE 'reservation-transfer-purge-%' AND purged_at IS NULL"),
    expiredSites: await count("SELECT COUNT(*) AS n FROM sites WHERE id LIKE 'reservation-anonymous-%' AND deleted_at IS NULL"),
    purgedSites: await count("SELECT COUNT(*) AS n FROM sites WHERE id LIKE 'reservation-deleted-%'"),
    expiredUploads: await count("SELECT COUNT(*) AS n FROM upload_sessions WHERE id LIKE 'reservation-expired-upload-%'"),
    abandonedDeploys: await count("SELECT COUNT(*) AS n FROM versions WHERE id LIKE 'reservation-abandoned-%'"),
    deletedBlobs: await count("SELECT COUNT(*) AS n FROM blobs WHERE sha256 >= ? AND sha256 <= ?", orphanShas[0], orphanShas.at(-1)),
    keys: await count("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key_hash LIKE 'reservation-expired-key-%'"),
    holds: await count("SELECT COUNT(*) AS n FROM slug_tombstones WHERE id LIKE 'reservation-expired-hold-%'"),
    redirects: await count("SELECT COUNT(*) AS n FROM slug_redirects WHERE slug LIKE 'reservation-expired-redirect-%'"),
  });
  const neighbors = async () => ({
    transfer: await env.DB.prepare("SELECT * FROM transfers WHERE id IN ('reservation-held-transfer', 'reservation-live-transfer') ORDER BY id").all(),
    versions: await env.DB.prepare("SELECT * FROM versions WHERE id IN ('reservation-held-version', 'reservation-future-pending') ORDER BY id").all(),
    heldFile: await env.DB.prepare("SELECT * FROM version_files WHERE version_id = 'reservation-held-version'").all(),
    upload: await env.DB.prepare("SELECT * FROM upload_sessions WHERE id = 'reservation-live-upload'").first(),
    keys: await env.DB.prepare("SELECT * FROM idempotency_keys WHERE key_hash IN ('reservation-live-key', 'reservation-pending-key') ORDER BY key_hash").all(),
    holds: await env.DB.prepare("SELECT * FROM slug_tombstones WHERE id IN ('reservation-live-hold', 'reservation-released-hold') ORDER BY id").all(),
    redirect: await env.DB.prepare("SELECT * FROM slug_redirects WHERE slug = 'reservation-live-redirect'").first(),
  });
  // Compare rows, not D1 execution timing metadata, across successive calls.
  const neighborRows = async () => {
    const snapshot = await neighbors();
    return {
      ...snapshot, transfer: snapshot.transfer.results, versions: snapshot.versions.results,
      heldFile: snapshot.heldFile.results, keys: snapshot.keys.results, holds: snapshot.holds.results,
    };
  };
  const untouched = await neighborRows();
  let before = await remaining();
  expect(before).toEqual({
    expiredTransfers: 201, purgedTransfers: 51, expiredSites: 201, purgedSites: 26,
    expiredUploads: 101, abandonedDeploys: 51, deletedBlobs: 101, keys: 501, holds: 501, redirects: 501,
  });

  // Positive progress in each nonempty cohort implies this fixture-derived
  // bound, without requiring a particular rows-per-slice implementation.
  const maxTicks = Math.max(...Object.values(before));
  const counter = bindingCounter();
  for (let tick = 0; tick < maxTicks && Object.values(before).some((n) => n > 0); tick++) {
    const measured = await counter.during(() => context(dw, (dc) => runCleanup(dc, now)));
    expect(measured.total, `cleanup tick ${tick}: D1=${measured.calls.d1}, R2=${measured.calls.r2}, KV=${measured.calls.kv}; setup/observations excluded, D1 batch counted once`).toBeLessThanOrEqual(1000);
    const after = await remaining();
    for (const phase of Object.keys(measured.result) as Array<keyof typeof measured.result>) {
      expect(before[phase] - after[phase], `${phase} report must match durable row progress`).toBe(measured.result[phase]);
    }
    for (const phase of Object.keys(before) as Array<keyof typeof before>) {
      if (before[phase] > 0) expect(after[phase], `${phase} must progress even while other cleanup phases are saturated`).toBeLessThan(before[phase]);
      if (tick === 0) expect(after[phase], `${phase} must retain its over-slice backlog for later invocations`).toBeGreaterThan(0);
    }
    if (tick === 0) {
      // Anonymous expiry clears credentials/cache only for rows it retired.
      const rows = await env.DB.prepare("SELECT id, deleted_at, claim_token_hash FROM sites WHERE id LIKE 'reservation-anonymous-%'")
        .all<{ id: string; deleted_at: number | null; claim_token_hash: string | null }>();
      for (const row of rows.results) {
        expect(row.claim_token_hash).toBe(row.deleted_at === null ? `claim-${row.id}` : null);
        expect(await env.CACHE.get(`live:${row.id}`)).toBe(row.deleted_at === null ? "expired-cache-fixture" : null);
      }
      // Remaining physical bytes still have both inventory and ownership.
      let inventoried = 0;
      for (const sha of orphanShas) {
        const present = await env.DB.prepare("SELECT sha256 FROM blobs WHERE sha256 = ?").bind(sha).first();
        expect(Boolean(await env.FILES.head(`blobs/${sha}`))).toBe(Boolean(present));
        expect(await count("SELECT COUNT(*) AS n FROM blob_scopes WHERE sha256 = ?", sha)).toBe(present ? 1 : 0);
        if (present) inventoried++;
      }
      expect(inventoried).toBe(after.deletedBlobs);
    }
    expect(await neighborRows()).toEqual(untouched);
    expect(await env.CACHE.get("live:reservation-live-neighbor")).toBe("retained-cache-fixture");
    expect(new Uint8Array(await (await env.FILES.get(`blobs/${heldSha}`))!.arrayBuffer())).toEqual(new Uint8Array([6]));
    const readback = await dw.call("/s/reservation-live/index.txt?raw=1");
    expect(readback.status).toBe(200);
    expect(await readback.text()).toBe(liveText);
    before = after;
  }
  for (const [phase, left] of Object.entries(before)) expect(left, `${phase} must drain within bounded subsequent ticks`).toBe(0);
  expect(await count("SELECT COUNT(*) AS n FROM sites WHERE id LIKE 'reservation-anonymous-%' AND deleted_at = ?", now)).toBe(201);
  expect(await count("SELECT COUNT(*) AS n FROM version_files WHERE version_id LIKE 'reservation-transfer-version-%' OR version_id LIKE 'reservation-deleted-version-%' OR version_id LIKE 'reservation-abandoned-%'")).toBe(0);
  for (const sha of orphanShas) expect(await env.FILES.head(`blobs/${sha}`)).toBeNull();
}, 180_000);
