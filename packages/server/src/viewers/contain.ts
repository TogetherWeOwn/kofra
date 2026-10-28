import { DROP } from "./sanitize";

// Contains one HTML/Markdown notebook output fragment: see containOutputMarkup().

const isAlpha = (c: string | undefined): boolean => c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
const VOID = new Set(["area", "base", "br", "col", "embed", "frame", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements the sanitizer removes together with their content; markup inside them never reaches the page. */
const DROPPED = new Set([...DROP].filter((n) => !VOID.has(n)));
/** Dropped elements whose content is raw text: only their own end tag is markup. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
/** End tags stop at these when looking for the element to close ("has an element in scope"). */
const SCOPE = new Set(["table", "td", "th", "caption"]);
/** Table parts: their end tags are only blocked by an enclosing table, not by a cell. */
const TABLE_PART = new Set(["tbody", "thead", "tfoot", "tr", "td", "th", "caption", "colgroup"]);
/** Elements that make a new li/dd/dt stop looking for an open one to close (special, and not address/div/p). */
const STOPPERS = new Set([
  "article", "aside", "blockquote", "caption", "center", "dd", "details", "dl", "dt", "figcaption", "figure", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "ol", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "ul",
]);
const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"];
/** Table parts are ignored by the parser outside a table. */
const NEEDS_TABLE = new Set(["caption", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"]);
/** Start tags that close an open p. */
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "center", "details", "div", "dl", "figcaption", "figure", "footer", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "ul",
]);
/** What an open table part makes a new one of these close first, nearest first. */
const CLOSES_PARTS: Record<string, string[]> = {
  td: ["caption", "td", "th"],
  th: ["caption", "td", "th"],
  tr: ["caption", "td", "th", "tr"],
  tbody: ["caption", "td", "th", "tr", "tbody", "thead", "tfoot"],
  thead: ["caption", "td", "th", "tr", "tbody", "thead", "tfoot"],
  tfoot: ["caption", "td", "th", "tr", "tbody", "thead", "tfoot"],
  caption: ["caption", "td", "th", "tr", "tbody", "thead", "tfoot"],
};

/** Lowercased tag name starting at `from` (HTML tokenizer rule: up to whitespace, "/" or ">"). */
function tagNameAt(html: string, from: number): string {
  let j = from;
  while (j < html.length && !isSpace(html[j]!) && html[j] !== "/" && html[j] !== ">") j++;
  return html.slice(from, j).replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Index just past the ">" that ends the tag whose attributes start at `from`, honouring quoted values; -1 if unterminated. */
function tagEnd(html: string, from: number): number {
  let j = from;
  while (j < html.length) {
    const c = html[j]!;
    if (c === ">") return j + 1;
    if (isSpace(c) || c === "/") {
      j++;
      continue;
    }
    j++; // first character of an attribute name, even "="
    while (j < html.length && !isSpace(html[j]!) && !"/>=".includes(html[j]!)) j++;
    while (j < html.length && isSpace(html[j]!)) j++;
    if (html[j] !== "=") continue;
    j++;
    while (j < html.length && isSpace(html[j]!)) j++;
    const q = html[j];
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, j + 1);
      if (close < 0) return -1;
      j = close + 1;
    } else {
      while (j < html.length && !isSpace(html[j]!) && html[j] !== ">") j++;
    }
  }
  return -1;
}

/** `html.indexOf(needle, from)` for scan positions that only move forward: a hit stays valid, a miss is final. */
class Ahead {
  private at = -2;
  constructor(
    private readonly html: string,
    private readonly needle: string,
  ) {}
  find(from: number): number {
    if (this.at === -1 || this.at >= from) return this.at;
    return (this.at = this.html.indexOf(this.needle, from));
  }
}

/** Index just past a comment or bogus comment opening at `i` (they end at "-->", "--!>" or ">"). */
function commentEnd(html: string, i: number, close: Ahead, bang: Ahead): number {
  if (html.startsWith("<!--", i)) {
    const j = i + 4;
    if (html.startsWith(">", j)) return j + 1;
    if (html.startsWith("->", j)) return j + 2;
    const a = close.find(j);
    const b = bang.find(j);
    if (a < 0 && b < 0) return html.length;
    return b < 0 || (a >= 0 && a < b) ? a + 3 : b + 4;
  }
  const gt = html.indexOf(">", i);
  return gt < 0 ? html.length : gt + 1;
}

const esc = "&lt;";

/**
 * The open elements of one output fragment, as the HTML tree builder would
 * see them. End tags only ever close an element this fragment opened (in
 * scope, like a browser), so nothing in the fragment can pop the generated
 * fold or its wrappers. Every operation is amortised constant time.
 */
class Open {
  private readonly names: string[] = [];
  private readonly at = new Map<string, number[]>();
  private readonly scopes: number[] = [];
  private readonly stops: number[] = [];

  private near(name: string): number {
    const a = this.at.get(name);
    return a && a.length ? a[a.length - 1]! : -1;
  }

  /** Pop element `k` and everything above it; returns their end tags, innermost first. */
  private popTo(k: number): string {
    let tags = "";
    while (this.names.length > k) {
      const idx = this.names.length - 1;
      const name = this.names.pop()!;
      tags += `</${name}>`;
      this.at.get(name)!.pop();
      if (this.scopes[this.scopes.length - 1] === idx) this.scopes.pop();
      if (this.stops[this.stops.length - 1] === idx) this.stops.pop();
    }
    return tags;
  }

  /** True if a start tag for `name` is ignored by the parser right now (a table part outside a table). */
  ignores(name: string): boolean {
    return NEEDS_TABLE.has(name) && this.near("table") < 0;
  }

  /**
   * End tags for the element `name` closes and everything open above it (innermost first, the element's own last),
   * or null if no such element is in scope. Any heading end tag closes the nearest open heading.
   */
  close(name: string): string | null {
    const k = HEADINGS.includes(name) ? Math.max(...HEADINGS.map((h) => this.near(h))) : this.near(name);
    if (k < 0) return null;
    let floor = this.scopes.length ? this.scopes[this.scopes.length - 1]! : -1;
    if (name === "table") floor = -1;
    else if (TABLE_PART.has(name)) floor = this.near("table");
    return k < floor ? null : this.popTo(k);
  }

  /** Open `name`; returns the end tags of what its start tag closes implicitly, which the output spells out so it stays well nested. */
  open(name: string): string {
    let implied = "";
    if (CLOSES_P.has(name)) {
      const k = this.near("p");
      if (k > (this.scopes.length ? this.scopes[this.scopes.length - 1]! : -1)) implied += this.popTo(k);
    }
    if (HEADINGS.includes(name) && HEADINGS.includes(this.names[this.names.length - 1]!)) implied += this.popTo(this.names.length - 1);
    const parts = CLOSES_PARTS[name];
    if (parts) {
      const t = this.near("table");
      const ks = parts.map((n) => this.near(n)).filter((k) => k > t);
      if (ks.length) implied += this.popTo(Math.min(...ks));
    } else if (name === "li" || name === "dd" || name === "dt") {
      const k = name === "li" ? this.near("li") : Math.max(this.near("dd"), this.near("dt"));
      if (k >= 0 && (!this.stops.length || this.stops[this.stops.length - 1]! <= k)) implied += this.popTo(k);
    } else if (name === "table") {
      const t = this.near("table");
      if (t >= 0 && this.scopes.length && this.scopes[this.scopes.length - 1] === t) implied += this.popTo(t);
    }
    const idx = this.names.length;
    this.names.push(name);
    const a = this.at.get(name);
    if (a) a.push(idx);
    else this.at.set(name, [idx]);
    if (SCOPE.has(name)) this.scopes.push(idx);
    if (STOPPERS.has(name)) this.stops.push(idx);
    return implied;
  }

  /** End tags that close everything still open, innermost first. */
  closers(): string {
    let s = "";
    for (let k = this.names.length - 1; k >= 0; k--) s += `</${this.names[k]}>`;
    return s;
  }
}

/**
 * Keep an HTML/Markdown notebook output fragment inside the generated
 * per-cell fold. The outer sanitizer keeps details, summary, div and main
 * (the fold and its wrappers) and passes unmatched end tags through, so a
 * stray end tag in an output could close an ancestor and leave later outputs
 * outside the fold, and an unclosed table or list would swallow what follows.
 *
 * This makes the fragment self-contained and well nested: details/summary
 * tags and every end tag that closes nothing the fragment opened become
 * text, end tags close only elements in browser scope (a misnested `</b>`
 * spells out the end tags of what it closes), what a start tag closes
 * implicitly (p, li/dd/dt, headings, table parts) is spelled out, and
 * whatever the fragment leaves open is closed. Content the sanitizer drops
 * (script, svg, template, comments...) gets every end tag escaped and is
 * closed, so a hidden tag is never matched against a live one and an unclosed
 * one cannot swallow the rest of the notebook. One linear character scan, no
 * tag-strip regex.
 */
export function containOutputMarkup(html: string): string {
  const out: string[] = [];
  const open = new Open();
  const close = new Ahead(html, "-->");
  const bang = new Ahead(html, "--!>");
  // Dropped elements we are inside, outermost first; `depth` counts nested tags of the same name.
  const regions: Array<{ name: string; depth: number }> = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    i = lt;
    const region = regions.length ? regions[regions.length - 1]!.name : "";
    if (RAW_TEXT.has(region)) {
      // Raw text: only the matching end tag is markup; everything before it is inert text.
      let term = -1;
      for (let p = html.indexOf("</", i); p >= 0; p = html.indexOf("</", p + 2)) {
        if (tagNameAt(html, p + 2) === region) {
          term = p;
          break;
        }
      }
      const end = term < 0 ? -1 : tagEnd(html, term + 2 + region.length);
      const stop = end < 0 ? html.length : term;
      out.push(html.slice(i, stop).split("<").join(esc));
      if (end >= 0) out.push(html.slice(term, end));
      i = end < 0 ? html.length : end;
      if (end >= 0) regions.pop(); // unterminated: closed below, or the sanitizer would drop the rest of the notebook
      continue;
    }
    const c1 = html[i + 1];
    const closing = c1 === "/";
    if (c1 === "!" || c1 === "?" || (closing && !isAlpha(html[i + 2]))) {
      const end = commentEnd(html, i, close, bang);
      out.push("<" + html.slice(i + 1, end).split("<").join(esc));
      i = end;
      continue;
    }
    if (!isAlpha(c1) && !(closing && isAlpha(html[i + 2]))) {
      out.push("<");
      i++;
      continue;
    }
    const nameStart = i + (closing ? 2 : 1);
    const name = tagNameAt(html, nameStart);
    const end = tagEnd(html, nameStart + name.length);
    if (end < 0) {
      // An unterminated tag swallows the rest of the input; none of it may become markup.
      out.push(html.slice(i).split("<").join(esc));
      break;
    }
    // Fold tags and end tags that close nothing this fragment opened become text.
    let literal = name === "details" || name === "summary" || name === "plaintext";
    if (!literal && region) {
      const top = regions[regions.length - 1]!;
      const foreign = region === "svg" || region === "math";
      if (foreign && name !== region) {
        // Everything inside a dropped svg/math is text to us: HTML integration points (title, desc, foreignObject, mi...)
        // would otherwise open raw-text elements that the sanitizer's own tokenizer reads differently.
        literal = true;
      } else if (!foreign && !closing && RAW_TEXT.has(name) && name !== region) {
        regions.push({ name, depth: 1 }); // raw text inside a dropped element: its content is not markup
      } else {
        if (name === region && !(foreign && !closing && html[end - 2] === "/")) top.depth += closing ? -1 : 1;
        if (closing && !(name === region && top.depth === 0)) literal = true;
        if (top.depth === 0) regions.pop();
      }
    } else if (!literal && closing) {
      // A stray </p> only makes an empty paragraph, so it may stay; the implied end tags keep the output well nested.
      if (!VOID.has(name)) {
        const closed = open.close(name);
        if (closed !== null) {
          out.push(closed); // spelled out, so the output is well nested whatever the author wrote
          i = end;
          continue;
        }
        literal = name !== "p";
      }
    } else if (!literal) {
      if (DROPPED.has(name)) {
        // Foreign elements honour "/>"; every other dropped element stays open, whatever the sanitizer's own tokenizer thinks.
        if ((name === "svg" || name === "math") && html[end - 2] === "/") {
          out.push(html.slice(i, end));
        } else {
          out.push(html[end - 2] === "/" ? html.slice(i, end - 2) + ">" : html.slice(i, end));
          regions.push({ name, depth: 1 });
        }
        i = end;
        continue;
      } else if (!VOID.has(name) && !open.ignores(name)) {
        out.push(open.open(name));
      }
    }
    if (literal) {
      // Escape the entire scanned token; rescanning its attributes can be quadratic.
      out.push(html.slice(i, end).split("<").join(esc));
      i = end;
    } else {
      out.push(html.slice(i, end));
      i = end;
    }
  }
  let tail = "";
  for (let k = regions.length - 1; k >= 0; k--) tail += `</${regions[k]!.name}>`.repeat(regions[k]!.depth);
  return out.join("") + tail + open.closers();
}
