import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { freshInstance, jsonBody, type Instance } from "./helpers";

// Public REST acceptance contract: SPEC 9.2 / PUB-08. Only external fetch is mocked;
// routing, identity, D1, R2 and KV run in workerd. This does not test DNS rebinding.
let dw: Instance;
beforeEach(async () => { dw = await freshInstance({ anonymous: { enabled: true } }); });
afterEach(() => { vi.restoreAllMocks(); });

const callerHeaders = {
  Authorization: "Bearer fixture-source-only",
  "X-Asset-Key": "fixture-asset-only",
  "X-Caller-Trace": "fixture-trace-only",
  Accept: "application/octet-stream",
};
const bytes = new Uint8Array([0, 255, 128, 13, 10, 65]);

function externalRedirects(urls: readonly string[]) {
  const seen: { url: string; headers: Headers }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const index = seen.length;
    seen.push({ url: request.url, headers: new Headers(request.headers) });
    // Fail closed: an unplanned fetch cannot accidentally return fixture bytes.
    if (request.url !== urls[index]) return new Response("unexpected external URL", { status: 400 });
    const next = urls[index + 1];
    if (next !== undefined) {
      return new Response(null, { status: 302, headers: { Location: next } });
    }
    return new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } });
  });
  return seen;
}

async function publishRemote(url: string) {
  const result = await dw.json("/api/v1/publish", {
    ...jsonBody({ files: [{ path: "asset.bin", url, headers: callerHeaders }] }), key: dw.ownerKey,
  });
  expect(result.status).toBe(201);
  expect(result.body.status).toBe("live");
  expect(result.body.files).toMatchObject({ total: 1, fetched: 1, pending: 0 });
  const raw = await dw.call(new URL("asset.bin?raw=1", result.body.url).href);
  expect(raw.status).toBe(200);
  expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytes);
}

function expectCallerHeaders(headers: Headers, retained: boolean) {
  for (const [name, value] of Object.entries(callerHeaders)) {
    expect.soft(headers.get(name), `${name} must ${retained ? "survive" : "be stripped after"} the redirect boundary`)
      .toBe(retained ? value : null);
  }
}

function anonymousPublish(body: Record<string, unknown>, key: string, ip: string) {
  const init = jsonBody(body);
  return dw.json("/api/v1/publish", {
    ...init, headers: { ...init.headers, "Idempotency-Key": key, "CF-Connecting-IP": ip },
  });
}

async function expectAnonymousSites(count: number) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM sites WHERE tenant_id IS NULL").first<{ count: number }>();
  expect(row?.count).toBe(count);
}

function expectAnonymousResult(result: Awaited<ReturnType<typeof anonymousPublish>>) {
  expect(result.status).toBe(201);
  expect(result.body.status).toBe("live");
  expect(result.body.site.anonymous).toBe(true);
  expect(result.body.claim.token).toMatch(/^dwc_\S+$/);
}

describe("URL source redirect header boundaries", () => {
  // Catches stripping credentials on every redirect instead of only cross-origin.
  it("retains every caller header over same-origin HTTPS redirects and stores exact bytes", async () => {
    const urls = ["https://93.184.216.34/start", "https://93.184.216.34/middle", "https://93.184.216.34/end"];
    const seen = externalRedirects(urls);
    await publishRemote(urls[0]!);
    expect(seen.map((hop) => hop.url)).toEqual(urls);
    for (const hop of seen) expectCallerHeaders(hop.headers, true);
  });

  // Catches forwarding either credentials or non-sensitive caller headers cross-origin.
  it("strips ALL caller headers across origins while still publishing exact bytes", async () => {
    const urls = ["https://93.184.216.34/start", "https://93.184.216.35/end"];
    const seen = externalRedirects(urls);
    await publishRemote(urls[0]!);
    expect(seen.map((hop) => hop.url)).toEqual(urls);
    expectCallerHeaders(seen[0]!.headers, true);
    expectCallerHeaders(seen[1]!.headers, false);
  });

  // Catches restoring the original header map when the chain returns to its origin.
  it("never restores caller headers after a cross-origin hop redirects back", async () => {
    const urls = [
      "https://93.184.216.34/start", "https://93.184.216.35/away",
      "https://93.184.216.34/back", "https://93.184.216.34/end",
    ];
    const seen = externalRedirects(urls);
    await publishRemote(urls[0]!);
    expect(seen.map((hop) => hop.url)).toEqual(urls);
    expectCallerHeaders(seen[0]!.headers, true);
    for (const hop of seen.slice(1)) expectCallerHeaders(hop.headers, false);
  });
});

describe("anonymous JSON publish idempotency", () => {
  // Catches anonymous writes skipping replay, losing the first claim credential.
  it("replays the entire first result including its usable claim token and creates only one site", async () => {
    const body = { files: [{ path: "note.txt", content: "anonymous replay bytes" }] };
    const first = await anonymousPublish(body, "anonymous-replay", "203.0.113.9");
    expectAnonymousResult(first);
    const replay = await anonymousPublish(body, "anonymous-replay", "203.0.113.9");
    expect.soft(replay.status).toBe(first.status);
    expect.soft(replay.body).toEqual({ ...first.body, replayed: true });
    expect.soft(replay.body.claim.token).toBe(first.body.claim.token);
    await expectAnonymousSites(1);
    const stored = await dw.call(`/api/v1/sites/${first.body.site.id}/files/note.txt`, { key: replay.body.claim.token });
    expect(stored.status).toBe(200);
    expect(await stored.text()).toBe("anonymous replay bytes");
  });

  // Catches accepting changed input under the same anonymous IP/key scope.
  it("rejects a changed JSON body with 422 without creating another anonymous site", async () => {
    const first = await anonymousPublish({ files: [{ path: "note.txt", content: "first body" }] }, "anonymous-changed", "203.0.113.9");
    expectAnonymousResult(first);
    const changed = await anonymousPublish({ files: [{ path: "note.txt", content: "changed body" }] }, "anonymous-changed", "203.0.113.9");
    expect.soft(changed.status).toBe(422);
    expect.soft(changed.body.error?.code).toBe("idempotency_key_reused");
    await expectAnonymousSites(1);
    const raw = await dw.call(new URL("note.txt?raw=1", first.body.url).href);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("first body");
  });

  // Catches a global anonymous scope leaking one caller's claim to another IP.
  it("isolates replay by client IP while preserving each caller's own first result", async () => {
    const body = { files: [{ path: "note.txt", content: "shared body, separate callers" }] };
    const first = await anonymousPublish(body, "anonymous-isolation", "203.0.113.9");
    const other = await anonymousPublish(body, "anonymous-isolation", "203.0.113.10");
    expectAnonymousResult(first);
    expectAnonymousResult(other);
    expect(other.body.replayed).not.toBe(true);
    expect(other.body.site.id).not.toBe(first.body.site.id);
    expect(other.body.claim.token).not.toBe(first.body.claim.token);
    const firstReplay = await anonymousPublish(body, "anonymous-isolation", "203.0.113.9");
    const otherReplay = await anonymousPublish(body, "anonymous-isolation", "203.0.113.10");
    expect.soft(firstReplay.body).toEqual({ ...first.body, replayed: true });
    expect.soft(otherReplay.body).toEqual({ ...other.body, replayed: true });
    await expectAnonymousSites(2);
  });
});
