export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Shared CSS for Kofra-generated pages (system pages, viewers, landing). Viewers can append their own. */
export const BASE_CSS = `
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#1d1b19;--muted:#6b665f;--line:#e6e1da;--card:#fff;--accent:#d9480f;--code:#f3f0eb}
@media (prefers-color-scheme:dark){:root{--bg:#141312;--fg:#ece8e2;--muted:#a19a90;--line:#2c2a27;--card:#1b1a18;--accent:#ff8a4c;--code:#22201d}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
a{color:var(--accent)}code,pre,kbd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em}
.dw-bar{position:sticky;top:0;z-index:5;display:flex;gap:.75rem;align-items:center;justify-content:space-between;padding:.55rem 1rem;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);font-size:.85rem}
.dw-bar .dw-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dw-bar nav{display:flex;gap:.5rem;flex-shrink:0}
.dw-bar nav a{padding:.2rem .6rem;border:1px solid var(--line);border-radius:999px;text-decoration:none;color:var(--fg)}
.dw-bar nav a:hover{border-color:var(--accent);color:var(--accent)}
.dw-system{max-width:34rem;margin:18vh auto;padding:0 1.25rem;text-align:left}
.dw-system h1{font-size:1.6rem;line-height:1.2;margin:0 0 .5rem}.dw-system p{color:var(--muted);margin:.25rem 0 1rem}
.dw-system .dw-code{display:inline-block;font:600 .8rem/1 ui-monospace,monospace;letter-spacing:.06em;color:var(--accent);margin-bottom:.75rem}
input,button{font:inherit}
`;

export function htmlPage(opts: { title: string; body: string; css?: string; head?: string; lang?: string }): string {
  return `<!doctype html><html lang="${opts.lang ?? "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.title)}</title><style>${BASE_CSS}${opts.css ?? ""}</style>${opts.head ?? ""}</head><body>${opts.body}</body></html>`;
}

/** Small system page (404, expired, password) served on site origins. `message` is trusted HTML. */
export function systemPage(opts: { code: string; title: string; message: string; extra?: string }): string {
  return htmlPage({
    title: opts.title,
    body: `<main class="dw-system"><div class="dw-code">${escapeHtml(opts.code)}</div><h1>${escapeHtml(opts.title)}</h1><p>${opts.message}</p>${opts.extra ?? ""}</main>`,
  });
}

/** CSP for pages Kofra generates on the app origin: no scripts at all. */
export const APP_PAGE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

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
