import { describe, expect, it } from "vitest";
import { ApiError } from "@dropway/core";
import { freshInstance, form, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";
import { connectMcp, connectLegacyMcp } from "./mcp-helpers";

// R-03 / SPEC 8.1. These are intentionally RED acceptance tests, not expected
// failures or skips. Keep them enabled when the Builder adds the implementation.
// Metadata injection avoids prescribing a new ApiError constructor signature.
const origin = "https://dropway.test";
const remediation = [{ tool: "get_site", args: { site: "error-fixture" }, why: "read the current site" }];

async function requestError(error: ApiError) {
  const instance = await freshInstance({}, {
    routes: [({ api }) => {
      api.get("/acceptance-error", () => { throw error; });
    }],
  });
  return instance.call("/api/v1/acceptance-error");
}

describe("R-03 error envelope v2", () => {
  it("exposes default retry guidance to direct, non-HTTP ApiError consumers", () => {
    const error = new ApiError(400, "invalid_request", "Invalid input.", "Fix the input.");
    expect(error).toMatchObject({ retryable: false, retryAfterSeconds: null, next: [] });
  });

  it("PIN: preserves the legacy error status, code, message, hint and details", async () => {
    const response = await requestError(new ApiError(400, "invalid_request", "Invalid input.", "Fix the input.", { fixture: true }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request", message: "Invalid input.", hint: "Fix the input.", details: { fixture: true } },
    });
  });

  it("adds non-retryable defaults without losing request correlation", async () => {
    const response = await requestError(new ApiError(400, "invalid_request", "Invalid input.", "Fix the input."));
    const body = await response.json<any>();
    expect(body.requestId).toEqual(expect.any(String));
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(response.headers.get("X-Request-Id")).toBe(body.requestId);
    expect(body.error).toMatchObject({ retryable: false, retryAfterSeconds: null, next: [] });
    expect(body.error.docs).toBe(`${origin}/docs/errors#invalid_request`);
    expect(response.headers.get("Retry-After")).toBeNull();
  });

  it("serializes explicitly supplied retry, documentation and next-call metadata", async () => {
    const error = Object.assign(new ApiError(503, "temporarily_unavailable", "Try later.", "Wait before retrying."), {
      retryable: true,
      retryAfterSeconds: 37,
      docs: `${origin}/docs/errors#temporarily_unavailable`,
      next: remediation,
    });
    const response = await requestError(error);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: {
      retryable: true, retryAfterSeconds: 37,
      docs: `${origin}/docs/errors#temporarily_unavailable`, next: remediation,
    } });
    expect(response.headers.get("Retry-After")).toBe("37");
  });

  for (const status of [429, 503]) {
    it(`sets Retry-After on HTTP ${status} even when the caller supplies no delay`, async () => {
      const response = await requestError(new ApiError(status, "temporarily_unavailable", "Try later.", "Wait before retrying."));
      expect(response.status).toBe(status);
      const body = await response.json<any>();
      const delay = response.headers.get("Retry-After");
      expect(delay, "429/503 must always provide Retry-After").not.toBeNull();
      expect(delay).toMatch(/^\d+$/);
      expect(Number.isSafeInteger(body.error.retryAfterSeconds)).toBe(true);
      expect(body.error.retryAfterSeconds).toBeGreaterThanOrEqual(0);
      expect(Number(delay)).toBe(body.error.retryAfterSeconds);
      expect(body.error.retryable).toBe(true);
    });

    it(`uses the explicit retry delay on HTTP ${status}`, async () => {
      const error = Object.assign(new ApiError(status, "temporarily_unavailable", "Try later.", "Wait before retrying."), {
        retryable: true, retryAfterSeconds: 19,
      });
      const response = await requestError(error);
      expect(response.status).toBe(status);
      expect(response.headers.get("Retry-After")).toBe("19");
      expect(await response.json()).toMatchObject({ error: { retryable: true, retryAfterSeconds: 19 } });
    });
  }

  it("adds the v2 fields to a real core authentication error", async () => {
    const instance = await freshInstance();
    const result = await instance.json("/api/v1/sites");
    expect(result.status).toBe(401);
    expect(result.body.error).toMatchObject({ retryable: false, retryAfterSeconds: null, next: [] });
    expect(result.body.error.docs).toBe(`${ORIGIN}/docs/errors#${result.body.error.code}`);
  });

  for (const [label, connect] of [["modern", connectMcp], ["legacy", connectLegacyMcp]] as const) {
    it(`preserves all error metadata in a ${label} MCP tool failure`, async () => {
      const instance = await freshInstance({}, { mcpTools: [{
        name: "acceptance_refusal",
        description: "Returns an error to exercise the public error envelope.",
        inputSchema: { type: "object", properties: {} },
        async handler() {
          throw Object.assign(new ApiError(503, "temporarily_unavailable", "Try later.", "Wait before retrying.", { fixture: true }), {
            retryable: true, retryAfterSeconds: 37,
            docs: `${ORIGIN}/docs/errors#temporarily_unavailable`, next: remediation,
          });
        },
      }] });
      const client = await connect(instance, instance.ownerKey);
      try {
        const result = await client.call("acceptance_refusal");
        expect(result.isError).toBe(true);
        expect(result.data.error).toMatchObject({
          code: "temporarily_unavailable", message: "Try later.", hint: "Wait before retrying.",
          retryable: true, retryAfterSeconds: 37,
          docs: `${ORIGIN}/docs/errors#temporarily_unavailable`, next: remediation,
          details: { fixture: true },
        });
      } finally { await client.client.close(); }
    });
  }
});

describe("R-03 native rate-limit errors", () => {
  async function limitedPublish() {
    const instance = await freshInstance({ anonymous: { enabled: true, sitesPerHourPerIp: 1 } });
    const headers = { "CF-Connecting-IP": "203.0.113.61" };
    const first = await instance.json("/api/v1/publish", { method: "POST", headers, body: form({ "index.html": "first" }) });
    expect(first.status).toBe(201);
    return instance.json("/api/v1/publish", { method: "POST", headers, body: form({ "index.html": "limited" }) });
  }

  it("PIN: already supplies Retry-After on the core anonymous-creation 429", async () => {
    const result = await limitedPublish();
    expect(result.status).toBe(429);
    expect(result.res.headers.get("Retry-After")).toBe("3600");
  });

  it("includes the same retry delay in the core 429 envelope", async () => {
    const result = await limitedPublish();
    expect(result.status).toBe(429);
    expect(result.body.error).toMatchObject({ retryable: true, retryAfterSeconds: 3600 });
    expect(result.res.headers.get("Retry-After")).toBe(String(result.body.error.retryAfterSeconds));
  });
});

// Field collection encoding is not prescribed by R-03. Accept either a keyed
// object or a list with path/field names; the contract is complete coverage.
function invalidFields(fields: unknown): string[] {
  expect(fields, "validation failures must include details.fields").toBeDefined();
  const paths = Array.isArray(fields)
    ? fields.map((field) => typeof field === "string" ? field : field.path ?? field.field)
    : Object.keys(fields as object);
  return paths.map((path) => (Array.isArray(path) ? path.join(".") : String(path)).replace(/\[(\d+)\]/g, ".$1"));
}

describe("R-03 complete validation errors", () => {
  it("reports all four invalid manifest fields across two files in one REST response", async () => {
    const instance = await freshInstance();
    const created = await instance.json("/api/v1/sites", { key: instance.ownerKey, ...jsonBody({ slug: "validation-rest" }) });
    expect(created.status).toBe(201);
    const result = await instance.json("/api/v1/sites/validation-rest/deploys", { key: instance.ownerKey, ...jsonBody({ files: [
      { path: "one.txt", size: -1, sha256: "not-a-hash" },
      { path: "two.txt", size: -2, sha256: "also-not-a-hash" },
    ] }) });
    expect(result.status).toBe(400);
    expect(invalidFields(result.body.error.details?.fields)).toEqual(expect.arrayContaining([
      "files.0.size", "files.0.sha256", "files.1.size", "files.1.sha256",
    ]));
    const versions = await instance.json("/api/v1/sites/validation-rest/versions", { key: instance.ownerKey });
    expect(versions.status).toBe(200);
    expect(versions.body.versions).toHaveLength(0);
  });

  it("reports every invalid MCP argument rather than just the first", async () => {
    const instance = await freshInstance({}, { mcpTools: [{
      name: "acceptance_validate",
      description: "Validates two independent fields.",
      inputSchema: {
        type: "object", required: ["label", "count"],
        properties: { label: { type: "string" }, count: { type: "integer", minimum: 0 } },
      },
      async handler() { return { accepted: true }; },
    }] });
    const client = await connectMcp(instance, instance.ownerKey);
    try {
      const result = await client.call("acceptance_validate", { label: 42, count: -1 });
      expect(result.isError).toBe(true);
      expect(invalidFields(result.data.error?.details?.fields)).toEqual(expect.arrayContaining(["label", "count"]));
    } finally { await client.client.close(); }
  });
});

async function publish(instance: Instance, slug: string, text: string, client: string) {
  const result = await instance.json("/api/v1/publish", {
    method: "POST", key: instance.ownerKey, headers: { "X-Kofra-Client": client },
    body: form({ "index.html": text }, { slug }),
  });
  expect([200, 201]).toContain(result.status);
  expect(result.body.version.id).toEqual(expect.any(String));
  return result.body.version as { id: string; number: number };
}

async function conflictFixture() {
  const instance = await freshInstance();
  const first = await publish(instance, "conflict-fixture", "first", "old-client/1.0");
  return { instance, first };
}

// SPEC fixes liveVersionId/liveVersionNumber. R-03's additional wire names are
// liveVersionClient and liveVersionAt (publication time, epoch ms per SPEC 7.1).
function expectLiveDetails(error: any, live: { id: string; number: number }, before: number, after: number) {
  expect(error.code).toBe("version_conflict");
  expect(error.details).toMatchObject({ liveVersionId: live.id, liveVersionNumber: live.number, liveVersionClient: "winning-client/2.0" });
  expect(Number.isSafeInteger(error.details.liveVersionAt)).toBe(true);
  expect(error.details.liveVersionAt).toBeGreaterThanOrEqual(before);
  expect(error.details.liveVersionAt).toBeLessThanOrEqual(after);
}

describe("R-03 stale-write remediation", () => {
  it("PIN: keeps prepare-time conflict detection and the actual live version id", async () => {
    const { instance, first } = await conflictFixture();
    const live = await publish(instance, "conflict-fixture", "second", "winning-client/2.0");
    const entry = await manifestEntry("index.html", "third");
    const result = await instance.json("/api/v1/sites/conflict-fixture/deploys", { key: instance.ownerKey, ...jsonBody({
      baseVersionId: first.id, files: [{ path: entry.path, size: entry.size, sha256: entry.sha256 }],
    }) });
    expect(result.status).toBe(409);
    expect(result.body.error).toMatchObject({ code: "version_conflict", details: { liveVersionId: live.id } });
    expect(await (await instance.call("/s/conflict-fixture/")).text()).toBe("second");
  });

  it("identifies the winning client and publication time on a stale prepare", async () => {
    const { instance, first } = await conflictFixture();
    const before = Date.now();
    const live = await publish(instance, "conflict-fixture", "second", "winning-client/2.0");
    const after = Date.now();
    const entry = await manifestEntry("index.html", "third");
    const result = await instance.json("/api/v1/sites/conflict-fixture/deploys", { key: instance.ownerKey, ...jsonBody({
      baseVersionId: first.id, files: [{ path: entry.path, size: entry.size, sha256: entry.sha256 }],
    }) });
    expect(result.status).toBe(409);
    expectLiveDetails(result.body.error, live, before, after);
  });

  it("reports the winner if live advances after prepare but before finalize", async () => {
    const { instance, first } = await conflictFixture();
    const entry = await manifestEntry("index.html", "losing pending bytes");
    const pending = await instance.json("/api/v1/sites/conflict-fixture/deploys", { key: instance.ownerKey, ...jsonBody({
      baseVersionId: first.id, files: [{ path: entry.path, size: entry.size, sha256: entry.sha256 }],
    }) });
    expect(pending.status).toBe(201);
    const uploaded = await instance.call(`/api/v1/blobs/${entry.sha256}`, {
      method: "PUT", key: instance.ownerKey, body: entry.bytes, headers: { "Content-Length": String(entry.size) },
    });
    expect(uploaded.status).toBe(201);
    const before = Date.now();
    const live = await publish(instance, "conflict-fixture", "winner after prepare", "winning-client/2.0");
    const after = Date.now();
    const result = await instance.json(`/api/v1/sites/conflict-fixture/deploys/${pending.body.deploy.id}/finalize`, {
      method: "POST", key: instance.ownerKey,
    });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("version_conflict");
    // Protect the side effect even while the metadata assertion is RED.
    expect(await (await instance.call("/s/conflict-fixture/")).text()).toBe("winner after prepare");
    expectLiveDetails(result.body.error, live, before, after);
  });

  it("provides a usable get_site next call for a stale partial update", async () => {
    const { instance, first } = await conflictFixture();
    const before = Date.now();
    const live = await publish(instance, "conflict-fixture", "second", "winning-client/2.0");
    const after = Date.now();
    const client = await connectMcp(instance, instance.ownerKey);
    try {
      const result = await client.call("update_site_files", { site: "conflict-fixture", baseVersionId: first.id, files: [{ path: "index.html", content: "stale" }] });
      expect(result.isError).toBe(true);
      expect(result.data.error.retryable).toBe(false);
      const next = result.data.error.next;
      expect(next).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "get_site", args: { site: "conflict-fixture" }, why: expect.any(String) })]));
      const instruction = next.find((step: any) => step.tool === "get_site");
      const recovered = await client.call(instruction.tool, instruction.args);
      expect(recovered.isError).toBe(false);
      expect(recovered.data.site.slug).toBe("conflict-fixture");
      expectLiveDetails(result.data.error, live, before, after);
    } finally { await client.client.close(); }
  });
});
