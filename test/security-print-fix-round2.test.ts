import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { appFooter, appHeader, siteFooter } from "../packages/server/src/ui/chrome";
import { CLIENT_SCRIPT } from "../packages/server/src/ui/assets";
import { APP_CSS, SITE_CSS } from "../packages/server/src/ui/design.generated";
import { urlCode } from "../packages/server/src/ui/pages";
import { renderMarkdown } from "../packages/server/src/viewers/markdown";
import { form, freshInstance, ORIGIN } from "./helpers";

/**
 * Security Print fix round 2 (independent judges, 2026-10-24): the regressions each fix closes.
 * Each test here fails on f2aa730.
 */

async function siteFixture(files: Record<string, string> = {}) {
  const dw = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test" });
  const pub = await dw.json("/api/v1/publish", {
    method: "POST",
    key: dw.ownerKey,
    body: form({ "index.html": "<p>hi</p>", "README.md": "# Notes\n\n| a | b |\n|---|---|\n| 1 | 2 |", "src/app.py": "print(1)\n", "docs/r.pdf": "%PDF-1.4\n%%EOF\n", ...files }),
  });
  expect(pub.status).toBe(201);
  const site = new URL(pub.body.url as string);
  const call = (path: string, init: RequestInit = {}) => dw.call(`${site.origin}${path}`, { ...init, headers: { Accept: "text/html", ...(init.headers ?? {}) } });
  return { dw, site, slug: pub.body.slug as string, call };
}

const mains = (html: string) => html.match(/<main\b[^>]*>/g) ?? [];

describe("one <main> and a skip link on every site-origin page (WCAG 2.4.1)", () => {
  it("every viewer has exactly one main#dw-main, after a Skip to content link that passes the bar", async () => {
    const { call } = await siteFixture();
    for (const path of ["/README.md", "/src/app.py", "/docs/r.pdf", "/index.html?view=1", "/index.html?view=source"]) {
      const html = await (await call(path)).text();
      expect(mains(html), path).toEqual(['<main id="dw-main" class="k-vbody">']);
      expect(html.indexOf('<a class="k-skip dw-skip" href="#dw-main">'), path).toBeGreaterThan(-1);
      expect(html.indexOf('<a class="k-skip"'), path).toBeLessThan(html.indexOf('<header class="k-vbar dw-vbar"'));
    }
  });

  it("the PDF and the HTML page in the frame name the file in a visually hidden h1", async () => {
    const { call } = await siteFixture();
    expect(await (await call("/docs/r.pdf")).text()).toContain('<h1 class="k-sr">r.pdf</h1>');
    expect(await (await call("/index.html?view=1")).text()).toContain('<h1 class="k-sr">index.html</h1>');
  });

  it("inside the app's frame (&embed=1) the viewer keeps its main but has no skip link (the app page has one)", async () => {
    const { call } = await siteFixture();
    const html = await (await call("/README.md?embed=1")).text();
    expect(mains(html)).toHaveLength(1);
    expect(html).not.toContain('class="k-skip"');
  });

  it("system pages and listings start with the skip link", async () => {
    const { call } = await siteFixture();
    for (const path of ["/missing.html", "/src/"]) {
      const html = await (await call(path)).text();
      expect(html.indexOf('<a class="k-skip dw-skip" href="#dw-main">'), path).toBeGreaterThan(-1);
      expect(mains(html), path).toHaveLength(1);
    }
  });
});

describe("end states share one component and one button order", () => {
  it("an empty site is a .k-state panel (kicker EMPTY), Publish files first, then Home (inside the app's viewer)", async () => {
    const dw = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test" });
    expect((await dw.json("/api/v1/sites", { method: "POST", key: dw.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "empty-one" }) })).status).toBe(201);
    // Round 3: "Publish files" is for the owner, so it shows inside the app's file viewer (&embed=1) only.
    const res = await dw.call("https://empty-one.sites.test/?embed=1", { headers: { Accept: "text/html" } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<div class="k-state k-nostamp">');
    expect(html).not.toMatch(/class="[^"]*k-empty/);
    expect(html).toContain('<p class="k-state-code">EMPTY</p>');
    const acts = /<div class="k-acts">(.*?)<\/div>/.exec(html)![1]!;
    expect(acts.indexOf(">Publish files<")).toBeGreaterThan(-1);
    expect(acts.indexOf(">Publish files<")).toBeLessThan(acts.indexOf(">Home<"));
    expect(acts).toMatch(/^<a class="k-btn" /); // the primary action leads
  });
});

describe("the header reads in its visual order at every width (WCAG 2.4.3)", () => {
  it("wordmark, tag, account area and switch come before the navigation row in the markup", () => {
    const html = appHeader({ name: "Kofra", tag: "Acme · a@b.test", nav: [{ label: "Sites", href: "/dashboard" }], account: '<a href="/login">Sign in</a>', theme: "auto", next: "/" });
    const at = (s: string) => html.indexOf(s);
    expect(at('class="k-wm"')).toBeLessThan(at('class="k-tag"'));
    expect(at('class="k-tag"')).toBeLessThan(at('class="k-acct"'));
    expect(at('class="k-acct"')).toBeLessThan(at('class="k-mode-switch"'));
    expect(at('class="k-mode-switch"')).toBeLessThan(at('class="k-nav"'));
  });

  it("the nav is a full-width row at every width, and the account tag is user data, not an upper-case kicker", () => {
    expect(APP_CSS).toContain(".k-nav{flex-basis:100%");
    expect(APP_CSS).not.toMatch(/\.k-nav\{order:3/);
    const tag = /\.k-top \.k-tag\{([^}]*)\}/.exec(APP_CSS)![1]!;
    expect(tag).not.toContain("uppercase");
    expect(tag).not.toContain("var(--mono)");
  });
});

describe("text never breaks inside a token", () => {
  it("phone ledger cards: the sub-line has a line of its own, so no drawn separator can start a wrapped line", () => {
    expect(APP_CSS).not.toMatch(/\.k-sub[^{]*::before\{content:"· "\}/);
    expect(APP_CSS).not.toMatch(/\.k-table td\.k-num \.k-sub\{display:inline/);
    expect(APP_CSS).toMatch(/(?:^|\})\.k-sub\{display:block/);
  });

  it("the sites list draws no empty sub-line for a site with no live version, and keys and members label every fact", () => {
    // (The served script may be reformatted by the bundler: match tokens, not layout.)
    expect(CLIENT_SCRIPT).toMatch(/class:\s*"k-sr",\s*text:\s*"Not published"/);
    expect(CLIENT_SCRIPT).not.toMatch(/bytes\(v\.totalBytes\)\s*:\s*""/);
    expect(CLIENT_SCRIPT).toMatch(/"data-label":\s*"Activity"/);
    expect(CLIENT_SCRIPT).toMatch(/"data-label":\s*"Added"/);
  });

  it("urlCode wraps a long URL only after / and before ., never at a hyphen or after ?", () => {
    // Round 3: under 40 characters the code never breaks at all (it moves to the next line whole).
    expect(urlCode("https://SITE.kofra-sites.test/")).toBe('<code class="k-tok">https://SITE.kofra-sites.test/</code>');
    expect(urlCode("https://SITE.long-sites-domain.example.com/p/")).toBe('<code class="k-brk"><span>https://</span><wbr><span>SITE</span><wbr><span>.long-sites-domain</span><wbr><span>.example</span><wbr><span>.com/</span><wbr><span>p/</span></code>');
    expect(urlCode("npx skills add https://kofra.example.com")).toBe('<code class="k-brk"><span>npx</span> <span>skills</span> <span>add</span> <span>https://</span><wbr><span>kofra</span><wbr><span>.example</span><wbr><span>.com</span></code>');
    // Round 4: the parts stay whole wherever they sit in the code (a link inside it too), on both origins.
    for (const css of [APP_CSS, SITE_CSS]) expect(css).toContain("code.k-tok,code.k-brk span,a.k-brk span{white-space:nowrap}");
  });

  it("inline code keeps its padding when it wraps and only breaks a token longer than the line", () => {
    for (const css of [APP_CSS, SITE_CSS]) {
      const rule = /:not\(pre\)>code\{([^}]*)\}/.exec(css)![1]!;
      expect(rule).toContain("box-decoration-break:clone");
      expect(rule).toContain("overflow-wrap:break-word");
      expect(rule).not.toContain("anywhere");
    }
  });

  it("file paths break after their / separators (<wbr>), and take a whole line on the narrowest phones", () => {
    expect(CLIENT_SCRIPT).toMatch(/function pathBreaks\(p\)/);
    expect(APP_CSS).toContain(".k-table.k-ftable .k-fname,.k-table.k-ftable tr>:first-child a{overflow-wrap:break-word}");
  });
});

describe("forms", () => {
  it("the publish slug pattern compiles under the v flag browsers use for pattern attributes", () => {
    const m = /pattern: "((?:[^"\\]|\\.)*)"/.exec(CLIENT_SCRIPT)!;
    const attr = JSON.parse(`"${m[1]}"`) as string;
    expect(attr).toBe("[a-z0-9][a-z0-9\\-]{1,62}");
    expect(() => new RegExp(`^(?:${attr})$`, "v")).not.toThrow();
    const re = new RegExp(`^(?:${attr})$`, "v");
    expect(re.test("my-site")).toBe(true);
    expect(re.test("-bad")).toBe(false);
  });

  it("an irreversible confirmation opens on Cancel, never on its own destructive button", () => {
    expect(CLIENT_SCRIPT).toMatch(/\(input \|\| \(opts\.danger === false \? ok : cancel\)\)\.focus\(\)/);
  });

  it("unchecked checkboxes and radios are drawn from the tokens; forced colours get the native controls back", () => {
    expect(APP_CSS).toContain("input:is([type=checkbox],[type=radio]){-webkit-appearance:none;appearance:none;");
    expect(APP_CSS).toMatch(/@media \(forced-colors:active\)\{[^@]*input:is\(\[type=checkbox\],\[type=radio\]\)\{-webkit-appearance:auto;appearance:auto\}/);
  });
});

describe("the no-script mode switch returns to itself", () => {
  it("POST /__dropway/theme answers 303 to next#dw-mode-<choice>, and the switch carries those markers", async () => {
    const dw = await freshInstance();
    const res = await dw.call("/__dropway/theme", {
      method: "POST",
      body: new URLSearchParams({ theme: "dark", next: "/dashboard" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    });
    expect(res.headers.get("location")).toBe("/dashboard#dw-mode-dark");
    const page = await (await dw.call("/dashboard")).text();
    expect(page).toContain('<form class="k-mode-switch" id="dw-mode"');
    // The marker sits just before its button, so the next Tab after the redirect lands on the button that was pressed.
    expect(page).toContain('<span id="dw-mode-dark"></span><button type="submit" name="theme" value="dark"');
  });
});

describe("site-origin chrome is full-bleed (one grid on the sites origin)", () => {
  it("site header and footer sit on the viewer bar's 18px gutter; the listing body starts on the same edge", () => {
    expect(SITE_CSS).toContain(".k-sitehead>.k-wrap,.k-sitefoot>.k-wrap{max-width:none;padding:0 18px}");
    expect(SITE_CSS).toMatch(/\.k-listing\{max-width:calc\(60rem \+ 36px\);padding:[^}]*18px/);
    expect(APP_CSS).toContain(".k-page.k-wide .k-top>.k-wrap{max-width:none;padding-inline:18px}");
  });
});

describe("markdown tables", () => {
  it("the accent rule is as wide as the table, not the whole measure", async () => {
    const out = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n", "t.md");
    expect(out.html).toContain("<table>");
    const { MD_CSS } = await import("../packages/server/src/viewers/markdown");
    expect(MD_CSS).toMatch(/\.k-doc table\{[^}]*width:max-content[^}]*max-width:100%/);
  });
});

describe("fallback faces are metric-matched on systems without Arial, Georgia or Courier New (G9 everywhere)", () => {
  it("each family lists its fallback faces in order, the DejaVu ones after the Arial, Georgia and Courier New ones", () => {
    for (const css of [APP_CSS, SITE_CSS]) {
      expect(css).toContain("--sans:'Public Sans','Public Sans Fallback','Public Sans Fallback B','Public Sans Fallback C',system-ui");
      expect(css).toContain("--serif:'Newsreader','Newsreader Fallback','Newsreader Fallback B',Georgia");
      expect(css).toContain("--mono:'Martian Mono','Martian Mono Fallback','Martian Mono Fallback B',ui-monospace");
      expect(css).toContain("@font-face{font-family:'Public Sans Fallback';src:local('Arial'),local('Arimo'),local('Liberation Sans');size-adjust:102.18%");
      expect(css).toContain("@font-face{font-family:'Public Sans Fallback B';src:local('DejaVu Sans');size-adjust:90.89%");
      expect(css).toContain("@font-face{font-family:'Public Sans Fallback C';src:local('DejaVu Serif');size-adjust:89.23%");
      expect(css).toContain("@font-face{font-family:'Newsreader Fallback B';src:local('DejaVu Serif');size-adjust:88.44%");
      expect(css).toContain("@font-face{font-family:'Martian Mono Fallback B';src:local('DejaVu Sans Mono');size-adjust:116.27%");
    }
  });

  it("app-only rules stay out of the inlined site bundle, which stays under its budget", () => {
    for (const sel of [".k-btn.k-danger{", ".k-hint{", ".k-chip.k-solid{", ".k-table td.k-act{", ".k-banner.k-danger{", ".k-muted{", ".k-guilloche-band.k-thin{"]) {
      expect(SITE_CSS, sel).not.toContain(sel);
      expect(APP_CSS, sel).toContain(sel);
    }
    expect(SITE_CSS.length).toBeLessThanOrEqual(24576);
  });
});

describe("footers never change height when the fonts arrive (G9 at 320)", () => {
  it("the domains line is two parts; under 720px each has a line of its own", () => {
    const d = "kofra.test · sites on <site>.kofra-sites.test";
    const want = '<span class="k-dom"><span>kofra.test</span><span class="k-dom-sep" aria-hidden="true"> · </span><span>sites on &lt;site&gt;.kofra-sites.test</span></span>';
    expect(appFooter({ name: "Kofra", domains: d })).toContain(want);
    expect(siteFooter({ name: "Kofra", appOrigin: "https://kofra.test", domains: d })).toContain(want);
    for (const css of [APP_CSS, SITE_CSS]) expect(css).toContain(".k-foot .k-dom{flex-basis:100%}.k-foot .k-dom>span{display:block}.k-foot .k-dom>.k-dom-sep{display:none}");
  });
});

describe("pinned behaviour of earlier fixes (Paperclip Review round 3)", () => {
  it("a navigation that hits a failing database gets the per-request platform 500: its mode, fonts and both actions", async () => {
    const dw = await freshInstance({ appOrigin: ORIGIN, sitesMode: "subdomain", sitesDomain: "sites.test" });
    await env.DB.prepare("DROP TABLE version_files").run();
    await env.DB.prepare("DROP TABLE sites").run();
    const res = await dw.call("https://anything.sites.test/?theme=dark", { headers: { Accept: "text/html", "Sec-Fetch-Dest": "document" } });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-security-policy")).toContain(`font-src ${ORIGIN}`);
    const html = await res.text();
    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(html).toContain("<h1>Something went wrong on our side</h1>");
    expect(html).toContain(`src:url(${ORIGIN}/__dropway/fonts/`);
    const acts = /<div class="k-acts">(.*?)<\/div>/.exec(html)![1]!;
    expect(acts).toMatch(/^<a class="k-btn" href="https:\/\/anything\.sites\.test\/">Try again<\/a><a class="k-btn k-ghost" href="https:\/\/dropway\.test">Home<\/a>$/);
  });

  it("the viewer bar's checksum is a keyboard disclosure with the full SHA-256 at every width", async () => {
    const { call } = await siteFixture();
    const html = await (await call("/src/app.py")).text();
    const m = /<span class="k-sum k-mini">(.*?)<\/span><\/div>/s.exec(html);
    expect(m, "viewer bar seal and checksum").toBeTruthy();
    expect(m![0]).not.toContain("k-hide-sm");
    expect(m![1]).toMatch(/<details class="k-checksum"><summary>SHA-256 [0-9a-f]{12}<\/summary><code>[0-9a-f]{64}<\/code><\/details>$/);
  });
});
