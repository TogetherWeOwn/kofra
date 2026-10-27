import type { Context } from "hono";
import { appOrigin, type DropwayContext } from "@dropway/core";
import type { DropwayEnv } from "../env";
import type { NavItem, UiSlots } from "../extensions";
import { BASE_CSS, escapeHtml } from "../html";
import { clientScriptUrl } from "./assets";

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
}

/**
 * Render a page inside the app frame. Embedding apps use this from their
 * uiSlots.pages handlers so their pages (billing, organisations, ...) share
 * the navigation, banner, theme and CSP of the dashboard.
 */
export async function renderAppPage(c: Context<DropwayEnv>, opts: AppPageOptions): Promise<Response> {
  const dw = c.get("dw");
  const slots = uiSlotsOf(c);
  const name = dw.config.instanceName;
  const showNav = opts.nav !== false;
  const nav = showNav
    ? navItems(slots)
        .map((n) => `<a href="${escapeHtml(n.href)}"${n.href === opts.active ? ' aria-current="page"' : ""}>${escapeHtml(n.label)}</a>`)
        .join("")
    : "";
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
  };
  const scripts = [clientScriptUrl(), ...(opts.scripts ?? [])].map((s) => `<script src="${escapeHtml(s)}" defer></script>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(opts.title === name ? name : `${opts.title} · ${name}`)}</title><style>${BASE_CSS}${APP_CSS}${opts.css ?? ""}</style>${slots.headHtml ?? ""}<script type="application/json" id="dw-boot">${jsonForScript(boot)}</script>${scripts}</head>
<body data-page="${escapeHtml(opts.page)}" class="${opts.wide ? "dw-wide" : ""}">
<a class="dw-skip" href="#dw-main">Skip to content</a>
<header class="dw-top"><a class="dw-brand" href="/">${escapeHtml(name)}</a>${showNav ? `<nav class="dw-nav" aria-label="Dashboard">${nav}</nav>` : '<span class="dw-nav"></span>'}<div class="dw-account" id="dw-account"><a class="dw-btn-link" href="${escapeHtml(slots.session?.signInPath ?? "/login")}">Sign in</a></div></header>
${banner ? `<div class="dw-banner" role="status">${banner}</div>` : ""}
<main id="dw-main" class="${opts.wide ? "dw-main-wide" : "dw-main"}">${opts.body}</main>
<div class="dw-toasts" id="dw-toasts" role="status" aria-live="polite"></div>
<noscript><div class="dw-banner">This page needs JavaScript for live data. The REST API (<a href="/openapi.json">/openapi.json</a>) works without it.</div></noscript>
</body></html>`;
  return new Response(c.req.method === "HEAD" ? null : html, { status: opts.status ?? 200, headers: appPageHeaders(dw) });
}

/** Styles for app pages (on top of BASE_CSS tokens). */
export const APP_CSS = `
:root{--ok:#1a7f37;--danger:#cf222e;--warn:#9a6700;--radius:8px;--shadow:0 1px 2px rgb(0 0 0/.06)}
@media (prefers-color-scheme:dark){:root{--ok:#3fb950;--danger:#ff7b72;--warn:#d29922}}
[hidden]{display:none!important}
body{min-height:100vh;display:flex;flex-direction:column}
.dw-skip{position:absolute;left:-999px;top:0;background:var(--accent);color:#fff;padding:.5rem .75rem;z-index:100}
.dw-skip:focus{left:.5rem;top:.5rem}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dw-top{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:1.25rem;height:3.25rem;padding:0 1.25rem;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px)}
.dw-brand{font-weight:700;letter-spacing:-.01em;color:var(--fg);text-decoration:none;white-space:nowrap}
.dw-nav{display:flex;gap:.25rem;flex:1;overflow-x:auto;scrollbar-width:none}
.dw-nav a{padding:.35rem .65rem;border-radius:6px;color:var(--muted);text-decoration:none;font-size:.9rem;white-space:nowrap}
.dw-nav a:hover{color:var(--fg);background:var(--code)}
.dw-nav a[aria-current]{color:var(--fg);font-weight:600;background:var(--code)}
.dw-account{display:flex;align-items:center;gap:.6rem;font-size:.85rem;color:var(--muted);white-space:nowrap}
.dw-account .who{max-width:14rem;overflow:hidden;text-overflow:ellipsis}
.dw-banner{padding:.6rem 1.25rem;background:color-mix(in srgb,var(--accent) 12%,var(--bg));border-bottom:1px solid var(--line);font-size:.9rem}
.dw-main{width:100%;max-width:72rem;margin:0 auto;padding:1.75rem 1.25rem 4rem;flex:1}
.dw-main-wide{flex:1;display:flex;min-height:0}
h1.dw-h1{font-size:1.5rem;line-height:1.2;letter-spacing:-.01em;margin:0}
.dw-pagehead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem 1rem;margin:0 0 1.25rem}
.dw-pagehead p{margin:.25rem 0 0;color:var(--muted);font-size:.9rem}
.dw-row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.dw-section{border:1px solid var(--line);border-radius:var(--radius);background:var(--card);margin:0 0 1.25rem;box-shadow:var(--shadow)}
.dw-section>header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem;padding:.75rem 1rem;border-bottom:1px solid var(--line)}
.dw-section>header h2{font-size:1rem;margin:0}
.dw-section>.dw-pad{padding:1rem}
.dw-muted{color:var(--muted)}.dw-small{font-size:.85rem}.dw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em}.dw-digest{overflow-wrap:anywhere;word-break:break-all}
.dw-btn,.dw-btn-link{display:inline-flex;align-items:center;justify-content:center;gap:.35rem;padding:.42rem .8rem;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--fg);font:inherit;font-size:.88rem;line-height:1.2;text-decoration:none;cursor:pointer;white-space:nowrap}
.dw-btn:hover,.dw-btn-link:hover{border-color:color-mix(in srgb,var(--accent) 60%,var(--line));color:var(--accent)}
.dw-btn[disabled]{opacity:.55;cursor:not-allowed}
.dw-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.dw-btn.primary:hover{filter:brightness(1.07);color:#fff}
.dw-btn.danger{color:var(--danger)}.dw-btn.danger:hover{border-color:var(--danger)}
.dw-btn.small{padding:.25rem .55rem;font-size:.8rem}
.dw-btn.ghost{border-color:transparent;background:transparent}
label.dw-label{display:block;font-size:.85rem;font-weight:600;margin:0 0 .3rem}
.dw-input,.dw-select,textarea.dw-input{width:100%;padding:.5rem .65rem;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);font:inherit;font-size:.92rem}
.dw-input:focus,.dw-select:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
.dw-field{margin:0 0 .9rem}.dw-help{font-size:.8rem;color:var(--muted);margin:.3rem 0 0}
.dw-check{display:flex;gap:.5rem;align-items:flex-start;font-size:.9rem;margin:.35rem 0}
.dw-check input{margin-top:.25rem}
.dw-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:0 1rem}
.dw-table{width:100%;border-collapse:collapse;font-size:.88rem}
.dw-table th{text-align:left;font-weight:600;font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;padding:.55rem 1rem;border-bottom:1px solid var(--line);white-space:nowrap}
.dw-table td{padding:.6rem 1rem;border-bottom:1px solid var(--line);vertical-align:middle}
.dw-table tr:last-child td{border-bottom:0}
.dw-table td a:not(.dw-btn){text-decoration:none}.dw-table td a:not(.dw-btn):hover{text-decoration:underline}
.dw-section>header .dw-input[type=search]{width:16rem;max-width:100%}
.dw-table .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.dw-table .act{text-align:right;white-space:nowrap}
.dw-th-sort{background:none;border:0;padding:0;font:inherit;color:inherit;text-transform:inherit;letter-spacing:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:.25rem}
.dw-th-sort:hover span:first-child{text-decoration:underline}
.dw-th-sort span[aria-hidden]{color:var(--accent)}
.dw-sort{display:inline-flex;align-items:center;gap:.5rem}
.dw-sort .dw-select{width:auto}
.dw-scroll{overflow-x:auto}
.dw-badge{display:inline-block;padding:.1rem .45rem;border-radius:999px;font-size:.72rem;font-weight:600;border:1px solid var(--line);color:var(--muted);white-space:nowrap;vertical-align:middle}
.dw-badge.live{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,transparent)}
.dw-badge.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,transparent)}
.dw-badge.accent{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,transparent)}
.dw-empty{text-align:center;padding:2.5rem 1rem;color:var(--muted)}
.dw-empty h2,.dw-empty h3{color:var(--fg);font-size:1.05rem;margin:0 0 .4rem}
.dw-error{border:1px solid color-mix(in srgb,var(--danger) 45%,transparent);background:color-mix(in srgb,var(--danger) 7%,transparent);color:var(--fg);border-radius:var(--radius);padding:.7rem .9rem;font-size:.9rem;margin:0 0 1rem}
.dw-error strong{color:var(--danger)}
.dw-callout{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:var(--radius);background:var(--card);padding:.8rem 1rem;margin:0 0 1rem;font-size:.9rem}
.dw-secret{display:flex;gap:.5rem;align-items:center;margin:.5rem 0}
.dw-secret code{flex:1;min-width:0;overflow:auto;white-space:nowrap;padding:.5rem .65rem;border-radius:7px;background:var(--code)}
.dw-skel{height:2.6rem;border-radius:6px;background:linear-gradient(90deg,var(--code),color-mix(in srgb,var(--code) 60%,var(--card)),var(--code));background-size:200% 100%;animation:dw-sk 1.2s linear infinite;margin:.5rem 1rem}
@keyframes dw-sk{to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.dw-skel{animation:none}}
.dw-toasts{position:fixed;right:1rem;bottom:1rem;display:flex;flex-direction:column;gap:.5rem;z-index:60;max-width:min(26rem,calc(100vw - 2rem))}
.dw-toast{padding:.6rem .85rem;border-radius:8px;background:var(--fg);color:var(--bg);font-size:.88rem;box-shadow:0 4px 14px rgb(0 0 0/.18)}
.dw-toast.err{background:var(--danger);color:#fff}
dialog.dw-dialog{border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);padding:0;width:min(30rem,calc(100vw - 2rem));box-shadow:0 12px 40px rgb(0 0 0/.25)}
dialog.dw-dialog::backdrop{background:rgb(0 0 0/.4)}
dialog.dw-dialog form{padding:1.1rem 1.2rem}
dialog.dw-dialog h2{font-size:1.05rem;margin:0 0 .5rem}
dialog.dw-dialog .dw-row{justify-content:flex-end;margin-top:1rem}
.dw-drop{border:2px dashed var(--line);border-radius:10px;padding:2rem 1rem;text-align:center;background:var(--bg);transition:border-color .12s,background .12s}
.dw-drop.over{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--bg))}
.dw-drop strong{display:block;font-size:1.05rem;margin-bottom:.35rem}
.dw-review{margin:.75rem 0 0;border:1px solid var(--line);border-radius:var(--radius);background:var(--card)}
.dw-review>summary{cursor:pointer;padding:.55rem .8rem;font-weight:600;font-size:.88rem;color:var(--fg)}
.dw-review>p{margin:.55rem 0 .2rem;padding:0 .8rem}
.dw-review-h{font-weight:600}
.dw-review-list{list-style:none;margin:0 0 .55rem;padding:0 .8rem;max-height:12rem;overflow:auto}
.dw-review-row{padding:.2rem 0;border-top:1px dotted var(--line);font-size:.85rem;overflow-wrap:anywhere}
.dw-review-nav{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;padding:.55rem .8rem 0}
.dw-review-nav .dw-input{width:12rem;max-width:100%}
.dw-review-nav .dw-select{width:auto;max-width:100%}
.dw-progress{height:.45rem;border-radius:99px;background:var(--code);overflow:hidden;margin:.6rem 0}
.dw-progress>span{display:block;height:100%;width:0;background:var(--accent);transition:width .15s}
.dw-url{display:inline-flex;align-items:center;gap:.35rem;max-width:100%;min-width:0}
.dw-url a{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dw-title{font-weight:600;color:var(--fg);text-decoration:none}
.dw-title:hover{color:var(--accent)}
.dw-sub{display:block;font-size:.8rem;color:var(--muted)}
.dw-kv{display:grid;grid-template-columns:minmax(8rem,max-content) 1fr;gap:.45rem 1.25rem;margin:0;font-size:.9rem}
.dw-kv dt{color:var(--muted)}.dw-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.dw-tabs{display:flex;gap:.25rem;border-bottom:1px solid var(--line);margin:0 0 .75rem}
.dw-tabs button{border:0;background:none;padding:.5rem .75rem;font:inherit;font-size:.88rem;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.dw-tabs button[aria-selected=true]{color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
pre.dw-snippet{position:relative;margin:0;background:var(--code);border-radius:8px;padding:.85rem 1rem;overflow:auto;font-size:.82rem;line-height:1.55;white-space:pre-wrap;word-break:break-all}
@media (max-width:720px){.dw-top{gap:.6rem;padding:0 .75rem}.dw-account .who{display:none}.dw-main{padding:1.25rem .85rem 3rem}.dw-table th,.dw-table td{padding:.5rem .6rem}.dw-hide-sm{display:none}}
`;
