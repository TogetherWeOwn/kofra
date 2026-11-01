# `kofra compare`: local directory vs pinned remote manifest (spec, v1)

Status: implemented. This document remains the source of truth for the
`compare` command. The implementation adds no new endpoints and changes no
existing command behavior beyond adding this read-only command.

Tags: **P2** (beyond parity; now implemented).

## 1. Problem

An agent-user wants to see which local bytes differ from an exact remote
version without publishing, without downloading site content, and without
moving the live pointer. Netlify describes the analogous workflow as comparing
local and historical build assets (deploy file explorer).

Today the closest command, `publish --dry-run`, is intentionally offline: it
resolves no instance (`packages/cli/src/main.ts`, `resolveInstance` is skipped
when `dryRun` is set) and returns the collected local file list without
contacting anything. It cannot answer "what differs from live". This spec
defines a separate, explicitly online, read-only command instead of
reinterpreting `--dry-run`.

Related but distinct work: server `diff_versions` ([TOG-37480](/TOG/issues/TOG-37480)),
read-back ([TOG-39179](/TOG/issues/TOG-39179)), omission explanation
([TOG-39181](/TOG/issues/TOG-39181)), pull ([TOG-39186](/TOG/issues/TOG-39186)),
offline diagnosis ([TOG-39189](/TOG/issues/TOG-39189)). None of them is a
prerequisite for this spec, and this spec does not change any of them.

## 2. Non-goals (v1)

- No publish, sync, mirror, restore, delete, or "apply" semantics. `compare`
  never writes remotely, locally (except stdout/stderr), or to config.
- No content downloads: no file bytes, no `rawUrl` fetches, no site-URL fetches.
  Only manifest metadata (`path`, `size`, `sha256`) is read.
- No new REST or MCP endpoints. The command uses two existing authenticated
  `GET` reads (section 5).
- No ZIP extraction, URL sources, decryption, encrypted-payload comparison, or
  single-file comparison. V1 compares **directories only**.
- No new ignore matcher and no dependency on the omission-explanation feature:
  the current collector and its ignore rules are the sole inclusion source
  (section 4).
- No `--dry-run` behaviour change. `publish --dry-run` stays offline.

## 3. Command surface

```
kofra compare <path> --site <name> [--version <ref>] [--json] [--quiet]
  [--include-unchanged] [--limit <n>] [--max-files <n>] [--max-bytes <n>]
```

| Flag | Meaning |
|---|---|
| `<path>` (required) | Local directory to compare. Must be a directory; a file, ZIP, or missing path is a usage error (section 8). |
| `--site <name>` / `-s` (required) | Site slug on the instance. No `dropway.json` link lookup: the target must be explicit every time, so a stale link can never silently compare against the wrong site. |
| `--version <ref>` (optional) | `live` (default), `v<N>`, `<N>`, or a version id. Resolved once, then pinned (section 5). |
| `--json` | Print exactly one JSON object on stdout (section 7). |
| `-q, --quiet` | No progress output (same convention as every command). |
| `--include-unchanged` | Include `unchanged` records in output. Without it, records list only `local_only`, `remote_only`, and `changed`; counts always cover all four classes. |
| `--limit <n>` | Max records printed (default 500, range 1–100000). Counts are always computed over the full comparison; `truncated: true` marks a cut record list. |
| `--max-files <n>` | Refuse before hashing when the eligible local path count exceeds this (default 50000, range 1–500000). |
| `--max-bytes <n>` | Refuse before hashing when eligible local bytes exceed this (default 2147483648, i.e. 2 GiB; range 1–10737418240). Accepts plain bytes only in v1. |

Global `--api` / `--key` resolution is unchanged (`resolveInstance` in
`packages/cli/src/main.ts`): `--api` flag, then `KOFRA_API`/`KOFRA_URL`, then
`dropway.json` `api`, then saved default. A key is **required**
(`requireKey`); there is no `--anonymous` flag on `compare`, because manifest
reads need `sites:read` under existing access controls, and anonymous sites
are addressed by claim token via `--key` like `files` is today.

Unknown publish-only flags (`--allow-secrets`, `--save`, `--no-save`,
`--new`, `--wait`, `--encrypt`, `--spa`, `--base`, `--message`,
`--concurrency`) are rejected as usage errors. There is deliberately no
unsafe wrong-flag path: nothing you can pass to `compare` publishes, writes
config, or downloads content.

## 4. Local side: reuse the collector, nothing else

The local eligible set is produced by exactly one code path: `collectFiles()`
in `packages/cli/src/files.ts`, called on the directory with
`{ exclude: [linkPath(cwd)] }` (the `dropway.json` link file is never an
input, matching `publish`). Inclusion semantics are therefore identical to
today's publish pipeline and its tests
(`packages/cli/test/unit.test.ts`, `collectFiles` block):

- Walk sorted directory entries; apply built-in ignores plus
  `<path>/.dropwayignore` via `IgnoreMatcher`; record `ignored[]`.
- Symlinked directories are skipped and recorded in `skippedLinks[]`
  (never followed; no new follow-symlink behaviour in v1).
- Every eligible file is hashed with SHA-256 (`hashFile`: in-memory up to
  4 MiB, streamed above) producing `{ path, size, sha256 }` with POSIX paths.
- Concurrency stays at the collector default (16).

Secrets handling differs from publish on purpose: `compare` publishes
nothing, so a secrets finding must not block it. The future implementation
calls the collector with secret scanning enabled but **never fails** on
findings, never prints secret values or matched text, and reports at most
`secretsFound: <count>` (no paths, no line numbers, no kinds) as a warning
that the directory still needs review before any future publish. This keeps
the collector as the sole inclusion source while refusing to turn an
inspection command into a credential oracle.

Single files, ZIP archives, and URL sources are rejected with usage errors
(`compare_directory_only`, `compare_zip_unsupported`; section 8) even though
the collector and `publish` accept some of them. Encrypted publishes are not
special-cased and need no decryption: `encryptFiles()`
(`packages/cli/src/encrypt.ts`) packs the whole tree into one
`encrypted.bin` blob, so a compare against an encrypted version naturally
reports N `local_only` records plus one `remote_only` (`encrypted.bin`).
The human output adds a one-line note when the pinned manifest is exactly
that single file — a heuristic, stated as such, since metadata alone cannot
distinguish it from a plaintext site containing one file of the same name.

## 5. Remote side: resolve once, pin, read manifest

Exactly two authenticated `GET` reads, both under existing `sites:read`
access controls:

1. **Resolve and pin.** The command resolves the ref **once** at the start
   and pins the canonical version id:
   - omitted / `live`: `GET /api/v1/sites/{slug}/versions?limit=500` (the
     same list `resolveVersion` in `packages/cli/src/main.ts` uses) and pin
     its `currentVersionId` at resolve time. The rollback "previous version"
     default is **not** reused — an omitted ref on `compare` always means live.
   - `v<N>` / `<N>` / id: `GET /api/v1/sites/{slug}/versions/{id}` (the
     `get_version` operation, served by `resolveVersionRef`, which sees rows
     of any status — unlike the CLI `resolveVersion` list, which only
     contains `ready` versions). If the row's `status` is not `ready`, fail
     with `version_not_ready` (section 8): a pending manifest is not
     immutable yet, so a comparison against one could silently mislead.
   - If the ref is omitted or `live` and the site has no live version, fail
     with `no_live_version` (section 8); comparing against "nothing" is a
     refusal, not an empty diff. An explicit `v<N>` / `<N>` / id ref still
     compares against that version once it is `ready` — `no_live_version`
     never blocks an explicit historical ref.
   - If the ref matches nothing, fail with `version_not_found`.
2. **Read the immutable manifest.**
   `GET /api/v1/sites/{slug}/files?version=<pinnedId>` in its raw REST form
   (`packages/server/src/operations/core-api.ts`, `list_files` HTTP handler),
   which returns the whole manifest from `listFiles()` in
   `packages/core/src/services/deploys.ts` in a single response:
   `{ version, files: [{ path, size, sha256, contentType, ... }] }` ordered
   by path from the immutable `version_files` rows. The implementation must
   use this raw form, not the operation/MCP handler's paged form (default
   limit 200, max 1000, `nextCursor`): the paged handler loads the same full
   manifest via `listFiles()` and slices it in memory, so paging would add
   requests without reducing server work, while one raw `GET` keeps the
   "exactly two reads" contract exact. Counts are exact over the full
   manifest, never over one page. Only `path`, `size`, and `sha256`
   are used; URLs in the response are never fetched.

The pinned version id is echoed in every output (section 7). If live moves
after pinning, the comparison still describes the pinned manifest; the
implementation **must not** re-resolve mid-run. (A future `--warn-if-live-moved`
re-check is out of scope for v1.)

## 6. Comparison semantics

Inputs: the local eligible list `L = [{ path, size, sha256 }]` and the
pinned remote manifest `R = [{ path, size, sha256 }]`. Both are sorted by
path in byte (UTF-8 code-unit) order; the join is on exact path equality
(case-sensitive, POSIX separators).

| Class | Rule | Record fields |
|---|---|---|
| `unchanged` | Same path, same `size`, same `sha256` | `path`, `size`, `sha256` |
| `changed` | Same path, `size` or `sha256` differs | `path`, `localSize`, `localSha256`, `remoteSize`, `remoteSha256` |
| `local_only` | Path only in `L` | `path`, `size`, `sha256` |
| `remote_only` | Path only in `R` | `path`, `size`, `sha256` |

Determinism: records are emitted in path byte order within each class, and
classes in the fixed order `changed`, `local_only`, `remote_only`,
`unchanged`. Counts and byte totals are exact integers over the full
comparison (never over a truncated record list):

- `counts: { changed, localOnly, remoteOnly, unchanged, localTotal, remoteTotal }`
- `bytes: { changedLocal, changedRemote, localOnly, remoteOnly, unchanged, localTotal, remoteTotal }`

`remote_only` means only "present in the pinned remote manifest and absent
locally". It is **not** a promise that a future publish would delete it, and
the human output says so verbatim: `remote_only paths are not deleted by
publishing; publish replaces the version, it does not mirror deletions.`
There are no mirror/deletion semantics anywhere in this command.

Incomplete metadata: `version_files` rows always carry `size` and `sha256`
today, but if a row ever arrives missing or malformed (empty hash, negative
size), the path is classified `changed` with `reason: "incomplete_metadata"`
and counted as changed — never as `unchanged`. The output `warnings[]`
carries one entry per affected path (capped by `--limit`, with the cap noted).

Caps and cancellation:

- `--max-files` / `--max-bytes` are checked from the collector's eligible
  list **before** hashing starts (sizes come from `stat`, so no bytes are
  read first). Exceeding either fails with `compare_cap_exceeded` (exit 2),
  naming the cap, the observed value, and the flag to raise it. The command
  never claims a full comparison from a partial walk.
- SIGINT (Ctrl-C) stops the run promptly (within one in-flight hash/read),
  prints no partial JSON, and exits 2 with `compare_cancelled` on stderr.
- Local-file-change detection: each file is `stat`ed before and after its
  hash; if size or mtime changed mid-hash, the run fails with
  `compare_source_changed` (exit 2) naming the path, instead of reporting a
  hash that matches neither the old nor the new bytes. No silent retry.

## 7. Output

### 7.1 JSON (`--json`): schema version 1

Exactly one JSON object on stdout; progress and notes go to stderr only
(existing `Output` convention). `schemaVersion: 1` is required; future
implementations add fields but never rename or remove v1 fields without
bumping it.

```jsonc
{
  "ok": true,
  "schemaVersion": 1,
  "command": "compare",
  "api": "https://dropway.example.workers.dev",
  "site": "team-report",
  "local": { "root": "/home/you/team-report", "kind": "dir" },
  "pinned": {
    "versionId": "ver_abc123",
    "number": 7,
    "requestedRef": "live",
    "resolvedAt": "2026-10-24T12:00:00.000Z",
    "fileCount": 3,
    "totalBytes": 1234
  },
  "counts": { "changed": 1, "localOnly": 1, "remoteOnly": 1, "unchanged": 1, "localTotal": 3, "remoteTotal": 3 },
  "bytes": { "changedLocal": 20, "changedRemote": 18, "localOnly": 5, "remoteOnly": 9, "unchanged": 11, "localTotal": 36, "remoteTotal": 38 },
  "records": [
    { "class": "changed", "path": "index.html", "localSize": 20, "localSha256": "aaa…", "remoteSize": 18, "remoteSha256": "bbb…" },
    { "class": "local_only", "path": "draft.md", "size": 5, "sha256": "ccc…" },
    { "class": "remote_only", "path": "old.css", "size": 9, "sha256": "ddd…" }
  ],
  "truncated": false,
  "ignored": ["drafts/"],
  "skippedLinks": ["linked"],
  "secretsFound": 0,
  "warnings": []
}
```

Field traceability (every field maps to an existing primitive):

| Field | Source |
|---|---|
| `api`, `site` | `resolveInstance()` result; explicit `--site` |
| `local.root`, `local.kind` | `collectFiles()` return (`root`, `kind`) |
| `pinned.versionId/number/fileCount/totalBytes` | `listFiles()` `version` (`serializeVersion`) |
| `pinned.requestedRef`, `resolvedAt` | CLI-side: the `--version` value (or `"live"`); wall clock at pin time |
| `counts`, `bytes`, `records` | Pure function over `L` and `R` (section 6) |
| `truncated` | `--limit` vs full record count |
| `ignored`, `skippedLinks` | `collectFiles()` return (same arrays `publish --dry-run` prints) |
| `secretsFound` | Count of collector secret findings (values never included) |
| `warnings` | `incomplete_metadata` entries; encrypted-publish note as `{ code, message }` |

### 7.2 Human output

```
Compared /home/you/team-report against team-report v7 (pinned ver_abc123, live at resolve time).
  changed     1 file   (local 20 B, remote 18 B)
  local_only  1 file   (5 B)
  remote_only 1 file   (9 B)
  unchanged   1 file   (11 B)
  ~ index.html (20 B -> 18 B)
  + draft.md (5 B)
  - old.css (9 B, remote only)
remote_only paths are not deleted by publishing; publish replaces the version, it does not mirror deletions.
Ignored: drafts/. Skipped symlinked folder linked/.
```

Symbols: `~` changed, `+` local only, `-` remote only, `=` unchanged (only
with `--include-unchanged`). Hashes are not printed in human output (paths
plus sizes are enough to act on; full hashes are in `--json`). Non-TTY
behaviour: identical text, no progress line, no colours; errors keep the
existing `Error (<code>): <message>` + `Fix: <hint>` shape on stderr.

### 7.3 Examples

```sh
# What differs from live? (needs a key with sites:read)
kofra compare ./dist --site team-report

# Against an exact older version, for scripts and agents
kofra compare ./dist --site team-report --version v6 --json

# Including unchanged files, capped record list, raised caps for a big tree
kofra compare ./dist --site team-report --include-unchanged --limit 200 \
  --max-files 200000 --max-bytes 8589934592
```

## 8. Errors

All errors use the existing `CliError` shape (`code`, `message`, `hint`,
`exitCode`, plus `status`/`requestId` for HTTP failures) and the stable
`EXIT` codes in `packages/cli/src/client.ts`. `code` values are snake_case
and stable.

| Code | Exit | When | Hint (next action) |
|---|---|---|---|
| `no_instance` (existing) | 2 | No `--api` / env / saved default | Pass `--api`, set `KOFRA_API`, or `kofra login` |
| `not_logged_in` (existing) | 3 | No key available | `kofra login`, `KOFRA_API_KEY`, or `--key` |
| `path_not_found` (existing) | 2 | `<path>` missing | Choose an existing directory |
| `compare_directory_only` | 2 | `<path>` is a file, not a directory | Point at the containing directory (v1 compares directories only) |
| `compare_zip_unsupported` | 2 | `<path>` is a `.zip` | Extract locally and compare the folder |
| `site_not_found` (HTTP 404 → existing mapping) | 4 | Site missing or not visible to the key | Check the name; `kofra list` |
| `version_not_found` (existing) | 4 | `--version` matches nothing finalized | `kofra versions <name>` |
| `no_live_version` | 4 | Omitted/`live` ref on a site with nothing live | Publish first, or pass an explicit `--version` |
| `version_not_ready` | 4 | Pinned version is `pending` | Wait for the publish to finalize, then re-run |
| `compare_cap_exceeded` | 2 | Eligible paths/bytes exceed `--max-files`/`--max-bytes` | Raise the named flag, or narrow the directory |
| `compare_source_changed` | 2 | A local file changed during hashing | Re-run when the tree is quiet |
| `compare_cancelled` | 2 | SIGINT | Re-run to get a complete comparison |
| HTTP 401/403/429/5xx/network (existing mapping) | 3/7 | Auth, rate limit, server, network | Existing client retry/hint behaviour unchanged |

`compare` performs no retries beyond the existing client defaults for safe
`GET`s (4 attempts, backoff; `client.ts` `ClientOptions`). A 409 cannot
occur (no writes); a 422 from the server surfaces through the existing
invalid-input mapping (exit 6).

## 9. Security and side-effect guarantees

- **Zero remote mutations**: only the two `GET` reads in section 5. No
  `POST`/`PUT`/`PATCH`/`DELETE`, no idempotency keys, no version creation.
- **Zero content downloads**: file bytes are never fetched — not via
  `rawUrl`, not via site URLs, not via `GET /api/v1/sites/{slug}/files/{path}`.
  A future implementation test asserts the mock fetch layer saw only the two
  manifest `GET`s (GET-only sentinel; section 10).
- **Zero config/credential writes**: no `dropway.json` write (no `--save`
  flag exists), no credentials read beyond the existing resolution, no key
  printed, no new credentials minted.
- **No secret values in output**: hashes, sizes, paths, counts only.
  `secretsFound` is a count; secret kinds/paths/lines are omitted even though
  the collector computes them. Secret-sentinel fixtures (section 10) assert
  no credential literal appears in stdout or stderr.
- **Existing access controls only**: the key needs `sites:read` on the site
  (or a claim token for its anonymous site); site-restricted keys compare
  only their site. No new scopes, grants, or activation authority.
- **No unsafe wrong-flag path**: publish-only flags are usage errors
  (section 3); there is no flag combination that writes, deletes, restores,
  or publishes.

## 10. Acceptance matrix (implemented)

Each row is covered against disposable fixtures or the local Worker harness in
`packages/cli/test`. The main contract lives in
`test/compare.acceptance.test.ts`; filesystem interruption boundaries live in
`test/compare-process.acceptance.test.ts` and
`test/compare-stat-boundary.test.ts`; OS-signal termination is covered in
`test/compare-double-sigint.test.ts`; and behavior against real Worker
manifests is covered in `test/compare-worker.acceptance.test.ts`. The matrix
also covers the implementation-only guards added with it: metadata redirects
are refused, torn manifests are rejected when their row count disagrees with
the pinned version, and hostile filenames remain escaped at the human output
boundary.

| # | Case | Recipe | Expect |
|---|---|---|---|
| 1 | Equal hashes | Publish fixture dir (3 files) via existing flow; `compare` unchanged tree `--json` | `counts.unchanged=3`, others 0; `truncated=false`; exit 0 |
| 2 | Changed bytes | Edit 1 file's bytes (same size and different size variants) | 1 `changed` record with both hashes/sizes; counts exact |
| 3 | Local-only path | Add 1 file locally | 1 `local_only` with size+sha256 matching `sha256sum` |
| 4 | Remote-only path | Delete 1 file locally after publish | 1 `remote_only`; human output contains the no-deletion sentence verbatim |
| 5 | Explicit version pin | Publish v2, then `compare --version v1` | `pinned.number=1`, `pinned.versionId` = v1 id; records describe v1 |
| 6 | Live moves after pin | (Unit/clock test) live advances between resolve and manifest read | Records still describe the pinned id; `pinned.versionId` echoed; no re-resolve |
| 7 | Missing version | `--version v99` | `version_not_found`, exit 4, hint names `kofra versions` |
| 8 | Denied site | Key without access / wrong site | 404 mapping, exit 4; no manifest content leaked in error |
| 9 | No live version | Fresh empty site, default (live) ref | `no_live_version`, exit 4 (not an empty diff, exit 0) |
| 10 | Pending version | `--version` pointing at a `pending` deploy | `version_not_ready`, exit 4 |
| 11 | Cap refusal | `--max-files 1` on a 3-file tree; `--max-bytes 1` | `compare_cap_exceeded`, exit 2, names cap + observed + flag; no partial claim |
| 12 | Cancel | SIGINT mid-hash (large fixture) | `compare_cancelled`, exit 2; no partial JSON on stdout |
| 13 | Source changed mid-hash | Rewrite a file while hashing (fault-injection on `stat`) | `compare_source_changed`, exit 2, names the path |
| 14 | Secret sentinel | Fixture with a GitHub-token-shaped string in a small text file | Exit 0, `secretsFound=1`, stdout+stderr contain no token literal |
| 15 | GET-only sentinel | Mock fetch records methods/URLs | Only the two manifest `GET`s; zero `PUT/POST/PATCH/DELETE`, zero byte-URL fetches |
| 16 | No-write sentinel | Run in a temp HOME + temp cwd | No `dropway.json` created/modified, no credentials file touched |
| 17 | Ignore parity | Fixture with `.env`, `node_modules/`, `.dropwayignore` entry, symlinked dir | `ignored[]`/`skippedLinks[]` identical to `publish --dry-run --json` on the same tree |
| 18 | Non-TTY | Piped stdout/stderr | Identical text minus progress; errors keep `Error (code)` + `Fix:` shape |
| 19 | Truncation honesty | `--limit 1` on a 3-record diff | `truncated=true`, 1 record, counts still exact over all 3 |
| 20 | Incomplete metadata | Manifest row with empty/missing sha256 (fault-injection) | Path classified `changed` with `reason=incomplete_metadata`; never `unchanged` |

Design checks retained from the spec: every `--json` field traces to an
existing primitive or documented CLI-side computation (section 7.1 table);
all three `GET` shapes exist on current main (`list_files` raw REST form,
`get_version`, and the versions list behind `main.ts` `listAllVersions`);
error codes follow the `ApiError`/`CliError` snake_case convention;
`publish --dry-run` is referenced but untouched.

## 11. Alignment and rollout

This design was approved and implemented as a read-only command. Any future
trust or permission boundary found in review goes to the CISO. Behavior
changes still need the same alignment/security disposition as the original
implementation.

Skills used: verification-before-completion (enabled); documentation-and-adrs
is installed but not enabled for this agent and was skipped.
