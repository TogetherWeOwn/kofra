/**
 * Allowlist HTML sanitizer for user-authored markup that Kofra renders
 * itself (raw HTML inside Markdown, notebook outputs). Built on HTMLRewriter,
 * the streaming HTML parser built into Workers, so it costs no bundle size.
 *
 * Viewer pages also carry a no-script CSP; this is the second layer. It drops
 * scripts, styles, frames, forms and form controls, <base>, <meta>, <link>,
 * SVG and MathML (with their content), every event handler and style
 * attribute, and any URL that is not http(s), mailto, tel, relative or a
 * fragment (data: is allowed for images only).
 */

/** Removed together with everything inside them. */
export const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "noembed", "noframes", "template",
  "base", "meta", "link", "title", "head", "svg", "math", "textarea", "select", "option", "optgroup", "button", "datalist",
  "canvas", "portal", "dialog", "xmp", "plaintext", "param", "slot", "frameset", "output", "progress", "meter", "map", "area",
]);

/** Kept (with filtered attributes). Anything else is unwrapped: the tag goes, its content stays. */
const KEEP = new Set([
  "a", "abbr", "address", "article", "aside", "audio", "b", "bdi", "bdo", "blockquote", "br", "caption", "center", "cite", "code",
  "col", "colgroup", "data", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "input", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "picture",
  "pre", "q", "rp", "rt", "ruby", "s", "samp", "section", "small", "source", "span", "strike", "strong", "sub", "summary", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "track", "tt", "u", "ul", "var", "video", "wbr",
]);

const GLOBAL_ATTRS = new Set(["id", "class", "title", "lang", "dir", "align", "valign", "hidden", "translate", "aria-label", "aria-hidden"]);

const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "name", "rel", "hreflang"]),
  img: new Set(["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding"]),
  source: new Set(["src", "srcset", "sizes", "type", "media", "width", "height"]),
  video: new Set(["src", "poster", "controls", "loop", "muted", "playsinline", "preload", "width", "height"]),
  audio: new Set(["src", "controls", "loop", "muted", "preload"]),
  track: new Set(["src", "kind", "srclang", "label", "default"]),
  ol: new Set(["start", "reversed", "type"]),
  li: new Set(["value"]),
  td: new Set(["colspan", "rowspan", "headers", "width"]),
  th: new Set(["colspan", "rowspan", "headers", "scope", "abbr", "width"]),
  col: new Set(["span", "width"]),
  colgroup: new Set(["span"]),
  details: new Set(["open"]),
  pre: new Set(["data-lang"]),
  input: new Set(["type", "checked", "disabled"]),
  time: new Set(["datetime"]),
  data: new Set(["value"]),
  del: new Set(["cite", "datetime"]),
  ins: new Set(["cite", "datetime"]),
  q: new Set(["cite"]),
  blockquote: new Set(["cite"]),
};

const URL_ATTRS = new Set(["href", "src", "poster", "cite"]);

const NAMED: Record<string, string> = { colon: ":", tab: "\t", newline: "\n", nbsp: " ", amp: "&", period: ".", sol: "/", lpar: "(", rpar: ")", quot: '"', apos: "'" };

function codePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "�";
  }
}

/** Decode the character references that could hide a scheme ("&#106;avascript:", "javascript&colon;"). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d: string) => codePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED[n.toLowerCase()] ?? m);
}

/** Is `value` a URL we let through for `attr` on `tag`? */
export function isSafeUrl(value: string, tag: string, attr: string): boolean {
  // Browsers ignore ASCII whitespace and control characters inside schemes ("java\tscript:").
  // eslint-disable-next-line no-control-regex
  const v = decodeEntities(value).replace(/[\u0000- \u007f]+/g, "").toLowerCase();
  if (v === "") return true;
  const head = v.split(/[/?#]/)[0]!;
  if (!head.includes(":")) return true; // relative URL or fragment
  if (head.includes("&")) return false; // an undecoded reference in front of a colon: refuse rather than guess
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(head);
  if (!scheme) return false;
  const s = scheme[1];
  if (s === "http" || s === "https") return true;
  if (attr === "href" && (s === "mailto" || s === "tel")) return true;
  if (s === "data" && (tag === "img" || tag === "source") && attr === "src") return /^data:image\/(png|gif|jpe?g|webp|avif|bmp|svg\+xml)[;,]/.test(v);
  return false;
}

function safeSrcset(value: string, tag: string): boolean {
  return value.split(",").every((part) => isSafeUrl(part.trim().split(/\s+/)[0] ?? "", tag, "src"));
}

/** Sanitize an HTML fragment. */
export async function sanitizeHtml(html: string): Promise<string> {
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (DROP.has(tag)) {
          el.remove();
          return;
        }
        if (!KEEP.has(tag)) {
          el.removeAndKeepContent();
          return;
        }
        if (tag === "input" && (el.getAttribute("type") ?? "").toLowerCase() !== "checkbox") {
          el.remove();
          return;
        }
        const allowed = TAG_ATTRS[tag];
        const names: string[] = [];
        for (const a of el.attributes) names.push(a[0]!);
        for (const name of names) {
          const n = name.toLowerCase();
          if (!GLOBAL_ATTRS.has(n) && !allowed?.has(n)) {
            el.removeAttribute(name);
            continue;
          }
          const v = el.getAttribute(name) ?? "";
          if (URL_ATTRS.has(n) && !isSafeUrl(v, tag, n)) el.removeAttribute(name);
          else if (n === "srcset" && !safeSrcset(v, tag)) el.removeAttribute(name);
        }
        if (tag === "input") el.setAttribute("disabled", "");
        if (tag === "a" && el.getAttribute("href")) el.setAttribute("rel", "nofollow noopener noreferrer");
      },
    })
    .onDocument({
      comments(c) {
        c.remove();
      },
      doctype() {},
    });
  return rewriter.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).text();
}
