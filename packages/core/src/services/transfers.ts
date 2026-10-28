import type { DropwayContext } from "../context";
import { appOrigin, siteFileUrl, siteUrl } from "../context";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../errors";
import { hashPassword, newSecret, verifyPassword } from "../lib/crypto";
import { requireMember, type Principal } from "../principal";
import { blobScope, putVerifiedBlob } from "./blobs";
import { createDeploy, finalizeDeploy, missingForScope } from "./deploys";
import { emit } from "./events";
import { createSite, discardNewSite } from "./sites";
import { resolveFileInputs } from "./sources";

export const TRANSFER_DAY = 86_400_000;
export interface TransferRecipient { email: string; token: string; downloads: number }
export interface TransferRow {
  id: string; site_id: string; tenant_id: string; member_id: string; slug: string;
  message: string | null; recipients_json: string; expires_at: number; download_limit: number | null;
  downloads: number; revision: number; revoked_at: number | null; expired_at: number | null;
  deleted_at: number | null; takedown_at: number | null; legal_hold: number; notified_at: number | null;
  purged_at: number | null; storage_bytes: number; created_at: number;
}
export interface TransferFile {
  path: string; sha256: string; size: number; content_type: string; downloads: number;
}
export interface TransferInput {
  slug?: string; files?: unknown; recipients?: string[]; message?: string | null;
  password?: string | null; currentPassword?: string; expiresAt?: number; downloadLimit?: number | null;
}
export const transferMissing = () => notFound("transfer_not_found", "No transfer available to this caller.", "Check the transfer reference and use its sender's key.");
export const transferConflict = () => conflict("transfer_conflict", "The transfer changed or no longer permits this operation.", "Read the transfer again; closed or notified deliveries cannot be edited.");

export function transferRecipients(t: TransferRow): TransferRecipient[] { return JSON.parse(t.recipients_json); }
export function transferPageUrl(dc: DropwayContext, slug: string, recipient?: string) {
  return `${appOrigin(dc)}/t/${encodeURIComponent(slug)}${recipient ? `?recipient=${encodeURIComponent(recipient)}` : ""}`;
}
export function transferFileUrl(dc: DropwayContext, slug: string, path: string, recipient?: string) {
  const url = new URL(siteFileUrl(dc, slug, path));
  if (recipient) url.searchParams.set("recipient", recipient);
  return url.href;
}

function recipientsOf(input: string[]): string[] {
  if (!Array.isArray(input) || input.length > 1000) throw badRequest("invalid_transfer", "Recipients must be an array of email addresses.", "Supply at most 50 distinct addresses.");
  const out = [...new Set(input.map((s) => typeof s === "string" ? s.trim().toLowerCase() : ""))];
  if (out.length > 50 || out.some((s) => s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))) {
    throw badRequest("invalid_transfer", "Invalid recipient list.", "Supply at most 50 distinct, valid email addresses.");
  }
  return out;
}
export function validateTransferPassword(password: unknown): string | null {
  if (password === null || password === "") return null;
  if (typeof password !== "string" || password.length < 8 || password.length > 1024 || password.includes("\0")) {
    throw badRequest("invalid_transfer_password", "Invalid transfer password.", "Use 8-1,024 characters without NUL, or an empty string for no password.");
  }
  return password;
}
async function validate(dc: DropwayContext, p: Principal, input: TransferInput, siteId: string | null) {
  const member = requireMember(p, "sites:write");
  if (input.message !== undefined && input.message !== null && (typeof input.message !== "string" || input.message.length > 10_000)) {
    throw badRequest("invalid_transfer", "The message is too long or not text.", "Use at most 10,000 characters of plain text.");
  }
  if (input.password !== undefined) validateTransferPassword(input.password);
  if (input.recipients !== undefined) recipientsOf(input.recipients);
  if (input.downloadLimit !== undefined && input.downloadLimit !== null && (!Number.isInteger(input.downloadLimit) || input.downloadLimit < 1 || input.downloadLimit > 10_000)) {
    throw badRequest("invalid_transfer", "Invalid download limit.", "Use an integer from 1 to 10,000, or null for no limit.");
  }
  const limits = await dc.adapters.policy.limits(p, { tenantId: member.tenantId, siteId }, dc);
  const instanceDays = Math.min(3650, dc.config.limits.transferMaxExpiryDays ?? 30);
  const days = Math.min(instanceDays, limits.transferMaxExpiryDays ?? instanceDays);
  if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < Date.now() + 3_600_000 || input.expiresAt > Date.now() + days * TRANSFER_DAY)) {
    throw badRequest("invalid_transfer_expiry", "Invalid transfer expiry.", `Choose a deadline from one hour to ${days} days from now.`);
  }
  return { member, limits, days };
}
export async function ownedTransfer(dc: DropwayContext, p: Principal, reference: string, write = false): Promise<TransferRow> {
  const member = requireMember(p, write ? "sites:write" : "sites:read");
  const t = await dc.env.DB.prepare("SELECT * FROM transfers WHERE (id = ? OR slug = ?) AND tenant_id = ? AND member_id = ? AND deleted_at IS NULL")
    .bind(reference, reference, member.tenantId, member.memberId).first<TransferRow>();
  if (!t || (member.siteId && member.siteId !== t.site_id)) throw transferMissing();
  return t;
}
export async function describeTransfer(dc: DropwayContext, t: TransferRow) {
  const { results: files } = await dc.env.DB.prepare("SELECT * FROM transfer_files WHERE transfer_id = ? ORDER BY path").bind(t.id).all<TransferFile>();
  return {
    id: t.id, slug: t.slug, mode: "transfer" as const, url: transferPageUrl(dc, t.slug), message: t.message,
    expiresAt: t.expires_at, downloadLimit: t.download_limit, downloads: t.downloads,
    revokedAt: t.revoked_at, expiredAt: t.expired_at, purgedAt: t.purged_at, revision: t.revision,
    recipients: transferRecipients(t).map((r) => ({ email: r.email, url: transferPageUrl(dc, t.slug, r.token), downloads: r.downloads })),
    files: files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, contentType: f.content_type, downloads: f.downloads })),
  };
}
export async function getTransfer(dc: DropwayContext, p: Principal, reference: string) {
  return describeTransfer(dc, await ownedTransfer(dc, p, reference));
}
export function transferEvent(dc: DropwayContext, t: Pick<TransferRow, "id" | "revision">, type: "transfer.created" | "transfer.updated" | "transfer.revoked" | "transfer.expired") {
  emit(dc, "onEvent", { id: `${t.id}:${t.revision}:${type}`, type, transferId: t.id, at: Date.now() });
}

export async function createTransfer(dc: DropwayContext, p: Principal, input: TransferInput) {
  const { member, limits, days } = await validate(dc, p, input, null);
  if (new URL(siteUrl(dc, input.slug ?? "delivery")).origin === new URL(appOrigin(dc)).origin) {
    throw new ApiError(409, "transfer_origin_required", "Transfers require a separate sites origin.", "Configure SITES_ORIGIN or subdomain serving before creating transfers.");
  }
  const resolved = await resolveFileInputs(dc, p, input.files, { lim: limits, scope: `t:${member.tenantId}`, site: null });
  const missing = await missingForScope(dc, `t:${member.tenantId}`, resolved.files.filter((f) => !f.bytes).map((f) => f.sha256));
  if (missing.length) throw badRequest("missing_blobs", "Transfer files must already be uploaded.", "Supply inline files, URLs, or hashes already stored by your tenant.");
  const { site } = await createSite(dc, p, { slug: input.slug, password: input.password || null });
  const now = Date.now();
  const expiresAt = input.expiresAt ?? now + Math.min(7, days) * TRANSFER_DAY;
  const recipients = recipientsOf(input.recipients ?? []).map((email) => ({ email, token: newSecret("dwr_"), downloads: 0 }));
  try {
    await dc.env.DB.batch([
      dc.env.DB.prepare("UPDATE sites SET mode = 'transfer' WHERE id = ?").bind(site.id),
      dc.env.DB.prepare(`INSERT INTO transfers (id, site_id, tenant_id, member_id, slug, message, recipients_json, expires_at, download_limit, storage_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(site.id, site.id, member.tenantId, member.memberId, site.slug, input.message ?? null, JSON.stringify(recipients), expiresAt, input.downloadLimit ?? null, resolved.files.reduce((n, f) => n + f.size, 0), now),
      dc.env.DB.prepare("INSERT OR IGNORE INTO transfer_slug_tombstones VALUES (?, ?, ?)").bind(site.slug, member.tenantId, member.memberId),
    ]);
    const initial = { ...site, mode: "transfer" as const };
    const deploy = await createDeploy(dc, p, initial, resolved.files, { source: "transfer", transferCreate: true });
    for (const f of resolved.files) if (f.bytes) await putVerifiedBlob(dc, blobScope({ tenantId: member.tenantId, siteId: site.id }), f.sha256, f.bytes, f.size, f.contentType);
    await dc.env.DB.prepare(`INSERT INTO transfer_files (transfer_id, path, sha256, size, content_type)
      SELECT ?, path, sha256, size, content_type FROM version_files WHERE version_id = ?`).bind(site.id, deploy.deploy.id).run();
    await finalizeDeploy(dc, p, initial, deploy.deploy.id, true);
  } catch (error) {
    // Finalization may have committed before a cache or notification failed.
    // Retain lifecycle ownership and usage unless the real references were removed.
    if (await discardNewSite(dc, site)) {
      await dc.env.DB.batch([
        dc.env.DB.prepare("UPDATE transfers SET purged_at = ?, deleted_at = ? WHERE id = ?").bind(Date.now(), Date.now(), site.id),
        dc.env.DB.prepare("DELETE FROM transfer_files WHERE transfer_id = ?").bind(site.id),
        dc.env.DB.prepare("DELETE FROM transfers WHERE id = ?").bind(site.id),
      ]);
    }
    throw error;
  }
  const t = await ownedTransfer(dc, p, site.id);
  transferEvent(dc, t, "transfer.created");
  return describeTransfer(dc, t);
}

// Exhaustion forbids new downloads/edits, but the sender must still be able
// to revoke outstanding continuation credentials, including via allLive.
const REVOKABLE = "revoked_at IS NULL AND expired_at IS NULL AND deleted_at IS NULL AND expires_at >= ? AND takedown_at IS NULL";
const LIVE = `${REVOKABLE} AND (download_limit IS NULL OR downloads < download_limit) AND legal_hold = 0`;
function assertMutable(t: TransferRow, update: boolean) {
  if (t.revoked_at !== null || t.expired_at !== null || t.deleted_at !== null || t.expires_at < Date.now() || t.takedown_at !== null || (update && ((t.download_limit !== null && t.downloads >= t.download_limit) || t.legal_hold || t.notified_at !== null))) throw transferConflict();
}
export async function updateTransfer(dc: DropwayContext, p: Principal, reference: string, input: TransferInput) {
  const t = await ownedTransfer(dc, p, reference, true);
  assertMutable(t, true);
  await validate(dc, p, input, t.site_id);
  const current = await dc.env.DB.prepare("SELECT password_hash FROM sites WHERE id = ?").bind(t.site_id).first<{ password_hash: string | null }>();
  let digest = current?.password_hash ?? null;
  if (input.password !== undefined) {
    if (digest && (!input.currentPassword || input.currentPassword.length > 1024 || input.currentPassword.includes("\0") || !await verifyPassword(input.currentPassword, digest))) {
      throw forbidden("Current password proof is required in this call.", "Send the currentPassword together with the new password.", "transfer_password_proof_required");
    }
    const password = validateTransferPassword(input.password);
    if (password === null) digest = null;
    else if (!digest || !await verifyPassword(password, digest)) digest = await hashPassword(password);
  }
  const existing = transferRecipients(t);
  const emails = input.recipients === undefined ? existing.map((r) => r.email) : recipientsOf(input.recipients);
  const recipientChanged = [...emails].sort().join("\0") !== existing.map((r) => r.email).sort().join("\0");
  const recipients = recipientChanged ? emails.map((email) => existing.find((r) => r.email === email) ?? { email, token: newSecret("dwr_"), downloads: 0 }) : existing;
  const message = input.message === undefined ? t.message : input.message;
  const expiry = input.expiresAt ?? t.expires_at;
  const limit = input.downloadLimit === undefined ? t.download_limit : input.downloadLimit;
  if (message === t.message && expiry === t.expires_at && limit === t.download_limit && !recipientChanged && digest === current?.password_hash) return describeTransfer(dc, t);
  const mutation = newSecret("dwm_");
  const [updated] = await dc.env.DB.batch([
    // Download counts do not change the management revision. Merge retained
    // recipients' counts from the current row, not the pre-validation snapshot.
    dc.env.DB.prepare(`UPDATE transfers SET message = ?, expires_at = ?, download_limit = ?,
      recipients_json = CASE WHEN ? = 0 THEN recipients_json ELSE
        (SELECT json_group_array(json_set(incoming.value, '$.downloads', COALESCE(
          (SELECT json_extract(stored.value, '$.downloads') FROM json_each(transfers.recipients_json) stored
            WHERE json_extract(stored.value, '$.token') = json_extract(incoming.value, '$.token')), 0)))
          FROM json_each(?) incoming) END,
      revision = revision + 1, mutation_id = ?
      WHERE id = ? AND revision = ? AND ${LIVE} AND notified_at IS NULL`).bind(message, expiry, limit, recipientChanged ? 1 : 0, JSON.stringify(recipients), mutation, t.id, t.revision, Date.now()),
    dc.env.DB.prepare(`UPDATE sites SET password_hash = ?, updated_at = ? WHERE id = ? AND EXISTS
      (SELECT 1 FROM transfers WHERE id = ? AND mutation_id = ?)`).bind(digest, Date.now(), t.site_id, t.id, mutation),
  ]);
  if (!updated?.meta.changes) throw transferConflict();
  const changed = await ownedTransfer(dc, p, t.id);
  transferEvent(dc, changed, "transfer.updated");
  return describeTransfer(dc, changed);
}
export async function revokeTransfers(dc: DropwayContext, p: Principal, input: { ids?: string[]; allLive?: boolean }) {
  const member = requireMember(p, "sites:write");
  if ((!input.allLive && !input.ids?.length) || (input.allLive && input.ids !== undefined) || (input.ids && input.ids.length > 100)) throw badRequest("invalid_transfer", "Choose transfer IDs or allLive.", "Supply 1-100 IDs, or allLive: true, not both.");
  const rows = input.allLive
    ? (await dc.env.DB.prepare(`SELECT * FROM transfers WHERE tenant_id = ? AND member_id = ? AND ${REVOKABLE} ${member.siteId ? "AND site_id = ?" : ""}`).bind(member.tenantId, member.memberId, Date.now(), ...(member.siteId ? [member.siteId] : [])).all<TransferRow>()).results
    : await Promise.all([...new Set(input.ids!)].map((id) => ownedTransfer(dc, p, id, true)));
  for (const t of rows) assertMutable(t, false);
  if (!rows.length) return { count: 0 };
  // Materialize the full eligibility decision before changing any row. A stale
  // member of a bulk request must not leave earlier deliveries partly revoked.
  const { results: changed } = await dc.env.DB.prepare(`WITH expected AS MATERIALIZED
      (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS revision FROM json_each(?)),
    eligible AS MATERIALIZED (SELECT t.id FROM transfers t JOIN expected e ON t.id = e.id AND t.revision = e.revision WHERE ${REVOKABLE}),
    readiness AS MATERIALIZED (SELECT (SELECT COUNT(*) FROM expected) = (SELECT COUNT(*) FROM eligible) AS ready)
    UPDATE transfers SET revoked_at = ?, revision = revision + 1
    WHERE id IN (SELECT id FROM eligible) AND (SELECT ready FROM readiness) RETURNING id, revision`)
    .bind(JSON.stringify(rows.map((t) => [t.id, t.revision])), Date.now(), Date.now()).all<{ id: string; revision: number }>();
  if (changed.length !== rows.length) throw transferConflict();
  for (const t of changed) transferEvent(dc, t, "transfer.revoked");
  return { count: changed.length };
}
