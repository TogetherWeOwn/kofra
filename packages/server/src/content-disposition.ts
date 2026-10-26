/**
 * The one place download filenames become a Content-Disposition header.
 *
 * Header values must be ByteStrings: raw non-ASCII names either throw
 * (characters above U+00FF, in ByteString-converting runtimes) or arrive
 * mojibake (Latin-1). Legal published paths may contain any non-control
 * characters, so emit an ASCII-only fallback plus the RFC 5987 extended
 * parameter carrying the real UTF-8 name:
 *
 *   attachment; filename="caf_.txt"; filename*=UTF-8''caf%C3%A9.txt
 *
 * The fallback replaces every character outside printable ASCII — and the
 * quoted-string breakers `"` and `\` — with `_`, one per UTF-16 code unit
 * (an astral character becomes `__`). That removes CR, LF and control
 * characters too, so header injection is impossible. The extended value
 * percent-encodes everything except RFC 5987 attr-chars (`encodeURIComponent`
 * leaves `!'()*~` alone, so `'` `(` `)` `*` are escaped explicitly), which
 * also neutralizes `"`, `\`, `;` and `=` there.
 *
 * Pure printable-ASCII names keep the single-parameter form byte-identical
 * to the historical header (cache/test stability), unless `alwaysExtended`
 * is set — transfer downloads have always sent `filename*`, even for ASCII
 * names, and keep doing so.
 */
export function attachmentDisposition(filename: string, options?: { alwaysExtended?: boolean }): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  if (!options?.alwaysExtended && /^[\x20-\x7e]*$/.test(filename)) {
    return `attachment; filename="${fallback}"`;
  }
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (s) => `%${s.charCodeAt(0).toString(16)}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
