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
 *   view and &embed=1 keep working (their <head> tags are deliberately not
 *   pinned either way).
 * - Viewer ETags move past their baseline versions, so a stale tag-less
 *   cached render is never revalidated as current (old validators must not
 *   earn a 304). Viewer CSP is unchanged.
 * - Hostile/unicode file names are attribute-escaped in every emitted tag
 *   and percent-encoded in every emitted URL.
 *
 * Everything is fetched over plain HTTP with no script execution, so tag
 * presence in the first response also pins the no-JavaScript behavior;
 * the viewport meta that narrow layouts rely on must remain.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { form, freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";

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
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function headOf(html: string): string {
  const start = html.indexOf("<head");
  const end = html.indexOf("</head>");
  expect(start, "response has a <head>").toBeGreaterThanOrEqual(0);
  expect(end, "response closes </head>").toBeGreaterThan(start);
  return html.slice(start, end);
}

interface Meta { key: string; content: string; raw: string }

function metasIn(head: string): Meta[] {
  const out: Meta[] = [];
  for (const tag of head.matchAll(/<meta\b[^>]*>/g)) {
    const attrs = new Map<string, string>();
    for (const a of tag[0].matchAll(/([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs.set(a[1]!.toLowerCase(), decodeEntities(a[2] ?? a[3] ?? ""));
    }
    const key = attrs.get("property") ?? attrs.get("name");
    if (key && attrs.has("content")) out.push({ key, content: attrs.get("content")!, raw: tag[0] });
  }
  return out;
}

function titleOf(head: string): string {
  const m = head.match(/<title>([\s\S]*?)<\/title>/);
  expect(m, "head has a <title>").not.toBeNull();
  return decodeEntities(m![1]!);
}

/** Baseline viewer versions observed on the pre-feature main (ETag `<id>@<n>-<sha>`). */
const BASELINE_VIEWER_VERSION: Record<string, number> = { code: 1, image: 1, pdf: 1 };

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
function expectUnfurl(html: string, want: UnfurlExpect): Meta[] {
  const head = headOf(html);
  const metas = metasIn(head);
  const one = (key: string): string | undefined => {
    const found = metas.filter((m) => m.key === key);
    expect(found.length, `exactly one <meta> for ${key} (found ${found.length}: ${found.map((f) => f.raw).join(" ")})`).toBeLessThanOrEqual(1);
    return found[0]?.content;
  };
  expect(one("robots"), "existing noindex meta stays").toContain("noindex");
  expect(head, "viewport meta stays for narrow layouts").toContain('name="viewport"');

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

  beforeAll(async () => {
    dw = await freshInstance();
    const res = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({
        "src/app.ts": CODE,
        "notes/big.txt": BIG,
        "notes/guide.md": MD,
        "data.json": JSON_TEXT,
        "img/logo.png": PNG,
        "img/icon.svg": SVG,
        "docs/report.pdf": PDF,
        "bin/data.bin": new Uint8Array([0, 1, 2, 3]),
        "page.html": AUTHORED,
      }),
    });
    expect(res.status).toBe(201);
    slug = res.body.slug;
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
      expectUnfurl(html, { ...c.want, url: canonical(c.path) });
    });
  }

  it("the human-readable size is not a raw byte count for larger files", async () => {
    const html = await (await dw.call(`/s/${slug}/notes/big.txt`, { headers: NAV })).text();
    const desc = metasIn(headOf(html)).find((m) => m.key === "og:description")?.content ?? "";
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
      const metas = expectUnfurl(html, { url: canonical(path), kind: image ? /image/i : /code|typescript/i, sizes: [image ? sizeRe(32) : sizeRe(100)], image });
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
    const metas = metasIn(headOf(html));
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
      const metas = metasIn(headOf(html));
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

  it("viewer CSP is unchanged in kind, and ETags move past the baseline render versions", async () => {
    const code = await dw.call(`/s/${slug}/src/app.ts`, { headers: NAV });
    const csp = code.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    await code.text();

    for (const [path, id] of [["src/app.ts", "code"], ["img/logo.png", "image"], ["docs/report.pdf", "pdf"]] as const) {
      const res = await dw.call(`/s/${slug}/${path}`, { headers: NAV });
      const etag = res.headers.get("etag") ?? "";
      await res.text();
      const parsed = etag.match(new RegExp(`^W/"${id}@(\\d+)-`));
      expect(parsed, `${id} ETag keeps the versioned shape (got ${etag})`).not.toBeNull();
      const baseline = BASELINE_VIEWER_VERSION[id]!;
      expect(Number(parsed![1]), `${id} render version is bumped past baseline @${baseline}`).toBeGreaterThan(baseline);
      // The new validator still earns a 304...
      const hit = await dw.call(`/s/${slug}/${path}`, { headers: { ...NAV, "If-None-Match": etag } });
      expect(hit.status, `${id} current validator revalidates`).toBe(304);
      // ...but a tag-less baseline render never does: its old validator must miss.
      const sha = etag.match(/-([a-f0-9]{64})/)?.[1];
      expect(sha).toBeTruthy();
      const stale = await dw.call(`/s/${slug}/${path}`, { headers: { ...NAV, "If-None-Match": `W/"${id}@${baseline}-${sha}"` } });
      expect(stale.status, `${id} baseline (tag-less) validator must not earn a 304`).toBe(200);
      await stale.text();
    }
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
    const metas = expectUnfurl(html, {
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
    expectUnfurl(await photos.text(), {
      url: `${ORIGIN}/s/${slug}/photos/`,
      kind: /folder|director|listing|files?/i,
      sizes: [/\b2\s*files?\b/i, sizeRe(64)],
    });

    const docs = await dw.call(`/s/${slug}/docs/`, { headers: NAV });
    expect(docs.headers.get("x-kofra-viewer")).toBe("listing");
    // 1 immediate file (50 B) + 1 immediate folder; the nested 70 B file is
    // the deep folder's own listing total, not this one's.
    const metas = expectUnfurl(await docs.text(), {
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
    const metas = expectUnfurl(html, {
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
    expectUnfurl(html, {
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
    expectUnfurl(html, {
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
      const metas = metasIn(headOf(html));
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
    expectUnfurl(await res.text(), {
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
    expectUnfurl(await code.text(), { url: `${base}/dir/code.ts`, kind: /code|typescript/i, sizes: [sizeRe(11)] });

    const pic = await sub.call(`${base}/dir/pic.png`, { headers: NAV });
    expect(pic.headers.get("x-kofra-viewer")).toBe("image");
    expectUnfurl(await pic.text(), { url: `${base}/dir/pic.png`, kind: /image/i, sizes: [sizeRe(32)], image: true });

    const listing = await sub.call(`${base}/dir/`, { headers: NAV });
    expect(listing.headers.get("x-kofra-viewer")).toBe("listing");
    expectUnfurl(await listing.text(), {
      url: `${base}/dir/`,
      kind: /folder|director|listing|files?/i,
      sizes: [/\b2\s*files?\b/i, sizeRe(11 + 32)],
    });

    const root = await sub.call(`${base}/`, { headers: NAV });
    expect(root.headers.get("x-kofra-viewer")).toBe("listing");
    expectUnfurl(await root.text(), {
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
    expectUnfurl(await code.text(), { url: `${base}/code.ts`, kind: /code|typescript/i, sizes: [sizeRe(11)] });

    const pic = await two.call(`${base}/pic.png`, { headers: NAV });
    expect(pic.headers.get("x-kofra-viewer")).toBe("image");
    expectUnfurl(await pic.text(), { url: `${base}/pic.png`, kind: /image/i, sizes: [sizeRe(32)], image: true });
  });
});
