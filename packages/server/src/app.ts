import { Hono, type Context } from "hono";
import { ApiError, ERROR_CODES, errorCatalogMarkdown, appOrigin, type DropwayContext } from "@dropway/core";
import type { DropwayEnv } from "./env";
import type { McpHandlerFactory, McpToolDefinition, UiSlots } from "./extensions";
import { APP_PAGE_CSP, escapeHtml, htmlPage } from "./html";
import { buildOpenApi } from "./openapi";
import type { OperationDefinition } from "./operations";
import { agentSkillsIndex, apiCatalog, connectMarkdown, connectSections, legacySkillsIndex, llmsFullTxt, llmsTxt, robotsTxt, skillInstance, skillMarkdown, SKILL_NAME } from "./discovery";
import { homePage, installUi } from "./ui";
import { nameCode, tok } from "./ui/code";
import { appStatePage, uiSlotsOf } from "./ui/shell";
import { installTransferPages } from "./transfers";
import { installEncrypted } from "./encrypted";
import { LEGACY_SKILL_NAME } from "./legacy-brand";

/**
 * App-origin pages: home, /openapi.json, /llms.txt, /skill.md, /connect,
 * /robots.txt, the well-known discovery indexes, /health, /claim, /mcp,
 * plus the dashboard and file viewer (./ui). Embedding apps replace the home
 * page with uiSlots.landing and add pages with uiSlots.pages; the MCP server
 * plugs in through createDropway({ mcp }).
 */

function pageHeaders(): Record<string, string> {
  return { "Content-Security-Policy": APP_PAGE_CSP, "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", Vary: "Cookie" };
}

/** /llms.txt lives in ./discovery; re-exported here for compatibility. */
export { llmsTxt } from "./discovery";

/**
 * /connect: copy-paste setup per agent client, rendered from connectSections()
 * (the same source as /connect.md). Static HTML, no scripts, works with
 * JavaScript disabled: select a block and copy it.
 */
function connectHtml(origin: string, instanceName: string): string {
  const sections = connectSections(origin)
    .map(
      (s) => `<section><h2>${escapeHtml(s.title)}</h2><p>${escapeHtml(s.intro)}</p>${s.snippets
        .map((sn) => `<h3>${escapeHtml(sn.title)}</h3><pre><code>${escapeHtml(sn.code)}</code></pre>`)
        .join("")}</section>`,
    )
    .join("");
  const css = `.dw-connect{max-width:46rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}.dw-connect .dw-connect-kicker{display:inline-block;font:600 .8rem/1 ui-monospace,monospace;letter-spacing:.06em;color:var(--accent);margin-bottom:.75rem}.dw-connect h1{font-size:1.7rem;margin:0 0 .5rem}.dw-connect h2{font-size:1.15rem;margin:2rem 0 .25rem;padding-top:1rem;border-top:1px solid var(--rule-soft)}.dw-connect h3{font-size:.95rem;margin:1.25rem 0 .4rem;color:var(--muted)}.dw-connect p{margin:.25rem 0 .75rem}.dw-connect pre{background:var(--paper-3);padding:1rem;border-radius:8px;overflow-x:auto;margin:0}.dw-connect section:first-of-type h2{border-top:none;padding-top:0}`;
  return htmlPage({
    title: `Connect an agent to ${instanceName}`,
    css,
    body: `<main class="dw-connect"><div class="dw-connect-kicker">SETUP</div><h1>Connect an agent to ${escapeHtml(instanceName)}</h1><p>One API key (<code>$KOFRA_API_KEY</code>, starts with <code>dw_</code>; the instance owner creates keys) works for MCP, REST and the CLI. Keep it secret: anyone holding it can publish as you.</p>${sections}<section><h2>Reference</h2><ul><li><a href="/llms.txt">/llms.txt</a>: how to publish, update and roll back</li><li><a href="/llms-full.txt">/llms-full.txt</a>: every endpoint, MCP tool and error code</li><li><a href="/skill.md">/skill.md</a>: the Agent Skill for this instance</li><li><a href="/openapi.json">/openapi.json</a>: every REST operation</li></ul></section></main>`,
  });
}

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
  app.get("/.well-known/api-catalog", (c) => c.json(apiCatalog(appOrigin(c.get("dw"))), 200, { "Content-Type": "application/linkset+json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" }));
  app.get("/connect.md", (c) => {
    const dw = c.get("dw");
    return c.body(connectMarkdown(appOrigin(dw), dw.config.instanceName), 200, markdown);
  });
  app.get("/connect", (c) => {
    const dw = c.get("dw");
    return c.html(connectHtml(appOrigin(dw), dw.config.instanceName), 200, pageHeaders());
  });
  app.get("/robots.txt", (c) => c.body(robotsTxt(), 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" }));
  app.get("/claim", (c) => {
    const slug = c.req.query("slug") ?? "";
    const dw = c.get("dw");
    const o = appOrigin(dw);
    const curl = `curl -X POST ${o}/api/v1/sites/${slug}/claim \\
  -H "Authorization: Bearer $KOFRA_API_KEY" -H "Content-Type: application/json" \\
  -d '{"claimToken":"dwc_..."}'`;
    const html = appStatePage(dw, c.req.url, {
      title: "Claim a site",
      code: "CLAIM",
      heading: "Keep this site",
      // The site name and "#token=" are code.k-tok: each moves to the next line whole, never split at a hyphen.
      message: `Anonymous sites expire. To keep ${nameCode(slug)}, call the API with an API key of this instance and the claim token (the part of this link after ${tok("#token=")}):`,
      // No script on this page, so no Copy button: the command wraps (all of it shows) and one click selects it.
      extra: `<div class="k-codeblock"><div class="k-codeblock-h"><span class="k-k">Claim with curl</span><span class="k-small">One click selects the command</span></div><pre class="k-wrapped k-pick" tabindex="0" role="region" aria-label="Claim with curl">${escapeHtml(curl)}</pre></div>`,
      signIn: uiSlotsOf(c).session?.signInPath,
      footerLinks: uiSlotsOf(c).footerLinks,
    });
    return c.html(html, 200, pageHeaders());
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
