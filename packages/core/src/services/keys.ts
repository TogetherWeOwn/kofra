import type { DropwayContext } from "../context";
import { ApiError, badRequest, forbidden, notFound, unauthorized } from "../errors";
import { newId, newSecret, sha256Hex } from "../lib/crypto";
import {
  ROLE_SCOPES,
  deserializeScopes,
  parseScopes,
  requireMember,
  serializeScopes,
  type MemberPrincipal,
  type Principal,
  type Role,
  type Scope,
} from "../principal";

export const API_KEY_PREFIX = "dw_";
export const MAX_KEYS_PER_MEMBER = 50;

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  member_id: string;
  name: string | null;
  prefix: string;
  scopes: string;
  site_id: string | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);

export function serializeKey(k: ApiKeyRow, currentKeyId?: string | null) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    memberId: k.member_id,
    scopes: deserializeScopes(k.scopes),
    siteId: k.site_id,
    current: currentKeyId ? k.id === currentKeyId : undefined,
    createdAt: iso(k.created_at),
    lastUsedAt: iso(k.last_used_at),
    expiresAt: iso(k.expires_at),
    revoked: !!k.revoked_at,
  };
}

/** Low-level: create a key row and return the plaintext once. No permission checks (for setup and extensions). */
export async function mintApiKey(
  dc: DropwayContext,
  input: { tenantId: string; memberId: string; name?: string | null; scopes: readonly Scope[]; siteId?: string | null; expiresAt?: number | null },
) {
  const count = await dc.env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE member_id = ? AND revoked_at IS NULL")
    .bind(input.memberId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_KEYS_PER_MEMBER) {
    throw new ApiError(409, "key_limit", `This member already has ${MAX_KEYS_PER_MEMBER} active keys.`, "Revoke unused keys with DELETE /api/v1/keys/:id.");
  }
  const secret = newSecret(API_KEY_PREFIX);
  const row: ApiKeyRow = {
    id: newId("key"),
    tenant_id: input.tenantId,
    member_id: input.memberId,
    name: input.name ? String(input.name).slice(0, 120) : null,
    prefix: secret.slice(0, 10),
    scopes: serializeScopes(input.scopes),
    site_id: input.siteId ?? null,
    created_at: Date.now(),
    last_used_at: null,
    expires_at: input.expiresAt ?? null,
    revoked_at: null,
  };
  await dc.env.DB.prepare(
    "INSERT INTO api_keys (id, tenant_id, member_id, name, prefix, key_hash, scopes, site_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, row.tenant_id, row.member_id, row.name, row.prefix, await sha256Hex(secret), row.scopes, row.site_id, row.created_at, row.expires_at)
    .run();
  return { ...serializeKey(row), key: secret };
}

/** Create a key for yourself, or (with members:write) for another member of your tenant. */
export async function createApiKey(
  dc: DropwayContext,
  p: Principal,
  input: { name?: unknown; scopes?: unknown; expiresInDays?: unknown; memberId?: unknown; site?: unknown },
) {
  const caller = requireMember(p, "keys:write");
  let memberId = caller.memberId;
  let memberRole: Role = caller.role;
  if (input.memberId !== undefined && input.memberId !== null && input.memberId !== caller.memberId) {
    requireMember(p, "members:write");
    const m = await dc.env.DB.prepare("SELECT id, role FROM members WHERE id = ? AND tenant_id = ? AND disabled_at IS NULL")
      .bind(String(input.memberId), caller.tenantId)
      .first<{ id: string; role: Role }>();
    if (!m) throw notFound("member_not_found", `No active member ${String(input.memberId)} in this tenant.`, "List members with GET /api/v1/members.");
    // A key acts as its member, so a key for an owner carries the owner role.
    if (m.role === "owner" && caller.role !== "owner") throw forbidden("Only owners can create keys for owners.", "Ask an owner to create the key.");
    memberId = m.id;
    memberRole = m.role;
  }
  // A key can never be wider than the caller's key, nor than the target member's role.
  const grantable = caller.scopes.filter((s) => ROLE_SCOPES[memberRole].includes(s));
  const scopes = parseScopes(input.scopes, grantable);
  if (scopes.length === 0) throw badRequest("invalid_scope", "A key needs at least one scope.");

  let siteId: string | null = caller.siteId;
  if (input.site !== undefined && input.site !== null && input.site !== "") {
    const site = await dc.env.DB.prepare("SELECT id FROM sites WHERE slug = ? AND tenant_id = ? AND deleted_at IS NULL")
      .bind(String(input.site).toLowerCase(), caller.tenantId)
      .first<{ id: string }>();
    if (!site || (caller.siteId && caller.siteId !== site.id)) throw notFound("site_not_found", `No site "${String(input.site)}" in this tenant.`);
    siteId = site.id;
  }

  let expiresAt: number | null = null;
  if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
    const days = Number(input.expiresInDays);
    if (!Number.isFinite(days) || days <= 0) throw badRequest("invalid_expiry", "expiresInDays must be a positive number.");
    expiresAt = Date.now() + days * 86400_000;
  }
  return mintApiKey(dc, {
    tenantId: caller.tenantId,
    memberId,
    name: input.name == null ? null : String(input.name),
    scopes,
    siteId,
    expiresAt,
  });
}

/** Your own keys; with members:write and all=true, every key in the tenant. */
export async function listApiKeys(dc: DropwayContext, p: Principal, opts: { all?: boolean } = {}) {
  const caller = requireMember(p, "keys:write");
  const all = opts.all && caller.scopes.includes("members:write");
  const { results } = await dc.env.DB.prepare(
    `SELECT id, tenant_id, member_id, name, prefix, scopes, site_id, created_at, last_used_at, expires_at, revoked_at
       FROM api_keys WHERE tenant_id = ? AND revoked_at IS NULL ${all ? "" : "AND member_id = ?"} ORDER BY created_at DESC`,
  )
    .bind(...(all ? [caller.tenantId] : [caller.tenantId, caller.memberId]))
    .all<ApiKeyRow>();
  return results.map((k) => serializeKey(k, caller.keyId));
}

export async function revokeApiKey(dc: DropwayContext, p: Principal, keyId: string) {
  const caller = requireMember(p, "keys:write");
  const key = await dc.env.DB.prepare("SELECT id, member_id FROM api_keys WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL")
    .bind(keyId, caller.tenantId)
    .first<{ id: string; member_id: string }>();
  if (!key || (key.member_id !== caller.memberId && !caller.scopes.includes("members:write"))) {
    throw notFound("key_not_found", `No active key ${keyId} that you can revoke.`, "List keys with GET /api/v1/keys.");
  }
  await dc.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").bind(Date.now(), key.id).run();
  return { revoked: true, id: key.id };
}

/** Turn a dw_ API key into a member principal, or throw 401. */
export async function authenticateApiKey(dc: DropwayContext, token: string, ip: string): Promise<MemberPrincipal> {
  const hash = await sha256Hex(token);
  const row = await dc.env.DB.prepare(
    `SELECT k.id, k.tenant_id, k.member_id, k.scopes, k.site_id, k.expires_at, k.revoked_at, k.last_used_at,
            m.role, m.disabled_at AS member_disabled, t.disabled_at AS tenant_disabled
       FROM api_keys k
       JOIN members m ON m.id = k.member_id
       JOIN tenants t ON t.id = k.tenant_id
      WHERE k.key_hash = ?`,
  )
    .bind(hash)
    .first<{
      id: string;
      tenant_id: string;
      member_id: string;
      scopes: string;
      site_id: string | null;
      expires_at: number | null;
      revoked_at: number | null;
      last_used_at: number | null;
      role: Role;
      member_disabled: number | null;
      tenant_disabled: number | null;
    }>();
  const now = Date.now();
  if (!row || row.revoked_at || row.member_disabled || row.tenant_disabled) {
    throw unauthorized("This API key is not valid or has been revoked.", "Ask the instance owner for a new key.", "invalid_api_key");
  }
  if (row.expires_at && row.expires_at < now) throw unauthorized("This API key has expired.", "Create a new key with POST /api/v1/keys.", "api_key_expired");

  // Track last use at most every 5 minutes, off the hot path.
  if (!row.last_used_at || now - row.last_used_at > 300_000) {
    dc.waitUntil(dc.env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, row.id).run().catch(() => {}));
  }
  const roleScopes = ROLE_SCOPES[row.role] ?? [];
  return {
    kind: "member",
    tenantId: row.tenant_id,
    memberId: row.member_id,
    role: row.role,
    scopes: deserializeScopes(row.scopes).filter((s) => roleScopes.includes(s)),
    keyId: row.id,
    siteId: row.site_id,
    via: "api_key",
    ip,
  };
}
