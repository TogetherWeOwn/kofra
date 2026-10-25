import { HTTP_SITE, HTTP_MANIFEST_ENTRY, HTTP_DEPLOY } from "./http-schemas";
import { accessModeOf, appOrigin, createSite, describeSite, parseSettings, releaseSlug, renameSite, requireConfirm, siteUrl, createSiteWithDeploy, serializeSite } from "@dropway/core";
import { CONFIRM_SLUG, SETTINGS_INPUT, SITE_OUT, SITE_REF, obj } from "../mcp/schemas";
import { readJson } from "../routes/api";
import { defineOperation, rawRequestInput } from "../operations";
import { fromSchema, LIST, WRITE, CREATE, DESTROY, siteOut, str, settingsFrom, P, D, clientOf } from "./shared";

export const SITE_OPERATIONS = [
  defineOperation({
    id: "create_site",
    anonymous: true,
    method: "POST",
    path: "/api/v1/sites",
    summary: "Create an empty site",
    toolset: "sites",
    scopes: ["sites:write"],
    description:
      "Reserve a site (optionally with a chosen slug and settings) without publishing files yet. Usually you do not need this: publish_site creates the site and publishes in one call.",
    input: fromSchema({
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "3-56 chars: a-z, 0-9, single hyphens. Omit for a generated name.",
        },
        ...SETTINGS_INPUT,
      },
      additionalProperties: false,
    }),
    output: fromSchema(obj({ site: SITE_OUT, url: { type: "string" }, slug: { type: "string" } }, ["site", "url"])),
    annotations: CREATE,
    async handler(a, { dw, principal }) {
      const { site } = await createSite(dw, principal, {
        slug: str(a.slug) ?? null,
        ...settingsFrom(a),
      });
      return {
        site: await siteOut(dw, site),
        slug: site.slug,
        url: siteUrl(dw, site.slug),
      };
    },
    http: {
      statuses: [201],
      // The handler coerces legacy settings itself; schema validation would
      // reject those before it runs.
      parseInput: (c) => rawRequestInput(c),
      input: fromSchema({
        type: "object",
        properties: {
          slug: { type: "string" },
          files: { type: "array", items: HTTP_MANIFEST_ENTRY },
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
      }),
      output: fromSchema({
        type: "object",
        properties: {
          site: HTTP_SITE,
          url: { type: "string" },
          claimToken: { type: "string" },
          deploy: HTTP_DEPLOY,
        },
      }),
      handler: async (c) => {
        const dw = D(c);
        const p = P(c);
        const body = await readJson(c);
        // Validates `files` before the site exists and removes the site again if its deploy fails.
        const { site, claimToken, deploy } = await createSiteWithDeploy(
          dw,
          p,
          {
            slug: (body.slug as string | undefined) ?? null,
            ...parseSettings(body),
          },
          body.files,
          {
            message: body.message,
            client: clientOf(c),
            source: "api",
          },
        );
        const out: Record<string, unknown> = {
          site: serializeSite(dw, site, null),
          url: siteUrl(dw, site.slug),
        };
        if (claimToken) {
          out.claimToken = claimToken;
          out.claimUrl = `${appOrigin(dw)}/claim?slug=${site.slug}#token=${claimToken}`;
          out.expiresAt = site.expires_at ? new Date(site.expires_at).toISOString() : null;
          out.note = "Anonymous site: it expires. Use `Authorization: Bearer <claimToken>` for deploys and uploads to it.";
        }
        if (deploy) out.deploy = deploy;
        return c.json(out, 201);
      },
    },
    tool: {
      idempotent: true,
      summarize: (r) => `Created empty site ${r.slug}; publish files with publish_site (site: "${r.slug}").`,
    },
    examples: [
      {
        input: { slug: "bright-otter-x7k2" },
        output: {
          site: {
            slug: "bright-otter-x7k2",
            url: "https://dropway.example/s/bright-otter-x7k2/",
            currentVersionId: "ver_example",
          },
          url: "https://dropway.example/s/bright-otter-x7k2/",
        },
      },
    ],
  }),
  defineOperation({
    id: "rename_site",
    method: "POST",
    path: "/api/v1/sites/{slug}/rename",
    summary: "Rename a site",
    toolset: "sites",
    scopes: ["sites:write"],
    description:
      "Give a site a new slug, which changes its URL. An ordinary site's old URL answers 308 to the new URL (path and query kept) until redirectUntil. Transfers keep permanent sender reservations without a redirect (redirectUntil is null).",
    input: fromSchema({
      type: "object",
      properties: {
        site: SITE_REF,
        newSlug: {
          type: "string",
          description: "3-56 chars: a-z, 0-9, single hyphens.",
        },
      },
      required: ["site", "newSlug"],
      additionalProperties: false,
    }),
    output: fromSchema(
      obj(
        {
          renamed: { type: "boolean" },
          oldSlug: { type: "string" },
          slug: { type: "string" },
          url: { type: "string" },
          redirectUntil: { type: ["string", "null"], description: "Until when the old URL 308s to the new one (ISO 8601); null for a no-op or transfer rename." },
          site: SITE_OUT,
          warnings: LIST,
        },
        ["renamed", "slug", "url"],
      ),
    ),
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      const out = await renameSite(dw, principal, a.site, a.newSlug);
      const redirectUntil = out.redirectUntil ? new Date(out.redirectUntil).toISOString() : null;
      return {
        renamed: out.renamed,
        oldSlug: out.oldSlug,
        slug: out.site.slug,
        url: siteUrl(dw, out.site.slug),
        redirectUntil,
        site: await siteOut(dw, out.site),
        warnings: out.renamed && redirectUntil !== null
          ? [
              {
                code: "old_url_redirects",
                message: `${siteUrl(dw, out.oldSlug)} now redirects (308) to ${siteUrl(dw, out.site.slug)} until ${redirectUntil}.`,
              },
            ]
          : [],
      };
    },
    http: {
      input: fromSchema({
        type: "object",
        required: ["newSlug", "slug"],
        properties: { newSlug: { type: "string" }, slug: { type: "string" } },
      }),
      output: fromSchema({
        type: "object",
        properties: {
          renamed: { type: "boolean" },
          oldSlug: { type: "string" },
          slug: { type: "string" },
          url: { type: "string" },
          redirectUntil: { type: ["string", "null"] },
          site: HTTP_SITE,
        },
      }),
      handler: async (c) => {
        const body = await readJson(c);
        const out = await renameSite(D(c), P(c), c.req.param("slug")!, body.newSlug ?? body.slug);
        return c.json({
          renamed: out.renamed,
          oldSlug: out.oldSlug,
          slug: out.site.slug,
          url: siteUrl(D(c), out.site.slug),
          redirectUntil: out.redirectUntil ? new Date(out.redirectUntil).toISOString() : null,
          site: {
            ...(await describeSite(D(c), out.site)),
            access: { mode: accessModeOf(out.site) },
          },
        });
      },
    },
    tool: {
      summarize: (r) => (r.renamed ? `Renamed ${r.oldSlug} to ${r.slug}: ${r.url}` : `${r.slug} already has that name.`),
    },
    examples: [
      {
        input: { site: "bright-otter-x7k2", newSlug: "renamed-page" },
        output: {
          renamed: true,
          oldSlug: "bright-otter-x7k2",
          slug: "renamed-page",
          url: "https://dropway.example/s/renamed-page/",
          redirectUntil: "2027-10-24T00:00:00.000Z",
          site: {
            slug: "renamed-page",
            url: "https://dropway.example/s/bright-otter-x7k2/",
            currentVersionId: "ver_example",
          },
        },
      },
    ],
  }),
  defineOperation({
    id: "release_slug",
    method: "POST",
    path: "/api/v1/slugs/release",
    summary: "Release a held site name early",
    toolset: "sites",
    scopes: ["admin"],
    description:
      "Release your tenant's freed site name before its hold ends, using an unrestricted admin key and a required reason kept as the audit record. The name becomes free at once. Set confirm to the slug. Cross-tenant disputes and ownerless holds require the instance operator's audited database procedure; tenant admin keys cannot release them.",
    input: fromSchema({
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "The held name to release.",
        },
        reason: {
          type: "string",
          description: "Why the hold ends early (for example a trademark dispute reference). Kept as the audit record.",
        },
        confirm: CONFIRM_SLUG,
      },
      required: ["slug", "reason", "confirm"],
      additionalProperties: false,
    }),
    output: fromSchema(
      obj(
        {
          released: { type: "boolean" },
          slug: { type: "string" },
          redirectsReleased: { type: "number" },
          holdsReleased: { type: "number" },
          reason: { type: "string" },
        },
        ["released", "slug", "reason"],
      ),
    ),
    annotations: DESTROY,
    confirm: "slug",
    async handler(a, { dw, principal }) {
      return releaseSlug(dw, principal, a.slug, a.reason);
    },
    http: {
      input: fromSchema({
        type: "object",
        required: ["slug", "reason", "confirm"],
        properties: { slug: { type: "string" }, reason: { type: "string" }, confirm: { type: "string" } },
      }),
      output: fromSchema({
        type: "object",
        properties: {
          released: { type: "boolean" },
          slug: { type: "string" },
          redirectsReleased: { type: "number" },
          holdsReleased: { type: "number" },
          reason: { type: "string" },
        },
      }),
      handler: async (c) => {
        const body = await readJson(c);
        // Custom http handlers bypass the registry's declarative confirm check; enforce it here.
        requireConfirm(body.confirm, String(body.slug ?? ""), "the slug");
        return c.json(await releaseSlug(D(c), P(c), body.slug, body.reason));
      },
    },
    tool: {
      summarize: (r) => `Released the hold on ${r.slug}.`,
    },
    examples: [
      {
        input: { slug: "held-name", reason: "Trademark dispute #42", confirm: "held-name" },
        output: { released: true, slug: "held-name", redirectsReleased: 0, holdsReleased: 1, reason: "Trademark dispute #42" },
      },
    ],
  }),
];
