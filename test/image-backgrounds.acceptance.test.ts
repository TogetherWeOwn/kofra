import { beforeAll, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@dropway/core";
import { VIEWERS } from "@dropway/server";
import { freshInstance, form, type Instance } from "./helpers";
import { imageBackgroundFiles } from "./fixtures/image-backgrounds";

/** Protected test-first contract. The builder continues these tests unchanged.
 * Real publish/serve in workerd, paired with the disposable-browser suite under
 * packages/cli/test/encrypted/image-backgrounds.browser.acceptance.test.ts.
 * Breaks caught: missing native choices; a stale pre-feature 304; extra reads;
 * weakening SVG isolation/CSP; changing a non-view representation or its ranges.
 * No implementation imports/diffs, replacement renderer or remote fixture.
 */
const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
const BASE = "/s/background-contract/";
const CHOICES = ["Checker", "Light", "Dark"];
// Literal observed on baseline a67a648; a product CSP edit cannot move both
// sides of the assertion together. The existing serving sandbox is preserved.
const BASELINE_CSP = "default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'unsafe-inline' https:; font-src * data:; frame-src https:; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock";

// Read actual HTML nodes rather than grepping CSS, comments, or stripping tags.
async function nativeChoiceTexts(html: string): Promise<string[]> {
  const texts: string[] = [];
  await new HTMLRewriter().on("label,option", {
    element(element) {
      const index = texts.push("") - 1;
      element.onEndTag(() => { texts[index] = texts[index]!.trim(); });
    },
    text(chunk) {
      if (texts.length) texts[texts.length - 1] += chunk.text;
    },
  }).transform(new Response(html)).text();
  return texts;
}

describe("image stage backgrounds: public serving contracts", () => {
  let dw: Instance;
  const get = (path: string, headers: Record<string, string> = NAV) => dw.call(BASE + path, { headers });
  beforeAll(async () => {
    dw = await freshInstance();
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form(Object.fromEntries(imageBackgroundFiles.map(file => [file.path, file.bytes])), { slug: "background-contract" }),
    });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
  });

  it.each(imageBackgroundFiles)("$path offers exactly named native Checker/Light/Dark choices, including embed", async file => {
    for (const suffix of ["", "?view=1&embed=1"]) {
      const response = await get(file.path + suffix);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kofra-viewer")).toBe(file.viewer);
      const texts = await nativeChoiceTexts(await response.text());
      for (const name of CHOICES) expect(texts.filter(text => text === name), `native ${name} choice for ${file.path}${suffix}`).toHaveLength(1);
    }
  });

  it.each(["light.png", "light.svg"].flatMap(path =>
    ["", "?view=1&embed=1"].flatMap(suffix =>
      [2, 3].map(version => ({ path, suffix, version })),
    ),
  ))("$path (suffix $suffix) rejects pre-background version-$version validators, then revalidates the new page", async ({ path, suffix, version }) => {
    const first = await get(path + suffix);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"(?:image|svg)@\d+-/);
    // Baseline a67a648 used version 2; immediate base 319e1d1 used version 3
    // for both viewers. Preserve bytes, sibling context, URL and embed suffix.
    const former = etag.replace(/@\d+-/, `@${version}-`);
    const conditional = await get(path + suffix, { ...NAV, "If-None-Match": former });
    expect(conditional.status, `former validator ${former} must not retain the checker-only page`).toBe(200);
    expect(conditional.headers.get("etag")).not.toBe(former);
    expect(await nativeChoiceTexts(await conditional.text())).toEqual(expect.arrayContaining(CHOICES));
    expect((await get(path + suffix, { ...NAV, "If-None-Match": etag })).status).toBe(304);
  });

  it.each(imageBackgroundFiles)("$path keeps the existing read budget without decoding or fetching pixels", async file => {
    const viewer = VIEWERS.find(candidate => candidate.id === file.viewer)!;
    const render = viewer.render;
    const reads: Array<{ offset?: number; length?: number }> = [];
    let textReads = 0;
    const spy = vi.spyOn(viewer, "render").mockImplementation(vc => render.call(viewer, {
      ...vc,
      readBytes: (offset, length) => { reads.push({ offset, length }); return vc.readBytes(offset, length); },
      readText: (...args) => { textReads++; return vc.readText(...args); },
    }));
    try {
      const response = await get(file.path);
      expect(response.status).toBe(200);
      await response.text();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(textReads, "SVG stays an img; raster only sniffs its dimension header").toBe(0);
      if (file.viewer === "svg") expect(reads).toEqual([]);
      else {
        expect(reads).toHaveLength(1);
        expect(reads[0]!.offset).toBe(0);
        expect(reads[0]!.length).toBe(Math.min(file.bytes.length, 64 * 1024));
      }
    } finally { spy.mockRestore(); }
  });

  it.each(imageBackgroundFiles)("$path keeps source/alt, metadata, script-free CSP and SVG-through-img isolation", async file => {
    const response = await get(file.path);
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toBe(BASELINE_CSP);
    expect(csp).not.toMatch(/script-src/);
    const html = await response.text();
    const images: Array<{ src: string | null; alt: string | null }> = [];
    const forbidden: string[] = [];
    await new HTMLRewriter()
      .on(".dw-stage img", { element: el => { images.push({ src: el.getAttribute("src"), alt: el.getAttribute("alt") }); } })
      .on("script,canvas,object,embed,iframe,input[type=color]", { element: el => { forbidden.push(el.tagName); } })
      .transform(new Response(html)).text();
    expect(images).toEqual([{ src: `${BASE}${file.path}`, alt: file.path }]);
    expect(forbidden).toEqual([]);
    expect(html).not.toContain("imageBackgroundScriptRan");
    expect(html).not.toMatch(/\bon\w+\s*=/i);
    expect(html).toContain(file.type);
    expect(html).toContain("Actual size");
    if (file.viewer === "image") {
      expect(response.headers.get("x-kofra-image-size")).toBe("1600x1000");
      expect(html).toContain("1,600 × 1,000 px");
    }
    const visibleText = await new HTMLRewriter().on("style", { element: el => { el.remove(); } }).transform(new Response(html)).text();
    // An honest "not an accessibility certification" caveat is allowed;
    // affirmative certification/alpha-detection promises are not.
    expect(visibleText).not.toMatch(/(?:certifies|certified (?:contrast|accessibility)|(?:passes|meets) WCAG|WCAG(?: [\d.A]+)? (?:compliant|certified)|guarantees (?:contrast|accessibility)|detects (?:alpha|transparency)|alpha detected)/i);
    if (file.path === "opaque.png") expect(visibleText).not.toMatch(/(?:this (?:image|file) is transparent|transparency detected)/i);
  });

  it.each(imageBackgroundFiles)("$path does not introduce a background query/cache-state dimension", async file => {
    const normal = await get(file.path);
    const html = await normal.text();
    const etag = normal.headers.get("etag");
    for (const query of ["?background=light", "?background=dark", "?background=%23ff00ff"]) {
      const response = await get(file.path + query);
      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe(etag);
      expect(await response.text()).toBe(html);
      expect((await get(file.path + query, { ...NAV, "If-None-Match": etag! })).status).toBe(304);
    }
  });

  it.each(imageBackgroundFiles)("$path preserves raw/download/subresource/frame bytes, headers, ranges and conditional requests", async file => {
    const sha = await sha256Hex(file.bytes);
    const originalType = file.viewer === "svg" ? "image/svg+xml; charset=utf-8" : file.type;
    const cases = [
      { suffix: "?raw=1", headers: NAV, type: file.viewer === "svg" ? "text/plain; charset=utf-8" : file.type, disposition: "inline" },
      { suffix: "?download=1", headers: NAV, type: originalType, disposition: "attachment" },
      { suffix: "", headers: { Accept: "image/*", "Sec-Fetch-Dest": "image" }, type: originalType, disposition: "inline" },
      { suffix: "", headers: { Accept: "text/html", "Sec-Fetch-Dest": "iframe" }, type: originalType, disposition: "inline" },
    ];
    for (const spec of cases) {
      const response = await get(file.path + spec.suffix, spec.headers);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kofra-viewer")).toBeNull();
      expect(response.headers.get("content-type")).toBe(spec.type);
      expect(response.headers.get("etag")).toBe(`"${sha}"`);
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      if (spec.disposition === "attachment") expect(response.headers.get("content-disposition")).toContain(`attachment; filename="${file.path}"`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(file.bytes);
      const range = await get(file.path + spec.suffix, { ...spec.headers, Range: "bytes=1-16" });
      expect(range.status).toBe(206);
      expect(range.headers.get("content-range")).toBe(`bytes 1-16/${file.bytes.length}`);
      expect(new Uint8Array(await range.arrayBuffer())).toEqual(file.bytes.slice(1, 17));
      expect((await get(file.path + spec.suffix, { ...spec.headers, "If-None-Match": `"${sha}"` })).status).toBe(304);
    }
    // The bare frame remains raw; opt-in embed still renders the same image
    // in its isolated wrapper without the full-page viewer bar/navigation.
    const embedded = await get(`${file.path}?view=1&embed=1`);
    const html = await embedded.text();
    expect(embedded.headers.get("x-kofra-viewer")).toBe(file.viewer);
    expect(html).not.toContain('class="dw-vbar"');
    expect(html).not.toMatch(/rel="(?:prev|next)"/);
    expect(html).toContain(`${BASE}${file.path}`);
  });
});
