# Kofra roadmap (open-source edition)

Status: draft 1, 2026-10-22. Ordered work for this repository. Each item is 1-3 days of agent work, has
acceptance criteria, and names the `docs/SPEC.md` features it delivers. Work top to bottom; items marked
"parallel" can run at the same time as the item before them because they touch different files.

Milestones:

- **M0 Dogfood MVP (P0)**, R-01 to R-16: publish through the API, CLI and MCP; serving; versions; scoped
  keys; anonymous publish with claim (off by default); viewers with a rendered/raw toggle.
- **M1 Parity (P1)**, R-17 to R-37: here.now feature parity for a single tenant.
- **M2 Beyond (P2)**, R-38 to R-51.
- **M3 Kofra ports (P1)**, R-52 to R-58: transfers to named people, delivery email and receipts, holds, very
  large files, hardened webhooks, strict rate limits. Owner approved 2026-10-22; read the M3 rules first.

## Definition of done (every item)

1. `npm run typecheck && npm test` pass; new behaviour has tests in `test/` (workerd, real D1/R2/KV emulation).
2. New operations are in the operation registry (after R-02), so REST, OpenAPI, MCP, `llms.txt` and CLI
   tables update together; every new error code is in the catalog.
3. `npm run guard` (`scripts/guard-open-core.mjs`) passes: no plans, prices, billing, payment code or public sign-up.
4. Extension API changes bump `EXTENSION_API_VERSION` and add a CHANGELOG line; the contract test covers them.
5. Migrations are new numbered files; applied ones are never edited.
6. `docs/SPEC.md` status column updated in the same pull request.

## Progress (2026-10-22, MVP merge)

The first three feature branches are merged into `main` on top of the baseline below:

| Item | State | What landed |
|---|---|---|
| R-01 | Done | Open-core guard and self-test in CI (npm, Yarn, pnpm and Bun text locks); `EXTENSION_API_VERSION = 1`, Extension API changelog and contract tests for every existing extension point. |
| R-04 | Partial | File sources (`content`, `url`, `sha256` + upload link, `copyFrom`) and idempotency keys for agent writes. |
| R-05 | Partial | Partial updates (`PATCH /api/v1/sites/:slug/files`), `GET` version status, rename. |
| R-06 | Done | Remote MCP server at `/mcp` (Streamable HTTP) with a tool for every core capability, toolsets and read-only mode. |
| R-07, R-08 | Done | Viewer bar with Rendered / Source / Raw, HTML frame, code highlighting, Markdown, JSON, CSV, images, SVG, PDF, video, audio, fonts, notebooks, binary info, cached renders. |
| R-09, R-10 | Done | `kofra` CLI: publish (hash locally, upload only missing files), list, versions, restore, delete, login, whoami, setup, `api`. Not yet published to npm. |
| R-11 | Done | `/llms.txt`, `/llms-full.txt`, `/skill.md`, `/.well-known/agent-skills`, repo skill in `skills/kofra`, `/connect`, `/connect.md`, `/.well-known/api-catalog`, `/robots.txt`. |
| R-22 | Partial | Dashboard (sign-in with an API key, sites, versions, publish, keys, members, settings) and the app-origin file browser `/v/:slug/`. Sessions and login links are R-21. |

Next: R-02 (operation registry), R-12 (path-mode hardening), R-13 (version preview URLs), R-14, R-15, R-16.

## Baseline (in `main` at `866ca07`)

One-call publish (multipart, zip, raw, inline JSON); manifest deploys with per-tenant content-addressed
dedupe (`/sites/:slug/deploys`, `PUT /blobs/:sha256`, finalize); unchanged detection; `baseVersionId`
conflicts; versions list/restore/delete; read-back of files; scoped API keys; members; bootstrap setup and
recovery; anonymous publish with claim tokens (off by default); password gates; SPA mode; cross-origin
isolation; Markdown viewer and folder listings; `?raw=1` and `?download=1`; path and subdomain modes with
HTML/CSS rewriting and `Referer` redirects; hourly cleanup cron; Analytics Engine writes; `/openapi.json`
and `/llms.txt`; extension points `createDropway({ config, adapters, hooks, apiMiddleware, routes,
mcpTools, mcp, uiSlots, viewers, scheduled })`; 50 tests.

---

## M0: Dogfood MVP (P0)

### R-01 Open-core guard, extension contract test, extension API version (1 day)
Delivers: OPS-08 (part). Depends: none.
- Done: `scripts/guard-open-core.mjs` (`npm run guard`) runs in CI and fails on: the private-code SPDX
  marker (the guard holds the exact string), payment SDK dependencies in any `package.json` or lockfile, a `.gitmodules`
  file, or code that imports a package outside this repo's `@dropway/*` and declared dependencies.
- `packages/server` exports `EXTENSION_API_VERSION = 1`; `CHANGELOG.md` has an "Extension API" section.
- `test/extension-contract.test.ts` exercises every existing extension point with fakes: identity,
  policy limits and refusals (`beforeCreateSite`, `beforeDeploy`), metering events (all 5 kinds), all 3
  hooks, an API route override, an app route, an MCP tool registration, UI slots, a viewer, `scheduled`.
- Done: the guard's `--self-test` plants the marker, a payment SDK and a billing folder and checks each is caught.

### R-02 Operation registry and generated OpenAPI (3 days)
Delivers: AX-01. Depends: R-01.
- `defineOperation()` per SPEC 6.5 with zod input/output schemas; all existing `/api/v1` routes are
  re-expressed as operations (old paths kept as aliases) and the hand-written `openapi.ts` is replaced by a
  generator.
- `/openapi.json` validates as OpenAPI 3.1 (Spectral or Redocly lint in CI: operationId, summary,
  description, examples and error responses required).
- `GET /api/v1/operations` returns the CLI command table (id, method, path, scopes, input schema, cli path).
- `createDropway({ operations })` accepts extension operations; the contract test registers one and sees
  it in REST, OpenAPI and the MCP tool list.
- CI test: every operation is an MCP tool or has `mcp.exclude` with a reason; descriptions under 4,096
  characters; stable tool order.
- All 50 existing tests still pass unchanged (behaviour preserved).

### R-03 Error envelope v2 and error catalog (1 day)
Delivers: AX-07, PUB-06 (richer conflict details). Depends: R-02 (parallel with late R-02 work).
- `ApiError` gains `retryable`, `retryAfterSeconds`, `docs`, `next`, and validation errors list every bad
  field in `details.fields`.
- `version_conflict` details name the live version id, number, client and time.
- `packages/core/src/error-codes.ts` lists every code with HTTP status, retryability and hint; a test fails
  if a service throws a code not in the list; `/docs/errors.md` is generated from it.
- `Retry-After` is set on every 429 and 503.

### R-04 Publish v2: file sources, upload links, idempotency (3 days)
Delivers: PUB-03, PUB-04, PUB-08, ID-05. Depends: R-02, R-03. Migration `0002` (idempotency, version and
site columns, usage counters).
- `publish_site` JSON accepts the flat `FileInput` (SPEC 9.2): `content` (utf8 or base64), `url`,
  `sha256`+`size`, `copyFrom`; exactly one source per file, else `invalid_request` with `details.fields`.
- URL sources: https only, public addresses only (private, loopback and link-local refused, re-checked on
  each of at most 3 redirects), 30 s timeout, `URL_FETCH_MAX_BYTES`; tests cover each refusal.
- Responses use `PublishResult` (SPEC 9.2): `status` live/unchanged/awaiting_upload, `versionUrl`,
  `files` counters, `warnings`, `next`.
- Missing blobs come back as upload items with `url`, `headers` and a ready `curl` line using a
  `dwu_` upload token (HMAC, scoped to that pending version, expires with it). `PUT /blobs/{sha256}` with
  that token works; with a token for another version it returns 403.
- `Idempotency-Key` (REST) / `idempotencyKey` (MCP): same key + same body replays the first response with
  `replayed: true`; same key + different body returns 422; concurrent duplicate returns 409 retryable.
- Inline caps enforced (`inline_too_large` hint names the CLI and upload links).

### R-05 Versions naming, partial updates, version status (2 days)
Delivers: PUB-02 (rename to /versions), PUB-07, PUB-11, VER-02. Depends: R-04.
- `/sites/{site}/versions` routes replace `/deploys` (kept as aliases, tested); `{version}` accepts
  `live`, `v12`, `12` or an id.
- `PATCH /sites/{site}/files` (`update_site_files`): `write`, `delete` (a trailing `/` deletes a folder),
  `move`; untouched files carry over by hash; `baseVersionId` conflicts return 409 with `next`.
- `get_version` returns status, counts, and for pending versions the missing files with fresh upload items.
- Finalizing with missing bytes returns `409 missing_blobs` with fresh upload items (no separate refresh call).
- Test: two agents edit the same site; the second gets `version_conflict`, rebases with
  `update_site_files`, and both changes are live.

### R-06 Remote MCP server with the core toolset (3 days)
Delivers: AX-02, AX-08 (part), PUB-09 (MCP). Depends: R-02, R-03, R-05.
- `/mcp` served by `createMcpHandler` (`agents/mcp/server`) with `@modelcontextprotocol/server` 2.x,
  stateless, compatibility lane for 2025 clients; no Durable Object.
- Auth: `Authorization: Bearer dw_...` resolved through the identity adapter; missing or bad credentials
  return 401 with a `WWW-Authenticate` header.
- `PUT /sites/{site}/access` with modes `public` and `password` (mapped onto the existing password
  setting; `restricted` and `private` return `feature_unavailable` until R-23).
- The `core` tools are generated from the registry with `outputSchema`, `structuredContent`, a one-line
  text summary, annotations, `alwaysLoad` on `whoami` and `publish_site`: 14 of the 15 now (`check_site`
  arrives in R-20; `claim_site` is listed only when anonymous publish is on); `delete_site` requires
  `confirm` equal to the slug (until R-17 it needs `sites:write`).
- Business errors return `isError: true` results with code, message and hint.
- Server `instructions` per SPEC 9.3, under 4,096 characters (test).
- MCP `clientInfo` is stored as the version's `client`.
- Manual check recorded in the PR: Claude Code (`claude mcp add --transport http ... --header`) publishes a
  page, updates one file, lists versions and restores v1 against `wrangler dev`.

### R-07 Viewers 1: viewer bar, HTML viewer frame, source and code (2-3 days)
Delivers: VIEW-01, VIEW-02 (HTML, code, text, config, Markdown highlighting). Depends: none (parallel with R-02..R-06).
- Every viewer page has the bar (name, size, type, version; Rendered, Source, Raw, Download, Copy link)
  and works with JavaScript disabled.
- `page.html?view=1` shows the viewer frame (bar + page in an iframe); `?view=source` shows highlighted
  source for any text file.
- Code, text and config files render highlighted with line numbers and `#L10-L20` anchors; Markdown code
  blocks are highlighted.
- Highlighter chosen by benchmark (highlight.js vs Shiki JavaScript engine) on a 1 MB file: CPU time and
  bundle size recorded in the PR; the Worker stays under 3 MB compressed.
- Rendered output is cached under `render/<viewer>@<version>/<sha256>`; a second request does not re-render (test).
- Markdown and any user HTML pass an allowlist sanitizer (tests for `<script>`, `onerror=`, `<base>`,
  `<meta http-equiv>`, `<form>`, `javascript:` URLs).

### R-08 Viewers 2: media, data and listings (2-3 days)
Delivers: VIEW-02 (images, SVG, PDF, video, audio, JSON, CSV, listing). Depends: R-07.
- Viewers per SPEC 10.2 for image, svg (shown through `<img>` so its scripts never run), pdf, video, audio,
  json (collapsible `<details>` tree, no script), csv/tsv (table, first 2,000 rows, counts).
- Folder listings render `README.md` below the file list; image galleries keep working.
- Sub-resource requests (`Sec-Fetch-Dest: image`, `script`, `empty`) still get raw bytes for every type (test).
- Over-cap files fall back to raw (text: first part with a note) (test per viewer).
- Visual check: screenshots of each viewer in light and dark themes attached to the PR.

### R-09 CLI: publish (3 days)
Delivers: AX-04 (part). Depends: R-04, R-05.
- `npx kofra publish <dir|file|zip> --json [--site] [--new] [--message] [--spa] [--anonymous] [--base]
  [--wait]` hashes files (streaming SHA-256), sends the manifest, uploads only missing blobs 6 at a time
  with retries on 429/5xx, finalizes, and prints one JSON object on stdout (SPEC agent contract);
  progress on stderr.
- `--wait` polls the returned `url` until `X-Kofra-Version` equals the new version (default 90 s; exit 8 on timeout).
- Credentials: `--api-key` > `KOFRA_API_KEY` > `~/.dropway/credentials.json` (0600, keyed by instance
  origin); instance: `--url` > `KOFRA_URL` > `dropway.json` > error with a hint.
- Ignores `.git/`, `node_modules/`, `.env*`, `*.pem`, `*.key`, `.dropway/` (except data/proxy manifests),
  `.dropwayignore`; refuses files that match secret patterns unless `--allow-secrets` (exit 2).
- Writes `dropway.json` after the first publish so re-running updates the same site.
- Exit codes 0-8 per the agent-experience contract; zero runtime dependencies, one bundled file.
- Published to npm as `kofra` (name verified free on 2026-10-23) and served by each instance at
  `<app>/cli/dropway.tgz`. If npm credentials are not available yet, the tarball path ships first and the
  npm publish is recorded as an operator to-do.

### R-10 CLI: management commands (2 days)
Delivers: AX-04, PUB-19. Depends: R-09. Parallel with R-11.
- `sites ls`, `site`, `files ls|cat`, `pull`, `versions ls`, `rollback [version]` (default: previous),
  `rm --yes`, `claim`, `whoami`, `keys ls|create|revoke`, `settings`, `access --password` (stdin), `watch`.
- `kofra api <operationId|METHOD path> --data '<json>'` calls any operation the instance lists in
  `/api/v1/operations`.
- Non-TTY never prompts; destructive commands without `--yes` refuse in non-TTY (exit 2).
- Golden tests of `--json` output for each command against a local `wrangler dev` instance.

### R-11 Discovery files and the instance skill (2 days)
Delivers: AX-06. Depends: R-02. Parallel with R-10.
- `/llms.txt` (v2), `/llms-full.txt`, `Link: rel="describedby"` headers, generated from the registry.
- `/skill.md` (under 2,000 tokens) templated with the instance's app and sites origins, anonymous setting
  and CLI install line; `/.well-known/agent-skills/index.json` (sha256 digest) and legacy
  `/.well-known/skills/index.json`; `GET /api/v1/skill/version`.
- `npx skills add <app> -g` installs the skill from a local `wrangler dev` instance (recorded in the PR).
- `/.well-known/api-catalog` (RFC 9727 linkset), `/connect` and `/connect.md` with one-liners for Claude
  Code, Codex, Cursor, `add-mcp`, the skill and curl; `/robots.txt`.

### R-12 Path-mode hardening and publish warnings (2 days)
Delivers: SRV-02 (SPA fallback), PUB-12, ANON-04 (sandbox). Depends: R-04.
- Done 2026-10-22: `SITES_SANDBOX` accepts `auto|true|false`; default `auto` sandboxes anonymous sites on
  a dedicated sites origin and everything on the app origin (tests for each mode). Sandboxed path-mode
  pages get the run-time URL shim (`path-shim.ts`).
- A navigation with a same-origin `Referer` inside SPA site X to a path X lacks redirects to X (test).
- Publish and finalize return warnings with `fix` text: `root_absolute_paths` (path mode),
  `spa_without_base`, `uses_browser_storage` (when the site will be sandboxed), `wasm_without_coi`,
  `possible_secret` (file and line), `invalid_config`.
- Paths under `__dropway/` are rejected at publish; `.dropway/*` files are stored but never served (tests).

### R-13 Version preview URLs (2 days)
Delivers: SRV-07. Depends: R-05.
- `<slug>--v<N>` serves that exact version in both modes (`/<slug>--v<N>/` and `<slug>--v<N>.<domain>`).
- Access: owner credentials (`Authorization` header) or a signed preview link (`?dw_preview=`, 24 h) that
  sets a path-scoped cookie and redirects to the clean URL; others get 404.
- `versionUrl` in publish results is a signed preview link; responses carry `X-Robots-Tag: noindex` and
  `Referrer-Policy: no-referrer`.
- Right after publishing, the version URL serves the new bytes even while the live URL still serves the
  old version (test with a stale KV entry).

### R-14 Hot-path caching and freshness measurement (2 days)
Delivers: SRV-06. Depends: R-13. Parallel with R-15.
- Blobs served through the Cache API keyed by sha256 (immutable); pointer memo in the Cache API (10 s) in
  front of KV; Range requests and files over 25 MB bypass the Cache API.
- A second request for the same file from the same data center does no R2 read (test via binding call counts).
- `scripts/measure-freshness.mjs` publishes a change and polls the live URL until it changes; results from
  a `workers.dev` deployment (p50/p95) recorded in `docs/SELF_HOST.md`.
- Probe whether `cf-cache-status`/Cache API hits work on `workers.dev` and record the answer.

### R-15 Same-site hardening and anonymous-publish polish (2 days)
Delivers: SPEC 11.2 same-site rules, ANON-04 (report link), ACC-01. Depends: none. Parallel with R-14.
- Cookie-authenticated state-changing app requests require `Origin` = app origin and
  `Sec-Fetch-Site: same-origin` (tests for a cross-origin and a same-site-cross-origin attacker).
- App cookies use the `__Host-` prefix; site cookies stay path-scoped.
- Anonymous HTML pages show a small fixed "Report abuse" link (injected by `HTMLRewriter`, sandbox-safe);
  `?raw=1` is never modified.
- Generated slugs use a 6-character suffix; existing slugs keep working.

### R-16 First-run page and one-click verification (2 days)
Delivers: ID-01 (browser), OPS-01, OBS-05. Depends: R-11.
- An instance that is not set up shows a setup form on `/`: bootstrap secret + email -> owner key shown
  once -> `/connect`. The form posts only to the app origin; the bootstrap secret is never stored client-side.
- `/health` reports `version` (package version) and `build` (a `BUILD_SHA` var set at deploy time, `"dev"` when unset).
- Fresh-account test per SPEC 12.5 on a Free and a Paid Cloudflare account; time to first publish and every
  manual step recorded in `docs/SELF_HOST.md`. Fix anything the button cannot do or document it.
- **M0 exit:** our own agents publish prototypes and reports through the CLI and MCP for a week; the top 5
  error codes by count are reviewed and fixed or documented.

---

## M1: Parity (P1)

### R-17 Scopes v2, capabilities, quotas, usage counters (2 days)
Delivers: OPS-03, AX-08, ID-03 (scopes). Depends: R-02.
- New scopes `sites:delete`, `data:write`, `secrets:write`, `admin` with the `0002` key migration
  (existing `sites:write` keys keep delete); `delete_site`, `delete_version`, `delete_folder` require `sites:delete`.
- `PolicyAdapter.capability`, `.quota`, `.beforeOperation` per SPEC 6.3; `CAPABILITIES` and `QUOTA_KEYS`
  exported; default policy reads admin config (`QUOTA_*` vars) and binding presence.
- `usage_counters` updated at site create/delete and finalize; `recomputeUsage()` nightly; `beforeDeploy`
  receives `newBytes`.
- `whoami` returns `capabilities`, `limits` and `usage`; a missing binding shows as unavailable (test with
  bindings removed).
- Contract test: an adapter denies `site_password` with a custom hint; the API returns that error and core
  contains no plan wording.

### R-18 Tenant services, serving adapter, worker composition, testing kit (2-3 days)
Delivers: OPS-08, SPEC 6.4-6.9. Depends: R-17.
- `suspendTenant`, `resumeTenant`, `deleteTenant`, `addMember` exported; suspended tenants' sites answer
  503 "unavailable" unless `beforeServe` answers.
- `ServingAdapter.resolveHost` and `.beforeServe` wired into routing and serving; zero extra I/O when unset (test).
- `createDropway({ queues })` returns a `queue` handler dispatching by queue name; Durable Object classes
  exported from `@dropway/server/durable-objects`; `hooks.onEvent` emits every `DropwayEvent`.
- `RouteExtension` can contribute OpenAPI fragments, merged into `/openapi.json`.
- `@dropway/server/testing` exports `createTestDropway`, `seedTenant`, `seedSite`, `publishFixture`; the
  contract test uses it and covers every extension point in SPEC 6.

### R-19 Post-publish job pipeline and AI metadata (2 days)
Delivers: OBS-03, ORG-03. Depends: R-18. Migration `0003` (jobs part).
- Queue `JOBS` (+ dead-letter queue) in `wrangler.jsonc`; finalize enqueues jobs; without the binding,
  jobs run in `waitUntil` (test both).
- `metadata` job: title/description from caller, then HTML `<title>`/meta, then Workers AI (`AI` binding)
  when present and `AI_METADATA` is not off; `metadata_source` recorded.
- `get_version` shows job states.

### R-20 Screenshots, check_site, diff, dry run (3 days)
Delivers: OBS-04, VER-03, VER-04, AX-09, PUB-17. Depends: R-19.
- `screenshot` job via the `BROWSER` binding: `thumbs/<versionId>.webp` and `og/<versionId>.png`; skipped
  when the entry HTML and its assets are unchanged; `og:image` served for sites without one.
- `check_site`: broken internal links, missing assets, path-mode traps, mixed content, `noindex`, large
  uncompressed assets; with `BROWSER`, console errors, failed requests and a screenshot.
- `diff_versions` (added, removed, changed; unified diff for text files up to 64 KB) and `dryRun: true` on
  `publish_site` / `update_site_files`.

### R-21 Sign-in: sessions, login links, email codes, Access identity (2 days)
Delivers: ID-06, ANON-03 (claim by sign-in). Depends: R-15. Migration `0004`.
- `create_login_link` (15 min, one use) for members; `/login?token=` creates a `__Host-dw_session` session.
- `EmailAdapter` default uses the `EMAIL` binding when present: email-code sign-in for existing members
  (5 tries, 15 min); without it the option is hidden and `feature_unavailable` is returned.
- Optional `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`: a valid Cloudflare Access JWT maps to a member by email.
- Sessions list and revoke for the member; logout; claim page lets a signed-in member claim an anonymous site.

### R-22 Dashboard v1 and app viewer page (3 days)
Delivers: PUB-18, VIEW-05, ORG-04, ID-02 (UI). Depends: R-21, R-08.
- Server-rendered pages (Hono JSX, small vanilla JS): sites list with search, site page (versions with
  restore, files with viewer iframes, settings), drag-and-drop publish (folder, zip, file), keys, members,
  QR code per site.
- `/view/{site}/{path}`: tabs and version picker; user content only inside an iframe on the sites origin.
- Every action calls public REST operations (test: the dashboard bundle references no non-registry endpoint).
- `uiSlots.settingsSections` and `uiSlots.banner` rendered; Playwright smoke test of the main flows.

### R-23 Access control and sharing (3 days)
Delivers: ACC-03, ACC-04, ACC-05, ACC-06, SRV-11. Depends: R-21. Migration `0005`.
- `set_site_access` modes public/password/restricted/private; restricted sign-in by emailed code at
  `<site>/__dropway/access`; members-only via session; policy version bump invalidates every grant.
- Share links: create, list, revoke; signed, expiring, optionally version-pinned; use counts.
- Access invites by email (with `EMAIL`); embed allowlist (`frame-ancestors`); gated sites refuse framing
  and are `noindex`.
- Gates apply on every address of a site (slug, version preview, mounts) (tests).
- Playwright WebKit and Firefox run the password and share-link flows on a sandboxed site (records the
  third-party-cookie behaviour from SPEC 14).

### R-24 OAuth 2.1 for MCP and CLI login (3 days)
Delivers: ID-07, AX-03 (auth). Depends: R-21, R-06.
- `@cloudflare/workers-oauth-provider` with `OAUTH_KV`: authorization code + PKCE, CIMD
  (`global_fetch_strictly_public`), DCR for older clients, RFC 9728 metadata, step-up `insufficient_scope`.
- Consent page signs the person in through the identity adapter (session, or paste an API key); granted
  scopes never exceed the member's role.
- API keys still work on `/mcp` via `resolveExternalToken` (test).
- `kofra login` (loopback PKCE with a pre-registered public client) and `kofra login --device`
  (device code, approved from the dashboard) store tokens per instance.
- Manual checks recorded: Claude.ai custom connector and ChatGPT developer mode connect and publish.

### R-25 MCP: all toolsets, narrowing, resources, apps card (3 days)
Delivers: AX-03, AX-10, ID-02 (tools). Depends: R-24.
- Every tool in SPEC 9.2 whose feature exists is registered; `?toolsets=`, `?read_only=1`, `?site=` and
  header equivalents work (tests: read-only hides writes; site scope rejects other sites).
- Resource templates, skill resources, three prompts; `ui://dropway/site-card` MCP Apps resource on the
  four publishing tools with a CSP limited to the sites origin.
- `call_api` and `search_docs`; `read_file` paging by range.
- Measured `tools/list` token size for `core` and `all` recorded in docs.

### R-26 Local stdio MCP in the CLI (1-2 days)
Delivers: AX-05. Depends: R-25, R-10.
- `npx -y kofra mcp` serves the same tools over stdio using `/api/v1/operations`; `localPath` and
  `localDir` sources hash and upload from disk.
- Tested with the MCP inspector and one coding agent.

### R-27 Static hosting correctness and site lifecycle (2 days)
Delivers: SRV-05, SRV-09, SRV-12, PUB-15, PUB-16, VIEW-06. Depends: R-05.
- `_redirects` (301/302/307/308, splats, placeholders) and `_headers` (path patterns) parsed at finalize
  into `config_json`; invalid lines become warnings; files never served.
- Cache policy matrix from SPEC SRV-05 (tests per class).
- `ttlSeconds` for keyed sites; `duplicate_site`; settings `noindex` and `viewers`; a site's own
  `robots.txt` served.

### R-28 Folders and search (2 days)
Delivers: ORG-01, ORG-02. Depends: R-19. Migration `0006`.
- Folder operations and tools; `list_sites ?folder=<id|name|none>`; `create_folder` with an existing name
  returns `created: false`.
- `index` job fills `site_search` (slug, title, description, paths, text of HTML/Markdown/text files up to
  a cap); `list_sites ?query=` returns matches with fields, paths and snippets.

### R-29 Analytics (2-3 days)
Delivers: OBS-01, OBS-02. Depends: R-19. Migration `0007`.
- Analytics Engine data point per SPEC 7.4 (views, 404s, bots; assets sampled); crawler classification
  including AI crawlers.
- Daily rollup cron into `analytics_daily`; `get_analytics` for a site or the instance (ranges 24h/7d/30d/90d/all)
  reads Analytics Engine SQL when `ANALYTICS_API_TOKEN` is set, else D1.
- Visitors counted from the daily salted hash (approximate distinct, or exact within the rollup).

### R-30 Site Data (3 days)
Delivers: APP-01. Depends: R-18.
- `.dropway/data.json` validated at finalize (types and rules per SPEC; invalid = warning and data off).
- `SiteDataStore` Durable Object per site (SQLite); browser API at `./.dropway/data/<collection>` with
  per-action access (public/owner/none), `Origin` checks for public writes, `Idempotency-Key`, rate limits.
- Owner API and the four `data` tools; records survive republish; schema removal hides fields without deleting data.

### R-31 Variables and proxy routes (3 days)
Delivers: APP-02, APP-03. Depends: R-17. Migration `0008`.
- Variables encrypted with AES-256-GCM (`VARIABLES_KEY` secret, key versioning); write-only on every surface.
- `.dropway/proxy.json` exact and prefix routes; `${VAR}` substitution only into requests to pinned
  upstreams (403 naming the variable otherwise); query forwarded; responses streamed (SSE test);
  10 MB body cap; per-route rate limit.
- An invalid manifest disables routes and returns a finalize warning.

### R-32 Drives (2-3 days)
Delivers: DRV-01, DRV-02, DRV-03, ID-03 (path prefix). Depends: R-05, R-17.
- `create_site kind:"drive"`; drive sites are never served (404 on the sites origin).
- Per-file conditional writes (`ifMatch` sha256, `ifNoneMatch: "*"`) and atomic batches via `update_site_files`.
- API keys with `site_id` + `path_prefix` + read or write act as share tokens; `kofra drive share` prints a
  hand-off block.
- `duplicate_site` from a drive to a site.

### R-33 Custom domains and mounts (3 days)
Delivers: DOM-02, DOM-03. Depends: R-18. Migration `0009`.
- `DomainAdapter` manual (instructions) and `cloudflare_api` (operator token; creates Workers Custom
  Domains or routes on the operator's zones).
- Domains, mounts (root and paths), primary domain with 308 redirects that keep path and query; `host:` KV
  map read by `resolveHost`; gates apply on mounted addresses.
- `site.urls[]` lists every address, primary first.

### R-34 Viewers 3, Markdown for agents, static assets (3 days)
Delivers: VIEW-03, SRV-10. Depends: R-08.
- `ASSETS` binding with `run_worker_first` excluding only `/__dropway/assets/*`; nonce CSP for viewers with scripts.
- Notebooks, JSON Lines, diff/patch, fonts, binary info page, YAML/TOML tree, Mermaid (strict) and KaTeX in
  Markdown, sortable/filterable CSV, JSON search.
- `Accept: text/markdown` navigations return Markdown; `read_file as:"markdown"` converts HTML, PDF and
  Office files with Workers AI when bound.

### R-35 Large uploads, archive URLs, attachments (2 days)
Delivers: PUB-13, PUB-14. Depends: R-04.
- `POST /uploads`, `PUT /uploads/{id}/parts/{n}` (10-95 MB parts), `complete` using R2 multipart; staged
  under `uploads/`, hashed with a streaming digest before becoming `blobs/<sha256>`; resumable by listing parts.
- CLI uses it above 95 MB; a 150 MB file round-trips with the right sha256 (test with a generated file).
- `archiveUrl` and `{download_url, file_name}` attachments as sources.
- Record the 99 MB vs 101 MB single-request result on `workers.dev`.

### R-36 Rate limits (1-2 days)
Delivers: OPS-05. Depends: R-17.
- Rate Limiting binding for bursts, D1 counters for hourly buckets, `PolicyAdapter.rateLimit` override.
- `RateLimit-Policy`, `RateLimit` and `Retry-After` headers; MCP errors carry the same numbers in `details`.

### R-37 Abuse basics and moderation (2 days)
Delivers: OPS-06, ANON-05, ANON-06. Depends: R-19. Migration `0003` (abuse part).
- Report form at `<site>/__dropway/report` and `POST /api/v1/abuse-reports` (rate limited; Turnstile when
  `TURNSTILE_SECRET` is set); admin list; `takedown` serves a notice page and blocks the files' hashes.
- `ModerationAdapter` default heuristics on anonymous publishes (password inputs, forms posting to other
  origins); `hold` keeps the site unpublished until claimed; tests for hold and allow.
- `anonymous_challenge_required` flow: a `challengeUrl` with Turnstile issues a short-lived publish token.

---

## M2: Beyond parity (P2)

### R-38 Audit log (1 day)
Delivers: ID-08. Depends: R-17.
- Every registry write records actor, action, target, client and hashed IP; `list_audit_events` with
  filters; secrets never logged (test greps a password and a variable value).

### R-39 Comments loop (3 days)
Delivers: COL-01. Depends: R-22, R-25. Migration `0010` (comments).
- Visitors (and signed-in members) comment on a page, an element or a version from the viewer frame and
  dashboard; agents `list_comments`, `reply_to_comment`, `resolve_comment` (with the fixing version).

### R-40 Webhooks (2 days)
Delivers: AX-12, COL-03. Depends: R-19. Migration `0010` (webhooks).
- Subscriptions per event and site; HMAC-SHA256 signatures with a timestamp; delivery through the Queue with
  retries and auto-disable after repeated failures; SSRF rules apply.

### R-41 Live reload (2 days)
Delivers: SRV-13, COL-02. Depends: R-18.
- `LiveChannel` Durable Object per site with hibernating WebSockets; viewer pages and version previews
  reload on publish; sites opt in with `<script src="/__dropway/live.js">`.

### R-42 Runtime instance settings and version retention (1 day)
Delivers: OPS-04, VER-05. Depends: R-17.
- `instance_settings` override vars at runtime (anonymous publish, limits, quotas, rate limits, AI
  metadata); `get/update_instance_settings`; retention job prunes old non-live versions when configured.

### R-43 Code Mode endpoint (2 days)
Delivers: AX-11. Depends: R-25.
- `/mcp/code` with `search` and `execute` over this instance's OpenAPI via `@cloudflare/codemode` when
  `LOADER` is bound; the caller's credential is injected host-side and never visible to the sandbox.
- Compared with plain tools on the agent task suite; results recorded before it is advertised.

### R-44 Scale: manifests in R2, D1 replicas (3 days)
Delivers: SPEC 7.5. Depends: R-14.
- Finalize writes `manifests/<versionId>.json`; serving and read-back use it; `blobs.ref_count` replaces
  scans for garbage collection; a backfill job migrates existing versions.
- Experiment: live pointer from D1 read replicas (Sessions API) behind the 10 s memo; p95 and freshness
  compared with KV and recorded.

### R-45 Typed client and npm packages (2 days)
Delivers: AX-13. Depends: R-02.
- `@dropway/client` generated from the registry; the CLI uses it; `@dropway/core`, `@dropway/server`,
  `@dropway/client` and `dropway` published with npm trusted publishing from CI.

### R-46 GitHub Action and pull-request previews (2 days)
Delivers: PUB-20. Depends: R-09.
- `TogetherWeOwn/dropway-action`-style composite action in this repo (`action.yml`): publish a folder,
  comment the preview URL on the PR, delete the preview when the PR closes.

### R-47 End-to-end encrypted sites (2-3 days)
Delivers: ACC-07. Depends: R-09.
- `kofra publish --encrypt` encrypts files in the CLI (AES-256-GCM, key in the URL fragment); a
  first-party loader decrypts in the browser; the server never sees the key; wording says exactly what it
  protects.
- Implemented for CLI files/folders up to 16 MiB, with an authenticated container and an opaque
  static-content viewer. No ZIP/SPA/external application hosting. Threat model and compatibility:
  [CLI guide](../packages/cli/README.md#encrypted-publishing). Browser-side publishing is not included.

### R-48 Per-site functions (3 days)
Delivers: SRV-14, APP-04. Depends: R-31.
- `functions/*.js` in a site run in Dynamic Workers (`LOADER`) with no outbound network except an
  allowlist, CPU and subrequest limits, and access to that site's Site Data and variables.

### R-49 Passkeys (2 days)
Delivers: ID-09. Depends: R-21.
- WebAuthn registration and sign-in for members on the app origin; recovery by login link.

### R-50 Rename, vanity names, public gallery (2 days)
Delivers: ORG-05, DOM-04. Depends: R-33.
- `rename_site` with a 307 from the old slug (default on); vanity names `<site>--<name>.<SITES_DOMAIN>`;
  opt-in public gallery page and JSON feed on the app origin.

### R-51 Viewers 4 (2-3 days)
Delivers: VIEW-04. Depends: R-34.
- Archives (entry list), Office previews (Workers AI conversion, labelled as previews), 3D models, GeoJSON
  maps, EPUB, each with caps and fallbacks per SPEC 10.2.

---

## M3: Kofra ports (P1)

The owner approved merging Kofra into this codebase on 2026-10-22. These items rebuild old Kofra's best
features on this codebase's model (sites, versions, content-addressed blobs). Do them in order: R-52 first.
The hosted parts (plan limits, the mail provider, the DMCA process, payments) are in the private SaaS
roadmap, not here.

**Owner decision 2026-10-22: no virus or malware scanning, in core or SaaS.** No ClamAV, no scan job
protocol, no `ScannerAdapter` and no scan-verdict gate are planned. No page, mail or doc may say that files
are "scanned" or "virus-free". Abuse-report categories such as `malware` stay: they are reports, not
scanning. TOTP is not ported either; passkeys (R-49) cover second factors.

Rules for every M3 item, on top of the Definition of done:

1. **Rules and tests, not code.** The spec is old Kofra's rules and tests (archived private repository at
   `156468e`; each card names the files). Restate them as your own tests in `test/`. Copy no code,
   fixtures, test data or literals.
2. **Publication check.** That source is private and contains internal host names and markers. Before you
   open a PR, check the diff for any internal host name, IP address, account, issue reference or marker,
   and say in the PR that you did.
3. **Live check.** An item is done when it works on a deployed instance (staging or a self-host test
   deploy), with the evidence linked in the PR. A closed card is not the measure.

### R-52 Transfers: expiring, password-protected deliveries to named people (3 days)
Delivers: new (add the SPEC rows in the build PR). Depends: R-02.
- `create_transfer` (REST, MCP and CLI through the operation registry) creates a site in `transfer` mode:
  files, up to 50 recipient email addresses (normalised, deduplicated once), an optional message (at most
  10,000 characters, shown as plain text, never HTML), an optional password, an expiry and an optional
  download limit. It returns one link per recipient plus one general link.
- Transfer files are always downloads (`Content-Disposition: attachment`, `nosniff`), never rendered, and
  are served from the sites host, never the app origin. The transfer page (message, file list, sizes,
  password form) is on the app origin.
- Bounds, each with a refusal test: password 8 to 1,024 characters, no NUL, empty means "no password";
  expiry from 1 hour to `TRANSFER_MAX_EXPIRY_DAYS` (default 30, at most 3,650), read through
  `PolicyAdapter.limits` so a host can lower it; download limit 1 to 10,000.
- Download order, in this exact order, with a test for each neighbouring pair: unknown slug, deleted
  transfer or missing file -> 404; live takedown -> 451, decided from the slug alone, above expiry and
  above the password, naming no ground; expired, revoked or download limit reached -> 410; password set
  and not unlocked -> password form (403 for API clients); otherwise the file. A transfer expiring exactly
  now still downloads; one millisecond later it is 410.
- Counts: per file and per recipient link, visible to the owner in `get_transfer`. A download counts when
  a GET without `Range`, or with a range starting at byte 0, is served; resumed ranges do not count again.
- A transfer the caller may not see answers 404, never 403, so "no such transfer" and "not yours" look
  the same.
- Updates (message, expiry, recipients, download limit) are allowed only while the transfer is live and
  no recipient has been notified yet; otherwise, or under a hold or takedown, they answer 409. A no-op
  update answers 200 and records no event.
- Revoke marks the transfer expired at once: the next request is 410 and is not counted, and the owner
  can still read the transfer. `revoke_transfers` revokes several (by id, or all live ones) in one call
  and returns the count. A revoke racing an update: exactly one wins, the other answers 409. Storage
  quota is released once, when the bytes are purged, never at revoke.
- Changing or clearing a set password requires the current password in the same call. The unlock cookie
  is bound to the password digest, so every earlier unlock stops working after a change. Hashing uses the
  same KDF as password sites; unlock attempts are rate limited per IP and per transfer.
- Slug tombstones: a slug once used by a transfer is never given to a different owner after a rename or
  deletion, so an old link never lands on someone else's files. The member who freed it may reuse it.
  Tombstones outlive the transfer and the member.
- The hourly cleanup claims live transfers past their expiry idempotently (a re-run claims nothing).
  Expiry is never blocked by a hold; purging the bytes is (R-54).
- No scanning (owner 2026-10-22): downloads are never gated on a scan, and the page never claims files
  are scanned. It states plainly that Kofra does not scan files and shows each file's exact type, size
  and SHA-256 checksum instead.

### R-53 Delivery email, receipts and download notifications (2-3 days)
Delivers: new. Depends: R-52, R-21.
- Events with stable ids through `hooks` (and as webhook event types once R-40 is in): `transfer.created`,
  `transfer.notified`, `transfer.opened`, `file.downloaded`, `transfer.expiring`, `transfer.expired`,
  `transfer.revoked`. `list_transfer_activity` returns them for one transfer, also as CSV.
- Mail goes through `EmailAdapter` (the `EMAIL` binding when present). Without it, transfers still work
  and return their links; the mail options answer `feature_unavailable`. Templates: one link email per
  recipient (the sender's message as plain text), a sender receipt, an immediate "downloaded" notice, a
  daily digest, and an expiry reminder.
- Outbox: every mail is an outbox row keyed by event and recipient, so a repeated event never mails twice.
  Failures retry, then dead-letter after `maxAttempts` with the reason. One failing mail never holds up
  the others in the same run.
- "Downloaded" notices follow the owner's setting: `immediate` sends at most one mail per transfer, file
  and download; `daily` sends one digest per transfer covering the previous 24 hours; `off` sends nothing.
- Expiry reminder: exactly one per deadline, only while the deadline is in the future and at most 24 hours
  away; changing the expiry re-arms it; never for expired, revoked or deleted transfers. Two sweeps racing
  send one mail.
- Every recipient mail has an unsubscribe link. Unsubscribed and suppressed addresses are skipped, with an
  audit entry; the suppression list outlives the transfer.
- Names and messages are inert in mail: a test uses a name with CR/LF, HTML and a URL. Mail never contains
  a password or file bytes.

### R-54 Takedown and legal-hold primitives (1 day)
Delivers: new (extends R-37). Depends: R-37, R-52. Extension API change.
- A hold can be put on a site, a transfer or a blob with a required reason and released with a required
  reason. Reasons over 255 characters are cut on a code-point boundary. History is append-only
  (`hold.applied`, `hold.released`) and goes to the audit log. Applying twice changes nothing; releasing
  something not held is an answer, not an error.
- **A hold blocks deletion, never expiry.** Expiry, revoke and takedown still deny access. Only purges are
  fenced: the hourly cleanup, version retention, site and member deletion, and orphan-blob collection.
- The fence is live: each purge checks holds immediately before each delete, never from a list read
  earlier. A test lands a hold between the cleanup's select and its delete, and the delete is skipped.
- Takedown on sites and transfers: missing 404 above takedown 451 above expired 410 above password. The
  451 page names no ground. A taken-down transfer that expires still answers 451.
- New extension point `hooks.beforePurge`, so a host (the SaaS DMCA process) can add holds. Bump
  `EXTENSION_API_VERSION`, add the CHANGELOG line and a contract test.

### R-55 Optional direct-to-R2 multipart uploads for very large files (3 days)
Delivers: new (extends R-35). Depends: R-35. Off by default.
- On only when the operator sets R2 S3 API credentials as secrets. The Deploy button cannot create
  those, so the Worker-proxied path from R-35 stays the default and works without them. Without
  credentials the direct operations answer `feature_unavailable`.
- Start checks size, name, type and quota before handing out any URL. Parts are whole MiB, at least 8
  MiB, at most 10,000 parts. A session lives 24 hours; each part URL lives 15 minutes and is refused after.
- A quota refusal or a failed write aborts the R2 multipart upload just created (best effort), so no paid
  parts are left behind. An abort racing a completion cannot orphan parts (whoever claims first wins).
- Completion refuses a forged ETag, a missing part, a duplicated part number hiding a missing one, and a
  part that was never uploaded. The Worker then checks the size and SHA-256 of the whole object itself
  before it becomes `blobs/<sha256>`; ETags and client metadata never count as checksums. A mismatch is
  final and the object is deleted. A repeated completion changes nothing; a crash midway resumes once.
- The cleanup aborts sessions past their lifetime (holds respected, R-54).
- **Measure before promising sizes.** Record CPU and wall time to hash 1, 10 and 100 GiB after upload on
  `workers.dev` in the PR. The advertised maximum comes from that measurement.
- No scanning (owner 2026-10-22): completion queues no scan job.

### R-56 Optional signed short-lived direct downloads (1 day)
Delivers: new. Depends: R-55, R-52.
- With the same R2 credentials, and for files over `DIRECT_DOWNLOAD_MIN_BYTES` (default 1 GiB), a
  transfer download may answer 302 to a presigned R2 GET that lives at most 5 minutes and forces
  `attachment`. Worker streaming stays the default, and the only path for sites.
- The full download order (R-52, R-54) runs before every URL is made; only "allowed" makes one. Revoked,
  expired, taken-down, locked and missing files never get a URL (tests).
- Each URL made counts as one download. A storage error counts the attempt but records no bytes. Analytics
  record the file size as an upper bound and say so.
- The redirect is `Cache-Control: no-store`. The docs say the URL exposes the R2 account host.

### R-57 Hardened webhooks (1 day, extends R-40)
Delivers: new. Depends: R-40.
- The signature covers the exact bytes sent (HMAC-SHA256 with a timestamp). Retries send byte-identical
  bodies under one delivery id, with a fresh timestamp and signature.
- Up to 5 attempts, 10 s, 60 s, 300 s and 900 s apart; a bounded dead-letter list; an endpoint switches
  off after 15 failed deliveries in a row, and the owner gets one alert.
- Secret rotation: both secrets sign for 24 hours, then only the new one.
- Budget of 300 events per endpoint per minute: above it, events are dropped (not queued), with one
  warning per endpoint per minute. A repeat of the same event to the same endpoint creates no second
  delivery.
- SSRF: resolve and check DNS before every attempt. Any private, loopback, link-local or reserved address
  in the answer fails closed. DNS errors and policy refusals report the same reason. Redirects are never
  followed; response bodies are read only up to a cap. Workers `fetch` cannot pin the checked address, so
  DNS rebinding remains a documented limit; test the `global_fetch_strictly_public` flag and record the
  result.

### R-58 Strict rate limits on Durable Objects (1-2 days, extends R-36)
Delivers: new. Depends: R-36.
- For security limits (sign-in codes, password unlocks, abuse reports, key creation), one SQLite Durable
  Object per bucket is the source of truth, because the Rate Limiting binding only counts per location.
  Bucket names are fixed, versioned SHA-256 names with no location in them; each environment has its own
  namespace.
- The per-client limit is checked before the global one; the global limit holds across buckets.
- The client address comes only from `CF-Connecting-IP`; forged forwarding headers change nothing. IPv6
  counts per /64; IPv4-mapped and IPv4-compatible IPv6 forms share the IPv4 bucket.
- If the counter is unavailable, these limits refuse (fail closed). `OPTIONS` and unknown paths spend
  nothing. 429 answers carry `RateLimit` and `Retry-After`.
