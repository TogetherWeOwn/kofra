/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import publishYaml from "../.github/workflows/publish.yml?raw";

function workflow(): Record<string, any> {
  const doc = parse(publishYaml) as Record<string, any>;
  return doc;
}

describe("npm publish workflow gates", () => {
  it("gates a separate build and tarball publish behind verification", () => {
    const jobs = workflow().jobs as Record<string, any>;
    expect(jobs.build.needs).toBe("verify");
    expect(jobs.build.if).toBe("github.event_name == 'push'");
    expect(jobs.publish.needs).toEqual(["verify", "build"]);
    expect(jobs.publish.environment).toBe("npm-publish");
    expect(jobs.publish.if).toBe("github.event_name == 'push'");

    const verifySteps = JSON.stringify(jobs.verify.steps);
    expect(verifySteps).toContain("merge-base --is-ancestor");
    expect(verifySteps).toContain("refs/heads/main:refs/remotes/origin/main");
    expect(verifySteps).toContain("github.ref_type == 'tag'");
    expect(jobs.verify.steps.some((step: Record<string, any>) => step.run?.includes('test "v$v" = "$RELEASE_TAG"'))).toBe(true);
    expect(verifySteps).toContain("npm run check");
    expect(verifySteps).not.toContain("npm publish");

    const buildSteps = jobs.build.steps as Record<string, any>[];
    const buildCommands = buildSteps.map((step) => step.run ?? "").join("\n");
    expect(buildCommands).toContain("npm ci --ignore-scripts");
    expect(buildCommands).toContain("git status --porcelain");
    expect(buildCommands.indexOf("git status --porcelain")).toBeLessThan(buildCommands.indexOf("npm run build"));
    for (const pkg of ["@kofra/core", "@kofra/server", "@kofra/client", "kofra"]) {
      expect(buildCommands).toContain(`npm pack -w ${pkg} `);
    }
    expect(buildCommands).toContain("sha256sum *.tgz > SHA256SUMS");
    expect(buildSteps.some((step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.["retention-days"] === 30)).toBe(true);

    const publishSteps = jobs.publish.steps as Record<string, any>[];
    const publishCommands = publishSteps.map((step) => step.run ?? "").join("\n");
    expect(publishSteps.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(publishCommands).not.toMatch(/npm (ci|install|run build|pack)\b/);
    expect(publishCommands.indexOf("sha256sum -c SHA256SUMS")).toBeLessThan(publishCommands.indexOf("npm publish"));
    for (const tarball of ["kofra-core-*.tgz", "kofra-server-*.tgz", "kofra-client-*.tgz", "kofra-[0-9]*.tgz"]) {
      expect(publishCommands).toContain(tarball);
    }
  });

  it("qualifies the main ref in the ancestry check", () => {
    const raw = publishYaml;
    expect(raw).toContain('git rev-parse --verify -q "refs/remotes/origin/main"');
    expect(raw).toContain('git merge-base --is-ancestor "$TAG_COMMIT" refs/remotes/origin/main');
    expect(raw).not.toContain('"origin/main"');
    expect(raw).not.toContain('"$TAG_COMMIT" origin/main');
  });

  it("keeps the OIDC token out of the verify job", () => {
    const wf = workflow();
    const jobs = wf.jobs as Record<string, any>;
    expect(wf.permissions).toEqual({ contents: "read" });
    const verifyPerms = jobs.verify.permissions ?? {};
    expect(verifyPerms["id-token"]).toBeUndefined();
    expect(jobs.build.permissions).toEqual({ contents: "read" });
    const publishPerms = jobs.publish.permissions as Record<string, string>;
    expect(publishPerms["id-token"]).toBe("write");
    expect(publishPerms.contents).toBe("read");
  });

  it("pins actions and allows verify-only manual dispatch", () => {
    const wf = workflow();
    expect(wf["on"]).toBeDefined();
    const on = wf.on as Record<string, any>;
    expect(on.workflow_dispatch).toBeDefined();
    const raw = publishYaml;
    expect(raw).toContain("actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4");
    expect(raw).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4");
  });
});
