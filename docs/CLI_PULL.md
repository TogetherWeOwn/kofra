# `kofra pull`: version-pinned site recovery (shipped)

Status: shipped. This document describes the implemented command; the
"proposed, design only" status and the section 7 security-review gate from
the design pass are superseded. The extraction-boundary review happened
during implementation (PR #84): every control it asked for is implemented in
`packages/cli/src/pull.ts` and pinned by `packages/cli/test/pull-guards.test.ts`
plus the protected acceptance suites. User-facing contract: `packages/cli/README.md`
("Pulling a version") and the AX-04 status row in `docs/SPEC.md`.

## 1. What it does

`kofra pull` copies one published site version from an instance to a local
directory: disaster recovery, migration, and "what is actually live"
inspection. It is the inverse of `kofra publish` for bytes only: it never
touches the instance (no uploads, no version creation, no settings).

```
kofra pull <site> <dir> [--version <ref>] [--force] [--json]
```

| Argument / flag | Meaning |
|---|---|
| `<site>` | Site slug, site id, or site URL, exactly as `publish --site` accepts |
| `<dir>` | Destination directory (created if missing; see section 5) |
| `--version <ref>` | `live` (default), `v3`, `3`, or a version id, resolved once server-side (section 3) |
| `--force` | Overwrite pulled paths inside a non-empty destination; local extras are preserved, never deleted |
| `--json` | Print exactly one JSON receipt on stdout (section 6); progress stays on stderr |

There is no `--dry-run`, `--concurrency`, `--max-files` or `--max-bytes`:
those were design-pass proposals and were not built. The command is
sequential, pages every manifest, and verifies every file.

Authentication, `--api`/`--key` resolution, and the moved-instance note
follow the existing commands (`resolveInstance`/`makeClient` in
`packages/cli/src/main.ts`). Pull needs a key with the `sites:read` scope.
No credential, project-link, or config file is written.

## 2. Source APIs (all existing, all authenticated reads)

The implementation uses exactly three existing endpoints, never rendered
viewer HTML and never any mutation:

1. `GET /api/v1/sites/{slug}/versions/{ref}` (`get_version`): resolve the
   `--version` ref **once** to a stable version id (`getVersionDirect` in
   `packages/cli/src/main.ts`, which unlike `resolveVersion` also accepts
   the `live` form and never pages history).
2. `GET /api/v1/sites/{slug}/files?version=<id>` (`list_files`): the pinned
   manifest, ordered by path, with per-file `size` and `sha256`. Pages of up
   to 1000 entries are followed via `nextCursor`; a repeated or
   non-progressing cursor is refused as `invalid_pull_response`.
3. `GET /api/v1/read-file?version=<id>&...&encoding=base64` (`read_file`):
   raw stored bytes in bounded pages of at most 1 MiB. Every page's
   `versionId`, `path`, `size`, `sha256`, `offset`, `length`, and
   canonical-base64 round-trip are checked before the bytes are accepted.

No new server API was added. Reads stay on the authorized API surface and
preserve original bytes (binary, Unicode, empty, HTML, CSS) with no viewer
rendering or URL rewriting.

## 3. Version pinning

The live pointer can move at any time (another publish, a restore). Every
pull pins the version before downloading anything:

1. Resolve `--version` (default `live`) to a version id via `get_version`.
   The resolved id must be immutable (`isImmutableVersionId` in
   `packages/cli/src/main.ts`: not blank, not `live`, not numeric/`vN`);
   otherwise the run stops with `invalid_pull_version` before any listing.
2. Pass that id as `?version=<id>` on the manifest read and on every byte
   page. Never re-resolve `live` mid-run.
3. Check every manifest page's `version.id` and every byte page's
   `versionId`, `path`, `size`, and `sha256` against the pin. On any
   mismatch: stop, keep what is verified so far, and record a per-file
   `invalid_pull_response` failure. Never mix files from two versions.

The readiness gate from the design pass (`version.status === "ready"` with
empty `missing`) was not built: pulling an explicit pending id downloads
whatever blobs it has uploaded, still under the same immutable pin and
integrity checks. For a published snapshot, pull `live` or a finalized `vN`.

## 4. No `--dry-run`

The design pass specified `--dry-run`; the shipped command does not have
one. The closest offline checks are `kofra files <site> [--version <v>]`
(manifest listing) and `kofra pull <site> <dir> --json` into a disposable
directory. Do not document or rely on a `--dry-run` flag: unknown flags
fail closed before any request or write.

## 5. Destination rules

- The destination is created (including parents) when missing. Creation is
  the only filesystem effect of the preflight: `checkPullDirectory` never
  deletes or modifies anything.
- An existing non-empty destination is refused with
  `pull_directory_not_empty` (exit 2) unless `--force` is passed. `--force`
  replaces only pulled file paths; extra local files are **never deleted**
  and their names are reported on stderr.
- Every manifest path passes `pathSegments`: nonempty forward-slash names,
  no dot segments, no backslash/colon/control characters, no Windows
  drive/UNC/reserved-name/trailing-dot-or-space spellings, and no `.git`
  segment in any case (publishing excludes `.git`, so server bytes must not
  become trusted Git configuration on disk). Anything else fails the file
  with `unsafe_pull_path`.
- Destination ancestors below the working directory must be plain
  directories: a symlink or non-directory parent is refused with
  `invalid_pull_directory` before anything is created. The walk is
  order-independent, so a missing intermediate directory never hides a
  symlinked ancestor (`link/sub/out` with `link -> outside` is refused).
- Inside the destination, symlink and non-directory parents are refused
  rather than followed (`unsafe_pull_path`), and a target that already
  exists as anything but a regular file is refused the same way.
- Filesystem aliases are refused, not normalized: a manifest name (or
  parent directory) that resolves on a case/normalization-insensitive disk
  to an earlier download or a differently named local extra fails with
  `pull_path_collision` instead of overwriting it. Use a case-sensitive
  destination for manifests containing such names.
- Do not modify the destination concurrently while pulling. The pull is
  atomic per file, not across the directory, and concurrent local
  modification is unsupported (not sandboxed).

## 6. Output, receipts, exit codes

`--json` writes exactly one object on stdout, **without** an `ok` wrapper:

```json
{
  "site": "my-site",
  "versionId": "ver_abc123",
  "dir": "/absolute/path/to/snapshot",
  "files": [{ "path": "index.html", "size": 12, "sha256": "<64 lowercase hex>" }],
  "failures": [{ "path": "file.bin", "code": "pull_integrity_mismatch", "message": "..." }]
}
```

Human mode prints one line per pulled file plus a summary with the pinned
version. Progress and extra-file notices stay on stderr. Pull-specific codes:

| Code | Exit | Meaning |
|---|---|---|
| `pull_directory_not_empty` | 2 (usage) | Destination exists and is not empty; retry with `--force` |
| `invalid_pull_directory` | 2 (usage) | Destination or a parent is a symlink / not a directory |
| `unsafe_pull_path` | 6 (invalid) / 2 (usage) | Manifest path unsafe, or local parent/target unsafe |
| `pull_path_collision` | 6 (invalid) | Manifest name aliases another file or directory on this disk |
| `invalid_pull_response` | 1 (error) | Listing or page metadata did not match the pinned manifest |
| `pull_integrity_mismatch` | 6 (invalid) | Verified bytes disagree with manifest size/SHA-256 |
| `invalid_pull_version` | 1 (error) | Server did not resolve an immutable version id |
| `pull_file_failed` | 1 (error) | Local write/replace failed (permissions, disk space) |

A failed file is named in `failures`, never counted in `files`, and leaves
no partial file: an old same-path file is retained when its replacement
fails. Other files continue; the first failure determines the exit code.
Failures before downloading (auth, version resolution, nonempty-directory
refusal) use the normal error envelope instead of a receipt.

## 7. Security review (completed during implementation)

The design pass blocked building on a review of this section. The review
happened commit by commit; each control below is implemented and pinned by
a mutant-checked test:

- Temporary files open exclusively (`wx`, `0o600`) and stay owner-only while
  unverified. Only after size and SHA-256 pass does the file receive the
  normal umask-adjusted mode, then it is renamed over nothing. (On Windows
  the mode bits are not enforced: pull into a private destination or apply
  an ACL to the temporary file.)
- Base64 pages must round-trip canonically; noncanonical encodings are
  rejected instead of decoded leniently.
- Manifest paths are validated before anything is created (section 5),
  including case-insensitive `.git` refusal so pulled bytes cannot become
  Git configuration.
- Ancestor and parent checks refuse symlinks rather than following them,
  independent of visit order or missing intermediates.
- Alias collisions (files and parent directories) fail closed with
  `pull_path_collision` instead of overwriting a differently named file.
- The resolved version id must be immutable; a server answering `live`
  stops the run before any manifest or byte read.

Residual limits (documented, not fixed): ancestor checks and the final
rename are not atomic against a hostile local actor swapping directories
mid-run — run pull on a trusted local disk, not a shared mount. Native
Windows/macOS filesystem behavior was exercised only via simulation, not
on those platforms (CI runs Linux). `.gitmodules` and other non-`.git`
dotfiles are treated as ordinary site bytes: `--force` into a Git worktree
replaces them like any pulled path.

## 8. Verification

- Protected acceptance: `npm run test:cli -- test/pull.acceptance.test.ts
  test/pull-worker.acceptance.test.ts` — RED before implementation (missing
  command), GREEN after, including a disposable real Worker and a built
  non-TTY CLI process: exact bytes (binary/Unicode/empty/multipage/HTML/CSS),
  pinned older versions, mid-pull republish, hostile paths, symlink
  sentinels, and JSON/exit contracts.
- Safety/integrity guards: `test/pull-guards.test.ts` — one targeted test
  per production guard (symlinked ancestors incl. missing intermediates,
  verified-file mode, `.git` case-insensitivity, mutable version ids,
  noncanonical base64, file and directory alias collisions), each confirmed
  by a surviving-then-failing mutant.
- Full gate: `npm run check` (guard, typecheck, all tests).

## 9. Non-goals (unchanged)

Decryption or plaintext export of encrypted sites; transfer-mode sites;
archive extraction; new bulk-download endpoints; resume; credentials or
project-link writes; overwrite/merge/prune/sync semantics beyond `--force`
replacement of pulled paths; changing what is live; progress bars beyond
the existing stderr conventions.
