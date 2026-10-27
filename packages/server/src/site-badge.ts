import type { LiveSite } from "@dropway/core";
import { escapeHtml } from "./html";

/**
 * Embeddable live-version badge: GET <site root>/badge.svg.
 *
 * Public data only. A badge names the live version number and a coarse age for
 * a public, unexpired, ordinary site; every other state (passworded, expired,
 * taken down, transfer, missing, renamed away, nothing live) gets one identical
 * generic image, so probing reveals nothing. Reads only the cached live
 * manifest (see getLiveSite): no extra D1, KV or R2 read, no credentials, no
 * cookies, and no analytics or usage record.
 */

const LABEL = "kofra";
const UNAVAILABLE = "not available";

/** Coarse relative age: minutes, hours or days, never an exact time. */
export function badgeAge(ageMs: number): string {
  const minutes = Math.floor(Math.max(0, ageMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Approximate advance of Verdana 11px text; the SVG pins text to the measured width with textLength. */
const textWidth = (s: string) => Math.ceil(s.length * 6.4);

/** A flat two-part badge: static markup, escaped text, no script and no references. */
export function renderBadge(message: string, description: string): string {
  const label = textWidth(LABEL) + 12;
  const value = textWidth(message) + 12;
  const total = label + value;
  const text = (x: number, s: string, width: number) =>
    `<text x="${x}" y="14" fill="#fff" text-anchor="middle" textLength="${width}" lengthAdjust="spacingAndGlyphs">${escapeHtml(s)}</text>`;
  const title = escapeHtml(`${LABEL}: ${description}`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" viewBox="0 0 ${total} 20" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<rect width="${total}" height="20" rx="3" fill="#5b6470"/>` +
    `<rect x="${label}" width="${value}" height="20" rx="3" fill="#34495e"/>` +
    `<rect x="${label}" width="6" height="20" fill="#34495e"/>` +
    `<g font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">${text(label / 2, LABEL, label - 12)}${text(label + value / 2, message, value - 12)}</g>` +
    `</svg>`
  );
}

/** What to show for a site: its live version, or null for every state that must look the same. */
export function badgeFor(live: LiveSite | null, now = Date.now()): string {
  const available =
    live &&
    !live.passwordHash &&
    !(live.expiresAt && live.expiresAt < now) &&
    live.versionId &&
    typeof live.versionNumber === "number" &&
    typeof live.versionAt === "number";
  if (!available) return renderBadge(UNAVAILABLE, UNAVAILABLE);
  const age = badgeAge(now - live.versionAt!);
  return renderBadge(`v${live.versionNumber} · ${age}`, `version ${live.versionNumber}, ${age === "just now" ? age : `updated ${age}`}`);
}

/** Same headers for every outcome, so the response never distinguishes one state from another. */
export function badgeResponse(svg: string, method: string): Response {
  return new Response(method === "HEAD" ? null : svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=300",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Access-Control-Allow-Origin": "*",
      "Referrer-Policy": "no-referrer",
      "Strict-Transport-Security": "max-age=31536000",
    },
  });
}
