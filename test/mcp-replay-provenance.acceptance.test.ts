import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { clearLiveMemoryCache } from "@dropway/core";
import { freshInstance, jsonBody, ORIGIN } from "./helpers";
import { worldState } from "./interleave-harness";
import { connectMcp, type ToolCall } from "./mcp-helpers";
import { ACTIONS, OTHER, SLUG, claims, fixture, observe, pointer, publish } from "./version-mutation-replay.helpers";

afterEach(() => { vi.restoreAllMocks(); clearLiveMemoryCache(); });

const RENAMED = "provenance-current-name";
const ORIGINAL_URL = `${ORIGIN}/s/${SLUG}/`;
const RENAMED_URL = `${ORIGIN}/s/${RENAMED}/`;
const EXTENSION_URL = "https://extension.test/current";

function expectJsonPresentation(result: ToolCall) {
  const jsonLine = result.text.split("\n").find(line => line.startsWith("{"));
  expect.soft(jsonLine, "the text channel must retain structuredContent").toBeDefined();
  if (jsonLine !== undefined) expect.soft(JSON.parse(jsonLine)).toEqual(result.data);
}

function expectOrdinary(result: ToolCall, url: string) {
  expect.soft(result.isError, JSON.stringify(result.data)).toBe(false);
  const headline = result.text.split("\n")[0] ?? "";
  expect.soft(headline, "ordinary presentation must describe the truthful current URL").toContain(url);
  expect.soft(headline, "a domain replayed flag is not proof of a stored historical receipt")
    .not.toMatch(/\b(?:replayed|historical|stored receipt|original receipt)\b/i);
  expect.soft(result.content, "unkeyed current results must retain an ordinary resource_link")
    .toContainEqual(expect.objectContaining({ type: "resource_link", uri: url }));
  for (const link of result.content.filter(block => block.type === "resource_link" && block.uri === url)) {
    const label = [link.name, link.title, link.description].filter(value => typeof value === "string").join(" ");
    expect.soft(label).not.toMatch(/\b(?:replayed|historical|stored receipt|original receipt)\b/i);
  }
  expectJsonPresentation(result);
}

function expectHistorical(result: ToolCall, first: ToolCall) {
  expect.soft(result.isError, JSON.stringify(result.data)).toBe(false);
  expect.soft(result.data, "historical receipts must not be recomputed from current state").toEqual({ ...first.data, replayed: true });
  const headline = result.text.split("\n")[0] ?? "";
  expect.soft(headline).toMatch(/^Replayed\b/i);
  expect.soft(headline).toMatch(/\b(?:historical|original|stored|receipt)\b|\bfirst result\b/i);
  expect.soft(result.content.filter(block => block.type === "resource_link"), "a stored receipt is not a current/live link").toEqual([]);
  expectJsonPresentation(result);
}

for (const modern of [true, false]) describe(`MCP ${modern ? "current" : "legacy"} replay provenance`, () => {
  it("presents unkeyed already-ready finalization as current, before and after an authorized rename", async () => {
    const h = await fixture();
    const ready = await env.DB.prepare("SELECT id, site_id, status FROM versions WHERE id = ?").bind(h.live).first();
    expect(ready).toEqual({ id: h.live, site_id: h.site.id, status: "ready" });
    expect(await pointer(h)).toBe(h.live);
    expect(await claims()).toEqual([]);
    const mcp = await connectMcp(h.dw, h.actor.key, { modern });
    // Both calls use immutable IDs and deliberately supply NO idempotency key.
    const args = { site: h.site.id, versionId: h.live };
    const check = async (slug: string, url: string) => {
      const result = await mcp.call("finalize_version", args);
      expect.soft(result.data).toMatchObject({
        slug, url, status: "live", replayed: true,
        version: { id: h.live, status: "ready", live: true },
        site: { id: h.site.id, slug, url, currentVersionId: h.live, currentVersion: { id: h.live, status: "ready", live: true } },
      });
      expectOrdinary(result, url);
      expect.soft(result.text.split("\n")[0], "finalize retains its ordinary completion summary").toMatch(/^(?:Already live|Published|Finalized)\b/i);
      expect.soft(await pointer(h), "the already-ready finalize remains a no-op").toBe(h.live);
      expect.soft(await claims(), "an unkeyed finalize must not create a replay claim").toEqual([]);
    };
    try {
      await check(SLUG, ORIGINAL_URL);
      const renamed = await h.dw.json(`/api/v1/sites/${h.site.id}/rename`, {
        key: h.dw.ownerKey, ...jsonBody({ newSlug: RENAMED }),
      });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      expect(await env.DB.prepare("SELECT slug, current_version_id FROM sites WHERE id = ?").bind(h.site.id).first())
        .toEqual({ slug: RENAMED, current_version_id: h.live });
      await check(RENAMED, RENAMED_URL);
    } finally { await mcp.client.close(); }
  });

  it("does not reserve an extension's own replayed field for transport provenance", async () => {
    let executions = 0;
    const dw = await freshInstance({}, {
      mcpTools: [{
        name: "extension_domain_result",
        toolset: "extra",
        description: "Returns an extension's current domain result.",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: { replayed: { type: "boolean" }, url: { type: "string" }, domain: { type: "string" } },
          required: ["replayed", "url", "domain"],
        },
        scopes: ["sites:read"],
        annotations: { readOnlyHint: true },
        async handler() {
          executions++;
          return { replayed: true, url: EXTENSION_URL, domain: "current-extension-result" };
        },
        summarize: data => `Extension result at ${data.url}`,
      }],
    });
    const mcp = await connectMcp(dw, dw.ownerKey, { modern });
    try {
      const first = await mcp.call("extension_domain_result", {});
      expect.soft(first.data).toEqual({ replayed: true, url: EXTENSION_URL, domain: "current-extension-result" });
      expect.soft(first.text.split("\n")[0], "the extension's declared summary must survive its first unkeyed call")
        .toBe(`Extension result at ${EXTENSION_URL}`);
      expectOrdinary(first, EXTENSION_URL);
      expect.soft(executions, "this is a real first execution, not a replay lookup").toBe(1);
      expect.soft(await claims()).toEqual([]);
    } finally { await mcp.client.close(); }
  });

  it("preserves an outer keyed publish replay as historical without repeating effects", async () => {
    const h = await fixture();
    const mcp = await connectMcp(h.dw, h.actor.key, { modern });
    try {
      const args = {
        site: h.site.id, files: [{ path: "index.html", content: "<h1>Outer provenance receipt</h1>" }],
        idempotencyKey: "outer-provenance-intent",
      };
      const first = await mcp.call("publish_site", args);
      expect(first.isError, JSON.stringify(first.data)).toBe(false);
      expect(first.data.replayed).not.toBe(true);
      expectOrdinary(first, ORIGINAL_URL);
      expect(await claims(), "the outer MCP wrapper must actually store a receipt").toHaveLength(1);
      const winner = await publish(h.dw, "a later publish after the outer receipt");
      const before = await worldState([SLUG, OTHER]);
      const beforeClaims = await claims();
      const observed = observe(h);
      const replay = await mcp.call("publish_site", args);
      observed.expectNoAction();
      expectHistorical(replay, first);
      expect.soft(await pointer(h)).toBe(winner);
      expect.soft(await worldState([SLUG, OTHER])).toEqual(before);
      expect.soft(await claims()).toEqual(beforeClaims);
    } finally { await mcp.client.close(); }
  });

  for (const action of ACTIONS) it(`preserves an inner keyed ${action} receipt without re-executing after a later publish`, async () => {
    const h = await fixture();
    const mcp = await connectMcp(h.dw, h.actor.key, { modern });
    try {
      const args = {
        site: h.site.id, version: h.target, ...(action === "delete" ? { confirm: SLUG } : {}),
        idempotencyKey: `inner-${action}-provenance-intent`,
      };
      const first = await mcp.call(`${action}_version`, args);
      expect(first.isError, JSON.stringify(first.data)).toBe(false);
      expect(first.data.replayed).not.toBe(true);
      if (action === "restore") {
        expect(first.data).toMatchObject({ restored: true, version: { id: h.target, live: true } });
        expect(await pointer(h)).toBe(h.target);
        expect(h.published.filter(event => event.kind === "restore")).toHaveLength(1);
        expectOrdinary(first, ORIGINAL_URL);
      } else {
        expect(first.data).toMatchObject({ deleted: true });
        expect(await env.DB.prepare("SELECT id FROM versions WHERE id = ?").bind(h.target).first()).toBeNull();
      }
      expect(await claims()).toHaveLength(1);
      const winner = await publish(h.dw, `a later publish after the inner ${action} receipt`);
      const before = await worldState([SLUG, OTHER]);
      const beforeClaims = await claims();
      const observed = observe(h);
      const replay = await mcp.call(`${action}_version`, args);
      observed.expectNoAction();
      expectHistorical(replay, first);
      expect.soft(await pointer(h)).toBe(winner);
      expect.soft(await worldState([SLUG, OTHER])).toEqual(before);
      expect.soft(await claims()).toEqual(beforeClaims);
    } finally { await mcp.client.close(); }
  });
});
