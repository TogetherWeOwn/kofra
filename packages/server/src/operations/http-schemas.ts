/** Schemas for pre-registry HTTP wire shapes, shared by their compatibility adapters. */
import { ALL_SCOPES } from "@dropway/core";
export const HTTP_VERSION: Record<string, any> = {
  type: "object",
  properties: {
    id: { type: "string" },
    number: { type: "integer" },
    status: { enum: ["pending", "ready"] },
    live: { type: "boolean" },
    fileCount: { type: "integer" },
    totalBytes: { type: "integer" },
    source: { type: "string" },
    client: { type: ["string", "null"] },
    message: { type: ["string", "null"] },
    createdAt: { type: "string" },
    finalizedAt: { type: ["string", "null"] },
  },
};
export const HTTP_SITE: Record<string, any> = {
  type: "object",
  properties: {
    slug: { type: "string" },
    url: {
      type: "string",
      description: "Share this URL as returned; never construct it.",
    },
    title: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    anonymous: { type: "boolean" },
    expiresAt: { type: ["string", "null"] },
    settings: { type: "object" },
    currentVersionId: { type: ["string", "null"] },
    currentVersion: { oneOf: [HTTP_VERSION, { type: "null" }] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    links: { type: "object" },
  },
};
export const HTTP_MANIFEST_ENTRY: Record<string, any> = {
  type: "object",
  required: ["path", "size", "sha256"],
  properties: {
    path: { type: "string" },
    size: { type: "integer", minimum: 0 },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    contentType: { type: "string" },
  },
};
export const HTTP_FILE_INPUT: Record<string, any> = {
  type: "object",
  required: ["path"],
  description: "A path plus exactly one source: content (+encoding), url (+headers), sha256 (+size) or copyFrom.",
  properties: {
    path: { type: "string" },
    content: { type: "string" },
    encoding: { enum: ["utf8", "base64"] },
    url: {
      type: "string",
      format: "uri",
      description: "Public https URL the server downloads.",
    },
    headers: { type: "object", additionalProperties: { type: "string" } },
    sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    size: { type: "integer", minimum: 0 },
    copyFrom: {
      type: "object",
      properties: {
        site: { type: "string" },
        version: { type: "string" },
        path: { type: "string" },
      },
    },
    contentType: { type: "string" },
  },
};
export const HTTP_SCOPES: Record<string, any> = {
  oneOf: [
    {
      type: "array",
      items: {
        enum: [...ALL_SCOPES],
      },
    },
    { type: "string", description: '"*" or space-separated scopes' },
  ],
};
export const HTTP_UPLOAD_ITEM: Record<string, any> = {
  type: "object",
  properties: {
    path: { type: "string" },
    paths: { type: "array", items: { type: "string" } },
    sha256: { type: "string" },
    size: { type: "integer" },
    method: { const: "PUT" },
    url: { type: "string" },
    headers: { type: "object", additionalProperties: { type: "string" } },
    curl: { type: "string" },
  },
};
export const HTTP_UPLOAD: Record<string, any> = {
  type: "object",
  properties: {
    versionId: { type: "string" },
    expiresAt: { type: "string" },
    items: { type: "array", items: HTTP_UPLOAD_ITEM },
  },
};
export const HTTP_DEPLOY: Record<string, any> = {
  type: "object",
  properties: {
    unchanged: { type: "boolean" },
    deploy: HTTP_VERSION,
    missing: { type: "array", items: { type: "string" } },
    uploads: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sha256: { type: "string" },
          size: { type: "integer" },
          paths: { type: "array", items: { type: "string" } },
          method: { const: "PUT" },
          url: { type: "string" },
          headers: { type: "object" },
        },
      },
    },
    finalizeUrl: { type: ["string", "null"] },
    next: { type: "string", description: "Plain-English next step." },
  },
};
export const HTTP_WHOAMI: Record<string, any> = {
  type: "object",
  properties: {
    principal: { type: "string" },
    tenant: { type: "object" },
    member: { type: "object" },
    keyId: { type: "string" },
    scopes: { type: "array", items: { type: "string" } },
    siteRestriction: { type: ["string", "null"] },
    capabilities: { type: "object" },
    limits: { type: "object" },
    usage: { type: "object" },
  },
};
export const HTTP_JSON_PUBLISH: Record<string, any> = {
  type: "object",
  required: ["files"],
  properties: {
    slug: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          encoding: { enum: ["utf8", "base64"] },
          contentType: { type: "string" },
        },
      },
    },
    message: { type: "string" },
    baseVersionId: { type: "string" },
    title: { type: ["string", "null"], maxLength: 200 },
    description: { type: ["string", "null"], maxLength: 2000 },
    spa: {
      type: "boolean",
      description: "Serve index.html for unknown paths (single-page apps).",
    },
    renderMarkdown: {
      type: "boolean",
      description: "Render .md files as HTML pages for browsers (default true).",
    },
    crossOriginIsolation: {
      type: "boolean",
      description: "Send COOP/COEP headers (needed for SharedArrayBuffer, threaded WASM).",
    },
    password: {
      type: ["string", "null"],
      description: "Visitor password; null removes it. Needs an API key.",
    },
  },
};
export const HTTP_PUBLISH_RESULT: Record<string, any> = {
  type: "object",
  properties: {
    url: { type: "string" },
    slug: { type: "string" },
    versionUrl: { type: "string", description: "Signed exact-version preview link, valid for 24 hours." },
    created: { type: "boolean" },
    unchanged: { type: "boolean" },
    site: HTTP_SITE,
    version: HTTP_VERSION,
    files: { type: "array", items: { type: "string" } },
    uploaded: { type: "integer" },
    reused: { type: "integer" },
    warnings: {
      type: "array",
      items: {
        type: "object",
        properties: { code: { type: "string" }, message: { type: "string" } },
      },
    },
    claimToken: {
      type: "string",
      description: "Anonymous publishes only; shown once.",
    },
    expiresAt: { type: ["string", "null"] },
  },
};
export const HTTP_AGENT_PUBLISH_RESULT: Record<string, any> = {
  type: "object",
  description: "Result of MCP publish_site / update_site_files and REST PATCH .../files.",
  properties: {
    status: { enum: ["live", "unchanged", "awaiting_upload"] },
    url: { type: "string" },
    slug: { type: "string" },
    versionUrl: { type: "string", description: "24 h signed preview; bearer capability." },
    site: { ...HTTP_SITE, properties: { ...HTTP_SITE.properties, id: { type: "string" } } },
    version: { oneOf: [HTTP_VERSION, { type: "null" }] },
    files: {
      type: "object",
      properties: {
        total: { type: "integer" },
        stored: { type: "integer" },
        reused: { type: "integer" },
        fetched: { type: "integer" },
        pending: { type: "integer" },
      },
    },
    upload: {
      type: "object",
      properties: {
        versionId: { type: "string" },
        expiresAt: { type: "string" },
        items: { type: "array", items: { type: "object" } },
        finalize: { type: "object" },
      },
    },
    changes: { type: "object" },
    warnings: { type: "array", items: { type: "object" } },
    next: { type: "array", items: { type: "object" } },
  },
};
