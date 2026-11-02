import { defineConfig } from "vitest/config";

// Node-side tests for code that runs in the visitor's browser, not in the Worker
// (the Workers test runtime cannot evaluate scripts). Everything else in
// @kofra/server is tested in the Workers runtime from /test.
export default defineConfig({
  test: {
    name: "server-node",
    root: new URL(".", import.meta.url).pathname,
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
