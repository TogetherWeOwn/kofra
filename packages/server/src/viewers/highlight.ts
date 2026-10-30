import { escapeHtml } from "../html";
import hljs from "./hljs.js";

/**
 * Server-side syntax highlighting (highlight.js core + about 80 languages,
 * registered in ./hljs.js so the Worker bundle stays small). Highlighting runs
 * once per file content: the output is cached by sha256 (see ./cache.ts).
 * Language ids come from @dropway/core languageFor(); ALIASES maps the few
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

/**
 * Token colours for hljs classes now ship in the design bundles (design/css/80-syntax.css, from the
 * syn-* tokens, in both modes). Kept as an export so viewers that still append it keep working.
 */
export const HIGHLIGHT_CSS = "";
