# Changelog

## Unreleased

### Static hosting correctness and site lifecycle

- Root `_redirects` (301/302/307/308, `:placeholders`, one trailing `*`
  splat) and `_headers` (path patterns) are parsed at finalize into the
  version's `config_json` (migration 0007). Invalid lines are skipped and
  returned as `invalid_hosting_rule` warnings; the files themselves are never
  served. Platform-owned headers cannot be set from `_headers`, and platform
  security headers are applied after (and win over) site headers. Restoring
  or duplicating a version carries its rules with its files.
- The cache policy is now the full matrix: gated sites `private, no-store`;
  sites shipping `.wasm` revalidate; fingerprinted build outputs immutable;
  HTML and unfingerprinted files revalidate. A `_headers` `Cache-Control`
  overrides the non-gated classes.
- Site settings gain `noindex` (X-Robots-Tag plus a generated disallowing
  `robots.txt` when the site ships none; a site's own `robots.txt` is served
  verbatim), `viewers: false` (always serve the stored bytes), and
  `ttlSeconds` for keyed sites: the site expires that long after its latest
  finalize, and `null` clears the lifetime. Anonymous sites keep the
  instance expiry and cannot set `ttlSeconds` (an explicit `null` is
  ignored; 400 `invalid_ttl` for values outside 1 to 315360000). Expiry of a
  keyed site refreshes the owner's usage counters, `_redirects`/`_headers` never
  count as the single served file or appear in folder listings, and
  `Service-Worker-Allowed` is platform-owned.

### Sites

- Every site serves an embeddable live-version badge at `<site URL>badge.svg` (path and
  subdomain mode): a flat SVG with the live version and a coarse age for public sites, and one
  identical generic image for passworded, expired, deleted, transfer, missing and renamed-away
  sites. The dashboard site page shows the Markdown snippet for public sites. It reads the cached
  live manifest (now version 4, which also carries the live version number and time; cached v3
  entries rebuild from D1 on first read) and is not recorded as a site request. `badge.svg` at a
  site root is reserved. See `docs/SITE_BADGE.md`.

### Dashboard

- The selected-version file table now announces matching-vs-loaded file counts
  and the matching byte total as you filter by path. A version with files but
  no matches shows a distinct no-match message with a Clear filter action
  (instead of a blank table), while a genuinely empty manifest stays labelled
  as empty. Clearing resets only the query, keeps the selected version and
  sort, and returns focus to the filter.

### Path-mode hardening and publish warnings (R-12)

- Publish and finalize return warnings with `fix` text (and `path`/`line` where known),
  computed from the stored bytes over a bounded scan: `root_absolute_paths` (path mode),
  `spa_without_base`, `uses_browser_storage` (when the site will be sandboxed),
  `wasm_without_coi` (renamed from `wasm_without_cross_origin_isolation`),
  `possible_secret` (file and line; matched values are never included) and
  `invalid_config` (a `.dropway/*.json` file that is not valid JSON). `no_index` now
  carries fix text too. Replayed finalizes and unchanged republishes (including
  file-source REST/MCP publishes and updates) return the same warnings instead of an
  empty list. Advisory database-read failures return no warnings without failing a
  successful publication; bounded blob reads run concurrently in deterministic order.
- A page navigation with a same-origin `Referer` inside an SPA site to a path the site
  lacks now 307-redirects to that path inside the site (SRV-02), where the SPA fallback
  serves it; app routes, paths with a file extension and sub-resource requests are
  untouched. On a separate sites origin, existing destination sites (even empty or
  expired), renamed-away slugs (their 308 redirect) and version addresses keep their
  own routing instead of being captured by the referring SPA.
- Publishing a path under `__dropway/` is refused with the new `reserved_path` error on
  every publish path (the manifest, one-shot and file-source flows share the check).
- `.dropway` and `.dropway/*` files are stored with the version (owner read-back works)
  but are never served from the sites origin, including through the single-file root
  shortcut, and no longer appear in folder listings. A directory holding only private
  entries answers 404 instead of an empty listing or a redirect.

### Versions naming

- Version creation and finalize move under `/versions`
  (`POST /api/v1/sites/{slug}/versions` and `POST .../versions/{id}/finalize`).
  The historical `/deploys` paths keep working as aliases with the same bodies
  and responses (plus additive `version` and `links` fields on manifest
  results). REST version references accept `live`, `vN`, `N` or an id, as the
  tools already did.
- `get_version` now returns `upload`/`uploads` with fresh upload items for
  pending versions (dwu_ tokens only for keys that may write the site), and
  missing-blob finalize errors carry a true `totalMissing` count.

### Publish v2

- REST JSON publishing now uses the same flat file sources as MCP: content,
  public HTTPS URLs, SHA-256/size and copyFrom. Results carry status, an owner
  dashboard versionUrl, file counters, warnings and next calls. Multipart, ZIP
  and raw-body responses remain compatible; JSON retains slug, unchanged and
  anonymous claimToken aliases.
- Missing bytes get ready curl commands and HMAC-signed dwu_ upload capabilities
  scoped to one pending version for one hour. They cannot read files, publish
  or finalize versions, and stop working after the version is finalized/deleted.
- D1 atomically claims authorization-scoped idempotency keys for JSON publishing
  and existing keyed operations: replay equal input, reject changed input with
  422 and concurrent duplicates with retryable 409. Migration 0005 adds the
  records; interrupted calls with an unknown outcome retain their claim until
  the 24-hour expiry rather than risking a duplicate side effect. Anonymous JSON
  publishing replays the first claim credential within its client-IP/key scope;
  without a client IP replay is disabled. Use unpredictable keys, not shared names.
- URL sources retain caller headers on same-origin redirects only, permanently
  dropping all caller headers after a cross-origin hop. Raw file reads accept
  site ids as well as slugs, including when authenticated by a claim token.
- Enforce decoded inline caps per file/call (UTF-8: 1/4 MiB; base64: 256 KiB/1 MiB)
  with CLI/upload-links remediation. URL_FETCH_MAX_BYTES configures URL sources
  (default 100 MiB; file and one-shot caps still apply). The MCP wire cap is 8 MiB
  so requests just above the decoded inline budget get actionable tool errors.
- Migration 0006 stores large replay results in bounded D1 rows, atomically with
  completion. Expiry cleanup and key reclaim retire their payload chunks; replay
  preserves the entire original response, including Unicode paths and upload links.
- Charge URL chunks to one shared streaming budget and cancel sibling fetches on
  refusal, rather than buffering whole bodies before enforcing the one-shot cap.
- Pinned dashboard version links load pending and older versions by immutable id,
  independently of the newest-100 ready-version history page.

### Typed client and npm packages

- New `@dropway/client`: a zero-dependency typed REST client generated from the
  operation registry (`npm run client:generate`; CI fails when it is stale).
  Every operation gets an input/output interface and a method; raw-byte
  operations upload and download bytes. Failures throw `DropwayError` with the
  server's stable code, hint, details, status and retryability.
- The `kofra` CLI's transport builds on `@dropway/client` (bundled into `dist/`,
  so the installed CLI still has no runtime dependencies); exit codes and error
  output are unchanged.
- `.github/workflows/publish.yml` publishes `@dropway/core`, `@dropway/server`,
  `@dropway/client` and `kofra` with npm trusted publishing (OIDC, no tokens)
  on `v*` tags. Operator to-do: register each package name as a trusted
  publisher on npmjs.com first.

### Error envelope v2

- Add retryable, retryAfterSeconds, docs and structured next calls to ApiError,
  REST and both MCP protocol lanes, retaining existing constructor calls and fields.
  HTTP 429/503 always include Retry-After; omitted delays default to one second.
- Report every malformed manifest field and MCP argument together in details.fields.
  Version conflicts identify the live version id, number, client and publication
  time (epoch milliseconds), with a get_site call to begin reconciliation.
- Publish the built-in catalog at /docs/errors and /docs/errors.md, and use it in
  discovery. Generate docs/errors.md with npm run errors:sync; npm run check
  rejects stale output. Extension-specific error codes remain supported.
- No server embedding option or extension signature changes; the extension API
  remains version 3 after the file-delivery additions below. ApiError's optional
  sixth argument supplies metadata.

### Renamed: Dropway is now Kofra

- User-visible names: product name, docs, UI copy, the default `INSTANCE_NAME` (`Kofra`), the CLI
  command `kofra` (the `dropway` command stays as an alias), environment variables `KOFRA_*`,
  response and request headers `X-Kofra-*`, the Agent Skill and MCP server name `kofra`.
- Still accepted: `DROPWAY_*` variables (a `KOFRA_*` variable wins), `X-Dropway-*` request headers,
  and the skill URLs under `dropway`. Responses send every `X-Kofra-*` header as `X-Dropway-*` too.
- Unchanged on purpose: Worker, D1, R2, KV and Analytics names, database tables, cookie and storage
  names, reserved paths (`/__dropway/`), CLI files (`dropway.json`, `.dropwayignore`,
  `~/.config/dropway`), the `@dropway/*` workspace packages and `createDropway()`.
- `scripts/rebrand.mjs` applies the rename and can be re-run after a rebase.

### Moving the app to a new origin

- `LEGACY_APP_ORIGINS` (and `LEGACY_DEPRECATED_AT`): former app origins keep serving the REST API,
  MCP, `/health`, `/.well-known/*` and the agent documents with `Deprecation` and
  `Link: rel="successor-version"` headers, and never redirect them (clients drop `Authorization` on
  cross-origin redirects). Other `GET`/`HEAD` requests 308 to `APP_ORIGIN`, uncached, with
  `Access-Control-Allow-Origin: *` so cross-origin reads of published files follow the redirect.
  New config fields `legacyAppOrigins` and `legacyDeprecatedAt`.
- The CLI notes once per run when an instance answers with those headers, naming the new address.
- The product name comes from `INSTANCE_NAME` in the served skill (heading, description, homepage),
  both skills indexes and the MCP server instructions. The skill's `name` does not follow
  `INSTANCE_NAME` (it is `kofra` after the rename above).

### File deliveries

- Add `create_transfer`, `get_transfer`, `update_transfer` and `revoke_transfers` to
  the operation registry. `dropway api <operationId> --data ...` now uses the
  advertised operation instead of treating its name as a URL.
- Transfer messages and password forms stay on the app origin; immutable files
  download from a separate sites host, with attachment, nosniff and no-store headers.
  Password grants expire after 15 minutes and are bound to the current digest.
- Add sender-owned slug reservations, per-file and recipient counts, conditional
  lifecycle mutations, hourly expiry claims and held-byte retention. Revocation
  does not release storage; manifest purge does, once, after a 24-hour retention.
- `TRANSFER_MAX_EXPIRY_DAYS` defaults to 30 and is capped at 3,650. Policy adapters
  may lower it. Transfer creation is refused without an isolated sites origin.
- MCP discovery uses operation summaries to preserve the tool inventory budget;
  full descriptions remain in OpenAPI and the full agent reference.

### Scopes, policy and usage

- Add `sites:delete`, `data:write`, `secrets:write` and `admin`. Owners/admins may hold
  every scope; members may hold read/write/delete, key management and data write.
  Migration `0003_scopes_usage.sql` gives existing write keys deletion permission;
  newly minted write-only keys cannot delete sites, versions or folders.
- Export `CAPABILITIES`, `QUOTA_KEYS` and optional policy `capability`, `quota` and
  `beforeOperation` hooks. Missing bindings remain unavailable even when an adapter
  allows a capability. Password create/update preserves an adapter's exact error.
- Add admin `QUOTA_*` configuration (`null`/unset = unlimited, `0` = no new resource).
  Sites and unique finalized storage are enforced on create/deploy/claim, with
  transaction-local quota checks at creation, claim and finalize.
- Reject inconsistent per-hash manifest sizes and reuse sizes that disagree with
  the caller's verified bytes, before recording a version. Accounting uses verified
  blob sizes when available, without exposing another tenant's storage.
- Add retry-safe `usage_counters`, `recomputeUsage()` and nightly attributed
  `storage_snapshot` metering. Pending uploads do not count; retained ready versions
  do, with a shared hash charged once per tenant until its last active reference is removed.
- REST and MCP `whoami` include capability decisions, size/resource limits and usage.
  Add `delete_folder` to the registry; deleting an organizer keeps its sites.

### Extension API

- Add optional `LiveSite.noindex`, `LiveSite.viewers` and `LiveSite.config`
  (the live version's parsed `_redirects`/`_headers`), optional `noindex`,
  `viewers` and `ttl_seconds` on site rows, optional `config_json` on version
  rows, and the public `@dropway/core` site-config parsers/matchers. Fields
  are additive and optional, so existing viewers, adapters and service
  callers keep working unchanged; `EXTENSION_API_VERSION` stays 4.
- Bump `EXTENSION_API_VERSION` to 4: Principal adds an upload-only variant
  (versionId, expiresAt in epoch milliseconds, ip), and DropwayConfig adds
  urlFetchMaxBytes. Custom identity/policy adapters must keep upload principals
  restricted to blob uploads. Existing member/claim permissions are unchanged.

- Bump `EXTENSION_API_VERSION` to 3. `beforeDeploy` now receives `newBytes`, and
  `deleteVersion(dc, principal, site, versionId)` now enforces deletion permission.
  Config gains `quotas`; REST compatibility adapters validate input before policy
  and may supply `http.parseInput` and a logical `http.policyId`. Raw publishing
  uses `publish_site` for policy on both transports, after parsing and before writes.
  Generated MCP tools also recheck authorization/capability/policy before exposing
  cached results via the optional `beforeReplay` tool guard; no handler is rerun.
- Add optional `Limits.transferMaxExpiryDays`, `DropwayHooks.onEvent` for transfer
  lifecycle events, public transfer services and transfer expiry/purge counts in
  `CleanupReport`. Existing adapters keep working; omitted delivery limits use
  the instance ceiling.
- Extend the version 2 contract with public core
  `AtomicWriteExtension`, `SiteNameMutation` and optional
  `PolicyAdapter.siteNameMutation`: every concrete site create/rename candidate
  composes core and extension SQL in one same-D1 batch. SQL refusal rolls back
  all statements; only precise 409 `slug_taken` conflicts retry generated names.
  Legacy `beforeCreateSite` remains a non-atomic, once-per-create preflight.
- Fence rename identity/previous name inside its batch; stale preparation fails
  with 409 `site_changed`, without extension residue or cache changes.
- Export `createTenantWithOwner`, `CreateTenantWithOwnerInput` and
  `CreateTenantWithOwnerOptions` for low-level atomic tenant/owner/extension SQL.
  Existing helpers retain field rules; setup uses the new helper. Key minting,
  setup admission races and cross-database/storage/network effects are excluded.
- Pin the additive types, deterministic competing-writer/rollback/cache behavior
  and version in independent disposable workerd/D1 acceptance tests. No core
  schema changes or additional public routes.
- Bump `EXTENSION_API_VERSION` to 2: add `defineOperation()`, typed operation
  definitions/contexts, `createDropway({ operations })` and `dropway.operations`.
  Operation input/output schemas drive REST validation, OpenAPI 3.1, MCP tools,
  CLI command metadata and instance-local discovery documents. Existing route
  and MCP-tool extension escape hatches remain available.
- Keep pre-registry REST payloads, status codes, raw streaming and paths through
  explicit transport adapters. Model-friendly JSON publishing and file reading
  are also available at `/api/v1/publish-sources` and `/api/v1/read-file`.
- Add public `GET /api/v1/operations` and Redocly validation in CI, including
  required summaries, descriptions, examples and JSON error responses.
- Enforce declared authorization before custom HTTP adapters; explicitly retain
  bootstrap setup/recovery and anonymous publishing. Decode numeric/boolean URL
  scalars, including nullable fields, without letting JSON override path resources.
- Bound JSON metadata bodies before parsing (8 MiB default, configurable per
  generated operation), cancel oversized streams and reject raw-body automatic
  replay definitions that cannot distinguish changed bytes. Preserve Hono body
  inspection by API middleware, rechecking cached bodies against the JSON budget.
- Partition member idempotency replay by credential and current authorization,
  including tenant/site restrictions, role and scopes. Older member records
  expire unused; retries spanning the upgrade may execute again.

- Introduced `EXTENSION_API_VERSION` in `@dropway/server` at version 1.
  Extension API changes must update this version and this section.
- Cover existing identity, policy limits and refusals, all five metering events,
  all three hooks, API middleware, route overrides and app routes, contexts,
  MCP tools and endpoint replacement, UI slots, viewers and scheduled work in
  `test/extension-contract.test.ts`, using fake adapters and real emulated storage.

### Subdomain mode hardening

- `LEGACY_SITES_ORIGINS` (config `legacySitesOrigins`): a former path-mode sites origin answers
  `<origin>/<slug>/<rest>?q` with `308` to the site's current URL, uncached; absolute paths from an old
  page follow its Referer (`307`). `SiteRoute` redirects may now have status `308`.
- Reserved labels in subdomain mode: `www.<SITES_DOMAIN>` 301s to the app; other reserved or malformed
  labels are never looked up as sites (404). `kofra`, `fallback` and `customers` join `RESERVED_SLUGS`.
- Password gate: `__Host-dw_pw_<slug>` cookie in subdomain mode; a password entered inside a frame
  (the dashboard file viewer, cross-site once sites have their own domain) sets a partitioned
  `SameSite=None` cookie, and the form may be framed by the app origin only (`frame-ancestors`).
- Password-protected responses send no `Access-Control-Allow-Origin` (also on preflights) and
  `Cross-Origin-Resource-Policy: same-origin` (unless sandboxed); non-navigation requests with
  `Sec-Fetch-Site: same-site` or `cross-site` get 403. Public sites are unchanged.
- New site names are at most 56 characters (`MAX_SLUG_LENGTH`), so `<slug>--v<N>` fits one DNS label.
  Existing longer names keep working.

### Open-core guard

- Scan npm shrinkwrap and legacy nested npm dependencies, Yarn, pnpm and Bun
  text lockfiles for excluded SDKs, in addition to modern npm lockfiles. Check
  `npm:` alias targets in manifests and lockfiles as well as dependency names.
  Reject binary `bun.lockb` with instructions to regenerate an auditable text lockfile.

### Link permanence

- A renamed site's old name 308s to the new name (path and query kept, path and
  subdomain modes) until `redirectUntil`, returned by `rename_site` alongside
  `oldSlug`. Rename chains resolve through the current name.
- Deleted and expired names are held for their previous tenant (chosen names 12
  months, generated names 90 days): other tenants get 409 `slug_reserved`, the
  holding tenant may reclaim. Durations are config (`SLUG_REDIRECT_DAYS`,
  `SLUG_HOLD_CHOSEN_DAYS`, `SLUG_HOLD_GENERATED_DAYS`).
- New operation `release_slug` (`POST /api/v1/slugs/release`): an unrestricted
  admin key releases only its tenant's holds, with a required reason kept as the
  audit record. Foreign and ownerless releases require the instance operator's
  audited database procedure, not tenant-grantable API scopes.
- Delete/expiry fence name, ownership and expiry in the transaction; stale
  deletes return `site_changed`, and cleanup skips changed rows. Expired aliases
  never become fresh tombstones; transfer renames never advertise a 308.
- A deleted version's `<slug>--v<N>` answers 410 in both modes, never another
  site's bytes. File deliveries keep their permanent sender-owned reservations.

### CLI discovery

- Add `kofra operations [operationId] [--schema]`: list the instance's public
  operation catalog, or inspect one exact row, without executing anything. Only
  `GET /api/v1/operations` is ever requested; no API key is needed and none is
  sent. Unknown ids fail with exit 4 (`operation_not_found`); `--schema` without
  an id fails with exit 2 before any request.
