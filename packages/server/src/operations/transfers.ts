import { z } from "zod";
import { createTransfer, getTransfer, updateTransfer, revokeTransfers } from "@kofra/core";
import { defineOperation } from "../operations";
import { CREATE, RO, WRITE } from "./shared";

const fields = {
  recipients: z.array(z.string()).optional().describe("Up to 50 normalized distinct email addresses; links are returned, not mailed."),
  message: z.string().nullable().optional().describe("Plain text, at most 10,000 characters."),
  password: z.string().nullable().optional().describe("8-1,024 characters without NUL; empty or null clears protection."),
  expiresAt: z.number().optional().describe("Unix milliseconds, from one hour to the instance's transfer expiry ceiling."),
  downloadLimit: z.number().nullable().optional().describe("1-10,000 counted downloads across all files and links; null means unlimited."),
};
// Keep discovery compact; the result also carries message, limits, state and counters.
const result = z.looseObject({ id: z.string(), slug: z.string(), mode: z.literal("transfer"), url: z.string(), expiresAt: z.number() });
const sample = { id: "site_delivery", slug: "delivery-sample", mode: "transfer", url: "https://kofra.example/t/delivery-sample", message: null, expiresAt: 1988150400000, downloadLimit: null, downloads: 0, revision: 0, revokedAt: null, expiredAt: null, purgedAt: null, recipients: [], files: [] };

export const TRANSFER_OPERATIONS = [
  defineOperation({
    id: "create_transfer", method: "POST", path: "/api/v1/transfers", toolset: "transfers", scopes: ["sites:write"],
    summary: "Create a file delivery", description: "Create an expiring, optionally password-protected delivery. Files are immutable downloads on the separate sites host. Returns one general link and one per recipient. No email is sent by this operation.",
    input: z.object({ slug: z.string().optional(), files: z.array(z.record(z.string(), z.unknown())), ...fields }), output: result,
    annotations: CREATE, cli: { command: ["transfers", "create"] }, http: { status: 201, statuses: [201] },
    async handler(a, { dw, principal }) { return createTransfer(dw, principal, a); },
    tool: { idempotent: true, summarize: (r) => `Delivery ready: ${r.url}` },
    examples: [{ input: { files: [{ path: "note.txt", content: "Hello" }] }, output: sample }],
  }),
  defineOperation({
    id: "get_transfer", method: "GET", path: "/api/v1/transfers/{transfer}", toolset: "transfers", scopes: ["sites:read"],
    summary: "Read your file delivery", description: "Read sender-visible delivery state, links, files and per-file and recipient download counts. Closed deliveries remain readable. A foreign or absent delivery returns the same 404.",
    input: z.object({ transfer: z.string() }), output: result, annotations: RO,
    cli: { command: ["transfers", "get"], positional: ["transfer"] },
    async handler(a, { dw, principal }) { return getTransfer(dw, principal, a.transfer); },
    examples: [{ input: { transfer: "site_delivery" }, output: sample }],
  }),
  defineOperation({
    id: "update_transfer", method: "PATCH", path: "/api/v1/transfers/{transfer}", toolset: "transfers", scopes: ["sites:write"],
    summary: "Edit an unnotified live delivery", description: "Change message, expiry, recipients, download limit or password while live and unnotified. A set password needs currentPassword in this call to change or clear it. Concurrent changes conflict; semantic no-ops emit no event.",
    input: z.object({ transfer: z.string(), ...fields, currentPassword: z.string().optional() }), output: result, annotations: WRITE,
    cli: { command: ["transfers", "update"], positional: ["transfer"] },
    async handler(a, { dw, principal }) { return updateTransfer(dw, principal, a.transfer, a); },
    examples: [{ input: { transfer: "site_delivery", message: "Updated note" }, output: { ...sample, message: "Updated note", revision: 1 } }],
  }),
  defineOperation({
    id: "revoke_transfers", method: "POST", path: "/api/v1/transfers/revoke", toolset: "transfers", scopes: ["sites:write"],
    summary: "Revoke file deliveries", description: "Immediately stop downloads for named deliveries or all live deliveries owned by the caller. Returns the changed count. Bytes and storage accounting remain until the retention purge; owner reads still work.",
    input: z.object({ ids: z.array(z.string()).optional(), allLive: z.boolean().optional() }), output: z.object({ count: z.number() }),
    annotations: { ...WRITE, destructiveHint: true }, cli: { command: ["transfers", "revoke"] },
    async handler(a, { dw, principal }) { return revokeTransfers(dw, principal, a); },
    examples: [{ input: { ids: ["site_delivery"] }, output: { count: 1 } }],
  }),
];
