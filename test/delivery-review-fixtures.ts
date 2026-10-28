import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { ServerBindings } from "@dropway/server";
import { expect } from "vitest";
import { ORIGIN, type Instance } from "./helpers";
import { attributeUrl, cookies, create, DAY, operations, unlock, type Transfer } from "./transfer-fixtures";

// Public, test-owned fixtures. Only dependency boundaries are instrumented;
// routing, authorization, KDF, D1 transactions, R2 bytes and cleanup stay real.
export const REVIEW_PASSWORD = "review-delivery-passphrase";
export const REVIEW_FILES = [
  { path: "alpha.txt", content: "alpha\n", contentType: "text/plain" },
  { path: "beta.html", content: "<p>beta</p>\n", contentType: "text/html" },
];
export const reviewInput = (extra: Record<string, unknown> = {}) => ({
  slug: "review-parcel",
  files: REVIEW_FILES,
  recipients: ["reader-a@example.net", "reader-b@example.org"],
  message: "Review delivery fixture",
  expiresAt: Date.now() + 2 * DAY,
  ...extra,
});
export const delivery = (dw: Instance, extra: Record<string, unknown> = {}) => create(dw, reviewInput(extra));

export async function request(dw: Instance, url: string, init: RequestInit = {}, bindings: Partial<ServerBindings> = {}) {
  const ctx = createExecutionContext();
  const response = await dw.dropway.fetch(new Request(url, { ...init, redirect: "manual" }),
    { ...env, ...bindings } as unknown as ServerBindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function operationRequest(dw: Instance, id: string, input: Record<string, unknown>, bindings: Partial<ServerBindings>) {
  const operation = (await operations(dw)).find((entry) => entry.id === id);
  expect(operation, id).toBeDefined();
  const body = { ...input };
  const path = operation!.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    expect(body[key], `missing ${key}`).toBeDefined();
    const value = encodeURIComponent(String(body[key]));
    delete body[key];
    return value;
  });
  const res = await request(dw, new URL(path, ORIGIN).href, {
    method: operation!.method,
    headers: { Authorization: `Bearer ${dw.ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, bindings);
  return { status: res.status, body: await res.json() as Record<string, any>, res };
}

/** Extract actual page links (including the signed grant), never mint a test grant. */
export async function fileLinks(dw: Instance, t: Transfer, recipient = 0, password?: string) {
  const pageUrl = t.recipients[recipient]?.url ?? t.url;
  const headers = new Headers({ Accept: "text/html" });
  if (password) headers.set("Cookie", cookies(await unlock(dw, { ...t, url: pageUrl }, password)));
  const page = await dw.call(pageUrl, { headers });
  expect(page.status, "delivery page must render before testing its downloads").toBe(200);
  const links: string[] = [];
  await new HTMLRewriter().on("a[href]", {
    element(e) { links.push(attributeUrl(e.getAttribute("href")!, pageUrl)); },
  }).transform(page).text();
  return REVIEW_FILES.map((file) => {
    const link = links.find((href) => new URL(href).origin !== ORIGIN && decodeURIComponent(new URL(href).pathname).endsWith(`/${file.path}`));
    expect(link, `rendered link for ${file.path}`).toBeDefined();
    return link!;
  });
}

/** Wrap real prepared statements, including statements executed in a real batch. */
export function databaseBoundary(beforeExecute: (sql: string[]) => Promise<void>): D1Database {
  const statements = new WeakMap<D1PreparedStatement, { raw: D1PreparedStatement; sql: string }>();
  const wrap = (raw: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(raw, { get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (["run", "all", "first", "raw"].includes(String(property))) await beforeExecute([sql]);
        return value.apply(target, args);
      };
    } });
    statements.set(proxy, { raw, sql });
    return proxy;
  };
  return new Proxy(env.DB, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") return async (batch: D1PreparedStatement[]) => {
      await beforeExecute(batch.map((statement) => statements.get(statement)?.sql ?? ""));
      return target.batch(batch.map((statement) => statements.get(statement)?.raw ?? statement));
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

export const transferWrite = (sql: string) => /\bUPDATE\s+transfers\b/i.test(sql);
export const accountingWrite = (sql: string) => transferWrite(sql) && /\bdownloads\s*=\s*downloads\s*\+/i.test(sql);

export async function lifecycle(ref: string, by: "slug" | "id" = "slug") {
  return env.DB.prepare(`SELECT s.id AS site_id, s.current_version_id, s.deleted_at AS site_deleted_at,
    t.id AS transfer_id, t.deleted_at, t.legal_hold, t.revoked_at, t.expired_at, t.purged_at, t.downloads
    FROM sites s LEFT JOIN transfers t ON t.site_id = s.id WHERE s.${by} = ?`).bind(ref).first<{
      site_id: string; current_version_id: string | null; site_deleted_at: number | null;
      transfer_id: string | null; deleted_at: number | null; legal_hold: number | null;
      revoked_at: number | null; expired_at: number | null; purged_at: number | null; downloads: number | null;
    }>();
}

export async function references(siteId: string) {
  const result = await env.DB.prepare(`SELECT vf.path, vf.sha256, vf.size, COALESCE(b.storage_key, 'blobs/' || vf.sha256) AS storage_key FROM version_files vf
    JOIN versions v ON v.id = vf.version_id LEFT JOIN blobs b ON b.sha256 = vf.sha256 WHERE v.site_id = ? ORDER BY vf.path`).bind(siteId)
    .all<{ path: string; sha256: string; size: number; storage_key: string }>();
  return result.results;
}

export async function assertStoredBytes(siteId: string) {
  const refs = await references(siteId);
  expect(refs.map((file) => [file.path, file.size])).toEqual([["alpha.txt", 6], ["beta.html", 12]]);
  for (const file of refs) {
    const blob = await env.FILES.get(file.storage_key);
    expect(blob, `${file.path} remains in R2`).not.toBeNull();
    expect(await blob!.text()).toBe(REVIEW_FILES.find((fixture) => fixture.path === file.path)!.content);
  }
}
