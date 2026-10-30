import { createOperationRegistry } from "./operations/registry";
import { schemaJson, type OperationDefinition } from "./operations";
import { PAGE_PATHS } from "./page-openapi";
import { ApiError, resolveConfig, type DropwayContext } from "@dropway/core";
import { SOURCE_REPO } from "./repo";

type Json = Record<string, any>;
const json = (schema: Json, example: unknown, description = "OK") => ({
  description,
  content: { "application/json": { schema, example } },
});

function toolAvailable(op: OperationDefinition, context: DropwayContext): boolean {
  if (!op.tool?.enabled) return true;
  try { return op.tool.enabled(context); } catch { return true; }
}

/** The boolean third argument remains supported; a definition array is also accepted. */
export function buildOpenApi(origin: string, instanceName: string, anonymousOrOperations: boolean | readonly OperationDefinition[] = false, registry?: readonly OperationDefinition[], availableTools?: ReadonlySet<string>): Json {
  const anonymousPublish = typeof anonymousOrOperations === "boolean" ? anonymousOrOperations : false;
  const operations = typeof anonymousOrOperations === "boolean" ? registry ?? createOperationRegistry() : anonymousOrOperations;
  // Static callers have configuration only. Request routes pass the actual visible inventory.
  const discoveryContext = { config: resolveConfig({ ANONYMOUS_PUBLISH: String(anonymousPublish) }, { instanceName }) } as DropwayContext;
  const paths: Json = Object.create(null);
  for (const [path, item] of Object.entries(PAGE_PATHS)) paths[path] = Object.assign(Object.create(null), structuredClone(item));
  for (const item of Object.values<Json>(paths))
    for (const page of Object.values<Json>(item)) {
      page.description ??= page.summary;
      page.responses[404] ??= { description: "Page or resource not found." };
    }
  for (const op of operations) {
    const input = schemaJson(op.http?.input ?? op.input);
    const output = schemaJson(op.http?.output ?? op.output, "output");
    const example = op.http?.examples?.[0] ?? op.examples?.[0];
    const enabled = availableTools?.has(op.id) ?? toolAvailable(op, discoveryContext);
    const excluded = op.mcp && "exclude" in op.mcp ? op.mcp.exclude : !enabled ? op.tool?.unavailableReason ?? "This MCP tool is not enabled for the instance; the REST operation remains available." : undefined;
    for (const [index, route] of [{ method: op.method, path: op.path }, ...(op.aliases ?? [])].entries()) {
      const parameters: Json[] = [];
      const names = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
      for (const name of names)
        parameters.push({
          name,
          in: "path",
          required: true,
          description: input.properties?.[name]?.description ?? `The ${name} identifying this resource.`,
          schema: input.properties?.[name] ?? { type: "string" },
        });
      const props = Object.fromEntries(Object.entries(input.properties ?? {}).filter(([key]) => !names.includes(key)));
      const required = (input.required ?? []).filter((key: string) => !names.includes(key));
      const method = route.method.toLowerCase();
      if (method === "get" || method === "head" || (op.rawBody && !op.http?.handler)) {
        for (const [name, schema] of Object.entries(props))
          parameters.push({
            name,
            in: "query",
            required: required.includes(name),
            schema,
          });
      }
      const contentTypes = op.http?.contentTypes ?? [op.rawBody ? "application/octet-stream" : "application/json"];
      const requestBody =
        !["get", "head", "delete"].includes(method) || (Object.keys(props).length > 0 && method === "delete")
          ? {
              required: required.length > 0 || !!op.rawBody,
              content: Object.fromEntries(
                contentTypes.map((type) => [
                  type,
                  {
                    schema:
                      type === "application/json"
                        ? { ...input, properties: props, required }
                        : type === "multipart/form-data"
                          ? {
                              type: "object",
                              additionalProperties: {
                                type: "string",
                                format: "binary",
                              },
                            }
                          : { type: "string", format: "binary" },
                    ...(example
                      ? {
                          example:
                            type === "application/json"
                              ? Object.fromEntries(Object.entries(example.input as Record<string, unknown>).filter(([name]) => Object.hasOwn(props, name)))
                              : type === "multipart/form-data"
                                ? { "index.html": "Hello from Kofra" }
                                : "Hello from Kofra",
                        }
                      : {}),
                  },
                ]),
              ),
            }
          : undefined;
      const success: Json = json(output, example?.output ?? {}, "Successful operation result");
      if (op.http?.responseType)
        success.content = {
          [op.http.responseType]: {
            schema: { type: "string", format: "binary" },
            example: "Hello from Kofra",
          },
        };
      const status = op.http?.status ?? 200;
      const responses: Json = {
        [status]: success,
        default: json(
          { $ref: "#/components/schemas/Error" },
          new ApiError(400, "invalid_request", "Invalid request.", "Correct the input and retry.").toJSON("request-example", origin),
          "Error with a stable code and remediation hint",
        ),
      };
      if (op.http?.statuses) {
        delete responses[status];
        for (const code of op.http.statuses) responses[code] = success;
      }
      responses[400] = responses.default;
      paths[route.path] ??= Object.create(null);
      paths[route.path][method] = {
        operationId: index === 0 ? op.id : `${op.id}_alias_${index}`,
        summary: op.summary,
        description: op.description,
        tags: [op.toolset],
        ...(index > 0 ? { deprecated: true } : {}),
        ...(op.anonymous ? { security: [] } : {}),
        ...(parameters.length ? { parameters } : {}),
        ...(requestBody ? { requestBody } : {}),
        ...(excluded ? { "x-mcp-exclude": excluded } : { "x-mcp-tool": op.id }),
        responses,
      };
    }
  }
  return {
    openapi: "3.1.0",
    info: {
      title: `${instanceName} API`,
      version: "1.0.0",
      description:
        "Publish files, folders and sites to live URLs. Authenticate with a scoped bearer API key. REST, MCP and CLI metadata are generated from the operation registry. Errors include a stable code and remediation hint.",
      license: {
        name: "MIT",
        url: `${SOURCE_REPO}/blob/main/LICENSE`,
      },
    },
    servers: [{ url: origin }],
    externalDocs: { description: "Agent reference", url: `${origin}/llms.txt` },
    security: [{ bearer: [] }],
    tags: [...new Set([...operations.map((op) => op.toolset), "agents", "pages"])].map((name) => ({ name, description: `${name} operations` })),
    paths,
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description: "API key, scoped claim token, or the bootstrap key for setup only.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error", "requestId"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "retryable", "retryAfterSeconds", "docs", "next"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                hint: { type: "string" },
                retryable: { type: "boolean" },
                retryAfterSeconds: { type: ["integer", "null"], minimum: 0 },
                docs: { type: "string", format: "uri" },
                next: {
                  type: "array",
                  items: {
                    type: "object", required: ["tool", "args", "why"],
                    properties: { tool: { type: "string" }, args: { type: "object", additionalProperties: true }, why: { type: "string" } },
                  },
                },
                details: { type: "object", additionalProperties: true },
              },
            },
            requestId: { type: "string" },
          },
        },
      },
    },
  };
}
