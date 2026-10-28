import { Marked, type Tokens } from "marked";
import { escapeHtml } from "../html";
import { cachedRender } from "./cache";
import { standardTabs, viewerPage } from "./chrome";
import { HIGHLIGHT_CSS, highlight, hljsLanguage } from "./highlight";
import type { Viewer } from "./index";
import { DROP, sanitizeHtml } from "./sanitize";

// Bump whenever the rendered output changes: this retires cached fragments
// and render ETags keyed `markdown@<version>/...`.
const MD_VERSION = 6;

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

/** Void elements: no end tag and no contents. `frame` is deliberately absent:
 *  it is not void, and the sanitizer drops it together with its contents. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/** Elements whose contents are raw text until the matching end tag. Only `script` has escape states. */
const RAWTEXT = new Set([
  "script", "style", "iframe", "noembed", "noframes", "noscript", "title", "textarea", "xmp", "plaintext",
]);

const TAG_OPEN = /<(\/?)([a-z][a-z0-9:-]*)(?=[\t\n\f\r />])/iy;
const HTML_SPACE = /[\t\n\f\r ]/;

interface ParsedTag {
  closing: boolean;
  name: string;
  id: string | undefined;
  selfClosing: boolean;
  /** Index just past ">". */
  end: number;
}

/**
 * Parse one tag starting at `html[start]` ("<"). Returns null when no tag
 * starts there, "eof" when the tag never terminates.
 */
function parseTag(html: string, start: number): ParsedTag | "eof" | null {
  TAG_OPEN.lastIndex = start;
  const m = TAG_OPEN.exec(html);
  if (!m) return null;
  const closing = m[1] === "/";
  const name = m[2]!.toLowerCase();
  let i = TAG_OPEN.lastIndex;
  let id: string | undefined;
  let selfClosing = false;
  // Attribute values may contain '<' and '>'. Never restart at a heading
  // prefix within a value, or rescan an unterminated tag from each '<'.
  while (i < html.length && html[i] !== ">") {
    if (HTML_SPACE.test(html[i]!)) { i++; continue; }
    if (html[i] === "/") { selfClosing = html[i + 1] === ">"; i++; continue; }
    const attrStart = i;
    while (i < html.length && !/[\t\n\f\r />=]/.test(html[i]!)) i++;
    if (i === attrStart) { i++; continue; }
    const attr = html.slice(attrStart, i).toLowerCase();
    while (i < html.length && HTML_SPACE.test(html[i]!)) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < html.length && HTML_SPACE.test(html[i]!)) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const valueStart = ++i;
        while (i < html.length && html[i] !== quote) i++;
        value = html.slice(valueStart, i);
        if (i < html.length) i++;
      } else {
        const valueStart = i;
        while (i < html.length && !HTML_SPACE.test(html[i]!) && html[i] !== ">") i++;
        value = html.slice(valueStart, i);
      }
    }
    // HTML keeps the first duplicate attribute. A slash is part of an
    // unquoted value, not a self-closing marker: id=install/ means install/.
    if (attr === "id" && id === undefined) id = value;
  }
  if (i === html.length) return "eof";
  return { closing, name, id, selfClosing, end: i + 1 };
}

type AnchorEvent = { kind: "md"; index: number } | { kind: "raw"; id: string };

/**
 * Read a probe fragment in served order: Markdown-generated headings (found by
 * their sentinel prefix wherever they appear, so headings swallowed by raw
 * markup can never shift later indices) interleaved with the raw-HTML heading
 * ids the sanitizer actually serves (outside comments, raw-text elements and
 * sanitizer-dropped subtrees). The per-render nonce keeps authored markup
 * from forging a sentinel occurrence.
 */
function scanProbe(html: string, nonce: string): AnchorEvent[] {
  const prefix = `kofra-md-${nonce}-`;
  const digits = /\d+/y;
  const mdAt: Array<{ pos: number; index: number }> = [];
  let at = html.indexOf(prefix);
  while (at >= 0) {
    digits.lastIndex = at + prefix.length;
    const num = digits.exec(html);
    if (num) mdAt.push({ pos: at, index: Number(num[0]) });
    at = html.indexOf(prefix, at + prefix.length);
  }

  const rawAt: Array<{ pos: number; id: string }> = [];
  const open: Array<{ name: string; dropped: boolean }> = [];
  let dropped = 0;
  let rawText: string | null = null;
  // Script tokenizer states: data, escaped (`<!--` seen), double-escaped.
  let escaped = 0;
  let comment = false;

  const finish = (): AnchorEvent[] => {
    const all: Array<{ pos: number; seq: number; event: AnchorEvent }> = [
      ...mdAt.map((m, seq) => ({ pos: m.pos, seq, event: { kind: "md", index: m.index } as AnchorEvent })),
      ...rawAt.map((r, k) => ({ pos: r.pos, seq: mdAt.length + k, event: { kind: "raw", id: r.id } as AnchorEvent })),
    ];
    all.sort((a, b) => a.pos - b.pos || a.seq - b.seq);
    const seenMd = new Set<number>();
    const events: AnchorEvent[] = [];
    for (const { event } of all) {
      if (event.kind === "md") {
        // Each generated heading carries two occurrences (id and href).
        if (seenMd.has(event.index)) continue;
        seenMd.add(event.index);
      }
      events.push(event);
    }
    return events;
  };

  /** Pop through the named open element, HTML "any other end tag" style. */
  const popTo = (name: string): void => {
    let found = -1;
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k]!.name === name) { found = k; break; }
    }
    if (found < 0) return;
    while (open.length > found) {
      const el = open.pop()!;
      if (el.dropped) dropped--;
      if (el.name === rawText) { rawText = null; escaped = 0; }
    }
  };

  let i = 0;
  for (;;) {
    if (comment) {
      const endGt = html.indexOf("-->", i);
      const endBang = html.indexOf("--!>", i);
      const end = endGt < 0 ? endBang : endBang < 0 ? endGt : Math.min(endGt, endBang);
      if (end < 0) return finish();
      i = html.startsWith("-->", end) ? end + 3 : end + 4;
      comment = false;
      continue;
    }
    if (rawText === "plaintext") return finish();
    if (rawText && rawText !== "script") {
      const lt = html.indexOf("<", i);
      if (lt < 0) return finish();
      // Only a matching end tag can end raw text; anything else is content.
      // The cheap shape check keeps adversarial tag soup linear; parseTag
      // then consumes the end tag exactly (quoted ">" included).
      const probe = html.slice(lt + 1, lt + 2 + rawText.length).toLowerCase();
      if (probe === `/${rawText}` && /[\t\n\f\r />]/.test(html[lt + 2 + rawText.length] ?? ">")) {
        const tag = parseTag(html, lt);
        if (tag === "eof" || tag === null) return finish();
        i = tag.end;
        popTo(rawText);
      } else {
        i = lt + 1;
      }
      continue;
    }
    if (rawText === "script") {
      const lt = html.indexOf("<", i);
      // In the escaped state `-->` returns to script data; elsewhere it is text.
      const dd = escaped === 1 ? html.indexOf("-->", i) : -1;
      if (dd >= 0 && (lt < 0 || dd < lt)) { escaped = 0; i = dd + 3; continue; }
      if (lt < 0) return finish();
      if (html.startsWith("<!--", lt)) { if (escaped === 0) escaped = 1; i = lt + 4; continue; }
      const slash = html[lt + 1] === "/";
      const nm = html.slice(lt + (slash ? 2 : 1), lt + (slash ? 2 : 1) + 6).toLowerCase();
      const after = html[lt + (slash ? 2 : 1) + 6] ?? ">";
      if (nm === "script" && /[\t\n\f\r />]/.test(after)) {
        if (!slash) {
          if (escaped === 1) escaped = 2;
          i = lt + 1;
        } else if (escaped === 2) {
          escaped = 1;
          i = lt + 1;
        } else if (escaped === 1) {
          escaped = 0;
          i = lt + 1;
        } else {
          const tag = parseTag(html, lt);
          if (tag === "eof" || tag === null) return finish();
          i = tag.end;
          popTo("script");
        }
      } else {
        i = lt + 1;
      }
      continue;
    }
    const lt = html.indexOf("<", i);
    if (lt < 0) return finish();
    if (html.startsWith("<!--", lt)) {
      // Abrupt closings complete immediately: <!--> and <!--->.
      if (html[lt + 4] === ">") { i = lt + 5; continue; }
      if (html[lt + 4] === "-" && html[lt + 5] === ">") { i = lt + 6; continue; }
      comment = true;
      i = lt + 4;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const gt = html.indexOf(">", lt + 2);
      if (gt < 0) return finish();
      i = gt + 1;
      continue;
    }
    const tag = parseTag(html, lt);
    if (tag === null) { i = lt + 1; continue; }
    // An unterminated tag at fragment EOF is discarded, like the browser: a
    // tag completed by later generated markup never reaches this branch,
    // because the probe is scanned whole.
    if (tag === "eof") return finish();
    i = tag.end;
    if (tag.closing) {
      popTo(tag.name);
      continue;
    }
    if (!VOID.has(tag.name) && !(tag.selfClosing && (tag.name === "svg" || tag.name === "math"))) {
      // A self-closing slash on HTML elements is ignored: <template/> stays open.
      const isDrop = DROP.has(tag.name);
      open.push({ name: tag.name, dropped: isDrop });
      if (isDrop) dropped++;
      if (RAWTEXT.has(tag.name)) { rawText = tag.name; escaped = 0; }
    }
    if (/^h[1-6]$/.test(tag.name) && tag.id && !tag.id.startsWith(prefix) && dropped === 0) {
      rawAt.push({ pos: lt, id: tag.id });
    }
  }
}

/** Probe ids embed a per-render nonce so authored markup can never forge one. */
function sentinelId(nonce: string, index: number): string {
  return `kofra-md-${nonce}-${index}`;
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Final ids from probe order: a Markdown heading keeps its baseline id
 * unless an earlier raw heading already owns it; then it takes the first
 * free base-N suffix, skipping every raw id and every baseline destination
 * in the document (past and future) so no reachable fragment moves.
 */
function assignIds(events: AnchorEvent[], bases: string[]): string[] {
  const rawAll = new Set<string>();
  for (const e of events) if (e.kind === "raw") rawAll.add(e.id);
  const seen = new Map<string, number>();
  const baselines = bases.map((base) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  });
  const baselineAll = new Set(baselines);
  const finals: Array<string | undefined> = new Array(bases.length);
  const assigned = new Set<string>();
  const rawSeen = new Set<string>();
  for (const e of events) {
    if (e.kind === "raw") {
      rawSeen.add(e.id);
      continue;
    }
    if (e.index >= bases.length || finals[e.index] !== undefined) continue;
    const base = bases[e.index]!;
    const baseline = baselines[e.index]!;
    if (!rawSeen.has(baseline)) {
      finals[e.index] = baseline;
    } else {
      let n = 1;
      let cand = `${base}-${n}`;
      while (rawAll.has(cand) || baselineAll.has(cand) || assigned.has(cand)) {
        n++;
        cand = `${base}-${n}`;
      }
      finals[e.index] = cand;
    }
    assigned.add(finals[e.index]!);
  }
  // A heading absorbed into raw markup leaves no probe event; it keeps its baseline.
  return baselines.map((baseline, k) => finals[k] ?? baseline);
}

function markedFor(
  mode: "probe" | "final",
  nonce: string,
  finals: readonly string[] | null,
  basesOut: string[] | null,
): Marked {
  const seen = new Map<string, number>();
  let n = 0;
  return new Marked({
    gfm: true,
    breaks: false,
    async: false,
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Heading) {
        const { tokens, depth } = token;
        let id: string;
        if (mode === "probe") {
          id = sentinelId(nonce, basesOut!.length);
          basesOut!.push(headingId(token.text));
        } else if (finals) {
          id = finals[n++]!;
        } else {
          const base = headingId(token.text);
          const k = seen.get(base) ?? 0;
          seen.set(base, k + 1);
          id = k ? `${base}-${k}` : base;
        }
        const inner = this.parser.parseInline(tokens);
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
 */
export function renderMarkdown(src: string, path: string): { title: string; html: string; frontMatter: string | null } {
  const { title: fmTitle, body, frontMatter } = splitFrontMatter(src.replace(/^\uFEFF/, ""));
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  const title = fmTitle ?? (h1 ? h1[1]!.replace(/[*_`]/g, "") : (path.split("/").pop() ?? path));
  // Without "<" no raw tag can exist: baselines are final after one pass.
  if (!body.includes("<")) {
    return { title, html: markedFor("final", "", null, null).parse(body) as string, frontMatter };
  }
  // Two passes over the real output bytes. The probe carries an unforgeable
  // sentinel per generated heading; the probe scan reads served order (raw
  // ids that survive the sanitizer, interleaved with generated headings);
  // the final pass assigns the collision-safe ids.
  const nonce = randomNonce();
  const bases: string[] = [];
  const probe = markedFor("probe", nonce, null, bases).parse(body) as string;
  const finals = assignIds(scanProbe(probe, nonce), bases);
  return { title, html: markedFor("final", nonce, finals, null).parse(body) as string, frontMatter };
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
