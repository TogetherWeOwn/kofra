import { TEXT_KINDS, languageFor, type FileKind } from "@dropway/core";
import { escapeHtml } from "../html";
import { cachedRender } from "./cache";
import { decodeText, scriptHash, standardTabs, truncatedNote, viewerCsp, viewerPage } from "./chrome";
import { HIGHLIGHT_CSS, HIGHLIGHT_MAX_BYTES, highlight, hljsLanguage, splitHighlightedLines } from "./highlight";
import type { Viewer, ViewerContext } from "./index";

/**
 * Code and text: highlighted (highlight.js, server-side), line numbers that are
 * links (#L12; #L10-L20 with JavaScript), a wrap toggle that works without
 * JavaScript, and a Copy button (a hashed inline script; hidden when scripts are off).
 * Also the "Source" view of every text file (?view=source), HTML included.
 */

/** At most this much text is shown; the rest is one click away (Raw, Download). */
export const SHOW_MAX_BYTES = 1024 * 1024;

const CODE_VERSION = 2;

/** The highlighting language for a file of this kind, or null for plain text. */
export function codeLanguage(path: string, kind: FileKind): string | null {
  if (kind === "html" || kind === "svg") return "xml";
  if (kind === "json" || kind === "notebook") return "json";
  if (kind === "markdown") return "markdown";
  return languageFor(path);
}

export const CODE_CSS = `
.dw-codewrap{position:relative}
.dw-codehead{display:flex;gap:.6rem;align-items:center;justify-content:flex-end;padding:.5rem .9rem 0;font-size:.8rem;color:var(--muted)}
.dw-codehead .dw-lang{margin-right:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dw-src{margin:.5rem .9rem 2rem;border:1px solid var(--line);border-radius:9px;background:var(--card);overflow:auto;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:4}
.dw-lines{display:table;min-width:100%;border-collapse:collapse;padding:.4rem 0}
.dw-ln{display:table-row}
.dw-ln>a{display:table-cell;width:1%;min-width:3.2em;padding:0 .9em 0 .8em;text-align:right;color:var(--muted);opacity:.6;text-decoration:none;user-select:none;-webkit-user-select:none;border-right:1px solid var(--line);vertical-align:top}
.dw-ln>a::before{content:attr(data-n)}
.dw-ln>a:hover{opacity:1;color:var(--accent)}
.dw-ln>.c{display:table-cell;padding:0 1em;white-space:pre}
.dw-ln:target,.dw-ln.dw-hl{background:color-mix(in srgb,var(--accent) 14%,transparent)}
.dw-ln:target>a,.dw-ln.dw-hl>a{opacity:1;color:var(--accent)}
#dw-wrap:checked~.dw-src .c{white-space:pre-wrap;overflow-wrap:anywhere}
#dw-wrap:checked~.dw-codehead label{border-color:var(--accent);color:var(--accent)}
#dw-wrap:focus-visible~.dw-codehead label{outline:2px solid var(--accent);outline-offset:2px}
`;

/** Copy + line-range highlighting. Static text, allowed by its CSP hash. */
export const CODE_SCRIPT = `(function(){var d=document,b=d.getElementById("dw-copy");if(b&&navigator.clipboard){b.hidden=false;b.addEventListener("click",function(){var t=Array.prototype.map.call(d.querySelectorAll(".dw-src .c"),function(e){return e.textContent}).join("\\n");navigator.clipboard.writeText(t).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1500)},function(){b.textContent="Copy failed"})})}function hl(){var m=/^#L(\\d+)(?:-L?(\\d+))?$/.exec(location.hash);Array.prototype.forEach.call(d.querySelectorAll(".dw-hl"),function(e){e.classList.remove("dw-hl")});if(!m||!m[2])return;var a=+m[1],z=+m[2];if(z<a){var t=a;a=z;z=t}for(var i=a;i<=z&&i<a+5000;i++){var e=d.getElementById("L"+i);if(e)e.classList.add("dw-hl")}var f=d.getElementById("L"+a);if(f)f.scrollIntoView({block:"center"})}addEventListener("hashchange",hl);hl()})();`;

/** Render text as numbered, optionally highlighted lines (cached by content). */
export async function renderCodeLines(vc: ViewerContext, text: string, lang: string | null, variant: string): Promise<{ html: string; lines: number; cache: string }> {
  const name = hljsLanguage(lang);
  const key = `code@${CODE_VERSION}/${name ?? "plain"}/${variant}/${vc.file.sha256}`;
  const r = await cachedRender(vc.dw, key, async () => {
    const src = text.replace(/\r\n?/g, "\n");
    const html = highlight(src, name);
    const rows = splitHighlightedLines(html);
    if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
    return `<div class="dw-lines">${rows.map((row, i) => `<div class="dw-ln" id="L${i + 1}"><a href="#L${i + 1}" data-n="${i + 1}" aria-label="Line ${i + 1}"></a><span class="c">${row}</span></div>`).join("")}</div>`;
  });
  const lines = (r.html.match(/class="dw-ln"/g) ?? []).length;
  return { html: r.html, lines, cache: r.cache };
}

/** Read up to SHOW_MAX_BYTES of the file as text. */
export async function readShownText(vc: ViewerContext): Promise<{ text: string; truncated: boolean; shown: number }> {
  const truncated = vc.file.size > SHOW_MAX_BYTES;
  const bytes = await vc.readBytes(0, truncated ? SHOW_MAX_BYTES : vc.file.size);
  return { text: decodeText(bytes), truncated, shown: bytes.byteLength };
}

/** Full code page for `text` (used by the code, source and binary-as-text views). */
export async function codePage(vc: ViewerContext, opts: { text: string; truncated: boolean; shown: number; lang: string | null; note?: string; tabs: ReturnType<typeof standardTabs> }) {
  const { html, lines, cache } = await renderCodeLines(vc, opts.text, opts.lang, opts.truncated ? `first${opts.shown}` : "full");
  const name = hljsLanguage(opts.lang);
  const plainNote = opts.text.length > HIGHLIGHT_MAX_BYTES && name ? `<p class="dw-note">This file is too large to highlight; it is shown as plain text.</p>` : "";
  const body = `${opts.note ?? ""}${opts.truncated ? truncatedNote(vc, opts.shown) : ""}${plainNote}<main class="dw-codewrap">
<input type="checkbox" id="dw-wrap" class="dw-toggle">
<div class="dw-codehead"><span class="dw-lang">${escapeHtml(name ?? "plain text")} · ${lines.toLocaleString("en-US")} line${lines === 1 ? "" : "s"}</span><label for="dw-wrap" class="dw-btn">Wrap</label><button type="button" id="dw-copy" class="dw-btn" hidden>Copy</button></div>
<div class="dw-src">${html}</div></main>`;
  return viewerPage(vc, {
    tabs: opts.tabs,
    body,
    print: true,
    css: CODE_CSS + HIGHLIGHT_CSS,
    script: CODE_SCRIPT,
    csp: viewerCsp({ scriptHashes: [await scriptHash(CODE_SCRIPT)] }),
    headers: { "X-Kofra-Render-Cache": cache },
  });
}

/** Kinds whose default view is this code view (the specific viewers fall back to it above their size caps). */
const CODE_KINDS = new Set<FileKind>(["code", "text", "json", "csv", "notebook"]);

export const codeViewer: Viewer = {
  id: "code",
  version: CODE_VERSION,
  maxBytes: Number.MAX_SAFE_INTEGER,
  matches: (file, _live, mode) => mode !== "source" && CODE_KINDS.has(file.kind),
  async render(vc) {
    const shown = await readShownText(vc);
    return codePage(vc, { ...shown, lang: codeLanguage(vc.file.path, vc.file.kind), tabs: standardTabs(vc, { rendered: vc.file.kind === "code" ? "Code" : "Text" }) });
  },
};

/** ?view=source for any text file. */
export const sourceViewer: Viewer = {
  id: "source",
  version: CODE_VERSION,
  maxBytes: Number.MAX_SAFE_INTEGER,
  matches: (file, _live, mode) => mode === "source" && TEXT_KINDS.has(file.kind),
  async render(vc) {
    const shown = await readShownText(vc);
    const k = vc.file.kind;
    const rendered = k === "html" ? "Page" : k === "code" || k === "text" ? null : "Rendered";
    return codePage(vc, { ...shown, lang: codeLanguage(vc.file.path, k), tabs: standardTabs(vc, { rendered, source: true }) });
  },
};
