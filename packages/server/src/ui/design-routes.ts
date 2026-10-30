import { APP_CSS, APP_CSS_HASH, ART } from "./design.generated";
import { FONT_FILES, FONT_LICENCES } from "./fonts.generated";
import { plate } from "./motifs";

/**
 * Design assets on the app origin, all from the Worker itself (no Static Assets binding, so the core,
 * embedding apps and tests behave the same):
 *   /__dropway/ui/kofra-<hash>.css           the app stylesheet
 *   /__dropway/ui/art/<name>.<hash>.svg      plate art, one file per colour mode
 *   /__dropway/fonts/<name>.<hash>.woff2     self-hosted fonts (SIL OFL 1.1), CORS-readable for site origins
 *   /__dropway/fonts/OFL.txt                 the font licences
 * The current hash is cached for a year (immutable). A known name with an unknown hash still gets the
 * current file, uncached, so a page from an older deploy never loses its styles or fonts.
 */
const IMMUTABLE = "public, max-age=31536000, immutable";

export function designCssResponse(file: string): Response | null {
  const m = /^kofra-([0-9a-f]{8})\.css$/.exec(file);
  if (!m) return null;
  return new Response(APP_CSS, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": m[1] === APP_CSS_HASH ? IMMUTABLE : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

const artCache = new Map<string, string>();

export function artResponse(file: string): Response | null {
  const m = /^([a-z0-9-]+)\.([0-9a-f]{8})\.svg$/.exec(file);
  // Own keys only: a name like "constructor" must not reach Object.prototype.
  const art = m && Object.hasOwn(ART, m[1]!) ? ART[m[1]!] : undefined;
  if (!m || !art) return null;
  let svg = artCache.get(m[1]!);
  if (svg === undefined) {
    svg = plate(art.seed, { lite: art.lite, label: "KOFRA", style: art.style });
    artCache.set(m[1]!, svg);
  }
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": m[2] === art.hash ? IMMUTABLE : "no-cache",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

const fontCache = new Map<string, Uint8Array>();

function fontBytes(name: string): Uint8Array | null {
  if (!Object.hasOwn(FONT_FILES, name)) return null;
  const f = FONT_FILES[name]!;
  let b = fontCache.get(name);
  if (!b) {
    const bin = atob(f.b64);
    b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    fontCache.set(name, b);
  }
  return b;
}

/** Site origins (and sandboxed, opaque-origin pages) load these cross-origin: font fetches always use CORS. */
const FONT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
};

export function fontResponse(file: string): Response | null {
  if (file === "OFL.txt") {
    return new Response(FONT_LICENCES, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400", ...FONT_HEADERS } });
  }
  const m = /^([a-z0-9-]+)\.([0-9a-f]{8})\.woff2$/.exec(file);
  const bytes = m ? fontBytes(m[1]!) : null;
  if (!m || !bytes) return null;
  // A copy per response: a body may take ownership of (detach) the buffer it is given.
  return new Response(bytes.slice(), {
    headers: { "Content-Type": "font/woff2", "Cache-Control": m[2] === FONT_FILES[m[1]!]!.hash ? IMMUTABLE : "no-cache", ...FONT_HEADERS },
  });
}
