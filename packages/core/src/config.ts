/**
 * Instance configuration. Resolved from Worker vars/secrets (see wrangler.jsonc),
 * then overridden by whatever the embedding app passes to createDropway({ config }).
 */

import { ApiError } from "./errors";
import { QUOTA_KEYS, type QuotaKey, type Quotas } from "./policy";

const MB = 1024 * 1024;

/** Size and count caps applied to a publish. A PolicyAdapter may return different values per caller. */
export interface Limits {
  /** Largest single file in bytes. Workers request bodies are capped at 100 MB on most plans. */
  maxFileBytes: number;
  /** Most files in one version. */
  maxFiles: number;
  /** Largest version (sum of file sizes) in bytes. */
  maxSiteBytes: number;
  /** Largest request body for one-shot POST /api/v1/publish (held in memory). */
  oneShotMaxBytes: number;
  /** Maximum delivery lifetime; embedding policies may lower it. */
  transferMaxExpiryDays?: number;
}

export interface AnonymousConfig {
  /** Allow publishing without an API key. Off by default. */
  enabled: boolean;
  /** Lifetime of an anonymous site. */
  ttlMs: number;
  /** New anonymous sites per IP per hour. */
  sitesPerHourPerIp: number;
  /** Caps for anonymous sites. */
  limits: Limits;
}

export type SitesMode = "path" | "subdomain";

/**
 * How long freed site names are held (R-59 link permanence). A renamed site's
 * old name 308s to the new name for `renameMs`; a deleted or expired name is
 * tombstoned for `chosenMs` (explicitly chosen) or `generatedMs` (generated),
 * during which only the holding tenant may reclaim it.
 */
export interface SlugHolds {
  renameMs: number;
  chosenMs: number;
  generatedMs: number;
}

export interface DropwayConfig {
  /** Shown in pages and API responses. */
  instanceName: string;
  /** Public origin of the app + API, no trailing slash. null = the origin of each request. */
  appOrigin: string | null;
  /**
   * Former public origins of the app, for example a workers.dev hostname after a move to a domain.
   * On these hosts the API, MCP, /health, /.well-known/* and the agent documents keep working and
   * carry Deprecation + Link headers; other GET/HEAD requests 308 to appOrigin. Needs appOrigin.
   */
  legacyAppOrigins: string[];
  /** Deprecation date of the legacy origins, Unix seconds (header `Deprecation: @<seconds>`). */
  legacyDeprecatedAt: number;
  /**
   * subdomain: https://<slug>.<sitesDomain>/ (each site its own origin; recommended).
   * path: <sitesOrigin>/<slug>/ when sitesOrigin is set, else <appOrigin><sitesPathPrefix>/<slug>/ (interim, sandboxed).
   */
  sitesMode: SitesMode;
  sitesDomain: string | null;
  /** Path mode only: origin of a sites-only deployment. null = serve sites from the app origin. */
  sitesOrigin: string | null;
  /**
   * Former origins that served sites in path mode (<origin>/<slug>/<path>), for example a
   * workers.dev sites Worker after a move to subdomain mode. Requests there answer 308 to the
   * same path and query on the site's current URL.
   */
  legacySitesOrigins: string[];
  /** Path mode on the app origin: prefix in front of /<slug>/. */
  sitesPathPrefix: string;
  /**
   * Serve user content with a CSP sandbox (opaque origin: no cookies, storage, workers or Referer).
   * Always on when sites share the app origin. Off by default for a separate sites origin and for
   * subdomain mode (SITES_SANDBOX=true turns it on there).
   */
  sitesSandbox: boolean;
  /**
   * Sandbox anonymous (unclaimed, expiring) sites even when sitesSandbox is off, so
   * untrusted pages on a shared sites origin cannot read other sites' storage.
   * SITES_SANDBOX=auto (the default) turns this on for a separate sites origin;
   * subdomain mode gives every site its own origin and leaves it off.
   */
  sitesSandboxAnonymous: boolean;
  /** false (open source): exactly one tenant, created by POST /api/v1/setup. */
  multiTenant: boolean;
  anonymous: AnonymousConfig;
  /** Maximum bytes downloaded for a URL file source. */
  urlFetchMaxBytes: number;
  /** Default caps for API-key publishes. */
  limits: Limits;
  /** Admin-set resource quotas. null means unlimited, zero refuses new resources. */
  quotas: Quotas;
  /** Secret that may create the owner (first run) and mint recovery owner keys. */
  adminBootstrapKey: string | null;
  /**
   * HMAC secret for capabilities (cookies, upload and preview tokens) and IP hashing. null when
   * neither SIGNING_SECRET nor ADMIN_BOOTSTRAP_KEY is set: read it through signingSecret(), which
   * refuses with 503 then.
   */
  signingSecret: string | null;
  /** KV edge-cache TTL for live site manifests, seconds (KV minimum is 30). */
  liveCacheTtlSeconds: number;
  /** How long freed site names are held (R-59). */
  slugHolds: SlugHolds;
}

export type ConfigOverrides = Partial<Omit<DropwayConfig, "anonymous" | "limits" | "quotas" | "slugHolds">> & {
  anonymous?: Partial<Omit<AnonymousConfig, "limits">> & { limits?: Partial<Limits> };
  limits?: Partial<Limits>;
  quotas?: Partial<Quotas>;
  slugHolds?: Partial<SlugHolds>;
};

/** Worker vars and secrets read by resolveConfig. All optional strings. */
export interface DropwayVars extends Partial<Record<`QUOTA_${Uppercase<QuotaKey>}`, string>> {
  INSTANCE_NAME?: string;
  APP_ORIGIN?: string;
  LEGACY_APP_ORIGINS?: string;
  LEGACY_DEPRECATED_AT?: string;
  SITES_MODE?: string;
  SITES_DOMAIN?: string;
  SITES_ORIGIN?: string;
  SITES_SANDBOX?: string;
  LEGACY_SITES_ORIGINS?: string;
  ANONYMOUS_PUBLISH?: string;
  ANON_TTL_HOURS?: string;
  ANON_SITES_PER_HOUR?: string;
  ANON_MAX_FILE_BYTES?: string;
  ANON_MAX_SITE_BYTES?: string;
  MAX_FILE_BYTES?: string;
  MAX_FILES?: string;
  MAX_SITE_BYTES?: string;
  ONESHOT_MAX_BYTES?: string;
  URL_FETCH_MAX_BYTES?: string;
  SLUG_REDIRECT_DAYS?: string;
  SLUG_HOLD_CHOSEN_DAYS?: string;
  SLUG_HOLD_GENERATED_DAYS?: string;
  ADMIN_BOOTSTRAP_KEY?: string;
  SIGNING_SECRET?: string;
  /** Local development only: sign with a fixed, public secret when no secret is set. */
  ALLOW_INSECURE_DEV_SECRET?: string;
  TRANSFER_MAX_EXPIRY_DAYS?: string;
}

const num = (v: string | undefined, d: number) => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const bool = (v: string | undefined, d: boolean) => {
  if (v === undefined || v.trim() === "") return d;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
};

export function normaliseOrigin(v: string | undefined | null): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
}

/** Comma- or space-separated origins, normalised and de-duplicated; invalid entries are dropped. */
export function normaliseOrigins(v: string | undefined | null): string[] {
  return [...new Set((v ?? "").split(/[\s,]+/).map(normaliseOrigin).filter((o): o is string => o !== null))];
}

/** ISO 8601 date or Unix seconds -> Unix seconds (0 when unset or invalid). */
function unixSeconds(v: string | undefined): number {
  const s = (v ?? "").trim();
  if (!s) return 0;
  const n = /^\d+$/.test(s) ? Number(s) * 1000 : Date.parse(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 1000) : 0;
}

function normaliseDomain(v: string | undefined | null): string | null {
  const d = (v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\.+|\.+$/g, "");
  return d || null;
}

/** Public, so anything signed with it is forgeable: only behind ALLOW_INSECURE_DEV_SECRET. */
const INSECURE_DEV_SECRET = "dropway-insecure-dev-secret";

/**
 * The instance signing secret. Fails closed: without one, signed capabilities and salted IP hashes
 * are refused (503) instead of falling back to a guessable key. Unsigned routes keep working.
 */
export function signingSecret(config: Pick<DropwayConfig, "signingSecret">): string {
  if (config.signingSecret) return config.signingSecret;
  throw new ApiError(503, "signing_secret_missing", "This instance has no signing secret configured.",
    "The operator must set SIGNING_SECRET (or ADMIN_BOOTSTRAP_KEY) as a Worker secret.", undefined, { retryable: false });
}

export function resolveConfig(vars: DropwayVars, overrides: ConfigOverrides = {}): DropwayConfig {
  const sitesDomain = overrides.sitesDomain !== undefined ? overrides.sitesDomain : normaliseDomain(vars.SITES_DOMAIN);
  const requestedMode = (overrides.sitesMode ?? vars.SITES_MODE ?? "").trim().toLowerCase();
  let sitesMode: SitesMode = requestedMode === "subdomain" || (!requestedMode && sitesDomain) ? "subdomain" : "path";
  if (sitesMode === "subdomain" && !sitesDomain) {
    console.warn(JSON.stringify({ event: "config_warning", message: "SITES_MODE=subdomain needs SITES_DOMAIN; falling back to path mode." }));
    sitesMode = "path";
  }
  const appOrigin = overrides.appOrigin !== undefined ? overrides.appOrigin : normaliseOrigin(vars.APP_ORIGIN);
  // Legacy app origins only make sense with a fixed APP_ORIGIN to send people and agents to.
  const legacyAppOrigins = appOrigin ? (overrides.legacyAppOrigins ?? normaliseOrigins(vars.LEGACY_APP_ORIGINS)).filter((o) => o !== appOrigin) : [];
  const sitesOriginVar = overrides.sitesOrigin !== undefined ? overrides.sitesOrigin : normaliseOrigin(vars.SITES_ORIGIN);
  // The effective sites origin. SITES_ORIGIN applies in path mode only: subdomain mode ignores it,
  // so a value left over from path mode must not drop that origin from LEGACY_SITES_ORIGINS below.
  const sitesOrigin = sitesMode === "path" && sitesOriginVar !== appOrigin ? sitesOriginVar : null;
  const legacySitesOrigins =
    overrides.legacySitesOrigins ??
    [...new Set((vars.LEGACY_SITES_ORIGINS ?? "").split(/[\s,]+/).map(normaliseOrigin))].filter(
      (o): o is string => o !== null && o !== appOrigin && o !== sitesOrigin,
    );
  const sharedOrigin = sitesMode === "path" && !sitesOrigin;
  // SITES_SANDBOX: true (every site), false (none, unless sites share the app origin), auto (default: anonymous sites on a sites origin).
  const sandboxVar = (vars.SITES_SANDBOX ?? "").trim().toLowerCase();
  const sandboxAuto = sandboxVar === "" || sandboxVar === "auto";
  const sandboxRequested = overrides.sitesSandbox ?? (sandboxAuto ? false : bool(sandboxVar, false));
  const limits: Limits = {
    maxFileBytes: num(vars.MAX_FILE_BYTES, 100 * MB),
    maxFiles: num(vars.MAX_FILES, 2500),
    maxSiteBytes: num(vars.MAX_SITE_BYTES, 10 * 1024 * MB),
    oneShotMaxBytes: num(vars.ONESHOT_MAX_BYTES, 25 * MB),
    transferMaxExpiryDays: Math.min(3650, num(vars.TRANSFER_MAX_EXPIRY_DAYS, 30)),
    ...overrides.limits,
  };
  const anonymous: AnonymousConfig = {
    enabled: bool(vars.ANONYMOUS_PUBLISH, false),
    ttlMs: num(vars.ANON_TTL_HOURS, 24) * 3600_000,
    sitesPerHourPerIp: num(vars.ANON_SITES_PER_HOUR, 60),
    ...overrides.anonymous,
    limits: {
      maxFileBytes: num(vars.ANON_MAX_FILE_BYTES, 25 * MB),
      maxFiles: limits.maxFiles,
      maxSiteBytes: num(vars.ANON_MAX_SITE_BYTES, 250 * MB),
      oneShotMaxBytes: limits.oneShotMaxBytes,
      ...overrides.anonymous?.limits,
    },
  };
  const adminBootstrapKey = overrides.adminBootstrapKey !== undefined ? overrides.adminBootstrapKey : vars.ADMIN_BOOTSTRAP_KEY?.trim() || null;
  const slugHolds: SlugHolds = {
    renameMs: num(vars.SLUG_REDIRECT_DAYS, 365) * 86400_000,
    chosenMs: num(vars.SLUG_HOLD_CHOSEN_DAYS, 365) * 86400_000,
    generatedMs: num(vars.SLUG_HOLD_GENERATED_DAYS, 90) * 86400_000,
    ...overrides.slugHolds,
  };
  return {
    instanceName: overrides.instanceName ?? (vars.INSTANCE_NAME?.trim() || "Kofra"),
    urlFetchMaxBytes: overrides.urlFetchMaxBytes ?? num(vars.URL_FETCH_MAX_BYTES, 100 * MB),
    appOrigin,
    legacyAppOrigins,
    legacyDeprecatedAt: overrides.legacyDeprecatedAt ?? unixSeconds(vars.LEGACY_DEPRECATED_AT),
    sitesMode,
    sitesDomain: sitesMode === "subdomain" ? sitesDomain : null,
    sitesOrigin,
    legacySitesOrigins,
    sitesPathPrefix: (overrides.sitesPathPrefix ?? "/s").replace(/\/+$/, ""),
    // Sites that share the app origin are always sandboxed: they must never touch the app's storage.
    sitesSandbox: sharedOrigin ? true : sandboxRequested,
    sitesSandboxAnonymous: overrides.sitesSandboxAnonymous ?? (sandboxAuto && sitesMode === "path"),
    multiTenant: overrides.multiTenant ?? false,
    anonymous,
    limits,
    quotas: Object.fromEntries(QUOTA_KEYS.map((key) => {
      const value = overrides.quotas?.[key] !== undefined ? overrides.quotas[key] : vars[`QUOTA_${key.toUpperCase()}` as keyof DropwayVars];
      const n = value === null || value === undefined || value === "" ? null : Number(value);
      if (n !== null && (!Number.isSafeInteger(n) || n < 0)) throw new Error(`Invalid quota ${key}: expected a non-negative integer or null.`);
      return [key, n];
    })) as Quotas,
    adminBootstrapKey,
    signingSecret: overrides.signingSecret !== undefined ? overrides.signingSecret
      : vars.SIGNING_SECRET?.trim() || adminBootstrapKey || (bool(vars.ALLOW_INSECURE_DEV_SECRET, false) ? INSECURE_DEV_SECRET : null),
    liveCacheTtlSeconds: Math.max(30, overrides.liveCacheTtlSeconds ?? 30),
    slugHolds,
  };
}
