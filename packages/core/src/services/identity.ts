import type { IdentityAdapter } from "../adapters";
import type { DropwayContext } from "../context";
import { sha256Hex, timingSafeEqualStr } from "../lib/crypto";
import { forbidden, unauthorized } from "../errors";
import { authenticateUploadToken, UPLOAD_TOKEN_PREFIX } from "./upload-tokens";
import type { Principal } from "../principal";
import { API_KEY_PREFIX, authenticateApiKey } from "./keys";

export const CLAIM_TOKEN_PREFIX = "dwc_";

/** Client IP as seen by Cloudflare. */
export function requestIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
}

/** Extract a bearer token from an Authorization header, or null when absent. Throws on a malformed header. */
export function bearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  if (!m) throw unauthorized("The Authorization header must be `Bearer <token>`.", undefined, "invalid_authorization");
  return m[1]!;
}

/** Resolve a bearer token: claim token (dwc_), the bootstrap secret, or an API key (dw_). */
export async function principalFromToken(dc: DropwayContext, token: string, ip: string): Promise<Principal> {
  if (token.startsWith(UPLOAD_TOKEN_PREFIX)) return authenticateUploadToken(dc, token, ip);
  if (token.startsWith(CLAIM_TOKEN_PREFIX)) {
    const row = await dc.env.DB.prepare("SELECT id FROM sites WHERE claim_token_hash = ? AND deleted_at IS NULL")
      .bind(await sha256Hex(token))
      .first<{ id: string }>();
    if (!row) {
      throw unauthorized("This claim token does not match any live site.", "Anonymous sites expire; publish again to get a new one.", "invalid_claim_token");
    }
    return { kind: "claim", siteId: row.id, ip };
  }
  const bootstrap = dc.config.adminBootstrapKey;
  if (bootstrap && timingSafeEqualStr(token, bootstrap)) return { kind: "bootstrap", ip };
  if (token.startsWith(API_KEY_PREFIX)) return authenticateApiKey(dc, token, ip);
  throw unauthorized("Unrecognised token format.", "API keys start with dw_ and claim tokens with dwc_.", "invalid_api_key");
}

/** The open-source identity: Authorization: Bearer <API key | claim token | bootstrap key>. */
export const defaultIdentity: IdentityAdapter = {
  async resolve(request, dc) {
    const ip = requestIp(request);
    const token = bearerToken(request);
    if (!token) return { kind: "anonymous", ip };
    if (token.startsWith(UPLOAD_TOKEN_PREFIX)) {
      const pathname = new URL(request.url).pathname;
      const blobUpload = /^(PUT|POST)$/.test(request.method) && /^\/api\/v1\/blobs\/[a-fA-F0-9]{64}$/.test(pathname);
      // The same one pending version may instead stage a large file through
      // the resumable multipart protocol; nothing else is reachable.
      const multipart =
        (request.method === "POST" && pathname === "/api/v1/uploads") ||
        (request.method === "GET" && /^\/api\/v1\/uploads\/[A-Za-z0-9_-]+$/.test(pathname)) ||
        (request.method === "PUT" && /^\/api\/v1\/uploads\/[A-Za-z0-9_-]+\/parts\/[^/]+$/.test(pathname)) ||
        (request.method === "POST" && /^\/api\/v1\/uploads\/[A-Za-z0-9_-]+\/complete$/.test(pathname));
      if (!blobUpload && !multipart) {
        throw forbidden("Upload tokens can only PUT file bytes to their upload links.", "Use an API key for other operations.");
      }
    }
    return principalFromToken(dc, token, ip);
  },
};
