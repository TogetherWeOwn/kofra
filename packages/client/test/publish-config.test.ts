import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..", "..");
const pkg = (dir: string) => JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));

/** R-45: @dropway/core, @dropway/server, @dropway/client and kofra publish from CI with npm trusted publishing. */
describe("npm publish configuration", () => {
  const packages = ["packages/core", "packages/server", "packages/client", "packages/cli"];

  it("versions the four published packages in lockstep with a registry to publish to", () => {
    const versions = new Set(packages.map((dir) => pkg(dir).version as string));
    expect([...versions]).toEqual([pkg("packages/client").version]);
    for (const dir of packages) {
      expect(pkg(dir).private, dir).not.toBe(true);
    }
    for (const dir of ["packages/core", "packages/server", "packages/client"]) {
      expect(pkg(dir).publishConfig, dir).toMatchObject({ access: "public", registry: "https://registry.npmjs.org/" });
    }
  });

  it("publishes every package with provenance through an OIDC workflow", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("--provenance");
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
    for (const name of ["@dropway/core", "@dropway/server", "@dropway/client", "kofra"]) {
      expect(workflow, name).toContain(name);
    }
  });

  it("gates the release on every package version matching the tag", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");
    const gate = workflow.slice(workflow.indexOf("Tag matches"), workflow.indexOf("- run: npm run build -w kofra"));
    // Match the loop membership exactly: "packages/cli" is a prefix of "packages/client",
    // so per-directory substring checks cannot pin the cli package.
    expect(gate).toContain("for p in packages/core packages/server packages/client packages/cli");
  });
});
