import { describe, expect, it } from "vitest";
import { CLIENT_SCRIPT } from "../packages/server/src/ui/assets";
import { LINE_CODE, nameCode, urlCode } from "../packages/server/src/ui/code";
import { APP_CSS, SITE_CSS } from "../packages/server/src/ui/design.generated";
import { form, freshInstance } from "./helpers";

/**
 * Security Print fix round 4 (CEO TOG-39281 on judge B4, 2026-10-24). Each test here fails on c0a0f0f.
 * The browser behaviour (the switch hidden while a secret shows, names on one line at 390 and 320 px) is tested
 * in packages/server/test/fix-round4-browser.test.ts; these pin the markup and the CSS both origins get.
 */

describe("F1: pages that show a secret once have no colour switch", () => {
  it("every secret the dashboard shows once is marked data-once, and the script hides the switch while one is on the page", () => {
    // CLIENT_SCRIPT is the bundled function's source, so the patterns allow any whitespace.
    expect(CLIENT_SCRIPT).toMatch(/class:\s*"k-keyout",\s*role:\s*"status",\s*"data-once":\s*true\s*\}/);
    expect(CLIENT_SCRIPT).toMatch(/class:\s*"k-small",\s*"data-once":\s*true\s*\},\s*h\("p",\s*\{\s*text:\s*"Anonymous site: it expires "/);
    expect(CLIENT_SCRIPT).toMatch(/var once = !!\$\("\[data-once\]"\);\s*if \(form\.hidden === once\) return;\s*form\.hidden = once;\s*top\.classList\.toggle\("k-noswitch", once\);/);
    expect(CLIENT_SCRIPT).toMatch(/new MutationObserver\(sync\)\.observe\(d\.body,\s*\{\s*childList:\s*true,\s*subtree:\s*true\s*\}\)/);
    expect(CLIENT_SCRIPT).toMatch(/wireThemeSwitch\(\);\s*hideSwitchWhileSecret\(\);/);
  });

  it("a new key's note sets the secret's name and the header as code.k-tok", () => {
    expect(CLIENT_SCRIPT).toMatch(/"Give it to the agent or person as ",\s*tok\("KOFRA_API_KEY"\),\s*"\."/);
    expect(CLIENT_SCRIPT).toMatch(/"Store it in your password manager; agents use it as ",\s*tok\("Authorization: Bearer <key>"\),\s*"\."/);
    expect(CLIENT_SCRIPT).toMatch(/function tok\(t\) \{\s*return h\("code",\s*\{\s*class:\s*"k-tok",\s*text:\s*t\s*\}\);/);
  });
});

describe("F2: a site's name never splits at a hyphen", () => {
  it("the claim page marks the site's name and #token= as code.k-tok", async () => {
    const dw = await freshInstance();
    const html = await (await dw.call("/claim?slug=merry-quartz-rf3bew")).text();
    expect(html).toContain('To keep <code class="k-tok">merry-quartz-rf3bew</code>, call the API');
    expect(html).toContain('(the part of this link after <code class="k-tok">#token=</code>)');
    // A name longer than the narrowest line wraps (plain code) instead of running off a phone screen.
    const long = "a".repeat(LINE_CODE + 1);
    expect(await (await dw.call(`/claim?slug=${long}`)).text()).toContain(`To keep <code>${long}</code>,`);
  });

  it("the report page (site origin) sets the address as code.k-brk and goes on in lower case after the comma", async () => {
    const dw = await freshInstance({ sitesMode: "subdomain", sitesDomain: "long-sites-domain.test", anonymous: { enabled: true } });
    const pub = await dw.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "<h1>hi</h1>" }) });
    expect(pub.status).toBe(201);
    const site = new URL(pub.body.url as string);
    const html = await (await dw.call(`${site.origin}/__dropway/report`, { headers: { Accept: "text/html" } })).text();
    expect(html).toContain(`<p><code class="k-brk"><span>https://</span><wbr><span>${pub.body.slug}</span><wbr><span>.long-sites-domain</span><wbr><span>.test/</span></code></p>`);
    expect(html).toContain("private data), tell the people who run");
  });

  it("both stylesheets keep code.k-tok and the parts of code.k-brk whole (the site origin had neither)", () => {
    for (const css of [APP_CSS, SITE_CSS]) expect(css).toContain("code.k-tok,code.k-brk span,a.k-brk span{white-space:nowrap}");
  });

  it("nameCode: whole when it fits the narrowest line; urlCode: a part longer than that line may break inside itself", () => {
    expect(nameCode("plucky-sparrow-a1b2c3")).toBe('<code class="k-tok">plucky-sparrow-a1b2c3</code>');
    expect(nameCode("x".repeat(LINE_CODE + 1))).toBe(`<code>${"x".repeat(LINE_CODE + 1)}</code>`);
    const slug = "a-very-long-slug-name-for-layout-tests-1234567";
    expect(urlCode(`https://${slug}.kofra-sites.test/`)).toBe(`<code class="k-brk"><span>https://</span><wbr>${slug}<wbr><span>.kofra-sites</span><wbr><span>.test/</span></code>`);
  });

  it("the dashboard's publish result sets the address as code.k-brk with nowrap parts (it was word-break:break-all)", () => {
    expect(CLIENT_SCRIPT).toMatch(/h\("code",\s*\{\s*class:\s*"k-brk"\s*\},\s*h\("a",\s*\{\s*href:\s*url,\s*target:\s*"_blank",\s*rel:\s*"noopener"\s*\},\s*urlParts\(url\)\)\)/);
    expect(CLIENT_SCRIPT).toMatch(/function urlParts\(u\)/);
  });
});
