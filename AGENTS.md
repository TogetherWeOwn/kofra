# Notes for coding agents

Read `docs/ARCHITECTURE.md` first. The short version:

- Business logic goes in `packages/core/src/services/*.ts`. Routes (REST in
  `packages/server/src/routes/api.ts`), MCP tools and UI handlers stay thin and
  call those services with `c.get("dw")` and the caller's `Principal`.
- Throw `ApiError` with a stable snake_case `code` and a `hint`.
- This repo is the single-tenant open-source product. Do not add plans, prices,
  billing, payment code, signup or usage quotas here; hosted features plug in
  through `createDropway()` options from outside.
- New file viewers go in `packages/server/src/viewers/` and are registered in `VIEWERS`.
- Never edit an applied migration; add a new numbered file in `packages/core/migrations/`.
- The CLI (`packages/cli`) runs on Node, not Workers: keep `src/publish.ts` and `src/client.ts`
  fetch-only, and keep `src/` erasable TypeScript (no enums, namespaces or parameter properties).
- `scripts/guard-open-core.mjs` fails CI on billing/pricing/payment code, payment SDKs or anything
  from a hosted layer. Do not work around it; an unrelated word match goes in
  `scripts/open-core-allowlist.txt` with a reason.
- Before committing: `npm run check` (guard, typecheck, all tests).
- Cloudflare test deploys go through the `cf-test-env` plugin only: `provision`
  a per-card disposable `pct-*` env, test against its short-lived per-Worker
  token, then `teardown`. D1 goes through `d1_execute`. Never deploy, `secret
  put`, or otherwise touch Cloudflare with the root `wrangler.jsonc` (worker
  names collide with hosted Kofra on the same account, and standing credentials
  can touch production). R2 object writes use wrangler/S3 paths, not raw REST.
- PRs follow the org contract in `TogetherWeOwn/.github` CONTRIBUTING + this repo's overrides; the PR template's Attestation is mandatory.
