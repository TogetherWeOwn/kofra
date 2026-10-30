import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { DropwayClient, type DeleteVersionInput } from "../src/index.ts";

it("the published DeleteVersionInput requires a string confirmation", () => {
  // Compile a consumer in memory against the checked-in SDK, not a mocked schema
  // or a regenerated client. The positive and negative cases fail independently.
  const filename = fileURLToPath(new URL("./delete-version-consumer.virtual.ts", import.meta.url));
  const source = [
    'import type { DeleteVersionInput } from "../src/index.ts";',
    'const good: DeleteVersionInput = { slug: "canonical-site", id: "ver_old", confirm: "canonical-site" };',
    'const missing: DeleteVersionInput = { slug: "canonical-site", id: "ver_old" };',
    'const wrong: DeleteVersionInput = { slug: "canonical-site", id: "ver_old", confirm: 42 };',
  ].join("\n");
  const options: ts.CompilerOptions = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = name => name === filename ? source : read(name);
  host.fileExists = name => name === filename || exists(name);
  const program = ts.createProgram([filename], options, host);
  const file = program.getSourceFile(filename)!;
  const diagnostics = program.getSemanticDiagnostics(file);
  const onLine = (line: number) => diagnostics.filter(d => d.start !== undefined && file.getLineAndCharacterOfPosition(d.start).line === line - 1);
  expect(onLine(2), "a string confirmation is accepted").toEqual([]);
  expect(onLine(3), "omitting confirmation is a type error").not.toEqual([]);
  expect(onLine(4), "a non-string confirmation is a type error").not.toEqual([]);
});

it("deleteVersion serializes confirmation on the actual DELETE", async () => {
  const requests: Request[] = [];
  const client = new DropwayClient({ api: "https://sdk-fixture.example", token: null, fetch: async request => {
    requests.push(request);
    return new Response(JSON.stringify({ deleted: true, id: "ver_old" }), { headers: { "Content-Type": "application/json" } });
  } });
  // Intersection keeps this test runnable before the generated interface is updated.
  const input: DeleteVersionInput & { confirm: string } = { slug: "canonical-site", id: "ver_old", confirm: "canonical-site" };
  expect(await client.deleteVersion(input)).toMatchObject({ deleted: true, id: "ver_old" });
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  const url = new URL(request.url);
  expect(request.method).toBe("DELETE");
  expect(url.pathname).toBe("/api/v1/sites/canonical-site/versions/ver_old");
  const text = await request.text();
  const query = url.searchParams.get("confirm");
  const body = text ? JSON.parse(text).confirm : null;
  expect(query ?? body).toBe("canonical-site");
  if (query && body) expect(body).toBe(query);
});
