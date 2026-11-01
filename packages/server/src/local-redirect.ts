/**
 * `next` as a path on `origin` under `base`, or null when following it could leave them.
 * Parsed the way a browser resolves a Location or href: "//host", "/\host", "/<tab>/host"
 * and absolute URLs all reach another origin, and "/base/../other" leaves the base.
 * After normalization "/.//host/x" becomes "//host/x", which browsers read as
 * protocol-relative, so a resolved path with a second "/" or "\" is also refused.
 * packages/server/src/ui/client.ts (safeNext) applies the same rule in the browser.
 */
export function localRedirectPath(next: string | null | undefined, origin: string, base = "/"): string | null {
  if (!next || next.charAt(0) !== "/" || /[\x00-\x1f\x7f\\]/.test(next)) return null;
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  const out = url.pathname + url.search + url.hash;
  if (out.charAt(1) === "/" || out.charAt(1) === "\\") return null;
  if (!url.pathname.startsWith(base)) return null;
  return out;
}
