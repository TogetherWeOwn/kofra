import { z } from "zod";
import type { Context, Hono } from "hono";
import {
  ApiError,
  requireMember,
  requireCapability,
  requireConfirm,
  type Capability,
  type OperationMeta,
  idempotencyScope,
  validateIdempotencyKey,
  withIdempotency,
  type DropwayContext,
  type Principal,
  type Scope,
} from "@dropway/core";
import type { DropwayEnv } from "./env";
import type { McpToolDefinition } from "./extensions";
import { readJson } from "./routes/api";

export interface OperationContext {
  dw: DropwayContext;
  principal: Principal;
  request: Request;
  client: string | null;
  idempotencyKey: string | null;
  /** Set by the generated adapter; optional for manually composed contexts. */
  transport?: "rest" | "mcp";
}

export interface OperationDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  id: string;
  toolset: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  aliases?: { method: string; path: string }[];
  scopes: Scope[];
  capability?: Capability;
  anonymous?: boolean;
  /** REST-only setup/recovery; only the bootstrap principal may dispatch. */
  bootstrap?: boolean;
  summary: string;
  description: string;
  input: I;
  output: O;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  mcp?: { alwaysLoad?: boolean } | { exclude: string };
  cli?: { command: string[]; positional?: string[] };
  confirm?: "slug" | "name" | "email" | "domain";
  rawBody?: boolean;
  /** Generated REST JSON wire-byte budget; defaults to 8 MiB. */
  jsonBodyMaxBytes?: number;
  examples?: { input: unknown; output: unknown }[];
  handler(input: z.infer<I>, ctx: OperationContext): Promise<z.infer<O>>;
  /** Wire compatibility for pre-registry REST clients. Never used by MCP.
   * A custom handler owns parsing, body limits, output and replay; shared authorization still runs.
   */
  http?: {
    input?: z.ZodType;
    output?: z.ZodType;
    handler?: (c: Context<DropwayEnv>, input: any) => Response | Promise<Response>;
    /** Parse a raw transport once, before policy; the handler receives this validated input. */
    parseInput?: (c: Context<DropwayEnv>) => unknown | Promise<unknown>;
    /** A REST-only transport may share its logical operation's policy identity. */
    policyId?: string;
    status?: number;
    statuses?: number[];
    responseType?: string;
    contentTypes?: string[];
    wildcard?: boolean;
    examples?: { input: unknown; output: unknown }[];
  };
  /** Existing tool presentation and retry behavior; schemas and handler come from this operation. */
  tool?: Pick<McpToolDefinition, "idempotent" | "redactForReplay" | "enabled" | "summarize"> & { unavailableReason?: string };
}

export function defineOperation<I extends z.ZodType, O extends z.ZodType, S extends Scope>(
  definition: OperationDefinition<I, O> & { scopes: S[] },
): OperationDefinition<I, O> & { scopes: S[] } {
  if (!/^[a-z][a-z0-9_]*$/.test(definition.id)) throw new Error(`Invalid operation id: ${definition.id}`);
  for (const route of [{ method: definition.method, path: definition.path }, ...(definition.aliases ?? [])]) {
    if (
      !/^[A-Z]+$/i.test(route.method) ||
      !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(route.method.toUpperCase()) ||
      !/^\/api\/v1(?:\/|$)/.test(route.path)
    ) {
      throw new Error(`Invalid operation route: ${route.method} ${route.path}`);
    }
  }
  if (!definition.summary.trim() || definition.summary.length > 80) throw new Error(`Invalid summary: ${definition.id}`);
  if (!definition.description.trim() || definition.description.length >= 4096) throw new Error(`Invalid description: ${definition.id}`);
  if (definition.mcp && "exclude" in definition.mcp && !definition.mcp.exclude.trim()) throw new Error(`Empty MCP exclusion: ${definition.id}`);
  if (definition.rawBody && !(definition.mcp && "exclude" in definition.mcp)) throw new Error(`Raw operation needs an MCP exclusion: ${definition.id}`);
  if (definition.rawBody && definition.tool?.idempotent && !definition.http?.handler) {
    throw new Error(`Raw operation cannot use generated idempotency: ${definition.id}`);
  }
  if (definition.jsonBodyMaxBytes !== undefined && (!Number.isSafeInteger(definition.jsonBodyMaxBytes) || definition.jsonBodyMaxBytes <= 0)) {
    throw new Error(`Invalid JSON body byte limit: ${definition.id}`);
  }
  if (definition.confirm) {
    const input = schemaJson(definition.input);
    for (const name of ["confirm", definition.confirm]) {
      if (input.properties?.[name]?.type !== "string" || !input.required?.includes(name)) {
        throw new Error(`Operation ${definition.id} confirmation needs required string fields confirm and ${definition.confirm}.`);
      }
    }
  }
  return definition;
}

export function schemaJson(schema: z.ZodType, io: "input" | "output" = "input"): Record<string, any> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
  });
  return json;
}

function validate(schema: z.ZodType, input: unknown, operation: string): any {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(
      400,
      "invalid_request",
      `Invalid input for ${operation}.`,
      "Correct the listed fields and retry; see /openapi.json for the input schema.",
      {
        fields: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

function validateOperationInput(op: OperationDefinition, input: unknown): any {
  const parsed = validate(op.input, input, op.id);
  if (op.confirm) requireConfirm(parsed.confirm, parsed[op.confirm], `the ${op.confirm}`);
  return parsed;
}

export function requireOperationScopes(principal: Principal, scopes: readonly Scope[], operation: string): void {
  const held: readonly Scope[] = principal.kind === "member" ? principal.scopes : principal.kind === "claim" ? ["sites:read", "sites:write", "sites:delete"] : [];
  for (const scope of scopes) {
    if (!held.includes(scope))
      throw new ApiError(
        403,
        "insufficient_scope",
        `Your credential lacks the "${scope}" scope needed for ${operation}.`,
        "Use a member API key with the required scopes; a claim token only controls its own site.",
        { required: scope, held: [...held] },
      );
  }
}

function authorizeOperation(op: OperationDefinition, ctx: OperationContext): void {
  if (ctx.principal.kind === "upload") {
    if (op.id === "upload_blob") return;
    throw new ApiError(403, "forbidden", "Upload tokens only authorize blob uploads.", "Use an API key for this operation.");
  }
  if (op.bootstrap) {
    if (ctx.principal.kind !== "bootstrap") {
      throw new ApiError(403, "bootstrap_key_required", "This operation needs the bootstrap key.", "Send Authorization: Bearer <ADMIN_BOOTSTRAP_KEY> for setup or recovery only.");
    }
    return;
  }
  if ((ctx.principal.kind === "anonymous" || ctx.principal.kind === "bootstrap") && !op.anonymous) requireMember(ctx.principal);
  if (ctx.principal.kind === "member" || ctx.principal.kind === "claim") requireOperationScopes(ctx.principal, op.scopes, op.id);
}

async function prepareOperation(op: OperationDefinition, input: unknown, ctx: OperationContext): Promise<any> {
  authorizeOperation(op, ctx);
  const parsed = validateOperationInput(op, input);
  await checkOperationPolicy(op, parsed, ctx);
  return parsed;
}

export async function executeOperation(op: OperationDefinition, input: unknown, ctx: OperationContext): Promise<any> {
  return runOperation(op, await prepareOperation(op, input, ctx), ctx);
}

async function checkOperationPolicy(op: OperationDefinition, input: unknown, ctx: OperationContext, id = op.id): Promise<void> {
  const p = ctx.principal;
  if (op.capability) await requireCapability(ctx.dw, p, op.capability, { siteId: p.kind === "claim" ? p.siteId : p.kind === "member" ? p.siteId : null, tenantId: p.kind === "member" ? p.tenantId : null });
  const meta: OperationMeta = { id, toolset: op.toolset, method: op.method, path: op.path, scopes: op.scopes };
  await ctx.dw.adapters.policy.beforeOperation?.(p, meta, input, ctx.dw);
}

async function runOperation(op: OperationDefinition, parsed: unknown, ctx: OperationContext): Promise<any> {
  const result = await op.handler(parsed, ctx);
  const output = op.output.safeParse(result);
  if (!output.success) {
    console.error(
      JSON.stringify({
        event: "operation_output_invalid",
        operation: op.id,
        fields: output.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      }),
    );
    throw new ApiError(500, "invalid_operation_output", `The ${op.id} handler returned an invalid result.`, "Report the requestId to the instance operator.");
  }
  // JSON omits optional undefined fields; MCP's schema adapter rejects them before serialization.
  return JSON.parse(JSON.stringify(output.data));
}

export function operationTools(operations: readonly OperationDefinition[]): McpToolDefinition[] {
  return operations
    .filter((op) => !(op.mcp && "exclude" in op.mcp))
    .map((op) => ({
      ...op.tool,
      name: op.id,
      title: op.summary,
      // Schemas carry field guidance; full prose stays in OpenAPI and llms-full.txt.
      description: op.summary,
      toolset: op.toolset,
      scopes: op.scopes,
      annotations: op.annotations,
      alwaysLoad: op.mcp && "alwaysLoad" in op.mcp ? op.mcp.alwaysLoad : false,
      inputSchema: schemaJson(op.input),
      outputSchema: schemaJson(op.output, "output"),
      beforeReplay: async (args, ctx) => { await prepareOperation(op, args, { ...ctx, transport: "mcp" }); },
      handler: (args, ctx) => executeOperation(op, args, { ...ctx, transport: "mcp" }),
    }));
}

export function commandTable(operations: readonly OperationDefinition[]) {
  return operations.map((op) => ({
    id: op.id,
    method: op.method,
    path: op.path,
    scopes: op.scopes,
    inputSchema: schemaJson(op.http?.input ?? op.input),
    ...(op.cli ? { cli: op.cli } : {}),
  }));
}

function honoPath(path: string): string {
  return path.replace(/^\/api\/v1/, "").replace(/\{([a-zA-Z0-9_]+)\}/g, ":$1") || "/";
}

function urlScalarTypes(field: Record<string, any>): string[] {
  if (field.anyOf || field.oneOf) return (field.anyOf ?? field.oneOf).flatMap(urlScalarTypes);
  return Array.isArray(field.type) ? field.type : [field.type];
}

function decodeUrlInput(values: Record<string, string>, schema: Record<string, any>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const types = [...new Set(urlScalarTypes(schema.properties?.[key] ?? {}).filter((type) => type !== "null"))];
    if (types.length === 1) {
      if ((types[0] === "integer" || types[0] === "number") && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
        const number = Number(value);
        if (Number.isFinite(number)) return [key, number];
      }
      if (types[0] === "boolean" && (value === "true" || value === "false")) return [key, value === "true"];
    }
    return [key, value];
  }));
}

async function requestInput(c: Context<DropwayEnv>, op: OperationDefinition, inputSchema = op.input) {
  const schema = schemaJson(inputSchema);
  const query = decodeUrlInput(c.req.query(), schema);
  const path = decodeUrlInput(c.req.param(), schema);
  const body = op.rawBody || ["GET", "HEAD"].includes(c.req.method) ? {} : await readJson(c, op.jsonBodyMaxBytes);
  // The URL names the resource; a body cannot select a different one.
  return { ...query, ...body, ...path };
}

/** Merged query/body/path input without schema validation, for `http.parseInput`
 * endpoints whose handlers parse the wire format themselves (field collectors,
 * legacy coercions). Policy checks still run on the returned input. */
export async function rawRequestInput(c: Context<DropwayEnv>): Promise<Record<string, unknown>> {
  const body = ["GET", "HEAD"].includes(c.req.method) ? {} : await readJson(c);
  // The URL names the resource; a body cannot select a different one.
  return { ...c.req.query(), ...body, ...c.req.param() };
}

export function installOperationRoutes(api: Hono<DropwayEnv>, operations: readonly OperationDefinition[]) {
  const routes = new Set<string>();
  for (const op of operations) {
    for (const route of [{ method: op.method, path: op.path }, ...(op.aliases ?? [])]) {
      const key = `${route.method.toUpperCase()} ${route.path.replace(/\{[^}]+\}/g, "{}")}`;
      if (routes.has(key)) throw new Error(`Duplicate operation route: ${key}`);
      routes.add(key);
      const handler = async (c: Context<DropwayEnv>) => {
        const ctx: OperationContext = {
          dw: c.get("dw"),
          principal: c.get("principal"),
          request: c.req.raw,
          client: c.req.header("x-kofra-client") ?? null,
          idempotencyKey: validateIdempotencyKey(c.req.header("idempotency-key")),
          transport: "rest",
        };
        // Authorization runs for both adapters, before parsing or cached replay.
        authorizeOperation(op, ctx);
        if (op.http?.handler) {
          const schema = op.http.input ?? op.input;
          const input = op.http.parseInput ? await op.http.parseInput(c) : op.rawBody
            ? await requestInput(c, op, schema)
            : validate(schema, await requestInput(c, op, schema), op.id);
          await checkOperationPolicy(op, input, ctx, op.http.policyId ?? op.id);
          return op.http.handler(c, input);
        }
        const input = validateOperationInput(op, await requestInput(c, op));
        await checkOperationPolicy(op, input, ctx);
        const { result, replayed } = await withIdempotency(
          ctx.dw,
          {
            scope: idempotencyScope(ctx.principal),
            operation: `rest:${op.id}`,
            key: op.tool?.idempotent ? ctx.idempotencyKey : null,
            input,
            redactForReplay: op.tool?.redactForReplay,
          },
          () => runOperation(op, input, ctx),
        );
        return c.json(replayed ? { ...(result as Record<string, unknown>), replayed: true } : result, (op.http?.status ?? 200) as 200);
      };
      const path = honoPath(route.path);
      api.on(route.method.toUpperCase(), op.http?.wildcard ? path.replace(/:path$/, ":path{.+}") : path, handler);
    }
  }
}
