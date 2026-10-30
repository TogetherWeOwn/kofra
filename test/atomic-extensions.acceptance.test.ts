import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  ApiError, claimSite, clearLiveMemoryCache, createSite, createTenant, createTenantWithOwner,
  defaultPolicy, deleteSite, insertMember, refreshLive, renameSite, setupInstance, sha256Hex,
  type CreateTenantWithOwnerInput, type CreateTenantWithOwnerOptions, type DropwayContext, type MemberRow,
  type Principal, type SiteNameMutation, type TenantRow,
} from "@dropway/core";
import { BOOTSTRAP, ORIGIN, form, freshInstance, jsonBody } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import {
  allocateExternal, asOwner, audit, auditRows, count, deferred, expectApiError, extensionSchema,
  harness, mapNameConflict, mustReachPreparation, outcome, policy, receipt, receiptRows, site,
  type PrepareName,
} from "./atomic-extensions.helpers";

afterEach(() => vi.restoreAllMocks());

type OwnerRows = { tenant: Readonly<TenantRow>; owner: Readonly<MemberRow> };

const empty: PrepareName = () => ({ statements: [] });
const refusal = () => new ApiError(451, "fixture_refused", "This mutation was refused.", "Use a permitted name.");

async function publish(dw: Awaited<ReturnType<typeof harness>>["dw"], slug: string, content = "unchanged-content") {
  const r = await dw.json("/api/v1/publish", {
    method: "POST", key: dw.ownerKey, body: form({ "index.txt": content }, { slug }),
  });
  expect(r.status).toBe(201);
  return (await site(slug))!;
}

async function coreSnapshot() {
  return {
    tenants: (await env.DB.prepare("SELECT * FROM tenants ORDER BY id").all<TenantRow>()).results,
    members: (await env.DB.prepare("SELECT * FROM members ORDER BY id").all<MemberRow>()).results,
    profiles: (await env.DB.prepare("SELECT * FROM fixture_profiles ORDER BY tenant_id").all()).results,
  };
}

async function siteMutationSnapshot() {
  const tables = [
    ["tenants", "id"], ["members", "id"], ["api_keys", "id"], ["folders", "id"],
    ["sites", "id"], ["versions", "id"], ["version_files", "version_id, path"],
    ["blobs", "sha256"], ["blob_scopes", "scope, sha256"],
  ] as const;
  return Object.fromEntries(await Promise.all(tables.map(async ([table, order]) => [
    table, (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()).results,
  ])));
}

async function tenantFixture() {
  const h = await harness();
  await extensionSchema();
  await env.DB.prepare("INSERT INTO fixture_profiles (tenant_id, owner_id, label) VALUES (?, ?, 'sentinel')")
    .bind(h.principal.tenantId, h.principal.memberId).run();
  return { ...h, before: await coreSnapshot() };
}

describe("atomic extension fixture controls", () => {
  it("uses real D1 rollback and both SQL-enforced allocation directions", async () => {
    const h = await harness();
    await extensionSchema();
    const first = await createSite(h.dc, h.principal, { slug: "fixture-first" });
    const candidate: SiteNameMutation = {
      operation: "rename", siteId: first.site.id, tenantId: h.principal.tenantId,
      slug: "fixture-next", previousSlug: "fixture-first",
    };
    // Receipt SQL must see the core mutation, never only the old name.
    await expect(env.DB.batch(receipt(h.dc, candidate).statements.slice())).rejects.toThrow("fixture_core_not_visible");
    expect(await count("fixture_audit")).toBe(0);
    await allocateExternal(candidate.slug);
    await expect(env.DB.batch([
      env.DB.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(candidate.slug, candidate.siteId),
      ...receipt(h.dc, candidate).statements,
    ])).rejects.toThrow("fixture_name_conflict");
    expect(await site("fixture-first")).toEqual({ deleted_slug: null, ...first.site });
    expect(await site(candidate.slug)).toBeNull();
    expect(await receiptRows()).toEqual([]);
    expect(await auditRows()).toEqual(["external:fixture-next"]);
    await expect(allocateExternal("fixture-first")).rejects.toThrow("fixture_name_conflict");
    expect(await count("fixture_external_names")).toBe(1);
    expect(await auditRows()).toEqual(["external:fixture-next"]);
    await h.flush();
  });

  it("a late constraint rolls back earlier fixture writes in an actual batch", async () => {
    const h = await harness();
    await extensionSchema();
    const batch = vi.spyOn(h.dc.env.DB, "batch");
    await expect(env.DB.batch([audit(h.dc, "rolled-back"), env.DB.prepare("INSERT INTO fixture_refusal VALUES (0)")]))
      .rejects.toThrow("CHECK constraint failed");
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await count("fixture_audit")).toBe(0);
    expect(await count("sites")).toBe(0);
  });
});

describe("site-name mutation compatibility and ordering", () => {
  it("unconfigured create, rename and single-tenant setup keep their existing results", async () => {
    const h = await harness();
    expect(await count("tenants")).toBe(1);
    expect(await count("members")).toBe(1);
    const created = await createSite(h.dc, h.principal, { slug: "default-name", title: "Title", spa: true });
    expect(created.claimToken).toBeNull();
    expect(created.site).toMatchObject({ slug: "default-name", title: "Title", spa: 1, tenant_id: h.principal.tenantId });
    const renamed = await renameSite(h.dc, h.principal, created.site.id, "default-next");
    expect(renamed).toMatchObject({ renamed: true, oldSlug: "default-name", site: { id: created.site.id, slug: "default-next" } });
    expect(await site("default-name")).toBeNull();
    await expect(setupInstance(h.dc, { kind: "bootstrap", ip: "192.0.2.1" }, {})).rejects.toMatchObject({ status: 409, code: "already_set_up" });
    await expect(setupInstance(h.dc, h.principal, {})).rejects.toMatchObject({ status: 403, code: "bootstrap_key_required" });
    await h.flush();
    expect(h.events.filter((e) => e.type === "site_created")).toHaveLength(1);
  });

  it("preflight -> beforeInsert -> per-candidate callback; canonical inputs have no secrets", async () => {
    const order: string[] = [];
    const seen: SiteNameMutation[] = [];
    const dw = await freshInstance({}, { adapters: { policy: {
      ...policy(async (p, input, dc) => {
        order.push("candidate");
        seen.push({ ...input });
        expect(p.kind).toBe("member");
        expect(dc.env.DB).toBe(env.DB);
        expect(Object.keys(input).sort()).toEqual(["operation", "previousSlug", "siteId", "slug", "tenantId"]);
        expect(await site(input.slug)).toBeNull();
        return receipt(dc, input);
      }),
      beforeCreateSite(_p, input) { order.push("preflight"); expect(input.slug).toBe("canonical-name"); },
    } } });
    await extensionSchema();
    const out = await asOwner(dw, (dc, p) => createSite(dc, p,
      { slug: "  CANONICAL-Name  ", password: "fixture-password", description: "kept", renderMarkdown: false, crossOriginIsolation: true },
      { beforeInsert: () => { order.push("beforeInsert"); } },
    ));
    expect(order).toEqual(["preflight", "beforeInsert", "candidate"]);
    expect(seen).toEqual([{
      operation: "create", siteId: out.site.id, tenantId: out.site.tenant_id,
      slug: "canonical-name", previousSlug: null,
    }]);
    expect(out.site).toMatchObject({ description: "kept", render_markdown: 0, cross_origin_isolation: 1 });
    expect(out.site.password_hash).toBeTruthy();
    expect(out.site.password_hash).not.toBe("fixture-password");
    expect(await receiptRows()).toEqual([{ site_id: out.site.id, slug: out.site.slug }]);
  });

  it.each([false, true])("extension statements=%s successful create/rename use exactly one core batch each", async (withStatements) => {
    const prepare = vi.fn<PrepareName>((_p, input, dc) => withStatements ? receipt(dc, input) : { statements: [] });
    const h = await harness(prepare);
    await extensionSchema();
    const batch = vi.spyOn(h.dc.env.DB, "batch");
    const created = await createSite(h.dc, h.principal, { slug: "batch-source" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledTimes(1);
    batch.mockClear();
    prepare.mockClear();
    const renamed = await renameSite(h.dc, h.principal, created.site.id, "batch-target");
    expect(renamed.site.slug).toBe("batch-target");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await count("fixture_receipts")).toBe(withStatements ? 2 : 0);
    await h.flush();
    expect(h.events.filter((e) => e.type === "site_created")).toHaveLength(1);
  });

  it("rename receives exact loaded identity and previous name; canonical no-op skips preparation", async () => {
    const prepare = vi.fn<PrepareName>((_p, input, dc) => receipt(dc, input));
    const h = await harness(prepare);
    await extensionSchema();
    const original = await createSite(h.dc, h.principal, { slug: "rename-input" });
    prepare.mockClear();
    const noOp = await renameSite(h.dc, h.principal, original.site.id, " RENAME-INPUT ");
    expect(noOp).toMatchObject({ renamed: false, oldSlug: "rename-input", site: original.site });
    expect(prepare).not.toHaveBeenCalled();
    const out = await renameSite(h.dc, h.principal, original.site.id, " RENAME-OUTPUT ");
    expect(prepare).toHaveBeenCalledExactlyOnceWith(h.principal, {
      operation: "rename", siteId: original.site.id, tenantId: original.site.tenant_id,
      slug: "rename-output", previousSlug: "rename-input",
    }, h.dc);
    expect(out.site.id).toBe(original.site.id);
    await h.flush();
  });

  it.each(["create", "rename"] as const)("%s authorization, scope, isolation and validation failures never prepare", async (operation) => {
    const prepare = vi.fn<PrepareName>(empty);
    const h = await harness(prepare);
    const original = await createSite(h.dc, h.principal, { slug: "guard-source" });
    prepare.mockClear();
    const denied: Principal[] = [
      { kind: "anonymous", ip: "192.0.2.3" }, { kind: "bootstrap", ip: "192.0.2.4" },
      { kind: "claim", siteId: original.site.id, ip: "192.0.2.5" },
      { ...h.principal, scopes: ["sites:read"] },
      { ...h.principal, siteId: "site_other" },
      ...(operation === "rename" ? [
        { ...h.principal, scopes: ["sites:write"] as const },
        { ...h.principal, tenantId: "ten_foreign" },
      ] : []),
    ];
    for (const p of denied) {
      const result = await outcome(operation === "create"
        ? createSite(h.dc, p, { slug: "guard-target" })
        : renameSite(h.dc, p, original.site.id, "guard-target"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(ApiError);
    }
    const invalid = await outcome(operation === "create"
      ? createSite(h.dc, h.principal, { slug: "invalid--name" })
      : renameSite(h.dc, h.principal, original.site.id, "invalid--name"));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expectApiError(invalid.error, 400, "invalid_slug");
    expect(prepare).not.toHaveBeenCalled();
    expect(await count("sites")).toBe(1);
    await h.flush();
  });

  it("invalid REST identity never reaches the new callback", async () => {
    const prepare = vi.fn<PrepareName>(empty);
    const dw = await freshInstance({}, { adapters: { policy: policy(prepare) } });
    const denied = await dw.json("/api/v1/sites", { key: "dw_not_a_valid_key", ...jsonBody({ slug: "identity-denied" }) });
    expect(denied.status).toBe(401);
    expect(prepare).not.toHaveBeenCalled();
    expect(await count("sites")).toBe(0);
  });

  it.each(["preflight", "beforeInsert"] as const)("%s refusal precedes candidate preparation", async (where) => {
    const prepare = vi.fn<PrepareName>(empty);
    const dw = await freshInstance({}, { adapters: { policy: {
      ...policy(prepare), beforeCreateSite() { if (where === "preflight") throw refusal(); },
    } } });
    const result = await outcome(asOwner(dw, (dc, p) => createSite(dc, p, {}, {
      beforeInsert() { if (where === "beforeInsert") throw refusal(); },
    })));
    expect(result.ok).toBe(false);
    if (!result.ok) expectApiError(result.error, 451, "fixture_refused", "Use a permitted name.");
    expect(prepare).not.toHaveBeenCalled();
    expect(await count("sites")).toBe(0);
  });

  it("legacy preflight slug_taken is not newly retried", async () => {
    const prepare = vi.fn<PrepareName>(empty);
    const legacy = vi.fn(() => { throw new ApiError(409, "slug_taken", "Legacy refusal."); });
    const dw = await freshInstance({}, { adapters: { policy: { ...policy(prepare), beforeCreateSite: legacy } } });
    const result = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({}) });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("slug_taken");
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(await count("sites")).toBe(0);
  });
});

describe("refusal through shared services, REST and MCP", () => {
  it.each(["create", "rename"] as const)("direct %s preserves the exact callback ApiError without effects", async (operation) => {
    let deny = false;
    const error = refusal();
    const prepare = vi.fn<PrepareName>(() => { if (deny) throw error; return { statements: [] }; });
    const h = await harness(prepare);
    await extensionSchema();
    const original = operation === "rename" ? (await createSite(h.dc, h.principal, { slug: "error-source" })).site : null;
    await h.flush();
    h.events.length = 0;
    prepare.mockClear();
    deny = true;
    const result = await outcome(operation === "create" ? createSite(h.dc, h.principal, { slug: "error-target" })
      : renameSite(h.dc, h.principal, original!.id, "error-target"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await site("error-target")).toBeNull();
    if (original) expect(await site(original.slug)).toEqual({ deleted_slug: null, ...original });
    expect(await count("fixture_audit")).toBe(0);
    await h.flush();
    expect(h.events).toEqual([]);
  });

  it.each([
    { surface: "REST", operation: "create" }, { surface: "REST", operation: "rename" },
    { surface: "MCP", operation: "create" }, { surface: "MCP", operation: "rename" },
  ] as const)("$surface $operation preserves refusal code/hint and leaves no new rows/events", async ({ surface, operation }) => {
    let deny = false;
    const seen: SiteNameMutation[] = [];
    const h = await harness((_p, input) => {
      seen.push({ ...input });
      if (deny) throw refusal();
      return { statements: [] };
    });
    await extensionSchema();
    const original = await publish(h.dw, "surface-source");
    h.events.length = 0;
    seen.length = 0;
    deny = true;
    if (surface === "REST") {
      const r = operation === "create"
        ? await h.dw.json("/api/v1/sites", { key: h.dw.ownerKey, ...jsonBody({ slug: " SURFACE-CREATE " }) })
        : await h.dw.json("/api/v1/sites/surface-source/rename", { key: h.dw.ownerKey, ...jsonBody({ newSlug: " SURFACE-RENAME " }) });
      expect(r.status).toBe(451);
      expect(r.body.error).toMatchObject({ code: "fixture_refused", message: "This mutation was refused.", hint: "Use a permitted name." });
    } else {
      const mcp = await connectMcp(h.dw, h.dw.ownerKey);
      try {
        const r = operation === "create"
          ? await mcp.call("create_site", { slug: " SURFACE-CREATE " })
          : await mcp.call("rename_site", { site: original.id, newSlug: " SURFACE-RENAME " });
        // MCP tool errors carry isError/code/hint, not an HTTP status field.
        expect(r.isError).toBe(true);
        expect(r.data.error).toMatchObject({ code: "fixture_refused", message: "This mutation was refused.", hint: "Use a permitted name." });
      } finally { await mcp.client.close(); }
    }
    expect(seen).toEqual([operation === "create"
      ? { operation: "create", siteId: expect.any(String), tenantId: original.tenant_id, slug: "surface-create", previousSlug: null }
      : { operation: "rename", siteId: original.id, tenantId: original.tenant_id, slug: "surface-rename", previousSlug: original.slug },
    ]);
    expect(await count("sites")).toBe(1);
    expect(await site(original.slug)).toEqual({ deleted_slug: null, ...original });
    expect(await receiptRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it.each(["create", "rename"] as const)("%s late extension constraint rolls back core and every earlier statement", async (operation) => {
    let deny = false;
    const mapped = new ApiError(403, "fixture_sql_refused", "SQL refused.", "Keep the original name.");
    const h = await harness((_p, input, dc) => ({
      statements: [...receipt(dc, input).statements, ...(deny ? [dc.env.DB.prepare("INSERT INTO fixture_refusal VALUES (0)")] : [])],
      mapError: (error: unknown) => String(error).includes("CHECK constraint failed") ? mapped : undefined,
    }));
    await extensionSchema();
    const original = operation === "rename" ? (await createSite(h.dc, h.principal, { slug: "sql-source" })).site : null;
    await h.flush();
    h.events.length = 0;
    const beforeReceipts = await receiptRows();
    const beforeAudit = await auditRows();
    deny = true;
    const batch = vi.spyOn(h.dc.env.DB, "batch");
    const result = await outcome(operation === "create" ? createSite(h.dc, h.principal, { slug: "sql-target" })
      : renameSite(h.dc, h.principal, original!.id, "sql-target"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(mapped);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await site("sql-target")).toBeNull();
    if (original) expect(await site(original.slug)).toEqual({ deleted_slug: null, ...original });
    expect(await count("sites")).toBe(original ? 1 : 0);
    expect(await receiptRows()).toEqual(beforeReceipts);
    expect(await auditRows()).toEqual(beforeAudit);
    await h.flush();
    expect(h.events).toEqual([]);
  });

  it.each(["create", "rename", "generated"] as const)("%s unrelated UNIQUE failure is neither renamed slug_taken nor retried", async (operation) => {
    let deny = false;
    const mappedErrors: unknown[] = [];
    const prepare = vi.fn<PrepareName>((_p, input, dc) => ({
      statements: [...receipt(dc, input).statements, ...(deny ? [dc.env.DB.prepare("INSERT INTO fixture_unique VALUES ('sentinel')")] : [])],
      mapError(error: unknown) { mappedErrors.push(error); return undefined; },
    }));
    const h = await harness(prepare);
    await extensionSchema();
    const original = operation === "rename" ? (await createSite(h.dc, h.principal, { slug: "unique-source" })).site : null;
    await h.flush();
    h.events.length = 0;
    const beforeReceipts = await receiptRows();
    const beforeAudit = await auditRows();
    prepare.mockClear();
    deny = true;
    const result = await outcome(operation === "rename" ? renameSite(h.dc, h.principal, original!.id, "unique-target")
      : createSite(h.dc, h.principal, operation === "create" ? { slug: "unique-target" } : {}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toBeInstanceOf(ApiError);
      expect(String(result.error)).toContain("UNIQUE constraint failed: fixture_unique.value");
      expect(mappedErrors).toEqual([result.error]);
    }
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await count("sites")).toBe(original ? 1 : 0);
    if (original) expect(await site(original.slug)).toEqual({ deleted_slug: null, ...original });
    expect(await receiptRows()).toEqual(beforeReceipts);
    expect(await auditRows()).toEqual(beforeAudit);
    await h.flush();
    expect(h.events).toEqual([]);
  });

  it.each(["create", "rename"] as const)("%s recognized extension name collision maps to slug_taken without another candidate", async (operation) => {
    const prepare = vi.fn<PrepareName>((_p, input, dc) => receipt(dc, input));
    const h = await harness(prepare);
    await extensionSchema();
    const original = operation === "rename" ? (await createSite(h.dc, h.principal, { slug: "mapped-source" })).site : null;
    const beforeReceipts = await receiptRows();
    await allocateExternal("mapped-target");
    prepare.mockClear();
    const result = await outcome(operation === "create" ? createSite(h.dc, h.principal, { slug: "mapped-target" })
      : renameSite(h.dc, h.principal, original!.id, "mapped-target"));
    expect(result.ok).toBe(false);
    if (!result.ok) expectApiError(result.error, 409, "slug_taken", "Choose another name.");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await site("mapped-target")).toBeNull();
    if (original) expect(await site(original.slug)).toEqual({ deleted_slug: null, ...original });
    expect(await receiptRows()).toEqual(beforeReceipts);
    await h.flush();
  });

  it.each(["create", "rename"] as const)("%s precise core sites.slug collision retains existing explicit-name hint", async (operation) => {
    const prepare = vi.fn<PrepareName>(empty);
    const h = await harness(prepare);
    const taken = await createSite(h.dc, h.principal, { slug: "core-taken" });
    const original = operation === "rename" ? await createSite(h.dc, h.principal, { slug: "core-source" }) : null;
    prepare.mockClear();
    const result = await outcome(operation === "create" ? createSite(h.dc, h.principal, { slug: "CORE-TAKEN" })
      : renameSite(h.dc, h.principal, original!.site.id, "CORE-TAKEN"));
    expect(result.ok).toBe(false);
    if (!result.ok) expectApiError(result.error, 409, "slug_taken", operation === "create"
      ? "Pick another slug, or omit it to get a generated one." : "Pick another name.");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await site("core-taken")).toEqual({ deleted_slug: null, ...taken.site });
    if (original) expect(await site("core-source")).toEqual({ deleted_slug: null, ...original.site });
    await h.flush();
  });
});

describe("deterministic competing-writer acquisition", () => {
  it.each(["create", "rename"] as const)("%s paused preparation loses to external allocation with no core receipt", async (operation) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let pause = false;
    const h = await harness(async (_p, input, dc) => {
      if (pause) { entered.resolve(); await release.promise; }
      return receipt(dc, input);
    });
    await extensionSchema();
    const original = operation === "rename" ? (await createSite(h.dc, h.principal, { slug: "race-source" })).site : null;
    await h.flush();
    h.events.length = 0;
    const beforeReceipts = await receiptRows();
    const beforeAudit = await auditRows();
    pause = true;
    const pending = outcome(operation === "create" ? createSite(h.dc, h.principal, { slug: "race-target" })
      : renameSite(h.dc, h.principal, original!.id, "race-target"));
    try {
      await mustReachPreparation(entered.promise, pending);
      expect(await site("race-target")).toBeNull();
      if (original) expect(await site(original.slug)).toEqual({ deleted_slug: null, ...original });
      await allocateExternal("race-target");
      release.resolve();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expectApiError(result.error, 409, "slug_taken");
      expect(await site("race-target")).toBeNull();
      if (original) expect(await site(original.slug)).toEqual({ deleted_slug: null, ...original });
      expect(await receiptRows()).toEqual(beforeReceipts);
      expect(await auditRows()).toEqual([...beforeAudit, "external:race-target"].sort());
      expect(await count("fixture_external_names")).toBe(1);
      await h.flush();
      expect(h.events).toEqual([]);
    } finally { release.resolve(); await pending; await h.flush(); }
  });

  it.each(["create", "rename"] as const)("%s wins first and SQL refuses the external writer (including its earlier write)", async (operation) => {
    const h = await harness((_p, input, dc) => receipt(dc, input));
    await extensionSchema();
    const original = operation === "rename" ? await createSite(h.dc, h.principal, { slug: "first-source" }) : null;
    const result = operation === "create" ? await createSite(h.dc, h.principal, { slug: "first-target" })
      : await renameSite(h.dc, h.principal, original!.site.id, "first-target");
    expect(result.site.slug).toBe("first-target");
    expect(await receiptRows()).toContainEqual({ site_id: result.site.id, slug: "first-target" });
    const beforeAudit = await auditRows();
    await expect(allocateExternal("first-target")).rejects.toThrow("fixture_name_conflict");
    expect(await count("fixture_external_names")).toBe(0);
    expect(await auditRows()).toEqual(beforeAudit);
    expect(await site("first-target")).toEqual({ deleted_slug: null, ...result.site });
    await h.flush();
  });
});

describe("generated concrete candidates and retry classification", () => {
  it.each([false, true])("anonymous=%s SQL candidate conflicts roll back twice, then only one winner/event survives", async (anonymous) => {
    const candidates: SiteNameMutation[] = [];
    const preflight: Array<string | null> = [];
    const events: import("@dropway/core").UsageEvent[] = [];
    const dw = await freshInstance({ anonymous: { enabled: true, ttlMs: 3600_000 } }, { adapters: {
      policy: {
        ...policy((_p, input, dc) => {
          candidates.push({ ...input });
          const base = receipt(dc, input);
          return {
            statements: [...base.statements, ...(candidates.length < 3 ? [dc.env.DB.prepare("INSERT INTO fixture_refusal VALUES (0)")] : [])],
            mapError: (error: unknown) => String(error).includes("CHECK constraint failed")
              ? new ApiError(409, "slug_taken", "Candidate refused.") : mapNameConflict(error),
          };
        }),
        beforeCreateSite(_p, input) { preflight.push(input.slug); },
      }, metering: { record: (event) => void events.push(event) },
    } });
    await extensionSchema();
    const before = Date.now();
    const r = await dw.json("/api/v1/sites", { key: anonymous ? null : dw.ownerKey, ...jsonBody({}) });
    expect(r.status).toBe(201);
    expect(candidates).toHaveLength(3);
    expect(preflight).toEqual([null]);
    for (const candidate of candidates) {
      expect(candidate).toMatchObject({ operation: "create", siteId: expect.any(String), previousSlug: null,
        tenantId: anonymous ? null : expect.any(String), slug: expect.any(String) });
      expect(candidate.slug.length).toBeGreaterThan(0);
      expect(Object.keys(candidate).sort()).toEqual(["operation", "previousSlug", "siteId", "slug", "tenantId"]);
    }
    const winner = (await site(r.body.site.slug))!;
    expect(winner.id).toBe(candidates[2]!.siteId);
    expect(await count("sites")).toBe(1);
    expect(await receiptRows()).toEqual([{ site_id: winner.id, slug: winner.slug }]);
    expect(await auditRows()).toEqual([`create:${winner.id}:${winner.slug}`]);
    expect(events).toEqual([{ type: "site_created", tenantId: winner.tenant_id, siteId: winner.id, anonymous, at: expect.any(Number) }]);
    if (anonymous) {
      expect(r.body.claimToken).toMatch(/^dwc_/);
      expect(winner.claim_token_hash).toBe(await sha256Hex(r.body.claimToken));
      expect(winner.expires_at).toBeGreaterThanOrEqual(before + 3600_000);
      expect(winner.expires_at).toBeLessThanOrEqual(Date.now() + 3600_000);
        await asOwner(dw, async (dc, p) => {
        const claimed = await claimSite(dc, p, winner.slug, r.body.claimToken);
        expect(claimed).toMatchObject({ id: winner.id, tenant_id: p.tenantId, claim_token_hash: null, expires_at: null });
      });
    } else expect(winner.claim_token_hash).toBeNull();
  });

  it.each([false, true])("anonymous=%s six deliberate SQL conflicts exhaust exactly six attempts with zero residue/events", async (anonymous) => {
    const candidates: SiteNameMutation[] = [];
    const h = await harness((_p, input, dc) => {
      candidates.push({ ...input });
      return { statements: [...receipt(dc, input).statements, dc.env.DB.prepare("INSERT INTO fixture_refusal VALUES (0)")],
        mapError: (error: unknown) => String(error).includes("CHECK constraint failed") ? new ApiError(409, "slug_taken", "Candidate conflict.") : undefined };
    }, { anonymous: { enabled: true } });
    await extensionSchema();
    const batch = vi.spyOn(h.dc.env.DB, "batch");
    const p: Principal = anonymous ? { kind: "anonymous", ip: "192.0.2.70" } : h.principal;
    const r = await outcome(createSite(h.dc, p, {}));
    expect(r.ok).toBe(false);
    if (!r.ok) expectApiError(r.error, 503, "slug_generation_failed", "Retry the request.");
    expect(candidates).toHaveLength(6);
    expect(candidates.every((c) => typeof c.slug === "string" && c.slug.length > 0)).toBe(true);
    expect(batch).toHaveBeenCalledTimes(6);
    expect(await count("sites")).toBe(0);
    expect(await receiptRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
    await h.flush();
    expect(h.events).toEqual([]);
  });

  it("callback-thrown precise 409 slug_taken retries per candidate", async () => {
    const prepare = vi.fn<PrepareName>((_p, input, dc) => {
      if (prepare.mock.calls.length < 3) throw new ApiError(409, "slug_taken", "Try another candidate.");
      return receipt(dc, input);
    });
    const h = await harness(prepare);
    await extensionSchema();
    const beforeInsert = vi.fn(() => {});
    const result = await createSite(h.dc, h.principal, {}, { beforeInsert });
    expect(beforeInsert).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(await receiptRows()).toEqual([{ site_id: result.site.id, slug: result.site.slug }]);
    expect(await count("sites")).toBe(1);
    await h.flush();
    expect(h.events.filter((e) => e.type === "site_created")).toHaveLength(1);
  });

  it.each([
    { slug: "explicit-conflict", attempts: 1, status: 409, code: "slug_taken" },
    { slug: null, attempts: 6, status: 503, code: "slug_generation_failed" },
  ])("callback name conflicts for $slug stop after $attempts attempts", async ({ slug, attempts, status, code }) => {
    const prepare = vi.fn<PrepareName>(() => { throw new ApiError(409, "slug_taken", "Candidate conflict."); });
    const h = await harness(prepare);
    await extensionSchema();
    const result = await outcome(createSite(h.dc, h.principal, { slug }));
    expect(result.ok).toBe(false);
    if (!result.ok) expectApiError(result.error, status, code);
    expect(prepare).toHaveBeenCalledTimes(attempts);
    expect(await count("sites")).toBe(0);
    expect(await receiptRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
    await h.flush();
    expect(h.events).toEqual([]);
  });

  it.each([{ status: 403, code: "slug_taken" }, { status: 409, code: "other_conflict" }, { status: 503, code: "fixture_unavailable" }])(
    "callback $status/$code is not a generated-name retry", async ({ status, code }) => {
      const error = new ApiError(status, code, "Not a name conflict.", "Do not retry.");
      const prepare = vi.fn<PrepareName>(() => { throw error; });
      const h = await harness(prepare);
      const result = await outcome(createSite(h.dc, h.principal, {}));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(error);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(await count("sites")).toBe(0);
      await h.flush();
      expect(h.events).toEqual([]);
    },
  );

  it("an arbitrary callback error is preserved without retries or effects", async () => {
    const error = new Error("fixture ordinary error containing UNIQUE is not a collision");
    const prepare = vi.fn<PrepareName>(() => { throw error; });
    const h = await harness(prepare);
    const result = await outcome(createSite(h.dc, h.principal, {}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await count("sites")).toBe(0);
    await h.flush();
    expect(h.events).toEqual([]);
  });

  it("a generated candidate overtaken by a core slug allocation retries only that collision", async () => {
    const entered = deferred<Readonly<SiteNameMutation>>();
    const release = deferred<void>();
    let attempts = 0;
    const h = await harness(async (_p, input, dc) => {
      attempts++;
      if (attempts === 1) { entered.resolve(input); await release.promise; }
      return receipt(dc, input);
    });
    await extensionSchema();
    const pending = outcome(createSite(h.dc, h.principal, {}));
    try {
      await mustReachPreparation(entered.promise.then(() => {}), pending);
      const candidate = await entered.promise;
      const competitorDc = { ...h.dc, adapters: { ...h.dc.adapters, policy: defaultPolicy } };
      const competitor = await createSite(competitorDc, h.principal, { slug: candidate.slug });
      release.resolve();
      const result = await pending;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.site.slug).not.toBe(competitor.site.slug);
        expect(await receiptRows()).toEqual([{ site_id: result.value.site.id, slug: result.value.site.slug }]);
      }
      expect(attempts).toBe(2);
      expect(await count("sites")).toBe(2);
      expect(await env.DB.prepare("SELECT id FROM sites WHERE id = ?").bind(candidate.siteId).first()).toBeNull();
    } finally { release.resolve(); await pending; await h.flush(); }
  });

  it("anonymous admission, chosen-name/password refusal and rate limit still precede the callback", async () => {
    const prepare = vi.fn<PrepareName>(empty);
    const h = await harness(prepare, { anonymous: { enabled: true, sitesPerHourPerIp: 0 } });
    const p: Principal = { kind: "anonymous", ip: "192.0.2.80" };
    await expect(createSite(h.dc, p, {})).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    await expect(createSite(h.dc, p, { slug: "chosen-anon" })).rejects.toMatchObject({ status: 403 });
    await expect(createSite(h.dc, p, { password: "not-allowed" })).rejects.toMatchObject({ status: 403 });
    expect(prepare).not.toHaveBeenCalled();
    expect(await count("sites")).toBe(0);
  });
});

describe("rename cache and stale-write fencing", () => {
  it("warm old content/cache survive SQL refusal untouched; accepted rename moves the same version", async () => {
    let deny = false;
    const h = await harness((_p, input, dc) => ({
      statements: [...receipt(dc, input).statements, ...(deny ? [dc.env.DB.prepare("INSERT INTO fixture_refusal VALUES (0)")] : [])],
      mapError: (error: unknown) => String(error).includes("CHECK constraint failed") ? refusal() : undefined,
    }));
    await extensionSchema();
    const original = await publish(h.dw, "cache-source");
    expect(await (await h.dw.call("/s/cache-source/")).text()).toBe("unchanged-content");
    const cached = await env.CACHE.get("live:cache-source");
    expect(cached).not.toBeNull();
    const beforeReceipts = await receiptRows();
    deny = true;
    const put = vi.spyOn(env.CACHE, "put");
    const remove = vi.spyOn(env.CACHE, "delete");
    const result = await outcome(renameSite(h.dc, h.principal, original.id, "cache-denied"));
    expect(result.ok).toBe(false);
    if (!result.ok) expectApiError(result.error, 451, "fixture_refused");
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await site(original.slug)).toEqual({ deleted_slug: null, ...original });
    expect(await env.CACHE.get("live:cache-source")).toBe(cached);
    expect(await env.CACHE.get("live:cache-denied")).toBeNull();
    expect(await receiptRows()).toEqual(beforeReceipts);
    expect(await (await h.dw.call("/s/cache-source/")).text()).toBe("unchanged-content");
    expect((await h.dw.call("/s/cache-denied/")).status).toBe(404);
    clearLiveMemoryCache();
    expect(await (await h.dw.call("/s/cache-source/")).text()).toBe("unchanged-content");
    deny = false;
    const renamed = await renameSite(h.dc, h.principal, original.id, "cache-accepted");
    expect(renamed.site.current_version_id).toBe(original.current_version_id);
    expect(await env.CACHE.get("live:cache-source")).toBeNull();
    expect(await env.CACHE.get("live:cache-accepted", "json")).toMatchObject({ siteId: original.id, versionId: original.current_version_id, slug: "cache-accepted" });
    const moved = await h.dw.call("/s/cache-source/");
    expect(moved.status).toBe(308);
    expect(moved.headers.get("location")).toBe(`${ORIGIN}/s/cache-accepted/`);
    expect(await (await h.dw.call("/s/cache-accepted/")).text()).toBe("unchanged-content");
    await h.flush();
  });

  it.each(["rename", "delete"] as const)("paused rename overtaken by %s fails site_changed inside the batch", async (overtaker) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const h = await harness(async (_p, input, dc) => {
      if (input.slug === "stale-target") {
        entered.resolve();
        await release.promise;
        // Intentionally NO receipt trigger/extension guard. Core must abort the
        // stale write inside its batch, or this extension-only audit would commit.
        return { statements: [audit(dc, `stale:${input.siteId}`)] };
      }
      return receipt(dc, input);
    });
    await extensionSchema();
    const original = await publish(h.dw, "stale-source");
    expect(await (await h.dw.call("/s/stale-source/")).text()).toBe("unchanged-content");
    const pending = outcome(renameSite(h.dc, h.principal, original.id, "stale-target"));
    try {
      await mustReachPreparation(entered.promise, pending);
      if (overtaker === "rename") await renameSite(h.dc, h.principal, original.id, "stale-winner");
      else await deleteSite(h.dc, h.principal, original.slug);
      const afterOvertake = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(original.id).first();
      const beforeReceipts = await receiptRows();
      const beforeAudit = await auditRows();
      const put = vi.spyOn(env.CACHE, "put");
      const remove = vi.spyOn(env.CACHE, "delete");
      release.resolve();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expectApiError(result.error, 409, "site_changed");
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(original.id).first()).toEqual(afterOvertake);
      expect(await receiptRows()).toEqual(beforeReceipts);
      expect(await auditRows()).toEqual(beforeAudit);
      expect(await site("stale-target")).toBeNull();
      expect(await env.CACHE.get("live:stale-target")).toBeNull();
      expect((await h.dw.call("/s/stale-target/")).status).toBe(404);
      if (overtaker === "rename") {
        // The overtaking rename recorded its own redirect; the refused stale write added nothing.
        const moved = await h.dw.call("/s/stale-source/");
        expect(moved.status).toBe(308);
        expect(moved.headers.get("location")).toBe(`${ORIGIN}/s/stale-winner/`);
        expect(await (await h.dw.call("/s/stale-winner/")).text()).toBe("unchanged-content");
      } else {
        expect((await h.dw.call("/s/stale-source/")).status).toBe(404);
        expect(await count("sites")).toBe(1); // soft-delete retained, never resurrected
      }
    } finally { release.resolve(); await pending; await h.flush(); }
  });

  it.each(["same-slug replacement", "tenant transfer"] as const)("paused rename overtaken by %s preserves identity, ownership and live cache", async (overtaker) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const h = await harness(async (_p, input, dc) => {
      if (input.operation === "rename" && input.slug === "fence-target") {
        entered.resolve();
        await release.promise;
        // Audit only: a receipt's identity trigger must not mask a missing core fence.
        return { statements: [audit(dc, `stale:${input.siteId}`)] };
      }
      return receipt(dc, input);
    }, { multiTenant: true });
    await extensionSchema();
    const foreign = await createTenant(h.dc, { name: "Other tenant" });
    const original = await publish(h.dw, "fence-source");
    const sentinel = await publish(h.dw, "fence-sentinel", "sentinel-content");
    expect(await (await h.dw.call("/s/fence-source/")).text()).toBe("unchanged-content");
    expect(await (await h.dw.call("/s/fence-sentinel/")).text()).toBe("sentinel-content");
    const pending = outcome(renameSite(h.dc, h.principal, original.id, "fence-target"));
    try {
      await mustReachPreparation(entered.promise, pending);
      let survivor = original;
      let content = "unchanged-content";
      if (overtaker === "same-slug replacement") {
        await deleteSite(h.dc, h.principal, original.slug);
        content = "replacement-content";
        survivor = await publish(h.dw, original.slug, content);
        expect(survivor.id).not.toBe(original.id);
        expect(survivor.current_version_id).not.toBe(original.current_version_id);
        expect(survivor.tenant_id).toBe(original.tenant_id);
      } else {
        await env.DB.prepare("UPDATE sites SET tenant_id = ? WHERE id = ?").bind(foreign.id, original.id).run();
        survivor = (await site(original.slug))!;
        expect(survivor).toEqual({ ...original, tenant_id: foreign.id });
        // The fixture transfer owns this allowed cache write, not the refused rename.
        await refreshLive(h.dc, survivor.id);
      }
      await h.flush();
      clearLiveMemoryCache();
      expect(await (await h.dw.call("/s/fence-source/")).text()).toBe(content);
      const beforeCore = await siteMutationSnapshot();
      const beforeReceipts = await receiptRows();
      const beforeAudit = await auditRows();
      const cached = await env.CACHE.get("live:fence-source");
      const sentinelCache = await env.CACHE.get("live:fence-sentinel");
      expect(cached).not.toBeNull();
      expect(JSON.parse(cached!)).toMatchObject({ siteId: survivor.id, tenantId: survivor.tenant_id,
        versionId: survivor.current_version_id, slug: original.slug });
      expect(sentinelCache).not.toBeNull();
      expect(await site("fence-target")).toBeNull();
      expect(await env.CACHE.get("live:fence-target")).toBeNull();
      h.events.length = 0;
      // Only observe effects after the overtaker and its warm-cache reads settle.
      const put = vi.spyOn(env.CACHE, "put");
      const remove = vi.spyOn(env.CACHE, "delete");
      release.resolve();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expectApiError(result.error, 409, "site_changed");
      await h.flush();
      expect(await siteMutationSnapshot()).toEqual(beforeCore);
      expect(await site(original.slug)).toEqual(survivor);
      expect(await site(sentinel.slug)).toEqual(sentinel);
      expect(await receiptRows()).toEqual(beforeReceipts);
      expect(await auditRows()).toEqual(beforeAudit);
      expect(h.events).toEqual([]);
      expect(await env.CACHE.get("live:fence-source")).toBe(cached);
      expect(await env.CACHE.get("live:fence-sentinel")).toBe(sentinelCache);
      expect(await site("fence-target")).toBeNull();
      expect(await env.CACHE.get("live:fence-target")).toBeNull();
      const live = await h.dw.call("/s/fence-source/");
      expect(live.status).toBe(200);
      expect(await live.text()).toBe(content);
      clearLiveMemoryCache();
      const fromCache = await h.dw.call("/s/fence-source/");
      expect(fromCache.status).toBe(200);
      expect(await fromCache.text()).toBe(content);
      expect(await (await h.dw.call("/s/fence-sentinel/")).text()).toBe("sentinel-content");
      expect((await h.dw.call("/s/fence-target/")).status).toBe(404);
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally { release.resolve(); await pending; await h.flush(); }
  });
});

describe("public createTenantWithOwner atomic composition", () => {
  it("exports the low-level service as a public function", () => {
    expect(createTenantWithOwner).toBeTypeOf("function");
  });

  it("prepares fresh readonly rows before SQL and commits tenant, fixed owner, then extension in one batch", async () => {
    const h = await tenantFixture();
    const batch = vi.spyOn(h.dc.env.DB, "batch");
    let prepared: { tenant: Readonly<TenantRow>; owner: Readonly<MemberRow> } | undefined;
    const options: CreateTenantWithOwnerOptions = {
      async extend(rows: OwnerRows, dc: DropwayContext) {
        expect(dc).toBe(h.dc);
        expect(await env.DB.prepare("SELECT id FROM tenants WHERE id = ?").bind(rows.tenant.id).first()).toBeNull();
        expect(await env.DB.prepare("SELECT id FROM members WHERE id = ?").bind(rows.owner.id).first()).toBeNull();
        prepared = { tenant: { ...rows.tenant }, owner: { ...rows.owner } };
        return { statements: [audit(dc, "tenant-success"), dc.env.DB.prepare(
          "INSERT INTO fixture_profiles (tenant_id, owner_id, label) VALUES (?, ?, 'new-profile')",
        ).bind(rows.tenant.id, rows.owner.id)] };
      },
    };
    // Structural extra fields from a JS caller cannot choose identity, tenant or role.
    const input = { tenant: { id: h.principal.tenantId, name: "t".repeat(121) }, owner: {
      id: h.principal.memberId, tenantId: h.principal.tenantId, tenant_id: h.principal.tenantId, role: "admin",
      email: " Not-An-Email ", externalRef: " External Ref ", name: "m".repeat(121),
    } } satisfies CreateTenantWithOwnerInput & { tenant: { id: string }; owner: { id: string; tenantId: string; tenant_id: string; role: string } };
    const result = await createTenantWithOwner(h.dc, input, options);
    expect(prepared).toEqual(result);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(result.tenant.id).not.toBe(h.principal.tenantId);
    expect(result.owner.id).not.toBe(h.principal.memberId);
    expect(result.tenant).toEqual({ id: expect.stringMatching(/^ten_/), name: "t".repeat(120), created_at: expect.any(Number), disabled_at: null });
    expect(result.owner).toEqual({ id: expect.stringMatching(/^mem_/), tenant_id: result.tenant.id, role: "owner",
      name: "m".repeat(120), email: " Not-An-Email ", external_ref: " External Ref ", created_at: expect.any(Number), disabled_at: null });
    expect(await env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(result.tenant.id).first()).toEqual(result.tenant);
    expect(await env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(result.owner.id).first()).toEqual(result.owner);
    expect(await env.DB.prepare("SELECT * FROM fixture_profiles WHERE tenant_id = ?").bind(result.tenant.id).first())
      .toEqual({ tenant_id: result.tenant.id, owner_id: result.owner.id, label: "new-profile" });
    expect((await coreSnapshot()).profiles).toContainEqual(h.before.profiles[0]);
  });

  it.each([
    { owner: {} }, { tenant: {}, owner: {} },
    { tenant: { name: "" }, owner: { name: "", email: "", externalRef: "" } },
    { tenant: { name: null }, owner: { name: null, email: null, externalRef: null } },
  ] satisfies CreateTenantWithOwnerInput[])("omitted extension and low-level optional fields preserve normalization: %j", async (input) => {
    const h = await tenantFixture();
    const r = await createTenantWithOwner(h.dc, input);
    expect(r.tenant.name).toBeNull();
    expect(r.owner).toMatchObject({ tenant_id: r.tenant.id, role: "owner", name: null,
      email: input.owner.email ?? null, external_ref: input.owner.externalRef ?? null });
    const after = await coreSnapshot();
    expect(after.tenants).toHaveLength(h.before.tenants.length + 1);
    expect(after.members).toHaveLength(h.before.members.length + 1);
    expect(after.profiles).toEqual(h.before.profiles);
  });

  it("callback ApiError before SQL preserves the error and all unrelated sentinel rows", async () => {
    const h = await tenantFixture();
    const error = refusal();
    const extend = vi.fn<NonNullable<CreateTenantWithOwnerOptions["extend"]>>(() => { throw error; });
    const batch = vi.spyOn(h.dc.env.DB, "batch");
    const result = await outcome(createTenantWithOwner(h.dc, { owner: {} }, { extend }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
    expect(extend).toHaveBeenCalledTimes(1);
    expect(batch).not.toHaveBeenCalled();
    expect(await coreSnapshot()).toEqual(h.before);
    expect(await auditRows()).toEqual([]);
  });

  it("injected owner INSERT failure rolls back the earlier tenant, leaving unrelated rows unchanged", async () => {
    const h = await tenantFixture();
    await env.DB.prepare(`CREATE TRIGGER fixture_owner_failure BEFORE INSERT ON members
      WHEN NEW.email = 'owner-failure' BEGIN SELECT RAISE(ABORT, 'fixture_owner_insert_failed'); END`).run();
    const extend = vi.fn<NonNullable<CreateTenantWithOwnerOptions["extend"]>>((rows: OwnerRows, dc: DropwayContext) => ({
      statements: [audit(dc, "owner-failure"), dc.env.DB.prepare(
        "INSERT INTO fixture_profiles (tenant_id, owner_id, label) VALUES (?, ?, 'never')",
      ).bind(rows.tenant.id, rows.owner.id)],
    }));
    const batch = vi.spyOn(h.dc.env.DB, "batch");
    const result = await outcome(createTenantWithOwner(h.dc, { owner: { email: "owner-failure" } }, { extend }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error)).toContain("fixture_owner_insert_failed");
    expect(extend).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await coreSnapshot()).toEqual(h.before);
    expect(await auditRows()).toEqual([]);
  });

  it("late extension failure rolls back tenant, owner, profile and earlier audit; maps recognized error", async () => {
    const h = await tenantFixture();
    const error = new ApiError(422, "fixture_profile_refused", "Profile refused.", "Keep the previous profile.");
    const mapped: unknown[] = [];
    const batch = vi.spyOn(h.dc.env.DB, "batch");
    const result = await outcome(createTenantWithOwner(h.dc, { tenant: { name: "rolled back" }, owner: { email: "new@example.test" } }, {
      extend(rows: OwnerRows, dc: DropwayContext) {
        return { statements: [audit(dc, "tenant-rollback"), dc.env.DB.prepare(
          "INSERT INTO fixture_profiles (tenant_id, owner_id, label) VALUES (?, ?, 'rollback')",
        ).bind(rows.tenant.id, rows.owner.id), dc.env.DB.prepare("INSERT INTO fixture_refusal VALUES (0)")],
        mapError(e: unknown) { mapped.push(e); return String(e).includes("CHECK constraint failed") ? error : undefined; } };
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
    expect(mapped).toHaveLength(1);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(await coreSnapshot()).toEqual(h.before);
    expect(await auditRows()).toEqual([]);
  });

  it("undefined tenant extension mapError preserves the original unrelated UNIQUE error", async () => {
    const h = await tenantFixture();
    const errors: unknown[] = [];
    const result = await outcome(createTenantWithOwner(h.dc, { owner: {} }, {
      extend(_rows: OwnerRows, dc: DropwayContext) { return { statements: [audit(dc, "unmapped"), dc.env.DB.prepare("INSERT INTO fixture_unique VALUES ('sentinel')")],
        mapError(error: unknown) { errors.push(error); return undefined; } }; },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toBeInstanceOf(ApiError);
      expect(String(result.error)).toContain("UNIQUE constraint failed: fixture_unique.value");
      expect(errors).toEqual([result.error]);
    }
    expect(await coreSnapshot()).toEqual(h.before);
    expect(await auditRows()).toEqual([]);
  });

  it("legacy low-level services retain field rules and roles", async () => {
    const h = await harness();
    const tenant = await createTenant(h.dc, { name: "legacy".repeat(30) });
    const member = await insertMember(h.dc, { tenantId: tenant.id, role: "admin", email: " UNVALIDATED ", externalRef: "", name: "" });
    expect(tenant.name).toBe("legacy".repeat(30).slice(0, 120));
    expect(member).toMatchObject({ tenant_id: tenant.id, role: "admin", name: null, email: " UNVALIDATED ", external_ref: "" });
  });

  it("setup response remains compatible while owner INSERT failure is atomic (key issuance excluded)", async () => {
    const h = await harness(undefined, { multiTenant: true });
    await extensionSchema();
    const before = await coreSnapshot();
    await env.DB.prepare(`CREATE TRIGGER fixture_setup_owner_failure BEFORE INSERT ON members
      WHEN NEW.email = 'fail@example.test' BEGIN SELECT RAISE(ABORT, 'fixture_setup_failed'); END`).run();
    const denied = await h.dw.json("/api/v1/setup", { key: BOOTSTRAP, ...jsonBody({ email: "fail@example.test" }) });
    expect(denied.status).toBe(500);
    expect(await coreSnapshot()).toEqual(before);
    const batch = vi.spyOn(h.dc.env.DB, "batch");
    const success = await h.dw.json("/api/v1/setup", { key: BOOTSTRAP, ...jsonBody({ email: " OWNER@EXAMPLE.TEST ", name: "Owner", tenantName: "Instance" }) });
    expect(success.status).toBe(201);
    expect(success.body).toMatchObject({ tenant: { id: expect.any(String), name: "Instance" },
      member: { email: "owner@example.test", name: "Owner", role: "owner" }, apiKey: { key: expect.stringMatching(/^dw_/) } });
    expect(batch).toHaveBeenCalledTimes(1);
    expect((await h.dw.json("/api/v1/me", { key: success.body.apiKey.key })).status).toBe(200);
  });
});
