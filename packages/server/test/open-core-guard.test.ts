import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
// Assemble forbidden fixtures at runtime so the test itself remains open-core.
const sdk = ["str", "ipe"].join("");
const marker = ["LicenseRef", "Dropway", "Proprietary"].join("-"); // rebrand:keep (the private layer's SPDX marker)
const excludedDirectory = ["bill", "ing"].join("");
const declaration = (specifier: string) => ["im", "port"].join("") + ` value from ${JSON.stringify(specifier)};\n`;
let root: string;

function put(path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function scan(...args: string[]) {
  const result = spawnSync(process.execPath, [join(root, "scripts/guard-open-core.mjs"), ...args], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "dropway-guard-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(repo, "scripts/guard-open-core.mjs"), join(root, "scripts/guard-open-core.mjs"));
  put("package.json", JSON.stringify({ name: "guard-fixture", private: true, workspaces: ["packages/*"], devDependencies: { vitest: "^4.1.0" } }));
  put("packages/core/package.json", JSON.stringify({ name: "@kofra/core", type: "module" }));
  put("packages/server/package.json", JSON.stringify({ name: "@kofra/server", type: "module", dependencies: { "@kofra/core": "^0.1.0", hono: "^4.13.13" } }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("open-core guard executable contract", () => {
  it("accepts an ordinary repository before any fixture is planted", () => {
    expect(scan()).toMatchObject({ status: 0 });
  });

  it.each(["packages/core/src/fixture.ts", "apps/worker/src/fixture.ts"])("rejects the private SPDX marker in %s", (path) => {
    put(path, `// SPDX-License-Identifier: ${marker}\nexport const fixture = 1;\n`);
    const result = scan();
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(path);
  });

  for (const path of ["package.json", "packages/extra/package.json"]) {
    it.each(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])(`rejects an excluded SDK in ${path} %s`, (section) => {
      put(path, JSON.stringify({ name: "fixture", [section]: { [sdk]: "^18.0.0" } }));
      const result = scan();
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(path);
    });
  }

  it.each([
    ["package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${sdk}`]: { version: "18.0.0" } } })],
    ["packages/extra/package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${sdk}`]: { version: "18.0.0" } } })],
    ["npm-shrinkwrap.json", JSON.stringify({ lockfileVersion: 1, dependencies: { [sdk]: { version: "18.0.0" } } })],
    ["yarn.lock", `# yarn lockfile v1\n\n${sdk}@^18.0.0:\n  version "18.0.0"\n`],
    ["pnpm-lock.yaml", `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      ${sdk}:\n        specifier: ^18.0.0\n        version: 18.0.0\npackages:\n  ${sdk}@18.0.0: {}\n`],
    ["bun.lock", JSON.stringify({ lockfileVersion: 1, workspaces: { "": { dependencies: { [sdk]: "^18.0.0" } } }, packages: { [sdk]: [`${sdk}@18.0.0`, "", {}, "sha512-fixture"] } })],
  ])("rejects an excluded SDK present only in %s", (path, contents) => {
    put(path, contents);
    const result = scan();
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(path);
  });

  it("rejects a submodule manifest", () => {
    put(".gitmodules", '[submodule "extra"]\n  path = extra\n  url = https://example.test/extra.git\n');
    const result = scan();
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(".gitmodules");
  });

  it("rejects an excluded-feature directory", () => {
    const path = `packages/server/src/${excludedDirectory}/index.ts`;
    put(path, "export const fixture = 1;\n");
    const result = scan();
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(path);
  });

  it.each([
    ["static", declaration("undeclared-fixture")],
    ["side effect", ["im", "port"].join("") + ' "undeclared-fixture";\n'],
    ["dynamic", `const module = ${["im", "port"].join("")}("undeclared-fixture/subpath");\n`],
    ["CommonJS", `const module = ${["re", "quire"].join("")}("undeclared-fixture");\n`],
    ["re-export", ["ex", "port"].join("") + ' { value } from "@outside/fixture";\n'],
  ])("rejects an undeclared %s package reference", (_kind, content) => {
    const path = "packages/server/src/fixture.ts";
    put(path, content);
    const result = scan();
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(path);
  });

  it.each(["hono", "hono/utils/http-status", "@kofra/core", "node:crypto", "./local", "../local"])("allows the declared, workspace, built-in or relative import %s", (specifier) => {
    put("packages/server/src/fixture.ts", declaration(specifier));
    const result = scan();
    expect(result.status, result.output).toBe(0);
  });

  it("allows a root-declared test dependency", () => {
    put("test/fixture.ts", declaration("vitest"));
    const result = scan();
    expect(result.status, result.output).toBe(0);
  });

  it("self-tests the marker, SDK and excluded-directory cases", () => {
    const result = scan("--self-test");
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/ok\s+marker/);
    expect(result.output).toMatch(/ok\s+sdk dependency/);
    expect(result.output).toContain(`ok   ${excludedDirectory} folder`);
  });
});

it("documents the versioned extension boundary in CHANGELOG.md", () => {
  const path = join(repo, "CHANGELOG.md");
  expect(existsSync(path), "R-01 requires CHANGELOG.md with an Extension API section").toBe(true);
  expect(readFileSync(path, "utf8")).toMatch(/^#{1,6}\s+Extension API\b/im);
});
