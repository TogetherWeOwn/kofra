# Live-version badge

Every public site serves a small flat SVG at `<site URL>badge.svg` that names its live
version and how recently that version went live. Paste it into a README or any page:

```markdown
[![kofra](https://<your-site-address>/badge.svg)](https://<your-site-address>/)
```

The dashboard site page shows this snippet with your site's real address, a preview and a
Copy button. It appears for public sites only. The address is the site URL the API returns
plus `badge.svg`, so it works the same in subdomain and path mode.

## What it shows

- `kofra | v3 · 2 h ago`: the live version number and a coarse age (`just now`, `N min ago`,
  `N h ago`, `N d ago`). Never an exact time. A restore shows the restored version and its
  original age.
- `kofra | not available`: one identical image for every other state: password-protected,
  expired, deleted, transfer, never published, renamed away, or nothing live yet. The bytes and
  headers match, so the badge cannot be used to probe a site's state.

## Behavior

- `200`, `Content-Type: image/svg+xml`, `X-Content-Type-Options: nosniff`,
  `Cache-Control: public, max-age=300`. A republish shows within five minutes in browsers and
  immediately on the next uncached read.
- Static markup with escaped text; no script and no external references. Readable at 20px.
- Read-only and public: it ignores cookies, keys and `Authorization`, and sets no cookie.
- Read path: the cached live manifest the site is already served from (memory, then KV, then one
  D1 rebuild on a miss). No new table, binding, scan or R2 read. Transfer sites are recognized by
  the same single D1 check every site request already makes, and the badge never reaches the
  transfer handler, so it cannot count a download.
- Badge reads are not recorded as site requests: no analytics point, usage meter or request hook.

## Reserved path

`badge.svg` at a site root is reserved for the badge. A published file with that exact path is
stored and listed but not served at that address (`docs/badge.svg` and other nested paths are
unaffected).
