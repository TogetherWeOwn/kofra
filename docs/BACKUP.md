# Backup and restore

Manual runbook for a self-hosted Kofra instance: one Worker plus a D1
database, an R2 bucket, a KV namespace and an Analytics Engine dataset
(see [Self-hosting](SELF_HOST.md)). No automation, no new bindings, no extra
spend: every command below was executed on a disposable instance, with the
provenance recorded at the end. Practice a restore drill on scratch state
before you need one for real.

Conventions: `dropway` is the D1 `database_name`, `dropway-files` the R2
`bucket_name`, `CACHE` the KV binding. Every `wrangler` command below also
has a `--local` variant that runs against `wrangler dev` state instead of
your account; the drill in [Provenance](#6-provenance) used them.

## 1. What lives where

| Binding | Default resource | Contents | Source of truth? |
|---|---|---|---|
| `DB` (D1) | database `dropway` | Everything metadata: tenants, members, API-key hashes and scopes, sites, versions, `version_files` (the manifest: path → SHA-256, size, content type), `blobs` + `blob_scopes`, `usage_counters`, idempotency keys, slug tombstones and redirects, transfers | **Yes** |
| `FILES` (R2) | bucket `dropway-files` | `blobs/<sha256>/<uuid>`: immutable, hash-verified file generations (`blobs/<sha256>` for legacy objects); `blobs.storage_key` selects the current generation. R2 verifies the hash on write. Names are meaningless without the D1 manifest | No (bytes only) |
| `CACHE` (KV) | namespace (auto-provisioned) | `live:<slug>` only: the hot "what is live" serving cache | No: any miss is rebuilt from D1 and rewritten (`live.ts`) |
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
export (schema and data as SQL):

```sh
npx wrangler d1 export dropway --remote --output=./dropway-2026-10-27.sql
```

Notes, all verified:

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

`live:<slug>` entries are a pure cache. Deleting one changes nothing a
visitor can see: the next read rebuilds it from D1 and rewrites KV
(executed: delete → site still `200` → key repopulated). There is no manual
rebuild step and none is needed. After a restore, warm the cache by reading
each site homepage once, then confirm:

```sh
npx wrangler kv key list --binding CACHE --remote
```

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

0. **Record the present first.** `wrangler d1 time-travel info dropway` gives
   the current bookmark: restoring to it later undoes your restore. If the
   broken database still answers, take a fresh export too (evidence, not a
   backup you trust).
1. **D1.** Inside the Time Travel window, restore in place (destructive:
   overwrites the database, cancels in-flight queries, prompts for
   confirmation in a terminal):

   ```sh
   npx wrangler d1 time-travel restore dropway --timestamp="2026-10-27T06:00:00+00:00"
   # or --bookmark=<saved bookmark> for the exact state; the output prints the
   # previous bookmark, which undoes this restore
   ```

   Past the window, or on a new account: point `wrangler.jsonc` at a fresh
   database and import the export (no migrations needed; the file carries them):

   ```sh
   npx wrangler d1 execute dropway --remote --file=./dropway-2026-10-27.sql
   npx wrangler d1 execute dropway --remote --command "SELECT count(*) AS sites FROM sites;"
   ```

2. **R2.** Copy the bytes back, then use the query in [section 2.2](#22-r2-bulk-copy-over-the-s3-api)
   against the restored D1 database to obtain each referenced `storage_key` and
   its expected `sha256`. Verify the copied object using that physical key:

   ```sh
   rclone copy ./bk-r2-2026-10-27/ r2:dropway-files
   npx wrangler r2 object get dropway-files/<storage_key-from-query> \
     --remote --file ./spot.bin && sha256sum ./spot.bin
   ```

   Extra objects are harmless; missing ones make file reads fail with `502`
   "File unavailable" until copied (observed in the drill: D1-only restore
   served `502`s, full restore served `200`s).
3. **KV.** Nothing to restore. Read each site once; `kv key list` shows the
   `live:<slug>` keys repopulating.
4. **Redeploy.** `npm run deploy` re-applies migrations and redeploys the
   Worker; it is safe to re-run for upgrades. With a second sites Worker
   ([Self-hosting, option B](SELF_HOST.md#b-a-second-deployment-for-sites)),
   redeploy it too: `npx wrangler deploy --name <worker>-sites`.
5. **Verify.** All three, in this order:

   ```sh
   npx kofra whoami --api https://<worker>          # instance reachable, key accepted
   curl -s https://<worker>/s/<site>/ -o /dev/null -w '%{http_code}\n'  # 200 + bytes
   npx wrangler d1 execute dropway --remote --command "SELECT key,value FROM usage_counters;"
   ```

   `whoami` must show the owner and full scopes; the site read must return
   real bytes, not the `502` page; counters must match the restored data
   (the midnight cron recomputes them anyway).

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
is rebuilt from D1 on every miss — so there is nothing to lose. The edge
Cache API is the same.

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

Executed 2026-10-27 with wrangler 4.152.0 (repo-pinned). Redacted outputs
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
| `kofra whoami` + site read | disposable `wrangler dev`, before and after restore | owner + full scopes; `hello backup` bytes back |
| `SELECT key,value FROM usage_counters` | restored local D1 | `sites=1, storage_bytes=69` intact |

All disposable remote resources were deleted the same session; `d1 list`
and `r2 bucket list` verified zero `dw-runbook-*` names afterwards, and no
production database or bucket was ever referenced. Not executed (no standing
scratch bucket; stock vendor syntax from the linked official docs): the
`rclone copy` bulk transfer, the Time Travel REST API
(`GET/POST .../time_travel/bookmark|restore`), and Analytics Engine SQL
queries. The redeploy step is the repo's own `npm run deploy`.
