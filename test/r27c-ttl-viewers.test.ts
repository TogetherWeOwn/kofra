import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clearLiveMemoryCache, runCleanup } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { form, freshInstance, jsonBody, manifestEntry, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";

const BROWSER_NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const JSON_HEADERS = { "Content-Type": "application/json" };

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

const publish = (files: Record<string, string>, fields: Record<string, string> = {}, inst: Instance = dw) =>
  inst.json("/api/v1/publish", { method: "POST", key: inst.ownerKey, body: form(files, fields) });

const patchSite = (slug: string, body: Record<string, unknown>, key = dw.ownerKey) =>
  dw.json(`/api/v1/sites/${slug}`, { method: "PATCH", key, headers: JSON_HEADERS, body: JSON.stringify(body) });

const usageSites = async () => (await env.DB.prepare("SELECT value FROM usage_counters WHERE key = 'sites'").all<{ value: number }>()).results[0]?.value;

describe("keyed-site TTL (PUB-16)", () => {
  it("sets ttlSeconds through PATCH and reports expiresAt; null clears it", async () => {
    const pub = await publish({ "index.html": "<p>x</p>" }, { slug: "ttl-site" });
    expect(pub.status).toBe(201);
    expect(pub.body.site.settings).toMatchObject({ ttlSeconds: null, viewers: true });
    expect(pub.body.site.expiresAt).toBeNull();

    const before = Date.now();
    const patched = await patchSite("ttl-site", { ttlSeconds: 3600 });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.site.settings.ttlSeconds).toBe(3600);
    const expires = Date.parse(patched.body.site.expiresAt);
    expect(expires - before).toBeGreaterThan(3599_000);
    expect(expires - before).toBeLessThan(3601_000);

    // A TTL'd keyed site is expiring, so crawlers are told to stay out.
    expect((await dw.call("/s/ttl-site/")).headers.get("x-robots-tag")).toBe("noindex");

    const cleared = await patchSite("ttl-site", { ttlSeconds: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.site.settings.ttlSeconds).toBeNull();
    expect(cleared.body.site.expiresAt).toBeNull();
    expect((await dw.call("/s/ttl-site/")).headers.get("x-robots-tag")).toBe("all");
  });

  it("carries ttlSeconds through publish (multipart string, JSON, republish)", async () => {
    const multi = await publish({ "index.html": "<p>x</p>" }, { slug: "ttl-multi", ttlSeconds: "7200" });
    expect(multi.status).toBe(201);
    expect(multi.body.site.settings.ttlSeconds).toBe(7200);

    const js = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      headers: JSON_HEADERS,
      body: JSON.stringify({ files: [{ path: "index.html", content: "<p>x</p>" }], slug: "ttl-json", ttlSeconds: 60 }),
    });
    expect(js.status).toBe(201);
    expect(js.body.site.settings).toMatchObject({ ttlSeconds: 60 });

    // Republishing without a TTL keeps the old one but renews the expiry.
    await env.DB.prepare("UPDATE sites SET expires_at = ? WHERE slug = 'ttl-json'").bind(Date.now() + 1000).run();
    const before = Date.now();
    const again = await publish({ "index.html": "<p>y</p>" }, { slug: "ttl-json" });
    expect(again.status).toBe(200);
    expect(again.body.site.settings.ttlSeconds).toBe(60);
    const renewed = Date.parse(again.body.site.expiresAt);
    expect(renewed - before).toBeGreaterThan(59_000);
    expect(renewed - before).toBeLessThan(61_000);
  });

  it("rejects bad TTLs and anonymous TTLs", async () => {
    const pub = await publish({ "index.html": "<p>x</p>" }, { slug: "ttl-bad" });
    expect(pub.status).toBe(201);
    // Out-of-range integers reach the service (invalid_field); wrong JSON types
    // are refused by input validation first (invalid_request), like other settings.
    for (const ttlSeconds of [0, -5, Number.MAX_SAFE_INTEGER]) {
      const bad = await patchSite("ttl-bad", { ttlSeconds });
      expect(bad.status, JSON.stringify(ttlSeconds)).toBe(400);
      expect(bad.body.error.code).toBe("invalid_field");
    }
    for (const ttlSeconds of [1.5, "soon"]) {
      const bad = await patchSite("ttl-bad", { ttlSeconds });
      expect(bad.status, JSON.stringify(ttlSeconds)).toBe(400);
      expect(bad.body.error.code).toBe("invalid_request");
    }
    // Untouched by the refusals above.
    expect((await patchSite("ttl-bad", {})).body.site.settings.ttlSeconds).toBeNull();

    // Anonymous sites keep their fixed 24 h expiry: no TTL on create or update.
    const anon = await freshInstance({ anonymous: { enabled: true } });
    const named = await anon.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "x" }, { ttlSeconds: "3600" }) });
    expect(named.status).toBe(403);
    const claimed = await anon.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "x" }) });
    expect(claimed.status).toBe(201);
    const viaClaim = await anon.json(`/api/v1/sites/${claimed.body.slug}`, {
      method: "PATCH",
      key: claimed.body.claimToken,
      headers: JSON_HEADERS,
      body: JSON.stringify({ ttlSeconds: 3600 }),
    });
    expect(viaClaim.status).toBe(403);
  });

  it("expired keyed sites answer 410 and go through expiry cleanup with usage refresh", async () => {
    const pub = await publish({ "index.html": "<p>ttl</p>" }, { slug: "ttl-gone", ttlSeconds: "3600" });
    expect(pub.status).toBe(201);
    expect(await usageSites()).toBe(1);

    await env.DB.prepare("UPDATE sites SET expires_at = ? WHERE slug = 'ttl-gone'").bind(Date.now() - 1000).run();
    await env.CACHE.delete("live:ttl-gone");
    clearLiveMemoryCache();
    const gone = await dw.call("/s/ttl-gone/");
    expect(gone.status).toBe(410);
    expect(await gone.text()).toContain("TTL");

    const ctx = createExecutionContext();
    const report = await runCleanup(dw.dropway.context(env as unknown as ServerBindings, ctx));
    await waitOnExecutionContext(ctx);
    expect(report.expiredSites).toBe(1);
    // The keyed expiry refreshed its tenant's counters at once.
    expect(await usageSites()).toBe(0);
    clearLiveMemoryCache();
    expect((await dw.call("/s/ttl-gone/")).status).toBe(404);
  });

  it("identical republish renews the TTL expiry", async () => {
    const pub = await publish({ "index.html": "<p>x</p>" }, { slug: "ttl-same", ttlSeconds: "3600" });
    expect(pub.status).toBe(201);
    // Force the deadline near, then publish the identical files again.
    await env.DB.prepare("UPDATE sites SET expires_at = ? WHERE slug = 'ttl-same'").bind(Date.now() + 1000).run();
    const before = Date.now();
    const again = await publish({ "index.html": "<p>x</p>" }, { slug: "ttl-same" });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.unchanged).toBe(true);
    expect(again.body.site.settings.ttlSeconds).toBe(3600);
    const renewed = Date.parse(again.body.site.expiresAt);
    expect(renewed - before).toBeGreaterThan(3599_000);
    expect(renewed - before).toBeLessThan(3601_000);
  });

  it("TTL edits around a pending finalize converge", async () => {
    const e = await manifestEntry("index.html", "<p>pending</p>");
    const { bytes: _b, ...entry } = e;
    const startPending = async (slug: string) => {
      const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug }) });
      expect(created.status).toBe(201);
      const deploy = await dw.json(`/api/v1/sites/${slug}/versions`, { key: dw.ownerKey, ...jsonBody({ files: [entry] }) });
      expect(deploy.status).toBe(201);
      const up = await dw.json(`/api/v1/blobs/${e.sha256}`, { method: "PUT", key: dw.ownerKey, body: e.bytes, headers: { "Content-Length": String(e.size) } });
      expect([200, 201]).toContain(up.status);
      return deploy.body.deploy.id as string;
    };
    const finalize = (slug: string, id: string) =>
      dw.json(`/api/v1/sites/${slug}/deploys/${id}/finalize`, { method: "POST", key: dw.ownerKey });

    // Set, then clear before finalize: the site stays expiry-free.
    const clearId = await startPending("ttl-clear-race");
    expect((await patchSite("ttl-clear-race", { ttlSeconds: 3600 })).status).toBe(200);
    expect((await patchSite("ttl-clear-race", { ttlSeconds: null })).status).toBe(200);
    expect((await finalize("ttl-clear-race", clearId)).status).toBe(200);
    const cleared = await patchSite("ttl-clear-race", {});
    expect(cleared.body.site.settings.ttlSeconds).toBeNull();
    expect(cleared.body.site.expiresAt).toBeNull();

    // No TTL, then set before finalize: the finalize renews with the new TTL.
    const setId = await startPending("ttl-set-race");
    const before = Date.now();
    expect((await patchSite("ttl-set-race", { ttlSeconds: 60 })).status).toBe(200);
    expect((await finalize("ttl-set-race", setId)).status).toBe(200);
    const set = await patchSite("ttl-set-race", {});
    expect(set.body.site.settings.ttlSeconds).toBe(60);
    const renewed = Date.parse(set.body.site.expiresAt);
    expect(renewed - before).toBeGreaterThan(59_000);
    expect(renewed - before).toBeLessThan(61_000);
  });

  it("concurrent finalize and TTL edit converge", async () => {
    const e = await manifestEntry("index.html", "<p>race</p>");
    const { bytes: _b, ...entry } = e;
    const startPending = async (slug: string) => {
      const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug }) });
      expect(created.status).toBe(201);
      const deploy = await dw.json(`/api/v1/sites/${slug}/versions`, { key: dw.ownerKey, ...jsonBody({ files: [entry] }) });
      expect(deploy.status).toBe(201);
      const up = await dw.json(`/api/v1/blobs/${e.sha256}`, { method: "PUT", key: dw.ownerKey, body: e.bytes, headers: { "Content-Length": String(e.size) } });
      expect([200, 201]).toContain(up.status);
      return deploy.body.deploy.id as string;
    };

    // Clear racing a finalize: every interleaving ends expiry-free.
    const clearId = await startPending("ttl-clear-concurrent");
    expect((await patchSite("ttl-clear-concurrent", { ttlSeconds: 3600 })).status).toBe(200);
    const [finClear, patchClear] = await Promise.all([
      dw.json(`/api/v1/sites/ttl-clear-concurrent/deploys/${clearId}/finalize`, { method: "POST", key: dw.ownerKey }),
      patchSite("ttl-clear-concurrent", { ttlSeconds: null }),
    ]);
    expect(finClear.status, JSON.stringify(finClear.body)).toBe(200);
    expect(patchClear.status).toBe(200);
    const cleared = await patchSite("ttl-clear-concurrent", {});
    expect(cleared.body.site.settings.ttlSeconds).toBeNull();
    expect(cleared.body.site.expiresAt).toBeNull();

    // Set racing a finalize: every interleaving ends with the new TTL renewed.
    const setId = await startPending("ttl-set-concurrent");
    const before = Date.now();
    const [finSet, patchSet] = await Promise.all([
      dw.json(`/api/v1/sites/ttl-set-concurrent/deploys/${setId}/finalize`, { method: "POST", key: dw.ownerKey }),
      patchSite("ttl-set-concurrent", { ttlSeconds: 60 }),
    ]);
    expect(finSet.status, JSON.stringify(finSet.body)).toBe(200);
    expect(patchSet.status).toBe(200);
    const set = await patchSite("ttl-set-concurrent", {});
    expect(set.body.site.settings.ttlSeconds).toBe(60);
    const renewed = Date.parse(set.body.site.expiresAt);
    expect(renewed - before).toBeGreaterThan(59_000);
    expect(renewed - before).toBeLessThan(63_000);
  });

  it("sets ttlSeconds and viewers through MCP", async () => {
    const pub = await publish({ "index.html": "<p>x</p>" }, { slug: "ttl-mcp" });
    expect(pub.status).toBe(201);
    const mcp = await connectMcp(dw, dw.ownerKey);
    const r = await mcp.call("update_site_settings", { site: "ttl-mcp", ttlSeconds: 3600, viewers: false });
    expect(r.isError).toBe(false);
    expect(r.data.site.settings).toMatchObject({ ttlSeconds: 3600, viewers: false });
    const cleared = await mcp.call("update_site_settings", { site: "ttl-mcp", ttlSeconds: null, viewers: true });
    expect(cleared.isError).toBe(false);
    expect(cleared.data.site.settings).toMatchObject({ ttlSeconds: null, viewers: true });
  });
});

describe("per-site viewers switch (VIEW-06)", () => {
  it("viewers:false serves every file raw, including ?view=1 and ?view=source", async () => {
    const pub = await publish({ "index.html": "<h1>hi</h1>", "note.md": "# Hello\n" }, { slug: "raw-site" });
    expect(pub.status).toBe(201);
    // Sanity: with viewers on, navigations render.
    const rendered = await dw.call("/s/raw-site/note.md", { headers: BROWSER_NAV });
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("x-kofra-viewer")).toBe("markdown");
    expect((await rendered.text())).toContain('<h1 id="hello">');

    const patched = await patchSite("raw-site", { viewers: false });
    expect(patched.status).toBe(200);
    expect(patched.body.site.settings.viewers).toBe(false);

    const md = await dw.call("/s/raw-site/note.md", { headers: BROWSER_NAV });
    expect(md.status).toBe(200);
    expect(md.headers.get("x-kofra-viewer")).toBeNull();
    expect(await md.text()).toBe("# Hello\n");

    const forced = await dw.call("/s/raw-site/note.md?view=1", { headers: BROWSER_NAV });
    expect(forced.status).toBe(200);
    expect(forced.headers.get("x-kofra-viewer")).toBeNull();
    expect(await forced.text()).toBe("# Hello\n");

    const source = await dw.call("/s/raw-site/note.md?view=source", { headers: BROWSER_NAV });
    expect(source.status).toBe(200);
    expect(source.headers.get("x-kofra-viewer")).toBeNull();
    expect(await source.text()).toBe("# Hello\n");

    const html = await dw.call("/s/raw-site/index.html", { headers: BROWSER_NAV });
    expect(html.headers.get("x-kofra-viewer")).toBeNull();
    expect(await html.text()).toBe("<h1>hi</h1>");

    // Flipping it back on restores the rendered pages.
    await patchSite("raw-site", { viewers: true });
    const again = await dw.call("/s/raw-site/note.md", { headers: BROWSER_NAV });
    expect(again.headers.get("x-kofra-viewer")).toBe("markdown");
  });

  it("renderMarkdown:false keeps serving .md raw while viewers are on", async () => {
    const pub = await publish({ "index.html": "<p>x</p>", "note.md": "# Hello\n" }, { slug: "md-site" });
    expect(pub.status).toBe(201);
    const patched = await patchSite("md-site", { renderMarkdown: false });
    expect(patched.body.site.settings).toMatchObject({ renderMarkdown: false, viewers: true });

    const md = await dw.call("/s/md-site/note.md", { headers: BROWSER_NAV });
    expect(md.headers.get("x-kofra-viewer")).toBeNull();
    expect(await md.text()).toBe("# Hello\n");
  });

  it("carries viewers through publish and create_site", async () => {
    const multi = await publish({ "index.html": "<p>x</p>" }, { slug: "raw-multi", viewers: "false" });
    expect(multi.status).toBe(201);
    expect(multi.body.site.settings.viewers).toBe(false);
    expect((await dw.call("/s/raw-multi/", { headers: BROWSER_NAV })).headers.get("x-kofra-viewer")).toBeNull();

    const created = await dw.json("/api/v1/sites", {
      method: "POST",
      key: dw.ownerKey,
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: "raw-created", viewers: false }),
    });
    expect(created.status).toBe(201);
    expect(created.body.site.settings.viewers).toBe(false);
  });

  it("viewers:false serves byte-exact HTML in path mode", async () => {
    const html = '<img src="/logo.png">';
    const pub = await publish({ "index.html": html }, { slug: "raw-bytes" });
    expect(pub.status).toBe(201);
    // Viewers on: path mode prefixes the root-relative URL.
    const rewritten = await dw.call("/s/raw-bytes/index.html", { headers: BROWSER_NAV });
    expect(rewritten.status).toBe(200);
    expect(rewritten.headers.get("x-kofra-rewritten")).toBe("path-prefix");
    expect(await rewritten.text()).toContain("/s/raw-bytes/logo.png");

    expect((await patchSite("raw-bytes", { viewers: false })).status).toBe(200);
    const raw = await dw.call("/s/raw-bytes/index.html", { headers: BROWSER_NAV });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("x-kofra-viewer")).toBeNull();
    expect(raw.headers.get("x-kofra-rewritten")).toBeNull();
    expect(await raw.text()).toBe(html);
  });
});
