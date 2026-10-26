/**
 * Protected independent acceptance tests; the Builder must not edit this file
 * or fixtures/duplicate-harness.ts. Run against the built CLI, not a command mock.
 *
 * Breaks caught: inferred targets; extra uploads/requests; lost/guessed receipt
 * identities; credential/config writes; unsafe mutation retries; lost server
 * errors; missing access-reset advice; and online/credential-bound dry runs.
 *
 * Offline plan ABI specified here: schemaVersion: 1, operation: duplicate_site,
 * source: the explicit unresolved reference, newSlug, optional message. No IDs
 * are fabricated. Additional non-secret descriptive fields are permitted.
 * Canonical README advice (SPA only, no access/settings copy, explicit-key reuse
 * after unknown outcomes) remains a manual Builder review item, not a prose grep.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { duplicateApi, duplicateHarness, duplicateObject, type DuplicateRun } from "./fixtures/duplicate-harness";

const NOTE = "Only SPA mode is copied. Passwords/access gates and other settings are not copied; re-apply protection explicitly.";
const WARNING = { code: "fixture_access_reset", message: "Destination is public; protection was not copied.", fix: "Apply protection explicitly if required." };
const receipt = {
  slug: "server-copy", url: "https://sites.example.test/server-copy/", versionId: "ver_returned_987",
  site: { id: "site_returned_456", slug: "server-copy", url: "https://sites.example.test/server-copy/",
    currentVersionId: "ver_returned_987", settings: { spa: true, passwordProtected: false } },
  version: { id: "ver_returned_987", number: 1, status: "ready", live: true, fileCount: 7, totalBytes: 8091, message: "Template snapshot" },
  fileCount: 7, totalBytes: 8091, note: NOTE, warnings: [WARNING], replayed: true,
};
let h: Awaited<ReturnType<typeof duplicateHarness>>;
beforeAll(async () => { h = await duplicateHarness(); });
afterAll(async () => { await h?.dispose(); });
const success = [{ status: 201, body: receipt }];

function ok(result: DuplicateRun) {
  expect(result.code, result.stdout + result.stderr).toBe(0);
  const value = duplicateObject(result);
  expect(value.ok).not.toBe(false);
  return value;
}
function wire(result: DuplicateRun, path: string, body: unknown, attempts = 1) {
  expect(result.wire, "only the existing duplicate endpoint, never publish/upload/access or source writes").toHaveLength(attempts);
  for (const req of result.wire) {
    expect(req).toMatchObject({ method: "POST", url: duplicateApi + path, authenticated: true });
    expect(JSON.parse(req.body)).toEqual(body);
    expect(req.key, "every mutation has a nonempty invocation idempotency key").toEqual(expect.any(String));
    expect(req.key!.trim().length).toBeGreaterThan(0);
  }
}

describe("duplicate command discovery and explicit targets", () => {
  it.each([false, true])("help advertises duplicate source and new-slug (repository executable=%s)", async repositoryBin => {
    const result = await h.cli(["help"], { repositoryBin });
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/duplicate\s+<source>\s+<new-slug>/);
    expect(result.wire).toEqual([]);
  });

  it.each([
    { source: "source-template", path: "/api/v1/sites/source-template/duplicate" },
    { source: "site_explicit_123", path: "/api/v1/sites/site_explicit_123/duplicate" },
    { source: "https://sites.example.test/s/template/?view=1#section", path: "/api/v1/sites/https%3A%2F%2Fsites.example.test%2Fs%2Ftemplate%2F%3Fview%3D1%23section/duplicate" },
  ])("encodes explicit $source once and sends only newSlug/message", async ({ source, path }) => {
    const result = await h.cli(["duplicate", source, "requested-copy", "--message", "Template snapshot", "--json"], { replies: success });
    ok(result);
    wire(result, path, { newSlug: "requested-copy", message: "Template snapshot" });
  });

  it("omits an absent message rather than supplying a guessed one", async () => {
    const result = await h.cli(["duplicate", "source-template", "requested-copy", "--json"], { replies: success });
    ok(result);
    wire(result, "/api/v1/sites/source-template/duplicate", { newSlug: "requested-copy" });
  });

  it.each([
    { name: "both targets missing", args: [] },
    { name: "destination missing despite project mapping", args: ["source-template"] },
    { name: "empty source", args: ["", "requested-copy"] },
    { name: "empty destination", args: ["source-template", ""] },
    { name: "extra positional", args: ["source-template", "requested-copy", "extra"] },
    { name: "unknown flag", args: ["source-template", "requested-copy", "--typo"] },
    { name: "copy password", args: ["source-template", "requested-copy", "--copy-password"] },
    { name: "copy access", args: ["source-template", "requested-copy", "--copy-access"] },
    { name: "copy settings", args: ["source-template", "requested-copy", "--copy-settings"] },
    { name: "implicit site flag", args: ["source-template", "requested-copy", "--site", "mapped"] },
    { name: "automatic browser open", args: ["source-template", "requested-copy", "--open"] },
    { name: "message without a value", args: ["source-template", "requested-copy", "--message"] },
    { name: "idempotency key without a value", args: ["source-template", "requested-copy", "--idempotency-key"] },
    { name: "empty idempotency key", args: ["source-template", "requested-copy", "--idempotency-key="] },
    { name: "blank idempotency key", args: ["source-template", "requested-copy", "--idempotency-key", "   "] },
  ])("rejects $name before networking or credentials", async ({ args }) => {
    const result = await h.cli(["duplicate", ...args, "--json"], { offline: true, key: null });
    expect(result.code, result.stdout + result.stderr).toBe(2);
    const value = duplicateObject(result);
    expect(value).toMatchObject({ ok: false, exitCode: 2, error: { code: expect.any(String), hint: expect.any(String) } });
    expect(value.error.code, "unknown_command is not argument validation").not.toBe("unknown_command");
    expect(result.wire).toEqual([]);
    expect(result.fileReads, "invalid argv must not resolve credentials/project files").toEqual([]);
  });
});

describe("duplicate entirely offline plan", () => {
  it.each([false, true])("emits one versioned unresolved plan without URL/key/config/files (json=%s)", async json => {
    const source = "https://sites.example.test/s/template/?view=1#section";
    const result = await h.cli(["duplicate", source, "planned-copy", "--message", "Offline snapshot", "--dry-run", ...(json ? ["--json"] : [])], { offline: true, key: null });
    const value = ok(result);
    expect(value).toMatchObject({ schemaVersion: 1, operation: "duplicate_site", source, newSlug: "planned-copy", message: "Offline snapshot" });
    expect(value).not.toHaveProperty("siteId");
    expect(value).not.toHaveProperty("versionId");
    expect(value).not.toHaveProperty("site.id");
    expect(JSON.stringify(value)).not.toMatch(/site_never_infer|never-infer-source/);
    expect(result.wire).toEqual([]);
    expect(result.fileReads).toEqual([]);
  });

  it("does not invent a message in a dry-run plan", async () => {
    const result = await h.cli(["duplicate", "site_explicit_123", "planned-copy", "--dry-run", "--json"], { offline: true });
    const value = ok(result);
    expect(value).toMatchObject({ schemaVersion: 1, source: "site_explicit_123", newSlug: "planned-copy" });
    expect(value.message == null).toBe(true);
    expect(result.wire).toEqual([]);
    expect(result.fileReads).toEqual([]);
  });
});

describe("duplicate receipt, stderr and idempotency", () => {
  it("prints returned identities/counters and preserves warnings, note and replay receipt in one JSON object", async () => {
    const result = await h.cli(["duplicate", "source-template", "requested-copy", "--json"], { replies: success });
    const value = ok(result);
    expect(value).toMatchObject(receipt);
    expect(new URL(value.url).search).toBe("");
    expect(new URL(value.url).hash).toBe("");
    expect(value.url).not.toContain("requested-copy");
    expect(result.stderr, "warnings are also visible without polluting JSON stdout").toContain(WARNING.message);
    wire(result, "/api/v1/sites/source-template/duplicate", { newSlug: "requested-copy" });
  });

  it("human output explains SPA-only inheritance and access/settings reset", async () => {
    const result = await h.cli(["duplicate", "source-template", "requested-copy"], { replies: success });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain(receipt.url);
    expect(output).toMatch(/SPA/i);
    expect(output).toMatch(/password/i);
    expect(output).toMatch(/access/i);
    expect(output).toMatch(/other settings/i);
    expect(output).toMatch(/not copied|not.*inherit|reset|re-apply/i);
    wire(result, "/api/v1/sites/source-template/duplicate", { newSlug: "requested-copy" });
  });

  it("passes an explicit recovery key unchanged across separate invocations", async () => {
    for (let invocation = 0; invocation < 2; invocation++) {
      const result = await h.cli(["duplicate", "source-template", "requested-copy", "--idempotency-key", "recover-copy-01", "--json"], { replies: success });
      ok(result);
      wire(result, "/api/v1/sites/source-template/duplicate", { newSlug: "requested-copy" });
      expect(result.wire[0]!.key).toBe("recover-copy-01");
      expect(result.stdout + result.stderr).not.toContain("recover-copy-01");
    }
  });

  it("generates fresh invocation keys but preserves identical payload/key on SDK 429 retry", async () => {
    const keys: string[] = [];
    for (let invocation = 0; invocation < 2; invocation++) {
      const result = await h.cli(["duplicate", "source-template", "requested-copy", "--message", "same snapshot", "--json"], { replies: [
        { status: 429, headers: { "Retry-After": "0" }, body: { error: { code: "rate_limited", message: "Back off", hint: "Retry this request.", retryable: true } } },
        ...success,
      ] });
      ok(result);
      wire(result, "/api/v1/sites/source-template/duplicate", { newSlug: "requested-copy", message: "same snapshot" }, 2);
      expect(result.wire[1]!.key).toBe(result.wire[0]!.key);
      expect(result.wire[1]!.body).toBe(result.wire[0]!.body);
      keys.push(result.wire[0]!.key!);
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("retains an explicit key on SDK retries", async () => {
    const result = await h.cli(["duplicate", "source-template", "requested-copy", "--idempotency-key=explicit-retry-01", "--json"], { replies: [
      { status: 429, headers: { "Retry-After": "0" }, body: { error: { code: "rate_limited", message: "Back off", hint: "Retry this request." } } }, ...success,
    ] });
    ok(result);
    wire(result, "/api/v1/sites/source-template/duplicate", { newSlug: "requested-copy" }, 2);
    expect(result.wire.map(req => req.key)).toEqual(["explicit-retry-01", "explicit-retry-01"]);
  });
});

const refusals = [
  { name: "collision", status: 409, code: "slug_taken", exit: 5 },
  { name: "held name", status: 409, code: "slug_reserved", exit: 5 },
  { name: "pending idempotency claim", status: 409, code: "idempotency_in_progress", exit: 5 },
  { name: "reserved system name", status: 400, code: "slug_reserved", exit: 6 },
  { name: "missing or foreign source", status: 404, code: "site_not_found", exit: 4 },
  { name: "transfer source", status: 409, code: "transfer_immutable", exit: 5 },
  { name: "policy refusal", status: 403, code: "feature_unavailable", exit: 3 },
  { name: "quota refusal", status: 413, code: "site_too_large", exit: 6 },
  { name: "unknown server outcome", status: 500, code: "internal_error", exit: 7 },
];
describe("duplicate stable failures without unconditional mutation retries", () => {
  it.each(refusals)("preserves $name status/code/hint/details and exit $exit", async ({ status, code, exit }) => {
    const error = { code, message: "Fixture refusal", hint: "Use an allowed target and retry explicitly.",
      details: { target: "requested-copy", diagnostic: "fixture-kept" }, retryable: code === "idempotency_in_progress" };
    const result = await h.cli(["duplicate", "source-template", "requested-copy", "--json"], {
      replies: [{ status, body: { error, requestId: "req_duplicate_fixture" } }, ...success],
    });
    expect(result.code, result.stdout + result.stderr).toBe(exit);
    expect(duplicateObject(result)).toMatchObject({ ok: false, exitCode: exit,
      error: { ...error, status, requestId: "req_duplicate_fixture" } });
    wire(result, "/api/v1/sites/source-template/duplicate", { newSlug: "requested-copy" });
  });

  it("does not retry a network-failed mutation even with an idempotency key", async () => {
    const result = await h.cli(["duplicate", "source-template", "requested-copy", "--idempotency-key", "recover-unknown-01", "--json"], {
      replies: [{ networkError: true }, ...success],
    });
    expect(result.code, result.stdout + result.stderr).toBe(7);
    expect(duplicateObject(result)).toMatchObject({ ok: false, exitCode: 7, error: { code: "network_error", hint: expect.any(String) } });
    wire(result, "/api/v1/sites/source-template/duplicate", { newSlug: "requested-copy" });
  });
});

describe("duplicate subprocess fixture controls (green on baseline)", () => {
  it("existing raw api reaches the stub with the same receipt and wire format", async () => {
    const result = await h.cli(["api", "POST", "/sites/source-template/duplicate", "--data", '{"newSlug":"requested-copy"}', "--json"], { replies: success });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(duplicateObject(result)).toMatchObject(receipt);
    expect(result.wire).toHaveLength(1);
    expect(result.wire[0]).toMatchObject({ method: "POST", url: duplicateApi + "/api/v1/sites/source-template/duplicate", authenticated: true });
  });
});
