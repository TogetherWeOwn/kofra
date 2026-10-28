/**
 * Acceptance contract: sort folder-listing files by name, size or type
 * with plain links.
 *
 * Written against the real served Worker (freshInstance + publish +
 * browser-navigation GETs), never against a reimplemented sorter. The
 * only computation in this file is deriving the *expected* order from
 * the fixture manifest the test itself published, using the comparator
 * the contract pins:
 *
 *   - Name order is `String.prototype.localeCompare` order — the exact
 *     order the listing already uses today (so "apple" < "Zebra" and
 *     "éclair" sorts with the e's, not after "z"). A code-point (`<`)
 *     comparator must fail these tests.
 *   - Size order is exact bytes descending, ties broken by name
 *     ascending (same localeCompare comparator).
 *   - Type order is the *displayed* kind label ascending (the text in
 *     each row's kind span, read back from the default render), ties
 *     broken by name ascending.
 *   - Folder rows always come first, themselves name-ordered.
 *
 * Pinned interface decisions (part of the contract):
 *   - The reserved query parameter is `sort` with exactly three
 *     recognized, case-sensitive values: `name`, `size`, `type`.
 *   - The three header links are labelled `Name`, `Largest first` and
 *     `Type`, each a plain anchor whose href is the same listing path
 *     with a single `sort=<value>` query parameter. The active sort's
 *     link carries `aria-current` (not `="false"`); inactive links
 *     carry no `aria-current` or `aria-current="false"`.
 *   - No parameter, `sort=name`, and any unrecognized value render
 *     byte-identically to each other (canonical default). A repeated
 *     `sort` parameter resolves to its first value.
 *
 * On the baseline (no sorting feature) the feature tests below fail
 * because the header links do not exist and `?sort=size|type` renders
 * plain name order. The inertness / regression guards pass on the
 * baseline and must keep passing.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

const byName = (a: string, b: string) => a.localeCompare(b);

interface Row {
  name: string;
  href: string;
  kind: string;
  isDir: boolean;
}

/** Rows of the listing's <ul>, in document order. */
function rows(html: string): Row[] {
  const out: Row[] = [];
  const re = /<li[^>]*>\s*<a href="([^"]+)"[^>]*>([^<]+)<\/a>\s*<span class="k">([^<]+)<\/span>/g;
  for (let m; (m = re.exec(html)); ) {
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
  for (let m; (m = re.exec(html)); ) {
    out.push({ attrs: m[1]!, href: m[2]!, label: m[3]!, index: m.index });
  }
  return out;
}

const SORT_LABELS = ["Name", "Largest first", "Type"] as const;
const SORT_VALUE: Record<(typeof SORT_LABELS)[number], string> = {
  Name: "name",
  "Largest first": "size",
  Type: "type",
};

function sortLinks(html: string): Anchor[] {
  return anchors(html).filter((a) => (SORT_LABELS as readonly string[]).includes(a.label));
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

/** The "N folders, M files · X" summary text, without trailing links. */
function summary(html: string): string {
  const m = /<span class="sum">([^<]*)</.exec(html);
  if (!m) throw new Error("listing summary span not found");
  return m[1]!;
}

async function publish(dw: Instance, files: Record<string, string | Uint8Array>): Promise<string> {
  const res = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(files) });
  expect(res.status, `publish failed: ${JSON.stringify(res.body)}`).toBe(201);
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
 * The mixed fixture. Insertion order is deliberately scrambled: neither
 * name, size nor type order matches publish order, so a pass cannot be
 * an accident of manifest order or sort stability.
 */
function mixedFiles(): Record<string, string | Uint8Array> {
  const png = new Uint8Array(120);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  return {
    "zeta-dir/inner.txt": "z",
    "song.mp3": "s".repeat(300),
    "Zebra.txt": "z".repeat(40),
    "data.json": '{"k":1}', // 7 B
    "mid-dir/inner.txt": "m",
    "big-notes.md": "# N\n" + "m".repeat(896), // 900 B
    "photo.png": png, // 120 B
    "apple.txt": "a".repeat(40),
    "clip.mp4": "v".repeat(300),
    "Alpha-dir/inner.txt": "a",
    "report.pdf": "%PDF-" + "p".repeat(50), // 55 B
    "éclair.txt": "e".repeat(40),
    // The CSV row pins type order to the *displayed* kind label: if the
    // label's alphabetical place differs from the internal kind id's
    // ("csv"), sorting by id must fail this suite.
    "sheet.csv": "a,b\n" + "1,2\n".repeat(4), // 20 B
    "tiny.svg": "<svg><!--" + "x".repeat(12) + "--></svg>", // 30 B
  };
}

/** Exact byte size per top-level file of the mixed fixture. */
const MIXED_SIZES: Record<string, number> = {
  "song.mp3": 300,
  "Zebra.txt": 40,
  "data.json": 7,
  "big-notes.md": 900,
  "photo.png": 120,
  "apple.txt": 40,
  "clip.mp4": 300,
  "report.pdf": 55,
  "éclair.txt": 40,
  "sheet.csv": 20,
  "tiny.svg": 30,
};

const MIXED_DIRS = ["zeta-dir/", "mid-dir/", "Alpha-dir/"];

let dw: Instance;
let slug: string;
let root: string;

beforeAll(async () => {
  dw = await freshInstance();
  slug = await publish(dw, mixedFiles());
  root = `/s/${slug}/`;
});

/** Expected file-row names for each sort, derived from the fixture. */
function expected(kindByName: Map<string, string>) {
  const names = Object.keys(MIXED_SIZES);
  return {
    dirs: [...MIXED_DIRS].sort(byName),
    name: [...names].sort(byName),
    size: [...names].sort((a, b) => MIXED_SIZES[b]! - MIXED_SIZES[a]! || byName(a, b)),
    type: [...names].sort((a, b) => byName(kindByName.get(a)!, kindByName.get(b)!) || byName(a, b)),
  };
}

/** Kind labels as displayed by the default render (the type-sort key). */
async function displayedKinds(): Promise<Map<string, string>> {
  const { html } = await listing(dw, root);
  return new Map(rows(html).filter((r) => !r.isDir).map((r) => [r.name, r.kind]));
}

function expectOrder(html: string, dirs: string[], files: string[]) {
  const rs = rows(html);
  expect(rs.map((r) => r.name)).toEqual([...dirs, ...files]);
  expect(rs.slice(0, dirs.length).every((r) => r.isDir)).toBe(true);
  expect(rs.slice(dirs.length).every((r) => !r.isDir)).toBe(true);
}

describe("listing sort: header controls", () => {
  it("offers exactly three plain sort links in the header, before the file list", async () => {
    const { res, html } = await listing(dw, root);
    expect(res.headers.get("x-kofra-viewer")).toBe("listing");
    const links = sortLinks(html);
    expect(links.map((l) => l.label)).toEqual(["Name", "Largest first", "Type"]);
    const headerEnd = html.indexOf("</header>");
    const listStart = html.indexOf("<ul>");
    expect(headerEnd).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.index, `${link.label} link must sit inside <header>`).toBeLessThan(headerEnd);
      expect(link.index, `${link.label} link must precede the file list`).toBeLessThan(listStart);
    }
  });

  it("sort links are self-referencing anchors carrying only the sort parameter", async () => {
    const { html } = await listing(dw, root);
    const links = sortLinks(html);
    expect(links.map((l) => l.label)).toEqual(["Name", "Largest first", "Type"]);
    for (const link of links) {
      const u = new URL(link.href, `https://dropway.test${root}`);
      expect(u.pathname, `${link.label} href must target the same listing`).toBe(root);
      expect([...u.searchParams.keys()], `${link.label} href must carry no parameter besides sort`).toEqual(["sort"]);
      expect(u.searchParams.get("sort")).toBe(SORT_VALUE[link.label as (typeof SORT_LABELS)[number]]);
    }
  });

  it("marks the active sort with aria-current and no other sort link", async () => {
    const cases: Array<[string, string]> = [
      [root, "Name"],
      [`${root}?sort=name`, "Name"],
      [`${root}?sort=size`, "Largest first"],
      [`${root}?sort=type`, "Type"],
      [`${root}?sort=bogus`, "Name"],
    ];
    for (const [path, active] of cases) {
      const { html } = await listing(dw, path);
      const links = sortLinks(html);
      expect(links, `${path}: all three sort links must render`).toHaveLength(3);
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

  it("needs no script: sort links are plain anchors and following one by GET applies the sort", async () => {
    const kinds = await displayedKinds();
    const exp = expected(kinds);
    const { html } = await listing(dw, root);
    expect(html).not.toContain("<script");
    const byLabel = new Map(sortLinks(html).map((l) => [l.label, l]));
    for (const label of SORT_LABELS) {
      const link = byLabel.get(label)!;
      expect(link, `missing ${label} sort link`).toBeDefined();
      expect(link.attrs).not.toMatch(/onclick/i);
      expect(link.attrs).not.toMatch(/tabindex\s*=\s*"-1"/i);
      const target = follow(root, link.href);
      const sorted = await listing(dw, target);
      expect(sorted.res.status).toBe(200);
      const files = label === "Name" ? exp.name : label === "Largest first" ? exp.size : exp.type;
      expectOrder(sorted.html, exp.dirs, files);
    }
  });

  it("keeps the narrow-screen shell: viewport meta stays and the header still precedes the list on sorted renders", async () => {
    const { html } = await listing(dw, `${root}?sort=size`);
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html.indexOf("</header>")).toBeLessThan(html.indexOf("<ul>"));
  });
});

describe("listing sort: ordering", () => {
  it("default (no parameter) is name order with folders first, exactly as today", async () => {
    const exp = expected(await displayedKinds());
    const { html } = await listing(dw, root);
    expectOrder(html, exp.dirs, exp.name);
  });

  it("?sort=name renders byte-identically to no parameter", async () => {
    const plain = await listing(dw, root);
    const named = await listing(dw, `${root}?sort=name`);
    expect(named.html).toBe(plain.html);
  });

  it("?sort=size is largest first: exact bytes descending, name ascending on ties, folders first", async () => {
    const exp = expected(await displayedKinds());
    const { html } = await listing(dw, `${root}?sort=size`);
    expectOrder(html, exp.dirs, exp.size);
    // The equal-size runs pin the tiebreak, not publish or engine order:
    // clip.mp4/song.mp3 are both 300 B; apple/éclair/Zebra are all 40 B.
    const names = rows(html).map((r) => r.name);
    expect(names.indexOf("clip.mp4")).toBeLessThan(names.indexOf("song.mp3"));
    expect(names.slice(names.indexOf("apple.txt"), names.indexOf("apple.txt") + 3)).toEqual(
      ["apple.txt", "éclair.txt", "Zebra.txt"].sort(byName),
    );
  });

  it("?sort=type groups by displayed kind label A to Z, then name, folders first", async () => {
    const exp = expected(await displayedKinds());
    const { html } = await listing(dw, `${root}?sort=type`);
    expectOrder(html, exp.dirs, exp.type);
    // Same-kind runs stay contiguous and name-ordered inside the run.
    const kinds = rows(html).filter((r) => !r.isDir).map((r) => r.kind);
    expect(kinds).toEqual([...kinds].sort(byName));
  });

  it("name order is locale order, not code-point order (case and unicode)", async () => {
    const { html } = await listing(dw, root);
    const names = rows(html).map((r) => r.name);
    // Code-point order would put "Zebra.txt" (Z=0x5A) before "apple.txt"
    // (a=0x61) and "éclair.txt" (é=0xE9) after "tiny.svg" (t=0x74).
    expect(names.indexOf("apple.txt")).toBeLessThan(names.indexOf("Zebra.txt"));
    expect(names.indexOf("éclair.txt")).toBeLessThan(names.indexOf("tiny.svg"));
    expect(names.indexOf("Alpha-dir/")).toBeLessThan(names.indexOf("zeta-dir/"));
  });

  it("is deterministic regardless of publish order (comparator, not sort stability)", async () => {
    const reversed = Object.fromEntries(Object.entries(mixedFiles()).reverse());
    const slug2 = await publish(dw, reversed);
    for (const q of ["", "?sort=size", "?sort=type"]) {
      const a = rows((await listing(dw, `${root}${q}`)).html).map((r) => r.name);
      const b = rows((await listing(dw, `/s/${slug2}/${q}`)).html).map((r) => r.name);
      expect(b, `order for ${q || "(default)"} must not depend on publish order`).toEqual(a);
    }
  });

  it("nested folder listings sort too, and a subfolder starts at default order when followed from a sorted parent", async () => {
    const sub = await publish(dw, {
      "root.txt": "r",
      "docs-a/b.txt": "b".repeat(10),
      "docs-a/a.txt": "a".repeat(99),
      "docs-a/c.md": "c".repeat(50),
    });
    const parentSorted = await listing(dw, `/s/${sub}/?sort=size`);
    const dirRow = rows(parentSorted.html).find((r) => r.isDir)!;
    expect(dirRow.href, "folder links must stay canonical").toBe(`/s/${sub}/docs-a/`);

    const followed = await listing(dw, dirRow.href);
    expect(rows(followed.html).map((r) => r.name)).toEqual(["a.txt", "b.txt", "c.md"]);

    const sortedSub = await listing(dw, `/s/${sub}/docs-a/?sort=size`);
    expect(rows(sortedSub.html).map((r) => r.name)).toEqual(["a.txt", "c.md", "b.txt"]);
    expect(sortLinks(sortedSub.html).map((l) => l.label)).toEqual(["Name", "Largest first", "Type"]);
  });

  it("a folder of only subfolders still offers the sort links and keeps folder name order", async () => {
    const s = await publish(dw, { "top.txt": "t", "only/b/x.txt": "x", "only/a/x.txt": "x" });
    const { html } = await listing(dw, `/s/${s}/only/?sort=type`);
    expect(rows(html).map((r) => r.name)).toEqual(["a/", "b/"]);
    expect(sortLinks(html)).toHaveLength(3);
  });
});

describe("listing sort: unrecognized and hostile input", () => {
  const bogus = [
    "",
    "bogus",
    "SIZE",
    "Size",
    " size",
    "size ",
    "name,size",
    "-size",
    "desc",
    "0",
    "../../etc",
    "' OR 1=1 --",
    "s".repeat(4096),
  ];

  it.each(bogus)("unrecognized sort value renders byte-identically to the default: %j", async (value) => {
    const plain = await listing(dw, root);
    const res = await listing(dw, `${root}?sort=${encodeURIComponent(value)}`);
    expect(res.res.status).toBe(200);
    expect(res.html).toBe(plain.html);
  });

  it("parameter name is case-sensitive: ?SORT=size is the default render", async () => {
    const plain = await listing(dw, root);
    const res = await listing(dw, `${root}?SORT=size`);
    expect(res.html).toBe(plain.html);
  });

  it("never reflects a hostile sort value into the page", async () => {
    const attack = '"><script>alert(1)</script>';
    const { html } = await listing(dw, `${root}?sort=${encodeURIComponent(attack)}`);
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("<script");
  });

  it("a repeated sort parameter resolves to its first value", async () => {
    const exp = expected(await displayedKinds());
    const sizeFirst = await listing(dw, `${root}?sort=size&sort=name`);
    expectOrder(sizeFirst.html, exp.dirs, exp.size);
    const plain = await listing(dw, root);
    const bogusFirst = await listing(dw, `${root}?sort=bogus&sort=size`);
    expect(bogusFirst.html).toBe(plain.html);
  });

  it("sort still applies alongside unrelated query parameters", async () => {
    const exp = expected(await displayedKinds());
    const { html } = await listing(dw, `${root}?utm_source=test&sort=size&ref=listing`);
    expectOrder(html, exp.dirs, exp.size);
  });
});

describe("listing sort: nothing else changes", () => {
  it("sort never propagates into file, folder, gallery or header links", async () => {
    for (const q of ["?sort=size", "?sort=type"]) {
      const { html } = await listing(dw, `${root}${q}`);
      expect(sortLinks(html), `${q}: all three sort links must render`).toHaveLength(3);
      const sortHrefs = new Set(sortLinks(html).map((l) => l.href));
      for (const a of anchors(html)) {
        if (sortHrefs.has(a.href) && (SORT_LABELS as readonly string[]).includes(a.label)) continue;
        expect(a.href, `link "${a.label}" must not carry the sort parameter`).not.toContain("sort=");
      }
      for (const r of rows(html)) {
        expect(r.href, `row link for ${r.name} must stay canonical`).not.toContain("?");
      }
      for (const m of html.matchAll(/<img src="([^"]+)"/g)) {
        expect(m[1], "gallery image URLs must stay canonical").not.toContain("?");
      }
    }
  });

  it("file and folder hrefs are the same set in every sort", async () => {
    const base = rows((await listing(dw, root)).html).map((r) => r.href).sort();
    for (const q of ["?sort=size", "?sort=type"]) {
      const hrefs = rows((await listing(dw, `${root}${q}`)).html).map((r) => r.href).sort();
      expect(hrefs).toEqual(base);
    }
  });

  it("summary counts and totals are unchanged by sorting", async () => {
    const base = summary((await listing(dw, root)).html);
    expect(base).toMatch(/3 folders, 11 files/);
    for (const q of ["?sort=size", "?sort=type", "?sort=bogus"]) {
      expect(summary((await listing(dw, `${root}${q}`)).html)).toBe(base);
    }
  });

  it("no new or changed headers: CSP, cache policy and header set match the default render", async () => {
    const plain = await listing(dw, root);
    const sorted = await listing(dw, `${root}?sort=size`);
    expect(sorted.res.headers.get("content-security-policy")).toBe(plain.res.headers.get("content-security-policy"));
    expect(sorted.res.headers.get("cache-control")).toBe(plain.res.headers.get("cache-control"));
    expect(sorted.res.headers.get("x-kofra-viewer")).toBe("listing");
    expect([...sorted.res.headers.keys()].sort()).toEqual([...plain.res.headers.keys()].sort());
  });

  it("is inert on file URLs in every serving mode", async () => {
    const file = `${root}apple.txt`;
    const modes: Array<[string, Record<string, string>]> = [
      ["", NAV], // rendered viewer
      ["", {}], // raw fetch
      ["?raw=1", NAV],
      ["?download=1", NAV],
      ["?view=1", {}],
      ["?view=source", NAV],
    ];
    for (const [q, headers] of modes) {
      const plain = await listing(dw, `${file}${q}`, headers);
      const withSort = await listing(dw, `${file}${q ? q + "&" : "?"}sort=size`, headers);
      expect(withSort.res.status, `${q} status`).toBe(plain.res.status);
      expect(withSort.res.headers.get("content-type"), `${q} content-type`).toBe(plain.res.headers.get("content-type"));
      expect(withSort.res.headers.get("content-disposition"), `${q} content-disposition`).toBe(plain.res.headers.get("content-disposition"));
      expect(withSort.res.headers.get("etag"), `${q} etag`).toBe(plain.res.headers.get("etag"));
      expect(withSort.html, `${q} body`).toBe(plain.html);
    }
  });

  it("is inert on sites with an index file, including the sandbox path shim and SPA fallback", async () => {
    const s = await publish(dw, {
      "index.html": '<!doctype html><html><head><title>Home</title><script src="/app.js"></script></head><body>home</body></html>',
      "app.js": "console.log(1)",
    });
    const plain = await listing(dw, `/s/${s}/`);
    expect(plain.res.headers.get("x-kofra-viewer")).not.toBe("listing");
    const withSort = await listing(dw, `/s/${s}/?sort=size`);
    expect(withSort.html).toBe(plain.html);
    expect(withSort.html).toContain("<title>Home</title>");
    expect(withSort.html.split('<script data-dropway="path-shim">')).toHaveLength(2);
    expect(withSort.html).not.toContain("Largest first");

    await dw.json(`/api/v1/sites/${s}`, {
      method: "PATCH", key: dw.ownerKey, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spa: true }),
    });
    const spaPlain = await listing(dw, `/s/${s}/some/client/route`);
    const spaSorted = await listing(dw, `/s/${s}/some/client/route?sort=type`);
    expect(spaSorted.res.status).toBe(200);
    expect(spaSorted.html).toBe(spaPlain.html);
    expect(spaSorted.html).toContain("<title>Home</title>");
  });

  it("folder redirect (missing trailing slash) still redirects to the canonical folder path", async () => {
    const res = await dw.call(`${root}mid-dir?sort=size`, { headers: NAV });
    expect(res.status).toBe(301);
    expect(new URL(res.headers.get("location")!, "https://dropway.test").pathname).toBe(`${root}mid-dir/`);
  });
});

describe("listing sort: image gallery follows the sorted order under its cap", () => {
  let galRoot: string;
  const pad = (n: number) => `img-${String(n).padStart(2, "0")}.png`;

  beforeAll(async () => {
    const files: Record<string, string | Uint8Array> = { "sub/x.txt": "x" };
    // 65 images; byte size grows with the numeric suffix so size order
    // is the exact reverse of name order.
    for (let i = 64; i >= 0; i--) {
      const bytes = new Uint8Array(100 + i);
      bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
      files[pad(i)] = bytes;
    }
    const s = await publish(dw, files);
    galRoot = `/s/${s}/`;
  });

  it("default gallery is the first 60 images in name order", async () => {
    const { html } = await listing(dw, galRoot);
    expect(galleryNames(html)).toEqual(Array.from({ length: 60 }, (_, i) => pad(i)));
  });

  it("size-sorted gallery is the 60 largest, largest first, and rows keep folders first", async () => {
    const { html } = await listing(dw, `${galRoot}?sort=size`);
    expect(galleryNames(html)).toEqual(Array.from({ length: 60 }, (_, i) => pad(64 - i)));
    const rs = rows(html);
    expect(rs[0]).toMatchObject({ name: "sub/", isDir: true });
    expect(rs.slice(1).map((r) => r.name)).toEqual(Array.from({ length: 65 }, (_, i) => pad(64 - i)));
    // Gallery entries are the leading image rows of the same render.
    expect(galleryNames(html)).toEqual(rs.slice(1, 61).map((r) => r.name));
  });

  it("type-sorted gallery falls back to name order within the single kind", async () => {
    const { html } = await listing(dw, `${galRoot}?sort=type`);
    expect(galleryNames(html)).toEqual(Array.from({ length: 60 }, (_, i) => pad(i)));
  });
});

describe("listing sort: password gate runs before any sorted render", () => {
  it("a locked site leaks no file names or sort links, and sorts after unlock", async () => {
    const s = await publish(dw, {
      "secret-big.txt": "b".repeat(200),
      "secret-small.txt": "s",
    });
    const access = await dw.json(`/api/v1/sites/${s}/access`, {
      method: "PUT", key: dw.ownerKey, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "password", password: "correct-password" }),
    });
    expect(access.status).toBe(200);

    const locked = await listing(dw, `/s/${s}/?sort=size`);
    expect(locked.res.status).toBe(401);
    expect(locked.res.headers.get("x-kofra-viewer")).not.toBe("listing");
    expect(locked.html).not.toContain("secret-big.txt");
    expect(locked.html).not.toContain("secret-small.txt");
    expect(locked.html).not.toContain("Largest first");

    const unlocked = await dw.call(`/s/${s}/__dropway/password`, {
      method: "POST",
      body: new URLSearchParams({ password: "correct-password" }),
      headers: { Origin: "https://dropway.test" },
    });
    expect(unlocked.status).toBe(303);
    const cookie = unlocked.headers.getSetCookie()[0]!.split(";", 1)[0]!;

    const sorted = await listing(dw, `/s/${s}/?sort=size`, { ...NAV, Cookie: cookie });
    expect(sorted.res.status).toBe(200);
    expect(sorted.res.headers.get("x-kofra-viewer")).toBe("listing");
    expect(rows(sorted.html).map((r) => r.name)).toEqual(["secret-big.txt", "secret-small.txt"]);
    expect(sortLinks(sorted.html)).toHaveLength(3);
  });
});
