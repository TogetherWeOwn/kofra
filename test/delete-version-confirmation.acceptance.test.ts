import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";

const SLUG = "confirm-version";

async function fixture() {
  const dw = await freshInstance();
  const publish = (content: string) => dw.json("/api/v1/publish", {
    key: dw.ownerKey, ...jsonBody({ slug: SLUG, files: [{ path: "index.html", content }] }),
  });
  const old = await publish("old version");
  expect(old.status).toBe(201);
  const live = await publish("live version");
  expect(live.status).toBe(200);
  const site = await env.DB.prepare("SELECT * FROM sites WHERE slug = ?").bind(SLUG).first<{ id: string; current_version_id: string }>();
  expect(site?.current_version_id).toBe(live.body.version.id);
  if (!site) throw new Error("Fixture site missing");
  return { dw, site, old: old.body.version.id as string, live: live.body.version.id as string, url: live.body.url as string };
}

// Snapshot every user table, not just the target row: refused destructive calls
// must not alter files, site metadata, usage, or any other persisted state.
async function databaseState() {
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) != '_cf_' ORDER BY name").all<{ name: string }>()).results;
  const result: Record<string, string[]> = {};
  for (const { name } of tables) {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const rows = (await env.DB.prepare(`SELECT * FROM ${quoted}`).all()).results;
    result[name] = rows.map((row) => JSON.stringify(row)).sort();
  }
  return result;
}

async function assertDeleted(dw: Instance, siteId: string, old: string, live: string) {
  expect(await env.DB.prepare("SELECT id FROM versions WHERE id = ?").bind(old).first()).toBeNull();
  expect(await env.DB.prepare("SELECT id FROM versions WHERE id = ?").bind(live).first()).toMatchObject({ id: live });
  expect(await env.DB.prepare("SELECT current_version_id FROM sites WHERE id = ?").bind(siteId).first()).toMatchObject({ current_version_id: live });
  const page = await dw.call(`/s/${SLUG}/`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("live version");
}

describe("delete_version confirmation across REST and MCP", () => {
  it.each(["missing", "wrong", "correct"] as const)("REST %s confirmation", async (confirmation) => {
    const f = await fixture();
    const before = await databaseState();
    const body = confirmation === "missing" ? {} : { confirm: confirmation === "correct" ? SLUG : "not-the-slug" };
    const result = await f.dw.json(`/api/v1/sites/${SLUG}/versions/${f.old}`, {
      method: "DELETE", key: f.dw.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (confirmation === "correct") {
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body).toMatchObject({ deleted: true, id: f.old });
      await assertDeleted(f.dw, f.site.id, f.old, f.live);
    } else {
      expect.soft(result.status, JSON.stringify(result.body)).toBe(400);
      expect.soft(result.body).toMatchObject({ error: { code: confirmation === "missing" ? "invalid_request" : "confirm_mismatch" } });
      expect(await databaseState()).toEqual(before);
    }
  });

  it.each(["raw-id", "canonical-slug"] as const)("REST site ID with %s confirmation", async confirmation => {
    const f = await fixture();
    const before = await databaseState();
    const result = await f.dw.json(`/api/v1/sites/${f.site.id}/versions/${f.old}`, {
      method: "DELETE", key: f.dw.ownerKey, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: confirmation === "raw-id" ? f.site.id : SLUG }),
    });
    if (confirmation === "canonical-slug") {
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body).toMatchObject({ deleted: true, id: f.old });
      await assertDeleted(f.dw, f.site.id, f.old, f.live);
    } else {
      expect.soft(result.status, JSON.stringify(result.body)).toBe(400);
      expect.soft(result.body).toMatchObject({ error: { code: "confirm_mismatch" } });
      expect(await databaseState()).toEqual(before);
    }
  });

  it.each(["missing", "wrong", "correct"] as const)("MCP %s confirmation", async (confirmation) => {
    const f = await fixture();
    const mcp = await connectMcp(f.dw, f.dw.ownerKey);
    try {
      const before = await databaseState();
      const args: Record<string, unknown> = { site: SLUG, version: f.old };
      if (confirmation !== "missing") args.confirm = confirmation === "correct" ? SLUG : "not-the-slug";
      const result = await mcp.call("delete_version", args);
      if (confirmation === "correct") {
        expect(result.isError, result.text).toBe(false);
        expect(result.data).toMatchObject({ deleted: true, id: f.old });
        await assertDeleted(f.dw, f.site.id, f.old, f.live);
      } else {
        expect(result.isError, result.text).toBe(true);
        if (confirmation === "wrong") expect(result.data).toMatchObject({ error: { code: "confirm_mismatch" } });
        expect(await databaseState()).toEqual(before);
      }
    } finally {
      await mcp.client.close();
    }
  });

  it.each(["id", "url"] as const)("MCP site %s requires the canonical slug, not the supplied reference", async (kind) => {
    const f = await fixture();
    const mcp = await connectMcp(f.dw, f.dw.ownerKey);
    try {
      const ref = kind === "id" ? f.site.id : f.url;
      expect(ref).toBeTruthy();
      expect(ref).not.toBe(SLUG);
      const before = await databaseState();
      const rejected = await mcp.call("delete_version", { site: ref, version: f.old, confirm: ref });
      expect(rejected.isError, rejected.text).toBe(true);
      expect(rejected.data).toMatchObject({ error: { code: "confirm_mismatch" } });
      expect(await databaseState()).toEqual(before);
      const accepted = await mcp.call("delete_version", { site: ref, version: f.old, confirm: SLUG });
      expect(accepted.isError, accepted.text).toBe(false);
      expect(accepted.data).toMatchObject({ deleted: true, id: f.old });
      await assertDeleted(f.dw, f.site.id, f.old, f.live);
    } finally {
      await mcp.client.close();
    }
  });
});
