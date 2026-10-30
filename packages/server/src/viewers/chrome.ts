import { appOrigin, encodePath, KIND_LABELS } from "@dropway/core";
import { escapeHtml, formatBytes, htmlPage } from "../html";
import { SKIP_LINK, TRUST_LINE } from "../ui/chrome";
import { fileSeal } from "../ui/motifs";
import { themeOf } from "../ui/theme";
import type { ViewerContext } from "./index";
import { compareNames } from "./listing";
import { carryLink, type LinkCarry } from "./links";
import { viewerPhone } from "./phone";
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
export const VIEWER_CHROME_VERSION = 3;

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
  /** The stored bytes (never gets ?theme=). */
  raw?: boolean;
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
  if (opts.raw !== false) tabs.push({ label: "Raw", href: vc.rawUrl, raw: true });
  return tabs;
}

/** What links from this viewer page carry: its explicit mode (?theme=) and the embed (links.ts). */
export function viewerCarry(vc: ViewerContext): LinkCarry {
  return { theme: themeOf(vc.dw), embed: vc.embed };
}

/** Breadcrumb links: each folder links to its listing on this origin (in this page's mode). */
function crumbs(vc: ViewerContext): string {
  const parts = vc.file.path.split("/");
  const carry = viewerCarry(vc);
  const out: string[] = [`<a href="${escapeHtml(carryLink(vc.siteBase, vc.siteBase, carry))}">${escapeHtml(vc.live.slug)}</a>`];
  let dir = "";
  parts.forEach((p, i) => {
    if (i === parts.length - 1) out.push(`<strong aria-current="page">${escapeHtml(p)}</strong>`);
    else {
      dir += `${p}/`;
      out.push(`<a href="${escapeHtml(carryLink(vc.siteBase, vc.siteBase + encodePath(dir), carry))}">${escapeHtml(p)}</a>`);
    }
  });
  return out.join('<span class="k-sep" aria-hidden="true">/</span>');
}

/**
 * Carry ?theme= (set by the app's file viewer for an explicit mode) onto links to other Kofra-generated
 * views of the same file (Rendered, Source). Never onto Raw or Download: those are the user's bytes.
 */
function withTheme(vc: ViewerContext, href: string): string {
  const t = vc.url.searchParams.get("theme");
  if (t !== "light" && t !== "dark") return href;
  // An HTML file's own address is the user's page, not a Kofra view.
  if (vc.file.kind === "html" && !/[?&]view=/.test(href)) return href;
  return `${href}${href.includes("?") ? "&" : "?"}theme=${t}`;
}

/** Direct files in listing name order; image/SVG viewers keep their own stage navigation. */
function siblingLinks(vc: ViewerContext): string {
  if (vc.mode !== "source" && (vc.file.kind === "image" || vc.file.kind === "svg")) return "";
  const slash = vc.file.path.lastIndexOf("/");
  const dir = vc.file.path.slice(0, slash + 1);
  const names = Object.keys(vc.live.files)
    // .dropway/* is stored but never served, so listings (and these links) do not name it.
    .filter((path) => path !== ".dropway" && !path.startsWith(".dropway/"))
    .filter((path) => path.startsWith(dir) && !path.slice(dir.length).includes("/"))
    .map((path) => path.slice(dir.length))
    .sort(compareNames);
  const i = names.indexOf(vc.file.path.slice(dir.length));
  if (i < 0 || names.length < 2) return "";
  const link = (name: string | undefined, rel: string, label: string) => name === undefined ? "" :
    `<a class="k-btn k-sm k-ghost" href="${escapeHtml(carryLink(vc.siteBase, vc.siteBase + encodePath(dir + name), viewerCarry(vc)))}" rel="${rel}" title="${escapeHtml(name)}" aria-label="${escapeHtml(`${label}: ${name}`)}">${label}</a>`;
  return link(names[i - 1], "prev", "Previous") + link(names[i + 1], "next", "Next");
}

/** The instance a viewer renders for; renderers fed a bare context (no config) fall back to defaults. */
function instanceOf(vc: ViewerContext): { origin: string | undefined; name: string } {
  return vc.dw?.config ? { origin: appOrigin(vc.dw), name: vc.dw.config.instanceName } : { origin: undefined, name: "Kofra" };
}

export function viewerBar(vc: ViewerContext, tabs: ViewerTab[], extra = ""): string {
  if (vc.embed) return "";
  const siblings = siblingLinks(vc);
  const kind = KIND_LABELS[vc.file.kind] ?? "File";
  const type = vc.file.contentType.split(";")[0]!;
  const inst = instanceOf(vc);
  return `<header class="k-vbar dw-vbar">
<div class="k-vfile"><a class="k-wm" href="${escapeHtml(inst.origin ?? "/")}" rel="nofollow">${escapeHtml(inst.name)}</a><span class="k-chip k-accent">${escapeHtml(kind)}</span><nav class="k-crumbs" aria-label="Path" title="${escapeHtml(vc.file.path)}">${crumbs(vc)}</nav><span class="k-vmeta">${formatBytes(vc.file.size)} · ${escapeHtml(type)}</span><span class="k-sum k-mini">${fileSeal(vc.file.path, vc.file.sha256)}<details class="k-checksum"><summary>SHA-256 ${escapeHtml(vc.file.sha256.slice(0, 12))}</summary><code>${escapeHtml(vc.file.sha256)}</code></details></span></div>
<nav class="k-seg" aria-label="View">${tabs
    .map((t) => `<a href="${escapeHtml(t.raw ? t.href : withTheme(vc, t.href))}"${t.current ? ' aria-current="page"' : ""} rel="nofollow">${escapeHtml(t.label)}</a>`)
    .join("")}</nav>
<nav class="k-btnrow" aria-label="File">${siblings}${extra}${viewerPhone(vc)}<a class="k-btn k-sm k-ghost" href="${escapeHtml(vc.downloadUrl)}" rel="nofollow" download>Download</a><a class="k-btn k-sm k-ghost" href="${escapeHtml(vc.appViewerUrl)}" rel="nofollow" title="Browse every file of this site">Files</a></nav>
<p class="k-trust k-show-lg">${TRUST_LINE}</p>
</header>`;
}

/** Shared viewer styles (on top of the site bundle). */
export const VIEWER_CSS = `
[hidden]{display:none!important}
.k-vbody{min-height:calc(100vh - 3.5rem)}
.k-toggle:focus-visible~* .k-togglebtn,.k-toggle:focus-visible~.k-togglebtn{outline:2px solid var(--focus);outline-offset:2px}
.dw-phone summary{list-style:none}.dw-phone summary::-webkit-details-marker{display:none}
.k-vbar:has(.dw-phone[open]){position:relative}
.dw-phone-panel{position:absolute;right:12px;top:100%;z-index:30;width:min(20rem,calc(100vw - 24px));box-sizing:border-box;padding:16px;border:1px solid var(--rule-soft);background:var(--paper);box-shadow:var(--shadow-2);font-size:14px;color:var(--ink)}
.dw-phone-panel p{margin:0 0 12px}.dw-phone-panel svg{display:block;max-width:100%;height:auto;margin:0 auto 12px}
.dw-phone-panel a{display:block;overflow-wrap:anywhere;font-family:var(--mono);font-size:12.5px;color:var(--accent)}
`;

/**
 * A complete viewer page response. `body` is trusted HTML (escape user content before passing it); it is the
 * page's one <main id="dw-main"> (viewers never add their own), after a "Skip to content" link that passes the
 * bar. Every viewer page has an h1: a body with no h1 of its own (JSON, a table, an image, code, a PDF, an HTML
 * page in the frame...) gets the file name as a visually hidden h1 (`srHeading` forces it either way). The trust
 * line under the body (phones and tablets; from 1000px it is in the bar) sits in the page's footer landmark.
 */
export function viewerPage(
  vc: ViewerContext,
  opts: { title?: string; body: string; css?: string; print?: boolean; tabs: ViewerTab[]; barExtra?: string; csp?: string; script?: string; headers?: Record<string, string>; srHeading?: boolean },
): Response {
  const name = vc.file.path.split("/").pop() ?? vc.file.path;
  const title = opts.title ?? `${name} · ${vc.live.slug}`;
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
    // unfurlHead carries the one robots meta.
    delivery: "site",
    theme: themeOf(vc.dw),
    appOrigin: instanceOf(vc).origin,
    // File path only: never copy request/capability URLs into printed context, even when embedded.
    body:
      (vc.embed ? "" : SKIP_LINK) +
      viewerBar(vc, opts.tabs, opts.barExtra) +
      (opts.print ? `<p class="dw-print-title">${escapeHtml(vc.file.path)}</p>` : "") +
      `<main id="dw-main" class="k-vbody">${opts.srHeading ?? !/<h1[\s>]/i.test(opts.body) ? `<h1 class="k-sr">${escapeHtml(name)}</h1>` : ""}${opts.body}</main>` +
      (vc.embed ? "" : `<footer class="k-hide-lg"><p class="k-trust k-vtrust">${TRUST_LINE}</p></footer>`) +
      (opts.script ? `<script>${opts.script}</script>` : ""),
  });
  const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8", ...opts.headers };
  if (opts.csp) headers["Content-Security-Policy"] = opts.csp;
  return new Response(page, { headers });
}

/** Note shown when only the first part of a large file is displayed. */
export function truncatedNote(vc: ViewerContext, shownBytes: number): string {
  return `<p class="k-banner k-notebar" role="note">Showing the first ${formatBytes(shownBytes)} of ${formatBytes(vc.file.size)}. <a href="${escapeHtml(vc.rawUrl)}" rel="nofollow">Raw</a> or <a href="${escapeHtml(vc.downloadUrl)}" rel="nofollow">download</a> the whole file.</p>`;
}

/** Decode UTF-8 (BOM stripped, invalid sequences replaced). */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
}
