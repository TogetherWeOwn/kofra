import { escapeHtml } from "../escape";
import { APP_CSS_HASH, FONT_FACE_TEMPLATE, PRELOAD_FONTS, SITE_CSS } from "./design.generated";
import { themeAttr, themeMetas, type ThemePref } from "./theme";

/**
 * The single HTML document writer for every page Kofra generates (app pages, system pages, the
 * password gate, listings, viewers). Two ways to deliver the design CSS:
 *
 * - "app"  (the app origin): one immutable stylesheet, /__dropway/ui/kofra-<hash>.css, cached across
 *          pages (CSP: style-src 'self'), plus a preload of the two text fonts.
 * - "site" (site origins): the site bundle inline, so the page is self-contained, with @font-face
 *          rules pointing at the app origin's font route (CSP: font-src <app origin>).
 *
 * The colour mode is written into <html data-theme> and the metas by the server, so there is no
 * flash of the wrong theme and no script is involved.
 */
export interface DocumentOptions {
  title: string;
  /** Trusted HTML for <body>. Escape anything that came from users. */
  body: string;
  delivery: "app" | "site";
  /** Colour mode for this response (default auto). */
  theme?: ThemePref;
  /** Origin of the app (site delivery: where the fonts come from; omitted = system fonts). */
  appOrigin?: string;
  /** Page-only CSS, inlined after the design CSS. */
  css?: string;
  /** Extra trusted HTML for <head>. */
  head?: string;
  lang?: string;
  /** Attributes for <body>, already escaped (e.g. ` class="k-page" data-page="sites"`). */
  bodyAttrs?: string;
  /** Site delivery: load the self-hosted fonts (default true when appOrigin is given). */
  fonts?: boolean;
  /** <meta name="robots"> content (e.g. "noindex"). */
  robots?: string;
}

/** URL of the app stylesheet (immutable; the hash changes with the CSS). */
export function appStylesheetUrl(): string {
  return `/__dropway/ui/kofra-${APP_CSS_HASH}.css`;
}

/** @font-face rules for the self-hosted fonts, served from `origin` ("" = this origin). */
export function fontFaceCss(origin: string): string {
  let base = origin;
  while (base.endsWith("/")) base = base.slice(0, -1);
  return FONT_FACE_TEMPLATE.split("__FONT_BASE__").join(base);
}

/** Preload links for the two fonts every app page uses first (Public Sans and Newsreader, Latin). */
export function fontPreloads(): string {
  return PRELOAD_FONTS.map((href) => `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin>`).join("");
}

export function renderDocument(opts: DocumentOptions): string {
  const theme = opts.theme ?? "auto";
  const head = [
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    themeMetas(theme),
    opts.robots ? `<meta name="robots" content="${escapeHtml(opts.robots)}">` : "",
    `<title>${escapeHtml(opts.title)}</title>`,
  ];
  if (opts.delivery === "app") {
    head.push(fontPreloads(), `<link rel="stylesheet" href="${appStylesheetUrl()}">`);
    if (opts.css) head.push(`<style>${opts.css}</style>`);
  } else {
    const fonts = opts.fonts !== false && opts.appOrigin ? fontFaceCss(opts.appOrigin) : "";
    head.push(`<style>${fonts}${SITE_CSS}${opts.css ?? ""}</style>`);
  }
  if (opts.head) head.push(opts.head);
  return `<!doctype html><html lang="${escapeHtml(opts.lang ?? "en")}"${themeAttr(theme)}><head>${head.join("")}</head><body${opts.bodyAttrs ?? ""}>${opts.body}</body></html>`;
}
