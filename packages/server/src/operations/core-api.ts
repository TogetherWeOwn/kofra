import { HTTP_WHOAMI, HTTP_FILE_INPUT, HTTP_AGENT_PUBLISH_RESULT, HTTP_SITE } from "./http-schemas";
import {
  appOrigin,
  claimSite,
  deleteSite,
  describeSite,
  describePolicy,
  finalizeVersionByRef,
  getMember,
  getSiteByRef,
  getTenant,
  listFiles,
  listSites,
  listVersions,
  parseSettings,
  publishSources,
  readFileSlice,
  requireConfirm,
  resolveSiteSlug,
  resolveVersionRef,
  restoreVersion,
  serializeMember,
  serializeTenant,
  setSiteAccess,
  siteUrl,
  updateSite,
  updateSiteFiles,
  getSiteFor,
  idempotencyScope,
  validateIdempotencyKey,
  withIdempotency,
} from "@dropway/core";
import { CONFIRM_SLUG, FILE_INPUT, PUBLISH_OUT, SETTINGS_INPUT, SITE_OUT, SITE_REF, VERSION_OUT, VERSION_REF, obj } from "../mcp/schemas";
import { readJson } from "../routes/api";
import { defineOperation, rawRequestInput } from "../operations";
import { fromSchema, ANY, ANY_OR_NULL, RO, WRITE, DESTROY, siteOut, str, settingsFrom, publishSummary, whoamiPrincipal, P, D } from "./shared";

export const CORE_API_OPERATIONS = [
  defineOperation({
    id: "whoami",
    method: "GET",
    path: "/api/v1/me",
    summary: "Who am I",
    toolset: "core",
    mcp: { alwaysLoad: true },
    description:
      "Describe this Kofra instance, your credential and permissions, URLs, capabilities (including missing bindings), size/resource limits and usage. Call first when unsure what you may do.",
    input: fromSchema({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    output: fromSchema(
      obj(
        {
          principal: ANY,
          tenant: ANY_OR_NULL,
          member: ANY_OR_NULL,
          instance: ANY,
          limits: ANY,
          capabilities: ANY,
          usage: ANY,
        },
        ["principal", "instance", "limits", "capabilities", "usage"],
      ),
    ),
    annotations: RO,
    async handler(_args, { dw, principal }) {
      const o = appOrigin(dw);
      const policy = await describePolicy(dw, principal);
      return {
        principal: whoamiPrincipal(principal),
        tenant: principal.kind === "member" ? serializeTenant(await getTenant(dw, principal.tenantId)) : null,
        member: principal.kind === "member" ? serializeMember(await getMember(dw, principal.memberId)) : null,
        instance: {
          name: dw.config.instanceName,
          appOrigin: o,
          api: `${o}/api/v1`,
          mcp: `${o}/mcp`,
          openapi: `${o}/openapi.json`,
          llms: `${o}/llms.txt`,
          skill: `${o}/skill.md`,
          sitesMode: dw.config.sitesMode,
          exampleSiteUrl: siteUrl(dw, "bright-otter-x7k2"),
          anonymousPublish: dw.config.anonymous.enabled,
          accessModes: ["public", "password"],
          fileSources: ["content", "url", "sha256", "copyFrom"],
        },
        ...policy,
      };
    },
    scopes: [],
    anonymous: true,
    http: {
      examples: [
        {
          input: {},
          output: {
            principal: "member",
            tenant: { id: "ten_example" },
            member: {
              id: "mem_example",
              email: "person@example.com",
              name: "Example",
              role: "member",
            },
            keyId: "key_example",
            scopes: ["sites:read"],
            siteRestriction: null,
          },
        },
      ],
      input: fromSchema({ type: "object", properties: {} }),
      output: fromSchema(HTTP_WHOAMI),
      handler: async (c) => {
        const p = P(c);
        const dw = D(c);
        const policy = await describePolicy(dw, p);
        if (p.kind === "member") {
          return c.json({
            ...policy,
            principal: "member",
            tenant: serializeTenant(await getTenant(dw, p.tenantId)),
            member: serializeMember(await getMember(dw, p.memberId)),
            keyId: p.keyId,
            scopes: p.scopes,
            siteRestriction: p.siteId,
          });
        }
        if (p.kind === "claim") return c.json({ ...policy, principal: "claim_token", siteId: p.siteId });
        return c.json({
          ...policy,
          principal: p.kind,
          anonymousPublish: dw.config.anonymous.enabled,
        });
      },
    },
    tool: {
      summarize: (r) =>
        r.principal.kind === "member"
          ? `You are a ${r.principal.role} of ${r.instance.name} (${r.instance.appOrigin}) with scopes ${r.principal.scopes.join(", ")}${r.principal.siteRestriction ? ", restricted to one site" : ""}.`
          : `You hold a claim token for one anonymous site on ${r.instance.name}.`,
    },
    cli: { command: ["whoami"] },
    examples: [
      {
        input: {},
        output: {
          principal: "member",
          tenant: { id: "ten_example" },
          member: {
            id: "mem_example",
            email: "person@example.com",
            name: "Example",
            role: "member",
          },
          keyId: "key_example",
          scopes: ["sites:read"],
          siteRestriction: null,
        },
      },
    ],
  }),
  defineOperation({
    id: "publish_site",
    method: "POST",
    path: "/api/v1/publish-sources",
    summary: "Publish a site",
    toolset: "core",
    mcp: { alwaysLoad: true },
    scopes: ["sites:write"],
    description:
      "Publish files to a live URL in one call. Without `site` a new site with a generated name is created; with `site` set to a slug you own, ALL its files are replaced by `files` (a new immutable version); with a new slug, a site of that name is created. Each file needs a path plus one source: content (text, or base64 for small binaries), url (the server downloads a public https URL), sha256+size (bytes already stored or uploaded afterwards), or copyFrom. Returns status (live, unchanged or awaiting_upload), the live `url`, version and next steps. Share `url` exactly as returned. Use update_site_files for partial edits. A root index.html, index.md or README.md opens as the site's page.",
    input: fromSchema({
      type: "object",
      properties: {
        files: {
          type: "array",
          minItems: 1,
          items: FILE_INPUT,
          description: "Every file of the site.",
        },
        site: {
          type: "string",
          description: "Optional. Slug, id or URL of your existing site to replace, or a new slug (3-56 chars: a-z, 0-9, single hyphens).",
        },
        ...SETTINGS_INPUT,
        password: {
          type: "string",
          minLength: 4,
          maxLength: 200,
          description: "Optional visitor password (see set_site_access).",
        },
        message: {
          type: "string",
          maxLength: 200,
          description: "Short note about this version, like a commit message.",
        },
        baseVersionId: {
          type: "string",
          description: "Fail with version_conflict if the live version is no longer this one (protects someone else's newer publish).",
        },
      },
      required: ["files"],
      additionalProperties: false,
    }),
    output: fromSchema(PUBLISH_OUT),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async handler(a, { dw, principal, client, transport }) {
      return publishSources(dw, principal, {
        ...a,
        files: a.files,
        client,
        source: transport === "rest" ? "api" : "mcp",
      });
    },
    tool: {
      idempotent: true,
      summarize: (r) => publishSummary(r, r.created ? "Created" : "Published"),
    },
    cli: { command: ["publish"] },
    examples: [
      {
        input: { files: [{ path: "index.html", content: "Hello" }] },
        output: {
          status: "live",
          url: "https://dropway.example/s/bright-otter-x7k2/",
          slug: "bright-otter-x7k2",
        },
      },
    ],
  }),
  defineOperation({
    id: "update_site_files",
    method: "PATCH",
    path: "/api/v1/sites/{slug}/files",
    summary: "Change some files",
    toolset: "core",
    scopes: ["sites:write"],
    description:
      "Add, replace, delete or move some files of an existing site; every other file carries over unchanged (nothing is re-sent). `files` uses the same sources as publish_site; `delete` takes paths (a trailing / deletes a folder); `move` takes {from, to}. Pass baseVersionId (the version id from your last result) so a newer publish by someone else fails with version_conflict instead of being overwritten; on conflict, read the live files and retry with the new id. Returns the same result as publish_site plus `changes`.",
    input: fromSchema({
      type: "object",
      properties: {
        site: SITE_REF,
        files: {
          type: "array",
          items: FILE_INPUT,
          description: "Files to add or replace.",
        },
        delete: {
          type: "array",
          items: { type: "string" },
          description: 'Paths to delete, e.g. ["old.html", "drafts/"].',
        },
        move: {
          type: "array",
          items: {
            type: "object",
            properties: { from: { type: "string" }, to: { type: "string" } },
            required: ["from", "to"],
            additionalProperties: false,
          },
          description: "Renames inside the site.",
        },
        baseVersionId: {
          type: "string",
          description: 'The version your change is based on ("live", "v3" or an id). Default: the live version.',
        },
        message: { type: "string", maxLength: 200 },
      },
      required: ["site"],
      additionalProperties: false,
    }),
    output: fromSchema(PUBLISH_OUT),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async handler(a, { dw, principal, client, transport }) {
      return updateSiteFiles(dw, principal, a.site, {
        files: a.files,
        delete: a.delete,
        move: a.move,
        baseVersionId: a.baseVersionId,
        message: a.message,
        client,
        source: transport === "rest" ? "api" : "mcp",
      });
    },
    http: {
      statuses: [200, 202],
      // The handler collects every malformed source field and coerces legacy
      // base references itself; schema validation would reject those first.
      parseInput: (c) => rawRequestInput(c),
      input: fromSchema({
        type: "object",
        properties: {
          files: { type: "array", items: HTTP_FILE_INPUT },
          delete: { type: "array", items: { type: "string" } },
          move: {
            type: "array",
            items: {
              type: "object",
              required: ["from", "to"],
              properties: { from: { type: "string" }, to: { type: "string" } },
            },
          },
          baseVersionId: {
            type: "string",
            description: '"live", "v3", "3" or a version id.',
          },
          message: { type: "string", maxLength: 200 },
          slug: { type: "string" },
        },
        required: ["slug"],
      }),
      output: fromSchema(HTTP_AGENT_PUBLISH_RESULT),
      handler: async (c) => {
        const dw = D(c);
        const p = P(c);
        const body = await readJson(c);
        const key = validateIdempotencyKey(c.req.header("idempotency-key"));
        const { result, replayed } = await withIdempotency(
          dw,
          {
            scope: idempotencyScope(p),
            operation: "rest:update_site_files",
            key,
            input: { site: c.req.param("slug")!, body },
          },
          () =>
            updateSiteFiles(dw, p, c.req.param("slug")!, {
              files: body.files,
              delete: body.delete,
              move: body.move,
              baseVersionId: body.baseVersionId,
              message: body.message,
              client: c.req.header("x-kofra-client") ?? null,
              source: "api",
            }),
        );
        return c.json(replayed ? { ...result, replayed: true } : result, result.status === "awaiting_upload" ? 202 : 200);
      },
    },
    tool: { idempotent: true, summarize: (r) => publishSummary(r, "Updated") },
    examples: [
      {
        input: {
          site: "bright-otter-x7k2",
          files: [{ path: "index.html", content: "Hello" }],
        },
        output: {
          status: "live",
          url: "https://dropway.example/s/bright-otter-x7k2/",
          slug: "bright-otter-x7k2",
        },
      },
    ],
  }),
  defineOperation({
    id: "finalize_version",
    method: "POST",
    path: "/api/v1/sites/{slug}/versions/{id}/finalize",
    aliases: [{ method: "POST", path: "/api/v1/sites/{slug}/deploys/{id}/finalize" }],
    summary: "Make an uploaded version live",
    toolset: "core",
    scopes: ["sites:write"],
    description:
      "Make a pending version live after you uploaded its missing files (publish_site or update_site_files returned status awaiting_upload with upload.items). Safe to call again. If bytes are still missing, the error lists fresh upload items.",
    input: fromSchema({
      type: "object",
      properties: { site: SITE_REF, versionId: VERSION_REF },
      required: ["site", "versionId"],
      additionalProperties: false,
    }),
    output: fromSchema(PUBLISH_OUT),
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      return finalizeVersionByRef(dw, principal, a.site, a.versionId);
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: { slug: { type: "string" }, id: { type: "string" } },
        required: ["slug", "id"],
      }),
      output: fromSchema({ type: "object" }),
      handler: async (c) => {
        const dw = D(c);
        // Resolve refs and enrich missing_blobs with fresh upload items, exactly
        // like the MCP tool; map back to the unchanged REST success shape.
        const result = await finalizeVersionByRef(dw, P(c), c.req.param("slug")!, c.req.param("id")!);
        const fresh = await getSiteFor(dw, P(c), result.slug);
        return c.json({
          url: siteUrl(dw, fresh.slug),
          live: result.status === "live",
          replayed: result.replayed,
          site: await describeSite(dw, fresh),
          warnings: result.warnings,
        });
      },
    },
    tool: {
      summarize: (r) => `${r.replayed ? "Already live" : "Live"}: ${r.slug} v${r.version?.number}: ${r.url}`,
    },
    examples: [
      {
        input: { site: "bright-otter-x7k2", versionId: "ver_example" },
        output: {
          url: "https://dropway.example/s/bright-otter-x7k2/",
          live: true,
          replayed: false,
          site: {
            slug: "bright-otter-x7k2",
            url: "https://dropway.example/s/bright-otter-x7k2/",
            currentVersionId: "ver_example",
          },
          warnings: [],
        },
      },
    ],
  }),
  defineOperation({
    id: "get_site",
    method: "GET",
    path: "/api/v1/sites/{slug}",
    summary: "Get a site",
    toolset: "core",
    scopes: ["sites:read"],
    description:
      "Show one site: live URL, title, settings (spa, renderMarkdown, crossOriginIsolation), access mode, expiry, and the live version (number, file count, size, who published it and when).",
    input: fromSchema({
      type: "object",
      properties: { site: SITE_REF },
      required: ["site"],
      additionalProperties: false,
    }),
    output: fromSchema(obj({ site: SITE_OUT }, ["site"])),
    annotations: RO,
    async handler(a, { dw, principal }) {
      return {
        site: await siteOut(dw, await getSiteByRef(dw, principal, a.site)),
      };
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
      }),
      output: fromSchema({ type: "object", properties: { site: HTTP_SITE } }),
      handler: async (c) => {
        const site = await getSiteFor(D(c), P(c), c.req.param("slug")!);
        return c.json({ site: await describeSite(D(c), site) });
      },
    },
    tool: {
      summarize: (r) =>
        `${r.site.slug}: ${r.site.currentVersion ? `v${r.site.currentVersion.number}, ${r.site.currentVersion.fileCount} files` : "nothing published yet"}, ${r.site.access.mode}: ${r.site.url}`,
    },
    cli: { command: ["sites", "get"] },
    examples: [
      {
        input: { site: "bright-otter-x7k2" },
        output: {
          site: {
            slug: "bright-otter-x7k2",
            url: "https://dropway.example/s/bright-otter-x7k2/",
            currentVersionId: "ver_example",
          },
        },
      },
    ],
  }),
  defineOperation({
    id: "list_sites",
    method: "GET",
    path: "/api/v1/sites",
    summary: "List sites",
    toolset: "core",
    scopes: ["sites:read"],
    description: "List your sites, newest first, with their live URLs and live versions. Pages of up to 200; pass nextCursor back as cursor for the next page.",
    input: fromSchema({
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Default 50.",
        },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    }),
    output: fromSchema(
      obj(
        {
          sites: { type: "array", items: SITE_OUT },
          nextCursor: { type: ["string", "null"] },
        },
        ["sites"],
      ),
    ),
    annotations: RO,
    async handler(a, { dw, principal }) {
      return listSites(dw, principal, {
        limit: a.limit as number | undefined,
        cursor: str(a.cursor) ?? null,
      });
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200 },
          cursor: { type: "string" },
        },
      }),
      output: fromSchema({
        type: "object",
        properties: {
          sites: { type: "array", items: HTTP_SITE },
          nextCursor: { type: ["string", "null"] },
        },
      }),
      handler: async (c) =>
        c.json(
          await listSites(D(c), P(c), {
            limit: Number(c.req.query("limit")) || undefined,
            cursor: c.req.query("cursor") ?? null,
          }),
        ),
    },
    tool: {
      summarize: (r) => `${r.sites.length} site(s)${r.nextCursor ? " (more: pass nextCursor)" : ""}.`,
    },
    cli: { command: ["sites", "ls"] },
    examples: [
      {
        input: {},
        output: {
          sites: [
            {
              slug: "bright-otter-x7k2",
              url: "https://dropway.example/s/bright-otter-x7k2/",
              currentVersionId: "ver_example",
            },
          ],
          nextCursor: null,
        },
      },
    ],
  }),
  defineOperation({
    id: "list_files",
    method: "GET",
    path: "/api/v1/sites/{slug}/files",
    summary: "List files",
    toolset: "core",
    scopes: ["sites:read"],
    description:
      "List the files of a site version (default: live): path, size, sha256, content type, viewer kind, the public `url` of each file and its `rawUrl` in the API. Filter with prefix; pages of up to 1000 (pass nextCursor back as cursor).",
    input: fromSchema({
      type: "object",
      properties: {
        site: SITE_REF,
        version: VERSION_REF,
        prefix: {
          type: "string",
          description: 'Only paths starting with this, e.g. "assets/".',
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "Default 200.",
        },
        cursor: { type: "string" },
      },
      required: ["site"],
      additionalProperties: false,
    }),
    output: fromSchema(
      obj(
        {
          site: { type: "string" },
          version: { anyOf: [VERSION_OUT, { type: "null" }] },
          files: { type: "array", items: ANY },
          total: { type: "integer" },
          nextCursor: { type: ["string", "null"] },
        },
        ["files"],
      ),
    ),
    annotations: RO,
    async handler(a, { dw, principal }) {
      const site = await getSiteByRef(dw, principal, a.site);
      const version = a.version === undefined ? null : await resolveVersionRef(dw, site, a.version);
      const listed = await listFiles(dw, site, version?.id ?? null);
      const prefix = str(a.prefix) ?? "";
      const matching = prefix ? listed.files.filter((f) => f.path.startsWith(prefix)) : listed.files;
      const start = Math.max(0, Number(a.cursor ?? 0) || 0);
      const limit = Math.min(1000, Math.max(1, Number(a.limit ?? 200) || 200));
      const page = matching.slice(start, start + limit);
      return {
        site: site.slug,
        version: listed.version,
        files: page,
        total: matching.length,
        nextCursor: start + limit < matching.length ? String(start + limit) : null,
      };
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: { slug: { type: "string" }, version: { type: "string" } },
        required: ["slug"],
      }),
      output: fromSchema({ type: "object" }),
      handler: async (c) => {
        const site = await getSiteFor(D(c), P(c), c.req.param("slug")!);
        return c.json(await listFiles(D(c), site, c.req.query("version") ?? null));
      },
    },
    tool: {
      summarize: (r) => `${r.total} file(s) in ${r.site}${r.version ? ` v${r.version.number}` : ""}${r.nextCursor ? `; showing ${r.files.length}` : ""}.`,
    },
    examples: [
      {
        input: { site: "bright-otter-x7k2" },
        output: {
          files: [
            {
              path: "index.html",
              size: 5,
              sha256: "0000000000000000000000000000000000000000000000000000000000000000",
              contentType: "text/html",
            },
          ],
        },
      },
    ],
  }),
  defineOperation({
    id: "read_file",
    method: "GET",
    path: "/api/v1/read-file",
    summary: "Read a file",
    toolset: "core",
    scopes: ["sites:read"],
    description:
      "Read back one published file. Text types return UTF-8 text; images and other binaries return base64 (force either with encoding). Reads up to 64 KB by default (max 1 MB per call); when truncated, call again with offset = nextOffset. Use it to check what you published.",
    input: fromSchema({
      type: "object",
      properties: {
        site: SITE_REF,
        path: { type: "string", description: 'File path, e.g. "index.html".' },
        version: VERSION_REF,
        encoding: {
          type: "string",
          enum: ["auto", "text", "base64"],
          description: 'Default "auto".',
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Byte offset to start at. Default 0.",
        },
        length: {
          type: "integer",
          minimum: 1,
          maximum: 1048576,
          description: "Bytes to read. Default 65536.",
        },
      },
      required: ["site", "path"],
      additionalProperties: false,
    }),
    output: fromSchema(
      obj(
        {
          path: { type: "string" },
          versionId: { type: "string" },
          contentType: { type: "string" },
          kind: { type: "string" },
          size: { type: "integer" },
          sha256: { type: "string" },
          encoding: { type: "string" },
          offset: { type: "integer" },
          length: { type: "integer" },
          truncated: { type: "boolean" },
          nextOffset: { type: ["integer", "null"] },
          content: { type: "string" },
          url: { type: "string" },
          rawUrl: { type: "string" },
        },
        ["path", "content", "encoding", "size"],
      ),
    ),
    annotations: RO,
    async handler(a, { dw, principal }) {
      const site = await getSiteByRef(dw, principal, a.site);
      const version = a.version === undefined ? null : await resolveVersionRef(dw, site, a.version);
      return readFileSlice(dw, site, a.path, {
        version,
        offset: a.offset,
        length: a.length,
        encoding: a.encoding,
      });
    },
    tool: {
      summarize: (r) =>
        `${r.path}: ${r.size} bytes ${r.contentType}${r.truncated ? `, showing bytes ${r.offset}-${r.offset + r.length} (next offset ${r.nextOffset})` : ""}.`,
    },
    examples: [
      {
        input: { site: "bright-otter-x7k2", path: "index.html" },
        output: {
          path: "index.html",
          content: "Hello",
          encoding: "text",
          size: 5,
        },
      },
    ],
  }),
  defineOperation({
    id: "list_versions",
    method: "GET",
    path: "/api/v1/sites/{slug}/versions",
    summary: "List versions",
    toolset: "core",
    scopes: ["sites:read"],
    description:
      "List the immutable versions of a site, newest first: number, live flag, file count, size, source, client and message. Restore any of them with restore_version.",
    input: fromSchema({
      type: "object",
      properties: {
        site: SITE_REF,
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Default 50.",
        },
      },
      required: ["site"],
      additionalProperties: false,
    }),
    output: fromSchema(
      obj(
        {
          site: { type: "string" },
          liveVersionId: { type: ["string", "null"] },
          versions: { type: "array", items: VERSION_OUT },
        },
        ["versions"],
      ),
    ),
    annotations: RO,
    async handler(a, { dw, principal }) {
      const site = await getSiteByRef(dw, principal, a.site);
      return {
        site: site.slug,
        liveVersionId: site.current_version_id,
        versions: await listVersions(dw, site, {
          limit: a.limit as number | undefined,
        }),
      };
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: {
          slug: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        required: ["slug"],
      }),
      output: fromSchema({ type: "object" }),
      handler: async (c) => {
        const site = await getSiteFor(D(c), P(c), c.req.param("slug")!);
        return c.json({
          currentVersionId: site.current_version_id,
          versions: await listVersions(D(c), site, {
            limit: Number(c.req.query("limit")) || undefined,
          }),
        });
      },
    },
    tool: {
      summarize: (r) =>
        `${r.versions.length} version(s) of ${r.site}; live is ${r.versions.find((v: any) => v.live)?.number ? `v${r.versions.find((v: any) => v.live).number}` : "none"}.`,
    },
    cli: { command: ["versions", "ls"] },
    examples: [
      {
        input: { site: "bright-otter-x7k2" },
        output: {
          currentVersionId: "ver_example",
          versions: [{ id: "ver_example", number: 1, status: "ready", live: true }],
        },
      },
    ],
  }),
  defineOperation({
    id: "restore_version",
    method: "POST",
    path: "/api/v1/sites/{slug}/versions/{id}/restore",
    summary: "Restore a version",
    toolset: "core",
    scopes: ["sites:write"],
    description:
      'Make an older version live again (instant rollback; nothing is copied). version accepts "v3", "3" or a version id. Restoring the version that is already live is a harmless no-op.',
    input: fromSchema({
      type: "object",
      properties: { site: SITE_REF, version: VERSION_REF },
      required: ["site", "version"],
      additionalProperties: false,
    }),
    output: fromSchema(
      obj(
        {
          restored: { type: "boolean" },
          alreadyLive: { type: "boolean" },
          version: VERSION_OUT,
          url: { type: "string" },
          slug: { type: "string" },
        },
        ["restored", "version", "url"],
      ),
    ),
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      const site = await getSiteByRef(dw, principal, a.site, "sites:write");
      const version = await resolveVersionRef(dw, site, a.version);
      const out = await restoreVersion(dw, principal, site, version.id);
      return { ...out, slug: site.slug, url: siteUrl(dw, site.slug) };
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: { slug: { type: "string" }, id: { type: "string" } },
        required: ["slug", "id"],
      }),
      output: fromSchema({ type: "object" }),
      handler: async (c) => {
        const dw = D(c);
        const site = await getSiteByRef(dw, P(c), c.req.param("slug")!, "sites:write");
        const version = await resolveVersionRef(dw, site, c.req.param("id")!);
        const out = await restoreVersion(dw, P(c), site, version.id);
        return c.json({ ...out, url: siteUrl(dw, site.slug) });
      },
    },
    tool: {
      summarize: (r) =>
        r.alreadyLive ? `v${r.version.number} of ${r.slug} was already live: ${r.url}` : `Restored ${r.slug} to v${r.version.number}: ${r.url}`,
    },
    cli: { command: ["versions", "restore"] },
    examples: [
      {
        input: { site: "bright-otter-x7k2", version: "ver_example" },
        output: {
          restored: true,
          version: {
            id: "ver_example",
            number: 1,
            status: "ready",
            live: true,
          },
          url: "https://dropway.example/s/bright-otter-x7k2/",
        },
      },
    ],
  }),
  defineOperation({
    id: "update_site_settings",
    method: "PATCH",
    path: "/api/v1/sites/{slug}",
    summary: "Change site settings",
    toolset: "core",
    scopes: ["sites:write"],
    description:
      "Change a site's title, description or serving settings: spa (unknown paths serve index.html, for single-page apps), renderMarkdown (browsers see .md rendered; false serves raw), crossOriginIsolation (COOP/COEP headers for SharedArrayBuffer). Only the fields you pass change. Passwords: set_site_access.",
    input: fromSchema({
      type: "object",
      properties: { site: SITE_REF, ...SETTINGS_INPUT },
      required: ["site"],
      additionalProperties: false,
    }),
    output: fromSchema(obj({ site: SITE_OUT }, ["site"])),
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      const slug = await resolveSiteSlug(dw, a.site);
      return {
        site: await siteOut(dw, await updateSite(dw, principal, slug, settingsFrom(a))),
      };
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: {
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
          slug: { type: "string" },
        },
        required: ["slug"],
      }),
      output: fromSchema({ type: "object", properties: { site: HTTP_SITE } }),
      handler: async (c) => {
        const site = await updateSite(D(c), P(c), c.req.param("slug")!, parseSettings(await readJson(c)));
        return c.json({ site: await describeSite(D(c), site) });
      },
    },
    tool: {
      summarize: (r) =>
        `Updated ${r.site.slug}: spa ${r.site.settings.spa}, renderMarkdown ${r.site.settings.renderMarkdown}, crossOriginIsolation ${r.site.settings.crossOriginIsolation}.`,
    },
    examples: [
      {
        input: { site: "bright-otter-x7k2", title: "My page" },
        output: {
          site: {
            slug: "bright-otter-x7k2",
            url: "https://dropway.example/s/bright-otter-x7k2/",
            currentVersionId: "ver_example",
          },
        },
      },
    ],
  }),
  defineOperation({
    id: "set_site_access",
    method: "PUT",
    path: "/api/v1/sites/{slug}/access",
    summary: "Set who can open a site",
    toolset: "core",
    scopes: ["sites:write"],
    description:
      'Set a site\'s access mode. "public": anyone with the link. "password": visitors must enter the password (stored hashed; changing it signs everyone out). Modes "restricted" and "private" are not available on this edition yet and return feature_unavailable.',
    input: fromSchema({
      type: "object",
      properties: {
        site: SITE_REF,
        mode: {
          type: "string",
          enum: ["public", "password", "restricted", "private"],
        },
        password: {
          type: "string",
          minLength: 4,
          maxLength: 200,
          description: 'Required for mode "password".',
        },
      },
      required: ["site", "mode"],
      additionalProperties: false,
    }),
    output: fromSchema(obj({ site: SITE_OUT, access: ANY }, ["site", "access"])),
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      const out = await setSiteAccess(dw, principal, a.site, {
        mode: a.mode,
        password: a.password,
      });
      return { site: await siteOut(dw, out.site), access: { mode: out.mode } };
    },
    http: {
      input: fromSchema({
        type: "object",
        required: ["mode", "slug"],
        properties: {
          mode: { enum: ["public", "password", "restricted", "private"] },
          password: { type: "string", minLength: 4, maxLength: 200 },
          slug: { type: "string" },
        },
      }),
      output: fromSchema({
        type: "object",
        properties: {
          site: HTTP_SITE,
          access: { type: "object", properties: { mode: { type: "string" } } },
        },
      }),
      handler: async (c) => {
        const body = await readJson(c);
        const out = await setSiteAccess(D(c), P(c), c.req.param("slug")!, {
          mode: body.mode,
          password: body.password,
        });
        return c.json({
          site: {
            ...(await describeSite(D(c), out.site)),
            access: { mode: out.mode },
          },
          access: { mode: out.mode },
        });
      },
    },
    tool: {
      summarize: (r) => `${r.site.slug} is now ${r.access.mode === "password" ? "password-protected" : "public"}: ${r.site.url}`,
    },
    examples: [
      {
        input: { site: "bright-otter-x7k2", mode: "public" },
        output: {
          site: {
            slug: "bright-otter-x7k2",
            url: "https://dropway.example/s/bright-otter-x7k2/",
            currentVersionId: "ver_example",
          },
          access: { mode: "public" },
        },
      },
    ],
  }),
  defineOperation({
    id: "delete_site",
    method: "DELETE",
    path: "/api/v1/sites/{slug}",
    summary: "Delete a site",
    toolset: "core",
    scopes: ["sites:delete"],
    description: "Delete a site and all its versions. Its URL stops working at once and the name is held for your tenant: only you may reclaim it before the hold ends. Set confirm to the site's slug.",
    input: fromSchema({
      type: "object",
      properties: { site: SITE_REF, confirm: CONFIRM_SLUG },
      required: ["site", "confirm"],
      additionalProperties: false,
    }),
    output: fromSchema(obj({ deleted: { type: "boolean" }, slug: { type: "string" } }, ["deleted", "slug"])),
    annotations: DESTROY,
    async handler(a, { dw, principal }) {
      const site = await getSiteByRef(dw, principal, a.site, "sites:delete");
      requireConfirm(a.confirm, site.slug);
      return deleteSite(dw, principal, site.slug);
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
      }),
      output: fromSchema({ type: "object" }),
      handler: async (c) => c.json(await deleteSite(D(c), P(c), c.req.param("slug")!)),
    },
    tool: { summarize: (r) => `Deleted ${r.slug}.` },
    cli: { command: ["sites", "delete"] },
    examples: [
      {
        input: { site: "bright-otter-x7k2", confirm: "bright-otter-x7k2" },
        output: { deleted: true, slug: "bright-otter-x7k2" },
      },
    ],
  }),
  defineOperation({
    id: "claim_site",
    method: "POST",
    path: "/api/v1/sites/{slug}/claim",
    summary: "Claim an anonymous site",
    toolset: "core",
    scopes: ["sites:write"],
    description:
      "Move an anonymous site (published without a key, so it expires) into your account using the claimToken from its publish response. It stops expiring and the claim token stops working.",
    input: fromSchema({
      type: "object",
      properties: {
        site: SITE_REF,
        claimToken: { type: "string", pattern: "^dwc_" },
      },
      required: ["site", "claimToken"],
      additionalProperties: false,
    }),
    output: fromSchema(obj({ claimed: { type: "boolean" }, site: SITE_OUT }, ["claimed", "site"])),
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      const site = await claimSite(dw, principal, await resolveSiteSlug(dw, a.site), a.claimToken);
      return { claimed: true, site: await siteOut(dw, site) };
    },
    http: {
      input: fromSchema({
        type: "object",
        required: ["claimToken", "slug"],
        properties: {
          claimToken: { type: "string" },
          slug: { type: "string" },
        },
      }),
      output: fromSchema({ type: "object" }),
      handler: async (c) => {
        const body = await readJson(c);
        const site = await claimSite(D(c), P(c), c.req.param("slug")!, body.claimToken);
        return c.json({ claimed: true, site: await describeSite(D(c), site) });
      },
    },
    tool: {
      enabled: (dw) => dw.config.anonymous.enabled,
      unavailableReason: "anonymous publishing is disabled; previously issued sites can still be claimed through REST",
      summarize: (r) => `Claimed ${r.site.slug}; it no longer expires: ${r.site.url}`,
    },
    examples: [
      {
        input: { site: "bright-otter-x7k2", claimToken: "dwc_example" },
        output: {
          claimed: true,
          site: {
            slug: "bright-otter-x7k2",
            url: "https://dropway.example/s/bright-otter-x7k2/",
            currentVersionId: "ver_example",
          },
        },
      },
    ],
  }),
];
