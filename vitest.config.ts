import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Test-only bindings: migrations to apply, and a known bootstrap secret.
          TEST_MIGRATIONS: await readD1Migrations(`${root}packages/core/migrations`),
          ADMIN_BOOTSTRAP_KEY: "test-bootstrap-secret-0123456789",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // The first test in each file pays for a cold Workers runtime start, and so
    // does the per-test fixture: reset() wipes D1/R2/KV, migrations are replayed
    // and the owner is set up again. Hooks get the same budget as the tests they
    // prepare - the 10s default tripped test/serve.test.ts once on a loaded
    // runner while every test body was already green.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
