# kofra CLI

Publish a folder, a file or a `.zip` to a live URL on any [Kofra](https://github.com/TogetherWeOwn/dropway)
instance. Built for AI agents and scripts: one command, one JSON object on stdout, stable exit codes,
and only the bytes the instance does not already have are uploaded.

```sh
npx kofra login --api https://dropway.example.workers.dev   # paste an API key once
npx kofra publish ./dist                                     # prints the live URL
npx kofra publish ./dist --json                              # one JSON object for agents
```

Zero runtime dependencies. Node.js 20 or newer.

> The npm package is prepared but not published yet. Until it is, run the CLI from a clone of the
> repository: `npm install`, then `node packages/cli/bin/dropway.mjs <command>` (Node 22.18+ runs the
> TypeScript source directly; on older Node run `npm run build -w kofra` first).

## Commands

| Command | What it does |
|---|---|
| `publish <path>` | Publish a folder, a single file or a `.zip`. Creates a site, or updates one with `--site <name>` |
| `list` | Your sites (`--all` for every page) |
| `site <name>` | One site: URL, live version, settings |
| `files <name>` | Files of the live version (or `--version v3`) with their URLs |
| `versions <name>` | Every version, newest first; the live one is marked |
| `restore <name> [v3]` | Make an older version live again. Without a version: the one before the live version. Alias `rollback` |
| `delete <name> --yes` | Delete a site. `--version v3` deletes one non-live version instead |
| `whoami` | The instance, your identity and your key's scopes |
| `login` / `logout` | Save or forget an API key for an instance |
| `setup --email <you>` | First run of a new instance: create the owner and save their key |
| `api [METHOD] <path>` | Call any REST endpoint, e.g. `kofra api PATCH /sites/my-site --data '{"spa":true}'` |

`kofra help <command>` shows every option.

## Publishing

```sh
kofra publish ./dist                         # new site with a generated name
kofra publish ./dist --site team-report      # update team-report, or create it with that name
kofra publish report.md                      # one file: served at the site root
kofra publish site.zip                       # the instance unpacks it (one request, 25 MB by default)
kofra publish ./dist --wait --json           # return only once the URL serves the new version
kofra publish ./dist --dry-run               # list what would be uploaded; contacts nothing
```

How it works: the CLI hashes every file (SHA-256), sends the list, uploads only the files the
instance is missing (6 in parallel, retried on rate limits, server errors and network errors), then
makes the new version live in one atomic step. Publishing identical files again reports
`"unchanged": true` and creates no version.

After the first publish with a key, `./dropway.json` records which site each published path updates,
so running the same command again updates that site. It holds no secrets and is safe to commit.
Use `--new` for a fresh site, `--no-save` to skip writing it.

Never published: `.git`, `node_modules`, `.env*`, `.dev.vars*`, `.npmrc`, `*.pem`, `*.key`, `*.p12`,
SSH keys, `.dropway/`, `.DS_Store`, and anything matched by `<path>/.dropwayignore` (gitignore-style;
`!pattern` re-includes). Text files (up to 4 MB) that contain credentials (private keys, cloud and API
tokens, Kofra keys) stop the publish with exit code 2 unless you pass `--allow-secrets`.

`--dry-run --json` explains every skipped path in an `omissions` array (`{path, reason}`, sorted by
relative path; pruned directories appear once): `ignored` (built-in or `.dropwayignore` rules),
`excluded` (explicitly excluded, e.g. the `./dropway.json` project link), `symlink_directory`
(directory links are never followed), `broken_symlink`, and `special_file` (FIFOs, sockets and
devices are never published). An offline agent check, needing no URL
or key:

```sh
kofra publish ./dist --dry-run --json | jq '{files: [.files[].path], omissions}'
```

Nothing publishable is refused with `no_files` (exit 2) before anything is contacted. This is a
local inventory of what the CLI would send: it does not validate server policy, quotas or limits,
and it is not the server's dry run. ZIP dry-runs stay an opaque archive summary (`{zip: true,
bytes}`); the CLI never unpacks the archive locally.

Anonymous publishing (`--anonymous`) works only on instances that turned it on. The site expires and
the output includes a `claimToken`: keep it to update the site (`--key <claimToken> --site <name>`) or
to claim it into an account.

## Encrypted publishing

```sh
kofra publish ./private-site --encrypt --json --no-save
kofra publish ./private-site --encrypt --dry-run --json
```

With `--encrypt`, source files are encrypted locally with **AES-256-GCM** into a single
 authenticated container before upload. The decryption key is placed only in the share URL
**fragment**: anyone with the full URL can decrypt, and a lost key cannot be recovered.
This protects stored contents from passive server or storage access, **not** from a malicious
host replacing the first-party loader or from a compromised recipient, device, or browser
extension. The server never receives the key through this protocol; it still supplies the code
that reads it. Do not use a host you do not trust. Treat the full link as a secret, including
terminal output, browser history, clipboard and link-sharing services.

Filenames and plaintext hashes are inside the encrypted container; aggregate size, timestamps,
site slug, explicitly supplied title/message and other site metadata remain visible. Avoid
sensitive values in those settings. The existing heuristic secret scan still applies to small text
files; it is not a guarantee that input contains no credentials. Old plaintext versions
are **not** encrypted retroactively: use `--new` for a site previously published in plaintext.
Each encrypted republish creates a fresh key and nonce even for identical input, so previous
live links cannot decrypt the updated bundle (restoring an old version requires its original
link). There is no deduplication across encrypted publishes. Save each link securely; the CLI
does not persist encryption keys in `dropway.json` or credentials.

Requires a current instance with the first-party decryptor, HTTPS (or localhost), WebCrypto and
JavaScript. Up to **16 MiB** of source files and **10,000 files** are loaded/decrypted entirely
in memory. The complete encoded container must also fit **24 MiB**, including filenames,
base64, JSON and encryption framing; long paths can exceed that limit even below 16 MiB raw.
ZIP uploads are refused before any upload: extract locally and publish the folder. SPA routing
is not supported. The returned `url` opens the app-origin loader, which decrypts before sending
content to an opaque sandbox without app cookies, storage or service workers. Use that complete
URL, not the ordinary site URL returned by `site` or the dashboard (which expose ciphertext only).
Password-protected sites are not supported by this loader: it fetches ciphertext without cookies
or other credentials, so unlocking the ordinary site does not unlock the loader.

`--encrypt --dry-run` lists original filenames, sizes and plaintext hashes locally and contacts
nothing. It does not encrypt, generate a share key or validate encrypted capacity. Treat that
local inventory as sensitive; a successful dry run does not guarantee encrypted input will fit.

The initial viewer supports entry HTML (`index.html`/`index.htm`, otherwise the first file),
relative classic scripts, styles, images, and read-only `fetch()` of original bundled bytes.
Single text/images can be viewed and other files downloaded. **Trust all bundled scripts and
executable content before opening a site.** Scripts can read every decrypted file. The sandbox
and resource CSP do not guarantee network isolation: a malicious script can navigate its frame
to a same-app URL and send decrypted data to the server in that request. Encryption protects
stored contents, not data from scripts that run after decryption.
XHR, modules/imports, dynamically constructed resource URLs, nested frames, forms and multipage
navigation are not supported. HTML links to bundled files download rather than navigate.
CSS `url()` references are resolved locally; use simple relative asset paths. HTML data-URL
assets and CSS `@import` are not supported. This is an encrypted static viewer, not transparent
hosting for arbitrary applications.

Stable local errors: `encrypted_zip_unsupported` / `encrypted_spa_unsupported` (exit 2),
`encrypted_input_too_large`, `encrypted_too_many_files`, `encrypted_container_too_large` and
`encrypted_invalid_path` (exit 6). These fail before creating a site or uploading data. Paths
must be unique, relative, slash-separated, with no empty, dot or dotdot segments, backslashes
or C0 control characters. Valid paths are preserved, not normalized.

## Output for agents

With `--json`, stdout carries exactly one JSON object; progress and notes go to stderr.

```json
{
  "ok": true,
  "url": "https://dropway.example.workers.dev/s/bright-otter-x7k2/",
  "slug": "bright-otter-x7k2",
  "created": false,
  "unchanged": false,
  "version": { "id": "ver_...", "number": 3, "live": true, "fileCount": 12, "totalBytes": 48211 },
  "files": 12,
  "uploaded": 2,
  "reused": 10,
  "bytesUploaded": 5120,
  "warnings": [],
  "api": "https://dropway.example.workers.dev"
}
```

Errors (also on stdout with `--json`):

```json
{
  "ok": false,
  "exitCode": 5,
  "error": {
    "code": "version_conflict",
    "message": "The live version changed since baseVersionId (someone else published).",
    "hint": "Fetch the site (GET /api/v1/sites/:slug), reconcile with its files, and deploy again with the new currentVersionId as baseVersionId.",
    "status": 409,
    "retryable": false
  }
}
```

### Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Success | |
| 1 | Unexpected error | Report it with the output |
| 2 | Usage error, refused without `--yes`, or files that look like secrets | Fix the command or the files |
| 3 | No key, invalid key, or missing scope | `kofra login`, or a key with the right scope |
| 4 | Not found (site, version, file) | Check the name with `kofra list` |
| 5 | Conflict: the live version moved (`--base`), or the name is taken | Re-read, then publish again |
| 6 | Invalid or over a limit (file too large, too many files) | Change the content |
| 7 | Retryable: rate limited, server error, network error | Retry later |
| 8 | `--wait` timed out before the URL served the new version | The publish succeeded; retry the check |

## Configuration

| Setting | Flag | Environment | Saved |
|---|---|---|---|
| Instance URL | `--api <url>` | `KOFRA_API` (or `KOFRA_URL`) | `./dropway.json`, then your last `login` |
| API key | `--key <key>` | `KOFRA_API_KEY` | `<config dir>/credentials.json` (mode 0600, one key per instance) |
| Bootstrap key (setup only) | | `KOFRA_BOOTSTRAP_KEY` | never |
| Attribution shown per version | | `KOFRA_CLIENT` (e.g. `my-agent/1.2`) | |

Config dir: `$KOFRA_CONFIG_DIR`, else `$XDG_CONFIG_HOME/dropway`, else `~/.config/dropway`
(`%APPDATA%\dropway` on Windows). `KOFRA_API_KEY` applies to whichever instance you target, so set
it per instance in CI. The CLI never prompts when stdin is not a terminal: pipe keys on stdin
(`echo "$KEY" | kofra login --api <url>`), and pass `--yes` for deletions.

## Development

```sh
npm install                 # at the repository root
npm run test:cli            # unit tests + end-to-end tests against a local Worker
npm run build -w kofra    # bundle to packages/cli/dist/dropway.mjs
```

Source layout: `src/client.ts` (HTTP + errors), `src/publish.ts` (the upload protocol; runtime-neutral and
also tested inside the Workers runtime), `src/files.ts` (walk, ignore, hash, secret scan), `src/main.ts`
(commands), `src/config.ts` (credentials and `dropway.json`).

## License

MIT
