/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import publishYaml from "../.github/workflows/publish.yml?raw";

function workflow(): Record<string, any> {
  const doc = parse(publishYaml) as Record<string, any>;
  return doc;
}

describe("npm publish workflow gates", () => {
  it("splits publish into verify and publish jobs behind ancestry, tests and review", () => {
    const wf = workflow();
    const jobs = wf.jobs as Record<string, any>;
    expect(jobs.verify).toBeDefined();
    expect(jobs.publish).toBeDefined();
    expect(jobs.publish.needs).toBe("verify");
    expect(jobs.publish.environment).toBe("npm-publish");
    expect(jobs.publish.if).toContain("push");

    const verifySteps = JSON.stringify(jobs.verify.steps);
    expect(verifySteps).toContain("merge-base --is-ancestor");
    expect(verifySteps).toContain("refs/heads/main:refs/remotes/origin/main");
    expect(verifySteps).toContain("github.ref_type == 'tag'");
    expect(verifySteps).toContain("npm run check");
    expect(verifySteps).not.toContain("npm publish");

    const publishSteps = JSON.stringify(jobs.publish.steps);
    expect(publishSteps).toContain("npm publish --provenance --access public -w @kofra/core");
    expect(publishSteps).toContain("npm publish --provenance -w kofra");
  });

  it("keeps the OIDC token out of the verify job", () => {
    const wf = workflow();
    const jobs = wf.jobs as Record<string, any>;
    expect(wf.permissions).toEqual({ contents: "read" });
    const verifyPerms = jobs.verify.permissions ?? {};
    expect(verifyPerms["id-token"]).toBeUndefined();
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
