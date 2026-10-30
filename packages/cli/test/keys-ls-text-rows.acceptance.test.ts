/** Protected review regression: Builder consumes unchanged.
 * Run: npm run test:cli -- test/keys-ls-text-rows.acceptance.test.ts
 * Breaks caught: removing/misassigning the per-key current marker; omitting,
 * swapping or reusing another row's displayed metadata (especially creation time).
 * No Worker/network or credential mutations; source and bundle are subprocesses.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyListHarness } from "./fixtures/keys-list-harness.ts";

const keys = [
  {
    id: "key_current", name: "Current agent", prefix: "dw_current", memberId: "mem_one",
    scopes: ["keys:write", "sites:read"], siteId: "site_alpha", current: true,
    createdAt: "2024-02-03T04:05:06.000Z", lastUsedAt: "2025-06-07T08:09:10.000Z",
    expiresAt: "2031-10-11T12:13:14.000Z", revoked: false,
  },
  {
    id: "key_other", name: "Other agent", prefix: "dw_other", memberId: "mem_two",
    scopes: ["sites:write"], siteId: null, current: false,
    createdAt: "2023-12-13T14:15:16.000Z", lastUsedAt: null,
    expiresAt: "2032-01-02T03:04:05.000Z", revoked: false,
  },
  {
    id: "key_keyless", name: null, prefix: "dw_keyless", memberId: "mem_three",
    scopes: [], siteId: "site_beta", // current deliberately omitted, never inferred
    createdAt: null, lastUsedAt: "2022-08-09T10:11:12.000Z", expiresAt: null, revoked: false,
  },
];
let harness: Awaited<ReturnType<typeof keyListHarness>>;
beforeAll(async () => { harness = await keyListHarness(); });
afterAll(async () => { await harness?.dispose(); });

function rows(stdout: string) {
  const lines = stdout.trimEnd().split("\n").filter(line => line.trim());
  expect(lines, "one header plus exactly one physical line per key").toHaveLength(4);
  // Use displayed column positions, not split-on-whitespace: noncurrent markers
  // and empty scopes are real empty cells. The header supplies layout ONLY, never
  // evidence that a data row has a marker or a particular metadata value.
  const starts = [...lines[0]!.matchAll(/\S.*?(?= {2,}|$)/gu)].map(match => match.index);
  return lines.slice(1).map(line => starts.map((start, i) => line.slice(start, starts[i + 1]).trim()));
}

describe.each([
  { label: "source / saved credentials", bundled: false },
  { label: "bundle / environment credentials", bundled: true },
])("keys ls individual text rows: $label", ({ bundled }) => {
  it.each([{ flags: [] }, { flags: ["--all"] }])("marks only current=true, not false or omitted ($flags)", async ({ flags }) => {
    const result = await harness.cli({ keys }, bundled, flags);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(rows(result.stdout).map(row => row.slice(0, 2))).toEqual([
      ["*", "key_current"], ["", "key_other"], ["", "key_keyless"],
    ]);
  });

  it.each([{ flags: [] }, { flags: ["--all"] }])("renders distinct metadata cells and null placeholders on their own rows ($flags)", async ({ flags }) => {
    const result = await harness.cli({ keys }, bundled, flags);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(rows(result.stdout)).toEqual([
      ["*", "key_current", "Current agent", "dw_current", "keys:write sites:read",
        "site_alpha", "2024-02-03 04:05", "2025-06-07 08:09", "2031-10-11T12:13:14.000Z"],
      ["", "key_other", "Other agent", "dw_other", "sites:write",
        "-", "2023-12-13 14:15", "-", "2032-01-02T03:04:05.000Z"],
      ["", "key_keyless", "-", "dw_keyless", "",
        "site_beta", "-", "2022-08-09 10:11", "-"],
    ]);
  });
});
