import { defineConfig } from "vitest/config";

// Node-side tests for @dropway/client: the generator, the fetch-only runtime
// (against stub fetch) and the npm publish configuration. End-to-end behaviour
// against the real Worker lives in /test/typed-client.test.ts (workerd).
export default defineConfig({
  test: {
    name: "client",
    root: new URL(".", import.meta.url).pathname,
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
