# Kofra

Instant web hosting for AI agents and people, built entirely on Cloudflare.
Publish a file, a folder or a whole site to a live URL with one command or one
HTTP call. Every publish is an immutable version you can restore. MIT licensed;
runs on your own Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TogetherWeOwn/kofra)
[![ci](https://github.com/TogetherWeOwn/kofra/actions/workflows/ci.yml/badge.svg)](https://github.com/TogetherWeOwn/kofra/actions/workflows/ci.yml)

Prefer not to self-host? A hosted version is coming.

> Status: early MVP. The REST API, the remote MCP server, the CLI, the dashboard and the file viewers work today.

> Kofra was called Dropway. The old names keep working: the `dropway` command, `DROPWAY_*` variables and `X-Dropway-*` headers (sent and accepted alongside `X-Kofra-*`). <!-- rebrand:keep -->

## What you get

- **One-call publish**: a folder, a `.zip`, JSON, or a single raw file becomes a live URL.
- **Content-addressed, incremental deploys**: send a manifest of `{path, size, sha256}`, upload only
  the files the instance does not already hold, finalize atomically. An identical republish reports
  `unchanged` and creates no version.
- **Immutable versions** with instant restore, stale-write protection (`baseVersionId`) and per-version delete.
- **Every file viewable in the browser**: HTML as a real page, Markdown as a formatted page, code with
  highlighting, JSON as a tree, CSV as a table, images, PDF, video, audio, fonts and notebooks, each
  with Rendered / Source / Raw tabs; `?raw=1` returns any file's stored bytes. Folders without an index
  get a listing.
- **Dashboard**: sign in with an API key, drag-and-drop publish, versions, restore, files, keys,
  members and settings; a file browser at `/v/<site>/` that never renders user content on the app origin.
- **Agent-first**: a remote MCP server at `/mcp` with a tool for every capability, a CLI with JSON
  output and stable exit codes, an installable Agent Skill (`npx skills add TogetherWeOwn/kofra`),
  `/openapi.json`, `/llms.txt` and `/llms-full.txt` on every instance. Every error has a stable `code`
  and a `hint`; writes take idempotency keys.
- **Scoped API keys** (`sites:read`, `sites:write`, `keys:write`, `members:write`, optional single-site
  restriction); only hashes are stored.
- **Single tenant**: an owner plus optional members. No signup and no billing.
- **Cheap and fast**: one Worker with D1, R2 (each file stored once, by SHA-256), KV and Analytics Engine.

## Quick start for agents

You need an instance URL and an API key. Self-host one in a few minutes (next section), then:

```sh
export KOFRA_API=https://<your-instance>          # e.g. https://dropway.<you>.workers.dev
export KOFRA_API_KEY=dw_...
```

### CLI

```sh
npx kofra publish ./dist --json          # prints {"ok":true,"url":"https://...", ...}
npx kofra publish ./dist --site docs     # update the site "docs" (created if missing)
npx kofra versions docs                  # every version; restore with: npx kofra restore docs v2
```

Only changed files are uploaded, the command exits non-zero with a machine-readable error when
something is wrong, and `--wait` returns only once the URL serves the new version. Full reference:
[packages/cli/README.md](packages/cli/README.md). (The npm package is being prepared; until it is
published, run `node packages/cli/bin/dropway.mjs` from a clone after `npm install`.)

### GitHub pull-request previews

Use this repository's composite action to publish a build folder, update one PR
comment, and remove the preview on close. It uses your own Kofra instance and
supports trusted same-repository PRs only. See [setup, permissions and cleanup](docs/PR_PREVIEWS.md).

### Version badge

Every public site serves a live-version badge at its own `badge.svg`:

```markdown
[![kofra](https://<your-site-address>/badge.svg)](https://<your-site-address>/)
```

The dashboard site page prints this snippet with your address filled in. See [the badge docs](docs/SITE_BADGE.md).

### curl

```sh
curl "$KOFRA_API/api/v1/publish" \
  -H "Authorization: Bearer $KOFRA_API_KEY" \
  -F "index.html=@index.html" -F "assets/app.js=@dist/assets/app.js"
# -> { "url": "https://<your-instance>/s/bright-otter-x7k2/", "version": { "number": 1, ... }, ... }

# A build folder as a zip, into a named site:
(cd dist && zip -qr ../site.zip .)
curl "$KOFRA_API/api/v1/publish?slug=my-site" \
  -H "Authorization: Bearer $KOFRA_API_KEY" \
  -H "Content-Type: application/zip" --data-binary @site.zip
```

For large sites use the manifest flow (send hashes, upload only what is missing, finalize). It is
described in `GET /llms.txt` and `GET /openapi.json` on your instance.

### MCP

The MCP endpoint is `https://<your-instance>/mcp` (Streamable HTTP), authenticated with the same API key.

Claude Code:

```sh
claude mcp add --transport http kofra "$KOFRA_API/mcp" --header "Authorization: Bearer $KOFRA_API_KEY"
```

Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "kofra": {
      "url": "https://<your-instance>/mcp",
      "headers": { "Authorization": "Bearer ${env:KOFRA_API_KEY}" }
    }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "inputs": [{ "type": "promptString", "id": "kofra-key", "description": "Kofra API key", "password": true }],
  "servers": {
    "kofra": {
      "type": "http",
      "url": "https://<your-instance>/mcp",
      "headers": { "Authorization": "Bearer ${input:kofra-key}" }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.kofra]
url = "https://<your-instance>/mcp"
bearer_token_env_var = "KOFRA_API_KEY"
```

Claude Desktop and other clients that only start local servers, through
[`mcp-remote`](https://github.com/geelen/mcp-remote):

```json
{
  "mcpServers": {
    "kofra": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-instance>/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer dw_..." }
    }
  }
}
```

Agents that can run a shell should prefer `npx kofra publish <dir> --json`: no file bytes pass
through the model.

## Self-host on your Cloudflare account

1. Click **Deploy to Cloudflare** above. Cloudflare copies this repository to your GitHub account,
   creates the D1 database, R2 bucket and KV namespace, applies the database migrations and deploys
   the Worker. Set `ADMIN_BOOTSTRAP_KEY` to a long random string (`openssl rand -hex 32`) when asked.
   (Your account needs R2 enabled once in the dashboard.)
2. Create the owner and save their key:

   ```sh
   KOFRA_BOOTSTRAP_KEY=<your bootstrap key> npx kofra setup --api https://<your-worker>.workers.dev --email you@example.com
   ```

   or with curl: `curl -X POST https://<your-worker>.workers.dev/api/v1/setup -H "Authorization: Bearer <bootstrap key>" -H "Content-Type: application/json" -d '{"email":"you@example.com"}'`
3. Publish: `npx kofra publish ./dist`.

Sites are served at `https://<your-worker>.workers.dev/s/<name>/` out of the box. With a domain of
your own, each site can get its own origin (`https://<name>.your-sites-domain.com`). Command-line
deploys, configuration, serving modes and upgrades: [docs/SELF_HOST.md](docs/SELF_HOST.md).

## API reference

Every instance describes itself:

- `GET /openapi.json`: OpenAPI 3.1 for the REST API (`/api/v1`)
- `GET /llms.txt`: a short guide for language models
- `GET /api/v1/me`: who your key is and what it may do

## Docs

- [Self-hosting and configuration](docs/SELF_HOST.md)
- [CLI reference](packages/cli/README.md)
- [Site recovery spec: `kofra pull`](docs/CLI_PULL.md) (proposed, design only)
- [Architecture and extension points](docs/ARCHITECTURE.md)
- [Agents: MCP server, REST twins, skill](docs/MCP.md)
- [Embeddable live-version badge](docs/SITE_BADGE.md)
- [Product specification](docs/SPEC.md) and [roadmap](docs/ROADMAP.md)
- [Notes for coding agents working on this repo](AGENTS.md)

## Development

Node.js 22 or newer.

```sh
npm install
npm run check      # open-core guard, typecheck, all tests
npm test           # Workers-runtime tests (D1, R2, KV emulated) + CLI tests against a local Worker
npm run dev        # wrangler dev; put ADMIN_BOOTSTRAP_KEY in .dev.vars
```

This repository is the complete single-tenant product. CI fails if billing, pricing or payment code,
or code from a hosted service, lands here (`scripts/guard-open-core.mjs`).

The page design (Security Print: light, dark and Auto colour modes) lives in `packages/server/design/`.
Edit the sources there, then run `npm run design:build`; `npm test` fails while the generated modules
are stale. `npm run design:shots -- --out <dir>` screenshots every page in every colour mode at 390, 768
and 1440 px (headless Chrome via `CHROME_PATH`). See `packages/server/design/DESIGN.md`.

## Third-party fonts

Pages use three fonts, served by the Worker itself from `/__dropway/fonts/` (no font CDN):
[Public Sans](https://github.com/uswds/public-sans), [Newsreader](https://github.com/productiontype/Newsreader)
and [Martian Mono](https://github.com/evilmartians/mono). All three are under the
[SIL Open Font License 1.1](https://openfontlicense.org) with no Reserved Font Name. The files are the
unmodified `@fontsource-variable` 5.3.0 builds; the licences are in `packages/server/design/fonts/OFL-*.txt`
and every instance serves them at `/__dropway/fonts/OFL.txt`.

## License

[MIT](LICENSE). The bundled fonts keep their own licence (SIL OFL 1.1, above).
