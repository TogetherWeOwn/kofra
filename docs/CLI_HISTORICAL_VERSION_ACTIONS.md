# Explicit historical version actions (proposed)

**Historical CLI selection remains design only — not implemented or approved
for activation.** This is the canonical proposal for selecting an explicit version
in CLI restore/delete, including a version older than the newest 500. The separate
P1–P4 server prerequisites in §5.1 may be implemented without activating that CLI
selection change. In particular, §3.4 describes P3's implemented retry/replay
prerequisite, not approval to bypass the remaining STOP/H15 gates. The consumer
is an agent performing an already-authorized action, not discovering authority.

## 1. Current behavior and evidence

Source baseline: `c6472c959ad970a69aba9dff46986562bf66ac89`.
Paths/lines below refer to that revision, not future implementations.

| Area | Verified behavior | Source |
|---|---|---|
| CLI selection | `restore SITE [REF]` and `delete SITE --version REF` both search one ready-only, newest-500 list. An older explicit ref fails locally with `version_not_found`, even if it exists. They then send the selected ID, not the number. | `packages/cli/src/main.ts:189-214,728-764` |
| Omitted restore | From that same window, find the live row; choose the highest-numbered other row below it. If live is absent from the window, choose the highest-numbered other row. No candidate means `no_previous_version` (exit 4). This is not necessarily the last version that was live. | `packages/cli/src/main.ts:198-206` |
| Direct reads | `getVersionDirect` uses one encoded `GET /sites/{site}/versions/{ref}`; it refuses empty/dot/dotdot segments locally. Reads already work beyond the window. | `packages/cli/src/main.ts:222-241` |
| Server selection | `resolveVersionRef` trims; empty/`live` means live; case-insensitive `vN`/`N` (1–9 digits) queries by number; otherwise query by ID. Number/ID queries bind the site, with no ready-only filter or list cap. Missing or hard-deleted rows return 404 `version_not_found`. | `packages/core/src/services/site-ops.ts:70-88` |
| Version status | `get_version` returns pending as well as ready versions. Pending can include missing hashes and fresh upload items for write-capable callers. Ready `missing: []` is not a new integrity check. Top-level `site` is a slug, not a site ID. | `packages/server/src/operations/versions.ts:9-60`; `packages/core/src/services/uploads.ts:54-76` |
| Restore checks | The operation loads the site with `sites:write`; the service refuses transfers, requires a ready version, and treats already-live as a no-op. Otherwise it flips the live pointer, refreshes cache and emits publication. The service relies on the caller's authorized site; it does not independently reauthorize it. | `packages/server/src/operations/core-api.ts:816-861`; `packages/core/src/services/deploys.ts:548-565` |
| Delete checks | The operation requires `sites:delete`; the service reloads authorization, refuses transfers and the live version, then deletes version/file metadata and updates usage. The service **allows pending non-live versions**; it does not directly delete R2 blobs. The current CLI cannot select pending rows. | `packages/server/src/operations/versions.ts:83-120`; `packages/core/src/services/deploys.ts:569-580` |
| Isolation | Site access checks tenant, optional key site restriction and read access, then the requested mutation scope. Foreign/unreadable/deleted sites are 404; a visible site with insufficient scope is 403. A claim token remains limited to its anonymous site. | `packages/core/src/services/sites.ts:70-96` |
| Confirmation | CLI deletion needs `--yes` or a matching typed site argument in a terminal. JSON/non-TTY never prompts. MCP additionally requires `confirm` equal to the canonical site slug; REST DELETE has no confirm field today (P2 in §5.1 adds one). Restore has no confirmation today. | `packages/cli/src/main.ts:258-264,744-764`; `packages/core/src/services/site-ops.ts:91-98`; `packages/server/src/operations/versions.ts:104-120` |

**Numbers are not immutable identities.** Inserts allocate `MAX(number) + 1`
(`packages/core/src/services/deploys.ts:252-254`); deleting the maximum can let a
later version reuse its number. `v3` and `3` are lookup conveniences. Only the
returned `ver_…` ID pins the selected version across later calls.

**Preflight is not a transaction fence.** Restore's UPDATE is fenced only by site
ID; delete's non-live check precedes its batch (`deploys.ts:548-579`). Neither
has an expected-live/base-version compare-and-swap. A successful GET cannot
reserve a target, guarantee its continued existence or prevent an in-service
live-state race. Even a site-ID reference resolves to a slug before access
checks (`site-ops.ts:57-67`); do not claim atomic slug/ownership fencing.

## 2. Two choices

| Choice | Benefit | Cost / boundary |
|---|---|---|
| A — retain bounded selection | No changed destructive-target reachability; pending stays unreachable from the CLI. | Explicit old IDs still fail outside the list window. Pagination would add reads but would not solve immutable identity or mutation races. |
| B — direct lookup for explicit refs only (**accepted as intent; build gated on P1–P4**) | Existing `get_version` locates an exact old version with one logical GET; mutate only its returned immutable ID. No new endpoint or dependency on pagination. | Expands the CLI's reachable ready history. Must explicitly exclude pending/`live` shorthand, retain confirmation, fail closed on empty flags, and disposition existing service races and retries before implementation. |

This changes convenience-command reach, **not server authority**: REST, MCP and
`kofra api` already target old IDs directly. Pending exclusion is a CLI-wrapper
compatibility rule, not a server-wide security barrier. It cannot prevent an
already-authorized caller from invoking the existing pending-delete operation.

Omitted restore/rollback remains Choice A, including its bounded previous-rule
edge cases. Bare history listing, explicit read commands, backend pagination,
site deletion and the generic `api` escape hatch are separate contracts.
This proposal does not authorize changes to those surfaces.

The separate [pagination proposal](https://github.com/TogetherWeOwn/kofra/pull/82)
is design-only and covers enumeration, not destructive selection. The shipped
[explicit-read change](https://github.com/TogetherWeOwn/kofra/pull/44) deliberately
left restore/delete alone. Neither is implementation approval for this proposal.

## 3. Proposed normative AX contract

“MUST” below describes a future accepted implementation, **not today's CLI**.

### 3.1 Parse before any action

- Require an explicit nonempty site positional. Never infer a site from
  `dropway.json`, the current directory, environment or a previous command.
  For these changed explicit-version actions, require explicit `--api` to pin
  the instance; keys keep existing precedence. This tightening is accepted as
  product intent (D2, §5). It does not alter omitted restore in this slice. Preserve explicit
  slug/site-ID/site-URL inputs; trim once and reject empty/dot/dotdot or control
  characters locally with `usage`. Never decode a site ref before encoding it
  as one path segment. Dry-run validates this syntax, not site existence.
- Distinguish **absent** `--version` from present-but-empty. `delete SITE
  --version=''` MUST refuse; it MUST NOT fall through to whole-site deletion.
  Only a genuinely absent version flag can enter the unchanged site-delete path.
- Trim a supplied ref once. Accept positive 1–9 ASCII digits with optional
  case-insensitive `v`, or an opaque ID matching `^ver_[A-Za-z0-9_-]+$`
  (at most 255 ASCII characters including prefix). ID equality is byte-exact,
  case-sensitive after the one trim. Leading zeroes are lookup syntax, not
  identity. These two full-string grammars reject every other character,
  including any `%`, slash or backslash. Reject zero, overlong numeric refs,
  empty/whitespace, `live`, dot/dotdot, separators, percent escapes, query/fragment
  characters, embedded whitespace and controls before config/credential reads
  or networking. Never percent-decode an input ref or reinterpret it as a URL.
- Preserve unknown-flag and surplus-positional refusal. `restore SITE --version
  v1`, `delete SITE v1`, a missing site, and invalid dry-run flag combinations
  MUST NOT select another operation. Repeated target/mode flags (`--version`,
  `--api`, `--dry-run`) MUST refuse rather than silently use the last value.
  Presence/parse checks precede every request. No new `--force`, inferred
  execution mode or “use latest instead” fallback.

### 3.2 Resolve once, then pin

1. Validate syntax/mode and the explicit instance. In execution mode, resolve
   credentials using existing rules; never store or print them.
2. Call existing `get_version`: `GET /api/v1/sites/{site}/versions/{ref}`.
   Encode each path segment once. Do not list versions or follow pagination.
3. Require a well-formed returned version: valid opaque `id`, positive safe
   integer `number`, `status` exactly `ready`, boolean `live`, and a nonempty
   canonical site slug. For an ID input the returned ID MUST equal it; for a
   numeric input the returned number MUST equal it. A mismatched/malformed
   success response refuses before mutation (proposed CLI-only
   `invalid_version_response`, exit 1, retryable false; not an existing code).
4. Pending MUST refuse both actions locally with existing `version_not_found`
   (exit 4, retryable false), even though direct inspection can show it and
   backend deletion could delete it. Do not finalize, upload or delete pending
   work as a side effect. Unknown/deleted refs propagate the server error.
5. Deleting a version reported live MUST refuse with existing `version_is_live`
   (exit 5); restoring an explicit ready ID already live retains the server's
   successful no-op. `live` shorthand itself remains invalid for mutations.
6. Preserve CLI delete confirmation UX exactly: `--yes`, or a terminal prompt bound
   to the explicit site argument and selected version number. Without `--yes`,
   JSON or either non-TTY stream refuses `confirmation_required` (exit 2), never
   prompts and never sends DELETE. Restore gains no confirmation in this proposal.
   The request additionally carries the P2 `confirm` wire field (§5.1); prompt and
   `--yes` behavior do not change.
7. Send only the returned immutable version ID through the existing operation:
   `POST /api/v1/sites/{site}/versions/{id}/restore` with `{}`, or
   `DELETE /api/v1/sites/{site}/versions/{id}` with the P2 `confirm` field (§5.1).
   Keep the explicit site argument
   unchanged across lookup/mutation; do not replace it with a guessed ID or the
   returned slug. Existing endpoints already accept site IDs. No new route,
   grant, capability token, confirmation bypass or authorization cache.
8. Server mutation authorization still runs independently of GET success.
   Forward its errors unchanged; never convert 403/404/409 into success or retry
   by resolving another number, site, or credential. A changed/deleted target
   fails or has the existing service semantics; it never selects a substitute.

If a site is renamed or its old slug is retargeted between requests, the same
version ID MUST NOT be replaced: resolution on a site without that ID returns
404. Do not retry via a new slug, convert this into site deletion, or claim that
site-ID input closes the in-service rename/ownership race. That latter race is
covered by the server-fencing prerequisites in section 5.1.

Numeric refs agree with IDs only for the same fixture/lookup moment. Agents
intending a previously inspected object MUST carry its ID, not reconstruct a
number. A target becoming live **between requests** should hit the service's
`version_is_live` check. An interleaving **inside** that service is the unfenced
case in section 1, not solved by this CLI proposal (prerequisites P1 and P2, section 5.1).

### 3.3 Receipts and recovery

Keep one JSON object on stdout with `--json`; progress/prompts only on stderr.
Reuse the [existing envelope and recovery metadata](../packages/cli/README.md#output-for-agents),
not a new RFC-shaped wrapper or a `next_action` alias:

```json
{"ok":false,"exitCode":4,"error":{"code":"version_not_found","message":"Version not found.","hint":"Inspect the explicit version reference; do not substitute a recent version.","retryable":false}}
```

That is a shape example, not a replacement for a server's actual message/hint.
Preserve server `status`, `requestId`, `details`, explicit `retryable`,
`retryAfterSeconds`, `docs` and `next` when supplied/valid. Local refusals omit
HTTP status/request ID, rather than fabricating a server response. `next` stays
informational; no suggested call is automatically executed.

| Failure | Exit / code | Next action (hint; never an automatic mutation) |
|---|---|---|
| Invalid explicit ref, including `live` | 2 / existing CLI `invalid_version_ref` | Supply an exact ID or positive `vN`/`N`; inspect it with `versions SITE REF`. |
| Bad flags/site missing/explicit instance missing | 2 / existing `usage` | Correct the named argument; pass explicit site and `--api`. |
| Invalid explicit instance URL | 2 / existing `invalid_api_url` | Fix the HTTP(S) origin; existing `normaliseApi` semantics apply in execution and dry-run. |
| Non-TTY/JSON delete without `--yes` | 2 / `confirmation_required` | Confirm intent separately, then explicitly rerun with `--yes`. |
| Terminal answer mismatch | 2 / `not_confirmed` | No deletion; review the site/ref before starting again. |
| Missing key or mutation scope | 3 / `not_logged_in` or server auth code | Use the intended authorized credential; never broaden scope automatically. |
| Pending / missing version; foreign version on an authorized site | 4 / `version_not_found` | Inspect the same ref. Pending needs a separate authorized upload/finalize workflow, not an action retry. |
| Hidden/foreign/deleted site | 4 / `site_not_found` | Verify the explicit site under the intended credential; do not reveal foreign metadata. |
| No previous candidate (omitted restore only) | 4 / `no_previous_version` | Inspect history; no substitute target. |
| Live delete / immutable transfer | 5 / `version_is_live` or `transfer_immutable` | Review another authorized operation; do not automatically restore/revoke first. |
| Server validation / transient failure | Existing mapping: 400/422→6; 429/5xx/network→7 | Preserve server hint; exit 7 alone is not permission to replay an uncertain write. |

Restore success remains `{ok:true, restored, alreadyLive, version, url}`;
`version.id` is the selected immutable ID. Delete success remains
`{ok:true, deleted:true, id, slug, version}` where `id` is immutable and
`version` is the selected display number. No upload credentials, config writes,
preview signing, browser navigation or invented site identity in the receipt.

### 3.4 Retries are not replay protection

P3 selects the **replay alternative**, replacing the earlier 429-only proposal.
MCP annotations alone are not replay protection, and custom REST adapters still
bypass generated replay. Both surfaces now call the core version-action workflow
explicitly; its [bounded replay contract](OPERATIONS.md#version-action-replay)
authorizes before replay and retains pending claims after uncertain errors.

All CLI restore invocations (including omitted-version restore) and version-delete
invocations pass `retry: "none"`: one mutation attempt, including on 429. The typed
SDK methods enforce the same policy; GET retains ordinary read retries. There is
no automatic retry on network/5xx/409 and no retry loop or follow-up probe in the
CLI. Each deliberate invocation sends a fresh UUID `Idempotency-Key` without
printing or saving it; there is no `--idempotency-key` flag for these actions.
A future explicit-ref implementation must retain this policy, not reintroduce
bounded 429 retries. Omitted restore's selection algorithm remains unchanged;
its unsafe mutation-retry behavior is intentionally removed by P3.

An explicit API/SDK consumer can retain a key and submit the identical request
under the same current authorization to retrieve the first stored successful
result. Input includes the authorized immutable site and originally submitted
version ref (plus delete confirmation), not a freshly selected target/pointer.
Unknown/pending results fail closed with 409; changed input returns 422. Replay is
credential/restriction-scoped, REST/MCP-separated and limited to 24 hours, not an
unlimited exactly-once guarantee. On an unknown outcome, inspect the same ID/site
and decide whether to make a fresh intentional invocation. A current live pointer
or 404 cannot prove who performed the action, and must never synthesize success.

### 3.5 Offline dry-run for the changed action surface

Add `--dry-run` to explicit-version restore/delete only. It MUST validate the
same syntax and emit one JSON plan even without `--json`, exit 0, with no
instance/credentials required, no prompt, **zero fetches and zero filesystem
reads/writes**. It branches before instance/config/key resolution. Example:

```json
{"schemaVersion":1,"operation":"delete_version","site":"history-site","versionRef":"v1","resolution":"unresolved","confirmationRequired":true}
```

Restore uses `operation: "restore_version"`, `confirmationRequired: false`.
If explicitly supplied, include `api` as a syntactically validated normalized
origin, never a key. Do not invent a version ID, readiness, permission verdict,
HTTP request receipt, or claim that the action would succeed. `--yes` changes
neither plan nor effects. An absent version (`restore SITE --dry-run` or
`delete SITE --dry-run`) MUST refuse with `usage`, exit 2; it must not preview
or enter the omitted-restore/site-delete paths. A supplied `--dry-run=false`,
`--dry-run=0` or `--no-dry-run` MUST refuse with `usage`, exit 2, before any
reads/requests; an agent's attempted preview must never silently enable execution.
Executing requires a fresh command with no dry-run flag and all execution
preconditions. This command-specific rule does not change the global parser.

## 4. Acceptance recipe — specified, not implemented or run

Future test files/commands (they do **not** exist in this design change):

```sh
npm run test:cli -- test/historical-version-actions.acceptance.test.ts
npx vitest run test/historical-version-actions.test.ts
```

Use the real CLI `run(argv, Io)` with injected `Io.fetch` as in the unchanged
`packages/cli/test/explicit-version-refs.acceptance.test.ts`, plus disposable
workerd D1/R2/KV service fixtures. Never run mutation examples against a real
instance. Sentinel keys are generated test data, never copied credentials.

Fixture F: owned `history-site`, ready numbers 1…601, live 601, pending 602;
`ver_old` = number 1 (absent from newest-500 list), `ver_live` = 601. Also own
site B, foreign site C, read-only and site-restricted keys. For number reuse,
use separate F-reuse: ready 1…3, live 2, no pending rows; resolve 3, delete 3,
then insert/finalize a distinct ID sequentially at number 3. Concurrent insert
allocation/UNIQUE-conflict retries are not part of this selection contract. In every CLI case
append `--json --api https://actions-fixture.example` unless explicitly testing
missing instance or offline behavior. Capture parsed stdout, exit, prompts,
all method/path/body calls and filesystem read/write spies. Snapshot local files
and D1 rows/pointer/usage, R2 keys/bytes and cache effects. Count writes after
fixture setup; no refusal or dry-run may cause one. Fail closed if injected
transport is not used. Each table row is a separately parameterized test.

| Case | Input / controlled interleaving | Required assertions |
|---|---|---|
| H1 old restore | `restore history-site v1` | Exit 0; one logical direct GET, then POST with `{}` and `ver_old` in path; no history GET; receipt `version.id=ver_old`; only F's pointer changes. |
| H2 old delete | `delete history-site --version v1 --yes` | Exit 0; GET then DELETE `ver_old`; `{ok:true,deleted:true,id:"ver_old",slug:"history-site",version:1}`; no site DELETE, other versions unchanged. |
| H3 equivalent refs | Fresh F for each of `v1`, `1`, `V01`, `ver_old`, for both actions | Same immutable mutation path/receipt; no listing. Equality is within unchanged F, not forever-stable numbers. |
| H4 live moves before mutation | Resolve `ver_old`; move live to 600 before POST; separately move live to `ver_old` before DELETE service begins | Restore still targets `ver_old`, never 600. Delete returns server 409 `version_is_live`, exit 5, no delete writes. GET's `live:false` does not override the server. |
| H5 target deleted / number reused | Resolve number 1 to `ver_old`, delete it before mutation; separately delete/reuse a non-live apex number after lookup | Mutation remains ID-bound, 404/exit 4 if gone; no lookup by number again, no mutation of replacement ID. Future invocations using a reused number can resolve differently: document this, never assert permanent number identity. |
| H6 foreign scope | Use C's site with restricted key; C's version ID on authorized F; F with read-only key; rename F and retarget its old slug to B between GET and mutation | Respectively `site_not_found`/4 with no mutation; `version_not_found`/4 with no mutation; GET may succeed but action returns `insufficient_scope`/3 with no writes; slug-retargeted action returns 404/4 and leaves B unchanged. No foreign identifiers or upload items in CLI output. |
| H7 pending and live | Both actions with pending 602 or its ID; delete with `ver_live`; restore with `ver_live` | Pending: local `version_not_found`/4, no POST/DELETE despite backend pending-delete support. Live delete: local `version_is_live`/5, no DELETE. Ready live restore: server no-op, exit 0, `restored:false,alreadyLive:true`, no pointer/event write. |
| H8 malformed / encoded | Both actions with `''`, spaces, `.`, `..`, `live`, `v0`, ten digits, `v1/restore`, backslash, `%2e%2e`, `%252e%252e`, `%2f`, `ver_x?y`, `ver_x#y`, newline, non-ASCII ID | `invalid_version_ref`/2, zero fetches/config reads/writes/prompts. No normalized parent/list/site route is contacted. Test argv values directly, not shell-escaped approximations. |
| H9 wrong mode | Empty `--version=`, absent site, `delete history-site v1 --yes`, `restore history-site --version v1`, surplus positional, unknown flag | Exit 2 with `invalid_version_ref` for the empty ref, `usage` otherwise; zero requests/writes. An empty version never becomes site DELETE. |
| H10 confirmation | Non-TTY or `--json` delete without `--yes`; terminal mismatch; terminal match | First two: `confirmation_required` or `not_confirmed`/2, no DELETE. Match or `--yes`: only selected version DELETE; never whole-site DELETE. No non-TTY prompt. |
| H11 dry-run | Both explicit actions, with/without `--api`, `--json`, `--yes`, missing key, unreadable config; also absent version, `--dry-run=false`, `--dry-run=0`, `--no-dry-run`, repeated target/mode flags, and execution without `--api` | Valid plan equals §3.5, exit 0; zero network/filesystem/prompt calls. All listed invalid modes refuse `usage`/2 with zero reads/requests. Malformed refs still refuse. |
| H12 omitted compatibility | `restore history-site`; F with live outside list; F with no previous candidate | Existing list-only algorithm/receipt unchanged, including fallback when live is absent and `no_previous_version`/4; no direct GET added. Baseline this separately from explicit-ref tests. |
| H13 retry / unknown result | GET 503 then success; action 429/503/network loss; deletion succeeded but response lost | Reads retry within existing bounds. Mutations make one attempt, including 429; return exit 7 and the actual error. P3 selects replay instead of pre-commit-proof/429 retries. An explicit same-key API/SDK replay retrieves only a stored receipt; a pending outcome is 409. A later 404 is not synthesized success/replay. |
| H14 envelope / malformed success | GET/action return existing error metadata; GET 200 with missing/invalid ID/status/live/site or mismatched ID/number | Error fields pass through unchanged. Malformed/mismatched GET refuses `invalid_version_response`/1 before mutation; stdout is exactly one JSON value, no credentials/upload links. |
| H15 service race characterization | Pause DELETE after non-live read, restore that ID concurrently, then resume; pause restore after target lookup, delete target, then resume | Characterize current unfenced results in disposable service tests. Do **not** label them safe or make a CLI-only fix pass this safety gate. Implementation cannot start until prerequisites P1–P4 (section 5.1) merge. |

Also retain unchanged site-delete, legacy-brand, binary `--version`, explicit
read and surplus-positional suites; never edit their protected acceptance files.
No new acceptance tests are authored by this documentation slice.

## 5. Decisions and implementation STOP

D1, D2 and D4 are **accepted as product intent only**; merging this doc
authorizes no build. D3 is dispositioned in section 5.1. Implementation stays
stopped until P1–P4 merge:

- **D1 — intent (accepted):** direct selection of any existing ready historical
  version for explicit CLI actions (option B), while leaving omitted restore,
  listing, explicit reads and pagination unchanged. Intent only; no build yet.
- **D2 — product surface (accepted):** explicit `--api` on changed execution
  paths, the ref grammar/`live` refusal, offline plan schema and no confirmation
  change for restore, as a bounded CLI contract. Deletion confirmation UX and
  site-delete behavior stay intact.
- **D3 — security disposition (recorded, see 5.1):** approve with mandatory
  server prerequisites; a CLI-only activation is not authorized.
- **D4 — error contract (accepted):** the proposed CLI-only
  `invalid_version_response` code and existing-code reuse for local pending/live
  refusals; server code/hint/metadata fidelity remains unchanged.

### 5.1 D3 disposition: prerequisites before any implementation

Security disposition: **approve with mandatory prerequisites; do not authorize
CLI-only activation.** Without them there is no safe scope: the change widens
destructive reach to all ready history (and sequential-number enumeration)
while check-then-act races, slug re-resolution across the CLI's two requests and
post-effect retries stay unfenced. Per-request authorization bounds privilege
(unknown and foreign sites both return 404) but does not pin (site, version,
live) across requests.

With the prerequisites, the safe scope is: explicit `vN`/`N`/`ver_` refs
resolved by direct GET beyond the newest-500 window; pending versions stay
unreachable from the CLI (a wrapper convenience, **not** a security boundary,
since the server read APIs already serve pending IDs); scopes and user-facing
confirmation UX unchanged (CLI `--yes`/prompt, restore gains none, MCP
`confirm=slug`); the returned immutable ID pinned for the mutation. The one
ordered exception is P2's HTTP DELETE wire field below, which ships atomically
with every caller — never as a server-only change.

P1 and the complete P2 ship together as one integrated prerequisite: restoring
and deleting must preserve the same live-pointer invariant. Both retain their
acceptance requirements; after the combined merge and P2 acceptance, P3 then P4
must merge before a historical-action implementation card starts:

- **P1 — atomic restore.** Existence, site ownership and expected-live
  compare-and-swap in one batch, reusing the `finalizeDeploy` conditional-update
  and conflict pattern (`packages/core/src/services/deploys.ts`). The expected-live
  anchor is the freshly service-loaded site row's live pointer, not a CLI-supplied
  token. Compare its **value at the atomic fence**, including exact NULL: a value
  different from the anchor returns 409 (CLI exit 5, no retry), even if it equals
  the requested target. The achieved state is not this request's replay receipt;
  the caller makes a fresh intentional invocation instead. **A→B→A may succeed**
  when the value is back at the anchor and all other predicates hold. This is not
  mutation-generation/history-sensitive fencing or proof that no writer ran;
  timestamps are not a generation substitute. Entry already-live stays write-free.
  Preserve the incoming service site ID through normal authorized reload, refusing
  a replacement identity with a non-disclosing 404 before target lookup or no-op
  metadata. This guard binds one service invocation, not separate CLI requests or
  raw-ID resolution end to end; it does not add slug CAS or rename/event receipt
  guarantees. A target deleted between check and flip must fail, never leave a
  dangling pointer.
- **P2 — atomic delete and confirm parity.** Fence the entire deleting batch
  on the target still being non-live and belonging to the authorized original
  active site. Refusal leaves manifest rows, version rows and usage unchanged,
  including when restore or pending finalization makes the target live after
  preflight. Enforce server-side `confirm` (canonical site slug, same
  `requireConfirm` semantics as MCP) on HTTP `DELETE /sites/{slug}/versions/{id}`
  with JSON body `{"confirm":"<canonical-site-slug>"}`. This breaks the prior
  bodyless HTTP contract: the handler, HTTP schema, CLI, dashboard, generated
  SDK `DeleteVersionInput` and REST-parity tests MUST change in the same combined
  P1+P2 merge. A server-only change would break existing callers. CLI prompt/`--yes`
  behavior and restore confirmation stay unchanged; historical-action
  implementation stays stopped until all four prerequisites are complete.
- **P3 — retry proof.** Show every layer that can emit 429/5xx on these routes
  is strictly pre-commit, or drop automatic retry on mutating POST/DELETE (429
  surfaces as exit 7, explicit re-run) and add idempotency-key replay. The two
  branches are alternatives: the pre-commit-proof branch keeps bounded 429
  retries (H13); the replay branch replaces automatic 429 retries with
  idempotency-key replay semantics its card defines. Narrowing
  restore to 429-only does not by itself prove pre-effect. Never synthesize
  success from a later 404 or live-pointer read.
- **P4 — pending/mode bar stays server-side.** Restore keeps rejecting non-ready
  versions; delete's allowance for pending non-live versions is accepted
  explicitly, not described as unchanged.

Conditions on the later implementation card: bind the delete prompt — what the
operator approves — to the immutable version ID actually mutated (the prompt
today shows slug and display number while the request sends a hidden ID); this
prompt binding is distinct from P2's wire value (the site slug). Race tests gate
on the server fence across live-move, publish, restore, delete and rename
interleavings, not CLI behavior alone; number-reuse and enumeration-expansion
risks are accepted in writing; staging end-to-end only; no new grants or scopes.
Implementation stays stopped until P1–P4 merge.

Record product intent and security dispositions in the associated task decision
record before a future bounded implementation card starts. A docs review is not
that authority. No implementation/build child is created by this slice. Future
implementation needs separately authored acceptance tests, all applicable
security/activation STOPs, exact-head CI/review and the normal release contract.

Non-goals: runtime fixes, pagination, historical reads, auth/scope changes,
confirmation redesign, migrations, new dependencies, data deletion, production
requests/tests, deployment, new grants/spend or host automation. Merging this
proposal is neither feature activation nor deployment evidence.
