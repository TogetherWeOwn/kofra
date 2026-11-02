/** Regression pins for the test-only stdin transport and filesystem audit. */
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stdinNodeHarness, stdinObject, type StdinNodeHarness } from "./helpers/stdin-publish-node.ts";

let work = "";
let h: StdinNodeHarness | undefined;
beforeEach(async () => {
  work = await realpath(await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "stdin-harness-")));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await h?.dispose();
  h = undefined;
  await rm(work, { recursive: true, force: true });
});

describe("stdin acceptance harness regressions", () => {
  // Break caught: decoding a binary upload before recording its arrival makes
  // an attempted network side effect disappear from the audit on parse failure.
  it("records a binary PUT even when the fixture cannot parse or answer it", async () => {
    h = await stdinNodeHarness();
    const entry = join(work, "binary-put.mjs");
    await writeFile(entry, `
      let refused = false;
      try {
        await fetch("https://default.invalid/api/v1/blobs/binary-put-fixture", {
          method: "PUT", body: new Uint8Array([0xff, 0x00, 0x80]),
        });
      } catch { refused = true; }
      process.stdout.write(JSON.stringify({ refused }, null, 2) + "\\n");
    `);
    const r = await h.run([], Buffer.alloc(0), { entry });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(stdinObject(r)).toEqual({ refused: true });
    expect(r.wire).toEqual([expect.objectContaining({
      method: "PUT", url: "https://default.invalid/api/v1/blobs/binary-put-fixture", authorization: null,
    })]);
  });

  // Break caught: deriving paths from the unresolved mkdtemp result loses
  // physical-path filesystem reads when the scratch directory is a symlink.
  it("derives physical cwd/config paths and audits reads under a symlinked scratch root", async () => {
    const physical = join(work, "physical");
    const alias = join(work, "alias");
    await mkdir(physical);
    await symlink(physical, alias, "dir");
    vi.stubEnv("PAPERCLIP_RUN_SCRATCH_DIR", alias);
    vi.stubEnv("TMPDIR", alias);
    h = await stdinNodeHarness();
    expect(h.cwd).toBe(await realpath(h.cwd));
    expect(h.config).toBe(await realpath(h.config));
    expect(dirname(dirname(dirname(h.cwd)))).toBe(physical);

    await h.credentials();
    await h.link();
    await writeFile(join(h.cwd, "report.txt"), "physical-path audit control\n");
    const r = await h.run(["publish", "report.txt", "--json", "--no-save"], Buffer.alloc(0));
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(stdinObject(r)).toMatchObject({ ok: true, slug: "linked-file-site" });
    expect(r.reads.some(read => read.path === r.linkPath && read.operation === "readFile")).toBe(true);
  });
});
