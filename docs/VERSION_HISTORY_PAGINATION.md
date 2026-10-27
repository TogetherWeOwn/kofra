# Version history pagination contract (Proposed)

Status: **Proposed — design only.** This document specifies a future contract.
It is not build approval, activation approval, or a promise that any surface
behaves this way today. Nothing here changes current behaviour until a later,
separately approved change implements it and its acceptance tests pass.

Goal: let an agent enumerate a site's full deployment history — more than the
current 500-row cap — without missing or duplicating versions while other
clients publish, finalize or delete versions at the same time, and without
widening any authorization boundary.

## 1. Current contract (verified against source)

- `listVersions` (`packages/core/src/services/deploys.ts:528-534`) returns
  ready versions only, `ORDER BY number DESC`, with `limit` clamped to
  1–500 (default 50). There is no cursor, so versions older than the newest
  500 cannot be enumerated by listing.
- The operation is `list_versions`, `GET /api/v1/sites/{slug}/versions`,
  scope `sites:read`, read-only annotations, MCP tool and CLI table row
  generated from the one registry definition
  (`packages/server/src/operations/core-api.ts:736-813`). The MCP shape is
  `{site, liveVersionId, versions}`; the HTTP shape is
  `{currentVersionId, versions}`. Both shapes are compatibility surface.
- Older versions remain individually addressable: version references accept
  `live`, `v12`, `12` or a version id
  (`packages/core/src/services/site-ops.ts:74-89`), and the CLI resolves a
  single version directly without paging history
  (`packages/cli/src/main.ts:222-238`). Direct lookup is not enumeration.
- `versions` storage (`packages/core/migrations/0001_init.sql:92-109`):
  `id` TEXT primary key, `site_id`, `number` INTEGER with
  `UNIQUE(site_id, number)`, `status` `pending|ready`, `created_at`,
  `finalized_at` (epoch milliseconds). The unique index also serves
  per-site ordered scans by `number`.
- A version number is assigned at insert time, while the version is still
  pending, as `COALESCE(MAX(number), 0) + 1` for the site
  (`deploys.ts:249-250`; the duplicate-site insert at
  `site-ops.ts:216-220` uses the same formula and inserts directly as
  ready). Numbers are therefore unique per site and increase in creation
  order, but they are **not** forever-stable: deleting the current maximum
  number lets a later insert reuse it (deletion is a hard delete of
  non-live versions, `deploys.ts:558-570`).
- Every transition to ready sets `finalized_at`: the finalize update
  (`deploys.ts:468`) and the duplicate insert above. So today
  `status = 'ready'` implies `finalized_at IS NOT NULL`. The future build
  must pin this invariant with a test before relying on it.
- Rows serialize as `{id, number, status, live, fileCount, totalBytes,
  source, client, message, createdAt, finalizedAt}` with ISO timestamps
  (`packages/core/src/services/sites.ts:99-112`). The stable identity of a
  version is `id`; `number` is a per-site display/order key.
- Authorization is resolved per call: the handlers load the site through
  `getSiteByRef`/`getSiteFor`, which answers 404 `site_not_found` when the
  caller cannot read the site (existence is not leaked) and 403
  `insufficient_scope` when the key lacks the scope (`sites.ts:82-93`).
- Existing pagination precedents: `list_sites` uses a keyset cursor
  `(created_at, id)` with a `limit + 1` probe and the stable
  `invalid_cursor` error (`sites.ts:302-356`,
  `packages/core/src/error-codes.ts:17`). That cursor is unsigned, carries
  no snapshot bound and no expiry. The file-list cursor is an offset into
  one version's manifest (`core-api.ts:610-618`); an offset is safe there
  only because a version's manifest is immutable. Version history is
  mutable, so an offset is **not** stable pagination here and this contract
  must not copy that pattern.
- Existing token-signing precedent: upload tokens are `payload.hmac`
  signed with the instance `signingSecret` and expire after one hour
  (`packages/core/src/services/upload-tokens.ts:7-22`,
  `packages/core/src/lib/crypto.ts:72-75`).

## 2. Designs compared (existing storage only)

### Design A — snapshot-bounded number keyset (recommended)

Page through one site's versions by the existing per-site `number`, newest
first, inside a snapshot fixed by the first page:

- Snapshot bounds: `highWaterNumber` = highest `number` assigned on the
  site (any status) when the walk starts, and `asOf` = server time sampled
  before the first page query.
- A row belongs to the walk iff, at the moment its page is read:
  `site_id = :site AND status = 'ready' AND number <= highWaterNumber
  AND finalized_at <= asOf`. Later pages add the keyset predicate
  `(number < :lastNumber OR (number = :lastNumber AND id < :lastId))`.
- Order: `number DESC, id DESC`. `number` is unique per site today; the
  `id` tie-breaker keeps the order total even if that invariant is ever
  weakened. Each page fetches `limit + 1` rows to decide exhaustion.

Strengths: matches the visible order agents already use (`v12` refs, CLI
rollback); served by the existing `versions_site_number` index; no new
storage; high-water + `asOf` exclude concurrent inserts and late
finalizations deterministically, except the one-millisecond boundary in
section 6.

Weaknesses: relies on the `ready ⇒ finalized_at` invariant; number reuse
after deleting the apex version is only fenced by `asOf`, not prevented
(section 6).

### Design B — `(created_at, id)` keyset (mirror of `list_sites`)

Page by creation time with the random id as tie-breaker, as `listSites`
does. Strengths: familiar shape; immune to number reuse. Weaknesses:
changes the enumeration order away from version numbers (a long-pending
version finalized late sorts by creation, not by number, contradicting the
current list order); millisecond `created_at` ties are common under
concurrent publishing and the id tie-break order is meaningless to users;
there is no `(site_id, created_at, id)` index, so each page sorts instead
of walking the number index; a creation-time high-water mark has the same
millisecond boundary problem with none of the `finalized_at` precision
about readiness. Rejected: more churn, weaker fit.

**Recommendation: Design A**, as the smallest bounded contract that reuses
existing storage, the existing index, the existing signing secret and
helpers, and the existing error envelope.

## 3. Proposed contract (Design A)

### 3.1 Request

Additive change to `list_versions` only. No new route, tool or command.

| Input | Type | Rules |
|---|---|---|
| `site` / `slug` | string | Unchanged site reference (slug, site id or URL). |
| `limit` | integer 1–500 | Unchanged; default 50. |
| `cursor` | string, at most 512 characters | Optional. Omit for the first page; afterwards pass the previous page's `nextCursor` unchanged. |

`GET /api/v1/sites/{slug}/versions?limit=50&cursor=<opaque>`; MCP and the
typed client take the same fields as tool/input arguments. This is a
read-only enumeration: there is no mutation and therefore **no dry-run
mode — dry run is N/A** for this operation.

### 3.2 Response (schema version 1)

The `versions` array and each row keep today's shape and order. New fields
are additive so existing clients that ignore them keep working:

```json
{
  "site": "bright-otter-x7k2",
  "liveVersionId": "ver_m4xAMPLE09z",
  "schemaVersion": 1,
  "versions": [
    { "id": "ver_m4xAMPLE09z", "number": 612, "status": "ready", "live": true,
      "fileCount": 12, "totalBytes": 41920, "source": "api", "client": "kofra-cli",
      "message": "release", "createdAt": "2026-10-26T12:00:00.000Z",
      "finalizedAt": "2026-10-26T12:00:01.000Z" }
  ],
  "page": {
    "limit": 50,
    "returned": 50,
    "exhausted": false,
    "snapshot": { "highWaterNumber": 612, "asOf": "2026-10-26T12:00:05.000Z" }
  },
  "nextCursor": "vh1.eyJ2IjoxLCJzaXRlIjoic2l0ZV9leGFtcGxlIiwiaHdtIjo2MTIsImFzT2YiOjE3OTMwMTYwMDUwMDAsImxhc3QiOjU2MywibGFzdElkIjoidmVyX2V4YW1wbGUiLCJleHAiOjE3OTMwMTk2MDUwMDB9.<64 hex chars>"
}
```

The final page (and an empty history) closes the walk:

```json
{ "versions": [], "page": { "limit": 50, "returned": 0, "exhausted": true,
  "snapshot": { "highWaterNumber": 0, "asOf": "2026-10-26T12:00:05.000Z" } },
  "nextCursor": null }
```

Semantics:

- `nextCursor` is non-null exactly when the `limit + 1` probe found one
  more snapshot row; `exhausted` is `nextCursor === null`. Clients stop on
  null and must not fabricate a cursor.
- The first page (no `cursor`) returns exactly the rows today's call
  returns for the same `limit`, plus the new fields. It also fixes the
  snapshot: the server samples `asOf`, reads `highWaterNumber`, then reads
  the page under the section 2 predicate. A version inserted between
  reading the high-water mark and reading the page gets a higher number
  (existing `MAX(number) + 1` assignment) and is excluded.
- No `total` count is offered. Under concurrent deletes a count taken at
  walk start can disagree with the rows actually delivered; the contract
  promises identity and order, not a census.
- `live` and `liveVersionId`/`currentVersionId` are read per page and may
  change mid-walk if another client publishes or restores. They are
  volatile annotations, not part of the stable enumeration.

### 3.3 Cursor token

Format: `vh1.<base64url(payload)>.<hmacHex>` where the payload is the
small JSON object `{"v":1,"site":<siteId>,"hwm":<int>,"asOf":<epochMs>,
"last":<int>,"lastId":<versionId>,"exp":<epochMs>}` and the signature is
the existing `hmacHex(signingSecret, "vh1." + base64url(payload))`,
verified with the existing timing-safe compare (same helpers as upload
tokens). Rules:

- Opaque: clients must not parse, construct or edit cursors. The payload
  contains only values already visible to an authorized caller of that
  site (site id, version numbers and ids, times). It contains **no
  secret, credential, tenant or member data**, and grants **no authority**:
  it is a signed hint about position, never a capability.
- Expiry is absolute, not sliding: `exp` = walk start + 60 minutes (the
  same bound as upload-token lifetime). Every page reissues the same
  deadline, so a walk cannot be kept alive indefinitely. A 10,000-version
  history at `limit=50` is 200 short reads — comfortably inside an hour.
- Rotating the instance signing secret invalidates outstanding cursors;
  they fail as `invalid_cursor` and the client restarts the walk. That is
  acceptable because the maximum cursor lifetime is one hour.
- Bound: tokens longer than 512 characters, an unknown `vh<N>` prefix,
  non-JSON or out-of-range fields, or a bad signature all fail before any
  page query runs.
- The anchor row (`last`/`lastId`) may have been deleted between pages.
  That is not an error: the keyset predicate continues from the position,
  which is the reason keyset is used instead of an offset or a row lookup.

### 3.4 Concurrent-change semantics

Within one walk (one snapshot), the contract is:

- **Inserts after the walk starts never appear.** A new publish gets
  `number > highWaterNumber` and `finalized_at > asOf`; either predicate
  alone excludes it. A fresh walk sees it.
- **Pending versions never appear** (unchanged from today; `listVersions`
  is ready-only). A version that is pending at walk start and finalizes
  mid-walk has `finalized_at > asOf` and is excluded from the whole walk,
  even if the cursor has not reached its number yet. It appears in the
  next fresh walk. Direct version lookup of pending versions keeps
  working exactly as today; this contract changes listing only.
- **No duplicates.** Pages partition the number space below the
  high-water mark by a strictly descending `(number, id)` cursor, so a
  snapshot row is returned at most once.
- **Deletes are silent.** Version deletion is a hard delete; a row deleted
  before its page is read is simply absent. A walk never errors because
  history shrank, and already-returned pages are never revised.
- **Number reuse is fenced, not fixed.** If the apex version is deleted
  and its number reused by a new insert during a walk, the new row's
  `finalized_at > asOf` excludes it (except the millisecond corner in
  section 6). Across walks, `v<N>` may name a different version id after
  such reuse — that is pre-existing behaviour; `id` is the stable name.

### 3.5 Authorization and isolation

- Every page is an ordinary `list_versions` call: the site is resolved
  from the request reference and the caller's `sites:read` access is
  **rechecked on every page** through the same service path as today. A
  key revoked or restricted mid-walk stops the walk.
- The cursor never selects the site. After the site is authorized, the
  signature is verified, and then the cursor's `site` must equal the
  authorized site's id. A cursor minted for site A used against site B
  fails with `cursor_site_mismatch` and returns no data from either site;
  the error does not echo the cursor's site id.
- Validation order is fixed: authorize the requested site first (today's
  404 `site_not_found` for unreadable sites, so cursor probing cannot
  reveal whether a foreign site exists), then token shape/signature, then
  site match, then expiry.
- No cross-site or cross-tenant data can flow through a cursor: page
  queries always bind the authorized site's id server-side, and the only
  cursor inputs are bounds (`hwm`, `asOf`, `last`, `lastId`) inside that
  site's own history.

### 3.6 Errors

All errors use the existing envelope (`code`, `message`, `hint`,
`retryable`, `next` — `packages/core/src/errors.ts`) and are registered in
the error catalog by the future build. New codes are proposals.

| Situation | Status / code | Retryable | Next action |
|---|---|---|---|
| Malformed, oversized, unknown-version or bad-signature cursor | 400 `invalid_cursor` (existing code) | false | Restart: call `list_versions` without `cursor`. Deliberately one code for garbled and forged tokens, so clients get no oracle about signatures. |
| Valid cursor, walk past `exp` | 410 `cursor_expired` (new; mirrors `upload_expired`) | false | Restart the walk; rows already collected stay valid by `id`. `details.expiredAt` (ISO) may be included. The same cursor will never succeed again, so retrying it is pointless — hence not retryable. |
| Valid cursor minted for a different site | 400 `cursor_site_mismatch` (new) | false | Restart the walk on the site actually requested. |
| `limit` out of range / bad input shape | 400 `invalid_request` (existing) | false | Fix the field named in `details.fields`. |
| Site not readable by this key | 404 `site_not_found` (existing) | false | List sites with the intended owner's credential. Returned before cursor validation. |
| Transient storage failure | existing 5xx codes | per catalog | Retry the same page request unchanged; reads are idempotent. |

Example:

```json
{ "error": { "code": "cursor_expired",
  "message": "This version-history walk has expired.",
  "hint": "Start again without a cursor; version ids you already collected remain valid.",
  "retryable": false,
  "next": [{ "tool": "list_versions", "args": { "site": "bright-otter-x7k2" }, "why": "Restart the walk from the newest version." }],
  "details": { "expiredAt": "2026-10-26T13:00:05.000Z" } } }
```

### 3.7 Compatibility

- No-cursor calls return the same rows, in the same order, under the same
  1–500 limit as today; only additive fields appear. Both the MCP shape
  (`site`, `liveVersionId`) and the HTTP shape (`currentVersionId`) keep
  their existing fields.
- Explicit-version paths (`live`, `v12`, `12`, version id; restore, files,
  status, CLI direct resolution) are untouched.
- The dashboard, which currently renders the loaded list, is not changed
  by this contract; a full-history browser UI is separate future work that
  may consume this contract once it exists.
- Retiring the contract later means ignoring `cursor` after a deprecation
  window in which outstanding cursors (≤ 1 hour) have all expired; no
  stored state exists to migrate.

## 4. How surfaces discover it (future build)

One registry edit propagates everywhere; no surface gets its own logic:

- `packages/core/src/services/deploys.ts`: extend the versions service
  with the snapshot/keyset query, cursor mint/verify, and the errors
  above (business logic stays in services).
- `packages/core/src/error-codes.ts`: register `cursor_expired` and
  `cursor_site_mismatch`, then regenerate `docs/errors.md`
  (`npm run errors:sync`).
- `packages/server/src/operations/core-api.ts`: add the `cursor` input and
  the additive output fields to `list_versions`, with a two-page example
  and a description that stays within existing registry size limits. REST,
  OpenAPI, the MCP tool, `llms.txt`/`skill.md` text and the CLI command
  table are generated from this definition; regenerate the typed client
  (`npm run client:generate`).
- CLI: the registry command-table row (`versions ls`, served by
  `GET /api/v1/operations` and inspected via `kofra operations` /
  `kofra api`) picks up the new fields automatically. The hand-written
  `kofra versions` convenience command
  (`packages/cli/src/main.ts:187-189`, today a single `limit=500` call)
  learns to walk pages for an explicit "all versions" request and keeps
  its direct-ref fallback for single versions. Agent-facing wording stays
  small: one sentence — "Pages of up to 500, newest first; pass nextCursor
  back as cursor until it is null."
- Token efficiency for agents: default page stays 50 rows; a version row
  is the same compact object as today; the MCP one-line summary adds only
  "(more: pass nextCursor)" when a walk is unfinished, as `list_sites`
  already does.

## 5. Acceptance recipe for the future build (proposed, not run)

Agent-runnable against a disposable local instance (`wrangler dev`) plus
the workerd service tests. Writing these down is **not** executed evidence:
the build change must land them as failing-first tests and make them pass.

Setup: seed one site with 612 ready versions (ids `v1..v612` by number),
a second owned site, and a test signing secret.

| Case | Given → when | Then |
|---|---|---|
| VH-1 over-cap walk | 612 ready versions → walk with `limit=50` | 13 pages; union of returned ids is exactly the 612; pages are pairwise disjoint; numbers strictly descend within and across pages; last page `exhausted: true`, `nextCursor: null`. |
| VH-2 concurrent insert | page 1 read → publish v613 → finish walk | v613 never appears in this walk; a fresh first page returns v613 first with a snapshot `highWaterNumber` of 613. |
| VH-3 pending then ready | one pending version (number ≤ high-water) at walk start → finalize it mid-walk | It appears on no page of this walk; a fresh walk includes it; direct lookup by id works throughout. |
| VH-4 deletes mid-walk | page 1 read → delete one unread version and the page-1 anchor version | Remaining pages succeed with no error; the unread deleted version never appears; no duplicates. |
| VH-5 timestamp ties | several ready versions sharing identical `created_at`/`finalized_at`, straddling a page boundary | Order is still total (`number DESC, id DESC`); no row is skipped or repeated at the boundary. |
| VH-6 empty and pending-only | a site with no versions; a site with only a pending version | Both return `versions: []`, `exhausted: true`, `nextCursor: null`; `highWaterNumber` is 0 for the first and the pending version's number for the second. |
| VH-7 wrong-site cursor | cursor from site A used on owned site B; and on a site the key cannot read | `400 cursor_site_mismatch` with no version data and no foreign ids echoed; for the unreadable site, `404 site_not_found` (authorization checked first). |
| VH-8 malformed/expired | garbage string; truncated token; one flipped signature character; 513-char token; `vh9.` prefix; a token whose `exp` is in the past (test clock or test-minted) | All malformed variants return `400 invalid_cursor`; the expired variant returns `410 cursor_expired`; restarting without a cursor succeeds in every case. |
| VH-9 apex number reuse | walk started → delete the apex version → publish (reusing its number) → finish walk | The reused-number version does not appear in this walk; its distinct `id` appears in a fresh walk. |
| VH-10 compatibility | no-cursor call with `limit=500`; explicit refs `live`, `v3`, `3`, id | Rows and order match the pre-change golden response plus additive fields; explicit lookups behave exactly as before. |

Plus the invariant test required by section 1: every ready version in
seeded fixtures has a non-null `finalized_at`, and a ready row with a null
`finalized_at` (if fixtures can manufacture one) is a build-time finding,
not silent walk data loss — the build must decide and test its treatment
before shipping.

## 6. Not guaranteed without schema work

Honest limits of building on today's tables:

1. **Point-in-time membership under deletes.** Deletion is a hard delete
   with no tombstone, so a version deleted mid-walk cannot be returned
   even though it existed at snapshot time. Tombstones or a snapshot
   table would be schema work.
2. **The one-millisecond finalize corner.** Times are epoch milliseconds
   from the app clock. A version that finalizes in the same millisecond
   in which `asOf` was sampled, after the sample, can satisfy
   `finalized_at <= asOf`; if its number is also within the high-water
   mark it may appear on a later page. Closing this needs a
   database-assigned monotonic finalize sequence (schema work). Sampling
   `asOf` before the first query narrows the window to that millisecond.
3. **Forever-stable version numbers.** `MAX(number) + 1` reuses a deleted
   apex number. A per-site monotonic counter would be schema work; until
   then `id` is the only forever-stable reference.
4. **An exact total.** No stored counter matches "ready rows in this
   snapshot", and deletes move the ground truth. The contract omits
   totals rather than reporting a number that can disagree with the walk.
5. **Random access.** Keyset walks are forward-only from newest. Jump to
   page N or to a date range, browsing oldest-first, and full-history
   search are not provided; they would need their own contract.
6. **A hard bound on page scan cost with many pending rows.** Pages walk
   the number index and filter status/readiness as they go; a site with a
   large backlog of pending rows (cleanup drops pending deploys older
   than a day, `packages/core/src/services/cleanup.ts`) can make a page
   scan further. An index on `(site_id, status, number)` would be a
   migration, considered only if measured page cost demands it.
7. **Cross-request snapshot isolation.** Each page is its own request and
   statement; the predicate-fixed snapshot emulates isolation for inserts
   and finalizations, but volatile annotations (`live`) and deletes are
   observed live, as specified above.

## 7. Open decisions (for design alignment; nothing here is decided by this document)

1. Page-size bound: keep the existing 1–500 `limit` in paged mode (this
   proposal), or tighten paged pages to the general 1–200 convention?
2. Cursor lifetime: is 60 minutes the right absolute walk bound?
3. Additive fields on every response (this proposal) versus an explicit
   opt-in parameter for paged mode.
4. Security review of signing cursors with the existing instance
   `signingSecret`: on instances that never configured one, the current
   code falls back to a development default (`packages/core/src/config.ts:262`),
   which would make cursors forgeable there. Impact is bounded —
   authorization is rechecked per page and a forged cursor only re-bounds
   a listing the caller can already read — but whether cursor signing
   should require a configured secret is a security decision, not settled
   here.
5. Should the reused-number fence rely on `finalized_at` as proposed, or
   should number monotonicity be fixed first as its own schema change?
