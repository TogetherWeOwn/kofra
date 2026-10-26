import { encodePath } from "../lib/paths";

/**
 * The parsed `_redirects` and `_headers` files of one version (SRV-09).
 *
 * Both files live at the site root and use the Netlify / Cloudflare Pages
 * syntax subset described in docs/SPEC.md. They are parsed once, at finalize,
 * into `versions.config_json`; serving only ever reads the parsed rules, and
 * the files themselves are never served. Invalid lines are skipped and
 * reported as `invalid_config` warnings (returned by finalize, and kept in
 * `config_json.warnings` so a replayed finalize can report them again).
 */

export interface SiteConfigWarning {
  code: string;
  message: string;
}

export interface SiteRedirectRule {
  from: string;
  to: string;
  status: 301 | 302 | 307 | 308;
}

export interface SiteHeaderRule {
  pattern: string;
  headers: Array<{ name: string; value: string }>;
}

export interface SiteConfig {
  redirects: SiteRedirectRule[];
  headers: SiteHeaderRule[];
  warnings: SiteConfigWarning[];
}

/** Config files larger than this are ignored (with a warning) instead of being read into memory. */
export const SITE_CONFIG_MAX_BYTES = 256 * 1024;
export const SITE_CONFIG_MAX_REDIRECTS = 1000;
export const SITE_CONFIG_MAX_HEADER_RULES = 100;
export const SITE_CONFIG_MAX_HEADERS = 1000;

const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);
const MAX_WARNINGS_PER_FILE = 50;
const MAX_HEADER_VALUE_LENGTH = 4096;
const PLACEHOLDER_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Headers a site author may not set through `_headers`: framing and platform
 * headers that serving owns (lengths, types, validators, cookies on a shared
 * origin, Kofra's own `X-Kofra-*`). Platform security headers are applied
 * after custom headers at serve time, so they win even when listed here only
 * by being overwritten.
 */
const BLOCKED_HEADERS = new Set([
  "accept-ranges",
  "age",
  "alt-svc",
  "clear-site-data",
  "connection",
  "content-disposition",
  "content-encoding",
  "content-length",
  "content-range",
  "content-security-policy",
  "content-type",
  "x-frame-options",
  "date",
  "etag",
  "expect",
  "host",
  "keep-alive",
  "location",
  "refresh",
  "server",
  "set-cookie",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "vary",
  "www-authenticate",
]);

export function emptySiteConfig(): SiteConfig {
  return { redirects: [], headers: [], warnings: [] };
}

class WarningSink {
  readonly warnings: SiteConfigWarning[] = [];
  private overflowNoted = false;
  constructor(private readonly file: string) {}
  add(line: number, reason: string) {
    if (this.warnings.length >= MAX_WARNINGS_PER_FILE) {
      if (!this.overflowNoted) {
        this.overflowNoted = true;
        this.warnings.push({ code: "invalid_config", message: `${this.file}: further invalid lines were also ignored (only the first ${MAX_WARNINGS_PER_FILE} are reported).` });
      }
      return;
    }
    this.warnings.push({ code: "invalid_config", message: `${this.file} line ${line}: ${reason}` });
  }
  addFile(reason: string) {
    this.warnings.push({ code: "invalid_config", message: `${this.file}: ${reason}` });
  }
}

function placeholdersIn(pattern: string): string[] {
  return [...pattern.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!);
}

/** Why a `_redirects` from-pattern or `_headers` path pattern is unusable, or null when it is fine. */
function patternError(pattern: string): string | null {
  if (!pattern.startsWith("/")) return `"${pattern}" must start with "/".`;
  if (pattern.startsWith("//") || pattern.includes("\\")) return `"${pattern}" must be a plain path with single "/" separators.`;
  if (pattern.includes("?") || pattern.includes("#")) return `"${pattern}" must be a plain path (no query string or fragment; query conditions are not supported).`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(pattern)) return `"${pattern}" contains spaces or control characters.`;
  const stars = pattern.split("*").length - 1;
  if (stars > 1 || (stars === 1 && !pattern.endsWith("*"))) return `"${pattern}" may contain one "*" splat, at the end.`;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== ":") continue;
    if (!/^:[A-Za-z_][A-Za-z0-9_]*/.test(pattern.slice(i))) return `"${pattern}" has a ":" that does not start a placeholder name.`;
  }
  // One complete segment per placeholder prevents overlapping [^/]+ captures
  // from causing combinatorial backtracking on an untrusted request path.
  for (const segment of pattern.split("/")) {
    if (segment.includes(":") && !/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      return `"${pattern}" must use each placeholder as a whole path segment.`;
    }
  }
  const names = placeholdersIn(pattern);
  if (new Set(names).size !== names.length) return `"${pattern}" repeats a placeholder name.`;
  return null;
}

function destinationError(to: string, from: string): string | null {
  if (to.includes("#")) return `destination "${to}" must not contain a fragment.`;
  if (to.startsWith("//") || to.startsWith("/\\") || to.includes("\\")) {
    return `destination "${to}" must be a plain path or an absolute http(s) URL (protocol-relative destinations are not supported).`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(to)) return `destination "${to}" contains spaces or control characters.`;
  if (!to.startsWith("/")) {
    let url: URL;
    try {
      url = new URL(to);
    } catch {
      return `destination "${to}" must start with "/" or be an absolute http(s) URL.`;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return `destination "${to}" must be an http(s) URL.`;
  }
  const known = new Set(placeholdersIn(from));
  if (from.includes("*")) known.add("splat");
  for (const name of placeholdersIn(to)) {
    if (!known.has(name)) return `destination "${to}" uses ":${name}", which "${from}" never captures.`;
  }
  return null;
}

/** Parse a `_redirects` file: `<from> <to> [301|302|307|308]` per line (default 301), `#` comments. */
export function parseRedirectsFile(text: string): { rules: SiteRedirectRule[]; warnings: SiteConfigWarning[] } {
  const sink = new WarningSink("_redirects");
  const rules: SiteRedirectRule[] = [];
  let capNoted = false;
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i]!.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (rules.length >= SITE_CONFIG_MAX_REDIRECTS) {
      if (!capNoted) {
        capNoted = true;
        sink.add(lineNo, `more than ${SITE_CONFIG_MAX_REDIRECTS} rules; the rest of the file was ignored.`);
      }
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    const commentAt = tokens.findIndex((t) => t.startsWith("#"));
    const parts = commentAt >= 0 ? tokens.slice(0, commentAt) : tokens;
    if (parts.length < 2 || parts.length > 3) {
      sink.add(lineNo, `expected "<from> <to> [status]", got "${trimmed.slice(0, 120)}".`);
      continue;
    }
    const [from, to, statusToken] = parts as [string, string, string?];
    const fromError = patternError(from);
    if (fromError) {
      sink.add(lineNo, fromError);
      continue;
    }
    const toError = destinationError(to, from);
    if (toError) {
      sink.add(lineNo, toError);
      continue;
    }
    let status = 301;
    if (statusToken !== undefined) {
      if (!/^(301|302|307|308)$/.test(statusToken)) {
        sink.add(lineNo, `status "${statusToken}" is not supported; use 301, 302, 307 or 308.`);
        continue;
      }
      status = Number(statusToken);
    }
    rules.push({ from, to, status: status as SiteRedirectRule["status"] });
  }
  return { rules, warnings: sink.warnings };
}

/**
 * Parse a `_headers` file: a path pattern line, then indented `Name: value`
 * lines. Blocked platform headers are dropped with a warning.
 */
export function parseHeadersFile(text: string): { rules: SiteHeaderRule[]; warnings: SiteConfigWarning[] } {
  const sink = new WarningSink("_headers");
  const rules: SiteHeaderRule[] = [];
  let current: SiteHeaderRule | null = null;
  let totalHeaders = 0;
  let capNoted = false;
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indented = raw.startsWith(" ") || raw.startsWith("\t");
    if (!indented) {
      const error = /\s/.test(trimmed) ? `"${trimmed.slice(0, 120)}" is not a single path pattern.` : patternError(trimmed);
      if (error) {
        sink.add(lineNo, error);
        current = null;
        continue;
      }
      if (rules.length >= SITE_CONFIG_MAX_HEADER_RULES) {
        if (!capNoted) sink.add(lineNo, `more than ${SITE_CONFIG_MAX_HEADER_RULES} path patterns; the rest of the file was ignored.`);
        capNoted = true;
        current = null;
        continue;
      }
      current = { pattern: trimmed, headers: [] };
      rules.push(current);
      continue;
    }
    const m = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):(.*)$/.exec(trimmed);
    if (!m) {
      sink.add(lineNo, `expected an indented "Name: value" header line, got "${trimmed.slice(0, 120)}".`);
      continue;
    }
    if (!current) {
      sink.add(lineNo, `header "${m[1]}" has no valid path pattern above it.`);
      continue;
    }
    const name = m[1]!;
    const value = m[2]!.trim();
    const lower = name.toLowerCase();
    if (BLOCKED_HEADERS.has(lower) || lower.startsWith("x-kofra-")) {
      sink.add(lineNo, `"${name}" is set by the platform and cannot be set in _headers.`);
      continue;
    }
    // eslint-disable-next-line no-control-regex
    if (value.length > MAX_HEADER_VALUE_LENGTH || /[\u0000-\u0008\u000b-\u001f\u007fĀ-￿]/.test(value)) {
      sink.add(lineNo, `the value of "${name}" is too long, contains control characters, or cannot be represented as an HTTP header.`);
      continue;
    }
    if (totalHeaders >= SITE_CONFIG_MAX_HEADERS) {
      if (!capNoted) sink.add(lineNo, `more than ${SITE_CONFIG_MAX_HEADERS} headers; the rest of the file was ignored.`);
      capNoted = true;
      continue;
    }
    current.headers.push({ name, value });
    totalHeaders++;
  }
  return { rules: rules.filter((r) => r.headers.length > 0), warnings: sink.warnings };
}

/** Parse whichever config files are present into one SiteConfig (warnings merged). */
export function parseSiteConfig(files: { redirects?: string | null; headers?: string | null }): SiteConfig {
  const config = emptySiteConfig();
  if (files.redirects != null) {
    const parsed = parseRedirectsFile(files.redirects);
    config.redirects = parsed.rules;
    config.warnings.push(...parsed.warnings);
  }
  if (files.headers != null) {
    const parsed = parseHeadersFile(files.headers);
    config.headers = parsed.rules;
    config.warnings.push(...parsed.warnings);
  }
  return config;
}

/** A warning for a config file that was skipped whole (for example because of its size). */
export function siteConfigFileWarning(file: string, reason: string): SiteConfigWarning {
  const sink = new WarningSink(file);
  sink.addFile(reason);
  return sink.warnings[0]!;
}

/** Read a stored `config_json` defensively: anything malformed becomes the empty config. */
export function parseSiteConfigJson(json: string | null | undefined): SiteConfig {
  if (!json) return emptySiteConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return emptySiteConfig();
  }
  if (!raw || typeof raw !== "object") return emptySiteConfig();
  const obj = raw as Record<string, unknown>;
  const config = emptySiteConfig();
  if (Array.isArray(obj.redirects)) {
    for (const r of obj.redirects.slice(0, SITE_CONFIG_MAX_REDIRECTS)) {
      if (!r || typeof r !== "object") continue;
      const { from, to, status } = r as Record<string, unknown>;
      if (typeof from === "string" && typeof to === "string" && typeof status === "number" && REDIRECT_STATUSES.has(status)) {
        config.redirects.push({ from, to, status: status as SiteRedirectRule["status"] });
      }
    }
  }
  if (Array.isArray(obj.headers)) {
    for (const r of obj.headers.slice(0, SITE_CONFIG_MAX_HEADER_RULES)) {
      if (!r || typeof r !== "object") continue;
      const { pattern, headers } = r as Record<string, unknown>;
      if (typeof pattern !== "string" || !Array.isArray(headers)) continue;
      const rule: SiteHeaderRule = { pattern, headers: [] };
      for (const h of headers) {
        if (!h || typeof h !== "object") continue;
        const { name, value } = h as Record<string, unknown>;
        if (typeof name === "string" && typeof value === "string") rule.headers.push({ name, value });
      }
      if (rule.headers.length) config.headers.push(rule);
    }
  }
  if (Array.isArray(obj.warnings)) {
    for (const w of obj.warnings) {
      if (!w || typeof w !== "object") continue;
      const { code, message } = w as Record<string, unknown>;
      if (typeof code === "string" && typeof message === "string") config.warnings.push({ code, message });
    }
  }
  return config;
}

export interface SitePatternMatch {
  params: Record<string, string>;
  splat: string | null;
}

const escapeRegExpChar = (ch: string) => (/[\\^$+?.()|[\]{}]/.test(ch) ? `\\${ch}` : ch);

/** Match a site-relative URL path (leading "/") against a pattern with `:placeholders` and one trailing `*`. */
export function matchSitePattern(pattern: string, path: string): SitePatternMatch | null {
  if (patternError(pattern)) return null;
  let source = "^";
  const groups: Array<{ name: string } | { splat: true }> = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      source += "(.*)";
      groups.push({ splat: true });
      continue;
    }
    if (ch === ":") {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(pattern.slice(i + 1))?.[0];
      if (name) {
        source += "([^/]+)";
        groups.push({ name });
        i += name.length;
        continue;
      }
    }
    source += escapeRegExpChar(ch);
  }
  source += "$";
  let m: RegExpExecArray | null;
  try {
    m = new RegExp(source).exec(path);
  } catch {
    return null;
  }
  if (!m) return null;
  const params: Record<string, string> = Object.create(null);
  let splat: string | null = null;
  groups.forEach((g, idx) => {
    if ("splat" in g) splat = m![idx + 1] ?? "";
    else params[g.name] = m![idx + 1] ?? "";
  });
  return { params, splat };
}

/** Substitute `:name` and `:splat` in a redirect destination, percent-encoding the captured values. */
export function substituteSitePattern(template: string, match: SitePatternMatch): string {
  return template.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (name === "splat" && match.splat !== null) return encodePath(match.splat);
    const value = match.params[name];
    return value === undefined ? whole : encodeURIComponent(value);
  });
}

/** The first redirect rule matching `path` (leading "/"), with its substituted destination. */
export function findSiteRedirect(
  config: SiteConfig | null | undefined,
  path: string,
): { rule: SiteRedirectRule; destination: string } | null {
  if (!config) return null;
  for (const rule of config.redirects) {
    const match = matchSitePattern(rule.from, path);
    if (match) return { rule, destination: substituteSitePattern(rule.to, match) };
  }
  return null;
}

/** Every `_headers` entry whose pattern matches `path` (leading "/"), in file order. */
export function siteHeadersFor(config: SiteConfig | null | undefined, path: string): Array<{ name: string; value: string }> {
  if (!config) return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const rule of config.headers) {
    if (matchSitePattern(rule.pattern, path)) out.push(...rule.headers);
  }
  return out;
}
