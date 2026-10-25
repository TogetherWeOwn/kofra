import { Hono } from "hono";
import { createOperationRegistry } from "./operations/registry";
import { installOperationRoutes, operationTools, type OperationDefinition } from "./operations";
import {
  ApiError,
  appOrigin,
  defaultIdentity,
  defaultPolicy,
  noopMetering,
  resolveConfig,
  runCleanup,
  snapshotUsage,
  type DropwayAdapters,
  type DropwayConfig,
  type DropwayContext,
  type DropwayHooks,
} from "@dropway/core";
import { createAppRouter } from "./app";
import type { DropwayEnv, ServerBindings } from "./env";
import type { CreateDropwayOptions, McpToolDefinition, UiSlots } from "./extensions";
import { escapeHtml, htmlPage } from "./html";
import { apiErrorResponse, installApiMiddleware } from "./routes/api";
import { legacyAppRedirect, legacyAppSuccessor, withDeprecationHeaders } from "./legacy";
import { redirectResponse, routeSiteRequest } from "./route-sites";
import { SITE_SANDBOX, serveSite, systemResponse } from "./serve";
import { bindUiSlots } from "./ui/shell";
import { VIEWERS, type Viewer } from "./viewers";
import { createMcpEndpoint } from "./mcp";
import { CORE_MCP_TOOLS } from "./mcp/tools";
import { acceptLegacyRequestHeaders, addLegacyResponseHeaders, legacyBrandHeaders } from "./legacy-brand";

export interface Dropway {
  /** Worker fetch handler: export default { fetch: dropway.fetch, scheduled: dropway.scheduled }. */
  fetch(request: Request, env: ServerBindings, ctx: ExecutionContext): Promise<Response>;
  /** Worker cron handler: core cleanup, then options.scheduled. */
  scheduled(controller: ScheduledController, env: ServerBindings, ctx: ExecutionContext): Promise<void>;
  /** App-origin router (REST API mounted at /api/v1). Useful for tests and composition. */
  app: Hono<DropwayEnv>;
  /** Instance-local source for REST routes, documentation, MCP and CLI commands. */
  operations: OperationDefinition[];
  /** MCP tools exposed by this instance (core + extensions). */
  mcpTools: readonly McpToolDefinition[];
  uiSlots: UiSlots;
  viewers: readonly Viewer[];
  adapters: DropwayAdapters;
  /** Build a service context outside a request (cron, queue consumers, scripts, tests). */
  context(env: ServerBindings, ctx: Pick<ExecutionContext, "waitUntil">, requestUrl?: URL | null): DropwayContext;
}

/** Core MCP tools (packages/server/src/mcp/tools.ts); extensions append theirs or replace one by name. */
export { CORE_MCP_TOOLS };

const contexts = new WeakMap<Request, DropwayContext>();

/** Download grants and recipient links are credentials, including in upstream errors. */
function requestErrorDetails(request: Request, error: unknown) {
  const url = new URL(request.url);
  const safeUrl = `${url.origin}${url.pathname}`;
  // Exceptions can echo credentials using any equivalent URL encoding, not just
  // the spelling on this request. Do not serialize their message or stack here.
  if (url.searchParams.has("grant") || url.searchParams.has("recipient")) {
    return { url: safeUrl, error: "[redacted]" };
  }
  return { url: safeUrl, error: String(error), stack: (error as Error)?.stack };
}

/**
 * Build a Kofra Worker. The open-source entry (apps/worker) calls this with no
 * options; a hosted layer passes adapters, hooks, routes, MCP tools and UI slots.
 */
export function createDropway(opts: CreateDropwayOptions = {}): Dropway {
  const hooks: readonly DropwayHooks[] = opts.hooks ? (Array.isArray(opts.hooks) ? opts.hooks : [opts.hooks]) : [];
  const adapters: DropwayAdapters = {
    identity: opts.adapters?.identity ?? defaultIdentity,
    policy: opts.adapters?.policy ?? defaultPolicy,
    metering: opts.adapters?.metering ?? noopMetering,
  };
  const uiSlots: UiSlots = { navItems: [], pages: [], ...opts.uiSlots };
  const operations = createOperationRegistry(opts.operations);
  const mcpTools: readonly McpToolDefinition[] = [...new Map([...operationTools(operations), ...(opts.mcpTools ?? [])].map((t) => [t.name, t] as const)).values()];
  const viewers: readonly Viewer[] = [...(opts.viewers ?? []), ...VIEWERS];

  const configs = new WeakMap<object, DropwayConfig>();
  const configFor = (env: ServerBindings): DropwayConfig => {
    let c = configs.get(env);
    if (!c) {
      const overrides = typeof opts.config === "function" ? opts.config(env) : (opts.config ?? {});
      c = resolveConfig(env, overrides);
      configs.set(env, c);
    }
    return c;
  };
  const context = (env: ServerBindings, ctx: Pick<ExecutionContext, "waitUntil">, requestUrl: URL | null = null): DropwayContext => ({
    env,
    config: configFor(env),
    adapters,
    hooks,
    requestUrl,
    waitUntil: (p) => ctx.waitUntil(p),
  });

  // Order matters: API middleware, then extension routes, then core routes,
  // so extensions see the resolved principal and can override core routes.
  const api = new Hono<DropwayEnv>();
  installApiMiddleware(api, opts.apiMiddleware ?? []);
  const appRoutes = new Hono<DropwayEnv>();
  for (const extend of opts.routes ?? []) extend({ api, app: appRoutes });
  installOperationRoutes(api, operations);
  const app = new Hono<DropwayEnv>();
  // Former-name headers (legacy-brand.ts) here too, so the exported app matches fetch.
  app.use("*", legacyBrandHeaders);
  app.use("*", async (c, next) => {
    c.set("dw", contexts.get(c.req.raw) ?? context(c.env, c.executionCtx, new URL(c.req.url)));
    c.set("requestId", c.req.header("cf-ray") ?? crypto.randomUUID());
    bindUiSlots(c, uiSlots);
    await next();
    c.header("X-Request-Id", c.get("requestId"));
    // Raw extension/transport responses still need retry guidance, even without ApiError.
    if ((c.res.status === 429 || c.res.status === 503) && !c.res.headers.has("Retry-After")) c.header("Retry-After", "1");
  });
  app.route("/api/v1", api);
  app.route("/", createAppRouter({ app: appRoutes, uiSlots, mcp: opts.mcp ?? createMcpEndpoint(), mcpTools, operations }));
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json(
        new ApiError(404, "route_not_found", `No API route for ${c.req.method} ${c.req.path}.`, `See ${appOrigin(c.get("dw"))}/openapi.json for every endpoint.`).toJSON(c.get("requestId"), appOrigin(c.get("dw"))),
        404,
      );
    }
    // CORS-readable, so a sandboxed site (opaque origin) whose fetch() lands here sees a 404 instead of a network error.
    return c.html(htmlPage({ title: "Not found", body: `<main class="dw-system"><div class="dw-code">404</div><h1>Not found</h1><p><a href="/">Home</a></p></main>` }), 404, { "Access-Control-Allow-Origin": "*" });
  });
  app.onError((err, c) => {
    if (c.req.path.startsWith("/api/")) return apiErrorResponse(c, err);
    console.error(JSON.stringify({ event: "app_error", ...requestErrorDetails(c.req.raw, err) }));
    return c.text("Internal error", 500);
  });

  // Clients from before the rename send and read the old header names (legacy-brand.ts).
  async function fetch(request: Request, env: ServerBindings, ctx: ExecutionContext): Promise<Response> {
    return addLegacyResponseHeaders(await handle(acceptLegacyRequestHeaders(request), env, ctx));
  }

  async function handle(request: Request, env: ServerBindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const dw = context(env, ctx, url);
    try {
      // A former app origin (config.legacyAppOrigins): pages move, the API and MCP keep answering.
      const successor = legacyAppSuccessor(dw, url);
      const moved = successor ? legacyAppRedirect(request, url, successor) : null;
      if (moved) return moved;
      const route = await routeSiteRequest(dw, request);
      switch (route.kind) {
        case "site":
          return await serveSite(request, dw, route.slug, route.path, route.mode, viewers);
        case "redirect":
          return redirectResponse(route);
        case "sites_home":
          return sitesHome(dw);
        case "sites_not_found":
          return systemResponse(dw, request, { kind: "path", base: "/", sandbox: true, rewrite: null }, null, 404, "404", "Nothing is published here", "There is no site at this address. See {app}.");
        case "app": {
          contexts.set(request, dw);
          const res = await app.fetch(request, env, ctx);
          return successor ? withDeprecationHeaders(res, dw, successor) : res;
        }
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "serve_error", ...requestErrorDetails(request, e) }));
      return new Response("Internal error", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
  }

  async function scheduled(controller: ScheduledController, env: ServerBindings, ctx: ExecutionContext): Promise<void> {
    const dw = context(env, ctx, null);
    await runCleanup(dw);
    if (controller.cron === "0 0 * * *") await snapshotUsage(dw);
    await opts.scheduled?.(dw, controller);
  }

  return { fetch, scheduled, app, operations, mcpTools, uiSlots, viewers, adapters, context };
}

function sitesHome(dw: DropwayContext): Response {
  const o = appOrigin(dw);
  const page = htmlPage({
    title: dw.config.instanceName,
    body: `<main class="dw-system"><div class="dw-code">SITES</div><h1>${escapeHtml(dw.config.instanceName)} sites</h1><p>This address serves published sites at <code>/&lt;site&gt;/</code>. To publish your own, see <a href="${escapeHtml(o)}">${escapeHtml(o)}</a>.</p></main>`,
  });
  return new Response(page, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; ${SITE_SANDBOX}`,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
