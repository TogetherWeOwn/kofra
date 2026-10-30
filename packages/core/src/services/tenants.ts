import type { DropwayContext } from "../context";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors";
import { newId } from "../lib/crypto";
import { stringField } from "../lib/input";
import { ALL_SCOPES, ROLES, ROLE_SCOPES, parseScopes, requireMember, type Principal, type Role } from "../principal";
import { mintApiKey } from "./keys";
import type { AtomicWriteExtension } from "../adapters";
import { atomicWrite } from "./atomic-write";

export interface TenantRow {
  id: string;
  name: string | null;
  created_at: number;
  disabled_at: number | null;
}

export interface MemberRow {
  id: string;
  tenant_id: string;
  email: string | null;
  name: string | null;
  role: Role;
  external_ref: string | null;
  created_at: number;
  disabled_at: number | null;
}

const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);

export function serializeTenant(t: TenantRow) {
  return { id: t.id, name: t.name, createdAt: iso(t.created_at) };
}

export function serializeMember(m: MemberRow) {
  return { id: m.id, email: m.email, name: m.name, role: m.role, createdAt: iso(m.created_at), disabled: !!m.disabled_at };
}

function cleanEmail(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const email = String(v).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest("invalid_email", `"${String(v)}" is not an email address.`);
  return email;
}

function cleanRole(v: unknown, fallback: Role): Role {
  if (v === undefined || v === null || v === "") return fallback;
  const role = stringField(v, "role");
  if (!(ROLES as readonly string[]).includes(role)) throw badRequest("invalid_role", `Role must be one of ${ROLES.join(", ")}.`);
  return role as Role;
}

function tenantRow(input: { name?: string | null }): TenantRow {
  return { id: newId("ten"), name: input.name ? String(input.name).slice(0, 120) : null, created_at: Date.now(), disabled_at: null };
}

type MemberInput = { tenantId: string; email?: string | null; name?: string | null; role: Role; externalRef?: string | null };

function memberRow(input: MemberInput): MemberRow {
  return {
    id: newId("mem"),
    tenant_id: input.tenantId,
    email: input.email ?? null,
    name: input.name ? String(input.name).slice(0, 120) : null,
    role: input.role,
    external_ref: input.externalRef ?? null,
    created_at: Date.now(),
    disabled_at: null,
  };
}

function tenantInsert(dc: DropwayContext, t: TenantRow): D1PreparedStatement {
  return dc.env.DB.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)").bind(t.id, t.name, t.created_at);
}

function memberInsert(dc: DropwayContext, m: MemberRow): D1PreparedStatement {
  return dc.env.DB.prepare("INSERT INTO members (id, tenant_id, email, name, role, external_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(m.id, m.tenant_id, m.email, m.name, m.role, m.external_ref, m.created_at);
}

/** Low-level: create a tenant. No checks; for setup and for extensions that onboard tenants. */
export async function createTenant(dc: DropwayContext, input: { name?: string | null } = {}): Promise<TenantRow> {
  const t = tenantRow(input);
  await tenantInsert(dc, t).run();
  return t;
}

/** Low-level: add a member to a tenant. No permission checks. */
export async function insertMember(dc: DropwayContext, input: MemberInput): Promise<MemberRow> {
  const m = memberRow(input);
  try {
    await memberInsert(dc, m).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("member_exists", `A member with email ${m.email} already exists.`, "List members with GET /api/v1/members.");
    throw e;
  }
  return m;
}

export interface CreateTenantWithOwnerInput {
  tenant?: { name?: string | null };
  owner: { email?: string | null; name?: string | null; externalRef?: string | null };
}

export interface CreateTenantWithOwnerOptions {
  /** Prepare same-DB SQL before any insert; no independent writes or irreversible effects. */
  extend?(
    rows: { tenant: Readonly<TenantRow>; owner: Readonly<MemberRow> },
    dc: DropwayContext,
  ): AtomicWriteExtension | Promise<AtomicWriteExtension>;
}

/** Low-level: caller owns admission. Key issuance is NOT part of this transaction. */
export async function createTenantWithOwner(
  dc: DropwayContext,
  input: CreateTenantWithOwnerInput,
  options: CreateTenantWithOwnerOptions = {},
): Promise<{ tenant: TenantRow; owner: MemberRow }> {
  const tenant = tenantRow(input.tenant ?? {});
  const owner = memberRow({
    tenantId: tenant.id, role: "owner", email: input.owner.email, name: input.owner.name, externalRef: input.owner.externalRef,
  });
  const extension = await options.extend?.({ tenant: { ...tenant }, owner: { ...owner } }, dc);
  await atomicWrite(dc, [tenantInsert(dc, tenant), memberInsert(dc, owner)], extension);
  return { tenant, owner };
}

export async function getTenant(dc: DropwayContext, id: string): Promise<TenantRow> {
  const t = await dc.env.DB.prepare("SELECT * FROM tenants WHERE id = ?").bind(id).first<TenantRow>();
  if (!t) throw notFound("tenant_not_found", "Tenant not found.");
  return t;
}

export async function getMember(dc: DropwayContext, id: string): Promise<MemberRow> {
  const m = await dc.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first<MemberRow>();
  if (!m) throw notFound("member_not_found", "Member not found.");
  return m;
}

async function tenantCount(dc: DropwayContext): Promise<number> {
  return (await dc.env.DB.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n ?? 0;
}

export async function isSetUp(dc: DropwayContext): Promise<boolean> {
  return (await tenantCount(dc)) > 0;
}

/**
 * First run: the bootstrap key creates the tenant, its owner and an owner API key.
 * In single-tenant mode this works exactly once.
 */
export async function setupInstance(dc: DropwayContext, p: Principal, input: { email?: unknown; name?: unknown; tenantName?: unknown; keyName?: unknown }) {
  if (p.kind !== "bootstrap") {
    throw forbidden("Setup needs the bootstrap key.", "Send `Authorization: Bearer <ADMIN_BOOTSTRAP_KEY>` (the secret set on the Worker).", "bootstrap_key_required");
  }
  if (!dc.config.multiTenant && (await isSetUp(dc))) {
    throw conflict(
      "already_set_up",
      "This instance already has an owner.",
      "Use the owner's API key. If it is lost, POST /api/v1/setup/recover with the bootstrap key mints a new owner key.",
    );
  }
  const email = cleanEmail(input.email);
  const keyName = input.keyName == null ? "owner" : stringField(input.keyName, "keyName");
  const { tenant, owner } = await createTenantWithOwner(dc, {
    tenant: { name: input.tenantName == null ? null : String(input.tenantName) },
    owner: { email, name: input.name == null ? null : String(input.name) },
  });
  const apiKey = await mintApiKey(dc, { tenantId: tenant.id, memberId: owner.id, name: keyName, scopes: ALL_SCOPES });
  return { tenant: serializeTenant(tenant), member: serializeMember(owner), apiKey };
}

/** Break-glass: the bootstrap key mints a fresh full-scope key for the (first) owner. */
export async function recoverOwnerKey(dc: DropwayContext, p: Principal) {
  if (p.kind !== "bootstrap") throw forbidden("Recovery needs the bootstrap key.", undefined, "bootstrap_key_required");
  if (dc.config.multiTenant) throw forbidden("Owner recovery is disabled on multi-tenant instances.", undefined, "not_available");
  const owner = await dc.env.DB.prepare("SELECT * FROM members WHERE role = 'owner' AND disabled_at IS NULL ORDER BY created_at LIMIT 1").first<MemberRow>();
  if (!owner) throw notFound("not_set_up", "This instance has no owner yet.", "POST /api/v1/setup with the bootstrap key first.");
  const apiKey = await mintApiKey(dc, { tenantId: owner.tenant_id, memberId: owner.id, name: "recovery", scopes: ALL_SCOPES });
  return { member: serializeMember(owner), apiKey };
}

export async function listMembers(dc: DropwayContext, p: Principal) {
  const caller = requireMember(p, "sites:read");
  const { results } = await dc.env.DB.prepare("SELECT * FROM members WHERE tenant_id = ? AND disabled_at IS NULL ORDER BY created_at")
    .bind(caller.tenantId)
    .all<MemberRow>();
  return results.map(serializeMember);
}

/** Add a member and give them their first API key (there is no email login in the core). */
export async function createMember(dc: DropwayContext, p: Principal, input: { email?: unknown; name?: unknown; role?: unknown; scopes?: unknown; keyName?: unknown }) {
  const caller = requireMember(p, "members:write");
  const role = cleanRole(input.role, "member");
  if (role === "owner" && caller.role !== "owner") throw forbidden("Only owners can add owners.");
  const scopes = parseScopes(input.scopes, ROLE_SCOPES[role].filter((s) => caller.scopes.includes(s)));
  const keyName = input.keyName == null ? "default" : stringField(input.keyName, "keyName");
  const member = await insertMember(dc, {
    tenantId: caller.tenantId,
    email: cleanEmail(input.email),
    name: input.name == null ? null : String(input.name),
    role,
  });
  const apiKey = await mintApiKey(dc, {
    tenantId: caller.tenantId,
    memberId: member.id,
    name: keyName,
    scopes,
  });
  return { member: serializeMember(member), apiKey };
}

export async function updateMember(dc: DropwayContext, p: Principal, memberId: string, input: { name?: unknown; role?: unknown }) {
  const caller = requireMember(p, "members:write");
  const m = await dc.env.DB.prepare("SELECT * FROM members WHERE id = ? AND tenant_id = ? AND disabled_at IS NULL")
    .bind(memberId, caller.tenantId)
    .first<MemberRow>();
  if (!m) throw notFound("member_not_found", `No member ${memberId}.`, "List members with GET /api/v1/members.");
  const role = cleanRole(input.role, m.role);
  if ((role === "owner" || m.role === "owner") && caller.role !== "owner" && role !== m.role) throw forbidden("Only owners can change owner roles.");
  if (m.role === "owner" && role !== "owner") await assertAnotherOwner(dc, caller.tenantId, m.id);
  const name = input.name === undefined ? m.name : input.name === null ? null : stringField(input.name, "name").slice(0, 120);
  await dc.env.DB.prepare("UPDATE members SET role = ?, name = ? WHERE id = ?").bind(role, name, m.id).run();
  return serializeMember({ ...m, role, name });
}

async function assertAnotherOwner(dc: DropwayContext, tenantId: string, exceptId: string) {
  const other = await dc.env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE tenant_id = ? AND role = 'owner' AND disabled_at IS NULL AND id != ?")
    .bind(tenantId, exceptId)
    .first<{ n: number }>();
  if (!other?.n) throw new ApiError(409, "last_owner", "A tenant must keep at least one owner.", "Make another member an owner first.");
}

/** Disable a member and revoke all their keys. Their sites stay with the tenant. */
export async function removeMember(dc: DropwayContext, p: Principal, memberId: string) {
  const caller = requireMember(p, "members:write");
  const m = await dc.env.DB.prepare("SELECT * FROM members WHERE id = ? AND tenant_id = ? AND disabled_at IS NULL")
    .bind(memberId, caller.tenantId)
    .first<MemberRow>();
  if (!m) throw notFound("member_not_found", `No member ${memberId}.`);
  if (m.role === "owner") {
    if (caller.role !== "owner") throw forbidden("Only owners can remove owners.");
    await assertAnotherOwner(dc, caller.tenantId, m.id);
  }
  const now = Date.now();
  await dc.env.DB.batch([
    dc.env.DB.prepare("UPDATE members SET disabled_at = ? WHERE id = ?").bind(now, m.id),
    dc.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL").bind(now, m.id),
  ]);
  return { removed: true, id: m.id };
}
