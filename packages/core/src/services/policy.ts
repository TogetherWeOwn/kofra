import type { SiteOwner } from "../adapters";
import type { DropwayContext } from "../context";
import { ApiError } from "../errors";
import { CAPABILITIES, QUOTA_KEYS, type Capability, type CapabilityDecision, type QuotaKey } from "../policy";
import type { Principal } from "../principal";
import { getUsage } from "./usage";

const BINDINGS: Partial<Record<Capability, string>> = {
  site_data: "SITE_DATA", functions: "LOADER", code_mode: "LOADER", screenshots: "BROWSER",
  ai_metadata: "AI", analytics: "ANALYTICS", site_restricted: "EMAIL",
};
const BUILTIN: readonly Capability[] = ["anonymous_publish", "url_fetch", "large_uploads", "version_previews", "site_password", "members", "api_keys"];

export async function capabilityDecision(dc: DropwayContext, p: Principal, capability: Capability, owner: SiteOwner | null = null): Promise<CapabilityDecision> {
  const binding = BINDINGS[capability];
  const available = binding ? !!Reflect.get(dc.env, binding) : BUILTIN.includes(capability);
  const requires = binding ? [binding] : [`${capability} support`];
  if (!available) return { allowed: false, error: new ApiError(501, "feature_unavailable", `This instance does not support ${capability}.`, `Ask the instance administrator to configure ${requires.join(", ")}.`, { requires }) };
  if (capability === "anonymous_publish" && !dc.config.anonymous.enabled) {
    return { allowed: false, error: new ApiError(501, "feature_unavailable", "Anonymous publishing is disabled.", "Use an API key or ask the instance administrator to enable ANONYMOUS_PUBLISH.", { requires: ["ANONYMOUS_PUBLISH"] }) };
  }
  return await dc.adapters.policy.capability?.(p, capability, owner, dc) ?? { allowed: true };
}

export async function requireCapability(dc: DropwayContext, p: Principal, capability: Capability, owner: SiteOwner | null = null): Promise<void> {
  const decision = await capabilityDecision(dc, p, capability, owner);
  if (!decision.allowed) throw decision.error;
}

export async function quotaFor(dc: DropwayContext, p: Principal, key: QuotaKey, owner: SiteOwner | null): Promise<number | null> {
  const limit = dc.adapters.policy.quota ? await dc.adapters.policy.quota(p, key, owner, dc) : dc.config.quotas[key];
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new ApiError(500, "invalid_policy_quota", `The policy returned an invalid ${key} quota.`, "Ask the instance administrator to return null or a non-negative integer.");
  }
  return limit;
}

export function quotaExceeded(key: QuotaKey, limit: number): ApiError {
  return new ApiError(403, "limit_reached", `The instance's ${key} limit has been reached.`, "Remove unused resources or ask the instance administrator to change the configured limit.", { quota: key, limit });
}

export async function requireQuota(dc: DropwayContext, p: Principal, key: QuotaKey, owner: SiteOwner, used: number, additional: number): Promise<number | null> {
  const limit = await quotaFor(dc, p, key, owner);
  if (limit !== null && used + additional > limit) throw quotaExceeded(key, limit);
  return limit;
}

export async function describePolicy(dc: DropwayContext, p: Principal) {
  const owner: SiteOwner = { siteId: p.kind === "claim" ? p.siteId : p.kind === "member" ? p.siteId : null, tenantId: p.kind === "member" ? p.tenantId : null };
  const capabilities = Object.fromEntries(await Promise.all(CAPABILITIES.map(async (capability) => {
    const decision = await capabilityDecision(dc, p, capability, owner);
    return [capability, decision.allowed ? decision : { allowed: false, error: decision.error.toJSON().error }];
  })));
  const quotas = Object.fromEntries(await Promise.all(QUOTA_KEYS.map(async (key) => [key, await quotaFor(dc, p, key, owner)])));
  return { capabilities, limits: { ...await dc.adapters.policy.limits(p, owner, dc), ...quotas }, usage: await getUsage(dc, owner.tenantId) };
}
