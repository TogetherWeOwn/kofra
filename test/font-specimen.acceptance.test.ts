/**
 * Protected test-first handoff: only the Test Author may edit this file.
 * Font UX must not alter bytes, CSP, storage-read budgets or validators.
 * Expectations are from the contract and baseline HTTP observations, not a diff.
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VIEWERS } from "@dropway/server";
import { form, freshInstance, type Instance } from "./helpers";
import { fontSpecimenBytes, FONT_SPECIMEN_PATH, FONT_SPECIMEN_SHA256 } from "./fixtures/font-specimen";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const FRAME = { ...NAV, "Sec-Fetch-Dest": "iframe" };
// Recorded from the real path-mode response on baseline a67a648, not from a
// product constant that could silently change alongside the implementation.
const FONT_CSP = "default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'unsafe-inline' https:; font-src * data:; frame-src https:; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock";
let dw: Instance;
let url: string;

beforeAll(async () => {
  dw = await freshInstance();
  const published = await dw.json("/api/v1/publish", {
    method: "POST", key: dw.ownerKey, body: form({ [FONT_SPECIMEN_PATH]: fontSpecimenBytes() }),
  });
  expect(published.status).toBe(201);
  url = `/s/${published.body.slug}/${FONT_SPECIMEN_PATH.split("/").map(encodeURIComponent).join("/")}`;
});

async function digest(response: Response): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

const get = (suffix = "", headers: Record<string, string> = NAV) => dw.call(url + suffix, { headers });

describe("font specimen HTTP and resource invariants", () => {
  it("keeps raw, download and font-subresource bytes identical to the self-created fixture", async () => {
    for (const [suffix, headers] of [
      ["?raw=1", NAV], ["?download=1", NAV], ["", FRAME],
      ["", { Accept: "*/*", "Sec-Fetch-Dest": "font", "Sec-Fetch-Mode": "cors" }],
    ] as const) {
      const response = await get(suffix, headers);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kofra-viewer")).toBeNull();
      if (suffix.includes("download")) expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(await digest(response)).toBe(FONT_SPECIMEN_SHA256);
    }
  });

  it("keeps the baseline no-script font CSP on navigation and embed responses", async () => {
    for (const [suffix, headers] of [["", NAV], ["?view=1&embed=1", NAV]] as const) {
      const response = await get(suffix, headers);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kofra-viewer")).toBe("font");
      expect(response.headers.get("content-security-policy")).toBe(FONT_CSP);
      expect(await response.text()).not.toMatch(/<script\b|<form\b|\son[a-z]+\s*=/i);
    }
  });

  it("does not read uploaded font bytes to render cold, warm or embed specimen HTML", async () => {
    // Four trailing zero bytes keep this self-created TTF valid but give it a
    // distinct content hash: earlier tests cannot warm this render by content.
    const bytes = new Uint8Array(fontSpecimenBytes().length + 4);
    bytes.set(fontSpecimenBytes());
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form({ "cold.ttf": bytes }),
    });
    expect(published.status).toBe(201);
    const coldUrl = `/s/${published.body.slug}/cold.ttf`;
    const font = VIEWERS.find(viewer => viewer.id === "font")!;
    const render = font.render;
    let byteReads = 0;
    let textReads = 0;
    const rendering = vi.spyOn(font, "render").mockImplementation(vc => render.call(font, {
      ...vc,
      readBytes: async (offset, length) => { byteReads++; return vc.readBytes(offset, length); },
      readText: async () => { textReads++; return vc.readText(); },
    }));
    const read = vi.spyOn(env.FILES, "get");
    const head = vi.spyOn(env.FILES, "head");
    try {
      for (const suffix of ["", "", "?view=1&embed=1"]) {
        const response = await dw.call(coldUrl + suffix, { headers: NAV });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-kofra-viewer")).toBe("font");
        await response.text();
      }
      expect(rendering.mock.calls.length, "observe a real cold font render, not just a cached response").toBeGreaterThan(0);
      expect({ byteReads, textReads }, "font specimen output uses manifest metadata only").toEqual({ byteReads: 0, textReads: 0 });
      expect(read.mock.calls, "specimen HTML uses manifest metadata, not extra font-body reads").toHaveLength(0);
      expect(head.mock.calls, "size controls must not add storage HEAD requests").toHaveLength(0);
    } finally { read.mockRestore(); head.mockRestore(); rendering.mockRestore(); }
  });

  for (const [variant, suffix, tail] of [["full", "", ""], ["embed", "?view=1&embed=1", "-e"]] as const) {
    it(`${variant}: invalidates baseline font@1 validators for changed output`, async () => {
      const old = `W/"font@1-${FONT_SPECIMEN_SHA256}${tail}"`;
      const response = await get(suffix, { ...NAV, "If-None-Match": old });
      expect(response.status, "changed font UX must not revalidate the old specimen HTML as 304").toBe(200);
      expect(response.headers.get("etag")).not.toBe(old);
      const match = response.headers.get("etag")?.match(variant === "embed"
        ? /^W\/"font@(\d+)-([a-f0-9]{64})-folder[A-Za-z0-9_-]+-chrome\d+(-e)"$/
        : /^W\/"font@(\d+)-([a-f0-9]{64})-folder[A-Za-z0-9_-]+-chrome\d+"$/);
      expect(match, "keep the viewer-version/content-hash ETag contract").not.toBeNull();
      expect(Number(match![1])).toBeGreaterThan(1);
      expect(match![2]).toBe(FONT_SPECIMEN_SHA256);
      expect(match![3] ?? "").toBe(tail);
    });
  }

  it("revalidates the current full and embed output, but never confuses their validators", async () => {
    const full = await get();
    const embed = await get("?view=1&embed=1");
    const fullTag = full.headers.get("etag")!;
    const embedTag = embed.headers.get("etag")!;
    expect(fullTag).toMatch(/^W\/"font@\d+-[a-f0-9]{64}-folder[A-Za-z0-9_-]+-chrome\d+"$/);
    expect(embedTag).toBe(fullTag.replace(/"$/, '-e"'));
    expect((await get("", { ...NAV, "If-None-Match": fullTag })).status).toBe(304);
    expect((await get("?view=1&embed=1", { ...NAV, "If-None-Match": embedTag })).status).toBe(304);
    expect((await get("", { ...NAV, "If-None-Match": embedTag })).status).toBe(200);
    expect((await get("?view=1&embed=1", { ...NAV, "If-None-Match": fullTag })).status).toBe(200);
  });

  it("uses the registered font viewer version to retire previous full and embed output", async () => {
    const font = VIEWERS.find(viewer => viewer.id === "font");
    expect(font).toBeDefined();
    const originalVersion = font!.version;
    const version = originalVersion ?? 1;
    try {
      const before = await get();
      const old = before.headers.get("etag")!;
      font!.version = version + 1;
      const changed = await get("", { ...NAV, "If-None-Match": old });
      expect(changed.status).toBe(200);
      expect(changed.headers.get("etag")).toMatch(new RegExp(`^W/"font@${version + 1}-${FONT_SPECIMEN_SHA256}-folder[A-Za-z0-9_-]+-chrome\\d+"$`));
      expect((await get("?view=1&embed=1", { ...NAV, "If-None-Match": old.replace(/"$/, '-e"') })).status).toBe(200);
      expect((await changed.text()).length).toBeGreaterThan(0);
    } finally { font!.version = originalVersion; }
  });
});
