/**
 * Protected paired acceptance tests. Run against disposable workerd bindings.
 * Folder listings omit Phone. Preview addresses omit Phone rather than encode
 * a preview or grant. File QR payloads are independently decoded in the browser
 * companion; these tests pin serving, safety, validators and byte identity.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex, type LiveSite } from "@dropway/core";
import { VIEWERS, type ViewerContext } from "@dropway/server";
import { viewerBar } from "../packages/server/src/viewers/chrome";
import { viewerPhone } from "../packages/server/src/viewers/phone";
import { form, freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
const files = {
  "notes.md": "# Phone handoff\n\nThe same public file on another device.\n",
  "data.json": '{"phone":"public"}\n',
  "table.csv": "name,value\nphone,1\n",
  "plain.txt": "Original text, not a QR image.\n",
  "page.html": "<!doctype html><title>Original</title><p>Original page</p>",
  "folder/child.txt": "Folder child\n",
  'folder/雪 & <phone> "quote" #?.md': "# Hostile filename, inert chrome\n",
};
// One image per folder, so folderNavEtag adds no suffix and the validator
// main issued is exactly `W/"<id>@<version>-<sha256>"`.
const media = {
  "vector/shape.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>\n',
  "raster/pixel.png": "not really a png; the image viewer renders without dimensions\n",
};
const fixtures: Record<string, string> = { ...files, ...media,
  "sample.pdf": "%PDF-1.4 fixture", "sample.mp4": "video fixture",
  "sample.mp3": "audio fixture", "sample.woff2": "font fixture", "sample.zip": "invalid zip fixture",
};

// Extract an actual image, not an unrelated icon or a text mention of QR.
function qrSvg(html: string): string | undefined {
  return Array.from(html.matchAll(/<svg\b[\s\S]*?<\/svg>/gi), (m) => m[0])
    .find((svg) => /\b(?:aria-label|aria-labelledby)=|<title\b/i.test(svg));
}

// Parse labels in workerd: assert on parsed text content, so attribute
// values and nested markup spellings neither satisfy nor break Phone.
async function elementTexts(html: string, selector: "summary" | "label"): Promise<string[]> {
  const texts: string[] = [];
  let current = -1;
  await new HTMLRewriter().on(selector, {
    element(element) {
      current = texts.push("") - 1;
      element.onEndTag(() => { current = -1; });
    },
    text(chunk) { if (current >= 0) texts[current] += chunk.text; },
  }).transform(new Response(html)).text();
  return texts;
}

async function expectPhone(html: string, url: string) {
  const labels = [...(await elementTexts(html, "summary")), ...(await elementTexts(html, "label"))];
  expect(labels.some((label) => /\bPhone\b/i.test(label)), "a native no-script Phone disclosure must be served in the viewer bar").toBe(true);
  const svg = qrSvg(html);
  expect(svg, "Phone must include a labelled, server-rendered inline SVG").toBeDefined();
  expect(html).toContain(`href="${url.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`);
  expect(svg!.length).toBeLessThanOrEqual(128 * 1024);
  expect(svg).toMatch(/\bviewBox=["']0 0 \d+ \d+["']/);
  expect(svg).not.toMatch(/<script\b|<foreignObject\b|<image\b|\bon\w+\s*=|(?:href|src)=["']https?:/i);
  return svg!;
}

describe("viewer Phone: served public-file contract", () => {
  let dw: Instance;
  let root: string;
  beforeAll(async () => {
    dw = await freshInstance();
    const published = await dw.json("/api/v1/publish", {
      key: dw.ownerKey, ...jsonBody({ files: Object.entries(fixtures).map(([path, content]) => ({ path, content })) }),
    });
    expect(published.status).toBe(201);
    root = `/s/${published.body.slug}/`;
  });

  it.each(["notes.md", "data.json", "table.csv", "plain.txt", "page.html"])(
    "serves a labelled Phone QR and public link on %s without relaxing CSP", async (path) => {
      const res = await dw.call(`${root}${path}?view=1&share=discard-me&token=discard-me`, { headers: NAV });
      expect(res.status).toBe(200);
      await expectPhone(await res.text(), `${ORIGIN}${root}${path}`);
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toMatch(/script-src[^;]*(?:'unsafe-inline'|https?:|\*)/);
    },
  );

  it("renders the same bounded SVG for repeated requests despite query/fragment changes", async () => {
    const a = await dw.call(`${root}notes.md?view=1&claim=first#secret`, { headers: NAV });
    const b = await dw.call(`${root}notes.md?view=1&unlock=second`, { headers: NAV });
    const url = `${ORIGIN}${root}notes.md`;
    expect(await expectPhone(await a.text(), url)).toBe(await expectPhone(await b.text(), url));
  });

  it("uses request origin rather than an app origin retained in a render cache", async () => {
    const path = `${root}notes.md?view=1`;
    await expectPhone(await (await dw.call(path, { headers: NAV })).text(), `${ORIGIN}${root}notes.md`);
    const otherOrigin = "https://phone.example.test:8443";
    const res = await dw.call(`${otherOrigin}${path}`, { headers: NAV });
    expect(res.status).toBe(200);
    await expectPhone(await res.text(), `${otherOrigin}${root}notes.md`);
  });

  it("encodes hostile path segments exactly as existing public file links do", async () => {
    const path = 'folder/雪 & <phone> "quote" #?.md'.split("/").map(encodeURIComponent).join("/");
    const res = await dw.call(`${root}${path}?view=1&dw_preview=not-a-grant`, { headers: NAV });
    expect(res.status).toBe(200);
    const html = await res.text();
    await expectPhone(html, `${ORIGIN}${root}${path}`);
    expect(html).not.toContain('<phone> "quote"');
    expect(html).not.toMatch(/<img[^>]+onerror|<script[^>]*src=["']https?:/i);
  });

  it.each(["notes.md", "data.json", "table.csv", "plain.txt", "page.html"])(
    "omits Phone in embed mode for %s", async (path) => {
      const html = await (await dw.call(`${root}${path}?view=1&embed=1`, { headers: NAV })).text();
      expect(qrSvg(html)).toBeUndefined();
      expect(html).not.toMatch(/<(?:summary|label)\b[^>]*>[^<]*Phone/i);
    },
  );

  it("omits Phone on folder listings (chosen listing policy)", async () => {
    const res = await dw.call(`${root}folder/`, { headers: NAV });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("child.txt");
    expect(qrSvg(html)).toBeUndefined();
    expect(html).not.toMatch(/<(?:summary|label)\b[^>]*>[^<]*Phone/i);
  });

  it("never replaces a missing file with a QR success page", async () => {
    const res = await dw.call(`${root}missing.md?view=1`, { headers: NAV });
    expect(res.status).toBe(404);
    expect(qrSvg(await res.text())).toBeUndefined();
  });

  it.each(Object.entries(files))("preserves raw/download/subresource bytes for %s", async (path, bytes) => {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    for (const query of ["?raw=1", "?download=1", ""]) {
      const res = await dw.call(`${root}${encoded}${query}`, { headers: { "Sec-Fetch-Dest": "empty" } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(bytes);
      if (query === "?download=1") expect(res.headers.get("content-disposition")).toContain("attachment");
    }
  });

  // Old versions are the validators the pre-Phone build issued, so a cached
  // page carrying one must refresh (200) instead of revalidating (304)
  // against markup that now includes the Phone disclosure. New versions pin
  // the merged Phone/unfurl render; historical pre-Phone validators stay fixed.
  it.each([
    ["notes.md", "markdown", 3, 10], ["data.json", "json", 2, 5], ["data.json", "json", 3, 5],
    ["table.csv", "csv", 3, 5], ["plain.txt", "code", 3, 5], ["page.html", "html-frame", 1, 4],
    ["vector/shape.svg", "svg", 3, 5], ["raster/pixel.png", "image", 3, 5],
  ] as const)("invalidates the pre-Phone %s %s@%i validator, then correctly revalidates refreshed markup", async (path, id, oldVersion, newVersion) => {
    const hash = await sha256Hex(new TextEncoder().encode(fixtures[path]));
    const legacy = `W/"${id}@${oldVersion}-${hash}"`;
    const refreshed = await dw.call(`${root}${path}?view=1`, { headers: { ...NAV, "If-None-Match": legacy } });
    expect(refreshed.status, "old cached viewer markup must refresh to include Phone").toBe(200);
    const etag = refreshed.headers.get("etag")!;
    expect(etag).not.toBe(legacy);
    expect(etag, "refreshed markup must carry the exact post-Phone validator").toMatch(new RegExp(`^W/"${id}@${newVersion}-${hash}`));
    await expectPhone(await refreshed.text(), `${ORIGIN}${root}${path}`);
    const conditional = await dw.call(`${root}${path}?view=1`, { headers: { ...NAV, "If-None-Match": etag } });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
  });

  // Preserve the manifest-dependent suffix from the actual response: old
  // validators included it, so a suffix-free synthetic tag cannot prove a refresh.
  it.each([
    ["page.html", "html-frame"], ["sample.pdf", "pdf"],
    ["sample.mp4", "video"], ["sample.mp3", "audio"],
    ["sample.woff2", "font"], ["sample.zip", "archive"],
  ] as const)("refreshes the actual pre-Phone %s %s@2 validator", async (path, id) => {
    const first = await dw.call(`${root}${path}?view=1`, { headers: NAV });
    expect(first.status).toBe(200);
    const current = first.headers.get("etag")!;
    expect(current).toMatch(new RegExp(`^W/"${id}@4-`));
    const legacy = current.replace(`${id}@4-`, `${id}@2-`);
    const refreshed = await dw.call(`${root}${path}?view=1`, { headers: { ...NAV, "If-None-Match": legacy } });
    expect(refreshed.status).toBe(200);
    await expectPhone(await refreshed.text(), `${ORIGIN}${root}${path}`);
    expect((await dw.call(`${root}${path}?view=1`, { headers: { ...NAV, "If-None-Match": current } })).status).toBe(304);
  });

  it("keeps the existing viewer CSP script, style and network restrictions", async () => {
    for (const path of ["notes.md", "data.json", "table.csv", "page.html"]) {
      const res = await dw.call(`${root}${path}?view=1`, { headers: NAV });
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("default-src 'none'");
      expect(csp.match(/(?:^|;\s*)script-src\s+([^;]+)/)?.[1] ?? "'none'").toBe("'none'");
      expect(csp).toContain("style-src 'unsafe-inline'");
      expect(csp).not.toMatch(/connect-src (?!'none')/);
    }
  });

  it("leaves highlighted source content available, with its original copy/range script CSP", async () => {
    const res = await dw.call(`${root}page.html?view=source`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("source");
    const html = await res.text();
    expect(html).toContain("Original");
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'sha256-[^']+'/);
    expect(res.headers.get("content-security-policy")!.match(/script-src[^;]*/)?.[0]).not.toContain("'unsafe-inline'");
  });
});

describe("viewer Phone: site-origin topology", () => {
  it("uses the receiving subdomain origin, never the dashboard or app file-browser URL", async () => {
    const dw = await freshInstance({ appOrigin: "https://app.example.test", sitesMode: "subdomain", sitesDomain: "files.example.test" });
    const published = await dw.json("/api/v1/publish", {
      key: dw.ownerKey, ...jsonBody({ slug: "phone-topology", files: [{ path: "notes.md", content: "# Site origin\n" }] }),
    });
    expect(published.status).toBe(201);
    const clean = "https://phone-topology.files.example.test/notes.md";
    const res = await dw.call(`${clean}?view=1&token=not-public`, { headers: NAV });
    expect(res.status).toBe(200);
    await expectPhone(await res.text(), clean);
  });

  it.each([
    { name: "app-path", config: { appOrigin: ORIGIN } },
    { name: "separate-sites-path", config: { appOrigin: ORIGIN, sitesOrigin: "https://sites.example" } },
    { name: "subdomain", config: { appOrigin: ORIGIN, sitesMode: "subdomain" as const, sitesDomain: "sites.test" } },
  ])("omits Phone from a real capability-authorized Markdown preview in $name mode", async ({ config }) => {
    const dw = await freshInstance(config);
    const original = await dw.json("/api/v1/publish", {
      key: dw.ownerKey, ...jsonBody({ slug: "phone-preview", files: [{ path: "notes.md", content: "# Historical preview sentinel\n" }] }),
    });
    expect(original.status).toBe(201);
    expect(original.body.versionUrl).toEqual(expect.any(String));
    const capability = new URL(original.body.versionUrl);
    expect(capability.searchParams.get("dw_preview")).toBeTruthy();
    const latest = await dw.json("/api/v1/publish", {
      key: dw.ownerKey, ...jsonBody({ slug: "phone-preview", files: [{ path: "notes.md", content: "# Current live sentinel\n" }] }),
    });
    expect(latest.status).toBe(200);

    // Redeem the actual publish-issued grant without an API key, and then
    // render with only its cookie. Neither an error page nor the current
    // public version can satisfy the historical viewer assertions below.
    const redeemed = await dw.call(capability.href, { headers: NAV });
    expect([302, 303, 307]).toContain(redeemed.status);
    const cookie = redeemed.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    expect(cookie).toContain("HttpOnly");
    const location = redeemed.headers.get("location");
    expect(location).toBeTruthy();
    const cleanRoot = new URL(location!, capability);
    expect(cleanRoot.origin).toBe(capability.origin);
    expect(cleanRoot.searchParams.has("dw_preview")).toBe(false);
    const previewFile = new URL("notes.md", cleanRoot).href;
    const unauthorized = await dw.call(previewFile, { headers: NAV });
    expect(unauthorized.status).toBe(404);
    const preview = await dw.call(previewFile, { headers: { ...NAV, Cookie: cookie!.split(";")[0]! } });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("x-kofra-viewer")).toBe("markdown");
    expect(preview.headers.get("cache-control")).toContain("no-store");
    const html = await preview.text();
    expect(html).toContain("Historical preview sentinel");
    expect(html).not.toContain("Current live sentinel");
    expect(qrSvg(html)).toBeUndefined();
    expect(html).not.toContain('class="dw-phone"');
    expect((await elementTexts(html, "summary")).some(text => /\bPhone\b/i.test(text))).toBe(false);
    expect(html).not.toContain(capability.searchParams.get("dw_preview")!);

    const publicFile = new URL("notes.md", latest.body.url).href;
    const live = await dw.call(publicFile, { headers: NAV });
    expect(live.status).toBe(200);
    const liveHtml = await live.text();
    expect(liveHtml).toContain("Current live sentinel");
    await expectPhone(liveHtml, publicFile);
  });

  it("does not advertise a Phone handoff on an unauthorized preview address", async () => {
    const dw = await freshInstance();
    const published = await dw.json("/api/v1/publish", {
      key: dw.ownerKey, ...jsonBody({ slug: "phone-preview", files: [{ path: "notes.md", content: "# Public file\n" }] }),
    });
    expect(published.status).toBe(201);
    const res = await dw.call("/s/phone-preview--v1/notes.md?view=1&dw_preview=not-a-grant", { headers: NAV });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(qrSvg(html)).toBeUndefined();
    expect(html).not.toMatch(/<(?:summary|label)\b[^>]*>[^<]*Phone/i);
  });
});

describe("viewer Phone: validator versions", () => {
  // Every viewer's rendered page gained the Phone disclosure, so every
  // viewer's ETag version must sit above the validator the pre-Phone build
  // issued; these exact versions also reserve the merged unfurl render identity.
  // Reverting a bump could strand cached pages from either parent on a 304.
  it("pins every built-in viewer at its exact post-Phone version", () => {
    const expected: Record<string, number> = {
      source: 5, "html-frame": 4, markdown: 10, notebook: 7, json: 5, csv: 5,
      svg: 5, image: 5, pdf: 4, video: 4, audio: 4, font: 4, archive: 4,
      code: 5, binary: 5,
    };
    expect(VIEWERS.map((v) => v.id).sort()).toEqual(Object.keys(expected).sort());
    for (const viewer of VIEWERS) expect(viewer.version ?? 1, viewer.id).toBe(expected[viewer.id]);
  });
});

describe("viewer Phone: preview guard (direct)", () => {
  // Preview identity comes from the authorized router, not URL spelling.
  // Real previews load the bare site slug; similarly shaped live origins
  // and path prefixes must not suppress an ordinary public-file handoff.
  const live = (slug: string): LiveSite => ({
    v: 2, siteId: "site_1", slug, tenantId: "t", versionId: "v", spa: false,
    renderMarkdown: true, crossOriginIsolation: false, passwordHash: null,
    expiresAt: null, files: {},
  });
  // Only the fields viewerPhone/viewerBar read carry meaning; dw and the
  // file readers are inert stubs that those two functions never call.
  function phoneContext(siteBase: string, rawUrl: string, preview?: boolean): ViewerContext {
    const url = new URL(rawUrl);
    const fileUrl = `${siteBase}notes.md`;
    return {
      dw: null as unknown as ViewerContext["dw"],
      request: new Request(url),
      url,
      live: live("foo"),
      ...(preview === undefined ? {} : { preview }),
      file: { path: "notes.md", sha256: "0".repeat(64), size: 12, contentType: "text/markdown", kind: "markdown" },
      mode: "view",
      embed: false,
      fileUrl,
      viewUrl: `${fileUrl}?view=1`,
      sourceUrl: `${fileUrl}?view=source`,
      rawUrl: `${fileUrl}?raw=1`,
      downloadUrl: `${fileUrl}?download=1`,
      siteBase,
      appViewerUrl: "https://app.example.test/view/notes.md",
      readText: async () => "",
      readBytes: async () => new Uint8Array(),
    };
  }

  it("renders no Phone for an authorized path preview with the bare live slug", () => {
    const vc = phoneContext("/s/foo--v1/", "https://app.example.test/s/foo--v1/notes.md?view=1", true);
    expect(viewerPhone(vc)).toBe("");
    const bar = viewerBar(vc, []);
    expect(bar).toContain("Download");
    expect(bar).not.toContain("dw-phone");
    expect(bar).not.toMatch(/<(?:summary|label)\b[^>]*>[^<]*Phone/);
  });

  it("renders no Phone for an authorized subdomain preview with the bare live slug", () => {
    const vc = phoneContext("/", "https://foo--v1.files.example.test/notes.md?view=1", true);
    expect(viewerPhone(vc)).toBe("");
    const bar = viewerBar(vc, []);
    expect(bar).toContain("Download");
    expect(bar).not.toContain("dw-phone");
    expect(bar).not.toMatch(/<(?:summary|label)\b[^>]*>[^<]*Phone/);
  });

  it.each([
    ["/s/foo/", "https://app.example.test/s/foo/notes.md"],
    ["/", "https://hello.files--v1.example.test/notes.md"],
    ["/team--v1/foo/", "https://app.example.test/team--v1/foo/notes.md"],
  ])("renders Phone on live %s regardless of preview-like spelling", async (siteBase, publicUrl) => {
    for (const preview of [undefined, false]) {
      const vc = phoneContext(siteBase, `${publicUrl}?view=1`, preview);
      await expectPhone(viewerPhone(vc), publicUrl);
      expect(viewerBar(vc, [])).toContain("dw-phone");
    }
  });
});

describe("viewer Phone: capacity degradation", () => {
  it("keeps the full plain public link when an otherwise valid filename exceeds QR capacity", async () => {
    const dw = await freshInstance();
    // 190 CJK code points fit the file-path budget but exceed QR capacity once
    // percent-encoded (1710 URL bytes before the origin and site prefix).
    const name = `${"雪".repeat(190)}.md`;
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form({ [name]: "# Long public path\n" }),
    });
    expect(published.status).toBe(201);
    const path = `/s/${published.body.slug}/${encodeURIComponent(name)}`;
    const res = await dw.call(`${path}?view=1&token=not-public`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("markdown");
    const html = await res.text();
    expect(html).toContain("Long public path");
    expect(qrSvg(html), "no truncated or substitute QR on encoder overflow").toBeUndefined();
    expect(html, "capacity overflow must retain the complete canonical link")
      .toContain(`href="${ORIGIN}${path}"`);
    expect(html).not.toContain('href="https://api.qr');
  });
});
