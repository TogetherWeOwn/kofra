import { HTTP_SCOPES } from "./http-schemas";
import { ALL_SCOPES, createApiKey, listApiKeys, resolveSiteSlug, revokeApiKey } from "@kofra/core";
import { obj } from "../mcp/schemas";
import { readJson } from "../routes/api";
import { defineOperation } from "../operations";
import { fromSchema, ANY, RO, CREATE, DESTROY, P, D } from "./shared";

export const KEY_OPERATIONS = [
  defineOperation({
    id: "list_api_keys",
    method: "GET",
    path: "/api/v1/keys",
    summary: "List API keys",
    toolset: "keys",
    scopes: ["keys:write"],
    description:
      "List active API keys (never the secrets): id, name, prefix, scopes, site restriction, expiry, last use. all=true lists every member's keys (needs members:write).",
    input: fromSchema({
      type: "object",
      properties: { all: { type: "boolean" } },
      additionalProperties: false,
    }),
    output: fromSchema(obj({ keys: { type: "array", items: ANY } }, ["keys"])),
    annotations: RO,
    async handler(a, { dw, principal }) {
      return {
        keys: await listApiKeys(dw, principal, { all: a.all === true }),
      };
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: { all: { type: "string", enum: ["1", "true"] } },
      }),
      output: fromSchema({ type: "object" }),
      handler: async (c) =>
        c.json({
          keys: await listApiKeys(D(c), P(c), {
            all: c.req.query("all") === "1" || c.req.query("all") === "true",
          }),
        }),
    },
    tool: { summarize: (r) => `${r.keys.length} active key(s).` },
    examples: [{ input: {}, output: { keys: [] } }],
  }),
  defineOperation({
    id: "create_api_key",
    method: "POST",
    path: "/api/v1/keys",
    summary: "Create an API key",
    toolset: "keys",
    scopes: ["keys:write"],
    description:
      "Create a key with a subset of your scopes, optionally restricted to one site. See scopes' enum for all supported permissions; deletion needs sites:delete, not sites:write. Store the secret `key`: it is shown ONCE and replay returns key: null.",
    input: fromSchema({
      type: "object",
      properties: {
        name: { type: "string", maxLength: 120 },
        scopes: {
          type: "array",
          items: {
            type: "string",
            enum: [...ALL_SCOPES],
          },
          description: "Default: all scopes you hold.",
        },
        site: {
          type: "string",
          description: "Restrict the key to this one site (slug).",
        },
        expiresInDays: { type: "number", exclusiveMinimum: 0 },
        memberId: {
          type: "string",
          description: "Create the key for another member (needs members:write).",
        },
      },
      additionalProperties: false,
    }),
    output: fromSchema(
      obj(
        {
          id: { type: "string" },
          key: { type: ["string", "null"] },
          scopes: { type: "array", items: { type: "string" } },
          siteId: { type: ["string", "null"] },
        },
        ["id"],
      ),
    ),
    annotations: CREATE,
    async handler(a, { dw, principal }) {
      const site = a.site === undefined ? undefined : await resolveSiteSlug(dw, a.site);
      return {
        ...(await createApiKey(dw, principal, {
          name: a.name,
          scopes: a.scopes,
          expiresInDays: a.expiresInDays,
          memberId: a.memberId,
          site,
        })),
        note: "Store key now; it is shown only once.",
      };
    },
    http: {
      statuses: [201],
      input: fromSchema({
        type: "object",
        properties: {
          name: { type: "string" },
          scopes: HTTP_SCOPES,
          expiresInDays: { type: "number" },
          memberId: { type: "string" },
          site: { type: "string" },
        },
      }),
      output: fromSchema({ type: "object" }),
      handler: async (c) => {
        const body = await readJson(c);
        const key = await createApiKey(D(c), P(c), body);
        return c.json({ ...key, note: "Store key now; it is shown only once." }, 201);
      },
    },
    tool: {
      idempotent: true,
      redactForReplay: (r: any) => ({
        ...r,
        key: null,
        note: "Replayed: the secret was shown only in the first response. If it is lost, revoke this key and create a new one.",
      }),
      summarize: (r) => `Created key ${r.id} (${(r.scopes ?? []).join(", ")})${r.key ? "; the secret is in `key`, shown once" : ""}.`,
    },
    examples: [
      {
        input: { name: "reader", scopes: ["sites:read"] },
        output: {
          id: "key_example",
          key: "dw_example",
          scopes: ["sites:read"],
          siteId: null,
        },
      },
    ],
  }),
  defineOperation({
    id: "revoke_api_key",
    method: "DELETE",
    path: "/api/v1/keys/{id}",
    summary: "Revoke an API key",
    toolset: "keys",
    scopes: ["keys:write"],
    description: "Revoke an API key by id (from list_api_keys). It stops working at once. You can revoke your own keys, or anyone's with members:write.",
    input: fromSchema({
      type: "object",
      properties: { id: { type: "string", pattern: "^key_" } },
      required: ["id"],
      additionalProperties: false,
    }),
    output: fromSchema(obj({ revoked: { type: "boolean" }, id: { type: "string" } }, ["revoked", "id"])),
    annotations: DESTROY,
    async handler(a, { dw, principal }) {
      return revokeApiKey(dw, principal, String(a.id));
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      }),
      output: fromSchema({ type: "object" }),
      handler: async (c) => c.json(await revokeApiKey(D(c), P(c), c.req.param("id")!)),
    },
    tool: { summarize: (r) => `Revoked key ${r.id}.` },
    examples: [
      {
        input: { id: "key_example" },
        output: { revoked: true, id: "key_example" },
      },
    ],
  }),
];
