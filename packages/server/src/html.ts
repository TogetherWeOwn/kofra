import { appOrigin, type DropwayContext } from "@dropway/core";
import { escapeHtml } from "./escape";
import { SKIP_LINK, siteFooter, siteHeader } from "./ui/chrome";
import { renderDocument } from "./ui/document";
import { themeOf, type ThemePref } from "./ui/theme";

export { escapeHtml } from "./escape";

/**
 * @deprecated The design CSS now comes from packages/server/design (ui/design.generated.ts): use
 * renderDocument() or htmlPage(), which add it. Kept so embedding apps that imported it still compile;
 * it is the site bundle (tokens, base and the components site pages use).
 */
export { SITE_CSS as BASE_CSS } from "./ui/design.generated";

/**
 * A complete HTML page in the Security Print design (ui/document.ts). `delivery` picks how the design
 * CSS arrives: "site" (default) inlines the site bundle, so the page is self-contained on any origin;
 * "app" links the cached app stylesheet (app origin only). `css` is page-only CSS.
 */
export function htmlPage(opts: {
  title: string;
  body: string;
  css?: string;
  head?: string;
  lang?: string;
  delivery?: "app" | "site";
  theme?: ThemePref;
  /** Where site pages load the fonts from (the app origin). Omitted: system fonts. */
  appOrigin?: string;
  bodyAttrs?: string;
  robots?: string;
}): string {
  return renderDocument({ ...opts, delivery: opts.delivery ?? "site" });
}

/** The domains line for footers: "<app host> · sites on <slug>.<domain>" (or the path form). */
export function domainsLine(dw: DropwayContext): string {
  const c = dw.config;
  const host = (o: string) => {
    try {
      return new URL(o).host;
    } catch {
      return o;
    }
  };
  const app = host(appOrigin(dw));
  if (c.sitesMode === "subdomain" && c.sitesDomain) return `${app} · sites on <site>.${c.sitesDomain}`;
  if (c.sitesOrigin) return `${app} · sites on ${host(c.sitesOrigin)}/<site>/`;
  return `${app} · sites under ${c.sitesPathPrefix}/<site>/`;
}

/**
 * A system page on a site origin (404, expired, password, 451...): the code as a mono kicker, a serif
 * heading, one line on what happened and a link on. `message` and `extra` are trusted HTML.
 * `stamp` adds a round rubber stamp, only for terminal states (Expired, 451).
 */
export function systemPage(opts: {
  code: string;
  title: string;
  message: string;
  extra?: string;
  stamp?: { text: string; grey?: boolean };
  /** "panel" for a form page (the password gate): an accent-framed panel instead of an end state. */
  variant?: "state" | "panel";
  /** The instance (for the wordmark, fonts and the colour mode). Omitted: a bare page with system fonts. */
  dw?: DropwayContext;
  theme?: ThemePref;
  /** Site-origin pages that show files carry the trust line. */
  trust?: boolean;
  /** Load the self-hosted fonts (default true; the platform error page sets false). */
  fonts?: boolean;
  /** Drawn inside the app's file viewer frame (&embed=1): no header, band or footer of its own (the app has them). */
  embed?: boolean;
}): string {
  const dw = opts.dw;
  const origin = dw ? appOrigin(dw) : undefined;
  const name = dw?.config.instanceName ?? "Kofra";
  const stamp = opts.stamp ? `<div class="k-bigstamp${opts.stamp.grey ? " k-grey" : ""}" aria-hidden="true">${escapeHtml(opts.stamp.text)}</div>` : "";
  const inner = `<p class="k-state-code">${escapeHtml(opts.code)}</p><h1>${escapeHtml(opts.title)}</h1><p>${opts.message}</p>${opts.extra ?? ""}`;
  const state =
    opts.variant === "panel"
      ? `<div class="k-panel">${inner}</div>`
      : `<div class="k-state${stamp ? "" : " k-nostamp"}">${stamp}<div>${inner}</div></div>`;
  const body = opts.embed
    ? `<div class="k-sys"><main id="dw-main">${state}</main></div>`
    : `${SKIP_LINK}<div class="k-sys">${origin ? siteHeader(name, origin) : ""}<main id="dw-main">${state}</main><div class="k-guilloche-band" aria-hidden="true"></div>${
        origin && dw ? siteFooter({ name, appOrigin: origin, domains: domainsLine(dw), trust: opts.trust }) : ""
      }</div>`;
  return htmlPage({
    title: opts.title,
    body,
    delivery: "site",
    theme: opts.theme ?? (dw ? themeOf(dw) : "auto"),
    appOrigin: opts.fonts === false ? undefined : origin,
    robots: "noindex",
  });
}

/** CSP for pages Kofra generates on the app origin with no script at all: the app stylesheet and fonts from 'self'. */
export const APP_PAGE_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** CSP for system pages on site origins (404, expired, password...): inline styles, fonts from the app origin, the data: guilloche mask. */
export function siteSystemCsp(dw: DropwayContext): string {
  return `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; font-src ${appOrigin(dw)}; img-src data:`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
