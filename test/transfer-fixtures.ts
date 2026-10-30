import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { clearLiveMemoryCache, runCleanup, type ConfigOverrides } from "@dropway/core";
import type { CreateDropwayOptions, ServerBindings } from "@dropway/server";
import { expect } from "vitest";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";

export const SITES = "https://deliveries.example";
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const PASSWORD = "delivery-secret-sample";
export const FILES = [
  { path: "notes.txt", content: "transfer sample bytes", contentType: "text/plain" },
  { path: "page.html", content: "<h1>download, do not render</h1>", contentType: "text/html" },
];

export interface Transfer {
  id: string;
  slug: string;
  mode: string;
  url: string;
  expiresAt: number;
  message: string | null;
  recipients: { email: string; url: string; downloads: number }[];
  files: { path: string; size: number; downloads: number }[];
}

export interface Operation {
  id: string;
  method: string;
  path: string;
  cli?: { command: string[] };
}

export const input = (overrides: Record<string, unknown> = {}) => ({
  slug: "parcel-sample",
  files: FILES,
  recipients: ["reader@example.net"],
  message: "A short delivery note",
  expiresAt: Date.now() + 2 * DAY,
  ...overrides,
});

export function instance(config: ConfigOverrides = {}, extra: Omit<CreateDropwayOptions, "config"> = {}) {
  return freshInstance({ appOrigin: ORIGIN, sitesOrigin: SITES, ...config }, extra);
}

/** Supply actual operator vars on every request, without mutating shared env. */
export async function instanceWithVars(vars: Record<string, string>) {
  const dw = await instance();
  const bindings = { ...env, ...vars } as unknown as ServerBindings;
  dw.call = async (path, init = {}) => {
    const { key, origin, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (key) headers.set("Authorization", `Bearer ${key}`);
    const ctx = createExecutionContext();
    const res = await dw.dropway.fetch(new Request(new URL(path, origin ?? ORIGIN), { ...rest, headers, redirect: "manual" }), bindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  dw.json = async (path, init) => {
    const res = await dw.call(path, init);
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* Preserve non-JSON error bodies. */ }
    return { status: res.status, body, res };
  };
  return dw;
}

const catalogs = new WeakMap<Instance, Operation[]>();
export async function operations(dw: Instance): Promise<Operation[]> {
  const cached = catalogs.get(dw);
  if (cached) return cached;
  const r = await dw.json("/api/v1/operations", { key: dw.ownerKey });
  expect(r.status, "R-02 must expose the operation table before transfer acceptance can run").toBe(200);
  expect(Array.isArray(r.body.operations)).toBe(true);
  catalogs.set(dw, r.body.operations);
  return r.body.operations;
}

/** Use advertised paths, not a second hard-coded transfer route table. */
export async function op(dw: Instance, name: string, args: Record<string, unknown> = {}, key = dw.ownerKey, headers: Record<string, string> = {}) {
  const operation = (await operations(dw)).find((o) => o.id === name);
  expect(operation, `missing operation ${name}`).toBeDefined();
  const body = { ...args };
  if (name === "rename_site") {
    body.newSlug = body.slug;
    body.slug = body.site;
    delete body.site;
  }
  if (name === "publish_site" && body.slug !== undefined) {
    body.site = body.slug;
    delete body.slug;
  }
  if (name === "delete_site" && body.site !== undefined) {
    body.slug = body.site;
    delete body.site;
  }
  const path = operation!.path.replace(/\{([^}]+)\}/g, (_, field: string) => {
    expect(body[field], `${name} needs path parameter ${field}`).toBeDefined();
    const value = encodeURIComponent(String(body[field]));
    delete body[field];
    return value;
  });
  const url = new URL(path, ORIGIN);
  const method = operation!.method.toUpperCase();
  if (method === "GET") {
    for (const [k, v] of Object.entries(body)) if (v !== undefined) url.searchParams.set(k, String(v));
    return dw.json(url.href, { key, headers });
  }
  return dw.json(url.href, { ...jsonBody(body), method, key, headers: { "Content-Type": "application/json", ...headers } });
}

// These tests propose flat transfer inputs and a transfer result (optionally
// wrapped in { transfer }). Public URL paths are discovered, never guessed.
export async function create(dw: Instance, overrides: Record<string, unknown> = {}, key = dw.ownerKey): Promise<Transfer> {
  const r = await op(dw, "create_transfer", input(overrides), key);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const transfer = r.body.transfer ?? r.body;
  expect(transfer.id).toEqual(expect.any(String));
  expect(transfer.url).toEqual(expect.any(String));
  return transfer;
}

export const ref = (t: Transfer) => ({ transfer: t.id });
export async function get(dw: Instance, t: Transfer): Promise<Transfer> {
  const r = await op(dw, "get_transfer", ref(t));
  expect(r.status).toBe(200);
  return r.body.transfer ?? r.body;
}
export const update = (dw: Instance, t: Transfer, changes: Record<string, unknown>) => op(dw, "update_transfer", { ...ref(t), ...changes });
export const revoke = (dw: Instance, t: Transfer) => op(dw, "revoke_transfers", { ids: [t.id] });
export const siteFile = (t: Transfer, path = "notes.txt") => `${SITES}/${t.slug}/${path}`;

/** Follow only first-party links; helper.call intentionally does not auto-follow redirects. */
export async function follow(dw: Instance, url: string, init: RequestInit = {}): Promise<Response> {
  for (let redirects = 0; redirects < 4; redirects++) {
    expect([ORIGIN, SITES]).toContain(new URL(url).origin);
    const r = await dw.call(url, init);
    if (![301, 302, 303, 307, 308].includes(r.status)) return r;
    const next = r.headers.get("location");
    expect(next).toBeTruthy();
    url = new URL(next!, url).href;
  }
  throw new Error("transfer redirect loop");
}

/** HTMLRewriter returns source spelling, unlike DOM getAttribute(). Decode once. */
export function attributeUrl(href: string, base: string) {
  return new URL(href.replace(/&amp;/g, "&"), base).href;
}

/** Recipient attribution must survive the actual page -> download link flow. */
export async function recipientFile(dw: Instance, t: Transfer, index: number, path = "notes.txt") {
  const link = t.recipients[index]!.url;
  const page = await follow(dw, link, { headers: { Accept: "text/html" } });
  expect(page.status).toBe(200);
  const links: string[] = [];
  await new HTMLRewriter().on("a[href]", {
    element(element) { links.push(attributeUrl(element.getAttribute("href")!, link)); },
  }).transform(page).text();
  const file = links.find((url) => new URL(url).origin === SITES && decodeURIComponent(new URL(url).pathname).endsWith(`/${path}`));
  expect(file, "the app page must link files on the sites host").toBeDefined();
  return file!;
}

export function refusal(r: { status: number; body: any }, status: number) {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(r.body.error.code).toMatch(/^[a-z][a-z0-9_]+$/);
  expect(r.body.error.hint).toEqual(expect.any(String));
  expect(r.body.error.hint.length).toBeGreaterThan(0);
}

export async function invalidate(t: Transfer) {
  await env.CACHE.delete(`live:${t.slug}`);
  clearLiveMemoryCache();
}

/**
 * Storage-only fixtures for states owned by later mail/moderation work. These
 * statements are proposed fixture wiring, not a required storage design. The
 * Builder may map this helper to their schema without weakening assertions.
 * Never mock the gate, lifecycle service, clock or download accounting itself.
 */
export async function state(t: Transfer, fields: Record<string, number | string | null>) {
  const allowed = ["expires_at", "expired_at", "revision", "downloads", "revoked_at", "deleted_at", "takedown_at", "takedown_reason", "legal_hold", "notified_at"];
  for (const name of Object.keys(fields)) expect(allowed).toContain(name);
  const entries = Object.entries(fields);
  const result = await env.DB.prepare(`UPDATE transfers SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...entries.map(([, v]) => v), t.id).run();
  expect(result.meta.changes, "fixture must modify a real transfer").toBe(1);
  await invalidate(t);
}

export async function storedFileCount(t: Transfer) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM version_files WHERE version_id IN (SELECT id FROM versions WHERE site_id IN (SELECT site_id FROM transfers WHERE id = ?))")
    .bind(t.id).first<{ n: number }>();
  return row!.n;
}

export async function passwordDigest(t: Transfer) {
  const row = await env.DB.prepare("SELECT password_hash FROM sites WHERE slug = ?").bind(t.slug).first<{ password_hash: string }>();
  expect(row?.password_hash).toEqual(expect.any(String));
  return row!.password_hash;
}

export async function storageUsage() {
  // Usage-counter shape is from the public SPEC, not the private predecessor.
  const row = await env.DB.prepare("SELECT COALESCE(SUM(value), 0) AS bytes FROM usage_counters WHERE key = 'storage_bytes'")
    .first<{ bytes: number }>();
  return row!.bytes;
}

export async function sweep(dw: Instance): Promise<Record<string, number>> {
  const ctx = createExecutionContext();
  const report = await runCleanup(dw.dropway.context(env as unknown as ServerBindings, ctx));
  await waitOnExecutionContext(ctx);
  return report as unknown as Record<string, number>;
}

export async function member(dw: Instance, email: string) {
  const r = await dw.json("/api/v1/members", { ...jsonBody({ email, role: "member" }), key: dw.ownerKey });
  expect(r.status).toBe(201);
  return { id: r.body.member.id as string, key: r.body.apiKey.key as string };
}

/** Post the real password form without fixing the form action to an invented route. */
export async function unlock(dw: Instance, t: Transfer, password: string, ip = "192.0.2.80") {
  const page = await dw.call(t.url, { headers: { Accept: "text/html" } });
  expect(page.headers.get("content-type")).toContain("text/html");
  let action: string | null = null;
  const fields = new URLSearchParams();
  await new HTMLRewriter().on("form", { element(e) { action = e.getAttribute("action") ?? t.url; } })
    .on('input[type="hidden"]', { element(e) { if (e.getAttribute("name")) fields.set(e.getAttribute("name")!, e.getAttribute("value") ?? ""); } })
    .transform(page).text();
  expect(action, "locked transfer has a password form").not.toBeNull();
  fields.set("password", password);
  return dw.call(new URL(action!, t.url).href, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, "CF-Connecting-IP": ip }, body: fields,
  });
}

export function cookies(r: Response) {
  const values = r.headers.getSetCookie();
  expect(values.length, "successful unlock must issue a cookie").toBeGreaterThan(0);
  return values.map((v) => v.split(";")[0]).join("; ");
}
