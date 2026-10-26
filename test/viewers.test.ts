import { beforeAll, describe, expect, it } from "vitest";
import { detectFileKind, languageFor, contentTypeFor, type LiveSite } from "@dropway/core";
import { findViewer, toViewerFile, VIEWERS, type ViewMode } from "@dropway/server";
import { sanitizeHtml, isSafeUrl } from "../packages/server/src/viewers/sanitize";
import { splitHighlightedLines, highlight } from "../packages/server/src/viewers/highlight";
import { imageSize } from "../packages/server/src/viewers/media";
import { parseCsv, detectDelimiter } from "../packages/server/src/viewers/csv";
import { looksLikeText } from "../packages/server/src/viewers/binary";
import { form, freshInstance, type Instance } from "./helpers";

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
    expect(pick("a.zip", "document")).toBeNull();
    expect(pick("a.zip", "view")).toBe("binary");
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
    expect(html).toContain('<span class="hljs-keyword">export</span>');
    expect(html).toContain("typescript · 2 lines");
    expect(res.headers.get("x-kofra-render-cache")).toBe("miss");
    const again = await get("src/app.ts");
    expect(again.headers.get("x-kofra-render-cache")).toBe("memory");
    const etag = again.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"code@2-[a-f0-9]{64}"$/);
    expect((await get("src/app.ts", { ...NAV, "If-None-Match": etag })).status).toBe(304);
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
    expect(await frame.text()).toContain(`<iframe class="dw-frame" src="/s/${slug}/index.html"`);
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
    expect(full).toContain('class="dw-vbar"');
    const embed = await get("src/app.ts?view=1&embed=1");
    expect(await embed.text()).not.toContain('class="dw-vbar"');
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
    expect(html).toContain('class="dw-gal"');
    expect(html).toContain(">SVG image<");
    expect(html).toContain(`href="https://dropway.test/v/${slug}/img/"`);
  });
});
