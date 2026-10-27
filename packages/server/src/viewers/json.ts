import { escapeHtml } from "../html";
import { cachedRender } from "./cache";
import { standardTabs, viewerPage } from "./chrome";
import { CODE_CSS, renderCodeLines } from "./code";
import { HIGHLIGHT_CSS } from "./highlight";
import type { Viewer } from "./index";

/**
 * JSON: a collapsible tree built from <details> elements (no script), with
 * key counts and typed values, plus a pretty-printed, highlighted view.
 * Invalid JSON shows the parse error above the highlighted source.
 */
// 4: report print, shared-link head tags and the Tree/Pretty keyboard-focus fix each
// changed the page after branching; neither parent's 3 identifies the merged bytes.
const JSON_VERSION = 4;
/** Nodes rendered in the tree before the rest is summarised. */
const MAX_NODES = 20_000;
/** Strings longer than this are cut in the tree (the pretty view has them whole). */
const MAX_STRING = 2_000;
/** Pretty-print only up to this many characters of output. */
const MAX_PRETTY = 1024 * 1024;

const JSON_CSS = `
.dw-json{padding:.5rem .9rem 3rem}
.dw-jtabs{display:flex;gap:.4rem;margin:.4rem 0 .6rem}
.dw-jtabs label{padding:.28rem .7rem;border:1px solid var(--line);border-radius:7px;cursor:pointer;font-size:.82rem;color:var(--muted);background:var(--card)}
#dw-jt-tree:checked~.dw-jtabs label[for=dw-jt-tree],#dw-jt-pretty:checked~.dw-jtabs label[for=dw-jt-pretty]{color:var(--fg);border-color:var(--accent);font-weight:600}
#dw-jt-tree:focus-visible~.dw-jtabs label[for=dw-jt-tree],#dw-jt-pretty:focus-visible~.dw-jtabs label[for=dw-jt-pretty]{outline:2px solid var(--accent);outline-offset:2px}
.dw-jpane{display:none}
#dw-jt-tree:checked~.dw-jtree,#dw-jt-pretty:checked~.dw-jpretty{display:block}
.dw-jpretty .dw-src{margin:0}
.dw-jtree{font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid var(--line);border-radius:9px;background:var(--card);padding:.6rem .9rem;overflow:auto}
.dw-jtree ul{list-style:none;margin:0;padding:0 0 0 1.3rem;border-left:1px dotted var(--line)}
.dw-jtree li{margin:0;white-space:nowrap}
.dw-jtree details>summary{cursor:pointer;list-style:none}
.dw-jtree details>summary::-webkit-details-marker{display:none}
.dw-jtree details>summary::before{content:"▸";display:inline-block;width:1em;color:var(--muted);transition:transform .1s}
.dw-jtree details[open]>summary::before{transform:rotate(90deg)}
.dw-jtree .leaf{padding-left:1em}
.dw-jk{color:#0550ae}.dw-js{color:#0a3069;white-space:pre-wrap;word-break:break-word}.dw-jn{color:#953800}.dw-jb{color:#cf222e}.dw-jz{color:var(--muted)}
.dw-jc{color:var(--muted);font-size:.85em;margin-left:.4rem}
.dw-jerr{margin:.75rem .9rem;padding:.6rem .9rem;border:1px solid #cf222e;border-radius:8px;color:#cf222e;background:color-mix(in srgb,#cf222e 8%,transparent);font-size:.88rem}
@media (prefers-color-scheme:dark){.dw-jk{color:#79c0ff}.dw-js{color:#a5d6ff}.dw-jn{color:#ffa657}.dw-jb{color:#ff7b72}}
`;

interface Budget {
  left: number;
}

function value(v: unknown): string {
  if (v === null) return '<span class="dw-jz">null</span>';
  if (typeof v === "string") {
    const s = v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
    const q = escapeHtml(JSON.stringify(s));
    if (/^https?:\/\/[^\s"<>]+$/.test(v) && v.length < 2048) return `<a class="dw-js" href="${escapeHtml(v)}" rel="nofollow noopener noreferrer">${q}</a>`;
    return `<span class="dw-js">${q}</span>`;
  }
  if (typeof v === "number") return `<span class="dw-jn">${escapeHtml(String(v))}</span>`;
  if (typeof v === "boolean") return `<span class="dw-jb">${v}</span>`;
  return "";
}

function node(key: string | null, v: unknown, depth: number, budget: Budget): string {
  budget.left--;
  const k = key === null ? "" : `<span class="dw-jk">${escapeHtml(key)}</span>: `;
  if (v === null || typeof v !== "object") return `<li class="leaf">${k}${value(v)}</li>`;
  const isArr = Array.isArray(v);
  const entries: Array<[string, unknown]> = isArr ? (v as unknown[]).map((x, i) => [String(i), x]) : Object.entries(v as Record<string, unknown>);
  const open = isArr ? "[" : "{";
  const close = isArr ? "]" : "}";
  const count = `<span class="dw-jc">${entries.length.toLocaleString("en-US")} ${isArr ? (entries.length === 1 ? "item" : "items") : entries.length === 1 ? "key" : "keys"}</span>`;
  if (!entries.length) return `<li class="leaf">${k}<span class="dw-jz">${open}${close}</span></li>`;
  const items: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (budget.left <= 0) {
      items.push(`<li class="leaf dw-jz">… ${(entries.length - i).toLocaleString("en-US")} more (see the Pretty or Raw view)</li>`);
      break;
    }
    const [ck, cv] = entries[i]!;
    items.push(node(isArr ? null : ck, cv, depth + 1, budget));
  }
  return `<li><details${depth < 2 ? " open" : ""}><summary>${k}<span class="dw-jz">${open}</span>${count}</summary><ul>${items.join("")}</ul><span class="dw-jz">${close}</span></details></li>`;
}

/** The JSON tree as HTML (exported for tests). */
export function renderJsonTree(v: unknown): string {
  return `<ul style="border:0;padding:0">${node(null, v, 0, { left: MAX_NODES })}</ul>`;
}

export const jsonViewer: Viewer = {
  id: "json",
  version: JSON_VERSION,
  maxBytes: 2 * 1024 * 1024,
  matches: (file, _live, mode) => file.kind === "json" && mode !== "source",
  async render(vc) {
    const text = await vc.readText();
    let parsed: unknown;
    let error: string | null = null;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (e) {
      error = (e as Error).message;
    }
    const tabs = standardTabs(vc, { rendered: "Tree", source: true });
    if (error !== null) {
      const { html, cache } = await renderCodeLines(vc, text, "json", "full");
      return viewerPage(vc, {
        tabs,
        print: true,
        css: CODE_CSS + HIGHLIGHT_CSS + JSON_CSS,
        body: `<p class="dw-jerr" role="alert">This file is not valid JSON: ${escapeHtml(error)}</p><main class="dw-codewrap"><div class="dw-src">${html}</div></main>`,
        headers: { "X-Kofra-Render-Cache": cache },
      });
    }
    const tree = await cachedRender(vc.dw, `json@${JSON_VERSION}/tree/${vc.file.sha256}`, async () => renderJsonTree(parsed));
    const prettyText = JSON.stringify(parsed, null, 2);
    const pretty = prettyText.length <= MAX_PRETTY ? (await renderCodeLines(vc, prettyText, "json", "pretty")).html : null;
    // Without a Pretty pane there is no Pretty tab either, so the radio goes
    // too: otherwise arrowing to it shows no focus indicator (its label is
    // the indicator's target) and hides the tree with nothing to show.
    const prettyInput = pretty ? '<input type="radio" name="dw-jt" id="dw-jt-pretty" class="dw-toggle">' : "";
    const body = `<main class="dw-json">
<input type="radio" name="dw-jt" id="dw-jt-tree" class="dw-toggle" checked>${prettyInput}
<div class="dw-jtabs"><label for="dw-jt-tree">Tree</label>${pretty ? '<label for="dw-jt-pretty">Pretty</label>' : ""}</div>
<div class="dw-jpane dw-jtree">${tree.html}</div>
${pretty ? `<div class="dw-jpane dw-jpretty"><div class="dw-src">${pretty}</div></div>` : ""}
</main>`;
    return viewerPage(vc, { tabs, print: true, css: CODE_CSS + HIGHLIGHT_CSS + JSON_CSS, body, headers: { "X-Kofra-Render-Cache": tree.cache } });
  },
};
