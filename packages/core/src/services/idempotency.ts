import type { DropwayContext } from "../context";
import { ApiError, badRequest } from "../errors";
import { sha256Hex } from "../lib/crypto";
import type { Principal } from "../principal";

/**
 * Idempotency keys for writes (REST `Idempotency-Key` header, MCP `idempotencyKey` argument).
 *
 * Same caller + same operation + same key:
 * - same input  -> the first result is replayed (`replayed: true`), nothing runs twice;
 * - other input -> 422 idempotency_key_reused;
 * - first call still running -> 409 idempotency_in_progress (retryable).
 * Records live 24 hours. Failed calls are not recorded, so a retry after an error runs again.
 *
 * D1 atomically claims each key across isolates and locations. A pending claim is
 * never stolen before its 24-hour expiry: an interrupted request has an unknown
 * outcome, not proof that it is safe to execute again. Normal failures release
 * their own claim, while completed results are durably replayed.
 */

const TTL_MS = 86_400_000;
const KEY_RE = /^[\x21-\x7e]{1,255}$/;
// At most 3 UTF-8 bytes per UTF-16 code unit: each value/row stays well below 2 MB.
const RESULT_CHUNK_CHARS = 256_000;

interface StoredRecord {
  state: "pending" | "done";
  input_hash: string;
  owner_token: string;
  result_json: string | null;
}

function inProgress(): ApiError {
  return new ApiError(409, "idempotency_in_progress", "The first request with this idempotency key is still running or its outcome is unknown.", "Retry this same request and key shortly; do not use a new key for an uncertain operation.", {
    retryable: true,
    retryAfterSeconds: 1,
  });
}

/** Check an idempotency key: 1-255 printable ASCII characters, or absent. */
export function validateIdempotencyKey(key: unknown): string | null {
  if (key === undefined || key === null || key === "") return null;
  if (typeof key !== "string" || !KEY_RE.test(key)) {
    throw badRequest(
      "invalid_idempotency_key",
      "The idempotency key must be 1-255 printable ASCII characters without spaces.",
      "Use a fresh UUID per logical operation, and reuse it only when retrying that same operation.",
    );
  }
  return key;
}

/** Replay never crosses a credential or its current authorization restrictions. */
export function idempotencyScope(p: Principal): string | null {
  if (p.kind === "member") {
    return `m:v2:${JSON.stringify([p.tenantId, p.memberId, p.keyId, p.siteId, p.role, [...new Set(p.scopes)].sort(), p.via])}`;
  }
  if (p.kind === "claim") return `c:${p.siteId}`;
  // Without a real client IP, never share anonymous claim credentials globally.
  if (p.kind === "anonymous" && p.ip && p.ip !== "0.0.0.0") return `a:${p.ip}`;
  return null;
}

/** JSON with sorted object keys, so equal inputs hash equally whatever their key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export interface IdempotencyOptions<T> {
  /** Owner of the record, from idempotencyScope(). null disables idempotency. */
  scope: string | null;
  /** Operation name, e.g. "publish_site". */
  operation: string;
  key: string | null;
  /** The request input (without the key itself). */
  input: unknown;
  /** Strip secrets before the result is stored for replay (e.g. a newly minted API key). */
  redactForReplay?: (result: T) => T;
}

/** Run `run` at most once per (scope, operation, key) within 24 hours. */
export async function withIdempotency<T>(dc: DropwayContext, opts: IdempotencyOptions<T>, run: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
  if (!opts.key || !opts.scope) return { result: await run(), replayed: false };
  const keyHash = await sha256Hex(`${opts.scope}\u0000${opts.operation}\u0000${opts.key}`);
  const inputHash = await sha256Hex(stableStringify(opts.input));
  const owner = crypto.randomUUID();
  const now = Date.now();
  const claimed = await dc.env.DB.prepare(
    `INSERT INTO idempotency_keys (key_hash, input_hash, owner_token, state, result_json, expires_at)
     VALUES (?, ?, ?, 'pending', NULL, ?)
     ON CONFLICT(key_hash) DO UPDATE SET input_hash = excluded.input_hash, owner_token = excluded.owner_token,
       state = 'pending', result_json = NULL, expires_at = excluded.expires_at
     WHERE idempotency_keys.expires_at <= ?`,
  ).bind(keyHash, inputHash, owner, now + TTL_MS, now).run();
  if (claimed.meta.changes === 0) {
    const existing = await dc.env.DB.prepare("SELECT input_hash, owner_token, state, result_json FROM idempotency_keys WHERE key_hash = ?").bind(keyHash).first<StoredRecord>();
    if (existing && existing.input_hash !== inputHash) {
      throw new ApiError(
        422,
        "idempotency_key_reused",
        `This idempotency key was already used for a different ${opts.operation} request.`,
        "Use a new key for a new operation; reuse a key only to retry the exact same request.",
      );
    }
    if (existing?.state === "done") {
      let json = existing.result_json;
      if (json === null) {
        const { results } = await dc.env.DB.prepare(
          "SELECT result_json FROM idempotency_result_chunks WHERE key_hash = ? AND owner_token = ? ORDER BY chunk_index",
        ).bind(keyHash, existing.owner_token).all<{ result_json: string }>();
        // Cleanup/reclaim may have retired this owner between the two reads.
        if (!results.length) throw inProgress();
        json = results.map((row) => row.result_json).join("");
      }
      return { result: JSON.parse(json) as T, replayed: true };
    }
    throw inProgress();
  }
  let result: T;
  try {
    result = await run();
  } catch (e) {
    await dc.env.DB.prepare("DELETE FROM idempotency_keys WHERE key_hash = ? AND owner_token = ? AND state = 'pending'").bind(keyHash, owner).run();
    throw e;
  }
  try {
    const stored = opts.redactForReplay ? opts.redactForReplay(result) : result;
    const json = JSON.stringify(stored);
    const statements: D1PreparedStatement[] = [];
    if (json.length > RESULT_CHUNK_CHARS) {
      for (let start = 0, index = 0; start < json.length; index++) {
        let end = Math.min(start + RESULT_CHUNK_CHARS, json.length);
        // Never turn a surrogate pair into two invalid UTF-8 strings in D1.
        const last = json.charCodeAt(end - 1);
        if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
        statements.push(dc.env.DB.prepare(
          `INSERT INTO idempotency_result_chunks (key_hash, owner_token, chunk_index, result_json)
           SELECT key_hash, owner_token, ?, ? FROM idempotency_keys
           WHERE key_hash = ? AND owner_token = ? AND state = 'pending'`,
        ).bind(index, json.slice(start, end), keyHash, owner));
        start = end;
      }
    }
    statements.push(dc.env.DB.prepare("UPDATE idempotency_keys SET state = 'done', result_json = ?, expires_at = ? WHERE key_hash = ? AND owner_token = ? AND state = 'pending'")
      .bind(statements.length ? null : json, Date.now() + TTL_MS, keyHash, owner));
    // Payload and completion commit together; a late owner cannot write to a reclaimed key.
    await dc.env.DB.batch(statements);
  } catch {
    // The mutation succeeded. Preserve its response and the pending claim (unknown
    // replay outcome) rather than returning a false failure or executing it again.
    console.error(JSON.stringify({ event: "idempotency_result_persistence_failed", operation: opts.operation }));
  }
  return { result, replayed: false };
}
