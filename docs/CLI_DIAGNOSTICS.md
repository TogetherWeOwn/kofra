# CLI configuration diagnostics

**Status: Proposed.** Design sign-off is pending. Do not implement this
spec until the design is approved, and do not start an implementation card
until the security-review questions below have a recorded disposition.
This document is the single source of truth for the proposed contract;
the command help and the CLI guide will point here rather than restate it.

## Problem

Before asking for credentials or publishing to the wrong origin, an agent
should be able to answer three questions offline: which configuration
source actually wins, whether each consulted source is absent, valid,
malformed, empty or unreadable (lower sources are only reported as
shadowed, never classified), and what to do next. Today it cannot:

- `packages/cli/src/main.ts` (`resolveInstance`) implements a real
  precedence chain (`--api` flag, then `KOFRA_API`/`KOFRA_URL`, then
  `./dropway.json`, then the saved default instance; `--key`, then
  `KOFRA_API_KEY`, then the saved key), but no command shows the outcome.
- `packages/cli/src/config.ts` (`readCredentials`, `readLink`) collapses
  missing, unreadable and invalid-JSON files into absent/empty values,
  and permissively coerces other parsed input without a health report.
  A corrupt file can look like a fresh machine or still supply usable
  configuration, with no way to distinguish those cases.
- The existing config tests (`packages/cli/test/unit.test.ts`, "config")
  cover storage round-trips and path mapping, not diagnostic provenance
  or redaction.

The fix proposed here is a strictly offline, read-only `explain-config`
command that reports the effective configuration and every source's
state, with credentials and other sensitive values redacted by
construction.

## Non-goals

- No change to resolver behavior. `readCredentials` and `readLink` keep
  their current reads and coercions: unreadable files and invalid JSON
  collapse to absent/empty, but parseable wrong-shaped objects may still
  supply usable defaults, keys or links. A diagnostic `invalid_shape`
  does not make those values absent. Classification is a separate read
  path, never permission to tighten the resolver.
- No repair, no writes, no network, no token validation, no login, no
  rotation, no telemetry, no probes. See "Offline and read-only".
- No new server API, no scope or policy change, no hosted concepts.

## Command (normative for the implementation PR)

```
kofra explain-config [path] [--api <url>] [--key <key>] [--json] [-q]
```

- `explain-config` takes the same global `--api` / `--key` flags as every
  command, because those flags *are* precedence inputs under diagnosis:
  `kofra explain-config --api <url>` shows how that value would win.
  No new flags. No alias.
- The optional `[path]` is a publish path as accepted by
  `kofra publish <path>`. When given, the output reports the single
  mapping lookup for that path (found slug, or missing). The command
  never enumerates the stored mappings.
- The command never prompts and never reads stdin, even on a terminal.
- Future help line (one line, from the command table as usual):
  `explain-config`: "Show which configuration wins, without contacting
  anything". Future guide row: `explain-config [path]` — "Diagnose local
  configuration offline: winning sources, file states, redacted".

## Resolution model

### Sources and precedence

API origin, highest precedence first:

| # | Kind | Detail (closed set) |
|---|------|---------------------|
| 1 | `flag` | `--api` |
| 2 | `env` | `KOFRA_API` or `DROPWAY_API`, then `KOFRA_URL` or `DROPWAY_URL` (literal winning name within each twin pair; see below) <!-- rebrand:keep --> |
| 3 | `project` | `./dropway.json` field `api` |
| 4 | `default` | saved default instance in `credentials.json` |

Key, highest precedence first:

| # | Kind | Detail (closed set) |
|---|------|---------------------|
| 1 | `flag` | `--key` |
| 2 | `env` | `KOFRA_API_KEY` or `DROPWAY_API_KEY` (literal winning name within the twin pair) <!-- rebrand:keep --> |
| 3 | `saved` | `credentials.json` entry for the effective API origin |

Rules:

- Selection is positional, not by validity: the first *present* source
  wins, exactly as the resolver does today. A present-but-invalid API
  value fails resolution with `invalid_api_url`; lower sources are
  reported as shadowed, never consulted, and their values are not
  validated. This mirrors `resolveInstance`, which normalizes the first
  present value and throws. In JSON, shadowed chain positions appear
  only as `source` references on `api.source_shadowed` /
  `env.legacy_shadowed` checks, naming kind plus detail with no
  validity claim; file health is reported separately and always (see
  States), independent of chain position.
- Empty string is absent for env and for every key source, but
  present-but-empty for API flag/link/default sources. The resolver
  chains env with `||` and tests keys with truthiness, so empty values
  there fall through; it chains the API flag, link and default with
  `??`, so an empty `--api`, an empty link `api` and an empty saved
  default each *win* and then fail resolution with `no_instance`
  (`main.ts:128-136`; `str()` returns `""` for `--api ""`). The
  diagnostic mirrors this exactly: it reports the empty winner plus
  `api.empty_value`, never a fall-through.
- Legacy names: `DROPWAY_*` fills an unset or empty `KOFRA_*` twin
  (`withLegacyEnv` in `packages/cli/src/legacy-brand.ts`). The output
  names the literal winning variable and sets `viaLegacyName: true`
  when the value arrived through a `DROPWAY_*` twin. When both twins
  are set, `KOFRA_*` wins and the legacy twin is reported shadowed.
- Saved-key lookup is keyed by the effective API origin. Unreadable or
  invalid-JSON credentials yield "no saved key". An `invalid_shape`
  classification does not veto values the existing resolver still
  accepts: effective origin/key selection must mirror its coercions,
  independently of file-health summaries. For example, a usable default
  and matching saved key can still win when an unrelated instance entry
  is `null`, even though that file is diagnosed `invalid_shape`.

### States

File sources (`credentials.json`, `./dropway.json`) are always examined
and classified as one of (file health is independent of chain
position: a shadowed file is still classified):

- `absent`: the file does not exist.
- `valid`: readable, parses, and has the expected shape (see File
  shapes below).
- `malformed`: invalid JSON (`invalid_json`), or valid JSON whose
  top-level value or known fields have the wrong type (`invalid_shape`).
  Classification only: invalid JSON collapses to absent/empty, while
  `invalid_shape` may leave usable values under existing resolver
  coercions. It must not force an otherwise usable source to fall through.
- `unreadable`: exists but cannot be read (`permission` for
  `EACCES`/`EPERM`, `not_a_file` for `EISDIR` and friends, `io_error`
  otherwise). Closed enum; no `strerror` text is emitted.

#### File shapes (normative)

`credentials.json` is `valid` when every rule below holds; otherwise it
is `malformed` with `invalid_shape`:

- The top level is an object. Arrays, `null` and primitives are
  `invalid_shape`. This is a diagnostic shape rule, not a claim that
  every such value makes the resolver return empty; resolver coercions
  remain untouched.
- `version`, when present, is ignored: any value (including a wrong
  number or type, or absence) keeps the file classifiable by the
  remaining rules, matching the resolver, which never reads it.
- `default`, when present, is a string or `null`. Any other type is
  `invalid_shape`. Empty string is allowed here (it becomes the
  `empty` API value state downstream when it wins).
- `instances`, when present, is a non-`null`, non-array object. Any
  other type is `invalid_shape`.
- Every `instances` entry is a non-`null`, non-array object. A
  non-object entry is `invalid_shape`. Entry fields are not policed
  further: `hasEntryForEffectiveApi` mirrors the resolver's truthiness
  test (`creds.instances[api]?.key`), without retaining the value.
- Unknown top-level and entry fields are ignored (see Compatibility
  notes).

`./dropway.json` is `valid` when every rule below holds; otherwise it
is `malformed` with `invalid_shape`:

- The top level is an object. Arrays, `null` and primitives are
  `invalid_shape`.
- `api`, when present, is a string (empty allowed; downstream `empty`
  state). Any other type is `invalid_shape`.
- `sites`, when present, is a non-`null`, non-array object whose values
  are all strings. Any other shape is `invalid_shape`.
- `$comment` and unknown fields are ignored.

Value sources (flag, env, `link.api`, saved default) classify as
follows. These labels describe consulted sources only — the winner of
each chain. Shadowed lower sources keep no label: they are named on
`api.source_shadowed` / `env.legacy_shadowed` checks without being
read past presence or validated:

- `absent`: unset; or empty for env values and for every key source.
- `valid`: present and accepted (API values must pass origin
  normalization; any non-empty key counts as present — key format is
  not validated offline).
- `invalid`: present but rejected (API values that fail normalization).
  The rejected input is never echoed.
- `empty`: present-but-empty API flag, link `api` or saved default.
  Resolution fails with `no_instance`, exactly as the resolver does;
  lower sources are shadowed, never consulted.

## JSON contract

With `--json` the command prints exactly one JSON object on stdout (the
usual CLI envelope rules apply) and nothing else there. The data
envelope is used for every diagnosed outcome, including unconfigured
and missing-key outcomes. Argument-parsing failures and unexpected
internal failures use the error envelopes defined under Exit semantics
instead (including the fixed exit-1 envelope, even after successful
argument parsing). The JSON shape is normative; the human text is
illustrative but bound by the same redaction rules.

```jsonc
{
  "schema": "kofra.explain-config/v1",
  "ok": true,                        // exitCode === 0
  "status": "ready",                  // ready | needs_key | unconfigured
  "exitCode": 0,
  "api": {
    "origin": "https://dropway.example.workers.dev",  // normalized origin, or null
    "source": { "kind": "env", "detail": "KOFRA_API", "viaLegacyName": false }  // or null
  },
  "key": {
    "present": true,
    "source": { "kind": "saved", "detail": null }, // flag | env | saved | null
    "kind": "api_key"                 // api_key (dw_…) | claim_token (dwc_…) | other | null
  },
  "configDir": { "selector": "default", "viaLegacyName": false, "path": "~/.config/dropway" },
  "credentialsFile": {
    "state": "valid", "detail": null,
    "defaultPresent": true, "instanceCount": 2,
    "hasEntryForEffectiveApi": true
  },
  "projectLink": {
    "state": "valid", "detail": null,
    "apiMatchesEffective": true, "sitesEntryCount": 1,
    "mapping": { "key": "dist", "slug": "bright-otter-x7k2" }  // or {key,slug:null}, or null without [path]
  },
  "checks": [
    { "id": "api.selected", "severity": "info", "code": "source_selected",
      "hint": "…", "nextAction": null, "source": { "kind": "env", "detail": "KOFRA_API" } }
  ]
}
```

Field rules:

- `schema` is `kofra.explain-config/v1`. Version 1 only ever gains new
  check IDs and new nullable fields; consumers must ignore unknown
  check IDs. Any breaking change ships as a new schema string.
- `source.detail` for flags is the literal flag (`--api`, `--key`); for
  env it is the literal variable name from the closed set
  `KOFRA_API`, `DROPWAY_API`, `KOFRA_URL`, `DROPWAY_URL`, <!-- rebrand:keep -->
  `KOFRA_API_KEY`, `DROPWAY_API_KEY`. This applies to selected and <!-- rebrand:keep -->
  shadowed source references. A winning legacy twin keeps its literal
  `DROPWAY_*` name and has `viaLegacyName: true`; a winning `KOFRA_*` <!-- rebrand:keep -->
  name has `viaLegacyName: false`. A shadowed reference names the
  literal variable but makes no claim about its value. For `project`,
  `default` and `saved`, `source.detail` is `null`. <!-- rebrand:keep -->
- `credentialsFile.defaultPresent`, `instanceCount` and
  `hasEntryForEffectiveApi` are always present, never omitted. Their
  values follow the table below; `null` means unavailable, not absent.
  For a `valid` file, `defaultPresent` is true exactly when `default`
  is a string (including an empty string), and `instanceCount` is the
  number of own entries in `instances` (zero when omitted).
  `hasEntryForEffectiveApi` is the truthiness of the saved entry's
  `key` at the resolved origin, not merely the presence of that entry.
  If no origin resolved (including an empty winning `--api`), no lookup
  occurs and that field is `null`, regardless of file state.

  | Credentials file state | `defaultPresent` | `instanceCount` | `hasEntryForEffectiveApi` |
  |---|---|---|---|
  | `absent` | `false` | `0` | `false` if an origin resolved, otherwise `null` |
  | `valid` | boolean as above | count as above | boolean lookup result if an origin resolved, otherwise `null` |
  | `malformed` (`invalid_json` or `invalid_shape`) | `null` | `null` | `null` |
  | `unreadable` (any detail) | `null` | `null` | `null` |

  Malformed and unreadable summaries stay unavailable even though the
  unchanged resolver treats unreadable/invalid JSON credentials as
  empty for resolution. A valid file's default and count remain known
  when the effective API is unresolved. These summary fields do not
  change source selection or exit semantics.
- `removed` appears only on the `api.value_trimmed` check. It is an
  array of distinct strings drawn from `userinfo`, `path`, `query`
  and `fragment`, in that order, listing each part normalization
  dropped. All other checks omit the field.
- `projectLink.apiMatchesEffective` is raw string equality between
  `link.api` and the effective origin, mirroring `publish`
  (`main.ts:300`), not normalized equality. A link whose `api`
  normalizes to the effective origin but carries trimmable parts still
  reports `false`, and its mappings are ignored, exactly as `publish`
  behaves today.
- `projectLink.apiMatchesEffective`, `sitesEntryCount` and `mapping` are
  always present, never omitted. `null` means unavailable, not absent:

  | Link state | `apiMatchesEffective` | `sitesEntryCount` | `mapping` |
  |---|---|---|---|
  | `absent` | `false` | `0` | `null` without `[path]`, else `{key, slug: null}` |
  | `valid` | raw equality as above; `false` when the link has no `api` or no origin resolved | number of own `sites` entries (`0` when omitted) | `null` without `[path]`; else `{key, slug}` with `slug` the stored string only when `apiMatchesEffective` is `true` and the entry is a non-empty string, otherwise `null` |
  | `malformed` (`invalid_json` or `invalid_shape`) | `null` | `null` | `null` without `[path]`, else `{key, slug: null}` |
  | `unreadable` (any detail) | `null` | `null` | `null` without `[path]`, else `{key, slug: null}` |

  `mapping` is `null` only when `[path]` is absent. With `[path]`, a
  `slug: null` lookup emits `project_link.mapping_missing`, a non-null
  one `project_link.mapping_found`. Malformed and unreadable links
  report no coerced lookup: the `project_link.*` error check carries
  the diagnosis, and these fields do not change source selection or
  exit semantics.
- `configDir.selector` names the literal winning variable: one of
  `KOFRA_CONFIG_DIR`, `DROPWAY_CONFIG_DIR`, `XDG_CONFIG_HOME`, <!-- rebrand:keep -->
  `APPDATA`, `default`, matching `configDir()` precedence. `run()`
  merges env with the generic legacy rule before commands read it, so
  `DROPWAY_CONFIG_DIR` fills `KOFRA_CONFIG_DIR` exactly like the API <!-- rebrand:keep -->
  twins; when it does, the selector is `DROPWAY_CONFIG_DIR` with <!-- rebrand:keep -->
  `viaLegacyName: true`.
- Every string is capped at 1024 characters; longer values are cut with
  a `[…truncated]` marker. `checks` holds at most 32 entries (the
  closed ID set below cannot reach that; the cap is a backstop).
- Output is deterministic: the same filesystem, environment, argv and
  working directory produce byte-identical stdout. No timestamps, no
  `savedAt`, no random ordering; checks appear in the table order below.

### Checks (closed ID set)

Every check carries a stable `id`, a `severity` (`info`, `warning`,
`error`), a stable snake_case `code`, a `hint` and either a
`nextAction` command template (angle-bracket placeholders only, never
real values) or `null`. Hints and templates contain no caller values.

| ID | Severity | Code | When | `nextAction` template |
|----|----------|------|------|-----------------------|
| `api.selected` | info | `source_selected` | an API source won | null |
| `api.unconfigured` | error | `no_instance` | no API source present | `kofra login --api https://<your-instance>` |
| `api.empty_value` | error | `empty_value` | the winning flag/link/default source is set but empty, so resolution fails with `no_instance` exactly as the resolver does (no fall-through) | `Unset the empty source or pass --api https://<your-instance>.` |
| `api.invalid_value` | error | `invalid_api_url` | the winning value failed normalization | `Pass --api https://<your-instance>.` |
| `api.value_trimmed` | info | `input_trimmed` | normalization dropped `userinfo`, `path`, `query` or `fragment` (listed in `removed`) | `Use the bare origin https://<host>.` |
| `api.source_shadowed` | info | `source_shadowed` | a lower source was set but not consulted (named by kind plus detail; no validity claim) | null |
| `key.selected` | info | `source_selected` | a key source won | null |
| `key.absent` | error | `not_logged_in` | API resolved but no key selected | `kofra login --api <effective-origin>` |
| `key.kind_noted` | info | `key_kind` | selected key kind is `claim_token` or `other` | null |
| `credentials_file.malformed` | error | `malformed_credentials` | see States (`detail` set) | `kofra login --api https://<your-instance>` (rewrites the file) |
| `credentials_file.unreadable` | error | `unreadable_credentials` | see States (`detail` set) | `Check the permissions of <path>.` |
| `project_link.malformed` | error | `malformed_project_link` | see States (`detail` set) | `Delete or fix ./dropway.json.` |
| `project_link.unreadable` | error | `unreadable_project_link` | see States (`detail` set) | `Check the permissions of ./dropway.json.` |
| `project_link.foreign_instance` | warning | `foreign_project_link` | link `api` is valid but raw-unequal to the effective origin, so its mappings are ignored (comparison mirrors `publish`: raw string equality, `main.ts:300`, not normalized equality; a self-link with trimmable parts also mismatches) | `Publish once with --api <effective-origin> --new, or remove ./dropway.json.` |
| `project_link.mapping_missing` | info | `mapping_missing` | `[path]` given and no mapping applies (no entry, or the link is absent, malformed, unreadable or foreign) | null |
| `project_link.mapping_found` | info | `mapping_found` | `[path]` given and an entry exists | null |
| `env.legacy_shadowed` | info | `source_shadowed` | a `DROPWAY_*` twin was set but its `KOFRA_*` twin won | null |

Severity notes:

- The exit code derives only from the effective outcome (see below), so
  a corrupt credentials file is an `error` check even when flags shadow
  it: always worth fixing, never silently ignored. Agents that want
  strictness fail on any `error` check in JSON.
- `key.absent` is how anonymous-capable flows see the world too: key
  absence is configuration data, and callers that publish with
  `--anonymous` ignore exit 3 deliberately.

## Redaction (normative)

The output is built from allowlisted fields only; raw caller inputs are
never echoed. In particular:

- Never emit key material: no flag, env or saved key values, no
  fingerprints, no lengths. Key presence, source kind and the
  `dw_`/`dwc_` prefix-derived kind are the only key facts.
- Never emit file contents: neither file's bytes, in whole or part,
  appear in any field, hint or message.
- Origins are normalized with origin semantics (scheme plus host plus
  port; userinfo, path, query and fragment are dropped) and invalid
  inputs are described by code only. Only normalized credential-free
  origins and source kinds appear.
- Never emit token-shaped substrings anywhere in stdout or stderr.
  The sufficient pin is canary-substring absence: the future test
  plants synthetic secrets of every key kind (including `other`-shaped
  values with no fixed prefix, which no pattern can match) and asserts
  each planted substring is absent from every output byte. The
  existing credential-pattern list (`SECRET_PATTERNS` in
  `packages/cli/src/secrets.ts`, which already reports kind and
  location, never values) is only a necessary backstop sweep: the
  future test also asserts that no pattern matches any output byte,
  but a passing sweep alone never proves the absence of an
  `other`-shaped leak.
- Paths are emitted with the home directory collapsed to `~` (user
  profile on Windows), and only when the resolved path is under that
  home directory. When the config dir points outside the home
  directory, `configDir.path` is `null` in JSON and the human output
  names the selector only: outside-home paths can carry team, project
  or machine names that must not leak into shared diagnostics.
  Precedent commands print raw paths; this command is held to the
  safer form because its output is meant to be shared.
- Stored mapping keys are never enumerated: only the count and, with
  `[path]`, the single caller-provided lookup. Mapping keys can name
  private folders; the caller already knows the path they asked about.
- No headers, no copied environment values, no proposed secrets. Only
  the closed variable-name set above is named, never its values.
- Human text obeys the same rules: it must contain no value the JSON
  contract forbids.

Fixture rule for tests: fixtures are synthetic values generated for the
test. Plant at least one canary per key kind: `dw_test_…` and
`dwc_test_…` canaries that match the real prefixes, plus an
`other`-shaped secret with no fixed prefix (for example a random
alphanumeric string). Never use a real credential, and assert each
canary substring is absent from the output bytes.

## Offline and read-only (normative)

The implementation must satisfy all of these, and the future tests pin
each one with a sentinel:

- No `fetch`, no `XMLHttpRequest`, no `node:http/https/net/dns/tls`
  imports; no `Request` construction aimed at the network. The command
  must exit identically with the network namespace removed.
- No writes: no `writeFile`, `mkdir`, `chmod`, `rename`, `rm`,
  `appendFile` or `copyFile` on any path, including the config dir and
  the project link. Repair is explicitly out of scope: the command
  suggests `nextAction` commands, never runs them.
- No token validation, login, rotation, provider calls or telemetry.
  Key "validity" is presence plus prefix kind only.
- No `prompt`, no `readStdin`, no `stdin` reads at all; the only inputs
  are argv, `process.env`, the working directory and the two config
  files (plus `stat` on their containing directories as needed to
  classify states).
- Filesystem reads are limited to the config file, the project link and
  the minimum directory stats to classify them. Symlinks are followed
  exactly as the resolver follows them today (no new traversal logic);
  the security questions below ask whether that needs narrowing.

## Exit semantics (deterministic)

| Exit | `status` | Meaning |
|------|----------|---------|
| 0 | `ready` | an API origin resolved and a key was selected |
| 3 | `needs_key` | an API origin resolved, no key selected |
| 2 | `unconfigured` | no API origin resolved |
| 1 | — | unexpected internal failure only; never a diagnosed state |

In the data envelope `ok` is `true` exactly when `exitCode` is `0`:
`needs_key` (exit 3) and `unconfigured` (exit 2) are diagnosed outcomes
with `ok: false`, so a consumer that tests only `ok` never treats a
missing API or key as ready. Diagnosed outcomes still use the data
envelope; only `ok` follows the exit code.

Argument-parsing failures also exit 2, but they keep the standard
error envelope (`{ok: false, exitCode, error}`), which carries no
`status` field. Only diagnosed outcomes carry `status`.

Exit 1 uses the standard error envelope with fixed, caller-free
content — no `status` field, no caller-derived fields:

```jsonc
{ "ok": false, "exitCode": 1,
  "error": { "code": "unexpected_error",
             "message": "Unexpected internal failure.",
             "retryable": false } }
```

- `code` is exactly `unexpected_error` and `message` exactly
  `Unexpected internal failure.` — never the thrown error's message,
  which could carry paths or input fragments. No `hint`, `status`,
  `details` or `requestId` (there is no server contact to identify).
- Human stderr for exit 1 is the same fixed one-liner.
- Redaction holds vacuously: the exit-1 envelope contains no
  caller-derived fields at all. A future test asserts byte-exact
  equality with the shape above on a forced internal failure.

Exits 4–8 are unreachable: there is no server contact. The `exitCode`
is echoed in JSON so piped output stays interpretable.

## Human output (illustrative)

```
Instance: https://dropway.example.workers.dev (from KOFRA_API)
Key: saved api_key
Config: ~/.config/dropway/credentials.json ok; ./dropway.json ok (1 mapping)
```

One line per warning/error check follows (`code`: hint). Exact wording
is illustrative; the redaction rules and the JSON contract are
normative.

## Discovery

- `kofra help` gains the one line quoted under Command; `kofra help
  explain-config` renders the usage plus the global footer, as usual.
- The CLI guide gains the one table row quoted under Command.
- This document stays the only full description. The generated agent
  skill is not hand-edited for this; if skill generation picks up new
  commands automatically, that output must link here, not copy the
  schema.
- The check an agent runs: `kofra explain-config --json` and branch on
  `exitCode` / `status` / `checks[].severity`. Exit 0 asserts presence,
  not authorization: an API origin resolved and a key-shaped value was
  selected, but the key may be invalid, unscoped or a claim token that
  member-only commands refuse. Anything else names the configuration
  blocker and the fix; agents must still handle 401/403 from the real
  command.

## Future acceptance matrix

For the paired Test Author. Each row is a hermetic fixture (synthetic
config dir via `KOFRA_CONFIG_DIR`, synthetic cwd, controlled env):

| # | Case | Expect |
|---|------|--------|
| 1 | `--api` set plus env, link and default | exit per key state; `api.selected` source `flag`; one `api.source_shadowed` per lower set source |
| 2 | `KOFRA_API` plus `KOFRA_URL` | `KOFRA_API` wins; `KOFRA_URL` shadowed |
| 3 | only `DROPWAY_API` set; repeat with only `DROPWAY_URL` | literal `source.detail` is `DROPWAY_API` / `DROPWAY_URL`, respectively, with `viaLegacyName: true`; never renamed to `KOFRA_*` in output <!-- rebrand:keep --> |
| 4 | `KOFRA_API` plus `DROPWAY_API` | `source.detail: KOFRA_API`, `viaLegacyName: false`; `env.legacy_shadowed` names `DROPWAY_API` without a validity claim <!-- rebrand:keep --> |
| 5 | empty-string env values | treated as absent |
| 6 | link `api` plus saved default | link wins; default shadowed |
| 7 | valid link `api` differing from effective origin | `project_link.foreign_instance` warning; mappings ignored |
| 8 | nothing set anywhere | exit 2, `status: unconfigured`, `ok: false`, `api.unconfigured` error; absent credentials summary is `defaultPresent: false`, `instanceCount: 0`, `hasEntryForEffectiveApi: null`; unknown flags also exit 2 but keep the error envelope with no `status` |
| 9 | winning `--api` invalid, valid env present | exit 2 `invalid_api_url` on the flag; env shadowed, not consulted; `hasEntryForEffectiveApi: null` |
| 10 | `credentials.json` with invalid JSON | `credentials_file.malformed` (`invalid_json`); all three credential summary fields are `null`, including with a resolved API; key falls through; exit follows the effective outcome |
| 11 | `credentials.json` valid JSON, wrong shape | `malformed` with `invalid_shape`; all three credential summary fields are `null`, including with a resolved API (resolver behavior unchanged) |
| 12 | credentials path is a directory; repeat with permission and other I/O failures | `unreadable` with `not_a_file` / `permission` / `io_error`; all three credential summary fields are `null`, including with a resolved API |
| 13 | `dropway.json` malformed / unreadable | matching `project_link.*` error checks; `apiMatchesEffective` and `sitesEntryCount` are `null`; with `[path]`, `mapping` is `{key, slug: null}` plus `mapping_missing`, without it `null` |
| 14 | key precedence flag over env over saved; kinds `dw_` / `dwc_` / other | `key.selected` with the right source and kind; `key.kind_noted` for non-`dw_` |
| 15 | API resolved, no key anywhere, credentials file absent | exit 3, `status: needs_key`, `ok: false`, `key.absent` error; `defaultPresent: false`, `instanceCount: 0`, `hasEntryForEffectiveApi: false` |
| 16 | canaries of every key kind planted (`dw_test_…`, `dwc_test_…`, prefix-less `other` secret) | no `SECRET_PATTERNS` match in any output byte; every canary substring absent |
| 17 | `--api` with userinfo, path, query, fragment | origin emitted; `api.value_trimmed` lists each removed part; no input echo |
| 18 | hostile schemes (`javascript:`, `ftp:`, `file:`), control characters | `invalid`, exit 2 |
| 19 | 8 KB URL, unicode/IDN host, padded whitespace | bounded output (≤1024 chars per string, truncation marker); normalized origin |
| 20 | `[path]` with and without a stored entry | `mapping_found` with slug / `mapping_missing`; planted foreign keys never appear |
| 21 | no `[path]`; repeat with absent link | `mapping` is null; `sitesEntryCount` only (`0` for an absent link) |
| 22 | zero-network sentinel: `fetch` sabotaged to throw, DNS removed | identical exit and stdout |
| 23 | zero-write sentinel: fixture tree hashed before and after | identical hashes and mtimes |
| 24 | determinism: two consecutive runs | byte-identical stdout; no `savedAt`, no timestamps |
| 25 | no-prompt: stdin closed, stdout piped | exits promptly; stderr carries no prompt |
| 26 | JSON conformance | parses; `schema` exact; `checks` within bounds and ID set; unknown IDs ignored by the consumer test |
| 27 | empty `--api ""` with valid env present; valid credentials with a string default and two instances | exit 2 `no_instance` on the flag plus `api.empty_value`; env shadowed, not consulted; `defaultPresent: true`, `instanceCount: 2`, `hasEntryForEffectiveApi: null`; repeat with absent credentials (`false`, `0`, `null`) and malformed/unreadable credentials (all three `null`) |
| 28 | empty `--key ""` with valid env key present | flag falls through (truthiness); env key selected |
| 29 | link `api` with trimmable suffix normalizing to the effective origin | `apiMatchesEffective: false`, mappings ignored, `foreign_instance` warning (mirrors `publish` string equality) |
| 30 | only `DROPWAY_CONFIG_DIR` set | `configDir.selector` is `DROPWAY_CONFIG_DIR` with `viaLegacyName: true` <!-- rebrand:keep --> |
| 31 | forced internal failure with `--json` | exit 1, byte-exact fixed error envelope, no `status`, no caller bytes |
| 32 | `KOFRA_CONFIG_DIR` outside the home directory | `configDir.path` is `null` in JSON; human output names the selector only; no path component in either output |
| 33 | API resolved, only `DROPWAY_API_KEY` set; repeat with both key twins set | legacy-only: `source.detail: DROPWAY_API_KEY`, `viaLegacyName: true`; both: `source.detail: KOFRA_API_KEY`, `viaLegacyName: false`, `env.legacy_shadowed` names `DROPWAY_API_KEY`; no key value emitted <!-- rebrand:keep --> |
| 34 | valid credentials `{}`; then empty string default, two instances, one with a truthy key | first: `defaultPresent: false`, `instanceCount: 0`; second: `defaultPresent: true`, `instanceCount: 2`; each has `hasEntryForEffectiveApi: null` without a resolved API; with explicit valid `--api`, lookup is `true` only for the truthy-key entry, otherwise `false` |
| 35 | credentials with a valid string default, a matching entry containing a synthetic key, and an unrelated `null` instance entry | file is `malformed` / `invalid_shape` with all three summary fields `null`, yet effective default and saved key still win, exit 0 `ready`; diagnostic classification must not tighten the resolver |
| 36 | `[path]` lookup across link states: absent link; valid link matching the effective origin with and without an entry; valid link with a different `api`; valid link with no `api` | absent: `apiMatchesEffective: false`, `sitesEntryCount: 0`, `{key, slug: null}`; matching with entry: `slug` set, `mapping_found`; matching without entry: `slug: null`, `mapping_missing`; different or missing `api`: `apiMatchesEffective: false`, `slug: null` even when an entry exists, `mapping_missing`; no effective origin: `apiMatchesEffective: false` |

## Security-review questions

Explicit questions for the security disposition that must precede any
implementation:

1. Is `~`-collapsed path emission acceptable in a shareable diagnostic,
   or must paths be omitted entirely (selector only)? Out-of-home
   paths are already `null` by the rule above; the question is only
   about `~`-collapsed in-home paths.
2. Is the `removed: ["userinfo"]` presence signal acceptable? It
   confirms the caller's input contained credential-bearing URL parts
   without emitting them, and nudges rotation of shell history and env.
3. Is prefix-derived key kind (`api_key` / `claim_token` / `other`)
   acceptable output, given real keys stay in memory only?
4. The diagnostic loads the credentials file into memory (as the
   resolver already does) but serializes none of it. Is that handling
   acceptable, or should the key-source check avoid parsing key values
   at all (for example, presence by shape without retaining values)?
5. Symlink following matches the resolver exactly. Should the
   diagnostic additionally refuse (or flag) symlinked config files?
6. Exit 3 on missing key also fires for operators who only publish
   anonymously. Is the documented "anonymous callers ignore exit 3"
   rule acceptable, or should anonymous intent be an explicit input?
7. Hint and `nextAction` templates name commands (`kofra login …`).
   Confirm no template may interpolate caller values, now or in future
   edits, and whether that rule needs a test pin.

## Compatibility notes

- URL normalization reuses origin semantics: the existing
  `normaliseApi` already returns `url.origin`, which drops userinfo,
  path, query and fragment. The diagnostic additionally reports *that*
  trimming happened (`api.value_trimmed`); the resolver itself is
  untouched.
- State classification for files is new logic beside the resolver, not
  a refactor of it. `readCredentials` / `readLink` keep their reads,
  partial coercions and collapse-to-absent cases so every existing caller
  is unaffected; `invalid_shape` is not an effective-value veto.
- Consuming a credential file with unknown extra fields is `valid`:
  unknown fields are ignored, matching the resolver's coercion.
