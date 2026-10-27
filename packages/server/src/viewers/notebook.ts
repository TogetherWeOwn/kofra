import { escapeHtml } from "../html";
import { cachedRender } from "./cache";
import { standardTabs, viewerPage } from "./chrome";
import { HIGHLIGHT_CSS, highlight, hljsLanguage } from "./highlight";
import type { Viewer } from "./index";
import { renderMarkdown } from "./markdown";
import { sanitizeHtml } from "./sanitize";

/**
 * Jupyter notebooks (.ipynb): Markdown cells rendered, code cells highlighted
 * with their execution count, outputs shown (text, errors, PNG/JPEG/GIF/SVG
 * images, HTML and Markdown through the sanitizer), grouped per cell in a
 * native initially-open <details> so a reader can fold a long result without
 * hiding the code that produced it. Nothing executes.
 */
const NB_VERSION = 2;
const MAX_OUTPUT_TEXT = 100_000;

const NB_CSS = `
.dw-nb{max-width:60rem;margin:0 auto;padding:1.5rem 1.25rem 5rem}
.dw-cell{display:grid;grid-template-columns:5.5rem 1fr;gap:.5rem;margin:0 0 1rem}
.dw-prompt{font:.75rem/1.9 ui-monospace,monospace;color:var(--muted);text-align:right;padding-top:.45rem}
.dw-cell pre{margin:0;background:var(--code);border-radius:8px;padding:.7rem .9rem;overflow:auto;font-size:.84rem;line-height:1.5}
.dw-out{margin-top:.4rem}
.dw-out>summary{cursor:pointer;color:var(--muted);font-size:.8rem;padding:.2rem 0}
.dw-out pre{background:transparent;border-left:3px solid var(--line);border-radius:0}
.dw-out pre.err{border-left-color:#cf222e;color:#cf222e}
.dw-out img{max-width:100%;height:auto;background:#fff;border-radius:4px}
.dw-mdcell{min-width:0}
.dw-mdcell :is(h1,h2,h3){line-height:1.25}
.dw-mdcell table{border-collapse:collapse}.dw-mdcell th,.dw-mdcell td{border:1px solid var(--line);padding:.3rem .6rem}
.dw-out table{border-collapse:collapse;font-size:.85rem}.dw-out th,.dw-out td{border:1px solid var(--line);padding:.25rem .55rem}
@media (max-width:640px){.dw-cell{grid-template-columns:1fr}.dw-prompt{text-align:left;padding:0}}
`;

type Json = Record<string, unknown>;
const text = (v: unknown): string => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "");
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
const clip = (s: string) => (s.length > MAX_OUTPUT_TEXT ? `${s.slice(0, MAX_OUTPUT_TEXT)}\n…` : s);

const isAlpha = (c: string | undefined): boolean => c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
/** Elements the sanitizer removes together with their content; markup inside them never reaches the page. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
const DROPPED = new Set([
  ...RAW_TEXT, "frameset", "object", "applet", "noscript", "template", "head", "svg", "math", "select", "option", "optgroup", "button",
  "datalist", "canvas", "portal", "dialog", "slot", "output", "progress", "meter", "map",
]);

/** Lowercased tag name starting at `from` (HTML tokenizer rule: up to whitespace, "/" or ">"). */
function tagNameAt(html: string, from: number): string {
  let j = from;
  while (j < html.length && !isSpace(html[j]!) && html[j] !== "/" && html[j] !== ">") j++;
  return html.slice(from, j).toLowerCase();
}

/** Index just past the ">" that ends the tag whose attributes start at `from`, honouring quoted values; -1 if unterminated. */
function tagEnd(html: string, from: number): number {
  let j = from;
  while (j < html.length) {
    const c = html[j]!;
    if (c === ">") return j + 1;
    if (isSpace(c) || c === "/") {
      j++;
      continue;
    }
    j++; // first character of an attribute name, even "="
    while (j < html.length && !isSpace(html[j]!) && !"/>=".includes(html[j]!)) j++;
    while (j < html.length && isSpace(html[j]!)) j++;
    if (html[j] !== "=") continue;
    j++;
    while (j < html.length && isSpace(html[j]!)) j++;
    const q = html[j];
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, j + 1);
      if (close < 0) return -1;
      j = close + 1;
    } else {
      while (j < html.length && !isSpace(html[j]!) && html[j] !== ">") j++;
    }
  }
  return -1;
}

/** Index just past a comment or bogus comment opening at `i` (they end at "-->", "--!>" or ">"). */
function commentEnd(html: string, i: number): number {
  if (html.startsWith("<!--", i)) {
    const j = i + 4;
    if (html.startsWith(">", j)) return j + 1;
    if (html.startsWith("->", j)) return j + 2;
    const a = html.indexOf("-->", j);
    const b = html.indexOf("--!>", j);
    if (a < 0 && b < 0) return html.length;
    return b < 0 || (a >= 0 && a < b) ? a + 3 : b + 4;
  }
  const gt = html.indexOf(">", i);
  return gt < 0 ? html.length : gt + 1;
}

const esc = "&lt;";

/**
 * Keep an HTML/Markdown output fragment inside the generated per-cell fold.
 * The outer sanitizer keeps details, summary, div and main (they are the fold
 * and its wrappers), and passes unmatched end tags through, so an output
 * containing `</details>`, `</div>` or `</main>` would close an ancestor and
 * leave later outputs outside the fold. This escapes the `<` of any
 * details/summary tag and of any div/main end tag with no matching open tag
 * in the same fragment, and closes div/main tags the fragment leaves open.
 * Content the sanitizer drops (script, svg, template, comments...) gets every
 * end tag escaped so a hidden tag can never be matched against a live one.
 * Everything else passes through to the sanitizer. Character scan, no
 * tag-strip regex.
 */
function containOutputMarkup(html: string): string {
  const out: string[] = [];
  const open: string[] = [];
  let region = "";
  let depth = 0;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    i = lt;
    if (RAW_TEXT.has(region)) {
      // Raw text: only the matching end tag is markup; everything before it is inert text.
      let term = -1;
      for (let p = html.indexOf("</", i); p >= 0; p = html.indexOf("</", p + 2)) {
        if (tagNameAt(html, p + 2) === region) {
          term = p;
          break;
        }
      }
      const end = term < 0 ? -1 : tagEnd(html, term + 2 + region.length);
      const stop = end < 0 ? html.length : term;
      out.push(html.slice(i, stop).split("<").join(esc));
      if (end >= 0) out.push(html.slice(term, end));
      i = end < 0 ? html.length : end;
      region = "";
      continue;
    }
    const c1 = html[i + 1];
    const closing = c1 === "/";
    if (c1 === "!" || c1 === "?" || (closing && !isAlpha(html[i + 2]))) {
      const end = commentEnd(html, i);
      out.push("<" + html.slice(i + 1, end).split("<").join(esc));
      i = end;
      continue;
    }
    if (!isAlpha(c1) && !(closing && isAlpha(html[i + 2]))) {
      out.push("<");
      i++;
      continue;
    }
    const nameStart = i + (closing ? 2 : 1);
    const name = tagNameAt(html, nameStart);
    const end = tagEnd(html, nameStart + name.length);
    // Unterminated tags, fold tags and unmatched wrapper/region end tags become text; the rest is rescanned.
    let literal = end < 0 || name === "details" || name === "summary";
    if (!literal && region) {
      if (name === region) depth += closing ? -1 : 1;
      if (closing && !(name === region && depth === 0)) literal = true;
      if (depth === 0) region = "";
    } else if (!literal && closing && (name === "div" || name === "main")) {
      const k = open.lastIndexOf(name);
      if (k < 0) literal = true;
      else open.length = k;
    } else if (!literal && !closing) {
      if (DROPPED.has(name)) {
        region = name;
        depth = 1;
      } else if (name === "div" || name === "main") {
        open.push(name);
      }
    }
    if (literal) {
      out.push(esc);
      i++;
    } else {
      out.push(html.slice(i, end));
      i = end;
    }
  }
  return out.join("") + open.reverse().map((n) => `</${n}>`).join("");
}

function output(o: Json): string {
  const type = o.output_type;
  if (type === "stream") return `<pre>${escapeHtml(clip(stripAnsi(text(o.text))))}</pre>`;
  if (type === "error") {
    const tb = Array.isArray(o.traceback) ? (o.traceback as string[]).join("\n") : `${String(o.ename)}: ${String(o.evalue)}`;
    return `<pre class="err">${escapeHtml(clip(stripAnsi(tb)))}</pre>`;
  }
  const data = (o.data ?? {}) as Json;
  for (const mime of ["image/png", "image/jpeg", "image/gif"]) {
    const b64 = text(data[mime]).replace(/\s+/g, "");
    if (b64 && /^[A-Za-z0-9+/=]+$/.test(b64)) return `<img src="data:${mime};base64,${b64}" alt="output">`;
  }
  if (data["image/svg+xml"]) {
    const bytes = new TextEncoder().encode(text(data["image/svg+xml"]));
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return `<img src="data:image/svg+xml;base64,${btoa(bin)}" alt="output">`;
  }
  if (data["text/html"]) return `<div>${containOutputMarkup(text(data["text/html"]))}</div>`;
  if (data["text/markdown"]) return `<div>${containOutputMarkup(renderMarkdown(text(data["text/markdown"]), "output.md").html)}</div>`;
  if (data["text/plain"]) return `<pre>${escapeHtml(clip(text(data["text/plain"])))}</pre>`;
  if (data["application/json"]) return `<pre>${escapeHtml(clip(JSON.stringify(data["application/json"], null, 2)))}</pre>`;
  return "";
}

/** Notebook HTML (unsanitized; exported for tests). */
export function renderNotebook(nb: Json): string {
  const meta = (nb.metadata ?? {}) as Json;
  const lang = hljsLanguage(String(((meta.language_info ?? {}) as Json).name ?? ((meta.kernelspec ?? {}) as Json).language ?? "python"));
  const cells = Array.isArray(nb.cells) ? (nb.cells as Json[]) : [];
  return cells
    .map((cell) => {
      const src = text(cell.source);
      if (cell.cell_type === "markdown") return `<div class="dw-cell"><div class="dw-prompt"></div><div class="dw-mdcell">${renderMarkdown(src, "cell.md").html}</div></div>`;
      if (cell.cell_type === "raw") return `<div class="dw-cell"><div class="dw-prompt">raw</div><pre>${escapeHtml(src)}</pre></div>`;
      const n = cell.execution_count == null ? " " : String(cell.execution_count);
      const outs = Array.isArray(cell.outputs) ? (cell.outputs as Json[]).map(output).filter(Boolean) : [];
      return `<div class="dw-cell"><div class="dw-prompt">In [${escapeHtml(n)}]:</div><div><pre><code class="hljs">${highlight(src, lang)}</code></pre>${
        outs.length ? `<details class="dw-out" open><summary>Outputs (${outs.length})</summary>${outs.join("")}</details>` : ""
      }</div></div>`;
    })
    .join("");
}

export const notebookViewer: Viewer = {
  id: "notebook",
  version: NB_VERSION,
  maxBytes: 20 * 1024 * 1024,
  matches: (file, _live, mode) => file.kind === "notebook" && mode !== "source",
  async render(vc) {
    const r = await cachedRender(vc.dw, `notebook@${NB_VERSION}/${vc.file.sha256}`, async () => {
      let nb: Json;
      try {
        nb = JSON.parse(await vc.readText()) as Json;
      } catch (e) {
        return `<p class="dw-note">This notebook is not valid JSON (${escapeHtml((e as Error).message)}). Use Source or Raw.</p>`;
      }
      return sanitizeHtml(renderNotebook(nb));
    });
    return viewerPage(vc, {
      tabs: standardTabs(vc, { rendered: "Notebook", source: true }),
      css: NB_CSS + HIGHLIGHT_CSS,
      body: `<main class="dw-nb">${r.html}</main>`,
      headers: { "X-Kofra-Render-Cache": r.cache },
    });
  },
};
