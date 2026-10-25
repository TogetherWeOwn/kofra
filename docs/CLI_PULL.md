# `kofra pull`: version-pinned site recovery (spec)

Status: proposed, design only. There is no implementation behind this
document, and it grants no authority to build one: downloading untrusted
paths to disk is a new extraction boundary, so implementation needs a
security review of section 7 first. Roadmap item R-10 lists `pull` among
the CLI management commands; this document defines the v1 contract.

## 1. What it does

`kofra pull` copies one published site version from an instance to a new,
empty local directory: disaster recovery, migration, and "what is actually
live" inspection. It is the inverse of `kofra publish` for bytes only: it
never touches the instance (no uploads, no version creation, no settings).

```
kofra pull <site> <destination> [--version <ref>] [--dry-run] [--json]
         [--concurrency <n>] [--max-files <n>] [--max-bytes <n>]
```

| Argument / flag | Meaning |
|---|---|
| `<site>` | Site slug, site id, or site URL, exactly as `publish --site` accepts |
| `<destination>` | New empty directory to write into (created if missing; see section 5) |
| `--version <ref>` | `live` (default), `v3`, `3`, or a version id, resolved once server-side (section 2) |
| `--dry-run` | Print the plan; write nothing to disk (section 4) |
| `--json` | Print exactly one JSON object on stdout (section 6) |
| `--concurrency <n>` | Parallel downloads, default 6, range 1-32 (as `publish`) |
| `--max-files <n>` | Refuse manifests above this file count, default 20000, range 1-100000 |
| `--max-bytes <n>` | Refuse manifests above this total size, default 1073741824 (1 GiB), minimum 1 |

Authentication, `--api`/`--key` resolution, and the moved-instance note
follow the existing commands (`resolveInstance`/`makeClient` in
`packages/cli/src/main.ts`). Pull needs a key with the `sites:read` scope.

## 2. Source APIs (all existing, all authenticated reads)

The implementation uses exactly three existing endpoints, never rendered
viewer HTML and never any mutation:

1. `GET /api/v1/sites/{slug}/versions/{id}` (`get_version`,
   `packages/server/src/operations/versions.ts`): resolve the `--version`
   ref **once** to a stable version id, number, and manifest hash.
   Resolution is server-side because `resolveVersionRef`
   (`packages/core/src/services/site-ops.ts`) accepts all four ref forms,
   while the CLI's `resolveVersion` helper (`packages/cli/src/main.ts`)
   has no `live` form (it defaults to the previous version for rollback).
2. `GET /api/v1/sites/{slug}/files?version=<id>` (`list_files`,
   `packages/server/src/operations/core-api.ts`, `listFiles` in
   `packages/core/src/services/deploys.ts`): the pinned manifest, ordered
   by path, with per-file `size` and `sha256`. Over REST this returns the
   whole manifest in one response (the REST handler ignores paging;
   cursors are MCP-only), so no pagination loop is needed.
3. `GET /api/v1/sites/{slug}/files/{path}?version=<id>` (`get_file_bytes`,
   `packages/server/src/operations/http.ts`): raw stored bytes per file.
   Response carries `ETag: "<sha256>"`, `Content-Length`, and
   `X-Kofra-Version: <id>`.

The paged JSON `read_file` operation (`GET /api/v1/read-file`) is for
agents inspecting snippets, not for recovery: it may transcode text and
pages at 1 MB, so it cannot guarantee byte preservation.

No new server API is proposed. If a future server change renames or
reshapes these endpoints, this spec is updated first.

## 3. Version pinning

The live pointer can move at any time (another publish, a restore). Every
pull pins the version before downloading anything:

1. Resolve `--version` (default `live`) to a version id via `get_version`.
   Require `version.status === "ready"` and that `missing` is an empty array
   before reading the manifest or any bytes. Otherwise stop with
   `version_not_ready` (exit 6), download nothing, and leave the destination
   untouched. A pending version is refused even if all its blobs are uploaded.
2. Pass that id as `?version=<id>` on the manifest read and on every byte
   read. Never re-resolve `live` mid-run.
3. Check every byte response's `X-Kofra-Version` against the pinned id. On
   any mismatch: stop, keep what is verified so far, exit non-zero with
   `version_mismatch` (section 6). Never mix files from two versions.
4. Report the pinned id, number, and manifest hash in human and JSON
   output so a later run can re-pull the identical bytes.

## 4. Plan and `--dry-run`

`--dry-run` prints what a real run would do and writes nothing: no files,
no directories, no network writes, and never a mutation. Unlike `publish
--dry-run`, which contacts nothing because its inputs are local, pull's
inputs are remote, so `--dry-run` **does** perform read-only discovery:
one `get_version` call plus, only when the readiness check in section 3
passes, one manifest read. It must not download any file bytes. The plan
lists, in manifest order: pinned version (id,
number, manifest hash), file count, total bytes, bounds checks, and every
file path with size and sha256. With `--json`, `--dry-run` prints the
same receipt schema as a real run (section 6) with `dryRun: true` and no
`downloadedAt`.

A real run prints the same plan header first (to stderr in human mode),
then downloads.

## 5. Destination and bounds (v1 limits)

- The destination must be new and empty: the command creates it (including
  parents) when missing, and refuses with `destination_not_empty` when it
  exists and contains any entry other than `.`/`..`. There is no
  overwrite, merge, prune, or delete in v1: no `--force`, no `--update`,
  no syncing into an existing tree.
- Refuse before downloading anything when the manifest exceeds
  `--max-files` (`too_many_files`) or `--max-bytes` (`pull_too_large`).
  The error states the observed count/bytes and the flag that gates it.
- At most `--concurrency` downloads in flight. Output order is
  deterministic regardless of completion order: receipts follow manifest
  (path) order, and the summary is printed once at the end.
- Every file is hash-verified before it counts (section 8). A summary
  reports files ok / failed / skipped-bytes (always zero in v1: every
  manifest file is downloaded or the run fails).

## 6. Output, receipts, exit codes, errors

Human mode prints one line per file (`<path>  <bytes>  ok`) to stderr as
files verify, then a summary line to stdout. `--json` prints exactly one
object on stdout, with a schema version so scripts can branch on it:

```json
{
  "ok": true,
  "pullSchema": 1,
  "site": "team-report",
  "destination": "./team-report-v3",
  "version": { "id": "ver_abc", "number": 3, "manifestHash": "…" },
  "dryRun": false,
  "files": [{ "path": "index.html", "size": 5, "sha256": "…", "status": "ok" }],
  "summary": { "files": 12, "bytes": 40960, "verified": 12, "failed": 0 },
  "downloadedAt": "2026-10-24T16:00:00.000Z"
}
```

`status` per file is `ok` in a successful run. Failed runs (`ok: false`)
use the CLI's standard error envelope (`{ ok: false, exitCode, error:
{code, message, hint, …} }`) and include every verified receipt plus the
failing file's receipt with `status` explaining the failure. Exit codes
reuse the stable `EXIT` map in `packages/cli/src/client.ts`; new
pull-specific codes:

| Code | Exit | Meaning |
|---|---|---|
| `destination_not_empty` | 2 (usage) | Destination exists and is not empty |
| `path_unsafe` | 2 (usage) | A manifest path fails containment (section 7); nothing is downloaded |
| `path_collision` | 2 (usage) | Two manifest paths collide after case folding; nothing is downloaded |
| `too_many_files` / `pull_too_large` | 6 (invalid) | Manifest exceeds `--max-files` / `--max-bytes` |
| `version_not_ready` | 6 (invalid) | Resolved version is not ready or reports missing blobs; no manifest/byte reads or disk writes; hint: retry `kofra pull <site> <new-destination> --version <id>` after that version is finalized, or select a ready version |
| `version_mismatch` | 1 (error) | A byte response named another version; stopped, partial tree kept |
| `hash_mismatch` / `size_mismatch` | 1 (error) | Verified bytes disagree after retries; the file is removed, run stops |
| `pull_cancelled` | 1 (error) | SIGINT/SIGTERM: in-flight file discarded, verified files kept |
| `download_failed` | 7 (unavailable) | Retryable network/server failure exhausted `DropwayClient` retries |

Every error carries a next-action hint naming the exact command or flag
that unblocks the user, following existing CLI conventions.

## 7. Fail-closed path containment

Manifest paths are untrusted input for disk writes, even though the
server's `normaliseFilePath` (`packages/core/src/lib/paths.ts`) already
rejects `..`, control characters, and over-long paths at publish time
(and folds backslashes to `/`).
Defense in depth: the client validates every path before creating
anything, and aborts the whole run on the first failure, leaving the
destination empty (or absent, if it created it).

Reject a path when, after decoding percent-escapes repeatedly to a
fixpoint, any of these hold:

- empty, absolute (`/x`), or containing a `..` or empty segment;
- a Windows drive (`C:`, `C:/`, `C:\`), a UNC prefix (`\\`, `//server`),
  a backslash anywhere, or ASCII/Unicode NUL;
- an ASCII or Unicode separator smuggled in an escape (`%2f`, `%5c`,
  double-encoded variants) or a lookalike (U+2215, U+FF3C, full-width
  solidus): decode-then-validate catches these because validation runs on
  the fully decoded form;
- a reserved Windows name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`,
  `LPT1`-`LPT9`, any case, with or without extension) or a segment ending
  in a space or dot;
- longer than 1024 characters (the server limit), so client and server
  agree on what a path is.

Collision handling: after containment, fold every path with Unicode
case folding and reject the manifest when two paths fold equal
(`path_collision`), on every platform, not only case-insensitive ones.
Deterministic behavior beats platform-dependent behavior for recovery.

Symlink handling: never create a symlink; never write through one. Before
writing each file, `lstat` every ancestor from the destination down and
refuse when any is a symlink or anything other than a directory. Open
output files with `O_EXCL` (fail when present) and `O_NOFOLLOW`. Write to
a temporary sibling (`<name>.kofra-part-<n>`), `fsync`, verify size and
sha256, then rename over nothing (the target cannot exist: the
destination started empty and collisions were rejected up front).

The client never deletes pre-existing user data: on any abort it removes
only `.kofra-part-*` files it created. There is no code path that deletes
anything else on disk.

## 8. Races, interruption, and verification

- TOCTOU limits: ancestor `lstat` checks and the final rename are not
  atomic against a hostile local actor swapping directories mid-run.
  Node offers no portable `openat2`-style API, so v1 documents the limit
  instead of claiming to close it: run pull on a trusted local disk, not
  on a shared or network mount, and treat a pull running alongside
  untrusted local writers as unsupported. The rename-over-nothing and
  post-write `realpath`-inside-destination check shrink the window to a
  single rename.
- Interrupted writes: a crash or signal leaves at most one unverified
  `.kofra-part-*` file per in-flight download; verified files are never
  rewritten or truncated. There is no resume in v1: re-run into a new
  empty directory.
- Cancellation: on SIGINT/SIGTERM, stop starting new downloads, discard
  in-flight temp files, print receipts for verified files, exit
  `pull_cancelled`.
- Hash/size mismatch: each file's bytes are hashed (SHA-256) as they
  arrive and compared with the manifest's `size` and `sha256` before the
  rename. Transient corruption is retried through the existing
  `DropwayClient` GET retry policy; a mismatch that survives retries
  removes the temp file and stops the run (`hash_mismatch` /
  `size_mismatch`). A file is never reported `ok` without a matching
  hash.

## 9. Bytes, consistency, compatibility

- Byte preservation: files are written from `get_file_bytes` responses
  verbatim. No transcoding, no newline conversion, no BOM handling, no
  HTML/CSS path-rewrite (that rewrite applies to served site traffic, not
  to API byte reads). Binary round-trips are verified by hash, not by
  eyeballing: the acceptance recipe (section 11) includes binary fixtures.
- Encrypted sites: a site published with `publish --encrypt` pulls as
  stored bytes (the encrypted container), exactly like any other file.
  V1 never decrypts and offers no plaintext export: the key lives only in
  URL fragments the CLI never sees.
- Compatibility: v1 targets the current API only. `pullSchema: 1` in JSON
  output lets future versions add fields without breaking readers; a
  breaking receipt change bumps the number.
- Site kinds: ordinary sites only. A transfer-mode site fails on the
  first byte read with the server's 403 `transfer_download_required`
  (exit 3), surfaced with its hint; v1 adds no transfer download path.

## 10. Non-goals for v1

Decryption or plaintext export of encrypted sites; downloading
transfer-mode sites; archive extraction
(pulled files are never unpacked); new ZIP or bulk-download endpoints;
resume of interrupted runs; accepting storage credentials; overwrite,
merge, prune, delete, or sync of any kind; changing what is live
(`restore` already does that); progress bars beyond the existing
stderr conventions.

## 11. Acceptance recipe (for the future Test Author)

Run on disposable local data only: a local Worker under workerd plus a
stub HTTP server for hostile manifests. No production instance is ever
touched.

1. Publish a fixture site to the local Worker: `index.html`, nested
   `assets/app.js`, a 0-byte file, and a 1 MiB random binary. Record
   `sha256sum` of every source file.
2. `kofra pull <site> ./out --json`: exit 0, `pullSchema: 1`, pinned
   version reported. `sha256sum -c` of `./out` against step 1 passes.
3. `kofra pull <site> ./out2 --dry-run --json`: exit 0, `dryRun: true`,
   identical file list to step 2, and `./out2` is not created.
4. Publish a second version mid-test, then pull with the first version's
   id: the tree matches version one, proving the pin, not the live
   pointer.
5. Pull into a non-empty directory: exit 2, `destination_not_empty`, the
   directory is untouched.
6. Hostile manifests from the stub server (each in a fresh directory):
   rows 1–8 exit 2 with `path_unsafe` or `path_collision`; row 9 exits 6
   with `too_many_files` or `pull_too_large`. Every row downloads nothing
   and leaves the destination empty.
7. Corrupting stub (flips one byte, or lies in `X-Kofra-Version`): the
   run stops with `hash_mismatch` / `size_mismatch` / `version_mismatch`,
   the bad file is absent, verified files keep matching hashes.
8. SIGINT mid-run (large fixture, slow stub): exit 1 `pull_cancelled`,
   no `.kofra-part-*` files remain.
9. `get_version` returns a pending version (both with missing blobs and
   with `missing: []`), or a synthetic ready version with non-empty
   `missing`: normal and dry-run pulls exit 6 `version_not_ready` with
   the remediation hint. Assert that only `get_version` was called, no
   manifest or byte reads occurred, and the destination was untouched.

Hostile fixture matrix (synthetic; these names cannot be produced through
normal publish because the server rejects them — that is why the stub
server exists):

| # | Manifest path(s) | Expected |
|---|---|---|
| 1 | `../escape.txt`, `a/../../b` | `path_unsafe` |
| 2 | `/abs.txt` | `path_unsafe` |
| 3 | `C:/win.txt`, `C:\win.txt`, `\\srv\share` | `path_unsafe` |
| 4 | `a%2fb.txt`, `a%252fb.txt`, `a%5cb.txt` | `path_unsafe` |
| 5 | `nul.txt`, `COM1`, `aux.html`, `trailing.` followed by U+0020 (space) | `path_unsafe` |
| 6 | `README.md` + `readme.md`, `A/x` + `a/X` | `path_collision` |
| 7 | Destination ancestor pre-replaced by a symlink | `path_unsafe`, no write through it |
| 8 | 300-segment deep path, 2000-char name | `path_unsafe` (length) |
| 9 | Manifest over `--max-files` / `--max-bytes` | `too_many_files` / `pull_too_large`, nothing downloaded |

## 12. Unverified assumptions

- Route precedence between `GET /api/v1/sites/{slug}/files` (manifest)
  and `GET /api/v1/sites/{slug}/files/{path}` (bytes, `wildcard: true`,
  compiled to `:path{.+}` in `packages/server/src/operations.ts`) is as
  read in the operation registry; no live request has confirmed both
  shapes on one instance in this design pass.
- `X-Kofra-Version`, `ETag`, and 304 behavior of `get_file_bytes` are
  as read in `packages/server/src/operations/http.ts`; no live byte
  download was exercised from this spec.
- Default bounds (20 000 files, 1 GiB, concurrency 6) are judgment calls
  for a recovery tool, not measurements; the future implementation may
  propose different defaults with evidence.
- Product direction (inspecting historical deploys and bulk recovery)
  follows the Netlify deploy-file-explorer guide linked from the
  roadmap discussion; no user interviews were run for this spec.
