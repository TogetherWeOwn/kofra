import { afterEach, describe, expect, it, vi } from "vitest";
import { DropwayClient, DropwayError, type FetchLike } from "../src/index.ts";

// These fixtures specify fidelity, not permission to execute suggested calls.
const next = [{ tool: "get_version", args: { site: "sample", version: "ver_old" }, why: "Read the immutable base before retrying." }];
const fields = { code: "version_conflict", message: "The live version moved.", hint: "Read the current version.", details: { liveVersionId: "ver_new" } };
const json = (body: unknown, status = 409, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

async function failure(body: unknown, status = 409, headers: Record<string, string> = {}) {
  const requests: Request[] = [];
  const client = new DropwayClient({ api: "https://recovery.test", token: "dw_disposable_sentinel", attempts: 1,
    fetch: (async request => { requests.push(request); return json(body, status, headers); }) as FetchLike });
  const error = await client.get("/sites/sample").then(() => { throw new Error("fixture must return an error"); }, e => e);
  expect(error).toBeInstanceOf(DropwayError);
  expect(requests).toHaveLength(1);
  return error as DropwayError;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("server recovery metadata fidelity", () => {
  it.each([0, null, 12])("retains delay %j, docs and next in the SDK error and JSON", async retryAfterSeconds => {
    const error = await failure({ error: { ...fields, retryable: false, retryAfterSeconds, docs: "/docs/errors#version_conflict", next }, requestId: "body-request" });
    const expected = { ...fields, status: 409, retryable: false, retryAfterSeconds, docs: "/docs/errors#version_conflict", next, requestId: "body-request" };
    expect(error).toMatchObject(expected);
    expect(error.toJSON()).toEqual(expected);
  });

  it.each([[503, false], [409, true], [429, false], [400, true]] as const)("respects explicit retryable %s/%s without redefining scheduling", async (status, retryable) => {
    const error = await failure({ error: { ...fields, retryable, retryAfterSeconds: null, docs: "https://docs.test/recovery", next: [] } }, status);
    expect(error.retryable).toBe(retryable);
    expect(error.toJSON()).toMatchObject({ retryable, retryAfterSeconds: null, docs: "https://docs.test/recovery", next: [] });
  });

  it.each([undefined, null, "false", 0, {}, []].map(retryable => ({ retryable })))("uses status fallback for absent/invalid retryable $retryable", async ({ retryable }) => {
    for (const [status, want] of [[409, false], [429, true], [503, true], [500, true], [400, false]] as const) {
      const error = await failure({ error: { ...fields, retryable } }, status);
      expect(error.retryable).toBe(want);
    }
  });

  it("preserves legacy construction/JSON without inventing optional metadata", () => {
    const error = new DropwayError({ ...fields, status: 409, retryable: false });
    expect(JSON.parse(JSON.stringify(error))).toEqual({ ...fields, status: 409, retryable: false });
  });

  it("serializes directly constructed recovery errors as well as HTTP errors", () => {
    const options = { ...fields, status: 409, retryable: false, retryAfterSeconds: 0, docs: "/docs/errors#version_conflict", next: [] };
    expect(new DropwayError(options).toJSON()).toEqual(options);
  });

  it.each([
    { retryAfterSeconds: -1, docs: {}, next: "get_version" },
    { retryAfterSeconds: "0", docs: ["/docs/errors"], next: {} },
    { retryAfterSeconds: 0.5, docs: 42, next: null },
    { retryAfterSeconds: 9007199254740992, docs: null, next: [{ tool: 1, args: {}, why: "read" }] },
    { retryAfterSeconds: false, docs: false, next: [{ tool: "get_version", args: [], why: "read" }] },
    { retryAfterSeconds: {}, docs: {}, next: [{ tool: "get_version", args: {}, why: 7 }] },
    { retryAfterSeconds: [], docs: [], next: [{ tool: "get_version", why: "read" }] },
  ])("drops malformed optional shapes without losing the legacy envelope: %j", async optional => {
    const error = await failure({ error: { ...fields, ...optional }, requestId: "legacy-request" });
    const value = JSON.parse(JSON.stringify(error));
    expect(value).toEqual({ ...fields, status: 409, retryable: false, requestId: "legacy-request" });
  });

  it.each([
    { optional: { retryAfterSeconds: -1, docs: "/docs/errors", next: [] }, want: { docs: "/docs/errors", next: [] } },
    { optional: { retryAfterSeconds: 0, docs: {}, next: [] }, want: { retryAfterSeconds: 0, next: [] } },
    { optional: { retryAfterSeconds: null, docs: "/docs/errors", next: [{}] }, want: { retryAfterSeconds: null, docs: "/docs/errors" } },
  ])("validates optional fields independently: $optional", async ({ optional, want }) => {
    const error = await failure({ error: { ...fields, ...optional } });
    expect(JSON.parse(JSON.stringify(error))).toEqual({ ...fields, status: 409, retryable: false, ...want });
  });

  it("allowlists envelope and next-call fields rather than copying raw diagnostic secrets", async () => {
    const secret = "disposable-raw-response-sentinel";
    const error = await failure({ error: { ...fields, retryable: false, retryAfterSeconds: 0,
      docs: "/docs/errors", next: [{ ...next[0], authorization: secret, headers: { cookie: secret } }],
      headers: { authorization: secret }, cookie: secret, token: secret, rawResponse: secret }, token: secret }, 409, { "Set-Cookie": secret });
    expect(JSON.parse(JSON.stringify(error))).toEqual({ ...fields, status: 409, retryable: false, retryAfterSeconds: 0, docs: "/docs/errors", next });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("dw_disposable_sentinel");
  });

  it("prefers the body requestId over the header and uses the header when absent", async () => {
    expect((await failure({ error: fields, requestId: "body-request" }, 409, { "X-Request-Id": "header-request" })).requestId).toBe("body-request");
    expect((await failure({ error: fields }, 409, { "X-Request-Id": "header-request" })).requestId).toBe("header-request");
  });

  it("keeps non-JSON failures bounded without serializing response bodies or headers", async () => {
    const sentinel = "disposable-html-secret";
    const client = new DropwayClient({ api: "https://recovery.test", token: null, attempts: 1,
      fetch: async () => new Response(`<html>${"upstream unavailable ".repeat(2000)}${sentinel}</html>`, { status: 502, headers: { "X-Request-Id": "html-request", "Set-Cookie": sentinel } }) });
    const error = await client.get("/sites").catch(e => e as DropwayError);
    expect(error).toBeInstanceOf(DropwayError);
    expect(error).toMatchObject({ code: "http_502", status: 502, retryable: true, requestId: "html-request" });
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect(JSON.stringify(error).length).toBeLessThan(1500);
  });
});

describe("recovery metadata does not change retry/execution policy", () => {
  it.each(["GET", "HEAD", "PUT", "DELETE", "POST", "PATCH"])("keeps %s attempt limits and exponential backoff despite retryable:false", async method => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const calls: { method: string; url: string; at: number; key: string | null; body: string }[] = [];
    const client = new DropwayClient({ api: "https://recovery.test", token: null, attempts: 3, backoffMs: 10,
      fetch: async request => {
        calls.push({ method: request.method, url: request.url, at: Date.now(), key: request.headers.get("Idempotency-Key"), body: await request.text() });
        return json({ error: { ...fields, retryable: false, retryAfterSeconds: 9000, docs: "https://never-follow.test/docs", next: [{ tool: "publish_site", args: { slug: "never-publish" }, why: "Data only." }] } }, 503);
      } });
    const result = client.request(method, "/sites/sample", { ...(method === "POST" || method === "PATCH" ? { json: { name: "sample" } } : {}) }).catch(e => e);
    await vi.runAllTimersAsync();
    const error = await result;
    // Baseline transport retries only reads, not all HTTP-idempotent verbs.
    const safe = ["GET", "HEAD"].includes(method);
    expect(calls.map(c => c.at)).toEqual(safe ? [0, 10, 30] : [0]);
    expect(calls.every(c => c.url === "https://recovery.test/api/v1/sites/sample" && c.method === method && c.key === null)).toBe(true);
    expect(error).toBeInstanceOf(DropwayError);
    expect(error.retryable).toBe(false);
  });

  it.each(["GET", "HEAD", "PUT", "DELETE", "POST", "PATCH"])("preserves %s network-failure attempts and delays", async method => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const times: number[] = [];
    const client = new DropwayClient({ api: "https://recovery.test", token: null, attempts: 3, backoffMs: 10,
      fetch: async () => { times.push(Date.now()); throw new Error("disposable network failure"); } });
    const result = client.request(method, "/sites/sample").catch(e => e);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(times).toEqual(["GET", "HEAD"].includes(method) ? [0, 10, 30] : [0]);
    expect(error).toMatchObject({ code: "network_error", retryable: true });
  });

  it("does not turn an idempotency key into permission to retry unsafe POST", async () => {
    const requests: Request[] = [];
    const bodies: string[] = [];
    const client = new DropwayClient({ api: "https://recovery.test", token: null, attempts: 3, backoffMs: 1,
      fetch: async request => { requests.push(request); bodies.push(await request.text()); return json({ error: { ...fields, retryable: true, next } }, 503); } });
    await client.post("/sites", { slug: "sample" }, { idempotencyKey: "disposable-recovery-key" }).catch(() => {});
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("Idempotency-Key")).toBe("disposable-recovery-key");
    expect(bodies).toEqual(['{"slug":"sample"}']);
  });

  it("uses Retry-After header seconds, not envelope delay, for 429 scheduling", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const times: number[] = [];
    const client = new DropwayClient({ api: "https://recovery.test", token: null, attempts: 3, backoffMs: 10,
      fetch: async () => { times.push(Date.now()); return json({ error: { ...fields, retryable: false, retryAfterSeconds: 9999, next } }, 429, { "Retry-After": "2" }); } });
    const result = client.get("/sites").catch(e => e);
    await vi.runAllTimersAsync(); await result;
    expect(times).toEqual([0, 2000, 4000]);
  });

  it("does not retry a 409 merely because metadata says retryable:true", async () => {
    const calls: string[] = [];
    const client = new DropwayClient({ api: "https://recovery.test", token: null, attempts: 3, backoffMs: 1,
      fetch: async request => { calls.push(request.url); return json({ error: { ...fields, retryable: true, next, docs: "https://never-follow.test/docs" } }); } });
    await client.get("/sites/sample").catch(() => {});
    expect(calls).toEqual(["https://recovery.test/api/v1/sites/sample"]);
  });
});
