import { describe, expect, it } from "vitest";
import { DropwayClient, DropwayError, type FetchLike, type RequestOptions } from "../src/index.ts";

const RAW_KEY = "retained-valid-intent";
const RECEIPT = { ok: true };
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

type EntryPoint = {
  name: string;
  invoke(client: DropwayClient, options: RequestOptions): Promise<unknown>;
};

const ENTRIES: EntryPoint[] = [
  { name: "request (JSON)", invoke: (client, options) => client.request("POST", "/publish", { ...options, json: {} }) },
  { name: "requestBytes", invoke: (client, options) => client.requestBytes("POST", "/bytes", { ...options, json: {} }) },
  { name: "restoreVersion", invoke: (client, options) => client.restoreVersion({ slug: "site_fixture", id: "ver_fixture" }, options) },
  { name: "deleteVersion", invoke: (client, options) => client.deleteVersion({ slug: "site_fixture", id: "ver_fixture", confirm: "fixture" }, options) },
];

const VALID = [
  { label: "1 character", key: "!" },
  { label: "255 characters", key: "k".repeat(254) + "~" },
];

// Removing all but the empty-string check must fail this matrix, even where
// Headers would otherwise trim/coerce a key or throw its own untyped error.
const INVALID: Array<{ label: string; value: unknown }> = [
  { label: "empty", value: "" },
  { label: "256 characters", value: "k".repeat(256) },
  { label: "leading ASCII space", value: " key" },
  { label: "trailing ASCII space", value: "key " },
  { label: "embedded ASCII space", value: "two keys" },
  { label: "NUL control", value: "key\u0000value" },
  { label: "tab control", value: "key\tvalue" },
  { label: "LF control", value: "key\nvalue" },
  { label: "CR control", value: "key\rvalue" },
  { label: "DEL control", value: "key\u007fvalue" },
  { label: "high-bit byte", value: "key\u0080" },
  { label: "Latin-1 byte (octal 377)", value: "keyÿ" },
  { label: "non-ByteString Unicode", value: "keyĀ" },
  { label: "surrogate-pair Unicode", value: "key\u{1f600}" },
  { label: "number", value: 42 },
  { label: "boolean", value: false },
  { label: "object", value: { key: "valid-looking" } },
  { label: "array", value: ["valid-looking"] },
  { label: "null", value: null },
];

function transport(handler: (request: Request, attempt: number) => Response | Promise<Response> = () => json(RECEIPT)) {
  const requests: Request[] = [];
  const fetch: FetchLike = async request => {
    requests.push(request);
    return handler(request, requests.length);
  };
  const client = new DropwayClient({ api: "https://sdk.test", token: null, fetch, attempts: 3, backoffMs: 1 });
  return { client, requests };
}

for (const entry of ENTRIES) describe(`${entry.name} idempotency-key boundary`, () => {
  for (const retained of [false, true]) describe(retained ? "with a retained raw header" : "without a raw header", () => {
    it.each(INVALID)("rejects $label locally with a stable, non-retryable error", async ({ value }) => {
      const h = transport();
      // Exercise untyped callers at the public boundary, without widening the SDK.
      const options: RequestOptions = {
        idempotencyKey: value as string,
        ...(retained ? { headers: { "Idempotency-Key": RAW_KEY } } : {}),
      };
      const error: unknown = await Promise.resolve().then(() => entry.invoke(h.client, options))
        .then(() => null, error => error);
      expect.soft(error, "invalid options cannot execute unkeyed or replay the retained header").toBeInstanceOf(DropwayError);
      expect.soft(error).toMatchObject({
        code: "invalid_idempotency_key",
        retryable: false,
        hint: expect.stringMatching(/(?:key|UUID|ASCII|character|space)/i),
      });
      expect.soft(h.requests.length, "reject before ANY fetch, including automatic retries").toBe(0);
      expect.soft(options.idempotencyKey, "do not normalize the caller's supplied option").toBe(value);
      if (retained) expect.soft(options.headers).toEqual({ "Idempotency-Key": RAW_KEY });
    });

    it.each(VALID)("accepts $label verbatim; the option wins over a retained header", async ({ key }) => {
      const h = transport();
      const options: RequestOptions = {
        idempotencyKey: key,
        ...(retained ? { headers: { "Idempotency-Key": RAW_KEY } } : {}),
      };
      await entry.invoke(h.client, options);
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]!.headers.get("Idempotency-Key")).toBe(key);
      if (retained) expect(options.headers).toEqual({ "Idempotency-Key": RAW_KEY });
    });

    it.each(["absent", "explicit undefined"] as const)("keeps an %s option compatible without inventing a key", async presence => {
      const h = transport();
      const options: RequestOptions = {
        ...(presence === "explicit undefined" ? { idempotencyKey: undefined } : {}),
        ...(retained ? { headers: { "Idempotency-Key": RAW_KEY } } : {}),
      };
      await entry.invoke(h.client, options);
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]!.headers.get("Idempotency-Key")).toBe(retained ? RAW_KEY : null);
    });
  });
});

for (const entry of ENTRIES.filter(entry => entry.name === "restoreVersion" || entry.name === "deleteVersion")) {
  it.each(["safe", "rate-limit"] as const)(`${entry.name} enforces one attempt despite retry:%s and a valid boundary key`, async retry => {
    const h = transport((_request, attempt) => attempt === 1
      ? json({ error: { code: "rate_limited", message: "Slow down.", hint: "Retain the same intent." } }, 429, { "Retry-After": "0" })
      : json(RECEIPT));
    const key = VALID[1]!.key;
    const error: unknown = await entry.invoke(h.client, {
      idempotencyKey: key, headers: { "Idempotency-Key": RAW_KEY }, retry,
    }).then(() => null, error => error);
    expect(error, "must not retry to the later success").toBeInstanceOf(DropwayError);
    expect(error).toMatchObject({ code: "rate_limited", status: 429 });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.headers.get("Idempotency-Key")).toBe(key);
  });
}
