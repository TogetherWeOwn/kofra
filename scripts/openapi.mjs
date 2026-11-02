import { build } from "esbuild";

// Use the public generator without importing a Worker entry point or making network calls.
const bundle = await build({
  stdin: {
    contents: 'export { buildOpenApi } from "./packages/server/src/openapi.ts";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  logLevel: "warning",
});
const { buildOpenApi } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
process.stdout.write(`${JSON.stringify(buildOpenApi("https://kofra.example", "Kofra"), null, 2)}\n`);
