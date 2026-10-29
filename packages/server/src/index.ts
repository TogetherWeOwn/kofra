/**
 * @dropway/server: the Hono app factory. createDropway() returns a Worker
 * handler that serves the app, the REST API, the MCP slot and every published site.
 */
/** Version of the public embedding contract; changes are recorded in CHANGELOG.md. */
export const EXTENSION_API_VERSION = 5;

export { createDropway, CORE_MCP_TOOLS, type Dropway } from "./create";
export { defineOperation, type OperationDefinition, type OperationContext } from "./operations";
export type {
  CreateDropwayOptions,
  McpHandlerFactory,
  McpToolContext,
  McpToolDefinition,
  NavItem,
  RouteExtension,
  UiPage,
  UiSection,
  UiSlots,
  UiSession,
} from "./extensions";
export type { DropwayEnv, ServerBindings } from "./env";
export { readJson, apiErrorResponse } from "./routes/api";
export { routeSiteRequest, type SiteRoute } from "./route-sites";
export { serveSite, resolvePath, isNavigation, requestedViewMode, securityHeaders, systemResponse, SITE_SANDBOX, type ServeMode } from "./serve";
export { VIEWERS, VIEWER_CSP, viewerCsp, findViewer, toViewerFile, type Viewer, type ViewerContext, type ViewerFile, type ViewMode } from "./viewers";
export { viewerPage, standardTabs, VIEWER_CSS, type ViewerTab } from "./viewers/chrome";
export { renderMarkdown, type MarkdownHeading } from "./viewers/markdown";
export { sanitizeHtml } from "./viewers/sanitize";
export { highlight, hljsLanguage } from "./viewers/highlight";
export { cachedRender } from "./viewers/cache";
export { escapeHtml, htmlPage, systemPage, BASE_CSS, APP_PAGE_CSP, formatBytes } from "./html";
export { buildOpenApi } from "./openapi";
export { llmsTxt, llmsFullTxt, skillMarkdown, skillInstance, agentSkillsIndex, SKILL_NAME, SKILL_DESCRIPTION, type SkillInstance } from "./discovery";
export { createMcpEndpoint, mcpInstructions, selectTools, MCP_SERVER_VERSION, type McpEndpointOptions } from "./mcp";
export { renderAppPage, appScriptCsp, APP_CSS, CORE_NAV, clientScriptUrl, type AppPageOptions } from "./ui";
