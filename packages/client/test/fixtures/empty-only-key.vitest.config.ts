import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.config.ts";

// Negative control: mutate only Vite's in-memory module, never the source file.
const target = new URL("../../src/http.ts", import.meta.url).pathname;
const guard = String.raw`if (key !== undefined && (typeof key !== "string" || key.length === 0 || key.length > 255 || /[^\x21-\x7e]/.test(key))) {`;

export default mergeConfig(base, defineConfig({
  plugins: [{
    name: "empty-only-idempotency-key-mutant",
    enforce: "pre",
    transform(source, id) {
      if (id.split("?")[0] !== target) return;
      if (source.split(guard).length !== 2) throw new Error("Empty-only key mutant is stale: expected exactly one validator guard.");
      console.warn('[empty-only key mutant] replaced the SDK format guard with: if (key === "")');
      return { code: source.replace(guard, 'if (key === "") {'), map: null };
    },
  }],
}));
