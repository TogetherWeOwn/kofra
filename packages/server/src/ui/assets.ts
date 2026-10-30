import { createQrEncoder, QR_LICENSE } from "../qr.js";
import { dropwayClient } from "./client";
import { kofraMotifs } from "./motifs";
import { SOURCE_REPO } from "../repo";

/**
 * The dashboard script, served from the Worker itself at
 * /__dropway/ui/app-<hash>.js (immutable; the hash changes with the code).
 *
 * The source is the text of dropwayClient() (given the seal generator, kofraMotifs() from
 * ./motifs.ts, and the QR encoder from ../qr.ts as its arguments), so packages stay "TypeScript
 * source, no build step" and an embedding app gets the same script without
 * extra bundler config. The bundler may wrap inner functions in __name(...)
 * (esbuild keepNames, which wrangler turns on), so a no-op __name is defined
 * around it.
 */
export const CLIENT_SCRIPT = `/*! Kofra dashboard (MIT) ${SOURCE_REPO} */
${QR_LICENSE}
(function(){"use strict";var __name=function(t){return t};(${dropwayClient.toString()})(${kofraMotifs.toString()}, ${createQrEncoder.toString()});})();
`;

/** 32-bit FNV-1a, hex: enough to bust caches when the script changes. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const CLIENT_HASH = fnv1a(CLIENT_SCRIPT);

export function clientScriptUrl(): string {
  return `/__dropway/ui/app-${CLIENT_HASH}.js`;
}

/** Response for GET /__dropway/ui/:file, or null when the name is unknown. */
export function clientScriptResponse(file: string): Response | null {
  const m = /^app-([0-9a-f]{8})\.js$/.exec(file);
  if (!m) return null;
  const current = m[1] === CLIENT_HASH;
  return new Response(CLIENT_SCRIPT, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      // An old hash still gets the current script, but must not be cached for long.
      "Cache-Control": current ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
