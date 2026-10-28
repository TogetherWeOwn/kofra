/**
 * Protected production-boundary acceptance tests. No replacement Io/stdin
 * reader: both the repository executable and built distribution receive real
 * Buffer bytes through a pipe. Build the current CLI before running this file.
 *
 * npm run build -w packages/cli
 * npm run test:cli -- test/stdin-publish-node.acceptance.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultApi, digest, explicitKey, stdinNodeHarness, stdinObject,
  type StdinNodeHarness,
} from "./helpers/stdin-publish-node.ts";

let h: StdinNodeHarness;
beforeEach(async () => { h = await stdinNodeHarness(); });
afterEach(async () => { await h?.dispose(); });

const env = { KOFRA_API: defaultApi, KOFRA_API_KEY: explicitKey };
const modes = [{ name: "repository executable", bundled: false }, { name: "built distribution", bundled: true }];
const cap = 100 * 1024 * 1024;

describe("stdin production reader wiring", () => {
  // Break caught: removing the production readStdinBytes binding falls back to
  // the text reader and UTF-8 replacement corrupts ff 00 80 before hashing.
  it.each(modes)("$name preserves non-UTF-8 pipe bytes and their exact hash", async ({ bundled }) => {
    const bytes = Buffer.from([0xff, 0x00, 0x80]);
    const r = await h.run(["publish", "--stdin", "binary.bin", "--dry-run", "--json"], bytes, { env, bundled });
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json).toMatchObject({ ok: true, dryRun: true, totalBytes: 3 });
    expect(json.files).toEqual([expect.objectContaining({ path: "binary.bin", size: 3, sha256: digest(bytes) })]);
    expect(r.stdinReads).toBe(1);
    expect(r.wire).toEqual([]);
  });

  // Breaks caught: a reduced bound / >= comparison rejects the exact cap; a
  // raised bound admits cap+1 and reaches the synthetic transport. This is the
  // actual 100 MiB CLI cap, not an injected small reader or a server-side cap.
  it.each(modes)("$name accepts exactly 100 MiB in an offline raw inventory", async ({ bundled }) => {
    const bytes = Buffer.alloc(cap, 0xff);
    const r = await h.run(["publish", "--stdin", "at-cap.bin", "--dry-run", "--json"], bytes, { env, bundled });
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json).toMatchObject({ ok: true, dryRun: true, totalBytes: 104857600 });
    expect(json.files).toEqual([expect.objectContaining({ path: "at-cap.bin", size: 104857600, sha256: digest(bytes) })]);
    expect(r.stdinReads).toBe(1);
    expect(r.wire).toEqual([]);
  });

  it.each(modes)("$name refuses 100 MiB + 1 with file_too_large / exit 6 before any fetch", async ({ bundled }) => {
    const bytes = Buffer.alloc(cap + 1, 0xff);
    const r = await h.run(["publish", "--stdin", "over-cap.bin", "--site", "stdin-selected-fixture", "--json"], bytes, { env, bundled });
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(6);
    expect(json).toMatchObject({ ok: false, exitCode: 6, error: { code: "file_too_large" } });
    expect(`${json.error.message} ${json.error.hint}`).toMatch(/limit|100|smaller|split|compress/i);
    expect(r.stdinReads).toBe(1);
    expect(r.wire, "oversized piped data never contacts even a synthetic instance").toEqual([]);
  });

  // Break caught: omitting the production firstByteTimeoutMs option leaves an
  // open, silent producer hanging. No EOF, test-only product knob or fake Io.
  it("a silent OPEN pipe becomes empty_stdin at the production 30-second first-byte deadline", async () => {
    const r = await h.run(["publish", "--stdin", "silent.bin", "--json"], null, { env, timeoutMs: 38_000 });
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(json).toMatchObject({ ok: false, exitCode: 2, error: { code: "empty_stdin" } });
    expect(r.elapsedMs, "must not confuse an open pipe with immediate EOF or an early timeout").toBeGreaterThanOrEqual(29_000);
    expect(r.elapsedMs).toBeLessThan(38_000);
    expect(r.stdinReads).toBe(1);
    expect(r.wire).toEqual([]);
  }, 45_000);
});
