import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDropway, renderAppPage, type ServerBindings } from "@dropway/server";
import { CLIENT_SCRIPT, CLIENT_HASH, fnv1a } from "../packages/server/src/ui/assets";
import { jsonForScript, navItems } from "../packages/server/src/ui/shell";
import { form, freshInstance } from "./helpers";

const scriptSrc = (html: string) => /<script src="(\/__dropway\/ui\/app-[0-9a-f]{8}\.js)" defer><\/script>/.exec(html)?.[1];
const boot = (html: string) => JSON.parse(/<script type="application\/json" id="dw-boot">(.*?)<\/script>/s.exec(html)![1]!);

describe("app pages", () => {
  it("home: neutral self-host page with snippets, strict CSP, one first-party script", async () => {
    const dw = await freshInstance();
    const res = await dw.call("/");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const html = await res.text();
    expect(scriptSrc(html)).toBe(`/__dropway/ui/app-${CLIENT_HASH}.js`);
    expect(html).not.toMatch(/<script>(?!<)/); // no inline executable scripts
    expect(html).toContain("https://dropway.test/api/v1/publish");
    expect(html).toContain("npx kofra publish ./dist");
    expect(html).toContain("claude mcp add --transport http kofra https://dropway.test/mcp");
    expect(html).toContain('data-page="home"');
    // The open-source edition never talks about money.
    expect(html).not.toMatch(/pric|billing|\bplans?\b|subscription|upgrade|checkout/i);
    expect(boot(html)).toMatchObject({ origin: "https://dropway.test", api: "/api/v1", anonymousPublish: false, page: { name: "home" } });
  });

  it("a new instance shows the setup path on the home page and a setup form on /login", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const dropway = createDropway();
    const get = async (path: string) => {
      const ctx = createExecutionContext();
      const res = await dropway.fetch(new Request(`https://dropway.test${path}`), env as unknown as ServerBindings, ctx);
      await waitOnExecutionContext(ctx);
      return res.text();
    };
    expect(await get("/")).toContain("This instance is not set up yet");
    const login = await get("/login");
    expect(login).toContain('id="dw-setup"');
    expect(login).toContain('name="secret" type="password" autocomplete="off"');
  });

  it("serves the dashboard script immutable by hash; old hashes revalidate; unknown names 404", async () => {
    const dw = await freshInstance();
    const res = await dw.call(`/__dropway/ui/app-${CLIENT_HASH}.js`);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const js = await res.text();
    expect(js).toBe(CLIENT_SCRIPT);
    expect(CLIENT_HASH).toBe(fnv1a(js));
    expect((await dw.call("/__dropway/ui/app-00000000.js")).headers.get("cache-control")).toBe("no-cache");
    expect((await dw.call("/__dropway/ui/other.js")).status).toBe(404);
  });

  it("the client script is self-contained and never writes API data as HTML", () => {
    expect(CLIENT_SCRIPT).toContain("var __name=function(t){return t};");
    expect(CLIENT_SCRIPT).toMatch(/\(function dropwayClient\(\) \{/);
    expect(CLIENT_SCRIPT).not.toMatch(/\brequire\(|^\s*import\s/m);
    expect(CLIENT_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  // The served script redistributes the vendored QR encoder, so its MIT notice
  // must travel with the bytes. Function.prototype.toString serializes the body
  // only, so the notice has to sit inside the factory, not above it.
  it("the served client script carries the vendored encoder's MIT notice", async () => {
    expect(CLIENT_SCRIPT).toContain("Copyright (c) 2009 Kazuhiko Arase");
    expect(CLIENT_SCRIPT).toContain("Permission is hereby granted");
    expect(CLIENT_SCRIPT).toContain("THE SOFTWARE IS PROVIDED \"AS IS\"");
    // Assert it on the bytes the Worker actually returns, not just the constant.
    const dw = await freshInstance();
    const js = await (await dw.call(`/__dropway/ui/app-${CLIENT_HASH}.js`)).text();
    expect(js).toContain("Copyright (c) 2009 Kazuhiko Arase");
    expect(js).toContain("Permission is hereby granted");
  });

  it("sign-in and dashboard pages are shells the script fills in", async () => {
    const dw = await freshInstance();
    for (const [path, page] of [
      ["/login", "login"],
      ["/dashboard", "sites"],
      ["/dashboard/publish", "publish"],
      ["/dashboard/keys", "keys"],
      ["/dashboard/settings", "settings"],
      ["/dashboard/sites/bright-otter-x7k2", "site"],
    ] as const) {
      const res = await dw.call(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const html = await res.text();
      expect(html).toContain(`data-page="${page}"`);
      expect(scriptSrc(html)).toBeTruthy();
    }
    const site = boot(await (await dw.call("/dashboard/sites/bright-otter-x7k2")).text());
    expect(site.page).toEqual({ name: "site", slug: "bright-otter-x7k2" });
    // Settings shows the instance configuration, server-rendered.
    const settings = await (await dw.call("/dashboard/settings")).text();
    expect(settings).toContain("Anonymous publishing");
    expect(settings).toContain("/s/SITE/");
  });

  it("escapes boot data so it cannot close its script tag", () => {
    expect(jsonForScript({ a: "</script><script>alert(1)</script>" })).not.toContain("</script>");
  });
});

describe("app-origin file viewer (/v/:slug/*path)", () => {
  it("shared origin: frames the sandboxed site path, never with allow-same-origin", async () => {
    const dw = await freshInstance();
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "<p>hi</p>", "docs/a b.md": "# A" }) });
    const slug = pub.body.slug;
    const res = await dw.call(`/v/${slug}/docs/a%20b.md`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-src 'self'");
    const html = await res.text();
    expect(html).toContain(`src="https://dropway.test/s/${slug}/docs/a%20b.md?view=1&amp;embed=1"`);
    const sandbox = /sandbox="([^"]+)"/.exec(html)![1]!;
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(boot(html).page).toEqual({ name: "viewer", slug, path: "docs/a b.md", siteUrl: `https://dropway.test/s/${slug}/` });
    // The framed view really is the embed variant (no bar), served sandboxed.
    const framed = await dw.call(`/s/${slug}/docs/a%20b.md?view=1&embed=1`, { headers: { "Sec-Fetch-Dest": "iframe" } });
    expect(framed.headers.get("x-kofra-viewer")).toBe("markdown");
    expect(framed.headers.get("content-security-policy")).toContain("sandbox");
    expect(await framed.text()).not.toContain('class="dw-vbar"');
  });

  it("separate sites origin: frames that origin and lets the page keep it", async () => {
    const dw = await freshInstance({ appOrigin: "https://dropway.test", sitesOrigin: "https://sites.example" });
    const res = await dw.call("/v/bright-otter-x7k2/");
    expect(res.headers.get("content-security-policy")).toContain("frame-src 'self' https://sites.example");
    const html = await res.text();
    expect(html).toContain('src="https://sites.example/bright-otter-x7k2/"');
    expect(/sandbox="([^"]+)"/.exec(html)![1]).toContain("allow-same-origin");
  });

  it("subdomain mode allows frames from any site subdomain; ?mode=source and /view/ alias work", async () => {
    const dw = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test" });
    const res = await dw.call("/v/bright-otter-x7k2/app.ts?mode=source");
    expect(res.headers.get("content-security-policy")).toContain("frame-src 'self' https://*.sites.test");
    expect(await res.text()).toContain('src="https://bright-otter-x7k2.sites.test/app.ts?view=source&amp;embed=1"');
    const alias = await dw.call("/view/bright-otter-x7k2/app.ts?mode=raw");
    expect(alias.status).toBe(301);
    expect(alias.headers.get("location")).toBe("/v/bright-otter-x7k2/app.ts?mode=raw");
    expect((await dw.call("/v/Not_A_Slug!/x")).status).toBe(404);
    expect((await dw.call("/v/bright-otter-x7k2")).headers.get("location")).toBe("/v/bright-otter-x7k2/");
  });
});

describe("UI slots for embedding apps", () => {
  it("adds nav items, pages in the dashboard frame, a banner and settings sections; can replace the home page", async () => {
    const dw = await freshInstance(
      {},
      {
        uiSlots: {
          navItems: [{ label: "Docs", href: "/docs", order: 50 }],
          pages: [{ path: "/dashboard/extra", title: "Extra", nav: true, handler: (c) => renderAppPage(c, { title: "Extra", page: "extra", active: "/dashboard/extra", body: "<p id=extra>extension page</p>" }) }],
          banner: () => "Maintenance tonight",
          settingsSections: [{ id: "extra-settings", title: "Extra settings", render: () => "<p>from the extension</p>" }],
          landing: (c) => c.text("custom home"),
        },
      },
    );
    const page = await dw.call("/dashboard/extra");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await page.text();
    expect(html).toContain("<p id=extra>extension page</p>");
    expect(html).toContain('<a href="/dashboard/extra" aria-current="page">Extra</a>');
    expect(html).toContain('<div class="dw-banner" role="status">Maintenance tonight</div>');
    const nav = /<nav class="dw-nav"[^>]*>(.*?)<\/nav>/.exec(html)![1]!;
    expect(nav.indexOf(">API keys<")).toBeLessThan(nav.indexOf(">Docs<"));
    expect(nav.indexOf(">Docs<")).toBeLessThan(nav.indexOf(">Settings<"));
    expect(nav.indexOf(">Settings<")).toBeLessThan(nav.indexOf(">Extra<"));
    expect(await (await dw.call("/dashboard/settings")).text()).toContain('<section class="dw-section" id="extra-settings"><header><h2>Extra settings</h2></header><div class="dw-pad"><p>from the extension</p></div></section>');
    expect(await (await dw.call("/")).text()).toBe("custom home");
  });

  it("uiSlots.session: the dashboard learns about the embedding app's cookie sessions", async () => {
    const dw = await freshInstance({}, { uiSlots: { session: { signInPath: "/signin", signOutPath: "/auth/signout" } } });
    const html = await (await dw.call("/dashboard")).text();
    expect(boot(html).session).toEqual({ signIn: "/signin", signOut: "/auth/signout" });
    expect(html).toContain('<div class="dw-account" id="dw-account"><a class="dw-btn-link" href="/signin">Sign in</a></div>');
    const login = await (await dw.call("/login?next=/dashboard/publish")).text();
    expect(login).toContain('href="/signin?next=%2Fdashboard%2Fpublish">Sign in with your account</a>');
    // Without the slot nothing changes.
    const plain = await freshInstance();
    const plainHtml = await (await plain.call("/dashboard")).text();
    expect(boot(plainHtml).session).toBeNull();
    expect(plainHtml).toContain('href="/login">Sign in</a>');
    expect(await (await plain.call("/login")).text()).not.toContain("Sign in with your account");
  });

  it("sign-in forms never put a key in a URL, even before the script loads", async () => {
    const dw = await freshInstance();
    const html = await (await dw.call("/login")).text();
    expect(html).toContain('<form class="dw-pad" id="dw-signin" method="post" action="/login">');
    const res = await dw.call("/login", { method: "POST", body: form({ key: "dw_secret_value" }) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?retry=1");
  });

  it("an extension page can replace a core dashboard page", async () => {
    const dw = await freshInstance({}, { uiSlots: { pages: [{ path: "/dashboard/keys", title: "Keys", handler: (c) => c.text("replaced") }] } });
    expect(await (await dw.call("/dashboard/keys")).text()).toBe("replaced");
  });

  it("orders navigation by `order`, core items first by default", () => {
    const items = navItems({ navItems: [{ label: "Late", href: "/late" }, { label: "Early", href: "/early", order: 5 }], pages: [] });
    expect(items.map((i) => i.label)).toEqual(["Early", "Sites", "Publish", "API keys", "Settings", "Late"]);
  });
});
