import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { clearLiveMemoryCache, sha256Hex, type ConfigOverrides } from "@dropway/core";
import { createDropway, type CreateDropwayOptions, type Dropway, type ServerBindings } from "@dropway/server";

export const ORIGIN = "https://dropway.test";
export const BOOTSTRAP = "test-bootstrap-secret-0123456789";

export interface Instance {
  dropway: Dropway;
  /** Owner API key (all scopes). */
  ownerKey: string;
  call(path: string, init?: RequestInit & { key?: string | null; origin?: string }): Promise<Response>;
  json<T = Record<string, any>>(path: string, init?: RequestInit & { key?: string | null; origin?: string }): Promise<{ status: number; body: T; res: Response }>;
}

/** Wipe storage, apply migrations, build a Kofra and create its owner. */
export async function freshInstance(config: ConfigOverrides = {}, extra: Omit<CreateDropwayOptions, "config"> = {}): Promise<Instance> {
  // The test runtime resets live D1 objects, but can retain a stopped object's
  // SQLite storage. Wake D1 before the single reset, even on an empty database.
  await env.DB.prepare("SELECT 1").first();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // Diagnostic for the intermittent setup 409: record whether reset left a
  // tenant behind. A count above zero here means dirty storage; zero here
  // with a setup refusal below means a tenant appeared between this check
  // and setup. Fail with the count either way - never retry or accept it.
  const tenantsAfterReset = (await env.DB.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n ?? 0;
  if (tenantsAfterReset !== 0) {
    throw new Error(`freshInstance: ${tenantsAfterReset} tenant(s) present immediately after reset/migrations, before setup`);
  }
  clearLiveMemoryCache();
  const dropway = createDropway({ config, ...extra });

  const call: Instance["call"] = async (path, init = {}) => {
    const { key, origin, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (key) headers.set("Authorization", `Bearer ${key}`);
    const url = path.startsWith("http") ? path : `${origin ?? ORIGIN}${path}`;
    const ctx = createExecutionContext();
    const res = await dropway.fetch(new Request(url, { ...rest, headers, redirect: "manual" }), env as unknown as ServerBindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  const json: Instance["json"] = async (path, init) => {
    const res = await call(path, init);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, res };
  };

  const setup = await json("/api/v1/setup", { method: "POST", key: BOOTSTRAP, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.com" }) });
  if (setup.status !== 201) throw new Error(`setup failed: ${setup.status} ${JSON.stringify(setup.body)} (tenants immediately after reset/migrations: ${tenantsAfterReset})`);
  return { dropway, ownerKey: setup.body.apiKey.key, call, json };
}

export function form(files: Record<string, string | Uint8Array>, fields: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [path, content] of Object.entries(files)) fd.append(path, new File([content], path.split("/").pop()!));
  return fd;
}

export async function manifestEntry(path: string, content: string, contentType?: string) {
  const bytes = new TextEncoder().encode(content);
  return { path, size: bytes.length, sha256: await sha256Hex(bytes), ...(contentType ? { contentType } : {}), bytes };
}

export const jsonBody = (v: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) });
