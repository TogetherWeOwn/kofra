import { escapeHtml } from "../html";
import { cachedRender } from "./cache";
import { standardTabs, viewerCarry, viewerPage } from "./chrome";
import { containOutputMarkup } from "./contain";
import { HIGHLIGHT_CSS, highlight, hljsLanguage } from "./highlight";
import type { Viewer } from "./index";
import { carryDocLinks } from "./links";
import { MD_CSS, renderMarkdown } from "./markdown";
import { sanitizeHtml } from "./sanitize";

/**
 * Jupyter notebooks (.ipynb): Markdown cells rendered, code cells highlighted
 * with their execution count, outputs shown (text, errors, PNG/JPEG/GIF/SVG
 * images, HTML and Markdown through the sanitizer), grouped per cell in a
 * native initially-open <details> so a reader can fold a long result without
 * hiding the code that produced it. Nothing executes.
 */
// 4: output folding with containment and report print treatment with
// shared-link head tags each changed the page after branching; neither
// parent's 3 identifies the merged bytes.
const NB_VERSION = 4;
const MAX_OUTPUT_TEXT = 100_000;

const NB_CSS = `
.k-doc .anchor-link{margin-left:.35em;color:var(--muted);opacity:0;text-decoration:none;font:400 .7em var(--sans)}
.k-doc :is(h1,h2,h3,h4,h5,h6):hover .anchor-link,.k-doc .anchor-link:focus-visible{opacity:1}
.dw-cell{display:grid;grid-template-columns:5.5rem minmax(0,1fr);gap:.5rem;margin:0 0 1rem}
.dw-prompt{font:400 12px/1.9 var(--mono);color:var(--muted);text-align:right;padding-top:.45rem}
.dw-cell pre{margin:0;background:var(--paper-3);border:1px solid var(--rule-soft);padding:12px 14px;overflow:auto;font-size:13px;line-height:1.55}
.dw-out{margin-top:.4rem;background:var(--surface);border-top:1px solid var(--rule-soft)}
.dw-out>summary{cursor:pointer;color:var(--muted);font:400 12px/1.4 var(--mono);padding:6px 0}
.dw-out>summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.dw-out pre{background:transparent;border:0;border-left:3px solid var(--rule-soft)}
.dw-out pre.err{border-left-color:var(--danger);color:var(--danger)}
.dw-out img{display:block;max-width:100%;height:auto;margin:10px 0;background:#fff}
.dw-mdcell{min-width:0}
.dw-mdcell :is(h1,h2,h3){line-height:1.25}
.dw-out table{border-collapse:collapse;font-size:14px}.dw-out th,.dw-out td{border:1px solid var(--rule-soft);padding:.25rem .55rem}
@media (max-width:640px){.dw-cell{grid-template-columns:minmax(0,1fr)}.dw-prompt{text-align:left;padding:0}}
`;

type Json = Record<string, unknown>;
const text = (v: unknown): string => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "");
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
const clip = (s: string) => (s.length > MAX_OUTPUT_TEXT ? `${s.slice(0, MAX_OUTPUT_TEXT)}\n…` : s);

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
        return `<p class="k-banner k-notebar" role="note">This notebook is not valid JSON (${escapeHtml((e as Error).message)}). Use Source or Raw.</p>`;
      }
      return sanitizeHtml(renderNotebook(nb));
    });
    return viewerPage(vc, {
      tabs: standardTabs(vc, { rendered: "Notebook", source: true }),
      print: true,
      css: MD_CSS + NB_CSS + HIGHLIGHT_CSS,
      body: `<div class="k-doc dw-nb">${await carryDocLinks(r.html, vc.url.pathname, vc.siteBase, viewerCarry(vc))}</div>`,
      headers: { "X-Kofra-Render-Cache": r.cache },
    });
  },
};
