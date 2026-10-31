# Public folder download as a bounded ZIP (design, v1)

**Status: proposed; design only, not implemented.** This document authorizes no
build, endpoint, deployment, new binding, credential, or spend. It is the
canonical future recipient contract, not a description of an available feature.
A separate implementation decision requires security disposition, product
alignment, and the measurement gates below. M3 candidate; ordering remains in
`docs/ROADMAP.md`. No transfer, authentication, email, or activation STOP changes.

## 1. Intent and evidence boundary

A recipient of a published folder should have one plain **Download folder** link,
instead of saving its files separately. V1 is a small convenience archive, not a
bulk-export service, backup, transfer delivery, or file-safety assurance. Kofra
does not scan files; an archive must never be described as scanned or safe.

Source baseline: `c6472c959ad970a69aba9dff46986562bf66ac89`, current `main` at
inspection on 2026-10-26. Citations below refer to that commit unless marked
otherwise. Inspection is not deployed-runtime verification.

| Current behavior verified from source | Evidence |
|---|---|
| Listings render immediate files and descendant-folder links, summary bytes for immediate files only, and at most 60 gallery images; no folder ZIP action | `packages/server/src/viewers/listing.ts:24-86` |
| Site URLs depend on serving mode; do not hard-code `/s/` | `packages/server/src/route-sites.ts:107-212` |
| Index names precede listings; a sole root file can replace a root listing; SPA/custom-404 fallback can resolve a nonexistent directory | `packages/server/src/serve.ts:45,75-94` |
| Transfers dispatch before ordinary site serving; ordinary expiry precedes the password gate, which precedes path resolution | `packages/server/src/serve.ts:278-355` |
| Ordinary expired sites answer 410 while present; cleanup can delete the old address, after which it is missing rather than a permanent 410 | `packages/server/src/serve.ts:299-320`; `packages/core/src/services/cleanup.ts:37-60` |
| Transfer file order is missing/deleted/file-missing 404, takedown 451, gone 410, password, bytes; its accounting and grants are separate | `packages/core/src/services/transfer-downloads.ts:9-27,103-135`; `packages/server/src/transfers.ts:104-119` |
| Ordinary-site takedown and general R-36 limiting are roadmap work, not implemented ordinary serving gates | `docs/ROADMAP.md:414-425,594-607`; `packages/server/src/serve.ts:299-355`; `packages/core/src/adapters.ts:45-72` |
| Reserved `__dropway/` rejection and `.dropway/*` stored-but-never-served are the intended contract, not safe assumptions about every manifest input and serving path | `docs/SPEC.md:1320-1321`; `packages/core/src/services/sources.ts:289-300`; `packages/core/src/services/deploys.ts:81-95`; `packages/core/src/services/live.ts:85-90` |
| Whole-version export is credentialed version-read access (`sites:read`, including a matching anonymous claim token), not an anonymous recipient endpoint; transfers are refused | `packages/server/src/operations/versions.ts:136-175`; `packages/core/src/services/sites.ts:70-92`; `packages/core/src/services/version-export.ts:217-222` |
| Export sorts by JavaScript UTF-16 code-unit path order; ZIP method 0, UTF-8 names, fixed 2020-01-01 timestamp, no data descriptors; CRC32 scans every byte | `packages/core/src/services/version-export.ts:38-125,224-235` |
| Export is pull-driven but buffers a whole file before emitting its header; no explicit cancel hook. Blob cache fills can add tee/buffering work | `packages/core/src/services/version-export.ts:128-180`; `packages/core/src/services/blobs.ts:18-47` |
| Export uses effective file/site-byte limits plus classic ZIP ceilings, not an independent anonymous cost budget | `packages/core/src/services/version-export.ts:224-260` |
| Default ordinary publishing allows 2,500 files. That is a manifest limit, not a proven safe count of archive storage reads | `packages/core/src/config.ts:210-229` |
| Public serving accepts a five-second isolate memo and valid KV records without a fresh D1 pointer check; D1 rebuilds on miss | `packages/core/src/services/live.ts:37-104` |
| Path normalization rejects exact normalized duplicates but neither folds case nor normalizes Unicode; maximum is 1,024 UTF-16 code units, not UTF-8 bytes | `packages/core/src/lib/paths.ts:3-24`; `packages/core/src/services/deploys.ts:60-131` |
| File HEAD/Range/conditional logic is not the listing renderer's contract | `packages/server/src/serve.ts:226-251,349-351,370-503`; `packages/server/src/viewers/listing.ts:31-35,78-86` |

A prior disposable local listing measurement at this same baseline exercised
2,500 direct rows. That evidence concerns HTML rendering only, **not ZIP CPU,
R2 reads, or production capacity**. The count is independently reproducible from
the publishing limit above. No archive benchmark was run for this design.

Filename dependency: public [PR #83](https://github.com/TogetherWeOwn/kofra/pull/83)
was OPEN, unmerged, at inspection (head
`1f04043af2d48fa679ac20a3f4bf32ed232bdce0`). Its proposed
`packages/server/src/content-disposition.ts:25-31` unifies ASCII fallback and
RFC 5987 `filename*`. This is an inspected proposal, **not shipped on the
baseline**. Future work must recheck its merged contract rather than copy an
unmerged helper or independently implement another header encoder.

## 2. Surface decision

**Choose a canonical site-relative folder URL with `?download=zip`.** Examples
use only the shared-origin shape; `siteUrl`/serving mode supplies the real base:

```text
/s/team-report/data/?download=zip     # data/ recursively
/s/team-report/?download=zip          # root recursively
```

- Add one ordinary anchor to an actual public listing, visible text and
  accessible name **Download folder**. Nearby static text: “ZIP, including
  subfolders; up to 100 files and 16 MiB.” It works with keyboard navigation,
  browser context menus and JavaScript disabled. No script, new tab, or reliance
  on the HTML `download` attribute. Server headers determine attachment behavior.
- Use the current directory, not the entire site. Link construction encodes each
  path segment once. It drops listing-only sort/filter query values. Existing
  per-file `?download=1`, `?raw=1` and viewer links remain unchanged.
- `download=zip` is case-sensitive, singular and exclusive: repeated `download`,
  or combination with `raw`, `view`, `embed`, or preview/version selectors is
  400 `folder_zip_invalid_request`, never a file download or alternate auth path.
  Unrelated listing sort values have no effect on selection, order or validator.
- AX is direct HTTP GET/HEAD with the same URL, not a new REST registry operation,
  MCP tool or CLI command. Agents may request it without owner credentials only
  when the site's existing recipient gate allows them. API keys are not a bypass.
- A nonslash path which really has eligible descendants redirects 308 to its
  slash form, preserving only `download=zip`, **after** site/password gates. An
  exact file at that path takes precedence and refuses 404 `folder_not_found`;
  it is never silently downloaded or treated as an extensionless page.
- Real indexed folders **are** downloadable at `folder/?download=zip`, including
  root and the single-file-root case. Ordinary navigation still serves its index
  or sole file and gains no injected link. A publisher may link the explicit URL.
  SPA virtual paths and custom-404 output do not create folders: they refuse 404.
- Live ordinary sites only. Historical previews, aliases that cannot be resolved
  authoritatively, alternate mounted/custom-domain serving not yet implemented,
  and transfer-mode/tombstoned transfer addresses cannot introduce another ZIP
  surface. Existing authoritative ordinary slug redirects may preserve the
  selector, but the destination reruns all gates; there is no cached archive
  redirect, signed archive capability, or version-ref parameter.

Rejected: `?download=1` on a directory (ambiguous with today's file contract), a
synthetic `folder.zip` filename (collides with published paths), a reserved
`__dropway/zip` endpoint (duplicates folder addressing and password continuations),
listing-only availability (needlessly excludes indexed sites), browser ZIP
assembly (many fetches, cross-origin/password and memory differences), and a new
MCP/CLI surface (not required for the recipient task).

## 3. Exact gate order and races

These are **future requirements**, not claims that ordinary takedown or limiting
already exists. The archive selector must be recognized before ordinary
index/SPA resolution, but not before the existing transfer-mode fence. A thin
server handler calls a public-folder service under `packages/core/src/services/`
with `dw` and an anonymous recipient `Principal`; it must not call owner
`exportVersionZip` with manufactured owner authority. Reuse recipient gate
semantics and ZIP primitives, not owner authorization or caps.

Transport/provider-wide DDoS controls may refuse before this application order.
They are not a substitute for the bounded origin admission below. Within Kofra:

1. **Authoritative address and mode.** Read D1, not the ordinary live KV/memory
   pointer. Unknown/deleted site -> 404 `site_not_found`; a valid retained ordinary
   rename -> no-store redirect to its current site address. `mode=transfer` or a
   transfer tombstone -> generic 404, before all ZIP work. A ZIP request never
   enters transfer download counting, password grants, or file enumeration.
   Ordinary transfer file requests retain their existing 404 > 451 > 410 > password
   order unchanged; rejecting the unsupported aggregate is not an R-52 extension.
2. **Live ordinary takedown/blocked-content policy**, from the authoritative
   security state -> 451 `site_unavailable`, generic message “This site is
   unavailable.” No grounds, path list, reason or count. This is above expiry,
   password and folder lookup. A hold alone is not a serving denial. Until the
   ordinary takedown/blocked-hash contract exists, ZIP activation is prohibited.
3. **Expiry.** Present site with `expiresAt < now` -> 410 `site_gone`; equality
   still permits access. After cleanup removes its old address, step 1 is 404.
4. **Recipient isolation and password.** Preserve existing cross-site non-navigation
   restrictions (403) and the ordinary site's digest-bound cookie gate. Locked
   navigation -> the ordinary 401 password form; locked machine request -> 401
   `site_password_required`, no manifest details. HEAD has the same status and no
   body. Unlock remains the existing POST mechanism, not a GET secret/query token;
   its constrained same-site continuation must preserve `download=zip`. No CORS
   read grant on passworded archives. A password change invalidates prior unlocks.
5. **Cheap metadata admission.** Every candidate past the recipient gate
   atomically debits the section 7 metadata budgets, **before any manifest-row
   enumeration or folder lookup**. Missing trusted client or unavailable counter
   -> 503; exhausted -> 429. This also bounds cap/missing-folder/hostile-selector
   probes: once exhausted,429 wins over those later refusals. Earlier site,
   takedown, expiry and password refusals keep their earlier precedence.
6. **Selector, method and folder resolution.** Decode once, reject malformed or
   unsafe paths/selector combinations (400); GET/HEAD only, otherwise 405 with
   `Allow: GET, HEAD`. OPTIONS grants no ZIP metadata or gated CORS access. Resolve
   a ready live version; apply section 4's manifest-row bound and namespace
   exclusions before determining existence. No version, reserved prefix, or no
   eligible descendants -> 404 `folder_not_found`. An exact file matching the
   requested path without its final slash also wins 404 over its subtree. A real
   nonslash folder now 308s to its canonical slash URL with only `download=zip`,
   spending cheap admission but no body budget. Slash-form requests continue.
7. **Bounded selection and Range/preconditions.** Count and sum the entire eligible
   subtree. Selected blocked hashes ->generic451 before cap/name metadata, never
   an “everything except blocked files” ZIP. Otherwise count cap precedes aggregate
   byte cap, then per-file byte cap, then unsupported-name refusal. This precedence
   is intentional even for over-cap hostile names. Complete only the bounded
   metadata scan; no blob/content scan, hostile-name log or silent truncation.
   Then any Range (including malformed/multipart) -> 416
   `folder_zip_range_unsupported` before `If-None-Match`; `If-Range` enables nothing.
   Unsupported write/date preconditions (`If-Match`, `If-Unmodified-Since`,
   `If-Modified-Since`) -> 400 `folder_zip_invalid_request`, not false 304. These
   refusals spend cheap admission, never body allocation.
8. **Classify conditional and reserve body admission.** Compute the candidate
   validator from pinned metadata. Matching `If-None-Match` (list, weak comparison
   or `*`) and HEAD need no body reservation. An unconditional GET or conditional
   miss additionally atomically reserves all full-GET buckets. No partial debit
   within this body reservation; an already-spent cheap admission is not refunded
   when body admission refuses 429/503. No blobs/generator opened yet.
9. **Final authoritative fence.** Immediately before 200/304 headers, recheck site
   existence/mode, takedown, expiry, password digest, selected-hash denial and live
   version/name identity. A new denial wins using steps 1-4; otherwise a changed
   live pointer/name -> 409 `folder_zip_changed`. No automatic restart, new
   classification or extra debit. Therefore the conditional comparison in step 8
   is usable only if this fence passes unchanged.
10. **Respond.** Confirmed conditional match -> 304; otherwise HEAD -> 200 metadata
    only; admitted GET -> deterministic stored stream. No admission refunds.

The pinned manifest is immutable throughout one response. A republish cannot
mix versions or put old bytes under a new name. The fence defines admission at
header commit, not an impossible transaction spanning D1, network and R2:
republish/revocation/takedown **after** headers cannot recall delivered bytes.
The response remains the admitted version, named as that version. No claim of
instant revocation of an in-flight download; this residual risk needs security
disposition. Reader cancellation must stop future blob reads and cancel the
active reader; no archive work continues in `waitUntil`.

## 4. Inclusion, entry paths and bounds

Selection is recursive by exact canonical manifest prefix: `data/` includes
`data/a.txt` and `data/nested/b.txt`, never `database/c.txt`. Every eligible root
file is a descendant of prefix `""`, so the sole-file root is downloadable.
Only-excluded subtrees are indistinguishable from missing folders (404). For
requested `a` or `a/`, an exact manifest file `a` wins with 404 even when `a/...`
exists; requesting the parent/root instead detects the selected `a` + `a/b`
conflict and refuses 422. Strip only the selected prefix. Root strips nothing. Entries are relative files, not a wrapper
folder, and are sorted by the existing export's explicit **UTF-16 code-unit**
comparison, not locale or SQL ordering. No directory records, symlinks, executable
attributes, comments or extra generated files. Download original stored bytes;
no HTML rewriting, viewer output, gzip-sibling negotiation, or extraction.

Never include a path whose **site-root namespace** is `__dropway` or `.dropway`
(the exact name or slash-prefixed descendants), even if it appears in a manifest.
`__dropway/` is reserved, `.dropway/*` can be stored but is never archive content.
A nested ordinary name such as `notes/.dropway/readme.txt` is not the root
configuration namespace and remains an ordinary file, subject to name checks.
Exclusions occur before counts/bytes and folder-existence determination. Do not
rely on listing visibility or one publishing path having already filtered them.
No exclusion is described as a malware/secret scan.

### 4.1 Numeric limits (candidate operating envelope, not measured capacity)

| Bound | V1 choice and derivation |
|---|---|
| Eligible file entries | **100** inclusive, or lower effective administrative `maxFiles`; 25x below the existing 2,500-entry manifest allowance. Derived from a cold-read cost budget of at most 100 R2 GETs/request and the per-request cost ceiling in section 7, not from listing latency |
| Sum of logical file bytes | **16,777,216 (16 MiB)** inclusive, or lower effective `maxSiteBytes`. Count each path even for identical hashes. Each individual file also must fit the lower of 16 MiB and effective `maxFileBytes`; a per-file limit does not lower the aggregate limit |
| Entry-name bytes | **1,024 UTF-8 bytes** after prefix stripping, inclusive; separately reject non-round-trippable UTF-16. This is deliberately stricter than publishing's code-unit limit |
| Complete ZIP upper bound | `B + sum(76 + 2*UTF8(entry).length) + 22`, so at the maxima **16,989,638 bytes**; compute exact length before opening blobs |
| Cold storage reads | At most one R2 body GET per selected entry, no HEAD-before-GET, retries or fetches to public per-file URLs; at most one active body reader |
| Stream memory | Do not retain the whole ZIP. Initial envelope: one file buffer <=16 MiB plus names/central metadata; total measured peak including copies/runtime <=64 MiB. Backpressure and cancellation required |

The 16 MiB candidate reserves at most one eighth of Workers' documented 128 MiB
isolate allowance for the primary file buffer, leaving room for copies and
concurrent/runtime work. It is a memory-derived starting ceiling, **not a CRC
CPU result**. Worker limits are shared by an isolate; concurrency still needs
measurement. If an effective per-file administrative limit is lower, any selected
file exceeding it refuses `folder_zip_too_large` with that limit; do not silently
omit it. Effective policy is evaluated for the target site's ownership as today,
without granting an anonymous caller owner identity. A future service may not
raise a public cap from an owner policy limit.

Metadata scan also needs a bounded input: refuse 413 `folder_zip_manifest_too_large`
when the ready version's stored count exceeds **2,500**, regardless of selected
subtree size, without loading its rows. Otherwise read at most 2,501 indexed rows
for that version. Observing row 2,501 is the same 413 with
`manifestFileCount: 2501` (a lower bound), `limit: 2500`, `countIsLowerBound: true`.
A completed smaller read disagreeing with stored count -> 503
`folder_zip_unavailable`, no counts or retry-in-place; do not silently repair it.
A metadata-only cap refusal reports the stored count and `countIsLowerBound:false`.
The cost model includes that version-metadata lookup, up to2,501 returned rows,
and constant gate/counter queries; actual D1 *scanned* rows must also be measured,
not assumed equal to returned rows. No unbounded raised-admin manifest or
constant-work claim for a tiny subtree inside an arbitrarily large version.

### 4.2 Names and collisions

Keep well-formed Unicode exactly as published: NFC and NFD remain distinct;
no case folding, transliteration, URL decoding of entry names, or automatic
renaming. Literal percent sequences remain literal. ZIP's UTF-8 bit is set.
For example `data/資料.txt` becomes `資料.txt`, and `data/café.txt` keeps its
combining mark. Exact duplicate names are impossible for a valid normalized
manifest because `validateManifest` rejects them, and stripping a fixed prefix
is injective. Still reject corrupt duplicate rows rather than overwrite them.

Publishing permits names an extractor may mishandle. Refuse the entire archive
with 422 `folder_zip_unsupported_path` for a lone surrogate; name above the
UTF-8 byte cap; absolute/drive/UNC or traversal syntax; backslash; control or
bidi-control code points U+202A-202E/U+2066-2069; colon/Windows device basenames
(CON, PRN, AUX, NUL, COM1-9, LPT1-9, case-insensitive, including extensions);
segments ending in dot/space; or a file/directory prefix conflict (`a` and
`a/b`). Device/path rules apply to every segment. Do not mutate names to make
unsafe archives extractable. Ordinary per-file links remain the fallback.
Case-equivalent or NFC-equivalent distinct names are preserved, not claimed
portable to every filesystem; clients must extract to a fresh directory and
never overwrite existing files without checking. Security disposition must
explicitly accept this residual portability risk or require a revised refusal
contract. No server-side extraction occurs.

### 4.3 Refusal envelope

For archive machine requests, JSON is always UTF-8 and `private, no-store`:

```json
{
  "error": {
    "code": "folder_zip_too_many_files",
    "message": "This folder exceeds the ZIP file limit.",
    "hint": "Open a smaller subfolder or download the files individually.",
    "details": { "fileCount": 101, "totalBytes": 1234, "limit": 100 },
    "next": { "action": "download_files_individually" }
  },
  "requestId": "<request-id>"
}
```

These are proposed codes to register later, not catalog changes in this PR.
413 `folder_zip_too_many_files` and `folder_zip_too_large` share the exact
hint/next action above. `folder_zip_manifest_too_large` instead has message
“This published version exceeds the folder ZIP manifest limit.” and hint
“Download files individually or ask the publisher for a smaller published version.”
with the same `next.action`; narrowing the folder alone cannot fix that refusal.
Details carry `fileCount,totalBytes,limit` for eligible-folder caps; manifest
refusal carries `manifestFileCount,limit,countIsLowerBound` as defined above
and reveals no excluded names. A
per-file refusal adds `limitKind: "file_bytes"`; aggregate byte refusal adds
`limitKind: "total_bytes"`. Only authorized callers past the password gate see
counts. No partial archive, pagination cursor, cap-raising link or retry loop.
An HTML refusal for navigation displays the same code, message and hint with a
plain recovery link (no reflected HTML): cap/name/Range errors return to the
requested canonical folder with its query removed; missing/reserved-only folders
return to the known site's root with no selector; missing sites link to the
instance landing page. Never link a 404 back to the same missing/reserved path.
HEAD never has a body. All non-200/304 results omit attachment, ETag and archive length.

Other stable proposed codes: 400 `folder_zip_invalid_request`; 404
`site_not_found`/`folder_not_found`; 401 `site_password_required`; 403
`site_request_forbidden`; 410 `site_gone`; 451 `site_unavailable`; 422
`folder_zip_unsupported_path`; 429 `folder_zip_rate_limited`; 503
`folder_zip_unavailable`; 409 `folder_zip_changed`; 416
`folder_zip_range_unsupported`. Each error has a fixed safe hint: unlock this
site (401), open its normal page (400/403/404/416/422), ask the publisher for a
current link (409/410/451), retry after the supplied delay (429/503). Do not
reflect a takedown ground or unsupported raw path in errors.

## 5. Success HTTP contract and freshness

- GET 200: `Content-Type: application/zip`, `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`,
  `Accept-Ranges: none`, exact `Content-Length` from section 4. No negotiated
  Content-Encoding. Security/referrer headers are at least as restrictive as
  ordinary serving. No user content is rendered on the app origin.
- Filename is `<slug>-<folder-basename>-v<N>.zip`; root uses
  `<slug>-v<N>.zip`. `N` comes from the same pinned ready version, never from a
  separately cached “live” name. Encode the Unicode basename with the merged
  RFC 5987 helper's ASCII fallback plus `filename*` contract. First truncate the
  displayed basename to 80 Unicode scalar values (not grapheme clusters), append
  the suffix, then invoke the helper once. Same displayed names across distinct
  folders are allowed; identity is the full URL/ETag, not a download-manager name.
  Do not change ZIP entry names. Always prevent CR/LF, quote/backslash injection
  and double encoding; ASCII fallback is not the authoritative Unicode name.
- HEAD executes the same gates, bounds and cheap admission but reads **zero
  blobs**, creates no ZIP generator, and has GET's manifest-derived metadata
  with no body. Its length is predicted from the immutable manifest, not verified
  against storage. GET must fail on a storage-length mismatch; HEAD cannot detect
  that fault and is not a storage-health proof. Do not add Range support or claim
  resumability. A failed midstream download must restart.
- Define the strong ETag as `"folder-zip-v1-<sha256hex>"` of UTF-8 JSON of
  `["folder-zip-v1",siteId,canonicalSlug,versionId,manifestHash,prefix]`, in that
  order, no whitespace. All values come from authoritative D1 for this admitted
  version, including manifest hash/number. ZIP algorithm/timestamp/name-policy
  changes bump the format token. Prefix is canonical, slash-terminated or `""`.
- Never cache archive responses in KV, R2, Cache API, isolate memory or CDN; no
  persisted archive objects or refresh jobs. Content-addressed **blob** caching
  may remain only if bounded/cancellation measurements include its tee/fills;
  otherwise the future service must use a direct bounded reader, not silently
  retain the owner's cache behavior.
- No-store intentionally prevents normal browser/shared archive caching. ETag
  supports **explicit** client validation, not permission to retain protected
  bytes. Compare `If-None-Match` only after all gates and the final D1 fence.
  A 304 carries the current `ETag`, `Cache-Control: private, no-store`, the exact
  same `Content-Disposition` value as 200, `Accept-Ranges: none`,
  `X-Content-Type-Options: nosniff`, and the same security/referrer headers. It
  omits Content-Type, Content-Length and Content-Encoding, and has no body.
  Never answer304 from slug/path alone, old KV or a blob hash.
- Republish/restore/rename from A to B: a request carrying A's tag must get B's
  200 (or the current refusal), never A's 304 paired with B's filename. The tag
  includes the name as well as manifest/version identity, even for equal bytes.
  D1 read sessions/primary consistency must not use an old read replica session
  or an old bookmark to resolve live; record that mode in future evidence.
- A blob read failure before headers can return 502
  `folder_zip_storage_unavailable`, hint “Retry shortly.” After headers, cancel
  and error the stream, do not append a JSON/HTML error into ZIP bytes or emit a
  valid central directory for incomplete content. Compare actual body length to
  manifest length before its local header; bound reading to expected size +1
  so corrupt storage cannot violate memory/byte caps. No automatic retry.

Rejected: slug-only caching (fresh name/stale archive), pinned immutable public
archive URLs (new retained unauthenticated surface), ETag from bytes alone
(doesn't bind the live selection/name), and prebuilding/persisting ZIPs (storage,
cleanup, takedown and cache invalidation expansion).

## 6. Measurement protocol, not results

**No CPU, memory or edge capacity number is claimed.** Existing functional
streaming coverage uses 6 x 128 KiB (`test/version-zip-export.acceptance.test.ts:669-755`)
and does not justify the public envelope. Stored CRC and full-file buffering are
the baseline to measure, not “CPU-free”. Deflate adds work and cannot be justified
by smaller text examples alone. V1 selects **stored**; a deflate comparison can
reject it only through a separately revised, security/product-aligned spec.

A separately authorized disposable measurement must provide the following
harness; it does **not** exist on the cited main and is not created here:
`test/public-folder-zip.measurement.test.ts`. The future Test Author owns it.
It seeds synthetic bytes directly into emulated D1/R2/KV, calls existing
`exportVersionZip` as the baseline, and a non-routed candidate service only in
the measurement harness. No public endpoint or deployment is needed for local
measurements. It also benchmarks the same fixture through an isolated deflate
experiment using the already-declared `fflate`, level 6, outside the product.
Freeze fixture seed `0x5eed1234`, unsigned xorshift32 bytes, and record each
payload's SHA-256 so clean reruns cannot substitute easier content.

| Fixture | Exact shape and purpose |
|---|---|
| F1 | 10 files x 1,024 B ASCII text; simple recipient happy path |
| F2 | 100 files totaling 16,777,216 B: 99 x 167,772 B plus 167,788 B; xorshift bytes, distinct contents; count+byte cap and worst cold read fan-out |
| F3 | 1 file x 16,777,216 B; xorshift bytes; worst first-file buffering/CRC |
| F4 | Same sizes as F2, repeated ASCII `synthetic folder report\n` truncated to size; compression-friendly comparator |
| F5 | 2,500 manifest rows; 100 eligible paths distributed 10 subfolders x10 with F2 sizes; 2,400 out-of-prefix zero-byte rows; metadata scan overhead |
| F6 | 100 zero-byte files, names 1,024 UTF-8 bytes and mixed valid Unicode, plus nested path variants; maximum metadata and deterministic ZIP overhead |
| Refusals | 101 eligible zero-byte files; 16 MiB+1; 2,501 manifest rows; effective administrative limits lower by one; hostile/colliding names; assert zero blob reads |

For every accepted fixture: method store baseline/candidate and deflate
comparator; cold cache disabled vs warm content-addressed blobs; 1 warmup then
**30 full-drain repeats**, followed by a clean-persistence rerun. Keep every
sample, p50/p95/max, exact runtime/tool versions, commit/config/CPU limit, serving
mode and SHA-256s. Count D1 rows/queries, R2 GETs, Cache API operations, bytes read,
wire length, first byte, full drain, failures and cancellation residual work.
Run sequential requests and **two** concurrent requests; no public load tests.
Throttle one local consumer to 64 KiB/s, cancel after its first ZIP chunk, and
prove no later file is opened (at most the active file has been read).

### Exact rerun contract

The following commands are **planned**, not executed verification, and the named
future test is deliberately absent today. Once its separately approved test
harness is committed, rerun from that commit using an externally provisioned
node_modules tree; do not install dependencies in a synced worktree:

```sh
# Existing functional baseline (available now; not a resource measurement).
npx --no-install vitest run test/version-zip-export.acceptance.test.ts \
  test/version-zip-export-pending.acceptance.test.ts

# Future harness: environment contract and fixture/repeat names are normative.
FOLDER_ZIP_SEED=0x5eed1234 FOLDER_ZIP_REPEATS=30 FOLDER_ZIP_CONCURRENCY=1 \
  FOLDER_ZIP_METHODS=store,deflate FOLDER_ZIP_CACHE=cold,warm \
  npx --no-install vitest run test/public-folder-zip.measurement.test.ts \
  --reporter=json --outputFile=/tmp/folder-zip-run1.json
FOLDER_ZIP_SEED=0x5eed1234 FOLDER_ZIP_REPEATS=30 FOLDER_ZIP_CONCURRENCY=2 \
  FOLDER_ZIP_METHODS=store,deflate FOLDER_ZIP_CACHE=cold,warm \
  npx --no-install vitest run test/public-folder-zip.measurement.test.ts \
  --reporter=json --outputFile=/tmp/folder-zip-run2.json
```

Each invocation must get fresh emulated persistence. The harness emits a
structured `folderZipMeasurements` record per sample, not merely Vitest pass
counts. Local client `performance.now()`/curl timings are **wall time only**.
Obtain workerd isolate CPU profiles (excluding idle/network wait) and memory
profiles for comparative diagnosis; never label Node driver CPU as Worker CPU.

Deployment admission additionally needs actual per-invocation Worker **CPU time**
on an already-authorized, isolated disposable environment at the same head and
existing account limits. Use its existing invocation telemetry, with a full-drain
single-request driver and one request at a time; capture CPU/wall fields and
correlating request IDs. Cloudflare documents these in invocation logs and
Tail/Logpush [timing telemetry](https://developers.cloudflare.com/changelog/2025-04-09-workers-timing/).
No new Tail Worker, Logpush job, binding, spend, root-template deployment, or
production/staging deployment is authorized by **this** design card. The future
measurement owner must secure a permitted environment first. If actual CPU or
peak memory evidence is unavailable, the gate is **unverified**, not passed.
The exact provider telemetry export command is environment-dependent and must be
recorded by that measurement owner; there is no invented working command here.

### Pre-stated thresholds

All apply to F1-F6, especially F2/F3/F5/F6; a single favorable median is insufficient:

1. Actual Worker CPU p95 <= **min(100 ms, 0.8 x the existing per-request CPU
   limit)**, no sample exceeds that existing limit, zero CPU/memory/runtime errors.
   Workers Free's documented 10 ms ceiling therefore gives an **8 ms** p95 gate;
   do not silently upgrade an account to pass. Local profiles are diagnostic only.
2. Peak isolate memory <= **64 MiB** for sequential and two-concurrent cases,
   including blob tees/copies and the runtime. No later blob opened after cancel.
3. Comparative local full-drain p95 <= **5 seconds**, first-byte p95 <= **1 second**
   unthrottled, and neither more than **25% slower than stored owner baseline**
   on the same fixture/runtime. Slow-consumer wall time is excluded from these
   latency thresholds, not from memory/cancellation checks. Edge wall times are
   recorded separately, not asserted equivalent to local times.
4. <=100 cold R2 body GETs, <=2,501 scanned manifest rows plus constant gate/counter
   work, and measured **total subrequests <=80% of the existing environment's
   limit**. Count Cache API and custom-hook work too. No new limit/binding request.
5. Expected stored length and SHA/CRC entries match every manifest; repeats are
   byte-identical. Refusals/HEAD/304/416 never read blobs. Peak cost in section 7
   remains within its ceiling under cold, cancelled and concurrent workloads.
6. Deflate comparator reports CPU and savings for random **and** text fixtures.
   Even >=25% wire reduction is not permission to switch: if its CPU exceeds
   stored by >20% or any gate fails, reject deflate. Stored remains the v1 choice.

These are proposed product/resource budgets derived before measuring. Passing
would validate this exact envelope/environment, not general Cloudflare capacity.

## 7. Anonymous amplification, admission and operating cost

One tiny URL can trigger up to 100 object reads and nearly 16.21 MiB of output;
compression is not a protection. Repeated requests, distributed IPs, early
cancellation, HEAD/conditional spam and slow consumers all matter. CORS is not
a server-to-server abuse barrier. The cap alone limits per-request work, not
aggregate expense. Do not place cached archives in front of access/rate checks.

**Prerequisite: R-36 integration** with atomic existing-D1 hourly budgets, not a
new ad-hoc limiter or a per-isolate Map. A location-local burst binding alone
cannot enforce the instance aggregate. Proposed initial administrative budgets:

- Full GET attempts: **1/minute and 6/hour per trusted client**, **30/hour per
  site**, **60/hour per instance**, across all folders/serving modes. Debit the
  whole request at admission, even if cancelled; never refund or split by Range.
- Every candidate reaching gate 5 first debits the cheap metadata budgets:
  **60/minute per client, 600/minute per instance**. Unconditional GETs and
  conditional misses additionally debit all full-GET budgets atomically before
  their 200. HEAD, conditional matches and Range/precondition refusals use only
  cheap admission. Earlier gate refusals never change to429 merely because a
  later budget is exhausted; provider request protection still bounds ingress.
  The cheap and body phases are separate reservations, each all-or-nothing
  across its own buckets, never a refund of already-spent cheap admission.
- Fixed UTC buckets; client from trusted `CF-Connecting-IP` only, IPv6 /64,
  mapped IPv4 unified. Refuse missing identity/counter failure closed with 503
  `folder_zip_unavailable`, `Retry-After: 60`. No forged forwarding fallback.
  Exceedance -> 429 `folder_zip_rate_limited` with `RateLimit-Policy`, `RateLimit`
  and `Retry-After` until the binding bucket resets. No self-retry.
- Only constant-sized address/mode/takedown/expiry/password checks precede cheap
  admission; no manifest enumeration may occur there. These pre-admission gates
  still cost requests and constant D1 reads, so deployment must retain existing
  provider request protection. The per-admitted-attempt cost ceiling includes
  both cheap and body phases; pre-admission refusals must be separately counted
  in measurement/account totals and are not described as free. These rates are a small initial
  envelope, not resistance to arbitrary DDoS. Concurrent/slow requests must
  prove section 6 memory/cancel gates; if global concurrency cannot stay bounded
  within existing infrastructure, **do not activate** rather than add queues.

At the maximum 60 complete cap requests/hour, output is <=1,019,378,280 B/hour
(about 972.15 MiB), with <=6,000 R2 GETs/hour, before unrelated product traffic.
A cancellation is costed as a full attempt. Fixed-bucket boundaries can allow
up to twice an hourly budget across an adjacent boundary; record that burst
and test it, not a claim of a sliding-window global ceiling. Distributed IPs
do not evade the instance/site budgets. Rate counters must have bounded retention
through the native limiter's cleanup, not host cron automation.

### Cost model (estimate, not a bill or product commercial feature)

Provider documentation read 2026-10-26: [Workers resource rates](https://developers.cloudflare.com/workers/platform/pricing/),
[R2 operation/egress rates](https://developers.cloudflare.com/r2/pricing/),
[Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
Standard R2 GETs are $0.36/million and Internet egress is $0; this does **not**
make CPU, read operations, D1 or abuse free. No account change is proposed.
Using marginal Workers request $0.30/million and CPU $0.02/million CPU-ms,
ignoring included allocations and monthly rounding:

```text
request + R2 + CPU at cap
= 0.30/1e6 + 100*0.36/1e6 + C_ms*0.02/1e6
= $0.00003830 when C_ms = 100
```

Add `rows_read * current_D1_read_rate + rows_written * current_D1_write_rate`
plus any existing observability/KV/cache-operation charges. R2 is assumed Standard,
not Infrequent Access retrieval. Each rerun must record actual read/write rows
and current provider units, including limiter contention; do not omit D1 just
because it falls under an allocation. No archive storage writes are allowed.

Pre-stated all-in marginal ceiling **$0.00005 per admitted cap attempt** (50
microdollars), excluding preexisting fixed account fees but including D1 and
observability. The 100-object budget spends 36 microdollars of that envelope;
100 ms CPU plus request leaves 11.7 microdollars for metadata/counters/telemetry.
If measured D1/telemetry or storage class makes that impossible, kill this
candidate, not the guard. A million anonymous cap requests would be about
**$38.30 plus D1/telemetry** and ~15.45 TiB output; aggregate admission is essential.
This arithmetic is not an authorization to generate that traffic or spend.

## 8. Routed decisions and recommendation

**Recommendation: NO BUILD now.** Retain this design as a bounded candidate.
Do not open a build until the exact saved spec revision has (1) security
admit/condition/reject disposition, (2) product/CEO alignment confirmation, (3)
passing measurement evidence, and (4) shipped ordinary takedown/reserved-path
and R-36 integration plus merged RFC 5987 dependency. Merging this docs-only
spec satisfies none of those runtime/activation gates.

Route a bounded security disposition covering the new anonymous surface,
ordinary-vs-transfer gate order, live freshness fence, reserved namespaces,
portable-name residual risk, cancellation and the quantitative abuse/cost budget.
Route a separate product alignment confirmation covering live-only recursive
selection, indexed-folder addressability, 100/16 MiB refusals and no resumability.
Both requests must name this document's immutable saved revision and content
SHA-256; their records live outside this public document. If it changes, reroute
against the new revision, never imply old answers cover a revised contract.

Explicit open questions and owners (they do **not** authorize implementation):

1. **Security disposition:** accept case/NFC-distinct extraction collisions and
   post-header revocation limits, or require a revised refusal policy? Until a
   disposition is recorded the answer is no activation, not implied consent.
2. **Product alignment:** is this deliberately small convenience envelope useful
   enough despite large-folder refusals and no Range/resume? A rejection means
   no implementation child; do not replace it with infrastructure expansion.
3. **Future measurement owner:** can an already-permitted environment provide CPU,
   memory and subrequest evidence under its existing limits with no new spend?
   Missing evidence leaves NO BUILD; local wall time cannot answer this question.
4. **Native limiter/takedown maintainers:** supply exact shipped interfaces and
   tests before implementation planning. No folder service invents or bypasses
   their unavailable gates. Baseline reserved-path enforcement gaps are included
   in the security routing; this document does not patch them or certify them.

**Written kill rule:** if stored at the stated envelope fails *any* CPU, memory,
first-byte/full-drain, subrequest, cancellation, determinism or all-in cost gate,
or requires new spend/infrastructure, **do not build this v1 candidate**. Likewise
no build if atomic instance admission, fresh authorization/takedown checks or
safe reserved-path exclusion cannot be guaranteed. No raising limits, partial
archives, deflate substitution, relaxed security, or silent smaller cap to turn
a failure green. A changed envelope needs a revised spec and fresh dispositions.
Security rejection/product misalignment kills this candidate; it does not cancel
Kofra or unrelated work. Design completion requires the saved spec, merged docs
PR and both routings recorded, **not answers to them**. No deployment is in scope.

## 9. Future numbered acceptance matrix

For a later independent Test Author to pin unchanged after the gates admit work.
Each row uses disposable synthetic D1/R2/KV, no production or private fixtures.
Every refusal asserts no archive/blob reads and no attachment/ETag leakage unless
the row explicitly covers a post-header fault. Measurements are section 6, not
passing-test counts. No test files are added or edited by this design PR.

| # | Case | Required result |
|---|---|---|
| 1 | Script-disabled listing, keyboard and accessible name | One plain Download folder link to current prefix, adjacent cap/subfolder text, no script or forced new tab |
| 2 | Nested root/subfolder with sibling `database/` | Recursive exact prefix, no wrapper/directories, no sibling bytes; original bytes, size/CRC correct |
| 3 | Indexed folder, sole-file root, SPA nonexistent directory | Explicit indexed/root ZIP works; normal pages unchanged; virtual/custom-404 directory refuses 404 |
| 4 | Path/shared-origin, dedicated-origin and subdomain bases | Equivalent selection and gates, correctly encoded links, no app-origin content rendering |
| 5 | Missing/deleted site and retained ordinary rename | 404; authoritative no-store rename redirect preserves selector and reruns gates, never cached ZIP |
| 6 | Transfer site and transfer tombstone combined with expired/password/takedown | Unsupported ZIP is generic 404, zero transfer accounting/grants; ordinary transfer file order remains unchanged |
| 7 | Ordinary takedown plus expiry | 451 without grounds, no counts, never 410; hold alone does not deny |
| 8 | Expired plus locked; deadline equality and +1 ms | 410 before password; equality passes expiry, +1 ms refuses; cleanup's missing address is 404 |
| 9 | Locked plus missing folder / too many files | Ordinary 401 gate wins, no existence/count disclosure; cross-site non-navigation restriction stays 403 |
| 10 | Successful unlock and password changed before header fence | Same-site constrained continuation retains selector; changed digest refuses, no stale unlock or secret URL |
| 11 | No ready live version / absent folder / only excluded files | 404 folder_not_found, never empty or SPA ZIP |
| 12 | Exact file vs same-named subtree and nonslash folder | Exact file refuses 404; real nonslash folder redirects308 after gate; destination has same selection |
| 13 | Malformed percent/traversal, repeated selector, raw/view/embed/preview mixture | 400 after site/password gates; no alternate bypass; unsupported methods405 and Allow header; HEAD body empty |
| 14 | Reserved root `.dropway`, `__dropway`, their descendants and direct requested prefixes | Never included; reserved folder address404; counts exclude them regardless of publish path; nested ordinary namespace rule pinned |
| 15 | Eligible count99/100/101, each within bytes; identical hashes on distinct paths | Inclusive100;101 -> 413 count code, logical entries not deduplicated; exact envelope/hint/next; zero blob reads |
| 16 | Bytes16MiB-1/exact/+1 and lower administrative count/site/file limits | Inclusive exact; over -> 413 byte code; both caps exceeded ->count first; no partial ZIP |
| 17 | Version manifest2500/2501, small selected subtree | Bounded scan;2501 -> 413 manifest code before sort/ZIP reads; no unbounded raised admin input |
| 18 | Non-ASCII, astral, NFC/NFD, quote/semicolon/percent names | Exact UTF-8 entries, fixed code-unit order; ASCII-safe attachment + correct filename*, no header injection/double decoding; filename truncation preserves scalar boundary |
| 19 | Exact normalized duplicates/corrupt duplicate rows; case/NFC-distinct files | Valid publish cannot have exact duplicates; corrupt duplicates refuse422; distinct legal names preserved under the explicitly accepted residual policy |
| 20 | Surrogates, bidi controls, Windows devices/drive/UNC/colon, traversal, trailing dot/space, `a` + `a/b` | Entire archive422 unsupported path, no renaming or partial archive; safe fallback hint; no raw hostile name echoed |
| 21 | UTF-8 entry-name1023/1024/1025 bytes; publisher1024 code-unit Unicode name | Byte-bound inclusive1024;1025 -> 422 even if publish allowed it; zero blob reads |
| 22 | Two GETs same pinned manifest, cache cold/warm, random and text | Byte-identical stored ZIP,2020 timestamp,no descriptors; length exact, no Content-Encoding/viewer transformations |
| 23 | HEAD happy path and each refusal | Same status/gates/GET metadata, no body/generator/blob reads; no false archive headers on errors |
| 24 | Range valid/invalid/multipart plus matching If-None-Match |416 before 304,no Content-Range or archive attachment on refusal,Accept-Ranges:none on success;no resume |
| 25 | Explicit current ETag, list/weak/`*`; unsupported conditionals |304 only after all gates;zero blobs;current metadata/no length; unsupported date/write preconditions400 |
| 26 | Republish A->B with stale KV/memory and A ETag | Fresh D1 B200/new filename/tag (or refusal), never A 304 under B name; restore and equal-byte rename variants included |
| 27 | Pointer/name change just before header fence |409 no retry/no blob reads; after headers pinned admitted version only, no mixed entries or new-version name |
| 28 | Takedown/expiry/password change vs matching ETag | Current denial before 304 or HEAD200; selected blocked hash451 never partially omitted |
| 29 | Client/hour/site/instance exhaustion and adjacent fixed-bucket boundaries |429 exact rate/reset headers;distributed clients cannot bypass global/site;no partial multi-bucket debit;documented boundary burst only |
| 30 | HEAD/conditional/Range cheap budget; conditional miss full budget |All cheap paths bounded;miss also atomically reserves body before 200;HEAD/304/416 no R2;missing trustedIP/counter failure503 |
| 31 | Storage missing/short/oversized, cancellation and slow consumer |Preheader502 or errored postheader stream,no valid partial ZIP/JSON trailer;actual length bounded;no later reads after cancel;memory within gate |
| 32 | Unauthorized, refused, failed and cancelled responses |No cached archive objects/capabilities/no secret log or takedown ground;no owner privilege synthesis;abort not refunded |
| 33 | F1-F6 cold/warm, clean rerun, sequential/two-concurrent CPU/memory/subrequests/cost |All pre-stated section6/7 thresholds with raw evidence,otherwise written NO BUILD;local wall times never presented as edge CPU |

**Design-only verification:** source inspection and dependency-status checks above;
`npm run guard` is the required local docs check. Typecheck/tests, benchmarks and
deployments are not claimed for this document; CI must still pass the full
required checks and exact-head independent review before squash auto-merge.
