/**
 * Regression coverage for the explicit idempotency-key charset guard in
 * duplicateCmd (main.ts). A non-ASCII key once passed a nonempty check and
 * crashed in fetch Headers as exit 1 `unexpected_error`; the server only
 * accepts 1-255 printable ASCII keys. Reverting the guard to a trim/nonempty
 * check must turn this file red.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { duplicateHarness, duplicateObject } from "./fixtures/duplicate-harness";

let h: Awaited<ReturnType<typeof duplicateHarness>>;
beforeAll(async () => { h = await duplicateHarness(); });
afterAll(async () => { await h?.dispose(); });

const invalidKeys = [
  { name: "non-Latin1 characters", key: "café☃-01" },
  { name: "an embedded space", key: "key with space" },
  { name: "256 characters", key: "k".repeat(256) },
];

describe("duplicate explicit idempotency-key charset guard", () => {
  it.each(invalidKeys.flatMap(({ name, key }) => [
    { name, key, dryRun: false },
    { name, key, dryRun: true },
  ]))("rejects a key with $name before any I/O (dryRun=$dryRun)", async ({ key, dryRun }) => {
    const result = await h.cli(
      ["duplicate", "source-template", "requested-copy", "--idempotency-key", key, ...(dryRun ? ["--dry-run"] : []), "--json"],
      { offline: true, key: null },
    );
    expect(result.code, result.stdout + result.stderr).toBe(2);
    expect(duplicateObject(result)).toMatchObject({
      ok: false, exitCode: 2, error: { code: "usage", hint: expect.any(String) },
    });
    expect(result.wire, "an invalid key never reaches the duplicate endpoint").toEqual([]);
    expect(result.fileReads, "an invalid key is rejected before credential/project reads").toEqual([]);
    expect(result.stdout + result.stderr, "the rejected key is never echoed").not.toContain(key);
  });

  it("rejects a non-Latin1 key in a configured invocation without sending a request", async () => {
    const result = await h.cli(
      ["duplicate", "source-template", "requested-copy", "--idempotency-key", "café☃-01", "--json"],
      { replies: [{ status: 201, body: {} }] },
    );
    expect(result.code, result.stdout + result.stderr).toBe(2);
    expect(duplicateObject(result)).toMatchObject({ ok: false, exitCode: 2, error: { code: "usage" } });
    expect(result.wire).toEqual([]);
  });

  it("accepts a 255-character printable ASCII key in an offline dry-run plan", async () => {
    const result = await h.cli(
      ["duplicate", "source-template", "requested-copy", "--idempotency-key", "k".repeat(255), "--dry-run", "--json"],
      { offline: true, key: null },
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(duplicateObject(result)).toMatchObject({ schemaVersion: 1, operation: "duplicate_site", newSlug: "requested-copy" });
    expect(result.wire).toEqual([]);
    expect(result.fileReads).toEqual([]);
  });
});
