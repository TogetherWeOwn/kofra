import { escapeHtml } from "../html";
import hljs from "./hljs.js";

/**
 * Server-side syntax highlighting (highlight.js core + about 80 languages,
 * registered in ./hljs.js so the Worker bundle stays small). Highlighting runs
 * once per file content: the output is cached by sha256 (see ./cache.ts).
 * Language ids come from @kofra/core languageFor(); ALIASES maps the few
 * that highlight.js lacks to a close relative.
 */

const ALIASES: Record<string, string> = {
  html: "xml", svg: "xml", vue: "xml", svelte: "xml", jsx: "javascript", tsx: "typescript", hcl: "ini", zig: "rust",
  mermaid: "plaintext", text: "plaintext", txt: "plaintext", sh: "bash", zsh: "bash", yml: "yaml", toml: "ini", js: "javascript",
  ts: "typescript", py: "python", rb: "ruby", rs: "rust", md: "markdown", jsonc: "json", json5: "json", console: "shell",
};

/** The highlight.js language to use for a language id (or a Markdown fence tag), or null for plain text. */
export function hljsLanguage(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const l = lang.trim().toLowerCase().split(/[\s{]/)[0]!;
  const name = ALIASES[l] ?? l;
  if (name === "plaintext") return null;
  return hljs.getLanguage(name) ? name : null;
}

/** Files above this size are shown as escaped plain text (highlighting is CPU-heavy). */
export const HIGHLIGHT_MAX_BYTES = 512 * 1024;

/** Highlight `text` as HTML (escaped; spans with hljs-* classes). Unknown languages are only escaped. */
export function highlight(text: string, lang: string | null | undefined): string {
  const name = hljsLanguage(lang);
  if (!name || text.length > HIGHLIGHT_MAX_BYTES) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

/**
 * Split highlighted HTML into lines, closing the spans that are open at each
 * line break and reopening them on the next line, so every line is valid HTML
 * on its own (needed for line numbers and #L anchors).
 */
export function splitHighlightedLines(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let cur = "";
  let last = 0;
  const re = /<span[^>]*>|<\/span>|\n/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    cur += html.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[0] === "\n") {
      out.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else if (m[0] === "</span>") {
      open.pop();
      cur += m[0];
    } else {
      open.push(m[0]);
      cur += m[0];
    }
  }
  out.push(cur + html.slice(last));
  return out;
}

/** Token colours for hljs classes (GitHub-like), light and dark. */
export const HIGHLIGHT_CSS = `
.hljs-comment,.hljs-quote{color:#6a737d;font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag,.hljs-meta .hljs-keyword,.hljs-template-tag{color:#cf222e}
.hljs-string,.hljs-regexp,.hljs-addition,.hljs-attribute .hljs-string,.hljs-meta .hljs-string{color:#0a3069}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-variable.constant_,.hljs-attr,.hljs-attribute,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-link{color:#0550ae}
.hljs-title,.hljs-title.function_,.hljs-section,.hljs-selector-id,.hljs-selector-class{color:#8250df}
.hljs-title.class_,.hljs-type,.hljs-built_in,.hljs-params .hljs-type{color:#953800}
.hljs-name,.hljs-tag{color:#116329}.hljs-variable,.hljs-template-variable,.hljs-property{color:#24292f}
.hljs-meta,.hljs-meta .hljs-meta{color:#57606a}.hljs-deletion{color:#82071e;background:#ffebe9}.hljs-addition{background:#dafbe1}
.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}
@media (prefers-color-scheme:dark){
.hljs-comment,.hljs-quote{color:#8b949e}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag,.hljs-meta .hljs-keyword,.hljs-template-tag{color:#ff7b72}
.hljs-string,.hljs-regexp,.hljs-attribute .hljs-string,.hljs-meta .hljs-string{color:#a5d6ff}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-variable.constant_,.hljs-attr,.hljs-attribute,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-link{color:#79c0ff}
.hljs-title,.hljs-title.function_,.hljs-section,.hljs-selector-id,.hljs-selector-class{color:#d2a8ff}
.hljs-title.class_,.hljs-type,.hljs-built_in,.hljs-params .hljs-type{color:#ffa657}
.hljs-name,.hljs-tag{color:#7ee787}.hljs-variable,.hljs-template-variable,.hljs-property{color:#e6edf3}
.hljs-meta,.hljs-meta .hljs-meta{color:#8b949e}.hljs-deletion{color:#ffdcd7;background:#67060c}.hljs-addition{color:#aff5b4;background:#033a16}
}
`;
