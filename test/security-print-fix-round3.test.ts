import { describe, expect, it } from "vitest";
import { abuseContactOf } from "../packages/core/src/config";
import { appHeader } from "../packages/server/src/ui/chrome";
import { CLIENT_SCRIPT } from "../packages/server/src/ui/assets";
import { APP_CSS, SITE_CSS } from "../packages/server/src/ui/design.generated";
import { urlCode } from "../packages/server/src/ui/code";
import { CORE_FOOTER_LINKS } from "../packages/server/src/ui/shell";
import { SOURCE_REPO } from "../packages/server/src/repo";
import { form, freshInstance, ORIGIN } from "./helpers";

/**
 * Security Print fix round 3 (independent judges, 2026-10-24): the regressions each fix closes.
 * Each test here fails on 3eee0dd.
 */

async function siteFixture(files: Record<string, string | Uint8Array> = {}, config = {}) {
  const dw = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test", ...config });
  const pub = await dw.json("/api/v1/publish", {
    method: "POST",
    key: dw.ownerKey,
    body: form({ "index.html": "<p>hi</p>", "README.md": "# Notes\n\nText.", "data/a.json": '{"a":1}', "data/t.csv": "a,b\n1,2\n", "src/app.py": "print(1)\n", "m/p.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), "m/c.webm": "not a video", ...files }),
  });
  expect(pub.status).toBe(201);
  const site = new URL(pub.body.url as string);
  const call = (path: string, init: RequestInit = {}) => dw.call(`${site.origin}${path}`, { ...init, headers: { Accept: "text/html", ...(init.headers ?? {}) } });
  return { dw, site, slug: pub.body.slug as string, call };
}

const acts = (html: string) => /<div class="k-acts">(.*?)<\/div>/.exec(html)?.[1] ?? "";

describe("the app header is one row from 1000px, as in the gallery", () => {
  it("from 1000px the navigation sits on the first row before the account area and the switch; narrower it is the row under them", () => {
    expect(APP_CSS).toContain("@media (min-width:1000px){.k-top .k-nav{flex-basis:auto;flex-wrap:nowrap;order:1;margin-left:auto;white-space:nowrap}.k-acct{order:2}.k-top>.k-wrap:has(>.k-nav)>.k-acct{margin-left:0}.k-top .k-mode-switch{order:3}}");
    expect(APP_CSS).toContain(".k-nav{flex-basis:100%;");
  });

  it("a page with no switch marks its header, and the account area ends flush with the content edge", () => {
    const html = appHeader({ name: "Kofra", theme: "auto", next: "/", account: '<a class="k-btn k-sm k-quiet" href="/login">Sign in</a>', modeSwitch: false });
    expect(html).toMatch(/^<header class="k-top k-noswitch">/);
    expect(html).not.toContain("k-mode-switch");
    expect(APP_CSS).toContain(".k-noswitch .k-acct .k-btn.k-quiet:last-child{margin-right:-5px}");
    expect(appHeader({ name: "Kofra", theme: "auto", next: "/" })).toMatch(/^<header class="k-top">/);
  });
});

describe("footer links and the source repository", () => {
  it("the footer lists API, llms.txt, MCP, Agent skill and Self-host, all on the renamed repository", () => {
    expect(CORE_FOOTER_LINKS.map((l) => l.label)).toEqual(["API", "llms.txt", "MCP", "Agent skill", "Self-host"]);
    expect(SOURCE_REPO).toBe("https://github.com/TogetherWeOwn/kofra");
    for (const l of CORE_FOOTER_LINKS) expect(l.href).not.toMatch(/dropway/i);
  });

  it("an embedding app's footer links come first", async () => {
    const dw = await freshInstance({}, { uiSlots: { navItems: [], pages: [], footerLinks: [{ label: "Plans", href: "/plans" }] } });
    const html = await (await dw.call("/login")).text();
    expect(html).toMatch(/<nav class="k-end" aria-label="Footer"><a href="\/plans">Plans<\/a><a href="\/openapi.json">API<\/a>/);
    const notFound = await (await dw.call("/nope", { headers: { Accept: "text/html" } })).text();
    expect(notFound).toContain('<a href="/plans">Plans</a>');
  });

  it("no rendered link, llms.txt, the skill, the API licence or the dashboard script names the former repository", async () => {
    const dw = await freshInstance();
    const home = await (await dw.call("/")).text();
    for (const href of home.match(/href="[^"]*"/g) ?? []) expect(href.replace("/__dropway/", "/"), href).not.toMatch(/dropway/i);
    expect(home).toContain(`<a href="${SOURCE_REPO}">Open source</a>`);
    const llms = await (await dw.call("/llms.txt")).text();
    expect(llms).not.toMatch(/TogetherWeOwn\/dropway/);
    expect(llms).toContain("npx skills add TogetherWeOwn/kofra");
    expect(llms).toContain(`[Source (MIT)](${SOURCE_REPO})`);
    expect(await (await dw.call("/skill.md")).text()).not.toMatch(/TogetherWeOwn\/dropway/);
    expect(((await dw.json("/openapi.json")).body as any).info.license.url).toBe(`${SOURCE_REPO}/blob/main/LICENSE`);
    expect(CLIENT_SCRIPT).not.toMatch(/TogetherWeOwn\/dropway/);
  });
});

describe("inline code, kickers and code blocks never cut text awkwardly", () => {
  it("the hero kicker breaks only at its separators", async () => {
    const dw = await freshInstance();
    const home = await (await dw.call("/")).text();
    expect(home).toContain('<p class="k-k"><span class="k-nowrap">Self-hosted</span> · <span class="k-nowrap">single tenant</span> · <span class="k-nowrap">on Cloudflare</span></p>');
    expect(APP_CSS).toContain(".k-nowrap{white-space:nowrap}");
  });

  it("the sites address is one unbroken chip with no full stop after it", async () => {
    const dw = await freshInstance({ sitesMode: "subdomain", sitesDomain: "kofra-sites.test" });
    const home = await (await dw.call("/")).text();
    expect(home).toContain('Each site on its own origin: <code class="k-tok">https://SITE.kofra-sites.test/</code></p>');
  });

  it("home commands wrap so all of each shows; other code blocks show a scroll shadow; the claim command wraps and selects in one click", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const home = await (await dw.call("/")).text();
    expect(home).toMatch(/<pre id="dw-s-curl" class="k-wrapped"/);
    expect(APP_CSS).toContain(".k-codeblock pre.k-wrapped{white-space:pre-wrap;overflow-wrap:anywhere}");
    expect(APP_CSS).toMatch(/\.k-codeblock pre\{[^}]*background:linear-gradient\(to right,var\(--paper-3\) 40%,oklch\(from var\(--paper-3\) l c h \/ 0\)\) left\/28px 100% no-repeat local/);
    const claim = await (await dw.call("/claim?slug=abc")).text();
    expect(claim).toContain('<pre class="k-wrapped k-pick"');
  });

  it("a banner's text column takes its width, so the setup code block lines up with the banner (J04)", () => {
    expect(APP_CSS).toContain(".k-banner>div{flex:1}");
  });
});

describe("the app viewer frame never flashes white in Dark (E2: only the site's own HTML gets a white canvas)", () => {
  it("the frame's backing follows the mode", () => {
    expect(APP_CSS).toContain(".k-frame{flex:1;width:100%;min-height:0;border:0;background:light-dark(#fff,var(--paper));display:block}");
    expect(APP_CSS).not.toMatch(/\.k-frame\{[^}]*background:#fff[;}]/);
  });

  it("the app viewer page has a (visually hidden) h1 naming the file", async () => {
    const { dw, slug } = await siteFixture();
    const html = await (await dw.call(`/v/${slug}/data/a.json`)).text();
    expect(html).toContain('<h1 class="k-sr" id="dw-vh">a.json</h1>');
    expect(CLIENT_SCRIPT).toMatch(/getElementById\("dw-vh"\)/);
  });
});

describe("site-origin viewers: one h1 each, the trust line in a landmark, the path never cut off", () => {
  it("every viewer body without its own h1 gets the file name as a hidden h1; Markdown with an h1 keeps its own", async () => {
    const { call } = await siteFixture();
    const cases: Array<[string, string]> = [["/data/a.json", "a.json"], ["/data/t.csv", "t.csv"], ["/src/app.py", "app.py"], ["/m/p.png", "p.png"], ["/m/c.webm", "c.webm"], ["/index.html?view=source", "index.html"]];
    for (const [path, name] of cases) {
      const html = await (await call(path)).text();
      expect(html, path).toContain(`<h1 class="k-sr">${name}</h1>`);
    }
    const md = await (await call("/README.md")).text();
    expect(md).not.toContain('<h1 class="k-sr">');
    expect(md).toMatch(/<h1[\s>]/);
  });

  it("the trust line under a viewer sits in the page footer (a contentinfo landmark)", async () => {
    const { call } = await siteFixture();
    const html = await (await call("/src/app.py")).text();
    expect(html).toContain('<footer class="k-hide-lg"><p class="k-trust k-vtrust">Kofra does not scan files; open files only from people you trust.</p></footer>');
  });

  it("the viewer bar's path wraps instead of cutting the file name with an ellipsis (WCAG 1.4.12)", () => {
    expect(SITE_CSS).not.toMatch(/\.k-vfile \.k-crumbs>:last-child\{[^}]*text-overflow:ellipsis/);
    expect(SITE_CSS).toContain(".k-vfile .k-crumbs{flex:0 1 auto;min-width:2.5rem}");
  });

  it("a video the browser cannot play says so (hashed script, fallback with Open and Download)", async () => {
    const { call } = await siteFixture();
    const res = await call("/m/c.webm");
    const html = await res.text();
    expect(html).toContain('<div class="dw-fallback" id="dw-verr" hidden><p>This browser cannot play this video.</p>');
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(html).toMatch(/<script>\(function\(\)\{var v=document\.querySelector\("\.dw-video"\)/);
  });

  it("on phones an image's stage hugs the image", async () => {
    const { call } = await siteFixture();
    expect(await (await call("/m/p.png")).text()).toContain("@media (max-width:640px){.dw-stage{min-height:0}}");
  });
});

describe("site-origin end states", () => {
  it("Home is the filled action when it is the only one (404), and a ghost after a primary action", async () => {
    const { call } = await siteFixture();
    expect(acts(await (await call("/missing.html")).text())).toMatch(/^<a class="k-btn" href="[^"]+">Home<\/a>$/);
  });

  it("a visitor to an empty site gets Home only; inside the app's viewer the owner gets Publish files first", async () => {
    const dw = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test" });
    expect((await dw.json("/api/v1/sites", { method: "POST", key: dw.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "empty-two" }) })).status).toBe(201);
    const visitor = await (await dw.call("https://empty-two.sites.test/", { headers: { Accept: "text/html" } })).text();
    expect(acts(visitor)).toMatch(/^<a class="k-btn" href="[^"]+">Home<\/a>$/);
    expect(visitor).not.toContain("Publish files");
    expect(visitor).toContain("The owner of this site has not published anything on it yet.");
    const owner = await (await dw.call("https://empty-two.sites.test/?embed=1", { headers: { Accept: "text/html" } })).text();
    expect(acts(owner)).toMatch(/^<a class="k-btn" href="[^"]+\/dashboard\/publish\?site=empty-two"[^>]*>Publish files<\/a><a class="k-btn k-ghost"/);
  });

  it("inside the app's viewer the password gate says why the owner sees it too", async () => {
    const { dw, slug, site } = await siteFixture();
    expect((await dw.json(`/api/v1/sites/${slug}`, { method: "PATCH", key: dw.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "letmein1" }) })).status).toBe(200);
    const framed = await (await dw.call(`${site.origin}/?embed=1`, { headers: { Accept: "text/html", "Sec-Fetch-Dest": "iframe" } })).text();
    expect(framed).toContain("This preview shows the site as visitors see it, so it asks you for the password too.");
    const top = await (await dw.call(`${site.origin}/`, { headers: { Accept: "text/html" } })).text();
    expect(top).not.toContain("This preview shows the site");
  });
});

describe("Report abuse opens a page (it was a 404)", () => {
  async function anonSite(config = {}) {
    const dw = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test", anonymous: { enabled: true }, ...config });
    const pub = await dw.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "<h1>hi</h1>" }) });
    expect(pub.status).toBe(201);
    return { dw, url: new URL(pub.body.url as string) };
  }

  it("the link on an anonymous page goes to <site>/__dropway/report, which names the site and how to report it", async () => {
    const { dw, url } = await anonSite();
    const page = await (await dw.call(url.href, { headers: { Accept: "text/html" } })).text();
    expect(page).toContain(`href="${url.origin}/__dropway/report"`);
    const res = await dw.call(`${url.origin}/__dropway/report`, { headers: { Accept: "text/html" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<p class="k-state-code">REPORT</p>');
    expect(html).toContain("<h1>Report this site</h1>");
    // Fix round 4: the address is code.k-brk (it wraps only after "/" and before "."), and the sentence goes on
    // in lower case after its comma.
    expect(html).toContain(`<p>${urlCode(`${url.origin}/`)}</p>`);
    expect(html).toContain("private data), tell the people who run");
  });

  it("with ABUSE_CONTACT an email address opens a prefilled email; an https URL is the report link", async () => {
    const mail = await anonSite({ abuseContact: "abuse@example.com" });
    const html = await (await mail.dw.call(`${mail.url.origin}/__dropway/report`, { headers: { Accept: "text/html" } })).text();
    expect(acts(html)).toMatch(/^<a class="k-btn" href="mailto:abuse@example\.com\?subject=Report%3A%20https%3A%2F%2F[^"]+">Email a report<\/a><a class="k-btn k-ghost"/);
    const form2 = await anonSite({ abuseContact: "https://example.com/report" });
    expect(acts(await (await form2.dw.call(`${form2.url.origin}/__dropway/report`, { headers: { Accept: "text/html" } })).text())).toMatch(/^<a class="k-btn" href="https:\/\/example\.com\/report" rel="noopener">Report it<\/a>/);
  });

  it("ABUSE_CONTACT accepts an email address or an https URL, nothing else", () => {
    expect(abuseContactOf(" abuse@kofra.app ")).toBe("abuse@kofra.app");
    expect(abuseContactOf("https://kofra.app/report")).toBe("https://kofra.app/report");
    expect(abuseContactOf("http://kofra.app/report")).toBeNull();
    expect(abuseContactOf("javascript:alert(1)")).toBeNull();
    expect(abuseContactOf("")).toBeNull();
    expect(abuseContactOf(undefined)).toBeNull();
    expect(abuseContactOf("https://desk@kofra.app/report")).toBe("https://desk@kofra.app/report");
    expect(abuseContactOf("a@b")).toBeNull();
    // No backtracking pattern: a crafted value is answered at once (CodeQL js/polynomial-redos).
    const started = Date.now();
    expect(abuseContactOf(`!@!.${"!.".repeat(5000)}`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe("dashboard copy and state", () => {
  it("Settings no longer says everything is changed in wrangler.jsonc: only the instance block is read-only", async () => {
    const dw = await freshInstance();
    const html = await (await dw.call("/dashboard/settings")).text();
    expect(html).toContain('<p id="dw-sub">Your account, the members who can sign in, and how this instance is set up.</p>');
    expect(html).toContain('Read-only here: change these in <code class="k-tok">wrangler.jsonc</code> and redeploy.');
  });

  it("the dashboard script: ticked defaults survive form.reset(), times are UTC, version sources are words, nothing to open before a version is live", () => {
    expect(CLIENT_SCRIPT).toMatch(/el\.checked = el\.defaultChecked = !!v/);
    expect(CLIENT_SCRIPT).toMatch(/toISOString\(\)\.slice\(0, 16\)\.replace\("T", " "\) \+ " UTC"/);
    expect(CLIENT_SCRIPT).not.toMatch(/timeZoneName/);
    expect(CLIENT_SCRIPT).toMatch(/publish: "one-call publish"/);
    expect(CLIENT_SCRIPT).not.toMatch(/v\.client, v\.source\]/);
    expect(CLIENT_SCRIPT).toMatch(/hasLive\s*\?/);
    expect(CLIENT_SCRIPT).toMatch(/"Key limited to a site"/);
    expect(CLIENT_SCRIPT).not.toMatch(/"No sites yet\."/);
  });

  it("option rows (radios and checkboxes with a label) align to the top of their line", () => {
    expect(APP_CSS).toMatch(/\.k-tog\{display:inline-flex;[^}]*vertical-align:top/);
  });
});

describe("the no-script switch resumes on the pressed button", () => {
  it("each button has a marker just before it, and the CSS keeps the first and last button's corners", async () => {
    const dw = await freshInstance();
    const html = await (await dw.call("/nope", { headers: { Accept: "text/html" } })).text();
    for (const v of ["auto", "light", "dark"]) expect(html).toContain(`<span id="dw-mode-${v}"></span><button type="submit" name="theme" value="${v}"`);
    expect(APP_CSS).toContain(".k-mode-switch button:first-of-type{border-left:0;");
    expect(APP_CSS).toContain(".k-mode-switch,.k-mode-switch [id]{scroll-margin-top:100vh}");
    const res = await dw.call("/__dropway/theme", { method: "POST", body: new URLSearchParams({ theme: "light", next: "/nope" }), headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN } });
    expect(res.headers.get("location")).toBe("/nope#dw-mode-light");
  });
});
