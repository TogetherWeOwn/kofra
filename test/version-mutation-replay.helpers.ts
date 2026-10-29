import { expect } from "vitest";
import { env } from "cloudflare:test";
import { type PublishEvent, type SiteRow, type UsageEvent } from "@dropway/core";
import type { CreateDropwayOptions } from "@dropway/server";
import { freshInstance, jsonBody, type Instance } from "./helpers";
import { connectMcp, type McpTestClient } from "./mcp-helpers";
import { effectSpies, isMutation, readsVersions, recordStatements, worldState } from "./interleave-harness";

export const SLUG = "mutation-replay";
export const OTHER = "mutation-other";
export const ACTIONS = ["restore", "delete"] as const;
export const SURFACES = ["REST", "MCP"] as const;
export type Action = typeof ACTIONS[number];
export type Surface = typeof SURFACES[number];
export interface ActionInput { site: string; version: string; confirm?: string }
export interface Outcome { status?: number; isError: boolean; body: Record<string, any> }

export async function publish(dw: Instance, content: string, slug = SLUG) {
  const r = await dw.json("/api/v1/publish", {
    key: dw.ownerKey, ...jsonBody({ slug, files: [
      { path: "index.html", content: `<h1>${content}</h1>`, contentType: "text/html" },
      { path: "shared.txt", content: "shared replay fixture bytes" },
    ] }),
  });
  expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
  return r.body.version.id as string;
}

export async function fixture(extra: Omit<CreateDropwayOptions, "config"> = {}) {
  const published: PublishEvent[] = [];
  const deleted: unknown[] = [];
  const metered: UsageEvent[] = [];
  const dw = await freshInstance({}, {
    ...extra,
    hooks: [...(Array.isArray(extra.hooks) ? extra.hooks : extra.hooks ? [extra.hooks] : []), {
      onPublish: event => { published.push(event); },
      onDelete: event => { deleted.push(event); },
    }],
    adapters: { ...extra.adapters, metering: { record: event => { metered.push(event); } } },
  });
  const target = await publish(dw, "historical target");
  const second = await publish(dw, "second historical version");
  const live = await publish(dw, "initial live");
  await publish(dw, "other historical", OTHER);
  await publish(dw, "other live", OTHER);
  const site = await env.DB.prepare("SELECT * FROM sites WHERE slug = ?").bind(SLUG).first<SiteRow>();
  const other = await env.DB.prepare("SELECT * FROM sites WHERE slug = ?").bind(OTHER).first<SiteRow>();
  if (!site || !other) throw new Error("Disposable replay fixture sites missing.");
  const minted = await dw.json("/api/v1/keys", {
    key: dw.ownerKey, ...jsonBody({ name: "mutation caller", scopes: ["sites:read", "sites:write", "sites:delete"] }),
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  const actor = { key: minted.body.key as string, id: minted.body.id as string };
  expect(actor.key).toEqual(expect.any(String));
  expect(actor.id).toEqual(expect.any(String));
  return { dw, site, other, target, second, live, actor, published, deleted, metered };
}
export type Harness = Awaited<ReturnType<typeof fixture>>;

export function input(h: Harness, action: Action, version = h.target, site = h.site.id): ActionInput {
  return { site, version, ...(action === "delete" ? { confirm: SLUG } : {}) };
}

/** The same public action through independent HTTP or MCP requests, never a service stub. */
export async function transport(h: Harness, surface: Surface, credential = h.actor.key) {
  let wireRefusal: Outcome | undefined;
  const boundary: Instance = { ...h.dw, dropway: { ...h.dw.dropway,
    async fetch(request, bindings, ctx) {
      const response = await h.dw.dropway.fetch(request, bindings, ctx);
      // Revocation is an HTTP 401 before the MCP tool layer. Preserve the real
      // wire refusal if the SDK throws it, rather than inventing a tool result.
      if (response.status === 401) wireRefusal = { status: 401, isError: true, body: await response.clone().json() as Record<string, any> };
      return response;
    },
  } };
  const mcp: McpTestClient | undefined = surface === "MCP" ? await connectMcp(boundary, credential) : undefined;
  return {
    async invoke(action: Action, a: ActionInput, key: string | null = "one-logical-action"): Promise<Outcome> {
      if (mcp) {
        wireRefusal = undefined;
        try {
          const r = await mcp.call(`${action}_version`, {
            ...a, ...(key === null ? {} : { idempotencyKey: key }),
          });
          return { isError: r.isError, body: r.data };
        } catch (error) {
          if (wireRefusal) return wireRefusal;
          throw error;
        }
      }
      const r = await h.dw.json(`/api/v1/sites/${encodeURIComponent(a.site)}/versions/${encodeURIComponent(a.version)}${action === "restore" ? "/restore" : ""}`, {
        method: action === "restore" ? "POST" : "DELETE", key: credential,
        headers: { "Content-Type": "application/json", ...(key === null ? {} : { "Idempotency-Key": key }) },
        ...(action === "delete" ? { body: JSON.stringify({ confirm: a.confirm }) } : {}),
      });
      return { status: r.status, isError: r.status >= 400, body: r.body };
    },
    close: async () => { await mcp?.client.close(); },
  };
}

export function expectSuccess(r: Outcome) {
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
  if (r.status !== undefined) expect(r.status).toBe(200);
}

export function expectFailure(r: Outcome, status: number, code: string) {
  expect.soft(r.isError, JSON.stringify(r.body)).toBe(true);
  if (r.status !== undefined) expect.soft(r.status, JSON.stringify(r.body)).toBe(status);
  expect.soft(r.body.error?.code).toBe(code);
  expect.soft(r.body.error?.hint).toEqual(expect.stringMatching(/\S/));
  expect.soft(r.body).not.toHaveProperty("version");
  expect.soft(r.body).not.toHaveProperty("deleted");
}

export function expectReplay(r: Outcome, original: Outcome) {
  expect.soft(r.isError, JSON.stringify(r.body)).toBe(false);
  if (r.status !== undefined) expect.soft(r.status).toBe(original.status ?? 200);
  // A transport may add replay metadata, but must not recompute the receipt.
  const { replayed: _firstReplay, ...first } = original.body;
  const { replayed: _nextReplay, ...next } = r.body;
  expect.soft(next, "only the first persisted success may be returned").toEqual(first);
}

export async function pointer(h: Harness) {
  return (await env.DB.prepare("SELECT current_version_id FROM sites WHERE id = ?").bind(h.site.id)
    .first<{ current_version_id: string | null }>())?.current_version_id;
}

export function observe(h: Harness) {
  const statements = recordStatements();
  const effects = effectSpies(() => {
    h.published.length = 0; h.deleted.length = 0; h.metered.length = 0;
  }, () => [h.published, h.deleted, h.metered]);
  return {
    clear() { statements.length = 0; effects.clear(); },
    expectNoAction({ noResolution = true } = {}) {
      const requestSql = [...statements];
      expect.soft(requestSql.filter(sql => isMutation(sql) && !/\bidempotency_\w+\b/i.test(sql)), "replay/refusal must not prepare business writes").toEqual([]);
      if (noResolution) expect.soft(requestSql.filter(readsVersions), "target resolution must be inside the protected execution, not before replay").toEqual([]);
      effects.expectNoEffects();
    },
  };
}

export const snapshot = () => worldState([SLUG, OTHER]);

export async function claims() {
  return (await env.DB.prepare("SELECT * FROM idempotency_keys ORDER BY key_hash").all<{
    key_hash: string; input_hash: string; owner_token: string; state: string; result_json: string | null; expires_at: number;
  }>()).results;
}

export function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export async function bounded<T>(promise: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 3000);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
