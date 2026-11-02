import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ConfigOverrides, KofraAdapters, KofraContext, KofraHooks, Principal, Scope } from "@kofra/core";
import type { KofraEnv, ServerBindings } from "./env";
import type { Viewer } from "./viewers";
import type { OperationDefinition } from "./operations";

/**
 * Extra REST routes. Called once at startup with the API router (mounted at
 * /api/v1, principal already resolved, errors already JSON) and the app router
 * (app origin root). Extension routes are registered BEFORE core routes, so an
 * extension can replace a core route by registering the same method + path.
 * Keep routes thin: parse input, call a service, shape JSON.
 */
export type RouteExtension = (routers: { api: Hono<KofraEnv>; app: Hono<KofraEnv> }) => void;

/** What an MCP tool handler receives. */
export interface McpToolContext {
  dw: KofraContext;
  principal: Principal;
  request: Request;
  /** Who is calling, for attribution: MCP clientInfo ("claude-code/2.1"), X-Kofra-Client or User-Agent. */
  client: string | null;
  /** The idempotencyKey argument, when the tool takes one (already applied by the server). */
  idempotencyKey: string | null;
}

/**
 * An MCP tool contributed by core or an extension. The MCP server (packages/server/src/mcp,
 * built on the Cloudflare Agents SDK) registers every tool in kofra.mcpTools.
 * Handlers must call @kofra/core services, never fetch the REST API.
 *
 * Handlers return a plain JSON object. The server sends it as `structuredContent`,
 * plus a text block (one plain-English line from `summarize`, then the compact JSON)
 * and a `resource_link` when the result has a `url`. Throw an ApiError for business
 * errors; the server turns it into an `isError: true` result with code, message and hint.
 */
export interface McpToolDefinition {
  /** snake_case; the same name as the REST operationId when there is one. */
  name: string;
  title?: string;
  /** Written for models: when to use it, what it returns, the common mistake. Under 4,096 characters. */
  description: string;
  /** JSON Schema (type: "object") for the arguments. Keep it flat (no oneOf) for model compatibility. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema (type: "object") of the result. Recommended; clients validate structuredContent against it. */
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Scopes the caller must hold (checked before the handler runs). */
  scopes?: Scope[];
  /** Group used by ?toolsets= narrowing ("core", "sites", "versions", "keys", "members", or your own). Default "extra". */
  toolset?: string;
  /** Ask clients that defer tool loading to always load this tool (`_meta["anthropic/alwaysLoad"]`). */
  alwaysLoad?: boolean;
  /**
   * Accept an `idempotencyKey` argument: a repeat call with the same key and arguments
   * replays the first result instead of running again (24 hours).
   */
  idempotent?: boolean;
  /** Remove secrets from a result before it is stored for idempotent replay. */
  redactForReplay?(result: unknown): unknown;
  /** Reauthorize a cached result before exposing it; generated registry tools recheck policy here. */
  beforeReplay?(args: Record<string, unknown>, ctx: McpToolContext): void | Promise<void>;
  /** Only list the tool when this returns true (e.g. a feature switched on in config). */
  enabled?(dw: KofraContext): boolean;
  /** One plain-English line describing a successful result. */
  summarize?(result: any, args: Record<string, unknown>): string;
  handler(args: Record<string, unknown>, ctx: McpToolContext): Promise<unknown>;
}

/**
 * Serves the MCP endpoint. createKofra mounts it at /mcp on the app origin.
 * Receives the tools to expose (core + extensions).
 */
export type McpHandlerFactory = (tools: readonly McpToolDefinition[]) => (c: Context<KofraEnv>) => Promise<Response>;

export interface NavItem {
  label: string;
  href: string;
  /** Lower sorts first. Core items use 0-99. */
  order?: number;
}

export interface UiPage {
  /** Path on the app origin, e.g. "/dashboard/billing". */
  path: string;
  title: string;
  /** Show in the dashboard navigation. */
  nav?: boolean;
  handler(c: Context<KofraEnv>): Response | Promise<Response>;
}

/** An extra section on the dashboard settings page (/dashboard/settings). */
export interface UiSection {
  /** Element id of the section (anchor links). */
  id: string;
  title: string;
  /** Trusted HTML for the section body. Escape anything that came from users. */
  render(c: Context<KofraEnv>): string | Promise<string>;
}

/**
 * Dashboard/UI extension slots. The dashboard reads these to build its
 * navigation and pages. Extension pages can share the dashboard frame by
 * rendering with renderAppPage() from @kofra/server.
 */
export interface UiSlots {
  /** Extra links in the dashboard navigation. */
  navItems: NavItem[];
  /** Extra app-origin pages; registered before core pages, so the same path replaces a core page. */
  pages: UiPage[];
  /** Replace the app-origin home page (GET /). */
  landing?: (c: Context<KofraEnv>) => Response | Promise<Response>;
  /** Extra HTML injected into <head> of Kofra-rendered app pages. */
  headHtml?: string;
  /** Extra sections at the end of /dashboard/settings. */
  settingsSections?: UiSection[];
  /** One-line notice (trusted HTML) above every app page, or null for none. */
  banner?: (c: Context<KofraEnv>) => string | null | Promise<string | null>;
  /**
   * Browser sessions provided by the embedding app (for example cookie sessions
   * after an email sign-in). When set, the dashboard also treats a request the
   * identity adapter resolves from the browser's cookies as signed in, sends
   * people to `signInPath` instead of /login, and signs out with a POST form to
   * `signOutPath`. API-key sign-in at /login keeps working. The identity adapter
   * must resolve the session for /api/v1 requests and refuse cross-origin writes.
   */
  session?: UiSession;
}

export interface UiSession {
  /** App-origin page where people sign in, e.g. "/signin". `?next=<path>` is appended. */
  signInPath: string;
  /** App-origin path that ends the session when POSTed to (a same-origin form post). */
  signOutPath: string;
}

export interface CreateKofraOptions {
  /** Config overrides on top of Worker vars. A function receives the bindings. */
  config?: ConfigOverrides | ((env: ServerBindings) => ConfigOverrides);
  /** Replace any adapter; unspecified ones use the open-source defaults. */
  adapters?: Partial<KofraAdapters>;
  /** Event hooks (one object or several). */
  hooks?: KofraHooks | KofraHooks[];
  /** Middleware run on /api/* after the principal is resolved and before routes. */
  apiMiddleware?: MiddlewareHandler<KofraEnv>[];
  /** Extra REST/app routes. */
  routes?: RouteExtension[];
  /** Operations registered once for REST, OpenAPI, MCP and the CLI command table. */
  operations?: OperationDefinition[];
  /** Extra MCP tools, appended to the core tools. */
  mcpTools?: McpToolDefinition[];
  /** The MCP endpoint implementation. Default: the built-in server, createMcpEndpoint() (packages/server/src/mcp). */
  mcp?: McpHandlerFactory;
  /** Dashboard/UI slots. */
  uiSlots?: Partial<UiSlots>;
  /** Extra file viewers, tried before the core ones. */
  viewers?: Viewer[];
  /** Extra cron work (runs after core cleanup). */
  scheduled?: (dc: KofraContext, controller: ScheduledController) => Promise<void>;
}
