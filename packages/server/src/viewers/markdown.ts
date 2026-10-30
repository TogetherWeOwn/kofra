import { Marked, type Tokens } from "marked";
import { escapeHtml } from "../html";
import { cachedRender } from "./cache";
import { standardTabs, viewerCarry, viewerPage } from "./chrome";
import { HIGHLIGHT_CSS, highlight, hljsLanguage } from "./highlight";
import type { Viewer } from "./index";
import { carryDocLinks } from "./links";
import { RESERVED_NAME, sanitizeHtml } from "./sanitize";

// 4 was issued separately for the report print treatment plus shared-link
// head tags and for the Phone disclosure in the viewer bar; neither 4
// identifies the merged bytes, so the merged render moves to 5.
const MD_VERSION = 5;

export const MD_CSS = `
.k-doc{max-width:46em;margin:0 auto;padding:var(--s7) var(--s7) var(--s10);font-size:17px;line-height:1.6;color:var(--ink);overflow-wrap:break-word}
.k-doc h1,.k-doc h2,.k-doc h3,.k-doc h4,.k-doc h5,.k-doc h6{font-family:var(--serif);font-weight:500;color:var(--accent);line-height:1.2;margin:1.8em 0 .6em;scroll-margin-top:4.5rem}
.k-doc h1{font-size:clamp(32px,4vw,52px);margin-top:0;letter-spacing:-.01em}
.k-doc h2{font-size:clamp(25px,2.8vw,34px);padding-bottom:.3rem;border-bottom:1px solid var(--rule-soft)}
.k-doc h3{font-size:clamp(20px,2vw,24px)}
.k-doc h4,.k-doc h5,.k-doc h6{font-size:19px}
.k-doc .md-anchor{margin-left:.35em;color:var(--muted);opacity:0;text-decoration:none;font-family:var(--sans);font-weight:400;font-size:.7em}
.k-doc :is(h1,h2,h3,h4,h5,h6):hover .md-anchor,.k-doc .md-anchor:focus{opacity:1}
.k-doc p,.k-doc ul,.k-doc ol,.k-doc blockquote,.k-doc table,.k-doc pre,.k-doc details,.k-doc dl{margin:0 0 1.1em}
.k-doc li{margin:.25em 0}
.k-doc li::marker{color:var(--accent-2)}
.k-doc img,.k-doc video{max-width:100%;height:auto}
.k-doc code{font-size:.86em}
.k-doc pre{background:var(--paper-3);border:1px solid var(--rule-soft);padding:16px 18px;overflow:auto;line-height:1.6;font-size:13.5px}
.k-doc pre code{background:none;padding:0;font-size:inherit}
.k-doc pre[data-lang]{position:relative}
.k-doc pre[data-lang]::before{content:attr(data-lang);position:absolute;top:6px;right:10px;font:500 10.5px/1 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--accent-2)}
.k-doc blockquote{border-left:3px solid var(--accent);padding:.1em 0 .1em 1em;color:var(--ink-2);font-family:var(--serif);font-size:1.06em}
.k-doc table{border-collapse:collapse;display:block;width:max-content;overflow:auto;max-width:100%;font-size:15px;border-top:1px solid var(--accent)}
.k-doc th{font:500 10.5px/1.3 var(--mono);text-transform:uppercase;letter-spacing:.11em;color:var(--accent-2);text-align:left;padding:10px 14px 8px 0;border-bottom:1px solid var(--rule)}
.k-doc td{padding:10px 14px 10px 0;border-bottom:1px solid var(--rule-soft);vertical-align:top}
.k-doc hr{border:0;border-top:1px solid var(--rule);margin:2em 0}
.k-doc li>input[type=checkbox]{margin:0 .45rem 0 -.2rem}
.k-doc ul:has(>li>input[type=checkbox]){list-style:none;padding-left:1.2rem}
.k-doc .md-fm{font-size:14px;color:var(--ink-2);border:1px solid var(--rule-soft);background:var(--paper-2);padding:8px 14px}
.k-doc .md-fm pre{margin:.5rem 0 .2rem}
.k-doc .md-diagram::after{content:"Mermaid diagram source";display:block;margin-top:.5rem;font:12px/1 var(--sans);color:var(--muted)}
@media (max-width:720px){.k-doc{padding:var(--s6) var(--s4) var(--s8);font-size:16.5px}}
`;

/** Split optional YAML front matter from the body. Only `title:` is used. */
export function splitFrontMatter(src: string): { title: string | null; body: string; frontMatter: string | null } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { title: null, body: src, frontMatter: null };
  const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(m[1]!);
  return { title: t ? t[1]! : null, body: src.slice(m[0].length), frontMatter: m[1]! };
}

/**
 * GitHub-style heading id: lowercase, punctuation dropped, spaces to dashes. An id in a namespace reserved
 * for Kofra's own markup (`k-`, `dw-`; the sanitizer strips those from user content) gets an `h-` prefix,
 * so the heading keeps an id and its `#` link still reaches it.
 */
export function headingId(text: string): string {
  const id =
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/&[a-z0-9#]+;/g, "")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  return RESERVED_NAME.test(id) ? `h-${id}` : id;
}

function markedFor(): Marked {
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
        return `<h${depth} id="${escapeHtml(id)}">${inner}<a class="md-anchor" href="#${escapeHtml(id)}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        const tag = (lang ?? "").trim().split(/\s+/)[0] ?? "";
        if (tag.toLowerCase() === "mermaid") return `<pre class="md-diagram" data-lang="mermaid"><code>${escapeHtml(text)}</code></pre>\n`;
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
        ? `<details class="md-fm"><summary>Front matter</summary><pre><code>${escapeHtml(out.frontMatter)}</code></pre></details>`
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
      body: `<article class="k-doc">${await carryDocLinks(m ? r.html.slice(m[0].length) : r.html, vc.url.pathname, vc.siteBase, viewerCarry(vc))}</article>`,
      headers: { "X-Kofra-Render-Cache": r.cache },
    });
  },
};
