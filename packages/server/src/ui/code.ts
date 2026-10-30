import { escapeHtml as e } from "../escape";

/**
 * Inline code (DESIGN.md section 7, Code), for app pages and site-origin pages alike: both stylesheets carry
 * `code.k-tok` and `code.k-brk span` (00-base.css).
 */

/** Inline code that never breaks inside itself: a query, a scope, a secret's name (short tokens). */
export const tok = (t: string) => `<code class="k-tok">${e(t)}</code>`;

/** Inline code shorter than this never wraps (a short URL or command moves to the next line whole). */
export const SHORT_CODE = 40;

/**
 * Characters of inline code the narrowest line holds (a 320 px phone: Martian Mono at .86em is about 9.6 px a
 * character). A name or a URL part longer than this may break inside itself, so it never runs off the screen.
 */
export const LINE_CODE = 24;

/**
 * A name (a site's slug) as inline code. One that fits the narrowest line is `code.k-tok`: it moves to the next
 * line whole and never breaks at its hyphens ("merry-" / "quartz-rf3bew"). A longer one is plain code, which
 * wraps only because it is longer than the line.
 */
export function nameCode(t: string): string {
  return t.length <= LINE_CODE ? tok(t) : `<code>${e(t)}</code>`;
}

/**
 * A URL or command as inline code. Short ones (under SHORT_CODE characters) never break; longer ones may wrap only
 * after "/", before "." and at spaces (<wbr>), never inside a name such as "kofra-sites", and never after a "?". A
 * part longer than LINE_CODE is the exception: it may break inside itself rather than run off a phone screen.
 */
export function urlCode(t: string): string {
  if (t.length < SHORT_CODE) return tok(t);
  const html = t
    .split(/(\s+)/)
    .map((word) => {
      if (!word || /^\s+$/.test(word)) return word;
      const segs: string[] = [];
      let from = 0;
      for (let i = 1; i < word.length; i++) {
        if (word[i - 1] === "/" ? word[i] !== "/" : word[i] === "." && word[i - 1] !== ".") {
          segs.push(word.slice(from, i));
          from = i;
        }
      }
      segs.push(word.slice(from));
      return segs.map((s) => (s.length > LINE_CODE ? e(s) : `<span>${e(s)}</span>`)).join("<wbr>");
    })
    .join("");
  return `<code class="k-brk">${html}</code>`;
}
