# v0.1.0 deployment verification checklist

Evidence record for the v0.1.0 verification deploy. Run this script verbatim against the
release candidate: steps 2, 5–6, 9–10 and Part B assert the shipped first-run and
secret-hardening behaviour, so run it on the exact build being tagged, not an older one.

Run Part A on a **fresh Cloudflare account** (or a dedicated test account — never an account
that runs a hosted Kofra). Record for every step: pass/fail, elapsed time, and the exact
output on failure. Total budget for Part A steps 1–8: **under 15 minutes** excluding Cloudflare
account creation. A stranger can follow most steps from the README + `docs/SELF_HOST.md`; steps 7–10
also need `packages/cli/README.md` and steps 6/9/10/12 need `docs/errors.md` — record any *further*
doc you had to open.

**Conventions.** `<worker>` = the deployed Worker host, e.g. `dropway.<account-subdomain>.workers.dev`.
Keep a scratch file with the two secrets from step 2 and the owner key from step 5; never paste them
into the evidence record. The script assumes a POSIX shell; on Windows the CLI stores credentials
under `%APPDATA%\dropway` and the mode-0600 check in step 5 does not apply.

## Run header

- Instance URL:
- Git SHA (tag candidate):
- Date:
- Run by:
- CLI form used (`npx kofra` post-tag, or from-source `node packages/cli/bin/dropway.mjs` after `npm install`) and Node version:

## Prerequisites

- [ ] **P1** — Cloudflare account exists; **R2 is enabled** once in the dashboard (R2 section). Expected: R2 shows an empty bucket list, no "enable" prompt. If R2 is not enabled, the deploy cannot create the bucket — this is the one manual prerequisite the button cannot do.
  - Result:
  - Evidence:
- [ ] **P2** — GitHub (or GitLab) account available for the button to copy the repo into. Expected: —.
  - Result:
  - Evidence:
- [ ] **P3** — Local machine: POSIX shell, `curl`, `openssl`, Node.js (version per path). Expected: the published CLI (`npx kofra`) needs **Node 20+**; **Node 22+ is the recommended single prerequisite** and is what the self-host guide requires for the command-line deploy path. **Until v0.1.0 is on npm**, `npx kofra` below means: clone the repo, `npm install`, then `node packages/cli/bin/dropway.mjs` — that from-source path needs **Node 22.18+**, or on older Node run `npm run build -w kofra` first. Run the script with `npx kofra` only after the tag publishes, and record which form (and Node version) was used.
  - Result:
  - Evidence:

## Part A — core first run (Deploy button → working site)

- [ ] **Step 1 — Open the Deploy button.** Action: from the README, click **Deploy to Cloudflare** (`https://deploy.workers.cloudflare.com/?url=https://github.com/TogetherWeOwn/kofra`) and sign in to Cloudflare and GitHub when asked. Expected: Cloudflare offers to copy the repository into your GitHub account and connect it to Workers Builds; the setup page lists a D1 database (`dropway`), an R2 bucket (`dropway-files`) and a KV namespace to create. Fail signal: the page asks you to pick a directory, or lists no bindings → stop, record a screenshot; the button config is broken.
  - Result:
  - Evidence:
- [ ] **Step 2 — Set the two secrets.** Action: generate two different values (`openssl rand -hex 32`, twice — 64 characters each) and enter them as `ADMIN_BOOTSTRAP_KEY` and `SIGNING_SECRET` on the setup page. Accept the default resource names. Expected: both fields accept input and are marked as secrets. Both secrets must be **at least 32 characters**: an instance started with a shorter `SIGNING_SECRET` or `ADMIN_BOOTSTRAP_KEY` refuses it with an operator-facing error naming the minimum — that refusal is asserted as a negative test in Part B8, not on this instance. Fail signal: only one secret is requested → record it; `SIGNING_SECRET` must be asked for.
  - Result:
  - Evidence:
- [ ] **Step 3 — Deploy.** Action: confirm the deploy and wait for Workers Builds to finish (`npm run deploy` applies the D1 migrations, then deploys the Worker). Expected: build succeeds; you get a `https://<worker>` URL. In the Cloudflare dashboard: Worker `dropway` exists, D1 database `dropway` exists with tables applied, R2 bucket `dropway-files` exists, one KV namespace exists. Fail signal: migration or provisioning errors in the build log → copy the first error verbatim into the evidence record.
  - Result:
  - Evidence:
- [ ] **Step 4 — Instance answers and says it is not set up yet.**
  ```sh
  curl -s -w '\n%{http_code}\n' https://<worker>/health
  curl -s https://<worker>/openapi.json | head -c 200
  ```
  Expected: `/health` returns HTTP 200 with a body containing `"ok":true`; `/openapi.json` returns an OpenAPI 3.1 document. Opening `https://<worker>/` in a browser shows "This instance is not set up yet" with a link to set it up in the browser (`/login#setup`) and the curl alternative. Fail signal: 5xx from `/health`, or the home page shows a dashboard/login with no setup path.
  - Result:
  - Evidence:
- [ ] **Step 5 — Create the owner (CLI path), including the wrong-secret check.** First prove a mistyped bootstrap secret is reported as a secret problem, not a format problem:
  ```sh
  KOFRA_BOOTSTRAP_KEY=definitely-wrong npx kofra setup --api https://<worker> --email you@example.com
  ```
  Expected: non-zero exit; the error code is `bootstrap_key_required` and the message says the bootstrap secret doesn't match this instance ("That bootstrap secret doesn't match this instance."). It must **never** say `invalid_api_key` or "Unrecognised token format". No owner is created. Then the real setup:
  ```sh
  KOFRA_BOOTSTRAP_KEY=<bootstrap key from step 2> npx kofra setup --api https://<worker> --email you@example.com
  npx kofra whoami
  ```
  Expected: setup prints the owner key **once** (starts `dw_`) and saves it to the CLI config dir's `credentials.json` (default `~/.config/dropway/credentials.json`, mode 0600 — check with `ls -l`; `$KOFRA_CONFIG_DIR` / `$XDG_CONFIG_HOME/dropway` / `%APPDATA%\dropway` per `packages/cli/README.md`). `whoami` exits 0 and shows the instance URL, your owner identity and full scopes. Fail signal: setup succeeds but `whoami` fails → credential save/keying bug; record both outputs (redact the key). Optional browser check (only possible **before** step 7): sign in at `https://<worker>/` with the owner key — the empty dashboard shows **one copyable publish command pre-filled with this instance's origin** (`npx kofra publish ./my-folder --api https://<worker>`) and no site-search box.
  - Result:
  - Evidence:
- [ ] **Step 6 — Setup works exactly once; curl path agrees.**
  ```sh
  curl -s -w '\n%{http_code}\n' -X POST https://<worker>/api/v1/setup \
    -H "Authorization: Bearer <bootstrap key>" -H "Content-Type: application/json" \
    -d '{"email":"second@example.com"}'
  ```
  Expected: HTTP **409** with error `code` **`already_set_up`** and a `hint` in the JSON body — no second owner is created. Optional browser variant (fresh instance only): `/login#setup` with bootstrap secret + email shows the owner key once and lands on `/connect`.
  - Result:
  - Evidence:
- [ ] **Step 7 — First publish.**
  ```sh
  mkdir -p /tmp/kofra-hello && printf '<!doctype html><title>Hello</title><h1>Hello from Kofra</h1>\n' > /tmp/kofra-hello/index.html
  printf '# Notes\n\nHello **markdown**.\n' > /tmp/kofra-hello/notes.md
  npx kofra publish /tmp/kofra-hello --site hello --wait --json
  ```
  Expected: exit 0; one JSON object on stdout with `"ok":true` and a `url` of the form `https://<worker>/s/hello/`. `--wait` returns only once that URL serves the new version. Then verify serving:
  ```sh
  curl -s https://<worker>/s/hello/                              # the HTML page
  curl -s -H "Accept: text/html" "https://<worker>/s/hello/notes.md"   # rendered Markdown
  curl -s "https://<worker>/s/hello/notes.md?raw=1" | diff - /tmp/kofra-hello/notes.md   # stored bytes, exact
  ```
  Expected: `/s/hello/` serves "Hello from Kofra"; the Markdown file renders as a formatted HTML page to a browser navigation (contains the notes heading and bold "markdown", not the literal `#`/`**` syntax) and `?raw=1` returns the stored bytes byte-for-byte (`diff` silent, exit 0). A `dropway.json` link file now exists in the directory the publish ran from (no secrets in it — open it and confirm; it maps the path to the site and instance).
  - Result:
  - Evidence:
- [ ] **Step 8 — Republish, versions, restore.**
  ```sh
  printf '<!doctype html><title>Hello v2</title><h1>Second version</h1>\n' > /tmp/kofra-hello/index.html
  npx kofra publish /tmp/kofra-hello --site hello --wait --json   # version 2 goes live
  npx kofra publish /tmp/kofra-hello --site hello --json          # identical: reports unchanged, no new version
  npx kofra versions hello                                        # v2 live, v1 listed
  npx kofra restore hello v1                                      # v1 live again
  curl -s https://<worker>/s/hello/                               # "Hello from Kofra" again
  ```
  Expected: each command exits 0; the unchanged republish creates **no** v3 (`versions` still lists exactly two versions); after restore, the live URL serves v1 content. The version-preview address for v2 (`/s/hello--v2/` path form) is private: `curl -s -o /dev/null -w '%{http_code}' https://<worker>/s/hello--v2/` returns **404** with no credentials; with owner credentials or the signed preview link from the publish result it returns 200 and serves "Second version".
  - Result:
  - Evidence:
- [ ] **Step 9 — Password gate.**
  ```sh
  printf 'correct horse battery staple\n' | npx kofra access hello --mode password --yes
  curl -s https://<worker>/s/hello/    # password form, not the page
  ```
  Expected: unauthenticated visits get the password form — the response contains "This site is password protected" and does **not** contain "Hello from Kofra". In a browser: a wrong password re-renders the form with "That password is not right."; the correct password unlocks the site and the content then serves on reload (the unlock cookie now carries a server-side expiry of at most 7 days; behaviour to the visitor is unchanged). This step also proves the signing path works end to end: if setting the password or unlocking answers `503 signing_secret_missing` on this instance, a secret from step 2 never reached the Worker — stop and record it. (On an instance with **no** signing secret configured at all, setting a password is refused at write time with that same 503 rather than failing later for visitors.) Cleanup: `npx kofra access hello --mode public --yes`, then `curl -s https://<worker>/s/hello/` serves "Hello from Kofra" again with no form.
  - Result:
  - Evidence:
- [ ] **Step 10 — Dashboard and scoped key.** Action: open `https://<worker>/`, sign in with the owner API key. Expected: sites list shows `hello`; the site page shows versions v1/v2 with restore, the file list (opening a file uses the `/v/hello/` browser and never renders the file on the app origin), and drag-and-drop publish accepts a small folder and creates a new version. Keys, Members and Settings pages load. Scoped-key recipe (there is no first-class `keys create` in 0.1.0; the generic command is the documented path):
  ```sh
  npx kofra api POST /keys --data '{"name":"smoke-readonly","scopes":["sites:read"]}'   # key shown once — copy it
  KOFRA_API_KEY=<scoped key> npx kofra publish /tmp/kofra-hello --site hello --json       # must be refused
  ```
  Expected: key creation succeeds and shows the new `dw_` key once. The publish attempt exits non-zero and prints exactly one JSON object with `"ok":false` and error code **`insufficient_scope`** (HTTP 403) — machine-readable because `--json` was passed. The same key can still read (`npx kofra list` with it succeeds). Fail signal: any dashboard action that only works after a manual API call, user content rendered on the app origin, or the scoped key succeeding at a write.
  - Result:
  - Evidence:
- [ ] **Step 11 — Agent surfaces smoke (REST + MCP + discovery).**
  ```sh
  export KOFRA_API=https://<worker> KOFRA_API_KEY=<owner key>
  curl -s "$KOFRA_API/api/v1/publish?slug=curl-hello" -H "Authorization: Bearer $KOFRA_API_KEY" -F "index.html=@/tmp/kofra-hello/index.html"
  curl -s "$KOFRA_API/llms.txt" | head -20
  curl -s "$KOFRA_API/api/v1/me" -H "Authorization: Bearer $KOFRA_API_KEY"
  claude mcp add --transport http kofra "$KOFRA_API/mcp" --header "Authorization: Bearer $KOFRA_API_KEY"   # or any MCP client
  ```
  Expected: the curl publish returns a live URL under `/s/curl-hello/` and `curl -s https://<worker>/s/curl-hello/` serves the fixture content; `/llms.txt` describes this instance (its own URLs, not placeholders); `/api/v1/me` returns identity, scopes, capabilities, limits and usage. In the MCP client: `whoami` answers, `publish_site` publishes one inline file to a new site, `list_versions` shows it, and a deliberately bad call (e.g. publish with no files) returns an error carrying a stable `code` and `hint`, not a stack trace.
  - Result:
  - Evidence:
- [ ] **Step 12 — Defaults are safe.**
  ```sh
  curl -s -w '\n%{http_code}\n' -X POST "$KOFRA_API/api/v1/publish" -F "index.html=@/tmp/kofra-hello/index.html"   # no key
  ```
  Expected: HTTP **401** with error code **`anonymous_publish_disabled`** — anonymous publishing is **off by default** (`ANONYMOUS_PUBLISH=false`). (Do not turn it on for Part A.)
  - Result:
  - Evidence:

**Part A pass bar:** steps 1–12 pass with no undocumented manual step; every failure becomes a filed follow-up with the verbatim output. Passing Part A is what moves the "deployment verification pending" SPEC rows (PUB-03, PUB-04, ID-05) to Done.

## Part B — extended verification (same instance, after Part A)

Extended release verification; a first-time self-hoster does not need these on day one.

- [ ] **B1 — Upload links (dwu_ tokens).** How: JSON-publish a file by `sha256`+`size` only, then `PUT` the bytes to the returned upload URL with the returned curl line, then finalize. Expected: publish completes; the token cannot read files or finalize a *different* version (403).
  - Result:
  - Evidence:
- [ ] **B2 — Resumable multipart.** How: CLI-publish a generated file > 95 MiB (e.g. `dd if=/dev/urandom bs=1M count=120`). Expected: round-trips with matching SHA-256 (compare `?raw=1` download); interrupted retry resumes from acknowledged parts. This verifies PUB-13/PUB-14.
  - Result:
  - Evidence:
- [ ] **B3 — File deliveries (transfers), incl. dead-delivery pages.** How: requires an isolated sites origin: first do `docs/SELF_HOST.md` option B (second `-sites` Worker) or C (subdomain mode). Then create a transfer with password + 1-hour expiry via `kofra api` / MCP `create_transfer`. Expected: on the default shared-origin setup, creation is refused with `409 transfer_origin_required` (expected behaviour, not a failure). With a sites origin, walk the full lifecycle **in a browser** (or with `Accept: text/html`): locked → password form; wrong password → form re-renders with an error; right password → file list and the file downloads as an attachment. Then the terminal states: after **revoke** or **expiry** the page *and* the direct file URL return **410** with the system page "This delivery is no longer available"; after **takedown**, **451** "This delivery is unavailable"; a **mangled link** returns **404** "We couldn't find that delivery"; submitting the unlock form after revocation renders the page too. None of these browser responses is raw JSON, shows an error code, or uses the word "transfer". The same URLs *without* `text/html` still return the JSON errors unchanged (`transfer_gone` 410, `transfer_unavailable` 451, `transfer_not_found` 404). This verifies XFR-01…04.
  - Result:
  - Evidence:
- [ ] **B4 — Subdomain mode (optional, needs a domain).** How: follow `docs/SELF_HOST.md` option C exactly. Expected: new publish returns `https://<name>.<sites-domain>/`; `curl -sI https://anything.<sites-domain>/` answers 404 from Kofra; old `/s/<name>/` links redirect.
  - Result:
  - Evidence:
- [ ] **B5 — Freshness.** How: `node scripts/measure-freshness.mjs --api https://<worker> --site hello --samples 20 --json` (from a clone). Expected: p95 ≤ 60 s (2026-11-01 measurement on workers.dev: p50 163 ms, p95 235 ms).
  - Result:
  - Evidence:
- [ ] **B6 — Encrypted publish.** How: `npx kofra publish <small file> --encrypt` (≤ 16 MiB). Expected: URL carries the key in its fragment; the page decrypts in the browser; the stored bytes (`?raw=1`) are ciphertext.
  - Result:
  - Evidence:
- [ ] **B7 — PR preview action (optional, needs a GitHub repo).** How: add the composite action per `docs/PR_PREVIEWS.md` to a test repo. Expected: PR gets one preview comment with a working URL; closing the PR removes the preview.
  - Result:
  - Evidence:
- [ ] **B8 — Secret-hardening negative tests (scratch instance or local run — not the Part A instance).** How: start a throwaway instance three ways: (a) `SIGNING_SECRET` shorter than 32 characters; (b) `ALLOW_INSECURE_DEV_SECRET` enabled with a non-loopback origin configured; (c) no signing secret configured at all. On (c), also try setting a site password, and try a site password shorter than 8 characters on a correctly configured instance. Expected: (a) and (b) refuse to start/serve with an operator-facing error naming the problem (the 32-character minimum / the insecure dev secret) — never a silent fallback to a weak or public key. (c) signed features answer `503 signing_secret_missing`, and setting a site password is refused at write time with the same code (no unlockable gate is created); a password under 8 characters is rejected on the healthy instance (site minimum raised to match transfers; record the error code).
  - Result:
  - Evidence:

## Outcome → SPEC mapping

After the run, mark each row Done, or link the filed follow-up if it failed. Passing Part A moves the
"deployment verification pending" rows to Done; Part B verifies the rows named below.

- PUB-03 — Done / follow-up:
- PUB-04 — Done / follow-up:
- PUB-13 — Done / follow-up: (Part B2)
- PUB-14 — Done / follow-up: (Part B2)
- ID-05 — Done / follow-up:
- XFR-01 — Done / follow-up: (Part B3)
- XFR-02 — Done / follow-up: (Part B3)
- XFR-03 — Done / follow-up: (Part B3)
- XFR-04 — Done / follow-up: (Part B3)
