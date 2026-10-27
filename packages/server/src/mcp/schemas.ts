/**
 * JSON Schemas shared by the MCP tools (inputs) and their results (outputs).
 * Inputs are flat (no oneOf) because several model APIs mishandle unions.
 * Descriptions here repeat in every tool that uses the schema, so keep them
 * short: the serialized tool list has a size budget (test/mcp.test.ts).
 */

type Schema = Record<string, unknown>;

export const SITE_REF: Schema = {
  type: "string",
  minLength: 1,
  description: "Site slug, site_... id or URL.",
};

export const VERSION_REF: Schema = {
  type: "string",
  minLength: 1,
  description: '"live", "v3"/"3", or a ver_... id.',
};

const COPY_FROM: Schema = {
  type: "object",
  description: "Copy a published file: site you can read (default: this site), version (default: live), path (default: same).",
  properties: { site: SITE_REF, version: VERSION_REF, path: { type: "string" } },
  additionalProperties: false,
};

export const FILE_INPUT: Schema = {
  type: "object",
  description: "A path plus exactly one source (content, url, sha256 or copyFrom).",
  properties: {
    path: { type: "string", minLength: 1, description: 'Path inside the site, e.g. "index.html" or "docs/guide.md".' },
    content: {
      type: "string",
      description: 'Text (encoding "utf8", up to 1 MB) or base64 bytes (up to 256 KB). For bigger/binary files prefer url or sha256.',
    },
    encoding: { type: "string", enum: ["utf8", "base64"], description: 'Default "utf8".' },
    url: { type: "string", description: "Public https URL (URL_FETCH_MAX_BYTES default 100 MiB; 30 s, 3 redirects; other caps)." },
    headers: { type: "object", additionalProperties: { type: "string" }, description: "Headers for the url download, e.g. Authorization; used once, never stored." },
    sha256: {
      type: "string",
      pattern: "^[a-fA-F0-9]{64}$",
      description: "Hex SHA-256 of the bytes. Stored: reused at once. Not stored: the result lists an upload link (PUT, then finalize_version).",
    },
    size: { type: "integer", minimum: 0, description: "Bytes; required with sha256 if not stored yet." },
    copyFrom: COPY_FROM,
    contentType: { type: "string", description: "MIME type; default from extension." },
  },
  required: ["path"],
  additionalProperties: false,
};

export const SETTINGS_INPUT = {
  title: { type: ["string", "null"], maxLength: 200, description: "Title shown in lists." },
  description: { type: ["string", "null"], maxLength: 2000, description: "One or two sentences about the site." },
  spa: { type: "boolean", description: "SPA: unknown paths serve index.html instead of 404." },
  renderMarkdown: { type: "boolean", description: "Render .md files as pages for browsers (default true); false serves raw." },
  crossOriginIsolation: { type: "boolean", description: "Send COOP/COEP headers (for SharedArrayBuffer/threaded WASM)." },
  noindex: { type: "boolean" },
  viewers: { type: "boolean" },
  ttlSeconds: { type: ["integer", "null"], minimum: 1, maximum: 315360000 },
} satisfies Record<string, Schema>;

export const IDEMPOTENCY_KEY: Schema = {
  type: "string",
  minLength: 1,
  maxLength: 255,
  description: "Retry key (24 h): same args replay; different args return 422.",
};

export const CONFIRM_SLUG: Schema = { type: "string", description: "Must equal the site's slug (destructive confirmation)." };

// ---------------------------------------------------------------- outputs
// Deliberately small: clients validate structuredContent against these, and some send
// them to the model, so they name the key fields and allow everything else.

export const VERSION_OUT: Schema = {
  type: "object",
  properties: { id: { type: "string" }, number: { type: "integer" }, status: { type: "string" }, live: { type: "boolean" } },
  required: ["id", "number", "status", "live"],
};

export const SITE_OUT: Schema = {
  type: "object",
  properties: { slug: { type: "string" }, url: { type: "string" }, currentVersionId: { type: ["string", "null"] } },
  required: ["slug", "url"],
};

export const PUBLISH_OUT: Schema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["live", "unchanged", "awaiting_upload"] },
    url: { type: "string", description: "Live URL. Share it exactly as returned." },
    slug: { type: "string" },
    versionUrl: { type: "string", description: "24 h signed preview; bearer capability." },
    site: SITE_OUT,
    version: { type: ["object", "null"] },
    files: { type: "object" },
    upload: { type: "object", description: "Only for awaiting_upload: items to PUT, then finalize." },
    warnings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          path: { type: "string" },
          line: { type: "integer" },
          fix: { type: "string" },
        },
      },
    },
    next: { type: "array" },
  },
  required: ["status", "url", "slug"],
};

export const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", properties, required });
