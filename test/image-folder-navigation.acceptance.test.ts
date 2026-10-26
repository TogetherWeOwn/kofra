import { beforeAll, describe, expect, it } from "vitest";
import { encodePath } from "@dropway/core";
import { VIEWER_CSP } from "@dropway/server";
import { freshInstance, jsonBody, type Instance } from "./helpers";
import { b64 } from "./mcp-helpers";

/**
 * Acceptance contract: previous/next navigation between the images of one
 * folder, from inside the image and SVG viewers.
 *
 * - When the opened file's folder holds other image/SVG files, the existing
 *   media bar shows plain-link Previous / Next controls naming the adjacent
 *   file, plus a position readout ("3 of 12"). Sibling order is the folder
 *   listing's name order (`localeCompare` on the file name, same folder
 *   only). At either end the missing direction is omitted; never wrap.
 * - Links are ordinary same-origin file URLs for the neighbour (a document
 *   navigation, so its own viewer renders), carry `rel="prev"` /
 *   `rel="next"`, and need no JavaScript, no new endpoint and no CSP change.
 * - Hidden in embed mode and absent for a lone image. Tabs, the zoom
 *   toggle, dimensions metadata and `X-Kofra-Image-Size` are preserved;
 *   raw/download bytes are untouched.
 * - A republish that adds or removes a sibling must not answer a
 *   conditional request with stale navigation: neighbour identity
 *   participates in the rendered page's ETag, and the image/SVG viewer
 *   versions are bumped past 1 because their cached markup changes.
 * - Password-gated sites gain no new access path and leak no sibling
 *   names; path, subdomain and sandboxed serving all keep working.
 *
 * These tests drive the real Worker in workerd through the public publish
 * and serving surfaces. They are expected to fail until the feature lands.
 */

const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

/** Minimal PNG header (IHDR width/height) with a tag byte so each file hashes differently. */
function pngBytes(width: number, height: number, tag = 0): Uint8Array {
  const b = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0, 0, 0, 0, 0, 8, 2, 0, 0, 0, tag]);
  b[16] = (width >>> 24) & 0xff;
  b[17] = (width >>> 16) & 0xff;
  b[18] = (width >>> 8) & 0xff;
  b[19] = width & 0xff;
  b[20] = (height >>> 24) & 0xff;
  b[21] = (height >>> 16) & 0xff;
  b[22] = (height >>> 8) & 0xff;
  b[23] = height & 0xff;
  return b;
}

/** Minimal GIF header (logical screen width/height, little-endian). */
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]);

const svgText = (marker: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>${marker}</script><rect width="10" height="10"/></svg>`;

type PubFile = { path: string; content: string; encoding?: "base64" };
const pngFile = (path: string, bytes: Uint8Array): PubFile => ({ path, content: b64(bytes), encoding: "base64" });
const binFile = pngFile;
const textFile = (path: string, content: string): PubFile => ({ path, content });

async function publish(dw: Instance, slug: string, files: PubFile[]): Promise<void> {
  const res = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ slug, files }) });
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  expect(res.body.slug).toBe(slug);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

interface Anchor {
  attrs: string;
  href: string | null;
  rel: string[];
  /** Accessible name: aria-label, title and visible text, entity-decoded. */
  label: string;
  index: number;
}

function anchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1]!;
    const attr = (name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
    const href = attr("href");
    const text = m[2]!.replace(/<[^>]*>/g, " ");
    const label = decodeEntities([attr("aria-label"), attr("title"), text].filter(Boolean).join(" ").replace(/\s+/g, " ").trim());
    out.push({
      attrs,
      href: href === null ? null : decodeEntities(href),
      rel: (attr("rel") ?? "").split(/\s+/).filter(Boolean),
      label,
      index: m.index,
    });
  }
  return out;
}

const navLink = (html: string, rel: "prev" | "next"): Anchor | undefined => anchors(html).find((a) => a.rel.includes(rel));

/** The media bar region: from the dw-mediabar element to the stage that follows it. */
function mediaBarRegion(html: string): string {
  const start = html.indexOf("dw-mediabar");
  expect(start, "page has a media bar").toBeGreaterThanOrEqual(0);
  const stage = html.indexOf("dw-stage", start);
  expect(stage, "page has a stage after the media bar").toBeGreaterThan(start);
  return html.slice(start, stage);
}

const regionText = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));

/** Assert the media bar holds the expected Previous/Next links and position readout. */
function expectFolderNav(
  html: string,
  opts: {
    base: string;
    prevPath?: string;
    nextPath?: string;
    position: number;
    total: number;
  },
): { prev?: Anchor; next?: Anchor } {
  const bar = mediaBarRegion(html);
  const prev = navLink(html, "prev");
  const next = navLink(html, "next");

  if (opts.prevPath === undefined) {
    expect(prev, "no Previous link at the start of the folder").toBeUndefined();
  } else {
    expect(prev, "Previous link is present").toBeDefined();
    expect(prev!.href).toBe(`${opts.base}${encodePath(opts.prevPath)}`);
    expect(prev!.label).toMatch(/previous/i);
    expect(prev!.label).toContain(opts.prevPath.split("/").pop()!);
  }
  if (opts.nextPath === undefined) {
    expect(next, "no Next link at the end of the folder").toBeUndefined();
  } else {
    expect(next, "Next link is present").toBeDefined();
    expect(next!.href).toBe(`${opts.base}${encodePath(opts.nextPath)}`);
    expect(next!.label).toMatch(/next/i);
    expect(next!.label).toContain(opts.nextPath.split("/").pop()!);
  }

  for (const link of [prev, next]) {
    if (!link) continue;
    // Plain, keyboard-focusable links inside the media bar: an <a href>
    // with no negative tabindex, no script handlers.
    expect(link.href).toBeTruthy();
    expect(link.attrs).not.toMatch(/tabindex\s*=\s*"-\d"/);
    expect(link.attrs).not.toMatch(/\bon\w+\s*=/);
    expect(link.index).toBeGreaterThan(html.indexOf("dw-mediabar"));
    expect(link.index).toBeLessThan(html.indexOf("dw-stage", html.indexOf("dw-mediabar")));
  }
  if (prev && next) expect(prev.index).toBeLessThan(next.index);

  expect(regionText(bar)).toContain(`${opts.position} of ${opts.total}`);
  return { prev, next };
}

function expectNoFolderNav(html: string): void {
  expect(navLink(html, "prev"), "no Previous link").toBeUndefined();
  expect(navLink(html, "next"), "no Next link").toBeUndefined();
  expect(regionText(mediaBarRegion(html))).not.toMatch(/\b\d+ of \d+\b/);
}

describe("image/SVG folder navigation (path mode)", () => {
  let dw: Instance;
  const SLUG = "nav-pics";
  const BASE = `/s/${SLUG}/`;
  const CAT_PNG = pngBytes(64, 32, 3);
  const ANT_PNG = pngBytes(10, 10, 1);

  const get = (path: string, headers: Record<string, string> = NAV) => dw.call(`${BASE}${encodePath(path)}`, { headers });
  const getHtml = async (path: string, headers: Record<string, string> = NAV) => {
    const res = await get(path, headers);
    expect(res.status, path).toBe(200);
    return res.text();
  };

  beforeAll(async () => {
    dw = await freshInstance();
    await publish(dw, SLUG, [
      // Five image/SVG files; text, video and PDF neighbours never count.
      pngFile("five/01-ant.png", ANT_PNG),
      textFile("five/02-bee.svg", svgText("bee-marker")),
      pngFile("five/03-cat.png", CAT_PNG),
      textFile("five/04-dog.txt", "not an image"),
      binFile("five/05-eel.mp4", new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])),
      pngFile("five/06-fox.png", pngBytes(20, 20, 6)),
      textFile("five/07-gnu.pdf", "%PDF-1.4\n%fake\n"),
      binFile("five/08-hen.gif", GIF),
      // A two-file folder: one image, one SVG.
      pngFile("two/a.png", pngBytes(11, 11, 1)),
      textFile("two/b.svg", svgText("two-b-marker")),
      // A lone image among non-images.
      pngFile("lone/only.png", pngBytes(12, 12, 1)),
      textFile("lone/readme.txt", "alone"),
      binFile("lone/clip.mp4", new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])),
      // Nested folders: siblings only, never recursion.
      pngFile("nested/top-a.png", pngBytes(13, 13, 1)),
      pngFile("nested/top-b.png", pngBytes(13, 13, 2)),
      pngFile("nested/sub/deep-a.png", pngBytes(14, 14, 1)),
      pngFile("nested/sub/deep-b.png", pngBytes(14, 14, 2)),
      pngFile("nested/sub/deeper/deepest.png", pngBytes(15, 15, 1)),
      // Case-mixed names: listing order is localeCompare, not code units.
      pngFile("case/Bravo.png", pngBytes(16, 16, 1)),
      pngFile("case/alpha.png", pngBytes(16, 16, 2)),
      textFile("case/Charlie.svg", svgText("charlie-marker")),
      // Hostile and unicode names in a folder whose name needs encoding.
      pngFile("my pics/a & b.png", pngBytes(17, 17, 1)),
      textFile("my pics/café ☕.svg", svgText("cafe-marker")),
      pngFile(`my pics/x <tag> "q" 's #1?.png`, pngBytes(17, 17, 2)),
      // Images at the site root form their own pool.
      pngFile("root-a.png", pngBytes(18, 18, 1)),
      pngFile("root-b.png", pngBytes(18, 18, 2)),
      textFile("index.html", "<!doctype html><title>Home</title><p>home</p>"),
    ]);
  });

  it("shows Previous/Next naming the neighbours and the position, skipping non-images", async () => {
    const res = await get("five/03-cat.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("image");
    // Dimensions metadata and header survive.
    expect(res.headers.get("x-kofra-image-size")).toBe("64x32");
    const html = await res.text();

    expectFolderNav(html, { base: BASE, prevPath: "five/02-bee.svg", nextPath: "five/06-fox.png", position: 3, total: 5 });

    const bar = regionText(mediaBarRegion(html));
    expect(bar).not.toContain("04-dog.txt");
    expect(bar).not.toContain("05-eel.mp4");
    expect(bar).not.toContain("07-gnu.pdf");
    expect(bar).toContain("64 × 32 px");

    // Existing chrome is preserved: zoom toggle, tabs, download, files.
    expect(html).toContain('id="dw-zoom"');
    expect(html).toContain('for="dw-zoom"');
    expect(html).toContain("Actual size");
    expect(html).toContain(`<img src="${BASE}five/03-cat.png"`);
    expect(html).toContain(">Image</a>");
    expect(html).toContain(`href="${BASE}five/03-cat.png?raw=1"`);
    expect(html).toContain(`href="${BASE}five/03-cat.png?download=1"`);
    expect(html).toContain(`href="https://dropway.test/v/${SLUG}/five/03-cat.png"`);
  });

  it("omits the missing direction at either end and never wraps around", async () => {
    const first = await getHtml("five/01-ant.png");
    expectFolderNav(first, { base: BASE, nextPath: "five/02-bee.svg", position: 1, total: 5 });
    expect(regionText(mediaBarRegion(first))).not.toContain("08-hen.gif");

    const last = await getHtml("five/08-hen.gif");
    expectFolderNav(last, { base: BASE, prevPath: "five/06-fox.png", position: 5, total: 5 });
    expect(regionText(mediaBarRegion(last))).not.toContain("01-ant.png");
  });

  it("flips through the whole folder by following the plain links", async () => {
    const order = ["five/01-ant.png", "five/02-bee.svg", "five/03-cat.png", "five/06-fox.png", "five/08-hen.gif"];
    let html = await getHtml(order[0]!);
    for (let i = 1; i < order.length; i++) {
      const next = navLink(html, "next");
      expect(next, `next from ${order[i - 1]}`).toBeDefined();
      const res = await dw.call(next!.href!, { headers: NAV });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-kofra-viewer")).toBe(order[i]!.endsWith(".svg") ? "svg" : "image");
      html = await res.text();
      expect(regionText(mediaBarRegion(html))).toContain(`${i + 1} of ${order.length}`);
    }
    expect(navLink(html, "next")).toBeUndefined();
    const back = navLink(html, "prev");
    expect(back!.href).toBe(`${BASE}${encodePath(order[order.length - 2]!)}`);
  });

  it("works in a two-file folder, from the SVG side too, with its Source tab intact", async () => {
    const png = await getHtml("two/a.png");
    expectFolderNav(png, { base: BASE, nextPath: "two/b.svg", position: 1, total: 2 });

    const res = await get("two/b.svg");
    expect(res.headers.get("x-kofra-viewer")).toBe("svg");
    const svg = await res.text();
    expectFolderNav(svg, { base: BASE, prevPath: "two/a.png", position: 2, total: 2 });
    // Shown through <img>: the SVG's own script text never reaches the page.
    expect(svg).not.toContain("two-b-marker");
    expect(svg).toContain('id="dw-zoom"');
    expect(svg).toContain(`href="${BASE}two/b.svg?view=source"`);
    expect(svg).toContain(">Source</a>");
    expect((await dw.call(`${BASE}two/b.svg?view=source`, { headers: NAV })).headers.get("x-kofra-viewer")).toBe("source");
  });

  it("shows no navigation for a lone image", async () => {
    const html = await getHtml("lone/only.png");
    expectNoFolderNav(html);
    expect(html).toContain('id="dw-zoom"');
    expect(html).toContain("Actual size");
  });

  it("counts same-folder siblings only in nested folders", async () => {
    const top = await getHtml("nested/top-a.png");
    expectFolderNav(top, { base: BASE, nextPath: "nested/top-b.png", position: 1, total: 2 });
    expect(regionText(mediaBarRegion(top))).not.toContain("deep-a.png");

    const deep = await getHtml("nested/sub/deep-b.png");
    expectFolderNav(deep, { base: BASE, prevPath: "nested/sub/deep-a.png", position: 2, total: 2 });
    expect(regionText(mediaBarRegion(deep))).not.toContain("top-b.png");
    expect(regionText(mediaBarRegion(deep))).not.toContain("deepest.png");

    expectNoFolderNav(await getHtml("nested/sub/deeper/deepest.png"));
  });

  it("treats the site root as its own folder", async () => {
    const html = await getHtml("root-a.png");
    expectFolderNav(html, { base: BASE, nextPath: "root-b.png", position: 1, total: 2 });
  });

  it("orders siblings by localeCompare on the file name, like the listing", async () => {
    const names = ["Bravo.png", "alpha.png", "Charlie.svg"];
    const order = [...names].sort((a, b) => a.localeCompare(b));
    const html = await getHtml(`case/${order[1]!}`);
    expectFolderNav(html, { base: BASE, prevPath: `case/${order[0]!}`, nextPath: `case/${order[2]!}`, position: 2, total: 3 });
  });

  it("escapes hostile names and encodes neighbour URLs exactly like the listing", async () => {
    const hostile = `x <tag> "q" 's #1?.png`;
    const html = await getHtml("my pics/café ☕.svg");
    expectFolderNav(html, {
      base: BASE,
      prevPath: "my pics/a & b.png",
      nextPath: `my pics/${hostile}`,
      position: 2,
      total: 3,
    });
    // The hostile name is text, never markup, and cannot break out of the href.
    expect(html).not.toContain("<tag>");
    expect(mediaBarRegion(html)).toContain("&lt;tag&gt;");
    expect(mediaBarRegion(html)).not.toContain(`href="/s/${SLUG}/my pics/`);

    // Parity: the listing's own link to the same neighbour is byte-identical.
    const listing = await getHtml("my pics/");
    const listingHref = anchors(listing).find((a) => a.href?.endsWith(encodeURIComponent(hostile)))?.href;
    expect(listingHref).toBe(`${BASE}${encodePath(`my pics/${hostile}`)}`);
    expect(navLink(html, "next")!.href).toBe(listingHref);

    // Following the encoded link renders that file's own viewer.
    const res = await dw.call(navLink(html, "next")!.href!, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("image");
    expectFolderNav(await res.text(), { base: BASE, prevPath: "my pics/café ☕.svg", position: 3, total: 3 });
  });

  it("hides navigation in embed mode, where the app-origin browser owns it", async () => {
    const res = await dw.call(`${BASE}five/03-cat.png?view=1&embed=1`, { headers: NAV });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('class="dw-vbar"');
    expectNoFolderNav(html);
  });

  it("adds no script and no CSP change; raw, download and sub-resource bytes are untouched", async () => {
    const res = await get("five/01-ant.png");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain(VIEWER_CSP);
    expect(csp).not.toMatch(/script-src/);
    // Path mode on the app origin stays sandboxed, exactly as before.
    expect(csp).toContain("; sandbox");
    const html = await res.text();
    expect(html.toLowerCase()).not.toContain("<script");
    // Narrow layouts keep working through the existing wrapping media bar.
    expect(html).toContain(".dw-mediabar{display:flex");
    expect(html).toContain("flex-wrap:wrap");
    expect(html).toContain("@media (max-width:640px)");
    expectFolderNav(html, { base: BASE, nextPath: "five/02-bee.svg", position: 1, total: 5 });

    const raw = await dw.call(`${BASE}five/01-ant.png?raw=1`, { headers: NAV });
    expect(raw.headers.get("x-kofra-viewer")).toBeNull();
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(ANT_PNG);

    const download = await dw.call(`${BASE}five/01-ant.png?download=1`, { headers: NAV });
    expect(download.headers.get("x-kofra-viewer")).toBeNull();
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(ANT_PNG);

    const subresource = await get("five/01-ant.png", { "Sec-Fetch-Dest": "image", Accept: "image/*" });
    expect(subresource.headers.get("x-kofra-viewer")).toBeNull();
    expect(new Uint8Array(await subresource.arrayBuffer())).toEqual(ANT_PNG);
  });

  it("bumps the image and SVG viewer versions in the ETag, since their markup changed", async () => {
    const imageEtag = (await get("five/03-cat.png")).headers.get("etag")!;
    const imageVersion = Number(imageEtag.match(/^W\/"image@(\d+)-/)?.[1]);
    expect(imageVersion, imageEtag).toBeGreaterThanOrEqual(2);

    const svgEtag = (await get("two/b.svg")).headers.get("etag")!;
    const svgVersion = Number(svgEtag.match(/^W\/"svg@(\d+)-/)?.[1]);
    expect(svgVersion, svgEtag).toBeGreaterThanOrEqual(2);
  });
});

describe("conditional requests after a republish", () => {
  let dw: Instance;
  const SLUG = "nav-cache";
  const BASE = `/s/${SLUG}/`;
  const B = pngBytes(30, 30, 2);
  const C = pngBytes(30, 30, 3);
  const A = pngBytes(30, 30, 1);

  const getMid = (headers: Record<string, string> = NAV) => dw.call(`${BASE}pics/b-mid.png`, { headers });

  beforeAll(async () => {
    dw = await freshInstance();
  });

  it("never answers If-None-Match with stale Previous/Next after siblings change", async () => {
    await publish(dw, SLUG, [pngFile("pics/b-mid.png", B), pngFile("pics/c-last.png", C)]);

    const v1 = await getMid();
    expect(v1.status).toBe(200);
    const etag1 = v1.headers.get("etag")!;
    expect(etag1).toBeTruthy();
    expectFolderNav(await v1.text(), { base: BASE, nextPath: "pics/c-last.png", position: 1, total: 2 });

    // An unchanged page still revalidates as 304.
    expect((await getMid({ ...NAV, "If-None-Match": etag1 })).status).toBe(304);

    // Republish with an earlier-sorting sibling; b-mid.png bytes are identical.
    await publish(dw, SLUG, [pngFile("pics/a-first.png", A), pngFile("pics/b-mid.png", B), pngFile("pics/c-last.png", C)]);
    const v2 = await getMid({ ...NAV, "If-None-Match": etag1 });
    expect(v2.status, "stale navigation must not be revalidated").toBe(200);
    const etag2 = v2.headers.get("etag")!;
    expect(etag2).not.toBe(etag1);
    expectFolderNav(await v2.text(), { base: BASE, prevPath: "pics/a-first.png", nextPath: "pics/c-last.png", position: 2, total: 3 });
    expect((await getMid({ ...NAV, "If-None-Match": etag2 })).status).toBe(304);

    // Removing a sibling also invalidates the old validator.
    await publish(dw, SLUG, [pngFile("pics/a-first.png", A), pngFile("pics/b-mid.png", B)]);
    const v3 = await getMid({ ...NAV, "If-None-Match": etag2 });
    expect(v3.status, "removed neighbour must not be revalidated").toBe(200);
    expect(v3.headers.get("etag")).not.toBe(etag2);
    expectFolderNav(await v3.text(), { base: BASE, prevPath: "pics/a-first.png", position: 2, total: 2 });
  });
});

describe("password-gated sites gain no new access path (path mode)", () => {
  let dw: Instance;
  const SLUG = "nav-locked";
  const BASE = `/s/${SLUG}/`;

  beforeAll(async () => {
    dw = await freshInstance();
    await publish(dw, SLUG, [
      pngFile("pics/a.png", pngBytes(40, 40, 1)),
      pngFile("pics/b.png", pngBytes(40, 40, 2)),
      pngFile("pics/c.png", pngBytes(40, 40, 3)),
    ]);
    const lock = await dw.json(`/api/v1/sites/${SLUG}/access`, {
      method: "PUT",
      key: dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "password", password: "secret1" }),
    });
    expect(lock.status).toBe(200);
  });

  it("leaks no sibling names or navigation before unlock, and navigates after it", async () => {
    const gated = await dw.call(`${BASE}pics/b.png`, { headers: NAV });
    expect(gated.headers.get("x-kofra-viewer")).toBeNull();
    const gatedBody = await gated.text();
    expect(gatedBody).not.toContain('rel="prev"');
    expect(gatedBody).not.toContain('rel="next"');
    expect(gatedBody).not.toContain("2 of 3");
    expect(gatedBody).not.toContain("pics/a.png");
    expect(gatedBody).not.toContain("pics/c.png");

    const unlock = await dw.call(`${BASE}__dropway/password`, {
      method: "POST",
      headers: { ...NAV, "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
      body: `password=secret1&next=${encodeURIComponent(`${BASE}pics/b.png`)}`,
    });
    expect(unlock.status).toBe(303);
    const cookie = unlock.headers.get("set-cookie")!.split(";")[0]!;

    const res = await dw.call(`${BASE}pics/b.png`, { headers: { ...NAV, Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("image");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expectFolderNav(await res.text(), { base: BASE, prevPath: "pics/a.png", nextPath: "pics/c.png", position: 2, total: 3 });
  });
});

describe("subdomain mode", () => {
  let dw: Instance;
  const SLUG = "nav-sub";
  const ORIGIN = `https://${SLUG}.sites.test`;

  beforeAll(async () => {
    dw = await freshInstance({ appOrigin: "https://app.test", sitesMode: "subdomain", sitesDomain: "sites.test" });
    await publish(dw, SLUG, [
      pngFile("pics/a.png", pngBytes(50, 50, 1)),
      pngFile("pics/b.png", pngBytes(50, 50, 2)),
      textFile("pics/c.svg", svgText("sub-c-marker")),
    ]);
  });

  it("links neighbours with same-origin file URLs on the site's own origin", async () => {
    const res = await dw.call(`${ORIGIN}/pics/b.png`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("image");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain(VIEWER_CSP);
    expect(csp).not.toMatch(/script-src/);
    const html = await res.text();
    expectFolderNav(html, { base: "/", prevPath: "pics/a.png", nextPath: "pics/c.svg", position: 2, total: 3 });

    const next = navLink(html, "next")!;
    const followed = await dw.call(`${ORIGIN}${next.href}`, { headers: NAV });
    expect(followed.headers.get("x-kofra-viewer")).toBe("svg");
    expectFolderNav(await followed.text(), { base: "/", prevPath: "pics/b.png", position: 3, total: 3 });
  });
});
