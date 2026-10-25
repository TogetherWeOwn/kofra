import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const bundle = await build({
  entryPoints: ["packages/core/src/error-codes.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  logLevel: "warning",
});
const { errorCatalogMarkdown } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const markdown = errorCatalogMarkdown();
const path = "docs/errors.md";
if (process.argv.includes("--check")) {
  const current = await readFile(path, "utf8").catch(() => "");
  if (current !== markdown) {
    console.error("docs/errors.md is stale; run npm run errors:sync.");
    process.exitCode = 1;
  }
} else {
  await writeFile(path, markdown);
}
