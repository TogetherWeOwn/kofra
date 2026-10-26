# Sender-scoped delivery inventory (spec)

Status: **proposed, design only**. This is the canonical inventory contract,
not an available API, CLI command, MCP tool or dashboard. No implementation,
migration, build task, activation or deployment is authorized by this document.

## Intent and decision

Senders and agents using their credentials should find their deliveries without
keeping recipient links in a spreadsheet. Recommend a **dedicated, metadata-only
list**, not reuse of `list_sites` or repeated `get_transfer` calls. This is a
product hypothesis; competitor collections are not evidence of Kofra demand.
The choices below are proposed engineering defaults, pending product intent and
privacy/boundary decisions. They do not broaden existing sender authority.

### What exists today

Source baseline: `c6472c959ad970a69aba9dff46986562bf66ac89`. These are source
observations, **not deployment verification**:

| Existing contract | Reuse assessment |
|---|---|
| [`listSites`](../packages/core/src/services/sites.ts), lines 302–357: requires a member with `sites:read`; filters tenant, deletion, creator for transfer-mode sites and optional key site restriction; orders `created_at DESC, id DESC`. Default 50, cap 200; cursor is base64 of creation time and site ID. | Authorization/order are useful precedent, but this mixes ordinary sites and transfers. Its serializer (lines 115–136) includes site URL, title/description, settings and version/file links, not a stable site ID or delivery lifecycle. Those fields are not this inventory's allowlist. |
| [`ownedTransfer` / `describeTransfer`](../packages/core/src/services/transfers.ts), lines 74–92: member, `sites:read`, tenant **and sender member** match, optional key site restriction, non-deleted only; reference is ID or slug. | Reuse the authority predicate, never the detail serializer: `describeTransfer` includes message, recipient emails, recipient bearer URLs and file metadata. Fetching it and redacting client-side is unacceptable. |
| [`TRANSFER_OPERATIONS`](../packages/server/src/operations/transfers.ts): create, get, update and revoke only; [`list_sites`](../packages/server/src/operations/core-api.ts) is a separate operation. | No dedicated delivery list exists. A new list would need a service and one operation-registry definition, not a second REST/MCP implementation. |
| [`cleanupTransfers`](../packages/core/src/services/transfer-cleanup.ts), lines 5–33; [`deleteSite`](../packages/core/src/services/sites.ts), lines 384–416; [`checkTransferGate`](../packages/core/src/services/transfer-downloads.ts), lines 22–28. | Expiry/revoke do not remove sender readability. Deletion hides it. Holds fence purge, not expiry; takedown and expiry deny downloads independently. Cleanup may retain transfer metadata after byte purge. |

`list_sites` must remain compatible; this proposal neither removes its fields
nor claims its existing output satisfies the stricter contract below. Reusing it
with a transfer filter still needs a new safe projection, lifecycle semantics
and public contract, so offers little advantage over a dedicated operation.

## Authority and visibility

Proposed operation ID: `list_owned_deliveries`; proposed REST read:
`GET /api/v1/deliveries`. Neither is registered now.

- Resolve the caller through the existing identity adapter. Require a member
  principal and `sites:read`; constrain **every database page** by both
  `tenantId` and `memberId`, matching `ownedTransfer`. Tenant owner/admin role
  alone never permits another member's deliveries. No impersonation parameter.
- A site-restricted key adds its exact `siteId` predicate; it never widens to the
  sender's other sites. An owned but ordinary site, missing site and foreign site
  all yield an empty page. No existence preflight, foreign count or diagnostic.
- Anonymous, bootstrap, claim and upload-only credentials grant no inventory
  authority. A recipient link, password unlock or signed download grant is not
  sender authentication. Future agent identities must preserve the approved
  sender mapping and exfiltration ratchet; this spec supplies no new delegation.
- Exclude soft-deleted deliveries even if bytes remain under hold. Include
  non-deleted expired, revoked, unavailable and byte-purged metadata while the
  sender still has read authority. A hold never grants visibility or a download.

A list has no missing-reference error: absent and foreign entries are equally
absent. Existing single-transfer reads retain the same generic
`transfer_not_found` for missing/foreign references. No count, status or cursor
may disclose filtered-out rows; no promise of constant-time database execution
is made. Test that serialized error/status/headers reveal no existence oracle.

## Minimum projection and lifecycle

Select allowlisted columns directly; never load recipients, message, password
material, manifests, file paths or links merely to discard them. Proposed row:

| Field | Provenance and rule |
|---|---|
| `deliveryId` | Stable `transfers.id`; opaque identifier, not an access capability. |
| `siteId` | Stable `transfers.site_id`; not a slug or URL. IDs stay distinct even if a current implementation happens to use equal values. |
| `label` | Always `null` in v1. Existing slugs, site titles/descriptions, filenames and messages have no public-safe provenance guarantee. A future explicitly public-safe label needs a separate decision; never synthesize one from sensitive text. |
| `status` | Derived at page `observedAt`: `unavailable` if takedown is live; else `revoked` if revoked; else `expired` if expiry is strictly earlier than observed time or expiry was claimed; else `download_limit_reached` if a non-null ceiling has `downloads >= download_limit`; else `active`. Deleted rows are excluded first. No takedown reason. |
| `createdAt`, `expiresAt` | Transfer timestamps, normalized as UTC RFC 3339 strings. Expiry exactly at observed time is not expired solely due to the deadline, matching the current strict comparison. |
| `revokedAt`, `expiredAt`, `purgedAt` | Existing lifecycle timestamps as UTC RFC 3339 or `null`; `expiredAt` is the cleanup claim time, not a fabricated deadline-crossing time. |

No `updatedAt` is proposed: the current transfer row has a revision, not an
accurate last-update timestamp. No hold flag/reason, tenant/member identity,
recipient count, download count, file count, size or content hash is necessary
for finding a delivery. `status` is a metadata observation, not a promise that a
file is downloadable: authentication, password, deletion and live gates still
apply. `purgedAt` describes byte retention separately from lifecycle.

**Never emit** recipient emails, sender messages, passwords or digests, claim,
upload, unlock, session, recipient or other bearer links/tokens. Exclusion applies
to results, errors/details/hints, logs/traces, examples, cursors and UI state.
Do not return even a general delivery URL or slug: it can become a bearer entry
point when no password is set. No URL field, Location/Link continuation header,
absolute next-page URL or automatic detail fetch. Pagination returns a cursor
only. A future UI may construct an authenticated app-management route from the
stable ID, never a recipient/download address; its route needs separate review.

Retention is not visibility: hidden deleted rows and visible closed rows may
both retain bytes. Holds/takedowns fence purge and do not prevent expiry or
revoke. Listing must not expire, revoke, delete, purge, release a hold, update
last-access time, create a session, send email or count a download. It grants no
purge authority, and it does not add hold management or legal policy.

**Known current gap:** [`authenticateApiKey`](../packages/core/src/services/keys.ts),
lines 188–190, schedules a throttled `api_keys.last_used_at` write during reads.
The proposed zero-write contract includes authentication and deferred
`waitUntil` work: it is **not true of that existing path**. Before a build is
cut, the CISO disposition must reconcile a narrowly scoped read-only
authentication path with credential-use auditing, or explicitly revise this
contract. Do not silently exempt bookkeeping, disable an audit/security gate or
change shared authentication in this docs slice. A11 must exercise a key with
stale/null `last_used_at` and drain deferred work so it detects the current gap.

## Bounded agent contract (proposed)

One service takes `(dw, principal, input)`; thin registry-backed REST/MCP/CLI
surfaces use that same service and the same strict output schema. Register in
OpenAPI, operation discovery, MCP tool metadata and CLI help only when approved
implementation ships. This document is the only canonical design source.

Input is a closed object with optional integer `limit` (default 25, range 1–100)
and optional `cursor` (1–1,024 unpadded base64url ASCII characters). Reject unknown
properties, malformed JSON, fractional/out-of-range limits and oversized input;
never clamp a caller's limit silently. No tenant, sender, recipient, URL,
free-text search, lifecycle filter, include-deleted or activation option in v1.
REST uses those two query parameters only; MCP uses the equivalent object.

A successful closed JSON object has exactly:

```json
{
  "schemaVersion": 1,
  "observedAt": "2030-01-02T12:00:00.000Z",
  "items": [{
    "deliveryId": "delivery_example",
    "siteId": "site_example",
    "label": null,
    "status": "revoked",
    "createdAt": "2030-01-01T12:00:00.000Z",
    "expiresAt": "2030-01-03T12:00:00.000Z",
    "revokedAt": "2030-01-02T11:00:00.000Z",
    "expiredAt": null,
    "purgedAt": null
  }],
  "nextCursor": null
}
```

Schema constraints: `schemaVersion` is literal `1`; `items` has 0–100 entries;
all row fields above are required, with no extra properties at any level. IDs
are nonempty opaque strings of at most 128 ASCII letters/digits/`_`/`-`, not
caller-provided slugs. `label` is literal null. Status is exactly the five-value
enum above. Timestamps are valid UTC strings of at most 24 characters in the
illustrated millisecond format; nullable fields accept only that or null.
`nextCursor` is null or the bounded cursor string. Bound serialized success
bodies at 128 KiB; an unrepresentable stored row fails closed with a generic
error, never truncates a field or spills raw database diagnostics.

The proposed response schema is JSON Schema 2020-12 (validate `date-time`
formats as well as the patterns); it is documentation, not a runtime schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object", "additionalProperties": false,
  "required": ["schemaVersion", "observedAt", "items", "nextCursor"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "observedAt": { "$ref": "#/$defs/time" },
    "items": { "type": "array", "maxItems": 100, "items": { "$ref": "#/$defs/row" } },
    "nextCursor": { "oneOf": [{ "type": "null" }, { "type": "string", "minLength": 1, "maxLength": 1024, "pattern": "^[A-Za-z0-9_-]+$" }] }
  },
  "$defs": {
    "id": { "type": "string", "minLength": 1, "maxLength": 128, "pattern": "^[A-Za-z0-9_-]+$" },
    "time": { "type": "string", "format": "date-time", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$", "maxLength": 24 },
    "optionalTime": { "oneOf": [{ "type": "null" }, { "$ref": "#/$defs/time" }] },
    "row": {
      "type": "object", "additionalProperties": false,
      "required": ["deliveryId", "siteId", "label", "status", "createdAt", "expiresAt", "revokedAt", "expiredAt", "purgedAt"],
      "properties": {
        "deliveryId": { "$ref": "#/$defs/id" }, "siteId": { "$ref": "#/$defs/id" },
        "label": { "type": "null" },
        "status": { "enum": ["active", "unavailable", "revoked", "expired", "download_limit_reached"] },
        "createdAt": { "$ref": "#/$defs/time" }, "expiresAt": { "$ref": "#/$defs/time" },
        "revokedAt": { "$ref": "#/$defs/optionalTime" }, "expiredAt": { "$ref": "#/$defs/optionalTime" },
        "purgedAt": { "$ref": "#/$defs/optionalTime" }
      }
    }
  }
}
```

### Ordering and cursors

Use keyset ordering on immutable `(transfers.created_at DESC, transfers.id DESC)`
with binary/code-unit ID ordering, not locale ordering or an offset. Fetch at
most `limit + 1` authorized rows. Emit at most `limit`; make `nextCursor` only
when another authorized row exists. Equal creation timestamps break by ID.

The first page fixes an inclusive upper tuple from its first authorized row;
continuations apply that upper bound and an exclusive lower-page tuple. Cursor
payload is a version, those timestamp/ID tuples, fixed limit and issue/expiry
times only; authenticate and encrypt it, binding it to operation, instance,
authenticated tenant/member, effective key site restriction and read scope.
Expire after 15 minutes from the first page (never extend on continuation).
No raw principal identity or secret-bearing row field belongs in the payload.
The cursor is **not authentication**: verify current principal/scopes on every
page, including after revocation. Reject tampering, expiry, wrong context or
changed limit uniformly as `invalid_cursor`; omit limit on continuation to reuse
its fixed value, or echo the identical integer (accepted). Never log cursor
text. Key selection/rotation must use an
approved deployment contract before implementation; this spec provisions no
keys or permissions. Do not reuse a recipient/download credential as a key.

This is a **live keyset walk, not a historical snapshot**. With unchanged rows,
there are no duplicates or skips, including timestamp ties. Normal later inserts
above the upper tuple do not enter the walk; a concurrently committed row below
it can appear if it has not already been passed. Deleted/inaccessible rows drop
out immediately, including held rows deleted between pages; never recover their
fields from a cursor. Status/retention changes are recomputed per page at that
page's `observedAt`, so repeated reads need not be byte-identical. After cursor
expiry, restart and deduplicate by `deliveryId`; do not promise exhaustive
point-in-time results or add snapshot writes to obtain them.

### Errors and read-only behavior

Use `ApiError` with stable snake_case `code` and a safe `hint` describing the
next action; preserve each transport's existing envelope. Do not claim the
future richer error-envelope roadmap has already shipped. On implementation,
add the new `inventory_unavailable` code to
[`error-codes.ts`](../packages/core/src/error-codes.ts), run `npm run errors:sync`
and include `Retry-After` on its 503 response. No runtime/catalog change is made
by this document.

| Code / HTTP | Next action (hint) | Retry policy |
|---|---|---|
| `unauthorized` / 401 | Authenticate with a sender-authorized member credential. | Not without changed authentication. |
| `insufficient_scope` / 403 | Use an authorized member credential with `sites:read`. | Not without changed scope/principal. |
| `invalid_request` / 400 | Use only limit and cursor within the documented bounds. | Correct the input first. |
| `invalid_cursor` / 400 | Restart from the first page; do not reuse this cursor. | Not with the same cursor. |
| `inventory_unavailable` / 503 | Retry the read later with bounded backoff; restart if the cursor expires. | Retryable; generic storage/configuration/schema failure, no raw values. |

Non-member principals with no member identity use `unauthorized`; an authenticated
member lacking read scope uses `insufficient_scope`. Unauthorized input is not
used for an existence check. Other failures never echo input or stored fields.

Read-only and idempotent means **zero state writes** and no side effects, not
frozen data. No meaningful dry-run exists for a pure read; do not add a fake
`--dry-run`, `--apply`, production mode, or flag combination that can activate a
write. No idempotency records or automatic recipient/detail/download calls.
Return `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Clients must
use fetch-based pagination, never cursor-bearing navigations/redirects, and
keep credentials/cursors out of browser history, analytics and shared caches;
a server cannot prevent a client manually navigating to a GET query URL. Use
only coarse error codes, duration and authorized row counts for observability;
exclude request query strings, authorization headers, bodies and returned rows.

## Future human UI criteria (not a dashboard design)

- A labelled “Your deliveries” region and table/list; stable IDs remain usable
  without a label. Empty state says “No deliveries available to this account”,
  not whether foreign/deleted deliveries exist.
- Loading and error states have accessible status text; loading is distinct
  from empty. Error names the safe recovery action; Retry never opens a link or
  mutates a delivery. No inline recipient/message preview or automatic prefetch.
- Keyboard access to pagination and retry, visible focus, predictable focus
  after paging and screen-reader announcements. At 320 CSS pixels and 200% zoom,
  no clipped controls or page-wide horizontal scroll; IDs may wrap or copy as
  plain IDs. No URL detection/linkification, HTML rendering or hidden bearer URL.

## Threat checklist and future acceptance matrix

**Not executed inventory tests:** no inventory implementation exists. A future
Test Author can use a frozen clock, synthetic D1 rows for senders A/B in tenant
T, sender C in tenant U, an ordinary site and site-restricted credentials. No
legacy fixtures, real addresses, external requests or production calls. Run
through the service and every enabled transport against disposable local
D1/R2/KV; assert the strict schema recursively and inspect captured errors/logs.

| ID | Synthetic case / agent assertion |
|---|---|
| A1 Scope isolation | A lists only A's non-deleted transfers in T. B's same-tenant rows and C's foreign-tenant rows never change A's items, cursor termination or errors. Owner/admin credentials still cannot list other senders' rows. |
| A2 Restricted key | A's key restricted to site X returns at most X if owned and a transfer. Ordinary, missing or foreign restriction returns the same empty shape. Cursor from unrestricted/X/Y/another member/tenant/instance is refused uniformly. |
| A3 Authentication | Anonymous, bootstrap, claim, upload-only and recipient/unlock credentials obtain no inventory. Missing read scope has the documented refusal. Revoked credentials cannot use an earlier cursor. |
| A4 Missing/foreign | Missing and foreign IDs yield the same `transfer_not_found` through the existing detail surface; inventory accepts no arbitrary reference. Empty/foreign/deleted restrictions have identical public outcomes without row diagnostics. |
| A5 Paging | Create 103 rows including tied creation times. Page at limits 1, 25 and 100; compare exact descending tuples, unique IDs and termination. Invalid limits/unknown fields/malformed/oversized, modified, expired and context-swapped cursors fail without echo. |
| A6 Concurrent changes | Insert above/below the upper tuple, delete a row, revoke or expire between pages. Verify the documented live-walk behavior, no repeat for unchanged rows, current authorization on every page and no resurrection from cursor contents. |
| A7 Lifecycle | At exact deadline remain active unless another gate closes it; 1 ms later expired without waiting for cleanup. Check revoked, limit-reached, takedown precedence, closed-but-unpurged and purged-but-readable rows. Deleted rows stay absent regardless of retained bytes. |
| A8 Holds/retention | Held active/expired rows follow normal visibility/status; no hold flag or reason. Held soft-deleted rows remain absent. Compare storage and lifecycle state before/after reads: unchanged, no hold release/purge or storage-credit inference. |
| A9 Non-emission | Put distinct synthetic canaries in recipient email/token, message, password/digest, slug, title/description, file path/hash and claim/upload/unlock/session/link fields. None may occur in response keys/values, errors/headers, captured logs/traces, decoded cursor payload or examples. |
| A10 Token-free handling | Assert no URL/slug/recipient field, redirect/continuation URL, hidden link, linkification, background detail/download fetch or bearer query in UI/history/analytics. Cursor is data only and never a navigation target. |
| A11 Read-only parity | REST/MCP/CLI expose the same projection and errors, read-only/idempotent annotations and discoverable schema. Spy on all DB writes, KV/R2 writes, email/hooks/session/idempotency/download counters: zero. Repeated reads change no state. |
| A12 Bounds and UI | Assert maximum row/body/cursor bounds, generic storage/schema-failure errors and no-store/no-referrer. Exercise labelled loading/empty/error, keyboard pagination/retry and narrow-screen/zoom criteria above. |

## Gates and non-goals

Before any implementation is cut, record **CEO intent alignment** and **CISO
privacy/boundary disposition** through native task decisions against the exact
spec revision. Pending is not approval. A docs PR merge is not either decision,
a build authorization, an activation approval or evidence of deployed safety.

Preserve R-52 sender-read/transfer and staging gates, R-64 agent-identity and
exfiltration-ratchet STOPs before public transfers, legal-hold fences, and every
existing auth, email, security and activation STOP. The existing sender detail
read exposes more than this proposed list; approving the list does not approve
discoverability followed by automatic detail reads. Cursor-key readiness,
acceptance tests, exact-head CI/review and approved isolated staging evidence
remain future prerequisites, never assumed by this document.

No UI/API/service build, build child, migration, transfer creation/notification,
file download, purge, credential provisioning, new spend/grant, legacy revival,
content scanning, production test, deployment or root-template deployment is
part of this slice. Public-core boundaries and internal Worker/storage names
remain unchanged. Documentation verification uses source inspection, safe
examples, link checks and repository checks only.

R-64 here denotes the externally tracked agent-identity/sender-mapping and
exfiltration-ratchet release gate, not an implemented public-roadmap item. A
future build assignment must identify its authoritative decision record; a
missing record is not permission to omit that gate.
