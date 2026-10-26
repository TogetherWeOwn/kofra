<!-- Generated from packages/core/src/error-codes.ts. Run npm run errors:sync. -->
# Error codes

Errors include code, message, hint, retryable, retryAfterSeconds, docs, next and optional details.
Manifest and operation-schema validation list bad fields in details.fields as {path, message} entries.
Source-structure validation retains {field, problem} entries; paths may use dotted or bracketed array indexes.
Legacy semantic validators retain their stable codes. Retry-After matches the top-level retryAfterSeconds on HTTP 429/503.
Legacy details.retryable and details.retryAfterSeconds remain for existing clients when supplied.
Version conflicts include liveVersionId, liveVersionNumber, liveVersionClient and liveVersionAt (epoch milliseconds).
Partial-update conflicts also retain optional yourBase, yourBaseNumber and liveClient fields.
A missing delay on 429/503 defaults to one second. Other errors have a null delay unless supplied.
Follow next calls to reconcile conflicts; retryable does not authorize replaying a changed request.
Delivery unlock throttles use rate_limited (429); invalid operation shapes use invalid_request (400), and permanent slug reservations use slug_taken (409).
slug_reserved is 400 for a reserved system label, or 409 for a freed name held for its previous tenant until details.holdUntil. Only the holding tenant may reclaim before then.
A delivery takedown response never includes its private reason.
Extension adapters can add codes and override guidance without changing built-in codes; unknown codes link to the catalog root unless docs is supplied.

| Code | HTTP status | Retryable | Hint |
| --- | --- | --- | --- |
| `already_claimed` | 409 | false | Access the site using its owning account's API key rather than claiming it again. |
| `already_set_up` | 409 | false | Use the owner's API key; if lost, call /api/v1/setup/recover with the bootstrap key. |
| `anonymous_publish_disabled` | 401 | false | Send Authorization: Bearer dw_... with an API key from the instance owner. |
| `api_key_expired` | 401 | false | Ask the instance owner to create a new API key. |
| `blob_missing` | 502 | true | Retry shortly; report the requestId if the contents remain unavailable. |
| `blob_not_expected` | 404 | false | Create a pending deploy first, then upload only the SHA-256 values it reports as missing. |
| `bootstrap_key_required` | 403 | false | Send the bootstrap key in Authorization: Bearer for setup or recovery only. |
| `claim_token_required` | 400 | false | Send the claimToken returned when the anonymous site was created. |
| `confirm_mismatch` | 400 | false | Set confirm to the exact value in details.expected, then call again. |
| `deploy_not_found` | 404 | false | Start a version with POST /api/v1/sites/:slug/versions (alias: /deploys), or use a returned version ID. |
| `duplicate_path` | 400 | false | Give each file a unique normalized path; remove duplicate entries. |
| `empty_body` | 400 | false | Send files as multipart, JSON, a .zip, or one raw file. |
| `export_too_large` | 413 | false | Download file by file with list_files and read_file. |
| `export_too_many_files` | 413 | false | Download file by file with list_files and read_file. |
| `feature_unavailable` | 501 | false | Use a supported alternative; for access modes, use password instead of private or restricted. |
| `fetch_blocked` | 422 | false | Use a public absolute HTTPS URL, or provide bytes inline or by upload instead. |
| `fetch_failed` | 422 | false | Check public reachability and credentials, use the final URL, or send bytes another way. |
| `file_not_found` | 404 | false | List files for the selected site/version and use an existing path. |
| `file_too_large` | 413 | false | Compress or split the file to fit the per-file limit; for a fetch cap, use SHA-256/size and an upload link. |
| `files_required` | 400 | false | Send a non-empty files array; keep at least one file, or delete the whole site instead. |
| `folder_not_found` | 404 | false | List your folders and retry. |
| `forbidden` | 403 | false | Use a member API key authorized for this action; claim tokens control only their own site. |
| `hash_mismatch` | 400 | false | Upload the exact file bytes matching the declared SHA-256; do not re-encode or compress them. |
| `idempotency_in_progress` | 409 | true | Retry the same request with the same key in a second or two. |
| `idempotency_key_reused` | 422 | false | Use a new key for a new request; reuse a key only for the exact same input. |
| `inline_too_large` | 413 | false | Use a URL source or SHA-256/size with an upload link; local directories can use the CLI. |
| `insufficient_scope` | 403 | false | Use a member API key with the required scopes; ask the instance owner to create one. |
| `internal_error` | 500 | true | Retry once; report the requestId to the instance operator if it repeats. |
| `invalid_access_mode` | 400 | false | Use public or password access; password mode also needs a password. |
| `invalid_api_key` | 401 | false | Ask the instance owner for a valid API key; API keys start with dw_. |
| `invalid_authorization` | 401 | false | Send Authorization: Bearer <token>, using an API key or applicable claim token. |
| `invalid_base64` | 400 | false | Encode the file bytes as valid base64 and set encoding to base64. |
| `invalid_claim_token` | 401 | false | Anonymous sites expire; publish again to obtain a new site and claim token. |
| `invalid_cursor` | 400 | false | Pass the nextCursor value returned by the previous page. |
| `invalid_email` | 400 | false | Send a valid email address, such as person@example.com, or omit the optional field. |
| `invalid_encoding` | 400 | false | Use auto, text or base64 for file reads. |
| `invalid_expiry` | 400 | false | Set expiresInDays to a positive finite number, or omit it. |
| `invalid_field` | 400 | false | Send the named settings field as true or false. |
| `invalid_file` | 400 | false | Give each JSON publish file string content; use encoding:base64 for binary bytes. |
| `invalid_idempotency_key` | 400 | false | Use a fresh UUID per logical operation; reuse it only when retrying the same request. |
| `invalid_json` | 400 | false | Send valid JSON with an object body and Content-Type: application/json. |
| `invalid_manifest` | 400 | false | Give each manifest entry an object containing path, size and sha256. |
| `invalid_operation_output` | 500 | false | Report the requestId to the instance operator. |
| `invalid_part` | 400 | false | Use a one-based part number the session expects and send exactly that part's bytes with Content-Length. |
| `invalid_password` | 400 | false | Use a password of 4–200 characters; use null to remove password protection. |
| `invalid_path` | 400 | false | Use a non-empty site-relative path of at most 1,024 characters, without .. or control characters. |
| `invalid_policy_quota` | 500 | false | Ask the instance administrator to return null or a non-negative integer. |
| `invalid_range` | 400 | false | Use an offset no greater than the file size; use nextOffset from the preceding read. |
| `invalid_request` | 400 | false | Correct every listed field in details.fields and retry; consult /openapi.json for the input schema. |
| `invalid_role` | 400 | false | Use owner, admin or member. |
| `invalid_scope` | 400 | false | Request valid scopes: sites:read, sites:write, keys:write, members:write, or * for all grantable scopes. |
| `invalid_sha256` | 400 | false | Compute the file's 64-character hexadecimal SHA-256 using sha256sum or shasum -a 256. |
| `invalid_site` | 400 | false | Use a site slug, site ID or a URL returned by this instance; list sites to find valid references. |
| `invalid_size` | 400 | false | Set size to the file's non-negative integer byte length. |
| `invalid_slug` | 400 | false | Use 3–56 lowercase letters, digits and single hyphens, starting and ending with a letter or digit. |
| `invalid_transfer` | 400 | false | Correct the delivery fields and retry. |
| `invalid_transfer_expiry` | 400 | false | Choose a deadline from one hour to the effective expiry ceiling. |
| `invalid_transfer_password` | 400 | false | Use 8-1,024 characters without NUL, or empty for no password. |
| `invalid_transfer_range` | 416 | false | Request one satisfiable byte range. |
| `invalid_zip` | 400 | false | Send a standard .zip using deflate or stored entries. |
| `key_limit` | 409 | false | Revoke unused keys with DELETE /api/v1/keys/:id. |
| `key_not_found` | 404 | false | List revocable keys with GET /api/v1/keys. |
| `key_site_restricted` | 403 | false | Use a key without a single-site restriction to create additional sites. |
| `last_owner` | 409 | false | Make another active member an owner before removing or demoting this owner. |
| `length_required` | 411 | false | Send Content-Length and raw file bytes, without multipart or chunked encoding. |
| `limit_reached` | 403 | false | Remove unused resources or ask the instance administrator to change the configured limit. |
| `mcp_not_enabled` | 501 | false | Use the REST API (see /openapi.json) or update the instance. |
| `member_exists` | 409 | false | List members and use or update the existing member instead. |
| `member_not_found` | 404 | false | List active members with GET /api/v1/members. |
| `missing_blobs` | 409 | false | PUT missing files' raw bytes to their upload URLs with the same credential, then finalize again. |
| `not_available` | 403 | false | Use the instance's supported owner recovery process. |
| `not_set_up` | 404 | false | Call POST /api/v1/setup with the bootstrap key first. |
| `part_conflict` | 409 | false | This part was already acknowledged with different bytes; start a new upload session to change it. |
| `password_required` | 400 | false | Call again with a password of 4–200 characters. |
| `path_required` | 400 | false | Add a path query parameter or X-Kofra-Path header to name the raw file. |
| `rate_limited` | 429 | true | Wait retryAfterSeconds before retrying; update an existing anonymous site using its claim token. |
| `reason_required` | 400 | false | Provide a non-empty reason for releasing the held name, such as a trademark dispute reference. |
| `request_too_large` | 413 | false | Split the request or use manifest/upload/finalize instead of embedding file bytes. |
| `route_not_found` | 404 | false | See /openapi.json for supported methods and endpoints. |
| `scope_not_grantable` | 403 | false | Request only scopes held by both the caller and the target member's role. |
| `site_changed` | 409 | false | Reload the site, reconcile the change, and retry manually. |
| `site_not_found` | 404 | false | List sites with GET /api/v1/sites using the intended owner's credential. |
| `site_too_large` | 413 | false | Split the content across several sites. |
| `size_mismatch` | 400 | false | Recheck the file bytes, manifest size and Content-Length; send the raw file body. |
| `slug_generation_failed` | 503 | true | Retry the request after the indicated delay. |
| `slug_not_held` | 404 | false | Only active held names need release; live, expired, released and never-used names need no release. |
| `slug_reserved` | 400 | false | Pick another name, or omit the slug to get a generated one. For a freed name held for its previous tenant (409), only that tenant may reclaim before details.holdUntil; otherwise wait until the hold ends. |
| `slug_taken` | 409 | false | Pick another slug, or omit it when creating a site to get a generated name. |
| `temporarily_unavailable` | 503 | true | Retry the request after the indicated delay. |
| `tenant_not_found` | 404 | false | Check the tenant associated with the credential; ask the instance operator if it is missing. |
| `too_many_files` | 400 | false | Split content across sites or trim build output; never silently drop files. |
| `transfer_conflict` | 409 | false | Read the transfer again; closed or notified deliveries cannot be edited. |
| `transfer_download_required` | 403 | false | Use the transfer page's sites-host download links. |
| `transfer_gone` | 410 | false | Ask the sender for a new delivery. |
| `transfer_immutable` | 409 | false | Use transfer operations, or create a new delivery for changed files. |
| `transfer_locked` | 403 | false | Unlock the delivery on its app-origin page. |
| `transfer_not_found` | 404 | false | Check the reference and use its sender's key. |
| `transfer_origin_required` | 409 | false | Configure a separate sites origin. |
| `transfer_password_proof_required` | 403 | false | Send currentPassword together with the new password. |
| `transfer_unavailable` | 451 | false | Contact the sender. |
| `transfer_unlock_unavailable` | 503 | true | Retry later. |
| `unauthorized` | 401 | false | Send Authorization: Bearer dw_...; the instance owner creates keys through /api/v1/keys or /api/v1/members. |
| `upload_closed` | 409 | false | Start a new upload session for this pending version; a finished or failed session accepts no parts. |
| `upload_expired` | 410 | false | Publish again for fresh upload links; stored files are reused. |
| `upload_incomplete` | 409 | false | PUT every missing part the session lists, then call complete again. |
| `upload_not_found` | 404 | false | Start a resumable upload with POST /api/v1/uploads and use the returned upload id. |
| `version_conflict` | 409 | false | Call get_site, reconcile the change, and retry using its live version ID as baseVersionId. |
| `version_is_live` | 409 | false | Restore or publish another version before deleting this one. |
| `version_not_found` | 404 | false | List versions for the site; if there is no live version yet, publish files first. |
| `zip_too_large` | 413 | false | Use the manifest flow for bigger sites, while respecting file/site limits. |
