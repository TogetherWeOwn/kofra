# Kofra for agents: MCP server, REST twins, skill

Every Kofra instance serves a remote MCP server, an OpenAPI document and agent
docs. They are generated from the same sources, so they always describe what that
instance can do.

| URL on the app origin | What |
|---|---|
| `/mcp` | Remote MCP server (Streamable HTTP, stateless) |
| `/openapi.json` | OpenAPI 3.1 for every route. `operationId` = MCP tool name |
| `/llms.txt` | Short reference: connect lines, every endpoint and tool in one line |
| `/llms-full.txt` | Full reference: every operation, every tool with its input schema, error codes, the skill |
| `/skill.md` | Agent Skill with this instance's URLs filled in |
| `/.well-known/agent-skills/index.json` | Skill discovery index (v0.2.0) so `npx skills add <app origin>` works |

## Connect

Use an API key (`dw_...`) from the instance owner (`POST /api/v1/keys`, or the
`create_api_key` tool). A key limited to `sites:read`, or to one site, works too.

```sh
# Claude Code
claude mcp add --transport http kofra https://<app>/mcp --header "Authorization: Bearer $KOFRA_API_KEY"

# Codex (~/.codex/config.toml)
[mcp_servers.kofra]
url = "https://<app>/mcp"
bearer_token_env_var = "KOFRA_API_KEY"

# Any client, or a quick check
npx @modelcontextprotocol/inspector --cli https://<app>/mcp --transport http \
  --header "Authorization: Bearer $KOFRA_API_KEY" --method tools/list
```

The skill: `npx skills add TogetherWeOwn/kofra` (generic copy from this
repository) or `npx skills add https://<app>` (templated with that instance).

## How the server works

- Built with `createMcpHandler` from the Cloudflare Agents SDK (`agents/mcp/server`)
  and `@modelcontextprotocol/server` 2.x. Each request builds a fresh server: no
  session, no Durable Object. MCP 2026-07-28 clients use the per-request envelope;
  2025-era clients (`initialize` handshake) are served by the stateless legacy lane.
- Auth: `Authorization: Bearer` with an API key (or the `dwc_` claim token of an
  anonymous site), resolved by the same identity adapter as the REST API.
  Missing or bad credentials get `401` with `WWW-Authenticate: Bearer`.
- Narrowing: `?toolsets=core,sites,versions,keys,members,folders,transfers` (default: all) and
  `?read_only=1`; or the headers `X-Kofra-Toolsets` and `X-Kofra-Read-Only`.
  All 31 tools (32 when `claim_site` is enabled) are about 9k tokens of definitions; `core` is about 5.5k.
- Results: `structuredContent` matching the tool's `outputSchema`, plus one text
  block (a plain-English line, then the compact JSON), plus a `resource_link`
  for live URLs. Business errors are results with `isError: true` and the text
  `<code>: <message> Fix: <hint>` followed by the error JSON.
- Attribution: the version's `client` is the MCP `clientInfo` (2026 clients), else
  the `X-Kofra-Client` header, else the first word of the User-Agent.

## Tools

| Tool | Toolset | What | REST twin |
|---|---|---|---|
| `whoami` | core | Caller, scopes, instance URLs, limits | `GET /api/v1/me` |
| `publish_site` | core | Publish files from any source; creates or replaces a site | `POST /api/v1/publish` |
| `update_site_files` | core | Write, delete, move some files; the rest carries over | `PATCH /api/v1/sites/{slug}/files` |
| `finalize_version` | core | Go live after uploading sha256-only files | `POST .../deploys/{id}/finalize` |
| `get_site` | core | Site, settings, access mode, live version | `GET /api/v1/sites/{slug}` |
| `list_sites` | core | Your sites, paged | `GET /api/v1/sites` |
| `list_files` | core | Files of a version with public and raw URLs | `GET .../files` |
| `read_file` | core | Text or base64, paged with offset/length | `GET .../files/{path}` |
| `list_versions` | core | Immutable versions, newest first | `GET .../versions` |
| `restore_version` | core | Roll back (`v3`, `3` or an id) | `POST .../versions/{id}/restore` |
| `update_site_settings` | core | title, description, spa, renderMarkdown, crossOriginIsolation, noindex, viewers, ttlSeconds | `PATCH /api/v1/sites/{slug}` |
| `set_site_access` | core | `public` or `password` | `PUT .../access` |
| `delete_site` | core | Delete (needs `confirm` = slug) | `DELETE /api/v1/sites/{slug}` |
| `claim_site` | core | Claim an anonymous site (listed only when anonymous publishing is on) | `POST .../claim` |
| `create_site` | sites | Reserve a site without files | `POST /api/v1/sites` |
| `rename_site` | sites | New slug (the old URL stops working) | `POST .../rename` |
| `duplicate_site` | sites | Copy the live version into a new slug, live at once (only SPA mode carries over; re-apply a password) | `POST .../duplicate` |
| `release_slug` | sites | Release a held site name early | `POST /api/v1/slugs/release` |
| `get_version` | versions | One version; missing uploads of a pending one | `GET .../versions/{version}` |
| `delete_version` | versions | Delete a non-live version (needs `confirm`) | `DELETE .../versions/{id}` |
| `list_api_keys`, `create_api_key`, `revoke_api_key` | keys | Scoped keys | `/api/v1/keys` |
| `list_members`, `add_member`, `update_member`, `remove_member` | members | Members and roles | `/api/v1/members` |
| `delete_folder` | folders | Delete an organizer folder; its sites become unfiled (needs `confirm` = name) | `DELETE /api/v1/folders/{folder}` |
| `create_transfer`, `get_transfer`, `update_transfer`, `revoke_transfers` | transfers | Expiring file deliveries | `/api/v1/transfers` |

Not tools, on purpose: blob uploads (`PUT /api/v1/blobs/{sha256}`: raw bytes should
not pass through a model; upload items carry ready `curl` lines), first-run setup
and owner recovery (bootstrap key only), and HTML pages.

## File sources

`publish_site` and `update_site_files` take files as `{ path, ...one source }`:

| Source | When |
|---|---|
| `content` (+ `encoding: "utf8"`, up to 1 MB) | Text the agent just wrote |
| `content` + `encoding: "base64"` (up to 256 KB) | Small binaries only |
| `url` (+ `headers`) | Files already online. https only, public hosts only (re-checked on each of up to 3 redirects), up to the per-file limit (100 MB by default) and 25 MB in total per call (`ONESHOT_MAX_BYTES`), 30 s |
| `sha256` + `size` | Bytes already stored are reused at once; otherwise the result is `awaiting_upload` with `upload.items` (PUT, then `finalize_version`) |
| `copyFrom: { site?, version?, path? }` | A file you already published (same owner) |
| `download_url` + `file_name` (+ `headers`) | A chat-client attachment: fetched under the same https/SSRF guards as `url`, stored at `file_name` |
| `archiveUrl` (top level, instead of `files`) | A public https .zip the server downloads and unpacks like an uploaded zip |

Sites can be named by slug, site id or any URL of the site. Versions by `live`,
`v3`, `3` or id.

## Safety

- Writes take `idempotencyKey` (REST: `Idempotency-Key` on `PATCH .../files`).
  The same key and arguments within 24 hours replay the first result
  (`replayed: true`); other arguments give `422 idempotency_key_reused`. A replayed
  `create_api_key` or `add_member` returns `key: null`: secrets are shown once.
- `update_site_files` and `publish_site` take `baseVersionId`; a newer publish by
  someone else gives `409 version_conflict` with the live version in `details`.
- Destructive tools need `confirm` (the slug, or the member's email).
- `restore_version` and `delete_version` use the [version-action replay contract](OPERATIONS.md#version-action-replay):
  fresh site authorization and canonical delete confirmation precede any replay;
  target resolution is inside the claim. Callback exceptions retain an unknown
  pending claim (409) rather than permit another effect. REST/MCP keys are scoped
  separately. Retention is bounded to 24 hours, not an exactly-once guarantee;
  never infer success from a subsequent 404 or live-pointer read.

## Extending (embedding applications)

```ts
import { createDropway, type McpToolDefinition } from "@dropway/server";

const myTool: McpToolDefinition = {
  name: "my_tool",
  toolset: "extra",
  description: "What it does, when to use it, what it returns.",
  inputSchema: { type: "object", properties: { site: { type: "string" } }, required: ["site"] },
  outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  annotations: { readOnlyHint: true },
  scopes: ["sites:read"],
  async handler(args, { dw, principal, client }) {
    // call @dropway/core services; throw ApiError for business errors
    return { ok: true };
  },
  summarize: (r) => "Done.",
};

export default createDropway({ mcpTools: [myTool] });
```

Extension tools appear after the core tools; one with a core tool's name replaces
it. `createMcpEndpoint({ name, instructions, allowedOriginHostnames })` customises
the endpoint itself (`createDropway({ mcp: createMcpEndpoint(...) })`).
