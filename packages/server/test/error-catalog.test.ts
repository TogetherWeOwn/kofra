/// <reference types="vite/client" />
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// R-03 catalog acceptance contract: ERROR_CODES is a record keyed by stable
// snake_case code, with { status, retryable, hint } entries. Keep this in the
// existing Node suite: the compiler inventory needs filesystem access, not D1.
// A missing module fails an assertion instead of preventing the suite loading.
const catalogModules = import.meta.glob<Record<string, unknown>>("../../core/src/error-codes.ts", { eager: true });
const root = fileURLToPath(new URL("../../../", import.meta.url));
type Entry = { status: number; retryable: boolean; hint: string };

function catalog(): Record<string, Entry> {
  const module = Object.values(catalogModules)[0];
  expect(module, "packages/core/src/error-codes.ts must exist").toBeDefined();
  expect(module?.ERROR_CODES, "the catalog must export ERROR_CODES").toBeTypeOf("object");
  const entries = module!.ERROR_CODES as Record<string, Entry>;
  expect(Object.keys(entries).length, "the catalog must not be empty").toBeGreaterThan(0);
  return entries;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

// Resolve the return type instead of grepping constructor text: this includes
// imported/aliased factories such as badRequest() and tooLarge(), ignores
// comments and strings, and fails closed on unbounded dynamic code arguments.
function serviceErrors() {
  const configPath = join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const files = [...sourceFiles(join(root, "packages/core/src/services")), ...sourceFiles(join(root, "packages/core/src/lib"))];
  const program = ts.createProgram(files, parsed.options);
  const checker = program.getTypeChecker();
  const found: Array<{ location: string; codes: string[] }> = [];
  for (const path of files) {
    const source = program.getSourceFile(path)!;
    function visit(node: ts.Node) {
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        const result = checker.getTypeAtLocation(node);
        const signature = checker.getResolvedSignature(node);
        const codeIndex = signature?.getParameters().findIndex((parameter) => parameter.getName() === "code") ?? -1;
        if (result.getSymbol()?.getName() === "ApiError" && codeIndex >= 0) {
          const parameter = signature?.declaration?.parameters[codeIndex];
          const fallback = parameter && ts.isParameter(parameter) ? parameter.initializer : undefined;
          const argument = node.arguments?.[codeIndex] ?? fallback;
          const type = argument && checker.getTypeAtLocation(argument);
          const alternatives = type?.isUnion() ? type.types : type ? [type] : [];
          const codes = alternatives.filter((t): t is ts.StringLiteralType => t.isStringLiteral()).map((t) => t.value);
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          const location = `${path.slice(root.length)}:${line}`;
          expect(codes.length, `cannot inventory an unbounded ApiError code at ${location}`).toBeGreaterThan(0);
          expect(codes.length, `partly dynamic ApiError code at ${location}`).toBe(alternatives.length);
          found.push({ location, codes });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(found.length, "the inventory must actually find service errors").toBeGreaterThan(0);
  return found;
}

describe("R-03 error catalog", () => {
  it("declares HTTP status, retryability and actionable hint for every catalog code", () => {
    for (const [code, entry] of Object.entries(catalog())) {
      expect(code).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
      expect(Number.isInteger(entry.status), code).toBe(true);
      expect(entry.status, code).toBeGreaterThanOrEqual(400);
      expect(entry.status, code).toBeLessThanOrEqual(599);
      expect(entry.retryable, code).toBeTypeOf("boolean");
      expect(entry.hint, code).toBeTypeOf("string");
      expect(entry.hint.trim().length, code).toBeGreaterThan(0);
    }
  });

  it("PIN: can discover real service constructor and error-factory calls", () => {
    const codes = serviceErrors().flatMap((entry) => entry.codes);
    expect(codes).toContain("version_conflict");
    expect(codes).toContain("invalid_request");
  });

  it("rejects every service or shared-library code absent from the catalog", () => {
    const entries = catalog();
    for (const { location, codes } of serviceErrors()) {
      for (const code of codes) {
        expect(Object.hasOwn(entries, code), `${location} throws uncataloged ${code}`).toBe(true);
      }
    }
  });

  it("keeps the generated docs/errors.md table in exact catalog parity", () => {
    const entries = catalog();
    const docPath = join(root, "docs/errors.md");
    let markdown = "";
    try { markdown = readFileSync(docPath, "utf8"); } catch { /* report the missing artifact as an assertion */ }
    expect(markdown, "generate docs/errors.md from the catalog").not.toBe("");
    // Canonical generated table columns: Code | HTTP status | Retryable | Hint.
    // Ignore prose/formatting outside the table; do not permit missing or stale rows.
    const rows = markdown.split("\n").flatMap((line) => {
      const cells = line.trim().split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
      if (cells[0]) cells[0] = cells[0].replace(/^`|`$/g, "");
      return cells.length === 4 && /^\d{3}$/.test(cells[1]!) ? [cells] : [];
    });
    const expected = Object.entries(entries).map(([code, entry]) => [code, String(entry.status), String(entry.retryable), entry.hint.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")]);
    expect(rows.sort((a, b) => a[0]!.localeCompare(b[0]!))).toEqual(expected.sort((a, b) => a[0]!.localeCompare(b[0]!)));
  });
});
