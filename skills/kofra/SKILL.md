---
name: kofra
description: Publish files, folders and static sites to a live URL with Kofra, then update, version, roll back and share them. Use when the user wants to publish, host, share, deploy or preview HTML pages, Markdown docs, reports, images, PDFs, demos or a built web app, or to change, check or roll back something already on Kofra.
license: MIT
metadata:
  homepage: https://github.com/TogetherWeOwn/dropway
---

# Kofra

Kofra turns files into a live URL. Every publish is an immutable version you can roll back. People opening a site get the right view for each file (HTML runs as a real page, Markdown is rendered, images, PDFs and code are displayed) and `?raw=1` on any file URL returns the raw bytes.

## Connect

- Instance: `$KOFRA_URL` (the app origin, for example `https://dropway.<account>.workers.dev`). API key: `$KOFRA_API_KEY` (starts with `dw_`; the instance owner creates keys). If either is missing, ask the user.
- `$KOFRA_URL/skill.md` serves this skill with the instance's own URLs and settings filled in.
- MCP (preferred when your client supports remote MCP): `$KOFRA_URL/mcp` with header `Authorization: Bearer $KOFRA_API_KEY`.
  Claude Code: `claude mcp add --transport http kofra $KOFRA_URL/mcp --header "Authorization: Bearer $KOFRA_API_KEY"`
- REST with curl works everywhere: `$KOFRA_URL/api/v1`, same header. Full reference: `$KOFRA_URL/llms-full.txt`, OpenAPI: `$KOFRA_URL/openapi.json`.

## Publish

MCP: `publish_site` with `files`, each `{ path, content }` (text; base64 only for small binaries), `{ path, url }` (the server downloads a public https file), `{ path, sha256, size }` (then PUT the bytes to the returned upload link and call `finalize_version`), `{ path, copyFrom }` or a chat attachment `{ download_url, file_name }`; or `archiveUrl` alone for a public https .zip.

REST, one call (form field name = file path):

```sh
curl -fsS $KOFRA_URL/api/v1/publish -H "Authorization: Bearer $KOFRA_API_KEY" \
  -F "index.html=@index.html" -F "assets/app.js=@assets/app.js"
```

A built folder: `(cd dist && zip -qr ../site.zip .) && curl -fsS $KOFRA_URL/api/v1/publish -H "Authorization: Bearer $KOFRA_API_KEY" -H "Content-Type: application/zip" --data-binary @site.zip`

Publish to the same site again with `-F slug=<slug>` (REST) or `site: "<slug>"` (MCP). Identical content returns `unchanged` and creates no version.

## Change, check, roll back

- Change a few files: `update_site_files` (MCP) or `PATCH $KOFRA_URL/api/v1/sites/<slug>/files` with `files`, `delete`, `move`, and `baseVersionId` from your last result. `version_conflict` means someone published since: re-read, re-apply, retry.
- Check your work: `list_files`, `read_file`, or fetch the returned `url`.
- Roll back: `list_versions`, then `restore_version` with `"v3"`.
- Settings: `update_site_settings` (title, description, spa, renderMarkdown, crossOriginIsolation). Password: `set_site_access`.

## Rules

1. Share the `url` from the response exactly as returned. Never build site URLs yourself.
2. Put `index.html` (or `index.md` / `README.md`) at the root so the URL opens a page.
3. Use relative links inside a site (`assets/app.js`, not `/assets/app.js`) so it works on every instance.
4. Keep big or binary files out of the conversation: use url sources or the upload links, not base64.
5. Never publish secrets (.env files, keys, tokens). If one slipped out, publish a fixed version and delete the bad one with `delete_version`.
6. Retrying a write? Reuse the same `idempotencyKey` (MCP) or `Idempotency-Key` header (REST).
7. Errors carry `code`, `message` and `hint`: follow the hint. Destructive tools need `confirm` set to the slug.
