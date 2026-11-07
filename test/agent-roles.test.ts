/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import builder from "../.claude/agents/builder.md?raw";
import crossReviewer from "../.claude/agents/cross-reviewer.md?raw";

function metadata(source: string): Record<string, unknown> {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source.replace(/\r\n/g, "\n"));
  if (!frontmatter?.[1]) throw new Error("Missing role frontmatter");
  return parse(frontmatter[1]) as Record<string, unknown>;
}

describe("repository agent role contracts", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("parses role frontmatter with %s line endings", (_name, newline) => {
    const source = ["---", "name: example", "model: gpt-6.1-sol", "---", "", "Role body."].join(newline);
    expect(metadata(source)).toEqual({ name: "example", model: "gpt-6.1-sol" });
  });

  it("pins the independent reviewer route without adding tools", () => {
    const role = metadata(crossReviewer);
    expect(role.name).toBe("cross-reviewer");
    expect(role.model).toBe("gpt-6.1-sol");
    expect(role.tools).toBe("Read, Grep, Glob, Bash");
    expect(role.description).toContain("same pinned head");
    expect(crossReviewer).toContain("Review the same pinned base and head SHAs as the primary reviewer");
    expect(role.description).toContain("record independent findings before sharing conclusions");
    expect(role.description).not.toMatch(/after (?:the )?main[- ]thread review/i);
  });

  it("does not authorize reviewer test execution or experimental activation", () => {
    expect(crossReviewer).toContain("Never edit files, execute tests or builds");
    expect(crossReviewer).not.toContain("running existing tests");
    expect(crossReviewer).toContain("code trace or existing check output");
    expect(crossReviewer).toContain("not a security boundary");
    expect(crossReviewer).toContain("experimental review-panel NO-GO");
  });

  it("preserves the builder route and delivery limits with substantial scope", () => {
    const role = metadata(builder);
    expect(role.name).toBe("builder");
    expect(role.model).toBe("claude/claude-sonnet-5-5");
    expect(role.tools).toBeUndefined();
    expect(role.description).toContain("substantial implementation");
    expect(builder).toContain("Never commit, push, open PRs or change Paperclip issues");
    expect(builder).toContain("Full suites and CI gates run only on GitHub Actions");
    expect(builder).toContain("never run a local full suite, CI mirror or Boat fallback suite");
    expect(builder).toContain("Only a focused reproduction of one failing test or crate may run locally under the existing guarded-build controls");
    expect(builder).toContain("Do no design work");
    expect(builder).toContain("experimental review-panel NO-GO");
  });
});
