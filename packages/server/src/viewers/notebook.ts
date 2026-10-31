import { escapeHtml } from "../html";
import { cachedRender } from "./cache";
import { standardTabs, viewerPage } from "./chrome";
import { containOutputMarkup } from "./contain";
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
// 4: output folding with containment and report print treatment with
// shared-link head tags each changed the page after branching; neither
// parent's 3 identifies the merged bytes.
const NB_VERSION = 4;
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
      print: true,
      css: NB_CSS + HIGHLIGHT_CSS,
      body: `<main class="dw-nb">${r.html}</main>`,
      headers: { "X-Kofra-Render-Cache": r.cache },
    });
  },
};
