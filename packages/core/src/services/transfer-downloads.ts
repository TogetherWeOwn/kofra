import { signingSecret } from "../config";
import type { DropwayContext } from "../context";
import { siteUrl } from "../context";
import { readBlob, readBlobRange } from "./blobs";
import { ApiError, forbidden, rateLimited } from "../errors";
import { hmacHex, newSecret, sha256Hex, timingSafeEqualStr, verifyPassword } from "../lib/crypto";
import { transferConflict, transferMissing, transferRecipients, validateTransferPassword, type TransferFile, type TransferRow } from "./transfers";

export interface PublicTransfer extends TransferRow { password_hash: string | null }
export async function publicTransfer(dc: DropwayContext, slug: string): Promise<PublicTransfer> {
  const t = await dc.env.DB.prepare(`SELECT t.*, s.password_hash FROM transfers t JOIN sites s ON s.id = t.site_id
    WHERE s.slug = ? AND s.mode = 'transfer' AND s.deleted_at IS NULL AND t.deleted_at IS NULL AND s.current_version_id IS NOT NULL`)
    .bind(slug).first<PublicTransfer>();
  if (!t) throw transferMissing();
  return t;
}
export async function publicTransferFile(dc: DropwayContext, t: TransferRow, path: string): Promise<TransferFile> {
  const file = await dc.env.DB.prepare("SELECT * FROM transfer_files WHERE transfer_id = ? AND path = ?").bind(t.id, path).first<TransferFile>();
  if (!file || t.purged_at !== null) throw transferMissing();
  return file;
}
/** Called only after resolving slug, deletion and (when applicable) the exact file. */
export function checkTransferGate(t: TransferRow): void {
  if (t.deleted_at !== null) throw transferMissing();
  if (t.takedown_at !== null) throw new ApiError(451, "transfer_unavailable", "This delivery is unavailable.", "Contact the sender.");
  if (t.revoked_at !== null || t.expired_at !== null || t.expires_at < Date.now() || (t.download_limit !== null && t.downloads >= t.download_limit)) {
    throw new ApiError(410, "transfer_gone", "This delivery is no longer available.", "Ask the sender for a new delivery.");
  }
}
export const transferCookieName = (t: TransferRow) => `__Host-dw_transfer_${t.id}`;

export async function makeTransferGrant(dc: DropwayContext, t: PublicTransfer): Promise<string> {
  const until = Math.min(Date.now() + 15 * 60_000, t.expires_at);
  const value = String(until);
  return `${value}.${await hmacHex(signingSecret(dc.config), `transfer:${t.id}:${t.password_hash}:${value}`)}`;
}
export async function transferUnlocked(dc: DropwayContext, t: PublicTransfer, request: Request): Promise<boolean> {
  if (!t.password_hash) return true;
  const cookies = new Map((request.headers.get("Cookie") ?? "").split(";").map((s) => { const i = s.indexOf("="); return [s.slice(0, i).trim(), s.slice(i + 1)] as const; }));
  const grants = [new URL(request.url).searchParams.get("grant"), cookies.get(transferCookieName(t))];
  for (const grant of grants) {
    if (!grant || grant.length > 100) continue;
    const [until, signature] = grant.split(".");
    if (!until || !signature || !/^\d+$/.test(until) || Number(until) < Date.now() || Number(until) > Date.now() + 15 * 60_000) continue;
    const expected = await hmacHex(signingSecret(dc.config), `transfer:${t.id}:${t.password_hash}:${until}`);
    if (timingSafeEqualStr(signature, expected)) return true;
  }
  return false;
}
async function spendUnlock(dc: DropwayContext, bucket: string, cap: number) {
  const windowMs = 15 * 60_000;
  const window = Math.floor(Date.now() / windowMs);
  // The conditional upsert matches no row once the counter is at its allowance, so a full counter is never written
  // again in its window and attempts never pass the cap. A late reservation from an earlier window cannot move it backward.
  for (let tries = 0; tries < 2; tries++) {
    const spent = await dc.env.DB.prepare(`INSERT INTO transfer_unlock_buckets (bucket, window, attempts) VALUES (?, ?, 1)
      ON CONFLICT(bucket) DO UPDATE SET window = MAX(window, excluded.window),
        attempts = CASE WHEN window >= excluded.window THEN attempts + 1 ELSE 1 END
        WHERE window < excluded.window OR attempts < ? RETURNING window`)
      .bind(bucket, window, cap).first<{ window: number }>();
    if (spent) return;
    const stored = await dc.env.DB.prepare("SELECT window, attempts FROM transfer_unlock_buckets WHERE bucket = ?")
      .bind(bucket).first<{ window: number; attempts: number }>();
    if (!stored) break;
    // A counter renewed into a newer window between the upsert and this read has room again: try once more.
    if (stored.attempts >= cap) throw rateLimited("Too many password attempts.", "Wait before trying again.", Math.max(1, Math.ceil(((stored.window + 1) * windowMs - Date.now()) / 1000)));
  }
  throw new ApiError(503, "transfer_unlock_unavailable", "Password unlock is unavailable.", "Retry later.");
}
/** Separate namespaces prevent site password attempts from consuming transfer budgets. */
export async function spendSitePasswordAttempt(dc: DropwayContext, siteId: string, ip: string) {
  await spendUnlock(dc, `site-ip:${await sha256Hex(`${signingSecret(dc.config)}:${ip}`)}`, 10);
  await spendUnlock(dc, `site:${siteId}`, 30);
}

export async function unlockTransfer(dc: DropwayContext, t: PublicTransfer, password: unknown, ip: string) {
  checkTransferGate(t);
  await spendUnlock(dc, `ip:${await sha256Hex(`${signingSecret(dc.config)}:${ip}`)}`, 10);
  await spendUnlock(dc, `transfer:${t.id}`, 30);
  const value = validateTransferPassword(password);
  if (!value || !t.password_hash || !await verifyPassword(value, t.password_hash)) throw forbidden("Incorrect password.", "Ask the sender for the delivery password.", "transfer_locked");
  return makeTransferGrant(dc, t);
}

/** Atomic state recheck and accounting, after a real blob/range has been opened. */
export async function recordTransferDownload(dc: DropwayContext, t: PublicTransfer, file: TransferFile, recipientToken: string | null, count: boolean) {
  const recipients = transferRecipients(t);
  const index = recipientToken ? recipients.findIndex((r) => r.token === recipientToken) : -1;
  if (recipientToken && index < 0) throw transferMissing();
  if (!count) {
    const fresh = await publicTransfer(dc, t.slug);
    await publicTransferFile(dc, fresh, file.path);
    checkTransferGate(fresh);
    if (fresh.password_hash !== t.password_hash) throw forbidden("Password required.", "Unlock the delivery again.", "transfer_locked");
    return;
  }
  const mutation = newSecret("dwd_");
  const increment = count ? 1 : 0;
  const recipientPath = index >= 0 && count ? `$[${index}].downloads` : null;
  const [updated] = await dc.env.DB.batch([
    dc.env.DB.prepare(`UPDATE transfers SET downloads = downloads + ?, mutation_id = ?,
      recipients_json = CASE WHEN ? IS NULL THEN recipients_json ELSE json_set(recipients_json, ?, json_extract(recipients_json, ?) + 1) END
      WHERE id = ? AND revision = ? AND deleted_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL
        AND takedown_at IS NULL AND purged_at IS NULL AND expires_at >= ? AND (download_limit IS NULL OR downloads < download_limit)
        AND EXISTS (SELECT 1 FROM sites WHERE id = site_id AND deleted_at IS NULL AND password_hash IS ?)`)
      .bind(increment, mutation, recipientPath, recipientPath, recipientPath, t.id, t.revision, Date.now(), t.password_hash),
    dc.env.DB.prepare(`UPDATE transfer_files SET downloads = downloads + ? WHERE transfer_id = ? AND path = ?
      AND EXISTS (SELECT 1 FROM transfers WHERE id = ? AND mutation_id = ?)`)
      .bind(increment, t.id, file.path, t.id, mutation),
  ]);
  if (!updated?.meta.changes) {
    const fresh = await publicTransfer(dc, t.slug);
    await publicTransferFile(dc, fresh, file.path);
    checkTransferGate(fresh);
    if (fresh.password_hash !== t.password_hash) throw forbidden("Password required.", "Unlock the delivery again.", "transfer_locked");
    throw transferConflict();
  }
}

export async function openTransferDownload(dc: DropwayContext, request: Request, slug: string, path: string) {
  const origin = new URL(request.url).origin;
  const isolated = dc.config.sitesOrigin || (dc.config.sitesMode === "subdomain" && dc.config.sitesDomain);
  if (!isolated || origin !== new URL(siteUrl(dc, slug)).origin || (dc.config.appOrigin && origin === new URL(dc.config.appOrigin).origin)) throw transferMissing();
  const t = await publicTransfer(dc, slug);
  const file = await publicTransferFile(dc, t, path);
  checkTransferGate(t);
  if (!await transferUnlocked(dc, t, request)) return { locked: true as const, transfer: t };
  const recipient = new URL(request.url).searchParams.get("recipient");
  if (recipient && !transferRecipients(t).some((r) => r.token === recipient)) throw transferMissing();
  let offset = 0;
  let length = file.size;
  const range = request.headers.get("Range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match?.[1];
    const end = match?.[2];
    if (!match || (!start && !end)) throw new ApiError(416, "invalid_transfer_range", "Invalid byte range.", "Request one satisfiable byte range.");
    offset = start ? Number(start) : Math.max(0, file.size - Number(end));
    const last = start ? (end ? Math.min(Number(end), file.size - 1) : file.size - 1) : file.size - 1;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(last) || offset < 0 || offset >= file.size || last < offset) throw new ApiError(416, "invalid_transfer_range", "Invalid byte range.", "Request one satisfiable byte range.");
    length = last - offset + 1;
  }
  const body = range ? await readBlobRange(dc, file.sha256, { offset, length }) : (await readBlob(dc, file.sha256, file.size))?.body;
  if (!body) throw transferMissing();
  try {
    await recordTransferDownload(dc, t, file, recipient, request.method === "GET" && (!range || offset === 0));
  } catch (error) {
    await body.cancel();
    throw error;
  }
  if (request.method === "HEAD") await body.cancel();
  return { locked: false as const, transfer: t, file, body: request.method === "HEAD" ? null : body, offset, length, ranged: !!range };
}
