/**
 * High-signal credential patterns. Publishing makes files public, so the CLI
 * refuses files that contain one of these unless --allow-secrets is passed.
 * Patterns are specific on purpose (fixed prefixes and lengths) to keep false
 * positives rare in minified bundles. Matched values are never printed.
 * The CLI runs on Node and cannot import @dropway/core; keep this list in sync
 * with `packages/core/src/lib/secrets.ts`, which the server uses for the
 * `possible_secret` warning on the REST and MCP publish paths.
 */
export const SECRET_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "private_key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { kind: "aws_access_key_id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { kind: "llm_api_key", re: /\bsk-(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{48}\b/ },
  { kind: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: "live_secret_key", re: /\b[sr]k_live_[A-Za-z0-9]{20,}/ },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: "dropway_key", re: /\bdwc?_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/ },
];

export interface SecretFinding {
  path: string;
  line: number;
  kind: string;
}

/** Scan text content; returns at most one finding per pattern per file. */
export function findSecrets(path: string, text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const { kind, re } of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    let line = 1;
    for (let i = 0; i < m.index; i++) if (text.charCodeAt(i) === 10) line++;
    out.push({ path, line, kind });
  }
  return out;
}

/** True when the bytes look like text (no NUL byte in the first 8 KB). */
export function looksTextual(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}
