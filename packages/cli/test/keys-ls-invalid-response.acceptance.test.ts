/** Protected review regression: Builder consumes unchanged.
 * Run: npm run test:cli -- test/keys-ls-invalid-response.acceptance.test.ts
 * Break caught: treating TypeScript's KeyItem[] annotation as runtime validation,
 * reporting malformed successful responses as success, or printing partial rows.
 * Intentionally RED until the Builder adds a local response-shape guard.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyListHarness, responseSentinel } from "./fixtures/keys-list-harness.ts";

const validKey = {
  id: "key_complete", name: "Complete fixture", prefix: "dw_fixture", memberId: "mem_fixture",
  scopes: ["keys:write"], siteId: "site_fixture", current: true,
  createdAt: "2024-01-02T03:04:05.000Z", lastUsedAt: "2025-02-03T04:05:06.000Z",
  expiresAt: "2035-03-04T05:06:07.000Z", revoked: false,
};
const nullMetadata = {
  id: "key_nullable", name: null, prefix: "dw_nullable", memberId: "mem_nullable",
  scopes: [], siteId: null, createdAt: null, lastUsedAt: null, expiresAt: null, revoked: false,
};
type Case = { label: string; body: unknown };
const invalid: Case[] = [
  { label: "null response", body: null },
  { label: "missing keys", body: {} },
  ...[[], "response", 42, false].map(body => ({ label: `nonobject response ${JSON.stringify(body)}`, body })),
  ...[null, {}, "keys", 42, false].map(keys => ({ label: `nonarray keys ${JSON.stringify(keys)}`, body: { keys } })),
  ...[null, "record", 42, false, []].map(row => ({ label: `nonobject record ${JSON.stringify(row)}`, body: { keys: [row] } })),
];

// All required fields are tested missing as well as wrong-typed. Nullable means
// string|null, NOT optional. current alone may be omitted. No ID/date/scope policy.
for (const field of ["id", "name", "prefix", "memberId", "scopes", "siteId", "createdAt", "lastUsedAt", "expiresAt", "revoked"]) {
  const row: Record<string, unknown> = { ...validKey };
  delete row[field];
  invalid.push({ label: `missing required ${field}`, body: { keys: [row] } });
}
for (const field of ["id", "prefix", "memberId"]) {
  for (const value of [null, 42, false, {}, []]) {
    invalid.push({ label: `${field} is ${JSON.stringify(value)}`, body: { keys: [{ ...validKey, [field]: value }] } });
  }
}
for (const field of ["name", "siteId", "createdAt", "lastUsedAt", "expiresAt"]) {
  for (const value of [42, false, {}, []]) {
    invalid.push({ label: `${field} is ${JSON.stringify(value)}`, body: { keys: [{ ...validKey, [field]: value }] } });
  }
}
for (const value of [null, "keys:write", {}, 42, false, [null], [42], [false], [{}], [[]], ["keys:write", null]]) {
  invalid.push({ label: `scopes is ${JSON.stringify(value)}`, body: { keys: [{ ...validKey, scopes: value }] } });
}
for (const field of ["current", "revoked"]) {
  for (const value of [null, "false", 0, {}, []]) {
    invalid.push({ label: `${field} is ${JSON.stringify(value)}`, body: { keys: [{ ...validKey, [field]: value }] } });
  }
}
invalid.push(
  { label: "malformed later row is all-or-nothing", body: { keys: [
    { ...validKey, id: "key_partial_must_not_print", name: "Partial row must not print" },
    { ...validKey, scopes: ["keys:write", 42] },
  ] } },
  { label: "malformed body with sensitive-looking extension fields", body: { keys: [
    { ...validKey, id: "key_partial_must_not_print", scopes: responseSentinel,
      key_hash: responseSentinel, accessToken: responseSentinel, authorization: responseSentinel },
  ], debug: responseSentinel } },
);

const valid: Case[] = [
  { label: "empty inventory", body: { keys: [] } },
  { label: "complete record", body: { keys: [validKey] } },
  { label: "null metadata and omitted current", body: { keys: [nullMetadata] } },
  { label: "false current and true revoked remain server data", body: { keys: [{ ...validKey, current: false, revoked: true }] } },
  // Runtime shape validation must not invent semantic restrictions or strip
  // benign extensions. Values below are fake, valid scalar types, not policies.
  { label: "string values are not new date, ID or scope policies", body: { keys: [{
    ...validKey, id: "", prefix: "custom", memberId: "external-member", siteId: "custom-site",
    createdAt: "custom-created", lastUsedAt: "custom-last-use", expiresAt: "custom-expiry",
    scopes: ["extension:inspect", ""], extraMetadata: { fixture: "preserved" },
  }] } },
];
let harness: Awaited<ReturnType<typeof keyListHarness>>;
beforeAll(async () => { harness = await keyListHarness(); });
afterAll(async () => { await harness?.dispose(); });

function usefulRemediation(hint: unknown) {
  expect(hint).toEqual(expect.any(String));
  expect(hint, "remediation must identify the instance/server/API compatibility problem").toMatch(/api|instance|server|version|response/i);
  expect(hint, "hint must say what to do next, not merely restate malformed").toMatch(/check|verify|updat|upgrad|compatib|report|contact|correct|use\b/i);
}

describe.each([
  { label: "source / text", bundled: false, json: false },
  { label: "source / JSON", bundled: false, json: true },
  { label: "bundle / text", bundled: true, json: false },
  { label: "bundle / JSON", bundled: true, json: true },
])("keys ls injected response: $label", ({ bundled, json }) => {
  it.each(invalid)("rejects $label with stable invalid_key_list and no partial output", async ({ body }) => {
    const result = await harness.cli(body, bundled, json ? ["--json"] : []);
    expect(result.code, "invalid successful GET bodies must fail deterministically").toBe(1);
    expect(result.stdout + result.stderr).not.toContain("key_partial_must_not_print");
    expect(result.stdout + result.stderr).not.toContain("Partial row must not print");
    expect(result.stdout + result.stderr).not.toMatch(/"ok"\s*:\s*true/);
    if (json) {
      const parsed = JSON.parse(result.stdout); // exactly one complete JSON value, not rows + an error
      expect(parsed).toMatchObject({ ok: false, exitCode: 1, error: {
        code: "invalid_key_list", retryable: false, message: expect.any(String), hint: expect.any(String),
      } });
      expect(parsed.error.message.trim().length).toBeGreaterThan(0);
      usefulRemediation(parsed.error.hint);
      expect(Object.hasOwn(parsed, "keys"), "no partial inventory in error output").toBe(false);
      expect(result.stderr).toBe("");
    } else {
      expect(result.stdout, "validate every row before rendering any header or row").toBe("");
      expect(result.stderr).toContain("invalid_key_list");
      usefulRemediation(result.stderr);
      expect(result.stderr).not.toMatch(/TypeError|\bat .*\.(?:ts|mjs|js):\d/);
    }
  });

  it.each(valid)("accepts $label without new semantic restrictions", async ({ body }) => {
    const result = await harness.cli(body, bundled, json ? ["--all", "--json"] : ["--all"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    if (json) {
      const parsed = JSON.parse(result.stdout);
      expect(parsed.keys).toEqual((body as { keys: unknown[] }).keys);
      if (Object.hasOwn(parsed, "ok")) expect(parsed.ok).toBe(true);
    } else {
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      if ((body as { keys: unknown[] }).keys.length === 0) {
        expect(result.stdout).toMatch(/no\s+(?:active\s+|api\s+)*keys|0\s+(?:active\s+|api\s+)*keys|empty/i);
      }
    }
  });
});
