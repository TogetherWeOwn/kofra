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
import { APP_PAGE_CSP, escapeHtml, siteSystemCsp, systemPage } from "./html";
import { apiErrorResponse, installApiMiddleware } from "./routes/api";
import { legacyAppRedirect, legacyAppSuccessor, withDeprecationHeaders } from "./legacy";
import { redirectResponse, routeSiteRequest } from "./route-sites";
import { isNavigation, SITE_SANDBOX, serveSite, systemResponse } from "./serve";
import { previewResponse, serveVersionPreview } from "./previews";
import { appStatePage, bindUiSlots, uiSlotsOf } from "./ui/shell";
import { bindRequestTheme } from "./ui/theme";
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
  if (url.searchParams.has("grant") || url.searchParams.has("recipient") || url.searchParams.has("dw_preview")) {
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
    let dw = contexts.get(c.req.raw);
    if (!dw) {
      dw = context(c.env, c.executionCtx, new URL(c.req.url));
      bindRequestTheme(dw, c.req.raw);
    }
    c.set("dw", dw);
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
    const html = appStatePage(c.get("dw"), c.req.url, { title: "Not found", code: "404", heading: "Not found", message: "There is no page at this address.", actions: '<a class="k-btn" href="/">Home</a>', signIn: uiSlotsOf(c).session?.signInPath, footerLinks: uiSlotsOf(c).footerLinks });
    return c.html(html, 404, { "Access-Control-Allow-Origin": "*", "Content-Security-Policy": APP_PAGE_CSP, "X-Content-Type-Options": "nosniff", Vary: "Cookie" });
  });
  app.onError((err, c) => {
    if (c.req.path.startsWith("/api/")) return apiErrorResponse(c, err);
    console.error(JSON.stringify({ event: "app_error", ...requestErrorDetails(c.req.raw, err) }));
    if (!(c.req.header("accept") ?? "").includes("text/html")) return c.text("Internal error", 500);
    const id = String(c.get("requestId") ?? "");
    const html = appStatePage(c.get("dw"), c.req.url, {
      title: "Server error",
      code: "500",
      heading: "Something went wrong on our side",
      message: "The page could not be built. Try again in a moment; if it keeps happening, tell the people who run this instance.",
      extra: id ? `<p class="k-small">Request <span class="k-mono">${escapeHtml(id)}</span></p>` : "",
      actions: `<a class="k-btn" href="${escapeHtml(new URL(c.req.url).pathname)}">Try again</a><a class="k-btn k-ghost" href="/">Home</a>`,
      signIn: uiSlotsOf(c).session?.signInPath,
      footerLinks: uiSlotsOf(c).footerLinks,
    });
    return c.html(html, 500, { "Content-Security-Policy": APP_PAGE_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", Vary: "Cookie" });
  });

  // Clients from before the rename send and read the old header names (legacy-brand.ts).
  async function fetch(request: Request, env: ServerBindings, ctx: ExecutionContext): Promise<Response> {
    return addLegacyResponseHeaders(await handle(acceptLegacyRequestHeaders(request), env, ctx));
  }

  async function handle(request: Request, env: ServerBindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const dw = context(env, ctx, url);
    // Site origins: ?theme= only (the theme cookie belongs to the app origin and is never read there).
    bindRequestTheme(dw, request, { cookie: false });
    let preview = false;
    try {
      // A former app origin (config.legacyAppOrigins): pages move, the API and MCP keep answering.
      const successor = legacyAppSuccessor(dw, url);
      const moved = successor ? legacyAppRedirect(request, url, successor) : null;
      if (moved) return moved;
      const route = await routeSiteRequest(dw, request);
      preview = route.kind === "preview" || route.kind === "gone" || (route.kind === "redirect" && route.preview === true);
      switch (route.kind) {
        case "site":
          return await serveSite(request, dw, route.slug, route.path, route.mode, viewers);
        case "preview":
          return await serveVersionPreview(request, dw, route.slug, route.number, route.path, route.mode, viewers);
        case "redirect":
          return redirectResponse(route);
        case "sites_home":
          return sitesHome(dw, request);
        case "sites_not_found":
          return systemResponse(dw, request, { kind: "path", base: "/", sandbox: true, rewrite: null }, null, 404, "404", "Nothing is published here", "There is no site at this address. See {app}.");
        case "gone":
          return previewResponse(systemResponse(dw, request, route.mode, null, 410, "GONE", "This version is gone", "This version address names a deleted version. Old version links never serve another site's files."));
        case "app": {
          bindRequestTheme(dw, request);
          contexts.set(request, dw);
          const res = await app.fetch(request, env, ctx);
          return successor ? withDeprecationHeaders(res, dw, successor) : res;
        }
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "serve_error", ...requestErrorDetails(request, e) }));
      if (isNavigation(request)) {
        // Rendering uses only the already-resolved request/config, never the failing database.
        const html = systemPage({
          dw,
          code: "500",
          title: "Something went wrong on our side",
          message: "Internal error: this page could not be served. Try again in a moment.",
          extra: `<div class="k-acts"><a class="k-btn" href="${escapeHtml(url.origin + url.pathname)}">Try again</a><a class="k-btn k-ghost" href="${escapeHtml(appOrigin(dw))}">Home</a></div>`,
        });
        const page = new Response(html, {
          status: 500,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; font-src ${appOrigin(dw)}; img-src data:; base-uri 'none'; form-action 'none'`, "X-Content-Type-Options": "nosniff" },
        });
        return preview ? previewResponse(page) : page;
      }
      const response = new Response("Internal error", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      return preview ? previewResponse(response) : response;
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

function sitesHome(dw: DropwayContext, request: Request): Response {
  const o = appOrigin(dw);
  const page = systemPage({
    dw,
    code: "SITES",
    title: `${dw.config.instanceName} sites`,
    message: `This address serves published sites at <code>/&lt;site&gt;/</code>. To publish your own, see <a href="${escapeHtml(o)}">${escapeHtml(o)}</a>.`,
  });
  return new Response(request.method === "HEAD" ? null : page, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `${siteSystemCsp(dw)}; ${SITE_SANDBOX}`,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
