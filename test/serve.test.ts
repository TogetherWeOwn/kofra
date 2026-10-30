import { beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "@dropway/core";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

const BROWSER_NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

let dw: Instance;
let slug: string;
beforeEach(async () => {
  dw = await freshInstance();
  const res = await dw.json("/api/v1/publish", {
    method: "POST",
    key: dw.ownerKey,
    body: form({
      "index.html": '<!doctype html><title>Home</title><script src="/assets/app.js"></script><a href="/docs/guide.md">guide</a>',
      "assets/app.js": "console.log('app')",
      "docs/guide.md": "# Guide\n\nSome *markdown* with <script>alert(1)</script>.",
      "docs/index.html": "<p>docs home</p>",
      "about.html": "<p>about</p>",
      "app.wasm": new Uint8Array([0, 97, 115, 109]),
    }),
  });
  slug = res.body.slug;
});

describe("serving", () => {
  it("serves files with ETag = sha256", async () => {
    const res = await dw.call(`/s/${slug}/assets/app.js`);
    expect(res.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/);
    const again = await dw.call(`/s/${slug}/assets/app.js`, { headers: { "If-None-Match": res.headers.get("etag")! } });
    expect(again.status).toBe(304);
  });

  it("serves HTML with security headers and the shared-origin sandbox", async () => {
    const res = await dw.call(`/s/${slug}/`, { headers: BROWSER_NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // Sandboxed HTML carries the run-time path shim; its version is part of the ETag.
    expect(res.headers.get("etag")).toMatch(/^W\/"pm-[a-f0-9]{64}-js\d+"$/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(res.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    const again = await dw.call(`/s/${slug}/`, { headers: { "If-None-Match": res.headers.get("etag")! } });
    expect(again.status).toBe(304);
  });

  it("?raw=1 returns the HTML source as text/plain", async () => {
    const res = await dw.call(`/s/${slug}/about.html?raw=1`, { headers: BROWSER_NAV });
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-kofra-original-content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<p>about</p>");
  });

  it("renders Markdown for browsers with a Raw link; raw for fetch/curl and ?raw=1", async () => {
    const page = await dw.call(`/s/${slug}/docs/guide.md`, { headers: BROWSER_NAV });
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("x-kofra-viewer")).toBe("markdown");
    // Scripts inside Markdown can never run on the rendered page.
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const html = await page.text();
    expect(html).toMatch(/<h1 id="guide">Guide<a class="md-anchor"/);
    expect(html).toContain("<em>markdown</em>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain(`href="/s/${slug}/docs/guide.md?raw=1"`);
    expect(html).toContain(">Raw</a>");

    const curl = await dw.call(`/s/${slug}/docs/guide.md`);
    expect(curl.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await curl.text()).toContain("# Guide");
    const fetchApi = await dw.call(`/s/${slug}/docs/guide.md`, { headers: { "Sec-Fetch-Dest": "empty", Accept: "*/*" } });
    expect(fetchApi.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const raw = await dw.call(`/s/${slug}/docs/guide.md?raw=1`, { headers: BROWSER_NAV });
    expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await raw.text()).toContain("<script>alert(1)</script>");
    const forced = await dw.call(`/s/${slug}/docs/guide.md?view=1`);
    expect(forced.headers.get("x-kofra-viewer")).toBe("markdown");
  });

  it("resolves directory indexes, extensionless .html and serves .wasm correctly", async () => {
    const dir = await dw.call(`/s/${slug}/docs`);
    expect(dir.status).toBe(301);
    expect(dir.headers.get("location")).toBe(`/s/${slug}/docs/`);
    expect(await (await dw.call(`/s/${slug}/docs/`)).text()).toBe("<p>docs home</p>");
    expect(await (await dw.call(`/s/${slug}/about`)).text()).toBe("<p>about</p>");
    const wasm = await dw.call(`/s/${slug}/app.wasm`);
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
  });

  it("returns a 404 page for missing files and unknown sites", async () => {
    const missing = await dw.call(`/s/${slug}/nope.html`, { headers: BROWSER_NAV });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("Page not found");
    const unknown = await dw.call("/s/no-such-site-here/");
    expect(unknown.status).toBe(404);
  });

  it("supports Range requests", async () => {
    const res = await dw.call(`/s/${slug}/assets/app.js`, { headers: { Range: "bytes=0-6" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toMatch(/^bytes 0-6\/\d+$/);
    expect(await res.text()).toBe("console");
  });

  it("serves index.html for unknown paths when spa is on", async () => {
    await dw.json(`/api/v1/sites/${slug}`, { method: "PATCH", key: dw.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spa: true }) });
    const res = await dw.call(`/s/${slug}/some/client/route`, { headers: BROWSER_NAV });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Home</title>");
  });

  it("lists folders without an index file", async () => {
    const res = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "a.txt": "a", "b/c.txt": "c" }) });
    const listing = await dw.call(`/s/${res.body.slug}/`, { headers: BROWSER_NAV });
    expect(listing.headers.get("x-kofra-viewer")).toBe("listing");
    const html = await listing.text();
    expect(html).toContain("a.txt");
    expect(html).toContain("b/");
  });
});

describe("path mode: root-relative URLs", () => {
  it("prefixes root-relative URLs in HTML (sandboxed pages send no Referer); ?raw=1 keeps the original", async () => {
    const html = await (await dw.call(`/s/${slug}/`, { headers: BROWSER_NAV })).text();
    expect(html).toContain(`<script src="/s/${slug}/assets/app.js">`);
    expect(html).toContain(`<a href="/s/${slug}/docs/guide.md">`);
    const raw = await (await dw.call(`/s/${slug}/index.html?raw=1`)).text();
    expect(raw).toContain('<script src="/assets/app.js">');
  });

  it("prefixes url() and @import in CSS and links in rendered Markdown, but not links to other sites", async () => {
    const pub = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({
        "style.css": '@import "/base.css"; body{background:url(/img/bg.png)} .x{background:url("//cdn.example/x.png")}',
        "base.css": "p{}",
        "img/bg.png": "png",
        "readme.md": "[home](/) [other](/s/other-site/) [ext](https://example.com/)",
      }),
    });
    const s = pub.body.slug;
    const css = await (await dw.call(`/s/${s}/style.css`)).text();
    expect(css).toBe(`@import "/s/${s}/base.css"; body{background:url(/s/${s}/img/bg.png)} .x{background:url("//cdn.example/x.png")}`);
    const md = await (await dw.call(`/s/${s}/readme.md`, { headers: BROWSER_NAV })).text();
    expect(md).toContain(`href="/s/${s}/"`);
    expect(md).toContain('href="/s/other-site/"');
    expect(md).toContain('href="https://example.com/"');
  });
});

describe("path mode: run-time shim for sandboxed pages (no Referer from an opaque origin)", () => {
  const SHIM = '<script data-dropway="path-shim">';
  const publish = (inst: Instance, files: Record<string, string>, fields: Record<string, string> = {}) =>
    inst.json("/api/v1/publish", { method: "POST", key: inst.ownerKey, body: form(files, fields) });

  it("goes in once, as the first child of <head>, with the site prefix and kept prefixes", async () => {
    const pub = await publish(dw, { "index.html": '<!doctype html><html><head><meta charset="utf-8"><script src="/a.js"></script><script>fetch("/b")</script></head><body></body></html>' });
    const s = pub.body.slug;
    const html = await (await dw.call(`/s/${s}/`, { headers: BROWSER_NAV })).text();
    expect(html.split(SHIM)).toHaveLength(2);
    expect(html.indexOf(SHIM)).toBe(html.indexOf("<head>") + "<head>".length);
    expect(html).toContain(`("/s/${s}/",["/s/"],`);
    expect(html).toContain(`<script src="/s/${s}/a.js">`);
  });

  it("without a <head> tag it goes before the first script or CSP meta, so a page CSP cannot block it", async () => {
    const pub = await publish(dw, {
      "a.html": '<p>hi</p><script>fetch("/x")</script>',
      "b.html": `<meta http-equiv="Content-Security-Policy" content="script-src 'self'"><script src="/app.js"></script>`,
    });
    const s = pub.body.slug;
    const a = await (await dw.call(`/s/${s}/a.html`, { headers: BROWSER_NAV })).text();
    expect(a.indexOf(SHIM)).toBeGreaterThan(a.indexOf("<p>hi</p>"));
    expect(a.indexOf(SHIM)).toBeLessThan(a.indexOf('<script>fetch("/x")'));
    const b = await (await dw.call(`/s/${s}/b.html`, { headers: BROWSER_NAV })).text();
    expect(b.startsWith(SHIM)).toBe(true);
  });

  it("is not added to ?raw=1, rendered views, CSS or unsandboxed sites", async () => {
    const pub = await publish(dw, { "index.html": "<head></head><p>x</p>", "readme.md": "# Hi", "s.css": "a{}" });
    const s = pub.body.slug;
    expect(await (await dw.call(`/s/${s}/index.html?raw=1`)).text()).toBe("<head></head><p>x</p>");
    expect(await (await dw.call(`/s/${s}/readme.md`, { headers: BROWSER_NAV })).text()).not.toContain(SHIM);
    expect(await (await dw.call(`/s/${s}/index.html?view=1`, { headers: BROWSER_NAV })).text()).not.toContain(SHIM);
    expect(await (await dw.call(`/s/${s}/s.css`)).text()).toBe("a{}");

    const two = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: "https://sites.example" });
    const keyed = await publish(two, { "index.html": "<head></head><script>fetch('/x')</script>" });
    const page = await two.call(`https://sites.example/${keyed.body.slug}/`, { headers: BROWSER_NAV });
    expect(page.headers.get("content-security-policy")).toBeNull();
    expect(await page.text()).not.toContain(SHIM);

    const sub = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test", sitesSandbox: true });
    const own = await publish(sub, { "index.html": "<head></head><p>own origin</p>" });
    expect(await (await sub.call(`https://${own.body.slug}.sites.test/`, { headers: BROWSER_NAV })).text()).toBe("<head></head><p>own origin</p>");
  });

  it("anonymous sites on a separate sites origin are sandboxed (with the shim) unless SITES_SANDBOX=false", async () => {
    const two = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: "https://sites.example", anonymous: { enabled: true } });
    const anon = await two.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "<head></head><script>fetch('/data.json')</script>", "data.json": "{}" }) });
    const page = await two.call(`https://sites.example/${anon.body.slug}/`, { headers: BROWSER_NAV });
    expect(page.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(await page.text()).toContain(`${SHIM}(function`);
    const data = await two.call(`https://sites.example/${anon.body.slug}/data.json`);
    expect(data.headers.get("content-security-policy")).toContain("sandbox allow-scripts");

    const off = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: "https://sites.example", anonymous: { enabled: true }, sitesSandboxAnonymous: false });
    const anon2 = await off.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "<head></head><p>x</p>" }) });
    const page2 = await off.call(`https://sites.example/${anon2.body.slug}/`, { headers: BROWSER_NAV });
    expect(page2.headers.get("content-security-policy")).toBeNull();
    const html = await page2.text();
    expect(html).not.toContain(SHIM);
    expect(html).toContain("<head></head><p>x</p>");
    expect(html.match(/<a\b[^>]*>Report abuse<\/a>/g)).toHaveLength(1);
    expect(html).toMatch(/position\s*:\s*fixed\b/i);
    // Disabling the sandbox omits the shim, not the anonymous report link; byte modes stay untouched.
    for (const query of ["raw=1", "download=1"]) {
      const original = await off.call(`https://sites.example/${anon2.body.slug}/?${query}`, { headers: BROWSER_NAV });
      expect(original.status).toBe(200);
      expect(await original.text()).toBe("<head></head><p>x</p>");
    }
  });

  it("SITES_SANDBOX: auto (default) sandboxes anonymous sites on a sites origin; true all; false none", () => {
    const sitesOrigin = { APP_ORIGIN: ORIGIN, SITES_ORIGIN: "https://sites.example" };
    const pick = (vars: Record<string, string>) => {
      const c = resolveConfig(vars);
      return [c.sitesSandbox, c.sitesSandboxAnonymous];
    };
    expect(pick(sitesOrigin)).toEqual([false, true]);
    expect(pick({ ...sitesOrigin, SITES_SANDBOX: "auto" })).toEqual([false, true]);
    expect(pick({ ...sitesOrigin, SITES_SANDBOX: "true" })).toEqual([true, false]);
    expect(pick({ ...sitesOrigin, SITES_SANDBOX: "false" })).toEqual([false, false]);
    expect(pick({})).toEqual([true, true]);
    expect(pick({ SITES_MODE: "subdomain", SITES_DOMAIN: "sites.test" })).toEqual([false, false]);
  });

  it("an unresolved root-relative fetch on the shared origin gets a CORS-readable 404, not a network error", async () => {
    const res = await dw.call("/data.json", { headers: { Origin: "null", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "empty" } });
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("path mode: absolute paths resolved by Referer", () => {
  it("redirects an absolute sub-resource to the referring site's file", async () => {
    const res = await dw.call("/assets/app.js", { headers: { Referer: `${ORIGIN}/s/${slug}/index.html`, "Sec-Fetch-Dest": "script" } });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`/s/${slug}/assets/app.js`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("vary")).toBe("Referer");
  });

  it("redirects absolute navigations into the site", async () => {
    const res = await dw.call("/docs/guide.md?x=1", { headers: { ...BROWSER_NAV, Referer: `${ORIGIN}/s/${slug}/` } });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`/s/${slug}/docs/guide.md?x=1`);
  });

  it("falls through to the app when the site has no such file", async () => {
    const res = await dw.call("/openapi.json", { headers: { Referer: `${ORIGIN}/s/${slug}/` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { openapi: string }).openapi).toBe("3.1.0");
  });

  it("ignores cross-origin referers", async () => {
    const res = await dw.call("/assets/app.js", { headers: { Referer: `https://evil.example/s/${slug}/` } });
    expect(res.status).toBe(404);
  });
});

describe("other serving topologies", () => {
  it("subdomain mode: each site on its own origin, app paths redirect there", async () => {
    const sub = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test" });
    const pub = await sub.json("/api/v1/publish", { method: "POST", key: sub.ownerKey, body: form({ "index.html": "<p>own origin</p>" }) });
    expect(pub.body.url).toBe(`https://${pub.body.slug}.sites.test/`);
    const res = await sub.call(`https://${pub.body.slug}.sites.test/`);
    expect(await res.text()).toBe("<p>own origin</p>");
    expect(res.headers.get("content-security-policy")).toBeNull();
    const legacy = await sub.call(`/s/${pub.body.slug}/x`);
    expect(legacy.status).toBe(301);
    expect(legacy.headers.get("location")).toBe(`https://${pub.body.slug}.sites.test/x`);
  });

  it("separate sites origin (two workers): sites at /<slug>/, never on the app origin", async () => {
    const two = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: "https://sites.example" });
    const pub = await two.json("/api/v1/publish", { method: "POST", key: two.ownerKey, body: form({ "index.html": '<img src="/img/logo.png">', "img/logo.png": "png" }) });
    expect(pub.body.url).toBe(`https://sites.example/${pub.body.slug}/`);
    const page = await two.call(`https://sites.example/${pub.body.slug}/`);
    expect(await page.text()).toContain(`src="/${pub.body.slug}/img/logo.png"`);
    // A separate sites origin is not sandboxed by default (so Referer works); SITES_SANDBOX=true opts in.
    expect(page.headers.get("content-security-policy")).toBeNull();
    const viaApp = await two.call(`/s/${pub.body.slug}/`);
    expect(viaApp.status).toBe(301);
    expect(viaApp.headers.get("location")).toBe(`https://sites.example/${pub.body.slug}/`);
    const abs = await two.call("https://sites.example/img/logo.png", { headers: { Referer: `https://sites.example/${pub.body.slug}/` } });
    expect(abs.status).toBe(307);
    expect(abs.headers.get("location")).toBe(`/${pub.body.slug}/img/logo.png`);
    const api = await two.call("https://sites.example/api/v1/sites");
    expect(api.status).toBe(404);
  });

  it("separate sites origin with SITES_SANDBOX=true sandboxes every response", async () => {
    const two = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: "https://sites.example", sitesSandbox: true });
    const pub = await two.json("/api/v1/publish", { method: "POST", key: two.ownerKey, body: form({ "index.html": "<p>x</p>" }) });
    const page = await two.call(`https://sites.example/${pub.body.slug}/`);
    expect(page.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
  });
});
