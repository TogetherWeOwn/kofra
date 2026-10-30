import { TEXT_KINDS, languageFor, type FileKind } from "@dropway/core";
import { escapeHtml } from "../html";
import { cachedRender } from "./cache";
import { decodeText, scriptHash, standardTabs, truncatedNote, viewerCsp, viewerPage } from "./chrome";
import { HIGHLIGHT_CSS, HIGHLIGHT_MAX_BYTES, highlight, hljsLanguage, splitHighlightedLines } from "./highlight";
import type { Viewer, ViewerContext } from "./index";

/**
 * Code and text: highlighted (highlight.js, server-side), line numbers that are
 * links (#L12), and — with JavaScript — line-range selection that only rewrites the
 * fragment (#L10-L20): shift-click another line number from an established line, or
 * use the toolbar's First/Last line inputs. A wrap toggle that works without
 * JavaScript, and a Copy button (a hashed inline script; hidden when scripts are
 * off, like the range controls). The address stays a live address: the fragment
 * names lines of whatever version is served, nothing more.
 * Also the "Source" view of every text file (?view=source), HTML included.
 */

/** At most this much text is shown; the rest is one click away (Raw, Download). */
export const SHOW_MAX_BYTES = 1024 * 1024;

// 3 rotates the merged line-range selection and report print treatment:
// both changed codePage output after branching from 1, so neither parent's 2
// identifies the merged bytes. 4 adds the Phone disclosure to the viewer bar.
const CODE_VERSION = 4;

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

/** Range-selection toolbar styles. Kept out of CODE_CSS so pages that only reuse the line styles (JSON) are byte-unchanged. */
const RANGE_CSS = `
.dw-codehead{flex-wrap:wrap}
.dw-range{display:inline-flex;gap:.35rem;align-items:center;flex-wrap:wrap}
.dw-range input{width:4.5em;padding:.28rem .4rem;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--fg);font:inherit}
.dw-range input[aria-invalid="true"]{border-color:var(--accent)}
.dw-range input:focus-visible,.dw-range button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dw-rangehint,.dw-rangemsg{flex:1 1 100%;text-align:right}
`;

/**
 * Copy + line-range selection and highlighting. Static text, allowed by its CSP hash.
 * Selections only assign `location.hash` (at most one history entry, no network or storage):
 * the shift-click anchor is the first line of the current valid `#L…` selection, so
 * hand-typed hashes and Back/Forward behave exactly like clicked selections, and a
 * plain click keeps the anchor's own default `#Ln` navigation. Highlighting a range
 * stops after 5000 lines; the keyboard route refuses a wider range and says so.
 */
export const CODE_SCRIPT = `(function(){var d=document,b=d.getElementById("dw-copy");if(b&&navigator.clipboard){b.hidden=false;b.addEventListener("click",function(){var t=Array.prototype.map.call(d.querySelectorAll(".dw-src .c"),function(e){return e.textContent}).join("\\n");navigator.clipboard.writeText(t).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1500)},function(){b.textContent="Copy failed"})})}function parse(h){var m=/^#L(\\d+)(?:-L?(\\d+))?$/.exec(h);if(!m)return null;var a=+m[1],z=m[2]?+m[2]:a;if(z<a){var t=a;a=z;z=t}return[a,z,m[2]?1:0]}function hl(){Array.prototype.forEach.call(d.querySelectorAll(".dw-hl"),function(e){e.classList.remove("dw-hl")});var p=parse(location.hash);if(!p||!p[2])return;var a=p[0],z=p[1],box=d.querySelector(".dw-lines"),rs=box?box.children:[],f=null;for(var i=a;i<=z&&i<a+5000;i++){var e=rs[i-1];if(e&&e.id==="L"+i){e.classList.add("dw-hl");if(i===a)f=e}}if(f)f.scrollIntoView({block:"center"})}function select(a,z){if(z<a){var t=a;a=z;z=t}location.hash=a===z?"#L"+a:"#L"+a+"-L"+z;hl()}function anchor(){var p=parse(location.hash);return p&&d.getElementById("L"+p[0])?p[0]:0}d.addEventListener("click",function(ev){if(!ev.shiftKey||ev.ctrlKey||ev.metaKey||ev.altKey||ev.button)return;var t=ev.target;while(t&&t.tagName!=="A")t=t.parentNode;if(!t)return;var m=/^#L(\\d+)$/.exec(t.getAttribute("href")||"");if(!m)return;var a=anchor(),n=+m[1];ev.preventDefault();if(typeof getSelection==="function"){var s=getSelection();if(s)s.removeAllRanges()}select(a||n,n)});var r=d.getElementById("dw-range"),hint=d.getElementById("dw-range-hint"),first=d.getElementById("dw-line-first"),last=d.getElementById("dw-line-last"),go=d.getElementById("dw-line-select"),msg=d.getElementById("dw-line-msg");if(r)r.hidden=false;if(hint)hint.hidden=false;function read(inp){var v=(inp.value||"").replace(/^\\s+|\\s+$/g,"");return /^\\d+$/.test(v)?+v:0}function fail(text,inp){if(first)first.removeAttribute("aria-invalid");if(last)last.removeAttribute("aria-invalid");if(msg)msg.textContent=text;if(inp){inp.setAttribute("aria-invalid","true");inp.focus()}}function choose(){var max=+(last.getAttribute("max")||0),a=read(first),z=read(last);if(!a||a>max){fail("Enter a first line number between 1 and "+max+". Only shown lines can be selected.",first);return}if(!z||z>max){fail("Enter a last line number between 1 and "+max+". Only shown lines can be selected.",last);return}var lo=a<z?a:z,hi=a<z?z:a;if(hi-lo+1>5000){fail("Select at most 5000 lines at a time: lines "+lo+" to "+hi+" is over the limit.",last);return}if(first)first.removeAttribute("aria-invalid");if(last)last.removeAttribute("aria-invalid");if(msg)msg.textContent="";select(lo,hi)}if(go&&first&&last){go.addEventListener("click",choose);var enter=function(ev){if(ev.key==="Enter"){ev.preventDefault();choose()}};first.addEventListener("keydown",enter);last.addEventListener("keydown",enter)}addEventListener("hashchange",hl);hl()})();`;

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
<div class="dw-codehead"><span class="dw-lang">${escapeHtml(name ?? "plain text")} · ${lines.toLocaleString("en-US")} line${lines === 1 ? "" : "s"}</span><span class="dw-range" id="dw-range" hidden><label for="dw-line-first">First line</label><input id="dw-line-first" type="number" min="1" max="${lines}" inputmode="numeric" aria-describedby="dw-line-msg"><label for="dw-line-last">Last line</label><input id="dw-line-last" type="number" min="1" max="${lines}" inputmode="numeric" aria-describedby="dw-line-msg"><button type="button" id="dw-line-select" class="dw-btn">Select lines</button></span><label for="dw-wrap" class="dw-btn">Wrap</label><button type="button" id="dw-copy" class="dw-btn" hidden>Copy</button><span class="dw-rangehint" id="dw-range-hint" hidden>Shift-click another line number to select a range of lines. The address in your browser updates, so you can copy it to link to those lines.</span><span class="dw-rangemsg" id="dw-line-msg" role="status"></span></div>
<div class="dw-src">${html}</div></main>`;
  return viewerPage(vc, {
    tabs: opts.tabs,
    body,
    print: true,
    css: CODE_CSS + RANGE_CSS + HIGHLIGHT_CSS,
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
