# Kofra specification (open-source edition)

Status: draft 1, 2026-10-22. This is the technical source of truth for the open-source, single-tenant
Kofra in this repository. `docs/ARCHITECTURE.md` explains how the current code is laid out;
`docs/SELF_HOST.md` is the operator guide; `docs/ROADMAP.md` orders the work. When this file and the
code disagree, the code describes what exists today and this file describes where it is going. Fix
whichever is wrong in the same pull request.

Tags used in this document:

- **P0**: the dogfood MVP being built now: publish through the API, the CLI and MCP; serving; versions;
  scoped API keys; optional anonymous publish with claim; file viewers with a rendered/raw toggle.
- **P1**: feature parity with here.now's public API and product.
- **P2**: beyond parity.
- **Done**: in `main` at commit `866ca07` (the baseline). Items delivered by the MVP merge after that
  (MCP server, viewers, dashboard, CLI, discovery files) are tracked in `docs/ROADMAP.md`, "Progress". **Partial**: part of it is in `main`. **R-NN**: the
  `docs/ROADMAP.md` item that delivers it.

Placeholders: `<app>` is the app origin (app, REST API, MCP), for example
`https://dropway.<you>.workers.dev`. `<sites>` is where sites are served (section 11.2).

---

## 1. Product summary

Kofra publishes a file, a folder or a whole static site to a live URL in one call, then lets you
manage it: immutable versions with instant rollback, a rendered or raw view of every file type,
passwords and private links, analytics, and small-app features (a record store and secret-injecting
proxy routes) that need no backend. It is built for AI agents first (REST API, remote MCP server,
CLI, installable skill) and works for people through a dashboard and plain links.

It runs entirely on Cloudflare (Workers, R2, D1, KV, Durable Objects, Queues, Analytics Engine and
optional Workers AI, Browser Run, Email Service and Turnstile). It is MIT licensed. Anyone can deploy
it to their own Cloudflare account with the Deploy to Cloudflare button.

This edition is **single tenant**: one owner, optional members, scoped API keys. It has no sign-up for
strangers, no plans, no prices, no billing and no payment code. Limits are whatever the instance owner
configures. An embedding application can add those things from outside through `createDropway()`
(section 6); nothing in this repository depends on such an application.

What Kofra is not:

- Not a build service. Agents build locally (or in CI) and publish the output.
- Not a general compute platform. Sites are static. Dynamic behaviour comes from Site Data, proxy
  routes and, later, sandboxed per-site functions (P2).
- Not a code host. Use git for source; use Kofra for what a person or agent should look at.

---

## 2. Personas

| Persona | Typical jobs | Main surface | "Good" means |
|---|---|---|---|
| **Coding agent with a shell** (Claude Code, Codex, Cursor, OpenCode, CI bots) | Publish a build or a report, update a few files, check the result, roll back, share privately | CLI `npx kofra`, local or remote MCP, REST | One command publishes; no file bytes pass through the model; JSON on stdout; errors say what to do next; the URL works when the command returns |
| **Chat or IDE agent without a shell** (Claude.ai, Claude Desktop, ChatGPT, VS Code) | Publish a page it just wrote, publish files that are already online, read back what it published | Remote MCP (OAuth or API key) | Small default toolset, inline text and URL sources, a preview card in the chat |
| **Developer** | Self-host for their team, script publishes, embed Kofra in their own product, extend it | REST + OpenAPI, CLI, `createDropway()` | One-click deploy, stable typed API, documented extension points, tests that run locally |
| **Non-technical user** | Open a link, read a report, view a PDF, CSV or image, enter a password, drop a folder in the dashboard | Browser: sites origin and dashboard | Every file type looks right in the browser with a "raw" and "download" option; nothing to install |
| **Small team self-hosting** | Share internal prototypes and documents safely; give each person and agent its own key; keep everything on their own Cloudflare account | Dashboard, API keys, members | Private by default for sensitive sites, audit of who published what, near-zero running cost |

---

## 3. Principles

1. **One call for the common case.** One request publishes a page and returns its URL. The
   multi-step manifest flow is for large or binary sites.
2. **Never move bytes through a model when there is another way.** Preference: local path (CLI or local
   MCP) > server-side URL fetch > already-stored hash > inline text > base64.
3. **Every write is safe to retry.** Content-addressed blobs, `Idempotency-Key`, `unchanged` results,
   idempotent finalize, restore and delete, and `baseVersionId` conflict checks.
4. **Every error says what to do next**: a stable `code`, a `hint`, whether a retry can help, and
   sometimes the exact call that fixes it.
5. **Never make the caller build URLs.** Responses carry `url`, and per file `viewUrl`, `rawUrl` and
   `downloadUrl`. URL shapes differ between modes and will change when an instance gets a domain.
6. **Same names everywhere.** The MCP tool `list_versions` is the OpenAPI `operationId: list_versions`
   and the CLI command `kofra versions ls`.
7. **The live instance is the truth.** Each instance describes itself (`whoami`, `/openapi.json`,
   `/llms.txt`, its skill), so self-hosted instances with fewer optional features are described correctly.
8. **Agents check their own work** (`check_site`, read-back, version preview URLs, `--wait`).
9. **Destructive actions need a cheap explicit confirmation** (`confirm: "<slug>"` in MCP; `--yes` in the CLI).
10. **The app origin never serves user content.** User bytes are only ever served from the sites origin(s).
11. **Anything a person can click, an agent can call.** The dashboard uses only public REST operations.
12. **Logic lives in `@dropway/core` services; every surface is thin.** REST, MCP, CLI and dashboard
    call the same services, so permissions, limits and errors are identical.
13. **No SaaS concepts here.** No plans, prices, billing, payment code, public sign-up or usage-based
    limits beyond admin-set config. Extension points name capabilities and events, never plans.

---

## 4. Feature list

### 4.1 Publishing (PUB)

| ID | Feature | Pri | Status |
|---|---|---|---|
| PUB-01 | One-call publish `POST /api/v1/publish`: multipart (`-F path=@file`), a `.zip` body, one raw file, or JSON with inline files. Creates a site or, with `?slug=`/`site`, replaces all files of an existing one | P0 | Done |
| PUB-02 | Manifest publish: send `{path, size, sha256, contentType?}` for every file; the server answers with only the hashes it still needs; upload those; finalize atomically | P0 | Done (as `/deploys`; renamed `/versions` in R-05) |
| PUB-03 | File sources in JSON and MCP, one per file: `content` (utf8), `content`+`encoding:"base64"` (small binaries), `url` (server fetches it, SSRF-guarded), `sha256`+`size` (already stored), `copyFrom` (another site, version or path) | P0 | Implemented (R-04); deployment verification pending |
| PUB-04 | Upload links: the response lists `PUT <app>/api/v1/blobs/<sha256>` targets with a ready `curl` line and a short-lived upload token scoped to the pending version. One egress host; no R2 credentials needed | P0 | Implemented for JSON/MCP file sources (R-04); deployment verification pending |
| PUB-05 | Byte-identical republish returns `status: "unchanged"` and mints no version; settings in the same call still apply | P0 | Done |
| PUB-06 | Stale-write protection: `baseVersionId` returns `409 version_conflict` naming the live version, who published it and when | P0 | Done |
| PUB-07 | Partial update `PATCH /api/v1/sites/{site}/files` (`update_site_files`): write, delete and move paths relative to a base version; everything else carries over by hash | P0 | R-05 |
| PUB-08 | `Idempotency-Key` on every create (24 h); finalize, restore and delete are idempotent | P0 | JSON publish and registered keyed writes use atomic D1 replay; legacy raw/multipart/ZIP publishing is not keyed. Finalize replay done |
| PUB-09 | Client attribution: `X-Kofra-Client: <harness>/<detail>` header or MCP `clientInfo`, stored per version | P0 | Done (header); MCP in R-06 |
| PUB-10 | Version message (like a commit message, up to 200 chars) | P0 | Done |
| PUB-11 | Pending versions expire after 1 hour; finalizing with missing bytes returns `409 missing_blobs` with fresh upload links | P0 | Partial (expiry done); R-05 |
| PUB-12 | Publish warnings: root-absolute paths in path mode, SPA without a base path, browser storage on a sandboxed origin, `.wasm` without cross-origin isolation, possible secrets, invalid config files | P0 | R-12 |
| PUB-13 | Files larger than one request (above about 95 MB): multipart upload through the Worker, resumable | P1 | R-35 |
| PUB-14 | `archiveUrl` (publish a zip from a URL) and chat-client attachments (`{download_url, file_name}`) as sources | P1 | R-35 |
| PUB-15 | Duplicate a site server-side (immediately live) | P1 | Done |
| PUB-16 | TTL for keyed sites (`ttlSeconds`, `null` clears) | P1 | R-27 |
| PUB-17 | Dry run: `dryRun: true` returns added, changed, removed and skipped files and the resulting size without creating a version | P1 | R-20 |
| PUB-18 | Drag-and-drop publish in the dashboard (folder, zip or file) | P1 | R-22 |
| PUB-19 | `kofra watch` republishes on change | P1 | R-10 |
| PUB-20 | GitHub Action and per-pull-request preview sites with cleanup | P2 | Done: [composite action](PR_PREVIEWS.md), trusted same-repository PRs |

### 4.2 Serving and URLs (SRV)

| ID | Feature | Pri | Status |
|---|---|---|---|
| SRV-01 | Three serving modes: subdomain (each site its own origin), path on a dedicated sites origin, path on the app origin (always sandboxed). Section 11.2 | P0 | Done |
| SRV-02 | Path mode keeps sites inside `/<slug>/`: HTML and CSS root-relative URLs are rewritten; URLs built at runtime are resolved by `Referer` with a 307 (unsandboxed pages) or by an injected run-time shim (sandboxed pages, which send no Referer); navigations inside an SPA fall back to the SPA. Interim until an instance has a domain | P0 | Done (SPA navigation fallback in R-12) |
| SRV-03 | Index resolution: `index.html`, `index.htm`, `index.md`, `README.md`; a one-file site serves that file at `/`; folders without an index get a listing; `404.html`; SPA fallback | P0 | Done |
| SRV-04 | Headers: `ETag` (sha256), `Range`/206, pre-compressed `.br`/`.gz` with `Content-Encoding`, `X-Kofra-Version`, `X-Robots-Tag: noindex` on expiring sites, `X-Content-Type-Options: nosniff` | P0 | Done |
| SRV-05 | Cache policy matrix (HTML and unfingerprinted files revalidate; fingerprinted files immutable; gated sites `private, no-store`; sites with `.wasm` revalidate) | P0 | Partial; R-27 |
| SRV-06 | Content-addressed edge cache (Cache API by sha256, pointer memo). Live URL shows a new version within about 60 s worldwide, the version URL at once | P0 | R-14 |
| SRV-07 | Version preview URLs `<slug>--v<N>` for the owner (signed links for others) | P0 | R-13 |
| SRV-08 | Cross-origin isolation per site (COOP/COEP for `SharedArrayBuffer` and threaded WebAssembly) | P0 | Done |
| SRV-09 | `_redirects` and `_headers` files at the site root (Netlify/Cloudflare Pages syntax subset), parsed at finalize, never served | P1 | R-27 |
| SRV-10 | Agent-readable pages: `Accept: text/markdown` on a navigation returns a Markdown rendering of HTML and text files | P1 | R-34 |
| SRV-11 | Embeds: public sites can be framed anywhere; gated sites refuse framing; per-site embed allowlist (`frame-ancestors`) | P1 | Partial; R-23 |
| SRV-12 | Robots: anonymous and expiring sites `noindex`; per-site `noindex` setting; a site's own `robots.txt` is served when present | P0 | Partial; R-27 |
| SRV-13 | Live reload: open tabs refresh when a new version goes live | P2 | R-41 |
| SRV-14 | Per-site functions (sandboxed server code via Dynamic Workers) | P2 | R-48 |

### 4.3 File viewers (VIEW)

Full matrix in section 10.

| ID | Feature | Pri | Status |
|---|---|---|---|
| VIEW-01 | Browser navigations to a file get a rendered view chosen by file type, with a bar offering Rendered, Source, Raw and Download. `?raw=1` returns the stored bytes (text types as `text/plain`), `?download=1` downloads, `?view=1` forces the viewer, `?view=source` shows highlighted source. Sub-resource requests always get raw bytes | P0 | Partial (Markdown, listing, raw, download done); R-07 |
| VIEW-02 | P0 types: HTML (real page, plus a viewer frame and source view), Markdown, images, SVG, PDF, video, audio, JSON, CSV/TSV, code (60+ languages), plain text, folder listing with image gallery and README | P0 | R-07, R-08 |
| VIEW-03 | P1 types: Jupyter notebooks, Mermaid and math inside Markdown, YAML/TOML tree, sortable and filterable CSV, JSON search, font specimens, diffs and patches, binary info page | P1 | R-34 |
| VIEW-04 | P2 types: Office documents (via Markdown conversion), archives (entry list), 3D models, GeoJSON maps, EPUB | P2 | R-51 |
| VIEW-05 | App-origin viewer page `<app>/view/{site}/{path}` with tabs and a version picker; user content stays in an iframe on the sites origin | P1 | R-22 |
| VIEW-06 | Per-site switches: `renderMarkdown` (exists) and `viewers: false` (always raw) | P0/P1 | Partial; R-27 |

### 4.4 Versions (VER)

| ID | Feature | Pri | Status |
|---|---|---|---|
| VER-01 | Immutable, numbered versions (`v1`, `v2`, ...) with source, client, message, file count, bytes | P0 | Done |
| VER-02 | List, get, restore (pointer flip; restoring the live version is a no-op success), delete one non-live version (for leaked secrets) | P0 | Done (get in R-05) |
| VER-03 | Diff two versions (added, removed, changed; unified text diffs for small text files) | P1 | R-20 |
| VER-04 | Thumbnail per version | P1 | R-20 |
| VER-05 | Admin-set retention (keep last N versions or N days per site; default keep all) | P2 | R-42 |

### 4.5 Identity and access to the instance (ID)

| ID | Feature | Pri | Status |
|---|---|---|---|
| ID-01 | First-run setup with the `ADMIN_BOOTSTRAP_KEY` secret creates the owner and a full-scope key; recovery mints a new owner key | P0 | Done (browser setup page in R-16) |
| ID-02 | Members with roles `owner`, `admin`, `member` | P1 | Done (REST); tools R-25; dashboard R-22 |
| ID-03 | Scoped API keys: named, scopes, optional single-site restriction, optional path prefix, optional expiry, last-used time; shown once, stored as SHA-256; 50 per member | P0 | Done (new scopes R-17; path prefix R-32) |
| ID-04 | Claim tokens (`dwc_`) for anonymous sites | P0 | Done |
| ID-05 | Upload tokens (`dwu_`) scoped to one pending version | P0 | Implemented (R-04), HMAC and live manifest/expiry checks; deployment verification pending |
| ID-06 | Dashboard sign-in: one-time login links minted by the owner, an agent or the CLI; email codes when an email binding exists; optional Cloudflare Access identity; revocable sessions | P1 | R-21 |
| ID-07 | OAuth 2.1 for MCP and the CLI (Client ID Metadata Documents, Dynamic Client Registration for older clients, PKCE loopback, device code for headless machines), step-up scopes | P1 | R-24 |
| ID-08 | Audit log of every write (who, what, when, from which client) | P2 | R-38 |
| ID-09 | Passkeys for dashboard sign-in | P2 | R-49 |

### 4.6 Anonymous publish and claim (ANON)

| ID | Feature | Pri | Status |
|---|---|---|---|
| ANON-01 | Off by default (`ANONYMOUS_PUBLISH=false`); one setting turns it on | P0 | Done |
| ANON-02 | Anonymous sites expire (default 24 h), have smaller caps, a per-IP hourly creation limit and `noindex` | P0 | Done |
| ANON-03 | Claim token and claim URL (token in the URL fragment, never sent to the server); claim by API (`claim_site`) or by signing in | P0 | Done (sign-in claim in R-21) |
| ANON-04 | Anonymous sites are always sandboxed on a shared sites origin and carry a small "Report abuse" link | P0 | Sandbox and link done; report form R-37 |
| ANON-05 | Optional Turnstile on browser uploads; agent-compatible challenge (`anonymous_challenge_required` with a `challengeUrl` a human opens once) when abuse pressure is on | P1 | R-37 |
| ANON-06 | Moderation hook: hold suspicious anonymous HTML (password fields, forms posting elsewhere) until claimed | P1 | R-37 |

### 4.7 Access control and sharing (ACC)

| ID | Feature | Pri | Status |
|---|---|---|---|
| ACC-01 | Hard-to-guess random slugs (`adjective-noun-xxxxxx`; 6-character suffix for new slugs, existing 4-character slugs unchanged) | P0 | Done |
| ACC-02 | Password per site: checked server-side, stored hashed, survives redeploys; changing it signs everyone out | P0 | Done |
| ACC-03 | Access modes `public`, `password`, `restricted` (verified emails and email domains), `private` (members only); one mode at a time; applies on every address of the site | P1 | R-23 |
| ACC-04 | Share links: signed, expiring, optionally pinned to a version, revocable, with a use count | P1 | R-23 |
| ACC-05 | Access invites by email (needs an email binding) | P1 | R-23 |
| ACC-06 | Embed allowlist per site | P1 | R-23 |
| ACC-07 | End-to-end encrypted sites (CLI-side AES-256-GCM before upload, fragment-only key, first-party browser decryption) | P2 | Implemented: CLI static viewer; browser publishing not included. See packages/cli/README.md for threat model and limits |

### 4.8 Organisation and search (ORG)

| ID | Feature | Pri | Status |
|---|---|---|---|
| ORG-01 | Folders: flat, one per site, invisible to visitors; agents must not invent folder names | P1 | Table done; R-28 |
| ORG-02 | Search over slug, title, description, file paths and extracted text | P1 | R-28 |
| ORG-03 | Titles and descriptions: caller value, then HTML metadata, then Workers AI when bound (switchable off) | P1 | R-19 |
| ORG-04 | QR code per site in the dashboard and viewer bar | P1 | R-22 |
| ORG-05 | Opt-in public gallery of the instance's public sites with a JSON feed | P2 | R-50 |
| ORG-06 | Dashboard version files: sort the loaded manifest by path, kind or exact byte size, ascending/descending, composed with the path filter; client-side only, default Path ascending | P1 | Done |

### 4.9 Agent surfaces (AX)

| ID | Feature | Pri | Status |
|---|---|---|---|
| AX-01 | REST API v1 and OpenAPI 3.1, generated from one operation registry | P0 | Done (R-02); legacy wire adapters preserved |
| AX-02 | Remote MCP server, Streamable HTTP, stateless, API-key auth, `core` toolset | P0 | R-06 |
| AX-03 | MCP: OAuth, every toolset, `?toolsets=`, read-only mode, single-site scope, resources, prompts, an MCP Apps site card | P1 | R-24, R-25 |
| AX-04 | CLI `npx kofra`: `publish --json --wait`, management commands, exit codes, `kofra api` escape hatch | P0 | R-09, R-10 |
| AX-05 | Local stdio MCP (`npx kofra mcp`) with local-path sources | P1 | R-26 |
| AX-06 | Discovery: `llms.txt` v2, a skill templated with the instance's own URLs, `/.well-known/agent-skills/index.json`, `/.well-known/api-catalog`, `/connect` | P0 | Partial (`llms.txt`, OpenAPI); R-11 |
| AX-07 | Error envelope with `code`, `hint`, `retryable`, `retryAfterSeconds`, `docs`, `next`, `details.fields` | P0 | Done (manifest and schema validation; legacy service validators retain stable codes) |
| AX-08 | `whoami` reports principal, instance, capabilities, limits and usage | P0 | R-17 policy/usage done; extended instance metadata in R-06 |
| AX-09 | `check_site`: broken links, missing assets, path-mode traps, optional screenshot | P1 | R-20 |
| AX-10 | `call_api` (any operation by method and path) and `search_docs` | P1 | R-25 |
| AX-11 | Code Mode endpoint `/mcp/code` (`search` + `execute` over the OpenAPI) | P2 | R-43 |
| AX-12 | Webhooks on site events, HMAC-signed | P2 | R-40 |
| AX-13 | Typed TypeScript client `@dropway/client` | P2 | R-45 |

### 4.10 Small apps without a backend (APP)

| ID | Feature | Pri | Status |
|---|---|---|---|
| APP-01 | Site Data: collections declared in `.dropway/data.json`, a browser API at `./.dropway/data/<collection>`, an owner API, per-action access rules and rate limits | P1 | R-30 |
| APP-02 | Variables: encrypted, write-only secrets, optionally pinned to upstream hostnames | P1 | R-31 |
| APP-03 | Proxy routes declared in `.dropway/proxy.json`: same-origin paths that inject variables server-side and stream the upstream response (SSE works) | P1 | R-31 |
| APP-04 | Per-site functions (Dynamic Workers) | P2 | R-48 |

### 4.11 Drives (DRV)

| ID | Feature | Pri | Status |
|---|---|---|---|
| DRV-01 | Private, versioned file stores for agent memory and hand-offs (`kind: "drive"` sites, never served publicly), conditional writes by sha256, atomic batches | P1 | R-32 |
| DRV-02 | Scoped share tokens = API keys limited to one drive, a path prefix, read or write, and an expiry; a pasteable share block for agent-to-agent hand-off | P1 | R-32 |
| DRV-03 | Publish a drive version as a site (server-side copy) | P1 | R-32 |

### 4.12 Domains (DOM)

| ID | Feature | Pri | Status |
|---|---|---|---|
| DOM-01 | Subdomain mode on a domain the operator owns (`SITES_DOMAIN` + wildcard route) | P0 | Done |
| DOM-02 | Custom domains per site: add, verify, mount a site at a path, primary-domain redirect (308) | P1 | R-33 |
| DOM-03 | Domain provisioning adapters: manual instructions (default) or the Cloudflare API with an operator token (Workers Custom Domains and routes on the operator's own zones) | P1 | R-33 |
| DOM-04 | Vanity names `<site>--<name>.<SITES_DOMAIN>` (single label, so Universal SSL covers them) | P2 | R-50 |

### 4.13 Analytics and background jobs (OBS)

| ID | Feature | Pri | Status |
|---|---|---|---|
| OBS-01 | Cookie-free analytics at the serving layer: views, approximate visitors, top paths, referrers, countries, crawlers (including AI crawlers), 404s | P1 | Partial (writes done); R-29 |
| OBS-02 | Daily rollups in D1 (beyond Analytics Engine's 3-month retention, and as a fallback when no Analytics Engine API token is configured) | P1 | R-29 |
| OBS-03 | Post-publish job pipeline on Queues, with job status visible to agents | P1 | R-19 |
| OBS-04 | Screenshots and Open Graph images per version (Browser Run) | P1 | R-20 |
| OBS-05 | Structured JSON logs; `/health` with build and version | P0 | Partial |

### 4.14 Collaboration (COL)

| ID | Feature | Pri | Status |
|---|---|---|---|
| COL-01 | Comments pinned to a page, an element and a version; agents list, reply to and resolve them | P2 | R-39 |
| COL-02 | Live reload (SRV-13) | P2 | R-41 |
| COL-03 | Webhooks (AX-12) | P2 | R-40 |

### 4.15 Operations and self-hosting (OPS)

| ID | Feature | Pri | Status |
|---|---|---|---|
| OPS-01 | Deploy to Cloudflare button: provisions D1, R2, KV and Analytics Engine, applies migrations, prompts for secrets | P0 | Done (fresh-account check in R-16) |
| OPS-02 | Hourly cleanup cron: expired anonymous sites, deleted sites, stale uploads, orphan blobs | P0 | Done |
| OPS-03 | Optional features switch off cleanly when their binding is absent and report it in `whoami.capabilities` | P0 | Done (R-17) |
| OPS-04 | Runtime instance settings (anonymous publish, limits) editable without a redeploy | P2 | R-42 |
| OPS-05 | Rate limits with `RateLimit-Policy` / `RateLimit` / `Retry-After` headers | P1 | R-36 |
| OPS-06 | Abuse reports, owner takedown, blocked-hash list | P1 | R-37 |
| OPS-07 | Upgrade by re-running the deploy (migrations first); restore D1 with Time Travel (30 days) | P0 | Done |
| OPS-08 | Versioned extension API, contract tests and a testing kit for embedding apps | P0/P1 | Version 3: operations and policy/usage contracts done; testing kit and future-point contracts R-18 |

### File deliveries

| ID | Capability | Priority | Status |
|---|---|---|---|
| XFR-01 | `create_transfer`: immutable files, up to 50 normalized recipient addresses, a plain-text message, password, expiry and optional download limit; general and per-recipient links | P1 | Implemented; deployment verification pending |
| XFR-02 | App-origin delivery/password pages; sites-host attachment-only downloads; 404 before 451 before 410 before password protection | P1 | Implemented; deployment verification pending |
| XFR-03 | Sender-only management, per-file/recipient counts, guarded updates and bulk revocation; same-call current-password proof and digest-bound unlock grants | P1 | Implemented; deployment verification pending |
| XFR-04 | Permanent sender-owned slug reservations; idempotent hourly expiry; holds fence purge, storage released once at purge | P1 | Implemented; deployment verification pending |

Delivery files cannot be replaced through site publishing, settings, access or
version operations. Create another transfer instead. A password is 8–1,024
characters without NUL; empty means no password. Expiry is one hour to the
instance ceiling (`TRANSFER_MAX_EXPIRY_DAYS`, default 30, at most 3,650 days),
further lowered by `PolicyAdapter.limits`. Download limits are 1–10,000.
Recipient addresses attribute links; they do not authenticate recipients or
prevent a recipient from forwarding a link. No email is sent by these operations.

A counted download is a served GET without a Range, or a range starting at zero.
Pages, HEAD, resumed ranges, invalid ranges and denied requests do not count.
Unlock cookies live only on the app host; the app renders short-lived signed
sites-host download links after unlock. Their grant is bound to the password
digest, is checked against live transfer state and never bypasses revocation,
takedown, expiry or limits. Query grants are bearer credentials for 15 minutes;
pages and downloads use no-store and no-referrer. Transfer metadata remains
readable to the sender after expiry/revocation. Byte references are purged after
24 hours closed, only while no hold/takedown is live. See `docs/errors.md` for
transfer errors.

### 4.16 Not in this edition

These are deliberately absent. Section 6 shows the generic extension points an embedding
application would use to add them without changing this repository.

- Sign-up for strangers, more than one tenant, workspaces spanning tenants.
- Plans, prices, billing, payment methods, invoices, credits, usage-based charges.
- Domain registration or resale.
- A hosted support desk (this edition links to the operator's contact and the GitHub issues).
- An in-dashboard AI editor (agents are the editor; they use the same API).

---

## 5. Architecture on Cloudflare

### 5.1 Picture

```
   agents: CLI, MCP, REST                         people: browsers
          |                                              |
   <app>  (app, /api/v1, /mcp, /oauth, docs)      <sites> (user content only)
          \                                              /
           +------------------ Worker -----------------+     one codebase, one or two deployments
           |  routeSiteRequest(): app | site | redirect  |     (a second deployment serves only <sites>)
           |  Hono app: REST, MCP, OAuth, dashboard       |
           |  serveSite(): access gates, viewers, bytes   |
           +---------------------------------------------+
   hot path (sites)              control plane (API, MCP)          async
   isolate memo (5 s)            D1: tenants, members, keys,       Queues: post-publish jobs
   Cache API: blob/<sha256>,         sites, versions, files,       (screenshots, AI metadata,
     render/<viewer>/<sha256>,       blobs, folders, access,        search index, moderation,
     ptr/<slug> (10 s)               domains, variables, jobs       webhooks, rollups)
   KV: live:<slug>, host:<name>  R2: blobs/<sha256>, thumbs/,      Cron: cleanup, rollups
   R2: blobs/<sha256>                uploads/ (multipart)           Durable Objects: Site Data,
   Analytics Engine write        KV: OAUTH_KV (OAuth grants)          live reload (P2)
```

### 5.2 Services and bindings

| Service | Used for | Binding | Required | When absent |
|---|---|---|---|---|
| Workers | Everything: app, API, MCP, serving, viewers | (the Worker) | yes | - |
| D1 | Source of truth for metadata; FTS5 search | `DB` | yes | - |
| R2 | File bytes, content-addressed (`blobs/<sha256>`); thumbnails; multipart staging | `FILES` | yes | - |
| KV | `live:<slug>` pointer cache; `host:<hostname>` domain map | `CACHE` | yes | - |
| Cache API | Per-data-center cache of blobs, rendered viewers, pointers | (runtime) | yes | - |
| Analytics Engine | Per-site hits | `ANALYTICS` | no | analytics reads fall back to D1 daily counters |
| Queues | Post-publish jobs, webhooks | `JOBS` (producer + consumer) | no (P1) | jobs run inline with `waitUntil`, best effort |
| Durable Objects (SQLite) | Site Data stores; strict rate limits; live reload (P2) | `SITE_DATA`, `LIVE` | no (P1) | Site Data reports `feature_unavailable` |
| KV for OAuth | Grants, tokens (hashed) for `workers-oauth-provider` | `OAUTH_KV` | no (P1) | MCP accepts API keys only |
| Workers AI | Titles and descriptions, Markdown conversion, moderation | `AI` | no | caller and HTML metadata only |
| Browser Run | Screenshots, OG images, `check_site` rendering | `BROWSER` | no | `check_site` runs static checks only |
| Email Service | Sign-in codes, restricted-site codes, invites | `EMAIL` | no | login links and API keys only |
| Turnstile | Anonymous browser uploads, public forms | `TURNSTILE_SECRET` (secret) | no | per-IP limits only |
| Rate Limiting binding | Burst limits per key and IP | `RATE_LIMITER` | no | D1 counters only |
| Workers Static Assets | Dashboard and viewer scripts under `/__dropway/assets/` | `ASSETS` | no (P1) | viewers that need scripts fall back to their no-script view |
| Dynamic Workers | Code Mode, per-site functions | `LOADER` | no (P2) | features absent |
| Cron Triggers | Cleanup (`17 * * * *`), daily rollups | (config) | yes | - |

Notes that shape the design:

- **User content lives in R2, not in Workers Static Assets.** Static assets are frozen per deploy and
  free only when no Worker code runs first; we need code in front of every site anyway (gates, viewers,
  analytics). Static assets are used only for our own dashboard and viewer scripts, with
  `run_worker_first` excluding just `/__dropway/assets/*`.
- **Worker size.** The Free plan caps a Worker at 3 MB compressed (Paid: 10 MB). Heavy viewer libraries
  (Mermaid, KaTeX, a 3D viewer) are served as static assets and loaded by the browser, never bundled.
- **CPU.** The Free plan allows 10 ms CPU per request, which breaks zip extraction and large renders.
  Self-host docs recommend Workers Paid; rendered output is cached by sha256 so each file renders once per
  data center.

### 5.3 Request routing

`routeSiteRequest()` (`packages/server/src/route-sites.ts`) decides, with no I/O for the common case:

| Request | Result |
|---|---|
| Host `<slug>.<SITES_DOMAIN>` (subdomain mode) | site `<slug>` |
| Host `<slug>--v<N>.<SITES_DOMAIN>` | version preview of `<slug>` (R-13) |
| Host in the custom-domain map (`resolveHost`) | the mounted site (R-33) |
| `<SITES_ORIGIN>/<slug>/...` (path mode, dedicated sites origin) | site `<slug>` |
| `<SITES_ORIGIN>/<slug>--v<N>/...` | version preview (R-13) |
| `<app>/s/<slug>/...` (path mode on the app origin) | site `<slug>`, always sandboxed |
| Root-absolute path with a same-origin `Referer` inside site X | `307` to X's URL if X has that path, or X is an SPA and this is a navigation |
| Anything else on `<app>` | the Hono app: `/api/v1/*`, `/mcp`, `/oauth/*`, pages |

### 5.4 Serving hot path (R-14)

1. Route by host and path (no I/O).
2. Live pointer `slug -> { siteId, versionId, settings, access }`: isolate memo (5 s) -> Cache API
   `ptr/<slug>` (10 s) -> KV `live:<slug>` (`cacheTtl` 30 s) -> D1.
3. Manifest `versionId -> { path: [sha256, size, type] }`: immutable, cached forever (isolate LRU ->
   Cache API -> D1; R2 `manifests/<versionId>.json` when D1 grows, section 7.5).
4. Bytes: Cache API `blob/<sha256>` (immutable) -> R2 `blobs/<sha256>` on a miss. Range requests and
   files above about 25 MB stream from R2 and skip the Cache API.
5. Rendered viewers: Cache API `render/<viewer>@<viewerVersion>/<sha256>`.
6. One Analytics Engine data point per top-level view, 404 or bot hit, written without awaiting.

Because bytes are addressed by hash, a publish never purges a cache: it only moves the pointer.
Freshness: the live URL shows a new version within about 60 s worldwide (KV propagation); the version
URL in the publish response is correct at once; `X-Kofra-Version` on every site response lets the CLI's
`--wait` confirm. A later experiment (R-44) reads the pointer from D1 read replicas behind the 10 s memo.

### 5.5 Upload protocol

1. `POST /api/v1/publish` (or `POST /api/v1/sites/{site}/versions`) with `files[]`. The server validates
   paths and limits, creates a `pending` version and computes **missing** = hashes the caller's tenant
   (or anonymous claim) has not proven it holds. Response: `status`, `upload.items[]` (missing only, each
   with `url`, `headers`, `curl`), `upload.expiresAt` (1 hour), `versionUrl`.
2. Upload each missing blob: `PUT <app>/api/v1/blobs/<sha256>` with `Authorization: Bearer dwu_...`
   (upload token) or the caller's key. The Worker streams into
   `R2.put("blobs/<sha256>", body, { sha256 })`; R2 rejects bytes that do not match the hash. Bytes that
   already exist physically are verified and not rewritten. Files above about 95 MB use multipart (R-35).
3. `POST .../versions/{version}/finalize`: check every hash, then flip the pointer with a conditional
   `UPDATE sites SET current_version_id = ? WHERE id = ? AND current_version_id IS ?` (the last value is
   `baseVersionId` when given; zero rows changed = `409 version_conflict`). Refresh KV, enqueue jobs,
   return URLs. A repeated finalize returns the same result (`already_live`).
4. Inline, URL and copy sources skip steps 2-3: the server stores the bytes and finalizes in the same call.

### 5.6 Background jobs (R-19)

Producer: finalize enqueues `{ kind, siteId, versionId }` messages on `JOBS`. Consumer (same Worker,
batch 10, retries 3, dead-letter queue `dropway-jobs-dlq`). Kinds: `metadata`, `screenshot`, `index`,
`webhook`, `rollup`. There is no `scan` kind: Kofra never scans file contents (owner decision
2026-10-22). Each job writes a `jobs` row so agents can poll `get_version` for
`jobs: { screenshot: "done", ... }`. Without a Queue binding the same handlers run in `waitUntil`.

---

## 6. Packages and extension points

### 6.1 Layout

```
wrangler.jsonc            Self-host config (repo root on purpose: the Deploy button treats the chosen
                          folder as the whole repo)
apps/worker               The single-tenant Worker: createDropway() with defaults
packages/core             @dropway/core   service layer: storage, publish protocol, versions, manifests,
                                          file-type detection, auth interfaces, tenant services, migrations
packages/server           @dropway/server createDropway(): Hono app factory, operation registry, REST, MCP,
                                          serving, viewers, dashboard, Durable Object classes, testing kit
packages/cli              kofra         CLI and local stdio MCP (npm package "kofra")
packages/client (R-45)    @dropway/client typed REST client generated from the registry
```

Rules:

- Dependencies point one way: `apps/*` -> `@dropway/server` -> `@dropway/core`. Nothing in this repo
  imports an embedding application, and embedding applications import only package names
  (`@dropway/server`, `@dropway/core`, documented subpaths). Deep imports are blocked by `exports` maps.
- Packages export TypeScript source; wrangler/esbuild bundles it. No build step.
- Public extension points name **capabilities** and **events**, never plans or prices.
- Any breaking change to anything in this section bumps `EXTENSION_API_VERSION` and gets a changelog entry.

### 6.2 `createDropway(options)`

Existing fields are marked `// exists`; the rest are planned, with the roadmap item.

```ts
import { createDropway } from "@dropway/server";

export interface CreateDropwayOptions {
  config?: ConfigOverrides | ((env: ServerBindings) => ConfigOverrides);           // exists
  adapters?: Partial<DropwayAdapters>;                                              // exists (identity, policy, metering)
  hooks?: DropwayHooks | DropwayHooks[];                                            // exists
  apiMiddleware?: MiddlewareHandler<DropwayEnv>[];                                  // exists
  routes?: RouteExtension[];                                                        // exists; R-18 adds OpenAPI fragments
  operations?: OperationDefinition[];                                               // R-02: typed operations -> REST + MCP + OpenAPI + CLI
  mcpTools?: McpToolDefinition[];                                                   // exists (prefer operations)
  mcp?: McpHandlerFactory;                                                          // exists; R-06 ships the default handler
  uiSlots?: Partial<UiSlots>;                                                       // exists; R-22 adds settingsSections, banner
  viewers?: Viewer[];                                                               // exists
  scheduled?: (dc: DropwayContext, controller: ScheduledController) => Promise<void>; // exists
  queues?: Record<string, QueueConsumer>;                                           // R-18
}

export interface Dropway {
  fetch(request: Request, env: ServerBindings, ctx: ExecutionContext): Promise<Response>;        // exists
  scheduled(controller: ScheduledController, env: ServerBindings, ctx: ExecutionContext): Promise<void>; // exists
  queue(batch: MessageBatch<unknown>, env: ServerBindings, ctx: ExecutionContext): Promise<void>; // R-18
  app: Hono<DropwayEnv>;                                                                          // exists
  operations: readonly OperationDefinition[];                                                     // R-02
  mcpTools: readonly McpToolDefinition[];                                                         // exists
  uiSlots: UiSlots; viewers: readonly Viewer[]; adapters: DropwayAdapters;                        // exists
  context(env: ServerBindings, ctx: Pick<ExecutionContext, "waitUntil">, requestUrl?: URL | null): DropwayContext; // exists
}

export const EXTENSION_API_VERSION: number;   // R-01, starts at 1
export type QueueConsumer = (batch: MessageBatch<unknown>, dc: DropwayContext) => Promise<void>;
```

The single-tenant entry stays three lines:

```ts
const dropway = createDropway();
export default { fetch: dropway.fetch, scheduled: dropway.scheduled, queue: dropway.queue } satisfies ExportedHandler<ServerBindings>;
export { SiteDataStore, LiveChannel } from "@dropway/server/durable-objects";   // R-30, R-41
```

### 6.3 Adapters

```ts
export interface DropwayAdapters {
  identity: IdentityAdapter;      // exists
  policy: PolicyAdapter;          // exists; extended below
  metering: MeteringAdapter;      // exists
  serving?: ServingAdapter;       // R-18
  email?: EmailAdapter;           // R-21 (default: Cloudflare Email Service when EMAIL is bound)
  domains?: DomainAdapter;        // R-33 (default: manual)
  moderation?: ModerationAdapter; // R-37 (default: heuristics for anonymous publishes)
}

/** Who is calling. Owns tenancy: a member principal names its tenant. (exists) */
export interface IdentityAdapter {
  resolve(request: Request, dc: DropwayContext): Promise<Principal>;
}

/** Limits and allow/deny decisions. Throw an ApiError to refuse. */
export interface PolicyAdapter {
  limits(principal: Principal, owner: SiteOwner, dc: DropwayContext): Limits | Promise<Limits>;          // exists
  beforeCreateSite?(principal: Principal, input: { slug: string | null; tenantId: string | null }, dc: DropwayContext): void | Promise<void>; // exists
  beforeDeploy?(principal: Principal, input: { siteId: string; tenantId: string | null; fileCount: number; totalBytes: number; newBytes: number }, dc: DropwayContext): void | Promise<void>; // exists; newBytes added in R-17
  /** R-17. Is this capability allowed for this caller? Core checks instance support first (binding present). */
  capability?(principal: Principal, capability: Capability, owner: SiteOwner | null, dc: DropwayContext): CapabilityDecision | Promise<CapabilityDecision>;
  /** R-17. Numeric quota for a resource. null = unlimited. Default: config.quotas[key] (admin-set). */
  quota?(principal: Principal, key: QuotaKey, owner: SiteOwner | null, dc: DropwayContext): number | null | Promise<number | null>;
  /** R-36. Rate rule for a bucket. Default: config.rateLimits[bucket]. */
  rateLimit?(principal: Principal, bucket: RateBucket, dc: DropwayContext): RateRule | null | Promise<RateRule | null>;
  /** R-17. Runs before every registry operation (after auth and validation, before the handler). */
  beforeOperation?(principal: Principal, op: OperationMeta, input: unknown, dc: DropwayContext): void | Promise<void>;
}

export type CapabilityDecision = { allowed: true } | { allowed: false; error: ApiError };

/** Closed list. Names describe product features, never commercial tiers. */
export const CAPABILITIES = [
  "anonymous_publish", "url_fetch", "large_uploads", "version_previews",
  "site_password", "site_restricted", "site_private", "share_links", "embed_allowlist",
  "custom_domains", "mounts", "vanity_names",
  "site_data", "variables", "proxy_routes", "drives", "functions",
  "analytics", "screenshots", "ai_metadata", "search", "comments", "webhooks",
  "code_mode", "members", "api_keys", "audit_log",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const QUOTA_KEYS = [
  "sites", "storage_bytes", "custom_domains", "members", "api_keys_per_member", "folders",
  "variables", "drives", "site_data_records_per_site", "share_links_per_site", "webhooks",
  "analytics_retention_days", "versions_per_site",
] as const;
export type QuotaKey = (typeof QUOTA_KEYS)[number];

export type RateBucket = "publish" | "read" | "anonymous_create" | "anonymous_request" | "url_fetch" | "screenshot" | "email" | "site_data_public_write" | "proxy";
export interface RateRule { limit: number; windowSeconds: number; burst?: { limit: number; windowSeconds: 10 | 60 } }

/** Usage events, recorded after the response (waitUntil). Default: no-op. (exists; new kinds in R-17) */
export interface MeteringAdapter { record(event: UsageEvent, dc: DropwayContext): void | Promise<void> }
export type UsageEvent =
  | { type: "deploy"; tenantId: string | null; siteId: string; versionId: string; fileCount: number; totalBytes: number; at: number } // exists
  | { type: "blob_upload"; tenantId: string | null; sha256: string; bytes: number; at: number }                                     // exists
  | { type: "site_request"; tenantId: string | null; siteId: string; status: number; bytes: number; at: number }                    // exists
  | { type: "site_created"; tenantId: string | null; siteId: string; anonymous: boolean; at: number }                               // exists
  | { type: "site_deleted"; tenantId: string | null; siteId: string; at: number }                                                    // exists
  | { type: "storage_snapshot"; tenantId: string; bytes: number; at: number }                                                         // R-17 (nightly)
  | { type: "job"; tenantId: string | null; kind: string; units: number; at: number }                                               // R-19
  | { type: "email_sent"; tenantId: string | null; kind: string; at: number }                                                        // R-21
  | { type: "fetch"; tenantId: string | null; bytes: number; at: number };                                                           // R-04

/** R-18. Hot-path hooks for serving. Must answer from memory or KV (no D1 on the hot path). */
export interface ServingAdapter {
  /** Map a host that is neither the app origin nor a SITES_DOMAIN subdomain to a site (custom domains). */
  resolveHost?(host: string, dc: DropwayContext): Promise<{ slug: string; mountPath: string; redirectTo?: string } | null>;
  /** Return a Response to short-circuit (owner suspended, takedown page, interstitial); null to continue. */
  beforeServe?(site: { id: string; slug: string; tenantId: string | null; versionId: string | null; anonymous: boolean }, request: Request, dc: DropwayContext): Promise<Response | null>;
}

/** R-21. Default: Cloudflare Email Service binding EMAIL when bound; otherwise features that need email report feature_unavailable. */
export interface EmailAdapter {
  send(message: { to: string[]; subject: string; text: string; html?: string; kind: "sign_in" | "site_access" | "invite" | "notice" }, dc: DropwayContext): Promise<{ id: string }>;
}

/** R-33. Default: "manual" (DNS and route instructions); "cloudflare_api" when CF_API_TOKEN and zones are configured. */
export interface DomainAdapter {
  add(hostname: string, dc: DropwayContext): Promise<DomainStatus>;
  check(hostname: string, dc: DropwayContext): Promise<DomainStatus>;
  remove(hostname: string, dc: DropwayContext): Promise<void>;
}
export interface DomainStatus {
  hostname: string; status: "pending" | "active" | "action_required" | "error";
  dns: { type: "CNAME" | "A" | "AAAA" | "TXT"; name: string; value: string }[];
  providerRef?: string; message?: string;
}

/** R-37. Default: cheap heuristics on anonymous publishes only. */
export interface ModerationAdapter {
  scanVersion(input: { siteId: string; versionId: string; anonymous: boolean; principal: Principal; files: { path: string; sha256: string; size: number; contentType: string }[] }, dc: DropwayContext): Promise<
    { action: "allow" } | { action: "hold"; reason: string; challengeUrl?: string } | { action: "block"; reason: string }>;
}
```

Core enforces capabilities and quotas at fixed points so an embedding application never wraps or
overrides core routes to gate a feature:

| Check | Where core calls it |
|---|---|
| `limits` | every publish, upload and finalize |
| `beforeCreateSite`, `quota("sites")` | site creation (publish, create, duplicate, claim) |
| `beforeDeploy`, `quota("storage_bytes")` | version creation, with `newBytes` = bytes the tenant does not already reference |
| `capability(...)` | the first line of each gated operation and of each gated serving feature |
| `quota(other keys)` | the create operation of that resource |
| `rateLimit(bucket)` | REST and MCP middleware, anonymous create, URL fetch, screenshots, public Site Data writes, proxy routes |
| `beforeOperation` | every registry operation |
| `serving.beforeServe` | every site request, after routing and before access gates |

Refusals use two codes: `feature_unavailable` (501; this instance lacks the binding or mode,
`details.requires`) and `limit_reached` (403 by default; an adapter may return any status and add
`details.upgradeUrl` or other links). Core never writes commercial wording into errors; hints come from
the adapter.

### 6.4 Hooks (after the response)

```ts
export interface DropwayHooks {
  onPublish?(event: PublishEvent, dc: DropwayContext): void | Promise<void>;     // exists ("deploy" | "restore")
  onDelete?(event: DeleteEvent, dc: DropwayContext): void | Promise<void>;       // exists ("api" | "expired")
  onRequest?(event: SiteRequestEvent, dc: DropwayContext): void | Promise<void>; // exists (every site request; keep cheap)
  onEvent?(event: DropwayEvent, dc: DropwayContext): void | Promise<void>;       // R-18: catch-all, same events webhooks use
}
export type DropwayEvent =
  | { type: "site.created" | "site.claimed" | "site.deleted" | "site.settings_changed" | "site.access_changed"; siteId: string; tenantId: string | null; actor: string; at: number }
  | { type: "version.published" | "version.restored" | "version.deleted"; siteId: string; versionId: string; actor: string; at: number }
  | { type: "member.added" | "member.removed" | "key.created" | "key.revoked"; tenantId: string; targetId: string; actor: string; at: number }
  | { type: "abuse.reported" | "site.taken_down"; siteId: string; at: number };
```

Hooks never block or fail a request; errors are logged. Use `PolicyAdapter` to refuse things.

### 6.5 Operation registry (R-02)

Every API operation is defined once. The registry generates the Hono route (with validation), the
OpenAPI operation, the MCP tool, the CLI command table (`GET /api/v1/operations`), `llms.txt` lines and
docs pages. Embedding apps add operations the same way, so their REST, MCP and docs stay consistent.

```ts
export interface OperationDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;                         // snake_case; = MCP tool name = OpenAPI operationId
  toolset: string;                    // "core", "sites", ... (section 9.2); new toolsets allowed
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;                       // "/api/v1/sites/{site}/versions"
  aliases?: { method: string; path: string }[];       // old paths kept working (e.g. /deploys)
  scopes: Scope[];                    // all required
  capability?: Capability;            // checked before the handler
  anonymous?: boolean;                // may run without credentials (publish only)
  summary: string;                    // <= 80 chars, verb first
  description: string;                // written for models: when to use, what returns, common mistake; <= 4,096 chars
  input: I; output: O;                // zod; flat objects (no oneOf) for model compatibility
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  mcp?: { alwaysLoad?: boolean } | { exclude: string /* reason */ };
  cli?: { command: string[]; positional?: string[] };
  confirm?: "slug" | "name" | "email" | "domain"; // destructive ops: MCP input requires confirm equal to this value
  rawBody?: boolean;                  // blob PUT, multipart publish: handler reads the Request; never an MCP tool
  examples?: { input: unknown; output: unknown }[];   // from test fixtures
  handler(input: z.infer<I>, ctx: OperationContext): Promise<z.infer<O>>;
}
export interface OperationContext {
  dw: DropwayContext; principal: Principal; request: Request;
  client: string | null;              // X-Kofra-Client or MCP clientInfo
  idempotencyKey: string | null;
}
```

CI rules (R-02): every operation has an MCP tool or an `exclude` reason; every tool has an output schema,
annotations and a description under 4,096 characters; `tools/list` order is stable; every error code a
handler can throw is in the error catalog.

### 6.6 Tenant services (R-18)

`@dropway/core` exports the only code that writes tenant rows, so an embedding app never writes SQL into
core tables:

```ts
createTenant(dc, { name }): Promise<TenantRow>                                         // exists
addMember(dc, tenantId, { email, name, role, externalRef }): Promise<MemberRow>       // exists as insertMember; renamed
mintApiKey(dc, member, { name, scopes, siteId?, pathPrefix?, expiresAt? }): Promise<{ key: string; row: ApiKeyRow }> // exists
suspendTenant(dc, tenantId, { reason }): Promise<void>     // sets disabled_at; sites answer 503 "unavailable" unless beforeServe answers
resumeTenant(dc, tenantId): Promise<void>
deleteTenant(dc, tenantId): Promise<{ sites: number }>     // soft-deletes sites; cron purges; blobs garbage-collected
recomputeUsage(dc, tenantId): Promise<UsageCounters>       // true-up of usage_counters
```

### 6.7 UI slots

```ts
export interface UiSlots {
  navItems: NavItem[];                                       // exists
  pages: UiPage[];                                           // exists
  landing?: (c: Context<DropwayEnv>) => Response | Promise<Response>; // exists
  headHtml?: string;                                         // exists
  settingsSections?: UiSection[];                            // R-22: extra sections on the settings page
  banner?: (c: Context<DropwayEnv>) => Promise<string | null>;        // R-22: one-line notice above every dashboard page
}
```

Dashboard pages use `APP_PAGE_CSP` or stricter and never render user content on the app origin.

### 6.8 Viewers (exists)

`Viewer { id, maxBytes, matches(file, live), render(vc) }`; extra viewers passed in `options.viewers`
run before core viewers. Section 10 lists core viewers.

### 6.9 Testing kit and contract (R-01 done, R-18 remaining)

- `@dropway/server` exports `EXTENSION_API_VERSION = 4`; extension API changes update that value and
  the Extension API section in `CHANGELOG.md`.
- `test/extension-contract.test.ts` builds `createDropway()` with fake adapters and exercises every
  existing point: identity and scopes, policy limits and refusals, all five metering event kinds,
  all three hooks, API middleware, a route override, an app route, contexts, MCP tools and endpoint
  replacement, UI slots, a viewer and `scheduled`. Public CI catches breakage without any private code.
- Future contracts arrive with their features: operations (R-02), capability denial, quota and rate
  rules (R-17/R-36), `queue`, `beforeServe`, `resolveHost` and the testing kit (R-18).
- `@dropway/server/testing` exports `createTestDropway(options)`, `seedTenant()`, `seedSite()`,
  `publishFixture()`, and the Miniflare bindings needed by `@cloudflare/vitest-plugin`.

---

## 7. Data model

### 7.1 Where data lives

| Store | Keys and contents |
|---|---|
| D1 `DB` | All metadata (tables below). Times are unix epoch milliseconds |
| R2 `FILES` | `blobs/<sha256>` file bytes (never overwritten); `thumbs/<versionId>.webp`, `og/<versionId>.png` (R-20); `uploads/<uploadId>/<part>` multipart staging (R-35, lifecycle 1 day); `manifests/<versionId>.json` (R-44) |
| KV `CACHE` | `live:<slug>` live pointer and manifest (exists); `host:<hostname>` mount map (R-33); `settings:instance` (R-42) |
| KV `OAUTH_KV` | OAuth clients, grants and hashed tokens, owned by `workers-oauth-provider` (R-24) |
| Durable Object `SITE_DATA` | One SQLite store per site with Site Data records (R-30) |
| Durable Object `LIVE` | One per site; hibernating WebSockets for live reload (R-41) |
| Analytics Engine `ANALYTICS` | Dataset `dropway_hits`, one point per view, 404 or bot hit |

### 7.2 Existing schema (`packages/core/migrations/0001_init.sql`, source of truth)

| Table | Purpose and key columns |
|---|---|
| `tenants` | `id`, `name`, `disabled_at`. Exactly one row in this edition |
| `members` | `tenant_id`, `email`, `name`, `role` (owner/admin/member), `external_ref` (outer identity system), `disabled_at` |
| `api_keys` | `key_hash` (SHA-256), `prefix`, `scopes` (space-separated), `site_id` restriction, `expires_at`, `revoked_at`, `last_used_at` |
| `folders` | `tenant_id`, `name` (unique per tenant, case-insensitive) |
| `sites` | `slug` (unique), `tenant_id` (NULL = anonymous), `folder_id`, `title`, `description`, `spa`, `render_markdown`, `cross_origin_isolation`, `password_hash`, `current_version_id`, `claim_token_hash`, `creator_ip_hash`, `expires_at`, `deleted_at`, `deleted_slug` |
| `versions` | `site_id`, `number`, `status` (pending/ready), `file_count`, `total_bytes`, `manifest_hash`, `base_version_id`, `source`, `client`, `message`, `created_by`, `finalized_at` |
| `version_files` | `(version_id, path)` -> `sha256`, `size`, `content_type` |
| `blobs` | `sha256` -> `size` |
| `blob_scopes` | `(scope, sha256)`: which tenant (`t:<id>`) or anonymous site (`s:<id>`) has proven it holds a blob; dedupe is answered only inside a scope |

### 7.3 Planned migrations

Never edit an applied migration. Each file below is one roadmap item's migration; numbers are assigned
in merge order.

```sql
-- 0005_publish_idempotency.sql (R-04; 0002-0004 already contain other features)
CREATE TABLE idempotency_keys (
  key_hash TEXT PRIMARY KEY,               -- hash of authorization identity, operation and key
  input_hash TEXT NOT NULL,                -- canonical JSON request hash
  owner_token TEXT NOT NULL,               -- fences completion/failure to the claim owner
  state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  result_json TEXT,
  expires_at INTEGER NOT NULL              -- 24-hour key lifetime
);
CREATE INDEX idempotency_keys_expires ON idempotency_keys(expires_at);

-- Remaining schema sketch below belongs to later roadmap items (R-05/R-17).
-- It is not part of migration 0005.

ALTER TABLE versions ADD COLUMN config_json TEXT;               -- parsed _redirects, _headers, .dropway/*.json
ALTER TABLE versions ADD COLUMN warnings_json TEXT;
ALTER TABLE versions ADD COLUMN restored_from_version_id TEXT;

ALTER TABLE sites ADD COLUMN kind TEXT NOT NULL DEFAULT 'site' CHECK (kind IN ('site', 'drive'));
ALTER TABLE sites ADD COLUMN noindex INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN viewers INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sites ADD COLUMN ttl_seconds INTEGER;               -- keyed-site TTL; expires_at recomputed at finalize
ALTER TABLE sites ADD COLUMN metadata_source TEXT;              -- caller | html | ai | fallback

ALTER TABLE api_keys ADD COLUMN path_prefix TEXT;               -- drive share tokens, file-scoped keys

-- New scope sites:delete: keys that could delete before keep that ability.
UPDATE api_keys SET scopes = scopes || ' sites:delete'
 WHERE (' ' || scopes || ' ') LIKE '% sites:write %' AND (' ' || scopes || ' ') NOT LIKE '% sites:delete %';

CREATE TABLE usage_counters (
  tenant_id   TEXT NOT NULL,
  key         TEXT NOT NULL,              -- a QuotaKey: sites | storage_bytes | custom_domains | ...
  value       INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, key)
) WITHOUT ROWID;
```

```sql
-- 0003_jobs_audit_abuse.sql (R-19, R-37, R-38, R-42)
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,             -- metadata | screenshot | index | webhook | rollup
  site_id      TEXT,
  version_id   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  result_json  TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX jobs_version ON jobs(version_id);
CREATE INDEX jobs_status ON jobs(status, updated_at);

CREATE TABLE audit_log (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT,
  actor         TEXT NOT NULL,            -- member:<id> | key:<id> | claim:<site id> | system
  action        TEXT NOT NULL,            -- operation id, e.g. delete_site
  target        TEXT,                     -- site:<id> | key:<id> | member:<id> | ...
  details_json  TEXT,                     -- never secrets
  client        TEXT,
  ip_hash       TEXT,
  at            INTEGER NOT NULL
);
CREATE INDEX audit_tenant ON audit_log(tenant_id, at);

CREATE TABLE abuse_reports (
  id                TEXT PRIMARY KEY,
  site_id           TEXT,
  url               TEXT NOT NULL,
  reason            TEXT NOT NULL CHECK (reason IN ('phishing', 'malware', 'spam', 'illegal', 'copyright', 'other')),
  details           TEXT,
  reporter_email    TEXT,
  reporter_ip_hash  TEXT,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at        INTEGER NOT NULL,
  handled_at        INTEGER,
  handled_by        TEXT
);
CREATE INDEX abuse_open ON abuse_reports(status, created_at);

CREATE TABLE blocked_hashes (
  sha256      TEXT PRIMARY KEY,           -- files that may never be published again on this instance
  reason      TEXT,
  created_at  INTEGER NOT NULL
) WITHOUT ROWID;

ALTER TABLE sites ADD COLUMN taken_down_at INTEGER;
ALTER TABLE sites ADD COLUMN taken_down_reason TEXT;

CREATE TABLE instance_settings (
  key         TEXT PRIMARY KEY,           -- anonymous_publish | limits | quotas | rate_limits | ai_metadata | ...
  value_json  TEXT NOT NULL,              -- overrides Worker vars at runtime
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);
```

```sql
-- 0004_sessions.sql (R-21)
CREATE TABLE sessions (
  id_hash       TEXT PRIMARY KEY,         -- SHA-256 of the cookie value
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  member_id     TEXT NOT NULL REFERENCES members(id),
  via           TEXT NOT NULL,            -- login_link | email_code | access | passkey
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  ip_hash       TEXT,
  user_agent    TEXT,
  revoked_at    INTEGER
);
CREATE INDEX sessions_member ON sessions(member_id);

CREATE TABLE login_links (
  token_hash  TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL REFERENCES members(id),
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,           -- 15 minutes
  used_at     INTEGER
);

CREATE TABLE email_codes (
  id          TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('sign_in', 'site_access')),
  email       TEXT NOT NULL,
  site_id     TEXT,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0, -- 5 wrong tries burns the code
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,           -- 15 minutes
  used_at     INTEGER
);
CREATE INDEX email_codes_lookup ON email_codes(email, purpose, created_at);

ALTER TABLE members ADD COLUMN last_seen_at INTEGER;
```

```sql
-- 0005_access.sql (R-23)
ALTER TABLE sites ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'public'
  CHECK (access_mode IN ('public', 'password', 'restricted', 'private'));
ALTER TABLE sites ADD COLUMN access_policy_version INTEGER NOT NULL DEFAULT 0; -- bump = every grant invalid
ALTER TABLE sites ADD COLUMN embed_origins TEXT;                                -- space-separated; NULL = default
UPDATE sites SET access_mode = 'password' WHERE password_hash IS NOT NULL;

CREATE TABLE site_access_lists (
  site_id     TEXT NOT NULL REFERENCES sites(id),
  kind        TEXT NOT NULL CHECK (kind IN ('email', 'domain')),
  value       TEXT NOT NULL,              -- lowercased
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (site_id, kind, value)
) WITHOUT ROWID;

CREATE TABLE share_links (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id),
  token_hash    TEXT NOT NULL UNIQUE,
  version_id    TEXT,                     -- pinned version, NULL = live
  label         TEXT,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  uses          INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER
);
CREATE INDEX share_links_site ON share_links(site_id, created_at);
```

```sql
-- 0006_search.sql (R-28)
CREATE VIRTUAL TABLE site_search USING fts5(
  site_id UNINDEXED, version_id UNINDEXED, slug, title, description, paths, body,
  tokenize = 'unicode61 remove_diacritics 2'
);
-- Note: `wrangler d1 export` does not support databases with virtual tables. Backups rely on D1 Time
-- Travel; the index can be dropped and rebuilt from R2 at any time (job kind "index").
```

```sql
-- 0007_analytics.sql (R-29)
CREATE TABLE analytics_daily (
  site_id     TEXT NOT NULL,
  day         TEXT NOT NULL,              -- YYYY-MM-DD UTC
  views       INTEGER NOT NULL DEFAULT 0,
  visitors    INTEGER,                    -- NULL when only D1 fallback counters exist
  not_found   INTEGER NOT NULL DEFAULT 0,
  bot_hits    INTEGER NOT NULL DEFAULT 0,
  top_json    TEXT,                       -- top paths, referrers, countries, crawlers
  PRIMARY KEY (site_id, day)
) WITHOUT ROWID;
```

```sql
-- 0008_variables.sql (R-31)
CREATE TABLE variables (
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  name               TEXT NOT NULL,       -- ^[A-Z][A-Z0-9_]{0,63}$
  ciphertext         TEXT NOT NULL,       -- AES-256-GCM, key derived from the VARIABLES_KEY secret
  iv                 TEXT NOT NULL,
  key_version        INTEGER NOT NULL DEFAULT 1,
  allowed_upstreams  TEXT,                -- space-separated hostnames; subdomains match
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, name)
) WITHOUT ROWID;
```

```sql
-- 0009_domains.sql (R-33)
CREATE TABLE domains (
  hostname           TEXT PRIMARY KEY,    -- lowercased, no trailing dot
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  status             TEXT NOT NULL CHECK (status IN ('pending', 'active', 'action_required', 'error')),
  provider           TEXT NOT NULL,       -- manual | cloudflare_api | <adapter id>
  provider_ref       TEXT,
  dns_json           TEXT,
  verification_json  TEXT,
  created_at         INTEGER NOT NULL,
  checked_at         INTEGER,
  activated_at       INTEGER
);
CREATE INDEX domains_tenant ON domains(tenant_id);

CREATE TABLE mounts (
  hostname    TEXT NOT NULL REFERENCES domains(hostname),
  path        TEXT NOT NULL,              -- "" = root, else "docs" (no leading or trailing slash)
  site_id     TEXT NOT NULL REFERENCES sites(id),
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (hostname, path)
) WITHOUT ROWID;
CREATE INDEX mounts_site ON mounts(site_id);

ALTER TABLE sites ADD COLUMN primary_hostname TEXT;   -- other addresses 308 to hostname + primary_path
ALTER TABLE sites ADD COLUMN primary_path TEXT;
```

```sql
-- 0010_collaboration.sql (R-39, R-40)
CREATE TABLE comments (
  id                   TEXT PRIMARY KEY,
  site_id              TEXT NOT NULL REFERENCES sites(id),
  version_id           TEXT NOT NULL,
  path                 TEXT NOT NULL,
  anchor_json          TEXT,              -- { selector, text, x, y }
  parent_id            TEXT,              -- replies
  author_kind          TEXT NOT NULL CHECK (author_kind IN ('visitor', 'member', 'agent')),
  author_name          TEXT,
  author_email         TEXT,
  author_ref           TEXT,              -- member or key id
  body                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at           INTEGER NOT NULL,
  resolved_at          INTEGER,
  resolved_by          TEXT,
  resolved_version_id  TEXT
);
CREATE INDEX comments_site ON comments(site_id, status, created_at);

CREATE TABLE webhooks (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  url                TEXT NOT NULL,       -- https only, public addresses only
  events             TEXT NOT NULL,       -- space-separated DropwayEvent types
  site_id            TEXT,                -- NULL = every site
  secret_ciphertext  TEXT NOT NULL,       -- HMAC signing secret, encrypted like variables
  secret_iv          TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  disabled_at        INTEGER,
  last_status        INTEGER,
  failures           INTEGER NOT NULL DEFAULT 0
);
```

Site Data store (inside each `SiteDataStore` Durable Object, R-30):

```sql
CREATE TABLE records (
  collection  TEXT NOT NULL,
  id          TEXT NOT NULL,
  data        TEXT NOT NULL,             -- JSON, <= 16 KB, validated against the version's .dropway/data.json
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  created_by  TEXT,                      -- public:<ip hash> | member:<id> | key:<id>
  deleted_at  INTEGER,
  PRIMARY KEY (collection, id)
);
CREATE TABLE idempotency (key TEXT PRIMARY KEY, record_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE rate (bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
```

### 7.4 Analytics Engine data point (R-29)

`index1` = site id. Blobs: kind (`view` | `asset` | `not_found` | `bot`), path, referrer host, country,
crawler name, status class, version id, tenant id, visitor hash (daily salted hash of IP and user agent;
never the raw IP). Doubles: 1, bytes, milliseconds. One point per HTML navigation, 404 and bot hit; assets
are sampled, not written one by one. Reads use the SQL API when the operator sets `CF_ACCOUNT_ID` and an
`ANALYTICS_API_TOKEN` secret; otherwise reads use `analytics_daily`.

### 7.5 Growth and retention

- D1 has a hard 10 GB cap per database. `version_files` grows with versions x files. When the database
  passes about 2 GB, R-44 moves file lists to immutable `manifests/<versionId>.json` in R2 and keeps only
  blob reference counts in D1.
- Deleted sites are soft-deleted (`deleted_at`), purged by the hourly cron after 24 h; blobs no scope
  references are deleted after a grace period.
- Anonymous sites are deleted at `expires_at`.
- Idempotency keys 24 h; email codes and login links 15 min; jobs 30 days; audit log kept unless the
  admin sets a retention.

---

## 8. REST API

### 8.1 Conventions

- Base `<app>/api/v1`. JSON in and out (except blob uploads and one-shot publish bodies).
- Auth: `Authorization: Bearer <credential>`. Credentials: API key `dw_...`, OAuth access token,
  claim token `dwc_...` (one anonymous site), upload token `dwu_...` (blob uploads of one pending version),
  session cookie (dashboard only, with Origin checks). None: anonymous publish when enabled.
- Path parameters: `{site}` = slug or site id; `{version}` = `live`, `v12`, `12` or a version id;
  `{path}` = file path with segments percent-encoded.
- Pagination: `?limit=` (1-200, default 50) and `?cursor=`; responses carry `nextCursor`.
- `Idempotency-Key` header on every POST that creates something (24 h; same key + different body =
  `422 idempotency_key_reused`; still running = `409 idempotency_in_progress`, retryable).
- `X-Kofra-Client: <harness>/<detail>` (attribution). `X-Request-Id` on every response.
- Rate limits (R-36): `RateLimit-Policy` and `RateLimit` headers (IETF draft format), `Retry-After` on 429/503.
- URLs in responses: `url` (live), `versionUrl` (exact version), per file `url`, `viewUrl`, `rawUrl`,
  `downloadUrl`. Clients must use them as returned.
- Errors:

```json
{
  "error": {
    "code": "version_conflict",
    "message": "The live version is v8 (published 2 minutes ago by codex), not v7.",
    "hint": "Call get_site, re-apply your change on top of v8 with update_site_files and baseVersionId v8.",
    "retryable": false,
    "retryAfterSeconds": null,
    "docs": "<app>/docs/errors#version_conflict",
    "details": { "liveVersionId": "ver_...", "liveVersionNumber": 8, "yourBase": 7 },
    "next": [{ "tool": "get_site", "args": { "site": "bright-otter-x7k2" }, "why": "see what changed" }]
  },
  "requestId": "8d3c2f1a9b..."
}
```

R-03 adds `retryable`, `retryAfterSeconds`, `docs` and `next` while preserving the existing fields.
Manifest and operation-schema validation collect bad fields in `details.fields`; source validation
also uses this collection. MCP field paths use dots for identifier/numeric segments and JSON-quoted
brackets for other property names: literal `a.b` is `["a.b"]`, distinct from nested `a.b`;
`items.0["x/y"]` identifies a literal slash in a key. Missing required/dependency keys use the
same notation. Legacy semantic service validators retain their stable error codes.
Version conflicts include `liveVersionId`, `liveVersionNumber`, `liveVersionClient` and
`liveVersionAt` (publication time in epoch milliseconds). HTTP 429/503 always send `Retry-After`,
matching the envelope delay (one second when omitted). `/docs/errors` and `/docs/errors.md` are
generated from `packages/core/src/error-codes.ts`; `npm run errors:sync` updates the repository copy.
Codes are stable forever.

### 8.2 Endpoints

`Tool` is the operationId and MCP tool name (`-` = REST only, with the reason in the registry).

**Discovery, setup, instance**

| Method | Path | Tool | Scope | Pri | Status |
|---|---|---|---|---|---|
| GET | `/api/v1` | - (index) | none | P0 | Done |
| GET | `/api/v1/me` | `whoami` | any | P0 | Done (capabilities, limits, usage in R-06/R-17) |
| GET | `/api/v1/operations` | - (CLI command table) | none | P0 | R-02 |
| GET | `/api/v1/skill/version` | - | none | P0 | R-11 |
| POST | `/api/v1/setup` | - (bootstrap key only) | bootstrap | P0 | Done |
| POST | `/api/v1/setup/recover` | - (bootstrap key only) | bootstrap | P0 | Done |
| GET | `/api/v1/instance` | `get_instance_settings` | admin | P2 | R-42 |
| PATCH | `/api/v1/instance` | `update_instance_settings` | admin | P2 | R-42 |
| GET | `/api/v1/docs/search?q=` | `search_docs` | none | P1 | R-25 |

**Publishing, files, uploads**

| Method | Path | Tool | Scope | Pri | Status |
|---|---|---|---|---|---|
| POST | `/api/v1/publish` | `publish_site` | `sites:write`, or none when anonymous is on | P0 | Partial (multipart, zip, raw, inline done; other sources R-04) |
| PATCH | `/api/v1/sites/{site}/files` | `update_site_files` | `sites:write` | P0 | R-05 |
| GET | `/api/v1/sites/{site}/files` | `list_files` | `sites:read` | P0 | Done |
| GET, HEAD | `/api/v1/sites/{site}/files/{path}` | `read_file` | `sites:read` | P0 | Done (`as=markdown`, ranges in R-25/R-34) |
| PUT | `/api/v1/blobs/{sha256}` | - (raw bytes) | `sites:write`, claim or upload token | P0 | Done (upload token R-04) |
| POST | `/api/v1/uploads` | - (multipart start) | `sites:write` or upload token | P1 | R-35 |
| PUT | `/api/v1/uploads/{id}/parts/{n}` | - | same | P1 | R-35 |
| POST | `/api/v1/uploads/{id}/complete` | - | same | P1 | R-35 |
| POST | `/api/v1/sites/{site}/check` | `check_site` | `sites:read` | P1 | R-20 |

**Sites**

| Method | Path | Tool | Scope | Pri | Status |
|---|---|---|---|---|---|
| POST | `/api/v1/sites` | `create_site` | `sites:write` | P1 | Done (tool R-25) |
| GET | `/api/v1/sites` | `list_sites` | `sites:read` | P0 | Done (`query`, `folder`, `kind`, `sort` in R-28) |
| GET | `/api/v1/sites/{site}` | `get_site` | `sites:read` | P0 | Done |
| PATCH | `/api/v1/sites/{site}` | `update_site_settings` | `sites:write` | P0 | Done (more settings R-27) |
| DELETE | `/api/v1/sites/{site}` | `delete_site` | `sites:delete` | P0 | Done (scope R-17; freed name held per R-59) |
| POST | `/api/v1/sites/{site}/claim` | `claim_site` | `sites:write` | P0 | Done |
| POST | `/api/v1/sites/{site}/duplicate` | `duplicate_site` | `sites:write` | P1 | Done |
| POST | `/api/v1/sites/{site}/rename` | `rename_site` | `sites:write` | P2 | Done (R-59: old name 308s + redirectUntil; vanity and gallery stay R-50) |

**Versions**

| Method | Path | Tool | Scope | Pri | Status |
|---|---|---|---|---|---|
| POST | `/api/v1/sites/{site}/versions` (alias `/deploys`) | - (`publish_site` covers it) | `sites:write` | P0 | Done as `/deploys` |
| GET | `/api/v1/sites/{site}/versions` | `list_versions` | `sites:read` | P0 | Done |
| GET | `/api/v1/sites/{site}/versions/{version}` | `get_version` | `sites:read` | P0 | Partial (`/deploys/{id}`); R-05 |
| POST | `/api/v1/sites/{site}/versions/{version}/finalize` | `finalize_version` | `sites:write` | P0 | Done as `/deploys/{id}/finalize` |
| POST | `/api/v1/sites/{site}/versions/{version}/restore` | `restore_version` | `sites:write` | P0 | Done |
| DELETE | `/api/v1/sites/{site}/versions/{version}` | `delete_version` | `sites:delete` | P1 | Done |
| GET | `/api/v1/sites/{site}/diff?from=&to=` | `diff_versions` | `sites:read` | P1 | R-20 |

**Access and sharing**

| Method | Path | Tool | Scope | Pri | Status |
|---|---|---|---|---|---|
| GET | `/api/v1/sites/{site}/access` | - (`get_site` full shows it) | `sites:read` | P1 | R-23 |
| PUT | `/api/v1/sites/{site}/access` | `set_site_access` | `sites:write` | P0 (public, password) / P1 | Partial (password via PATCH); R-23 |
| POST | `/api/v1/sites/{site}/access/invites` | `send_access_invites` | `sites:write` | P1 | R-23 |
| GET | `/api/v1/sites/{site}/share-links` | `list_share_links` | `sites:read` | P1 | R-23 |
| POST | `/api/v1/sites/{site}/share-links` | `create_share_link` | `sites:write` | P1 | R-23 |
| DELETE | `/api/v1/sites/{site}/share-links/{id}` | `revoke_share_link` | `sites:write` | P1 | R-23 |

**Folders**

| Method | Path | Tool | Scope | Pri | Status |
|---|---|---|---|---|---|
| GET | `/api/v1/folders` | `list_folders` | `sites:read` | P1 | R-28 |
| POST | `/api/v1/folders` | `create_folder` | `sites:write` | P1 | R-28 |
| PATCH | `/api/v1/folders/{folder}` | `rename_folder` | `sites:write` | P1 | R-28 |
| DELETE | `/api/v1/folders/{folder}` | `delete_folder` | `sites:delete` | P1 | Done (delete only; organizer operations R-28) |

**Keys, members, sign-in**

| Method | Path | Tool | Scope | Pri | Status |
|---|---|---|---|---|---|
| GET | `/api/v1/keys` | `list_api_keys` | `keys:write` | P0 | Done |
| POST | `/api/v1/keys` | `create_api_key` | `keys:write` | P0 | Done (path prefix R-32) |
| DELETE | `/api/v1/keys/{id}` | `revoke_api_key` | `keys:write` | P0 | Done |
| GET | `/api/v1/members` | `list_members` | `members:write` | P1 | Done |
| POST | `/api/v1/members` | `add_member` | `members:write` | P1 | Done |
| PATCH | `/api/v1/members/{id}` | `update_member` | `members:write` | P1 | Done |
| DELETE | `/api/v1/members/{id}` | `remove_member` | `members:write` | P1 | Done |
| POST | `/api/v1/login-links` | `create_login_link` | `members:write` (or self) | P1 | R-21 |
| POST | `/api/v1/auth/email-code` | - (browser flow) | none | P1 | R-21 |
| POST | `/api/v1/auth/email-code/verify` | - | none | P1 | R-21 |
| POST | `/api/v1/auth/logout` | - | session | P1 | R-21 |

**Domains and mounts**

| Method | Path | Tool | Scope | Pri | Status |
|---|---|---|---|---|---|
| GET | `/api/v1/domains` | `list_domains` | `admin` | P1 | R-33 |
| POST | `/api/v1/domains` | `add_domain` | `admin` | P1 | R-33 |
| GET | `/api/v1/domains/{domain}` | `get_domain` (re-checks) | `admin` | P1 | R-33 |
| DELETE | `/api/v1/domains/{domain}` | `remove_domain` | `admin` | P1 | R-33 |
| PUT | `/api/v1/sites/{site}/primary-domain` | `set_primary_domain` | `sites:write` | P1 | R-33 |
| GET | `/api/v1/mounts` | `list_mounts` | `sites:read` | P1 | R-33 |
| PUT | `/api/v1/mounts` | `mount_site` | `sites:write` | P1 | R-33 |
| DELETE | `/api/v1/mounts` | `unmount_site` | `sites:write` | P1 | R-33 |

**Site Data, variables, analytics**

| Method | Path | Tool | Scope | Pri | Status |
|---|---|---|---|---|---|
| GET | `/api/v1/sites/{site}/data/{collection}` | `list_records` | `sites:read` | P1 | R-30 |
| POST | `/api/v1/sites/{site}/data/{collection}` | `write_record` | `data:write` | P1 | R-30 |
| GET | `/api/v1/sites/{site}/data/{collection}/{id}` | `get_record` | `sites:read` | P1 | R-30 |
| PUT, PATCH | `/api/v1/sites/{site}/data/{collection}/{id}` | `write_record` | `data:write` | P1 | R-30 |
| DELETE | `/api/v1/sites/{site}/data/{collection}/{id}` | `delete_record` | `data:write` | P1 | R-30 |
| GET | `/api/v1/variables` | `list_variables` | `secrets:write` | P1 | R-31 |
| PUT | `/api/v1/variables/{name}` | `set_variable` | `secrets:write` | P1 | R-31 |
| DELETE | `/api/v1/variables/{name}` | `delete_variable` | `secrets:write` | P1 | R-31 |
| GET | `/api/v1/analytics?range=` | `get_analytics` | `sites:read` | P1 | R-29 |
| GET | `/api/v1/sites/{site}/analytics?range=` | `get_analytics` | `sites:read` | P1 | R-29 |

**Collaboration, operations**

| Method | Path | Tool | Scope | Pri | Status |
|---|---|---|---|---|---|
| GET | `/api/v1/sites/{site}/comments` | `list_comments` | `sites:read` | P2 | R-39 |
| POST | `/api/v1/sites/{site}/comments` | - (viewer widget; visitors) | none or session | P2 | R-39 |
| POST | `/api/v1/sites/{site}/comments/{id}/replies` | `reply_to_comment` | `sites:write` | P2 | R-39 |
| POST | `/api/v1/sites/{site}/comments/{id}/resolve` | `resolve_comment` | `sites:write` | P2 | R-39 |
| GET | `/api/v1/webhooks` | `list_webhooks` | `admin` | P2 | R-40 |
| POST | `/api/v1/webhooks` | `create_webhook` | `admin` | P2 | R-40 |
| DELETE | `/api/v1/webhooks/{id}` | `delete_webhook` | `admin` | P2 | R-40 |
| POST | `/api/v1/abuse-reports` | - (public form, rate limited) | none | P1 | R-37 |
| GET | `/api/v1/abuse-reports` | - | `admin` | P1 | R-37 |
| POST | `/api/v1/sites/{site}/takedown` | - | `admin` | P1 | R-37 |
| GET | `/api/v1/audit` | `list_audit_events` | `admin` | P2 | R-38 |

### 8.3 Routes outside `/api/v1`

App origin:

| Route | Purpose | Pri | Status |
|---|---|---|---|
| `/` | Landing (or `uiSlots.landing`); first-run setup form when not set up (R-16) | P0 | Done |
| `/health` | `{ ok, service, version, build }` | P0 | Done |
| `/openapi.json` | OpenAPI 3.1 for this instance (servers = its own origin) | P0 | Done |
| `/llms.txt`, `/llms-full.txt`, `/docs/*.md` | Agent docs (llms.txt v2; `Link: rel="describedby"` headers) | P0 / P1 | Partial; R-11 |
| `/skill.md`, `/.well-known/agent-skills/index.json` (+ legacy `/.well-known/skills/index.json`) | Skill templated with this instance's URLs; `npx skills add <app>` works | P0 | R-11 |
| `/.well-known/api-catalog` | RFC 9727 linkset to OpenAPI, docs, MCP | P0 | R-11 |
| `/connect`, `/connect.md` | Copy-paste setup per agent client | P0 | R-11 |
| `/robots.txt` | App crawler policy | P0 | R-11 |
| `/claim` | Claim page (token in fragment) | P0 | Done |
| `/mcp` | Remote MCP (section 9) | P0 | R-06 (501 today) |
| `/mcp/server-card`, `/mcp/code` | MCP server card; Code Mode | P1 / P2 | R-25 / R-43 |
| `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/device` | OAuth 2.1 | P1 | R-24 |
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp` | OAuth discovery | P1 | R-24 |
| `/login`, `/dashboard/*`, `/view/{site}/{path}` | Dashboard and viewer page | P1 | R-21, R-22 |
| `/cli/dropway.tgz` | The CLI tarball for `npx -y --package=<app>/cli/dropway.tgz dropway`, for instances whose users cannot reach npm | P1 | R-09 |

Sites origin:

| Route | Purpose | Pri | Status |
|---|---|---|---|
| `/<slug>/<path>` or `https://<slug>.<SITES_DOMAIN>/<path>` | The site; `?raw=1`, `?download=1`, `?view=1`, `?view=source` | P0 | Done (view modes R-07) |
| `/<slug>--v<N>/<path>` or `<slug>--v<N>.<SITES_DOMAIN>` | Version preview | P0 | R-13 |
| `<site>/__dropway/password` | Password form post | P0 | Done |
| `<site>/__dropway/access`, `<site>/__dropway/share/<token>` | Restricted-site sign-in, share-link entry | P1 | R-23 |
| `<site>/.dropway/data/<collection>[/<id>]` | Site Data browser API | P1 | R-30 |
| any path declared in `.dropway/proxy.json` | Proxy route | P1 | R-31 |
| `/__dropway/assets/<hash>.<ext>` | Our viewer scripts and styles (static assets) | P1 | R-34 |
| `/__dropway/report` | Abuse report form | P1 | R-37 |

Reserved: slugs never contain `--` and never match the reserved list; file paths under `__dropway/` are
rejected at publish; files under `.dropway/` are stored but never served.

### 8.4 Error codes

Initial catalog (R-03 makes it complete and generates `/docs/errors.md`):

| Code | HTTP | Retryable | Meaning, typical hint |
|---|---|---|---|
| `invalid_json`, `invalid_request` | 400 | no | Fix the fields listed in `details.fields` |
| `files_required`, `invalid_path`, `duplicate_path`, `invalid_sha256`, `invalid_slug`, `slug_reserved` | 400 | no | Input shape problems, each with an example fix |
| `hash_mismatch`, `size_mismatch` | 400 | no | Bytes do not match the declared hash or size; re-read the file, do not re-encode it |
| `length_required` | 411 | no | Send `Content-Length` with raw bytes |
| `inline_too_large`, `file_too_large`, `site_too_large`, `request_too_large` | 413 | no | Over a cap; the hint names the right upload path |
| `too_many_files` | 400 | no | Over the file cap; remove source maps or duplicates, never drop files silently |
| `fetch_failed`, `fetch_blocked` | 422 | upstream 5xx only | URL source problems |
| `unauthorized`, `invalid_api_key`, `key_expired` | 401 | no | Credential problems |
| `insufficient_scope`, `scope_not_grantable`, `forbidden` | 403 | no | Permission problems |
| `site_not_found`, `version_not_found`, `file_not_found`, `folder_not_found`, `route_not_found` | 404 | no | The hint names the list call |
| `slug_taken`, `version_conflict`, `version_is_live`, `missing_blobs`, `already_claimed` | 409 | no | Conflicts, with details and `next` |
| `idempotency_in_progress` | 409 | yes | Retry in a second |
| `idempotency_key_reused` | 422 | no | Same key, different request |
| `upload_expired`, `site_expired` | 410 | no | Publish again (unchanged files are reused) |
| `confirm_mismatch` | 400 | no | Set `confirm` to the exact value in `details` |
| `claim_token_invalid` | 403 | no | Use the token from the publish response |
| `anonymous_disabled` | 401 | no | This instance requires an API key; ask its owner |
| `anonymous_challenge_required` | 403 | no | A human opens `details.challengeUrl` once |
| `limit_reached` | 403 (adapters may choose) | no | `details: { limit, used, resetsAt? }` plus adapter links |
| `rate_limited` | 429 | yes | Wait `retryAfterSeconds` |
| `feature_unavailable` | 501 | no | `details.requires` names the binding or setting |
| `invalid_policy_quota` | 500 | no | Adapter must return null or a non-negative integer |
| `folder_not_found` | 404 | no | No folder accessible to this credential; list and retry |
| `blob_missing`, `service_unavailable` | 502/503 | yes | Retry after `Retry-After` |
| `internal_error` | 500 | once | Retry; report `requestId` if it repeats |

---

## 9. MCP server

### 9.1 Endpoint, transport, auth

- `POST <app>/mcp`, Streamable HTTP, stateless, built with `createMcpHandler` from `agents/mcp/server` and
  `@modelcontextprotocol/server` 2.x (MCP spec 2026-07-28), with the stateless compatibility lane for
  2025-era clients. No Durable Object: every call is one Worker request. Cross-call state is an explicit
  handle (`versionId` of a pending version, valid 1 hour).
- Auth: `Authorization: Bearer dw_...` API keys (P0); OAuth 2.1 via `@cloudflare/workers-oauth-provider`
  with API keys still accepted through `resolveExternalToken` (P1). `/mcp` always requires a credential;
  anonymous agents use REST or the CLI.
- Narrowing (R-25): `?toolsets=core,domains` (or `all`), `?read_only=1`, `?site=<slug>` (the `site`
  argument disappears from schemas and the credential is checked against that site). Header equivalents
  `X-Kofra-Toolsets`, `X-Kofra-Read-Only`, `X-Kofra-Site`.
- Tools are generated from the operation registry (section 6.5). Embedding apps add toolsets through
  `operations` or `mcpTools`.

### 9.2 Tools

Hints: RO = readOnly, D = destructive, I = idempotent, OW = openWorld. `*` = loaded even when a client
defers tools (`_meta["anthropic/alwaysLoad"]`). Destructive tools require `confirm`.

| Tool | Toolset | REST | Scope | RO/D/I/OW | Pri |
|---|---|---|---|---|---|
| `whoami`* | core | `GET /me` | any | T/F/T/F | P0 |
| `publish_site`* | core | `POST /publish` (JSON) | `sites:write` | F/F/T/T | P0 |
| `update_site_files` | core | `PATCH /sites/{site}/files` | `sites:write` | F/F/T/T | P0 |
| `finalize_version` | core | `POST .../versions/{version}/finalize` | `sites:write` | F/F/T/F | P0 |
| `get_site` | core | `GET /sites/{site}` | `sites:read` | T/F/T/F | P0 |
| `list_sites` | core | `GET /sites` | `sites:read` | T/F/T/F | P0 |
| `list_files` | core | `GET /sites/{site}/files` | `sites:read` | T/F/T/F | P0 |
| `read_file` | core | `GET /sites/{site}/files/{path}` | `sites:read` | T/F/T/F | P0 |
| `list_versions` | core | `GET /sites/{site}/versions` | `sites:read` | T/F/T/F | P0 |
| `restore_version` | core | `POST .../restore` | `sites:write` | F/F/T/F | P0 |
| `update_site_settings` | core | `PATCH /sites/{site}` | `sites:write` | F/F/T/F | P0 |
| `set_site_access` | core | `PUT /sites/{site}/access` | `sites:write` | F/F/T/F | P0 (public, password) / P1 |
| `delete_site` | core | `DELETE /sites/{site}` | `sites:delete` | F/T/T/F | P0 |
| `claim_site` | core (listed only when anonymous publish is on) | `POST /sites/{site}/claim` | `sites:write` | F/F/T/F | P0 |
| `check_site` | core | `POST /sites/{site}/check` | `sites:read` | T/F/T/T | P1 |
| `create_site` | sites | `POST /sites` | `sites:write` | F/F/F/F | P1 |
| `duplicate_site` | sites | `POST /sites/{site}/duplicate` | `sites:write` | F/F/F/F | P1 |
| `rename_site` | sites | `POST /sites/{site}/rename` | `sites:write` | F/F/T/F | P2 |
| `get_version` | versions | `GET .../versions/{version}` | `sites:read` | T/F/T/F | P0 |
| `diff_versions` | versions | `GET /sites/{site}/diff` | `sites:read` | T/F/T/F | P1 |
| `delete_version` | versions | `DELETE .../versions/{version}` | `sites:delete` | F/T/T/F | P1 |
| `list_folders` | folders | `GET /folders` | `sites:read` | T/F/T/F | P1 |
| `create_folder` | folders | `POST /folders` | `sites:write` | F/F/T/F | P1 |
| `rename_folder` | folders | `PATCH /folders/{folder}` | `sites:write` | F/F/T/F | P1 |
| `delete_folder` | folders | `DELETE /folders/{folder}` | `sites:delete` | F/T/T/F | P1 |
| `create_share_link` | sharing | `POST /sites/{site}/share-links` | `sites:write` | F/F/F/F | P1 |
| `list_share_links` | sharing | `GET /sites/{site}/share-links` | `sites:read` | T/F/T/F | P1 |
| `revoke_share_link` | sharing | `DELETE .../share-links/{id}` | `sites:write` | F/T/T/F | P1 |
| `send_access_invites` | sharing | `POST .../access/invites` | `sites:write` | F/F/F/T | P1 |
| `list_domains` | domains | `GET /domains` | `admin` | T/F/T/F | P1 |
| `add_domain` | domains | `POST /domains` | `admin` | F/F/T/T | P1 |
| `get_domain` | domains | `GET /domains/{domain}` | `admin` | T/F/T/F | P1 |
| `remove_domain` | domains | `DELETE /domains/{domain}` | `admin` | F/T/T/F | P1 |
| `set_primary_domain` | domains | `PUT /sites/{site}/primary-domain` | `sites:write` | F/F/T/F | P1 |
| `list_mounts` | domains | `GET /mounts` | `sites:read` | T/F/T/F | P1 |
| `mount_site` | domains | `PUT /mounts` | `sites:write` | F/F/T/F | P1 |
| `unmount_site` | domains | `DELETE /mounts` | `sites:write` | F/T/T/F | P1 |
| `list_records` | data | `GET .../data/{collection}` | `sites:read` | T/F/T/F | P1 |
| `get_record` | data | `GET .../data/{collection}/{id}` | `sites:read` | T/F/T/F | P1 |
| `write_record` | data | `POST`/`PUT .../data/...` | `data:write` | F/F/T/F | P1 |
| `delete_record` | data | `DELETE .../data/{collection}/{id}` | `data:write` | F/T/T/F | P1 |
| `list_variables` | variables | `GET /variables` | `secrets:write` | T/F/T/F | P1 |
| `set_variable` | variables | `PUT /variables/{name}` | `secrets:write` | F/F/T/F | P1 |
| `delete_variable` | variables | `DELETE /variables/{name}` | `secrets:write` | F/T/T/F | P1 |
| `get_analytics` | analytics | `GET /analytics`, `GET /sites/{site}/analytics` | `sites:read` | T/F/T/F | P1 |
| `list_api_keys` | keys | `GET /keys` | `keys:write` | T/F/T/F | P0 |
| `create_api_key` | keys | `POST /keys` | `keys:write` | F/F/F/F | P0 |
| `revoke_api_key` | keys | `DELETE /keys/{id}` | `keys:write` | F/T/T/F | P0 |
| `list_members` | members | `GET /members` | `members:write` | T/F/T/F | P1 |
| `add_member` | members | `POST /members` | `members:write` | F/F/T/T | P1 |
| `update_member` | members | `PATCH /members/{id}` | `members:write` | F/F/T/F | P1 |
| `remove_member` | members | `DELETE /members/{id}` | `members:write` | F/T/T/F | P1 |
| `create_login_link` | members | `POST /login-links` | `members:write` | F/F/F/F | P1 |
| `list_comments` | comments | `GET /sites/{site}/comments` | `sites:read` | T/F/T/F | P2 |
| `reply_to_comment` | comments | `POST .../comments/{id}/replies` | `sites:write` | F/F/F/F | P2 |
| `resolve_comment` | comments | `POST .../comments/{id}/resolve` | `sites:write` | F/F/T/F | P2 |
| `list_webhooks` | webhooks | `GET /webhooks` | `admin` | T/F/T/F | P2 |
| `create_webhook` | webhooks | `POST /webhooks` | `admin` | F/F/F/T | P2 |
| `delete_webhook` | webhooks | `DELETE /webhooks/{id}` | `admin` | F/T/T/F | P2 |
| `get_instance_settings` | instance | `GET /instance` | `admin` | T/F/T/F | P2 |
| `update_instance_settings` | instance | `PATCH /instance` | `admin` | F/F/T/F | P2 |
| `list_audit_events` | instance | `GET /audit` | `admin` | T/F/T/F | P2 |
| `search_docs` | docs | `GET /docs/search` | none | T/F/T/F | P1 |
| `call_api` | advanced | any `/api/v1` route | the route's scope | F/T/F/T | P1 |

64 tools; `core` is 15 (about 5k tokens of definitions). Code Mode (P2, R-43) is a separate endpoint
`/mcp/code` with two tools, `search` and `execute`, over this instance's OpenAPI, available when a
`LOADER` (Dynamic Workers) binding exists.

Key shapes (full schemas live in the registry):

```ts
type SiteRef = string;     // slug, site id, or any URL of the site
type VersionRef = string;  // "live" | "v12" | "12" | version id

// Exactly one source per file. Flat on purpose (some model APIs mishandle oneOf).
interface FileInput {
  path: string;                       // "index.html", "assets/app.js"; "/" and "./" prefixes accepted
  content?: string; encoding?: "utf8" | "base64";   // inline; utf8 <= 1 MB/file, base64 <= 256 KB/file
  url?: string; headers?: Record<string, string>;   // server fetch; headers never stored
  sha256?: string; size?: number;     // manifest entry (bytes stored or to be uploaded)
  copyFrom?: { site?: SiteRef; version?: VersionRef; path?: string };
  contentType?: string;
  localPath?: string;                 // local stdio MCP and CLI only
}

// publish_site output (REST returns the same JSON)
interface PublishResult {
  status: "live" | "unchanged" | "awaiting_upload";
  url: string;                        // live URL; share exactly as returned
  versionUrl: string;                 // this exact version (owner preview link)
  site: SiteSummary; version: VersionSummary;
  files: { total: number; stored: number; reused: number; fetched: number; pending: number };
  upload?: { versionId: string; expiresAt: string;
             items: { path: string; sha256: string; size: number; method: "PUT"; url: string; headers: Record<string, string>; curl: string }[];
             finalize: { tool: "finalize_version"; args: { site: string; versionId: string } } };
  claim?: { url: string; token: string; expiresAt: string; note: string };   // anonymous only; token shown once
  warnings: { code: string; message: string; path?: string; line?: number; fix?: string }[];
  next: { tool: string; args?: Record<string, unknown>; why: string }[];
}
```

### 9.3 Results, errors, instructions

- Every tool returns `structuredContent` matching its `outputSchema`, plus a text block: one plain-English
  line (for example `Published bright-otter-x7k2 v3 (12 files, 2 uploaded, 10 unchanged): <url>`) and the
  compact JSON. Live URLs are also returned as `resource_link` blocks.
- Business errors are tool results with `isError: true` and the text `"<code>: <message> Fix: <hint>"` plus
  the error JSON, so clients pass them back to the model. Protocol errors stay JSON-RPC errors.
- Lists paginate (default 50). `read_file` pages by byte range (default 64 KB) and can return
  `as: "markdown"` for HTML, PDF and Office files (Workers AI conversion, R-34).
- Server `instructions` (under 4,096 characters, search-friendly): what Kofra is for; prefer
  `npx kofra publish <dir> --json` when a shell exists; how to choose file sources; share `url` exactly;
  use `update_site_files` with `baseVersionId` for edits; run `check_site` after publishing; destructive
  calls need `confirm`.

### 9.4 Resources, prompts, apps (R-25)

- Resource templates: `dropway://sites/{site}`, `dropway://sites/{site}/files/{path}`,
  `dropway://sites/{site}/versions/{version}/files/{path}`; skill files as `skill://dropway/SKILL.md`.
- Prompts: `publish`, `share-privately`, `rollback`.
- MCP Apps card `ui://dropway/site-card` on `publish_site`, `update_site_files`, `get_site` and
  `restore_version`: live preview iframe (sites origin only in its CSP), versions with restore, a
  Rendered/Raw toggle per file, QR code, claim link for anonymous sites.

### 9.5 Local stdio server (R-26)

`npx -y kofra mcp` exposes the same tools; file sources also accept `localPath` and `localDir`, which the
CLI hashes and uploads from disk. Credentials as for the CLI.

---

## 10. File viewers

### 10.1 Rules

1. A viewer runs only for top-level navigations (`Sec-Fetch-Dest: document` or `iframe`, or
   `Accept: text/html` without fetch metadata) or with `?view=1`. `fetch()`, `<img>`, `<script>` and every
   other sub-resource request gets raw bytes, so sites keep working. (Done)
2. `?raw=1` returns the stored bytes; HTML, SVG, Markdown and other text types come back as
   `text/plain; charset=utf-8` so the source shows. `?download=1` sends `Content-Disposition: attachment`.
   (Done) `?view=source` shows highlighted source for any text file, HTML included. (R-07)
3. Every viewer page has the same slim bar: file name, size, type, version, and links Rendered, Source
   (text types), Raw, Download, Copy link. The bar works without JavaScript.
4. **HTML is the real page.** A navigation to `page.html` serves the page itself, never a viewer.
   `page.html?view=1` serves the **viewer frame**: the bar plus the page in an iframe, so a person can flip
   between the rendered page and its source. (R-07)
5. Each viewer has a size cap. Above it the file is served raw (or, for text, as the first part with a
   "showing first N KB" note and links).
6. Viewer pages get `VIEWER_CSP` (no scripts) by default. A viewer that needs scripts (P1 sorting,
   search, diagrams) uses a per-response nonce and loads only first-party files from
   `/__dropway/assets/`. User content is always escaped or run through an allowlist sanitizer (Markdown
   and notebook HTML: no `<script>`, event handlers, `<base>`, `<meta http-equiv>`, `<form>` or
   `javascript:` URLs).
7. Rendered output is cached by `render/<viewer>@<version>/<sha256>`.
8. Per site: `renderMarkdown: false` serves `.md` raw; `viewers: false` turns every viewer off.
9. `Accept: text/markdown` on a navigation returns a Markdown rendering instead of HTML (R-34).
10. Light and dark themes follow `prefers-color-scheme`; tables, headings and controls are accessible by keyboard.

### 10.2 Matrix

| Kind (`detectFileKind`) | Typical extensions | Rendered view | Source / raw | Viewer cap | Scripts | Pri | Status |
|---|---|---|---|---|---|---|---|
| html | `.html`, `.htm` | The page itself; `?view=1` = viewer frame | highlighted source; raw as text | - | page's own | P0 | Page + raw done; frame, source R-07 |
| markdown | `.md`, `.markdown` | GFM: tables, task lists, footnotes, heading anchors, highlighted code; Rendered/Markdown toggle | yes | 2 MB | none (P0); Mermaid and KaTeX (P1) | P0 | Done (basic); highlighting R-07; diagrams R-34 |
| image | `.png .jpg .jpeg .gif .webp .avif .bmp .ico` | Centered on a checkerboard, fit/actual-size toggle, dimensions | raw | - | none | P0 | R-08 |
| svg | `.svg` | Shown through `<img>` (its scripts never run) | highlighted XML source | 5 MB | none | P0 | R-08 |
| pdf | `.pdf` | Browser's built-in PDF viewer in an embed, with a download fallback | raw | - | none | P0 | R-08 |
| video | `.mp4 .webm .mov .ogv` | `<video controls>` with Range | raw | - | none | P0 | R-08 |
| audio | `.mp3 .wav .ogg .m4a .flac .aac` | `<audio controls>` | raw | - | none | P0 | R-08 |
| json | `.json`, `.geojson`, `.webmanifest` | Collapsible tree from `<details>` elements, pretty-printed values, key counts | highlighted | 5 MB (pretty-print only up to 20 MB) | none (P0); search (P1) | P0 | R-08 |
| json lines | `.jsonl .ndjson` | One collapsible row per line, first 2,000 lines | highlighted | 10 MB | none | P1 | R-34 |
| csv | `.csv .tsv` | Table with header detection, row and column counts, first 2,000 rows | raw | 10 MB | none (P0); sort and filter (P1) | P0 | R-08 |
| code | 60+ languages via `languageFor` (`.js .ts .py .go .rs .sql .sh ...`) | Highlighted, line numbers, `#L10-L20` anchors, wrap toggle | raw | 1 MB | none | P0 | R-07 |
| config | `.yaml .yml .toml .ini .xml` | Highlighted (P0); collapsible tree for YAML/TOML (P1) | raw | 1 MB | none | P0 / P1 | R-07 / R-34 |
| text | `.txt .log`, `text/*` | Monospace with line numbers, wrap toggle | raw | 2 MB | none | P0 | R-07 |
| notebook | `.ipynb` | Cells: Markdown, highlighted code, outputs (text, images, sanitized HTML) | JSON source | 10 MB | none | P1 | R-34 |
| diff | `.diff .patch` | Colored unified diff with file headers | raw | 1 MB | none | P1 | R-34 |
| diagram | `.mmd .mermaid` (and fenced blocks in Markdown) | Rendered diagram (Mermaid, `securityLevel: strict`) | source | 256 KB | first-party | P1 | R-34 |
| font | `.woff .woff2 .ttf .otf` | Specimen: alphabet, sizes, sample text | download | 10 MB | none | P1 | R-34 |
| binary | `.wasm`, unknown | Info page: size, type, sha256, first 256 bytes as hex, download | download | - | none | P1 | R-34 |
| archive | `.zip .tar .gz .tgz` | Entry list with sizes (zip central directory; tar headers) | download | 100 MB | none | P2 | R-51 |
| office | `.docx .xlsx .pptx` | Preview via Workers AI Markdown conversion, clearly labelled as a preview | download | 25 MB | none | P2 | R-51 |
| model3d | `.glb .gltf` | `<model-viewer>` from first-party assets | download | 50 MB | first-party | P2 | R-51 |
| map | `.geojson` (opt-in) | Map with features (tiles from a configurable source) | JSON view | 10 MB | first-party | P2 | R-51 |
| epub | `.epub` | Chapter list and reader | download | 50 MB | first-party | P2 | R-51 |
| folder | (no index file) | Listing: folders, sizes, image gallery, and `README.md` rendered below | - | - | none | P0 | Done (README below in R-08) |

---

## 11. Security model

### 11.1 Threats we design for

1. A published site attacking the app, the API or the people who use it (stealing sessions or keys, CSRF).
2. One site attacking another site on the same instance (reading its storage, cookies or gated content).
3. Strangers using anonymous publish for phishing or malware.
4. Agents doing damage by mistake (hallucinated deletes, overwriting another agent's work, leaking secrets).
5. Information leaks through the platform (dedupe oracles, enumeration, logs).
6. Server-side request forgery through URL sources, proxy routes and webhooks.

### 11.2 Origins and serving modes

| Mode | Config | Site URL | Isolation between sites | Isolation from the app |
|---|---|---|---|---|
| Subdomain (recommended) | `SITES_MODE=subdomain`, `SITES_DOMAIN`, wildcard route + proxied wildcard DNS | `https://<slug>.<SITES_DOMAIN>/` | Each site is its own origin (own cookies, storage, service workers) | Use a different registrable domain from the app |
| Path, dedicated sites origin | `SITES_MODE=path`, `SITES_ORIGIN` = a second deployment of the same Worker | `<SITES_ORIGIN>/<slug>/` | **None** between unsandboxed sites (one origin) | Separate origin; the app origin redirects `/s/...` there |
| Path, app origin (zero-config default) | `SITES_MODE=path`, no `SITES_ORIGIN` | `<app>/s/<slug>/` | CSP sandbox on every site (opaque origins) | CSP sandbox |

Path mode is interim. It exists so an instance works on `workers.dev` with no domain. Its limits:

- Sites on one origin share cookies, `localStorage`, IndexedDB and the service-worker scope space unless
  sandboxed. A same-origin script can also read another site's gated content once a visitor has unlocked
  it, because it can make credentialed same-origin requests (and change its own URL with `pushState`, so
  `Referer` checks do not help). **Path mode protects gated content from outsiders, not from other sites on
  the same instance.** Instances where publishers do not trust each other must use subdomain mode or
  `SITES_SANDBOX=true`.
- Root-absolute URLs are handled by HTML/CSS rewriting, `Referer` redirects (unsandboxed pages) and an
  injected run-time shim (sandboxed pages: no Referer is ever sent from an opaque origin). Import
  specifiers, `location.href` and `pushState` with root-relative URLs should be relative. Publish warnings (R-12) say this with the exact framework fix.

`SITES_SANDBOX` (default `auto` since 2026-10-22):

| Value | Effect |
|---|---|
| `auto` (default) | Sandbox when sites share the app origin; on a dedicated sites origin sandbox **anonymous** sites only; subdomain mode none |
| `true` | Every site response carries the CSP sandbox (scripts run in an opaque origin: no cookies, storage or service workers) |
| `false` | No sandbox, except when sites share the app origin (always forced) |

**Same-site caveat on `workers.dev`.** `workers.dev` is on the Public Suffix List, so
`dropway.<you>.workers.dev` and `dropway-sites.<you>.workers.dev` are different origins but the **same
site** (`<you>.workers.dev`). `SameSite` cookies therefore do not stop requests from sites pages to the app.
Rules (R-15): app cookies use the `__Host-` prefix (cannot be set or overwritten with a `Domain`
attribute); every state-changing app request authenticated by a cookie must carry `Origin` equal to the app
origin and `Sec-Fetch-Site: same-origin`; the REST API authenticates by bearer tokens, never cookies, and
its CORS allows any origin without credentials. Subdomain mode on a separate registrable domain removes the
caveat.

**Current boundary:** built-in API-key sign-in issues no app cookie, and core REST ignores
cookie-only credentials. Real app-cookie `__Host-` issuance and cookie-authenticated write
integration checks are **deferred / not run** until R-21 introduces sessions, before any
session is enabled. Cookie-rejection tests are not proof of either rule. An embedding
identity adapter accepting cookies must enforce both header checks itself; this boundary
does not approve a cookie-authenticated embedding deployment.

### 11.3 Headers by response class

| Response | Headers |
|---|---|
| App pages (`<app>`) | `APP_PAGE_CSP` (no inline scripts except nonce, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `nosniff` |
| REST API | `Content-Type: application/json`, CORS `*` without credentials, `Cache-Control: no-store` |
| Read-back `GET /files/{path}` | text types as `text/plain`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, no-store` |
| Viewer pages (sites origin) | `VIEWER_CSP` or nonce CSP, plus the sandbox when the site is sandboxed |
| User files (sites origin) | `nosniff`, `X-Kofra-Version`, `ETag`, CSP `sandbox ...` when sandboxed, COOP/COEP when cross-origin isolation is on, `Access-Control-Allow-Origin: *` on public sites only, `X-Robots-Tag: noindex` on anonymous, expiring and `noindex` sites, `frame-ancestors 'self'` on gated sites |
| System pages (404, password, report) | no scripts, `Cache-Control: no-store` |

The sandbox token list is `SITE_SANDBOX` (`allow-scripts allow-forms allow-popups
allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation
allow-orientation-lock`), never `allow-same-origin`.

### 11.4 Credentials, scopes, roles

| Credential | Format | Stored | Lifetime |
|---|---|---|---|
| API key | `dw_` + random | SHA-256 only; prefix kept for display | until revoked or `expires_at` |
| Claim token | `dwc_` + random | SHA-256 | until the site expires or is claimed |
| Upload token | `dwu_<versionId>.<exp>.<hmac>` | not stored (HMAC with `SIGNING_SECRET`) | the pending version (1 h) |
| Share link token | random in the URL | SHA-256 | its `expires_at` |
| Version preview token | HMAC over site, version and expiry | not stored | 24 h |
| Session | random cookie `__Host-dw_session` | SHA-256 in `sessions` | 30 days, sliding; revocable |
| OAuth tokens | issued by `workers-oauth-provider` | hashed in `OAUTH_KV` | access 1 h, refresh rotates, grant 30 days |
| Bootstrap secret | `ADMIN_BOOTSTRAP_KEY` secret | Worker secret | setup and recovery only |

Scopes: `sites:read`, `sites:write`, `keys:write`, `members:write`, `sites:delete`, `data:write`,
`secrets:write`, `admin` (implemented; migration `0003_scopes_usage.sql` gives `sites:delete` to existing `sites:write` keys after the transfer schema in `0002_transfers.sql`).
Roles: `owner` and `admin` may hold every scope; `member` may hold `sites:read`, `sites:write`,
`sites:delete`, `keys:write`, `data:write`. A key can never be wider than its member; a member can never
grant more than they hold. Keys can be limited to one site and, for drives, a path prefix.

### 11.5 Integrity, privacy, SSRF, secrets

- **Upload integrity.** R2 verifies the SHA-256 of every single-request upload. Multipart uploads land in
  `uploads/`, are hashed with a streaming digest, and only then become `blobs/<sha256>`.
- **Dedupe privacy.** "Already have it" is answered only for hashes the caller's tenant (or anonymous
  claim) has proven it holds (`blob_scopes`). Other hashes are always requested, verified, and not rewritten
  if present. No unauthenticated endpoint reveals whether a hash exists.
- **Enumeration.** Newly generated slugs are `adjective-noun-xxxxxx` (60 x 60 words x 32^6 suffixes,
  about 3.9 trillion names, about 42 bits). That makes them hard to guess, not secret: anything private
  must use an access mode. Existing four-character slugs remain valid and are not renamed. Listing endpoints
  need credentials; version previews need a signed link; 404s look the same for "never existed" and "no access".
- **IPs.** Only salted hashes (`SIGNING_SECRET`) are stored. Analytics visitors are daily salted hashes.
- **SSRF.** URL sources, proxy routes and webhooks fetch `https` only, refuse private, loopback,
  link-local and Cloudflare-internal addresses, follow at most 3 redirects (re-checking each), time out at
  30 s, and cap bodies (100 MB for sources, 10 MB for proxy bodies). The Worker uses the
  `global_fetch_strictly_public` compatibility flag when OAuth CIMD is enabled.
- **Secrets in content.** The CLI refuses to upload files matching high-signal secret patterns (private
  key blocks, `AKIA...`, `ghp_`, `sk-`, `xox`, `dw_`) unless `--allow-secrets`; the server returns
  `possible_secret` warnings and suggests `delete_version`.
- **Variables** are encrypted with AES-256-GCM (key from the `VARIABLES_KEY` secret, versioned), are
  write-only through every surface, and are injected only into proxy requests to pinned upstreams.
- **Agent mistakes.** `confirm` on destructive MCP tools, `--yes` in the CLI, `baseVersionId` conflicts,
  immutable versions, `delete_version` refuses the live version, deleted sites are recoverable for 24 h by
  the operator (soft delete).

### 11.6 Anonymous publish controls

Off by default. When on: expiry (24 h), smaller caps, per-IP hourly limit, `noindex`, always sandboxed on a
shared origin, "Report abuse" link on anonymous HTML pages, optional Turnstile on browser uploads, the
moderation adapter (hold pages with password fields or forms posting elsewhere until claimed), the
`anonymous_challenge_required` flow for API callers under abuse pressure, and owner takedown with a
blocked-hash list.

Anonymous `text/html` responses carry a fixed, script-free "Report abuse" link injected by
`HTMLRewriter`, including fragments. XHTML (`application/xhtml+xml`) is excluded: appending
an HTML link after its root element would break XML well-formedness. Existing path-mode
rewriting is unchanged. The link opens the site's absolute `__dropway/report` URL
in a new window with `noopener noreferrer`, so an untrusted `<base>` cannot redirect it
and it works without script authority in the sandbox. Raw/download responses and stored
bytes are not changed; claimed and owned sites carry no anonymous link. Transformed HTML
uses a separate versioned ETag and ignores byte ranges. **The report form and submission
processing remain R-37.** Until that route exists, its destination follows ordinary site
resolution: a 404 (possibly the site's `404.html`) or the site's `index.html` SPA fallback.
The link alone is not an operational reporting channel.

### 11.7 Default limits (all admin-configurable)

| Limit | Default | Setting |
|---|---|---|
| Largest file (single request) | 100 MB (Workers request body limit on Free/Pro zones) | `MAX_FILE_BYTES` |
| Largest file (multipart, R-35) | 5 GB | `MAX_MULTIPART_FILE_BYTES` |
| Files per version | 2,500 | `MAX_FILES` |
| Bytes per version | 10 GB | `MAX_SITE_BYTES` |
| One-shot publish body | 25 MB | `ONESHOT_MAX_BYTES` |
| Inline content per file / per call | 1 MB / 4 MB (base64 256 KB / 1 MB) | `INLINE_MAX_BYTES` (R-04) |
| URL source per file | 100 MB, 30 s, 3 redirects | `URL_FETCH_MAX_BYTES` (R-04) |
| Pending version lifetime | 1 hour | - |
| Anonymous: lifetime / per-IP per hour / file / site | 24 h / 60 / 25 MB / 250 MB | `ANON_TTL_HOURS`, `ANON_SITES_PER_HOUR`, `ANON_MAX_FILE_BYTES`, `ANON_MAX_SITE_BYTES` |
| API keys per member | 50 | - |
| Folders, variables (x 4 KB), access-list entries | 50, 50, 10,000 | quotas (R-17) |
| Site Data | 16 KB per record, 25,000 per collection, 100,000 per site | quotas (R-30) |
| Proxy routes | 10 MB body, 100 requests per hour per IP per route by default | `.dropway/proxy.json` per route |
| Rate limits | authenticated publish 600/h (burst 60/min); reads 1,200/min; anonymous requests 120/min/IP | `RATE_LIMITS` (R-36) |
| Quotas (sites, storage, ...) | unlimited | `QUOTA_*` vars or instance settings (R-17) |

---

## 12. Self-hosting: the one-click plan

### 12.1 Path for a new operator

1. **Prerequisites.** A Cloudflare account with R2 activated (a free checkout step the Deploy button
   cannot do) and a GitHub or GitLab account. Workers Paid ($5/month on Cloudflare) is recommended: the Free
   plan's 10 ms CPU per request breaks zip uploads and large renders, and Email sending and Dynamic Workers
   need Paid.
2. **Click** `https://deploy.workers.cloudflare.com/?url=https://github.com/TogetherWeOwn/dropway`.
   Cloudflare copies the repo into the operator's account, creates D1 `dropway`, R2 `dropway-files`, KV,
   the Analytics Engine dataset (on first write) and, once added to `wrangler.jsonc`, the Queue and Durable
   Objects; it prompts for `ADMIN_BOOTSTRAP_KEY` (from `.dev.vars.example`, with help text from
   `package.json` `cloudflare.bindings`), builds, runs `npm run deploy` (migrations, then deploy).
3. **First run in the browser (R-16).** Opening `<app>/` on an instance that is not set up shows a form:
   paste the bootstrap secret, enter an email, get the owner API key once, then the `/connect` page with
   one-line setup for each agent. The `curl` path keeps working.
4. **Connect agents.** `/connect` shows: `claude mcp add --transport http kofra <app>/mcp --header
   "Authorization: Bearer $KOFRA_API_KEY"`, Codex, Cursor, `npx add-mcp <app>/mcp`,
   `npx skills add <app> -g`, and `npx kofra login --api <app>`.

### 12.2 What the button cannot do, and the fallback

| Not automatic | Fallback |
|---|---|
| DNS records, Workers routes, custom domains | Path mode on `workers.dev` works with zero setup; subdomain mode is a documented manual step |
| R2 S3 credentials (presigned URLs) | Not needed: uploads go through the Worker |
| Analytics Engine API token (reads) | D1 daily counters |
| Email sending domain | Login links and API keys; email features report `feature_unavailable` |
| Bindings that need Workers Paid (`LOADER`) | Not in the default `wrangler.jsonc`; documented opt-in |
| Second deployment for a dedicated sites origin | Documented: deploy the same repo again with `--name <name>-sites`, set `SITES_ORIGIN` on both |

Every optional feature checks its binding at runtime and appears in `whoami.capabilities`, so a partial
setup is described correctly to agents.

### 12.3 Topologies

| Topology | Cost to set up | Isolation | Use when |
|---|---|---|---|
| A. One Worker, path mode, sites at `<app>/s/<slug>/` (default) | none | all sites sandboxed (storage APIs unavailable to pages) | trying it out, personal use |
| B. Two deployments on `workers.dev`: app and `<name>-sites` | one extra deploy | sites separated from the app; not from each other unless sandboxed | a team that trusts its publishers, before buying a domain |
| C. Subdomain mode on a domain the operator owns | wildcard DNS + one route | full per-site origins | any instance with untrusted publishers, or once a domain exists |

### 12.4 Upgrades, backup, removal

- Upgrade: pull upstream (or let the Deploy button's repo sync), `npm run deploy` (migrations first, then
  the Worker). Migrations are additive; a migration that needs data movement ships with a cron job, not a
  blocking step.
- Backup: D1 Time Travel (30 days, point in time); R2 objects are immutable and content-addressed. FTS
  search tables can be rebuilt (note in 7.3).
- Removal: delete the Worker(s), D1 database, R2 bucket, KV namespaces and Queue in the dashboard.

### 12.5 Acceptance test for one-click (R-16)

On a fresh Cloudflare account (Free plan and Paid plan, separately): click the button, finish in under 5
minutes with only the documented inputs, set up the owner in the browser, publish a 40-file Vite build with
`npx kofra publish ./dist --json --wait`, open it, view a Markdown and a CSV file rendered and raw, roll
back, and connect Claude Code to `/mcp` with the key. Record the result in `docs/SELF_HOST.md`.

---

## 13. Parity checklist against here.now

here.now's public API (OpenAPI v0.1.0 read on 2026-10-22) has 139 operations: Auth 9, Sites 21,
Folders 4, Site Data 5, Analytics 2, Profiles 6, Drives 17, Domains 30, Domain purchasing 13,
Workspaces 24, Variables 3, Billing 4, Support 1.

| here.now feature (operations) | Kofra equivalent | Pri | Status |
|---|---|---|---|
| 3-step publish: create, PUT to presigned R2, finalize (Sites) | Manifest publish + upload links + `finalize_version`; plus one-call publish and inline/URL sources | P0 | Done / R-04 |
| Presigned R2 upload URLs | Upload links on the app origin (one egress host, no R2 keys) | P0 | R-04 |
| Incremental deploys by sha256, `skipped[]` | Missing-hash negotiation, per-tenant dedupe | P0 | Done |
| Refresh upload URLs | `missing_blobs` returns fresh links; `get_version` lists what is missing | P0 | R-05 |
| Idempotent finalize (`replayed`) | `already_live` | P0 | Done |
| Byte-identical republish `unchanged` | Same | P0 | Done |
| Update in place, settings as patches | `publish_site` with `site`, `update_site_settings` | P0 | Done |
| `baseVersionId` -> 409 | Same, with `next` | P0 | Done |
| Finalize `warnings[]` | Publish warnings (more kinds) | P0 | R-12 |
| Client attribution header and badge | `X-Kofra-Client`, MCP `clientInfo` | P0 | Done / R-06 |
| `urls[]` (slug, domain, label...) | `site.urls[]` (slug, domain, mount) | P1 | R-33 |
| TTL | `ttlSeconds` | P1 | R-27 |
| SPA mode | `spa` | P0 | Done |
| Display metadata and AI generation | Title/description; HTML metadata then Workers AI | P1 | R-19 |
| Viewer metadata for auto-viewers | Site title/description and OG image per version | P1 | R-19, R-20 |
| Duplicate site | `duplicate_site` | P1 | Done |
| Publish from Drive | `duplicate_site` from a drive | P1 | R-32 |
| Delete site | `delete_site` (with `confirm`) | P0 | Done |
| Caps: 2,500 files, 10 GB per version, 250 MB anonymous file, 5 GB keyed file | 2,500 / 10 GB / 25 MB anonymous (configurable) / 100 MB single request, 5 GB multipart | P0 / P1 | Done / R-35 |
| Anonymous publish 24 h + claim token/URL (Sites) | Same; off by default | P0 | Done |
| Agent sign-up by email code (Auth 2) | Not in this edition (no strangers). Owner mints member keys; login links; email codes for existing members | P1 | R-21 |
| Dashboard sign-in by magic link or Google | Login links, email codes (with an email binding), Cloudflare Access identity | P1 | R-21 |
| Named API keys, list, revoke (Auth 3) | Same, plus scopes, site and path restriction, expiry; keys are shown once (not re-readable, on purpose) | P0 | Done |
| Email change (Auth 4) | Owner edits member email | P2 | R-22 |
| Credentials file `~/.herenow/credentials` | `~/.dropway/credentials.json`, per instance | P0 | R-09 |
| Random slugs; one origin per site | Same in subdomain mode; path mode interim | P0 | Done |
| Serving precedence, listings, gallery | Same, plus README under listings | P0 | Done / R-08 |
| Markdown render + toggle + `?raw=1` | Same | P0 | Done |
| JSON, CSV, code, text, SVG served raw | Rendered viewers for all of them, with raw toggle | P0 | R-07, R-08 |
| Headers, Range, edge compression, WASM handling, COOP/COEP, pre-compressed files | Same | P0 / P1 | Done (warning R-12) |
| New version live in about 10 s | Version URL at once; live URL within about 60 s; `--wait` confirms | P0 | R-13, R-14 |
| Owner-only preview hosts `{versionId}--{slug}` | `<slug>--v<N>` with signed links | P0 | R-13 |
| Thumbnails and OG cards | Browser Run screenshots | P1 | R-20 |
| Versions: list, restore, delete one, drift detection (Sites) | Same; restore of live is a no-op success | P0 / P1 | Done |
| Folders (4) | Same | P1 | R-28 |
| Read-back: list files, read file, HEAD (Sites 3) | Same, plus `as: "markdown"` and byte ranges | P0 | Done |
| Site Data (5) + browser runtime | Same model, Durable Object per site | P1 | R-30 |
| Analytics (2) | Same fields, Analytics Engine + D1 rollups | P1 | R-29 |
| Profiles (6) | Opt-in public gallery and feed | P2 | R-50 |
| Search | Same scope plus PDF and other text via Workers AI conversion (P2) | P1 | R-28 |
| Workspaces (24) | One tenant with members and roles. Several workspaces per instance are not in this edition | P1 | Done (REST) / R-22 |
| Drives (17) | Drives as private `kind: "drive"` sites with scoped tokens | P1 | R-32 |
| Variables (3) + proxy routes | Same | P1 | R-31 |
| Custom domains (4), primary domain (2), mounts (5) | Same on the operator's zones; deprecated `links` aliases not copied | P1 | R-33 |
| Vanity subdomains and handles (14) | Vanity names on the operator's domain | P2 | R-50 |
| Access: password, restricted, owner-only, members, invites (Sites 3) | Same; plus share links and embed allowlists | P0 / P1 | Done (password) / R-23 |
| Embeds | Same, plus per-site allowlist | P0 / P1 | Done / R-23 |
| Agent docs, discovery files, skill | Same set, generated per instance | P0 | R-11 |
| Error shape | Code, hint, retryable, next | P0 | R-03 |
| Abuse reporting and takedown | Report form, takedown, blocked hashes | P1 | R-37 |
| Editor (in-dashboard AI) | Not planned: agents edit through the same API | - | - |
| Domain purchasing (13), Billing (4), Support (1), plan credits, Stripe provisioning | Not in this edition | - | - |
| No MCP, no OAuth | Remote MCP with OAuth, local MCP, CLI, Code Mode | P0 / P1 | R-06, R-24 |

Beyond parity (planned): rendered viewers for every common type, `check_site`, `diff_versions`, dry runs,
share links, comments that agents resolve, live reload, webhooks, `Accept: text/markdown`, MCP Apps
preview cards, Code Mode, end-to-end encrypted sites, per-site functions, self-hosting in one click.

---

## 14. Open questions and tests to run

| Question | How we answer it | Owner |
|---|---|---|
| Live-URL freshness with KV on real traffic | R-14 measurement script from 5 regions; p50/p95 time-to-visible | R-14 |
| Does the Cache API behave on `workers.dev` hostnames? | Probe `cf-cache-status` and hit rates on a `workers.dev` deployment | R-14 |
| Request body limit on `workers.dev` (no zone plan) | Upload 99 MB and 101 MB files | R-35 |
| Cookies for gated sites served with the CSP sandbox in Safari and Firefox | Browser tests (Playwright WebKit/Firefox) of password and share-link flows | R-23 |
| Does the Deploy button accept optional bindings (Queues, DO) on a Free account? | R-16 fresh-account test | R-16 |
| MCP stateless lane with Claude.ai, ChatGPT, Cursor, Codex | Connect each client; record results in docs | R-06, R-24 |
| Analytics Engine SQL support for approximate distinct counts | Query test; otherwise count visitors from the daily-hash blob in rollups | R-29 |
| Server-side highlighter: CPU and bundle size | Benchmark highlight.js vs Shiki (JavaScript regex engine) on 1 MB files | R-07 |

---

## 15. References

- here.now: https://here.now/docs, https://here.now/openapi.json, https://here.now/llms.txt, https://here.now/skill.md
- Cloudflare Workers limits and pricing: https://developers.cloudflare.com/workers/platform/limits/, https://developers.cloudflare.com/workers/platform/pricing/
- R2 Workers API (`sha256`, conditional puts, multipart): https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- D1 limits, FTS5, read replication, Time Travel: https://developers.cloudflare.com/d1/platform/limits/, https://developers.cloudflare.com/d1/best-practices/read-replication/
- KV consistency: https://developers.cloudflare.com/kv/concepts/how-kv-works/
- Cache API: https://developers.cloudflare.com/workers/runtime-apis/cache/
- Static assets routing (`run_worker_first`): https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
- Deploy to Cloudflare buttons: https://developers.cloudflare.com/workers/platform/deploy-buttons/
- Remote MCP handler and authorization: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/, https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
- workers-oauth-provider: https://github.com/cloudflare/workers-oauth-provider
- MCP specification 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- Browser Run, Workers AI Markdown conversion, Email Service, Turnstile, Rate Limiting binding:
  https://developers.cloudflare.com/browser-run/, https://developers.cloudflare.com/workers-ai/features/markdown-conversion/,
  https://developers.cloudflare.com/email-service/, https://developers.cloudflare.com/turnstile/,
  https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cloudflare for SaaS (custom hostnames): https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/
- Public Suffix List (`workers.dev`): https://publicsuffix.org/list/public_suffix_list.dat
- llms.txt: https://llmstxt.org/ · Agent Skills: https://agentskills.io/specification · RFC 9727 api-catalog
- IETF drafts: RateLimit headers (draft-ietf-httpapi-ratelimit-headers), Idempotency-Key (draft-ietf-httpapi-idempotency-key-header)
