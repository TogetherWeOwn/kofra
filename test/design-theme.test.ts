import { describe, expect, it } from "vitest";
import { APP_PAGE_CSP, THEME_COOKIE } from "@dropway/server";
import { THEME_BODY_MAX } from "../packages/server/src/ui/theme";
import { APP_CSS_HASH, THEME_COLORS } from "../packages/server/src/ui/design.generated";
import { FONT_FILES } from "../packages/server/src/ui/fonts.generated";
import { renderMarkdown } from "../packages/server/src/viewers/markdown";
import { sanitizeHtml } from "../packages/server/src/viewers/sanitize";
import { ORIGIN, form, freshInstance } from "./helpers";

/** Security Print colour modes (PORT-SPEC 3) and the CSP each page class ships with (PORT-SPEC 7). */

const themePost = (dw: Awaited<ReturnType<typeof freshInstance>>, fields: Record<string, string>, headers: Record<string, string> = { Origin: ORIGIN }) => {
  const body = new URLSearchParams(fields);
  return dw.call("/__dropway/theme", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers } });
};
const htmlTag = (html: string) => /<html[^>]*>/.exec(html)![0];

describe("theme cookie route (POST /__dropway/theme)", () => {
  it("light and dark set the __Host- cookie for a year; auto deletes it; all answer 303 to next", async () => {
    const dw = await freshInstance();
    for (const theme of ["light", "dark"]) {
      const res = await themePost(dw, { theme, next: "/dashboard/keys?x=1" });
      expect(res.status).toBe(303);
      // Back to the pressed button's marker (#dw-mode-<choice>), so the next Tab lands on that button after the reload.
      expect(res.headers.get("location")).toBe(`/dashboard/keys?x=1#dw-mode-${theme}`);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("set-cookie")).toBe(`${THEME_COOKIE}=${theme}; Path=/; Secure; SameSite=Lax; Max-Age=31536000`);
    }
    const auto = await themePost(dw, { theme: "auto", next: "/" });
    expect(auto.status).toBe(303);
    expect(auto.headers.get("set-cookie")).toBe(`${THEME_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`);
    expect(THEME_COOKIE).toBe("__Host-dw_theme");
  });

  it("same origin only: a cross-origin or unlabelled post changes nothing", async () => {
    const dw = await freshInstance();
    const cross = await themePost(dw, { theme: "dark", next: "/dashboard" }, { Origin: "https://evil.test" });
    expect(cross.status).toBe(303);
    expect(cross.headers.get("location")).toBe("/");
    expect(cross.headers.get("set-cookie")).toBeNull();
    const noOrigin = await themePost(dw, { theme: "dark", next: "/dashboard" }, {});
    expect(noOrigin.headers.get("set-cookie")).toBeNull();
    // No Origin but the browser says the request came from this origin: accepted.
    const fetchMeta = await themePost(dw, { theme: "dark", next: "/dashboard" }, { "Sec-Fetch-Site": "same-origin" });
    expect(fetchMeta.headers.get("set-cookie")).toContain(`${THEME_COOKIE}=dark;`);
  });

  it("next must be a same-origin path; an unknown theme sets nothing", async () => {
    const dw = await freshInstance();
    for (const next of ["//evil.test", "/\tx", "https://evil.test/", "/\\evil", "dashboard", `/${"a".repeat(600)}`]) {
      const res = await themePost(dw, { theme: "dark", next });
      expect(res.headers.get("location"), next).toBe("/");
    }
    const bad = await themePost(dw, { theme: "sepia", next: "/login" });
    expect(bad.status).toBe(303);
    expect(bad.headers.get("location")).toBe("/login");
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  it("reads at most THEME_BODY_MAX bytes: a large declared or streamed body is refused unread; only urlencoded forms count", async () => {
    const dw = await freshInstance();
    const big = new URLSearchParams({ theme: "dark", next: "/", pad: "x".repeat(THEME_BODY_MAX) });
    const declared = await themePost(dw, Object.fromEntries(big));
    expect(declared.status).toBe(413);
    expect(declared.headers.get("set-cookie")).toBeNull();
    // Streamed with no Content-Length: cut off once it passes the limit.
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (sent >= 64) return ctl.close();
        sent++;
        ctl.enqueue(new TextEncoder().encode(sent === 1 ? "theme=dark&next=%2F&pad=" : "y".repeat(1024)));
      },
    });
    const streamed = await dw.call("/__dropway/theme", { method: "POST", body: stream, headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN }, duplex: "half" } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(streamed.headers.get("set-cookie")).toBeNull();
    expect(sent).toBeLessThan(64);
    // The exact boundary, both as a declared length and as a stream with no length: 2048 bytes is the limit.
    const sized = (n: number) => {
      const head = "theme=dark&next=%2F&pad=";
      return head + "x".repeat(n - head.length);
    };
    const streamOf = (text: string) => {
      const bytes = new TextEncoder().encode(text);
      return new ReadableStream<Uint8Array>({
        start(ctl) {
          for (let i = 0; i < bytes.length; i += 500) ctl.enqueue(bytes.subarray(i, i + 500));
          ctl.close();
        },
      });
    };
    const post = (body: BodyInit, extra: Record<string, string> = {}) =>
      dw.call("/__dropway/theme", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, ...extra }, duplex: "half" } as RequestInit);
    for (const [n, ok] of [[2047, true], [THEME_BODY_MAX, true], [THEME_BODY_MAX + 1, false]] as const) {
      expect(sized(n).length).toBe(n);
      for (const body of [sized(n), streamOf(sized(n))]) {
        const res = await post(body);
        expect(res.status, `${n} bytes, ${typeof body === "string" ? "declared" : "streamed"}`).toBe(ok ? 303 : 413);
        expect(res.headers.get("set-cookie")).toBe(ok ? `${THEME_COOKIE}=dark; Path=/; Secure; SameSite=Lax; Max-Age=31536000` : null);
      }
    }
    // An oversized Content-Length is refused before a single byte is read.
    let pulls = 0;
    const untouched = new ReadableStream<Uint8Array>({ pull(ctl) { pulls++; ctl.enqueue(new TextEncoder().encode("theme=dark")); ctl.close(); } }, { highWaterMark: 0 });
    const early = await post(untouched, { "Content-Length": String(THEME_BODY_MAX + 1) });
    expect(early.status).toBe(413);
    expect(pulls).toBe(0);
    // Multipart is not what the switch sends: nothing is set.
    const fd = new FormData();
    fd.append("theme", "dark");
    const multipart = await dw.call("/__dropway/theme", { method: "POST", body: fd, headers: { Origin: ORIGIN } });
    expect(multipart.status).toBe(303);
    expect(multipart.headers.get("location")).toBe("/");
    expect(multipart.headers.get("set-cookie")).toBeNull();
  });
});

describe("server-rendered colour mode (no flash, no script)", () => {
  it("Auto: no data-theme, both metas; the cookie writes data-theme and only-<mode> metas into the first byte", async () => {
    const dw = await freshInstance();
    const auto = await dw.call("/login");
    expect(auto.headers.get("vary")).toContain("Cookie");
    const a = await auto.text();
    expect(htmlTag(a)).toBe('<html lang="en">');
    expect(a).toContain('<meta name="color-scheme" content="light dark">');
    expect(a).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${THEME_COLORS.light}">`);
    expect(a).toContain(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${THEME_COLORS.dark}">`);
    // The pressed switch button is the current mode.
    expect(a).toMatch(/<button type="submit" name="theme" value="auto" aria-pressed="true"/);

    const dark = await (await dw.call("/login", { headers: { Cookie: `other=1; ${THEME_COOKIE}=dark` } })).text();
    expect(htmlTag(dark)).toBe('<html lang="en" data-theme="dark">');
    expect(dark).toContain('<meta name="color-scheme" content="only dark">');
    expect(dark).toContain(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${THEME_COLORS.dark}">`);
    expect(dark).toMatch(/value="dark" aria-pressed="true"/);
    // ?theme= wins for this response only.
    const light = await (await dw.call("/login?theme=light", { headers: { Cookie: `${THEME_COOKIE}=dark` } })).text();
    expect(htmlTag(light)).toBe('<html lang="en" data-theme="light">');
    // A junk cookie value is Auto.
    expect(htmlTag(await (await dw.call("/login", { headers: { Cookie: `${THEME_COOKIE}=sepia` } })).text())).toBe('<html lang="en">');
  });

  it("the switch is a no-script form on every app page, posting back to the current path without ?theme", async () => {
    const dw = await freshInstance();
    const html = await (await dw.call("/dashboard/keys?x=1&theme=dark")).text();
    expect(html).toContain('<form class="k-mode-switch" id="dw-mode" method="post" action="/__dropway/theme"><input type="hidden" name="next" value="/dashboard/keys?x=1">');
    expect(html).toContain('<div role="group" aria-label="Colour theme">');
    for (const v of ["auto", "light", "dark"]) expect(html).toContain(`name="theme" value="${v}"`);
  });

  it("site origins never read the app cookie: Auto in CSS, ?theme= for Kofra-generated pages", async () => {
    const dw = await freshInstance();
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "<p>hi</p>", "notes.md": "# Notes" }) });
    const url = new URL(pub.body.url as string);
    const missing = `${url.pathname}missing.html`;
    const withCookie = await (await dw.call(missing, { headers: { Cookie: `${THEME_COOKIE}=dark`, Accept: "text/html" } })).text();
    expect(htmlTag(withCookie)).toBe('<html lang="en">');
    const linked = await (await dw.call(`${missing}?theme=dark`, { headers: { Accept: "text/html" } })).text();
    expect(htmlTag(linked)).toBe('<html lang="en" data-theme="dark">');
    // Viewer pages: ?theme= changes the body, so the ETag differs.
    const md = await dw.call(`${url.pathname}notes.md?view=1`);
    const mdDark = await dw.call(`${url.pathname}notes.md?view=1&theme=dark`);
    expect(htmlTag(await mdDark.text())).toBe('<html lang="en" data-theme="dark">');
    expect(md.headers.get("etag")).not.toBe(mdDark.headers.get("etag"));
    expect(mdDark.headers.get("etag")).toContain("-td");
    // The user's own HTML is served untouched.
    expect(await (await dw.call(`${url.pathname}index.html?theme=dark`)).text()).toContain("<p>hi</p>");
  });

  it("the app viewer opens folders and the site's own pages through __dropway/open: ?theme= reaches Kofra pages only", async () => {
    const dw = await freshInstance();
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "<p>hi</p>", "docs/a.txt": "a", "docs/b.md": "# B" }) });
    const slug = pub.body.slug as string;
    const base = new URL(pub.body.url as string).pathname;
    const open = (next: string, theme = "dark") => dw.call(`${base}__dropway/open?next=${encodeURIComponent(next)}&theme=${theme}`, { headers: { "Sec-Fetch-Dest": "iframe" } });
    const location = async (next: string, theme?: string) => {
      const res = await open(next, theme);
      expect(res.status).toBe(303);
      expect(res.headers.get("cache-control")).toBe("no-store");
      return res.headers.get("location");
    };
    expect(await location(`${base}docs/`)).toBe(`${base}docs/?theme=dark`); // a listing
    expect(await location(base)).toBe(base); // the site's own index.html
    expect(await location(`${base}docs/a.txt?raw=1`)).toBe(`${base}docs/a.txt?raw=1`); // raw bytes
    expect(await location(`${base}docs/b.md?view=1&embed=1`)).toBe(`${base}docs/b.md?view=1&embed=1&theme=dark`); // a viewer
    expect(await location(`${base}nope.html`)).toBe(`${base}nope.html?theme=dark`); // Kofra's page-not-found
    expect(await location(`${base}docs/`, "auto")).toBe(`${base}docs/`);
    // A mode written into `next` never reaches the site's own page.
    expect(await location(`${base}?theme=dark`)).toBe(base);
    // Only paths on this site.
    for (const bad of ["//evil.test/", "https://evil.test/", "/elsewhere/", `${base}\\evil`, `${base}../other-site/`, `${base}..//evil.test/`]) expect(await location(bad)).toBe(base);

    // The viewer page frames a folder through it, with the embed (the listing draws no header or footer of its
    // own inside the app) and, in an explicit mode, the mode. A raw file goes direct in Auto.
    const frameSrc = async (path: string, cookie?: string) => /<iframe id="dw-frame"[^>]* src="([^"]+)"/.exec(await (await dw.call(path, { headers: cookie ? { Cookie: cookie } : {} })).text())![1]!.replaceAll("&amp;", "&");
    expect(await frameSrc(`/v/${slug}/docs/`, `${THEME_COOKIE}=light`)).toBe(`${ORIGIN}${base}__dropway/open?next=${encodeURIComponent(`${base}docs/`)}&embed=1&theme=light`);
    expect(await frameSrc(`/v/${slug}/docs/`)).toBe(`${ORIGIN}${base}__dropway/open?next=${encodeURIComponent(`${base}docs/`)}&embed=1`);
    expect(await frameSrc(`/v/${slug}/docs/a.txt?mode=raw`)).toBe(`${ORIGIN}${base}docs/a.txt?raw=1`);

    // A locked site: the gate is drawn in the mode and returns to __dropway/open once unlocked.
    await dw.json(`/api/v1/sites/${slug}`, { method: "PATCH", key: dw.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "correct horse" }) });
    const gate = await open(base, "light");
    expect(gate.status).toBe(401);
    const html = await gate.text();
    expect(htmlTag(html)).toBe('<html lang="en" data-theme="light">');
    expect(html).toContain(`name="next" value="${base}__dropway/open?next=`);
  });
});

describe.each(["path", "subdomain"] as const)("frame redirect URL normalization (%s mode)", (sitesMode) => {
  const fixture = async () => {
    const dw = await freshInstance({ sitesMode, sitesDomain: "sites.test" });
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "<p>hi</p>", "docs/a.txt": "a", "docs/b.md": "# B" }) });
    expect(pub.status).toBe(201);
    const site = new URL(pub.body.url as string);
    const base = site.pathname;
    expect(base).toBe(sitesMode === "path" ? `/s/${pub.body.slug}/` : "/");
    const open = async (next: string, theme = "dark") => {
      const res = await dw.call(`${site.origin}${base}__dropway/open?${new URLSearchParams({ next, theme })}`, { headers: { "Sec-Fetch-Dest": "iframe" } });
      expect(res.status).toBe(303);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const location = res.headers.get("location")!;
      expect(new URL(location, site).origin).toBe(site.origin);
      return location;
    };
    return { base, open };
  };

  const escapes = sitesMode === "path"
    ? ["../other/", "../..//evil.test/", "%2e%2e/other/", "%2E%2E/%2e%2e//evil.test/", ".%2e/other/"]
    : ["..//evil.test/", "docs/../..//evil.test/", "%2e%2e//evil.test/", "docs/%2E%2E/.%2e//evil.test/"];
  it.each(escapes)("falls back to the site root after normalizing %s", async (suffix) => {
    const { base, open } = await fixture();
    // `next` is query-encoded, so normalization happens inside the route, not before dispatch.
    expect(await open(`${base}${suffix}?keep=1&theme=light`)).toBe(base);
  });

  it.each([
    ["docs/../docs/?tag=a&tag=b&x=%2B&theme=light", "docs/?tag=a&tag=b&x=%2B&theme=dark"],
    ["docs/%2e%2e/docs/b.md?view=1&embed=1&keep=1", "docs/b.md?view=1&embed=1&keep=1&theme=dark"],
    ["docs/../index.html?keep=1&theme=light", "index.html?keep=1"],
    ["docs/./a.txt?raw=1&keep=1&theme=light", "docs/a.txt?raw=1&keep=1"],
    ["docs/../docs/b.md?download=1&keep=1&theme=light", "docs/b.md?download=1&keep=1"],
  ])("keeps a normalized in-base target and its query: %s", async (suffix, expected) => {
    const { base, open } = await fixture();
    expect(await open(`${base}${suffix}`)).toBe(`${base}${expected}`);
  });

  it("Auto removes an incoming theme without adding one to the normalized listing", async () => {
    const { base, open } = await fixture();
    expect(await open(`${base}docs/../docs/?keep=1&theme=light`, "auto")).toBe(`${base}docs/?keep=1`);
  });
});

describe("CSP: no inline script, no external font origin", () => {
  it("no-script app pages: APP_PAGE_CSP exactly, no script-src, no <script> at all, fonts and CSS from 'self'", async () => {
    expect(APP_PAGE_CSP).toBe("default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const dw = await freshInstance();
    for (const path of ["/claim?slug=abc", "/nope"]) {
      const res = await dw.call(path, { headers: { Accept: "text/html" } });
      expect(res.headers.get("content-security-policy"), path).toBe(APP_PAGE_CSP);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      const html = await res.text();
      expect(html, path).not.toContain("<script");
      expect(html, path).toContain(`<link rel="stylesheet" href="/__dropway/ui/kofra-${APP_CSS_HASH}.css">`);
      expect(html, path).not.toMatch(/fonts\.(googleapis|gstatic)\.com|https?:\/\/[^"']*\.woff2/);
    }
    // The 404 stays CORS-readable for sandboxed sites.
    expect((await dw.call("/nope")).headers.get("access-control-allow-origin")).toBe("*");
  });

  it("dashboard pages: one first-party script, no inline script; fonts preloaded from this origin", async () => {
    const dw = await freshInstance();
    const res = await dw.call("/dashboard");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("font-src 'self' data:");
    const html = await res.text();
    expect(html.match(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>/g)).toBeNull();
    for (const f of Object.values(FONT_FILES).filter((f) => f.name === "public-sans-latin-normal" || f.name === "newsreader-latin-normal")) {
      expect(html).toContain(`<link rel="preload" href="/__dropway/fonts/${f.name}.${f.hash}.woff2" as="font" type="font/woff2" crossorigin>`);
    }
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it("site system pages and listings load fonts only from the app origin", async () => {
    const dw = await freshInstance();
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "a/one.txt": "1", "b.txt": "2" }) });
    const base = new URL(pub.body.url as string).pathname;
    const sys = await dw.call(`${base}missing.html`, { headers: { Accept: "text/html" } });
    expect(sys.status).toBe(404);
    expect(sys.headers.get("content-security-policy")).toMatch(/^default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; font-src https:\/\/dropway\.test; img-src data:/);
    const page = await sys.text();
    expect(page).not.toContain("<script");
    expect(page).toContain(`src:url(${ORIGIN}/__dropway/fonts/`);
    const listing = await dw.call(base, { headers: { Accept: "text/html" } });
    expect(listing.headers.get("x-kofra-viewer")).toBe("listing");
    expect(listing.headers.get("content-security-policy")).toContain(`font-src ${ORIGIN};`);
    expect(await listing.text()).not.toContain("<script");
  });
});

describe("user content cannot wear Kofra's chrome", () => {
  it("the sanitizer drops k- and dw- classes and ids, keeping the rest", async () => {
    expect(await sanitizeHtml('<p class="k-banner k-ok note">x</p>')).toBe('<p class="note">x</p>');
    expect(await sanitizeHtml('<div id="dw-main" class="k-btn">y</div>')).toBe("<div>y</div>");
    expect(await sanitizeHtml('<h2 id="setup" class="intro">z</h2>')).toBe('<h2 id="setup" class="intro">z</h2>');
  });
  it("character references cannot spell a reserved name (decimal, hex, no semicolon, encoded separators)", async () => {
    expect(await sanitizeHtml('<div class="k&#45;banner k&#45;ok" id="d&#119;-main">Forged</div>')).toBe("<div>Forged</div>");
    expect(await sanitizeHtml('<div class="&#x6b;-btn note" id="&#100;&#119;&#45;boot">x</div>')).toBe('<div class="note">x</div>');
    expect(await sanitizeHtml('<p class="k&#45banner">x</p>')).toBe("<p>x</p>");
    expect(await sanitizeHtml('<p class="note&#9;k-ok&NewLine;dw-x lead">x</p>')).toBe('<p class="note lead">x</p>');
    expect(await sanitizeHtml('<p id=" &#9;k-top">x</p>')).toBe("<p>x</p>");
    // Lookalikes that browsers do not turn into a hyphen-minus stay.
    expect(await sanitizeHtml('<p class="k&dash;x">x</p>')).toBe('<p class="k&dash;x">x</p>');
  });
  it("code blocks (which scroll sideways on phones) are reachable by keyboard; other tabindex values are dropped", async () => {
    expect(await sanitizeHtml('<pre tabindex="-1"><code>x</code></pre><p tabindex="3">y</p>')).toBe('<pre tabindex="0"><code>x</code></pre><p>y</p>');
  });
  it("Markdown headings named like a reserved prefix keep a working id and # link after sanitizing", async () => {
    const { html } = renderMarkdown("## K setup\n\n## DW guide\n\n## Setup\n\n## K setup\n", "README.md");
    const clean = await sanitizeHtml(html);
    for (const id of ["h-k-setup", "h-dw-guide", "setup", "h-k-setup-1"]) {
      expect(clean).toContain(`id="${id}"`);
      expect(clean).toContain(`href="#${id}"`);
    }
    expect(clean).not.toMatch(/id="(k|dw)-/);
  });
});

describe("error pages", () => {
  it("app 500: an HTML page for navigations (no script, APP_PAGE_CSP, request id), text for everything else", async () => {
    const dw = await freshInstance({}, { routes: [({ app }) => void app.get("/boom", () => { throw new Error("kaboom"); })] });
    const page = await dw.call("/boom", { headers: { Accept: "text/html", "cf-ray": "ray-123" } });
    expect(page.status).toBe(500);
    expect(page.headers.get("content-security-policy")).toBe(APP_PAGE_CSP);
    const html = await page.text();
    expect(html).toContain("Something went wrong on our side");
    expect(html).toContain('<span class="k-mono">ray-123</span>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("kaboom");
    const api = await dw.call("/boom");
    expect(api.status).toBe(500);
    expect(await api.text()).toBe("Internal error");
  });
});

describe("design assets", () => {
  it("the app stylesheet, fonts, licences and plate art are served with the right headers", async () => {
    const dw = await freshInstance();
    const css = await dw.call(`/__dropway/ui/kofra-${APP_CSS_HASH}.css`);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const body = await css.text();
    expect(body).toContain(".k-btn{");
    expect(body).toContain('[data-theme="dark"]{color-scheme:only dark;');
    expect((await dw.call("/__dropway/ui/kofra-00000000.css")).headers.get("cache-control")).toBe("no-cache");

    const f = FONT_FILES["public-sans-latin-normal"]!;
    const font = await dw.call(`/__dropway/fonts/${f.name}.${f.hash}.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(font.headers.get("access-control-allow-origin")).toBe("*");
    expect(font.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(font.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await font.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("wOF2");
    const again = await dw.call(`/__dropway/fonts/${f.name}.00000000.woff2`);
    expect(again.headers.get("cache-control")).toBe("no-cache");
    // The cached bytes serve every response in full.
    expect(new Uint8Array(await again.arrayBuffer()).byteLength).toBe(bytes.byteLength);
    expect((await dw.call("/__dropway/fonts/nope.00000000.woff2")).status).toBe(404);
    // Names are looked up as own keys only.
    expect((await dw.call("/__dropway/fonts/constructor.00000000.woff2")).status).toBe(404);
    expect((await dw.call("/__dropway/ui/art/constructor.00000000.svg")).status).toBe(404);
    const ofl = await dw.call("/__dropway/fonts/OFL.txt");
    expect(ofl.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const licences = await ofl.text();
    for (const family of ["Public Sans", "Newsreader", "Martian Mono"]) expect(licences).toContain(family);
    expect(licences).toContain("SIL Open Font License, Version 1.1");

    const artUrl = /url\((\/__dropway\/ui\/art\/plate-home-light\.[0-9a-f]{8}\.svg)\)/.exec(body)![1]!;
    const art = await dw.call(artUrl);
    expect(art.headers.get("content-type")).toBe("image/svg+xml");
    expect(art.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await art.text()).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 600 400"/);
  });
});

describe("file deliveries", () => {
  it("a locked file on the sites origin is a site page: inline CSS, fonts from the app, no app-only assets or mode switch", async () => {
    const { create, instance, PASSWORD, siteFile } = await import("./transfer-fixtures");
    const dw = await instance();
    const t = await create(dw, { password: PASSWORD });
    for (const query of ["", "?theme=dark"]) {
      const res = await dw.call(siteFile(t) + query, { headers: { Accept: "text/html", "Sec-Fetch-Dest": "document" } });
      expect(res.status).toBe(403);
      expect(res.headers.get("content-security-policy")).toBe(`default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; font-src ${ORIGIN}; img-src data:; frame-ancestors 'none'`);
      const html = await res.text();
      expect(htmlTag(html)).toBe(query ? '<html lang="en" data-theme="dark">' : '<html lang="en">');
      expect(html).not.toContain("/__dropway/ui/");
      expect(html).not.toMatch(/<form[^>]*k-mode-switch/);
      expect(html).not.toContain("/__dropway/theme");
      expect(html).not.toContain("<script");
      expect(html).toContain(`href="${t.url}"`);
      // Every asset the page loads exists where it points.
      const assets = [...html.matchAll(/url\(([^)]+)\)|<link[^>]+href="([^"]+)"/g)].map((m) => (m[1] ?? m[2])!.replace(/^["']|["']$/g, "")).filter((u) => !u.startsWith("data:"));
      expect(assets.length).toBeGreaterThan(0);
      for (const url of new Set(assets)) {
        const abs = new URL(url, siteFile(t)).href;
        expect(abs.startsWith(`${ORIGIN}/__dropway/fonts/`), abs).toBe(true);
        expect((await dw.call(abs)).status, abs).toBe(200);
      }
    }
  });
});
