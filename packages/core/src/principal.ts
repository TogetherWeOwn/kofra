import { badRequest, forbidden, unauthorized } from "./errors";

/**
 * Permission scopes carried by API keys.
 * - sites:read     list and read sites, versions and files
 * - sites:write    create, publish, update and restore sites
 * - sites:delete   delete sites, versions and folders
 * - keys:write     create and revoke API keys (never wider than the caller's own)
 * - members:write  add, change and remove members of the tenant
 * - data:write     change site data
 * - secrets:write  change site secrets
 * - admin          administer the instance
 */
export const ALL_SCOPES = ["sites:read", "sites:write", "sites:delete", "keys:write", "members:write", "data:write", "secrets:write", "admin"] as const;
export type Scope = (typeof ALL_SCOPES)[number];

export type Role = "owner" | "admin" | "member";
export const ROLES: readonly Role[] = ["owner", "admin", "member"];

/** The widest scopes each role may hold. */
export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  owner: ALL_SCOPES,
  admin: ALL_SCOPES,
  member: ["sites:read", "sites:write", "sites:delete", "keys:write", "data:write"],
};

/** A member of a tenant, authenticated by an API key or (in extensions) by a session. */
export interface MemberPrincipal {
  kind: "member";
  tenantId: string;
  memberId: string;
  role: Role;
  scopes: readonly Scope[];
  /** The API key used, if any. */
  keyId: string | null;
  /** Key restricted to one site (by site id), or null. */
  siteId: string | null;
  /** How the caller authenticated: "api_key", or whatever an IdentityAdapter sets. */
  via: string;
  ip: string;
}

/**
 * Who is calling. Routes and services take a Principal, never raw headers.
 * IdentityAdapters (packages/core/src/adapters.ts) produce these.
 */
export type Principal =
  | { kind: "anonymous"; ip: string }
  | MemberPrincipal
  /** The ADMIN_BOOTSTRAP_KEY secret: may only create the owner (first run) or mint a recovery owner key. */
  | { kind: "bootstrap"; ip: string }
  /** A claim token (dwc_...) returned when an anonymous site was created; controls only that site. */
  | { kind: "claim"; siteId: string; ip: string }
  /** Signed upload capability: only the blobs of one pending version, never site access. */
  | { kind: "upload"; versionId: string; expiresAt: number; ip: string };

export function hasScope(p: Principal, scope: Scope): boolean {
  return p.kind === "member" && p.scopes.includes(scope);
}

/** Require an authenticated member, optionally holding a scope. */
export function requireMember(p: Principal, scope?: Scope): MemberPrincipal {
  if (p.kind !== "member") {
    if (p.kind === "bootstrap") {
      throw forbidden(
        "The bootstrap key can only set up the instance.",
        "Use the owner API key returned by POST /api/v1/setup (or mint a new one with POST /api/v1/setup/recover).",
      );
    }
    throw unauthorized();
  }
  if (scope && !p.scopes.includes(scope)) {
    throw forbidden(`This API key lacks the "${scope}" scope.`, "Ask the instance owner for a key with that scope (POST /api/v1/keys).", "insufficient_scope");
  }
  return p;
}

/**
 * Parse requested scopes ("*", "sites:read sites:write", or an array) and check
 * they are a subset of `allowed`. Undefined/empty = all of `allowed`.
 */
export function parseScopes(input: unknown, allowed: readonly Scope[]): Scope[] {
  if (input === undefined || input === null || input === "" || input === "*") return [...allowed];
  const list = Array.isArray(input) ? input.map(String) : String(input).split(/[\s,]+/).filter(Boolean);
  if (list.includes("*")) return [...allowed];
  const out: Scope[] = [];
  for (const s of list) {
    if (!(ALL_SCOPES as readonly string[]).includes(s)) {
      throw badRequest("invalid_scope", `Unknown scope "${s}".`, `Valid scopes: ${ALL_SCOPES.join(", ")}, or "*" for all you hold.`);
    }
    if (!allowed.includes(s as Scope)) {
      throw forbidden(`You cannot grant "${s}": it is wider than what you or the key's member hold.`, `Grantable here: ${allowed.join(", ") || "none"}.`, "scope_not_grantable");
    }
    if (!out.includes(s as Scope)) out.push(s as Scope);
  }
  return out;
}

export function serializeScopes(scopes: readonly Scope[]): string {
  return [...scopes].sort().join(" ");
}

export function deserializeScopes(s: string): Scope[] {
  return s.split(/\s+/).filter((x): x is Scope => (ALL_SCOPES as readonly string[]).includes(x));
}
