/**
 * Acceptance (TWO-1123): every viewer page type renders a skip link as its
 * first focusable element, landing on the content landmark — the app shell's
 * pattern — and the accent pairs used for text and primary buttons meet
 * WCAG AA (≥4.5:1) in both colour schemes.
 *
 * The skip link and landmark live in the shared viewer frame
 * (viewerPage() in chrome.ts, plus the directory listing), so one page per
 * viewer type exercises the contract for all of them.
 */
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { viewerPage, type Viewer } from "@dropway/server";
import { clearRenderMemoryCache } from "../packages/server/src/viewers/cache";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const SKIP = '<a class="dw-skip" href="#dw-content">Skip to content</a>';

// Markers that can take keyboard focus in a viewer page body (styles live in
// <head>, so everything matched here is real tab order).
const FOCUSABLE = ["<a ", "<button", "<input", "<select", "<textarea", "<summary", "<iframe", "<object", "<audio", "<video", "<embed"];

function srgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = srgb(hex).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** color-mix(in srgb, accent p, base) composited over an opaque base. */
function tint(accent: string, base: string, p: number): string {
  const a = srgb(accent);
  const b = srgb(base);
  return `#${a.map((v, i) => Math.round((v * p + b[i]! * (1 - p)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** CSS filter brightness(f): per-channel multiply, clamped to the gamut. */
function brightness(hex: string, f: number): string {
  return `#${srgb(hex).map((v) => Math.round(Math.min(1, v * f) * 255).toString(16).padStart(2, "0")).join("")}`;
}

describe("viewer skip link and accent contrast (TWO-1123)", () => {
  let dw: Instance;
  let slug: string;
  // PNG header stub with a 64x32 IHDR, as in the toggle-focus suite; the
  // media viewer only reads the header here.
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32, 8, 2, 0, 0, 0, 1, 2, 3]);

  const pages: Array<[string, string, string]> = [
    ["code", "src/app.ts", "code"],
    ["markdown", "doc/notes.md", "markdown"],
    ["json", "data/config.json", "json"],
    ["csv", "data/table.csv", "csv"],
    ["image", "img/logo.png", "image"],
    ["notebook", "book/notes.ipynb", "notebook"],
    ["binary", "files/blob.bin?view=1", "binary"],
    ["archive", "archives/bundle.zip", "archive"],
    ["html frame", "page.html?view=1", "html-frame"],
    ["image embed (no bar)", "img/logo.png?view=1&embed=1", "image"],
    ["listing", "sub/", "listing"],
  ];

  // Extension viewer for the owned-id test: its body carries its own main
  // landmark, so the shared frame must keep that id (not mint a duplicate)
  // and land the skip link on it. Registered on the shared instance so no
  // extra freshInstance() (which resets fixture storage) is needed mid-file.
  const customMainViewer: Viewer = {
    id: "custom-main", version: 1, maxBytes: 1024,
    matches: (file) => file.path === "custom.txt",
    async render(vc) {
      return viewerPage(vc, {
        tabs: [{ label: "Rendered", href: vc.fileUrl, current: true }],
        body: `<main id="results"><a href="#results">Back to results</a><p>hi</p></main>`,
      });
    },
  };

  // Extension viewers for the data-id test: `data-id` must not be mistaken
  // for the landmark id, whether or not a real id is present.
  const customDataIdViewer: Viewer = {
    id: "custom-data-id", version: 1, maxBytes: 1024,
    matches: (file) => file.path === "custom-data.txt",
    async render(vc) {
      return viewerPage(vc, {
        tabs: [{ label: "Rendered", href: vc.fileUrl, current: true }],
        body: `<main data-id="report"><h1>Report</h1></main>`,
      });
    },
  };
  const customOwnedViewer: Viewer = {
    id: "custom-owned", version: 1, maxBytes: 1024,
    matches: (file) => file.path === "custom-owned.txt",
    async render(vc) {
      return viewerPage(vc, {
        tabs: [{ label: "Rendered", href: vc.fileUrl, current: true }],
        body: `<main data-id="report" id="owned"><h1>Report</h1></main>`,
      });
    },
  };

  // Fixture with an authored landmark; shared with the stale-fragment test so
  // the seeded poison key matches the served bytes exactly.
  const EVIL_MD = "# Authored\n\n<main id=\"authored\"><p>authored landmark</p></main>\n";

  let setup: Promise<void> | null = null;
  async function ready(): Promise<void> {
    if (!setup) {
      setup = (async () => {
        dw = await freshInstance({}, { viewers: [customMainViewer, customDataIdViewer, customOwnedViewer] });
        const res = await dw.json("/api/v1/publish", {
          method: "POST",
          key: dw.ownerKey,
          body: form(
            {
              "custom.txt": "hello",
              "custom-data.txt": "hello",
              "custom-owned.txt": "hello",
              "src/app.ts": "// skip-link fixture\nexport const answer: number = 42;\n",
              "doc/notes.md": "# Notes\n\nA paragraph with a [link](https://example.test).\n",
              "data/config.json": '{"name":"skip","list":[1,2,3]}',
              "data/table.csv": "name,qty\napples,3\npears,7\n",
              "img/logo.png": PNG,
              "book/notes.ipynb": JSON.stringify({ cells: [{ cell_type: "markdown", metadata: {}, source: ["# Hi"] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
              "files/blob.bin": new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
              "archives/bundle.zip": zipSync({ "hello.txt": strToU8("hello\n") }),
              "page.html": "<!doctype html><title>Hi</title><p>Hello</p>",
              "evil/main.md": EVIL_MD,
              "sub/nested.txt": "nested\n",
            },
            { slug: "skip-link" },
          ),
        });
        expect(res.status).toBe(201);
        slug = res.body.slug;
      })();
    }
    await setup;
  }

  it.each(pages)("%s page: skip link is first, targets one content landmark", async (_label, path, viewer) => {
    await ready();
    const res = await dw.call(`/s/${slug}/${path}`, { headers: NAV });
    expect(res.status, path).toBe(200);
    expect(res.headers.get("x-kofra-viewer"), `${path}: viewer`).toBe(viewer);
    const html = await res.text();
    const body = html.slice(html.indexOf("<body>"));
    // The skip link renders and reveals on keyboard focus.
    expect(body, `${path}: skip link`).toContain(SKIP);
    expect(html, `${path}: skip reveal rule`).toContain(".dw-skip:focus");
    // It is the first focusable element: DOM order is tab order here (no
    // positive tabindex anywhere on viewer pages).
    const skipAt = body.indexOf(SKIP);
    const firstFocusable = Math.min(...FOCUSABLE.map((m) => body.indexOf(m)).filter((i) => i >= 0));
    expect(firstFocusable, `${path}: skip link is the first tab stop`).toBe(skipAt);
    // Exactly one content landmark, and the skip link lands on it; the
    // landmark is focusable so keyboard focus follows the skip link.
    expect(body.match(/<main[\s>]/g)?.length ?? 0, `${path}: exactly one <main>`).toBe(1);
    expect(body, `${path}: landmark id`).toMatch(/<main\b[^>]*\bid="dw-content"/);
    expect(body, `${path}: landmark focusable`).toMatch(/<main\b[^>]*\btabindex="-1"/);
  });

  it("accent pairs meet WCAG AA in both schemes", async () => {
    await ready();
    const res = await dw.call(`/s/${slug}/src/app.ts`, { headers: NAV });
    const css = [...(await res.text()).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!).join("\n");
    // The shipped values, read from the real bytes so a silent revert fails.
    expect(css, "light accent").toContain("--accent:#c7430c");
    const dark = /prefers-color-scheme:dark\)\{\:root\{[^}]*--accent:(#[0-9a-f]{6})/.exec(css)?.[1];
    expect(dark, "dark accent").toBe("#ff8a4c");
    const light = "#c7430c";
    const pairs: Array<[string, string, string]> = [
      // Defect 1: dark primary button / skip link (white text failed at 2.34:1).
      ["#141312", "#ff8a4c", "dark primary-button / skip-link text on accent"],
      // Defect 2: light accent as text (failed at 4.12:1 on the page background).
      [light, "#fbfaf8", "light accent text on page background"],
      [light, "#ffffff", "light accent text on card"],
      ["#ffffff", light, "light primary-button / skip-link text on accent"],
      // Unchanged dark accent as text must keep passing.
      ["#ff8a4c", "#141312", "dark accent text on page background"],
      ["#ff8a4c", "#1b1a18", "dark accent text on card"],
      // Tinted-current states: accent text on the 6% accent wash over card.
      [light, tint(light, "#ffffff", 0.06), "light accent text on current-file wash"],
      ["#ff8a4c", tint("#ff8a4c", "#1b1a18", 0.06), "dark accent text on current-file wash"],
    ];
    // Primary-button hover keeps a darkening filter, so the hovered pair
    // must pass too. The shipped factor is read from the app shell bytes
    // (viewer pages carry no .dw-btn.primary rule), so a lightening revert
    // fails here.
    const shell = await (await dw.call("/login", { headers: NAV })).text();
    const factor = Number(/\.dw-btn\.primary:hover\{[^}]*filter:brightness\(([\d.]+)\)/.exec(shell)?.[1]);
    expect(factor, "hover brightness factor ships").toBeGreaterThan(0);
    pairs.push(
      ["#ffffff", brightness(light, factor), "light primary-button text on hover"],
      ["#141312", brightness("#ff8a4c", factor), "dark primary-button text on hover"],
    );
    for (const [fg, bg, label] of pairs) {
      expect(contrast(fg, bg), `${label} (${fg} on ${bg})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("extension-owned main id is kept and becomes the skip target", async () => {
    await ready();
    const res = await dw.call(`/s/${slug}/custom.txt?view=1`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("custom-main");
    const html = await res.text();
    const body = html.slice(html.indexOf("<body>"));
    // No duplicate id: the extension's landmark keeps its own, the skip link
    // lands on it, and it is focusable so keyboard focus follows the link.
    expect(body).toContain('<a class="dw-skip" href="#results">Skip to content</a>');
    expect(body.match(/id="results"/g)?.length).toBe(1);
    expect(body).not.toContain("dw-content");
    const mainTag = /<main\b[^>]*>/.exec(body)?.[0] ?? "";
    expect(mainTag, "landmark keeps its id").toContain('id="results"');
    expect(mainTag, "landmark focusable").toContain('tabindex="-1"');
    // The skip link is still the first tab stop.
    const skipAt = body.indexOf('<a class="dw-skip"');
    const firstFocusable = Math.min(...FOCUSABLE.map((m) => body.indexOf(m)).filter((i) => i >= 0));
    expect(firstFocusable, "skip link is the first tab stop").toBe(skipAt);
  });

  it("data-id is not mistaken for the landmark id", async () => {
    await ready();
    // data-id with no id: the skip link lands on the minted landmark, not a
    // nonexistent #report.
    const res = await dw.call(`/s/${slug}/custom-data.txt?view=1`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("custom-data-id");
    const html = await res.text();
    const body = html.slice(html.indexOf("<body>"));
    expect(body).toContain('<a class="dw-skip" href="#dw-content">Skip to content</a>');
    expect(body.match(/<main(?=[\s>])/g)?.length ?? 0, "exactly one <main>").toBe(1);
    expect(body, "landmark id").toMatch(/<main\b[^>]*\bid="dw-content"/);
    // ... while a real id next to data-id still wins as the skip target.
    const owned = await (await dw.call(`/s/${slug}/custom-owned.txt?view=1`, { headers: NAV })).text();
    const ownedBody = owned.slice(owned.indexOf("<body>"));
    expect(ownedBody).toContain('<a class="dw-skip" href="#owned">Skip to content</a>');
    expect(ownedBody.match(/id="owned"/g)?.length, "no duplicate id").toBe(1);
    expect(ownedBody).not.toContain("dw-content");
  });

  it("ignores pre-demotion cached fragments so the page keeps one landmark", async () => {
    await ready();
    // Seed the retired render key with a fragment that still holds the
    // authored landmark, as an edge cache left over from before deployment
    // would. The bumped markdown version must not read it.
    clearRenderMemoryCache();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(EVIL_MD));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await caches.default.put(
      new Request(`${ORIGIN}/__dropway/render/markdown@5/${hash}`),
      new Response("<h1>Authored</h1><main id=\"authored\"><p>authored landmark</p></main>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    const res = await dw.call(`/s/${slug}/evil/main.md`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-render-cache"), "stale fragment must not serve").toBe("miss");
    const html = await res.text();
    const body = html.slice(html.indexOf("<body>"));
    expect(body.match(/<main(?=[\s>])/g)?.length ?? 0, "exactly one <main>").toBe(1);
    expect(body, "authored landmark demoted, content kept").toContain('<div id="authored">');
    expect(body, "landmark id").toMatch(/<main\b[^>]*\bid="dw-content"/);
  });

  it("html frame keeps full-height layout inside the landmark", async () => {
    await ready();
    const res = await dw.call(`/s/${slug}/page.html?view=1`, { headers: NAV });
    expect(res.status).toBe(200);
    const html = await res.text();
    const body = html.slice(html.indexOf("<body>"));
    // The frame wraps in the landmark (the skip target) instead of sitting
    // bare in the flex body, and the wrap grows the way the frame used to.
    expect(body).toMatch(/<main\b[^>]*\bid="dw-content"[^>]*\bclass="dw-frame-wrap"/);
    const frameAt = body.indexOf('class="dw-frame"');
    expect(frameAt, "frame inside the landmark").toBeGreaterThan(body.indexOf("<main"));
    expect(body.indexOf("</main>"), "landmark closes after the frame").toBeGreaterThan(frameAt);
    expect(html, "wrap grows in the flex column").toContain(".dw-frame-wrap{display:flex;flex-direction:column;flex:1");
  });

  it("authored main landmarks are demoted so the page keeps one landmark", async () => {
    await ready();
    const res = await dw.call(`/s/${slug}/evil/main.md`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("markdown");
    const html = await res.text();
    const body = html.slice(html.indexOf("<body>"));
    expect(body.match(/<main(?=[\s>])/g)?.length ?? 0, "exactly one <main>").toBe(1);
    expect(body, "authored landmark demoted, content kept").toContain('<div id="authored">');
    expect(body, "authored content kept").toContain("authored landmark");
    expect(body, "landmark id").toMatch(/<main\b[^>]*\bid="dw-content"/);
    expect(body, "landmark focusable").toMatch(/<main\b[^>]*\btabindex="-1"/);
  });

  it("app shell keeps a dark-scheme primary-button and skip-link fix", async () => {
    await ready();
    const res = await dw.call("/login", { headers: NAV });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html, "app shell skip link").toContain('<a class="dw-skip" href="#dw-main">Skip to content</a>');
    expect(html, "dark primary-button / skip-link text override").toContain(
      "@media (prefers-color-scheme:dark){.dw-btn.primary{color:#141312}",
    );
  });
});
