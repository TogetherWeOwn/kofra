import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerBindings } from "@kofra/server";
import { jsonBody, ORIGIN, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import {
  create, FILES, get, instance, member, op, operations, recipientFile, refusal,
  siteFile, state, storedFileCount,
} from "./transfer-fixtures";

// Spec-derived breaks: sender metadata leaked through ordinary site operations,
// read-only downloads invalidating edits, truncated allLive, and partial revoke.
// No implementation diff was read to write these contracts.
let dw: Instance;
beforeEach(async () => { dw = await instance({ anonymous: { enabled: true } }); });

async function transferRow(id: string) {
  const row = await env.DB.prepare("SELECT * FROM transfers WHERE id = ?").bind(id).first();
  expect(row, "fixture must refer to a real transfer").not.toBeNull();
  return row!;
}

describe("ordinary site operations preserve transfer sender privacy", () => {
  it("list_sites includes the caller's delivery but not another sender's delivery", async () => {
    const alice = await member(dw, "private-sender@example.net");
    const bob = await member(dw, "listing-sender@example.net");
    const hidden = await create(dw, { slug: "private-parcel", message: "private-message-canary" }, alice.key);
    const visible = await create(dw, { slug: "my-parcel" }, bob.key);
    const listed = await op(dw, "list_sites", {}, bob.key);
    expect(listed.status).toBe(200);
    expect(listed.body.sites.map((s: { slug: string }) => s.slug)).toEqual([visible.slug]);
    expect(JSON.stringify(listed.body)).not.toContain(hidden.slug);
    expect(JSON.stringify(listed.body)).not.toContain(hidden.id);
    expect(JSON.stringify(listed.body)).not.toContain("private-message-canary");

    const client = await connectMcp(dw, bob.key);
    try {
      const result = await client.call("list_sites");
      expect(result.isError, result.text).toBe(false);
      expect(result.data.sites.map((s: { slug: string }) => s.slug)).toEqual([visible.slug]);
      expect(result.text).not.toContain(hidden.slug);
    } finally { await client.client.close(); }
  });

  it("claim_site with a dummy token neither returns nor changes another sender's delivery", async () => {
    const alice = await member(dw, "claim-owner@example.net");
    const bob = await member(dw, "claim-stranger@example.net");
    const hidden = await create(dw, { slug: "unclaimable-parcel", message: "claim-privacy-canary" }, alice.key);
    const before = await transferRow(hidden.id);
    const siteBefore = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(before.site_id).first();
    const denied = await op(dw, "claim_site", { slug: hidden.slug, claimToken: "dwc_dummy-transfer-claim-token" }, bob.key);
    expect(denied.status, JSON.stringify(denied.body)).toBe(404);
    expect(denied.body.error.code).toBe("site_not_found");
    expect(denied.body.site).toBeUndefined();
    for (const secret of [hidden.id, hidden.url, "claim-privacy-canary", "reader@example.net"]) {
      expect(JSON.stringify(denied.body)).not.toContain(secret);
    }
    expect(await transferRow(hidden.id)).toEqual(before);

    const client = await connectMcp(dw, bob.key);
    try {
      const result = await client.call("claim_site", { site: hidden.slug, claimToken: "dwc_dummy-transfer-claim-token" });
      expect(result.isError, result.text).toBe(true);
      expect(result.data.error.code).toBe(denied.body.error.code);
      expect(result.text).not.toContain(hidden.id);
      expect(result.text).not.toContain("claim-privacy-canary");
    } finally { await client.client.close(); }
    expect(await transferRow(hidden.id)).toEqual(before);
    expect(await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(before.site_id).first()).toEqual(siteBefore);
    const saved = await op(dw, "get_transfer", { transfer: hidden.id }, alice.key);
    expect(saved.status).toBe(200);
    expect((saved.body.transfer ?? saved.body).message).toBe("claim-privacy-canary");
  });
});

describe("download accounting is not a management edit", () => {
  it("HEAD preserves the management revision and all stored transfer fields", async () => {
    const t = await create(dw);
    const url = await recipientFile(dw, t, 0);
    const before = await transferRow(t.id);
    expect(before.revision, "management revision must be present for this regression").toEqual(expect.any(Number));
    const response = await dw.call(url, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(await transferRow(t.id)).toEqual(before);
    const saved = await get(dw, t);
    expect(saved.files.map((f) => f.downloads)).toEqual([0, 0]);
    expect(saved.recipients.map((r) => r.downloads)).toEqual([0]);
  });

  it("a resumed range counts as a download without touching the management revision or settings", async () => {
    const t = await create(dw);
    const url = await recipientFile(dw, t, 0);
    const before = await transferRow(t.id);
    expect(before.revision, "management revision must be present for this regression").toEqual(expect.any(Number));
    const response = await dw.call(url, { headers: { Range: "bytes=8-" } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe(" sample bytes");
    const after = await transferRow(t.id);
    expect(after.revision).toBe(before.revision);
    expect(after.message).toBe(before.message);
    expect(after.expires_at).toBe(before.expires_at);
    expect(after.download_limit).toBe(before.download_limit);
    expect(after.downloads).toBe((before.downloads as number) + 1);
    const saved = await get(dw, t);
    expect(saved.files.map((f) => f.downloads)).toEqual([1, 0]);
    expect(saved.recipients.map((r) => r.downloads)).toEqual([1]);
  });
});

describe("bulk revoke boundaries", () => {
  it("allLive revokes every one of 1001 live rows, leaving closed and foreign rows unchanged", async () => {
    const live = [];
    // Real creation keeps site/version/recipient identity and storage invariants;
    // no fabricated transfer rows or mocked revoke service can hide truncation.
    for (let start = 0; start < 1001; start += 10) {
      live.push(...await Promise.all(Array.from({ length: Math.min(10, 1001 - start) }, (_, i) =>
        create(dw, { slug: `bulk-parcel-${String(start + i).padStart(4, "0")}` }))));
    }
    const closed = await create(dw, { slug: "closed-bulk-parcel" });
    await state(closed, { expires_at: Date.now() - 1 });
    const other = await member(dw, "other-bulk-sender@example.net");
    const foreign = await create(dw, { slug: "foreign-bulk-parcel" }, other.key);
    const closedBefore = await transferRow(closed.id);
    const foreignBefore = await transferRow(foreign.id);
    const r = await op(dw, "revoke_transfers", { allLive: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.count).toBe(1001);
    const rows = await env.DB.prepare("SELECT id, revoked_at FROM transfers").all<{ id: string; revoked_at: number | null }>();
    const revoked = new Set(rows.results.filter((row) => row.revoked_at !== null).map((row) => row.id));
    expect(revoked.size).toBe(1001);
    for (const t of live) expect(revoked.has(t.id), t.slug).toBe(true);
    expect(await transferRow(closed.id)).toEqual(closedBefore);
    expect(await transferRow(foreign.id)).toEqual(foreignBefore);
    for (const t of [live[0]!, live[1000]!]) expect((await dw.call(siteFile(t))).status).toBe(410);
    expect((await dw.call(siteFile(foreign))).status).toBe(200);
  }, 120_000);

  it("a selected row expiring after selection but before the write leaves every other selected row unchanged", async () => {
    const selected = await Promise.all(["atomic-first", "atomic-stale", "atomic-last"].map((slug) => create(dw, { slug })));
    const before = await Promise.all(selected.map((t) => transferRow(t.id)));
    const expiresAt = Date.now() - 1;
    let injected = false;
    const inject = async () => {
      if (injected) return;
      injected = true;
      const changed = await env.DB.prepare("UPDATE transfers SET expires_at = ? WHERE id = ?").bind(expiresAt, selected[1]!.id).run();
      expect(changed.meta.changes).toBe(1);
    };
    // Inject the external state change only at the real D1 write boundary.
    // All selection, validation, statements, transactions and effects stay real.
    const prepared: string[] = [];
    const statements = new WeakMap<D1PreparedStatement, { raw: D1PreparedStatement; revoke: boolean }>();
    const wrap = (raw: D1PreparedStatement, revoke: boolean): D1PreparedStatement => {
      const wrapped = new Proxy(raw, { get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), revoke);
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (revoke && ["run", "all", "first", "raw"].includes(String(property))) await inject();
          return value.apply(target, args);
        };
      } });
      statements.set(wrapped, { raw, revoke });
      return wrapped;
    };
    const database = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        prepared.push(sql);
        return wrap(target.prepare(sql), /\bUPDATE\s+transfers\b[\s\S]*\brevoked_at\b/i.test(sql));
      };
      if (property === "batch") return async (batch: D1PreparedStatement[]) => {
        if (batch.some((statement) => statements.get(statement)?.revoke)) await inject();
        return target.batch(batch.map((statement) => statements.get(statement)?.raw ?? statement));
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const operation = (await operations(dw)).find((o) => o.id === "revoke_transfers")!;
    expect(operation).toBeDefined();
    const ctx = createExecutionContext();
    const response = await dw.kofra.fetch(new Request(new URL(operation.path, ORIGIN), {
      ...jsonBody({ ids: selected.map((t) => t.id) }), method: operation.method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${dw.ownerKey}` },
    }), { ...env, DB: database } as unknown as ServerBindings, ctx);
    await waitOnExecutionContext(ctx);
    const body = await response.json();
    expect(injected, JSON.stringify({ status: response.status, body, prepared })).toBe(true);
    refusal({ status: response.status, body }, 409);
    const after = await Promise.all(selected.map((t) => transferRow(t.id)));
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual({ ...before[1], expires_at: expiresAt });
    expect(after[2]).toEqual(before[2]);
    for (const t of [selected[0]!, selected[2]!]) {
      const download = await dw.call(siteFile(t));
      expect(download.status).toBe(200);
      expect(await download.text()).toBe(FILES[0]!.content);
    }
    expect((await dw.call(siteFile(selected[1]!))).status).toBe(410);
  });
});

describe("storage fixture identity survives deletion and slug reuse", () => {
  it("counts held files by transfer identity rather than the original or reused slug", async () => {
    const original = await create(dw);
    expect((await op(dw, "delete_site", { site: original.slug, confirm: original.slug })).status).toBe(200);
    await state(original, { legal_hold: 1 });
    expect(await storedFileCount(original)).toBe(2);
    const replacement = await create(dw, { files: [FILES[0]!] });
    expect(replacement.id).not.toBe(original.id);
    expect(await storedFileCount(original)).toBe(2);
    expect(await storedFileCount(replacement)).toBe(1);
  });
});
