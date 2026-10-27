# CLI watch: bounded, explicit publishing (proposed v1)

**Status: specification only; not implemented or approved for implementation.**
This is the canonical contract for a future `kofra watch`. Saving or merging it
adds no command, dependency, endpoint, permission, deployment or automatic
publishing authority. The saved task specification must contain the same text.
Proposed choices below are engineering recommendations, not recorded approval.

## 1. Outcome, alternatives and recommendation

An agent iterating on an already-published folder should be able to authorize a
short foreground session of updates to **one explicit existing site**, without
retyping publish, overwriting another writer, or leaving a service running.
The roadmap names `watch` under management commands (`docs/ROADMAP.md:177-184`),
but the CLI command table (`packages/cli/src/main.ts:1294-1312`) and command guide
(`packages/cli/README.md:19-40`) contain no watch command today.

| Alternative | Benefit | Limitation / decision |
|---|---|---|
| Repeated explicit `publish --base <id>` | Available now; each mutation is separately requested | Agent must manage target, base and outcomes; current publish can create a missing site. Keep this as the fallback, not an automatic retry recipe. |
| Local preview only | No remote mutation or credentials | Does not update the shared URL; preview servers/reload infrastructure are outside this proposal. |
| Bounded foreground watch | Fewer commands with explicit session authority and conservative failure handling | Additional snapshot, cancellation and response-validation work is needed; polling/hash work is capped. Recommended only with the gates below. |

**Recommendation: build the bounded design after intent/security disposition and
a separate planner cut/Test Author pair; no build is authorized now.** Do not
ship a loop around today's `publish()` helper. Reuse its collector and existing
prepare/blob/finalize **protocol**, not its site-creation, retry, settings or
response-selection behavior. If the future slice cannot satisfy the bounds and
fail-closed rules without changing server publish semantics, recommend no-build
and return to explicit publishing. Compare and configuration-diagnostics specs
are useful inputs (`docs/CLI_COMPARE.md`, `docs/CLI_DIAGNOSTICS.md`), not build
dependencies and not authority to expand either command.

No daemon, detached process, service, host scheduler, cron, browser opening,
remote preview, app worker/queue, telemetry, automatic restoration/deletion,
credential rotation, new scope or new spend is part of v1. No production test or
deployment is part of this specification or its future acceptance recipes.

## 2. Source facts and deliberate gaps

Citations describe revision `9474d931670f88e5f74831c81f50ff6160789d98`.
They are traceability, not evidence that the proposed behavior already exists.

| Existing primitive | Source and consequence for watch |
|---|---|
| Collection | `packages/cli/src/files.ts:57-157`: sorted traversal, root `.dropwayignore`, explicit exclusions, hashes and omission records. Recollect on every scan, including ignore-rule changes. |
| Ignore precedence | `packages/cli/src/ignore.ts:8-34,88-109`: built-ins followed by custom last-match-wins rules, including negation; pruned directories stay pruned. Built-ins are defaults, not an unoverrideable secret boundary. |
| Links / secrets | `files.ts:69-115,119-148` and `packages/cli/src/secrets.ts:7-42`: directory links skipped, regular-file links followed even outside the root, broken links/special files omitted. Text scanning is heuristic, NUL-detected binary is not scanned, files above 4 MiB are not scanned. Do not claim containment or guaranteed secret detection. |
| Publish refusal / dry-run | `packages/cli/src/main.ts:399-410`: exclude the cwd project link, collect, refuse possible secrets before upload. Watch keeps refusal and does not offer `--allow-secrets`. |
| Existing helper is unsuitable as-is | `packages/cli/src/publish.ts:134-160,166-179,188-240`: missing-site creation and cleanup, lazy body reads, parallel upload/retry and mutable current-version selection. A collector result is not an immutable byte snapshot. |
| Existing manifest endpoint | `packages/server/src/operations/http.ts:281-346`: POST `/sites/{slug}/versions` (legacy `/deploys` alias) calls `createDeploy` directly. Settings can change before preparation; watch sends none. This endpoint is **not keyed-idempotent**. |
| Conflict and identity | `packages/core/src/services/deploys.ts:135-137,197-228,447-503`: prepare checks base before unchanged; identity includes path/hash/content type, not message; finalize fences the live-pointer change in its transaction. Ready-version finalize replay never republishes a superseded version. |
| Keyed replay is a different protocol | `packages/server/src/operations/http.ts:230-247` wraps JSON `/publish`, not manifest preparation. `packages/core/src/services/idempotency.ts:33-37,87-158` provides scoped 24-hour keyed replay, payload-mismatch refusal and pending/unknown outcomes there. Sending a header to manifest prepare would not confer those guarantees. |
| Transport is not a time budget | `packages/client/src/http.ts:76-127,229-291`: default four attempts, automatic redirects and non-abortable request/backoff path. `packages/cli/src/client.ts:128-142` delegates to it. Watch needs its own bounded invocation controls; existing commands remain unchanged. |
| Output / parsing | `packages/cli/src/main.ts:76-115,1373-1392` keeps one-object JSON and refuses surplus arguments before side effects; `packages/cli/src/args.ts:29-95` rejects unknown flags but repeated flags overwrite earlier values. Watch must validate its complete flag contract before I/O. |
| Existing identity / reads | `packages/server/src/operations/core-api.ts:114-130,432-463` provides member identity/siteRestriction and authenticated site reads. `packages/core/src/services/sites.ts:99-141` serializes neither a site id nor a version manifest hash. Pin site id from a required existing key restriction, not an invented site field. |
| Finalize confirmation | `packages/server/src/operations/core-api.ts:396-408` REST finalize returns live/replayed/site, **not a version object**. `packages/server/src/operations/versions.ts:9-60` supplies exact-id version metadata; a mandatory GET confirms that prepared id's ready/live state. Content read-back uses `packages/core/src/services/deploys.ts:590-611`, separately from that metadata proof. |

The new CLI-local work is bounded collection/snapshotting, lifecycle, cancellation,
strict target/response validation and summary serialization. It must remain Node
code with erasable TypeScript; protocol modules stay fetch-only. No migration or
core/server change is proposed. Any need for one requires re-scoping, not a hidden
prerequisite in an implementation PR.

## 3. Explicit invocation and validation

Proposed, **not runnable today**:

```text
kofra watch <directory> --api <origin> --site <slug> --base <versionId>
  --mode publish [--initial skip|publish] [--max-duration <seconds>]
  [--max-publishes <n>] [--json] [--quiet]
kofra watch <directory> --dry-run [--api <origin>] [--site <slug>]
  [--base <versionId>] [--initial skip|publish] [--max-duration <seconds>]
  [--max-publishes <n>] [--json] [--quiet]
```

- Online mode requires all four explicit flags: `--api`, `--site`, `--base`,
  `--mode publish`. There is no inferred target from environment, project links,
  saved default or a prompt. `--site` is a canonical slug, not a URL or site id;
  `--base` is an immutable `ver_...` id, not `live`, a number, or an empty value.
- `--api` must be exactly an HTTP(S) origin: no userinfo, path other than `/`,
  query or fragment. Require HTTPS except literal loopback origins for disposable
  tests. Refuse redirects for **all** watch requests; never forward credentials
  or follow upload URLs to another origin. A successor hint is advice, not a move.
- Resolve only the credential for that explicit origin, once: explicit `--key`,
  then `KOFRA_API_KEY` (including the existing legacy-env compatibility), then its
  saved key. Do not consult a project link or saved default. GET `/api/v1/me`
  once and require `principal:member`, `sites:read`, `sites:write`, and a non-null
  `siteRestriction`. This **already-provisioned site-restricted member key** is
  mandatory: its restriction supplies the stable site id and makes all slug
  reads/writes refuse another site under the same name. Anonymous, claim,
  bootstrap, upload-only and unrestricted keys are refused. No credential
  creation, permission change or replacement; use explicit publishing if an
  already-authorized restricted key is unavailable.
- Before the first mutation, GET the explicit slug with that key; require an
  existing owned site with a non-null live version equal to `--base`. Pin site
  id from `whoami.siteRestriction`, and slug/base from this read. The site's
  JSON does not expose its id; server restriction enforcement supplies the
  identity fence. Never create a site. Before each attempted batch, re-read and
  require that same slug/base under the same restricted credential; deletion,
  rename, replacement or live movement stops the session.
- Only the flags above plus `--key`, `--help`/`-h`, `--quiet`/`-q` are accepted.
  No aliases for watch. Exactly one directory positional. Refuse files, ZIPs,
  URL input. Refuse duplicate flags (including aliases/positive-negative
  spellings), unknown flags, malformed values and surplus positionals **before
  filesystem, credentials, stdin or networking**. Add a watch-only argv pre-scan
  or strict parser mode to detect duplicates; today's parser is insufficient.
  After syntax passes, a classifying stat may reject a file/ZIP/missing path
  before collection/credential lookup. Never silently accept a last flag winner.
- `--initial` defaults to `skip`: baseline the initial local snapshot without
  publishing it. It does **not** assert equality with remote. The first later
  eligible change replaces the whole remote manifest with the then-local tree,
  including any local/remote differences that already existed at startup.
  Explicit `--initial publish` attempts that initial snapshot immediately.
- `--max-duration`: integer seconds, default 300, range 1-900, measured from
  validated invocation start, including collection, reads and uploads.
  `--max-publishes`: default 5, range 1-10. It counts **attempted preparations**,
  including unchanged responses and failed/ambiguous preparations, not just new
  versions. There is no unlimited value. Integers use decimal digits only.
- `--dry-run` rejects `--mode` and `--key` rather than selecting a precedence.
  Target flags are optional descriptive literals, validated if supplied, never
  resolved. Environment/default instances and credentials are not read.
- Publish-only options (`--new`, `--save`, `--no-save`, `--anonymous`, `--encrypt`,
  `--allow-secrets`, settings/password flags, `--wait`, `--message`,
  `--concurrency`, `--idempotency-key`) and `--ndjson`/`--events` are usage errors.
  No wrong flag combination can fall back to one-shot publish.

## 4. Local inventory, snapshots and portable change detection

Use `collectFiles(directory, { exclude: [linkPath(cwd)] })` with secret scanning
on, and the existing matcher, hashing and omission classifications. A fresh root
ignore file is loaded for every scan. Regular-file symlinks retain existing
publish behavior, including external file targets; directory symlinks are never
followed. This must be prominent in help. Do not silently widen or narrow ignore
semantics, or claim that ignored paths cannot be re-included. Refuse detected
secrets with `possible_secrets`, exit 2; print counts, never matched values,
paths/lines of findings or raw filesystem error text. No bypass flag.

Fixed v1 limits, not raisable by flags: 1,000 eligible files, 16 MiB eligible
bytes, 4 MiB per file, 10,000 visited entries (ignored entries count), depth 64,
512 total collection passes, and 128 MiB retained watch-owned buffers/metadata.
Check entry/depth/count/size budgets during traversal and before content reads;
stat again while reading so growth cannot defeat the byte cap. This requires a
bounded collector adapter/refactor preserving the existing inclusion decisions,
not a second matcher or an unrestricted pre-walk. Check every cap on every pass.
The binary/heuristic scan limitations above remain; a successful scan is not
permission to publish credentials. These caps intentionally exclude large sites.

Freeze a batch's bytes in bounded memory, not on disk. Verify that each held
buffer's SHA-256 and size equal the collector's entry, and scan those exact bytes
with the existing secret detector. Upload only held buffers, never re-open a path
from an old manifest. Snapshot identity is a hash of canonical sorted
`{path,size,sha256,contentType}` entries with POSIX paths and exact case-sensitive
names; exclude mtime, traversal order and session metadata. Use the server's
content-type mapping, not a new guess. Reject invalid/colliding paths rather
than normalizing them into another file. Pin root realpath/file identity and
refuse root disappearance/replacement. Source changes while collecting invalidate
the whole candidate. If there is no safe initial baseline, refuse with
`watch_source_changed`; otherwise keep the last baseline and rescan within
existing budgets. An eventual bound stop with an unstable candidate sets
`changesMayRemain:true`, never acknowledges partial content.

**Portable strategy: bounded full rescans, not native filesystem events.** Use
one process-local timer; start a scan no sooner than two seconds after the prior
scan completes. No `fs.watch` recursion, watcher handles, new dependency or
unbounded polling fallback. A candidate must have the same fingerprint in two
consecutive complete scans separated by at least 500 ms (the fixed debounce).
Bursts coalesce to the newest stable candidate, with no queue of file events.
Continuous edits may produce no publish; the session still expires. A file
created and removed between scans can be missed; watch is not an audit log or
real-time synchronization. Atomic-save renames and new subdirectories are picked
up on the next full scan. Supported scope is ordinary local filesystems on
Linux, macOS and Windows; network mounts and special/virtual filesystems are not
a supported reliability claim. Test platforms explicitly; never imply native
event delivery is lossless.

## 5. State machine and stopping

| State | Action / transition |
|---|---|
| Validate | Validate the full syntax, modes and bounds before I/O. Help prints help only. |
| Inventory | Collect/freeze a safe baseline within caps. Dry-run emits its plan and stops; no timer or credential lookup is started. |
| Pin | Online: resolve the explicit-origin credential and GET the existing site/base. Refusal stops without a mutation. |
| Observe | `initial=skip` installs the local baseline. Scan until a different stable fingerprint appears; `initial=publish` uses the safe initial snapshot without waiting for a later edit. |
| Prepare | Recheck pinned site/base. Allocate one immutable batch, debit one publish slot, send manifest preparation exactly once. |
| Upload | Serial PUTs of missing distinct hashes from held buffers (one request at a time). No second batch or collection runs concurrently; remember that a post-flight full rescan is mandatory. |
| Finalize / confirm | Send finalize once for the prepared id if uploads succeeded and the session is not stopping. Then make one exact-version GET to confirm ready/live state; REST finalize itself returns no version. |
| Acknowledge | Advance expected base only to the exact-id GET-confirmed ready/live batch version; unchanged retains the base. Install its local fingerprint. Release snapshot buffers, then full-rescan before considering another batch, including after unchanged. |
| Stop | Close timers, abort owned I/O, start no further mutations, emit one summary, release memory and exit. No remote cleanup/delete/restore. |

There is at most one batch and one HTTP request in flight. Edits during upload
are not appended to that batch: after success a fresh full scan observes them
and they require stabilization before another preparation. This also catches
file-link target and ignore changes, without an unbounded dirty-path set.
Identical local fingerprints cause no remote request and consume no publish
slot. A server `unchanged` preparation consumes a slot, has no upload/finalize,
and must identify the expected base; another returned id is a refusal.

No scan, wait or request starts after the monotonic session deadline. Each HTTP
request, including its response-body read, has one maximum 15-second budget,
clipped to remaining session time; cap JSON bodies at 2 MiB. Use a watch-owned
AbortController linking that budget, the session deadline and first signal to
each fetch/body reader. Use a watch-local fetch wrapper with redirects refused,
one transport attempt and no inherited retry/backoff or successor move. All
traversal/hash work checks cancellation between entries/chunks. Abort queued work
as well as active work; merely rejecting `Promise.all` is insufficient. Normal expiration, scan cap or
publish cap is a bounded stop, not a claim of synchronization. Include whether
local changes may remain; if the last batch used the final slot, conservatively
report that without starting an extra scan.

First SIGINT/SIGTERM requests the same stop immediately; a second exits promptly
without further reads. Target cleanup/summary within two seconds after deadline
or signal, assuming a responsive OS/local filesystem; hung kernel I/O, process
suspension and SIGKILL cannot promise a summary or a strict user-space deadline.
No independent supervisor/service is introduced. SIGINT before finalize prevents
finalize from starting, but uploaded bytes/pending metadata can remain. If
finalize was sent, **process cancellation is not rollback**: it can be accepted
before the connection is aborted. Treat its result as unknown unless a direct
receipt or the bounded read below proves otherwise. Never auto-restore a base.

## 6. Protocol, fencing, idempotency and uncertainty

1. Identity: one GET `/api/v1/me` with the resolved key; require a site-restricted
   member with both scopes. Pin `siteRestriction` as siteId. Non-member or null
   restriction is `watch_credential_unsupported` (exit 3); missing scopes are
   `insufficient_scope` (exit 3). Then pin/recheck with GET
   `/api/v1/sites/{slug}` under that same restricted key. Verify slug/current
   version; identity is enforced server-side, not a nonexistent site.id field.
   Pin a non-null base; no unversioned/empty-site mode.
2. Prepare: POST `/api/v1/sites/{slug}/versions` with only
   `{ files: [{path,size,sha256,contentType}], baseVersionId: expectedBase }`.
   No site-create, settings, message or other mutating route. Server conflicts
   are terminal at prepare **and** finalize; never rebase onto a reported head.
3. Validate preparation: unchanged must name the expected base; changed must
   name a new pending version. Missing upload hashes/sizes must be a distinct
   subset of this snapshot; accept only the existing same-origin blob route
   and method PUT. Never execute returned curl strings, arbitrary `next`
   instructions or arbitrary finalize URLs. Construct the known finalize/blob
   routes from verified ids/hashes. Ignore returned headers except a validated
   Content-Type; set Content-Length from the held buffer and use only the
   session's original bearer credential. Never use returned credentials or
   export upload capabilities into output.
4. PUT missing blobs, then POST `/api/v1/sites/{slug}/versions/{preparedId}/finalize`.
   REST finalize returns `live`, `replayed`, `site`, not a version object. After
   a successful or ambiguous finalize attempt, if no signal/deadline, make one GET
   `/api/v1/sites/{slug}/versions/{preparedId}`. This is the normal confirmation
   on a successful response **or** the reconciliation on an ambiguous response,
   never two GETs or a polling loop. Require returned id equal to preparedId,
   status ready and live true before continuing. `live:false` on a ready version
   means `watch_superseded`, exit 5; no restore/retry. `replayed:true` alone is
   not success: confirmation is still required. Update the next base from this
   exact id only, never `site.currentVersion`. If a clean finalize cannot be
   confirmed within time, stop unresolved with exit 7.

The exact-id GET's `status:ready` proves this prepared version finalized; counts
are sanity checks only, since they already existed while pending. It does not
return a manifest hash or prove content equality. `batch.manifestHash` is the
local frozen fingerprint, not a server receipt field. Per-batch content proof is
not promised; future acceptance verifies the existing hash-verifying upload and
finalize protocol using a separate pinned `files --version` manifest read-back.

A batch gets `batchId = <random-session-UUID>:<1-based-sequence>` once, bound to
its frozen manifest and pinned base. Retries never create another logical batch.
**This is correlation and at-most-one-attempt bookkeeping, not durable server
idempotency for preparation.** The chosen v1 sends preparation once, sends each
blob once and sends finalize once. It sends no misleading `Idempotency-Key` to
manifest preparation. There is no cross-process replay, journal, resume flag or
user idempotency-key flag. A fresh invocation is new user authority, not recovery
of an uncertain old batch. An unknown preparation may have left an unreported
pending version; do not prepare it again or claim zero remote writes.

Blob PUT/content hashes and ready-version finalize have intrinsic idempotent
behavior, but v1 deliberately does **not** auto-retry them. The 24-hour keyed
JSON `/publish` wrapper is not used: it has different target-creation semantics.
If future requirements demand automatic durable replay of preparation, stop and
re-design through a separately approved protocol change; do not invent a header
contract or silently switch endpoints.

**Retry budget: zero automatic retries, including GET, 429, network and 5xx.**
One 429 ends the session with exit 7; a valid Retry-After is advisory in the
summary, not permission to sleep/retry or to exceed the deadline. No automatic
retry of `missing_blobs`, 409 (even if `retryable:true`), 422, auth failure or
malformed response. Disable inherited SDK retry/redirect behavior for watch
only; do not change other commands. Never rotate/fallback to another key.
At most `2 + 1004 * maxPublishes` HTTP attempts are permitted (startup identity
and pin, then a site recheck, prepare, up to 1000 distinct PUTs, finalize and
one confirmation/reconciliation GET per slot); every attempt also consumes
remaining time. There is no periodic remote live/version polling or site-byte
fetch. A 429 finalize is a definitive refusal and stops without confirmation;
no further I/O follows any rate-limit response.

Failure classification is phase-sensitive:

- Before preparation is dispatched: no content mutation attempted by this batch.
  A wrong-site restricted key and a nonexistent slug both surface as
  `site_not_found`, exit 4; never infer which case caused the 404.
- Prepare response lost/invalid: `watch_outcome_unknown`, unknown pending state,
  no version id invented, no further mutation or automatic version-list search.
- PUT failed/ambiguous before finalize: record known pending version and
  `not_published`; blob storage may have changed. Stop without finalize/cleanup.
- Finalize lost/5xx/invalid body: record `unknown`; use the single exact-id GET
  above if no signal and time remains. Matching id with status ready proves that
  prepared version finalized (even if no longer live), not its manifest hash;
  pending/404/failed read does not prove it cannot still finalize. No second
  read follows an unsuccessful confirmation. Reconciliation never mutates and
  the session stops even if ready. Report confirmed finalization separately
  from live state. Keep exit 7 for this interrupted protocol (or 5 if confirmed
  superseded), with `retryable:false` and advice not to replay the write.
  Signals/deadline do not trigger extra reconciliation I/O.
- A definitive conflict is exit 5. It can leave a pending version/blobs but must
  never overwrite the competing live version. Stop on rename/deletion too.

Recovery is read-only first: inspect the named site and exact prepared version
with existing `site`, `versions <site> <versionId>` and `files --version` commands.
If the id is unknown, an operator must reconcile history and the external writer
before authorizing any new publish. No automatic reset, deletion, rollback or
last-writer-wins fallback. Existing pending-version cleanup is server-owned
(`packages/core/src/services/cleanup.ts:85-99`), not a promised watch rollback.

## 7. AX output and errors

### One final object, not a stream

`--json` produces exactly one schema-versioned summary on stdout, at controlled
termination, including validation errors and dry-run. **No NDJSON, intermediate
JSON, per-file output or heartbeat lines on stdout.** Human progress goes only
to stderr, one line at start and at most two per attempted batch plus one stop
line; no scan-by-scan noise. `--quiet` suppresses progress, not error/unknown
outcome advice. Non-TTY adds no escape codes. Text mode prints one short final
summary on stdout; errors/advice stay stderr. Existing commands are unchanged.
A killed process/broken pipe may produce no complete object; never claim a
missing/truncated summary proves no mutation. Broken stdout stops further work.

Normative v1 summary example (values are illustrative):

```json
{
  "schemaVersion": 1,
  "command": "watch",
  "ok": true,
  "exitCode": 0,
  "sessionId": "b0e96e5b-5c45-4ec9-9e92-472c6987cb78",
  "dryRun": false,
  "target": { "api": "https://example.invalid", "slug": "scratch", "siteId": "site_example", "initialBaseVersionId": "ver_base", "lastConfirmedVersionId": "ver_next" },
  "initial": "skip",
  "limits": { "maxDurationSeconds": 300, "maxPublishes": 5, "maxScans": 512 },
  "stopReason": "duration_limit",
  "elapsedMs": 300000,
  "counts": { "scans": 20, "attemptedBatches": 1, "published": 1, "unchanged": 0 },
  "local": { "files": 3, "bytes": 1024, "ignored": 2, "omitted": 3, "secretsFound": 0 },
  "changesMayRemain": true,
  "batches": [{ "batchId": "b0e96e5b-5c45-4ec9-9e92-472c6987cb78:1", "baseVersionId": "ver_base", "manifestHash": "<64-lowercase-hex>", "versionId": "ver_next", "phase": "finalize", "outcome": "published", "finalized": true, "liveAtReceipt": true, "bytesUploaded": 1024 }],
  "error": null,
  "next_action": "Session ended; inspect local changes before authorizing another session."
}
```

Use a dedicated watch redacting formatter for success, dry-run and errors;
never reuse the existing publish dry-run inventory or secret-error printers
(`main.ts:103-115,403-424`), which emit paths/findings. Never forward their raw
details into watch output.

Required keys are those shown. Target origin/slug echo only validated explicit
literals; absent/invalid values are null. siteId is null until the member key's
restriction is validated, never invented from site JSON. `initialBaseVersionId`
is the supplied validated literal, not proof it was live. Batch `versionId`, `finalized`, `liveAtReceipt` are null when unknown;
`phase` is `prepare|upload|finalize`, `outcome` is
`unchanged|published|not_published|unknown|superseded`. No batch record before a
preparation attempt. `lastConfirmedVersionId` means the last confirmed session
base, **not current live now**. `liveAtReceipt` is not a cache-convergence check.
`changesMayRemain` is conservative: true after an in-flight/last-slot stop or
when no final complete scan establishes the acknowledged local fingerprint.
Even false does not claim remote equality for `initial=skip`, nor cover edits
after the last scan. `stopReason` is
`dry_run|duration_limit|publish_limit|scan_limit|signal|error`.

Dry-run uses this same envelope with no session/batch allocation (`sessionId:null`,
`batches:[]`), unresolved ids null, one local inventory and stopReason `dry_run`.
It reads local files for collection and scanning only, writes neither files nor
config nor credentials, makes zero network requests, does not start observation,
and does not validate remote existence, permissions or capacity. It needs no key
or configured instance. Detected secrets still refuse. `ok` means successful
planning or an orderly bounded stop, **not** that all local edits are live.

At most ten batch records; summary at most 32 KiB UTF-8; no filenames, absolute
local roots, file contents, tokens, claim/upload URLs, request bodies or raw
backend `details` in either output channel. Cap/escape human-provided strings;
use an allowlist for server error codes, request id and numeric retry delay.
Unknown server error text is replaced by a fixed safe message. Aggregate counters
remain exact. JSON v1 may gain additive fields only; breaking changes require a
schema bump. There are no unbounded event arrays or path-list truncation traps.

### Stable failure contract

On failure `ok:false`, a nonzero `exitCode`, and
`error:{code,message,hint,retryable,next_action,status,requestId,retryAfterSeconds}`
are required (unavailable optional metadata is null). `next_action` also appears
at top level for success/recovery. Codes are stable snake_case; advice never
executes itself. Retryable means an agent may retry the **named safe read** later,
not permission to restart a mutation/session. Unknown mutations always report
`retryable:false`, irrespective of a backend's general retry advice.

| Code / category | Exit | Required next action |
|---|---|---|
| `usage`, `watch_explicit_target_required`, `watch_directory_only` | 2 | Correct syntax/explicit target or use offline dry-run; no I/O on flag errors. |
| `possible_secrets`, `no_files`, `watch_source_changed` | 2 | Review/remove unsafe content, select a nonempty directory, or stop edits. Failure to freeze the first safe baseline exits immediately with watch_source_changed; after a baseline exists, unstable later candidates may reach a bound stop (exit 0, changesMayRemain:true, unless another error exists). |
| `not_logged_in`, existing 401/403 codes, `watch_credential_unsupported` | 3 | Supply an already-authorized member credential for this origin/site; never mint/fallback/rotate. |
| `site_not_found`, `version_not_found`, `watch_no_live_version` | 4 | Inspect the explicit disposable target; watch never creates it. |
| `version_conflict`, `watch_target_changed`, `watch_superseded` | 5 | Stop; reconcile the other writer read-only. A newer base is not automatically accepted. |
| `watch_cap_exceeded`, existing invalid-input/limit codes | 6 | Narrow the tree; v1 caps cannot be raised. No partial publish to fit a cap. |
| `watch_rate_limited`, read-only network/5xx failure | 7 | Observe advisory delay and inspect safely later; automatic retry budget is zero. |
| `watch_outcome_unknown` | 7 | Inspect recorded ids/phase; do not retry the write with a new batch or key. |
| `watch_unexpected_response`, `watch_redirect_refused` | 7 | Stop and inspect the target/protocol; do not follow returned URLs or guess identities. If mutation was sent, classify outcome unknown too. |
| `watch_cancelled` | 130 | Inspect summary phase/outcome before a new command; signal is never rollback. SIGTERM uses the same controlled-stop exit. |
| `unexpected_error`, `watch_output_unavailable` | 1 | Stop; preserve any already-obtained receipt, report safe ids only. |

Orderly duration/publish/scan bound stops exit 0 unless a batch is unresolved
(7) or another failure already exists. Signal exit 130 takes precedence but does
not erase an unknown batch. Watch never uses exit 8: it performs no live-URL
convergence polling. A server `unchanged` is not a new version or a publish count.

## 8. Discoverability and an agent-verifiable check

This document owns the contract; a later approved build must derive short
help/README/skill guidance from it, not maintain another spec:

- Register watch in `main.ts` command/help tables with explicit target, initial
  choice, hard bounds, file-link warning, unknown-outcome advice and the offline
  example. Do not advertise the command as available in this docs-only change.
- Add a CLI README command row and a short link to this spec; preserve the global
  one-object JSON promise and explain that progress is stderr, summary is delayed.
- Add the same bounded workflow in the `skillMarkdown` source
  (`packages/server/src/discovery.ts:36-98`), regenerate `skills/kofra/SKILL.md`
  with `npm run skill:sync`, and extend its existing sync checks. Never hand-edit
  only the generated skill. Do not register a server watch/MCP operation.

Future smoke command, **only after implementation**, against an existing
throwaway site on an operator-provided disposable instance (not production).
`DISPOSABLE_BASE` is an exact live version id read before this command;
`KOFRA_API_KEY` is an existing site-restricted member key with both scopes,
provided securely, never pasted into the command or report. Existing key
management supports `siteId` (`packages/core/src/services/keys.ts:54-79`); any
provisioning is a separate authorized prerequisite, never part of watch or its
smoke command. `kofra whoami --api "$DISPOSABLE_API" --json` exposes its safe
restriction metadata for setup diagnosis:

```sh
node packages/cli/bin/dropway.mjs watch ./watch-fixture \
  --api "$DISPOSABLE_API" --site "$DISPOSABLE_SITE" --base "$DISPOSABLE_BASE" \
  --mode publish --initial publish --max-duration 10 --max-publishes 1 --json
```

Verify one JSON object, exit 0, one attempted batch, and an exact ready version
id (or the unchanged pinned base). Read that exact id with the existing
`versions <site> <id>` and `files --version <id>` commands; verify fixture hashes.
This check does not require a public npm release or site-URL polling. A dry-run
variant removes `--mode publish`, adds `--dry-run`, and must work with credentials
absent and a network-denying sentinel. It reports no invented site/version ids.

## 9. Numbered future acceptance matrix

Not executed by this design card. The future Test Author supplies these tests;
the builder does not edit acceptance tests to make them pass. Use local Worker
D1/R2/KV emulation, injected clock/fetch/filesystem controls, temporary HOME/cwd,
and disposable credentials. Deny production destinations in the test transport.
Use the smoke command above for online cases, varying one input as specified.

| # | Contract / fixture | Required evidence |
|---|---|---|
| 1 | Current absence / eventual discovery | Today command table lacks watch; future help, README and generated skill agree with this spec and pass sync checks. |
| 2 | Explicit opt-in | Omit each api/site/base/mode; poison environment/project defaults. Exit 2, no filesystem/credential reads or network. |
| 3 | Malformed flags | Unknown, duplicate/alias/negated flags, empty base, live/numeric base, bad origin, surplus args, decimals, zero/unlimited/over-cap budgets. Usage exit before I/O; no publish fallback. |
| 4 | Incompatible mode / path | Dry-run plus mode/key, publish-only flags, file/ZIP/URL input. Refuse; no mutation. Path-kind validation may read stat only after syntax passes. |
| 5 | Offline dry-run | Denying fetch and write sentinels, absent/malformed credentials and poisoned config. One inventory/summary, no credential/config reads, timers, networking or writes. |
| 6 | Initial skip | Initial local tree differs from remote; no write until a later eligible stable change. Summary never claims initial equality; later full replacement documented. |
| 7 | Initial publish / unchanged | Immediate one-slot preparation; equal remote manifest returns same base, unchanged count 1, zero PUT/finalize/new version. |
| 8 | Burst coalescing | Many rewrites between two full scans. Only newest twice-stable snapshot prepares; no per-event queue/output. |
| 9 | Change during upload | Pause a PUT, edit/add/remove files and ignore rules. Held bytes and first manifest stay fixed; no overlapping scan/batch; post-flight scan/stabilization then one next batch. |
| 10 | Local unchanged | mtime-only edits/reordered walk and repeated identical scans. Zero requests/slots after pin, identical canonical fingerprint. |
| 11 | Ignore parity | Built-ins, custom negation/pruned directories and cwd project-link exclusion. Same inclusion/omission decisions as existing publish; no secret rule silently relaxed. |
| 12 | Link / platform behavior | Directory link/loop, external regular-file alias, broken link, atomic save/new directory on Linux/macOS/Windows. Existing inclusion preserved; no root replacement or native watcher assumption. |
| 13 | Secret refusal | Small-text token sentinel, re-included ignored name, changing file between hash/body. Exit 2 before prepare; exact held bytes scanned; no literal/path/finding text in either channel. Binary heuristic limitation is explicit. |
| 14 | Snapshot integrity | Size/mtime/inode changes, same-size rewrites, source disappearing, root swap, case-colliding/invalid paths. No inconsistent buffer/manifest upload; stable rescan or bounded refusal. |
| 15 | Resource caps | Exceed each file/byte/entry/depth/scan/memory cap, grow while reading, or empty tree. Fail before unsafe allocation/partial publish; ignored entries count toward traversal budget. |
| 16 | Concurrent writer before prepare | Move live after pin, including an identical-content competing version. Base conflict, exit 5, no rebase/second prepare. |
| 17 | Concurrent writer during upload | Move live between prepare and finalize. Transaction rejects our finalize; other writer stays live, pending/blob remnants honestly recorded. |
| 18 | Rename/delete/replacement | Change site identity under slug before a batch or during upload. Never create/recreate/delete a site; refuse or server-fenced conflict. |
| 19 | Batch identity / at-most-once | One id per frozen batch; inject prepare response loss. Exactly one prepare, unknown record with nullable version id, no ineffective idempotency-header promise. |
| 20 | No inherited retries | Network/5xx/429 at each GET/prepare/PUT/finalize; missing_blobs and idempotency_in_progress. No automatic repeat, replacement credential, or new batch. |
| 21 | Exact confirmation / unknown finalize accepted | Clean finalize and commit-then-drop variants each issue one exact-version GET if time permits (not two). id+ready confirms finalization; no manifest-hash field assumed. Clean confirmed-live continues; ambiguous exits 7; no mutation replay. |
| 22 | Unknown finalize not resolved | Pending/404/lost/slow reconciliation, or deadline during finalize. Unknown remains; never equate cancellation/not-found with rollback. No read after deadline/signal. |
| 23 | Wrong receipt / superseded | Finalize lacks a version as on today's wire; embedded current version differs; exact-id confirmation is wrong-id/pending/live:false, or body oversized. Never acknowledge competing id; ready/live:false is superseded exit 5. |
| 24 | 429 budget | Any phase returns 429 with small/large/malformed Retry-After. Exactly zero automatic retries/sleeps; safe numeric advice only, exit 7, bounds intact. |
| 25 | Bounded exit | Fake monotonic clock, endless edits, hanging request/body, publish-slot exhaustion and slow scans. No new work after deadline, request/body abort, max slots/scans/HTTP attempts respected. |
| 26 | Signals | Signal during collection, prepare, PUT, before/during/after finalize; second signal/SIGKILL variants. Exit 130 when controlled, no later mutation; unknown survives; no guaranteed object after forced death. |
| 27 | Machine summary | Pipe stdout/stderr; success/error/early validation/dry-run. One parseable schemaVersion 1 object, exact counters/ids, <=10 batches/32 KiB, no NDJSON/progress stdout. |
| 28 | Output safety/backpressure | Token/path/control-character sentinel and malicious server errors/URLs/next; blocked/broken stdout. No sensitive echo or instruction execution, bounded output, stop subsequent mutations. |
| 29 | Origin/credential boundary | Cross-origin/redirected prepare/upload/finalize; non-member, unrestricted member, missing scopes, wrong-site restriction. Non-member/unrestricted exit 3 after identity, missing scopes exit 3; mismatched slug returns site_not_found/404, exit 4, indistinguishable from absence. No forwarded credential or widening. |
| 30 | Read-back / no side effects | Exact immutable-id read-back matches fixture; request log contains only specified reads, manifest prepare, serial blobs and finalize. Config/HOME/tree unchanged; no browser, cleanup or background process. |

## 10. Resources, rollout gates and stop rule

No new packages or infrastructure; use existing instance resources and Node
built-ins. Costs are bounded, not zero: up to ten attempts can create pending or
ready metadata, upload distinct bytes and retain old versions. Each session can
send at most 160 MiB of file bodies before protocol overhead; fixed HTTP/time
caps also apply. Server policy may impose lower limits; refuse rather than split
or purchase capacity. Collector hashing can read up to the scan cap times the
local byte cap, plus held-snapshot verification; this CPU/I/O trade-off is why
large trees and network mounts are excluded. No paid worker, raised provider
limit, credential grant or cleanup exemption is assumed. No new spend.

Before any build: save CEO intent alignment to this exact revision and a narrow
CISO disposition on repeated credential use, file-link exposure, strict origin
binding, heuristic scan limitations and unknown outcomes. Existing scopes are
unchanged, but repeated unattended-in-session remote mutations are a new
workflow; do not self-certify that security disposition unnecessary. Routing is
not an approval result. A separate planner cut and acceptance-test pair follows
only after those design gates. This design card finishes when its docs PR is
merged and routing is saved; it does not wait for alignment answers or create
implementation cards. Decision receipts belong in the task system, not as
invented approvals in this public document.

**Design metric, review 2026-11-02:** one complete merged canonical spec, matching
saved task document, all numbered future cases mapped, and recorded intent /
security routing; runtime acceptance count remains zero. For an eventual pilot,
require zero overlapping batches, unfenced writes, blind mutation retries,
secret-output incidents and executions exceeding configured work budgets on
supported fixtures. Stop the pilot on the first violation and return to explicit
publishing. Recommend no-build if correctness needs unbounded polling, bypassing
a conflict fence, weaker ignore/secret checks, unsupported cancellation claims,
new authority or unapproved infrastructure. Do not relax a failed check to make
watch look usable.
