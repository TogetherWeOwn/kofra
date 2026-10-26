import { Marked, type Tokens } from "marked";
import { escapeHtml } from "../html";
import { cachedRender } from "./cache";
import { standardTabs, viewerPage } from "./chrome";
import { HIGHLIGHT_CSS, highlight, hljsLanguage } from "./highlight";
import type { Viewer } from "./index";
import { sanitizeHtml } from "./sanitize";

// Bump whenever the rendered output changes: this retires cached fragments
// and render ETags keyed `markdown@<version>/...`.
const MD_VERSION = 3;

/** How many headings the contents outline lists at most; the body is never cut. */
const MAX_OUTLINE_HEADINGS = 200;

const MD_CSS = `
.dw-md{max-width:48rem;margin:0 auto;padding:2.5rem 1.25rem 5rem}
.dw-md h1,.dw-md h2,.dw-md h3,.dw-md h4,.dw-md h5,.dw-md h6{line-height:1.25;margin:2rem 0 .75rem;scroll-margin-top:4rem}
.dw-md h1{font-size:2.1rem;margin-top:0}.dw-md h2{font-size:1.5rem;padding-bottom:.3rem;border-bottom:1px solid var(--line)}
.dw-md h3{font-size:1.2rem}
.dw-md .dw-anchor{margin-left:.4rem;color:var(--muted);opacity:0;text-decoration:none;font-weight:400}
.dw-md :is(h1,h2,h3,h4,h5,h6):hover .dw-anchor,.dw-md .dw-anchor:focus{opacity:1}
.dw-md p,.dw-md ul,.dw-md ol,.dw-md blockquote,.dw-md table,.dw-md pre,.dw-md details{margin:0 0 1rem}
.dw-md img,.dw-md video{max-width:100%;height:auto;border-radius:6px}
.dw-md code{background:var(--code);padding:.12em .35em;border-radius:4px}
.dw-md pre{background:var(--code);padding:1rem;border-radius:8px;overflow:auto;line-height:1.45;font-size:.88rem}
.dw-md pre code{background:none;padding:0;font-size:inherit}
.dw-md pre[data-lang]{position:relative}
.dw-md pre[data-lang]::before{content:attr(data-lang);position:absolute;top:.35rem;right:.6rem;font:.68rem/1 ui-monospace,monospace;color:var(--muted);text-transform:lowercase}
.dw-md blockquote{border-left:3px solid var(--accent);padding:.1rem 1rem;color:var(--muted)}
.dw-md table{border-collapse:collapse;display:block;overflow:auto;max-width:100%}
.dw-md th,.dw-md td{border:1px solid var(--line);padding:.4rem .75rem}
.dw-md th{background:var(--code)}
.dw-md hr{border:0;border-top:1px solid var(--line);margin:2rem 0}
.dw-md li>input[type=checkbox]{margin:0 .45rem 0 -.2rem}
.dw-md ul:has(>li>input[type=checkbox]){list-style:none;padding-left:1.2rem}
.dw-md .dw-fm{font-size:.85rem;color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:.4rem .8rem}
.dw-md .dw-fm pre{margin:.5rem 0 .2rem}
.dw-md .dw-contents{border:1px solid var(--line);border-radius:8px;background:var(--code);padding:.4rem .8rem;margin:0 0 1.5rem}
.dw-md .dw-contents summary{cursor:pointer;font-weight:600}
.dw-md .dw-contents summary:focus-visible,.dw-md .dw-contents a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dw-md .dw-contents-list{list-style:none;margin:.5rem 0 .25rem;padding:0}
.dw-md .dw-contents-item{margin:.15rem 0}
.dw-md .dw-contents-level-2{margin-left:.9rem}.dw-md .dw-contents-level-3{margin-left:1.8rem}.dw-md .dw-contents-level-4{margin-left:2.7rem}.dw-md .dw-contents-level-5{margin-left:3.6rem}.dw-md .dw-contents-level-6{margin-left:4.5rem}
.dw-md .dw-contents a{color:var(--accent);overflow-wrap:anywhere}
.dw-md .dw-contents-note{color:var(--muted);font-size:.85rem;margin:.25rem 0}
.dw-md .dw-diagram::after{content:"Mermaid diagram source";display:block;margin-top:.5rem;font:.72rem/1 ui-sans-serif,system-ui;color:var(--muted)}
`;

/**
 * The `title:` value of a front-matter block, one optional pair of quotes
 * stripped. The value is cut from the line with string operations, not a
 * capture regex: lazy capture plus optional quote/trailing-space groups is
 * ambiguous, so a value with many spaces makes it backtrack super-linearly
 * on document-controlled input.
 */
function frontMatterTitle(frontMatter: string): string | null {
  const t = /^title:/m.exec(frontMatter);
  if (!t) return null;
  const rest = frontMatter.slice(t.index + t[0].length).trimStart();
  const lineEnd = rest.indexOf("\n");
  let value = (lineEnd === -1 ? rest : rest.slice(0, lineEnd)).trimEnd();
  if (value.length > 1 && (value[0] === '"' || value[0] === "'")) value = value.slice(1);
  if (value.length > 1 && (value.endsWith('"') || value.endsWith("'"))) value = value.slice(0, -1);
  return value || null;
}

/** Split optional YAML front matter from the body. Only `title:` is used. */
export function splitFrontMatter(src: string): { title: string | null; body: string; frontMatter: string | null } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { title: null, body: src, frontMatter: null };
  return { title: frontMatterTitle(m[1]!), body: src.slice(m[0].length), frontMatter: m[1]! };
}

/** GitHub-style heading id: lowercase, punctuation dropped, spaces to dashes. */
export function headingId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/&[a-z0-9#]+;/g, "")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

/** One heading a Markdown parse actually rendered: its level and the id that parse assigned it. */
export interface MarkdownHeading {
  depth: number;
  id: string;
}

function markedFor(headings: MarkdownHeading[]): Marked {
  const seen = new Map<string, number>();
  return new Marked({
    gfm: true,
    breaks: false,
    async: false,
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { tokens, depth, text }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        let id = headingId(text);
        const n = seen.get(id) ?? 0;
        seen.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        headings.push({ depth, id });
        return `<h${depth} id="${escapeHtml(id)}">${inner}<a class="dw-anchor" href="#${escapeHtml(id)}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        const tag = (lang ?? "").trim().split(/\s+/)[0] ?? "";
        if (tag.toLowerCase() === "mermaid") return `<pre class="dw-diagram" data-lang="mermaid"><code>${escapeHtml(text)}</code></pre>\n`;
        const name = hljsLanguage(tag);
        const body = name ? highlight(text, name) : escapeHtml(text);
        return `<pre${tag ? ` data-lang="${escapeHtml(tag.slice(0, 20))}"` : ""}><code class="hljs${name ? ` language-${escapeHtml(name)}` : ""}">${body}</code></pre>\n`;
      },
    },
  });
}

/**
 * Render Markdown (GFM: tables, task lists, strikethrough, autolinks) to HTML,
 * with highlighted code blocks and linkable headings. The output is NOT
 * sanitized: pass it through sanitizeHtml() before serving it (the viewer does).
 * `headings` lists the Markdown headings this parse rendered (ATX and setext,
 * never raw-HTML headings or fenced lookalikes) with the exact ids it
 * assigned them, in document order; embedding callers may ignore it.
 */
export function renderMarkdown(
  src: string,
  path: string,
): { title: string; html: string; frontMatter: string | null; headings: MarkdownHeading[] } {
  const { title: fmTitle, body, frontMatter } = splitFrontMatter(src.replace(/^\uFEFF/, ""));
  // First h1 line, cut with string operations like frontMatterTitle: a lazy
  // capture followed by space/# groups backtracks super-linearly on a
  // heading line containing many spaces.
  const h1 = /^#\s+/m.exec(body);
  let h1Text: string | null = null;
  if (h1) {
    const rest = body.slice(h1.index + h1[0].length);
    const lineEnd = rest.indexOf("\n");
    let text = (lineEnd === -1 ? rest : rest.slice(0, lineEnd)).trimEnd();
    // ATX closing sequence: one trailing run of #s (keeping at least one
    // character, so "# ###" still yields "#"), then trailing spaces.
    let end = text.length;
    while (end > 1 && text[end - 1] === "#") end--;
    if (end < text.length) text = text.slice(0, end).trimEnd();
    h1Text = text || null;
  }
  const title = fmTitle ?? (h1Text ? h1Text.replace(/[*_`]/g, "") : (path.split("/").pop() ?? path));
  const headings: MarkdownHeading[] = [];
  return { title, html: markedFor(headings).parse(body) as string, frontMatter, headings };
}

function decodeLabelEntities(s: string): string {
  const codePoint = (n: number): string => {
    try {
      return String.fromCodePoint(n);
    } catch {
      return "\uFFFD";
    }
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => codePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => codePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Label content for one already-sanitized heading, without its trailing "#"
 * anchor link. The input is sanitizer output, whose text is already
 * entity-encoded (&copy; stays &copy;, a literal < is &lt;), so the text is
 * kept verbatim instead of decoded and re-escaped — it renders exactly what
 * the heading renders, and carries no markup once the tags are stripped.
 */
function plainHeadingText(inner: string): string {
  // Walk the sanitized HTML once, keeping only text outside tags and
  // dropping the "#" text of the renderer's own dw-anchor link. A
  // tag-stripping replace() would read as (incomplete) sanitization; this
  // is only flattening, and the outline built from it passes through
  // sanitizeHtml() again before serving.
  const parts: string[] = [];
  let inAnchor = false;
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "<") {
      const end = inner.indexOf(">", i + 1);
      // A "<" with no later ">" is text, not a tag (sanitizer output encodes
      // literal < as &lt;, so this only guards malformed input).
      if (end === -1) {
        if (!inAnchor) parts.push("<");
        i++;
        continue;
      }
      const tag = inner.slice(i + 1, end);
      if (!inAnchor && /^a\b/.test(tag) && /\bclass="[^"]*dw-anchor/.test(tag)) inAnchor = true;
      else if (inAnchor && tag === "/a") inAnchor = false;
      i = end + 1;
    } else {
      if (!inAnchor) parts.push(inner[i]!);
      i++;
    }
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

/**
 * The label a reader sees for each collected heading, read from the
 * already-sanitized body so labels match the served headings exactly
 * (markup the sanitizer dropped never reappears as outline text). Headings
 * are paired in document order, not by id alone: two Markdown headings can
 * share an id when a base slug collides with another heading's suffixed
 * slug ("A", "A-1", "A"), and each still gets its own label. Raw-HTML
 * headings pair only if they exactly match the next collected heading.
 */
function renderedHeadingLabels(html: string, headings: MarkdownHeading[]): string[] {
  const labels = headings.map(() => "");
  let next = 0;
  // Match the opening tag, then search for the closing tag once from there:
  // a single pattern spanning both rescans the rest of the document for
  // every unclosed raw-HTML heading the sanitizer kept (quadratic), and if
  // no closing tag exists after an opening one, no later heading can close.
  const open = /<h([1-6])\b[^>]*\bid="([^"]*)"[^>]*>/g;
  const close = /<\/h[1-6]>/g;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const h = headings[next];
    if (!h) break;
    const innerStart = m.index + m[0].length;
    close.lastIndex = innerStart;
    const c = close.exec(html);
    if (!c) break;
    if (Number(m[1]) === h.depth && decodeLabelEntities(m[2]!) === h.id)
      labels[next++] = plainHeadingText(html.slice(innerStart, c.index));
    open.lastIndex = c.index + c[0].length;
  }
  return labels;
}

/**
 * Native collapsible contents outline for the standalone Markdown viewer:
 * a `<details>` of ordinary fragment links, so it works with JavaScript
 * disabled. Only headings the same parse rendered are listed, each label is
 * plain escaped text, and the list is capped with a truthful note. Returns
 * "" for documents with fewer than two rendered headings.
 */
function contentsOutline(headings: MarkdownHeading[], labels: string[]): string {
  if (headings.length < 2) return "";
  const shown = headings.slice(0, MAX_OUTLINE_HEADINGS);
  // Labels arrive as entity-encoded sanitizer text (no tags); only the
  // id fallback for a heading with no readable text needs escaping here.
  const items = shown
    .map(
      (h, i) =>
        `<li class="dw-contents-item dw-contents-level-${h.depth}"><a href="#${escapeHtml(h.id)}">${labels[i] || escapeHtml(h.id)}</a></li>`,
    )
    .join("");
  const note =
    headings.length > shown.length
      ? `<p class="dw-contents-note">Showing the first ${shown.length} of ${headings.length} headings.</p>`
      : "";
  return `<nav class="dw-contents" aria-label="Contents"><details><summary>Contents</summary><ol class="dw-contents-list">${items}</ol>${note}</details></nav>`;
}

export const markdownViewer: Viewer = {
  id: "markdown",
  version: MD_VERSION,
  maxBytes: 2 * 1024 * 1024,
  matches: (file, live, mode) => live.renderMarkdown && file.kind === "markdown" && mode !== "source",
  async render(vc) {
    let title = vc.file.path;
    const r = await cachedRender(vc.dw, `markdown@${MD_VERSION}/${vc.file.sha256}`, async () => {
      const out = renderMarkdown(await vc.readText(), vc.file.path);
      const fm = out.frontMatter
        ? `<details class="dw-fm"><summary>Front matter</summary><pre><code>${escapeHtml(out.frontMatter)}</code></pre></details>`
        : "";
      const bodyHtml = await sanitizeHtml(out.html);
      // Standalone documents only: the shared helper's output (notebook cells,
      // listing previews) never gains this outline. The outline is generated
      // markup with escaped plain-text labels; it goes through the same
      // sanitizer as the body before either is served.
      const outline = contentsOutline(out.headings, renderedHeadingLabels(bodyHtml, out.headings));
      // The title travels with the cached fragment so a hit needs no re-parse.
      return `<!--title:${escapeHtml(out.title)}-->${fm}${outline ? await sanitizeHtml(outline) : ""}${bodyHtml}`;
    });
    const m = /^<!--title:(.*?)-->/.exec(r.html);
    if (m) title = m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    return viewerPage(vc, {
      title,
      tabs: standardTabs(vc, { source: true }),
      css: MD_CSS + HIGHLIGHT_CSS,
      body: `<article class="dw-md">${m ? r.html.slice(m[0].length) : r.html}</article>`,
      headers: { "X-Kofra-Render-Cache": r.cache },
    });
  },
};
