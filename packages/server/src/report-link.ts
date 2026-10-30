import { escapeHtml } from "./escape";

// Injected into user pages, where none of Kofra's CSS exists and the page's own CSP applies: the Security
// Print light values are written as literals here (the one allowed exception, E1). Text 11.74:1, border 3.87:1.

/** Part of transformed HTML ETags; bump when the injected markup changes. */
export const REPORT_LINK_VERSION = 2;

/** The destination is absolute: publishers can supply an untrusted <base>. */
export function injectReportLink(response: Response, destination: string): Response {
  const link = `<a href="${escapeHtml(destination)}" target="_blank" rel="noopener noreferrer" style="position:fixed;bottom:12px;right:12px;z-index:2147483647;padding:6px 10px;border:1px solid #847D69;border-radius:3px;background:#FBF8F0;color:#0F3B2E;font:500 12px/1.4 system-ui,sans-serif;text-decoration:underline;text-underline-offset:3px">Report abuse</a>`;
  // Document-end also runs for fragments without an explicit <body>.
  return new HTMLRewriter().onDocument({ end(end) { end.append(link, { html: true }); } }).transform(response);
}
