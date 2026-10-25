# @dropway/client

Typed REST client for [Kofra](https://github.com/TogetherWeOwn/kofra), generated from the operation registry. Fetch-only with zero dependencies. Like the core and server packages, this package ships TypeScript source: use a bundler (esbuild, wrangler or Vite) targeting Node 20+, Cloudflare Workers or browsers. Plain Node imports from `node_modules` are not supported, including on Node versions with native type stripping. The `kofra` CLI bundles this package into its JavaScript executable.

```ts
import { DropwayClient } from "@dropway/client";

const client = new DropwayClient({ api: "https://kofra.example.workers.dev", token: "dw_..." });

const me = await client.whoami();
const site = await client.createSite({ slug: "hello" });
const bytes = await client.getFileBytes({ slug: "hello", path: "index.html" });
```

Every method mirrors one registry operation (`OPERATIONS` holds the table), so the client, the OpenAPI document, the MCP tools and the CLI stay in step. Failures throw `DropwayError` with the server's stable `code`, `message`, `hint`, `details`, HTTP `status` and a `retryable` flag.

Regenerate after registry changes: `npm run client:generate`.
