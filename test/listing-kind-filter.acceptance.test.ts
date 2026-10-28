/**
 * Acceptance contract: narrow public folder listings by file kind with
 * script-free links.
 *
 * Written against the real served Worker (freshInstance + publish +
 * browser-navigation GETs), never against a reimplemented filter. The only
 * computation in this file derives the *expected* sets from the listing's own
 * default render (row kind labels) and from the pinned classifier contract:
 *
 *   - Filter membership is the listing's own classification: a file shown with
 *     kind label L under All must appear under `?kind=<id>` exactly when
 *     KIND_LABELS[<id>] === L. A second classifier must fail these tests.
 *   - Within a filter, file order is the default render's order restricted to
 *     the kind (today: `String.prototype.localeCompare` on the file name).
 *     Folder rows stay first, themselves name-ordered, under every filter.
 *
 * Pinned interface decisions (part of the contract):
 *   - The reserved query parameter is `kind`. Recognized values are the
 *     `FileKind` ids (`pdf`, `csv`, `image`, `svg`, `code`, ...),
 *     case-sensitive. All means no parameter, an empty value, `kind=all`,
 *     or any unrecognized value; every one of those renders byte-identically
 *     to the default. A repeated `kind` parameter resolves to its first value.
 *   - The controls are an `All` link plus one link per known kind inside a
 *     `<nav>` whose aria-label mentions "this folder" (current-folder scope,
 *     never recursive search), placed before the file `<ul>`. `All` comes
 *     first; every kind link is labelled with its KIND_LABELS value and its
 *     href targets the same listing path with `kind=<id>`. The `All` href
 *     carries no `kind` parameter. A recognized `sort` selection
 *     (`name|size|type`) present in the current URL is preserved by every
 *     kind-control href. Absent/invalid sort may emit canonical `sort=name`
 *     so the existing no-sort / explicit-name byte-identity contract holds;
 *     no other parameters are added. Sort controls reciprocally preserve kind.
 *   - The active control carries `aria-current` (not `="false"`); inactive
 *     controls carry no `aria-current` or `aria-current="false"`.
 *   - Filtered summaries read "M of N files" (matching of total direct
 *     files) and keep the folder count and total bytes of the default render
 *     verbatim. A filter with no matches says "No files of this kind" and
 *     still offers the `All` recovery link; a folder with no direct files
 *     says "0 files" and never the no-match sentence.
 *   - File, folder, gallery, breadcrumb and app-viewer hrefs stay canonical:
 *     no `kind` parameter (and no `?` at all) outside kind/sort controls.
 *   - No `<form>`, no `<script>`, no CSP change (`form-action 'none'` stays),
 *     no new headers beyond what conditional correctness needs, no
 *     storage/API/index side effects. Following a kind link by plain GET
 *     applies the filter (no JavaScript needed).
 *
 * Legend: tests marked RED fail on the baseline (the filter does not exist
 * yet) and must fail for that reason only; tests marked GUARD pass on the
 * baseline and pin behavior the feature must not change. A RED test that
 * fails for any other reason (harness, fixture, publish) is a bug in this
 * file, not a feature signal.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { contentTypeFor, detectFileKind, encodePath, KIND_LABELS, type FileKind } from "@dropway/core";
import { escapeHtml } from "../packages/server/src/html";
import { freshInstance, jsonBody, type Instance } from "./helpers";
import { b64 } from "./mcp-helpers";
import { create as createTransfer, follow as followTransfer, instance as transferInstance, SITES as TRANSFER_SITES } from "./transfer-fixtures";

const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

const byName = (a: string, b: string) => a.localeCompare(b);

interface Row {
  name: string;
  href: string;
  kind: string;
  isDir: boolean;
}

/** Rows of the listing's <ul>, in document order. The `../` escape row has no kind span and is excluded. */
function rows(html: string): Row[] {
  const out: Row[] = [];
  const re = /<li[^>]*>\s*<a href="([^"]+)"[^>]*>([^<]+)<\/a>\s*<span class="k">([^<]+)<\/span>/g;
  for (let m; (m = re.exec(html)) !== null; ) {
    out.push({ href: m[1]!, name: m[2]!, kind: m[3]!, isDir: m[3] === "Folder" });
  }
  return out;
}

interface Anchor {
  href: string;
  label: string;
  attrs: string;
  index: number;
}

function anchors(html: string): Anchor[] {
  const out: Anchor[] = [];
  const re = /<a\s+([^>]*href="([^"]+)"[^>]*)>([^<]*)<\/a>/g;
  for (let m; (m = re.exec(html)) !== null; ) {
    // HTML href attributes escape query separators; URLs use the decoded value.
    out.push({ attrs: m[1]!, href: m[2]!.replace(/&amp;/g, "&"), label: m[3]!, index: m.index });
  }
  return out;
}

/** The kind-filter control group: the <nav> whose accessible label scopes it to this folder. */
function kindNav(html: string): string | null {
  for (const m of html.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/g)) {
    const label = /aria-label="([^"]*)"/.exec(m[1]!)?.[1] ?? "";
    if (/this folder/i.test(label)) return m[0];
  }
  return null;
}

/** Plain-link kind controls (All + kinds) inside the kind nav, in document order. */
function kindLinks(html: string): Anchor[] {
  const nav = kindNav(html);
  if (!nav) return [];
  const start = html.indexOf(nav);
  const end = start + nav.length;
  return anchors(html).filter((a) => a.index >= start && a.index < end);
}

function ariaCurrent(a: Anchor): string | null {
  const m = /aria-current(?:="([^"]*)")?/.exec(a.attrs);
  if (!m) return null;
  return m[1] ?? "true";
}

/** Names shown in the image gallery, in document order. */
function galleryNames(html: string): string[] {
  const start = html.indexOf('class="dw-gal"');
  if (start < 0) return [];
  const end = html.indexOf("</div>", start);
  const gal = html.slice(start, end < 0 ? undefined : end);
  return [...gal.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]!);
}

/** Gallery link targets and image sources. */
function galleryTargets(html: string): Array<{ href: string; src: string }> {
  const start = html.indexOf('class="dw-gal"');
  if (start < 0) return [];
  const end = html.indexOf("</div>", start);
  const gal = html.slice(start, end < 0 ? undefined : end);
  const hrefs = [...gal.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]!);
  const srcs = [...gal.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]!);
  return hrefs.map((href, i) => ({ href, src: srcs[i] ?? "" }));
}

/** The summary text, without trailing links. */
function summary(html: string): string {
  const m = /<span class="sum">([^<]*)</.exec(html);
  if (!m) throw new Error("listing summary span not found");
  return m[1]!;
}

/** Matching/total file counts from a filtered summary ("M of N files"). */
function counts(html: string): { matching: number; total: number } | null {
  const m = /(\d+)\s+of\s+(\d+)\s+files?/i.exec(summary(html));
  return m ? { matching: Number(m[1]), total: Number(m[2]) } : null;
}

type PubFile = { path: string; content: string; encoding?: "base64" };
const textFile = (path: string, content: string): PubFile => ({ path, content });
const pngFile = (path: string, bytes: Uint8Array): PubFile => ({ path, content: b64(bytes), encoding: "base64" });

/** Minimal PNG header with a tag byte so each file hashes differently. */
function pngBytes(size: number, tag: number): Uint8Array {
  const b = new Uint8Array(size);
  b.set([137, 80, 78, 71, 13, 10, 26, 10]);
  b[size - 1] = tag;
  return b;
}

async function publishJson(dw: Instance, files: PubFile[], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ files, ...extra }) });
  expect([200, 201], `publish failed: ${JSON.stringify(res.body)}`).toContain(res.status);
  return res.body.slug as string;
}

async function listing(dw: Instance, path: string, headers: Record<string, string> = NAV): Promise<{ res: Response; html: string }> {
  const res = await dw.call(path, { headers });
  return { res, html: await res.text() };
}

/** Resolve an href found on `pagePath` to a call()-able path+query. */
function follow(pagePath: string, href: string): string {
  const u = new URL(href, `https://dropway.test${pagePath}`);
  return u.pathname + u.search;
}

/**
 * The mixed fixture. Publish order is deliberately scrambled so a pass cannot
 * be an accident of manifest order. No index file at any listed level, so
 * every folder below renders a listing. Unicode and HTML-like names pin
 * escaping and percent-encoding under every filter.
 */
function mixedFiles(): PubFile[] {
  return [
    textFile("sub/inner.txt", "inner note"),
    textFile("sub/plan.pdf", "%PDF-sub-plan"),
    textFile("sub/deep/x.txt", "deep"),
    textFile("song.mp3", "s".repeat(300)),
    textFile("Zebra.txt", "z".repeat(40)),
    textFile("data.json", '{"k":1}'),
    textFile("report.pdf", "%PDF-" + "p".repeat(50)),
    pngFile("photo.png", pngBytes(120, 1)),
    textFile("apple.txt", "a".repeat(40)),
    textFile("tiny.svg", '<svg xmlns="http://www.w3.org/2000/svg"><!--' + "x".repeat(12) + "--></svg>"),
    textFile("app.ts", "export const app = 1;\n"),
    textFile("page.html", "<p>page</p>"),
    textFile("sheet.csv", "a,b\n" + "1,2\n".repeat(4)),
    textFile("éclair.txt", "e".repeat(40)),
    pngFile("a & b.png", pngBytes(140, 2)),
    textFile("café ☕.svg", '<svg xmlns="http://www.w3.org/2000/svg"><title>café ☕</title></svg>'),
    textFile(`x <tag> "q" 's #1?.txt`, "hostile bytes"),
    textFile("docs/guide.md", "# Guide\n"),
    textFile("Alpha-dir/inner.txt", "a"),
    textFile("my pics/note.txt", "a note"),
    pngFile("my pics/shot.png", pngBytes(110, 3)),
    textFile("only/a/x.txt", "x"),
    textFile("only/b/x.txt", "x"),
  ];
}

const HOSTILE_NAMES = [`x <tag> "q" 's #1?.txt`, "a & b.png", "café ☕.svg", "éclair.txt", "Zebra.txt", "apple.txt"];

const KIND_CASES: FileKind[] = ["pdf", "csv", "image", "svg", "code", "text", "json", "audio", "html"];

const idByLabel = new Map<string, FileKind>(Object.entries(KIND_LABELS).map(([id, label]) => [label, id as FileKind]));

let dw: Instance;
let slug: string;
let root: string;

/** Default-render rows of the mixed root: the oracle for membership and order. */
let allRows: Row[];

beforeAll(async () => {
  dw = await freshInstance();
  slug = await publishJson(dw, mixedFiles());
  root = `/s/${slug}/`;
  allRows = rows((await listing(dw, root)).html);
});

const allFiles = () => allRows.filter((r) => !r.isDir);
const allDirs = () => allRows.filter((r) => r.isDir);

/** File rows the default render shows with a kind's label, in default order. */
function expectedMembers(kindId: FileKind): string[] {
  return allFiles()
    .filter((r) => r.kind === KIND_LABELS[kindId])
    .map((r) => r.name);
}

/** Assert a filtered render keeps folder rows first and the kind's files in default order. */
function expectFilteredTo(html: string, kindId: FileKind) {
  const rs = rows(html);
  expect(rs.map((r) => r.name)).toEqual([...allDirs().map((r) => r.name), ...expectedMembers(kindId)]);
}

/** Assert honest totals: matching/total counts plus the default folder count and byte total. */
function expectHonestTotals(filteredHtml: string, allHtml: string, matching: number, total: number) {
  const c = counts(filteredHtml);
  expect(c, `expected "${matching} of ${total} files" in ${JSON.stringify(summary(filteredHtml))}`).toEqual({ matching, total });
  const allSum = summary(allHtml);
  const folders = /(\d+ folders?,)/.exec(allSum)?.[1];
  expect(folders, `default summary carries a folder count: ${JSON.stringify(allSum)}`).toBeTruthy();
  expect(summary(filteredHtml)).toContain(folders!);
  const bytes = /·\s*(.+)$/.exec(allSum)?.[1];
  expect(bytes, `default summary carries a byte total: ${JSON.stringify(allSum)}`).toBeTruthy();
  expect(summary(filteredHtml)).toContain(bytes!);
}

describe("kind filter: controls", () => {
  // RED: no kind controls exist on the baseline.
  it("offers All plus the present kinds as plain links in a this-folder nav before the file list", async () => {
    const { res, html } = await listing(dw, root);
    expect(res.headers.get("x-kofra-viewer")).toBe("listing");
    const nav = kindNav(html);
    expect(nav, "a <nav> whose aria-label scopes the controls to this folder").not.toBeNull();
    const links = kindLinks(html);
    const labels = links.map((l) => l.label);
    expect(labels[0]).toBe("All");
    for (const kindId of KIND_CASES) {
      expect(labels, `kind ${kindId} (${KIND_LABELS[kindId]}) must be linked`).toContain(KIND_LABELS[kindId]);
    }
    // One link per label: no duplicates, whatever the builder shows beyond the present kinds.
    expect(new Set(labels).size).toBe(labels.length);
    const listStart = html.indexOf("<ul>");
    for (const link of links) {
      expect(link.index, `${link.label} control must precede the file list`).toBeLessThan(listStart);
    }
  });

  // RED: no kind controls exist on the baseline.
  it("control hrefs target the same listing with kind and at most canonical default sort (All carries no kind)", async () => {
    const { html } = await listing(dw, root);
    const links = kindLinks(html);
    expect(links.length).toBeGreaterThan(1);
    for (const link of links) {
      const u = new URL(link.href, `https://dropway.test${root}`);
      expect(u.pathname, `${link.label} href must target the same listing`).toBe(root);
      // Requiring sort to be absent here contradicted sort=name byte identity
      // once kind controls also had to preserve an explicit name selection.
      const sortKeys = u.searchParams.has("sort") ? ["sort"] : [];
      if (sortKeys.length) expect(u.searchParams.getAll("sort")).toEqual(["name"]);
      if (link.label === "All") {
        expect(u.searchParams.has("kind"), "All href must not carry kind=").toBe(false);
        expect([...u.searchParams.keys()]).toEqual(sortKeys);
      } else {
        const id = idByLabel.get(link.label);
        expect(id, `control label ${JSON.stringify(link.label)} must be a KIND_LABELS value`).toBeDefined();
        expect(u.searchParams.get("kind")).toBe(id);
        expect([...u.searchParams.keys()].sort(), `${link.label} href must carry only kind and optional default sort`).toEqual(["kind", ...sortKeys]);
      }
    }
  });

  // RED: no kind controls exist on the baseline.
  it("marks the active control with aria-current and no other control", async () => {
    const cases: Array<[string, string]> = [
      [root, "All"],
      [`${root}?kind=pdf`, KIND_LABELS.pdf],
      [`${root}?kind=csv`, KIND_LABELS.csv],
      [`${root}?kind=image`, KIND_LABELS.image],
      [`${root}?kind=bogus`, "All"],
      [`${root}?kind=`, "All"],
      [`${root}?kind=all`, "All"],
    ];
    for (const [path, active] of cases) {
      const { html } = await listing(dw, path);
      const links = kindLinks(html);
      expect(links.length, `${path}: kind controls must render`).toBeGreaterThan(1);
      for (const link of links) {
        const current = ariaCurrent(link);
        if (link.label === active) {
          expect(current, `${path}: ${link.label} must be aria-current`).not.toBeNull();
          expect(current).not.toBe("false");
        } else {
          expect(current === null || current === "false", `${path}: ${link.label} must not be current`).toBe(true);
        }
      }
    }
  });

  // RED: no kind controls exist on the baseline.
  it("needs no script: controls are plain anchors and following one by GET applies the filter", async () => {
    const { html } = await listing(dw, root);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<form");
    const links = kindLinks(html);
    expect(links.length).toBeGreaterThan(1);
    for (const link of links) {
      expect(link.attrs).not.toMatch(/on\w+\s*=/i);
      expect(link.attrs).not.toMatch(/tabindex\s*=\s*"-1"/i);
      const target = follow(root, link.href);
      const rendered = await listing(dw, target);
      expect(rendered.res.status, `following ${link.label}`).toBe(200);
      if (link.label === "All") {
        expect(rendered.html).toBe(html);
      } else {
        expectFilteredTo(rendered.html, idByLabel.get(link.label)!);
      }
    }
  });

  // GUARD: the listing already classifies with detectFileKind; the filter must reuse it, not fork it.
  it("row labels match detectFileKind/KIND_LABELS for every fixture file (no second classifier)", async () => {
    const { html } = await listing(dw, root);
    const byName = new Map(rows(html).map((r) => [r.name, r.kind]));
    for (const f of mixedFiles().filter((f) => !f.path.includes("/"))) {
      const base = f.path.slice(f.path.lastIndexOf("/") + 1);
      const expected = KIND_LABELS[detectFileKind(f.path, contentTypeFor(f.path))];
      expect(byName.get(escapeHtml(base)), `row label for ${base}`).toBe(expected);
    }
  });

  // GUARD: keyboard-visible focus must stay possible; the page must not suppress focus outlines.
  it("does not suppress keyboard focus visibility in listing CSS", async () => {
    for (const q of ["", "?kind=pdf"]) {
      const { html } = await listing(dw, `${root}${q}`);
      const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
      expect(styles).not.toMatch(/outline\s*:\s*(none|0)\b/i);
    }
  });

  // GUARD: narrow-screen shell stays intact on filtered renders.
  it("keeps the narrow-screen shell: viewport meta stays and controls precede the list when filtered", async () => {
    const { html } = await listing(dw, `${root}?kind=pdf`);
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html.indexOf("</header>")).toBeLessThan(html.indexOf("<ul>"));
  });
});

describe("kind filter: filtering", () => {
  // RED: the baseline ignores kind= and renders every direct file.
  it.each(KIND_CASES)("?kind=%s shows only that kind's direct files, in default order, with honest counts", async (kindId) => {
    const plain = await listing(dw, root);
    const { res, html } = await listing(dw, `${root}?kind=${kindId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("listing");
    expectFilteredTo(html, kindId);
    for (const r of rows(html).filter((r) => !r.isDir)) {
      expect(r.kind).toBe(KIND_LABELS[kindId]);
    }
    expectHonestTotals(html, plain.html, expectedMembers(kindId).length, allFiles().length);
  });

  // RED: the baseline renders no "M of N" counts.
  it("All and Clear recover the full listing from a filter", async () => {
    const plain = await listing(dw, root);
    const { html } = await listing(dw, `${root}?kind=pdf`);
    const all = kindLinks(html).find((l) => l.label === "All");
    expect(all, "filtered render must offer the All recovery link").toBeDefined();
    const recovered = await listing(dw, follow(`${root}?kind=pdf`, all!.href));
    expect(recovered.html).toBe(plain.html);
    expect(counts(recovered.html), "All render shows plain totals, not M-of-N").toBeNull();
  });

  // RED: the baseline ignores kind=, so the escape path is untested with a filter applied.
  it("a nested filter keeps its subfolder link, ../ escape, breadcrumbs and honest counts", async () => {
    const sub = `${root}sub/`;
    const plain = await listing(dw, sub);
    const { html } = await listing(dw, `${sub}?kind=pdf`);
    const rs = rows(html);
    expect(rs.filter((r) => !r.isDir).map((r) => r.name)).toEqual(["plan.pdf"]);
    expect(rs.filter((r) => r.isDir).map((r) => r.name)).toEqual(["deep/"]);
    expect(html).toContain('href="../"');
    expect(html).toContain(`>${slug}</a>`);
    expect(html).toContain(">sub</a>");
    expectHonestTotals(html, plain.html, 1, 2);
    // The root itself has no parent to escape to, filtered or not.
    expect((await listing(dw, `${root}?kind=pdf`)).html).not.toContain('href="../"');
  });

  // RED: no kind controls exist on the baseline.
  it("kind hrefs in an encoded folder stay in that folder with encoded destinations", async () => {
    const folder = `${root}${encodePath("my pics/")}`;
    const { html } = await listing(dw, `${folder}?kind=image`);
    expect(rows(html).filter((r) => !r.isDir).map((r) => r.name)).toEqual(["shot.png"]);
    expect(html).toContain('href="../"');
    const links = kindLinks(html);
    expect(links.length).toBeGreaterThan(1);
    for (const link of links) {
      const u = new URL(link.href, `https://dropway.test${folder}`);
      expect(u.pathname, `${link.label} href must stay in the encoded folder`).toBe(folder);
    }
  });

  // RED: the baseline ignores kind= on the redirect target.
  it("a folder redirect keeps the kind query and the followed render is filtered", async () => {
    const res = await dw.call(`${root}sub?kind=pdf`, { headers: NAV });
    expect(res.status).toBe(301);
    const location = new URL(res.headers.get("location")!, "https://dropway.test");
    expect(location.pathname).toBe(`${root}sub/`);
    const followed = await listing(dw, location.pathname + location.search);
    expect(rows(followed.html).filter((r) => !r.isDir).map((r) => r.name)).toEqual(["plan.pdf"]);
  });

  // GUARD: default order is locale order today; filters preserve it by construction.
  it("default order is locale order, not code-point order (case and unicode)", async () => {
    const names = allFiles().map((r) => r.name);
    expect(names).toEqual([...names].sort(byName));
    expect(names.indexOf("apple.txt")).toBeLessThan(names.indexOf("Zebra.txt"));
    expect(names.indexOf(escapeHtml("éclair.txt"))).toBeLessThan(names.indexOf("tiny.svg"));
  });

  // GUARD: names stay escaped and hrefs encoded on filtered renders.
  it("escapes hostile names and encodes hrefs identically on All and filtered renders", async () => {
    const plain = await listing(dw, root);
    for (const n of HOSTILE_NAMES) {
      // The listing escapes the whole href attribute, so encodeURIComponent's
      // survivors (') appear entity-encoded in the markup.
      expect(plain.html).toContain(`href="${root}${escapeHtml(encodeURIComponent(n))}"`);
      expect(plain.html).toContain(`>${escapeHtml(n)}</a>`);
    }
    const filtered = await listing(dw, `${root}?kind=text`);
    const hostileHref = `${root}${escapeHtml(encodeURIComponent(HOSTILE_NAMES[0]!))}`;
    expect(filtered.html).toContain(`href="${hostileHref}"`);
    expect(filtered.html).toContain(`>${escapeHtml(HOSTILE_NAMES[0]!)}</a>`);
    expect(filtered.html).not.toContain('<tag> "q"');
  });
});

describe("kind filter: unrecognized and hostile input", () => {
  const bogus = [
    "",
    "bogus",
    "PDF",
    "Pdf",
    " pdf",
    "pdf ",
    "pdf,pdf",
    "all ",
    "0",
    "videox",
    "../../etc",
    "' OR 1=1 --",
    "s".repeat(4096),
  ];

  // GUARD: unknown values already render the default (kind= is ignored); the feature must keep that.
  it.each(bogus)("unrecognized kind value renders byte-identically to the default: %j", async (value) => {
    const plain = await listing(dw, root);
    const res = await listing(dw, `${root}?kind=${encodeURIComponent(value)}`);
    expect(res.res.status).toBe(200);
    expect(res.html).toBe(plain.html);
  });

  // GUARD: pins the All alias and the case-sensitive parameter name.
  it("?kind=all and ?KIND=pdf render byte-identically to the default", async () => {
    const plain = await listing(dw, root);
    for (const q of ["?kind=all", "?KIND=pdf"]) {
      expect((await listing(dw, `${root}${q}`)).html, q).toBe(plain.html);
    }
  });

  // GUARD: only the bounded kind parameter filters; no text-search parameter is honored.
  it("text-search parameters never filter: ?q/?search/?filter/?type render the default", async () => {
    const plain = await listing(dw, root);
    for (const q of ["?q=pdf", "?search=pdf", "?filter=pdf", "?type=pdf", "?kindx=pdf"]) {
      expect((await listing(dw, `${root}${q}`)).html, q).toBe(plain.html);
    }
  });

  // GUARD: hostile values are never reflected.
  it("never reflects a hostile kind value into the page", async () => {
    const attack = '"><script>alert(1)</script>';
    const { html } = await listing(dw, `${root}?kind=${encodeURIComponent(attack)}`);
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("<script");
  });

  // RED: the baseline renders All for every repeated value, so first-wins is unobservable.
  it("a repeated kind parameter resolves to its first value", async () => {
    const firstPdf = await listing(dw, `${root}?kind=pdf&kind=csv`);
    expectFilteredTo(firstPdf.html, "pdf");
    const plain = await listing(dw, root);
    const bogusFirst = await listing(dw, `${root}?kind=bogus&kind=pdf`);
    expect(bogusFirst.html).toBe(plain.html);
  });

  // RED: the baseline ignores kind= alongside anything else.
  it("kind still filters alongside unrelated query parameters", async () => {
    const { html } = await listing(dw, `${root}?utm_source=test&kind=pdf&ref=listing`);
    expectFilteredTo(html, "pdf");
  });
});

describe("kind filter: sort coexistence", () => {
  // RED: no kind controls exist to preserve anything. Passes whether or not listing sort has landed:
  // with sort absent the parameter is inert but must still round-trip through kind hrefs.
  it.each(["name", "size", "type"])("kind controls preserve a recognized sort selection: sort=%s", async (sort) => {
    const { html } = await listing(dw, `${root}?sort=${sort}`);
    const links = kindLinks(html);
    expect(links.length, "kind controls must render on a sorted listing").toBeGreaterThan(1);
    for (const link of links) {
      const u = new URL(link.href, `https://dropway.test${root}`);
      expect(u.pathname, `${link.label} href must target the same listing`).toBe(root);
      expect(u.searchParams.get("sort"), `${link.label} href must preserve sort=${sort}`).toBe(sort);
      if (link.label === "All") {
        expect(u.searchParams.has("kind")).toBe(false);
      } else {
        expect(u.searchParams.get("kind")).toBe(idByLabel.get(link.label));
      }
    }
  });

  // RED: the baseline ignores kind=, with or without sort=. Compares by set so the test holds
  // under name order (sort absent) and under a sorted order (sort present).
  it("kind and sort compose in one URL: the kind set is filtered and sort is preserved", async () => {
    const expected = expectedMembers("pdf").slice().sort();
    for (const sort of ["size", "type"]) {
      const { html } = await listing(dw, `${root}?kind=pdf&sort=${sort}`);
      const names = rows(html).filter((r) => !r.isDir).map((r) => r.name);
      expect(names.slice().sort(), `pdf set with sort=${sort}`).toEqual(expected);
      expectHonestTotals(html, (await listing(dw, root)).html, expected.length, allFiles().length);
      for (const link of kindLinks(html)) {
        const u = new URL(link.href, `https://dropway.test${root}`);
        expect(u.searchParams.get("sort"), `${link.label} href must keep sort=${sort}`).toBe(sort);
      }
    }
  });

  // RED: the baseline ignores kind= here too.
  it("an unrecognized sort value does not break filtering", async () => {
    const { html } = await listing(dw, `${root}?kind=pdf&sort=bogus`);
    expect(rows(html).filter((r) => !r.isDir).map((r) => r.name).slice().sort()).toEqual(expectedMembers("pdf").slice().sort());
  });

  // GUARD: only the canonical default may be emitted without a recognized selection.
  // Forbidding sort=name here contradicted the existing sort default's byte identity.
  it.each(["", "&sort=bogus"])("kind hrefs add at most canonical sort=name without a recognized sort: %j", async (q) => {
    const { html } = await listing(dw, `${root}?kind=pdf${q}`);
    for (const link of kindLinks(html)) {
      const u = new URL(link.href, `https://dropway.test${root}`);
      expect([[], ["name"]], `${link.label} href must not invent a non-default sort`).toContainEqual(u.searchParams.getAll("sort"));
    }
  });
});

describe("kind filter: empty and no match", () => {
  // RED: the baseline renders the full listing for a valid-but-absent kind.
  it.each(["", "name", "size", "type"])("a valid kind with no files says No files of this kind with zero counts, keeps escape paths, drops the gallery (sort=%j)", async (sort) => {
    const plain = await listing(dw, sort ? `${root}?sort=${sort}` : root);
    const page = `${root}?kind=video${sort ? `&sort=${sort}` : ""}`;
    const { res, html } = await listing(dw, page);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("listing");
    expect(html).toContain("No files of this kind");
    expect(rows(html).filter((r) => !r.isDir)).toHaveLength(0);
    expect(rows(html).filter((r) => r.isDir).map((r) => r.name)).toEqual(allDirs().map((r) => r.name));
    expectHonestTotals(html, plain.html, 0, allFiles().length);
    expect(galleryNames(html)).toHaveLength(0);
    const all = kindLinks(html).find((l) => l.label === "All");
    expect(all, "no-match render must keep the All recovery link").toBeDefined();
    expect(new URL(all!.href, `https://dropway.test${root}`).searchParams.has("kind")).toBe(false);
    const recovered = await listing(dw, follow(page, all!.href));
    expect(recovered.html).toBe(plain.html);
    const clearLinks = anchors(html).filter((a) => a.label === "Clear filter");
    expect(clearLinks, "no-match render must offer exactly one Clear filter recovery link").toHaveLength(1);
    const clearUrl = new URL(clearLinks[0]!.href, `https://dropway.test${page}`);
    expect(clearUrl.pathname, "Clear filter must stay in the same folder").toBe(root);
    expect(clearUrl.searchParams.has("kind"), "Clear filter must return to All").toBe(false);
    if (sort) expect(clearUrl.searchParams.get("sort"), "Clear filter must preserve the selected sort").toBe(sort);
    const cleared = await listing(dw, follow(page, clearLinks[0]!.href));
    expect(cleared.res.status).toBe(200);
    expect(cleared.html).toBe(plain.html);
  });

  // RED (controls half): the empty/all distinction already holds, but the All control is new.
  it("a folder with no direct files says 0 files (never the no-match sentence) and still offers All", async () => {
    const { html } = await listing(dw, `${root}only/`);
    expect(summary(html)).toMatch(/0 files/);
    expect(summary(html)).not.toMatch(/\d+\s+of\s+\d+/i);
    expect(html).not.toContain("No files of this kind");
    expect(rows(html).filter((r) => !r.isDir)).toHaveLength(0);
    expect(rows(html).filter((r) => r.isDir).map((r) => r.name)).toEqual(["a/", "b/"]);
    const links = kindLinks(html);
    const all = links.find((l) => l.label === "All");
    expect(all, "empty folder must still offer All").toBeDefined();
    expect(ariaCurrent(all!)).not.toBeNull();
    expect(ariaCurrent(all!)).not.toBe("false");
  });
});

describe("kind filter: image gallery coherence", () => {
  const imageNames = () => [...expectedMembers("image"), ...expectedMembers("svg")];

  // GUARD: today's gallery already shows the folder's images in file order.
  it("All gallery shows every image and SVG in file order", async () => {
    const { html } = await listing(dw, root);
    const files = allFiles().map((r) => r.name);
    const expected = files.filter((n) => imageNames().includes(n));
    expect(galleryNames(html)).toEqual(expected);
  });

  // RED: the baseline gallery ignores the filter.
  it("?kind=image shows only raster images, ?kind=svg only SVGs", async () => {
    const raster = await listing(dw, `${root}?kind=image`);
    expect(galleryNames(raster.html)).toEqual(expectedMembers("image"));
    expect(raster.html).not.toContain(escapeHtml("café ☕.svg"));
    const vector = await listing(dw, `${root}?kind=svg`);
    expect(galleryNames(vector.html)).toEqual(expectedMembers("svg"));
    expect(vector.html).not.toContain("photo.png");
  });

  // RED: the baseline gallery ignores the filter.
  it("the gallery disappears when no matching image remains", async () => {
    for (const q of ["?kind=pdf", "?kind=code", "?kind=video"]) {
      const { html } = await listing(dw, `${root}${q}`);
      expect(galleryNames(html), `${q} must have no gallery`).toHaveLength(0);
      expect(html, `${q} must not render the gallery container`).not.toContain('class="dw-gal"');
    }
  });

  describe("gallery cap under a filter", () => {
    let galRoot: string;
    const pad = (n: number) => `img-${String(n).padStart(2, "0")}.png`;

    beforeAll(async () => {
      const files: PubFile[] = [textFile("sub/x.txt", "x")];
      for (let i = 64; i >= 0; i--) {
        files.push(pngFile(pad(i), pngBytes(100 + i, i)));
      }
      files.push(textFile("a.pdf", "%PDF-a"), textFile("b.pdf", "%PDF-b"), textFile("c.pdf", "%PDF-c"));
      const s = await publishJson(dw, files);
      galRoot = `/s/${s}/`;
    });

    // GUARD: the 60-item cap already holds on the default render.
    it("All gallery keeps the 60-item cap in file order", async () => {
      const { html } = await listing(dw, galRoot);
      expect(galleryNames(html)).toEqual(Array.from({ length: 60 }, (_, i) => pad(i)));
    });

    // RED: the baseline shows all 68 file rows under ?kind=image.
    it("a filtered gallery keeps the cap: 65 matching images show 65 rows and the first 60 in the gallery", async () => {
      const { html } = await listing(dw, `${galRoot}?kind=image`);
      const rs = rows(html);
      expect(rs.filter((r) => r.isDir).map((r) => r.name)).toEqual(["sub/"]);
      expect(rs.filter((r) => !r.isDir).map((r) => r.name)).toEqual(Array.from({ length: 65 }, (_, i) => pad(i)));
      expect(galleryNames(html)).toEqual(Array.from({ length: 60 }, (_, i) => pad(i)));
      expect(galleryNames(html)).toEqual(rs.filter((r) => !r.isDir).slice(0, 60).map((r) => r.name));
    });

    // RED: the baseline gallery ignores the filter.
    it("a non-image filter on the cap folder drops the gallery but keeps honest counts", async () => {
      const plain = await listing(dw, galRoot);
      const { html } = await listing(dw, `${galRoot}?kind=pdf`);
      expect(rows(html).filter((r) => !r.isDir).map((r) => r.name)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
      expect(galleryNames(html)).toHaveLength(0);
      expectHonestTotals(html, plain.html, 3, 68);
    });
  });
});

describe("kind filter: nothing else changes", () => {
  // GUARD: kind= appears nowhere today; after the feature it must stay scoped to the controls.
  it("kind never propagates into file, folder, gallery, breadcrumb or app-viewer links", async () => {
    for (const q of ["?kind=pdf", "?kind=image"]) {
      const { html } = await listing(dw, `${root}${q}`);
      const nav = kindNav(html) ?? "";
      const start = html.indexOf(nav);
      const end = start + nav.length;
      const sortValues = new Map([["Name", "name"], ["Largest first", "size"], ["Type", "type"]]);
      for (const a of anchors(html)) {
        const inControls = nav !== "" && a.index >= start && a.index < end;
        const u = new URL(a.href, `https://dropway.test${root}`);
        // Only real same-folder header sort controls may preserve kind, never
        // breadcrumbs, file/folder rows, gallery links or app-viewer links.
        const isSortControl = a.index < html.indexOf("</header>") && u.pathname === root
          && u.searchParams.getAll("sort").length === 1 && u.searchParams.get("sort") === sortValues.get(a.label);
        if (inControls || isSortControl) continue;
        expect(a.href, `link "${a.label}" must not carry the kind parameter`).not.toContain("kind=");
      }
      for (const r of rows(html)) {
        expect(r.href, `row link for ${r.name} must stay canonical`).not.toContain("?");
      }
      for (const t of galleryTargets(html)) {
        expect(t.href, "gallery link must stay canonical").not.toContain("?");
        expect(t.src, "gallery image URL must stay canonical").not.toContain("?");
      }
      expect(html).not.toMatch(/\/v\/[^"]*kind=/);
    }
  });

  // GUARD: filtering hides rows; it never rewrites their destinations.
  it("file and folder hrefs are the same set on All and filtered renders", async () => {
    const base = new Map(allRows.map((r) => [r.name, r.href]));
    for (const q of ["?kind=pdf", "?kind=text", "?kind=video"]) {
      for (const r of rows((await listing(dw, `${root}${q}`)).html)) {
        expect(r.href, `href for ${r.name} under ${q}`).toBe(base.get(r.name));
      }
    }
  });

  // GUARD: the default summary format is unchanged by the feature's presence.
  it("the default summary keeps its plain totals with no M-of-N", async () => {
    const { html } = await listing(dw, root);
    expect(summary(html)).toMatch(/5 folders, 14 files/);
    expect(counts(html)).toBeNull();
  });

  // GUARD: no header, CSP or cache-policy change for filtered renders.
  it("filtered renders keep the listing CSP (form-action none), cache policy and viewer header", async () => {
    const plain = await listing(dw, root);
    const filtered = await listing(dw, `${root}?kind=pdf`);
    const csp = filtered.res.headers.get("content-security-policy")!;
    expect(csp).toBe(plain.res.headers.get("content-security-policy"));
    expect(csp).toContain("form-action 'none'");
    expect(csp).toMatch(/default-src 'none'/);
    expect(filtered.res.headers.get("cache-control")).toBe(plain.res.headers.get("cache-control"));
    expect(filtered.res.headers.get("cache-control")).toContain("must-revalidate");
    expect(filtered.res.headers.get("x-kofra-viewer")).toBe("listing");
  });

  // GUARD: kind is inert on file URLs in every serving mode; bytes and validators are identical.
  it("is inert on file URLs: raw, download, views and sub-resources hash identically with or without kind", async () => {
    const file = `${root}photo.png`;
    const modes: Array<[string, Record<string, string>]> = [
      ["", NAV], // rendered viewer
      ["", {}], // raw fetch / sub-resource
      ["?raw=1", NAV],
      ["?download=1", NAV],
      ["?view=1", {}],
      ["?view=source", NAV],
    ];
    for (const [q, headers] of modes) {
      const plain = await listing(dw, `${file}${q}`, headers);
      const withKind = await listing(dw, `${file}${q ? `${q}&` : "?"}kind=pdf`, headers);
      expect(withKind.res.status, `${q || "(navigation)"} status`).toBe(plain.res.status);
      expect(withKind.res.headers.get("content-type"), `${q} content-type`).toBe(plain.res.headers.get("content-type"));
      expect(withKind.res.headers.get("content-disposition"), `${q} content-disposition`).toBe(
        plain.res.headers.get("content-disposition"),
      );
      expect(withKind.res.headers.get("etag"), `${q} etag`).toBe(plain.res.headers.get("etag"));
      expect(withKind.html, `${q} bytes`).toBe(plain.html);
    }
  });

  // GUARD: an index page still wins over the listing, with or without kind=.
  it("is inert on sites with an index file, including the sandbox path shim and SPA fallback", async () => {
    const s = await publishJson(dw, [
      textFile("index.html", '<!doctype html><html><head><title>Home</title><script src="/app.js"></script></head><body>home</body></html>'),
      textFile("app.js", "console.log(1)"),
      textFile("report.pdf", "%PDF-r"),
    ]);
    const plain = await listing(dw, `/s/${s}/`);
    expect(plain.res.headers.get("x-kofra-viewer")).not.toBe("listing");
    const withKind = await listing(dw, `/s/${s}/?kind=pdf`);
    expect(withKind.html).toBe(plain.html);
    expect(withKind.html).toContain("<title>Home</title>");
    expect(withKind.html.split('<script data-dropway="path-shim">')).toHaveLength(2);
    expect(withKind.html).not.toContain("No files of this kind");

    await dw.json(`/api/v1/sites/${s}`, {
      method: "PATCH",
      key: dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spa: true }),
    });
    const spaPlain = await listing(dw, `/s/${s}/some/client/route`);
    const spaKind = await listing(dw, `/s/${s}/some/client/route?kind=pdf`);
    expect(spaKind.res.status).toBe(200);
    expect(spaKind.html).toBe(spaPlain.html);
    expect(spaKind.html).toContain("<title>Home</title>");
  });

  // GUARD: missing files still 404 with kind=.
  it("missing files still 404 with kind=", async () => {
    const res = await dw.call(`${root}nope.html?kind=pdf`, { headers: NAV });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Page not found");
  });

  // GUARD: browsing with kind= performs no storage or API mutation.
  it("filtered browsing adds no versions, files or index entries", async () => {
    const before = await dw.json(`/api/v1/sites/${slug}/files`, { key: dw.ownerKey });
    expect(before.status).toBe(200);
    for (const q of ["?kind=pdf", "?kind=image", "?kind=video", "?kind=bogus", "?kind="]) {
      const r = await listing(dw, `${root}${q}`);
      expect(r.res.status).toBe(200);
    }
    const after = await dw.json(`/api/v1/sites/${slug}/files`, { key: dw.ownerKey });
    expect(after.body).toEqual(before.body);
  });
});

describe("kind filter: conditional and cached responses", () => {
  // RED: the baseline answers every kind= with the All body, so a filtered
  // conditional request returns the wrong state.
  it("a filtered request never answers 304 with another display state's validator", async () => {
    const all = await listing(dw, root);
    const allEtag = all.res.headers.get("etag");
    const headers: Record<string, string> = { ...NAV };
    if (allEtag) headers["If-None-Match"] = allEtag;
    const filtered = await dw.call(`${root}?kind=pdf`, { headers });
    expect(filtered.status, "All validator must not 304 a filtered request").toBe(200);
    const html = await filtered.text();
    expect(html).toContain("report.pdf");
    expect(html).not.toContain("sheet.csv");
    expect(counts(html)).toEqual({ matching: expectedMembers("pdf").length, total: allFiles().length });
  });

  // GUARD (vacuous until listings carry validators): each display state revalidates on its own.
  it("an All request never answers 304 with a filtered validator, and validators differ per state when present", async () => {
    const filtered = await listing(dw, `${root}?kind=pdf`);
    const filteredEtag = filtered.res.headers.get("etag");
    const headers: Record<string, string> = { ...NAV };
    if (filteredEtag) headers["If-None-Match"] = filteredEtag;
    const all = await dw.call(root, { headers });
    expect(all.status, "filtered validator must not 304 the All request").toBe(200);
    expect(await all.text()).toContain("sheet.csv");
    const allEtag = all.headers.get("etag");
    if (allEtag && filteredEtag) {
      expect(filteredEtag, "All and filtered validators must differ").not.toBe(allEtag);
    }
  });
});

describe("kind filter: password gate runs before any filtered render", () => {
  // RED (post-unlock half): the 401/no-leak half passes today; the filtered half fails.
  it("a locked site leaks no file names or kind controls, and filters after unlock", async () => {
    const s = await publishJson(dw, [textFile("secret-big.pdf", "%PDF-big"), textFile("secret-small.txt", "s")]);
    const access = await dw.json(`/api/v1/sites/${s}/access`, {
      method: "PUT",
      key: dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "password", password: "correct-password" }),
    });
    expect(access.status).toBe(200);

    const locked = await listing(dw, `/s/${s}/?kind=pdf`);
    expect(locked.res.status).toBe(401);
    expect(locked.res.headers.get("x-kofra-viewer")).not.toBe("listing");
    expect(locked.html).not.toContain("secret-big.pdf");
    expect(locked.html).not.toContain("secret-small.txt");
    expect(locked.html).not.toContain("No files of this kind");
    expect(kindLinks(locked.html)).toHaveLength(0);

    const unlocked = await dw.call(`/s/${s}/__dropway/password`, {
      method: "POST",
      body: new URLSearchParams({ password: "correct-password" }),
      headers: { Origin: "https://dropway.test" },
    });
    expect(unlocked.status).toBe(303);
    const cookie = unlocked.headers.getSetCookie()[0]!.split(";", 1)[0]!;

    const filtered = await listing(dw, `/s/${s}/?kind=pdf`, { ...NAV, Cookie: cookie });
    expect(filtered.res.status).toBe(200);
    expect(filtered.res.headers.get("x-kofra-viewer")).toBe("listing");
    expect(rows(filtered.html).filter((r) => !r.isDir).map((r) => r.name)).toEqual(["secret-big.pdf"]);
    expect(counts(filtered.html)).toEqual({ matching: 1, total: 2 });
    expect(kindLinks(filtered.html).length).toBeGreaterThan(1);
  });
});

describe("kind filter: transfer gates run unchanged", () => {
  // GUARD: transfer slugs never render listings; kind= changes nothing there.
  it("kind= is inert on transfer deliveries: identical bytes, never a listing", async () => {
    const tdw = await transferInstance();
    const t = await createTransfer(tdw, { slug: "parcel-kind" });
    const plain = await followTransfer(tdw, `${TRANSFER_SITES}/${t.slug}/`, { headers: NAV });
    const plainBody = await plain.text();
    const kinded = await followTransfer(tdw, `${TRANSFER_SITES}/${t.slug}/?kind=pdf`, { headers: NAV });
    expect(kinded.status).toBe(plain.status);
    expect(await kinded.text()).toBe(plainBody);
    expect(kinded.headers.get("x-kofra-viewer")).not.toBe("listing");
    expect(plainBody).not.toContain('class="dw-ls"');
  });
});

describe("kind filter: subdomain parity", () => {
  let sub: Instance;
  let subSlug: string;
  const site = () => `https://${subSlug}.sites.test`;

  beforeAll(async () => {
    sub = await freshInstance({ appOrigin: "https://dropway.test", sitesMode: "subdomain", sitesDomain: "sites.test" });
    subSlug = await publishJson(sub, mixedFiles());
  });

  // RED: the baseline ignores kind= on subdomain origins too.
  it("filters, counts and recovers on a site's own origin", async () => {
    const plain = await listing(sub, `${site()}/`);
    expect(plain.res.headers.get("x-kofra-viewer")).toBe("listing");
    const { html } = await listing(sub, `${site()}/?kind=pdf`);
    expect(rows(html).filter((r) => !r.isDir).map((r) => r.name)).toEqual(["report.pdf"]);
    expect(rows(html).filter((r) => r.isDir).map((r) => r.name)).toEqual(["Alpha-dir/", "docs/", "my pics/", "only/", "sub/"]);
    expectHonestTotals(html, plain.html, 1, 14);
    const all = kindLinks(html).find((l) => l.label === "All");
    expect(all, "subdomain filter must offer All").toBeDefined();
    const u = new URL(all!.href, `${site()}/`);
    expect(u.pathname).toBe("/");
    expect(u.searchParams.has("kind")).toBe(false);
  });

  // GUARD: invalid values already normalize everywhere.
  it("invalid kind renders byte-identically to All on a subdomain origin", async () => {
    const plain = await listing(sub, `${site()}/`);
    for (const q of ["?kind=bogus", "?kind=", "?kind=all", "?KIND=pdf"]) {
      expect((await listing(sub, `${site()}/${q}`)).html, q).toBe(plain.html);
    }
  });

  // RED: the baseline gallery ignores the filter on subdomain origins too.
  it("gallery coherence holds on a subdomain origin", async () => {
    const all = await listing(sub, `${site()}/`);
    expect(galleryNames(all.html).length).toBeGreaterThan(0);
    const { html } = await listing(sub, `${site()}/?kind=pdf`);
    expect(galleryNames(html)).toHaveLength(0);
    expect(html).not.toContain('class="dw-gal"');
    const svg = await listing(sub, `${site()}/?kind=svg`);
    expect(galleryNames(svg.html)).toEqual([escapeHtml("café ☕.svg"), "tiny.svg"].sort(byName));
  });

  // RED (kind-href half): file encoding already holds; same-folder kind hrefs are new.
  it("encodes hostile names and keeps kind hrefs in the same encoded folder on a subdomain origin", async () => {
    const folder = `${site()}/${encodePath("my pics/")}`;
    const { html } = await listing(sub, `${folder}?kind=image`);
    expect(rows(html).filter((r) => !r.isDir).map((r) => r.name)).toEqual(["shot.png"]);
    for (const link of kindLinks(html)) {
      const u = new URL(link.href, folder);
      expect(u.pathname, `${link.label} href must stay in the encoded folder`).toBe(`/${encodePath("my pics/")}`);
    }
    const plain = await listing(sub, `${site()}/`);
    const hostile = HOSTILE_NAMES[0]!;
    expect(plain.html).toContain(`href="/${escapeHtml(encodeURIComponent(hostile))}"`);
    expect(plain.html).toContain(`>${escapeHtml(hostile)}</a>`);
  });
});
