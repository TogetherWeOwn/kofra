/** Browser and discovery routes are not registry API operations. */
type Json = Record<string, any>;
const page = (operationId: string, summary: string, metadata: Json): Json => ({ operationId, summary, description: summary, ...metadata });
export const PAGE_PATHS: Json = {
  "/t/{slug}": Object.fromEntries(["get", "head", "post"].map((method) => [method, page(`transfer_page_${method}`, method === "post" ? "Unlock a file delivery" : "Open a file delivery", {
    tags: ["pages"], security: [], "x-mcp-exclude": "browser page; use get_transfer for sender state",
    parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
    ...(method === "post" ? { requestBody: { required: true, content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties: { password: { type: "string" } }, required: ["password"] } } } } } : {}),
    responses: { "200": { description: "Plain-text message and download links on the app origin." }, "303": { description: "Unlocked; redirect with a digest-bound cookie." }, "403": { description: "Password required." }, "410": { description: "Delivery closed." }, "451": { description: "Delivery unavailable." } },
  })])),

  "/mcp": {
    post: page("mcp", "Remote MCP server (Streamable HTTP, stateless)", {
      tags: ["agents"],
      description:
        'JSON-RPC over Streamable HTTP (MCP 2026-07-28, and 2025-era clients through the stateless lane). Same API keys as REST. Narrow the tool list with ?toolsets=core,sites,versions,keys,members and ?read_only=1. Example: claude mcp add --transport http kofra <origin>/mcp --header "Authorization: Bearer dw_..."',
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", description: "A JSON-RPC 2.0 request." } } } },
      "x-mcp-exclude": "this is the MCP endpoint itself",
      responses: {
        "200": { description: "JSON-RPC response (application/json or text/event-stream)." },
        "401": { description: "Missing or invalid API key (WWW-Authenticate: Bearer)." },
      },
    }),
  },
  "/": {
    get: page("landing", "Landing page (HTML)", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "browser page",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/docs/errors": {
    get: page("error_catalog_page", "Built-in error codes and remediation (HTML)", {
      tags: ["agents"], security: [], "x-mcp-exclude": "documentation page",
      responses: { "200": { description: "HTML error catalog", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/docs/errors.md": {
    get: page("error_catalog_markdown", "Generated built-in error catalog (Markdown)", {
      tags: ["agents"], security: [], "x-mcp-exclude": "documentation document",
      responses: { "200": { description: "Markdown error catalog", content: { "text/markdown": { schema: { type: "string" } } } } },
    }),
  },
  "/health": {
    get: page("health", "Health check", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "monitoring",
      responses: {
        "200": {
          description: "OK",
          content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, service: { type: "string" } } } } },
        },
      },
    }),
  },
  "/claim": {
    get: page("claim_page", "Claim page for anonymous sites (token in the URL fragment)", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "browser page; use claim_site",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/__dropway/encrypted/{slug}": {
    get: page("encrypted_page", "Decrypt a CLI-encrypted site locally (key only in URL fragment)", {
      tags: ["pages"],
      parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" }, description: "Site slug." }],
      security: [],
      "x-mcp-exclude": "browser-only WebCrypto; never send the share key to an API or MCP tool",
      responses: { "200": { description: "First-party decryptor HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/__dropway/encrypted-loader.js": {
    get: page("encrypted_script", "First-party encrypted-site decryptor", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "static browser asset",
      responses: { "200": { description: "JavaScript", content: { "text/javascript": { schema: { type: "string" } } } } },
    }),
  },
  "/__dropway/encrypted-frame": {
    get: page("encrypted_frame", "Opaque sandbox for authenticated decrypted content", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "browser-only sandbox bootstrap",
      responses: { "200": { description: "Isolated content runtime", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/login": {
    get: page("login_page", "Sign-in page (API key; first-run setup)", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "browser page",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
    post: page("login_form_fallback", "Where the sign-in forms post before the page script has loaded: redirects back to /login and ignores the body", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "browser page",
      responses: { "303": { description: "Redirect to /login?retry=1" } },
    }),
  },
  "/dashboard": {
    get: page("dashboard_page", "Dashboard: sites list", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "browser page; use list_sites",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/dashboard/": {
    get: page("dashboard_page_slash", "Redirects to /dashboard", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "redirect",
      responses: { "301": { description: "Redirect" } },
    }),
  },
  "/dashboard/sites/{slug}": {
    get: page("dashboard_site_page", "Dashboard: one site (versions, files, settings)", {
      tags: ["pages"],
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Site slug, e.g. bright-otter-x7k2 (routes marked as such also accept a site id).",
        },
      ],
      security: [],
      "x-mcp-exclude": "browser page; use get_site",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/dashboard/publish": {
    get: page("dashboard_publish_page", "Dashboard: drag-and-drop publish", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "browser page; use publish_site",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/dashboard/keys": {
    get: page("dashboard_keys_page", "Dashboard: API keys and members", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "browser page; use list_api_keys",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/dashboard/settings": {
    get: page("dashboard_settings_page", "Dashboard: instance settings", {
      tags: ["pages"],
      security: [],
      "x-mcp-exclude": "browser page",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/v/{slug}": {
    get: page("file_browser_root", "Redirects to /v/{slug}/", {
      tags: ["pages"],
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Site slug, e.g. bright-otter-x7k2 (routes marked as such also accept a site id).",
        },
      ],
      security: [],
      "x-mcp-exclude": "redirect",
      responses: { "301": { description: "Redirect" } },
    }),
  },
  "/v/{slug}/{path}": {
    get: page(
      "file_browser_page",
      "File browser: file tree plus a rendered, source or raw view of one file (rendered in a sandboxed frame on the sites origin)",
      {
        tags: ["pages"],
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Site slug, e.g. bright-otter-x7k2 (routes marked as such also accept a site id).",
          },
          { name: "path", in: "path", required: true, schema: { type: "string" }, description: "File path inside the site (may be empty or contain slashes)" },
        ],
        security: [],
        "x-mcp-exclude": "browser page; use read_file",
        responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
      },
    ),
  },
  "/view/{slug}/{path}": {
    get: page("file_browser_legacy", "Redirects to /v/{slug}/{path}", {
      tags: ["pages"],
      parameters: [
        {
          name: "slug",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Site slug, e.g. bright-otter-x7k2 (routes marked as such also accept a site id).",
        },
        { name: "path", in: "path", required: true, schema: { type: "string" }, description: "File path" },
      ],
      security: [],
      "x-mcp-exclude": "redirect",
      responses: { "301": { description: "Redirect" } },
    }),
  },
  "/__dropway/ui/{file}": {
    get: page("dashboard_script", "Dashboard script (content-hashed name, cached immutable)", {
      tags: ["pages"],
      parameters: [{ name: "file", in: "path", required: true, schema: { type: "string" }, description: "Script file name" }],
      security: [],
      "x-mcp-exclude": "static asset",
      responses: { "200": { description: "JavaScript", content: { "text/javascript": { schema: { type: "string" } } } } },
    }),
  },
  "/openapi.json": {
    get: page("openapi", "This document", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
    }),
  },
  "/llms.txt": {
    get: page("llms_txt", "Agent quick reference (llms.txt)", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "Markdown", content: { "text/markdown": { schema: { type: "string" } } } } },
    }),
  },
  "/llms-full.txt": {
    get: page("llms_full_txt", "Full agent reference: every endpoint, MCP tool and error code", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "Markdown", content: { "text/markdown": { schema: { type: "string" } } } } },
    }),
  },
  "/skill.md": {
    get: page("skill", "Agent Skill (SKILL.md) for this instance", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "Markdown", content: { "text/markdown": { schema: { type: "string" } } } } },
    }),
  },
  "/connect": {
    get: page("connect_page", "Copy-paste agent setup per client (HTML)", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
    }),
  },
  "/connect.md": {
    get: page("connect_markdown", "Copy-paste agent setup per client (Markdown)", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "Markdown", content: { "text/markdown": { schema: { type: "string" } } } } },
    }),
  },
  "/robots.txt": {
    get: page("robots_txt", "App crawler policy", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "Plain text", content: { "text/plain": { schema: { type: "string" } } } } },
    }),
  },
  "/.well-known/api-catalog": {
    get: page("api_catalog", "RFC 9727 linkset to this instance's OpenAPI, docs and MCP endpoint", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "OK", content: { "application/linkset+json": { schema: { type: "object" } } } } },
    }),
  },
  "/.well-known/agent-skills/index.json": {
    get: page("agent_skills_index", "Agent Skills discovery index (v0.2.0) for `npx skills add <origin>`", {
      tags: ["agents"],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
    }),
  },
  "/.well-known/agent-skills/{name}/SKILL.md": {
    get: page("agent_skill_file", "A skill listed in the discovery index", {
      tags: ["agents"],
      parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" }, description: "Skill name (kofra)" }],
      security: [],
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "Markdown", content: { "text/markdown": { schema: { type: "string" } } } } },
    }),
  },
  "/.well-known/skills/index.json": {
    get: page("agent_skills_index_legacy", "Legacy skills discovery index (v0.1.0)", {
      tags: ["agents"],
      security: [],
      deprecated: true,
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
    }),
  },
  "/.well-known/skills/{name}/SKILL.md": {
    get: page("agent_skill_file_legacy", "A skill listed in the legacy index", {
      tags: ["agents"],
      parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" }, description: "Skill name (kofra)" }],
      security: [],
      deprecated: true,
      "x-mcp-exclude": "discovery document",
      responses: { "200": { description: "Markdown", content: { "text/markdown": { schema: { type: "string" } } } } },
    }),
  },
};
