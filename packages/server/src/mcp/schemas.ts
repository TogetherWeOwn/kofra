/**
 * JSON Schemas shared by the MCP tools (inputs) and their results (outputs).
 * Inputs are flat (no oneOf) because several model APIs mishandle unions.
 */

type Schema = Record<string, unknown>;

export const SITE_REF: Schema = {
  type: "string",
  minLength: 1,
  description: "Site slug, site_... id, or site URL.",
};

export const VERSION_REF: Schema = {
  type: "string",
  minLength: 1,
  description: 'A version: "live", "v3" or "3" (version number 3), or a version id (ver_...).',
};

const COPY_FROM: Schema = {
  type: "object",
  description: "Copy a file you already published: from a site you can read (default: this site), a version (default: live) and a path (default: the same path).",
  properties: { site: SITE_REF, version: VERSION_REF, path: { type: "string" } },
  additionalProperties: false,
};

export const FILE_INPUT: Schema = {
  type: "object",
  description: "One file: a path plus exactly one source (content, url, sha256 or copyFrom).",
  properties: {
    path: { type: "string", minLength: 1, description: 'Path inside the site, e.g. "index.html", "docs/guide.md", "assets/app.js".' },
    content: {
      type: "string",
      description: 'The file itself: text (encoding "utf8", up to 1 MB) or base64 bytes (encoding "base64", up to 256 KB). For bigger or binary files prefer url or sha256.',
    },
    encoding: { type: "string", enum: ["utf8", "base64"], description: 'How content is encoded. Default "utf8".' },
    url: { type: "string", description: "Public https URL to download. URL_FETCH_MAX_BYTES (default 100 MiB), 30 s, 3 redirects; file/request caps also apply." },
    headers: { type: "object", additionalProperties: { type: "string" }, description: "Request headers for the url download, e.g. Authorization. Used once, never stored." },
    sha256: {
      type: "string",
      pattern: "^[a-fA-F0-9]{64}$",
      description: "Hex SHA-256 of the bytes. Already stored: reused at once. Not stored: the result lists an upload link (PUT the bytes, then finalize_version).",
    },
    size: { type: "integer", minimum: 0, description: "Size in bytes. Required with sha256 when the bytes are not stored yet." },
    copyFrom: COPY_FROM,
    contentType: { type: "string", description: "MIME type. Default: from the file extension." },
  },
  required: ["path"],
  additionalProperties: false,
};

export const SETTINGS_INPUT = {
  title: { type: ["string", "null"], maxLength: 200, description: "Title shown in lists." },
  description: { type: ["string", "null"], maxLength: 2000, description: "One or two sentences about the site." },
  spa: { type: "boolean", description: "Single-page app: unknown paths serve index.html instead of a 404." },
  renderMarkdown: { type: "boolean", description: "Browsers see .md files rendered as pages (default true); false serves them raw." },
  crossOriginIsolation: { type: "boolean", description: "Send COOP/COEP headers (needed for SharedArrayBuffer and threaded WebAssembly)." },
} satisfies Record<string, Schema>;

export const IDEMPOTENCY_KEY: Schema = {
  type: "string",
  minLength: 1,
  maxLength: 255,
  description: "Retry key (24 h): same arguments replay; different arguments return 422.",
};

export const CONFIRM_SLUG: Schema = { type: "string", description: "Must equal the site's slug. Destructive actions need this explicit confirmation." };

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
    versionUrl: { type: "string", description: "Owner dashboard link pinned by version id." },
    site: SITE_OUT,
    version: { type: ["object", "null"] },
    files: { type: "object" },
    upload: { type: "object", description: "Only when status is awaiting_upload: items to PUT, then finalize." },
    warnings: { type: "array" },
    next: { type: "array" },
  },
  required: ["status", "url", "slug"],
};

export const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", properties, required });
