/**
 * Markdown contents-outline contract (paired acceptance tests; the paired
 * build must keep this file unchanged and make it pass).
 *
 * Outcome: a standalone rendered Markdown document with at least two rendered
 * headings gets one native collapsible Contents navigation, before the first
 * heading, that works with JavaScript disabled:
 *
 * - one `<details>` whose `<summary>` reads "Contents", associated with a
 *   `<nav aria-label="Contents">` (either may wrap the other), with class hooks
 *   styled from the existing viewer tokens (var(--...)), a visible
 *   :focus-visible outline for the summary/links, and no fixed pixel width or
 *   nowrap that would break a narrow layout;
 * - one fragment link per actual Markdown heading token (h1-h6, ATX and
 *   setext), in document order, each href equal to the id the same render pass
 *   assigned to that heading, each label the heading's plain escaped text
 *   (no copied inline markup, no nested/duplicated interactive links), and
 *   each entry carrying an accessible level cue: a data-level/data-depth
 *   attribute, a level class, an aria "level N" label, or nested-list depth;
 * - only Markdown heading tokens are collected: not front matter, not
 *   fenced-code lookalikes, not raw-HTML headings; hostile heading markup
 *   must stay inert in the outline exactly as in the sanitized body;
 * - at most the first 200 rendered headings are listed, with a truthful
 *   truncation note inside the contents block when there are more; the body
 *   keeps every heading under the existing caps;
 * - fewer than two rendered headings: no contents control at all.
 *
 * Preserved behaviour: heading id generation and every existing deep link,
 * title/front-matter rendering, raw/source/download byte identity, the
 * no-script viewer CSP, notebook cells and other shared-helper fragments
 * (renderMarkdown() itself gains no outline), and directory listings.
 * Changed rendered output must bump the Markdown viewer version above 2 so
 * markdown@2 fragments and ETags are retired. The build also documents the
 * outline in the canonical viewer note (docs/ARCHITECTURE.md, "Viewing
 * files") and verifies a served page in a disposable browser with scripts
 * disabled, keyboard only, at a narrow width.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { cachedRender, clearRenderMemoryCache } from "../packages/server/src/viewers/cache";
import { markdownViewer, renderMarkdown } from "../packages/server/src/viewers/markdown";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

const many = (n: number): string => Array.from({ length: n }, (_, i) => `## Section ${i + 1}\n\nBody ${i + 1}.\n`).join("\n");

const notebook = JSON.stringify({
  metadata: { language_info: { name: "python" } },
  cells: [
    { cell_type: "markdown", source: "# Cell Title\n\n## Cell Section\n\n### Cell Detail\n" },
    { cell_type: "code", execution_count: 1, source: "print('hi')", outputs: [] },
  ],
});

const fixtures: Record<string, string> = {
  "none.md": "Just a paragraph.\n\nAnother paragraph, no headings at all.\n",
  "one.md": "# Only One Heading\n\nSome text under it.\n",
  "two.md": "# First Report\n\nIntro paragraph.\n\n## Second Section\n\nBody text.\n",
  "levels.md": "# Level One\n\n## Level Two\n\n### Level Three\n\n#### Level Four\n\n##### Level Five\n\n###### Level Six\n",
  "anchors.md":
    "# Guide\n\n## Hello, World!\n\n## Hello, World!\n\n## Café — déjà vu\n\n## Café — déjà vu\n\n## !!!\n\n## !!!\n\n## 日本語 テスト\n\n## 日本語 テスト\n",
  "fences.md":
    "# Real Title\n\n```md\n# Fake heading in a fence\n## Also fake\n```\n\n## Real Section\n\n~~~\n# Tilde fence fake\n~~~\n\nTrailing text.\n",
  "frontmatter.md":
    "---\ntitle: Quarterly Report\n# not a heading, just front matter\n---\n# Real One\n\n## Real Two\n",
  "setext.md": "Setext Title\n============\n\n## ATX Section\n\nSetext Subtitle\n---------------\n",
  "links.md":
    "# Using `code` and **bold** text\n\n## Read [the linked docs](https://example.com/docs) & more\n\n## Plain & simple <em>emphasised</em> tail\n",
  "hostile.md":
    '# Safe <script>alert(1)</script> Title\n\n## Click <a href="javascript:alert(2)">here</a> now\n\n## Pic <img src="x" onerror="alert(3)"> end\n',
  "rawhtml.md": '# Markdown Title\n\n<h2 id="raw-custom">Raw HTML heading</h2>\n\n## Markdown Section\n',
  "many200.md": many(200),
  "many205.md": many(205),
  "notebooks/outline.ipynb": notebook,
};

/** Decode the small entity set the viewer emits; used only to read labels back. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const plainText = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs) ?? new RegExp(`\\b${name}='([^']*)'`).exec(attrs);
  return m ? decodeEntities(m[1]!) : null;
}

export interface OutlineParts {
  /** The `<details>...</details>` whose summary reads Contents, if any. */
  details: string | null;
  /** The `<nav aria-label="Contents">...</nav>`, if any. */
  nav: string | null;
  /** The larger block holding the outline links (nav when it wraps details). */
  root: string | null;
  /** Exact substring to remove before reading body headings. */
  remove: string | null;
}

function outlineParts(html: string): OutlineParts {
  let details: string | null = null;
  for (const m of html.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)) {
    const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/.exec(m[0]);
    if (summary && /contents/i.test(plainText(summary[1]!))) {
      details = m[0];
      break;
    }
  }
  let nav: string | null = null;
  for (const m of html.matchAll(/<nav\b([^>]*)>[\s\S]*?<\/nav>/g)) {
    if (/contents/i.test(attr(m[1]!, "aria-label") ?? "")) {
      nav = m[0];
      break;
    }
  }
  const root = nav && details && nav.includes(details) ? nav : details && nav && details.includes(nav) ? details : (details ?? nav);
  return { details, nav, root, remove: root };
}

interface OutlineEntry {
  href: string;
  /** Raw inner HTML of the link: must be plain text, never copied markup. */
  labelHtml: string;
  label: string;
  /** Level from data-*, class or aria cue; otherwise nested-list depth. */
  level: number | null;
}

function levelFrom(attrsList: string[], blockBeforeAnchor: string): number | null {
  for (const attrs of attrsList) {
    for (const name of ["data-level", "data-depth"]) {
      const v = attr(attrs, name);
      if (v && /^[1-6]$/.test(v)) return Number(v);
    }
    const aria = attr(attrs, "aria-label");
    const fromAria = aria ? /level\s*([1-6])\b/i.exec(aria) : null;
    if (fromAria) return Number(fromAria[1]);
    const cls = attr(attrs, "class") ?? "";
    for (const token of cls.split(/\s+/)) {
      const m = /(?:^|[-_])(?:level|depth|h|l)-?([1-6])$/.exec(token) ?? /^h([1-6])$/.exec(token);
      if (m) return Number(m[1]);
    }
  }
  // Nested lists: depth of open <ul>/<ol> elements at this anchor.
  let depth = 0;
  for (const t of blockBeforeAnchor.matchAll(/<(\/?)(ul|ol)\b[^>]*>/g)) depth += t[1] ? -1 : 1;
  return depth > 0 ? depth : null;
}

function outlineEntries(html: string): OutlineEntry[] {
  const { root } = outlineParts(html);
  if (!root) return [];
  const entries: OutlineEntry[] = [];
  for (const m of root.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const href = attr(m[1]!, "href") ?? "";
    if (!href.startsWith("#")) {
      entries.push({ href, labelHtml: m[2]!, label: plainText(m[2]!), level: null });
      continue;
    }
    const before = root.slice(0, m.index);
    const liAttrs = [...before.matchAll(/<li\b([^>]*)>/g)].at(-1)?.[1] ?? "";
    entries.push({
      href,
      labelHtml: m[2]!,
      label: plainText(m[2]!),
      level: levelFrom([m[1]!, liAttrs], before),
    });
  }
  return entries;
}

interface BodyHeading {
  depth: number;
  id: string;
  label: string;
}

/** Headings of the rendered document itself (outline removed first). */
function bodyHeadings(html: string): BodyHeading[] {
  const { remove } = outlineParts(html);
  const body = remove ? html.replace(remove, "") : html;
  return Array.from(body.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/g), (m) => ({
    depth: Number(m[1]),
    id: attr(m[2]!, "id") ?? "",
    label: plainText(m[3]!.replace(/<a\b[^>]*class="[^"]*dw-anchor[^"]*"[^>]*>[\s\S]*?<\/a>/g, "")),
  })).filter((h) => h.id !== "");
}

/** Style rules whose selector mentions one of the outline's classes. */
function outlineCssRules(html: string): Array<{ selector: string; body: string }> {
  const { root } = outlineParts(html);
  if (!root) return [];
  const classes = new Set<string>();
  for (const m of root.matchAll(/class="([^"]*)"/g)) for (const c of m[1]!.split(/\s+/).filter(Boolean)) classes.add(c);
  const css = Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g), (m) => m[1]!).join("\n");
  return Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({ selector: m[1]!.trim(), body: m[2]! })).filter((r) =>
    [...classes].some((c) => r.selector.includes(`.${c}`)),
  );
}

describe("Markdown contents outline in workerd", () => {
  let dw: Instance;
  let slug: string;
  beforeAll(async () => {
    dw = await freshInstance();
    const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(fixtures) });
    expect(published.status).toBe(201);
    slug = published.body.slug;
  });
  beforeEach(() => clearRenderMemoryCache());
  const get = (path: string, headers: Record<string, string> = NAV) => dw.call(`/s/${slug}/${path}`, { headers });
  const page = async (path: string): Promise<string> => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("markdown");
    return res.text();
  };

  it.each(["none.md", "one.md"])("omits the contents control for %s (fewer than two headings)", async (path) => {
    const html = await page(path);
    const parts = outlineParts(html);
    expect(parts.details).toBeNull();
    expect(parts.nav).toBeNull();
    expect(outlineEntries(html)).toEqual([]);
  });

  it("adds one native collapsible Contents navigation before the first heading", async () => {
    const html = await page("two.md");
    const parts = outlineParts(html);
    expect(parts.details).not.toBeNull();
    expect(parts.nav).not.toBeNull();
    // The links live inside the collapsible element (native, no script needed).
    expect(parts.details!).toContain('href="#first-report"');
    // Exactly one contents block.
    const summaries = Array.from(html.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g), (m) => plainText(m[1]!)).filter((t) =>
      /contents/i.test(t),
    );
    expect(summaries).toHaveLength(1);
    // Before the first rendered heading, so readers need not scroll to it.
    expect(html.indexOf(parts.root!)).toBeLessThan(html.indexOf('<h1 id="first-report">'));
    const entries = outlineEntries(html);
    const headings = bodyHeadings(html);
    expect(headings.map((h) => h.id)).toEqual(["first-report", "second-section"]);
    expect(entries.map((e) => e.href)).toEqual(headings.map((h) => `#${h.id}`));
    expect(entries.map((e) => e.label)).toEqual(["First Report", "Second Section"]);
    for (const e of entries) expect(e.labelHtml).not.toContain("<");
  });

  it("lists h1-h6 in document order with an accessible cue for each level", async () => {
    const html = await page("levels.md");
    const entries = outlineEntries(html);
    const headings = bodyHeadings(html);
    expect(headings.map((h) => h.depth)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(entries.map((e) => e.href)).toEqual(headings.map((h) => `#${h.id}`));
    expect(entries.map((e) => e.label)).toEqual(headings.map((h) => h.label));
    expect(entries.map((e) => e.level)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps existing anchors and resolves duplicates, unicode and empty-punctuation headings to their real ids", async () => {
    const html = await page("anchors.md");
    // The pre-existing deep-link contract: these ids must not move.
    const expectedIds = [
      "guide",
      "hello-world",
      "hello-world-1",
      "café-déjà-vu",
      "café-déjà-vu-1",
      "section",
      "section-1",
      "日本語-テスト",
      "日本語-テスト-1",
    ];
    const headings = bodyHeadings(html);
    expect(headings.map((h) => h.id)).toEqual(expectedIds);
    expect(new Set(headings.map((h) => h.id)).size).toBe(expectedIds.length);
    // Every outline href resolves to the heading rendered in the same pass.
    const entries = outlineEntries(html);
    expect(entries.map((e) => e.href)).toEqual(expectedIds.map((id) => `#${id}`));
    expect(entries.map((e) => e.label)).toEqual(headings.map((h) => h.label));
    expect(entries.map((e) => e.label)).toEqual([
      "Guide",
      "Hello, World!",
      "Hello, World!",
      "Café — déjà vu",
      "Café — déjà vu",
      "!!!",
      "!!!",
      "日本語 テスト",
      "日本語 テスト",
    ]);
  });

  it("collects only Markdown heading tokens, not fenced-code lookalikes", async () => {
    const html = await page("fences.md");
    expect(bodyHeadings(html).map((h) => h.label)).toEqual(["Real Title", "Real Section"]);
    expect(outlineEntries(html).map((e) => e.label)).toEqual(["Real Title", "Real Section"]);
    // The fenced source still renders as code in the body.
    expect(html).toContain("Fake heading in a fence");
  });

  it("ignores front matter and preserves its title and rendering", async () => {
    const html = await page("frontmatter.md");
    expect(html).toContain("<title>Quarterly Report</title>");
    expect(html).toContain("<summary>Front matter</summary>");
    expect(outlineEntries(html).map((e) => e.label)).toEqual(["Real One", "Real Two"]);
    expect(outlineEntries(html).map((e) => e.href)).toEqual(["#real-one", "#real-two"]);
  });

  it("includes setext headings, not only ATX lines", async () => {
    const html = await page("setext.md");
    expect(bodyHeadings(html).map((h) => h.label)).toEqual(["Setext Title", "ATX Section", "Setext Subtitle"]);
    expect(outlineEntries(html).map((e) => e.label)).toEqual(["Setext Title", "ATX Section", "Setext Subtitle"]);
  });

  it("uses plain escaped labels and copies no active inline markup or links", async () => {
    const html = await page("links.md");
    // Premise: the rendered headings themselves read as these plain labels.
    expect(bodyHeadings(html).map((h) => h.label)).toEqual([
      "Using code and bold text",
      "Read the linked docs & more",
      "Plain & simple emphasised tail",
    ]);
    const entries = outlineEntries(html);
    expect(entries.map((e) => e.label)).toEqual([
      "Using code and bold text",
      "Read the linked docs & more",
      "Plain & simple emphasised tail",
    ]);
    for (const e of entries) {
      expect(e.href).toMatch(/^#/);
      expect(e.labelHtml).not.toContain("<");
    }
    const { root } = outlineParts(html);
    expect(root).not.toContain("https://example.com");
    expect(root).not.toMatch(/<code|<strong|<em\b/);
  });

  it("keeps hostile heading markup inert in the outline and the page", async () => {
    const res = await get("hostile.md");
    const html = await res.text();
    expect(html).not.toMatch(/<script\b/i);
    // Premise: all three hostile headings still render as body headings.
    expect(bodyHeadings(html)).toHaveLength(3);
    const { root } = outlineParts(html);
    expect(root).not.toBeNull();
    expect(root).not.toMatch(/<script\b|<img\b|<a\b[^>]*href="\s*javascript:/i);
    expect(root).not.toMatch(/<[^>]+\bon\w+\s*=/i);
    const entries = outlineEntries(html);
    const headings = bodyHeadings(html);
    expect(headings).toHaveLength(3);
    expect(entries.map((e) => e.href)).toEqual(headings.map((h) => `#${h.id}`));
    for (const e of entries) {
      expect(e.href).toMatch(/^#/);
      expect(e.labelHtml).not.toContain("<");
    }
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("does not collect raw-HTML headings that the render pass never assigned an id", async () => {
    const html = await page("rawhtml.md");
    // Premise: the raw heading is served in the body with its author id.
    expect(html).toContain('id="raw-custom"');
    expect(html).toContain("Raw HTML heading");
    const entries = outlineEntries(html);
    expect(entries.map((e) => e.label)).toEqual(["Markdown Title", "Markdown Section"]);
    expect(entries.map((e) => e.href)).not.toContain("#raw-custom");
  });

  it("lists exactly 200 headings in full, with no truncation note", async () => {
    const html = await page("many200.md");
    const headings = bodyHeadings(html);
    const entries = outlineEntries(html);
    expect(headings).toHaveLength(200);
    expect(entries.map((e) => e.href)).toEqual(headings.map((h) => `#${h.id}`));
    expect(plainText(outlineParts(html).root!)).not.toMatch(/truncat/i);
  });

  it("bounds the outline to the first 200 headings with a truthful note, body complete", async () => {
    const html = await page("many205.md");
    const headings = bodyHeadings(html);
    const entries = outlineEntries(html);
    expect(headings).toHaveLength(205);
    expect(headings.at(-1)?.label).toBe("Section 205");
    expect(entries).toHaveLength(200);
    expect(entries.map((e) => e.href)).toEqual(headings.slice(0, 200).map((h) => `#${h.id}`));
    expect(entries.map((e) => e.href)).not.toContain(`#${headings.at(-1)!.id}`);
    const note = plainText(outlineParts(html).root!);
    expect(note).toMatch(/200/);
    expect(note).toMatch(/first|truncat|more|205/i);
  });

  it.each(["?raw=1", "?download=1"])("preserves exact stored bytes for %s", async (query) => {
    const res = await get(`anchors.md${query}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new TextEncoder().encode(fixtures["anchors.md"]!));
    if (query === "?raw=1") expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    if (query === "?download=1") expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("serves the stored bytes to non-navigation requests and no outline in source view", async () => {
    const fetched = await get("two.md", { Accept: "*/*", "Sec-Fetch-Dest": "empty" });
    expect(fetched.headers.get("x-kofra-viewer")).toBeNull();
    expect(await fetched.text()).toBe(fixtures["two.md"]);
    const source = await get("two.md?view=source");
    expect(source.headers.get("x-kofra-viewer")).toBe("source");
    const html = await source.text();
    expect(outlineParts(html).details).toBeNull();
    expect(outlineParts(html).nav).toBeNull();
  });

  it("adds no outline to notebook cells or directory listings", async () => {
    const nb = await get("notebooks/outline.ipynb");
    expect(nb.headers.get("x-kofra-viewer")).toBe("notebook");
    const nbHtml = await nb.text();
    expect(nbHtml).toContain("Cell Title");
    expect(nbHtml).toContain("Cell Section");
    expect(outlineParts(nbHtml).details).toBeNull();
    expect(outlineParts(nbHtml).nav).toBeNull();

    const listing = await get("notebooks/");
    expect(listing.headers.get("x-kofra-viewer")).toBe("listing");
    const listHtml = await listing.text();
    expect(outlineParts(listHtml).details).toBeNull();
    expect(outlineParts(listHtml).nav).toBeNull();
  });

  it("is keyboard-operable without scripts and styled for narrow layouts from existing tokens", async () => {
    const html = await page("two.md");
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    const { root } = outlineParts(html);
    expect(root).not.toBeNull();
    // Native interactive elements only: a real summary and real anchors,
    // nothing removed from the tab order.
    expect(root).toMatch(/<summary\b/);
    expect(root).not.toMatch(/tabindex="-1"/);
    for (const e of outlineEntries(html)) expect(e.href).toMatch(/^#[^"]+$/);
    const rules = outlineCssRules(html);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((r) => /:focus-visible|:focus/.test(r.selector) && /outline/.test(r.body))).toBe(true);
    expect(rules.some((r) => /var\(--/.test(r.body))).toBe(true);
    for (const r of rules) {
      expect(r.body).not.toMatch(/white-space:\s*nowrap/);
      expect(r.body).not.toMatch(/min-width:\s*\d+px/);
      const fixed = /(?:^|;)\s*width:\s*(\d+)px/.exec(r.body);
      if (fixed) expect(Number(fixed[1])).toBeLessThanOrEqual(320);
    }
  });

  it("serves the same outline to concurrent readers of one document", async () => {
    const [a, b] = await Promise.all([get("levels.md"), get("levels.md")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const entriesA = outlineEntries(await a.text());
    const entriesB = outlineEntries(await b.text());
    expect(entriesA).toHaveLength(6);
    expect(entriesA).toEqual(entriesB);
  });

  it("retires the markdown@2 render identity (viewer version bumped)", () => {
    expect(markdownViewer.version).toBeGreaterThan(2);
  });

  it.each(["memory", "edge"])("cannot reuse a legacy markdown@2 outline-free fragment from %s", async (tier) => {
    const hash = await sha256Hex(new TextEncoder().encode(fixtures["two.md"]!));
    const legacyKey = `markdown@2/${hash}`;
    const url = `${ORIGIN}/s/${slug}/two.md`;
    const oldHtml = '<!--title:First Report--><h1 id="first-report">First Report</h1><p>LEGACY_NO_OUTLINE</p>';
    await caches.default.delete(new Request(`${ORIGIN}/__dropway/render/${legacyKey}`));
    await caches.default.delete(new Request(`${ORIGIN}/__dropway/render/markdown@${markdownViewer.version}/${hash}`));
    if (tier === "memory") {
      const ctx = createExecutionContext();
      const dc = dw.dropway.context(env as unknown as ServerBindings, ctx, new URL(url));
      await cachedRender(dc, legacyKey, async () => oldHtml);
      await waitOnExecutionContext(ctx);
    } else {
      await caches.default.put(new Request(`${ORIGIN}/__dropway/render/${legacyKey}`), new Response(oldHtml, {
        headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=2592000" },
      }));
      clearRenderMemoryCache();
    }
    const res = await dw.call(url, { headers: NAV });
    const html = await res.text();
    expect(html).not.toContain("LEGACY_NO_OUTLINE");
    expect(outlineEntries(html).map((e) => e.href)).toEqual(["#first-report", "#second-section"]);
    expect(res.headers.get("x-kofra-render-cache")).toBe("miss");
    const again = await dw.call(url, { headers: NAV });
    expect(again.headers.get("x-kofra-render-cache")).toBe("memory");
    expect(outlineEntries(await again.text()).map((e) => e.href)).toEqual(["#first-report", "#second-section"]);
  });

  it("does not answer 304 to a markdown@2 ETag, but revalidates the new render", async () => {
    const hash = await sha256Hex(new TextEncoder().encode(fixtures["two.md"]!));
    const legacy = `W/"markdown@2-${hash}"`;
    const res = await get("two.md", { ...NAV, "If-None-Match": legacy });
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag")!;
    expect(etag).not.toBe(legacy);
    expect(etag).toMatch(/^W\/"markdown@\d+-[a-f0-9]{64}"$/);
    expect(outlineEntries(await res.text()).map((e) => e.href)).toEqual(["#first-report", "#second-section"]);
    const fresh = await get("two.md", { ...NAV, "If-None-Match": etag });
    expect(fresh.status).toBe(304);
    expect(await fresh.text()).toBe("");
  });
});

describe("shared Markdown helper (embedding surfaces stay outline-free)", () => {
  it("renderMarkdown() output keeps its heading ids and gains no contents outline", () => {
    const out = renderMarkdown("# Helper Title\n\n## Helper Section\n\n### Helper Detail\n", "cell.md");
    expect(out.html).toContain('<h1 id="helper-title">');
    expect(out.html).toContain('<h2 id="helper-section">');
    expect(outlineParts(out.html).details).toBeNull();
    expect(outlineParts(out.html).nav).toBeNull();
    expect(out.html).not.toMatch(/<summary\b[^>]*>\s*Contents\s*<\/summary>/i);
  });
});
