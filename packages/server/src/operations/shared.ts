import { z } from "zod";
import type { Context } from "hono";
import { accessModeOf, describeSite, parseSettings, type KofraContext, type Principal, type SiteRow } from "@kofra/core";
import { SETTINGS_INPUT } from "../mcp/schemas";
import type { KofraEnv } from "../env";

export const fromSchema = (schema: Record<string, any>): z.ZodType<any> => z.fromJSONSchema(schema);

export const ANY = { type: "object" } as const;

export const ANY_OR_NULL = { type: ["object", "null"] } as const;

export const LIST = { type: "array" } as const;

export const RO = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const CREATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const DESTROY = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

export async function siteOut(dw: KofraContext, site: SiteRow) {
  return {
    ...(await describeSite(dw, site)),
    access: { mode: accessModeOf(site) },
  };
}

export const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

export const settingsFrom = (a: Record<string, unknown>) => {
  const picked: Record<string, unknown> = {};
  for (const k of Object.keys(SETTINGS_INPUT)) if (a[k] !== undefined) picked[k] = a[k];
  return parseSettings(picked);
};

export function publishSummary(r: any, verb = "Published"): string {
  const v = r.version ? `v${r.version.number}` : "";
  if (r.status === "unchanged") return `Nothing changed: ${r.slug} ${v} already has exactly these files. ${r.url}`;
  if (r.status === "awaiting_upload")
    return `${r.slug} ${v} is waiting for ${r.files.pending} upload(s): PUT each upload.items[].url, then call finalize_version.`;
  const f = r.files;
  return `${verb} ${r.slug} ${v} (${f.total} files: ${f.stored} new, ${f.reused} reused${f.fetched ? `, ${f.fetched} fetched` : ""}): ${r.url}`;
}

export function whoamiPrincipal(p: Principal) {
  if (p.kind === "member")
    return {
      kind: "member" as const,
      memberId: p.memberId,
      role: p.role,
      scopes: [...p.scopes],
      keyId: p.keyId,
      siteRestriction: p.siteId,
      via: p.via,
    };
  if (p.kind === "claim") return { kind: "claim_token" as const, siteId: p.siteId };
  return { kind: p.kind };
}

export const P = (c: Context<KofraEnv>) => c.get("principal");

export const D = (c: Context<KofraEnv>) => c.get("dw");

export const clientOf = (c: Context<KofraEnv>) => c.req.header("x-kofra-client") ?? null;
