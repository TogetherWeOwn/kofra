/**
 * ARCHIVE-ENTRIES acceptance tests (TOG-41691): list entries inside ZIP files
 * without downloading.
 *
 * These tests ARE the spec. They must fail on main (no archive viewer) and
 * the builder makes them pass without editing this file.
 *
 * Viewer contract (builder: implement exactly this):
 * - id "archive", version 1. Matches file.kind === "archive" for every view
 *   mode except "source" (document, frame, view). ?view=source on an archive
 *   keeps returning the raw bytes because no viewer matches it.
 * - Over-cap, corrupt and non-ZIP archives render THROUGH the archive viewer
 *   (x-kofra-viewer stays "archive"): the binary info page (size/type/kind
 *   rows, SHA-256, hex dump, Download) plus a note saying why. So maxBytes
 *   must not exclude big archives from matching; the size cap is enforced in
 *   render(). Never a 500.
 * - Listing: one row per entry with path, uncompressed size and method
 *   (stored/deflated), in central-directory order (not path order); directories
 *   (trailing "/") listed with size 0; a counts line with the total entry
 *   count and total uncompressed bytes; the standard viewer bar with Raw,
 *   Download and Files links; exactly VIEWER_CSP plus the serving layer's
 *   opaque-origin sandbox (no scripts).
 * - Caps: MAX_ARCHIVE_BYTES = 2 MiB parsed, MAX_ENTRIES = 1000 rows shown.
 *   Past the entry cap: "Showing the first 1,000 of N entries".
 * - Cache like every viewer: cachedRender keyed with id + version
 *   ("archive@1/..."), X-Kofra-Render-Cache header; ETag W/"archive@1-<sha>"
 *   (plus -e for &embed=1) so a version bump invalidates old renders.
 * - Escape entry names as text; make no external requests (relative links
 *   plus the absolute app-origin Files link only).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { gzipSync, strToU8, zipSync } from "fflate";
import { contentTypeFor, sha256Hex, type LiveSite } from "@dropway/core";
import { findViewer, formatBytes, toViewerFile, VIEWERS, VIEWER_CSP, type ViewMode } from "@dropway/server";
import { clearRenderMemoryCache } from "../packages/server/src/viewers/cache";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const IFRAME = { Accept: "text/html,*/*", "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate" };

const MAX_ENTRIES = 1000;
const MANY_COUNT = 1200;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const BIG_BYTES = Math.floor(2.5 * 1024 * 1024);

/** Deliberately non-path-sorted: zipSync preserves this central-directory order. */
function mixedZip(): Uint8Array {
  return zipSync({
    "zebra.txt": [strToU8("stripes\n"), { level: 0 }],
    "docs/ünïcode-日本語.txt": [strToU8("unicode content here"), { level: 9 }],
    "a/b/c/deep.txt": [strToU8("deep\n"), { level: 9 }],
    "a/": [new Uint8Array(0), { level: 0 }],
    "a/b/": [new Uint8Array(0), { level: 0 }],
    "empty.txt": [new Uint8Array(0), { level: 0 }],
    "<script>alert(1)</script>.txt": [strToU8("xss\n"), { level: 0 }],
    "hello.txt": [strToU8("Hello, world!\n"), { level: 9 }],
  });
}

const MIXED_NAMES = ["zebra.txt", "docs/ünïcode-日本語.txt", "a/b/c/deep.txt", "a/", "a/b/", "empty.txt", "<script>alert(1)</script>.txt", "hello.txt"];
/** Uncompressed sizes: 8 + 20 + 5 + 0 + 0 + 0 + 4 + 14. */
const MIXED_TOTAL = 51;

function manyZip(): Uint8Array {
  const files: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (let i = 0; i < MANY_COUNT; i++) files[`file-${String(i).padStart(4, "0")}.txt`] = [strToU8("x"), { level: 0 }];
  return zipSync(files);
}

function bigZip(): Uint8Array {
  return zipSync({ "payload.bin": [new Uint8Array(BIG_BYTES), { level: 0 }] });
}

function garbageZip(): Uint8Array {
  const out = new Uint8Array(200);
  for (let i = 0; i < out.length; i++) out[i] = (i * 7 + 3) % 251;
  return out;
}

const BAD_DIRECTORY_CASES = ["offset", "length", "entry-boundary", "zip64", "multidisk"] as const;

/** Mutate directory metadata only; the local headers and payloads stay intact. */
function badDirectoryZip(kind: typeof BAD_DIRECTORY_CASES[number]): Uint8Array {
  const bytes = mixedZip();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22; // zipSync writes an EOCD without a comment.
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const directory = view.getUint32(end + 16, true);
  expect(view.getUint32(directory, true)).toBe(0x02014b50);
  if (kind === "offset") view.setUint32(end + 16, bytes.length + 1, true);
  if (kind === "length") view.setUint32(end + 12, 1, true);
  if (kind === "entry-boundary") view.setUint16(directory + 28, 0xffff, true);
  if (kind === "zip64") view.setUint32(end + 16, 0xffffffff, true);
  if (kind === "multidisk") view.setUint16(end + 4, 1, true);
  return bytes;
}

/** Invalid DEFLATE payload, valid directory: listing must not inflate entries. */
function unreadablePayloadZip(): Uint8Array {
  const bytes = zipSync({ "directory-only.txt": [strToU8("Do not inflate this entry.\n"), { level: 9 }] });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  expect(view.getUint16(8, true)).toBe(8);
  const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  const length = view.getUint32(18, true);
  expect(length).toBeGreaterThan(0);
  bytes.fill(0xff, start, start + length); // Reserved DEFLATE block type, not a valid stream.
  return bytes;
}

/** Minimal valid ustar tar with one file (hand-rolled: no tar writer in deps). */
function tarFixture(): Uint8Array {
  const content = strToU8("Hello tar!\n");
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  const write = (off: number, text: string, len: number) => header.set(enc.encode(text).subarray(0, len), off);
  write(0, "hello.txt", 100);
  write(100, "0000644\0", 8);
  write(108, "0000000\0", 8);
  write(116, "0000000\0", 8);
  write(124, `${content.length.toString(8).padStart(11, "0")}\0`, 12);
  write(136, "00000000000\0", 12);
  header.fill(0x20, 148, 156);
  write(156, "0", 1);
  write(257, "ustar", 6);
  write(263, "00", 2);
  let sum = 0;
  for (const x of header) sum += x;
  write(148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  const body = new Uint8Array(512);
  body.set(content);
  const out = new Uint8Array(512 * 4);
  out.set(header, 0);
  out.set(body, 512);
  return out;
}

const live = (): LiveSite => ({
  v: 2,
  siteId: "site_1",
  slug: "s",
  tenantId: "t",
  versionId: "v",
  spa: false,
  renderMarkdown: true,
  crossOriginIsolation: false,
  passwordHash: null,
  expiresAt: null,
  files: {},
});

describe("archive viewer selection", () => {
  const pick = (path: string, mode: ViewMode, size = 100) => findViewer(toViewerFile(path, "0".repeat(64), size, contentTypeFor(path)), live(), VIEWERS, mode)?.id ?? null;

  it("selects the archive viewer for archives on navigation, in frames and with ?view=1, never for source", () => {
    for (const path of ["a.zip", "a.tar", "a.gz", "a.tgz", "a.7z", "a.rar"]) {
      expect(pick(path, "document")).toBe("archive");
      expect(pick(path, "frame")).toBe("archive");
      expect(pick(path, "view")).toBe("archive");
      expect(pick(path, "source")).toBeNull();
    }
  });

  it("leaves other kinds alone", () => {
    expect(pick("a.png", "document")).toBe("image");
    expect(pick("a.ts", "document")).toBe("code");
    expect(pick("a.bin", "view")).toBe("binary");
    expect(pick("a.bin", "document")).toBeNull();
  });

  it("pins id, version 1, and fallback-through matching past the size cap", () => {
    const archive = VIEWERS.find((v) => v.id === "archive");
    expect(archive).toBeDefined();
    expect(archive!.version).toBe(1);
    // Over-cap files still match: the fallback info page renders through the
    // archive viewer itself (x-kofra-viewer stays "archive").
    const huge = toViewerFile("big.zip", "0".repeat(64), 100 * 1024 * 1024, contentTypeFor("big.zip"));
    expect(archive!.matches(huge, live(), "document")).toBe(true);
    expect(archive!.matches(huge, live(), "view")).toBe(true);
    expect(archive!.matches(huge, live(), "source")).toBe(false);
    const code = toViewerFile("a.ts", "0".repeat(64), 100, contentTypeFor("a.ts"));
    expect(archive!.matches(code, live(), "document")).toBe(false);
  });
});

describe("archive viewer pages", () => {
  let dw: Instance;
  let slug: string;
  const files: Record<string, Uint8Array> = {};

  beforeAll(async () => {
    const mixed = mixedZip();
    files["archives/mixed.zip"] = mixed;
    files["archives/many.zip"] = manyZip();
    files["archives/big.zip"] = bigZip();
    files["archives/truncated.zip"] = mixed.subarray(0, 64);
    files["archives/garbage.zip"] = garbageZip();
    files["archives/a.tar"] = tarFixture();
    files["archives/a.gz"] = gzipSync(strToU8("hello gzip world\n"));
    files["archives/a.7z"] = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    files["archives/a.rar"] = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    files["archives/cache-probe.zip"] = zipSync({ "probe.txt": strToU8("probe\n") });
    files["archives/version-probe.zip"] = zipSync({ "version-probe.txt": strToU8("version cache probe\n") });
    files["archives/unreadable-payload.zip"] = unreadablePayloadZip();
    for (const kind of BAD_DIRECTORY_CASES) files[`archives/bad-directory-${kind}.zip`] = badDirectoryZip(kind);
    expect(files["archives/big.zip"]!.length).toBeGreaterThan(MAX_ARCHIVE_BYTES);
    expect(files["archives/many.zip"]!.length).toBeLessThan(MAX_ARCHIVE_BYTES);

    dw = await freshInstance();
    const res = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({ ...files, "index.html": "<!doctype html><title>Home</title><p>home</p>" }),
    });
    expect(res.status).toBe(201);
    slug = res.body.slug;
  }, 30_000);

  const get = (path: string, headers: Record<string, string> = NAV) => dw.call(`/s/${slug}/${path}`, { headers });
  const shaOf = (b: Uint8Array) => sha256Hex(b);

  it("lists every entry of a multi-entry ZIP in central-directory order with sizes, methods and counts", async () => {
    const res = await get("archives/mixed.zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("archive");
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();

    // Counts: 8 entries, MIXED_TOTAL uncompressed bytes.
    expect(html).toMatch(/8 entries/i);
    expect(html).toContain(formatBytes(MIXED_TOTAL));

    // Every path present (hostile names escaped), every file size present.
    for (const name of MIXED_NAMES) {
      const shown = name.includes("<") ? name.replaceAll("<", "&lt;").replaceAll(">", "&gt;") : name;
      expect(html).toContain(shown);
    }
    for (const size of ["8 B", "20 B", "5 B", "4 B", "14 B", "0 B"]) {
      expect(html).toMatch(new RegExp(`\\b${size.replace(" ", "\\s")}\\b`));
    }

    // Stored and deflated entries both handled and labelled.
    expect(html).toMatch(/stored/i);
    expect(html).toMatch(/deflated/i);

    // Unicode names intact.
    expect(html).toContain("ünïcode-日本語");

    // Compare whole cells, not substring positions: "a/" is also in "a/b/c/deep.txt".
    const expected = MIXED_NAMES.map((name) => name.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
    const paths = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].flatMap(([row]) => {
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(([, cell]) => cell!.replace(/<[^>]*>/g, "").trim());
      return cells.filter((cell) => expected.includes(cell));
    });
    expect(paths).toEqual(expected); // Central-directory insertion order, including directories.

    // The standard bar: Raw, Download and the app viewer.
    expect(html).toContain(`href="/s/${slug}/archives/mixed.zip?raw=1"`);
    expect(html).toContain(`href="/s/${slug}/archives/mixed.zip?download=1"`);
    expect(html).toContain(`href="${ORIGIN}/v/${slug}/archives/mixed.zip"`);

    // Frames get the listing too (nothing embeds a ZIP as bytes).
    expect((await get("archives/mixed.zip", IFRAME)).headers.get("x-kofra-viewer")).toBe("archive");
  });

  it("escapes hostile entry names and keeps the page script-free", async () => {
    const res = await get("archives/mixed.zip");
    const html = await res.text();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;.txt");
    expect(html).not.toContain("<script");
    const csp = res.headers.get("content-security-policy")!;
    const directives = csp.split(";").map((part) => part.trim()).filter(Boolean);
    const sandbox = directives.filter((part) => /^sandbox(?:\s|$)/.test(part));
    expect(sandbox).toHaveLength(1);
    expect(sandbox[0]).not.toContain("allow-same-origin");
    expect(directives.filter((part) => !/^sandbox(?:\s|$)/.test(part))).toEqual(VIEWER_CSP.split(";").map((part) => part.trim()));
    expect(csp).not.toContain("script-src");
  });

  it("?view=1 renders the same listing; &embed=1 drops the bar", async () => {
    const res = await get("archives/mixed.zip?view=1");
    expect(res.headers.get("x-kofra-viewer")).toBe("archive");
    const html = await res.text();
    expect(html).toMatch(/8 entries/i);
    expect(html).toContain('class="dw-vbar"');
    const embed = await get("archives/mixed.zip?view=1&embed=1");
    expect(await embed.text()).not.toContain('class="dw-vbar"');
    expect(embed.headers.get("etag")).toMatch(/-e"$/);
  });

  it("renders deterministically", async () => {
    const a = await (await get("archives/mixed.zip")).text();
    const b = await (await get("archives/mixed.zip?view=1")).text();
    // Same bytes, same listing fragment: bar links differ only by tab state, entries identical.
    for (const name of ["zebra.txt", "hello.txt", "a/b/c/deep.txt", "empty.txt"]) {
      expect(a).toContain(name);
      expect(b).toContain(name);
    }
    const c = await (await get("archives/mixed.zip")).text();
    expect(c).toBe(a);
  });

  it("truncates past 1,000 entries with a notice", async () => {
    const res = await get("archives/many.zip?view=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("archive");
    const html = await res.text();
    expect(html).toMatch(new RegExp(`showing the first ${MAX_ENTRIES.toLocaleString("en-US")} of ${MANY_COUNT.toLocaleString("en-US")} entries`, "i"));
    expect(html).toContain("file-0000.txt");
    expect(html).toContain("file-0999.txt");
    expect(html).not.toContain("file-1000.txt");
    expect(html).not.toContain("file-1199.txt");
  });

  it("falls back to the binary info page with a note past the size cap", async () => {
    for (const path of ["archives/big.zip?view=1", "archives/big.zip"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-kofra-viewer")).toBe("archive");
      const html = await res.text();
      expect(html).toContain("SHA-256");
      expect(html).toMatch(/First \d+ bytes/);
      expect(html).toContain("Download");
      expect(html).toMatch(/too large/i);
    }
  });

  it("falls back with a note for truncated, corrupt and non-ZIP archives, never a 500", async () => {
    const cases: Array<{ path: string; note: RegExp }> = [
      { path: "archives/truncated.zip", note: /invalid|corrupt|could not be read|truncated/i },
      { path: "archives/garbage.zip", note: /invalid|corrupt|could not be read|truncated/i },
      { path: "archives/a.tar", note: /only ZIP|not a ZIP/i },
      { path: "archives/a.gz", note: /only ZIP|not a ZIP/i },
      { path: "archives/a.7z", note: /only ZIP|not a ZIP/i },
      { path: "archives/a.rar", note: /only ZIP|not a ZIP/i },
    ];
    for (const { path, note } of cases) {
      for (const url of [`${path}?view=1`, path]) {
        const res = await get(url);
        expect(res.status).toBe(200);
        expect(res.headers.get("x-kofra-viewer")).toBe("archive");
        const html = await res.text();
        expect(html).toContain("SHA-256");
        expect(html).toMatch(/First \d+ bytes/);
        expect(html).toMatch(note);
      }
    }
  });

  it.each(BAD_DIRECTORY_CASES)("falls back for %s directory metadata instead of reading outside its bounds", async (kind) => {
    for (const suffix of ["", "?view=1"]) {
      const res = await get(`archives/bad-directory-${kind}.zip${suffix}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-kofra-viewer")).toBe("archive");
      const html = await res.text();
      expect(html).toContain("SHA-256");
      expect(html).toMatch(/First \d+ bytes/);
      expect(html).toMatch(/invalid|corrupt|could not be read|truncated|unsupported|not supported|ZIP64|multi.?disk/i);
      expect(html).not.toContain("zebra.txt"); // No partially trusted directory listing.
    }
  });

  it("lists directory metadata even when the entry payload cannot be inflated", async () => {
    const res = await get("archives/unreadable-payload.zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("archive");
    const html = await res.text();
    expect(html).toMatch(/1 entr(?:y|ies)/i);
    expect(html).toContain("directory-only.txt");
    expect(html).toContain("27 B");
    expect(html).toMatch(/deflated/i);
    expect(html).not.toContain("SHA-256"); // A real listing, not the binary fallback.
  });

  it("serves sub-resource requests as byte-identical ZIPs without a viewer", async () => {
    for (const path of ["archives/mixed.zip", "archives/big.zip"]) {
      for (const headers of [
        { Accept: "*/*", "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors" },
        { Accept: "image/avif,image/webp,*/*;q=0.8", "Sec-Fetch-Dest": "image", "Sec-Fetch-Mode": "no-cors" },
      ]) {
        const res = await get(path, headers);
        expect(res.status).toBe(200);
        expect(res.headers.get("x-kofra-viewer")).toBeNull();
        expect(res.headers.get("x-kofra-render-cache")).toBeNull();
        expect(res.headers.get("content-type")).toContain("application/zip");
        expect(await shaOf(new Uint8Array(await res.arrayBuffer()))).toBe(await shaOf(files[path]!));
      }
    }
  });

  it("?raw=1 and ?download=1 stay byte-identical; ?view=source stays raw", async () => {
    for (const path of ["archives/mixed.zip", "archives/big.zip"]) {
      const want = await shaOf(files[path]!);
      const raw = await get(`${path}?raw=1`);
      expect(raw.headers.get("x-kofra-viewer")).toBeNull();
      expect(await shaOf(new Uint8Array(await raw.arrayBuffer()))).toBe(want);
      const dl = await get(`${path}?download=1`);
      expect(dl.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(await shaOf(new Uint8Array(await dl.arrayBuffer()))).toBe(want);
    }
    const src = await get("archives/mixed.zip?view=source");
    expect(src.headers.get("x-kofra-viewer")).toBeNull();
    expect(await shaOf(new Uint8Array(await src.arrayBuffer()))).toBe(await shaOf(files["archives/mixed.zip"]!));
  });

  it("caches renders by content and rejects another viewer's ETag", async () => {
    clearRenderMemoryCache();
    const sha = await shaOf(files["archives/cache-probe.zip"]!);
    const first = await get("archives/cache-probe.zip");
    expect(first.headers.get("x-kofra-viewer")).toBe("archive");
    expect(first.headers.get("x-kofra-render-cache")).toBe("miss");
    const second = await get("archives/cache-probe.zip");
    expect(second.headers.get("x-kofra-render-cache")).toBe("memory");

    const etag = second.headers.get("etag")!;
    expect(etag).toBe(`W/"archive@1-${sha}"`);
    expect((await get("archives/cache-probe.zip", { ...NAV, "If-None-Match": etag })).status).toBe(304);
    // This checks viewer identity, not a version bump (covered separately below).
    expect((await get("archives/cache-probe.zip", { ...NAV, "If-None-Match": `W/"binary@1-${sha}"` })).status).toBe(200);
  });

  it("regenerates the cached fragment and ETag after an actual archive viewer version bump", async () => {
    const archive = VIEWERS.find((viewer) => viewer.id === "archive");
    expect(archive).toBeDefined();
    const version = archive!.version;
    const render = archive!.render;
    let byteReads = 0;
    // Keep the real renderer and real R2 bytes; observe whether a new fragment is produced.
    const spy = vi.spyOn(archive!, "render").mockImplementation((vc) => render.call(archive, {
      ...vc,
      readBytes: async (offset, length) => {
        byteReads++;
        return vc.readBytes(offset, length);
      },
    }));
    try {
      clearRenderMemoryCache();
      const sha = await shaOf(files["archives/version-probe.zip"]!);
      const first = await get("archives/version-probe.zip");
      expect(first.status).toBe(200);
      expect(first.headers.get("etag")).toBe(`W/"archive@1-${sha}"`);
      expect(first.headers.get("x-kofra-render-cache")).toBe("miss");
      expect(await first.text()).toContain("version-probe.txt");
      const warm = await get("archives/version-probe.zip");
      expect(warm.headers.get("x-kofra-render-cache")).toBe("memory");
      const oldEtag = warm.headers.get("etag")!;
      expect((await get("archives/version-probe.zip", { ...NAV, "If-None-Match": oldEtag })).status).toBe(304);

      archive!.version = 2; // Same viewer id, URL and content hash; only its version changes.
      byteReads = 0;
      const bumped = await get("archives/version-probe.zip", { ...NAV, "If-None-Match": oldEtag });
      expect(bumped.status).toBe(200);
      expect(bumped.headers.get("etag")).toBe(`W/"archive@2-${sha}"`);
      expect(bumped.headers.get("x-kofra-render-cache")).toBe("miss");
      expect(await bumped.text()).toContain("version-probe.txt");
      expect(byteReads).toBeGreaterThan(0); // Not just a new header on the old fragment.
      const bumpedWarm = await get("archives/version-probe.zip");
      expect(bumpedWarm.headers.get("x-kofra-render-cache")).toBe("memory");
      expect((await get("archives/version-probe.zip", { ...NAV, "If-None-Match": bumpedWarm.headers.get("etag")! })).status).toBe(304);
      const embed = await get("archives/version-probe.zip?view=1&embed=1", { ...NAV, "If-None-Match": `W/"archive@1-${sha}-e"` });
      expect(embed.status).toBe(200);
      expect(embed.headers.get("etag")).toBe(`W/"archive@2-${sha}-e"`);

      // Drop only isolate memory: v2 must also have its own edge-cache fragment.
      clearRenderMemoryCache();
      const edge = await get("archives/version-probe.zip");
      expect(edge.headers.get("x-kofra-render-cache")).toBe("edge");
      expect(edge.headers.get("etag")).toBe(`W/"archive@2-${sha}"`);
      expect(await edge.text()).toContain("version-probe.txt");
    } finally {
      archive!.version = version;
      spy.mockRestore();
      clearRenderMemoryCache();
    }
  });

  it("makes no external requests", async () => {
    for (const path of ["archives/mixed.zip?view=1", "archives/big.zip?view=1", "archives/a.tar?view=1"]) {
      const html = await (await get(path)).text();
      const absolute = html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
      for (const url of absolute) expect(url.startsWith(ORIGIN)).toBe(true);
      expect(html).not.toContain("<script");
    }
  });
});
