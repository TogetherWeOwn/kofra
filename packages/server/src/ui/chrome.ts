import { escapeHtml } from "../escape";
import { THEME_PATH, type ThemePref } from "./theme";

/**
 * The page chrome shared by every app-origin page, in the core and in embedding apps (one header,
 * one footer): skip link, header (wordmark, tag, navigation, account area, colour mode switch),
 * footer (wordmark, domains, links, the trust line on pages that show files). Site-origin pages get
 * a minimal header (a small wordmark linking to the app) and a footer.
 */
const e = escapeHtml;

const ICONS: Record<ThemePref, string> = {
  auto: '<circle cx="8" cy="8" r="6.25"/><path d="M8 1.75v12.5a6.25 6.25 0 0 0 0-12.5z" fill="currentColor" stroke="none"/>',
  light: '<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4"/>',
  dark: '<path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z"/>',
};
const LABELS: Record<ThemePref, [string, string]> = {
  auto: ["Auto", "Follow your device setting"],
  light: ["Light", "Always light"],
  dark: ["Dark", "Always dark"],
};

/** The trust line, verbatim (DESIGN.md section 10). Kofra never claims a file is safe. */
export const TRUST_LINE = "Kofra does not scan files; open files only from people you trust.";

/** id of the switch form. */
export const MODE_SWITCH_ID = "dw-mode";

/**
 * id of the empty marker just before a button of the switch: the no-script switch returns to `next#dw-mode-<choice>`,
 * so the next Tab lands on the button that was pressed (a fragment on the button itself would move the next Tab past it).
 */
export const modeMarkerId = (v: ThemePref) => `${MODE_SWITCH_ID}-${v}`;

/**
 * Auto / Light / Dark as submit buttons posting to /__dropway/theme: works on pages with no script at
 * all. Where the dashboard script runs it switches in place, without a reload. `next` is the current
 * path and query (escaped here).
 */
export function modeSwitch(pref: ThemePref, next: string): string {
  const buttons = (["auto", "light", "dark"] as const)
    .map((v) => {
      const [label, title] = LABELS[v];
      return `<span id="${modeMarkerId(v)}"></span><button type="submit" name="theme" value="${v}" aria-pressed="${pref === v}" title="${title}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">${ICONS[v]}</svg><span data-label="${label}">${label}</span></button>`;
    })
    .join("");
  return `<form class="k-mode-switch" id="${MODE_SWITCH_ID}" method="post" action="${THEME_PATH}"><input type="hidden" name="next" value="${e(next)}"><div role="group" aria-label="Colour theme">${buttons}</div></form>`;
}

export interface ChromeNavItem {
  label: string;
  href: string;
}

export interface AccountAreaOptions {
  /** Signed in (pages with no script): Sign out posts to `signOut`. The person shows in the header tag (identityTag). */
  user?: { signOut: string } | null;
  /** Where "Sign in" goes (default /login). */
  signIn?: string;
  /** A filled call to action beside "Sign in" for people who are not signed in, e.g. "Start free" (hidden under 720px). */
  start?: ChromeNavItem | null;
}

/**
 * The header's account area, one markup for every app page (the core dashboard fills the same markup with its
 * script): "Sign in" as a quiet button (plus an optional filled call to action), or "Sign out".
 */
export function accountArea(o: AccountAreaOptions = {}): string {
  if (o.user) return `<form method="post" action="${e(o.user.signOut)}"><button class="k-btn k-sm k-quiet" type="submit">Sign out</button></form>`;
  return `<a class="k-btn k-sm k-quiet" href="${e(o.signIn ?? "/login")}">Sign in</a>${o.start ? `<a class="k-btn k-sm k-hide-sm" href="${e(o.start.href)}">${e(o.start.label)}</a>` : ""}`;
}

/** The tag beside the wordmark when someone is signed in: "<account> · <email>" (plain text, as typed; hidden under 720px). */
export function identityTag(account: string | null | undefined, email: string | null | undefined): string {
  const parts = [account, email].map((x) => (x ?? "").trim()).filter(Boolean);
  // A personal account is often named after the email: say it once.
  return (parts.length === 2 && parts[0]!.toLowerCase() === parts[1]!.toLowerCase() ? [parts[1]!] : parts).join(" · ");
}

export interface AppHeaderOptions {
  /** The instance name (shown as the wordmark; styled lowercase by CSS, the text keeps its case). */
  name: string;
  /** Where the wordmark links (default "/"). */
  home?: string;
  /** Small mono line after the wordmark, e.g. "Account · email" (plain text; identityTag). */
  tag?: string;
  /** id for the tag, so the dashboard script can fill it in once it knows who is signed in. */
  tagId?: string;
  nav?: ChromeNavItem[];
  /** href of the current nav item (aria-current="page"). */
  active?: string;
  /** Trusted HTML for the account area (sign-in link, or the person and a sign-out form). */
  account?: string;
  /** id for the account area (the dashboard script fills "dw-account"). */
  accountId?: string;
  theme: ThemePref;
  /** Current path and query, for the switch's return address. */
  next: string;
  /** Show the mode switch (default true; pages whose CSP blocks form posts set false). */
  modeSwitch?: boolean;
  navLabel?: string;
}

/**
 * The header in reading order: the wordmark, the tag, the account area, the mode switch, then the navigation. Under
 * 1000px that is the screen order too (the navigation is the row under the others), so keyboard focus moves left to
 * right, then down, never back up the screen. From 1000px the header is one row, with the navigation before the
 * account area on screen (10-top.css). Pages with no switch get `k-noswitch`, so the account area ends flush with
 * the content edge.
 */
export function appHeader(o: AppHeaderOptions): string {
  const nav = o.nav?.length
    ? `<nav class="k-nav" aria-label="${e(o.navLabel ?? "Main")}">${o.nav
        .map((n) => `<a href="${e(n.href)}"${n.href === o.active ? ' aria-current="page"' : ""}>${e(n.label)}</a>`)
        .join("")}</nav>`
    : "";
  return `<header class="k-top${o.modeSwitch === false ? " k-noswitch" : ""}"><div class="k-wrap"><a class="k-wm" href="${e(o.home ?? "/")}">${e(o.name)}</a>${o.tag || o.tagId ? `<span class="k-tag"${o.tagId ? ` id="${e(o.tagId)}"` : ""}>${e(o.tag ?? "")}</span>` : ""}<div class="k-acct"${o.accountId ? ` id="${e(o.accountId)}"` : ""}>${o.account ?? ""}</div>${o.modeSwitch === false ? "" : modeSwitch(o.theme, o.next)}${nav}</div></header>`;
}

export interface AppFooterOptions {
  name: string;
  home?: string;
  /** Plain-text domains line, e.g. "kofra.app · sites on <slug>.kofra.io". */
  domains?: string;
  links?: ChromeNavItem[];
  /** Show the trust line (every page that shows files). */
  trust?: boolean;
}

/**
 * The footer's domains line ("kofra.app · sites on <slug>.kofra.io") in two parts. Under 720px each part has a line of
 * its own (11-foot.css), so the footer's height never depends on which font has loaded (no shift when the fonts
 * arrive); wider, they read as one line with the separator.
 */
function domainsHtml(domains: string): string {
  const at = domains.indexOf(" · ");
  if (at < 0) return `<span class="k-dom"><span>${e(domains)}</span></span>`;
  return `<span class="k-dom"><span>${e(domains.slice(0, at))}</span><span class="k-dom-sep" aria-hidden="true"> · </span><span>${e(domains.slice(at + 3))}</span></span>`;
}

export function appFooter(o: AppFooterOptions): string {
  const links = (o.links ?? []).map((l) => `<a href="${e(l.href)}">${e(l.label)}</a>`).join("");
  return `<footer class="k-foot"><div class="k-wrap"><a class="k-wm" href="${e(o.home ?? "/")}">${e(o.name)}</a>${o.domains ? domainsHtml(o.domains) : ""}${links ? `<nav class="k-end" aria-label="Footer">${links}</nav>` : ""}${o.trust ? `<p class="k-trust">${TRUST_LINE}</p>` : ""}</div></footer>`;
}

export const SKIP_LINK = '<a class="k-skip dw-skip" href="#dw-main">Skip to content</a>';

export interface AppChromeOptions {
  header: AppHeaderOptions;
  footer?: AppFooterOptions | null;
  /** Trusted HTML shown in a strip under the header (uiSlots.banner). */
  banner?: string | null;
  /** Trusted HTML for <main>. */
  main: string;
  mainClass?: string;
  /** Trusted HTML after the footer (toasts, noscript). */
  after?: string;
}

/**
 * Skip link + header + optional banner + <main id="dw-main"> + footer: the body of an app page. Every page
 * with a footer draws the guilloche band right above it (PORT-SPEC 5), so the footer is the same everywhere;
 * pages with a hero draw one more under it (at most two per page).
 */
export function appChrome(o: AppChromeOptions): string {
  return `${SKIP_LINK}${appHeader(o.header)}${o.banner ? `<div class="k-slotbanner" role="status"><div class="k-wrap">${o.banner}</div></div>` : ""}<main id="dw-main" class="${e(o.mainClass ?? "k-main")}">${o.main}</main>${o.footer ? `${GUILLOCHE_BAND}${appFooter(o.footer)}` : ""}${o.after ?? ""}`;
}

/** The guilloche band (a CSS mask, recoloured by the mode): under a hero and above every app footer. */
export const GUILLOCHE_BAND = '<div class="k-guilloche-band" aria-hidden="true"></div>';

/** Minimal header for site-origin pages: a small wordmark that links to the app; `extra` (a listing's path, summary and sort) sits under the bar inside the same header. */
export function siteHeader(name: string, appOrigin: string, extra = ""): string {
  return `<header class="k-sitehead${extra ? " k-sitehead-x" : ""}"><div class="k-wrap"><a class="k-wm" href="${e(appOrigin)}" rel="nofollow">${e(name)}</a></div>${extra}</header>`;
}

/** Footer for site-origin pages: domains line, plus the trust line on pages that show files. */
export function siteFooter(o: { name: string; appOrigin: string; domains?: string; trust?: boolean }): string {
  return `<footer class="k-foot k-sitefoot"><div class="k-wrap"><a class="k-wm" href="${e(o.appOrigin)}" rel="nofollow">${e(o.name)}</a>${o.domains ? domainsHtml(o.domains) : ""}${o.trust ? `<p class="k-trust">${TRUST_LINE}</p>` : ""}</div></footer>`;
}
