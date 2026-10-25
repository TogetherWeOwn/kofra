import { build } from "esbuild";

const bundle = await build({
  stdin: { contents: 'export { errorCatalogMarkdown } from "./packages/core/src/error-codes.ts";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true, write: false, platform: "node", format: "esm", logLevel: "warning",
});
const { errorCatalogMarkdown } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

process.stdout.write(errorCatalogMarkdown());
