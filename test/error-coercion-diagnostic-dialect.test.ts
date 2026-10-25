import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody } from "./helpers";
import { connectLegacyMcp, connectMcp } from "./mcp-helpers";

// Manifest coercions must stay client errors, MCP diagnostics must preserve
// field identity, and dialect selection must be pinned by discriminating
// fixtures. These run against the real Worker through both MCP protocols.

// Bracket-notation for a single non-identifier segment, built with
// JSON.stringify so quoted keys are never hand-escaped.
const bracket = (segment: string): string => `[${JSON.stringify(segment)}]`;

const TRICKY_KEY = 'x" but does not have "y';
const LITERAL_DOT = "a.b";

function exactPaths(fields: unknown): string[] {
  expect(fields, "validation errors include details.fields").toBeDefined();
  if (!Array.isArray(fields)) return Object.keys(fields as object);
  return fields.map((field) =>
    typeof field === "string" ? field : String(field.path ?? field.field),
  );
}

async function storedDeploys() {
  return {
    versions: await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM versions",
    ).first<number>("count"),
    files: await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM version_files",
    ).first<number>("count"),
  };
}

async function deploySite(slug: string) {
  const instance = await freshInstance();
  const site = await instance.json("/api/v1/sites", {
    key: instance.ownerKey,
    ...jsonBody({ slug }),
  });
  expect(site.status).toBe(201);
  return instance;
}

describe("REST manifest coercions stay client errors", () => {
  it("keeps size-object coercion inside validation with the first semantic error", async () => {
    const instance = await deploySite("coercion-size-object");
    const before = await storedDeploys();
    const result = await instance.json(
      "/api/v1/sites/coercion-size-object/deploys",
      {
        key: instance.ownerKey,
        ...jsonBody({
          files: [
            {
              path: "../x",
              size: { toString: null },
              sha256: "bad",
              contentType: "text/plain",
            },
          ],
        }),
      },
    );
    expect(await storedDeploys()).toEqual(before);
    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe("invalid_path");
    expect(result.body.error?.retryable).toBe(false);
    expect(exactPaths(result.body.error?.details?.fields)).toEqual(
      expect.arrayContaining([
        "files.0.path",
        "files.0.size",
        "files.0.sha256",
      ]),
    );
  });

  it("keeps sha256-object coercion inside validation with the first semantic error", async () => {
    const instance = await deploySite("coercion-sha-object");
    const before = await storedDeploys();
    const result = await instance.json(
      "/api/v1/sites/coercion-sha-object/deploys",
      {
        key: instance.ownerKey,
        ...jsonBody({
          files: [
            {
              path: "../x",
              size: -1,
              sha256: { toString: null },
              contentType: "text/plain",
            },
          ],
        }),
      },
    );
    expect(await storedDeploys()).toEqual(before);
    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe("invalid_path");
    expect(result.body.error?.retryable).toBe(false);
    expect(exactPaths(result.body.error?.details?.fields)).toEqual(
      expect.arrayContaining([
        "files.0.path",
        "files.0.size",
        "files.0.sha256",
      ]),
    );
  });

  it("rejects a malformed path object as a client error without writing", async () => {
    const instance = await deploySite("coercion-path-object");
    const before = await storedDeploys();
    const result = await instance.json(
      "/api/v1/sites/coercion-path-object/deploys",
      {
        key: instance.ownerKey,
        ...jsonBody({
          files: [
            {
              path: { toString: null },
              size: 5,
              sha256: "a".repeat(64),
              contentType: "text/plain",
            },
          ],
        }),
      },
    );
    expect(await storedDeploys()).toEqual(before);
    expect(result.status).toBe(400);
    expect(result.body.error?.code).toBe("invalid_path");
    expect(result.body.error?.retryable).toBe(false);
    expect(exactPaths(result.body.error?.details?.fields)).toContain(
      "files.0.path",
    );
  });
});

for (const [protocol, connect] of [
  ["modern", connectMcp],
  ["legacy", connectLegacyMcp],
] as const) {
  describe(`${protocol} MCP diagnostic field identity`, () => {
    it("reports a literal dotted key and a nested path as two distinguishable fields", async () => {
      const dispatched: unknown[] = [];
      const instance = await freshInstance(
        {},
        {
          mcpTools: [
            {
              name: "dotted_identity_probe",
              description: "Literal and nested dotted fields stay distinct.",
              inputSchema: {
                type: "object",
                properties: {
                  [LITERAL_DOT]: { type: "integer" },
                  a: {
                    type: "object",
                    properties: { b: { type: "integer" } },
                  },
                },
              },
              async handler(args) {
                dispatched.push(structuredClone(args));
                return { received: args };
              },
            },
          ],
        },
      );
      const client = await connect(instance, instance.ownerKey);
      try {
        const accepted = await client.call("dotted_identity_probe", {
          [LITERAL_DOT]: 1,
          a: { b: 2 },
        });
        expect(accepted.isError).toBe(false);
        expect(accepted.data.received).toEqual({
          [LITERAL_DOT]: 1,
          a: { b: 2 },
        });
        expect(dispatched).toHaveLength(1);
        const rejected = await client.call("dotted_identity_probe", {
          [LITERAL_DOT]: "bad",
          a: { b: "bad" },
        });
        expect(rejected.isError).toBe(true);
        expect(
          dispatched,
          "invalid calls never reach the extension",
        ).toHaveLength(1);
        expect(rejected.data.error?.code).toBe("invalid_request");
        const paths = exactPaths(rejected.data.error?.details?.fields);
        expect(paths).toHaveLength(2);
        expect(new Set(paths)).toEqual(
          new Set([bracket(LITERAL_DOT), "a.b"]),
        );
      } finally {
        await client.client.close();
      }
    });

    it("uses the same bracket representation for missing required keys", async () => {
      const dispatched: unknown[] = [];
      const keys = [
        "plain",
        LITERAL_DOT,
        TRICKY_KEY,
        "a/b",
        "m~n",
        "a[0]",
        "",
      ];
      const properties: Record<string, unknown> = {};
      for (const key of keys) properties[key] = { type: "string" };
      const instance = await freshInstance(
        {},
        {
          mcpTools: [
            {
              name: "required_identity_probe",
              description: "Missing keys keep their exact identities.",
              inputSchema: {
                type: "object",
                required: keys,
                properties,
              },
              async handler(args) {
                dispatched.push(structuredClone(args));
                return { received: args };
              },
            },
          ],
        },
      );
      const client = await connect(instance, instance.ownerKey);
      try {
        const complete: Record<string, unknown> = {};
        for (const key of keys) complete[key] = "value";
        const accepted = await client.call(
          "required_identity_probe",
          complete,
        );
        expect(accepted.isError).toBe(false);
        expect(accepted.data.received).toEqual(complete);
        expect(dispatched).toHaveLength(1);
        const rejected = await client.call("required_identity_probe", {});
        expect(rejected.isError).toBe(true);
        expect(
          dispatched,
          "invalid calls never reach the extension",
        ).toHaveLength(1);
        expect(rejected.data.error?.code).toBe("invalid_request");
        const paths = exactPaths(rejected.data.error?.details?.fields);
        expect(paths).toHaveLength(keys.length);
        expect(new Set(paths)).toEqual(
          new Set([
            "plain",
            bracket(LITERAL_DOT),
            bracket(TRICKY_KEY),
            bracket("a/b"),
            bracket("m~n"),
            bracket("a[0]"),
            bracket(""),
          ]),
        );
      } finally {
        await client.client.close();
      }
    });

    it("reports every missing dependentRequired key without parsing prose", async () => {
      const dispatched: unknown[] = [];
      const trigger = "trigger.key";
      const dependents = ["dep.one", "dep.two", TRICKY_KEY];
      const properties: Record<string, unknown> = {
        [trigger]: { type: "string" },
      };
      for (const key of dependents) properties[key] = { type: "string" };
      const instance = await freshInstance(
        {},
        {
          mcpTools: [
            {
              name: "dependent_required_probe",
              description: "Dependent keys keep their exact identities.",
              inputSchema: {
                type: "object",
                properties,
                dependentRequired: { [trigger]: dependents },
              },
              async handler(args) {
                dispatched.push(structuredClone(args));
                return { received: args };
              },
            },
          ],
        },
      );
      const client = await connect(instance, instance.ownerKey);
      try {
        const complete: Record<string, unknown> = { [trigger]: "x" };
        for (const key of dependents) complete[key] = "value";
        const accepted = await client.call(
          "dependent_required_probe",
          complete,
        );
        expect(accepted.isError).toBe(false);
        expect(accepted.data.received).toEqual(complete);
        expect(dispatched).toHaveLength(1);
        const rejected = await client.call("dependent_required_probe", {
          [trigger]: "x",
        });
        expect(rejected.isError).toBe(true);
        expect(
          dispatched,
          "invalid calls never reach the extension",
        ).toHaveLength(1);
        expect(rejected.data.error?.code).toBe("invalid_request");
        const paths = exactPaths(rejected.data.error?.details?.fields);
        expect(paths).toHaveLength(dependents.length);
        expect(new Set(paths)).toEqual(
          new Set(dependents.map((key) => bracket(key))),
        );
      } finally {
        await client.client.close();
      }
    });

    it("reports every missing dependencies key without parsing prose", async () => {
      const dispatched: unknown[] = [];
      const trigger = "trigger.key";
      const dependents = ["dep.one", TRICKY_KEY];
      const properties: Record<string, unknown> = {
        [trigger]: { type: "string" },
      };
      for (const key of dependents) properties[key] = { type: "string" };
      const instance = await freshInstance(
        {},
        {
          mcpTools: [
            {
              name: "dependencies_probe",
              description: "Draft-07 dependencies keep exact identities.",
              inputSchema: {
                $schema: "http://json-schema.org/draft-07/schema#",
                type: "object",
                properties,
                dependencies: { [trigger]: dependents },
              },
              async handler(args) {
                dispatched.push(structuredClone(args));
                return { received: args };
              },
            },
          ],
        },
      );
      const client = await connect(instance, instance.ownerKey);
      try {
        const complete: Record<string, unknown> = { [trigger]: "x" };
        for (const key of dependents) complete[key] = "value";
        const accepted = await client.call("dependencies_probe", complete);
        expect(accepted.isError).toBe(false);
        expect(accepted.data.received).toEqual(complete);
        expect(dispatched).toHaveLength(1);
        const rejected = await client.call("dependencies_probe", {
          [trigger]: "x",
        });
        expect(rejected.isError).toBe(true);
        expect(
          dispatched,
          "invalid calls never reach the extension",
        ).toHaveLength(1);
        expect(rejected.data.error?.code).toBe("invalid_request");
        const paths = exactPaths(rejected.data.error?.details?.fields);
        expect(paths).toHaveLength(dependents.length);
        expect(new Set(paths)).toEqual(
          new Set(dependents.map((key) => bracket(key))),
        );
      } finally {
        await client.client.close();
      }
    });

    it("renders a nested dotted segment with brackets", async () => {
      const dispatched: unknown[] = [];
      const instance = await freshInstance(
        {},
        {
          mcpTools: [
            {
              name: "nested_bracket_probe",
              description: "Nested special segments keep brackets.",
              inputSchema: {
                type: "object",
                properties: {
                  a: {
                    type: "object",
                    required: ["b.c"],
                    properties: { "b.c": { type: "integer" } },
                  },
                },
              },
              async handler(args) {
                dispatched.push(structuredClone(args));
                return { received: args };
              },
            },
          ],
        },
      );
      const client = await connect(instance, instance.ownerKey);
      try {
        const accepted = await client.call("nested_bracket_probe", {
          a: { "b.c": 1 },
        });
        expect(accepted.isError).toBe(false);
        expect(dispatched).toHaveLength(1);
        const wrongType = await client.call("nested_bracket_probe", {
          a: { "b.c": "bad" },
        });
        expect(wrongType.isError).toBe(true);
        expect(dispatched).toHaveLength(1);
        expect(
          exactPaths(wrongType.data.error?.details?.fields),
        ).toEqual([`a${bracket("b.c")}`]);
        const missing = await client.call("nested_bracket_probe", { a: {} });
        expect(missing.isError).toBe(true);
        expect(dispatched).toHaveLength(1);
        expect(exactPaths(missing.data.error?.details?.fields)).toEqual([
          `a${bracket("b.c")}`,
        ]);
      } finally {
        await client.client.close();
      }
    });
  });
}

const DIALECTS = [
  ["draft-07", "http://json-schema.org/draft-07/schema#", true],
  ["draft-06", "http://json-schema.org/draft-06/schema#", true],
  ["2019-09", "https://json-schema.org/draft/2019-09/schema", false],
  ["2020-12", "https://json-schema.org/draft/2020-12/schema", false],
] as const;

for (const [protocol, connect] of [
  ["modern", connectMcp],
  ["legacy", connectLegacyMcp],
] as const) {
  describe(`${protocol} MCP schema dialect selection`, () => {
    for (const [label, schemaUri, acceptsString] of DIALECTS) {
      it(`applies $ref-sibling semantics for ${label}`, async () => {
        const dispatched: unknown[] = [];
        const instance = await freshInstance(
          {},
          {
            mcpTools: [
              {
                name: "dialect_probe",
                description: `Reference sibling under ${label}.`,
                inputSchema: {
                  $schema: schemaUri,
                  type: "object",
                  definitions: { str: { type: "string" } },
                  properties: {
                    mode: { $ref: "#/definitions/str", type: "number" },
                  },
                },
                async handler(args) {
                  dispatched.push(structuredClone(args));
                  return { received: args };
                },
              },
            ],
          },
        );
        const client = await connect(instance, instance.ownerKey);
        try {
          const empty = await client.call("dialect_probe", {});
          expect(empty.isError).toBe(false);
          expect(empty.data.received).toEqual({});
          expect(dispatched).toEqual([{}]);
          const stringInput = await client.call("dialect_probe", {
            mode: "read",
          });
          if (acceptsString) {
            expect(stringInput.isError).toBe(false);
            expect(stringInput.data.received).toEqual({ mode: "read" });
            expect(dispatched).toEqual([{}, { mode: "read" }]);
          } else {
            expect(stringInput.isError).toBe(true);
            expect(stringInput.data.error?.code).toBe("invalid_request");
            expect(dispatched).toEqual([{}]);
          }
          const numberInput = await client.call("dialect_probe", {
            mode: 123,
          });
          expect(numberInput.isError).toBe(true);
          expect(numberInput.data.error?.code).toBe("invalid_request");
          expect(exactPaths(numberInput.data.error?.details?.fields)).toContain(
            "mode",
          );
          expect(dispatched).toEqual(
            acceptsString ? [{}, { mode: "read" }] : [{}],
          );
        } finally {
          await client.client.close();
        }
      });
    }
  });
}
