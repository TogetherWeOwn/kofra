import { completeMultipartUpload, createMultipartUpload, getMultipartUpload, uploadMultipartPart, MULTIPART_DEFAULT_PART_BYTES, MULTIPART_MAX_PART_BYTES, MULTIPART_MIN_PART_BYTES } from "@dropway/core";
import { defineOperation } from "../operations";
import { fromSchema, RO, WRITE, P, D } from "./shared";

const SHA = "a".repeat(64);
const SESSION_OUT = {
  type: "object",
  properties: {
    id: { type: "string" },
    versionId: { type: "string" },
    sha256: { type: "string" },
    size: { type: "integer" },
    partSize: { type: "integer" },
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: { partNumber: { type: "integer" }, size: { type: "integer" }, etag: { type: "string" } },
        required: ["partNumber", "size", "etag"],
      },
    },
    status: { type: "string" },
    expiresAt: { type: "string" },
  },
  required: ["id", "sha256", "size", "partSize", "parts"],
} as const;

const sessionExample = {
  id: "upl_example",
  versionId: "ver_example",
  sha256: SHA,
  size: 157286400,
  partSize: MULTIPART_DEFAULT_PART_BYTES,
  parts: [],
  status: "active",
  expiresAt: "2026-10-27T00:00:00.000Z",
};

/**
 * Resumable multipart upload (R-35): one pending manifest file staged
 * through R2 multipart in 10-95 MiB parts, hash-verified on completion.
 * REST/CLI protocol only — raw part bytes and session orchestration never
 * pass through MCP, like upload_blob.
 */
export const UPLOAD_OPERATIONS = [
  defineOperation({
    id: "create_multipart_upload",
    method: "POST",
    path: "/api/v1/uploads",
    summary: "Start a resumable multipart upload",
    toolset: "versions",
    scopes: ["sites:write"],
    description:
      "Start staging one file of a pending version through R2 multipart: pass versionId and the file's sha256. partSize is 10-95 MiB (default 50 MiB); every part but the last holds exactly partSize bytes. The credential must control that pending version (an owner's API key, a claim token or the version's own dwu_ upload token).",
    input: fromSchema({
      type: "object",
      properties: {
        versionId: { type: "string", minLength: 1, description: "Pending version id returned with status awaiting_upload." },
        sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$", description: "SHA-256 of the whole file, as listed in the pending manifest." },
        partSize: { type: "integer", minimum: MULTIPART_MIN_PART_BYTES, maximum: MULTIPART_MAX_PART_BYTES, description: `Part size in bytes, ${MULTIPART_MIN_PART_BYTES}-${MULTIPART_MAX_PART_BYTES}; default ${MULTIPART_DEFAULT_PART_BYTES}.` },
      },
      required: ["versionId", "sha256"],
      additionalProperties: false,
    }),
    output: fromSchema(SESSION_OUT),
    annotations: WRITE,
    mcp: { exclude: "REST/CLI resumable-upload protocol; part bytes never pass through the model" },
    http: { status: 201 },
    async handler(a, { dw, principal }) {
      return createMultipartUpload(dw, principal, a);
    },
    examples: [{ input: { versionId: "ver_example", sha256: SHA }, output: sessionExample }],
  }),
  defineOperation({
    id: "get_multipart_upload",
    method: "GET",
    path: "/api/v1/uploads/{id}",
    summary: "Show a resumable upload's acknowledged parts",
    toolset: "versions",
    scopes: ["sites:write"],
    description:
      "List the parts this upload session has acknowledged (partNumber, size, etag) so an interrupted upload resumes by sending only the missing parts. The credential must control the session's pending version.",
    input: fromSchema({
      type: "object",
      properties: { id: { type: "string", minLength: 1, description: "Upload session id from POST /api/v1/uploads." } },
      required: ["id"],
      additionalProperties: false,
    }),
    output: fromSchema(SESSION_OUT),
    annotations: RO,
    mcp: { exclude: "REST/CLI resumable-upload protocol; part bytes never pass through the model" },
    async handler(a, { dw, principal }) {
      return getMultipartUpload(dw, principal, a.id);
    },
    examples: [{ input: { id: "upl_example" }, output: { ...sessionExample, parts: [{ partNumber: 1, size: MULTIPART_DEFAULT_PART_BYTES, etag: "etag-example" }] } }],
  }),
  defineOperation({
    id: "upload_multipart_part",
    method: "PUT",
    path: "/api/v1/uploads/{id}/parts/{partNumber}",
    summary: "Upload one part's raw bytes",
    toolset: "versions",
    scopes: ["sites:write"],
    description:
      "Body = exactly this part's bytes, with Content-Length (a one-based partNumber; every part but the last holds partSize bytes). Acknowledged only when the length matches. Repeating a part with identical bytes replays the acknowledgement; different bytes are refused.",
    input: fromSchema({
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        partNumber: { type: "integer", minimum: 1, description: "One-based part number." },
      },
      required: ["id", "partNumber"],
      additionalProperties: false,
    }),
    output: fromSchema({
      type: "object",
      properties: { partNumber: { type: "integer" }, size: { type: "integer" }, etag: { type: "string" } },
      required: ["partNumber", "size", "etag"],
    }),
    annotations: WRITE,
    mcp: { exclude: "raw bytes never pass through the model; PUT them from a shell or the CLI" },
    rawBody: true,
    http: {
      handler: async (c) => {
        const len = c.req.header("content-length");
        const out = await uploadMultipartPart(D(c), P(c), c.req.param("id")!, c.req.param("partNumber")!, c.req.raw.body, len === undefined ? null : Number(len));
        return c.json(out, 201);
      },
      contentTypes: ["application/octet-stream"],
    },
    examples: [{ input: { id: "upl_example", partNumber: 1 }, output: { partNumber: 1, size: MULTIPART_DEFAULT_PART_BYTES, etag: "etag-example" } }],
    async handler() {
      throw new Error("REST transport required");
    },
  }),
  defineOperation({
    id: "complete_multipart_upload",
    method: "POST",
    path: "/api/v1/uploads/{id}/complete",
    summary: "Complete and verify a resumable upload",
    toolset: "versions",
    scopes: ["sites:write"],
    description:
      "Assemble the acknowledged parts, stream-hash the result, and only then store it as blobs/<sha256> for the caller's pending version to finalize. Client-supplied part lists are ignored; the acknowledged parts decide. Safe to repeat.",
    input: fromSchema({
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        parts: { type: "array", items: { type: "object", additionalProperties: true }, description: "Ignored; the server uses its acknowledged parts." },
      },
      required: ["id"],
      additionalProperties: false,
    }),
    output: fromSchema({
      type: "object",
      properties: { sha256: { type: "string" }, size: { type: "integer" }, stored: { type: "boolean" } },
      required: ["sha256", "size"],
    }),
    annotations: WRITE,
    mcp: { exclude: "REST/CLI resumable-upload protocol; part bytes never pass through the model" },
    async handler(a, { dw, principal }) {
      return completeMultipartUpload(dw, principal, a.id);
    },
    examples: [{ input: { id: "upl_example" }, output: { sha256: SHA, size: 157286400, stored: true } }],
  }),
];
