import { Marked, type Tokens } from "marked";
import { escapeHtml } from "../html";
import { cachedRender } from "./cache";
import { standardTabs, viewerPage } from "./chrome";
import { HIGHLIGHT_CSS, highlight, hljsLanguage } from "./highlight";
import type { Viewer } from "./index";
import { DROP, sanitizeHtml } from "./sanitize";

// Bump whenever the rendered output changes: this retires cached fragments
// and render ETags keyed `markdown@<version>/...`.
const MD_VERSION = 5;

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
.dw-md .dw-diagram::after{content:"Mermaid diagram source";display:block;margin-top:.5rem;font:.72rem/1 ui-sans-serif,system-ui;color:var(--muted)}
`;

/** Split optional YAML front matter from the body. Only `title:` is used. */
export function splitFrontMatter(src: string): { title: string | null; body: string; frontMatter: string | null } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { title: null, body: src, frontMatter: null };
  const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(m[1]!);
  return { title: t ? t[1]! : null, body: src.slice(m[0].length), frontMatter: m[1]! };
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

/** Scan raw tokens once, retaining comment/DROP state across inline tokens. */
function rawHeadingScanner(ids: Set<string>): (html: string) => void {
  const dropped: string[] = [];
  const droppedCounts = new Map<string, number>();
  const voidDrop = new Set(["area", "base", "embed", "frame", "link", "meta", "param"]);
  const rawTextTags = new Set(["script", "style", "iframe", "noembed", "noframes", "noscript", "title", "textarea", "xmp", "plaintext"]);
  const tag = /<(\/?)([a-z][a-z0-9:-]*)(?=[\t\n\f\r />])/iy;
  const space = /[\t\n\f\r ]/;
  let comment = false;
  let rawText: string | null = null;
  return (html) => {
    let i = 0;
    while (i < html.length) {
      if (comment) {
        const end = /--!?>/g;
        end.lastIndex = i;
        const m = end.exec(html);
        if (!m) return;
        i = end.lastIndex;
        comment = false;
      }
      i = html.indexOf("<", i);
      if (i < 0 || rawText === "plaintext") return;
      if (!rawText && html.startsWith("<!--", i)) {
        comment = true;
        i += 4;
        continue;
      }
      if (!rawText && (html[i + 1] === "!" || html[i + 1] === "?")) {
        const end = html.indexOf(">", i + 2);
        if (end < 0) return;
        i = end + 1;
        continue;
      }
      tag.lastIndex = i;
      const m = tag.exec(html);
      if (!m) { i++; continue; }
      const closing = m[1] === "/";
      const name = m[2]!.toLowerCase();
      i = tag.lastIndex;
      if (rawText && !(closing && name === rawText)) continue;
      let id: string | undefined;
      let selfClosing = false;
      // Attribute values may contain '<' and '>'. Never restart at a heading
      // prefix within a value, or rescan an unterminated tag from each '<'.
      while (i < html.length && html[i] !== ">") {
        if (space.test(html[i]!)) { i++; continue; }
        if (html[i] === "/") { selfClosing = html[i + 1] === ">"; i++; continue; }
        const start = i;
        while (i < html.length && !/[\t\n\f\r />=]/.test(html[i]!)) i++;
        if (i === start) { i++; continue; }
        const attr = html.slice(start, i).toLowerCase();
        while (i < html.length && space.test(html[i]!)) i++;
        let value = "";
        if (html[i] === "=") {
          i++;
          while (i < html.length && space.test(html[i]!)) i++;
          const quote = html[i];
          if (quote === '"' || quote === "'") {
            const valueStart = ++i;
            while (i < html.length && html[i] !== quote) i++;
            value = html.slice(valueStart, i);
            if (i < html.length) i++;
          } else {
            const valueStart = i;
            while (i < html.length && !space.test(html[i]!) && html[i] !== ">") i++;
            value = html.slice(valueStart, i);
          }
        }
        // HTML keeps the first duplicate attribute. A slash is part of an
        // unquoted value, not a self-closing marker: id=install/ means install/.
        if (attr === "id" && id === undefined) id = value;
      }
      if (i === html.length) return;
      i++;
      if (closing) {
        if (droppedCounts.get(name)) {
          let parent: string;
          do {
            parent = dropped.pop()!;
            droppedCounts.set(parent, droppedCounts.get(parent)! - 1);
          } while (parent !== name);
        }
        if (name === rawText) rawText = null;
      } else if (DROP.has(name)) {
        if (!voidDrop.has(name) && !(selfClosing && (name === "svg" || name === "math"))) {
          dropped.push(name);
          droppedCounts.set(name, (droppedCounts.get(name) ?? 0) + 1);
        }
        if (rawTextTags.has(name)) rawText = name;
      } else if (!dropped.length && /^h[1-6]$/.test(name) && id) {
        ids.add(id);
      }
    }
  };
}

function markedFor(): Marked {
  const seen = new Map<string, number>();
  const headings = new WeakMap<object, { base: string; id: string }>();
  const reserved = new Set<string>();
  const nextSuffix = new Map<string, number>();
  const rawIds = new Set<string>();
  const reserveRaw = rawHeadingScanner(reserved);
  const registerRaw = rawHeadingScanner(rawIds);
  return new Marked({
    gfm: true,
    breaks: false,
    async: false,
    walkTokens(token) {
      if (token.type === "html") reserveRaw(token.text);
      if (token.type !== "heading") return;
      const base = headingId(token.text);
      const n = seen.get(base) ?? 0;
      const id = n ? `${base}-${n}` : base;
      seen.set(base, n + 1);
      headings.set(token, { base, id });
      reserved.add(id);
    },
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Heading) {
        const { tokens, depth } = token;
        const inner = this.parser.parseInline(tokens);
        const original = headings.get(token)!;
        let id = original.id;
        // Keep baseline Markdown numbering, including future suffix destinations.
        // Only an id shadowed by earlier raw HTML may move to a free suffix.
        if (rawIds.has(id)) {
          let n = nextSuffix.get(original.base) ?? 1;
          do {
            id = `${original.base}-${n++}`;
          } while (reserved.has(id) || rawIds.has(id));
          nextSuffix.set(original.base, n);
          reserved.add(id);
        }
        return `<h${depth} id="${escapeHtml(id)}">${inner}<a class="dw-anchor" href="#${escapeHtml(id)}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        registerRaw(text);
        return text;
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
 */
export function renderMarkdown(src: string, path: string): { title: string; html: string; frontMatter: string | null } {
  const { title: fmTitle, body, frontMatter } = splitFrontMatter(src.replace(/^\uFEFF/, ""));
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  const title = fmTitle ?? (h1 ? h1[1]!.replace(/[*_`]/g, "") : (path.split("/").pop() ?? path));
  return { title, html: markedFor().parse(body) as string, frontMatter };
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
      // The title travels with the cached fragment so a hit needs no re-parse.
      return `<!--title:${escapeHtml(out.title)}-->${fm}${await sanitizeHtml(out.html)}`;
    });
    const m = /^<!--title:(.*?)-->/.exec(r.html);
    if (m) title = m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    return viewerPage(vc, {
      title,
      print: true,
      tabs: standardTabs(vc, { source: true }),
      css: MD_CSS + HIGHLIGHT_CSS,
      body: `<article class="dw-md">${m ? r.html.slice(m[0].length) : r.html}</article>`,
      headers: { "X-Kofra-Render-Cache": r.cache },
    });
  },
};
