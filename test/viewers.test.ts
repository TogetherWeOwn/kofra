import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { detectFileKind, languageFor, contentTypeFor, sha256Hex, type LiveSite } from "@dropway/core";
import { findViewer, toViewerFile, VIEWERS, type ServerBindings, type ViewMode } from "@dropway/server";
import { sanitizeHtml, isSafeUrl } from "../packages/server/src/viewers/sanitize";
import { splitHighlightedLines, highlight } from "../packages/server/src/viewers/highlight";
import { imageSize } from "../packages/server/src/viewers/media";
import { parseCsv, detectDelimiter } from "../packages/server/src/viewers/csv";
import { cachedRender, clearRenderMemoryCache } from "../packages/server/src/viewers/cache";
import { notebookViewer, renderNotebook } from "../packages/server/src/viewers/notebook";
import { looksLikeText } from "../packages/server/src/viewers/binary";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

// The viewer bar has its own Phone <details>. Fold assertions read only
// content after the bar's header, never a <main> close tag: hostile output
// fixtures deliberately contain their own </main>.
function pageContent(html: string): string {
  const end = html.indexOf("</header>");
  return end < 0 ? html : html.slice(end + "</header>".length);
}

const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const IFRAME = { Accept: "text/html,*/*", "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate" };

describe("file type detection", () => {
  const cases: Array<[string, string | null, string]> = [
    ["index.html", null, "html"],
    ["page.htm", null, "html"],
    ["README.md", null, "markdown"],
    ["notes.markdown", null, "markdown"],
    ["logo.png", null, "image"],
    ["photo.JPG", null, "image"],
    ["icon.svg", null, "svg"],
    ["report.pdf", null, "pdf"],
    ["clip.mp4", null, "video"],
    ["clip.webm", null, "video"],
    ["song.mp3", null, "audio"],
    ["data.json", null, "json"],
    ["map.geojson", null, "json"],
    ["site.webmanifest", null, "json"],
    ["table.csv", null, "csv"],
    ["table.tsv", null, "csv"],
    ["app.ts", null, "code"],
    ["app.tsx", null, "code"],
    ["main.py", null, "code"],
    ["main.rs", null, "code"],
    ["config.yaml", null, "code"],
    ["config.toml", null, "code"],
    ["events.jsonl", null, "code"],
    ["fix.diff", null, "code"],
    ["Dockerfile", null, "code"],
    ["Makefile", null, "code"],
    [".gitignore", null, "code"],
    ["notes.txt", null, "text"],
    ["server.log", null, "text"],
    ["LICENSE", null, "text"],
    ["analysis.ipynb", null, "notebook"],
    ["font.woff2", null, "font"],
    ["model.glb", null, "model3d"],
    ["bundle.zip", null, "archive"],
    ["app.wasm", null, "wasm"],
    ["blob.bin", null, "binary"],
    ["unknown", null, "binary"],
    // Browsers declare .ts files as MPEG transport streams; the extension wins.
    ["app.ts", "video/mp2t", "code"],
    ["data.out", "application/json", "json"],
    ["page", "text/html; charset=utf-8", "html"],
  ];
  it.each(cases)("%s (%s) -> %s", (path, declared, kind) => {
    expect(detectFileKind(path, declared ?? contentTypeFor(path))).toBe(kind);
  });

  it("maps paths to highlighting languages", () => {
    expect(languageFor("src/app.mjs")).toBe("javascript");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("deploy/Dockerfile.prod")).toBe("dockerfile");
    expect(languageFor(".env.local")).toBe("bash");
    expect(languageFor("infra/main.tf")).toBe("hcl");
    expect(languageFor("notes.txt")).toBeNull();
  });
});

const live = (renderMarkdown = true): LiveSite => ({
  v: 2,
  siteId: "site_1",
  slug: "s",
  tenantId: "t",
  versionId: "v",
  spa: false,
  renderMarkdown,
  crossOriginIsolation: false,
  passwordHash: null,
  expiresAt: null,
  files: {},
});

describe("viewer versions", () => {
  // The version is part of the ETag and the render cache key: a changed render
  // without a bump serves stale cached pages, so every bump is pinned here.
  it("pins every registered viewer to its current render version", () => {
    expect(VIEWERS).toHaveLength(15);
    expect(Object.fromEntries(VIEWERS.map((v) => [v.id, v.version ?? 1]))).toEqual({
      source: 5, "html-frame": 4, markdown: 5, notebook: 4, json: 5, csv: 5, svg: 5, image: 5,
      pdf: 4, video: 4, audio: 4, font: 4, archive: 4, code: 5, binary: 5,
    });
  });
});

describe("viewer selection", () => {
  const pick = (path: string, mode: ViewMode, size = 100, l = live()) => findViewer(toViewerFile(path, "0".repeat(64), size, contentTypeFor(path)), l, VIEWERS, mode)?.id ?? null;

  it("serves HTML as the real page; ?view=1 gives the viewer frame, ?view=source the source", () => {
    expect(pick("index.html", "document")).toBeNull();
    expect(pick("index.html", "frame")).toBeNull();
    expect(pick("index.html", "view")).toBe("html-frame");
    expect(pick("index.html", "source")).toBe("source");
  });

  it("chooses a viewer per kind for navigations", () => {
    expect(pick("a.md", "document")).toBe("markdown");
    expect(pick("a.md", "document", 100, live(false))).toBeNull();
    expect(pick("a.ts", "document")).toBe("code");
    expect(pick("a.txt", "document")).toBe("code");
    expect(pick("a.json", "document")).toBe("json");
    expect(pick("a.csv", "document")).toBe("csv");
    expect(pick("a.png", "document")).toBe("image");
    expect(pick("a.svg", "document")).toBe("svg");
    expect(pick("a.pdf", "document")).toBe("pdf");
    expect(pick("a.mp4", "document")).toBe("video");
    expect(pick("a.mp3", "document")).toBe("audio");
    expect(pick("a.woff2", "document")).toBe("font");
    expect(pick("a.ipynb", "document")).toBe("notebook");
  });

  it("keeps raw bytes for media a site embeds in an iframe, and for binaries unless ?view=1", () => {
    expect(pick("a.pdf", "frame")).toBeNull();
    expect(pick("a.mp4", "frame")).toBeNull();
    expect(pick("a.png", "frame")).toBeNull();
    expect(pick("a.md", "frame")).toBe("markdown");
    expect(pick("a.zip", "document")).toBe("archive");
    expect(pick("a.zip", "view")).toBe("archive");
    expect(pick("a.wasm", "view")).toBe("binary");
    expect(pick("a.png", "source")).toBeNull();
  });

  it("falls back to the code view above a viewer's size cap", () => {
    expect(pick("big.json", "document", 3 * 1024 * 1024)).toBe("code");
    expect(pick("big.md", "document", 3 * 1024 * 1024)).toBeNull();
  });
});

describe("sanitizer", () => {
  it("removes scripts, handlers, styles, frames, forms, base and meta", async () => {
    const out = await sanitizeHtml(
      `<p onclick="x()" style="position:fixed">hi<script>alert(1)</script></p><img src=x onerror=alert(1)><iframe src="https://evil"></iframe>` +
        `<form action="https://evil"><input type="password" name=p><input type="checkbox" checked><button>go</button></form>` +
        `<base href="https://evil/"><meta http-equiv="refresh" content="0;url=https://evil"><style>body{display:none}</style><svg><script>1</script></svg>` +
        `<details open><summary>more</summary><custom-el>kept text</custom-el></details><!-- comment -->`,
    );
    expect(out).not.toMatch(/script|onclick|onerror|style=|iframe|<form|password|<button|<base|<meta|<style|<svg|comment/i);
    expect(out).toContain("<p>hi</p>");
    expect(out).toMatch(/<input type="checkbox" checked disabled(="")?>/);
    expect(out).toContain("<details open><summary>more</summary>kept text</details>");
  });

  it("drops javascript:, vbscript: and non-image data: URLs, including encoded ones", async () => {
    const out = await sanitizeHtml(
      `<a href="javascript:alert(1)">a</a><a href="  JaVa\tScRiPt:alert(1)">b</a><a href="&#106;avascript:alert(1)">c</a>` +
        `<a href="javascript&colon;alert(1)">d</a><a href="data:text/html,<script>1</script>">e</a><a href="vbscript:x">f</a>` +
        `<a href="https://example.com/x?a=1&b=2">ok</a><a href="docs/page.md#top">rel</a><img src="data:image/png;base64,AAAA"><img src="data:text/html,x">`,
    );
    expect(out).not.toMatch(/javascript|vbscript|data:text/i);
    expect(out).toContain('href="https://example.com/x?a=1&b=2"');
    expect(out).toContain('href="docs/page.md#top"');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(isSafeUrl("mailto:a@b.c", "a", "href")).toBe(true);
    expect(isSafeUrl("mailto:a@b.c", "img", "src")).toBe(false);
  });
});

describe("helpers", () => {
  it("splits highlighted HTML into self-contained lines", () => {
    const html = highlight("/* one\ntwo */\nconst x = `a\nb`;", "javascript");
    const lines = splitHighlightedLines(html);
    expect(lines).toHaveLength(4);
    for (const l of lines) expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length);
    expect(lines[1]).toContain("two */");
  });

  it("reads image dimensions from PNG, GIF and JPEG headers", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0x2c, 0, 0, 0, 0xc8, 8, 2, 0, 0, 0]);
    expect(imageSize(png)).toEqual({ width: 300, height: 200 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]);
    expect(imageSize(gif)).toEqual({ width: 320, height: 240 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 640, height: 480 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("parses quoted CSV and detects delimiters", () => {
    const { rows } = parseCsv('name,note\r\n"Smith, J","said ""hi""\nthen left"\nDoe,ok\n', ",", 100);
    expect(rows).toEqual([["name", "note"], ["Smith, J", 'said "hi"\nthen left'], ["Doe", "ok"]]);
    expect(detectDelimiter("a;b;c\n1;2;3\n", "x.csv")).toBe(";");
    expect(detectDelimiter("a,b\n", "x.tsv")).toBe("\t");
    expect(parseCsv("a\nb\nc\nd\n", ",", 2)).toEqual({ rows: [["a"], ["b"]], complete: false });
  });

  it("csv detection: blank lines between records cast no vote", () => {
    // Pin the nonempty-record rule: an empty record voting [0,0,0,0] would
    // drop the semicolon minimum to 0 and fall back to comma.
    expect(detectDelimiter("a;b\n\n1;2\n3;4\n", "x.csv")).toBe(";");
    expect(detectDelimiter("\n\na;b\n1;2\n3;4\n", "x.csv")).toBe(";");
  });

  it("tells text from binary", () => {
    expect(looksLikeText(new TextEncoder().encode("MIT License\n\nCopyright ünïcode"))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 1]))).toBe(false);
  });
});

describe("viewer pages", () => {
  let dw: Instance;
  let slug: string;
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32, 8, 2, 0, 0, 0, 1, 2, 3]);
  const nb = JSON.stringify({
    metadata: { language_info: { name: "python" } },
    cells: [
      { cell_type: "markdown", source: ["# Analysis\n", "Some <script>alert(1)</script> **bold**"] },
      { cell_type: "code", execution_count: 3, source: "print('hi')", outputs: [{ output_type: "stream", text: ["hi\n"] }, { output_type: "display_data", data: { "image/png": "iVBORw0KGgo=" } }] },
    ],
  });
  beforeAll(async () => {
    dw = await freshInstance();
    const res = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({
        "index.html": "<!doctype html><title>Home</title><p>home</p>",
        "src/app.ts": "// viewer-test\nexport const answer: number = 42;\n",
        "data/config.json": '{"name":"dropway","list":[1,2,3],"nested":{"ok":true,"none":null},"link":"https://example.com/x"}',
        "data/broken.json": '{"name": "dropway",',
        "data/table.csv": 'city,population\n"Paris, FR",2100000\nLyon,513000\n',
        "img/logo.png": PNG,
        "img/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>',
        "media/talk.mp4": new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]),
        "media/talk.en.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
        "media/song.mp3": new Uint8Array([0x49, 0x44, 0x33, 3]),
        "docs/report.pdf": "%PDF-1.4\n%fake\n",
        "fonts/Inter.woff2": new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1]),
        "bin/data.bin": new Uint8Array([0, 1, 2, 3, 0xff, 0xfe, 0x41, 0x42]),
        "LICENSE": "MIT License\n\nPermission is hereby granted...\n",
        "yarn.lock": "# yarn lockfile v1\n\nleft-pad@1.3.0:\n  version \"1.3.0\"\n",
        "notebooks/analysis.ipynb": nb,
      }),
    });
    expect(res.status).toBe(201);
    slug = res.body.slug;
  });
  const get = (path: string, headers: Record<string, string> = NAV) => dw.call(`/s/${slug}/${path}`, { headers });

  it("code: highlighted lines with anchors, a hashed copy script, and a render cache", async () => {
    const res = await get("src/app.ts");
    expect(res.headers.get("x-kofra-viewer")).toBe("code");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("sandbox allow-scripts");
    const html = await res.text();
    expect(html).toContain('id="L1"');
    expect(html).toContain('href="#L2"');
    // Line links work by click and by #L2, but stay out of the Tab order (a long file would be thousands of stops).
    expect(html).toContain('<a href="#L2" data-n="2" aria-label="Line 2" tabindex="-1">');
    expect(html).toContain('<span class="hljs-keyword">export</span>');
    expect(html).toContain("typescript · 2 lines");
    expect(res.headers.get("x-kofra-render-cache")).toBe("miss");
    const again = await get("src/app.ts");
    expect(again.headers.get("x-kofra-render-cache")).toBe("memory");
    const etag = again.headers.get("etag")!;
    // Nonembedded pages include the live manifest identity as well as the file hash.
    expect(etag).toMatch(/^W\/"code@5-[a-f0-9]{64}-[A-Za-z0-9_-]+"$/);
    const hash = etag.match(/^W\/"code@5-([a-f0-9]{64})-/)![1];
    expect((await get("src/app.ts", { ...NAV, "If-None-Match": `W/"code@3-${hash}"` })).status).toBe(200);
    expect((await get("src/app.ts", { ...NAV, "If-None-Match": etag })).status).toBe(304);
    // A validator from before the redesign (no page version) never revalidates the new page.
    expect((await get("src/app.ts", { ...NAV, "If-None-Match": `W/"code@1-${hash}"` })).status).toBe(200);
    // Sub-resource requests still get the bytes.
    const script = await get("src/app.ts", { "Sec-Fetch-Dest": "script", Accept: "*/*" });
    expect(script.headers.get("x-kofra-viewer")).toBeNull();
    expect(await script.text()).toContain("export const answer");
  });

  it("html: the page itself; ?view=1 frames it; ?view=source highlights it", async () => {
    const page = await get("index.html");
    expect(page.headers.get("x-kofra-viewer")).toBeNull();
    expect(await page.text()).toContain("<p>home</p>");
    const frame = await get("index.html?view=1");
    expect(frame.headers.get("x-kofra-viewer")).toBe("html-frame");
    expect(await frame.text()).toContain(`<iframe class="k-frame" src="/s/${slug}/index.html"`);
    const src = await get("index.html?view=source");
    expect(src.headers.get("x-kofra-viewer")).toBe("source");
    const html = await src.text();
    expect(html).toContain('<span class="hljs-tag">&lt;<span class="hljs-name">p</span>&gt;</span>');
    expect(html).toContain(">Page</a>");
  });

  it("json: collapsible tree and pretty view; invalid JSON shows the error", async () => {
    const res = await get("data/config.json");
    expect(res.headers.get("x-kofra-viewer")).toBe("json");
    const html = await res.text();
    expect(html).toContain('<span class="dw-jk">nested</span>');
    expect(html).toContain("3 items");
    expect(html).toContain('<span class="dw-jz">null</span>');
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('id="dw-jt-pretty"');
    const broken = await (await get("data/broken.json")).text();
    expect(broken).toContain("This file is not valid JSON");
  });

  it("csv: a table with counts and numeric columns", async () => {
    const html = await (await get("data/table.csv")).text();
    expect(html).toContain("2 rows · 2 columns · comma-separated");
    expect(html).toContain("<td>Paris, FR</td>");
    expect(html).toContain('<td class="n">2100000</td>');
  });

  it("csv: the render path discards a record cut by the detection budget", async () => {
    // The detector must see the whole sample so it can tell a 64 Ki budget
    // cut from EOF; a pre-sliced sample would vote the cut tail and pick comma.
    const prefix = "name;note\n";
    const cut = "cut.csv";
    const body = prefix + "a,b,c," + "x".repeat(64 * 1024 - prefix.length - 6) + ",late\n";
    const published = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({ [cut]: body }),
    });
    expect(published.status).toBe(201);
    const html = await (await dw.call(`/s/${published.body.slug}/${cut}`, { headers: NAV })).text();
    expect(html).toContain("1 rows · 2 columns · semicolon-separated");
    expect(html).not.toContain("comma-separated");
  });

  it("images: zoomable with dimensions; sub-resources and iframes get the bytes", async () => {
    const res = await get("img/logo.png");
    expect(res.headers.get("x-kofra-viewer")).toBe("image");
    expect(res.headers.get("x-kofra-image-size")).toBe("64x32");
    expect(await res.text()).toContain(`<img src="/s/${slug}/img/logo.png" alt="logo.png" width="64" height="32">`);
    const img = await get("img/logo.png", { "Sec-Fetch-Dest": "image", Accept: "image/*" });
    expect(img.headers.get("content-type")).toBe("image/png");
    expect((await get("img/logo.png", IFRAME)).headers.get("content-type")).toBe("image/png");
  });

  it("svg: shown through <img> (its scripts never run) with a source view", async () => {
    const html = await (await get("img/icon.svg")).text();
    expect(html).toContain(`<img src="/s/${slug}/img/icon.svg"`);
    expect(html).not.toContain("alert(1)");
    expect((await get("img/icon.svg?view=source")).headers.get("x-kofra-viewer")).toBe("source");
  });

  it("pdf, video, audio and fonts get players and specimens", async () => {
    const pdf = await get("docs/report.pdf");
    expect(pdf.headers.get("x-kofra-viewer")).toBe("pdf");
    expect(pdf.headers.get("content-security-policy")).toContain("object-src https://dropway.test");
    expect(await pdf.text()).toContain(`<object class="dw-pdf" data="/s/${slug}/docs/report.pdf?raw=1" type="application/pdf"`);
    expect((await get("docs/report.pdf", IFRAME)).headers.get("content-type")).toBe("application/pdf");
    const video = await (await get("media/talk.mp4")).text();
    expect(video).toContain(`<video class="dw-video" controls playsinline preload="metadata" src="/s/${slug}/media/talk.mp4">`);
    expect(video).toContain(`<track kind="subtitles" src="/s/${slug}/media/talk.en.vtt" srclang="en" label="en" default>`);
    expect(await (await get("media/song.mp3")).text()).toContain("<audio class=\"dw-audio\" controls");
    const font = await (await get("fonts/Inter.woff2")).text();
    expect(font).toContain(`@font-face{font-family:"dw-specimen";src:url("/s/${slug}/fonts/Inter.woff2") format("woff2")`);
  });

  it("binary: downloads on navigation, info page with ?view=1; text without a known type is shown as text", async () => {
    const nav = await get("bin/data.bin");
    expect(nav.headers.get("x-kofra-viewer")).toBeNull();
    expect(nav.headers.get("content-type")).toBe("application/octet-stream");
    const info = await get("bin/data.bin?view=1");
    expect(info.headers.get("x-kofra-viewer")).toBe("binary");
    const html = await info.text();
    expect(html).toContain("00000000  00 01 02 03 ff fe 41 42");
    expect(html).toContain("SHA-256");
    const lic = await get("LICENSE");
    expect(lic.headers.get("x-kofra-viewer")).toBe("code");
    expect(await lic.text()).toContain("Permission is hereby granted");
    const lock = await get("yarn.lock?view=1");
    expect(lock.headers.get("x-kofra-viewer")).toBe("binary");
    expect(await lock.text()).toContain("it looks like text");
  });

  it("notebooks: cells, outputs, sanitized Markdown", async () => {
    const html = await (await get("notebooks/analysis.ipynb")).text();
    expect(html).toContain("In [3]:");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="output">');
    expect(html).toContain('<span class="hljs-built_in">print</span>');
  });

  it("&embed=1 drops the bar (used by the app-origin viewer)", async () => {
    const full = await (await get("src/app.ts?view=1")).text();
    expect(full).toContain('class="k-vbar dw-vbar"');
    const embed = await get("src/app.ts?view=1&embed=1");
    expect(await embed.text()).not.toContain('class="k-vbar dw-vbar"');
    expect(embed.headers.get("etag")).toMatch(/-e"$/);
  });

  it("the bar links Raw, Download and the app viewer", async () => {
    const html = await (await get("data/table.csv")).text();
    expect(html).toContain(`href="/s/${slug}/data/table.csv?raw=1"`);
    expect(html).toContain(`href="/s/${slug}/data/table.csv?download=1"`);
    expect(html).toContain(`href="https://dropway.test/v/${slug}/data/table.csv"`);
    expect(html).toContain(">Table</a>");
  });

  it("folder listings show kinds, sizes and an image gallery", async () => {
    const res = await get("img/");
    expect(res.headers.get("x-kofra-viewer")).toBe("listing");
    const html = await res.text();
    expect(html).toContain('class="k-gallery"');
    expect(html).toContain(">SVG image<");
    expect(html).toContain(`href="https://dropway.test/v/${slug}/img/"`);
  });
});

/**
 * Notebook output folding: paired acceptance contract (keep this file
 * unchanged in the implementation change).
 *
 * - Each code cell with at least one rendered output wraps exactly those
 *   outputs, in order, in one native initially-open <details> whose
 *   <summary> text is "Outputs (N)", N counting only outputs that render a
 *   fragment under the existing output rules (unsupported MIME-only outputs
 *   render nothing and are not counted).
 * - The cell's code and its "In [n]:" prompt stay outside the <details>, so
 *   collapsing it can never hide the code. Cells with zero rendered outputs
 *   (empty, unsupported-only, markdown, raw) get no control.
 * - Folding is native only: no script, no shared `name` (controls toggle
 *   independently), the summary keeps its native keyboard behaviour, and
 *   the summary/control survives the existing sanitizer.
 * - All existing output rendering is preserved inside the fold: stream and
 *   error text (ANSI stripped), PNG/JPEG/GIF/SVG images, sanitized HTML and
 *   Markdown, plain text and JSON, the current MIME priority, the 100,000
 *   character text clip with its ellipsis and the 20 MiB viewer cap.
 * - The notebook render version is bumped past 2 so cached pre-fold
 *   fragments and "notebook@1" / "notebook@2" conditional ETags retire; Raw, Download,
 *   Source and sub-resource bytes stay identical to the stored file.
 */
describe("notebook output folding", () => {
  const nbJson = (cells: unknown[]) => JSON.stringify({ metadata: { language_info: { name: "python" } }, cells });
  const foldNb = nbJson([
    { cell_type: "markdown", source: "# Fold fixture title\n\nintro-fold-sentinel" },
    { cell_type: "code", execution_count: 1, source: "empty_cell_marker = 1", outputs: [] },
    {
      cell_type: "code", execution_count: 2, source: "alpha_cell_marker = compute_alpha()",
      outputs: [{ output_type: "stream", name: "stdout", text: "alpha-stream-sentinel\n" }],
    },
    {
      cell_type: "code", execution_count: 3, source: "mixed_cell_marker = compute_mixed()",
      outputs: [
        { output_type: "stream", name: "stdout", text: "mixed-stream-sentinel\n" },
        { output_type: "stream", name: "stderr", text: "mixed-stderr-sentinel\n" },
        {
          output_type: "error", ename: "ValueError", evalue: "mixed-error-evalue",
          traceback: ["\u001b[31mTraceback (most recent call last)\u001b[0m", "ValueError: mixed-error-sentinel"],
        },
        {
          output_type: "execute_result", execution_count: 3,
          data: {
            "text/html": "<p>mixed-html-sentinel</p><script>alert(41)</script><img src=x onerror=alert(42)>",
            "text/plain": "shadowed-plain-sentinel",
          },
        },
        { output_type: "display_data", data: { "image/png": "iVBORw0KGgo=" } },
        { output_type: "display_data", data: { "text/markdown": "**mixed-md-sentinel** <script>alert(43)</script>" } },
        { output_type: "display_data", data: { "application/json": { foldKey: "mixed-json-sentinel" } } },
        { output_type: "display_data", data: { "application/pdf": "JVBERi0xLjQK" } },
        { output_type: "display_data", data: { "text/latex": "latex-sentinel-must-not-render" } },
        { output_type: "stream", name: "stdout", text: "</summary></details><script>alert(44)</script>" },
      ],
    },
    {
      cell_type: "code", execution_count: 4, source: "unsupported_cell_marker = 2",
      outputs: [{ output_type: "display_data", data: { "application/pdf": "JVBERi0xLjQK" } }],
    },
    { cell_type: "code", execution_count: null, source: "pending_cell_marker = 3", outputs: [] },
    { cell_type: "raw", source: "raw-cell-sentinel" },
    {
      cell_type: "code", execution_count: 5, source: 'hostile_source_marker = "</details><script>alert(45)</script>"',
      outputs: [{ output_type: "stream", name: "stdout", text: "hostile-source-output-sentinel\n" }],
    },
  ]);
  const longNb = nbJson([
    {
      cell_type: "code", execution_count: 7, source: "long_stream_marker = emit_long()",
      outputs: [{ output_type: "stream", name: "stdout", text: "LONG-START " + "x".repeat(100_500) + " LONG-END-SENTINEL" }],
    },
    {
      cell_type: "code", execution_count: 8, source: "long_json_marker = emit_json()",
      outputs: [{ output_type: "display_data", data: { "application/json": { pad: "y".repeat(100_500), tail: "JSON-END-SENTINEL" } } }],
    },
  ]);
  const foldFiles: Record<string, string> = {
    "nb/fold.ipynb": foldNb,
    "nb/long.ipynb": longNb,
    "nb/empty.ipynb": nbJson([]),
    "nb/nocells.ipynb": JSON.stringify({ metadata: {} }),
    "nb/broken.ipynb": "{not json",
  };

  const detailsBlocks = (html: string) => Array.from(pageContent(html).matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g), (m) => m[0]);
  // Text extraction for assertions only: scan out <...> spans character by
  // character instead of stripping tags with a regex replace.
  const stripTags = (html: string) => {
    let text = "";
    for (let i = 0; i < html.length; ) {
      const end = html[i] === "<" ? html.indexOf(">", i + 1) : -1;
      if (end > i + 1) i = end + 1;
      else text += html[i++];
    }
    return text;
  };
  const summaryText = (block: string) => stripTags(block.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1] ?? "").trim();
  const withoutDetails = (html: string) => html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
  const expectOrder = (haystack: string, needles: string[]) => {
    let at = -1;
    for (const needle of needles) {
      const next = haystack.indexOf(needle, at + 1);
      expect(next, `${needle} after offset ${at}`).toBeGreaterThan(at);
      at = next;
    }
  };

  let dw: Instance;
  let slug: string;
  beforeAll(async () => {
    dw = await freshInstance();
    const res = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(foldFiles) });
    expect(res.status).toBe(201);
    slug = res.body.slug;
  });
  beforeEach(() => clearRenderMemoryCache());
  const get = (path: string, headers: Record<string, string> = NAV) => dw.call(`/s/${slug}/${path}`, { headers });

  it("wraps each nonempty output group in an initially-open details with a counted Outputs summary", async () => {
    const res = await get("nb/fold.ipynb");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("notebook");
    const html = await res.text();
    const blocks = detailsBlocks(html);
    // Only the three code cells with rendered outputs get a control: the
    // empty, unsupported-only, markdown and raw cells get none.
    expect(blocks).toHaveLength(3);
    expect(blocks.map(summaryText)).toEqual(["Outputs (1)", "Outputs (8)", "Outputs (1)"]);
    for (const block of blocks) {
      const tag = block.match(/^<details\b[^>]*>/)![0];
      expect(tag).toMatch(/(?:^|\s)open(?:\s|=|>)/);
      // A shared name would make the controls an exclusive accordion.
      expect(tag).not.toMatch(/\sname=/);
    }
    expect(blocks[0]).toContain("alpha-stream-sentinel");
    expect(blocks[2]).toContain("hostile-source-output-sentinel");
  });

  it("keeps every mixed output type, in order and sanitized, inside the fold", async () => {
    const html = await (await get("nb/fold.ipynb")).text();
    const blocks = detailsBlocks(html);
    expect(blocks).toHaveLength(3);
    const mixed = blocks[1]!;
    expectOrder(stripTags(mixed), [
      "Outputs (8)", "mixed-stream-sentinel", "mixed-stderr-sentinel", "mixed-error-sentinel",
      "mixed-html-sentinel", "mixed-md-sentinel", "mixed-json-sentinel",
    ]);
    expect(mixed).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="output">');
    expect(mixed).toContain("<strong>mixed-md-sentinel</strong>");
    expect(mixed).toContain("foldKey");
    // MIME priority is unchanged: HTML shadows the plain-text fallback, and
    // a traceback shadows ename/evalue; unsupported outputs render nothing.
    expect(html).not.toContain("shadowed-plain-sentinel");
    expect(html).not.toContain("mixed-error-evalue");
    expect(html).not.toContain("latex-sentinel-must-not-render");
    expect(html).not.toContain("JVBERi0xLjQK");
    // ANSI escapes are still stripped from stream/error text.
    expect(html).not.toContain("\u001b[31m");
    // Hostile markup is neutralized without forging or closing the fold:
    // the escaped stream text stays visible as text inside its block.
    expect(mixed).toContain("&lt;/summary&gt;&lt;/details&gt;");
    expect(html).not.toMatch(/<script\b|onerror\s*=/);
    expect(detailsBlocks(html)).toHaveLength(3);
  });

  it("keeps code and execution prompts outside the fold, in cell order", async () => {
    const html = await (await get("nb/fold.ipynb")).text();
    const outside = stripTags(withoutDetails(html));
    for (const code of ["empty_cell_marker = 1", "alpha_cell_marker = compute_alpha()", "mixed_cell_marker = compute_mixed()", "unsupported_cell_marker = 2", "pending_cell_marker = 3"]) {
      expect(outside).toContain(code);
    }
    for (const prompt of ["In [1]:", "In [2]:", "In [3]:", "In [4]:", "In [ ]:", "In [5]:"]) {
      expect(outside).toContain(prompt);
    }
    // Nothing that belongs to an output group leaks outside its fold.
    for (const out of ["alpha-stream-sentinel", "mixed-stream-sentinel", "mixed-json-sentinel", "hostile-source-output-sentinel"]) {
      expect(outside).not.toContain(out);
    }
    expectOrder(stripTags(html), [
      "intro-fold-sentinel", "empty_cell_marker", "alpha_cell_marker", "alpha-stream-sentinel",
      "mixed_cell_marker", "unsupported_cell_marker", "pending_cell_marker", "raw-cell-sentinel", "hostile_source_marker",
    ]);
  });

  it("folds with native no-script semantics and keeps the viewer CSP and narrow layout", async () => {
    const res = await get("nb/fold.ipynb");
    const html = await res.text();
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(html).not.toMatch(/<script\b/);
    // The existing single-column narrow layout still applies.
    expect(html).toContain("@media (max-width:640px)");
    // The bar still links the untouched views of the same file.
    expect(html).toContain(`href="/s/${slug}/nb/fold.ipynb?raw=1"`);
    expect(html).toContain(`href="/s/${slug}/nb/fold.ipynb?download=1"`);
    expect(html).toContain(">Notebook</a>");
    // Native <summary> is the keyboard/pointer toggle: it must not be
    // removed from the tab order or replaced by script-driven controls.
    expect(html).toMatch(/<summary\b/);
    expect(html).not.toMatch(/<summary[^>]*tabindex="-1"/);
  });

  it("keeps the 100,000-character output clip inside the fold", async () => {
    const html = await (await get("nb/long.ipynb")).text();
    const blocks = detailsBlocks(html);
    expect(blocks.map(summaryText)).toEqual(["Outputs (1)", "Outputs (1)"]);
    expect(blocks[0]).toContain("LONG-START");
    expect(blocks[0]).toContain("x".repeat(99_000));
    expect(blocks[0]).not.toContain("x".repeat(100_001));
    expect(blocks[0]).not.toContain("LONG-END-SENTINEL");
    expect(blocks[0]).toContain("…");
    expect(blocks[1]).not.toContain("JSON-END-SENTINEL");
    expect(blocks[1]).toContain("…");
  });

  it("serves empty and invalid notebooks without inventing a control", async () => {
    for (const path of ["nb/empty.ipynb", "nb/nocells.ipynb"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-kofra-viewer")).toBe("notebook");
      const html = await res.text();
      expect(detailsBlocks(html)).toEqual([]);
      expect(html).not.toContain("In [");
    }
    const broken = await (await get("nb/broken.ipynb")).text();
    expect(broken).toContain("This notebook is not valid JSON");
    expect(broken).toContain("Use Source or Raw.");
    expect(detailsBlocks(broken)).toEqual([]);
  });

  it("keeps Raw, Download, Source and sub-resource bytes identical", async () => {
    const stored = new TextEncoder().encode(foldNb);
    for (const [query, headers] of [
      ["?raw=1", NAV],
      ["?download=1", NAV],
      ["", { Accept: "*/*", "Sec-Fetch-Dest": "empty" }],
    ] as Array<[string, Record<string, string>]>) {
      const res = await get(`nb/fold.ipynb${query}`, headers);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-kofra-viewer")).toBeNull();
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(stored);
      if (query === "?download=1") expect(res.headers.get("content-disposition")).toContain("attachment");
    }
    const source = await get("nb/fold.ipynb?view=source");
    expect(source.headers.get("x-kofra-viewer")).toBe("source");
    const sourceHtml = await source.text();
    expect(sourceHtml).toContain("mixed-stream-sentinel");
    expect(detailsBlocks(sourceHtml)).toEqual([]);
    expect(pageContent(sourceHtml)).not.toMatch(/<details\b[^>]*class="[^"]*\bdw-out\b/);
  });

  it("renderNotebook folds rendered outputs only (plain text, JPEG and SVG included)", () => {
    const html = renderNotebook({
      metadata: { language_info: { name: "python" } },
      cells: [
        {
          cell_type: "code", execution_count: 1, source: "unit_marker = 1",
          outputs: [
            { output_type: "execute_result", data: { "text/plain": "unit-plain-sentinel" } },
            { output_type: "display_data", data: { "image/jpeg": "/9j/4AAQ" } },
            { output_type: "display_data", data: { "image/svg+xml": '<svg xmlns="http://www.w3.org/2000/svg"></svg>' } },
            { output_type: "display_data", data: { "application/pdf": "JVBERi0xLjQK" } },
          ],
        },
        { cell_type: "code", execution_count: 2, source: "unit_empty_marker = 2", outputs: [] },
      ],
    });
    const blocks = detailsBlocks(html);
    expect(blocks.map(summaryText)).toEqual(["Outputs (3)"]);
    expect(blocks[0]).toContain("unit-plain-sentinel");
    expect(blocks[0]).toContain('<img src="data:image/jpeg;base64,/9j/4AAQ" alt="output">');
    expect(blocks[0]).toContain('<img src="data:image/svg+xml;base64,');
    expect(stripTags(withoutDetails(html))).toContain("unit_marker = 1");
    expect(renderNotebook({})).toBe("");
    expect(renderNotebook({ cells: "nope" })).toBe("");
  });

  it("the fold survives the existing sanitizer", async () => {
    const out = await sanitizeHtml(renderNotebook(JSON.parse(foldNb)));
    const blocks = detailsBlocks(out);
    expect(blocks.map(summaryText)).toEqual(["Outputs (1)", "Outputs (8)", "Outputs (1)"]);
    for (const block of blocks) expect(block.match(/^<details\b[^>]*>/)![0]).toMatch(/(?:^|\s)open(?:\s|=|>)/);
    expect(out).not.toMatch(/<script\b|onerror\s*=/);
  });

  it("keeps the 20 MiB notebook viewer cap", () => {
    const pick = (size: number) => findViewer(toViewerFile("a.ipynb", "0".repeat(64), size, contentTypeFor("a.ipynb")), live(), VIEWERS, "document")?.id ?? null;
    expect(pick(20 * 1024 * 1024)).toBe("notebook");
    expect(pick(20 * 1024 * 1024 + 1)).not.toBe("notebook");
    expect(notebookViewer.maxBytes).toBe(20 * 1024 * 1024);
  });

  it.each([["memory", 1], ["edge", 1], ["memory", 2], ["edge", 2]] as const)("cannot reuse a pre-fold fragment from %s at notebook@%i", async (tier, version) => {
    expect(notebookViewer.version).toBeGreaterThan(2);
    const hash = await sha256Hex(new TextEncoder().encode(foldNb));
    const legacyKey = `notebook@${version}/${hash}`;
    const url = `${ORIGIN}/s/${slug}/nb/fold.ipynb`;
    const oldHtml = "<p>PRE_FOLD_LEGACY</p><pre>alpha-stream-sentinel</pre>";
    await caches.default.delete(new Request(`${ORIGIN}/__dropway/render/${legacyKey}`));
    await caches.default.delete(new Request(`${ORIGIN}/__dropway/render/notebook@${notebookViewer.version}/${hash}`));
    if (tier === "memory") {
      const ctx = createExecutionContext();
      const dc = dw.dropway.context(env as unknown as ServerBindings, ctx, new URL(url));
      await cachedRender(dc, legacyKey, async () => oldHtml);
      await waitOnExecutionContext(ctx);
    } else {
      await caches.default.put(new Request(`${ORIGIN}/__dropway/render/${legacyKey}`), new Response(oldHtml, {
        headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=2592000" },
      }));
      clearRenderMemoryCache();
    }
    const res = await dw.call(url, { headers: NAV });
    const html = await res.text();
    expect(html).not.toContain("PRE_FOLD_LEGACY");
    expect(detailsBlocks(html).map(summaryText)).toEqual(["Outputs (1)", "Outputs (8)", "Outputs (1)"]);
    expect(res.headers.get("x-kofra-render-cache")).toBe("miss");
    const again = await dw.call(url, { headers: NAV });
    expect(again.headers.get("x-kofra-render-cache")).toBe("memory");
    expect(detailsBlocks(await again.text())).toHaveLength(3);
  });

  it("serves identical folded pages to concurrent cold requests", async () => {
    const [a, b] = await Promise.all([get("nb/fold.ipynb"), get("nb/fold.ipynb")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const [htmlA, htmlB] = await Promise.all([a.text(), b.text()]);
    expect(htmlB).toBe(htmlA);
    expect(detailsBlocks(htmlA)).toHaveLength(3);
  });

  it.each([1, 2])("does not answer 304 to a notebook@%i ETag, but revalidates the new render", async (version) => {
    const hash = await sha256Hex(new TextEncoder().encode(foldNb));
    const legacy = `W/"notebook@${version}-${hash}"`;
    const res = await get("nb/fold.ipynb", { ...NAV, "If-None-Match": legacy });
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag")!;
    expect(etag).not.toBe(legacy);
    expect(etag).toMatch(/^W\/"notebook@\d+-[a-f0-9]{64}(-[A-Za-z0-9_-]+)?"$/);
    expect(detailsBlocks(await res.text())).toHaveLength(3);
    const fresh = await get("nb/fold.ipynb", { ...NAV, "If-None-Match": etag });
    expect(fresh.status).toBe(304);
    expect(await fresh.text()).toBe("");
  });
});

/**
 * Notebook output fold containment: paired acceptance contract.
 *
 * No text/html or text/markdown output may close (or forge) the generated
 * per-cell fold. A later output of the same cell must still sit inside the
 * single `details.dw-out` after the browser parses the page, whatever end
 * tags, details/summary tags or markup hidden in comments, dropped elements
 * or attribute values the earlier output carries. Benign markup renders
 * unchanged inside the fold.
 */
describe("notebook output fold containment", () => {
  const SENTINEL = "later-output-sentinel";
  const nbWith = (first: Record<string, unknown>) => ({
    metadata: { language_info: { name: "python" } },
    cells: [
      {
        cell_type: "code", execution_count: 1, source: "containment_marker = 1",
        outputs: [
          { output_type: "display_data", data: first },
          { output_type: "stream", name: "stdout", text: `${SENTINEL}\n` },
        ],
      },
    ],
  });

  type El = { name: string; attrs: Record<string, string>; children: Array<El | string> };
  const set = (names: string) => new Set(names.split(" "));
  const VOID = set("area base basefont bgsound br col embed frame hr img input keygen link meta param source track wbr");
  const RAW = set("script style textarea title xmp iframe noembed noframes noscript");
  const HEADING = set("h1 h2 h3 h4 h5 h6");
  const FORMATTING = set("a b big code em font i nobr s small strike strong tt u");
  // Start tags that close an open <p>, and end tags that pop to their element when it is in scope.
  const BLOCK = set(
    "address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer header hgroup main menu nav ol p search section summary ul",
  );
  const BLOCK_END = new Set([...BLOCK, "button", "listing", "pre"]);
  const SPECIAL = new Set([
    ...BLOCK_END, ...HEADING, ...set("applet area base basefont bgsound body br caption col colgroup dd dt embed form frame frameset head hr html iframe img input keygen li link marquee meta noembed noframes noscript object param plaintext script select source style table tbody td template textarea tfoot th thead title tr track wbr xmp"),
  ]);
  const SCOPE = set("#root html table td th caption template applet marquee object");
  const BUTTON_SCOPE = new Set([...SCOPE, "button"]);
  const LIST_SCOPE = new Set([...SCOPE, "ol", "ul"]);
  const TABLE_SCOPE = set("#root html table template");
  const TABLE_PARTS = set("caption col colgroup tbody td tfoot th thead tr");
  const SECTIONS = set("tbody thead tfoot");
  const FOSTER_TARGETS = set("table tbody thead tfoot tr");
  const isAlpha = (c: string | undefined) => c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
  const isSpace = (c: string | undefined) => c === " " || c === "\n" || c === "\t" || c === "\f" || c === "\r";

  /**
   * Parse HTML into a tree the way a browser's tree builder does for the
   * markup these fixtures produce: a character-scan tokenizer (comments,
   * quoted attribute values, raw-text elements) and the HTML tree
   * construction rules that decide containment. End tags close only an open
   * element of that name in scope (else are ignored), which is what lets a
   * stray </div> or </main> pop an enclosing <details>; <p>, <li>, <dd>/<dt>
   * and headings close implicitly; table parts outside a table are ignored,
   * tables imply tbody/tr and close cells, and stray content inside a table
   * is foster-parented before it. Formatting end tags are simplified: they
   * pop to their element, or are dropped from the stack when a block sits
   * inside them (no reparenting).
   */
  const parse = (html: string): El => {
    const root: El = { name: "#root", attrs: {}, children: [] };
    const stack: El[] = [root];
    const parent = new Map<El, El>();
    const top = () => stack[stack.length - 1]!;
    const find = (match: (name: string) => boolean, scope: Set<string>) => {
      for (let k = stack.length - 1; k > 0; k--) {
        if (match(stack[k]!.name)) return k;
        if (scope.has(stack[k]!.name)) return -1;
      }
      return -1;
    };
    const has = (name: string, scope = SCOPE) => find((n) => n === name, scope);
    const popTo = (k: number) => {
      if (k > 0) stack.length = k;
    };
    const clearTo = (names: Set<string>) => {
      while (!names.has(top().name) && top() !== root) stack.pop();
    };
    // The browser's insertion mode, read off the stack of open elements.
    const mode = () => {
      for (let k = stack.length - 1; k > 0; k--) {
        const n = stack[k]!.name;
        if (n === "td" || n === "th") return "cell";
        if (n === "tr") return "row";
        if (SECTIONS.has(n)) return "section";
        if (n === "caption") return "caption";
        if (n === "colgroup") return "colgroup";
        if (n === "table") return "table";
        if (n === "template" || n === "html") return "body";
      }
      return "body";
    };
    let foster = false;
    const place = (node: El | string) => {
      const cur = top();
      const t = foster && FOSTER_TARGETS.has(cur.name) ? stack.map((e) => e.name).lastIndexOf("table") : -1;
      if (t > 0) {
        const table = stack[t]!;
        const into = parent.get(table) ?? stack[t - 1]!;
        into.children.splice(into.children.indexOf(table), 0, node);
        if (typeof node !== "string") parent.set(node, into);
      } else {
        cur.children.push(node);
        if (typeof node !== "string") parent.set(node, cur);
      }
    };
    const insert = (name: string, attrs: Record<string, string> = {}, push = !VOID.has(name)) => {
      const el: El = { name, attrs, children: [] };
      place(el);
      if (push) stack.push(el);
      return el;
    };
    const closeP = () => popTo(has("p", BUTTON_SCOPE));

    const bodyStart = (name: string, attrs: Record<string, string>) => {
      if (name === "html" || name === "body" || name === "head" || name === "frameset" || TABLE_PARTS.has(name)) return;
      if (BLOCK.has(name) || name === "hr" || name === "pre" || name === "listing" || name === "table" || name === "plaintext") closeP();
      else if (HEADING.has(name)) {
        closeP();
        if (HEADING.has(top().name)) stack.pop();
      } else if (name === "li" || name === "dd" || name === "dt") {
        const same = name === "li" ? (n: string) => n === "li" : (n: string) => n === "dd" || n === "dt";
        for (let k = stack.length - 1; k > 0; k--) {
          const n = stack[k]!.name;
          if (same(n)) {
            popTo(k);
            break;
          }
          if (SPECIAL.has(n) && n !== "address" && n !== "div" && n !== "p") break;
        }
        closeP();
      } else if (name === "button") popTo(has("button"));
      else if (name === "form") {
        if (stack.some((e) => e.name === "form")) return;
        closeP();
      } else if (name === "a") {
        const k = stack.map((e) => e.name).lastIndexOf("a");
        if (k > 0) bodyEnd("a");
      } else if (name === "option" || name === "optgroup") {
        if (top().name === "option") stack.pop();
      }
      insert(name, attrs);
    };
    const bodyEnd = (name: string) => {
      if (name === "br") return void insert("br");
      if (name === "p") {
        const k = has("p", BUTTON_SCOPE);
        if (k < 0) insert("p", {}, false);
        else popTo(k);
        return;
      }
      if (BLOCK_END.has(name)) return popTo(has(name));
      if (name === "li") return popTo(has("li", LIST_SCOPE));
      if (name === "dd" || name === "dt") return popTo(has(name));
      if (HEADING.has(name)) return popTo(find((n) => HEADING.has(n), SCOPE));
      if (name === "form") {
        const k = has("form");
        if (k > 0) stack.splice(k, 1);
        return;
      }
      if (FORMATTING.has(name)) {
        const k = has(name);
        if (k < 0) return;
        if (stack.slice(k + 1).some((el) => SPECIAL.has(el.name))) stack.splice(k, 1);
        else popTo(k);
        return;
      }
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) return popTo(k);
        if (SPECIAL.has(stack[k]!.name)) return;
      }
    };
    const inBodyFostered = (fn: () => void) => {
      foster = true;
      fn();
      foster = false;
    };

    const startTag = (name: string, attrs: Record<string, string>): void => {
      const m = mode();
      if (m === "colgroup") {
        if (name === "col") return void insert("col");
        stack.pop();
        return startTag(name, attrs);
      }
      if (m === "cell" || m === "caption") {
        if (!TABLE_PARTS.has(name)) return bodyStart(name, attrs);
        const k = m === "cell" ? find((n) => n === "td" || n === "th", TABLE_SCOPE) : has("caption", TABLE_SCOPE);
        if (k < 0) return;
        popTo(k);
        return startTag(name, attrs);
      }
      if (m === "row") {
        if (name === "td" || name === "th") {
          clearTo(set("tr template html"));
          return void insert(name, attrs);
        }
        if (TABLE_PARTS.has(name)) {
          clearTo(set("tr template html"));
          stack.pop();
          return startTag(name, attrs);
        }
      }
      if (m === "section") {
        if (name === "tr") {
          clearTo(set("tbody thead tfoot template html"));
          return void insert(name, attrs);
        }
        if (name === "td" || name === "th") {
          startTag("tr", {});
          return startTag(name, attrs);
        }
        if (TABLE_PARTS.has(name)) {
          clearTo(set("tbody thead tfoot template html"));
          stack.pop();
          return startTag(name, attrs);
        }
      }
      if (m === "table" || m === "section" || m === "row") {
        const tableCtx = set("table template html");
        if (name === "caption" || name === "colgroup" || SECTIONS.has(name)) {
          clearTo(tableCtx);
          return void insert(name, attrs);
        }
        if (name === "col") {
          startTag("colgroup", {});
          return startTag(name, attrs);
        }
        if (name === "tr" || name === "td" || name === "th") {
          clearTo(tableCtx);
          insert("tbody");
          return startTag(name, attrs);
        }
        if (name === "table") {
          const k = has("table", TABLE_SCOPE);
          if (k < 0) return;
          popTo(k);
          return startTag(name, attrs);
        }
        if (name === "style" || name === "script" || name === "template") return void insert(name, attrs);
        return inBodyFostered(() => bodyStart(name, attrs));
      }
      bodyStart(name, attrs);
    };
    const endTag = (name: string): void => {
      const m = mode();
      if (m === "colgroup") {
        if (name === "col") return;
        stack.pop();
        if (name !== "colgroup") endTag(name);
        return;
      }
      if (m === "cell") {
        if (name === "td" || name === "th") return popTo(has(name, TABLE_SCOPE));
        if (name === "table" || name === "tr" || SECTIONS.has(name)) {
          if (has(name, TABLE_SCOPE) < 0) return;
          popTo(find((n) => n === "td" || n === "th", TABLE_SCOPE));
          return endTag(name);
        }
        if (TABLE_PARTS.has(name) || name === "body" || name === "html") return;
        return bodyEnd(name);
      }
      if (m === "caption") {
        if (name === "caption") return popTo(has("caption", TABLE_SCOPE));
        if (name === "table") {
          const k = has("caption", TABLE_SCOPE);
          if (k < 0) return;
          popTo(k);
          return endTag(name);
        }
        if (TABLE_PARTS.has(name) || name === "body" || name === "html") return;
        return bodyEnd(name);
      }
      if (m === "row") {
        if (name === "tr") return popTo(has("tr", TABLE_SCOPE));
        if (name === "table" || SECTIONS.has(name)) {
          if (has(name, TABLE_SCOPE) < 0 || has("tr", TABLE_SCOPE) < 0) return;
          popTo(has("tr", TABLE_SCOPE));
          return endTag(name);
        }
      }
      if (m === "section") {
        if (SECTIONS.has(name)) return popTo(has(name, TABLE_SCOPE));
        if (name === "table") {
          const k = find((n) => SECTIONS.has(n), TABLE_SCOPE);
          if (k < 0) return;
          popTo(k);
          return endTag(name);
        }
      }
      if (m === "table" || m === "section" || m === "row") {
        if (name === "table") return popTo(has("table", TABLE_SCOPE));
        if (TABLE_PARTS.has(name) || name === "body" || name === "html") return;
        return inBodyFostered(() => bodyEnd(name));
      }
      if (name === "body" || name === "html") return;
      bodyEnd(name);
    };
    const chars = (s: string) => {
      if (!s) return;
      const m = mode();
      const blank = [...s].every(isSpace);
      if (m === "colgroup" && !blank) {
        stack.pop();
        return chars(s);
      }
      if ((m === "table" || m === "section" || m === "row") && FOSTER_TARGETS.has(top().name) && !blank) return inBodyFostered(() => place(s));
      place(s);
    };

    const lower = html.toLowerCase();
    let i = 0;
    let buf = "";
    const flush = () => {
      chars(buf);
      buf = "";
    };
    while (i < html.length) {
      const c = html[i]!;
      if (c !== "<") {
        buf += c;
        i++;
        continue;
      }
      if (html.startsWith("<!--", i)) {
        flush();
        if (html.startsWith("<!-->", i)) i += 5;
        else if (html.startsWith("<!--->", i)) i += 6;
        else {
          const a = html.indexOf("-->", i + 4);
          const b = html.indexOf("--!>", i + 4);
          i = a < 0 && b < 0 ? html.length : b >= 0 && (a < 0 || b < a) ? b + 4 : a + 3;
        }
        continue;
      }
      const closing = html[i + 1] === "/";
      const nameAt = closing ? i + 2 : i + 1;
      if (html[i + 1] === "!" || html[i + 1] === "?" || (closing && !isAlpha(html[nameAt]))) {
        flush();
        const end = html.indexOf(">", i + 1);
        i = end < 0 ? html.length : end + 1;
        continue;
      }
      if (!isAlpha(html[nameAt])) {
        buf += c;
        i++;
        continue;
      }
      let j = nameAt;
      while (j < html.length && !isSpace(html[j]) && html[j] !== "/" && html[j] !== ">") j++;
      const name = lower.slice(nameAt, j);
      const attrs: Record<string, string> = {};
      while (j < html.length && html[j] !== ">") {
        if (isSpace(html[j]) || html[j] === "/") {
          j++;
          continue;
        }
        const a = j;
        j++;
        while (j < html.length && !isSpace(html[j]) && html[j] !== "/" && html[j] !== ">" && html[j] !== "=") j++;
        const attr = lower.slice(a, j);
        while (isSpace(html[j])) j++;
        let value = "";
        if (html[j] === "=") {
          j++;
          while (isSpace(html[j])) j++;
          const q = html[j];
          if (q === '"' || q === "'") {
            const end = html.indexOf(q, j + 1);
            value = html.slice(j + 1, end < 0 ? html.length : end);
            j = end < 0 ? html.length : end + 1;
          } else {
            const v = j;
            while (j < html.length && !isSpace(html[j]) && html[j] !== ">") j++;
            value = html.slice(v, j);
          }
        }
        if (!(attr in attrs)) attrs[attr] = value;
      }
      // A tag cut off by the end of input is dropped, as browsers do.
      if (j >= html.length) break;
      flush();
      i = j + 1;
      if (closing) {
        endTag(name);
        continue;
      }
      startTag(name === "image" ? "img" : name, attrs);
      if (name === "plaintext") {
        buf = html.slice(i);
        i = html.length;
      } else if (RAW.has(name)) {
        let end = lower.indexOf(`</${name}`, i);
        while (end >= 0 && isAlpha(lower[end + 2 + name.length])) end = lower.indexOf(`</${name}`, end + 1);
        chars(html.slice(i, end < 0 ? html.length : end));
        i = end < 0 ? html.length : end;
      }
    }
    flush();
    return root;
  };
  const all = (el: El, pred: (e: El) => boolean, out: El[] = []): El[] => {
    for (const child of el.children) {
      if (typeof child === "string") continue;
      if (pred(child)) out.push(child);
      all(child, pred, out);
    }
    return out;
  };
  const textOf = (el: El): string => el.children.map((ch) => (typeof ch === "string" ? ch : textOf(ch))).join("");
  const isFold = (e: El) => e.name === "details" && (e.attrs.class ?? "").split(/\s+/).includes("dw-out");
  const countOf = (haystack: string, needle: string) => haystack.toLowerCase().split(needle).length - 1;

  /** The cell's fold as a browser sees it in the viewer's <main> wrapper. */
  const expectContained = (html: string) => {
    const content = pageContent(html);
    expect(countOf(content, "<details"), html).toBe(1);
    const doc = parse(content);
    expect(all(doc, (e) => e.name === "details"), html).toHaveLength(1);
    const folds = all(doc, isFold);
    expect(folds, html).toHaveLength(1);
    const fold = folds[0]!;
    const summaries = fold.children.filter((ch): ch is El => typeof ch !== "string" && ch.name === "summary");
    expect(summaries.map((s) => textOf(s).trim()), html).toEqual(["Outputs (2)"]);
    expect(textOf(fold), html).toContain(SENTINEL);
    expect(textOf(doc).split(SENTINEL), html).toHaveLength(2);
    const close = content.toLowerCase().indexOf("</details>");
    expect(content.indexOf(SENTINEL), html).toBeGreaterThan(content.toLowerCase().indexOf("<details"));
    expect(content.indexOf(SENTINEL), html).toBeLessThan(close);
    return fold;
  };
  const render = async (first: Record<string, unknown>) =>
    `<main class="dw-nb">${await sanitizeHtml(renderNotebook(nbWith(first)))}</main>`;

  it("the containment model sees a stray end tag pop an enclosing details", () => {
    const leaked = parse(`<main><div><details class="dw-out"><summary>Outputs (2)</summary><div></div></div><pre>${SENTINEL}</pre></details></div></main>`);
    expect(textOf(all(leaked, isFold)[0]!)).not.toContain(SENTINEL);
    const kept = parse(`<main><div><details class="dw-out"><summary>Outputs (2)</summary><div><a title='</div>'>x</a></div><pre>${SENTINEL}</pre></details></div></main>`);
    expect(textOf(all(kept, isFold)[0]!)).toContain(SENTINEL);
  });

  const HOSTILE_HTML = [
    "</details>",
    "</DETAILS >",
    "</summary>",
    "<details>",
    "</div>",
    "</div></div></div>",
    "</main>",
    "<!-- <div> --></div>",
    "<template><div></template></div>",
    "<script>var a='<div>'</script></div>",
    "<a title='</div>'>x</a>",
    '<details title="</div>">',
  ];
  it.each(HOSTILE_HTML)("a text/html output %j cannot close or forge the fold", async (payload) => {
    expectContained(await render({ "text/html": payload }));
  });

  it.each(["</div>", "</div></div>"])("a text/markdown output %j cannot close the fold", async (payload) => {
    expectContained(await render({ "text/markdown": `md-before\n\n${payload}\n\nmd-after` }));
  });

  it.each([
    "<table><tr><td>1</td></tr></table>",
    "<div><b>x</b></div>",
    '<p>a</p><div class="x">y</div>',
  ])("benign text/html %j renders unchanged inside the fold", async (payload) => {
    const html = await render({ "text/html": payload });
    const fold = expectContained(html);
    expect(html).toContain(payload);
    expect(html.indexOf(payload)).toBeGreaterThan(html.indexOf("</summary>"));
    expect(html.indexOf(payload)).toBeLessThan(html.indexOf(SENTINEL));
    expect(textOf(fold)).toContain(textOf(parse(payload)));
  });

  it("a text/html output that leaves a div open keeps the later output inside the fold", async () => {
    const html = await render({ "text/html": "<div>unclosed-div-sentinel" });
    const fold = expectContained(html);
    expect(textOf(fold)).toContain("unclosed-div-sentinel");
    expect(textOf(fold).indexOf("unclosed-div-sentinel")).toBeLessThan(textOf(fold).indexOf(SENTINEL));
  });

  it("keeps the fold contained on the served viewer page", async () => {
    const dw = await freshInstance();
    const files: Record<string, string> = {
      "c/main.ipynb": JSON.stringify(nbWith({ "text/html": "</main>" })),
      "c/divs.ipynb": JSON.stringify(nbWith({ "text/html": "</div></div></div>" })),
      "c/md.ipynb": JSON.stringify(nbWith({ "text/markdown": "md-before\n\n</div></div>\n\nmd-after" })),
    };
    const res = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(files) });
    expect(res.status).toBe(201);
    for (const path of Object.keys(files)) {
      const page = await dw.call(`/s/${res.body.slug}/${path}`, { headers: NAV });
      expect(page.status).toBe(200);
      expect(page.headers.get("x-kofra-viewer")).toBe("notebook");
      expectContained(await page.text());
    }
  });

  const NEXT_SENTINEL = "next-cell-output-sentinel";
  const twoCells = (first: Record<string, unknown>) => ({
    metadata: { language_info: { name: "python" } },
    cells: [
      ...nbWith(first).cells,
      {
        cell_type: "code", execution_count: 2, source: "next_cell_marker = 2",
        outputs: [{ output_type: "stream", name: "stdout", text: `${NEXT_SENTINEL}\n` }],
      },
    ],
  });
  const renderTwo = async (first: Record<string, unknown>) =>
    `<main class="dw-nb">${await sanitizeHtml(renderNotebook(twoCells(first)))}</main>`;
  const within = (outer: El, inner: El) => all(outer, (e) => e === inner).length > 0;
  const hasClass = (e: El, name: string) => (e.attrs.class ?? "").split(/\s+/).includes(name);

  /** Two code cells as a browser sees them: the first cell's output cannot annex the second cell. */
  const expectNextCellFree = (html: string) => {
    const doc = parse(html);
    const folds = all(doc, isFold);
    expect(folds, html).toHaveLength(2);
    const [fold, next] = folds as [El, El];
    expect(within(fold, next), html).toBe(false);
    expect(textOf(fold), html).toContain(SENTINEL);
    expect(textOf(fold), html).not.toContain(NEXT_SENTINEL);
    const nextSummary = next.children.filter((ch): ch is El => typeof ch !== "string" && ch.name === "summary");
    expect(nextSummary.map((s) => textOf(s).trim()), html).toEqual(["Outputs (1)"]);
    expect(textOf(next), html).toContain(NEXT_SENTINEL);
    const prompts = all(doc, (e) => hasClass(e, "dw-prompt") && textOf(e).trim() === "In [2]:");
    expect(prompts, html).toHaveLength(1);
    const code = all(doc, (e) => e.name === "code" && textOf(e).includes("next_cell_marker"));
    expect(code, html).toHaveLength(1);
    const tables = all(doc, (e) => e.name === "table");
    for (const el of [next, prompts[0]!, code[0]!]) {
      expect(within(fold, el), html).toBe(false);
      for (const table of tables) expect(within(table, el), html).toBe(false);
    }
    expect(textOf(doc).split(SENTINEL), html).toHaveLength(2);
    expect(textOf(doc).split(NEXT_SENTINEL), html).toHaveLength(2);
  };

  it("the containment model applies implied end tags and table annexing as browsers do", () => {
    const fold = (inner: string) => `<details class="dw-out"><summary>Outputs (2)</summary><div>${inner}</div><pre>${SENTINEL}</pre></details>`;
    const sentinelInFold = (inner: string) => textOf(all(parse(`<main><div>${fold(inner)}</div></main>`), isFold)[0]!).includes(SENTINEL);
    // A heading end tag closes whichever heading is open; li closes the previous li and what it holds.
    expect(sentinelInFold("<h1><div></h2></div>")).toBe(false);
    expect(sentinelInFold("<h1><div></h2>")).toBe(true);
    expect(sentinelInFold("<ul><li><div><li></ul></div>")).toBe(false);
    // </table> closes the open cell and row; table parts outside a table are ignored.
    expect(sentinelInFold("<table><tr><td><div></table></div>")).toBe(false);
    expect(sentinelInFold("<td><div></div></div>")).toBe(false);
    // An unclosed table swallows a following fold, and stray content in a table is moved before it.
    const annexed = parse(`<main>${fold("<table><tr><td>x")}${fold("")}</main>`);
    const [first, second] = all(annexed, isFold) as [El, El];
    expect(within(first, second)).toBe(true);
    const fostered = parse("<div><table><b>moved</b><tr><td>kept</td></tr></table></div>");
    const table = all(fostered, (e) => e.name === "table")[0]!;
    expect(textOf(table)).toBe("kept");
    expect(textOf(fostered)).toBe("movedkept");
  });

  const MISNESTED_HTML = [
    "<section><div></section></div>",
    "<xİ></main>",
    "<dİv></div>",
    "<section><div></section></div></div></div>",
    "<p><div></p></div></div>",
    "<ul><li><div><li><div></ul></div></div>",
    "<h1><div></h2></div></div>",
    "<b><i>x</b></i></div></div>",
    "<table><tr><td><div></table></div></div>",
    "<td><div></div></div>",
    "<caption><div></caption></div></div>",
  ];
  it.each(MISNESTED_HTML)("a misnested text/html output %j cannot pop the fold", async (payload) => {
    expectContained(await render({ "text/html": payload }));
  });

  it.each(["<section><div></section></div></div></div>", "<ul><li><div><li><div></ul></div></div>"])(
    "a misnested text/markdown output %j cannot pop the fold",
    async (payload) => {
      expectContained(await render({ "text/markdown": `md-before\n\n${payload}\n\nmd-after` }));
    },
  );

  it.each([
    "<table>",
    "<table><tr><td>x",
    "<table><tr><td><div>x",
    "<ul><li>a<li>b",
    "<div><div><div>",
    "<table><thead><a><summary></caption><tbody>",
  ])("an unclosed text/html output %j cannot annex the next cell", async (payload) => {
    expectNextCellFree(await renderTwo({ "text/html": payload }));
  });

  it.each([
    ["text/html", "<!--"],
    ["text/html", "<p>ok</p><!-- trailing note"],
    ["text/html", "<!unfinished"],
    ["text/html", "<?unfinished"],
    ["text/markdown", "hello\n\n<!-- unterminated"],
  ])("an unterminated comment in %s does not swallow later outputs or cells", async (mime, payload) => {
    expectNextCellFree(await renderTwo({ [mime]: payload }));
  });

  it("a noscript raw-text end tag inside apparent attribute text cannot annex the next cell", async () => {
    expectNextCellFree(await renderTwo({ "text/html": '<noscript><p title="</noscript>"><table><tr><td>' }));
  });

  it("unwraps output disclosure tags and ignores stray end tags without showing markup", async () => {
    const html = await render({ "text/html": "<details><summary>More</summary><p>content</p></details></div>" });
    const fold = expectContained(html);
    expect(textOf(fold)).toContain("Morecontent");
    expect(textOf(fold)).not.toContain("<details>");
    expect(textOf(fold)).not.toContain("</div>");
  });

  it.each([
    "<script>var a=1",
    "<style>p{",
    "<textarea>x",
    "<svg><g>",
    "<template><div>",
    "<select><option>",
    "<button>",
    "<button/>",
    "<plaintext>x",
    "<plaintext>hello</plaintext>",
    "<template><plaintext>hello</plaintext>",
  ])("an unclosed dropped element %j does not swallow the rest of the notebook", async (payload) => {
    expectNextCellFree(await renderTwo({ "text/html": payload }));
  });

  it.each(["<svg><title><textarea>x", "<svg><desc><script>var a=1", "<svg><foreignObject><style>p{", "<math><mi><script>var a=1"])(
    "an unclosed raw-text element %j inside svg or math does not swallow the rest of the notebook",
    async (payload) => {
      expectNextCellFree(await renderTwo({ "text/html": payload }));
    },
  );

  describe("dropped-element tokenizer boundaries", () => {
    it.each([
      "<svg a=/>",
      "<svg width=100/>",
      "<math a=/>",
    ])("an unclosed foreign element %j cannot consume later outputs or cells", async (payload) => {
      expectNextCellFree(await renderTwo({ "text/html": payload }));
    });

    it.each([
      "<svg a=/></svg>",
      "<svg width=100/></svg>",
      "<math a=/></math>",
      "<math data-note=value/></math>",
    ])("an unquoted slash-bearing attribute in %j preserves markup after the group", async (payload) => {
      const html = await renderTwo({ "text/html": `${payload}<p>after-foreign-group-sentinel</p>` });
      expectNextCellFree(html);
      const fold = all(parse(html), isFold)[0]!;
      expect(textOf(fold)).toContain("after-foreign-group-sentinel");
    });

    it.each([
      '<svg data-note="value/"></svg>',
      "<math data-note='value/'></math>",
    ])("a quoted slash-bearing attribute in %j leaves following markup outside the group", async (payload) => {
      const html = await renderTwo({ "text/html": `${payload}<p>after-foreign-group-sentinel</p>` });
      expectNextCellFree(html);
      const fold = all(parse(html), isFold)[0]!;
      expect(textOf(fold)).toContain("after-foreign-group-sentinel");
    });

    it.each([
      "<svg data-note=value />",
      "<math data-note=value />",
      '<svg data-note="value/"/>',
      "<math data-note='value/'/>",
      "<svg><g data-note=value /></svg>",
      "<math><mrow data-note=value /></math>",
    ])("a truly self-closing foreign element in %j leaves following markup outside it", async (payload) => {
      const html = await renderTwo({ "text/html": `${payload}<p>after-foreign-group-sentinel</p>` });
      expectNextCellFree(html);
      const fold = all(parse(html), isFold)[0]!;
      expect(textOf(fold)).toContain("after-foreign-group-sentinel");
    });

    it.each([
      "<template><template>inner-dropped-text</template>outer-dropped-text</template>",
      "<template><template><template>inner-dropped-text</template>middle-dropped-text</template>outer-dropped-text</template>",
      "<svg><svg>inner-dropped-text</svg>outer-dropped-text</svg>",
      "<math><math>inner-dropped-text</math>outer-dropped-text</math>",
      "<svg><g><g>inner-dropped-text</g>outer-dropped-text</g></svg>",
      "<math><mrow><mrow>inner-dropped-text</mrow>outer-dropped-text</mrow></math>",
    ])("a matched same-name dropped group %j preserves following output and cell boundaries", async (payload) => {
      const html = await renderTwo({ "text/html": `<p>before-dropped-group-sentinel</p>${payload}<p>after-dropped-group-sentinel</p>` });
      expectNextCellFree(html);
      const fold = all(parse(html), isFold)[0]!;
      const text = textOf(fold);
      expect(text).toContain("before-dropped-group-sentinel");
      expect(text).toContain("after-dropped-group-sentinel");
      expect(text).not.toContain("inner-dropped-text");
      expect(text).not.toContain("outer-dropped-text");
    });

    it.each([
      "<template><template>inner-dropped-text</template>outer-dropped-text",
      "<svg><svg>inner-dropped-text</svg>outer-dropped-text",
      "<math><math>inner-dropped-text</math>outer-dropped-text",
    ])("an incomplete outer same-name dropped group %j cannot consume later outputs or cells", async (payload) => {
      expectNextCellFree(await renderTwo({ "text/html": payload }));
    });
  });

  it.each([
    ["quote-paired stray end tags", '</x a="'.repeat(16_000) + 'x">'],
    ["quote-paired tags inside svg", '<svg>' + '<g a="'.repeat(16_000) + 'x">'],
    ["quote-paired literal tags", '<details a="'.repeat(16_000) + 'x">'],
    ["unterminated anchor tags", "<a ".repeat(53_334)],
    ["comments", "<!-- x -->".repeat(16_000)],
    ["open divs then stray paragraph ends", "<div>".repeat(32_000) + "</p>".repeat(40_000)],
    ["nested list items holding divs", "<li><div>".repeat(17_800)],
    ["nested table cells", "<table><tr><td>".repeat(10_700)],
    ["nested svg", "<svg>".repeat(32_000)],
  ])("renders a ~160 KB text/html output of %s in linear time", (_label, payload) => {
    const nb = nbWith({ "text/html": payload });
    const started = performance.now();
    renderNotebook(nb);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
  }, 120_000);

  it.each([
    '<table class="dataframe"><thead><tr><th></th><th>value</th></tr></thead><tbody><tr><th>0</th><td>1.5</td></tr></tbody></table>',
    "<ul><li>a</li><li>b</li></ul>",
    "<div><div><span>x</span></div></div>",
  ])("well-formed text/html %j renders unchanged inside the fold", async (payload) => {
    const html = await render({ "text/html": payload });
    const fold = expectContained(html);
    expect(html).toContain(payload);
    expect(html.indexOf(payload)).toBeGreaterThan(html.indexOf("</summary>"));
    expect(html.indexOf(payload)).toBeLessThan(html.indexOf(SENTINEL));
    expect(textOf(fold)).toContain(textOf(parse(payload)));
  });

  it.each([
    ["<ul><li>first-item<li>second-item</ul>", ["first-item", "second-item"]],
    ["<p>para-text<div>block-text</div>", ["para-text", "block-text"]],
    ["<table><tr><td>cell-one<td>cell-two</table>", ["cell-one", "cell-two"]],
  ] as const)("sloppy text/html %j keeps all its text inside the fold", async (payload, words) => {
    const fold = expectContained(await render({ "text/html": payload }));
    const text = textOf(fold);
    let at = text.indexOf("Outputs (2)");
    for (const word of [...words, SENTINEL]) {
      const next = text.indexOf(word, at + 1);
      expect(next, `${word} in ${text}`).toBeGreaterThan(at);
      at = next;
    }
  });
});
