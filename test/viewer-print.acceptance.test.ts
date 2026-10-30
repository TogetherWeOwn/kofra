/**
 * Protected print contract. Intentionally RED until consumed by the paired build.
 * These assertions inspect delivered representations, never implementation text.
 * Geometry, disclosure and print visibility are tested in the browser companion.
 */
import { sha256Hex } from "@dropway/core";
import { beforeAll, describe, expect, it } from "vitest";
import { form, freshInstance, type Instance } from "./helpers";
import { printCapFiles, printFiles } from "./viewer-print.fixtures";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
// Observed pre-print validators at the baseline; not imported from production.
const previousVersions: Record<string, number> = { markdown: 2, code: 1, json: 1, csv: 2, notebook: 1, source: 1 };
// Unknown kind, but its bytes are UTF-8 text: served by the binary viewer's as-text branch.
const binaryTextContent = "# yarn lockfile v1\n\nleft-pad@1.3.0:\n  version \"1.3.0\"\n";
let dw: Instance;
let slug: string;

beforeAll(async () => {
  dw = await freshInstance();
  const published = await dw.json("/api/v1/publish", {
    method: "POST", key: dw.ownerKey,
    body: form({ ...Object.fromEntries(Object.entries(printFiles).map(([path, file]) => [path, file.content])), ...printCapFiles,
      "broken.json": '{"name": "print",', "yarn.lock": binaryTextContent,
      "own.html": '<!doctype html><style>@media print{body{color:purple}}</style><p>Application-owned printing</p>' }),
  });
  expect(published.status).toBe(201);
  slug = published.body.slug;
});
const get = (path: string, headers: Record<string, string> = NAV) => dw.call(`/s/${slug}/${path}`, { headers });

// A print rule in the delivered inline CSS is a selection/wiring assertion only.
// It deliberately makes no claim about pagination or computed layout.
function printStyles(html: string): string[] {
  return [...html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)]
    .filter((match) => /\bmedia\s*=\s*["']print["']/i.test(match[1]!) || /@media\s+print\b/i.test(match[2]!))
    .map((match) => match[2]!);
}

describe("print stylesheet delivery", () => {
  it("source mode receives the same inline print output mode", async () => {
    const response = await get("report.md?view=source");
    expect(response.headers.get("x-kofra-viewer")).toBe("source");
    expect(printStyles(await response.text()).length).toBeGreaterThan(0);
  });

  it.each(Object.entries(printFiles))("%s selects inline print treatment, including the embedded document", async (path, file) => {
    for (const suffix of ["?view=1", "?view=1&embed=1"]) {
      const response = await get(`${path}${suffix}`);
      expect(response.headers.get("x-kofra-viewer")).toBe(file.viewer);
      const html = await response.text();
      expect(printStyles(html).length, `${path}${suffix} (${response.headers.get("etag")}) must receive print CSS without a new stylesheet request`).toBeGreaterThan(0);
      expect(html).not.toMatch(/<link\b[^>]*rel=["']stylesheet["']/i);
    }
  });

  it.each([...Object.entries(printFiles).map(([path, file]) => [path, file.viewer] as const), ["report.md?view=source", "source"] as const])(
    "%s invalidates pre-print HTTP validators and revalidates its new representation", async (path, viewer) => {
      const file = printFiles[path.split("?")[0]!]!;
      const hash = await sha256Hex(new TextEncoder().encode(file.content));
      const legacy = `W/"${viewer}@${previousVersions[viewer]}-${hash}"`;
      const response = await get(path, { ...NAV, "If-None-Match": legacy });
      expect(response.status, "a pre-print cached response must not survive as 304").toBe(200);
      const etag = response.headers.get("etag")!;
      expect(etag).not.toBe(legacy);
      expect(etag).toMatch(new RegExp(`^W/"${viewer}@\\d+-[a-f0-9]{64}(?:-folder[A-Za-z0-9_-]+)?-chrome\\d+(?:\\.[0-9a-f]{8})?"$`));
      const fresh = await get(path, { ...NAV, "If-None-Match": etag });
      expect(fresh.status).toBe(304);
      expect(await fresh.text()).toBe("");
    },
  );

  it("binary text fallback retires pre-rotation validators and revalidates the current representation", async () => {
    const hash = await sha256Hex(new TextEncoder().encode(binaryTextContent));
    const response = await get("yarn.lock?view=1", { ...NAV, "If-None-Match": `W/"binary@3-${hash}"` });
    expect(response.headers.get("x-kofra-viewer")).toBe("binary");
    expect(response.status, "a pre-rotation binary cached response must not survive as 304").toBe(200);
    const etag = response.headers.get("etag")!;
    const version = etag.match(/^W\/"binary@(\d+)-/)?.[1];
    expect(Number(version)).toBeGreaterThan(3);
    expect(etag).toMatch(new RegExp(`^W/"binary@\\d+-${hash}(?:-folder[A-Za-z0-9_-]+)?-chrome\\d+(?:\\.[0-9a-f]{8})?"$`));
    const html = await response.text();
    expect(html).toContain("it looks like text");
    expect(printStyles(html).length, "the binary as-text branch renders through the code page, so it must receive print CSS").toBeGreaterThan(0);
    const fresh = await get("yarn.lock?view=1", { ...NAV, "If-None-Match": etag });
    expect(fresh.status).toBe(304);
    expect(await fresh.text()).toBe("");
  });

  it("invalid JSON error page still selects inline print treatment", async () => {
    const response = await get("broken.json");
    expect(response.headers.get("x-kofra-viewer")).toBe("json");
    const html = await response.text();
    expect(html).toContain("This file is not valid JSON");
    expect(printStyles(html).length, "the invalid-JSON branch must receive print CSS without a new stylesheet request").toBeGreaterThan(0);
  });

  it("print CSS hides the anonymous report link", async () => {
    const html = await (await get("report.md")).text();
    const css = printStyles(html).join("\n");
    expect(css).toMatch(/body>a\[href\$="\/__dropway\/report"\][^}]*display:none!important/);
  });
});

describe("print must not change file/security contracts", () => {
  it.each(Object.entries(printFiles))("%s keeps its script policy, bytes and source representation", async (path, file) => {
    const response = await get(path);
    const csp = response.headers.get("content-security-policy")!;
    const policy = "default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'unsafe-inline' https:; font-src * data:; frame-src https:; base-uri 'none'; form-action 'none'; ";
    const sandbox = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock";
    const html = await response.text();
    if (file.viewer === "code") {
      expect(csp).toBe(`${policy}script-src 'sha256-8kBw0RLH7SihuFxmhc5HdeB3FJK+v2IMXvuARwK5LZ0='; ${sandbox}`);
      expect([...html.matchAll(/<script\b/gi)]).toHaveLength(1);
    } else {
      // default-src 'none' supplies script-src/connect-src when omitted.
      expect(csp).toBe(`${policy}${sandbox}`);
      expect(html).not.toMatch(/<script\b/i);
    }
    expect(html).not.toMatch(/\bon(?:beforeprint|afterprint)\s*=|window\.print\s*\(|<button[^>]*>\s*Print/i);
    for (const query of ["raw=1", "download=1"]) {
      const bytes = await get(`${path}?${query}`);
      expect(bytes.headers.get("x-kofra-viewer")).toBeNull();
      expect(await bytes.text()).toBe(file.content);
      if (query === "download=1") expect(bytes.headers.get("content-disposition")).toContain("attachment");
    }
    const source = await get(`${path}?view=source`);
    expect(source.headers.get("x-kofra-viewer")).toBe("source");
    expect(await source.text()).toContain('id="L1"');
  });

  it("retains existing cap notices rather than suggesting the complete input was printed", async () => {
    const code = await (await get("capped.txt")).text();
    expect(code).toMatch(/truncat|first.*(?:MiB|MB|bytes)/i);
    expect(code).not.toContain("UNRENDERED_CODE_TAIL");
    const csv = await (await get("capped.csv")).text();
    expect(csv).toMatch(/showing the first 2[,.]?000 rows/i);
    expect(csv).toContain("row-1999");
    expect(csv).not.toContain("row-2000");
    const json = await (await get("capped.json")).text();
    expect(json).toMatch(/more \(see the Pretty or Raw view\)/);
    const notebook = await (await get("capped.ipynb")).text();
    expect(notebook).toContain("…");
    expect(notebook).not.toContain("UNRENDERED_NOTEBOOK_TAIL");
  });

  it("does not inject viewer print rules into application-owned HTML", async () => {
    const response = await get("own.html");
    expect(response.headers.get("x-kofra-viewer")).toBeNull();
    const html = await response.text();
    expect(html).toContain("@media print{body{color:purple}}");
    expect(html).not.toContain("dw-vbar");
    expect(printStyles(html)).toEqual(["@media print{body{color:purple}}"]);
  });
});
