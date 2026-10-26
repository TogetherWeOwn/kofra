import { HTTP_MANIFEST_ENTRY, HTTP_DEPLOY, HTTP_PUBLISH_RESULT, HTTP_FILE_INPUT, HTTP_AGENT_PUBLISH_RESULT } from "./http-schemas";
import type { Context } from "hono";
import {
  appOrigin,
  getDeployStatus,
  parseSettings,
  updateSite,
  ApiError,
  anonymousDisabled,
  createDeploy,
  parseDeployOptions,
  getFile,
  getSiteByRef,
  getSiteFor,
  isHtml,
  isTextual,
  normaliseFilePath,
  notFound,
  parsePublishRequest,
  publishFiles,
  publishSources,
  idempotencyScope,
  validateIdempotencyKey,
  withIdempotency,
  readBlob,
  recoverOwnerKey,
  setupInstance,
  uploadBlob,
} from "@dropway/core";
import type { DropwayEnv } from "../env";
import { readJson } from "../routes/api";
import { defineOperation, rawRequestInput } from "../operations";
import { fromSchema, RO, WRITE, P, D, clientOf } from "./shared";

export const HTTP_OPERATIONS = [
  defineOperation({
    anonymous: true,
    id: "api_index",
    method: "GET",
    path: "/api/v1",
    aliases: [],
    toolset: "agents",
    scopes: [],
    summary: "API index with links to the docs",
    description: "API index with links to the docs. Use this REST compatibility endpoint for its documented wire format.",
    input: fromSchema({ type: "object", properties: {} }),
    output: fromSchema({ type: "object" }),
    annotations: RO,
    mcp: { exclude: "discovery document; use whoami" },
    http: {
      handler: (c) => {
        const o = appOrigin(D(c));
        return c.json({
          name: `${D(c).config.instanceName} API`,
          version: "v1",
          openapi: `${o}/openapi.json`,
          llms: `${o}/llms.txt`,
          quickstart: `curl -H "Authorization: Bearer $KOFRA_API_KEY" -F "index.html=@index.html" ${o}/api/v1/publish`,
        });
      },
    },
    examples: [
      {
        input: {},
        output: {
          name: "Kofra API",
          version: "v1",
          openapi: "https://dropway.example/openapi.json",
        },
      },
    ],
    async handler() {
      throw new Error("REST transport required");
    },
  }),
  defineOperation({
    id: "setup_instance",
    bootstrap: true,
    method: "POST",
    path: "/api/v1/setup",
    aliases: [{ method: "POST", path: "/api/v1/accounts" }],
    toolset: "setup",
    scopes: [],
    summary: "First run: create the owner (bootstrap key only)",
    description:
      "Authorization: Bearer <ADMIN_BOOTSTRAP_KEY>. Creates the tenant, its owner and a full-scope owner API key. Works once on a single-tenant instance.",
    input: fromSchema({
      type: "object",
      properties: {
        email: { type: "string" },
        name: { type: "string" },
        tenantName: { type: "string" },
      },
    }),
    output: fromSchema({ type: "object" }),
    annotations: WRITE,
    mcp: { exclude: "needs the bootstrap key, which MCP never accepts" },
    http: {
      statuses: [201],
      handler: async (c: Context<DropwayEnv>) => {
        const body = await readJson(c);
        const out = await setupInstance(D(c), P(c), body);
        return c.json(
          {
            ...out,
            note: "Store apiKey.key now; it is shown only once. Use it as `Authorization: Bearer <key>`.",
          },
          201,
        );
      },
      contentTypes: ["application/json"],
    },
    examples: [
      {
        input: { email: "owner@example.com", name: "Owner" },
        output: {
          tenant: { id: "ten_example" },
          member: {
            id: "mem_example",
            email: "person@example.com",
            name: "Example",
            role: "owner",
          },
          apiKey: { id: "key_example", key: "dw_example" },
        },
      },
    ],
    async handler() {
      throw new Error("REST transport required");
    },
  }),
  defineOperation({
    id: "recover_owner_key",
    bootstrap: true,
    method: "POST",
    path: "/api/v1/setup/recover",
    aliases: [],
    toolset: "setup",
    scopes: [],
    summary: "Mint a new owner key (bootstrap key only)",
    description: "Mint a new owner key (bootstrap key only). Use this REST compatibility endpoint for its documented wire format.",
    input: fromSchema({ type: "object", properties: {} }),
    output: fromSchema({ type: "object" }),
    annotations: WRITE,
    mcp: { exclude: "needs the bootstrap key" },
    http: {
      statuses: [201],
      handler: async (c) =>
        c.json(
          {
            ...(await recoverOwnerKey(D(c), P(c))),
            note: "Store apiKey.key now; it is shown only once.",
          },
          201,
        ),
    },
    examples: [
      {
        input: {},
        output: {
          member: {
            id: "mem_example",
            email: "person@example.com",
            name: "Example",
            role: "owner",
          },
          apiKey: { id: "key_example", key: "dw_example" },
        },
      },
    ],
    async handler() {
      throw new Error("REST transport required");
    },
  }),
  defineOperation({
    rawBody: true,
    id: "publish_upload",
    anonymous: true,
    method: "POST",
    path: "/api/v1/publish",
    aliases: [],
    toolset: "publish",
    scopes: ["sites:write"],
    summary: "Publish files in one call and get a live URL",
    description:
      'Accepts multipart/form-data (field name = file path, e.g. -F "assets/app.js=@dist/assets/app.js"; or field `files[]` with filenames; a single .zip is unpacked), application/json ({"files":[{"path","content","encoding?":"base64"}]}), a .zip body, or one raw file body named by ?path= or X-Kofra-Path. Settings and `slug` may be sent as form fields, JSON fields or query parameters. With an existing `slug` you own, publishes a new version of it. Byte-identical content returns unchanged:true. JSON uses the same flat content, url, sha256+size and copyFrom sources as MCP publish_site, and returns PublishResult with versionUrl, counters and upload capabilities. Idempotency-Key replays JSON requests. Multipart, ZIP and raw bodies retain their original response shape.',
    input: fromSchema({
      type: "object",
      required: ["files"],
      properties: {
        slug: { type: "string", description: "Legacy alias for site." },
        site: { type: "string", description: "Existing site ref or new slug." },
        files: { type: "array", items: HTTP_FILE_INPUT },
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
        noindex: {
          type: "boolean",
          description: "Ask crawlers not to index this site (X-Robots-Tag: noindex).",
        },
        viewers: {
          type: "boolean",
          description: "Rendered file viewers on (default true); false always serves the stored bytes.",
        },
        ttlSeconds: {
          type: ["integer", "null"],
          description: "Keyed sites only: lifetime in seconds from the latest publish; null clears it.",
        },
        password: {
          type: ["string", "null"],
          description: "Visitor password; null removes it. Needs an API key.",
        },
        path: { type: "string" },
      },
    }),
    output: fromSchema({ oneOf: [HTTP_AGENT_PUBLISH_RESULT, HTTP_PUBLISH_RESULT] }),
    annotations: WRITE,
    mcp: {
      exclude: "Multipart, zip and raw publishing; models use publish_site with file sources.",
    },
    http: {
      statuses: [200, 201, 202],
      policyId: "publish_site",
      parseInput: async (c) => {
        const dw = D(c);
        const p = P(c);
        if (p.kind === "anonymous" && !dw.config.anonymous.enabled) throw anonymousDisabled();
        const lim = await dw.adapters.policy.limits(p, { siteId: null, tenantId: p.kind === "member" ? p.tenantId : null }, dw);
        if (c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
          const body = await readJson(c, lim.oneShotMaxBytes);
          return { format: "sources" as const, body };
        }
        return { format: "upload" as const, input: await parsePublishRequest(dw, c.req.raw, lim.oneShotMaxBytes) };
      },
      handler: async (c, parsed: { format: "sources"; body: Record<string, unknown> } | { format: "upload"; input: Awaited<ReturnType<typeof parsePublishRequest>> }) => {
        if (parsed.format === "upload") {
          const out = await publishFiles(D(c), P(c), parsed.input, { client: clientOf(c) });
          return c.json(out, out.created ? 201 : 200);
        }
        const body = parsed.body;
        const query = Object.fromEntries(new URL(c.req.url).searchParams);
        const input = { ...query, ...body };
        const { result, replayed } = await withIdempotency(D(c), {
          scope: idempotencyScope(P(c)), operation: "rest:publish_site", key: validateIdempotencyKey(c.req.header("idempotency-key")), input,
        }, () => publishSources(D(c), P(c), { ...input, site: input.site, files: input.files, source: "api", client: clientOf(c) }));
        return c.json(replayed ? { ...result, replayed: true } : result, result.status === "awaiting_upload" ? 202 : result.created ? 201 : 200);
      },
      contentTypes: ["multipart/form-data", "application/json", "application/zip", "application/octet-stream"],
    },
    examples: [
      {
        input: { files: [{ path: "index.html", content: "Hello" }] },
        output: {
          url: "https://dropway.example/s/bright-otter-x7k2/",
          slug: "bright-otter-x7k2",
          created: true,
          unchanged: false,
          site: {
            slug: "bright-otter-x7k2",
            url: "https://dropway.example/s/bright-otter-x7k2/",
            currentVersionId: "ver_example",
          },
          version: {
            id: "ver_example",
            number: 1,
            status: "ready",
            live: true,
          },
          files: ["index.html"],
          uploaded: 1,
          reused: 0,
          warnings: [],
        },
      },
    ],
    async handler() {
      throw new Error("REST transport required");
    },
  }),
  defineOperation({
    id: "create_version",
    method: "POST",
    path: "/api/v1/sites/{slug}/versions",
    aliases: [{ method: "POST", path: "/api/v1/sites/{slug}/deploys" }],
    toolset: "versions",
    scopes: ["sites:write"],
    summary: "Start a version from a file manifest (upload only what is missing)",
    description:
      "Send every file's path, size and sha256. The response lists only the files the server does not have yet (`uploads`). PUT each, then finalize.",
    input: fromSchema({
      type: "object",
      required: ["files", "slug"],
      properties: {
        files: { type: "array", items: HTTP_MANIFEST_ENTRY },
        message: { type: "string" },
        baseVersionId: {
          type: "string",
          description: "Fail with 409 version_conflict if the live version is no longer this one.",
        },
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
        noindex: {
          type: "boolean",
          description: "Ask crawlers not to index this site (X-Robots-Tag: noindex).",
        },
        viewers: {
          type: "boolean",
          description: "Rendered file viewers on (default true); false always serves the stored bytes.",
        },
        ttlSeconds: {
          type: ["integer", "null"],
          description: "Keyed sites only: lifetime in seconds from the latest publish; null clears it.",
        },
        password: {
          type: ["string", "null"],
          description: "Visitor password; null removes it. Needs an API key.",
        },
        slug: { type: "string" },
      },
    }),
    output: fromSchema(HTTP_DEPLOY),
    annotations: WRITE,
    mcp: {
      exclude: "MCP publish_site covers it (sha256 sources return upload links)",
    },
    http: {
      statuses: [200, 201],
      // The handler collects every malformed manifest field and coerces legacy
      // metadata itself; schema validation would reject those before it runs.
      parseInput: (c) => rawRequestInput(c),
      handler: async (c) => {
        const dw = D(c);
        const p = P(c);
        let site = await getSiteFor(dw, p, c.req.param("slug")!, "sites:write");
        const body = await readJson(c);
        const settings = parseSettings(body);
        const opts = parseDeployOptions({
          message: body.message,
          client: clientOf(c),
          baseVersionId: body.baseVersionId,
          source: "api",
        });
        if (Object.keys(settings).length) site = await updateSite(dw, p, site.slug, settings);
        const out = await createDeploy(dw, p, site, body.files, opts);
        return c.json(out, out.unchanged ? 200 : 201);
      },
      contentTypes: ["application/json"],
    },
    examples: [
      {
        input: {
          files: [
            {
              path: "index.html",
              size: 5,
              sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            },
          ],
        },
        output: {
          unchanged: false,
          deploy: {
            id: "ver_example",
            number: 1,
            status: "pending",
            live: false,
          },
          missing: ["0000000000000000000000000000000000000000000000000000000000000000"],
          uploads: [],
          finalizeUrl: "https://dropway.example/api/v1/sites/bright-otter-x7k2/versions/ver_example/finalize",
        },
      },
    ],
    async handler() {
      throw new Error("REST transport required");
    },
  }),
  defineOperation({
    id: "get_deploy",
    method: "GET",
    path: "/api/v1/sites/{slug}/deploys/{id}",
    aliases: [],
    toolset: "versions",
    scopes: ["sites:read"],
    summary: "Pending version status (missing files)",
    description: "Pending version status (missing files). Use this REST compatibility endpoint for its documented wire format.",
    input: fromSchema({
      type: "object",
      properties: { slug: { type: "string" }, id: { type: "string" } },
      required: ["slug", "id"],
    }),
    output: fromSchema({ type: "object" }),
    annotations: RO,
    mcp: { exclude: "Legacy response shape; models use get_version." },
    http: {
      handler: async (c) => {
        const site = await getSiteFor(D(c), P(c), c.req.param("slug")!);
        return c.json(await getDeployStatus(D(c), site, c.req.param("id")!));
      },
    },
    examples: [
      {
        input: {},
        output: {
          deploy: { id: "ver_example", number: 1, status: "ready", live: true },
          missing: [],
        },
      },
    ],
    async handler() {
      throw new Error("REST transport required");
    },
  }),
  defineOperation({
    id: "upload_blob",
    method: "PUT",
    path: "/api/v1/blobs/{sha256}",
    aliases: [{ method: "POST", path: "/api/v1/blobs/{sha256}" }],
    toolset: "versions",
    scopes: ["sites:write"],
    summary: "Upload one file's raw bytes",
    description:
      "Body = the exact file bytes, with Content-Length. The SHA-256 is verified. Only files listed as missing by a pending version you control are accepted.",
    input: fromSchema({
      type: "object",
      properties: { sha256: { type: "string" } },
      required: ["sha256"],
    }),
    output: fromSchema({ type: "object" }),
    annotations: WRITE,
    mcp: {
      exclude: "raw bytes never pass through the model; PUT them from a shell (curl lines are in upload.items)",
    },
    rawBody: true,
    http: {
      statuses: [200, 201],
      handler: async (c) => {
        const len = c.req.header("content-length");
        const out = await uploadBlob(
          D(c),
          P(c),
          c.req.param("sha256")!,
          c.req.raw.body,
          len === undefined ? null : Number(len),
          c.req.header("content-type") ?? null,
        );
        return c.json(out, out.existed ? 200 : 201);
      },
      contentTypes: ["application/octet-stream"],
    },
    examples: [
      {
        input: {},
        output: {
          existed: false,
          sha256: "0000000000000000000000000000000000000000000000000000000000000000",
          size: 5,
        },
      },
    ],
    async handler() {
      throw new Error("REST transport required");
    },
  }),
  defineOperation({
    id: "get_file_bytes",
    method: "GET",
    path: "/api/v1/sites/{slug}/files/{path}",
    aliases: [],
    toolset: "files",
    scopes: ["sites:read"],
    summary: "Read one file's raw bytes (ETag = sha256)",
    description: "The MCP tool read_file returns text or base64 in JSON and pages with offset/length.",
    input: fromSchema({
      type: "object",
      properties: {
        slug: { type: "string" },
        path: { type: "string" },
        version: { type: "string" },
      },
      required: ["slug", "path"],
    }),
    output: fromSchema({ type: "object", additionalProperties: true }),
    annotations: RO,
    mcp: {
      exclude: "Raw file bytes and HTTP headers; models use read_file for paged JSON.",
    },
    http: {
      responseType: "application/octet-stream",
      handler: async (c) => {
        const dw = D(c);
        const site = await getSiteByRef(dw, P(c), c.req.param("slug")!);
        const path = normaliseFilePath(c.req.param("path")!);
        const versionId = c.req.query("version") ?? site.current_version_id;
        const file = await getFile(dw, site, path, versionId);
        if (!file) throw notFound("file_not_found", `No file "${path}" in this version.`, "List files with GET /api/v1/sites/:slug/files.");
        const headers: Record<string, string> = {
          // Never render user content on the app origin: textual types come back as text/plain.
          "Content-Type": isTextual(file.content_type) || isHtml(file.content_type) ? "text/plain; charset=utf-8" : file.content_type,
          "X-Kofra-Content-Type": file.content_type,
          "X-Kofra-Version": versionId ?? "",
          "Content-Length": String(file.size),
          ETag: `"${file.sha256}"`,
          "Cache-Control": "private, no-store",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "X-Content-Type-Options": "nosniff",
        };
        if (c.req.method === "HEAD") return c.body(null, 200, headers);
        if (c.req.header("if-none-match") === `"${file.sha256}"`) return c.body(null, 304, headers);
        const blob = await readBlob(dw, file.sha256, file.size);
        if (!blob) throw new ApiError(502, "blob_missing", "The file is listed but its contents could not be read.", "Retry shortly.");
        return new Response(blob.body, { status: 200, headers });
      },
      wildcard: true,
    },
    examples: [{ input: {}, output: "Hello" }],
    async handler() {
      throw new Error("REST transport required");
    },
  }),
];
