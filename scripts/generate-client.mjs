/**
 * Generate the typed REST client (`packages/client/src/generated.ts`) from the
 * operation registry (R-45, SPEC AX-13).
 *
 * The registry is the source of truth: every operation gets an input/output
 * interface plus a typed method on DropwayClient. Wire shapes follow the REST
 * transport (`http.input ?? input`, like the OpenAPI generator), not the MCP
 * transport. Raw-body operations keep their bytes:
 * - an operation returning octet-stream or ZIP reads bytes;
 * - a raw-body operation whose whole input is path parameters uploads bytes;
 * - any other raw-body operation (e.g. JSON publish) is a normal JSON call.
 *
 * Usage: node scripts/generate-client.mjs [--out <path>] [--check]
 * `--check` exits 1 when the checked-in file differs (used by CI and tests).
 *
 * The pure helpers (jsonSchemaToTs, emitClient, ...) are dependency-free so
 * tests can import this module anywhere, including the Workers runtime; esbuild
 * is loaded lazily by dumpOperations, which only the CLI entrypoint calls.
 */

export function toMethodName(id) {
  return id.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

export function toTypeName(id) {
  const camel = toMethodName(id);
  return camel.slice(0, 1).toUpperCase() + camel.slice(1);
}

const tsLiteral = (value) => JSON.stringify(value) ?? "unknown";

function unionOf(parts) {
  const unique = [...new Set(parts)];
  return unique.length === 1 ? unique[0] : unique.join(" | ");
}

function scalarTs(type) {
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      throw new Error(`Unsupported JSON schema type: ${JSON.stringify(type)}`);
  }
}

function commentFor(description, indent) {
  if (typeof description !== "string" || !description.trim()) return "";
  const safe = description.replace(/\*\//g, "*\\/");
  return `${indent}/** ${safe} */\n`;
}

/**
 * Convert one JSON-schema node to a TypeScript type expression. Covers exactly
 * the keywords the registry emits; anything else fails loudly so new schema
 * shapes get deliberate handling instead of silently wrong types.
 */
const UNSUPPORTED_KEYWORDS = ["$ref", "allOf", "not", "prefixItems", "patternProperties", "if", "then", "else"];

export function jsonSchemaToTs(schema, indent = "") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "unknown";
  for (const key of UNSUPPORTED_KEYWORDS) {
    if (schema[key] !== undefined) throw new Error(`Unsupported JSON schema keyword: ${key}`);
  }
  if (schema.const !== undefined) return tsLiteral(schema.const);
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) throw new Error("Unsupported JSON schema: empty enum");
    return unionOf(schema.enum.map(tsLiteral));
  }
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key])) {
      if (schema[key].length === 0) throw new Error(`Unsupported JSON schema: empty ${key}`);
      return unionOf(schema[key].map((s) => jsonSchemaToTs(s, indent)));
    }
  }
  if (Array.isArray(schema.type)) return unionOf(schema.type.map(scalarTs));
  if (schema.type === "array") {
    const item = schema.items ? jsonSchemaToTs(schema.items, indent) : "unknown";
    return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
  }
  if (schema.type !== undefined && schema.type !== "object") return scalarTs(schema.type);
  const properties = schema.properties && typeof schema.properties === "object" ? Object.entries(schema.properties) : [];
  const additional = schema.additionalProperties;
  if (properties.length === 0) {
    if (schema.type === undefined && additional === undefined) return "unknown";
    if (additional === false) return "Record<string, never>";
    if (additional !== undefined && additional !== true) return `Record<string, ${jsonSchemaToTs(additional, indent)}>`;
    return "Record<string, unknown>";
  }
  const inner = `${indent}  `;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const lines = [];
  for (const [name, prop] of properties) {
    const safe = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
    const optional = required.has(name) ? "" : "?";
    lines.push(`${commentFor(prop?.description, inner)}${inner}${safe}${optional}: ${jsonSchemaToTs(prop, inner)};`);
  }
  if (additional !== undefined && additional !== false) {
    lines.push(`${inner}[key: string]: ${additional === true ? "unknown" : jsonSchemaToTs(additional, inner)};`);
  }
  return `{\n${lines.join("\n")}\n${indent}}`;
}

export function emitInterface(name, schema) {
  const ts = jsonSchemaToTs(schema);
  if (!ts.startsWith("{") || Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    return `export type ${name} = ${ts};\n`;
  }
  return `export interface ${name} ${ts}\n`;
}

function isBytesOut(op) {
  return op.responseType === "application/octet-stream" || op.responseType === "application/zip";
}

function isBytesIn(op) {
  if (!op.rawBody || isBytesOut(op)) return false;
  // A raw-body operation whose whole input is path parameters (today: upload_blob)
  // takes its payload as bytes; one with body properties (today: publish_upload)
  // is a normal JSON call.
  const names = new Set([...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  const props = Object.keys(op.input?.properties ?? {});
  return props.length > 0 && props.every((p) => names.has(p));
}

/** Render the full generated.ts text for registry metadata rows. */
export function emitClient(operations) {
  const chunks = [];
  chunks.push("// DO NOT EDIT: generated from the operation registry by `npm run client:generate` (R-45).");
  chunks.push('import { DropwayHttpClient, type BytesResult, type CallOptions } from "./http.ts";');
  chunks.push("");
  for (const op of operations) {
    const type = toTypeName(op.id);
    chunks.push(emitInterface(`${type}Input`, op.input));
    chunks.push(emitInterface(`${type}Output`, op.output));
  }
  chunks.push("export const OPERATIONS = {");
  for (const op of operations) {
    chunks.push(
      `  ${JSON.stringify(op.id)}: { method: ${JSON.stringify(op.method)}, path: ${JSON.stringify(op.path)}, summary: ${JSON.stringify(op.summary)} },`,
    );
  }
  chunks.push("} as const;");
  chunks.push("");
  chunks.push("export type OperationId = keyof typeof OPERATIONS;");
  chunks.push("");
  chunks.push("export class DropwayClient extends DropwayHttpClient {");
  for (const op of operations) {
    const type = toTypeName(op.id);
    const method = toMethodName(op.id);
    const summary = op.summary.replace(/\*\//g, "*\\/");
    // A 429 on these mutations does not prove that no effect committed.
    const callOptions = op.id === "restore_version" || op.id === "delete_version" ? '{ ...opts, retry: "none" }' : "opts";
    const optionalInput = Object.keys(op.input?.properties ?? {}).length === 0;
    if (isBytesOut(op)) {
      chunks.push(`  /** ${summary} */`);
      chunks.push(`  async ${method}(input: ${type}Input, opts?: CallOptions): Promise<BytesResult> {`);
      chunks.push(`    return this.callBytes(OPERATIONS[${JSON.stringify(op.id)}], input, opts);`);
    } else if (isBytesIn(op)) {
      chunks.push(`  /** ${summary} */`);
      chunks.push(
        `  async ${method}(input: ${type}Input, body: Uint8Array | ArrayBuffer | Blob | string, opts?: CallOptions): Promise<${type}Output> {`,
      );
      chunks.push(
        `    return this.callRaw<${type}Input, ${type}Output>(OPERATIONS[${JSON.stringify(op.id)}], input, body, opts);`,
      );
    } else if (optionalInput) {
      chunks.push(`  /** ${summary} */`);
      chunks.push(`  async ${method}(input?: ${type}Input, opts?: CallOptions): Promise<${type}Output> {`);
      chunks.push(
        `    return this.call<${type}Input, ${type}Output>(OPERATIONS[${JSON.stringify(op.id)}], input ?? {}, opts);`,
      );
    } else {
      chunks.push(`  /** ${summary} */`);
      chunks.push(`  async ${method}(input: ${type}Input, opts?: CallOptions): Promise<${type}Output> {`);
      chunks.push(
        `    return this.call<${type}Input, ${type}Output>(OPERATIONS[${JSON.stringify(op.id)}], input, ${callOptions});`,
      );
    }
    chunks.push("  }");
  }
  chunks.push("}");
  chunks.push("");
  return chunks.join("\n");
}

async function dumpOperations() {
  const { build } = await import("esbuild");
  const bundle = await build({
    stdin: {
      contents: [
        'import { createOperationRegistry } from "./packages/server/src/operations/registry.ts";',
        'import { schemaJson } from "./packages/server/src/operations.ts";',
        "export function dumpOperations() {",
        "  return createOperationRegistry().map((op) => ({",
        "    id: op.id, method: op.method, path: op.path, summary: op.summary,",
        "    rawBody: !!op.rawBody, responseType: op.http?.responseType ?? null,",
        "    input: schemaJson(op.http?.input ?? op.input),",
        '    output: schemaJson(op.http?.output ?? op.output, "output"),',
        "  }));",
        "}",
      ].join("\n"),
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "warning",
  });
  const { dumpOperations } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  return dumpOperations();
}

function parseArgs(argv) {
  let out = "packages/client/src/generated.ts";
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i] ?? out;
    else if (argv[i] === "--check") check = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return { out, check };
}

async function main() {
  const { out, check } = parseArgs(process.argv.slice(2));
  const { dirname } = await import("node:path");
  const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const operations = await dumpOperations();
  const text = emitClient(operations);
  if (check) {
    const current = readFileSync(out, "utf8");
    if (current !== text) {
      console.error(`Stale generated client: run \`npm run client:generate\` (first diff at byte ${diffAt(current, text)}).`);
      process.exit(1);
    }
    console.log(`Generated client is current (${operations.length} operations).`);
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`Wrote ${out} (${operations.length} operations).`);
}

function diffAt(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

const invoked = process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invoked) await main();
