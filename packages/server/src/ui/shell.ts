import type { Context } from "hono";
import { appOrigin, KIND_LABELS, type DropwayContext } from "@dropway/core";
import type { DropwayEnv } from "../env";
import type { NavItem, UiSlots } from "../extensions";
import { domainsLine, escapeHtml } from "../html";
import { clientScriptUrl } from "./assets";
import { accountArea, appChrome, type ChromeNavItem } from "./chrome";
import { renderDocument } from "./document";
import { THEME_COLORS } from "./design.generated";
import { nextFor, themeOf } from "./theme";
import { SOURCE_REPO } from "../repo";

/**
 * The app-origin page frame shared by the home page, the dashboard, the file
 * viewer and any page an embedding app adds through uiSlots.pages:
 * header (instance name, navigation, account), optional banner, main.
 *
 * Pages are server-rendered shells; one small first-party script
 * (/__dropway/ui/app-<hash>.js) fills in data from the public REST API with
 * the API key the person signed in with (sessionStorage; no cookies). The
 * CSP allows only that script ('self'), frames from the sites origin, and API
 * calls to this origin. User content is never rendered on this origin.
 */

const slotsByRequest = new WeakMap<Request, UiSlots>();

/** Called by createDropway for every app request so renderAppPage can find the instance's UI slots. */
export function bindUiSlots(c: Context<DropwayEnv>, slots: UiSlots) {
  slotsByRequest.set(c.req.raw, slots);
}

/** The UI slots bound to this request (empty slots outside createDropway). */
export function uiSlotsOf(c: Context<DropwayEnv>): UiSlots {
  return slotsByRequest.get(c.req.raw) ?? { navItems: [], pages: [] };
}

/** CSP source for wherever sites are served, for frame-src/img-src/connect-src. */
export function sitesCspSource(dw: DropwayContext): string {
  const c = dw.config;
  if (c.sitesMode === "subdomain" && c.sitesDomain) return `https://*.${c.sitesDomain}`;
  if (c.sitesOrigin) return c.sitesOrigin;
  return "'self'";
}

/** CSP for app pages that run the dashboard script. */
export function appScriptCsp(dw: DropwayContext): string {
  const s = sitesCspSource(dw);
  const sites = s === "'self'" ? "" : ` ${s}`;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${sites}`,
    `connect-src 'self'${sites}`,
    `frame-src 'self'${sites}`,
    "font-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

export function appPageHeaders(dw: DropwayContext): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": appScriptCsp(dw),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cache-Control": "no-cache",
    // The page carries the colour mode chosen in the theme cookie (data-theme on <html>).
    Vary: "Cookie",
  };
}

/** Core dashboard navigation. Embedding apps add items through uiSlots.navItems and uiSlots.pages (nav: true). */
export const CORE_NAV: NavItem[] = [
  { label: "Sites", href: "/dashboard", order: 10 },
  { label: "Publish", href: "/dashboard/publish", order: 20 },
  { label: "API keys", href: "/dashboard/keys", order: 30 },
  { label: "Settings", href: "/dashboard/settings", order: 90 },
];

export function navItems(slots: UiSlots): NavItem[] {
  const extra: NavItem[] = [...slots.navItems, ...slots.pages.filter((p) => p.nav).map((p) => ({ label: p.title, href: p.path, order: 100 }))];
  return [...CORE_NAV, ...extra.map((n) => ({ ...n, order: n.order ?? 100 }))].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/** JSON for a <script type="application/json"> block (never executed; "<" escaped so it cannot close the tag). */
export function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export interface AppPageOptions {
  title: string;
  /** Which client view to start ("home", "login", "sites", "site", "publish", "keys", "settings", "viewer"; anything else = none). */
  page: string;
  /** Trusted HTML for <main>. Escape anything that came from users. */
  body: string;
  /** href of the nav item to mark as current. */
  active?: string;
  /** Extra data for the client script (available as boot.page). */
  data?: Record<string, unknown>;
  css?: string;
  /** Extra first-party script URLs (same origin; the CSP allows only 'self'). */
  scripts?: string[];
  /** Full-width layout without the content column (the file viewer). */
  wide?: boolean;
  /** Show the dashboard navigation (default true). */
  nav?: boolean;
  status?: number;
  /** Full-bleed sections that bring their own .k-wrap (the home page): no content column. */
  bare?: boolean;
  /** Show the footer (default true; the full-height file viewer has none). */
  footer?: boolean;
  /** The page shows files: the footer carries the trust line. */
  trust?: boolean;
}

/**
 * @deprecated App pages link the cached stylesheet (/__dropway/ui/kofra-<hash>.css) through renderAppPage();
 * this is the same CSS as text, kept so embedding apps that imported it still compile.
 */
export { APP_CSS } from "./design.generated";

export { SOURCE_REPO };

/**
 * Footer links on core app pages (PORT-SPEC 6.0): API, llms.txt, MCP, Agent skill, Self-host. Embedding apps put
 * their own first (the hosted service adds Pricing).
 */
export const CORE_FOOTER_LINKS: ChromeNavItem[] = [
  { label: "API", href: "/openapi.json" },
  { label: "llms.txt", href: "/llms.txt" },
  { label: "MCP", href: `${SOURCE_REPO}/blob/main/docs/MCP.md` },
  { label: "Agent skill", href: "/skill.md" },
  { label: "Self-host", href: `${SOURCE_REPO}/blob/main/docs/SELF_HOST.md` },
];

/**
 * Render a page inside the app frame. Embedding apps use this from their
 * uiSlots.pages handlers so their pages (billing, organisations, ...) share
 * the navigation, banner, theme and CSP of the dashboard.
 */
export async function renderAppPage(c: Context<DropwayEnv>, opts: AppPageOptions): Promise<Response> {
  const dw = c.get("dw");
  const slots = uiSlotsOf(c);
  const name = dw.config.instanceName;
  const theme = themeOf(dw);
  const banner = slots.banner ? await Promise.resolve(slots.banner(c)).catch(() => null) : null;
  const boot = {
    v: 1,
    origin: appOrigin(dw),
    instanceName: name,
    api: "/api/v1",
    sitesMode: dw.config.sitesMode,
    anonymousPublish: dw.config.anonymous.enabled,
    session: slots.session ? { signIn: slots.session.signInPath, signOut: slots.session.signOutPath } : null,
    page: { name: opts.page, ...opts.data },
    themeColors: THEME_COLORS,
    kindLabels: KIND_LABELS,
  };
  const scripts = [clientScriptUrl(), ...(opts.scripts ?? [])].map((s) => `<script src="${escapeHtml(s)}" defer></script>`).join("");
  const body = appChrome({
    header: {
      name,
      // The dashboard script fills the tag ("<account> · <email>") and swaps "Sign in" for "Sign out".
      tagId: "dw-tag",
      nav: opts.nav === false ? [] : navItems(slots),
      active: opts.active,
      navLabel: "Dashboard",
      account: accountArea({ signIn: slots.session?.signInPath ?? "/login" }),
      accountId: "dw-account",
      theme,
      next: nextFor(c.req.url),
    },
    banner,
    main: opts.body,
    mainClass: opts.wide ? "k-main-wide" : opts.bare ? "k-bare" : "k-main",
    footer: opts.footer === false || opts.wide ? null : { name, domains: domainsLine(dw), links: [...(slots.footerLinks ?? []), ...CORE_FOOTER_LINKS], trust: opts.trust },
    after: `<div class="k-toasts" id="dw-toasts" role="status" aria-live="polite"></div><noscript><div class="k-wrap"><p class="k-banner k-warn">This page needs JavaScript for live data. The REST API (<a href="/openapi.json">/openapi.json</a>) works without it.</p></div></noscript>`,
  });
  const html = renderDocument({
    title: opts.title === name ? name : `${opts.title} · ${name}`,
    delivery: "app",
    theme,
    robots: "noindex",
    css: opts.css,
    head: `${slots.headHtml ?? ""}<script type="application/json" id="dw-boot">${jsonForScript(boot)}</script>${scripts}`,
    bodyAttrs: ` class="k-page${opts.wide ? " k-wide" : ""}" data-page="${escapeHtml(opts.page)}"`,
    body,
  });
  return new Response(c.req.method === "HEAD" ? null : html, { status: opts.status ?? 200, headers: appPageHeaders(dw) });
}

/**
 * A small no-script page on the app origin in the app frame (header with the mode switch, footer):
 * claim instructions, not found, server error. `message` and `extra` are trusted HTML. Served with
 * APP_PAGE_CSP (no script; the app stylesheet and fonts from 'self').
 */
export function appStatePage(
  dw: DropwayContext,
  url: string,
  opts: { title: string; code: string; heading: string; message: string; extra?: string; actions?: string; signIn?: string; modeSwitch?: boolean; footerLinks?: ChromeNavItem[] },
): string {
  const name = dw.config.instanceName;
  const theme = themeOf(dw);
  const main = `<div class="k-narrow"><div class="k-state k-nostamp"><div><p class="k-state-code">${escapeHtml(opts.code)}</p><h1>${escapeHtml(opts.heading)}</h1><p>${opts.message}</p>${opts.extra ?? ""}${opts.actions ? `<div class="k-acts">${opts.actions}</div>` : ""}</div></div></div>`;
  return renderDocument({
    title: opts.title === name ? name : `${opts.title} · ${name}`,
    delivery: "app",
    theme,
    robots: "noindex",
    bodyAttrs: ' class="k-page"',
    body: appChrome({
      header: { name, theme, next: nextFor(url), account: accountArea({ signIn: opts.signIn ?? "/login" }), modeSwitch: opts.modeSwitch },
      main,
      footer: { name, domains: domainsLine(dw), links: [...(opts.footerLinks ?? []), ...CORE_FOOTER_LINKS] },
    }),
  });
}
