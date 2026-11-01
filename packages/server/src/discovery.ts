import { ERROR_CODES, appOrigin, sha256Hex, siteUrl, type DropwayConfig, type DropwayContext } from "@dropway/core";
import type { McpToolDefinition } from "./extensions";
import { buildOpenApi } from "./openapi";
import type { OperationDefinition } from "./operations";

/**
 * Agent discovery documents, all generated from the same sources so they cannot drift:
 * the OpenAPI document (REST), the MCP tool list, and the skill template.
 *
 *   /llms.txt         short reference (llmstxt.org format)
 *   /llms-full.txt    every endpoint, every MCP tool with its input schema, error codes
 *   /skill.md         Agent Skill (SKILL.md) with this instance's URLs filled in
 *   /.well-known/agent-skills/index.json  discovery index v0.2.0 (npx skills add <origin>)
 *   /.well-known/skills/index.json        legacy index v0.1.0
 *   /connect, /connect.md                 copy-paste setup per agent client (HTML, Markdown)
 *   /.well-known/api-catalog               RFC 9727 linkset to the OpenAPI, docs and MCP endpoint
 *   /robots.txt                           app crawler policy (discovery docs are crawlable, app shells are not)
 *
 * The repository copy at skills/kofra/SKILL.md is skillMarkdown(null): a test keeps it in sync.
 */

export const SKILL_NAME = "kofra";
/** Skill description naming the product (the instance name; "Kofra" for the repository copy). */
export function skillDescription(product: string): string {
  return `Publish files, folders and static sites to a live URL with ${product}, then update, version, roll back and share them. Use when the user wants to publish, host, share, deploy or preview HTML pages, Markdown docs, reports, images, PDFs, demos or a built web app, or to change, check or roll back something already on ${product}.`;
}
export const SKILL_DESCRIPTION = skillDescription("Kofra");

export interface SkillInstance {
  origin: string;
  instanceName: string;
  anonymousPublish: boolean;
  exampleSiteUrl: string;
}

/** The Kofra Agent Skill. `instance` null renders the generic copy kept in the repository. */
export function skillMarkdown(instance: SkillInstance | null): string {
  const app = instance ? instance.origin : "$KOFRA_URL";
  const where = instance
    ? `- Instance: \`${app}\` (${instance.instanceName}). API key: \`$KOFRA_API_KEY\` (starts with \`dw_\`; the instance owner creates keys). If the key is missing, ask the user.
- ${instance.anonymousPublish ? "This instance also accepts publishing without a key: such sites expire after 24 hours and return a claim token." : "This instance requires an API key for every publish."}`
    : `- Instance: \`$KOFRA_URL\` (the app origin, for example \`https://dropway.<account>.workers.dev\`). API key: \`$KOFRA_API_KEY\` (starts with \`dw_\`; the instance owner creates keys). If either is missing, ask the user.
- \`$KOFRA_URL/skill.md\` serves this skill with the instance's own URLs and settings filled in.`;
  // The product name people see is the instance's; the skill's name is fixed (SKILL_NAME), and the
  // former name still serves at its old URLs (legacy-brand.ts) so existing installs keep working.
  // Kept to one plain YAML-safe line, since it also goes into the front matter.
  const product = (instance ? instance.instanceName.replace(/[\r\n:#"']+/g, " ").trim() : "") || "Kofra";
  return `---
name: ${SKILL_NAME}
description: ${skillDescription(product)}
license: MIT
metadata:
  homepage: ${instance ? instance.origin : "https://github.com/TogetherWeOwn/kofra"}
---

# ${product}

${product} turns files into a live URL. Every publish is an immutable version you can roll back. People opening a site get the right view for each file (HTML runs as a real page, Markdown is rendered, images, PDFs and code are displayed) and \`?raw=1\` on any file URL returns the raw bytes.

## Connect

${where}
- MCP (preferred when your client supports remote MCP): \`${app}/mcp\` with header \`Authorization: Bearer $KOFRA_API_KEY\`.
  Claude Code: \`claude mcp add --transport http kofra ${app}/mcp --header "Authorization: Bearer $KOFRA_API_KEY"\`
- REST with curl works everywhere: \`${app}/api/v1\`, same header. Full reference: \`${app}/llms-full.txt\`, OpenAPI: \`${app}/openapi.json\`.

## Publish

MCP: \`publish_site\` with \`files\`, each \`{ path, content }\` (text; base64 only for small binaries), \`{ path, url }\` (the server downloads a public https file), \`{ path, sha256, size }\` (then PUT the bytes to the returned upload link and call \`finalize_version\`), \`{ path, copyFrom }\` or a chat attachment \`{ download_url, file_name }\`; or \`archiveUrl\` alone for a public https .zip.

REST, one call (form field name = file path):

\`\`\`sh
curl -fsS ${app}/api/v1/publish -H "Authorization: Bearer $KOFRA_API_KEY" \\
  -F "index.html=@index.html" -F "assets/app.js=@assets/app.js"
\`\`\`

A built folder: \`(cd dist && zip -qr ../site.zip .) && curl -fsS ${app}/api/v1/publish -H "Authorization: Bearer $KOFRA_API_KEY" -H "Content-Type: application/zip" --data-binary @site.zip\`

Publish to the same site again with \`-F slug=<slug>\` (REST) or \`site: "<slug>"\` (MCP). Identical content returns \`unchanged\` and creates no version.

## Change, check, roll back

- Change a few files: \`update_site_files\` (MCP) or \`PATCH ${app}/api/v1/sites/<slug>/files\` with \`files\`, \`delete\`, \`move\`, and \`baseVersionId\` from your last result. \`version_conflict\` means someone published since: re-read, re-apply, retry.
- Check your work: \`list_files\`, \`read_file\`, or fetch the returned \`url\`.
- Roll back: \`list_versions\`, then \`restore_version\` with \`"v3"\`.
- Settings: \`update_site_settings\` (title, description, spa, renderMarkdown, crossOriginIsolation). Password: \`set_site_access\`.

## Rules

1. Share the \`url\` from the response exactly as returned. Never build site URLs yourself${instance ? ` (on this instance they look like \`${instance.exampleSiteUrl}\`, but that can change)` : ""}.
2. Put \`index.html\` (or \`index.md\` / \`README.md\`) at the root so the URL opens a page.
3. Use relative links inside a site (\`assets/app.js\`, not \`/assets/app.js\`) so it works on every instance.
4. Keep big or binary files out of the conversation: use url sources or the upload links, not base64.
5. Never publish secrets (.env files, keys, tokens). If one slipped out, publish a fixed version and delete the bad one with \`delete_version\`.
6. Retrying a write? Reuse the same \`idempotencyKey\` (MCP) or \`Idempotency-Key\` header (REST).
7. Errors carry \`code\`, \`message\` and \`hint\`: follow the hint. Destructive tools need \`confirm\` set to the slug.
`;
}

export function skillInstance(dw: DropwayContext): SkillInstance {
  return { origin: appOrigin(dw), instanceName: dw.config.instanceName, anonymousPublish: dw.config.anonymous.enabled, exampleSiteUrl: siteUrl(dw, "bright-otter-x7k2") };
}

/** /.well-known/agent-skills/index.json (Agent Skills discovery v0.2.0). */
export async function agentSkillsIndex(dw: DropwayContext) {
  const md = skillMarkdown(skillInstance(dw));
  return {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: SKILL_NAME,
        type: "skill-md",
        description: skillDescription(dw.config.instanceName),
        url: `${appOrigin(dw)}/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`,
        digest: `sha256:${await sha256Hex(md)}`,
      },
    ],
  };
}

/** /.well-known/skills/index.json (legacy v0.1.0 layout: <base>/<name>/SKILL.md). */
export function legacySkillsIndex(product = "Kofra") {
  return { skills: [{ name: SKILL_NAME, description: skillDescription(product), files: ["SKILL.md"] }] };
}

// ---------------------------------------------------------------- llms.txt

type OpenApiOp = { operationId?: string; summary?: string; description?: string; deprecated?: boolean; parameters?: Array<Record<string, unknown>>; requestBody?: Record<string, any>; "x-mcp-tool"?: string; "x-mcp-exclude"?: string };

function operations(origin: string, config: DropwayConfig, registry?: readonly OperationDefinition[], availableTools?: ReadonlySet<string>) {
  const doc = buildOpenApi(origin, config.instanceName, config.anonymous.enabled, registry, availableTools) as { paths: Record<string, Record<string, OpenApiOp>> };
  const out: Array<{ method: string; path: string; op: OpenApiOp }> = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) out.push({ method: method.toUpperCase(), path, op });
  }
  return out;
}

/** Is a tool listed on this instance? (Evaluated with the instance config only.) */
function toolEnabled(t: McpToolDefinition, config: DropwayConfig): boolean {
  if (!t.enabled) return true;
  try {
    return t.enabled({ config } as DropwayContext);
  } catch {
    return true;
  }
}

const firstSentence = (s: string) => {
  const m = /^(.+?[.!?])(\s|$)/.exec(s.trim());
  return (m ? m[1]! : s.trim()).replace(/\s+/g, " ");
};

function mcpLines(origin: string): string {
  return `- Endpoint: \`${origin}/mcp\` (Streamable HTTP; header \`Authorization: Bearer dw_...\`). Narrow the tool list with \`?toolsets=core\` (or sites, versions, keys, members, folders, transfers) and \`?read_only=1\`.
- Claude Code: \`claude mcp add --transport http kofra ${origin}/mcp --header "Authorization: Bearer $KOFRA_API_KEY"\`
- Codex (~/.codex/config.toml): \`[mcp_servers.kofra]\` with \`url = "${origin}/mcp"\` and \`bearer_token_env_var = "KOFRA_API_KEY"\`
- Cursor, VS Code and other clients: add a remote (HTTP) MCP server with that URL and header.
- Inspector: \`npx @modelcontextprotocol/inspector --cli ${origin}/mcp --transport http --header "Authorization: Bearer $KOFRA_API_KEY" --method tools/list\``;
}

/** /llms.txt: what this is, how to connect, every endpoint and tool in one line each. */
export function llmsTxt(origin: string, config: DropwayConfig, tools: readonly McpToolDefinition[] = [], registry?: readonly OperationDefinition[], availableTools?: ReadonlySet<string>): string {
  const visibleTools = tools.filter((tool) => availableTools ? availableTools.has(tool.name) : toolEnabled(tool, config));
  const available = availableTools ?? (tools.length ? new Set(visibleTools.map((tool) => tool.name)) : undefined);
  const ops = operations(origin, config, registry, available).filter((o) => o.path.startsWith("/api/") && !o.op.deprecated);
  return `# ${config.instanceName}

> Instant web hosting for AI agents (Kofra, open source, on Cloudflare). Publish a file, folder or site to a live URL with one call; every publish is an immutable version you can roll back. Use the REST API, the remote MCP server or the Agent Skill.

Base URL: ${origin}
Auth: \`Authorization: Bearer dw_...\` (API key from the instance owner; scopes sites:read, sites:write, sites:delete, keys:write, members:write, data:write, secrets:write, admin).${
    config.anonymous.enabled ? " Anonymous publishing is enabled: without a key, sites expire after 24 hours and a claimToken is returned." : " Anonymous publishing is disabled on this instance."
  }
Errors: JSON \`{ "error": { "code", "message", "hint", "retryable", "retryAfterSeconds", "docs", "next", "details" }, "requestId" }\`. Follow the hint and next calls; validation errors list bad fields in details.fields. Catalog: ${origin}/docs/errors.md.
URLs: share the \`url\` from responses exactly as returned (site URLs look like ${siteUrl({ config, requestUrl: new URL(origin) }, "bright-otter-x7k2")}).

## Quick start

- Publish: \`curl ${origin}/api/v1/publish -H "Authorization: Bearer $KEY" -F "index.html=@index.html" -F "assets/app.js=@assets/app.js"\` (form field name = file path). Also accepts a .zip body, JSON \`{"files":[{"path","content"}]}\`, or one raw file with \`?path=name.ext\`.
- Same site again: add \`slug=<slug>\`. Identical content returns \`unchanged\`.
- Change some files: \`PATCH ${origin}/api/v1/sites/{slug}/files\` with \`files\`, \`delete\`, \`move\`, \`baseVersionId\`.
- Large sites: \`POST /api/v1/sites/{slug}/versions\` with \`{path,size,sha256}\` for every file, \`PUT /api/v1/blobs/{sha256}\` only for the missing ones, then \`POST .../versions/{id}/finalize\`. The old \`/deploys\` paths still work as aliases.
- Viewing: browsers get rendered views (HTML is the real page, Markdown rendered); \`?raw=1\` returns raw bytes, \`?download=1\` downloads.

## MCP

${mcpLines(origin)}

## Docs

- [Full reference](${origin}/llms-full.txt): every endpoint, every MCP tool with its input schema, error codes
- [OpenAPI 3.1](${origin}/openapi.json): x-mcp-tool names available MCP twins; x-mcp-exclude explains REST-only operations
- [Agent Skill](${origin}/skill.md): install with \`npx skills add ${origin}\` or \`npx skills add TogetherWeOwn/kofra\`
- [Source (MIT)](https://github.com/TogetherWeOwn/kofra)

## REST endpoints

${ops.map((o) => `- \`${o.method} ${o.path}\` (${o.op.operationId}): ${o.op.summary ?? ""}`).join("\n")}

## MCP tools

${visibleTools.map((t) => `- \`${t.name}\`: ${firstSentence(t.description)}`).join("\n")}
`;
}

/** /llms-full.txt: the complete agent reference. */
export function llmsFullTxt(origin: string, config: DropwayConfig, tools: readonly McpToolDefinition[], registry?: readonly OperationDefinition[], availableTools?: ReadonlySet<string>): string {
  const visibleTools = tools.filter((tool) => availableTools ? availableTools.has(tool.name) : toolEnabled(tool, config));
  const available = availableTools ?? (tools.length ? new Set(visibleTools.map((tool) => tool.name)) : undefined);
  const ops = operations(origin, config, registry, available);
  const opBlock = (o: (typeof ops)[number]) => {
    const lines = [`### ${o.method} ${o.path}`, "", `operationId \`${o.op.operationId}\`${o.op.deprecated ? " (deprecated alias)" : ""}. ${o.op.summary ?? ""}`];
    if (o.op["x-mcp-tool"]) lines.push(`MCP tool: \`${o.op["x-mcp-tool"]}\`.`);
    else if (o.op["x-mcp-exclude"]) lines.push(`No MCP tool: ${o.op["x-mcp-exclude"]}.`);
    if (o.op.description) lines.push("", o.op.description);
    const params = (o.op.parameters ?? []).map((p) => `\`${String(p.name)}\` (${String(p.in)}${p.required ? ", required" : ""})${p.description ? `: ${String(p.description)}` : ""}`);
    if (params.length) lines.push("", `Parameters: ${params.join("; ")}.`);
    const bodyTypes = o.op.requestBody?.content ? Object.keys(o.op.requestBody.content) : [];
    if (bodyTypes.length) lines.push(`Body: ${bodyTypes.join(", ")}.`);
    return lines.join("\n");
  };
  const toolBlock = (t: McpToolDefinition) => {
    const a = t.annotations ?? {};
    const hints = [a.readOnlyHint ? "read-only" : "writes", a.destructiveHint ? "destructive" : null, t.idempotent ? "accepts idempotencyKey" : null].filter(Boolean).join(", ");
    return `### ${t.name}\n\n${t.description}\n\nToolset \`${t.toolset ?? "extra"}\`; ${hints}${t.scopes?.length ? `; needs ${t.scopes.join(", ")}` : ""}.\n\nInput schema: \`${JSON.stringify(t.inputSchema)}\``;
  };
  return `${llmsTxt(origin, config, tools, registry, availableTools).trimEnd()}

---

# Full reference

## Concepts

- Site: a slug (DNS label, e.g. bright-otter-x7k2) with settings and a live version. Tools accept a slug, a site id or any URL of the site.
- Version: an immutable set of files (path -> sha256, size, content type) with a number (v1, v2...). Publishing makes a new version live atomically; restore flips the live pointer back. Version arguments accept "live", "v3", "3" or an id.
- Files are stored once per owner by SHA-256: unchanged files are never uploaded twice, across versions and sites.
- File sources (MCP publish_site and update_site_files, REST PATCH .../files): each file has a path and exactly one of content (+encoding utf8 up to 1 MB or base64 up to 256 KB), url (+headers; public https only, up to 25 MB, 3 redirects, 30 s), sha256 (+size; reused if stored, otherwise an upload link is returned), copyFrom {site?, version?, path?} or a chat attachment {download_url, file_name} (fetched like url, file_name becomes the path). publish_site also accepts archiveUrl alone: a public https .zip downloaded and unpacked like an uploaded zip.
- Large files (REST/CLI): above 95 MiB the CLI stages bytes through POST /api/v1/uploads, PUT /api/v1/uploads/{id}/parts/{n} (10-95 MiB parts, resumable via GET /api/v1/uploads/{id}) and POST /api/v1/uploads/{id}/complete; the server hash-verifies the assembled file before finalize.
- status: "live" (the URL serves it now), "unchanged" (identical to the live version; nothing created) or "awaiting_upload" (PUT each upload.items[].url with the raw bytes and the same Authorization header, then finalize_version).
- Idempotency: writes accept idempotencyKey (MCP) or the Idempotency-Key header (REST PATCH .../files). The same key and arguments within 24 hours replay the first result (replayed: true); a different body returns 422 idempotency_key_reused. Secrets (new API keys) are not replayed.
- Viewers: navigations to a file get a rendered view chosen by type; sub-resource requests (img, script, fetch) always get raw bytes. ?raw=1 raw bytes (text types as text/plain), ?download=1 download, ?view=1 force the viewer.

## Error codes

${Object.entries(ERROR_CODES).sort(([a], [b]) => a.localeCompare(b)).map(([code, entry]) => `- ${entry.status} ${code} (retryable: ${entry.retryable}): ${entry.hint}`).join("\n")}

## REST operations

${ops.map(opBlock).join("\n\n")}

## MCP tools

Results carry structuredContent (matching the tool's outputSchema) plus a text block: one plain-English line, then the compact JSON. Live URLs also come as resource_link blocks. Business errors are results with isError: true and the text "<code>: <message> Fix: <hint>" followed by the error JSON.

${visibleTools.map(toolBlock).join("\n\n")}

## Agent Skill

${skillMarkdown({ origin, instanceName: config.instanceName, anonymousPublish: config.anonymous.enabled, exampleSiteUrl: siteUrl({ config, requestUrl: new URL(origin) }, "bright-otter-x7k2") })}`;
}

// ---------------------------------------------------------------- /connect

export interface ConnectSnippet {
  /** Short label rendered above the command, e.g. "Claude Code". */
  title: string;
  /** The exact text to copy-paste. */
  code: string;
}

export interface ConnectSection {
  title: string;
  intro: string;
  snippets: ConnectSnippet[];
}

/** Client-specific JSON shared by the home page and both /connect formats. */
export function mcpJsonSnippets(origin: string): ConnectSnippet[] {
  const url = `${origin}/mcp`;
  return [
    {
      title: "Cursor (.cursor/mcp.json or ~/.cursor/mcp.json)",
      code: JSON.stringify({ mcpServers: { kofra: { url, headers: { Authorization: "Bearer ${env:KOFRA_API_KEY}" } } } }, null, 2),
    },
    {
      title: "VS Code (.vscode/mcp.json)",
      code: JSON.stringify({
        inputs: [{ type: "promptString", id: "kofra-key", description: "Kofra API key", password: true }],
        servers: { kofra: { type: "http", url, headers: { Authorization: "Bearer ${input:kofra-key}" } } },
      }, null, 2),
    },
  ];
}

/**
 * One source of truth for the /connect page and /connect.md: the same sections
 * render as HTML (app.ts) and as Markdown (connectMarkdown) so they cannot drift.
 * Commands use the instance's own origin and `$KOFRA_API_KEY`; VS Code prompts for the key.
 */
export function connectSections(origin: string): ConnectSection[] {
  const mcp = `${origin}/mcp`;
  return [
    {
      title: "MCP (recommended)",
      intro: "One API key (`$KOFRA_API_KEY`, starts with `dw_`) unlocks every tool. Reads and writes go through the same permissions as the REST API.",
      snippets: [
        {
          title: "Claude Code",
          code: `claude mcp add --transport http kofra ${mcp} --header "Authorization: Bearer $KOFRA_API_KEY"`,
        },
        {
          title: "Codex (~/.codex/config.toml)",
          code: `[mcp_servers.kofra]\nurl = "${mcp}"\nbearer_token_env_var = "KOFRA_API_KEY"`,
        },
        ...mcpJsonSnippets(origin),
        {
          title: "Any MCP client (add-mcp)",
          code: `npx add-mcp ${mcp} --header "Authorization: Bearer $KOFRA_API_KEY"`,
        },
      ],
    },
    {
      title: "Agent Skill",
      intro: "Teaches the agent to publish, change, check and roll back on this instance, with its URLs filled in.",
      snippets: [{ title: "Install globally", code: `npx skills add ${origin} -g` }],
    },
    {
      title: "CLI",
      intro: "Hashes locally and uploads only files the server does not have yet.",
      snippets: [{ title: "Sign in, then publish", code: `npx kofra login --api ${origin}\nnpx kofra publish ./dist` }],
    },
    {
      title: "REST",
      intro: "Works everywhere curl does. The full reference is llms-full.txt; every operation is in openapi.json.",
      snippets: [
        {
          title: "Publish a page",
          code: `curl ${origin}/api/v1/publish -H "Authorization: Bearer $KOFRA_API_KEY" -F "index.html=@index.html"`,
        },
      ],
    },
  ];
}

/** /connect.md: the same setup lines as the /connect page, as Markdown. */
export function connectMarkdown(origin: string, instanceName: string): string {
  const sections = connectSections(origin)
    .map((s) => `## ${s.title}\n\n${s.intro}\n\n${s.snippets.map((sn) => `### ${sn.title}\n\n\`\`\`\n${sn.code}\n\`\`\``).join("\n\n")}`)
    .join("\n\n");
  return `# Connect an agent to ${instanceName}\n\nOne API key (\`$KOFRA_API_KEY\`, starts with \`dw_\`; the instance owner creates keys) works for MCP, REST and the CLI. Keep it secret: anyone holding it can publish as you.\n\n${sections}\n\n## Reference\n\n- [llms.txt](${origin}/llms.txt): how to publish, update and roll back\n- [llms-full.txt](${origin}/llms-full.txt): every endpoint, MCP tool and error code\n- [skill.md](${origin}/skill.md): the Agent Skill for this instance\n- [openapi.json](${origin}/openapi.json): every REST operation\n`;
}

/** /.well-known/api-catalog: RFC 9727 linkset to this instance's OpenAPI, docs and MCP endpoint. */
export function apiCatalog(origin: string) {
  const markdown = (href: string) => ({ href, type: "text/markdown" });
  return {
    linkset: [
      {
        anchor: `${origin}/`,
        "service-desc": [{ href: `${origin}/openapi.json`, type: "application/openapi+json;version=3.1.0" }],
        "service-doc": [`${origin}/llms.txt`, `${origin}/llms-full.txt`, `${origin}/skill.md`, `${origin}/connect.md`].map(markdown),
        describedby: [{ href: `${origin}/openapi.json`, type: "application/openapi+json;version=3.1.0" }],
        mcp: [{ href: `${origin}/mcp`, type: "application/json", title: "Remote MCP server (Streamable HTTP)" }],
      },
    ],
  };
}

/** /robots.txt: discovery docs are crawlable; the key-gated app shells are not. */
export function robotsTxt(): string {
  return `# Kofra app origin: discovery documents are public; dashboard, sign-in, claim,\n# file-browser and API shells need a key and are not worth crawling.\nUser-agent: *\nDisallow: /dashboard\nDisallow: /login\nDisallow: /claim\nDisallow: /v/\nDisallow: /view/\nDisallow: /mcp\nDisallow: /api/\n`;
}
