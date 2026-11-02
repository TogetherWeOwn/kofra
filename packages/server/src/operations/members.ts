import { HTTP_SCOPES } from "./http-schemas";
import { ALL_SCOPES, createMember, listMembers, removeMember, requireConfirm, updateMember } from "@kofra/core";
import { obj } from "../mcp/schemas";
import { readJson } from "../routes/api";
import { defineOperation } from "../operations";
import { fromSchema, ANY, RO, WRITE, DESTROY, P, D } from "./shared";

export const MEMBER_OPERATIONS = [
  defineOperation({
    id: "list_members",
    method: "GET",
    path: "/api/v1/members",
    summary: "List members",
    toolset: "members",
    scopes: ["sites:read"],
    description: "List the members of this instance: id, email, name, role (owner, admin, member).",
    input: fromSchema({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    output: fromSchema(obj({ members: { type: "array", items: ANY } }, ["members"])),
    annotations: RO,
    async handler(_a, { dw, principal }) {
      return { members: await listMembers(dw, principal) };
    },
    http: {
      input: fromSchema({ type: "object", properties: {} }),
      output: fromSchema({ type: "object" }),
      handler: async (c) => c.json({ members: await listMembers(D(c), P(c)) }),
    },
    tool: { summarize: (r) => `${r.members.length} member(s).` },
    examples: [
      {
        input: {},
        output: {
          members: [
            {
              id: "mem_example",
              email: "person@example.com",
              name: "Example",
              role: "member",
            },
          ],
        },
      },
    ],
  }),
  defineOperation({
    id: "add_member",
    method: "POST",
    path: "/api/v1/members",
    summary: "Add a member",
    toolset: "members",
    scopes: ["members:write"],
    description:
      "Add a person or agent as a member (role member or admin; owners need an owner key). Returns their first API key, shown ONCE: hand it to them.",
    input: fromSchema({
      type: "object",
      properties: {
        email: { type: "string" },
        name: { type: "string", maxLength: 120 },
        role: {
          type: "string",
          enum: ["owner", "admin", "member"],
          description: 'Default "member".',
        },
        scopes: {
          type: "array",
          items: {
            type: "string",
            enum: [...ALL_SCOPES],
          },
        },
      },
      additionalProperties: false,
    }),
    output: fromSchema(obj({ member: ANY, apiKey: ANY }, ["member", "apiKey"])),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async handler(a, { dw, principal }) {
      return {
        ...(await createMember(dw, principal, {
          email: a.email,
          name: a.name,
          role: a.role,
          scopes: a.scopes,
        })),
        note: "Give apiKey.key to the new member; it is shown only once.",
      };
    },
    http: {
      statuses: [201],
      input: fromSchema({
        type: "object",
        properties: {
          email: { type: "string" },
          name: { type: "string" },
          role: { enum: ["owner", "admin", "member"] },
          scopes: HTTP_SCOPES,
        },
      }),
      output: fromSchema({ type: "object" }),
      handler: async (c) =>
        c.json(
          {
            ...(await createMember(D(c), P(c), await readJson(c))),
            note: "Give apiKey.key to the new member; it is shown only once.",
          },
          201,
        ),
    },
    tool: {
      idempotent: true,
      redactForReplay: (r: any) => ({
        ...r,
        apiKey: { ...r.apiKey, key: null },
        note: "Replayed: the secret was shown only in the first response.",
      }),
      summarize: (r) => `Added ${r.member.email ?? r.member.id} as ${r.member.role}.`,
    },
    examples: [
      {
        input: { email: "person@example.com", name: "Example" },
        output: {
          member: {
            id: "mem_example",
            email: "person@example.com",
            name: "Example",
            role: "member",
          },
          apiKey: { id: "key_example", key: "dw_example" },
        },
      },
    ],
  }),
  defineOperation({
    id: "update_member",
    method: "PATCH",
    path: "/api/v1/members/{id}",
    summary: "Change a member",
    toolset: "members",
    scopes: ["members:write"],
    description: "Change a member's name or role. Only owners can grant or remove the owner role, and an instance always keeps one owner.",
    input: fromSchema({
      type: "object",
      properties: {
        id: { type: "string", pattern: "^mem_" },
        name: { type: ["string", "null"] },
        role: { type: "string", enum: ["owner", "admin", "member"] },
      },
      required: ["id"],
      additionalProperties: false,
    }),
    output: fromSchema(obj({ member: ANY }, ["member"])),
    annotations: WRITE,
    async handler(a, { dw, principal }) {
      return {
        member: await updateMember(dw, principal, String(a.id), {
          name: a.name,
          role: a.role,
        }),
      };
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      }),
      output: fromSchema({ type: "object" }),
      handler: async (c) =>
        c.json({
          member: await updateMember(D(c), P(c), c.req.param("id")!, await readJson(c)),
        }),
    },
    tool: {
      summarize: (r) => `${r.member.email ?? r.member.id} is now ${r.member.role}.`,
    },
    examples: [
      {
        input: { id: "mem_example", name: "Updated name" },
        output: {
          member: {
            id: "mem_example",
            email: "person@example.com",
            name: "Updated name",
            role: "member",
          },
        },
      },
    ],
  }),
  defineOperation({
    id: "remove_member",
    method: "DELETE",
    path: "/api/v1/members/{id}",
    summary: "Remove a member",
    toolset: "members",
    scopes: ["members:write"],
    description: "Remove a member and revoke all their API keys. Their sites stay. Set confirm to the member's email (or id when they have no email).",
    input: fromSchema({
      type: "object",
      properties: {
        id: { type: "string", pattern: "^mem_" },
        confirm: {
          type: "string",
          description: "The member's email (or id if they have none).",
        },
      },
      required: ["id", "confirm"],
      additionalProperties: false,
    }),
    output: fromSchema(obj({ removed: { type: "boolean" }, id: { type: "string" } }, ["removed", "id"])),
    annotations: DESTROY,
    async handler(a, { dw, principal }) {
      const id = String(a.id);
      const m = (await listMembers(dw, principal)).find((x) => x.id === id);
      if (m) requireConfirm(a.confirm, m.email ?? m.id, "the member's email");
      return removeMember(dw, principal, id);
    },
    http: {
      input: fromSchema({
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      }),
      output: fromSchema({ type: "object" }),
      handler: async (c) => c.json(await removeMember(D(c), P(c), c.req.param("id")!)),
    },
    tool: {
      summarize: (r) => `Removed member ${r.id} and revoked their keys.`,
    },
    examples: [
      {
        input: { id: "mem_example", confirm: "person@example.com" },
        output: { removed: true, id: "mem_example" },
      },
    ],
  }),
];
