import { describe, expect, it } from "vitest";
import { THEME_COOKIE } from "@dropway/server";
import { accountArea, appChrome, identityTag } from "../packages/server/src/ui/chrome";
import { APP_CSS, SITE_CSS } from "../packages/server/src/ui/design.generated";
import { carryDocLinks, carryLink } from "../packages/server/src/viewers/links";
import { form, freshInstance } from "./helpers";

/**
 * Security Print fix round 1 (independent judges, 2026-10-24): the regressions each fix closes.
 * Every expectation here failed on 0bbfe9a/d8d3c1f.
 */

const bands = (html: string) => html.split('class="k-guilloche-band"').length - 1;

async function siteFixture(files: Record<string, string> = {}) {
  const dw = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test" });
  const pub = await dw.json("/api/v1/publish", {
    method: "POST",
    key: dw.ownerKey,
    body: form({ "docs/a.md": "# A\n\n[b](b.md) [up](../index.html) [out](https://example.com/x) [top](#a)", "docs/b.md": "# B", "docs/c.csv": "x\n1", "index.html": "<p>hi</p>", ...files }),
  });
  expect(pub.status).toBe(201);
  const site = new URL(pub.body.url as string);
  const call = (path: string, init: RequestInit = {}) => dw.call(`${site.origin}${path}`, { ...init, headers: { Accept: "text/html", ...(init.headers ?? {}) } });
  return { dw, site, slug: pub.body.slug as string, call };
}

describe("links between Kofra pages keep the mode and the embed (J29 frame navigation)", () => {
  it("carryLink is the plain path in Auto outside the app, else a hop through __dropway/open", () => {
    expect(carryLink("/", "/docs/", { theme: "auto", embed: false })).toBe("/docs/");
    expect(carryLink("/", "/docs/", { theme: "dark", embed: false })).toBe("/__dropway/open?next=%2Fdocs%2F&theme=dark");
    expect(carryLink("/s/x/", "/s/x/a b.md", { theme: "auto", embed: true })).toBe("/s/x/__dropway/open?next=%2Fs%2Fx%2Fa%20b.md&embed=1");
    expect(carryLink("/", "/docs/?q=1", { theme: "light", embed: true })).toBe("/__dropway/open?next=%2Fdocs%2F%3Fq%3D1&embed=1&theme=light");
  });

  it("carryDocLinks rewrites relative links to files of the site only", async () => {
    const html = '<p><a href="b.md">b</a> <a href="../x/">x</a> <a href="https://e.test/">e</a> <a href="//e.test/">p</a> <a href="#h">h</a> <a href="mailto:a@b.c">m</a></p>';
    const out = await carryDocLinks(html, "/docs/a.md", "/", { theme: "dark", embed: true });
    expect(out).toContain('href="/__dropway/open?next=%2Fdocs%2Fb.md&amp;embed=1&amp;theme=dark"');
    // A link to a section of another page keeps its fragment (on the hop; the 303 to the page inherits it).
    expect(await carryDocLinks('<a href="b.md#setup">s</a>', "/docs/a.md", "/", { theme: "dark", embed: false })).toBe('<a href="/__dropway/open?next=%2Fdocs%2Fb.md&amp;theme=dark#setup">s</a>');
    expect(out).toContain('href="/__dropway/open?next=%2Fx%2F&amp;embed=1&amp;theme=dark"');
    for (const kept of ['href="https://e.test/"', 'href="//e.test/"', 'href="#h"', 'href="mailto:a@b.c"']) expect(out).toContain(kept);
    // Outside the site's base (path mode) nothing changes; nothing to carry, nothing changes.
    expect(await carryDocLinks('<a href="/other/">o</a>', "/s/x/a.md", "/s/x/", { theme: "dark", embed: false })).toBe('<a href="/other/">o</a>');
    expect(await carryDocLinks(html, "/docs/a.md", "/", { theme: "auto", embed: false })).toBe(html);
  });

  it("a listing inside the app's frame (&embed=1) has no header, footer or Browse files, and its links keep the embed and the mode", async () => {
    const { call } = await siteFixture();
    const html = await (await call("/docs/?embed=1&theme=dark")).text();
    expect(html).not.toContain("<header class=\"k-sitehead");
    expect(html).not.toContain('class="k-foot"');
    expect(html).not.toContain("Browse files");
    expect(html).toContain('href="/__dropway/open?next=%2Fdocs%2Fb.md&amp;embed=1&amp;theme=dark"');
    expect(html).toContain('href="/__dropway/open?next=%2F&amp;embed=1&amp;theme=dark"'); // the ../ row and the crumb to the site root
    // On its own (no embed, Auto) the listing keeps its frame and plain links.
    const plain = await (await call("/docs/")).text();
    expect(plain).toContain("<header class=\"k-sitehead");
    expect(plain).toContain("Browse files");
    expect(plain).toContain('href="/docs/b.md"');
    // In an explicit mode only: the mode goes along, the embed does not.
    const dark = await (await call("/docs/?theme=dark")).text();
    expect(dark).toContain('href="/__dropway/open?next=%2Fdocs%2Fb.md&amp;theme=dark"');
  });

  it("thumbnails follow the kind of each file", async () => {
    const { call } = await siteFixture({ "docs/p.png": "x", "docs/v.webm": "x" });
    const html = await (await call("/docs/")).text();
    expect(html).toContain("k-th-sheet"); // c.csv
    expect(html).toContain("k-th-image"); // p.png
    expect(html).toContain("k-th-play"); // v.webm
    expect(html).toContain("k-th-doc"); // a.md
  });

  it("__dropway/open passes &embed=1 on to Kofra pages only", async () => {
    const { call } = await siteFixture();
    const loc = async (next: string) => (await call(`/__dropway/open?next=${encodeURIComponent(next)}&embed=1`, { headers: { "Sec-Fetch-Dest": "iframe" } })).headers.get("location");
    expect(await loc("/docs/")).toBe("/docs/?embed=1"); // a listing
    expect(await loc("/docs/b.md")).toBe("/docs/b.md?embed=1"); // a viewer
    expect(await loc("/")).toBe("/"); // the site's own index.html never sees it
  });

  it("Markdown links in a framed or themed viewer keep the embed and the mode", async () => {
    const { call } = await siteFixture();
    const html = await (await call("/docs/a.md?view=1&embed=1&theme=dark")).text();
    expect(html).toContain('href="/__dropway/open?next=%2Fdocs%2Fb.md&amp;embed=1&amp;theme=dark"');
    expect(html).toContain('href="https://example.com/x"');
    const auto = await (await call("/docs/a.md?view=1")).text();
    expect(auto).toContain('href="b.md"');
  });

  it("the password gate inside the frame draws no header or footer and posts with the embed", async () => {
    const { dw, slug, call } = await siteFixture();
    await dw.json(`/api/v1/sites/${slug}`, { method: "PATCH", key: dw.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "correct horse" }) });
    const gate = await call(`/__dropway/open?next=%2F&embed=1&theme=light`, { headers: { "Sec-Fetch-Dest": "iframe" } });
    expect(gate.status).toBe(401);
    const html = await gate.text();
    expect(html).not.toContain("<header class=\"k-sitehead");
    expect(html).not.toContain('class="k-foot"');
    expect(bands(html)).toBe(0);
    expect(html).toMatch(/action="\/__dropway\/password\?dw_form=[^"&]+&amp;theme=light&amp;embed=1"/);
    // Opened directly, the gate has the site frame.
    const direct = await (await call("/")).text();
    expect(direct).toContain("<header class=\"k-sitehead");
  });

  it("system pages inside the frame open app links in a new tab (the app refuses to be framed)", async () => {
    const { call } = await siteFixture();
    const html = await (await call("/nope.html?embed=1")).text();
    expect(html).toContain('target="_blank" rel="noopener">Home</a>');
    expect(html).not.toContain("<header class=\"k-sitehead");
  });
});

describe("one app chrome (header and footer) on every app page", () => {
  it("the guilloche band sits above every app footer; the home page draws two in all", async () => {
    const dw = await freshInstance();
    for (const path of ["/dashboard", "/dashboard/publish", "/dashboard/keys", "/dashboard/settings", "/login", "/nope", "/claim?slug=x"]) {
      const html = await (await dw.call(path)).text();
      expect(html, path).toContain('<div class="k-guilloche-band" aria-hidden="true"></div><footer class="k-foot">');
      expect(bands(html), path).toBe(1);
    }
    expect(bands(await (await dw.call("/")).text())).toBe(2);
  });

  it("the Publish page carries the trust line (it lists the chosen files)", async () => {
    const dw = await freshInstance();
    expect(await (await dw.call("/dashboard/publish")).text()).toContain('<p class="k-trust">Kofra does not scan files; open files only from people you trust.</p>');
  });

  it("the account area is one markup: a quiet Sign in (plus an optional call to action), or Sign out", () => {
    expect(accountArea({ signIn: "/signin" })).toBe('<a class="k-btn k-sm k-quiet" href="/signin">Sign in</a>');
    expect(accountArea({ signIn: "/signin", start: { label: "Start free", href: "/signin" } })).toBe('<a class="k-btn k-sm k-quiet" href="/signin">Sign in</a><a class="k-btn k-sm k-hide-sm" href="/signin">Start free</a>');
    expect(accountArea({ user: { signOut: "/auth/signout" } })).toBe('<form method="post" action="/auth/signout"><button class="k-btn k-sm k-quiet" type="submit">Sign out</button></form>');
    expect(identityTag("Northwind", "mira@example.com")).toBe("Northwind · mira@example.com");
    expect(identityTag(null, "mira@example.com")).toBe("mira@example.com");
    expect(identityTag("Mira@Example.com", "mira@example.com")).toBe("mira@example.com");
    expect(identityTag("@mira", "mira@example.com")).toBe("@mira · mira@example.com");
    const html = appChrome({ header: { name: "Kofra", tag: identityTag("A", "a@b.c"), theme: "auto", next: "/" }, main: "", footer: null });
    expect(html).toContain('<a class="k-wm" href="/">Kofra</a><span class="k-tag">A · a@b.c</span>');
    expect(bands(html)).toBe(0); // no footer, no band
  });

  it("no-script app pages (404, claim) offer Sign in like every other page", async () => {
    const dw = await freshInstance();
    expect(await (await dw.call("/nope")).text()).toContain('<div class="k-acct"><a class="k-btn k-sm k-quiet" href="/login">Sign in</a></div>');
  });

  it("the API-key sign-in page has its h1 inside the panel, and no second 'API key' heading", async () => {
    const dw = await freshInstance();
    const html = await (await dw.call("/login")).text();
    expect(html).toMatch(/<section class="k-panel" aria-labelledby="dw-key-h"><h1 id="dw-key-h">Sign in to Kofra<\/h1>/);
    expect(html).not.toContain(">API key</h2>");
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
  });

  it("the explicit mode is kept by the theme cookie on the app (sanity)", async () => {
    const dw = await freshInstance();
    expect(await (await dw.call("/dashboard", { headers: { Cookie: `${THEME_COOKIE}=dark` } })).text()).toContain('data-theme="dark"');
  });
});

describe("viewer details", () => {
  it("the JSON Tree/Pretty switch is a segmented control, and the HTML viewer's Open is a button", async () => {
    const { call } = await siteFixture({ "d.json": '{"a":1}', "p.html": "<p>x</p>" });
    expect(await (await call("/d.json")).text()).toContain('<div class="dw-jtabs" role="group"');
    expect(await (await call("/p.html?view=1")).text()).toContain('<a class="k-btn k-sm k-ghost" href="/p.html" rel="nofollow" title="Open the page without the bar">Open</a>');
  });
});

describe("design system rules the judges found broken", () => {
  it("state kickers are accent-2 Martian Mono in both bundles, in end states and in panels (the cascade once greyed them)", () => {
    for (const css of [APP_CSS, SITE_CSS]) {
      expect(css).toContain(".k-state-code,.k-state .k-state-code{font:500 12px/1.3 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--accent-2)}");
      // Nothing more specific recolours it afterwards.
      expect(css.slice(css.indexOf(".k-state .k-state-code{"))).not.toMatch(/\.k-state-code[^{,]*\{[^}]*color:var\(--ink/);
    }
  });

  it("the dialog scrim darkens in both modes: it mixes the shadow token, never the ink (near-white in Midnight)", () => {
    for (const css of [APP_CSS, SITE_CSS]) {
      expect(css).toContain("--scrim:color-mix(in srgb,var(--shadow) 50%,transparent)");
      expect(css).not.toMatch(/--scrim:color-mix\(in srgb,var\(--ink\)/);
    }
  });

  it("the site bundle keeps its budget after this round", () => {
    expect(SITE_CSS.length).toBeLessThanOrEqual(24576);
  });
});
