import { expect } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  ApiError, defaultIdentity,
  type AtomicWriteExtension, type ConfigOverrides, type KofraContext, type MemberPrincipal,
  type PolicyAdapter, type Principal, type SiteNameMutation, type SiteRow, type UsageEvent,
} from "@kofra/core";
import type { ServerBindings } from "@kofra/server";
import { freshInstance, ORIGIN, type Instance } from "./helpers";

export type PrepareName = (
  principal: Principal,
  input: Readonly<SiteNameMutation>,
  dc: KofraContext,
) => AtomicWriteExtension | Promise<AtomicWriteExtension>;

export function policy(prepare: PrepareName): PolicyAdapter {
  return { limits: (_p, _o, dc) => dc.config.limits, siteNameMutation: prepare };
}

export async function harness(prepare?: PrepareName, config: ConfigOverrides = {}) {
  const events: UsageEvent[] = [];
  const dw = await freshInstance(config, { adapters: {
    ...(prepare ? { policy: policy(prepare) } : {}),
    metering: { record: (event) => void events.push(event) },
  } });
  const ctx = createExecutionContext();
  const dc = dw.kofra.context(env as unknown as ServerBindings, ctx);
  const principal = await defaultIdentity.resolve(new Request(`${ORIGIN}/api/v1/me`, {
    headers: { Authorization: `Bearer ${dw.ownerKey}` },
  }), dc);
  if (principal.kind !== "member") throw new Error("Fixture owner identity did not resolve.");
  return { dw, dc, principal, events, flush: () => waitOnExecutionContext(ctx) };
}

export async function asOwner<T>(dw: Instance, fn: (dc: KofraContext, p: MemberPrincipal) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const dc = dw.kofra.context(env as unknown as ServerBindings, ctx);
  const p = await defaultIdentity.resolve(new Request(`${ORIGIN}/api/v1/me`, {
    headers: { Authorization: `Bearer ${dw.ownerKey}` },
  }), dc);
  if (p.kind !== "member") throw new Error("Fixture owner identity did not resolve.");
  try { return await fn(dc, p); }
  finally { await waitOnExecutionContext(ctx); }
}

/** Only disposable extension-owned objects; never a product migration or deployed schema. */
export async function extensionSchema() {
  const sql = [
    "CREATE TABLE fixture_audit (tag TEXT PRIMARY KEY)",
    "CREATE TABLE fixture_refusal (allowed INTEGER NOT NULL CHECK (allowed = 1))",
    "CREATE TABLE fixture_unique (value TEXT PRIMARY KEY)",
    "INSERT INTO fixture_unique VALUES ('sentinel')",
    "CREATE TABLE fixture_external_names (slug TEXT PRIMARY KEY)",
    `CREATE TABLE fixture_receipts (
      site_id TEXT NOT NULL REFERENCES sites(id), slug TEXT NOT NULL,
      PRIMARY KEY (site_id, slug)
    )`,
    // Each controlled writer checks the other table INSIDE its write transaction.
    // No trigger on sites: a missing extension hook must not be hidden by the fixture.
    `CREATE TRIGGER fixture_external_guard BEFORE INSERT ON fixture_external_names BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM sites WHERE slug = NEW.slug AND deleted_at IS NULL)
        THEN RAISE(ABORT, 'fixture_name_conflict') END;
    END`,
    `CREATE TRIGGER fixture_receipt_guard BEFORE INSERT ON fixture_receipts BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sites WHERE id = NEW.site_id AND slug = NEW.slug AND deleted_at IS NULL
      ) THEN RAISE(ABORT, 'fixture_core_not_visible') END;
      SELECT CASE WHEN EXISTS (SELECT 1 FROM fixture_external_names WHERE slug = NEW.slug)
        THEN RAISE(ABORT, 'fixture_name_conflict') END;
    END`,
    `CREATE TABLE fixture_profiles (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
      owner_id TEXT NOT NULL REFERENCES members(id), label TEXT NOT NULL
    )`,
    `CREATE TRIGGER fixture_profile_guard BEFORE INSERT ON fixture_profiles BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM members WHERE id = NEW.owner_id AND tenant_id = NEW.tenant_id AND role = 'owner'
      ) THEN RAISE(ABORT, 'fixture_owner_not_visible') END;
    END`,
  ];
  await env.DB.batch(sql.map((s) => env.DB.prepare(s)));
}

export function audit(dc: KofraContext, tag: string) {
  return dc.env.DB.prepare("INSERT INTO fixture_audit (tag) VALUES (?)").bind(tag);
}

export function receipt(dc: KofraContext, input: Readonly<SiteNameMutation>): AtomicWriteExtension {
  return { statements: [
    audit(dc, `${input.operation}:${input.siteId}:${input.slug}`),
    dc.env.DB.prepare("INSERT INTO fixture_receipts (site_id, slug) VALUES (?, ?)").bind(input.siteId, input.slug),
  ], mapError: mapNameConflict };
}

export function mapNameConflict(error: unknown): ApiError | undefined {
  if (String(error).includes("fixture_name_conflict")) {
    return new ApiError(409, "slug_taken", "A competing writer owns the name.", "Choose another name.");
  }
  return undefined;
}

export async function allocateExternal(slug: string) {
  return env.DB.batch([
    env.DB.prepare("INSERT INTO fixture_audit (tag) VALUES (?)").bind(`external:${slug}`),
    env.DB.prepare("INSERT INTO fixture_external_names (slug) VALUES (?)").bind(slug),
  ]);
}

export async function count(table: "sites" | "tenants" | "members" | "fixture_audit" | "fixture_receipts" | "fixture_profiles" | "fixture_external_names") {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

export async function site(slug: string): Promise<SiteRow | null> {
  return env.DB.prepare("SELECT * FROM sites WHERE slug = ? AND deleted_at IS NULL").bind(slug).first<SiteRow>();
}

export async function receiptRows() {
  return (await env.DB.prepare("SELECT site_id, slug FROM fixture_receipts ORDER BY site_id, slug").all()).results;
}

export async function auditRows() {
  return (await env.DB.prepare("SELECT tag FROM fixture_audit ORDER BY tag").all<{ tag: string }>()).results.map((r) => r.tag);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function outcome<P extends Promise<unknown>>(promise: P) {
  try { return { ok: true as const, value: await promise }; }
  catch (error: unknown) { return { ok: false as const, error }; }
}

/** Missing callbacks fail immediately instead of hanging a baseline run at a barrier. */
export async function mustReachPreparation<T>(entered: Promise<void>, settled: Promise<T>) {
  const first = await Promise.race([entered.then(() => "prepared"), settled.then(() => "settled")]);
  expect(first, "The operation settled without invoking siteNameMutation").toBe("prepared");
}

export function expectApiError(error: unknown, status: number, code: string, hint?: string) {
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status, code, ...(hint ? { hint } : {}) });
}
