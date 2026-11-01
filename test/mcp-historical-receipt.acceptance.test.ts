import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { clearLiveMemoryCache } from "@dropway/core";
import { jsonBody, ORIGIN } from "./helpers";
import { worldState } from "./interleave-harness";
import { connectMcp, type ToolCall } from "./mcp-helpers";
import { OTHER, SLUG, claims, fixture, observe, pointer, publish } from "./version-mutation-replay.helpers";

afterEach(() => { vi.restoreAllMocks(); clearLiveMemoryCache(); });

const RENAMED = "historical-original-renamed";
const ORIGINAL_URL = `${ORIGIN}/s/${SLUG}/`;
const RENAMED_URL = `${ORIGIN}/s/${RENAMED}/`;

function expectCurrentPresentation(result: ToolCall, url: string) {
  expect.soft(result.isError, JSON.stringify(result.data)).toBe(false);
  expect.soft(result.data.replayed).not.toBe(true);
  const headline = result.text.split("\n")[0] ?? "";
  expect.soft(headline, "ordinary first execution still describes the completed action").toMatch(/^(Created|Published|Updated|Restored|Already live)\b/i);
  expect.soft(headline, "the first-execution text must use the current URL").toContain(url);
  expect.soft(headline, "first execution must not be advertised as a historical replay").not.toMatch(/^(Replayed|Historical receipt)\b/i);
  expect.soft(result.content, "ordinary first execution still exposes its live URL").toContainEqual(expect.objectContaining({ type: "resource_link", uri: url }));
}

function expectHistoricalPresentation(result: ToolCall, first: ToolCall) {
  expect.soft(result.isError, JSON.stringify(result.data)).toBe(false);
  expect.soft(result.data, "preserve every field of the stored receipt, including its historical URL").toEqual({ ...first.data, replayed: true });
  const headline = result.text.split("\n")[0] ?? "";
  expect.soft(headline, "human-readable presentation must recognize replay from either wrapper").toMatch(/^Replayed\b/i);
  expect.soft(headline, "the prose must identify a historical receipt rather than synthesize current success").toMatch(/\b(histor(?:ical|ic)|original|stored|receipt)\b|\bfirst result\b/i);
  const jsonLine = result.text.split("\n").find(line => line.startsWith("{"));
  expect.soft(jsonLine, "the text channel must carry the same receipt as structuredContent").toBeDefined();
  if (jsonLine !== undefined) expect.soft(JSON.parse(jsonLine)).toEqual(result.data);

  // Suppressing links is fine. If retained, EACH link must be explicitly
  // historical; an unqualified live/shareable link could now serve another site.
  for (const link of result.content.filter(block => block.type === "resource_link")) {
    expect.soft([first.data.url, first.data.versionUrl].filter(Boolean), "do not recompute a replay link from current site state").toContain(link.uri);
    let label = [link.name, link.title, link.description].filter(value => typeof value === "string").join(" ");
    // A slug such as "mutation-replay" is an identifier, not replay wording.
    for (const reference of [first.data.url, first.data.versionUrl, first.data.slug, RENAMED, SLUG, OTHER]) {
      if (typeof reference === "string" && reference) label = label.split(reference).join("[reference]");
    }
    expect.soft(label, "a retained resource link must be explicitly historical, never an unqualified current/live/shareable URL")
      .toMatch(/\b(histor(?:ical|ic)|original|stored|replay(?:ed)?)\b/i);
  }
}

for (const modern of [true, false]) describe(`MCP ${modern ? "current" : "legacy"} historical receipt presentation`, () => {
  it("keeps an inner restore replay historical after authorized old-slug release and reuse", async () => {
    const h = await fixture();
    const mcp = await connectMcp(h.dw, h.actor.key, { modern });
    try {
      const args = { site: h.site.id, version: h.target, idempotencyKey: "historical-restore-intent" };
      const first = await mcp.call("restore_version", args);
      expect(first.isError, JSON.stringify(first.data)).toBe(false);
      expect(first.data).toMatchObject({ restored: true, alreadyLive: false, url: ORIGINAL_URL, version: { id: h.target, live: true } });
      expectCurrentPresentation(first, ORIGINAL_URL);

      const renamed = await h.dw.json(`/api/v1/sites/${h.site.id}/rename`, {
        key: h.dw.ownerKey, ...jsonBody({ newSlug: RENAMED }),
      });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      const released = await h.dw.json("/api/v1/slugs/release", {
        key: h.dw.ownerKey, ...jsonBody({ slug: SLUG, confirm: SLUG, reason: "Disposable historical receipt regression" }),
      });
      expect(released.status, JSON.stringify(released.body)).toBe(200);
      expect(released.body.released).toBe(true);
      const reused = await h.dw.json(`/api/v1/sites/${h.other.id}/rename`, {
        key: h.dw.ownerKey, ...jsonBody({ newSlug: SLUG }),
      });
      expect(reused.status, JSON.stringify(reused.body)).toBe(200);
      const holder = await env.DB.prepare("SELECT id, current_version_id FROM sites WHERE slug = ?").bind(SLUG)
        .first<{ id: string; current_version_id: string }>();
      expect(holder).toEqual({ id: h.other.id, current_version_id: h.other.current_version_id });
      const oldAddress = await h.dw.call(ORIGINAL_URL);
      expect(oldAddress.status).toBe(200);
      expect(await oldAddress.text(), "the saved URL now REALLY serves the other owned site, not the restored site").toContain("<h1>other live</h1>");
      const winner = await publish(h.dw, "a later publish at the original site's new URL", RENAMED);

      const before = await worldState([SLUG, OTHER, RENAMED]);
      const beforeClaims = await claims();
      const observed = observe(h);
      const replay = await mcp.call("restore_version", args);
      observed.expectNoAction();
      expect.soft(await pointer(h), "replay must not undo the later publication").toBe(winner);
      expect.soft(await worldState([SLUG, OTHER, RENAMED])).toEqual(before);
      expect.soft(await claims()).toEqual(beforeClaims);
      expectHistoricalPresentation(replay, first);
      expect.soft(replay.text.split("\n")[0], "never substitute the original site's new URL into a stored receipt").not.toContain(RENAMED_URL);

      // The replacement site's authorized old slug cannot retrieve site A's
      // receipt, even though both sites belong to this same caller.
      observed.clear();
      const wrongSite = await mcp.call("restore_version", { ...args, site: SLUG });
      expect.soft(wrongSite.isError).toBe(true);
      expect.soft(wrongSite.data.error?.code).toBe("idempotency_key_reused");
      observed.expectNoAction();
      expect.soft(await worldState([SLUG, OTHER, RENAMED])).toEqual(before);
      expect.soft(await claims()).toEqual(beforeClaims);

      // A genuinely new intent DOES execute and presents A's current URL.
      observed.clear();
      const fresh = await mcp.call("restore_version", { ...args, idempotencyKey: "fresh-restore-after-rename" });
      expect.soft(fresh.data).toMatchObject({ restored: true, alreadyLive: false, url: RENAMED_URL, version: { id: h.target, live: true } });
      expectCurrentPresentation(fresh, RENAMED_URL);
      expect.soft(await pointer(h)).toBe(h.target);
      expect.soft(h.published.filter(event => event.kind === "restore")).toHaveLength(1);
      expect.soft(await env.DB.prepare("SELECT current_version_id FROM sites WHERE id = ?").bind(h.other.id)
        .first("current_version_id")).toBe(h.other.current_version_id);
    } finally { await mcp.client.close(); }
  });

  it("keeps ordinary publish presentation and outer generic replay presentation distinct", async () => {
    const h = await fixture();
    const mcp = await connectMcp(h.dw, h.actor.key, { modern });
    try {
      const args = { site: SLUG, files: [{ path: "index.html", content: "<h1>Outer replay receipt</h1>" }], idempotencyKey: "outer-publish-intent" };
      const first = await mcp.call("publish_site", args);
      expect(first.isError, JSON.stringify(first.data)).toBe(false);
      expect(first.data.url).toBe(ORIGINAL_URL);
      expect(first.data.version.id).not.toBe(h.live);
      expectCurrentPresentation(first, ORIGINAL_URL);
      const winner = await publish(h.dw, "a later publication after the generic receipt");
      const before = await worldState([SLUG, OTHER]);
      const beforeClaims = await claims();
      const observed = observe(h);
      const replay = await mcp.call("publish_site", args);
      observed.expectNoAction();
      expect.soft(await pointer(h)).toBe(winner);
      expect.soft(await worldState([SLUG, OTHER])).toEqual(before);
      expect.soft(await claims()).toEqual(beforeClaims);
      expectHistoricalPresentation(replay, first);
    } finally { await mcp.client.close(); }
  });
});
