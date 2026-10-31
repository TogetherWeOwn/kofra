/**
 * Protected acceptance tests: link unfurl (Open Graph / Twitter Card) head
 * metadata for file viewers and folder listings.
 *
 * These tests were written before the feature and define its contract. The
 * implementation change must make them pass WITHOUT editing this file.
 *
 * Contract pinned here (all against the real Worker in workerd):
 * - Every sampled viewer-page render and every folder listing emits, inside
 *   <head>: og:title (exactly the existing <title> text), og:type=website,
 *   og:url (request origin + the file/listing path, percent-encoded per path
 *   segment the way existing links encode it, never any query string),
 *   og:description and <meta name="description"> (each carrying a kind label
 *   and a human-readable size; listings: immediate folder/file counts and
 *   their total size, mirroring the visible listing summary), and
 *   twitter:card=summary. The existing robots=noindex meta stays.
 * - Image-kind files only: og:image is the absolute file URL (query-free, so
 *   a plain fetch returns the bytes) and twitter:card=summary_large_image.
 *   No generated thumbnail/screenshot URL is ever cited; nothing else
 *   (PDF, SVG, video, listings, ...) gets og:image.
 * - og:url / og:image never leak preview/claim/unlock/share tokens or any
 *   other query parameter present on the incoming request.
 * - Password gates answer before any viewer renders and leak no file
 *   metadata; 404/error pages carry no unfurl tags.
 * - Authored HTML pages are served as themselves: the platform never
 *   injects, duplicates or overwrites an author's own tags. The ?view=1
 *   HTML frame is a viewer page and does carry the platform tags.
 * - Raw, download and sub-resource responses stay byte-identical; source
 *   view and &embed=1 keep working and carry the same head metadata.
 * - All 15 viewers, including source, HTML frame, binary and embedded views,
 *   reject the tag-less main validators from 923ac4b. Historical versions are
 *   fixed independently of the implementation; current validators still earn
 *   a 304. Shared chrome retirement also covers extension-owned viewer versions.
 *   Viewer CSP is unchanged.
 * - Hostile/unicode file names are attribute-escaped in every emitted tag
 *   and percent-encoded in every emitted URL.
 *
 * Everything is fetched over plain HTTP with no script execution, so tag
 * presence in the first response also pins the no-JavaScript behavior;
 * the viewport meta that narrow layouts rely on must remain.
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { viewerPage, type Viewer } from "@dropway/server";
import { form, freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";
import { expectVersionedBadge } from "./site-badge.helpers";

const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

// A 64x32 PNG header, 32 bytes (the image viewer reads dimensions from it).
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32, 8, 2, 0, 0, 0, 1, 2, 3]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const byteLen = (s: string) => new TextEncoder().encode(s).length;

/** Human-readable size for n bytes, tolerant of B/bytes and KB/KiB dressings. */
function sizeRe(n: number): RegExp {
  if (n < 1024) return new RegExp(`\\b${n}\\s*(?:B|bytes)\\b`);
  const kb = n / 1024;
  const whole = Number.isInteger(kb) ? `${kb}(?:\\.0)?` : kb.toFixed(1).replace(".", "\\.");
  return new RegExp(`\\b${whole}\\s*(?:KB|KiB)\\b`, "i");
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  // One pass: a literal filename such as "&#38;quot;" must not decode twice.
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|quot|apos|lt|gt));/gi, (_, hex, decimal, name) =>
    name ? named[name.toLowerCase()]! : String.fromCodePoint(parseInt(hex ?? decimal, hex ? 16 : 10)));
}

function headOf(html: string): string {
  const start = html.indexOf("<head");
  const end = html.indexOf("</head>");
  expect(start, "response has a <head>").toBeGreaterThanOrEqual(0);
  expect(end, "response closes </head>").toBeGreaterThan(start);
  return html.slice(start, end);
}

interface Meta { key: string; content: string; raw: string }

async function metasIn(html: string): Promise<Meta[]> {
  const out: Meta[] = [];
  // Parse the real document in workerd: comments, script text and body decoys
  // are not head metadata. HTMLRewriter exposes attribute entities verbatim.
  await new HTMLRewriter().on("head meta", {
    element(element) {
      const key = element.getAttribute("property") ?? element.getAttribute("name");
      const content = element.getAttribute("content");
      if (key && content !== null) {
        const raw = `<meta ${[...element.attributes].map(([name, value]) => `${name}="${value}"`).join(" ")}>`;
        out.push({ key: decodeEntities(key), content: decodeEntities(content), raw });
      }
    },
  }).transform(new Response(html)).text();
  return out;
}

function titleOf(head: string): string {
  const m = head.match(/<title>([\s\S]*?)<\/title>/);
  expect(m, "head has a <title>").not.toBeNull();
  return decodeEntities(m![1]!);
}

/**
 * Tag-less main 923ac4bbcfa616368f0f180552d527b52baf55bd, independently pinned:
 * serve.ts:500-521 includes chrome1, full-page folder version (except image/SVG),
 * and image/SVG navigation even for embeds. Never graft a current ETag suffix.
 * Retirement is behavioral: advancing shared chrome can invalidate these tags
 * without advancing an extension's or individual viewer's numeric version.
 * Exact current registry versions remain separately pinned in viewers.test.ts
 * and viewer-phone.acceptance.test.ts.
 */
const TAGLESS_MAIN_VERSION = {
  source: 4, "html-frame": 3, markdown: 4, notebook: 3, json: 4, csv: 4,
  svg: 4, image: 4, pdf: 3, video: 3, audio: 3, font: 3, archive: 3,
  code: 4, binary: 4,
} as const;
// Historical media.ts:109-164, FNV-1a over "img/icon.svg\nimg/logo.png".
const TAGLESS_IMAGE_NAV = "-nav15sxmfs";

interface UnfurlExpect {
  /** Exact og:url (and og:image when `image` is set). */
  url: string;
  /** Kind label the descriptions must carry. */
  kind: RegExp;
  /** Human-readable size (or listing counts/total) the descriptions must carry. */
  sizes: RegExp[];
  image?: boolean;
}

/** Assert the full head contract and return the parsed metas. */
async function expectUnfurl(html: string, want: UnfurlExpect): Promise<Meta[]> {
  const head = headOf(html);
  const metas = await metasIn(html);
  const one = (key: string): string | undefined => {
    const found = metas.filter((m) => m.key === key);
    expect(found.length, `exactly one <meta> for ${key} (found ${found.length}: ${found.map((f) => f.raw).join(" ")})`).toBeLessThanOrEqual(1);
    return found[0]?.content;
  };
  expect(one("robots"), "existing noindex meta stays").toContain("noindex");
  expect(one("viewport"), "viewport meta stays for narrow layouts").toBeTruthy();

  expect(one("og:title"), "og:title is the existing page title").toBe(titleOf(head));
  expect(one("og:type")).toBe("website");
  const url = one("og:url");
  expect(url, "og:url is the canonical query-free absolute URL").toBe(want.url);
  expect(url).not.toContain("?");

  for (const key of ["og:description", "description"] as const) {
    const desc = one(key);
    expect(desc, `${key} is present`).toBeTruthy();
    expect(desc!, `${key} carries the kind label`).toMatch(want.kind);
    for (const s of want.sizes) expect(desc!, `${key} carries the human-readable size/counts`).toMatch(s);
  }

  expect(one("twitter:card")).toBe(want.image ? "summary_large_image" : "summary");
  const ogImage = one("og:image");
  if (want.image) {
    expect(ogImage, "image-kind files cite their own absolute, query-free file URL").toBe(want.url);
    expect(ogImage).not.toContain("?");
    expect(ogImage!).not.toMatch(/thumb|screenshot|\/og\//i);
  } else {
    expect(ogImage, "only image-kind files get og:image (no invented thumbnails)").toBeUndefined();
  }
  return metas;
}

async function expectRevalidated(dw: Instance, path: string, etag: string) {
  const get = vi.spyOn(env.FILES, "get");
  const head = vi.spyOn(env.FILES, "head");
  try {
    const response = await dw.call(path, { headers: { ...NAV, "If-None-Match": etag } });
    expect(response.status, "the current representation still earns 304").toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
    expect(await response.text()).toBe("");
    expect(get.mock.calls.length, "304 needs no blob read").toBe(0);
    expect(head.mock.calls.length, "304 needs no blob metadata read").toBe(0);
  } finally {
    get.mockRestore();
    head.mockRestore();
  }
}

describe("unfurl head metadata oracle", () => {
  it("ignores commented tags, script literals and body decoys but preserves real duplicates", async () => {
    const html = '<!doctype html><html><head><!--<meta property="og:title" content="comment">-->'
      + '<script>const decoy = \'<meta property="og:title" content="script">\';</script>'
      + '<meta property="og:title" content="first"><meta property="og:title" content="second">'
      + '</head><body><meta property="og:title" content="body"></body></html>';
    expect((await metasIn(html)).map(({ key, content }) => ({ key, content }))).toEqual([
      { key: "og:title", content: "first" }, { key: "og:title", content: "second" },
    ]);
  });

  it("decodes attribute entities exactly once, including literal entity-looking names", async () => {
    const html = '<!doctype html><html><head><meta property="og:title" content="&quot; &lt;tag&gt; &#x2615; &#233; &amp;quot; &amp;#34; &#38;quot;"></head><body></body></html>';
    expect((await metasIn(html)).map((meta) => meta.content)).toEqual(['" <tag> ☕ é &quot; &#34; &quot;']);
  });
});

describe("unfurl shared chrome retires extension validators", () => {
  it.each([false, true])("refreshes an extension fixed at version 7 from chrome1 (embed=%s)", async (embed) => {
    const viewer: Viewer = {
      id: "extension-unfurl", version: 7, maxBytes: 1024,
      matches: (file) => file.path === "fixture.txt",
      etagExtra: () => "-layout-2",
      async render(context) {
        return viewerPage(context, { tabs: [], body: "<main>Extension fixture</main>" });
      },
    };
    const dw = await freshInstance({}, { viewers: [viewer] });
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({ "fixture.txt": "hello" }, { slug: "unfurl-extension" }),
    });
    expect(published.status).toBe(201);
    const path = `/s/unfurl-extension/fixture.txt?view=1${embed ? "&embed=1" : ""}`;
    // Complete 923ac4b validator: fixed extension version, known SHA-256("hello"),
    // extension extra, historical folder rule and chrome1; no current-tag bytes.
    const folder = embed ? "" : `-folder${published.body.version.id}`;
    const legacy = `W/"extension-unfurl@7-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824-layout-2${folder}-chrome1${embed ? "-e" : ""}"`;
    const current = await dw.call(path, { headers: NAV });
    expect(current.status).toBe(200);
    expect(current.headers.get("x-kofra-viewer")).toBe("extension-unfurl");
    const html = await current.text();
    await expectUnfurl(html, { url: `${ORIGIN}/s/unfurl-extension/fixture.txt`, kind: /text/i, sizes: [sizeRe(5)] });
    const etag = current.headers.get("etag");
    expect(etag).toMatch(/^W\/"extension-unfurl@7-/);
    const refreshed = await dw.call(path, { headers: { ...NAV, "If-None-Match": legacy } });
    expect.soft(refreshed.status, "shared metadata changes must retire chrome1 without changing the extension's version 7").toBe(200);
    const freshHtml = await refreshed.text();
    if (refreshed.status === 200) {
      expect(refreshed.headers.get("etag")).toBe(etag);
      expect(freshHtml).toBe(html);
      await expectUnfurl(freshHtml, { url: `${ORIGIN}/s/unfurl-extension/fixture.txt`, kind: /text/i, sizes: [sizeRe(5)] });
    }
    expect.soft(etag, "the extension's predecessor identity must be retired").not.toBe(legacy);
    await expectRevalidated(dw, path, etag!);
  });
});

describe("unfurl head tags: file viewers (path mode on the app origin)", () => {
  let dw: Instance;
  let slug: string;
  const CODE = "export const x = 1;\n".repeat(5); // exactly 100 bytes
  const BIG = "x".repeat(2048);
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
  const PDF = "%PDF-1.4\n%fake\n"; // 15 bytes
  const JSON_TEXT = '{"a":1}'; // 7 bytes
  const MD = "# Field Notes\n\nSome body text.\n";
  const AUTHORED = '<!doctype html><html><head><title>Authored</title><meta property="og:title" content="Author Title"><meta name="description" content="Author desc"></head><body><p>mine</p></body></html>';

  const files: Record<string, string | Uint8Array> = {
    "src/app.ts": CODE,
    "notes/big.txt": BIG,
    "notes/guide.md": MD,
    "data.json": JSON_TEXT,
    "data.csv": "name,value\nalpha,1\n",
    "notebooks/analysis.ipynb": JSON.stringify({
      nbformat: 4, nbformat_minor: 5, metadata: {},
      cells: [{ cell_type: "markdown", metadata: {}, source: ["# Cache identity\n", "Notebook body.\n"] }],
    }),
    "media/clip.mp4": new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]),
    "media/song.mp3": new Uint8Array([0x49, 0x44, 0x33, 3]),
    "fonts/sample.woff2": new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1]),
    "archives/bundle.zip": zipSync({ "entry.txt": new TextEncoder().encode("cache-entry\n") }, { level: 0 }),
    "img/logo.png": PNG,
    "img/icon.svg": SVG,
    "docs/report.pdf": PDF,
    "bin/data.bin": new Uint8Array([0, 1, 2, 3]),
    "page.html": AUTHORED,
  };
  const hashes = new Map<string, string>();
  let versionId: string;

  beforeAll(async () => {
    dw = await freshInstance();
    const res = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form(files),
    });
    expect(res.status).toBe(201);
    slug = res.body.slug;
    expect(res.body.version.id).toEqual(expect.any(String));
    versionId = res.body.version.id;
    // Hash the exact bytes we uploaded, including this one ZIP allocation.
    // Historical validators must not obtain any part of their suffix from a
    // response header or from the current viewer/chrome implementation.
    for (const [path, content] of Object.entries(files)) {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : Uint8Array.from(content);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      hashes.set(path, [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
    }
  });

  const canonical = (path: string) => `${ORIGIN}/s/${slug}/${path}`;

  const cases: Array<{ path: string; request?: string; viewer: string; want: UnfurlExpect }> = [
    { path: "src/app.ts", viewer: "code", want: { url: "", kind: /code|typescript/i, sizes: [sizeRe(100)] } },
    { path: "notes/big.txt", viewer: "code", want: { url: "", kind: /text/i, sizes: [sizeRe(2048)] } },
    { path: "notes/guide.md", viewer: "markdown", want: { url: "", kind: /markdown/i, sizes: [sizeRe(byteLen(MD))] } },
    { path: "data.json", viewer: "json", want: { url: "", kind: /json/i, sizes: [sizeRe(7)] } },
    { path: "img/logo.png", viewer: "image", want: { url: "", kind: /image/i, sizes: [sizeRe(32)], image: true } },
    { path: "img/icon.svg", viewer: "svg", want: { url: "", kind: /svg|image/i, sizes: [sizeRe(byteLen(SVG))] } },
    { path: "docs/report.pdf", viewer: "pdf", want: { url: "", kind: /pdf/i, sizes: [sizeRe(15)] } },
    { path: "bin/data.bin", request: "bin/data.bin?view=1", viewer: "binary", want: { url: "", kind: /binary/i, sizes: [sizeRe(4)] } },
    { path: "page.html", request: "page.html?view=1", viewer: "html-frame", want: { url: "", kind: /html/i, sizes: [sizeRe(byteLen(AUTHORED))] } },
  ];

  for (const c of cases) {
    it(`${c.viewer} viewer for ${c.path} unfurls with name, kind and size`, async () => {
      const res = await dw.call(`/s/${slug}/${c.request ?? c.path}`, { headers: NAV });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-kofra-viewer")).toBe(c.viewer);
      const html = await res.text();
      await expectUnfurl(html, { ...c.want, url: canonical(c.path) });
    });
  }

  it("the human-readable size is not a raw byte count for larger files", async () => {
    const html = await (await dw.call(`/s/${slug}/notes/big.txt`, { headers: NAV })).text();
    const desc = (await metasIn(html)).find((m) => m.key === "og:description")?.content ?? "";
    expect(desc).toMatch(sizeRe(2048));
    expect(desc).not.toContain("2048");
  });

  it("og:url/og:image never repeat preview, claim, unlock or share tokens from the request", async () => {
    const junk = "dw_preview=PREVIEWSECRET&claim=CLAIMSECRET&unlock=UNLOCKSECRET&share=SHARESECRET&token=TOKENSECRET";
    for (const [req, path, image] of [
      [`src/app.ts?view=1&${junk}`, "src/app.ts", false],
      [`img/logo.png?${junk}`, "img/logo.png", true],
    ] as const) {
      const res = await dw.call(`/s/${slug}/${req}`, { headers: NAV });
      expect(res.status).toBe(200);
      const html = await res.text();
      const metas = await expectUnfurl(html, { url: canonical(path), kind: image ? /image/i : /code|typescript/i, sizes: [image ? sizeRe(32) : sizeRe(100)], image });
      for (const m of metas) expect(m.content).not.toMatch(/PREVIEWSECRET|CLAIMSECRET|UNLOCKSECRET|SHARESECRET|TOKENSECRET/);
      expect(headOf(html)).not.toMatch(/PREVIEWSECRET|CLAIMSECRET|UNLOCKSECRET|SHARESECRET|TOKENSECRET/);
    }
  });

  it("authored HTML pages keep the author's own tags untouched (no platform injection)", async () => {
    const res = await dw.call(`/s/${slug}/page.html`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBeNull();
    const html = await res.text();
    expect(html).toContain("<p>mine</p>");
    const metas = await metasIn(html);
    expect(metas.filter((m) => m.key === "og:title").map((m) => m.content)).toEqual(["Author Title"]);
    expect(metas.find((m) => m.key === "description")?.content).toBe("Author desc");
    for (const key of ["og:type", "og:url", "og:image", "og:description", "twitter:card"]) {
      expect(metas.find((m) => m.key === key), `platform adds no ${key} to authored pages`).toBeUndefined();
    }
  });

  it("404 pages carry no unfurl tags and name no file metadata", async () => {
    for (const path of [`/s/${slug}/no-such-file.txt`, "/s/no-such-site-xyz/file.txt"]) {
      const res = await dw.call(path, { headers: NAV });
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).not.toContain("og:");
      const metas = await metasIn(html);
      for (const key of ["og:title", "og:description", "description", "twitter:card"]) {
        expect(metas.find((m) => m.key === key), `404 carries no ${key}`).toBeUndefined();
      }
    }
  });

  it("raw, download and sub-resource responses stay byte-identical", async () => {
    const raw = await dw.call(`/s/${slug}/notes/big.txt?raw=1`, { headers: NAV });
    expect(raw.headers.get("x-kofra-viewer")).toBeNull();
    expect(await raw.text()).toBe(BIG);
    const dl = await dw.call(`/s/${slug}/notes/big.txt?download=1`, { headers: NAV });
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(dl.headers.get("content-disposition")).toContain("big.txt");
    expect(await dl.text()).toBe(BIG);
    const script = await dw.call(`/s/${slug}/src/app.ts`, { headers: { "Sec-Fetch-Dest": "script", Accept: "*/*" } });
    expect(script.headers.get("x-kofra-viewer")).toBeNull();
    expect(await script.text()).toBe(CODE);
    const img = await dw.call(`/s/${slug}/img/logo.png`, { headers: { "Sec-Fetch-Dest": "image", Accept: "image/*" } });
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
  });

  it("source view and &embed=1 keep working", async () => {
    const src = await dw.call(`/s/${slug}/src/app.ts?view=source`, { headers: NAV });
    expect(src.status).toBe(200);
    expect(src.headers.get("x-kofra-viewer")).toBe("source");
    expect(await src.text()).toContain('<span class="hljs-keyword">export</span>');
    const embed = await dw.call(`/s/${slug}/src/app.ts?view=1&embed=1`, { headers: NAV });
    expect(embed.status).toBe(200);
    expect(embed.headers.get("x-kofra-viewer")).toBe("code");
    const embedHtml = await embed.text();
    expect(embedHtml).not.toContain('class="dw-vbar"');
    expect(embedHtml).toContain("export");
  });

  it("viewer CSP is unchanged in kind", async () => {
    const code = await dw.call(`/s/${slug}/src/app.ts`, { headers: NAV });
    const csp = code.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    await code.text();
  });

  const cacheCases: Array<{ viewer: keyof typeof TAGLESS_MAIN_VERSION; path: string; query?: string; kind: RegExp }> = [
    { viewer: "source", path: "src/app.ts", query: "?view=source", kind: /code|typescript/i },
    { viewer: "html-frame", path: "page.html", kind: /html/i },
    { viewer: "markdown", path: "notes/guide.md", kind: /markdown/i },
    { viewer: "notebook", path: "notebooks/analysis.ipynb", kind: /notebook/i },
    { viewer: "json", path: "data.json", kind: /json/i },
    { viewer: "csv", path: "data.csv", kind: /csv/i },
    { viewer: "svg", path: "img/icon.svg", kind: /svg|image/i },
    { viewer: "image", path: "img/logo.png", kind: /image/i },
    { viewer: "pdf", path: "docs/report.pdf", kind: /pdf/i },
    { viewer: "video", path: "media/clip.mp4", kind: /video/i },
    { viewer: "audio", path: "media/song.mp3", kind: /audio/i },
    { viewer: "font", path: "fonts/sample.woff2", kind: /font/i },
    { viewer: "archive", path: "archives/bundle.zip", kind: /archive|zip/i },
    { viewer: "code", path: "src/app.ts", kind: /code|typescript/i },
    { viewer: "binary", path: "bin/data.bin", kind: /binary/i },
  ];

  for (const c of cacheCases) {
    for (const embed of [false, true]) {
      it(`${c.viewer} ${embed ? "embed" : "viewer"} rejects its tag-less main @${TAGLESS_MAIN_VERSION[c.viewer]} HTTP validator`, async () => {
        const path = `/s/${slug}/${c.path}${c.query ?? "?view=1"}${embed ? "&embed=1" : ""}`;
        const res = await dw.call(path, { headers: NAV });
        expect(res.status).toBe(200);
        expect(res.headers.get("x-kofra-viewer")).toBe(c.viewer);
        const html = await res.text();
        const content = files[c.path]!;
        const size = typeof content === "string" ? byteLen(content) : content.byteLength;
        const want = { url: canonical(c.path), kind: c.kind, sizes: [sizeRe(size)], image: c.viewer === "image" };
        await expectUnfurl(html, want);
        const etag = res.headers.get("etag") ?? "";
        expect(etag, `${c.viewer} ETag keeps its versioned identity`).toMatch(new RegExp(`^W/"${c.viewer}@\\d+-[^"]+"$`));
        if (embed) expect(etag, "embedded validator keeps its own discriminator").toMatch(/-e"$/);
        await expectRevalidated(dw, path, etag);

        const baseline = TAGLESS_MAIN_VERSION[c.viewer];
        const imageFamily = c.viewer === "image" || c.viewer === "svg";
        const navigation = imageFamily ? TAGLESS_IMAGE_NAV : "";
        const folder = !embed && !imageFamily ? `-folder${versionId}` : "";
        const hash = hashes.get(c.path);
        expect(hash, "historical validator hashes the original uploaded fixture").toMatch(/^[0-9a-f]{64}$/);
        const legacyEtag = `W/"${c.viewer}@${baseline}-${hash}${navigation}${folder}-chrome1${embed ? "-e" : ""}"`;
        const stale = await dw.call(path, { headers: { ...NAV, "If-None-Match": legacyEtag } });
        expect.soft(stale.status, `${c.viewer} actual 923ac4b @${baseline}/chrome1 validator must get a fresh body, not 304 (${legacyEtag})`).toBe(200);
        const fresh = await stale.text();
        if (stale.status === 200) {
          expect(stale.headers.get("x-kofra-viewer")).toBe(c.viewer);
          expect(stale.headers.get("etag")).toBe(etag);
          expect(fresh, "stale validator receives the current complete page").toBe(html);
          await expectUnfurl(fresh, want);
        }
      });
    }
  }
});

describe("unfurl metadata identity survives identical-byte republishes", () => {
  it.each([false, true])("refreshes a root image renamed from a.png to b.png (embed=%s)", async (embed) => {
    const dw = await freshInstance();
    const slug = "unfurl-root-rename";
    const base = `/s/${slug}/`;
    const path = `${base}?view=1${embed ? "&embed=1" : ""}`;
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form({ "a.png": PNG }, { slug }),
    });
    expect(published.status).toBe(201);
    const first = await dw.call(path, { headers: NAV });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-kofra-viewer")).toBe("image");
    await expectUnfurl(await first.text(), { url: `${ORIGIN}${base}a.png`, kind: /image/i, sizes: [sizeRe(32)], image: true });
    const oldEtag = first.headers.get("etag");
    expect(oldEtag).toEqual(expect.any(String));

    const updated = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({
      site: slug, files: [{ path: "b.png", content: b64(PNG), encoding: "base64" }],
    }) });
    expect(updated.status).toBe(200);
    expect(updated.body.version.id).not.toBe(published.body.version.id);
    const removed = await dw.call(`${base}a.png`, { headers: NAV });
    expect(removed.status, "the old canonical file really disappeared").toBe(404);
    await removed.text();

    const refreshed = await dw.call(path, { headers: { ...NAV, "If-None-Match": oldEtag! } });
    expect.soft(refreshed.status, "renaming identical bytes changes root unfurl metadata, so the old validator must not return 304").toBe(200);
    const refreshedHtml = await refreshed.text();
    const current = await dw.call(path, { headers: NAV });
    expect(current.status).toBe(200);
    const html = await current.text();
    const metas = await expectUnfurl(html, { url: `${ORIGIN}${base}b.png`, kind: /image/i, sizes: [sizeRe(32)], image: true });
    expect(metas.find((meta) => meta.key === "og:title")?.content).toContain("b.png");
    expect(metas.find((meta) => meta.key === "og:title")?.content).not.toContain("a.png");
    const etag = current.headers.get("etag");
    expect(etag).toEqual(expect.any(String));
    expect.soft(etag, "the validator covers the resolved filename, not only its content hash").not.toBe(oldEtag);
    if (refreshed.status === 200) {
      expect(refreshed.headers.get("etag")).toBe(etag);
      expect(refreshedHtml).toBe(html);
    }
    const raw = await dw.call(`${base}?raw=1`, { headers: NAV });
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(PNG);
    await expectRevalidated(dw, path, etag!);
  });

  it("refreshes embedded data.json when only application/json changes to application/geo+json", async () => {
    const dw = await freshInstance();
    const slug = "unfurl-mime-change";
    const content = '{"a":1}';
    const path = `/s/${slug}/data.json?view=1&embed=1`;
    const published = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({
      slug, files: [{ path: "data.json", content, contentType: "application/json" }],
    }) });
    expect(published.status).toBe(201);
    const first = await dw.call(path, { headers: NAV });
    expect(first.status).toBe(200);
    const before = await expectUnfurl(await first.text(), { url: `${ORIGIN}/s/${slug}/data.json`, kind: /json/i, sizes: [sizeRe(7)] });
    for (const key of ["description", "og:description"]) {
      expect(before.find((meta) => meta.key === key)?.content).toContain("application/json");
    }
    const oldEtag = first.headers.get("etag");
    expect(oldEtag).toEqual(expect.any(String));

    const updated = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({
      site: slug, files: [{ path: "data.json", content, contentType: "application/geo+json" }],
    }) });
    expect(updated.status).toBe(200);
    expect(updated.body.version.id).not.toBe(published.body.version.id);
    const refreshed = await dw.call(path, { headers: { ...NAV, "If-None-Match": oldEtag! } });
    expect.soft(refreshed.status, "a changed MIME description must refresh even in an embed").toBe(200);
    const refreshedHtml = await refreshed.text();
    const current = await dw.call(path, { headers: NAV });
    expect(current.status).toBe(200);
    expect(current.headers.get("x-kofra-viewer")).toBe("json");
    const html = await current.text();
    const after = await expectUnfurl(html, { url: `${ORIGIN}/s/${slug}/data.json`, kind: /json/i, sizes: [sizeRe(7)] });
    for (const key of ["description", "og:description"]) {
      expect(after.find((meta) => meta.key === key)?.content).toContain("application/geo+json");
    }
    const etag = current.headers.get("etag");
    expect(etag).toEqual(expect.any(String));
    expect.soft(etag, "embedded metadata is part of the HTTP identity").not.toBe(oldEtag);
    if (refreshed.status === 200) {
      expect(refreshed.headers.get("etag")).toBe(etag);
      expect(refreshedHtml).toBe(html);
    }
    expect(await (await dw.call(`/s/${slug}/data.json?raw=1`)).text()).toBe(content);
    await expectRevalidated(dw, path, etag!);
  });
});

describe("unfurl canonical reachability for a reserved root name", () => {
  it("canonicalizes sole uploaded badge.svg artwork to a reachable artwork viewer, not the provider badge", async () => {
    const dw = await freshInstance();
    const slug = "unfurl-badge-artwork";
    const base = `/s/${slug}/`;
    const artwork = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>UNFURL_ARTWORK_ONLY</text></svg>';
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form({ "badge.svg": artwork }, { slug }),
    });
    expect(published.status).toBe(201);
    const provider = await dw.call(`${base}badge.svg`, { headers: NAV });
    expect(provider.status).toBe(200);
    expect(provider.headers.get("x-kofra-viewer")).toBeNull();
    const providerSvg = await provider.text();
    expectVersionedBadge(providerSvg, 1);
    expect(providerSvg).not.toContain("UNFURL_ARTWORK_ONLY");

    const root = await dw.call(base, { headers: NAV });
    expect(root.status).toBe(200);
    expect(root.headers.get("x-kofra-viewer")).toBe("svg");
    const html = await root.text();
    const url = (await metasIn(html)).find((meta) => meta.key === "og:url")?.content;
    expect(url).toEqual(expect.any(String));
    const canonical = new URL(url!);
    expect(canonical.origin).toBe(ORIGIN);
    expect(canonical.pathname.startsWith(base)).toBe(true);
    expect(canonical.search).toBe("");
    expect(canonical.hash).toBe("");
    expect.soft(canonical.pathname, "reserved badge.svg serves provider status, not the uploaded artwork").not.toBe(`${base}badge.svg`);
    await expectUnfurl(html, { url: canonical.href, kind: /svg|image/i, sizes: [sizeRe(byteLen(artwork))] });

    // Reachability and bytes, not a preferred alias spelling, identify the file.
    const navigation = await dw.call(canonical.href, { headers: NAV });
    expect(navigation.status).toBe(200);
    expect.soft(navigation.headers.get("x-kofra-viewer"), "the canonical must navigate to the artwork viewer").toBe("svg");
    await navigation.text();
    const canonicalRaw = new URL(canonical);
    canonicalRaw.search = "?raw=1";
    expect.soft(await (await dw.call(canonicalRaw.href, { headers: NAV })).text(), "the canonical identifies the uploaded artwork bytes").toBe(artwork);
    expect(await (await dw.call(`${base}?raw=1`, { headers: NAV })).text()).toBe(artwork);

    const stillProvider = await dw.call(`${base}badge.svg`, { headers: NAV });
    expect(stillProvider.headers.get("x-kofra-viewer")).toBeNull();
    const stillProviderSvg = await stillProvider.text();
    expectVersionedBadge(stillProviderSvg, 1);
    expect(stillProviderSvg).not.toContain("UNFURL_ARTWORK_ONLY");
    expect(stillProvider.headers.get("content-type")).toBe(provider.headers.get("content-type"));
  });

  it.each(["index.html", "notes.txt"])("keeps authorized multi-file preview badge.svg directly canonical with %s", async (companion) => {
    const dw = await freshInstance();
    const slug = "unfurl-badge-preview";
    const artwork = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>PREVIEW_ARTWORK_ONLY</text></svg>';
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({ "badge.svg": artwork, [companion]: "<p>PREVIEW_COMPANION</p>" }, { slug }),
    });
    expect(published.status).toBe(201);
    expect(published.body.versionUrl).toEqual(expect.any(String));
    const previewRoot = new URL(published.body.versionUrl);
    // Use ordinary owner authorization; never send or report the signed query.
    previewRoot.search = "";
    previewRoot.hash = "";
    expect(previewRoot.origin).toBe(ORIGIN);
    expect(previewRoot.pathname).toBe(`/s/${slug}--v${published.body.version.number}/`);
    const canonical = new URL("badge.svg", previewRoot).href;

    const root = await dw.call(previewRoot.href, { key: dw.ownerKey, headers: NAV });
    expect(root.status).toBe(200);
    expect(root.headers.get("x-kofra-viewer")).not.toBe("svg");
    const rootHtml = await root.text();
    expect(rootHtml).toContain(companion === "index.html" ? "PREVIEW_COMPANION" : "notes.txt");
    expect(rootHtml).not.toContain("PREVIEW_ARTWORK_ONLY");

    const response = await dw.call(`${canonical}?view=1`, { key: dw.ownerKey, headers: NAV });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-kofra-viewer")).toBe("svg");
    expect(response.headers.get("cache-control")).toMatch(/\bprivate\b/);
    expect(response.headers.get("cache-control")).toMatch(/\bno-store\b/);
    await expectUnfurl(await response.text(), { url: canonical, kind: /svg|image/i, sizes: [sizeRe(byteLen(artwork))] });

    const navigation = await dw.call(canonical, { key: dw.ownerKey, headers: NAV });
    expect(navigation.status).toBe(200);
    expect(navigation.headers.get("x-kofra-viewer"), "the preview canonical navigates directly to the artwork, not its index/listing").toBe("svg");
    await navigation.text();
    const raw = await dw.call(`${canonical}?raw=1`, { key: dw.ownerKey, headers: NAV });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("x-kofra-viewer")).toBeNull();
    expect(await raw.text()).toBe(artwork);
  });
});

describe("unfurl metadata is absent from authored 404 fallbacks", () => {
  let dw: Instance;
  const slug = "unfurl-authored-404";
  const authored = '<!doctype html><html><head><title>Authored missing page</title><meta name="robots" content="noindex"></head><body><p>AUTHORED_MISSING_PAGE</p></body></html>';

  beforeAll(async () => {
    dw = await freshInstance();
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form({ "index.html": "<p>home</p>", "404.html": authored }, { slug }),
    });
    expect(published.status).toBe(201);
  });

  it("preserves the ordinary authored fallback bytes and noindex", async () => {
    const direct = await dw.call(`/s/${slug}/404.html`, { headers: NAV });
    expect(direct.status).toBe(200);
    const missing = await dw.call(`/s/${slug}/missing`, { headers: NAV });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-kofra-viewer")).toBeNull();
    const html = await missing.text();
    expect(html).toBe(await direct.text());
    expect(html).toContain("AUTHORED_MISSING_PAGE");
    expect((await metasIn(html)).find((meta) => meta.key === "robots")?.content).toContain("noindex");
    expect(await (await dw.call(`/s/${slug}/404.html?raw=1`)).text()).toBe(authored);
  });

  it.each(["1", "source"])("keeps missing?view=%s at 404 without generated file metadata", async (mode) => {
    const response = await dw.call(`/s/${slug}/missing?view=${mode}`, { headers: NAV });
    expect(response.status).toBe(404);
    const html = await response.text();
    const metas = await metasIn(html);
    expect(metas.find((meta) => meta.key === "robots")?.content, "404 still carries noindex").toContain("noindex");
    expect(metas.filter((meta) => meta.key.startsWith("og:") || meta.key.startsWith("twitter:") || meta.key === "description"),
      "an authored fallback is an error, not a file to unfurl").toEqual([]);
  });

  it.each(["1", "source"])("never revalidates missing?view=%s against a successful custom-404 viewer", async (mode) => {
    const directPath = `/s/${slug}/404.html?view=${mode}`;
    const direct = await dw.call(directPath, { headers: NAV });
    expect(direct.status).toBe(200);
    const viewer = mode === "1" ? "html-frame" : "source";
    expect(direct.headers.get("x-kofra-viewer")).toBe(viewer);
    const etag = direct.headers.get("etag");
    expect(etag, "a successful direct custom-404 viewer supplies a real validator").toEqual(expect.any(String));
    await direct.text();

    // Reuse the successful file's tag twice: the second request revalidates
    // after an error. Even a wildcard must never turn a missing path into 304.
    for (const validator of [etag!, etag!, "*"]) {
      const response = await dw.call(`/s/${slug}/missing?view=${mode}`, {
        headers: { ...NAV, "If-None-Match": validator },
      });
      expect(response.status, "a conditional custom-404 response stays an error, never 304").toBe(404);
      expect(response.headers.get("x-kofra-viewer")).toBe(viewer);
      expect(response.headers.get("etag"), "error viewers must not advertise a successful file validator").toBeNull();
      expect(response.headers.get("cache-control")).toMatch(/\bprivate\b/);
      expect(response.headers.get("cache-control")).toMatch(/\bno-store\b/);
      const metas = await metasIn(await response.text());
      expect(metas.find((meta) => meta.key === "robots")?.content, "conditional errors retain noindex").toContain("noindex");
      expect(metas.filter((meta) => meta.key.startsWith("og:") || meta.key.startsWith("twitter:") || meta.key === "description"),
        "conditional error viewers carry no generated file metadata").toEqual([]);
    }
    // Error responses must not disable or poison successful-file revalidation.
    await expectRevalidated(dw, directPath, etag!);
  });
});

describe("unfurl head tags: folder listings", () => {
  let dw: Instance;
  let slug: string;

  beforeAll(async () => {
    dw = await freshInstance();
    const res = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({
        "alpha.txt": "a".repeat(100),
        "beta.txt": "b".repeat(200),
        "photos/cat.png": PNG,
        "photos/dog.png": PNG,
        "docs/guide.txt": "g".repeat(50),
        "docs/deep/inner.txt": "i".repeat(70),
      }),
    });
    expect(res.status).toBe(201);
    slug = res.body.slug;
  });

  it("root listing unfurls with its immediate folder/file counts and total size", async () => {
    const res = await dw.call(`/s/${slug}/`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("listing");
    expect(res.headers.get("cache-control") ?? "").toMatch(/must-revalidate|no-cache|no-store|max-age=0/);
    const html = await res.text();
    // Immediate entries only: 2 files (100+200 B) and 2 folders, mirroring the
    // visible listing summary; nested bytes are not rolled into the total.
    const metas = await expectUnfurl(html, {
      url: `${ORIGIN}/s/${slug}/`,
      kind: /folder|director|listing|files?/i,
      sizes: [/\b2\s*folders?\b/i, /\b2\s*files?\b/i, sizeRe(300)],
    });
    expect(metas.find((m) => m.key === "og:description")?.content ?? "").not.toContain("414");
    // A gallery of images inside does not make the listing an image card.
    expect(metas.find((m) => m.key === "og:image")).toBeUndefined();
  });

  it("subfolder listings scope counts and size to that folder", async () => {
    const photos = await dw.call(`/s/${slug}/photos/`, { headers: NAV });
    expect(photos.headers.get("x-kofra-viewer")).toBe("listing");
    await expectUnfurl(await photos.text(), {
      url: `${ORIGIN}/s/${slug}/photos/`,
      kind: /folder|director|listing|files?/i,
      sizes: [/\b2\s*files?\b/i, sizeRe(64)],
    });

    const docs = await dw.call(`/s/${slug}/docs/`, { headers: NAV });
    expect(docs.headers.get("x-kofra-viewer")).toBe("listing");
    // 1 immediate file (50 B) + 1 immediate folder; the nested 70 B file is
    // the deep folder's own listing total, not this one's.
    const metas = await expectUnfurl(await docs.text(), {
      url: `${ORIGIN}/s/${slug}/docs/`,
      kind: /folder|director|listing|files?/i,
      sizes: [/\b1\s*folders?\b/i, /\b1\s*files?\b/i, sizeRe(50)],
    });
    expect(metas.find((m) => m.key === "og:description")?.content ?? "").not.toContain("120");
  });
});

describe("unfurl head tags: hostile and unicode file names", () => {
  let dw: Instance;
  const HOSTILE = 'evil "quote" <svg onload=alert(1)> & café ☕.txt';
  const NESTED = "my dir/semi;colon#hash?plus+.ts";
  const HOSTILE_PNG = 'evil "<cat>" & dog.png';
  const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

  beforeAll(async () => {
    dw = await freshInstance();
    const res = await dw.json("/api/v1/publish", {
      key: dw.ownerKey,
      ...jsonBody({
        slug: "unfurl-hostile",
        files: [
          { path: HOSTILE, content: "hostile text body" },
          { path: NESTED, content: "export const y = 2;\n" },
          { path: HOSTILE_PNG, content: b64(PNG), encoding: "base64" },
        ],
      }),
    });
    expect(res.status).toBe(201);
  });

  const slug = "unfurl-hostile";

  it("attribute-escapes titles and percent-encodes canonical URLs", async () => {
    const res = await dw.call(`/s/${slug}/${encPath(HOSTILE)}`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("code");
    const html = await res.text();
    const head = headOf(html);
    expect(head, "no injected element survives in the head").not.toContain("<svg");
    const metas = await expectUnfurl(html, {
      url: `${ORIGIN}/s/${slug}/${encPath(HOSTILE)}`,
      kind: /text/i,
      sizes: [sizeRe(byteLen("hostile text body"))],
    });
    const ogTitle = metas.find((m) => m.key === "og:title")?.content ?? "";
    // Parsed back, the attribute value is the real name (data, not markup).
    expect(ogTitle).toContain("<svg onload=alert(1)>");
    expect(ogTitle).toContain('evil "quote"');
    expect(ogTitle).toContain("café ☕");
    const ogUrl = metas.find((m) => m.key === "og:url")?.content ?? "";
    expect(ogUrl).not.toContain(" ");
    expect(ogUrl).toContain("%22");
    expect(ogUrl).toContain("%3Csvg");
    expect(ogUrl).toContain("%C3%A9");
  });

  it("encodes spaces and URL-significant characters per path segment", async () => {
    const res = await dw.call(`/s/${slug}/${encPath(NESTED)}`, { headers: NAV });
    expect(res.status).toBe(200);
    const html = await res.text();
    await expectUnfurl(html, {
      url: `${ORIGIN}/s/${slug}/my%20dir/semi%3Bcolon%23hash%3Fplus%2B.ts`,
      kind: /code|typescript/i,
      sizes: [sizeRe(byteLen("export const y = 2;\n"))],
    });
  });

  it("og:image for a hostile image name is the same safely encoded absolute URL", async () => {
    const res = await dw.call(`/s/${slug}/${encPath(HOSTILE_PNG)}`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("image");
    const html = await res.text();
    expect(headOf(html)).not.toContain("<cat>");
    await expectUnfurl(html, {
      url: `${ORIGIN}/s/${slug}/${encPath(HOSTILE_PNG)}`,
      kind: /image/i,
      sizes: [sizeRe(32)],
      image: true,
    });
  });
});

describe("unfurl head tags: password-gated sites leak nothing new", () => {
  let dw: Instance;
  const slug = "unfurl-locked";

  beforeAll(async () => {
    dw = await freshInstance();
    const pub = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({ "secret-notes.txt": "top secret body bytes", "pic.png": PNG }, { slug }),
    });
    expect(pub.status).toBe(201);
    const lock = await dw.json(`/api/v1/sites/${slug}/access`, {
      method: "PUT",
      key: dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "password", password: "secret1" }),
    });
    expect(lock.status).toBe(200);
  });

  it("the gate answers before any viewer or listing renders, with no file metadata", async () => {
    for (const path of ["secret-notes.txt", "pic.png", "", "missing.txt"]) {
      const res = await dw.call(`/s/${slug}/${path}`, { headers: NAV });
      expect(res.status, `gate for ${path || "(root)"}`).toBe(401);
      expect(res.headers.get("x-kofra-viewer")).toBeNull();
      const html = await res.text();
      expect(html).not.toContain("og:");
      expect(html).not.toContain("top secret body bytes");
      const metas = await metasIn(html);
      for (const key of ["og:title", "og:description", "og:image", "description", "twitter:card"]) {
        expect(metas.find((m) => m.key === key), `gate for ${path} carries no ${key}`).toBeUndefined();
      }
      expect(titleOf(headOf(html))).not.toContain("secret-notes");
    }
  });

  it("after unlock the same viewer unfurls normally", async () => {
    const unlock = await dw.call(`/s/${slug}/__dropway/password`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=secret1&next=%2Fsecret-notes.txt",
    });
    expect(unlock.status).toBe(303);
    const cookie = (unlock.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("=");
    const res = await dw.call(`/s/${slug}/secret-notes.txt`, { headers: { ...NAV, Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("code");
    await expectUnfurl(await res.text(), {
      url: `${ORIGIN}/s/${slug}/secret-notes.txt`,
      kind: /text/i,
      sizes: [sizeRe(byteLen("top secret body bytes"))],
    });
  });
});

describe("unfurl head tags: canonical URLs follow the serving mode", () => {
  it("subdomain mode builds og:url/og:image on the site's own origin", async () => {
    const sub = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test" });
    const pub = await sub.json("/api/v1/publish", {
      method: "POST",
      key: sub.ownerKey,
      body: form({ "dir/code.ts": "export {};\n", "dir/pic.png": PNG, "root.txt": "root text" }, { slug: "unfurl-sub" }),
    });
    expect(pub.status).toBe(201);
    const base = "https://unfurl-sub.sites.test";

    const code = await sub.call(`${base}/dir/code.ts?view=1&share=SHARESECRET`, { headers: NAV });
    expect(code.headers.get("x-kofra-viewer")).toBe("code");
    await expectUnfurl(await code.text(), { url: `${base}/dir/code.ts`, kind: /code|typescript/i, sizes: [sizeRe(11)] });

    const pic = await sub.call(`${base}/dir/pic.png`, { headers: NAV });
    expect(pic.headers.get("x-kofra-viewer")).toBe("image");
    await expectUnfurl(await pic.text(), { url: `${base}/dir/pic.png`, kind: /image/i, sizes: [sizeRe(32)], image: true });

    const listing = await sub.call(`${base}/dir/`, { headers: NAV });
    expect(listing.headers.get("x-kofra-viewer")).toBe("listing");
    await expectUnfurl(await listing.text(), {
      url: `${base}/dir/`,
      kind: /folder|director|listing|files?/i,
      sizes: [/\b2\s*files?\b/i, sizeRe(11 + 32)],
    });

    const root = await sub.call(`${base}/`, { headers: NAV });
    expect(root.headers.get("x-kofra-viewer")).toBe("listing");
    await expectUnfurl(await root.text(), {
      url: `${base}/`,
      kind: /folder|director|listing|files?/i,
      sizes: [/\b1\s*folders?\b/i, /\b1\s*files?\b/i, sizeRe(9)],
    });
  });

  it("sandboxed sites on a separate sites origin canonicalize to that origin and keep the sandbox CSP", async () => {
    const two = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: "https://sites.example", sitesSandbox: true });
    const pub = await two.json("/api/v1/publish", {
      method: "POST",
      key: two.ownerKey,
      body: form({ "code.ts": "export {};\n", "pic.png": PNG }, { slug: "unfurl-sandboxed" }),
    });
    expect(pub.status).toBe(201);
    const base = "https://sites.example/unfurl-sandboxed";

    const code = await two.call(`${base}/code.ts`, { headers: NAV });
    expect(code.headers.get("x-kofra-viewer")).toBe("code");
    expect(code.headers.get("content-security-policy") ?? "").toContain("sandbox");
    await expectUnfurl(await code.text(), { url: `${base}/code.ts`, kind: /code|typescript/i, sizes: [sizeRe(11)] });

    const pic = await two.call(`${base}/pic.png`, { headers: NAV });
    expect(pic.headers.get("x-kofra-viewer")).toBe("image");
    await expectUnfurl(await pic.text(), { url: `${base}/pic.png`, kind: /image/i, sizes: [sizeRe(32)], image: true });
  });
});
