import { encodePath, isSiteConfigPath, KIND_LABELS } from "@dropway/core";
import { escapeHtml, formatBytes, htmlPage } from "../html";
import type { ViewerContext } from "./index";
import { viewerPhone } from "./phone";
import { compareNames } from "./listing";
import { REPORT_PRINT_CSS } from "./print";
import { unfurlHead } from "./unfurl";

/**
 * The shared frame of every viewer page: one slim bar (kind, path, size, type;
 * view tabs; Download; a link to the app-origin file browser) above the body.
 * The bar is plain links, so it works with JavaScript off.
 */

/**
 * Revision of this shared frame (bar markup and VIEWER_CSS). It is part of
 * every full-page viewer ETag, so a chrome change retires cached pages for
 * extension viewers using viewerPage() too, not just the built-ins whose own
 * `version` is bumped by hand. Bump it whenever the shared output changes.
 */
export const VIEWER_CHROME_VERSION = 2;

/** CSP for viewer pages: no scripts, so user-authored markup inside e.g. Markdown cannot execute. */
export const VIEWER_CSP =
  "default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'unsafe-inline' https:; font-src * data:; frame-src https:; base-uri 'none'; form-action 'none'";

/**
 * VIEWER_CSP plus what one viewer needs: hashed inline scripts, frames or
 * plugin objects from given origins (explicit origins, because 'self' does not
 * reliably match inside a sandboxed, opaque-origin page).
 */
export function viewerCsp(opts: { scriptHashes?: string[]; frameSrc?: string[]; objectSrc?: string[] } = {}): string {
  let csp = VIEWER_CSP;
  if (opts.frameSrc?.length) csp = csp.replace("frame-src https:", `frame-src https: ${opts.frameSrc.join(" ")}`);
  if (opts.objectSrc?.length) csp += `; object-src ${opts.objectSrc.join(" ")}`;
  if (opts.scriptHashes?.length) csp += `; script-src ${opts.scriptHashes.map((h) => `'${h}'`).join(" ")}`;
  return csp;
}

const hashes = new Map<string, Promise<string>>();

/** CSP source hash ("sha256-<base64>") of an inline script, computed once per isolate. */
export function scriptHash(script: string): Promise<string> {
  let h = hashes.get(script);
  if (!h) {
    h = crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)).then((d) => {
      let bin = "";
      for (const b of new Uint8Array(d)) bin += String.fromCharCode(b);
      return `sha256-${btoa(bin)}`;
    });
    hashes.set(script, h);
  }
  return h;
}

export interface ViewerTab {
  label: string;
  href: string;
  current?: boolean;
}

/**
 * The usual tabs: the default view (label names it: "Rendered", "Table", "Tree"...),
 * "Source" for text files and "Raw" (the stored bytes).
 */
export function standardTabs(vc: ViewerContext, opts: { rendered?: string | null; source?: boolean; raw?: boolean } = {}): ViewerTab[] {
  const tabs: ViewerTab[] = [];
  const source = vc.mode === "source";
  if (opts.rendered !== null) tabs.push({ label: opts.rendered ?? "Rendered", href: vc.fileUrl, current: !source });
  if (opts.source) tabs.push({ label: "Source", href: vc.sourceUrl, current: source });
  if (opts.raw !== false) tabs.push({ label: "Raw", href: vc.rawUrl });
  return tabs;
}

/** Breadcrumb links: each folder links to its listing on this origin. */
function crumbs(vc: ViewerContext): string {
  const parts = vc.file.path.split("/");
  const out: string[] = [`<a href="${escapeHtml(vc.siteBase)}">${escapeHtml(vc.live.slug)}</a>`];
  let dir = "";
  parts.forEach((p, i) => {
    if (i === parts.length - 1) out.push(`<strong>${escapeHtml(p)}</strong>`);
    else {
      dir += `${p}/`;
      out.push(`<a href="${escapeHtml(vc.siteBase + encodePath(dir))}">${escapeHtml(p)}</a>`);
    }
  });
  return out.join('<span class="dw-sep">/</span>');
}

/** Direct files in listing name order; image/SVG viewers keep their own stage navigation. */
function siblingLinks(vc: ViewerContext): string {
  if (vc.mode !== "source" && (vc.file.kind === "image" || vc.file.kind === "svg")) return "";
  const slash = vc.file.path.lastIndexOf("/");
  const dir = vc.file.path.slice(0, slash + 1);
  const names = Object.keys(vc.live.files)
    // Private platform inputs are stored but never served or named in navigation.
    .filter((path) => path !== ".dropway" && !path.startsWith(".dropway/") && !isSiteConfigPath(path))
    .filter((path) => path.startsWith(dir) && !path.slice(dir.length).includes("/"))
    .map((path) => path.slice(dir.length))
    .sort(compareNames);
  const i = names.indexOf(vc.file.path.slice(dir.length));
  if (i < 0 || names.length < 2) return "";
  const link = (name: string | undefined, rel: string, label: string) => name === undefined ? "" :
    `<a href="${escapeHtml(vc.siteBase + encodePath(dir + name))}" rel="${rel}" title="${escapeHtml(name)}" aria-label="${escapeHtml(`${label}: ${name}`)}">${label}</a>`;
  return link(names[i - 1], "prev", "Previous") + link(names[i + 1], "next", "Next");
}

export function viewerBar(vc: ViewerContext, tabs: ViewerTab[], extra = ""): string {
  if (vc.embed) return "";
  const siblings = siblingLinks(vc);
  const kind = KIND_LABELS[vc.file.kind] ?? "File";
  const type = vc.file.contentType.split(";")[0]!;
  return `<header class="dw-vbar" role="banner">
<div class="dw-vfile"><span class="dw-kind">${escapeHtml(kind)}</span><span class="dw-crumbs">${crumbs(vc)}</span><span class="dw-vmeta">${formatBytes(vc.file.size)} · ${escapeHtml(type)}</span></div>
<nav class="dw-vtabs" aria-label="View">${tabs
    .map((t) => `<a href="${escapeHtml(t.href)}"${t.current ? ' aria-current="page"' : ""} rel="nofollow">${escapeHtml(t.label)}</a>`)
    .join("")}</nav>
<nav class="dw-vact" aria-label="File"${siblings ? ' style="flex-wrap:wrap;flex-shrink:1;max-width:100%"' : ""}>${siblings}${extra}${viewerPhone(vc)}<a href="${escapeHtml(vc.downloadUrl)}" rel="nofollow" download>Download</a><a href="${escapeHtml(vc.appViewerUrl)}" rel="nofollow" title="Browse every file of this site">Files</a></nav>
</header>`;
}

/** Shared viewer styles (on top of BASE_CSS). */
export const VIEWER_CSS = `
[hidden]{display:none!important}
.dw-vbar{position:sticky;top:0;z-index:20;display:flex;flex-wrap:wrap;gap:.4rem .9rem;align-items:center;justify-content:space-between;padding:.45rem .9rem;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px);font-size:.82rem;line-height:1.3}
.dw-vfile{display:flex;align-items:center;gap:.6rem;min-width:0;flex:1 1 18rem}
.dw-kind{flex:none;font:600 .68rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.05em;text-transform:uppercase;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 40%,transparent);border-radius:4px;padding:.25rem .4rem}
.dw-crumbs{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dw-crumbs a{color:var(--muted);text-decoration:none}.dw-crumbs a:hover{color:var(--accent)}.dw-crumbs strong{font-weight:600;color:var(--fg)}
.dw-sep{color:var(--muted);opacity:.5;padding:0 .2rem}
.dw-vmeta{flex:none;color:var(--muted);white-space:nowrap}
.dw-vtabs{display:flex;border:1px solid var(--line);border-radius:7px;overflow:hidden;flex:none}
.dw-vtabs a{padding:.28rem .7rem;text-decoration:none;color:var(--muted);border-left:1px solid var(--line)}
.dw-vtabs a:first-child{border-left:0}.dw-vtabs a:hover{color:var(--fg);background:var(--code)}
.dw-vtabs a[aria-current]{color:var(--fg);background:var(--card);font-weight:600;box-shadow:inset 0 -2px 0 var(--accent)}
.dw-vact{display:flex;gap:.4rem;flex:none;align-items:center;flex-wrap:wrap;max-width:100%}
.dw-phone summary{list-style:none}.dw-phone summary::-webkit-details-marker{display:none}
.dw-phone summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dw-vbar:has(.dw-phone[open]){position:relative}
.dw-phone-panel{position:absolute;right:.6rem;top:100%;width:min(20rem,calc(100vw - 1.2rem));box-sizing:border-box;padding:1rem;border:1px solid var(--line);border-radius:8px;background:var(--card);box-shadow:0 .5rem 1.5rem #0003}
.dw-phone-panel p{margin:0 0 .75rem}.dw-phone-panel svg{display:block;max-width:100%;height:auto;margin:0 auto .75rem}
.dw-vact .dw-phone-panel a{display:block;overflow-wrap:anywhere;white-space:normal;padding:0;border:0;border-radius:0;background:none;color:var(--accent);text-decoration:underline;user-select:text}
.dw-vact a,.dw-vact label,.dw-phone summary,.dw-btn{padding:.28rem .65rem;border:1px solid var(--line);border-radius:7px;text-decoration:none;color:var(--fg);background:var(--card);cursor:pointer;font-size:.82rem;line-height:1.3;user-select:none}
.dw-vact a:hover,.dw-vact label:hover,.dw-btn:hover{border-color:var(--accent);color:var(--accent)}
.dw-toggle{position:absolute;opacity:0;pointer-events:none}
.dw-toggle:focus-visible+label{outline:2px solid var(--accent);outline-offset:2px}
.dw-note{margin:.75rem auto;max-width:60rem;padding:.55rem .85rem;border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:7px;background:var(--card);font-size:.85rem;color:var(--muted)}
.dw-note a{color:var(--accent)}
.dw-checker{background-color:var(--card);background-image:linear-gradient(45deg,var(--code) 25%,transparent 25%),linear-gradient(-45deg,var(--code) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,var(--code) 75%),linear-gradient(-45deg,transparent 75%,var(--code) 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0}
.dw-meta{color:var(--muted);font-size:.85rem;text-align:center;margin:.75rem 0}
@media (max-width:640px){.dw-vmeta{display:none}.dw-vbar{padding:.4rem .6rem}}
`;

/** A complete viewer page response. `body` is trusted HTML (escape user content before passing it). */
export function viewerPage(
  vc: ViewerContext,
  opts: { title?: string; body: string; css?: string; print?: boolean; tabs: ViewerTab[]; barExtra?: string; csp?: string; script?: string; headers?: Record<string, string> },
): Response {
  const title = opts.title ?? `${vc.file.path.split("/").pop()} · ${vc.live.slug}`;
  const page = htmlPage({
    title,
    css: VIEWER_CSS + (opts.css ?? "") + (opts.print ? REPORT_PRINT_CSS : ""),
    head: unfurlHead({
      title,
      description: `${KIND_LABELS[vc.file.kind] ?? "File"} · ${formatBytes(vc.file.size)} · ${vc.file.contentType.split(";")[0]}`,
      // Live badge.svg is reserved for provider status; previews serve the uploaded path directly.
      url: vc.url.origin + vc.siteBase + (!vc.preview && vc.file.path === "badge.svg" ? "" : encodePath(vc.file.path)),
      image: vc.file.kind === "image",
    }),
    // File path only: never copy request/capability URLs into printed context, even when embedded.
    body: viewerBar(vc, opts.tabs, opts.barExtra) + (opts.print ? `<p class="dw-print-title">${escapeHtml(vc.file.path)}</p>` : "") + opts.body + (opts.script ? `<script>${opts.script}</script>` : ""),
  });
  const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8", ...opts.headers };
  if (opts.csp) headers["Content-Security-Policy"] = opts.csp;
  return new Response(page, { headers });
}

/** Note shown when only the first part of a large file is displayed. */
export function truncatedNote(vc: ViewerContext, shownBytes: number): string {
  return `<p class="dw-note">Showing the first ${formatBytes(shownBytes)} of ${formatBytes(vc.file.size)}. <a href="${escapeHtml(vc.rawUrl)}" rel="nofollow">Raw</a> or <a href="${escapeHtml(vc.downloadUrl)}" rel="nofollow">download</a> the whole file.</p>`;
}

/** Decode UTF-8 (BOM stripped, invalid sequences replaced). */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
}
