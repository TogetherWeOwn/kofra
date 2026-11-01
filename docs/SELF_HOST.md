# Self-hosting Kofra

Kofra runs on your own Cloudflare account: one Worker plus a D1 database, an R2 bucket and a KV
namespace (Analytics Engine creates its dataset on the first write). It is a single-tenant product:
you (the owner) plus the members and API keys you create. There is no signup and no billing.

You need:

- A Cloudflare account with R2 turned on (a one-time step in the dashboard under R2; the deploy
  cannot do it for you).
- For the button: a GitHub or GitLab account. For the command line: Node.js 22 or newer.
- The free Workers plan is enough to try it. Workers Paid is recommended for real use: the free
  plan's 10 ms of CPU per request is tight for zip uploads and large pages.

## Option 1: Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TogetherWeOwn/kofra)

Link: `https://deploy.workers.cloudflare.com/?url=https://github.com/TogetherWeOwn/kofra`

What happens, per Cloudflare's [Deploy button docs](https://developers.cloudflare.com/workers/platform/deploy-buttons/):

1. Cloudflare copies this repository into your GitHub (or GitLab) account and connects it to
   Workers Builds, so every push to your copy redeploys.
2. It reads `wrangler.jsonc` and creates what it lists: the D1 database `dropway`, the R2 bucket
   `dropway-files` and a KV namespace. You can rename them on the setup page.
3. It asks for `ADMIN_BOOTSTRAP_KEY` and `SIGNING_SECRET` (listed in `.dev.vars.example`; the help
   text comes from `cloudflare.bindings` in `package.json`). Use a different long random string for
   each: `openssl rand -hex 32`.
4. It runs `npm run deploy`, which applies the D1 migrations and then deploys the Worker.

The button points at the repository root on purpose. The docs say Cloudflare "does not fully
support monorepos": a button for a subdirectory treats that folder as the whole repository, so it must
contain everything it needs. The Worker entry (`apps/worker`) imports `packages/*`, so
`wrangler.jsonc` sits at the root with `"main": "apps/worker/src/index.ts"`.

Changing settings later: edit the `vars` in `wrangler.jsonc` in your copy and push. Do not rely on
editing variables in the dashboard: the next `wrangler deploy` replaces dashboard variables with the
ones in `wrangler.jsonc` unless you set `"keep_vars": true`. Secrets (`ADMIN_BOOTSTRAP_KEY`,
`SIGNING_SECRET`) are kept across deploys.

## Option 2: Command line

```sh
git clone https://github.com/TogetherWeOwn/kofra && cd kofra
npm install
npx wrangler login
npx wrangler secret put ADMIN_BOOTSTRAP_KEY   # paste a long random string (openssl rand -hex 32)
npx wrangler secret put SIGNING_SECRET        # a different long random string
npm run deploy
```

`npm run deploy` is safe to re-run for upgrades: it applies new migrations, then deploys.

On the first run nothing exists yet, so it deploys once (Wrangler's
[automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)
creates the D1 database, R2 bucket and KV namespace and writes their IDs back into `wrangler.jsonc`),
applies the migrations, and deploys again. Commit the updated `wrangler.jsonc` in your copy.

Name clashes: Wrangler connects to an existing D1 database or R2 bucket with the same name instead
of creating one. If your account already has a `dropway` database or a `dropway-files` bucket that
belongs to something else, change `name`, `database_name` and `bucket_name` in `wrangler.jsonc` first.

## File deliveries

Deliveries require a separate files origin (`SITES_ORIGIN`, or subdomain serving);
shared-origin `/s/` mode cannot create them. Optional password grants last 15 minutes
and are bound to the current password digest. Recipient links attribute download
counts but do not verify email identity. Messages are plain text. Expiry ranges
from one hour to the configured maximum: `TRANSFER_MAX_EXPIRY_DAYS` defaults to 30
and is capped at 3,650 days; an embedding policy can lower it. No email is sent.

Set a strong `SIGNING_SECRET` before enabling password deliveries. The app's
HttpOnly cookie is not shared with the files host: after unlock, the app page
renders signed download links, valid for at most 15 minutes. Treat their query
strings as bearer credentials and do not log or share them. Every request still
checks current expiry, revocation, takedown, limit and password digest in D1.

Delivery file manifests are immutable. Ordinary site publishing, settings and
version APIs cannot replace them or change their password. Use `update_transfer`
for permitted metadata changes and `revoke_transfers` to stop downloads at once.
Cleanup claims expiry hourly, retains closed bytes for 24 hours, then removes
manifest references only if there is no hold or takedown. Storage accounting is
released once at purge, never at revoke. Sender metadata remains readable.

## Version file checksums

On a site page, each version's Files panel lists every file's exact byte size
and full SHA-256 manifest checksum with a Copy SHA-256 button (keyboard
operable; success or failure is announced). The panel always fetches the
selected version by its immutable version ID and shows the version number and
ID from that same manifest response, so a digest is never attached to a stale
live label. Digests come from manifest metadata only; the panel never downloads
file bytes to display them.

A checksum is the selected version's manifest metadata, not proof that the
current live download matches it, and not a verdict on authenticity,
authorship, safe content or scanning. Compare it against a trusted source you
already have. Per-file Open links still point at the live site.

## Releasing held site names

Renames hold their old URLs; deleting or expiring a site tombstones its name.
`release_slug` (`POST /api/v1/slugs/release`) requires `confirm` equal to the
slug, a nonempty `reason`, and an **unrestricted admin key of the holding tenant**.
Tenant admin scope is not instance-wide operator authority: foreign holds,
ownerless anonymous holds and site-restricted keys are refused with 403.

For a cross-tenant trademark dispute or an ownerless expiry, the **instance
operator with existing D1 write access**, not a tenant API credential, performs
an audited release outside the public API. Verify the exact slug and dispute
first, then submit the following statements together in **one D1 `batch`**.
Bind `:slug`, one epoch-millisecond `:now`, a nonempty `:reason` and an attributable
`:operator` identity (for example `operator:case-42`) as parameters; these labels
are illustrative, not values to paste unmodified:

```sql
INSERT INTO slug_tombstones
  (id, slug, tenant_id, site_id, chosen, hold_until, reason, created_at,
   released_at, release_reason, released_by)
SELECT lower(hex(randomblob(16))), r.slug, s.tenant_id, r.site_id, r.chosen,
       r.hold_until, 'rename', :now, :now, :reason, :operator
FROM slug_redirects r LEFT JOIN sites s ON s.id = r.site_id
WHERE r.slug = :slug AND r.hold_until > :now;

UPDATE slug_tombstones
SET released_at = :now, release_reason = :reason, released_by = :operator
WHERE slug = :slug AND released_at IS NULL AND hold_until > :now;

DELETE FROM slug_redirects WHERE slug = :slug AND hold_until > :now;
```

Verify no active redirect or unreleased active tombstone remains for the slug,
and retain the released rows as the audit trail. A live site's current name and
permanent delivery reservations are not released by this procedure. Never grant
D1 credentials to a tenant or reuse the bootstrap key for release. Released audit
rows are retained indefinitely; only expired **unreleased** holds are purged.

## First run: create the owner

With the CLI (it saves the owner key in `~/.config/dropway/credentials.json`, mode 0600):

```sh
KOFRA_BOOTSTRAP_KEY=<your bootstrap key> npx kofra setup --api https://<worker>.<you>.workers.dev --email you@example.com
npx kofra whoami
npx kofra publish ./some-folder
```

With curl:

```sh
curl -X POST https://<worker>/api/v1/setup \
  -H "Authorization: Bearer $ADMIN_BOOTSTRAP_KEY" \
  -H "Content-Type: application/json" -d '{"email":"you@example.com"}'
# -> { "apiKey": { "key": "dw_..." }, ... }   (shown once)
```

Setup works once. If you lose the owner key, `POST /api/v1/setup/recover` with the bootstrap key mints
a new one. Add people with `POST /api/v1/members` (each gets their own key) and create narrower keys
(for CI or an MCP client) with `POST /api/v1/keys`, e.g.
`npx kofra api POST /keys --data '{"name":"ci","scopes":["sites:read","sites:write"]}'`.

## Configuration

Variables go in `vars` in `wrangler.jsonc`; secrets with `npx wrangler secret put <NAME>`.

| Name | Default | Meaning |
|---|---|---|
| `ADMIN_BOOTSTRAP_KEY` (secret) | none | Creates the owner on first run; mints recovery owner keys |
| `SIGNING_SECRET` (secret) | bootstrap key | HMAC secret for signed capabilities (site password cookies, upload and version preview tokens, delivery grants) and IP hashing. Independent of the bootstrap key: set its own value so rotating or removing `ADMIN_BOOTSTRAP_KEY` does not invalidate them. With neither set, those features answer `503 signing_secret_missing`; unsigned routes keep working |
| `ALLOW_INSECURE_DEV_SECRET` | `false` | Local development only: with no secret set, sign with a fixed public value. Never set it on a reachable instance |
| `INSTANCE_NAME` | `Kofra` | Shown in pages and API responses |
| `APP_ORIGIN` | request origin | Public origin of the app and API |
| `LEGACY_APP_ORIGINS` | empty | Former app origins (comma-separated), after a move to a new `APP_ORIGIN`. See [Moving the app](#moving-the-app-to-a-new-origin) |
| `LEGACY_DEPRECATED_AT` | none | Date of that move (ISO 8601 or Unix seconds), sent as `Deprecation: @<seconds>`; unset = no `Deprecation` header (the successor `Link` is still sent) |
| `SITES_MODE` | `path` (`subdomain` when `SITES_DOMAIN` is set) | `path` or `subdomain` (see below) |
| `SITES_DOMAIN` | empty | Subdomain mode: sites at `https://<name>.<SITES_DOMAIN>/` |
| `SITES_ORIGIN` | empty | Path mode: origin of a second, sites-only deployment of the same Worker. Ignored in subdomain mode |
| `LEGACY_SITES_ORIGINS` | empty | Former path-mode sites origins (comma-separated): `<origin>/<name>/<path>` answers `308` to the site's current URL, path and query kept (not cached) |
| `SITES_SANDBOX` | `auto` | `auto`: on a separate sites origin, sandbox anonymous sites only. `true`: sandbox every site. `false`: none. Always on when sites share the app origin |
| `ANONYMOUS_PUBLISH` | `false` | Allow publishing without a key (sites expire; a claim token is returned) |
| `ANON_TTL_HOURS` | `24` | Lifetime of anonymous sites |
| `ANON_SITES_PER_HOUR` | `60` | New anonymous sites per IP per hour |
| `ANON_MAX_FILE_BYTES` / `ANON_MAX_SITE_BYTES` | 25 MB / 250 MB | Caps for anonymous sites |
| `MAX_FILE_BYTES` | 100 MB | Largest file |
| `MAX_FILES` | 2500 | Most files per version |
| `MAX_SITE_BYTES` | 10 GB | Largest version |
| `ONESHOT_MAX_BYTES` | 25 MB | Largest one-shot `POST /api/v1/publish` body (bigger sites use the manifest flow, which the CLI always uses) |

### Resource quotas and scope upgrades

`QUOTA_SITES` and `QUOTA_STORAGE_BYTES` set optional tenant resource limits. Use
non-negative integers: unset/empty means unlimited; `0` refuses new resources.
Ordinary site storage counts each hash once across active sites' ready versions,
including history; pending uploads are not charged. Deleting an ordinary site or
non-live version frees bytes only when no other ready version on an active ordinary
site references them. Claiming an anonymous site checks the receiving tenant's
sites and storage quotas first.

Deliveries use the existing reservation model: each transfer's full manifest bytes
are charged separately until purge, including revoked, expired, deleted or held
deliveries. Reusing a hash across an ordinary site and a transfer, or across two
transfers, does not reduce that reservation. A transfer's initial deploy adds no
further bytes (`newBytes: 0`) because creation already reserved them. Transfers
also occupy site slots while their site rows remain active; purge retains the
sender-readable transfer record and site unless the sender deleted the site.

`GET /api/v1/me` (MCP `whoami`) reports `capabilities`, `limits` and `usage`.
Other `QUOTA_*` names follow the exported `QUOTA_KEYS` vocabulary; resource-specific
features enforce their corresponding quotas when implemented. Optional features
without their required binding report `feature_unavailable`, even if a custom
policy allows them. The default config runs usage reconciliation at midnight UTC
and cleanup hourly; custom Worker configs must preserve both cron entries.

The dashboard Settings page renders the same caller-effective values under
"Your account": the four size/count limits, site and retained-storage usage
against their configured limits, and each capability with its refusal reason
when unavailable. The "This instance" section keeps showing the configured
defaults above; effective values can be lower per key.

The `0003_scopes_usage.sql` migration (after `0002_transfers.sql`) preserves deletion on existing `sites:write`
keys by adding `sites:delete`. New keys must explicitly include `sites:delete` to
delete; read/write-only automation stays non-destructive. Owners and admins may
hold all scopes; members may hold `sites:read`, `sites:write`, `sites:delete`,
`keys:write` and `data:write`, but not `secrets:write` or `admin`. A claim token
retains read/write/delete control of its own anonymous site only; claiming the
site invalidates that token. Repeating the member's successful claim is retry-safe
and does not charge the site's usage twice.

## Where sites are served

| | A. Path mode (default) | B. Second Worker on workers.dev | C. Subdomain mode (your domain) |
|---|---|---|---|
| Site URL | `https://<worker>/s/<name>/` | `https://<worker>-sites.<you>.workers.dev/<name>/` | `https://<name>.<your-sites-domain>/` |
| Setup | none | one extra deploy | a domain on Cloudflare, one DNS record, one route |
| Isolation | sites share the app origin, so they are always sandboxed | sites are separated from the app, not from each other | every site is its own origin |
| Limits for pages | no cookies, `localStorage` or service workers (sandbox); root-relative import specifiers and `location.href = "/x"` do not resolve | sites share one origin's storage (anonymous sites are sandboxed) | none |
| Use when | trying it out, personal use | a team that trusts its publishers, before buying a domain | untrusted publishers, or as soon as you have a domain |

### A. Path mode

Nothing to do. Sites are served under `/s/<name>/` on the same Worker with a CSP sandbox, so a page
can never read the app's storage. Root-relative URLs in HTML and CSS (`/assets/app.js`) are rewritten
to stay inside the site, and a small script at the top of each page does the same for URLs built in
JavaScript (`fetch("/data.json")`, `img.src = "/x.png"`, XHR, `innerHTML`). Import specifiers
(`import "/x.js"`), `location.href = "/x"` and `history.pushState("/x")` are not rewritten: use
relative URLs there, or subdomain mode.

### B. A second deployment for sites

1. In `wrangler.jsonc` set `"APP_ORIGIN": "https://<worker>.<you>.workers.dev"` and
   `"SITES_ORIGIN": "https://<worker>-sites.<you>.workers.dev"`, then `npm run deploy`.
2. Deploy the same code and bindings under a second name: `npx wrangler deploy --name <worker>-sites`.

Both Workers share the same D1, R2 and KV. The app redirects `/s/<name>/...` to the sites origin and
never serves user content itself. Both also run the hourly cleanup cron; each cleanup step re-checks
state before changing it, so running it twice is safe.

### C. Subdomain mode with your own domain

Use a domain for sites that is a different registrable domain from the app (for example the app on
`dropway.<you>.workers.dev` or `kofra.example.com`, sites on `example-sites.com`), so a published page
can never set or read the app's cookies.

1. **Add the domain** to your Cloudflare account (a full zone, so Cloudflare serves its DNS).
2. **Wildcard DNS record**: type `AAAA`, name `*`, IPv6 address `100::`, proxy status **Proxied**.
   `100::` is the documented placeholder for hostnames that only run a Worker
   ([routes docs](https://developers.cloudflare.com/workers/configuration/routing/routes/)); wildcard
   records can be proxied on every plan
   ([wildcard DNS docs](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/)).
3. **Configure the Worker** in `wrangler.jsonc`:

   ```jsonc
   "workers_dev": true,   // keep the app on workers.dev; adding routes turns it off otherwise
   "routes": [{ "pattern": "*.example-sites.com/*", "zone_name": "example-sites.com" }],
   "vars": {
     "APP_ORIGIN": "https://dropway.<you>.workers.dev",
     "SITES_MODE": "subdomain",
     "SITES_DOMAIN": "example-sites.com"
     // ...keep the other vars; clear SITES_ORIGIN (subdomain mode ignores it)
   }
   ```

   It must be a route, not a Custom Domain: Custom Domains
   ["do not support wildcard DNS records"](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
4. **Deploy**: `npm run deploy`, or push to your copy if you used the button.
5. **Check**: `curl -sI https://anything.example-sites.com/` answers from Kofra (404, no such site),
   and a new publish returns `https://<name>.example-sites.com/`. Old `/s/<name>/` links on the app
   redirect to the new URLs. If sites were on a second Worker before (option B), set
   `LEGACY_SITES_ORIGINS` to its old origin so `<old origin>/<name>/...` links redirect too, and
   clear `SITES_ORIGIN`: subdomain mode ignores it (left set, it does not stop those redirects).

In subdomain mode `www.<SITES_DOMAIN>` redirects to the app, and reserved names (`files`, `fallback`,
`customers`, `api`, ...) are never served as sites. Site names are at most 56 characters, so a version
preview host `<name>--v<N>` still fits one DNS label. Password-protected sites use a `__Host-` cookie,
send no CORS headers and `Cross-Origin-Resource-Policy: same-origin`, and refuse (`403`) non-navigation
requests from other sites (`Sec-Fetch-Site: same-site` or `cross-site`): sibling `<name>.<SITES_DOMAIN>`
hosts are the same site until the domain is on the Public Suffix List. A password entered in the
dashboard's file viewer (a cross-site frame) sets a partitioned cookie for that frame only.

TLS: Universal SSL covers the apex and first-level subdomains only
([limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)).
Site names are single labels, so `<name>.example-sites.com` is covered. Do not use a deeper
`SITES_DOMAIN` such as `sites.example.com`: `<name>.sites.example.com` would need an advanced
certificate.

To put the app itself on your domain too, add a Custom Domain route such as
`{ "pattern": "kofra.example.com", "custom_domain": true }` and set `APP_ORIGIN` to match.

### Moving the app to a new origin

Keep `"workers_dev": true`, set `APP_ORIGIN` to the new origin and list the old one in
`LEGACY_APP_ORIGINS` (for example `"https://dropway.<you>.workers.dev"`). On the old origin:

- `/api/*`, `/mcp`, `/health`, `/.well-known/*`, `/llms.txt`, `/llms-full.txt`, `/openapi.json` and
  `/skill.md` keep answering, with `Deprecation` and `Link: <new URL>; rel="successor-version"`
  headers. They are not redirected: HTTP clients drop the `Authorization` header on a cross-origin
  redirect, so a redirected agent would get 401. The CLI prints a one-line note with the new address.
- Other `GET`/`HEAD` requests (pages, the dashboard, sign-in links) answer `308` to the same path and
  query on the new origin. The redirect is not cached, so moving back works at once. It carries
  `Access-Control-Allow-Origin: *` (never credentials), so cross-origin reads of published files at
  their old URLs (`/s/<site>/...`) follow it; the new origin decides whether the read is allowed.
  Other methods (webhooks, form posts) are served in place.
- Browser sessions are per host: people sign in again on the new origin.

## Caching and freshness

What a request reads, in order: isolate memory (5 s), the Cache API pointer memo (10 s, shared by
every isolate in the data center), then KV (which has its own edge cache, 30 s minimum), then D1.
File bytes come from the Cache API keyed by SHA-256 (immutable), then R2. Files over 25 MB and
Range requests go straight to R2 and never touch the Cache API. A publish, settings change or
delete drops the memo in the data center that handled it (the next read refills it from KV); other data centers pick the
change up within the memo's 10 s plus KV's cache TTL.

Measure how long a change takes to appear on your own deployment. Point it at an existing site:
each sample updates `measure.txt` in place with a partial file update, leaving the rest of the
site untouched:

```sh
KOFRA_API_KEY=<owner key> node scripts/measure-freshness.mjs \
  --api https://<worker>.<you>.workers.dev --site freshness --samples 20 --json
```

It prints `p50Ms` and `p95Ms` from "publish returned" to "the live URL served the new bytes".

### Measured on workers.dev

Measured 2026-11-01 against a throwaway test worker with 20 samples
(`scripts/measure-freshness.mjs --samples 20 --json`): p50 163 ms, p95 235 ms
(min 128 ms, max 517 ms). Requests were served from EU colos (LHR, CDG, AMS).
Acceptance (p95 ≤ 60 s) passes. The test worker's Analytics Engine binding wrote
to the shared `dropway_hits` dataset; filter by worker name when reading it.

Cache probe: no `cf-cache-status` header is present on `*.workers.dev` responses.
The Cache API is internal to the Workers runtime, not the CDN cache, so there is
nothing to emit that header. Repeat reads of the same file from the same colo return
identical bytes and ETag (`cache-control: immutable` on fingerprinted assets); by
construction the edge cache is consulted before R2, which is not externally
observable. Cross-colo propagation of a new version was observed within seconds:
immediately after a publish one colo served the new version while another still
served the previous one, converging on the next reads.

## Upgrades, backups, removal

- **Upgrade**: pull the latest code (or sync your copy on GitHub), then `npm run deploy` (pushing
  your copy does this through Workers Builds). Migrations are additive and run before the new code.
- **Backups**: D1 Time Travel restores the database to any minute in the last 30 days (7 on the free
  plan). R2 objects are immutable and named by their SHA-256. The full procedure — per-binding
  backup commands, numbered restore order, what is not recoverable, and cadence — is the
  [backup and restore runbook](BACKUP.md).
- **Removal**: delete the Worker(s), the D1 database, the R2 bucket and the KV namespace in the dashboard.

## Verify a deployment

```sh
npx kofra whoami --api https://<worker>          # instance reachable, key accepted
curl -s https://<worker>/openapi.json | head -c 200  # the API describes itself
```
