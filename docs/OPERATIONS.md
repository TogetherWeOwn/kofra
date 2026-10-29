# Operations

Use Zod 4.6.7 or later in your embedding app; `@dropway/server` declares it as a
peer so operation schemas and the server share the same Zod type identity.

`defineOperation()` is the public API extension boundary. One definition supplies
REST, OpenAPI 3.1, an MCP tool, the CLI command table, the `@dropway/client`
typed method and agent discovery text. Regenerate the client after changing an
operation (`npm run client:generate`); CI fails when it is stale.
Business logic still belongs in a service taking `DropwayContext` and `Principal`.

```ts
import { z } from "zod";
import { createDropway, defineOperation } from "@dropway/server";

const echo = defineOperation({
  id: "echo_message",
  toolset: "diagnostics",
  method: "POST",
  path: "/api/v1/echo",
  aliases: [{ method: "PUT", path: "/api/v1/old-echo" }],
  scopes: ["sites:read"],
  summary: "Echo a message",
  description: "Check this instance's integration. Returns the message unchanged. Send a nonempty message; this does not publish a site.",
  input: z.object({ message: z.string().min(1).max(40) }),
  output: z.object({ message: z.string() }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  cli: { command: ["diagnostics", "echo"], positional: ["message"] },
  examples: [{ input: { message: "hello" }, output: { message: "hello" } }],
  async handler(input, ctx) {
    // A real capability calls its service here with ctx.dw and ctx.principal.
    return { message: input.message };
  },
});

export default createDropway({ operations: [echo] });
```

The resolved handler context also contains the original `request`, `client`
(`X-Kofra-Client` or MCP clientInfo), `idempotencyKey`, and the optional
`transport` (`rest` or `mcp`) for attribution. Services must still
check resource ownership and site restrictions: a scope is not permission to
access somebody else's site. Throw `ApiError` with a stable snake_case code and
remediation hint; both transports preserve it.

## Binding and validation

- GET input combines path parameters and query parameters. Numeric and boolean
  path/query values, including nullable scalars, are decoded according to the Zod
  schema; invalid scalar text is rejected, not coerced to zero or false. JSON
  methods combine the body with URL parameters without coercing JSON values;
  a body cannot override a path-selected resource.
- Generated JSON routes accept at most 8 MiB of wire bytes by default. Set a
  positive integer `jsonBodyMaxBytes` on an operation for a different finite
  budget. The reader checks Content-Length and actual streamed bytes before
  decoding/parsing, cancels overflow and returns `413 request_too_large`.
  Use upload links instead of putting large file bytes in JSON. Legacy metadata
  adapters using `readJson()` use the same default; raw uploads keep their own
  streaming reader and existing limits. `apiMiddleware` may inspect the body
  through Hono's `c.req.json()`, `text()` or `arrayBuffer()` before `next()`;
  the reader reuses that cache and checks the reconstructed bytes against the
  same budget. Trusted middleware owns any buffering it performs before dispatch;
  the generated reader cannot retroactively bound that allocation. Unread bodies
  are still counted and cancelled as they stream, without cloning or teeing them.
- Zod validates inputs and applies defaults before dispatch. Operation output is
  validated, then normalized to JSON for both transports.
- Definitions must use flat object input/output schemas. Keep summaries at most
  80 characters and descriptions below 4,096. Include useful successful examples.
- Required scopes are enforced before dispatch, including custom `http.handler`
  adapters, and before cached replay. A claim token has only
  `sites:read`/`sites:write`, never key or member administration; site services
  must still enforce its one-site restriction. Anonymous access is opt-in.
  Public metadata also accepts the bootstrap credential. REST-only setup and
  recovery explicitly use `bootstrap: true`, rejecting every other principal.
- A `rawBody: true` operation leaves the Request body untouched for the handler;
  its default OpenAPI body type is `application/octet-stream`. It needs an MCP
  exclusion reason. Put non-body input in its path/query schema. Raw operations
  cannot use generated `tool.idempotent` replay: path/query input alone cannot
  identify the bytes. A custom HTTP adapter must own any raw retry contract.
- For declarative destructive confirmation, set `confirm: "name"` (or `slug`,
  `email`, `domain`) and include required string `confirm` and target fields in
  the input schema. Both generated transports reject a mismatch before execution.
  Legacy REST destructive routes otherwise retain their original wire contract.
  Version deletion is an explicit breaking exception: HTTP
  `DELETE /api/v1/sites/{slug}/versions/{id}` requires a JSON body
  `{"confirm":"<canonical-site-slug>"}`. Its compatibility handler resolves the
  site before comparing confirmation, so an ID/URL reference is not itself a
  valid confirmation value. CLI, dashboard and generated SDK callers send the
  same field; missing input fails schema validation and a mismatch returns
  `confirm_mismatch` before any deletion.
- An operation appears as an MCP tool unless `mcp: { exclude: "reason" }` is set.
  Raw request-body operations require an exclusion. `mcp.alwaysLoad` is available
  for essential tools. Tool filtering and the existing MCP idempotency behavior
  remain in the endpoint. Generic REST operations marked `tool.idempotent` use
  the same replay service with `Idempotency-Key`, a REST-specific namespace and
  any declared `tool.redactForReplay` secret redaction. Member replay identity
  includes the tenant, member, credential id, site restriction, role, sorted
  scopes and authentication method. Changing credentials or authorization runs
  the service again, never returns a more privileged credential's saved result.
  Pre-hardening member replay records are no longer read and expire normally
  after 24 hours; retries spanning this upgrade may execute again. Claims remain
  scoped to the single anonymous site they control.

## Discovery and compatibility

`dropway.operations` is instance-local. Later definitions replace by id without
changing tool order. Duplicate method/path registrations are rejected. Existing
`routes` overrides run first; `mcpTools` remains a compatibility escape hatch.

`GET /api/v1/operations` is public metadata, not an authorization grant. Each row
contains `id`, `method`, `path`, `scopes`, a JSON `inputSchema`, and optional `cli`
metadata. No handlers, Zod internals, credentials or tenant data are returned.
`kofra api METHOD PATH` remains the escape hatch for operations without a
convenience CLI command. `kofra operations [id] [--schema]` inspects this same
catalog without executing anything.

Core definitions live in `packages/server/src/operations/`, with stable order in
`core.ts`. Existing REST clients keep their original payloads/statuses through
explicit `http` compatibility adapters on those definitions; those adapters call
the original core services and own no business rules. A custom `http.handler`
replaces generated parsing, output validation and retry handling, not shared
principal/scope authorization. `tool.idempotent` and `jsonBodyMaxBytes` do not
wrap custom adapters: the adapter must explicitly call `withIdempotency()` with
an appropriate payload identity or `readJson(c, maxBytes)` with its chosen
budget. New definitions should not need adapters. Notably:

- `POST /api/v1/publish` still supports multipart, raw, zip and legacy JSON.
  `POST /api/v1/publish-sources` exposes the model-friendly `publish_site` input.
- `GET /api/v1/sites/{slug}/files/{path}` still streams raw bytes with safe headers,
  ETags and HEAD handling. `GET /api/v1/read-file` exposes the paged JSON
  `read_file` operation.
- Member/key endpoints and site/version management retain their existing paths.
  Bootstrap setup remains REST-only. Old aliases such as `/accounts` and blob
  POST still work and are documented as deprecated aliases.

### Version-action replay

Restore (`POST /sites/{slug}/versions/{id}/restore`) and version delete
(`DELETE /sites/{slug}/versions/{id}` with canonical-slug `confirm`) accept an
optional REST `Idempotency-Key`; their MCP tools accept `idempotencyKey`.
Keys are 1–255 printable ASCII characters without spaces. An explicitly empty key
is rejected; omitting the key remains compatible but has no result-replay guarantee.

Core services authorize the current credential/site and validate delete confirmation
before consulting replay. The input hash binds the authorized immutable site ID,
the original submitted version reference and, for deletion, confirmation. The key
is scoped to the credential's current restrictions and operation; REST and MCP
have independent namespaces. No target is re-resolved on a completed replay, even
when it has since been deleted or `live`/a number now names something different.
The original result is returned with `replayed: true`; current URLs/pointers do not
replace the stored receipt. Another site's acquisition of an old slug cannot replay
its previous holder's result.

Changed input under the same key returns 422 `idempotency_key_reused`. Concurrent
or unknown outcomes return 409 `idempotency_in_progress`, without another action.
These workflows opt into `withIdempotency`'s `retainOnError`: callback errors leave
the pending claim intact, since a D1 response or post-commit cache refresh can fail
after the mutation. Result-persistence failure preserves the first successful
response and its pending claim, rather than permitting re-execution. Other services
retain their existing claim-release behavior by default.

Records expire after 24 hours (completed-result retention starts on completion).
After expiry a key may be reclaimed; this is not unlimited exactly-once execution.
Never infer a replay receipt from a later 404 or live-pointer read. CLI and dashboard
version actions generate a new UUID per deliberate invocation/click, do not persist
it, and never auto-retry; a later action is fresh intent. Typed SDK actions also
never auto-retry and can carry a caller-retained key. In particular, 429 is surfaced,
not presumed to prove a pre-effect refusal.

Run `npm run check` and `npm run openapi:lint`. CI validates the emitted OpenAPI
3.1 document with Redocly and requires ids, summaries, descriptions, successful
examples and JSON error responses. Browser/discovery routes are documented
separately in `page-openapi.ts`; they are not API operations.
