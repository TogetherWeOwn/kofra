# Changelog

## Unreleased

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
