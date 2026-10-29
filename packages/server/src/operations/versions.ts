import { HTTP_UPLOAD, HTTP_UPLOAD_ITEM, HTTP_VERSION } from "./http-schemas";
import { deleteVersionByRef, exportVersionZip, getVersionStatus, getSiteByRef, resolveVersionRef } from "@dropway/core";
import { CONFIRM_SLUG, SITE_REF, VERSION_OUT, VERSION_REF, obj } from "../mcp/schemas";
import { defineOperation } from "../operations";
import { fromSchema, RO, DESTROY, P, D } from "./shared";
import { attachmentDisposition } from "../content-disposition";
import { readJson } from "../routes/api";

export const VERSION_OPERATIONS = [
  defineOperation({
    id: "get_version",
    method: "GET",
    path: "/api/v1/sites/{slug}/versions/{id}",
    summary: "Get a version",
    toolset: "versions",
    scopes: ["sites:read"],
    description:
      'Show one version ("live", "v3", "3" or an id): status, number, counts, source, client, message. Pending: `missing` sha256 list, plus fresh upload items for write keys.',
    input: fromSchema({
      type: "object",
      properties: { site: SITE_REF, version: VERSION_REF },
      required: ["site", "version"],
      additionalProperties: false,
    }),
    output: fromSchema(
      obj(
        {
          site: { type: "string" },
          version: VERSION_OUT,
          missing: { type: "array", items: { type: "string" } },
          // Pending versions (write keys): fresh upload items; same items repeat as legacy `uploads`.
          upload: { type: "object" },
        },
        ["version"],
      ),
    ),
    annotations: RO,
    async handler(a, { dw, principal }) {
      const site = await getSiteByRef(dw, principal, a.site);
      const v = await resolveVersionRef(dw, site, a.version);
      return { site: site.slug, ...(await getVersionStatus(dw, site, v, principal)) };
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: { slug: { type: "string" }, id: { type: "string" } },
        required: ["slug", "id"],
      }),
      output: fromSchema({
        type: "object",
        properties: {
          site: { type: "string" },
          version: HTTP_VERSION,
          missing: { type: "array", items: { type: "string" } },
          upload: HTTP_UPLOAD,
          uploads: { type: "array", items: HTTP_UPLOAD_ITEM },
        },
      }),
      handler: async (c) => {
        const site = await getSiteByRef(D(c), P(c), c.req.param("slug")!);
        const v = await resolveVersionRef(D(c), site, c.req.param("id")!);
        return c.json({ site: site.slug, ...(await getVersionStatus(D(c), site, v, P(c))) });
      },
    },
    tool: {
      summarize: (r) =>
        `${r.site} v${r.version.number}: ${r.version.status}${r.version.live ? ", live" : ""}, ${r.version.fileCount} files${r.missing.length ? `, ${r.missing.length} missing` : ""}.`,
    },
    examples: [
      {
        input: { site: "bright-otter-x7k2", version: "ver_example" },
        output: {
          site: "bright-otter-x7k2",
          version: {
            id: "ver_example",
            number: 1,
            status: "ready",
            live: true,
          },
          missing: [],
        },
      },
    ],
  }),
  defineOperation({
    id: "delete_version",
    method: "DELETE",
    path: "/api/v1/sites/{slug}/versions/{id}",
    summary: "Delete a version",
    toolset: "versions",
    scopes: ["sites:delete"],
    description:
      "Permanently delete one version that is not live (for example one that leaked a secret). The live version cannot be deleted: restore or publish another first. Set confirm to the site's slug.",
    input: fromSchema({
      type: "object",
      properties: {
        site: SITE_REF,
        version: VERSION_REF,
        confirm: CONFIRM_SLUG,
        idempotencyKey: { type: "string" },
      },
      required: ["site", "version", "confirm"],
      additionalProperties: false,
    }),
    output: fromSchema(obj({ deleted: { type: "boolean" }, id: { type: "string" }, replayed: { type: "boolean" } }, ["deleted", "id"])),
    annotations: DESTROY,
    handler: (a, { dw, principal }) => deleteVersionByRef(dw, principal, a.site, a.version, a.confirm, {
      transport: "mcp", idempotencyKey: a.idempotencyKey,
    }),
    http: {
      input: fromSchema({
        type: "object",
        properties: { slug: { type: "string" }, id: { type: "string" }, confirm: CONFIRM_SLUG },
        required: ["slug", "id", "confirm"],
      }),
      output: fromSchema({ type: "object" }),
      handler: async (c) => {
        const body = await readJson(c);
        return c.json(await deleteVersionByRef(D(c), P(c), c.req.param("slug")!, c.req.param("id")!, body.confirm, {
          transport: "rest", idempotencyKey: c.req.header("idempotency-key"),
        }));
      },
    },
    tool: { summarize: (r) => `Deleted version ${r.id}.` },
    examples: [
      {
        input: {
          site: "bright-otter-x7k2",
          version: "ver_old",
          confirm: "bright-otter-x7k2",
        },
        output: { deleted: true, id: "ver_old" },
      },
    ],
  }),
  defineOperation({
    id: "export_version",
    method: "GET",
    path: "/api/v1/sites/{slug}/versions/{version}/export",
    summary: "Download a version as a ZIP",
    toolset: "versions",
    scopes: ["sites:read"],
    description:
      'Stream one version ("live", "v3", "3" or an id) as a deterministic ZIP of exactly its served manifest bytes: entries stored uncompressed and sorted by path, one fixed timestamp, no data descriptors. Answers 413 when the version exceeds the effective file-count or byte caps. Binary payload: download it over REST (for example curl).',
    input: fromSchema({
      type: "object",
      properties: { site: SITE_REF, version: VERSION_REF },
      required: ["site", "version"],
      additionalProperties: false,
    }),
    output: fromSchema({ type: "object", additionalProperties: true }),
    annotations: RO,
    mcp: {
      exclude: "Binary ZIP bytes never pass through the model; download the export over REST (GET /api/v1/sites/{slug}/versions/{version}/export), for example with curl.",
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: { slug: { type: "string" }, version: { type: "string" } },
        required: ["slug", "version"],
      }),
      responseType: "application/zip",
      handler: async (c) => {
        const version = c.req.param("version")!.trim();
        const out = await exportVersionZip(D(c), P(c), c.req.param("slug")!, version);
        const headers = {
          "Content-Type": "application/zip",
          // out.filename is slug-derived (`<slug>-v<n>.zip`; slugs are
          // [a-z0-9-]), so the helper returns its plain ASCII form unchanged.
          "Content-Disposition": attachmentDisposition(out.filename),
          "Cache-Control": version === "" || version.toLowerCase() === "live"
            ? "private, no-cache"
            : "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
          "X-Kofra-Version": out.versionId,
        };
        if (c.req.method === "HEAD") return c.body(null, 200, headers);
        return c.body(out.stream, 200, headers);
      },
    },
    examples: [{ input: { site: "bright-otter-x7k2", version: "live" }, output: "Hello" }],
    async handler() {
      throw new Error("REST transport required");
    },
  }),
];
