import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseSettings, type LiveSite } from "@dropway/core";
import { cacheControlFor } from "../packages/server/src/serve";
import { form, freshInstance, type Instance } from "./helpers";

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

describe("_redirects and _headers (SRV-09)", () => {
  it("parses both files at finalize into config_json, warns per invalid line, serves neither file", async () => {
    const pub = await publish(
      {
        "index.html": "<p>home</p>",
        "new.html": "<p>new</p>",
        "assets/app.js": "console.log(1)",
        _redirects: [
          "# a comment",
          "/old /new.html 302",
          "/legacy/* /new/:splat 308",
          "/blog/:year/:slug /posts/:year/:slug 301",
          "/ext https://example.com/there 307",
          "/defaulted /new.html",
          "/search /results?q=static 302",
          "/bad-status /new.html 200",
          "nonsense-line",
          "/missing-dest",
          "/unknown-var /x/:nope 301",
          "/proto-relative //example.com/x 302",
        ].join("\n"),
        _headers: [
          "/assets/*",
          "  X-Test-Asset: yes",
          "  Cache-Control: public, max-age=60",
          "/*",
          "  X-Test-All: all",
          "  X-Content-Type-Options: sniffme",
          "boguspath",
          "  X-Nope: nope",
          "/assets/*",
          "  NotAHeaderLine",
          "  Set-Cookie: evil=1",
          '  Clear-Site-Data: "storage"',
        ].join("\n"),
      },
      { slug: "config-site" },
    );
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const slug = pub.body.slug as string;

    const invalid = (pub.body.warnings as Array<{ code: string; message: string }>).filter((w) => w.code === "invalid_config");
    // _redirects: bad status, nonsense, missing destination, unknown placeholder, protocol-relative destination.
    // _headers: bad path, its orphaned header, a non-header line, Set-Cookie, Clear-Site-Data.
    expect(invalid).toHaveLength(10);
    expect(invalid.some((w) => w.message.includes("_redirects") && w.message.includes("line 8"))).toBe(true);
    expect(invalid.some((w) => w.message.includes("_headers"))).toBe(true);

    const versionId = pub.body.version.id as string;
    const row = await env.DB.prepare("SELECT config_json FROM versions WHERE id = ?").bind(versionId).first<{ config_json: string | null }>();
    expect(row?.config_json, "finalize stores the parsed site config on the version").toBeTruthy();
    const config = JSON.parse(row!.config_json!);
    expect(config.redirects).toContainEqual({ from: "/old", to: "/new.html", status: 302 });
    expect(config.redirects).toContainEqual({ from: "/legacy/*", to: "/new/:splat", status: 308 });
    expect(config.redirects).toContainEqual({ from: "/defaulted", to: "/new.html", status: 301 });
    expect(config.headers).toContainEqual({
      pattern: "/assets/*",
      headers: [
        { name: "X-Test-Asset", value: "yes" },
        { name: "Cache-Control", value: "public, max-age=60" },
      ],
    });

    const old = await dw.call(`/s/${slug}/old?x=1`);
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe(`/s/${slug}/new.html?x=1`);

    const splat = await dw.call(`/s/${slug}/legacy/a/b`);
    expect(splat.status).toBe(308);
    expect(splat.headers.get("location")).toBe(`/s/${slug}/new/a/b`);

    const placeholders = await dw.call(`/s/${slug}/blog/2026/hello-world`);
    expect(placeholders.status).toBe(301);
    expect(placeholders.headers.get("location")).toBe(`/s/${slug}/posts/2026/hello-world`);

    const external = await dw.call(`/s/${slug}/ext`);
    expect(external.status).toBe(307);
    expect(external.headers.get("location")).toBe("https://example.com/there");

    const defaulted = await dw.call(`/s/${slug}/defaulted`);
    expect(defaulted.status).toBe(301);

    const search = await dw.call(`/s/${slug}/search?x=1`);
    expect(search.headers.get("location")).toBe(`/s/${slug}/results?q=static`);

    for (const f of ["_redirects", "_headers"]) {
      const res = await dw.call(`/s/${slug}/${f}`);
      expect(res.status, `${f} is never served`).toBe(404);
      expect(await res.text()).not.toContain("/old /new.html");
    }

    const asset = await dw.call(`/s/${slug}/assets/app.js`);
    expect(asset.headers.get("x-test-asset")).toBe("yes");
    expect(asset.headers.get("x-test-all")).toBe("all");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=60");
    expect(asset.headers.get("set-cookie")).toBeNull();
    expect(asset.headers.get("clear-site-data")).toBeNull();
    // Platform security headers win over _headers.
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");

    const home = await dw.call(`/s/${slug}/index.html`);
    expect(home.headers.get("x-test-all")).toBe("all");
    expect(home.headers.get("x-test-asset")).toBeNull();
  });

  it("restoring a version restores its redirects, and duplicating a site copies them", async () => {
    const v1 = await publish({ "index.html": "<p>v1</p>", "new.html": "<p>n</p>", _redirects: "/old /new.html 301\n" }, { slug: "restore-config" });
    expect(v1.status).toBe(201);
    await publish({ "index.html": "<p>v2</p>", "new.html": "<p>n</p>" }, { slug: "restore-config" });
    expect((await dw.call("/s/restore-config/old")).status).toBe(404);

    const restored = await dw.json("/api/v1/sites/restore-config/versions/1/restore", { method: "POST", key: dw.ownerKey });
    expect(restored.status).toBe(200);
    const afterRestore = await dw.call("/s/restore-config/old");
    expect(afterRestore.status).toBe(301);
    expect(afterRestore.headers.get("location")).toBe("/s/restore-config/new.html");

    const copy = await dw.json("/api/v1/sites/restore-config/duplicate", {
      method: "POST",
      key: dw.ownerKey,
      headers: JSON_HEADERS,
      body: JSON.stringify({ newSlug: "restore-config-copy" }),
    });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    const onCopy = await dw.call("/s/restore-config-copy/old");
    expect(onCopy.status).toBe(301);
    expect(onCopy.headers.get("location")).toBe("/s/restore-config-copy/new.html");
  });

  it("warns on redirect destinations that cannot be HTTP header values, and never serves a 500 for them", async () => {
    const pub = await publish(
      {
        "index.html": "<p>x</p>",
        _redirects: "/old /new-💩 302\n/ext https://example.com/中文 307\n",
      },
      { slug: "bad-dest" },
    );
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const invalid = (pub.body.warnings as Array<{ code: string; message: string }>).filter((w) => w.code === "invalid_config");
    expect(invalid).toHaveLength(2);
    expect((await dw.call("/s/bad-dest/old")).status).toBe(404);
    expect((await dw.call("/s/bad-dest/ext")).status).toBe(404);
  });

  it("skips a self-looping redirect rule and continues to the next matching rule", async () => {
    const pub = await publish(
      {
        "index.html": "<p>home</p>",
        "other.html": "<p>other</p>",
        _redirects: "/* /index.html 301\n/index.html /other.html 301\n",
      },
      { slug: "self-loop" },
    );
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const looped = await dw.call("/s/self-loop/index.html");
    expect(looped.status).toBe(301);
    expect(looped.headers.get("location")).toBe("/s/self-loop/other.html");

    const solo = await publish({ "index.html": "<p>home</p>", _redirects: "/* /index.html 301\n" }, { slug: "self-loop-solo" });
    expect(solo.status).toBe(201);
    expect((await dw.call("/s/self-loop-solo/index.html")).status).toBe(200);
  });

  it("replays stored config warnings on a byte-identical REST republish", async () => {
    const files = { "index.html": "<p>x</p>", _redirects: "/ok /index.html 301\nnonsense-line\n" };
    const first = await publish(files, { slug: "replay-warn" });
    expect(first.status).toBe(201);
    const firstInvalid = (first.body.warnings as Array<{ code: string; message: string }>).filter((w) => w.code === "invalid_config");
    expect(firstInvalid).toHaveLength(1);
    const second = await publish(files, { slug: "replay-warn" });
    expect(second.status).toBe(200);
    expect(second.body.unchanged).toBe(true);
    const secondInvalid = (second.body.warnings as Array<{ code: string; message: string }>).filter((w) => w.code === "invalid_config");
    expect(secondInvalid).toHaveLength(1);
    expect(secondInvalid[0]!.message).toBe(firstInvalid[0]!.message);
  });

  it("reports the path-pattern cap and the header cap independently", async () => {
    const chunks: string[] = [];
    for (let i = 0; i < 99; i++) {
      chunks.push(`/p${i}/*`);
      for (let j = 0; j < 10; j++) chunks.push(`  X-H-${i}-${j}: v`);
    }
    chunks.push("/p99/*");
    for (let j = 0; j < 20; j++) chunks.push(`  X-Fill-${j}: v`);
    chunks.push("/overflow/*", "  X-Overflow: v");
    const pub = await publish({ "index.html": "<p>x</p>", _headers: chunks.join("\n") }, { slug: "cap-warn" });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const invalid = (pub.body.warnings as Array<{ code: string; message: string }>).filter((w) => w.code === "invalid_config");
    expect(invalid.some((w) => w.message.includes("more than 1000 headers"))).toBe(true);
    expect(invalid.some((w) => w.message.includes("more than 100 path patterns"))).toBe(true);
  });

  it("rejects a from-pattern that combines a :splat placeholder with a trailing splat", async () => {
    const pub = await publish(
      { "index.html": "<p>x</p>", _redirects: "/files/:splat/* /x/:splat 301\n" },
      { slug: "splat-clash" },
    );
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const invalid = (pub.body.warnings as Array<{ code: string; message: string }>).filter((w) => w.code === "invalid_config");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.message).toContain("splat");
    const row = await env.DB.prepare("SELECT config_json FROM versions WHERE id = ?")
      .bind(pub.body.version.id as string)
      .first<{ config_json: string | null }>();
    expect(JSON.parse(row!.config_json!).redirects).toHaveLength(0);
  });
});

describe("cache policy matrix (SRV-05)", () => {
  const live = (over: Partial<LiveSite> = {}): LiveSite => ({
    v: 3,
    siteId: "site_test",
    slug: "cache-site",
    tenantId: "ten_test",
    versionId: "ver_test",
    spa: false,
    renderMarkdown: true,
    crossOriginIsolation: false,
    passwordHash: null,
    expiresAt: null,
    files: {},
    ...over,
  });
  const file: [string, number, string] = ["a".repeat(64), 3, "application/javascript"];

  it("HTML and unfingerprinted files revalidate; fingerprinted files are immutable", () => {
    expect(cacheControlFor("index.html", live())).toBe("public, max-age=0, must-revalidate");
    expect(cacheControlFor("assets/app.js", live())).toBe("public, max-age=0, must-revalidate");
    expect(cacheControlFor("assets/app-a1b2c3d4e5.js", live())).toBe("public, max-age=31536000, immutable");
  });

  it("gated sites are private, no-store, even for fingerprinted files", () => {
    expect(cacheControlFor("assets/app-a1b2c3d4e5.js", live({ passwordHash: "hash" }))).toBe("private, no-store");
  });

  it("sites with .wasm revalidate, even for fingerprinted files", () => {
    const withWasm = live({ files: Object.assign(Object.create(null), { "app.wasm": file, "assets/app-a1b2c3d4e5.js": file }) });
    expect(cacheControlFor("assets/app-a1b2c3d4e5.js", withWasm)).toBe("public, max-age=0, must-revalidate");
    expect(cacheControlFor("assets/app-a1b2c3d4e5.wasm", live())).toBe("public, max-age=0, must-revalidate");
  });

  it("serves the matrix over HTTP", async () => {
    const pub = await publish(
      { "index.html": "<p>x</p>", "assets/app.js": "1", "assets/app-a1b2c3d4e5.js": "2" },
      { slug: "cache-http" },
    );
    expect(pub.status).toBe(201);
    expect((await dw.call("/s/cache-http/index.html")).headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect((await dw.call("/s/cache-http/assets/app.js")).headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect((await dw.call("/s/cache-http/assets/app-a1b2c3d4e5.js")).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});

describe("ttlSeconds, noindex, viewers and robots.txt (PUB-16, SRV-12, VIEW-06)", () => {
  it("parseSettings validates ttlSeconds", () => {
    expect(parseSettings({ ttlSeconds: 3600 }).ttlSeconds).toBe(3600);
    expect(parseSettings({ ttlSeconds: null }).ttlSeconds).toBeNull();
    expect(parseSettings({ ttlSeconds: "3600" }).ttlSeconds).toBe(3600);
    for (const bad of [0, -5, 1.5, "soon", Number.NaN]) {
      expect(() => parseSettings({ ttlSeconds: bad }), `ttlSeconds=${String(bad)}`).toThrowError(expect.objectContaining({ code: "invalid_ttl" }));
    }
  });

  it("applies all three settings, serves the site's own robots.txt raw, and clears TTL with null", async () => {
    const pub = await publish(
      { "index.html": "<p>home</p>", "guide.md": "# Guide\n", "robots.txt": "User-agent: *\nAllow: /\n" },
      { slug: "settings-site" },
    );
    expect(pub.status).toBe(201);

    const before = Date.now();
    const patched = await patchSite("settings-site", { ttlSeconds: 3600, noindex: true, viewers: false });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.site.settings).toMatchObject({ ttlSeconds: 3600, noindex: true, viewers: false });
    const expiresAt = Date.parse(patched.body.site.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3_500_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);

    const home = await dw.call("/s/settings-site/");
    expect(home.headers.get("x-robots-tag")).toBe("noindex");

    const guide = await dw.call("/s/settings-site/guide.md", { headers: BROWSER_NAV });
    expect(guide.headers.get("x-kofra-viewer")).toBeNull();
    expect(guide.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await guide.text()).toBe("# Guide\n");

    const robots = await dw.call("/s/settings-site/robots.txt", { headers: BROWSER_NAV });
    expect(robots.status).toBe(200);
    expect(robots.headers.get("x-kofra-viewer")).toBeNull();
    expect(await robots.text()).toBe("User-agent: *\nAllow: /\n");

    const cleared = await patchSite("settings-site", { ttlSeconds: null });
    expect(cleared.body.site.settings).toMatchObject({ ttlSeconds: null, noindex: true, viewers: false });
    expect(cleared.body.site.expiresAt).toBeNull();
    // noindex is independent of expiry: the site is no longer expiring but still noindex.
    expect((await dw.call("/s/settings-site/")).headers.get("x-robots-tag")).toBe("noindex");

    const indexed = await patchSite("settings-site", { noindex: false });
    expect(indexed.body.site.settings.noindex).toBe(false);
    expect((await dw.call("/s/settings-site/")).headers.get("x-robots-tag")).toBe("all");

    const bad = await patchSite("settings-site", { ttlSeconds: 0 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_ttl");
  });

  it("recomputes a keyed site's expiry at finalize from ttlSeconds", async () => {
    await publish({ "index.html": "<p>one</p>" }, { slug: "ttl-finalize" });
    await patchSite("ttl-finalize", { ttlSeconds: 60 });
    await env.DB.prepare("UPDATE sites SET expires_at = ? WHERE slug = 'ttl-finalize'").bind(Date.now() - 1000).run();

    const republished = await publish({ "index.html": "<p>two</p>" }, { slug: "ttl-finalize" });
    expect(republished.status, JSON.stringify(republished.body)).toBe(200);
    const site = await dw.json("/api/v1/sites/ttl-finalize", { key: dw.ownerKey });
    const expiresAt = Date.parse(site.body.site.expiresAt);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    expect((await dw.call("/s/ttl-finalize/")).status).toBe(200);
  });

  it("generates a disallowing robots.txt for noindex sites without one, and 404s for indexable sites", async () => {
    await publish({ "index.html": "<p>x</p>" }, { slug: "robots-generated" });
    expect((await dw.call("/s/robots-generated/robots.txt")).status).toBe(404);
    await patchSite("robots-generated", { noindex: true });
    const robots = await dw.call("/s/robots-generated/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toContain("text/plain");
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("refuses ttlSeconds for anonymous sites (keyed sites only)", async () => {
    const anon = await freshInstance({ anonymous: { enabled: true } });
    const res = await anon.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "<p>x</p>" }, { ttlSeconds: "3600" }) });
    expect(res.status).toBe(403);
  });

  it("treats ttlSeconds:null as no change on anonymous sites", async () => {
    const anon = await freshInstance({ anonymous: { enabled: true } });
    const pub = await anon.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "<p>x</p>" }) });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    expect(pub.body.expiresAt).toBeTruthy();
    const patched = await anon.json(`/api/v1/sites/${pub.body.slug}`, {
      method: "PATCH",
      key: pub.body.claimToken,
      headers: JSON_HEADERS,
      body: JSON.stringify({ ttlSeconds: null }),
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.site.expiresAt).toBe(pub.body.expiresAt);
    const numbered = await anon.json(`/api/v1/sites/${pub.body.slug}`, {
      method: "PATCH",
      key: pub.body.claimToken,
      headers: JSON_HEADERS,
      body: JSON.stringify({ ttlSeconds: 60 }),
    });
    expect(numbered.status).toBe(403);
  });
});
