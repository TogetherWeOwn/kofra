import type { DropwayContext } from "../context";
import { ApiError, forbidden } from "../errors";
import { hmacHex, timingSafeEqualStr } from "../lib/crypto";
import type { Principal } from "../principal";

export const UPLOAD_TOKEN_PREFIX = "dwu_";
export const PENDING_VERSION_TTL_MS = 3600_000;

/** A capability for exactly one immutable pending manifest, never a site credential. */
export async function createUploadToken(dc: DropwayContext, version: { id: string; created_at: number }): Promise<string> {
  const payload = `${UPLOAD_TOKEN_PREFIX}${version.id}.${version.created_at + PENDING_VERSION_TTL_MS}`;
  return `${payload}.${await hmacHex(dc.config.signingSecret, payload)}`;
}

export async function authenticateUploadToken(dc: DropwayContext, token: string, ip: string): Promise<Principal> {
  const match = /^dwu_(ver_[a-zA-Z0-9_-]+)\.(\d+)\.([a-f0-9]{64})$/.exec(token);
  if (!match || !timingSafeEqualStr(await hmacHex(dc.config.signingSecret, token.slice(0, token.lastIndexOf("."))), match[3]!)) {
    throw forbidden("Invalid upload token.", "Use the unmodified Authorization header from upload.items.");
  }
  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(expiresAt) || Date.now() >= expiresAt) throw uploadExpired();
  return { kind: "upload", versionId: match[1]!, expiresAt, ip };
}

export function uploadExpired(): ApiError {
  return new ApiError(410, "upload_expired", "This pending version's upload capability has expired.", "Publish again to get fresh upload links; stored files are reused.");
}
