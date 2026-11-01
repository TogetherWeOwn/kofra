import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { LiveSite } from "@dropway/core";
import { cacheControlFor, isNoindex } from "../packages/server/src/serve";
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

/** Minimal live manifest for the pure cache-policy unit tests. */
const live = (over: Partial<LiveSite> = {}): LiveSite => ({
  v: 5,
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

describe("cache policy matrix (SRV-05)", () => {
  it("HTML and unfingerprinted files revalidate; fingerprinted files are immutable", () => {
    expect(cacheControlFor("index.html", live())).toBe("public, max-age=0, must-revalidate");
    expect(cacheControlFor("assets/app.js", live())).toBe("public, max-age=0, must-revalidate");
    expect(cacheControlFor("assets/app-a1b2c3d4e5.js", live())).toBe("public, max-age=31536000, immutable");
  });

  it("gated sites are private, no-store, even for fingerprinted files", () => {
    expect(cacheControlFor("assets/app-a1b2c3d4e5.js", live({ passwordHash: "hash" }))).toBe("private, no-store");
    expect(cacheControlFor("index.html", live({ passwordHash: "hash" }))).toBe("private, no-store");
  });

  it("sites with .wasm revalidate, even for fingerprinted files", () => {
    const withWasm = live({ files: Object.assign(Object.create(null), { "app.wasm": file, "assets/app-a1b2c3d4e5.js": file }) });
    expect(cacheControlFor("assets/app-a1b2c3d4e5.js", withWasm)).toBe("public, max-age=0, must-revalidate");
    expect(cacheControlFor("app.wasm", live())).toBe("public, max-age=0, must-revalidate");
    expect(cacheControlFor("app.wasm.br", live())).toBe("public, max-age=0, must-revalidate");
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

    // Gated over HTTP too: lock the site, unlock a visitor, read a fingerprinted file.
    const access = await dw.json("/api/v1/sites/cache-http/access", {
      method: "PUT",
      key: dw.ownerKey,
      headers: JSON_HEADERS,
      body: JSON.stringify({ mode: "password", password: "secret12" }),
    });
    expect(access.status).toBe(200);
    const unlock = await dw.call("/s/cache-http/__dropway/password", {
      method: "POST",
      body: new URLSearchParams({ password: "secret12" }),
      headers: { Origin: "https://dropway.test" },
    });
    expect(unlock.status).toBe(303);
    const cookie = unlock.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    const gated = await dw.call("/s/cache-http/assets/app-a1b2c3d4e5.js", { headers: { Cookie: cookie } });
    expect(gated.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("indexing policy (SRV-12)", () => {
  it("anonymous and expiring sites send X-Robots-Tag: noindex", async () => {
    expect(isNoindex(live({ tenantId: null }))).toBe(true);
    expect(isNoindex(live({ expiresAt: Date.now() + 3600_000 }))).toBe(true);
    expect(isNoindex(live({ noindex: true }))).toBe(true);
    expect(isNoindex(live())).toBe(false);

    // An expiring owner site is noindex even though it is not anonymous.
    const keyed = await publish({ "index.html": "<p>x</p>" }, { slug: "expiring-site" });
    expect(keyed.status).toBe(201);
    expect((await dw.call("/s/expiring-site/")).headers.get("x-robots-tag")).toBe("all");
    await env.DB.prepare("UPDATE sites SET expires_at = ? WHERE slug = 'expiring-site'").bind(Date.now() + 3600_000).run();
    // The live entry is cached: a settings write rebuilds it from D1 with the new expiry.
    await patchSite("expiring-site", { title: "expiring" });
    expect((await dw.call("/s/expiring-site/")).headers.get("x-robots-tag")).toBe("noindex");

    // A fresh instance (reset wipes the owner above): anonymous sites are noindex.
    const anon = await freshInstance({ anonymous: { enabled: true } });
    const pub = await anon.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "<p>x</p>" }) });
    expect(pub.status).toBe(201);
    const home = await anon.call(`/s/${pub.body.slug}/`);
    expect(home.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("per-site noindex flips X-Robots-Tag and is reported in settings", async () => {
    const pub = await publish({ "index.html": "<p>x</p>" }, { slug: "noindex-site" });
    expect(pub.status).toBe(201);
    expect(pub.body.site.settings).toMatchObject({ noindex: false });

    const patched = await patchSite("noindex-site", { noindex: true });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.site.settings).toMatchObject({ noindex: true });
    expect((await dw.call("/s/noindex-site/")).headers.get("x-robots-tag")).toBe("noindex");

    const cleared = await patchSite("noindex-site", { noindex: false });
    expect(cleared.body.site.settings.noindex).toBe(false);
    expect((await dw.call("/s/noindex-site/")).headers.get("x-robots-tag")).toBe("all");
  });

  it("serves the site's own robots.txt verbatim, never rendered", async () => {
    const pub = await publish(
      { "index.html": "<p>x</p>", "robots.txt": "User-agent: *\nAllow: /\n" },
      { slug: "own-robots" },
    );
    expect(pub.status).toBe(201);
    const robots = await dw.call("/s/own-robots/robots.txt", { headers: BROWSER_NAV });
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toContain("text/plain");
    expect(robots.headers.get("x-kofra-viewer")).toBeNull();
    expect(await robots.text()).toBe("User-agent: *\nAllow: /\n");
  });

  it("generates a disallowing robots.txt for noindex sites without one, and 404s for indexable sites", async () => {
    await publish({ "index.html": "<p>x</p>" }, { slug: "robots-generated" });
    const missing = await dw.call("/s/robots-generated/robots.txt");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-robots-tag")).toBe("all");

    await patchSite("robots-generated", { noindex: true });
    const robots = await dw.call("/s/robots-generated/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toContain("text/plain");
    expect(robots.headers.get("x-robots-tag")).toBe("noindex");
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");

    const head = await dw.call("/s/robots-generated/robots.txt", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("the password gate still applies to robots.txt", async () => {
    await publish(
      { "index.html": "<p>x</p>", "robots.txt": "User-agent: *\nAllow: /\n" },
      { slug: "locked-robots" },
    );
    const access = await dw.json("/api/v1/sites/locked-robots/access", {
      method: "PUT",
      key: dw.ownerKey,
      headers: JSON_HEADERS,
      body: JSON.stringify({ mode: "password", password: "secret12" }),
    });
    expect(access.status).toBe(200);

    const gated = await dw.call("/s/locked-robots/robots.txt");
    expect(gated.status).toBe(401);

    const unlock = await dw.call("/s/locked-robots/__dropway/password", {
      method: "POST",
      body: new URLSearchParams({ password: "secret12" }),
      headers: { Origin: "https://dropway.test" },
    });
    expect(unlock.status).toBe(303);
    const cookie = unlock.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    const robots = await dw.call("/s/locked-robots/robots.txt", { headers: { Cookie: cookie } });
    expect(robots.status).toBe(200);
    expect(await robots.text()).toBe("User-agent: *\nAllow: /\n");
  });

  it("robots.txt is never answered by the SPA or 404.html fallbacks", async () => {
    await publish(
      { "index.html": "<p>spa home</p>", "404.html": "<p>custom missing</p>" },
      { slug: "fallback-robots", spa: "true" } as Record<string, string>,
    );
    // Indexable: a plain 404, not the custom 404.html page.
    const miss = await dw.call("/s/fallback-robots/robots.txt", { headers: BROWSER_NAV });
    expect(miss.status).toBe(404);
    expect(await miss.text()).not.toContain("custom missing");
    // Noindex without its own file: the generated disallow-all, not index.html.
    await patchSite("fallback-robots", { noindex: true });
    const generated = await dw.call("/s/fallback-robots/robots.txt", { headers: BROWSER_NAV });
    expect(generated.status).toBe(200);
    expect(await generated.text()).toBe("User-agent: *\nDisallow: /\n");
  });
});
