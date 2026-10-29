/**
 * BLIND failing acceptance: SDK restore/deleteVersion replay contract + retry:'none' (P3 scope).
 *
 * P3 is replay only. Historical-reference expansion/activation is EXPLICITLY
 * OUT OF SCOPE: no historical tests here, no new flag.
 *
 * Contract under test:
 * - Typed `restoreVersion` and `deleteVersion` never automatically retry:
 *   exactly ONE fetch for 429 (including Retry-After), 5xx, network loss
 *   and 409, even when a retry would succeed. They honor an explicit
 *   `RequestOptions.idempotencyKey` / `CallOptions.idempotencyKey` on that
 *   single fetch.
 * - Low-level transport supports `retry: 'none'` = one fetch including 429
 *   (with Retry-After). Safe/rate-limit and GET default behavior is
 *   preserved (those tests stay green).
 *
 * Harness: stub fetch only. No network. Future `retry: 'none'` is passed
 * via a locally widened structural variable so the file typechecks on the
 * baseline (`retry?: "safe" | "rate-limit"`) and exercises runtime behavior.
 */
import { describe, expect, it } from "vitest";
import {
  DropwayClient,
  DropwayError,
  type CallOptions,
  type FetchLike,
  type RequestOptions,
} from "../src/index.ts";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

// Locally widened structural variable for the future retry option. Avoids a
// typecheck-only RED on the baseline while testing runtime behavior.
function noneRetry(): RequestOptions {
  return { retry: "none" } as unknown as RequestOptions;
}
function noneCall(): CallOptions {
  return { retry: "none" } as unknown as CallOptions;
}
function noneCallWithKey(key: string): CallOptions {
  return { retry: "none", idempotencyKey: key } as unknown as CallOptions;
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> } | { network: true };

function stubReplies(replies: Reply[]) {
  const requests: Request[] = [];
  let calls = 0;
  const fetch = (async (req: Request) => {
    requests.push(req);
    const reply = replies[Math.min(calls++, replies.length - 1)]!;
    if ("network" in reply) throw new TypeError("fixture network loss");
    return json(reply.body, reply.status, reply.headers ?? {});
  }) as FetchLike & { requests: Request[] };
  fetch.requests = requests;
  return { fetch, requests, calls: () => calls };
}

async function threw(p: Promise<unknown>): Promise<DropwayError> {
  try {
    const value = await p;
    expect(
      value,
      "expected the call to throw after exactly one fetch, but it succeeded by retrying",
    ).toBeUndefined();
    throw new Error("expected the call to throw after exactly one fetch");
  } catch (e) {
    if (e instanceof DropwayError) return e;
    // A success value above fails the expect with a clear retry message; do
    // not mask it as a DropwayError assertion.
    throw e;
  }
}

const RATE = { error: { code: "rate_limited", message: "slow down" } };
const BOOM = { error: { code: "internal_error", message: "boom" } };
const CONFLICT = { error: { code: "version_conflict", message: "moved", hint: "Refetch." } };

describe("restoreVersion never automatically retries", () => {
  it("429 with Retry-After: one fetch, throws, no retry to success", async () => {
    const s = stubReplies([
      { status: 429, headers: { "Retry-After": "0" }, body: RATE },
      { status: 200, body: { restored: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    const e = await threw(c.restoreVersion({ slug: "s", id: "ver_1" }));
    expect(e.code).toBe("rate_limited");
    expect(s.calls()).toBe(1);
    expect(s.requests).toHaveLength(1);
  });

  it("429 without Retry-After: one fetch", async () => {
    const s = stubReplies([
      { status: 429, body: RATE },
      { status: 200, body: { restored: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await threw(c.restoreVersion({ slug: "s", id: "ver_1" }));
    expect(s.calls()).toBe(1);
  });

  it("honors an explicit idempotencyKey on its single 429 fetch", async () => {
    const s = stubReplies([
      { status: 429, headers: { "Retry-After": "0" }, body: RATE },
      { status: 200, body: { restored: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await threw(c.restoreVersion({ slug: "s", id: "ver_1" }, { idempotencyKey: "explicit-restore-01" }));
    expect(s.calls()).toBe(1);
    expect(s.requests[0]!.headers.get("Idempotency-Key")).toBe("explicit-restore-01");
  });

  it("explicit idempotencyKey plus retry none stays one fetch for 429", async () => {
    const s = stubReplies([
      { status: 429, headers: { "Retry-After": "0" }, body: RATE },
      { status: 200, body: { restored: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await threw(c.restoreVersion({ slug: "s", id: "ver_1" }, noneCallWithKey("k-restore-none-01")));
    expect(s.calls()).toBe(1);
    expect(s.requests[0]!.headers.get("Idempotency-Key")).toBe("k-restore-none-01");
  });

  it("5xx: one fetch", async () => {
    const s = stubReplies([
      { status: 500, body: BOOM },
      { status: 200, body: { restored: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await threw(c.restoreVersion({ slug: "s", id: "ver_1" }));
    expect(s.calls()).toBe(1);
  });

  it("network loss: one fetch", async () => {
    const s = stubReplies([{ network: true }, { status: 200, body: { restored: true } }]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    const e = await threw(c.restoreVersion({ slug: "s", id: "ver_1" }));
    expect(e.code).toBe("network_error");
    expect(s.calls()).toBe(1);
  });

  it("409: one fetch", async () => {
    const s = stubReplies([
      { status: 409, body: CONFLICT },
      { status: 200, body: { restored: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    const e = await threw(c.restoreVersion({ slug: "s", id: "ver_1" }));
    expect(e.code).toBe("version_conflict");
    expect(s.calls()).toBe(1);
  });

  it("sends an explicit idempotencyKey on success", async () => {
    const s = stubReplies([{ status: 200, body: { restored: true } }]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch });
    await c.restoreVersion({ slug: "s", id: "ver_1" }, { idempotencyKey: "k-restore-ok-01" });
    expect(s.calls()).toBe(1);
    expect(s.requests[0]!.headers.get("Idempotency-Key")).toBe("k-restore-ok-01");
  });
});

describe("deleteVersion never automatically retries", () => {
  it("429 with Retry-After: one fetch, throws, no retry to success", async () => {
    const s = stubReplies([
      { status: 429, headers: { "Retry-After": "0" }, body: RATE },
      { status: 200, body: { deleted: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    const e = await threw(c.deleteVersion({ slug: "s", id: "ver_1", confirm: "s" }));
    expect(e.code).toBe("rate_limited");
    expect(s.calls()).toBe(1);
  });

  it("honors an explicit idempotencyKey on its single 429 fetch", async () => {
    const s = stubReplies([
      { status: 429, headers: { "Retry-After": "0" }, body: RATE },
      { status: 200, body: { deleted: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await threw(c.deleteVersion({ slug: "s", id: "ver_1", confirm: "s" }, { idempotencyKey: "explicit-delete-01" }));
    expect(s.calls()).toBe(1);
    expect(s.requests[0]!.headers.get("Idempotency-Key")).toBe("explicit-delete-01");
  });

  it("5xx: one fetch", async () => {
    const s = stubReplies([
      { status: 503, body: BOOM },
      { status: 200, body: { deleted: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await threw(c.deleteVersion({ slug: "s", id: "ver_1", confirm: "s" }));
    expect(s.calls()).toBe(1);
  });

  it("network loss: one fetch", async () => {
    const s = stubReplies([{ network: true }, { status: 200, body: { deleted: true } }]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await threw(c.deleteVersion({ slug: "s", id: "ver_1", confirm: "s" }));
    expect(s.calls()).toBe(1);
  });

  it("409: one fetch", async () => {
    const s = stubReplies([
      { status: 409, body: CONFLICT },
      { status: 200, body: { deleted: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await threw(c.deleteVersion({ slug: "s", id: "ver_1", confirm: "s" }));
    expect(s.calls()).toBe(1);
  });

  it("sends an explicit idempotencyKey on success", async () => {
    const s = stubReplies([{ status: 200, body: { deleted: true } }]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch });
    await c.deleteVersion({ slug: "s", id: "ver_1", confirm: "s" }, { idempotencyKey: "k-delete-ok-01" });
    expect(s.calls()).toBe(1);
    expect(s.requests[0]!.headers.get("Idempotency-Key")).toBe("k-delete-ok-01");
  });
});

describe.each(["restoreVersion", "deleteVersion"] as const)("%s overrides caller retry policies", method => {
  const cases: Array<{ label: string; retry: "safe" | "rate-limit"; first: Reply; code: string }> = [
    { label: "429", retry: "safe", first: { status: 429, headers: { "Retry-After": "0" }, body: RATE }, code: "rate_limited" },
    { label: "429", retry: "rate-limit", first: { status: 429, headers: { "Retry-After": "0" }, body: RATE }, code: "rate_limited" },
    { label: "network loss", retry: "safe", first: { network: true }, code: "network_error" },
    { label: "500", retry: "safe", first: { status: 500, body: BOOM }, code: "internal_error" },
    { label: "503", retry: "safe", first: { status: 503, body: BOOM }, code: "internal_error" },
  ];

  it.each(cases)("$retry cannot resubmit after $label even when a second fetch would succeed", async ({ label, retry, first, code }) => {
    const s = stubReplies([first, { status: 200, body: { restored: true, deleted: true } }]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    const key = `caller-${method}-${retry}-${label.replaceAll(" ", "-")}`;
    const opts: CallOptions = { retry, idempotencyKey: key };
    const call = method === "restoreVersion"
      ? c.restoreVersion({ slug: "s", id: "ver_1" }, opts)
      : c.deleteVersion({ slug: "s", id: "ver_1", confirm: "s" }, opts);
    const error = await threw(call);
    expect(error.code, "preserve the first rejection, not the later success").toBe(code);
    expect(s.calls(), "caller retry options cannot override a single-attempt intent").toBe(1);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.headers.get("Idempotency-Key")).toBe(key);
    expect(s.requests[0]!.method).toBe(method === "restoreVersion" ? "POST" : "DELETE");
    expect(new URL(s.requests[0]!.url).pathname).toBe(`/api/v1/sites/s/versions/ver_1${method === "restoreVersion" ? "/restore" : ""}`);
  });
});

describe("transport retry:'none' means one fetch including 429", () => {
  it("POST with retry none and Retry-After 429: one fetch", async () => {
    const s = stubReplies([
      { status: 429, headers: { "Retry-After": "0" }, body: RATE },
      { status: 200, body: { ok: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    const e = await threw(c.post("/sites", {}, noneRetry()));
    expect(e.code).toBe("rate_limited");
    expect(s.calls()).toBe(1);
  });

  it("GET with retry none and 429: one fetch", async () => {
    const s = stubReplies([
      { status: 429, headers: { "Retry-After": "0" }, body: RATE },
      { status: 200, body: { ok: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await threw(c.get("/sites", noneRetry()));
    expect(s.calls()).toBe(1);
  });

  it("GET with retry none and network then success stops at one fetch", async () => {
    const s = stubReplies([{ network: true }, { status: 200, body: { ok: true } }]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    const e = await threw(c.get("/sites", noneRetry()));
    expect(e.code).toBe("network_error");
    expect(s.calls()).toBe(1);
  });

  it("request() with retry none and 500 then success still throws after one fetch", async () => {
    const s = stubReplies([
      { status: 500, body: BOOM },
      { status: 200, body: { ok: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await threw(c.request("GET", "/sites", noneRetry()));
    expect(s.calls()).toBe(1);
  });

  it("typed restore with retry none and 429: one fetch", async () => {
    const s = stubReplies([
      { status: 429, headers: { "Retry-After": "0" }, body: RATE },
      { status: 200, body: { restored: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await threw(c.restoreVersion({ slug: "s", id: "ver_1" }, noneCall()));
    expect(s.calls()).toBe(1);
  });

  it("typed delete with retry none and 429: one fetch", async () => {
    const s = stubReplies([
      { status: 429, headers: { "Retry-After": "0" }, body: RATE },
      { status: 200, body: { deleted: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await threw(c.deleteVersion({ slug: "s", id: "ver_1", confirm: "s" }, noneCall()));
    expect(s.calls()).toBe(1);
  });
});

describe("safe/rate-limit and GET defaults are preserved", () => {
  it("GET default still retries 429 within the cap", async () => {
    const s = stubReplies([
      { status: 429, headers: { "Retry-After": "0" }, body: RATE },
      { status: 200, body: { ok: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await expect(c.get("/sites")).resolves.toMatchObject({ status: 200 });
    expect(s.calls()).toBe(2);
  });

  it("generic POST default still retries 429 within the cap", async () => {
    const s = stubReplies([
      { status: 429, headers: { "Retry-After": "0" }, body: RATE },
      { status: 200, body: { ok: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await expect(c.post("/sites", {})).resolves.toMatchObject({ status: 200 });
    expect(s.calls()).toBe(2);
  });

  it("generic POST default still does one fetch for 5xx (safe-only)", async () => {
    const s = stubReplies([
      { status: 500, body: BOOM },
      { status: 200, body: { ok: true } },
    ]);
    const c = new DropwayClient({ api: "https://sdk.test", token: null, fetch: s.fetch, backoffMs: 1, attempts: 3 });
    await threw(c.post("/sites", {}));
    expect(s.calls()).toBe(1);
  });
});
