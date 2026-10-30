import { Marked, type Tokens } from "marked";
import { escapeHtml } from "../html";
import { cachedRender } from "./cache";
import { standardTabs, viewerPage } from "./chrome";
import { HEADING_REFERENCES } from "./heading-references";
import { HIGHLIGHT_CSS, highlight, hljsLanguage } from "./highlight";
import type { Viewer } from "./index";
import { DROP, KEEP, sanitizeHtml } from "./sanitize";

// Bump whenever the rendered output changes: this retires cached fragments
// and render ETags keyed `markdown@<version>/...`. 11 preserves non-heading
// destinations and matches foreign content/removal lifetimes and tag policy.
const MD_VERSION = 11;

const MD_CSS = `
.dw-md{max-width:48rem;margin:0 auto;padding:2.5rem 1.25rem 5rem}
.dw-md h1,.dw-md h2,.dw-md h3,.dw-md h4,.dw-md h5,.dw-md h6{line-height:1.25;margin:2rem 0 .75rem;scroll-margin-top:4rem}
.dw-md h1{font-size:2.1rem;margin-top:0}.dw-md h2{font-size:1.5rem;padding-bottom:.3rem;border-bottom:1px solid var(--line)}
.dw-md h3{font-size:1.2rem}
.dw-md .dw-anchor{margin-left:.4rem;color:var(--muted);opacity:0;text-decoration:none;font-weight:400}
.dw-md :is(h1,h2,h3,h4,h5,h6):hover .dw-anchor,.dw-md .dw-anchor:focus{opacity:1}
.dw-md p,.dw-md ul,.dw-md ol,.dw-md blockquote,.dw-md table,.dw-md pre,.dw-md details{margin:0 0 1rem}
.dw-md img,.dw-md video{max-width:100%;height:auto;border-radius:6px}
.dw-md code{background:var(--code);padding:.12em .35em;border-radius:4px}
.dw-md pre{background:var(--code);padding:1rem;border-radius:8px;overflow:auto;line-height:1.45;font-size:.88rem}
.dw-md pre code{background:none;padding:0;font-size:inherit}
.dw-md pre[data-lang]{position:relative}
.dw-md pre[data-lang]::before{content:attr(data-lang);position:absolute;top:.35rem;right:.6rem;font:.68rem/1 ui-monospace,monospace;color:var(--muted);text-transform:lowercase}
.dw-md blockquote{border-left:3px solid var(--accent);padding:.1rem 1rem;color:var(--muted)}
.dw-md table{border-collapse:collapse;display:block;overflow:auto;max-width:100%}
.dw-md th,.dw-md td{border:1px solid var(--line);padding:.4rem .75rem}
.dw-md th{background:var(--code)}
.dw-md hr{border:0;border-top:1px solid var(--line);margin:2rem 0}
.dw-md li>input[type=checkbox]{margin:0 .45rem 0 -.2rem}
.dw-md ul:has(>li>input[type=checkbox]){list-style:none;padding-left:1.2rem}
.dw-md .dw-fm{font-size:.85rem;color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:.4rem .8rem}
.dw-md .dw-fm pre{margin:.5rem 0 .2rem}
.dw-md .dw-diagram::after{content:"Mermaid diagram source";display:block;margin-top:.5rem;font:.72rem/1 ui-sans-serif,system-ui;color:var(--muted)}
`;

/** Split optional YAML front matter from the body. Only `title:` is used. */
export function splitFrontMatter(src: string): { title: string | null; body: string; frontMatter: string | null } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { title: null, body: src, frontMatter: null };
  const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(m[1]!);
  return { title: t ? t[1]! : null, body: src.slice(m[0].length), frontMatter: m[1]! };
}

/** GitHub-style heading id: lowercase, punctuation dropped, spaces to dashes. */
export function headingId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/&[a-z0-9#]+;/g, "")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

/** Void elements: no end tag and no contents. `frame` is deliberately absent:
 *  it is not void, and the sanitizer drops it together with its contents. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/** Elements whose contents are raw text until the matching end tag. Only `script` has escape states. */
const RAWTEXT = new Set([
  "script", "style", "iframe", "noembed", "noframes", "noscript", "title", "textarea", "xmp", "plaintext",
]);

// Foreign content (inside <svg>/<math>) has no raw-text elements of its own:
// <style> and <title> there are ordinary elements whose children stay markup.
// Only the HTML integration points switch the parser back to HTML rules.
const SVG_INTEGRATION = new Set(["foreignobject", "desc", "title"]);
const MATH_INTEGRATION = new Set(["mi", "mo", "mn", "ms", "mtext"]);
const MATH_INTEGRATION_ENCODINGS = new Set(["text/html", "application/xhtml+xml"]);

// These starts return foreign parsing to HTML. That context transition does
// not end a removed element's content lifetime in the streaming sanitizer.
const FOREIGN_BREAKOUT = new Set([
  "b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt", "em", "embed",
  "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "i", "img", "li", "listing", "menu", "meta",
  "nobr", "ol", "p", "pre", "ruby", "s", "small", "span", "strong", "strike", "sub", "sup", "table",
  "tt", "u", "ul", "var",
]);

// After the initial ASCII letter, HTML tag names consume every non-space,
// non-slash, non-">" character, including unfamiliar custom-element names.
const TAG_OPEN = /<(\/?)([a-z][^\t\n\f\r />]*)/iy;
const HTML_SPACE = /[\t\n\f\r ]/;

// HTML numeric references in the C1 range use the Windows-1252 replacements.
const C1: Readonly<Record<number, number>> = {
  128: 8364, 130: 8218, 131: 402, 132: 8222, 133: 8230, 134: 8224, 135: 8225,
  136: 710, 137: 8240, 138: 352, 139: 8249, 140: 338, 142: 381, 145: 8216,
  146: 8217, 147: 8220, 148: 8221, 149: 8226, 150: 8211, 151: 8212, 152: 732,
  153: 8482, 154: 353, 155: 8250, 156: 339, 158: 382, 159: 376,
};

/** Comparison keys only: authored attributes are never rewritten. */
function headingKey(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\0/g, "�").replace(
    /&(#(?:x[0-9a-f]+|[0-9]+);?|[a-z][a-z0-9]*;?)/gi,
    (ref, name: string, offset: number, input: string) => {
      if (name[0] !== "#") {
        // In attributes, a legacy reference followed by alphanumeric or '='
        // stays literal. Named references themselves are case-sensitive.
        if (!name.endsWith(";") && /[=a-z0-9]/i.test(input[offset + ref.length] ?? "")) return ref;
        return Object.hasOwn(HEADING_REFERENCES, name) ? HEADING_REFERENCES[name]! : ref;
      }
      const n = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!n || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "�";
      return String.fromCodePoint(C1[n] ?? n);
    },
  );
}

/** HTML names fold ASCII capitals only, not Unicode lookalikes. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

interface ParsedTag {
  closing: boolean;
  name: string;
  id: string | undefined;
  inputType: string | undefined;
  /** `annotation-xml[encoding]` decides whether its children are HTML. */
  encoding: string | undefined;
  selfClosing: boolean;
  /** Index just past ">". */
  end: number;
}

/**
 * Parse one tag starting at `html[start]` ("<"). Returns null when no tag
 * starts there, "eof" when the tag never terminates.
 */
function parseTag(html: string, start: number): ParsedTag | "eof" | null {
  TAG_OPEN.lastIndex = start;
  const m = TAG_OPEN.exec(html);
  if (!m) return null;
  const closing = m[1] === "/";
  const name = asciiLower(m[2]!);
  let i = TAG_OPEN.lastIndex;
  let id: string | undefined;
  let inputType: string | undefined;
  let encoding: string | undefined;
  let selfClosing = false;
  // Attribute values may contain '<' and '>'. Never restart at a heading
  // prefix within a value, or rescan an unterminated tag from each '<'.
  while (i < html.length && html[i] !== ">") {
    if (HTML_SPACE.test(html[i]!)) { i++; continue; }
    if (html[i] === "/") { selfClosing = html[i + 1] === ">"; i++; continue; }
    const attrStart = i;
    // At "before attribute name", '=' starts a name (a parse error), rather
    // than being discarded: =id and id are distinct attributes.
    if (html[i] === "=") i++;
    while (i < html.length && !/[\t\n\f\r />=]/.test(html[i]!)) i++;
    const attr = asciiLower(html.slice(attrStart, i));
    while (i < html.length && HTML_SPACE.test(html[i]!)) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < html.length && HTML_SPACE.test(html[i]!)) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const valueStart = ++i;
        while (i < html.length && html[i] !== quote) i++;
        value = html.slice(valueStart, i);
        if (i < html.length) i++;
      } else {
        const valueStart = i;
        while (i < html.length && !HTML_SPACE.test(html[i]!) && html[i] !== ">") i++;
        value = html.slice(valueStart, i);
      }
    }
    // HTML keeps the first duplicate attribute. A slash is part of an
    // unquoted value, not a self-closing marker: id=install/ means install/.
    if (attr === "id" && id === undefined) id = value;
    if (attr === "type" && inputType === undefined) inputType = value;
    if (attr === "encoding" && encoding === undefined) encoding = value;
  }
  if (i === html.length) return "eof";
  return { closing, name, id, inputType, encoding, selfClosing, end: i + 1 };
}

type AnchorEvent = { kind: "md"; index: number } | { kind: "raw"; id: string; heading: boolean };

type RawDestination = { pos: number; id: string; heading: boolean };

/** SVG and MathML integration points: their children are parsed as HTML again. */
function integrationPoint(name: string, root: "svg" | "math" | null, encoding: string | undefined): boolean {
  if (root === "svg") return SVG_INTEGRATION.has(name);
  if (root !== "math") return false;
  if (MATH_INTEGRATION.has(name)) return true;
  return name === "annotation-xml" && MATH_INTEGRATION_ENCODINGS.has(asciiLower(encoding ?? ""));
}

/** One tokenizer pass. Structural omissions describe comparison bytes only;
 * HTMLRewriter remains the sanitizer and authored output is never rewritten here. */
function scanHtml(html: string, nonce: string, projecting: boolean) {
  const prefix = `kofra-md-${nonce}-`;
  const rawAt: RawDestination[] = [];
  const omitted: Array<[number, number]> = [];
  let hiddenFrom: number | undefined;
  let commentFrom = 0;
  // Content/removal scopes survive a namespace breakout. Context is separate:
  // even a self-closed root changes it without opening a removable subtree.
  let context: "html" | "svg" | "math" = "html";
  const open: Array<{ name: string; dropped: boolean; removed: boolean; childCtx: "html" | "svg" | "math" }> = [];
  let dropped = 0;
  let rawText: string | null = null;
  // Script tokenizer states: data, escaped (`<!--` seen), double-escaped.
  let escaped = 0;
  let comment = false;
  const commentEnd = /--!?>/g;
  let scriptEscapeEnd: number | undefined;
  const openNames = new Map<string, number[]>();

  const omit = (start: number, end: number): void => {
    if (projecting && end > start) omitted.push([start, end]);
  };
  const finish = () => {
    if (hiddenFrom !== undefined) omit(hiddenFrom, html.length);
    if (comment && dropped === 0) omit(commentFrom, html.length);
    return { rawAt, omitted };
  };

  /** Successful pops are amortized; missing names never scan the stack. */
  const popTo = (name: string): void => {
    const found = openNames.get(name)?.at(-1);
    if (found === undefined) return;
    while (open.length > found) {
      const el = open.pop()!;
      const indices = openNames.get(el.name)!;
      indices.pop();
      if (!indices.length) openNames.delete(el.name);
      if (el.dropped) dropped--;
      if (el.name === rawText) { rawText = null; escaped = 0; }
    }
    context = open.at(-1)?.childCtx ?? "html";
  };
  const closeTag = (tag: ParsedTag, start: number): void => {
    const found = openNames.get(tag.name)?.at(-1);
    const removed = found !== undefined && open[found]!.removed;
    popTo(tag.name);
    if (hiddenFrom !== undefined) {
      if (dropped === 0) {
        omit(hiddenFrom, removed ? tag.end : start);
        hiddenFrom = undefined;
      }
    } else if (removed) {
      omit(start, tag.end);
    }
  };

  let i = 0;
  for (;;) {
    if (comment) {
      // Find either terminator in one forward search, not two suffix scans.
      commentEnd.lastIndex = i;
      if (!commentEnd.exec(html)) return finish();
      i = commentEnd.lastIndex;
      if (dropped === 0) omit(commentFrom, i);
      comment = false;
      continue;
    }
    if (rawText === "plaintext") return finish();
    if (rawText && rawText !== "script") {
      const lt = html.indexOf("<", i);
      if (lt < 0) return finish();
      // Only a matching end tag can end raw text; anything else is content.
      // The cheap shape check keeps adversarial tag soup linear; parseTag
      // then consumes the end tag exactly (quoted ">" included).
      const probe = html.slice(lt + 1, lt + 2 + rawText.length).toLowerCase();
      if (probe === `/${rawText}` && /[\t\n\f\r />]/.test(html[lt + 2 + rawText.length] ?? ">")) {
        const tag = parseTag(html, lt);
        if (tag === "eof" || tag === null) return finish();
        i = tag.end;
        closeTag(tag, lt);
      } else {
        i = lt + 1;
      }
      continue;
    }
    if (rawText === "script") {
      const lt = html.indexOf("<", i);
      // In either escaped state `-->` returns to script data. Cache its next
      // position so repeated '<' markers never re-search an unchanged suffix.
      if (escaped !== 0 && (scriptEscapeEnd === undefined || (scriptEscapeEnd >= 0 && scriptEscapeEnd < i))) {
        scriptEscapeEnd = html.indexOf("-->", i);
      }
      const dd = escaped !== 0 ? scriptEscapeEnd! : -1;
      if (dd >= 0 && (lt < 0 || dd < lt)) { escaped = 0; i = dd + 3; continue; }
      if (lt < 0) return finish();
      // Reconsume the opener's dashes: <!--> and <!---> already contain
      // the --> that returns an escaped script to data.
      if (html.startsWith("<!--", lt)) { if (escaped === 0) escaped = 1; i = lt + 2; continue; }
      const slash = html[lt + 1] === "/";
      const nm = html.slice(lt + (slash ? 2 : 1), lt + (slash ? 2 : 1) + 6).toLowerCase();
      const after = html[lt + (slash ? 2 : 1) + 6] ?? ">";
      if (nm === "script" && /[\t\n\f\r />]/.test(after)) {
        if (!slash) {
          if (escaped === 1) escaped = 2;
          i = lt + 1;
        } else if (escaped === 2) {
          escaped = 1;
          i = lt + 1;
        } else {
          const tag = parseTag(html, lt);
          if (tag === "eof" || tag === null) return finish();
          i = tag.end;
          closeTag(tag, lt);
        }
      } else {
        i = lt + 1;
      }
      continue;
    }
    const lt = html.indexOf("<", i);
    if (lt < 0) return finish();
    // Inside foreign content `<![CDATA[` opens a text run that ends only at
    // `]]>`; every `<` in it is content. Reading it as an HTML bogus comment
    // (through the first `>`) would end the dropped foreign subtree early and
    // register headings the parser keeps as text. Only the exact uppercase
    // spelling matches; any other `<![` there is an ordinary bogus comment.
    if (context !== "html" && html.startsWith("<![CDATA[", lt)) {
      const close = html.indexOf("]]>", lt + 9);
      if (close < 0) return finish();
      i = close + 3;
      continue;
    }
    if (html.startsWith("<!--", lt)) {
      // Abrupt closings complete immediately: <!--> and <!--->.
      if (html[lt + 4] === ">") { i = lt + 5; if (dropped === 0) omit(lt, i); continue; }
      if (html[lt + 4] === "-" && html[lt + 5] === ">") { i = lt + 6; if (dropped === 0) omit(lt, i); continue; }
      comment = true;
      commentFrom = lt;
      i = lt + 4;
      continue;
    }
    // A nonletter after "</" starts a bogus comment through the next ">",
    // except for the empty end tag "</>". Embedded '<' markers are content.
    const bogusEnd = html[lt + 1] === "/" && html[lt + 2] !== ">" && !/[a-z]/i.test(html[lt + 2] ?? "");
    if (html[lt + 1] === "!" || html[lt + 1] === "?" || bogusEnd) {
      const gt = html.indexOf(">", lt + 2);
      const end = gt < 0 ? html.length : gt + 1;
      // Doctypes are retained; bogus comments are removed by onDocument.comments.
      if (dropped === 0 && !/^<!doctype(?:[\t\n\f\r >]|$)/i.test(html.slice(lt, lt + 10))) omit(lt, end);
      if (gt < 0) return finish();
      i = end;
      continue;
    }
    const tag = parseTag(html, lt);
    if (tag === null) { i = lt + 1; continue; }
    // An unterminated tag at fragment EOF is discarded, like the browser: a
    // tag completed by later generated markup never reaches this branch,
    // because the probe is scanned whole.
    if (tag === "eof") return finish();
    i = tag.end;
    if (tag.closing) {
      closeTag(tag, lt);
      continue;
    }
    if (context !== "html" && FOREIGN_BREAKOUT.has(tag.name)) {
      context = "html";
      // Each foreign frame changes at most once: amortized linear work. Keep
      // its removal scope open even though following tokens now parse as HTML.
      for (let k = open.length - 1; k >= 0 && open[k]!.childCtx !== "html"; k--) open[k]!.childCtx = "html";
    }
    const namespace: "html" | "svg" | "math" = context === "html"
      ? tag.name === "svg" ? "svg" : tag.name === "math" ? "math" : "html"
      : context;
    const foreign: boolean = namespace !== "html";
    // Policy uses Unicode lowercasing, just like sanitizeHtml. Structural names
    // above remain ASCII-folded: linK is dropped as link but is not HTML-void.
    const policyName = tag.name.toLowerCase();
    const isDrop = projecting && (DROP.has(policyName) || (policyName === "input" && (tag.inputType ?? "").toLowerCase() !== "checkbox"));
    const removed = projecting && (isDrop || !KEEP.has(policyName));
    const hasContent: boolean = foreign ? !tag.selfClosing : !VOID.has(tag.name);
    if (dropped === 0 && removed) {
      if (isDrop && hasContent) hiddenFrom = lt;
      else omit(lt, tag.end);
    }
    // A foreign slash ends the token's content scope, including at integration
    // points. A slash on an HTML non-void element is still ignored.
    context = hasContent && integrationPoint(tag.name, namespace === "html" ? null : namespace, tag.encoding) ? "html" : namespace;
    if (hasContent) {
      const indices = openNames.get(tag.name) ?? [];
      indices.push(open.length);
      openNames.set(tag.name, indices);
      open.push({ name: tag.name, dropped: isDrop, removed, childCtx: context });
      if (isDrop) dropped++;
      if (!foreign && RAWTEXT.has(tag.name)) { rawText = tag.name; escaped = 0; }
    }
    if (tag.id && !tag.id.startsWith(prefix) && dropped === 0) {
      rawAt.push({ pos: lt, id: headingKey(tag.id), heading: /^h[1-6]$/.test(tag.name) });
    }
  }
}

/**
 * Merge original Markdown sentinel order with raw destinations in the final output.
 * Removing comments, dropped subtrees or unwrapped tags can join text into new
 * markup. Apply those structural omissions once, then reparse the comparison
 * bytes without sanitizing them again. Positions map monotonically back to the
 * original probe, so swallowed headings cannot shift later Markdown indices.
 */
function scanProbe(html: string, nonce: string): AnchorEvent[] {
  const prefix = `kofra-md-${nonce}-`;
  const digits = /\d+/y;
  const mdAt: Array<{ pos: number; index: number }> = [];
  let at = html.indexOf(prefix);
  while (at >= 0) {
    digits.lastIndex = at + prefix.length;
    const num = digits.exec(html);
    if (num) mdAt.push({ pos: at, index: Number(num[0]) });
    at = html.indexOf(prefix, at + prefix.length);
  }

  const first = scanHtml(html, nonce, true);
  let rawAt = first.rawAt;
  if (first.omitted.length) {
    const parts: string[] = [];
    const spans: Array<{ offset: number; start: number }> = [];
    let from = 0;
    let offset = 0;
    const append = (end: number): void => {
      if (end <= from) return;
      spans.push({ offset, start: from });
      parts.push(html.slice(from, end));
      offset += end - from;
    };
    for (const [start, end] of first.omitted) {
      append(start);
      from = end;
    }
    append(html.length);
    rawAt = scanHtml(parts.join(""), nonce, false).rawAt;
    let span = 0;
    for (const raw of rawAt) {
      while (span + 1 < spans.length && spans[span + 1]!.offset <= raw.pos) span++;
      raw.pos += spans[span]!.start - spans[span]!.offset;
    }
  }

  const seenMd = new Set<number>();
  const events: AnchorEvent[] = [];
  let m = 0;
  let r = 0;
  while (m < mdAt.length || r < rawAt.length) {
    if (r < rawAt.length && (m === mdAt.length || rawAt[r]!.pos < mdAt[m]!.pos)) {
      const raw = rawAt[r++]!;
      events.push({ kind: "raw", id: raw.id, heading: raw.heading });
    } else {
      const index = mdAt[m++]!.index;
      // Each generated heading carries two occurrences (id and href).
      if (!seenMd.has(index)) { seenMd.add(index); events.push({ kind: "md", index }); }
    }
  }
  return events;
}

/** Probe ids embed a per-render nonce so authored markup can never forge one. */
function sentinelId(nonce: string, index: number): string {
  return `kofra-md-${nonce}-${index}`;
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Final ids from probe order: a Markdown heading keeps its baseline id
 * unless an earlier raw heading already owns it; then it takes the first
 * free base-N suffix, skipping all surviving raw ids (not just headings) and baseline destinations
 * in the document (past and future) so no reachable fragment moves.
 */
function assignIds(events: AnchorEvent[], bases: string[], baselines: string[]): string[] {
  const rawAll = new Set<string>();
  for (const e of events) if (e.kind === "raw") rawAll.add(e.id);
  const baselineAll = new Set(baselines);
  const finals: Array<string | undefined> = new Array(bases.length);
  const assigned = new Set<string>();
  const rawSeen = new Set<string>();
  const nextSuffix = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "raw") {
      if (e.heading) rawSeen.add(e.id);
      continue;
    }
    if (e.index >= bases.length || finals[e.index] !== undefined) continue;
    const base = bases[e.index]!;
    const baseline = baselines[e.index]!;
    if (!rawSeen.has(baseline)) {
      finals[e.index] = baseline;
    } else {
      let n = nextSuffix.get(base) ?? 1;
      let cand = `${base}-${n}`;
      while (rawAll.has(cand) || baselineAll.has(cand) || assigned.has(cand)) {
        n++;
        cand = `${base}-${n}`;
      }
      nextSuffix.set(base, n + 1);
      finals[e.index] = cand;
    }
    assigned.add(finals[e.index]!);
  }
  // A heading absorbed into raw markup leaves no probe event; it keeps its baseline.
  return baselines.map((baseline, k) => finals[k] ?? baseline);
}

function markedFor(
  nonce: string,
  basesOut: string[] | null,
  baselinesOut: string[] | null,
): Marked {
  // Baseline counters belong to one Markdown fragment, even in a notebook.
  const seen = new Map<string, number>();
  return new Marked({
    gfm: true,
    breaks: false,
    async: false,
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Heading) {
        const { tokens, depth } = token;
        const base = headingId(token.text);
        const k = seen.get(base) ?? 0;
        seen.set(base, k + 1);
        const baseline = k ? `${base}-${k}` : base;
        let id = baseline;
        if (basesOut && baselinesOut) {
          id = sentinelId(nonce, basesOut.length);
          basesOut.push(base);
          baselinesOut.push(baseline);
        }
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${escapeHtml(id)}">${inner}<a class="dw-anchor" href="#${escapeHtml(id)}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        const tag = (lang ?? "").trim().split(/\s+/)[0] ?? "";
        if (tag.toLowerCase() === "mermaid") return `<pre class="dw-diagram" data-lang="mermaid"><code>${escapeHtml(text)}</code></pre>\n`;
        const name = hljsLanguage(tag);
        const body = name ? highlight(text, name) : escapeHtml(text);
        return `<pre${tag ? ` data-lang="${escapeHtml(tag.slice(0, 20))}"` : ""}><code class="hljs${name ? ` language-${escapeHtml(name)}` : ""}">${body}</code></pre>\n`;
      },
    },
  });
}

function markdownSource(src: string, path: string) {
  const { title: fmTitle, body, frontMatter } = splitFrontMatter(src.replace(/^\uFEFF/, ""));
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  const title = fmTitle ?? (h1 ? h1[1]!.replace(/[*_`]/g, "") : (path.split("/").pop() ?? path));
  return { title, body, frontMatter };
}

/** Internal document planner shared by the Markdown and notebook viewers.
 * Render all Markdown fragments first, assemble their actual wrappers/raw
 * outputs, then resolve once in served order. Historical baseline counters
 * reset per fragment; reservations span the complete assembled document. */
export function createMarkdownAnchors() {
  const nonce = randomNonce();
  const bases: string[] = [];
  const baselines: string[] = [];
  return {
    render(src: string, path: string) {
      const { title, body, frontMatter } = markdownSource(src, path);
      const html = markedFor(nonce, bases, baselines).parse(body) as string;
      return { title, html, frontMatter };
    },
    resolve(html: string, boundary = ""): string {
      if (!bases.length) return html;
      // The suffix participates only in interpretation. Never add bytes to
      // sanitized content: viewer chrome already supplies this boundary.
      const finals = assignIds(scanProbe(html + boundary, nonce), bases, baselines);
      return html.replace(new RegExp(`kofra-md-${nonce}-(\\d+)`, "g"), (_match, index: string) => escapeHtml(finals[Number(index)]!));
    },
  };
}

/**
 * Render Markdown (GFM: tables, task lists, strikethrough, autolinks) to HTML,
 * with highlighted code blocks and linkable headings. The output is NOT
 * sanitized: pass it through sanitizeHtml() before serving it (the viewer does).
 * This synchronous fragment helper has true EOF; viewers plan with their own
 * final wrapper boundary instead.
 */
export function renderMarkdown(src: string, path: string): { title: string; html: string; frontMatter: string | null } {
  // Without "<" no raw tag can exist: baselines are final after one pass.
  if (!src.includes("<")) {
    const { title, body, frontMatter } = markdownSource(src, path);
    return { title, html: markedFor("", null, null).parse(body) as string, frontMatter };
  }
  const anchors = createMarkdownAnchors();
  const out = anchors.render(src, path);
  return { ...out, html: anchors.resolve(out.html) };
}

export const markdownViewer: Viewer = {
  id: "markdown",
  version: MD_VERSION,
  maxBytes: 2 * 1024 * 1024,
  matches: (file, live, mode) => live.renderMarkdown && file.kind === "markdown" && mode !== "source",
  async render(vc) {
    let title = vc.file.path;
    const r = await cachedRender(vc.dw, `markdown@${MD_VERSION}/${vc.file.sha256}`, async () => {
      const anchors = createMarkdownAnchors();
      const out = anchors.render(await vc.readText(), vc.file.path);
      const fm = out.frontMatter
        ? `<details class="dw-fm"><summary>Front matter</summary><pre><code>${escapeHtml(out.frontMatter)}</code></pre></details>`
        : "";
      // The title travels with the cached fragment so a hit needs no re-parse.
      return `<!--title:${escapeHtml(out.title)}-->${fm}${await sanitizeHtml(anchors.resolve(out.html, "</article>"))}`;
    });
    const m = /^<!--title:(.*?)-->/.exec(r.html);
    if (m) title = m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    return viewerPage(vc, {
      title,
      print: true,
      tabs: standardTabs(vc, { source: true }),
      css: MD_CSS + HIGHLIGHT_CSS,
      body: `<article class="dw-md">${m ? r.html.slice(m[0].length) : r.html}</article>`,
      headers: { "X-Kofra-Render-Cache": r.cache },
    });
  },
};
