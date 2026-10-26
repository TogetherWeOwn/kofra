# Kofra architecture

Kofra publishes files, folders and sites to live URLs. It runs entirely on
Cloudflare: one Worker, D1 for metadata, R2 for file bytes, KV for the hot
"what is live" cache, Analytics Engine for hits.

This repository is the **complete single-tenant product** (MIT). It has no
plans, prices, billing, payment code or public signup. A hosted, multi-tenant
service can be built *on top* of it by calling `createDropway()` with its own
adapters, routes and UI. The extension points below exist for that. Nothing
here imports such a layer, and such a layer never copies files from here.

## Layout

```
wrangler.jsonc            Self-host deploy config (repo root on purpose: the Deploy to
                          Cloudflare button treats the chosen folder as the whole repo)
apps/worker/src/index.ts  The single-tenant Worker: createDropway() with defaults
packages/core             @dropway/core: service layer (no HTTP framework)
  migrations/             D1 schema (applied by `npm run deploy`)
  src/config.ts           Vars/secrets -> DropwayConfig
  src/context.ts          DropwayContext (what every service takes) + URL helpers
  src/principal.ts        Principal (who is calling), roles, scopes
  src/adapters.ts         Extension interfaces: identity, policy, metering, hooks
  src/errors.ts           ApiError (status, code, message, hint, details)
  src/lib/                crypto, mime, paths, slugs, file-type detection
  src/services/           ALL business logic (see below)
packages/server           @dropway/server: createDropway() Hono app factory
  src/create.ts           createDropway(): wiring, dispatch, cron
  src/route-sites.ts      Decides "site request" vs "app request" (modes, Referer)
  src/serve.ts            Serves site files (index resolution, ranges, ETags, password, headers)
  src/path-rewrite.ts     Path mode: prefixes root-relative URLs in HTML/CSS
  src/viewers/            File viewers, one per kind (code, markdown, json, csv, media, notebook, binary...)
  src/ui/                 App-origin UI: home, sign-in, dashboard, file viewer, the dashboard script
  src/routes/api.ts       API middleware, JSON parsing and error responses
  src/operations/         Operation families and compatibility adapters; core.ts fixes stable order
  src/operations.ts       Operation types, validation and REST/MCP generation
  src/mcp/                Remote MCP server (/mcp): endpoint (index.ts), core tools (tools.ts), schemas
  src/app.ts              App-origin routes: home (./ui), /openapi.json, discovery routes, /claim, /mcp
  src/openapi.ts          OpenAPI 3.1 document for every route (operationId = MCP tool name)
  src/discovery.ts        /llms.txt, /llms-full.txt, /skill.md, /connect(.md), /.well-known/*, /robots.txt (generated)
  src/extensions.ts       Types for routes, MCP tools, UI slots, createDropway options
packages/cli              `kofra` CLI (npm package "kofra", Node 20+, zero runtime dependencies)
skills/kofra/SKILL.md   Agent Skill (`npx skills add TogetherWeOwn/dropway`); generated, `npm run skill:sync`
scripts/guard-open-core.mjs  CI guard: no billing, pricing, payment or hosted-service code in this repo
test/                     vitest + @cloudflare/vitest-plugin (runs inside workerd)
```

## Rule: logic lives in services, every surface is thin

All behaviour lives in `packages/core/src/services/*.ts`. A service takes a
`DropwayContext` (`dw`) and a `Principal`, enforces permissions itself, and
throws `ApiError` with a stable `code` and a `hint` for the caller.

| Service | What it does |
|---|---|
| `identity.ts` | Default identity adapter: `Authorization: Bearer` API key (`dw_`), claim token (`dwc_`) or bootstrap secret |
| `keys.ts` | Create, list, revoke scoped API keys (only a SHA-256 is stored) |
| `tenants.ts` | First-run setup (bootstrap key creates the owner), members, owner recovery |
| `sites.ts` | Create, list, update, delete and claim sites; settings; access checks (`getSiteFor`) |
| `deploys.ts` | Manifest validation, content-addressed upload, atomic finalize, versions, restore, read-back |
| `publish.ts` | One-shot publish (multipart, JSON, zip, raw) built on `deploys.ts` |
| `sources.ts` | Agent file sources (`content`, base64, `url` with an SSRF guard, `sha256` + upload links, `copyFrom`), `publishSources`, partial `updateSiteFiles`, `finalizeVersionByRef` |
| `site-ops.ts` | Site refs (slug, id or URL), version refs (`live`, `v3`, `3`, id), rename, access modes, paged file reads, `confirm` checks |
| `idempotency.ts` | Atomic D1 idempotency claims (24 h): replay the first result, 422 on a reused key with another body, retryable 409 for concurrent/unknown outcomes |
| `upload-tokens.ts` | HMAC upload-only capabilities for the blobs of one pending version, expiring one hour after creation |
| `blobs.ts` | R2 storage at `blobs/<sha256>` (R2 verifies the hash on write), edge cache |
| `live.ts` | `live:<slug>` manifest in KV (D1 fallback, per-isolate 5 s cache); v3 filename maps are prototype-less so legal names like `__proto__` survive |
| `cleanup.ts` | Hourly cron: expire anonymous sites, purge deleted sites, drop stale uploads, delete orphan blobs |
| `events.ts` | Runs hooks and metering after the response (never throws) |
| `transfers.ts` | Sender-owned deliveries: create/read/update/revoke, revision fencing and permanent slug reservations |
| `transfer-downloads.ts` | Live D1 download gates, digest-bound unlock grants, per-IP/transfer unlock budgets, range and recipient accounting |
| `transfer-cleanup.ts` | Idempotent expiry and live hold-fenced manifest purge, separate from owner readability |

The registry operations (`packages/server/src/operations/`) only parse input,
call a service and shape JSON. **The MCP server and the CLI's server side must call
the same services**, never the REST API over HTTP, so permissions, limits and
errors are identical everywhere.

## Request flow

```
fetch(request)
  -> createDropway builds dw (config cached per env, adapters, hooks, waitUntil)
  -> routeSiteRequest(dw, request)
       site      -> serveSite()       (packages/server/src/serve.ts)
       redirect  -> 301/307           (trailing slash, other origin, Referer fallback)
       app       -> Hono app: /api/v1/* (identity adapter resolves the principal),
                    /, /openapi.json, /llms.txt, /llms-full.txt, /skill.md, /connect(.md),
                    /.well-known/*, /robots.txt, /claim, /mcp, UI pages
```

### Where sites are served (config `SITES_MODE`)

| Mode | Site URL | Isolation |
|---|---|---|
| `subdomain` | `https://<slug>.<SITES_DOMAIN>/` | Each site its own origin. Recommended once a domain exists |
| `path` + `SITES_ORIGIN` | `<SITES_ORIGIN>/<slug>/` (second Worker deployment, same code) | Sites share one origin, separate from the app. By default (`SITES_SANDBOX=auto`) only anonymous sites are sandboxed; `true` sandboxes every site, `false` none |
| `path` (self-host default) | `<APP_ORIGIN>/s/<slug>/` | Shares the app origin, so always served with a CSP `sandbox` (opaque origin: no cookies, storage or service workers) |

Path mode is interim. Root-relative URLs (`/assets/app.js`) would escape the
`/<slug>/` prefix, so:

1. HTML and CSS are rewritten on the way out (`path-rewrite.ts`, streaming
   `HTMLRewriter`): `/x` becomes `/s/<slug>/x`. `?raw=1` returns the stored bytes.
2. Anything left (URLs built in JavaScript) is resolved by the `Referer`: if the
   referring page belongs to site X and X has the file, the request gets a 307
   to X's URL.
3. Sandboxed pages have an opaque origin and browsers send them no `Referer`
   at all, whatever the `Referrer-Policy` (measured in Chrome 151), so (2) cannot
   work there. Instead their HTML gets a small inline script at the top of
   `<head>` (`path-shim.ts`) that applies the rule of (1) in the browser:
   root-relative URLs passed to `fetch`, `Request`, `XMLHttpRequest`,
   `EventSource`, `sendBeacon`, `window.open`, element URL properties,
   `setAttribute` and elements inserted later get the site prefix. Not covered:
   import specifiers, CSS set from JS, `location.href = "/x"` and
   `history.pushState("/x")`. Use relative URLs there, or subdomain mode.

### Viewing files

`serveFile` asks `findViewer(file, live, viewers, mode)` (`packages/server/src/viewers`)
for a rendered view. The mode comes from the request:

| Request | Mode | What it gets |
|---|---|---|
| Top-level navigation (`Sec-Fetch-Dest: document`, or `Accept: text/html`) | `document` | The view for the file's kind; HTML is served as the page itself; binaries download |
| Navigation inside an `<iframe>` | `frame` | Same, except images, PDFs, video and audio get raw bytes, so a site embedding its own PDF keeps working |
| `?view=1` | `view` | Always a view when one exists: HTML gets the viewer frame (bar + page in an iframe), binaries an info page |
| `?view=source` | `source` | Highlighted source of any text file, HTML and SVG included |
| `fetch()`, `<img>`, `<script>`... | none | Raw bytes, always |

`?raw=1` returns the stored bytes (text types as `text/plain`), `?download=1`
downloads, `&embed=1` drops the viewer bar (the app-origin viewer frames views
and has its own toolbar).

Every view shares one bar (`viewers/chrome.ts`: kind, path, size, type; view
tabs; Download; Files) built from plain links, so it works with JavaScript off.
View pages get `VIEWER_CSP` (no scripts). The code view adds one static inline
script (Copy, `#L10-L20` ranges) allowed by its SHA-256 hash, which stays valid
across 304 responses, unlike a nonce. User markup (Markdown, notebook HTML)
goes through `viewers/sanitize.ts`, an allowlist sanitizer on `HTMLRewriter`.
Expensive output (highlighting, Markdown, JSON trees, CSV tables) is cached by
content in `viewers/cache.ts` (`render/<viewer>@<version>/<variant>/<sha256>`:
isolate memory, then the Cache API).

Syntax highlighting is highlight.js core plus about 80 languages registered in
`viewers/hljs.js` (about 106 KB gzipped). That file is plain JavaScript with
its own `hljs.d.ts` because highlight.js's types pull in the DOM lib.

ZIP navigations, frames and `?view=1` list central-directory metadata only: paths,
uncompressed sizes and compression methods in central-directory order, with totals
for every entry and at most the first 1,000 rows. Archives over 2 MiB, invalid ZIPs,
ZIP64/split ZIPs and non-ZIP archives get the binary info page with an explanation.
No entry is inflated, extracted or linked, and entry contents are not verified.
The ZIP fragment uses `archive@<version>/<sha256>`; bump the viewer version when
its parser or output changes to invalidate both fragments and HTTP validators.
Raw/download and sub-resource requests still serve the original complete bytes.

**To add a viewer:** create `packages/server/src/viewers/<name>.ts` exporting a
`Viewer` (`id`, `version`, `maxBytes`, `matches(file, live, mode)`, `render(vc)`),
match on `file.kind` (from `detectFileKind` in `@dropway/core`) and the mode,
wrap the body with `viewerPage()` from `viewers/chrome.ts`, and add it to
`VIEWERS` in `viewers/index.ts` before the code/binary fallbacks. Embedding apps
pass extra viewers in `createDropway({ viewers })`; they run first.

### App-origin UI (`packages/server/src/ui`)

| Path | Page |
|---|---|
| `/` | Home: what this instance is, publish from the browser, curl/CLI/MCP snippets (`uiSlots.landing` replaces it) |
| `/login` | Sign in with an API key; first-run setup and owner recovery with the bootstrap secret |
| `/dashboard` | Sites |
| `/dashboard/sites/:slug` | Versions (restore, delete), files of any version (view, download), settings, delete |
| `/dashboard/publish` | Drag-and-drop publish: folder, files or a zip |
| `/dashboard/keys` | Create and revoke scoped API keys |
| `/dashboard/settings` | Account, members, instance configuration, `uiSlots.settingsSections` |
| `/v/:slug/*path` (`/view/...` redirects) | File browser: tree, view tabs, and the file in a sandboxed iframe on the sites origin. The tree combines a case-insensitive path filter with the manifest file kind (All by default); the count covers loaded files only, matching ancestors stay discoverable, and Clear restores All plus an empty path filter without changing the displayed file |

Pages are server-rendered shells. One first-party script,
`/__dropway/ui/app-<hash>.js`, fills in data from the public REST API, using the
API key the person signed in with (sessionStorage, or localStorage when they tick
"keep me signed in"; no cookies). The script is the source text of
`dropwayClient()` in `ui/client.ts`, so there is no build step and nothing for an
embedding app to configure. Keep that function self-contained and build DOM with
its `h()` helper, never `innerHTML`.

App pages use `appScriptCsp()`: scripts from `'self'` only, frames, images and
`connect-src` limited to this origin and the sites origin, `frame-ancestors 'none'`.
The dashboard never renders user content on the app origin: files open in an
iframe on the sites origin (with `allow-same-origin` only when that origin is
not the app origin), and downloads go through a forced-download blob.

Drag-and-drop publishing hashes files in the browser (SHA-256), sends the
manifest to `POST /api/v1/sites/:slug/deploys`, uploads only the blobs the
server reports missing (4 at a time, retried on 429/5xx), then finalizes. A
single `.zip` goes to `POST /api/v1/publish` instead. `.git/`, `node_modules/`,
`.env*` and OS clutter are skipped and listed. Before publishing, the browser
shows a review of every included path with its byte size and every excluded
path with its ignore reason. The review has a literal case-insensitive path
search, an All/Included/Excluded visibility switch and Path/Size ordering;
these only change the display, and every included file is still uploaded.
Path order is ascending code-unit order; Size orders included bytes descending
with Path order breaking ties; exclusions always stay Path-ordered after the
included group, and an unreadable exclusion keeps its "unreadable" note
instead of a guessed size. Clear restores the full review in Path order.
Unreadable paths covered by those same ignore rules
remain excluded (an unreadable folder's contents are not listed); other read
failures block publishing until the selection is reselected. The displayed
selection stays bound to the in-flight publish.

## Data model (D1, `packages/core/migrations`)

- `tenants`: exactly one in this build (created by `POST /api/v1/setup`).
- `members`: owner / admin / member of a tenant; `external_ref` links an outer identity system.
- `api_keys`: SHA-256 of the key, `scopes` (`sites:read sites:write sites:delete keys:write members:write data:write secrets:write admin`), optional `site_id` restriction.
- `sites`: `tenant_id` NULL = anonymous (then `claim_token_hash`, `expires_at`).
- `versions`: immutable manifests; `status` pending|ready; `manifest_hash` (identical republish = `unchanged`); `base_version_id` (409 `version_conflict`).
- `version_files`: path -> sha256, size, content type.
- `blobs` + `blob_scopes`: bytes exist once in R2; a scope (`t:<tenant>` or `s:<anonymous site>`) skips an upload only for bytes it has proven it holds, so dedupe never reveals another owner's files.
- `usage_counters`: active owned sites and unique bytes in ordinary sites' ready versions, plus each transfer's reserved bytes until purge (including deleted or held deliveries). Lifecycle transactions refresh counters; transfer insert/purge triggers preserve their retention charge. `recomputeUsage(dc, tenantId)` repairs drift; the midnight cron emits one `storage_snapshot` per tenant. Ordinary pending manifests are not charged; a transfer reserves its bytes before its initial deploy, so that deploy's `newBytes` is zero. `0003_scopes_usage.sql` extends the table from `0002_transfers.sql` without rewriting the applied migration.

- `idempotency_keys` (`0005_publish_idempotency.sql`): authorization/operation/key
  hashes, request hashes, an owner fence and the first result. D1 arbitrates
  concurrent claims; failed operations release only their own pending claim.
  Unknown outcomes fail closed until the 24-hour key expiry, rather than stealing
  a live or interrupted operation's claim. Anonymous JSON publishing uses an
  IP-scoped key (no replay when the IP is unavailable), so clients must choose
  unpredictable keys and not share them with others behind the same network.
  Hourly cleanup deletes at most 500 expired records per invocation, oldest expiry
  first, including pending records; future-expiry owners and results remain intact.
  Large replay responses use bounded `idempotency_result_chunks` rows (migration
  `0006`), committed atomically with the owner-fenced completion. Small results
  remain inline and existing records still replay. Chunk boundaries preserve UTF-16
  surrogate pairs; each row stays below D1's 2 MB value/row limit. Parent deletion
  cascades to payload rows; reclaiming an expired key removes the previous owner's
  chunks. A persistence failure preserves the successful mutation's response and
  leaves its claim pending (unknown replay outcome), without logging result secrets.

Never edit an applied migration; add `000N_*.sql`. Extensions keep their own
tables in their own migrations or their own D1 database.

## Extension points: `createDropway(options)`

`@dropway/server` exports `EXTENSION_API_VERSION = 4` for this public embedding
contract. Update it and the Extension API section in `CHANGELOG.md` when changing
the contract. `test/extension-contract.test.ts` exercises every existing extension
point with fake adapters and real emulated D1/R2/KV bindings; it runs in public CI.

```ts
import { createDropway } from "@dropway/server";

export default createDropway({
  config: { multiTenant: true },               // or (env) => ({ ... }); overrides vars
  adapters: {
    identity,   // resolve(request, dw) -> Principal (sessions, OAuth, tenant selection...)
    policy,     // limits; capability; quota; beforeOperation; beforeCreateSite; beforeDeploy (with newBytes)
    metering,   // record(UsageEvent, dw), called after the response; default no-op
  },
  hooks: [{ onPublish, onDelete, onRequest }], // after the response; errors are logged only
  apiMiddleware: [/* Hono middleware on /api/*, after the principal is resolved */],
  routes: [({ api, app }) => { api.get("/extra", handler); }], // registered BEFORE core routes (can override)
  operations: [/* defineOperation: zod input/output, service handler, REST path, MCP and CLI metadata */],
  mcpTools: [/* compatibility escape hatch: MCP-only tools, or replacement by name */],
  mcp: createMcpEndpoint({ name, instructions }), // optional: the default endpoint is mounted at /mcp already
  uiSlots: { navItems: [], pages: [{ path, title, nav, handler }], landing, headHtml, banner, settingsSections, session },
  viewers: [/* extra viewers, tried before core ones */],
  scheduled: async (dw, controller) => { /* extra cron work */ },
});
```

`dropway.context(env, ctx)` builds a `DropwayContext` outside a request (queue
consumers, scripts, tests). Inside routes, use `c.get("dw")` and
`c.get("principal")`.

### Publish credentials (version 4)

`Principal` includes `{ kind: "upload", versionId, expiresAt, ip }`. It authorizes
only `upload_blob`, never reads, publish or finalize. The default identity adapter
accepts dwu_ credentials only on blob upload URLs; the service independently checks
pending state, deletion, expiry and exact manifest membership on every upload.
`DropwayConfig.urlFetchMaxBytes` (or `URL_FETCH_MAX_BYTES`) limits URL sources;
per-file and one-shot limits still apply. Concurrent URL bodies debit one shared
one-shot budget as each chunk arrives, before buffering it; a refusal cancels all
sibling fetches and readers. Embedding Workers must retain
`global_fetch_strictly_public` in their compatibility flags: hostname-string
validation alone cannot prevent DNS-pointed private targets or rebinding. Custom
fetchers are trusted deployment code and must enforce the same network boundary.

### Atomic mutation extensions (version 2)

`@dropway/core` exports `AtomicWriteExtension` (`statements: readonly
D1PreparedStatement[]`, optional `mapError(error): ApiError | undefined`) and
`SiteNameMutation` (`operation: "create" | "rename"`, `siteId`, `tenantId`,
`slug`, `previousSlug`). The optional
`PolicyAdapter.siteNameMutation(principal, input, dc)` prepares an extension,
synchronously or asynchronously, for each concrete name acquisition:

- Create runs existing authorization, validation, legacy `beforeCreateSite` and
  `CreateSiteOptions.beforeInsert` first. The legacy preflight runs once, with
  the requested canonical slug or null; it is **not an atomic allocation guard**.
  The new callback receives each actual generated or explicit slug, the new
  site id/tenant and `previousSlug: null`, never claim/password secrets.
- Rename runs existing member/scope/isolation checks and canonical validation
  first. A canonical no-op skips preparation. Otherwise the callback receives
  the loaded identity, new slug and `previousSlug`. REST and MCP share this
  service. A concurrent rename, ownership change or deletion during preparation
  fails with 409 `site_changed`, before extension writes can commit. Core uses a
  schema-free SQL assertion (lazy CASE with a tagged invalid JSON path on the
  stale branch) and fenced UPDATE in the same batch, not an after-commit check.
- Core SQL runs first, then extension SQL, sequentially in **one**
  `dc.env.DB.batch` per attempt. D1 rolls back the whole batch on SQL failure,
  including earlier extension statements. Metering and rename cache changes
  happen only after success. Refused renames leave the old live URL/cache intact;
  accepted renames invalidate the old name and refresh the new one, no redirects.

Preparation is **outside** the transaction. It may build statements or throw,
but must not independently write or perform irreversible effects expecting core
rollback. Statements must be prepared on the **same `dc.env.DB`**. This is a
trusted embedding API, not a sandbox for untrusted SQL. It makes no atomicity
claim across databases, KV, R2, network calls, or a later deployment.

Refusal must be a **SQL failure/constraint inside the batch**. A SELECT returning
false, INSERT selecting zero rows, or JavaScript inspecting batch results after
commit cannot refuse/undo the mutation. `mapError` translates only recognized
SQL failures; undefined preserves the original error. Preparation-thrown
`ApiError`s preserve status/code/hint directly and through REST; MCP retains its
existing `isError`/code/message/hint format (no numeric status field).

Core's precise `sites.slug` UNIQUE constraint keeps 409 `slug_taken` and its
existing explicit-name hint. Extension mappers can deliberately return 409
`slug_taken` for their competing allocation. Only that exact status/code is a
generated-name retry, including when thrown by the new callback: six attempts,
then 503 `slug_generation_failed`. Unrelated UNIQUE errors are not collisions;
other errors propagate without retry. Explicit names never retry. Rolled-back
candidates leave no site/extension rows or creation events; only the winner emits
`site_created`.

For example, an embedding app can own a constraint-backed allocation table in
its **own** same-D1 migration (these are not core tables):

```sql
CREATE TABLE extension_names (
  slug TEXT PRIMARY KEY,
  site_id TEXT UNIQUE REFERENCES sites(id)
);
-- External writers reserve a name with site_id NULL. They must also refuse
-- names already owned by a site, inside their transaction, in this direction.
CREATE TRIGGER extension_external_name BEFORE INSERT ON extension_names
WHEN NEW.site_id IS NULL BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM sites WHERE slug = NEW.slug AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'extension_name_conflict') END;
END;
```

```ts
import { ApiError, defaultPolicy, type PolicyAdapter } from "@dropway/core";

const policy: PolicyAdapter = {
  ...defaultPolicy,
  siteNameMutation(_principal, input, dc) {
    return {
      statements: [
        // Release this site's previous allocation on rename, atomically.
        dc.env.DB.prepare("DELETE FROM extension_names WHERE site_id = ?")
          .bind(input.siteId),
        dc.env.DB.prepare("INSERT INTO extension_names (slug, site_id) VALUES (?, ?)")
          .bind(input.slug, input.siteId),
      ],
      mapError(error) {
        if (/\bUNIQUE constraint failed: extension_names\.slug(?=:|$)/.test(String(error))) {
          return new ApiError(409, "slug_taken", "The name is allocated.", "Choose another name.");
        }
        return undefined;
      },
    };
  },
};
```

The UNIQUE constraint refuses site acquisition if an external allocation won
first; the trigger refuses an external acquisition if the site won first. All
writers must obey the same SQL constraints, not a SELECT-only preflight. The
embedding app also owns allocation release on site deletion; core does not
manage extension-table lifecycle or retention. Real disposable D1 fixtures in
`test/atomic-extensions.acceptance.test.ts` pin both writer orders, rollback,
generated retries, REST/MCP refusals, cache behavior and stale preparation.

`createTenantWithOwner(dc, input, options?)` is a separate low-level exported
service. `CreateTenantWithOwnerInput` accepts optional `tenant: { name? }` and
required `owner: { email?, name?, externalRef? }`; the caller owns admission and
authorization. Core generates fresh ids, fixes the member's role to owner and
its tenant to the new tenant. It reuses `createTenant`/`insertMember` field rules:
120-character names (falsy names become null), unchanged email/externalRef
values (nullish values become null), no new email validation.

`CreateTenantWithOwnerOptions.extend(rows, dc)` optionally prepares an
`AtomicWriteExtension` with readonly tenant/owner rows before any insert. Core
inserts tenant, then owner, then extension SQL in one batch, returning full rows
only after success. Extension SQL can reference the inserted rows, for example:

```ts
const { tenant, owner } = await createTenantWithOwner(dc, {
  tenant: { name: "Example" }, owner: { externalRef: "external-user" },
}, {
  extend({ tenant, owner }, dc) {
    return { statements: [dc.env.DB.prepare(
      "INSERT INTO extension_profiles (tenant_id, owner_id) VALUES (?, ?)",
    ).bind(tenant.id, owner.id)] };
  },
});
```

Here `extension_profiles` belongs to the embedding app's same-D1 schema.
Preparation refusal, owner INSERT failure or extension SQL failure leaves
neither new core row nor earlier extension writes. Existing low-level helpers
remain compatible. `setupInstance` uses this helper without extensions, keeping
its authorization, validation and response; **API key minting remains separate**,
and the single-tenant setup admission race is **not** included in this contract.
No public registration route or core migration is added.

### Where to add things

- **An API operation (core):** service function in `packages/core/src/services`,
  then one `defineOperation()` in the relevant `packages/server/src/operations/`
  family (listed in `core.ts`) with
  Zod input/output schemas, a thin service handler, method/path, scopes,
  description, examples, annotations and optional CLI metadata. REST, OpenAPI,
  MCP and the command table are generated; do not add a second route or tool.
  Raw-byte/bootstrap endpoints have an explicit `mcp.exclude` reason.
  Tests in `test/` enforce registration, metadata and stable tool ordering.
  `npm run openapi:lint` independently validates the generated document in CI.
- **An API operation (extension):** pass `defineOperation()` results through
  `createDropway({ operations })`. Definitions replace by id without reordering;
  each app gets its own registry and generated discovery. See `docs/OPERATIONS.md`.
- **An MCP-only tool (compatibility):** `createDropway({ mcpTools })` remains an
  escape hatch; tools replace by name. Prefer operations for new capabilities.
  The MCP endpoint still resolves identity, enforces scope checks and applies
  idempotency, toolset/read-only filtering and ApiError shaping. See `docs/MCP.md`.
- **Dashboard pages:** register through `uiSlots.pages` (with `nav: true` for a
  navigation link) and render them with `renderAppPage(c, { title, page, body })`
  from `@dropway/server`, which adds the dashboard frame, navigation, banner and
  CSP. `uiSlots.banner` shows a notice above every app page;
  `uiSlots.settingsSections` adds sections to `/dashboard/settings`.
  `uiSlots.session = { signInPath, signOutPath }` tells the dashboard that the
  embedding app signs people in with cookie sessions (its identity adapter must
  resolve them for `/api/v1` and refuse cross-origin writes). App cookies must use
  `__Host-` names; cookie-authenticated state-changing requests require both exact
  app `Origin` and `Sec-Fetch-Site: same-origin`, not just `SameSite` cookies.
  API-key sign-in at `/login` keeps working and issues no app cookie. The R-15
  tests pin the current bearer-only and site-cookie surfaces; real app-cookie
  issuance and authenticated-write integration tests remain deferred / not run
  until R-21, before session activation. Embedding-cookie activation likewise
  requires those real integration tests; the current tests are not approval.
  Never render user content on the app origin.
- **CLI:** `packages/cli` talks to the REST API (it runs on users' machines). The upload protocol
  (`src/publish.ts`, `src/client.ts`) uses only `fetch`, so `test/cli-publish.test.ts` runs it against
  the real Worker inside workerd; `packages/cli/test` covers the rest, end to end against a local Worker.
  A new REST endpoint usually needs no CLI change: `kofra api <METHOD> <path>` reaches it.

## Conventions

- TypeScript strict, `verbatimModuleSyntax`; packages export TypeScript source
  (bundled by wrangler/esbuild and vite), no build step.
- Errors: `ApiError(status, code, message, hint, details)`; codes are snake_case
  and stable; hints say what to do next.
- No SaaS concepts in this repo: no plans, prices, billing, quotas beyond
  admin-set config, and no signup. Those belong to a layer built on the
  extension points.
- Tests: `npm test` (runs in workerd with real D1/R2/KV emulation). `npm run typecheck`.

## Deploying

- Self-host: Deploy to Cloudflare button, or `npm run deploy` (see `docs/SELF_HOST.md`).
- Maintainers: the root `wrangler.jsonc` is the self-host template. Do not deploy
  it to an account that runs a hosted Kofra: its worker and resource names
  (`dropway`, `dropway-files`) may collide. Use a separate config for test instances.
