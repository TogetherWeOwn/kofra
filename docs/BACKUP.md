# Backup and restore

Manual runbook for a self-hosted Kofra instance: one Worker plus a D1
database, an R2 bucket, a KV namespace and an Analytics Engine dataset
(see [Self-hosting](SELF_HOST.md)). No automation, no new bindings, no extra
spend. [Provenance](#6-provenance) distinguishes commands exercised on
disposable state from unexecuted procedures; it is not an end-to-end remote
restore certification. Practice a restore drill on scratch state before you
need one for real.

Conventions: `dropway` is the D1 `database_name`, `dropway-files` the R2
`bucket_name`, `CACHE` the KV binding. The `d1 export`/`execute`,
`r2 object` and `kv key`/`kv bulk` commands also take `--local` to run
against `wrangler dev` state instead of your account, and the drill in
[Provenance](#6-provenance) used them. `d1 time-travel`, `wrangler deploy`
and `wrangler secret` have no local variant: they always act on your account.

## 1. What lives where

| Binding | Default resource | Contents | Source of truth? |
|---|---|---|---|
| `DB` (D1) | database `dropway` | Everything metadata: tenants, members, API-key hashes and scopes, sites, versions, `version_files` (the manifest: path → SHA-256, size, content type), `blobs` + `blob_scopes`, `usage_counters`, idempotency keys, slug tombstones and redirects, transfers | **Yes** |
| `FILES` (R2) | bucket `dropway-files` | `blobs/<sha256>/<uuid>`: immutable, hash-verified file generations (`blobs/<sha256>` for legacy objects); `blobs.storage_key` selects the current generation. R2 verifies the hash on write. Names are meaningless without the D1 manifest | No (bytes only) |
| `CACHE` (KV) | namespace (auto-provisioned) | `live:<slug>` only: the hot "what is live" serving cache | No: any miss is rebuilt from D1 and rewritten (`live.ts`). A hit is served without reading D1, so entries go stale when D1 changes outside the app (a restore) |
| `ANALYTICS` (AE) | dataset `dropway_hits` | One data point per served request: site id; slug, path, status, country, referrer, page-or-asset, version, tenant; count, latency ms, bytes | No, and nothing in D1 derives from it |
| edge Cache API | — | Blob bytes and viewer fragments on custom domains; a no-op on `*.workers.dev` | No: ephemeral, rebuilds |

## 2. Back up

### 2.1 D1: Time Travel (always on) plus an export file

Time Travel restores the database to any minute in the last **30 days**
(Workers Paid) or **7 days** (Workers Free). It is always on and costs
nothing extra. It needs a database on the production backend; new databases
are. Restores overwrite in place, so record the current bookmark before any
risky operation — it is your undo:

```sh
npx wrangler d1 time-travel info dropway
# -> current bookmark 00000000-0000000a-... ; save it
```

For retention beyond the window, and before every upgrade, take a portable
export (schema and data as SQL). Pause all writers (including scheduled
cleanup) and drain in-flight work while recording the inventory and
exporting, so both describe the same snapshot; save the counts beside the
SQL file for the import check. The inventory counts the rows of every table
(sites and versions, but also tenants, members, API keys, usage counters,
transfers, slug holds, idempotency and upload state, and `d1_migrations`).
It reads the table list from `sqlite_master`, so tables added by later
migrations are included without editing the query:

```sh
INVENTORY_SQL="SELECT group_concat('SELECT ''' || name || ''' AS table_name, count(*) AS rows FROM \"' || name || '\"', ' UNION ALL ') AS q FROM (SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_' ORDER BY name);"
npx wrangler d1 execute dropway --remote --json --command "$INVENTORY_SQL" \
  | jq -r '.[0].results[0].q' > ./inventory.sql
npx wrangler d1 execute dropway --remote --json --command "$(cat ./inventory.sql)" \
  | jq -S '.[0].results | sort_by(.table_name)' > ./dropway-2026-10-27-counts.json
npx wrangler d1 export dropway --remote --output=./dropway-2026-10-27.sql
```

Check every command succeeded, and that the counts file is a non-empty
JSON array, before resuming writers. For a multi-part
backup, also retain the ordered list of SQL parts. Each part must contain
complete SQL statements; arbitrary byte/line splitting can corrupt imports.

Notes:

- A running export blocks other database requests; run it off-peak.
- `d1 execute --file` imports files up to 5 GiB; split bigger ones.
- Exports include the `d1_migrations` rows, so they import cleanly into an
  empty database with no migration step.
- Kofra has no virtual tables, so the export limitation on those does not apply.

Verify the file is not empty and holds your tables, e.g.
`grep -c 'CREATE TABLE' dropway-2026-10-27.sql`. The real verification is a
restore drill ([Provenance](#6-provenance)).

### 2.2 R2: bulk copy over the S3 API

Blobs are immutable, so a bucket copy is incremental forever: each run copies
only new physical keys. Copy the whole bucket with rclone
([R2 rclone docs](https://developers.cloudflare.com/r2/examples/rclone/)).
With an API token created per
[R2 authentication](https://developers.cloudflare.com/r2/api/tokens/):

```ini
# ~/.config/rclone/rclone.conf
[r2]
type = s3
provider = Cloudflare
access_key_id = <redacted>
secret_access_key = <redacted>
endpoint = https://<accountid>.r2.cloudflarestorage.com
acl = private
```

```sh
rclone copy r2:dropway-files ./bk-r2-2026-10-27/     # to local disk, or
rclone copy r2:dropway-files r2:dropway-files-bk/    # to a second bucket
```

`copy` never deletes at the destination; prefer it over `sync` for backups.

Prefer the second bucket. A legacy `blobs/<sha256>` object and a
`blobs/<sha256>/<uuid>` generation of the same hash can exist side by side
(for example, an orphaned legacy object next to a fresh upload). R2 keys are
flat, but a local filesystem cannot hold both a file and a directory named
`blobs/<sha256>`, so a local-disk copy can fail on that one object. If that
happens, rerun the copy after a later hourly cleanup has removed the orphaned
object. The cleanup sweeps the bucket a page at a time, so the next run does not
always fix it.

Two things the copy alone does not give you:

- **The manifest lives in D1.** A `blobs/<sha256>[/<uuid>]` object says nothing about
  which site or path it belongs to. Enumerate the referenced set from the
  database you backed up in 2.1:

  ```sh
  npx wrangler d1 execute dropway --remote \
    --command "SELECT DISTINCT vf.sha256, COALESCE(b.storage_key, 'blobs/' || b.sha256) AS storage_key FROM version_files vf JOIN blobs b ON b.sha256 = vf.sha256;"
  ```

  Compare physical `storage_key` values, not just hashes. Objects in the bucket
  but not in that list are orphans awaiting the hourly
  cleanup; harmless to keep.
- **Spot-check one object** after the copy, comparing bytes:

  ```sh
  npx wrangler r2 object get dropway-files/<storage_key-from-query> --remote --file ./spot.bin
  sha256sum ./spot.bin   # must equal <sha256>
  ```

`r2 bucket info` object counts lag on fresh buckets (eventual consistency);
do not treat a zero count right after a copy as data loss.

### 2.3 KV: no backup (rebuild path)

`live:<slug>` entries are a pure cache, so there is nothing to back up and
nothing to lose. Deleting one changes nothing a visitor can see: once the
5-second per-isolate memory cache and the 30-second KV edge cache
(`cacheTtl`) have expired, the next read rebuilds it from D1 and rewrites KV
(executed: delete → site still `200` → key repopulated). Inspect the cache
with:

```sh
npx wrangler kv key list --binding CACHE --remote --prefix live:
```

The cache cannot be lost, but it can be **stale**. A hit is served as-is,
without reading D1, and entries for ordinary sites never expire
(`packages/core/src/services/live.ts`: only anonymous sites get a TTL). The
app rewrites or deletes an entry on every change it makes itself (publish,
restore a version, settings, claim, delete); it cannot see a D1 restore. So
every D1 restore into a database this Worker already served from must be
followed by the KV invalidation in [restore step 2](#3-restore-in-order).

### 2.4 Analytics Engine: no backup path (loss window)

Raw hit events are kept for **three months** and Cloudflare documents no
export or restore for them. Kofra core performs **no** Analytics Engine to
D1 rollup: `usage_counters` (`sites`, `storage_bytes`) are recomputed from
D1 itself by lifecycle transactions and the midnight cron, and the default
metering adapter is a no-op. So the loss window is exactly the hit history:
a lost dataset loses per-request analytics, never quotas, usage or counters.
If you query the dataset (SQL API, Grafana), export the aggregates you care
about yourself; that is outside this runbook.

## 3. Restore, in order

0. **Quiesce, then record the present.** Announce a maintenance window
   before either restore path. Kofra has no built-in maintenance/read-only
   switch: use your deployment's controls to stop incoming requests and all
   writers (UI, API, CLI, MCP and external jobs), including direct
   `workers.dev` URLs and both Workers when using option B. Pause both cron
   triggers on each deployed Worker and keep `triggers.crons` empty in the
   restore configuration so step 5 does not re-enable them. Wait for
   in-flight requests and background work to drain. If you cannot establish
   this quiescent state, **stop here**.

   Keep maintenance in place through step 6, allowing only the operator's
   step-4/6 reads once deployed bindings point at restored D1 and KV has been
   invalidated. Otherwise a publish accepted by the old database after the
   import is silently lost at cutover, and an old Worker can repopulate stale
   KV. The restore also
   deliberately discards changes after the selected backup/Time Travel point;
   agree on that loss window before proceeding.

   `wrangler d1 time-travel info dropway` gives the current bookmark:
   restoring to it later undoes your restore. If the broken database still
   answers, take a fresh export too (evidence, not a backup you trust).
1. **D1.** Inside the Time Travel window, restore in place (destructive:
   overwrites the database, cancels in-flight queries, prompts for
   confirmation in a terminal):

   ```sh
   npx wrangler d1 time-travel restore dropway --timestamp="2026-10-27T06:00:00+00:00"
   # or --bookmark=<saved bookmark> for the exact state; the output prints the
   # previous bookmark, which undoes this restore
   ```

   Past the window: point the `DB` entry of `wrangler.jsonc` at a fresh, empty
   database and import the export (no migrations needed; the file carries
   them). Import into an empty database only: one that `npm run deploy`
   already migrated fails on the first `CREATE TABLE`.

   ```sh
   npx wrangler d1 create dropway-restored
   # set the DB entry's database_name to dropway-restored and database_id to the printed id
   npx wrangler d1 execute DB --remote --file=./dropway-2026-10-27.sql
   # INVENTORY_SQL as set in section 2.1, now run against the restored database
   npx wrangler d1 execute DB --remote --json --command "$INVENTORY_SQL" \
     | jq -r '.[0].results[0].q' > ./restored-inventory.sql
   npx wrangler d1 execute DB --remote --json --command "$(cat ./restored-inventory.sql)" \
     | jq -S '.[0].results | sort_by(.table_name)' > ./restored-counts.json
   jq -e 'length > 0' ./dropway-2026-10-27-counts.json ./restored-counts.json > /dev/null \
     && diff ./dropway-2026-10-27-counts.json ./restored-counts.json && echo "inventory matches"
   ```

   For a multi-part backup, replace the single `--file` import above with
   one import per part in the backup's recorded order, exactly once. Stop
   on the first failed import; do not continue with later parts or deploy a
   partially imported database. Run the count query only after the last
   part. The `diff` compares every table's row count in
   `restored-counts.json` with the saved backup inventory: **abort on any
   difference**, including a missing table or an unexpected zero, before
   rebinding a Worker. A successful SQL command alone does not
   prove completeness. If the backup has no inventory, establish the
   expected contents from trusted backup records/a prior restore drill
   before proceeding; do not declare the import complete from its own count.

   Editing `wrangler.jsonc` changes only what your local commands talk to;
   the deployed Worker stays bound to the old database until the step-5
   redeploy. On this fresh-database path, run steps 3 then 5 next, and only
   then the KV invalidation (step 2) and reads (step 4).

   On a **new account** nothing exists yet. Do not run `npm run deploy` before
   the import (it would create and migrate an empty `dropway`). Instead, in a
   clone of the repo:

   1. `npx wrangler login` with the new account. If your copy of
      `wrangler.jsonc` carries the old account's resource IDs (the `DB`
      `database_id`, the `CACHE` `id`), remove them.
   2. `npx wrangler d1 create dropway`, set the printed `database_id` on the
      `DB` entry, then run the two `d1 execute DB` commands above.
   3. `npx wrangler r2 bucket create dropway-files`. Create an R2 API token
      in the **new account**, scoped to that destination bucket, and configure
      a separate rclone remote named `r2-restored` using section 2.2's format
      with the new account's endpoint and access keys. `wrangler login` does
      not update rclone's static credentials or endpoint. Keep the old remote
      separate; verify the destination account/bucket before copying in step 3.
   4. Set both secrets again; they are not in any backup:

      ```sh
      npx wrangler secret put ADMIN_BOOTSTRAP_KEY
      npx wrangler secret put SIGNING_SECRET   # only if the old instance set one
      ```

      API keys survive (D1 stores plain SHA-256 hashes, no secret involved).
      Reuse the old `SIGNING_SECRET` value if you kept it; a new one only
      invalidates short-lived grants: password-site cookies (visitors enter
      the password again), upload capabilities and delivery unlocks, and the
      hashed-IP rate-limit buckets restart.
   5. Redeploy (step 5). Its first deploy auto-provisions a new, empty KV
      namespace, so step 2 has nothing to delete there.

2. **KV: invalidate every live entry.** Required after any restore into a
   database the Worker had already served from (in-place Time Travel, or an
   import while the same KV namespace stays bound). Until you do this, every
   site keeps serving the version, files, password and settings it had before
   the restore, a site that exists only after the restore point keeps
   serving, and a status-code-only check returns `200` on the wrong bytes.

   On the fresh-database path (step 1 imported into a new database), skip
   this step for now and come back after steps 3 and 5: the deployed Worker
   is still bound to the old database until the step-5 redeploy, so a delete
   now is undone by the next read — visitor traffic or step 4's own reads —
   which rebuilds each entry from the old D1 and writes it back.

   Delete all `live:` keys in one call:

   ```sh
   npx wrangler kv key list --binding CACHE --remote --prefix live: > live-keys.json
   npx wrangler kv bulk delete live-keys.json --binding CACHE --remote --force
   ```

   The list output is the JSON array `kv bulk delete` reads; Wrangler pages
   through the list and deletes in batches of 1,000, so one file covers every
   site. Check that both commands succeeded. Keep site traffic stopped and
   wait at least a minute before step 4's reads. Kofra's defaults are a
   30-second KV read cache (`cacheTtl`) and a 5-second per-isolate cache; an
   embedding deployment with a longer read TTL needs at least that TTL plus
   5 seconds. These are not a global propagation deadline:
   [KV deletions can take time to reach other locations](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/).
   The immediate list need not be empty; check it after the wait in step 4,
   and keep maintenance in place if deletion or content checks have not
   settled. Each site's next cache miss then rebuilds from the D1 the Worker
   is bound to — the restored one, once the ordering above is followed.
   Blob bytes and viewer fragments in the edge Cache API are keyed by
   SHA-256, so they cannot go stale and need nothing.

3. **R2.** Copy the bytes back, then use the query in [section 2.2](#22-r2-bulk-copy-over-the-s3-api)
   against the restored D1 database to obtain each referenced `storage_key` and
   its expected `sha256`. Verify the copied object using that physical key.
   Set `RESTORE_REMOTE=r2` for the existing account, or
   `RESTORE_REMOTE=r2-restored` for the new-account remote configured in step 1.
   Verify that remote's endpoint and credentials match the account Wrangler
   is targeting; there is deliberately no default destination below.

   ```sh
   rclone copy ./bk-r2-2026-10-27/ "${RESTORE_REMOTE:?Set the verified destination remote}:dropway-files"
   npx wrangler r2 object get dropway-files/<storage_key-from-query> \
     --remote --file ./spot.bin && sha256sum ./spot.bin
   ```

   Extra objects are harmless; missing ones make file reads fail with `502`
   "File unavailable" until copied (observed in the drill: D1-only restore
   served `502`s, full restore served `200`s).
4. **KV check.** Nothing to restore. After the step-2 wait, while site
   traffic is still stopped, run:

   ```sh
   npx wrangler kv key list --binding CACHE --remote --prefix live:
   ```

   Expect `[]` only after deletion has propagated. If keys remain, keep
   maintenance in place, allow more propagation time and check again; if
   they persist, investigate failed deletion or a caller that was not
   quiesced. Then allow operator reads of each restored live site once and
   repeat the same list command to observe repopulation. KV writes and
   listing are asynchronous/eventually consistent, so newly rebuilt names
   may not appear immediately either. An empty list alone does not prove
   that serving caches are fresh: step 6 checks bytes. On the fresh-database
   path, do this only after **both** step-5 redeploys (when option B is used)
   and the deferred step-2 deletion; earlier reads can rebuild from old D1.
5. **Redeploy.** `npm run deploy` re-applies migrations and redeploys the
   primary Worker. With a second sites Worker
   ([Self-hosting, option B](SELF_HOST.md#b-a-second-deployment-for-sites)),
   redeploy it too: `npx wrangler deploy --name <worker>-sites`. Keep traffic
   and cron triggers stopped throughout. On the fresh-database path, wait
   for **every configured Worker redeploy to succeed** (primary, plus the
   sites Worker if option B is used) and old invocations to drain before
   step 2 and step 4. Do not delete/repopulate KV between the two deploys:
   the old-bound sites Worker can repopulate the shared namespace. A failed
   deploy is a stop, not permission to continue with mixed bindings.
6. **Verify before reopening traffic.** Check identity, the normal visitor
   entry page, raw bytes, and counters. `<site-url>` is the site's URL for
   your serving mode ([Where sites are served](SELF_HOST.md#where-sites-are-served)):
   `https://<worker>/s/<site>/` in path mode, `https://<worker>-sites.<you>.workers.dev/<site>/`
   with a second sites Worker, `https://<site>.<your-sites-domain>/` in subdomain mode.
   Pick a site without a password and a file whose content changed between
   the restore point and now, so a stale read cannot pass. `<path>` is the
   path as stored in `version_files`, without a leading slash (`assets/app.js`).

   ```sh
   npx kofra whoami --api https://<worker>          # instance reachable, key accepted
   curl -fSL '<site-url>' -o ./homepage.html -w '%{http_code}\n' || exit 1
   curl -fSL '<site-url><path>?raw=1' -o ./verify.bin -w '%{http_code}\n' || exit 1
   sha256sum ./verify.bin
   npx wrangler d1 execute DB --remote --command \
     "SELECT f.sha256 FROM version_files f JOIN sites s ON f.version_id = s.current_version_id WHERE s.slug = '<site>' AND f.path = '<path>';"
   npx wrangler d1 execute DB --remote --command "SELECT key,value FROM usage_counters;"
   ```

   `whoami` must show the owner and full scopes. Both HTTP probes must end
   at `200`. Inspect `homepage.html` for known restored content, not an error
   page; for a file entry point rather than a homepage, probe its normal
   visitor URL instead. Checking a separate raw asset alone misses an absent
   index blob (`502` for visitors while the asset can still return `200`).
   `sha256sum` must equal the `sha256` the restored D1 holds for that path.
   `?raw=1` returns stored bytes with no viewer page, link rewriting or
   precompressed variant. A failed probe, wrong entry page, or hash mismatch
   is a stop: keep maintenance in place and investigate R2 completeness,
   deployed bindings and stale KV (repeat step 2 if needed). Counters must
   match the restored data; do not rely on a later cron to make verification
   pass.

   Only after all checks pass, restore the original cron configuration on
   both Workers (if present), redeploy them against the same restored
   bindings, and resume callers/traffic. Keep maintenance in place if either
   deploy fails. The temporary empty cron list must not become permanent.

## 4. NOT recoverable

- Raw Analytics Engine events past the three-month retention, or any dataset
  loss: no restore API exists. Hit history only; counters are unaffected.
- In-flight pending versions: the hourly cleanup drops pending deploys older
  than a day and their bytes become orphans, then deleted.
- Upload capabilities (`dwu_`): HMAC-signed, expire one hour after creation.
  An interrupted multipart session cannot resume after a restore; republish.
- Idempotency replays past the 24-hour key expiry: keys are purged
  (500 per hourly run). Retrying is safe; replaying the old response is not
  possible.
- Expired anonymous sites and deleted sites past the purge (rows an hour
  after deletion, tombstones keep the names): Time Travel inside its window
  can still recover these; exports from after the purge cannot.
- Cross-binding skew: D1 and R2 snapshots taken minutes apart can disagree.
  A version whose blobs are missing reads `502` until R2 catches up.

Deliberately absent: KV-only state. KV holds no unique data — `live:<slug>`
is rebuilt from D1 on every miss — so there is nothing to lose. It can hold
**stale** data after a restore, which restore step 2 clears; that is a step to
run, not a loss. The edge Cache API holds only content-addressed bytes and
fragments: nothing to lose and nothing to invalidate.

## 5. Cadence and retention math

- **Before every upgrade**: export + record the current bookmark. Migrations
  are additive, but Time Travel is your undo.
- **Weekly**: `d1 export`. Cheap: a two-file demo database exports to 14 KB;
  size tracks the D1 size in the dashboard (megabytes for most instances).
- **Monthly**: full `rclone copy` of R2. Immutable blobs make each run copy
  only new physical keys; keep the last two copies.
- **Retention math, honestly**: D1 recovery point is the better of (last
  export, Time Travel window at minute granularity) — inside the window you
  lose minutes, outside it you lose everything since the export. R2 recovery
  point is the last copy; stragglers are exactly the files uploaded since.
  Analytics Engine is unrecoverable by design past three months. Disk for a
  year of weekly exports is ~52× your D1 size: negligible next to R2.
- No timers, cron entries, scripts or new bindings are part of this runbook.
  Schedule the two commands with your own cron if you want; that automation
  is out of scope here.

## 6. Provenance

Executed 2026-10-27 with wrangler 4.152.0 (repo-pinned) unless a row names
another version; commands listed as not executed below the table were not
run. Redacted outputs
(keys, secret material and account identifiers omitted; bookmark prefixes
shown truncated):

| Command | Where | Result |
|---|---|---|
| `d1 export DB --local --output=...` | disposable `wrangler dev` (fresh `.wrangler/state`, 2-file site) | 14,115-byte SQL, schema + data + `d1_migrations` |
| `d1 export <name> --remote --output=...` | disposable remote D1 `dw-runbook-exp-*` (1 canary row) | 131-byte SQL containing the row |
| `d1 execute DB --local --file=...` | fresh local state (`.wrangler/state` wiped) | site row back; `SELECT` confirms |
| `d1 time-travel info/restore` + undo | disposable remote D1 `dw-runbook-tmp-*` (canary table) | delete → 0 rows; restore to bookmark → row back; restore to previous bookmark → 0 rows |
| `r2 object put/get/delete`, `bucket create/info/delete --remote` | disposable remote bucket `dw-runbook-tmp-*` | byte-identical round-trip; bucket removed |
| `r2 object get/put --local` | disposable `wrangler dev` | blob backup + restore; D1-only state served `502`, full state `200` |
| `kv key delete/list` + site read | disposable `wrangler dev` | delete → `[]`; site read `200`; key repopulated |
| `kv key list --prefix live: > file` + `kv bulk delete file --force` (wrangler 4.153.0) | disposable local KV (`--local --persist-to`, keys `live:a`, `live:b`, `other`, plus `live:anon` with TTL and an `expiration` field in the file) | only `live:*` deleted; `other` kept; `Success!` |
| `kofra whoami` + site read | disposable `wrangler dev`, before and after restore | owner + full scopes; `hello backup` bytes back |
| `SELECT key,value FROM usage_counters` | restored local D1 | `sites=1, storage_bytes=69` intact |

All disposable remote resources were deleted the same session; `d1 list`
and `r2 bucket list` verified zero `dw-runbook-*` names afterwards, and no
production database or bucket was ever referenced. Not executed (no standing
scratch bucket; stock vendor syntax from the linked official docs): the
`rclone copy` bulk transfer, the Time Travel REST API
(`GET/POST .../time_travel/bookmark|restore`), and Analytics Engine SQL
queries. Added 2026-10-27, not executed remotely: the `--remote` forms of the
KV invalidation (the same commands as the local row above), and the
new-account sequence (`d1 create`, `secret put`; stock Wrangler commands). The
redeploy step is the repo's own `npm run deploy`. The 2026-10-28 additions
(maintenance/drain and cron pause/resume, snapshot inventory comparison,
ordered multi-part import, the combined homepage/raw verification sequence,
and new-account rclone configuration) have not been drilled end to end;
they were checked against the service code and vendor documentation only.
The 2026-10-31 all-table inventory (`INVENTORY_SQL`) was run locally against
a SQLite database built from `packages/core/migrations/`, not against remote D1.
