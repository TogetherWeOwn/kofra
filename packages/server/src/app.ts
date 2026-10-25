import { Hono, type Context } from "hono";
import { ApiError, ERROR_CODES, errorCatalogMarkdown, appOrigin, type DropwayContext } from "@dropway/core";
import type { DropwayEnv } from "./env";
import type { McpHandlerFactory, McpToolDefinition, UiSlots } from "./extensions";
import { APP_PAGE_CSP, escapeHtml, htmlPage } from "./html";
import { buildOpenApi } from "./openapi";
import type { OperationDefinition } from "./operations";
import { agentSkillsIndex, legacySkillsIndex, llmsFullTxt, llmsTxt, skillInstance, skillMarkdown, SKILL_NAME } from "./discovery";
import { homePage, installUi } from "./ui";
import { installTransferPages } from "./transfers";
import { installEncrypted } from "./encrypted";
import { LEGACY_SKILL_NAME } from "./legacy-brand";

/**
 * App-origin pages: home, /openapi.json, /llms.txt, /health, /claim, /mcp,
 * plus the dashboard and file viewer (./ui). Embedding apps replace the home
 * page with uiSlots.landing and add pages with uiSlots.pages; the MCP server
 * plugs in through createDropway({ mcp }).
 */

function pageHeaders(): Record<string, string> {
  return { "Content-Security-Policy": APP_PAGE_CSP, "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" };
}

/** /llms.txt lives in ./discovery; re-exported here for compatibility. */
export { llmsTxt } from "./discovery";

/** Install the core app-origin routes on `app` (which may already hold extension routes). */
export function createAppRouter(opts: { app: Hono<DropwayEnv>; uiSlots: UiSlots; mcp?: McpHandlerFactory | undefined; mcpTools: readonly McpToolDefinition[]; operations: readonly OperationDefinition[] }) {
  const app = opts.app;
  const availableToolNames = (dw: DropwayContext) => new Set(opts.mcpTools.filter((tool) => !tool.enabled || tool.enabled(dw)).map((tool) => tool.name));

  for (const page of opts.uiSlots.pages) app.get(page.path, (c) => page.handler(c));
  installUi(app, opts.uiSlots);
  installTransferPages(app);
  installEncrypted(app);

  app.get("/", (c) => (opts.uiSlots.landing ? opts.uiSlots.landing(c) : homePage(c)));
  app.get("/health", (c) => c.json({ ok: true, service: "dropway" }));
  app.get("/openapi.json", (c) => {
    const dw = c.get("dw");
    const available = availableToolNames(dw);
    return c.json(buildOpenApi(appOrigin(dw), dw.config.instanceName, dw.config.anonymous.enabled, opts.operations, available), 200, { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" });
  });
  // Agent discovery (./discovery): llms.txt, llms-full.txt, the skill and its well-known indexes.
  const markdown = { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" };
  app.get("/docs/errors.md", (c) => c.body(errorCatalogMarkdown(), 200, markdown));
  app.get("/docs/errors", (c) => {
    const rows = Object.entries(ERROR_CODES).sort(([a], [b]) => a.localeCompare(b)).map(([code, entry]) =>
      `<tr id="${escapeHtml(code)}"><td><code>${escapeHtml(code)}</code></td><td>${entry.status}</td><td>${entry.retryable}</td><td>${escapeHtml(entry.hint)}</td></tr>`,
    ).join("");
    return c.html(htmlPage({ title: "Error codes", body: `<main><h1>Error codes</h1><p>Follow the hint and next calls. On 429/503, wait Retry-After seconds before retrying. <a href="/docs/errors.md">Markdown catalog</a></p><table><thead><tr><th>Code</th><th>HTTP status</th><th>Retryable</th><th>Hint</th></tr></thead><tbody>${rows}</tbody></table></main>` }), 200, { ...pageHeaders(), "Cache-Control": "public, max-age=300" });
  });
  const describedBy = (o: string) => ({ Link: `<${o}/llms.txt>; rel="describedby"; type="text/markdown", <${o}/openapi.json>; rel="service-desc"` });
  app.get("/llms.txt", (c) => {
    const dw = c.get("dw");
    return c.body(llmsTxt(appOrigin(dw), dw.config, opts.mcpTools, opts.operations, availableToolNames(dw)), 200, markdown);
  });
  app.get("/llms-full.txt", (c) => {
    const dw = c.get("dw");
    return c.body(llmsFullTxt(appOrigin(dw), dw.config, opts.mcpTools, opts.operations, availableToolNames(dw)), 200, markdown);
  });
  const skill = (c: Context<DropwayEnv>) => {
    const name = c.req.param("name");
    if (name !== undefined && name !== SKILL_NAME && name !== LEGACY_SKILL_NAME) return c.notFound();
    return c.body(skillMarkdown(skillInstance(c.get("dw"))), 200, { ...markdown, ...describedBy(appOrigin(c.get("dw"))) });
  };
  app.get("/skill.md", skill);
  app.get("/.well-known/agent-skills/:name/SKILL.md", skill);
  app.get("/.well-known/skills/:name/SKILL.md", skill);
  app.get("/.well-known/agent-skills/index.json", async (c) => c.json(await agentSkillsIndex(c.get("dw")), 200, { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" }));
  app.get("/.well-known/skills/index.json", (c) => c.json(legacySkillsIndex(c.get("dw").config.instanceName), 200, { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" }));
  app.get("/claim", (c) => {
    const slug = c.req.query("slug") ?? "";
    const o = appOrigin(c.get("dw"));
    const body = `<main class="dw-system"><div class="dw-code">CLAIM</div><h1>Keep this site</h1>
<p>Anonymous sites expire. To keep <code>${escapeHtml(slug)}</code>, call the API with an API key of this instance and the claim token (the part of this link after <code>#token=</code>):</p>
<pre style="white-space:pre-wrap;word-break:break-all;background:var(--code);padding:1rem;border-radius:8px">curl -X POST ${escapeHtml(o)}/api/v1/sites/${escapeHtml(slug)}/claim \\
  -H "Authorization: Bearer $KOFRA_API_KEY" -H "Content-Type: application/json" \\
  -d '{"claimToken":"dwc_..."}'</pre></main>`;
    return c.html(htmlPage({ title: "Claim a site", body }), 200, pageHeaders());
  });

  const mcpHandler = opts.mcp?.(opts.mcpTools);
  app.all("/mcp", (c) => {
    if (mcpHandler) return mcpHandler(c);
    return c.json(
      new ApiError(501, "mcp_not_enabled", "This build has no MCP server mounted.").toJSON(c.get("requestId"), appOrigin(c.get("dw"))),
      501,
    );
  });
  app.all("/mcp/*", (c) => (mcpHandler ? mcpHandler(c) : c.notFound()));
  return app;
}
