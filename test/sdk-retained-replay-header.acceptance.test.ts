import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { DropwayClient, DropwayError, type FetchLike } from "@dropway/client";
import { clearLiveMemoryCache, type PublishEvent, type UsageEvent } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, ORIGIN, type Instance } from "./helpers";
import { effectSpies, worldState } from "./interleave-harness";
import { ACTIONS, claims, fixture, observe, snapshot } from "./version-mutation-replay.helpers";

afterEach(() => { vi.restoreAllMocks(); clearLiveMemoryCache(); });

interface PublishReceipt {
  slug: string;
  url: string;
  version: { id: string };
  replayed?: boolean;
}

const BODY = { files: [{ path: "index.html", content: "<h1>Retained publish intent</h1>" }] };
const RAW_KEY = "retained-publish-intent";

/** Record transport calls, but let the real Worker and disposable storage decide every result. */
function sdkFor(dw: Instance, token = dw.ownerKey) {
  const requests: Array<{ method: string; path: string; key: string | null }> = [];
  const fetch: FetchLike = async request => {
    requests.push({ method: request.method, path: new URL(request.url).pathname, key: request.headers.get("Idempotency-Key") });
    const ctx = createExecutionContext();
    const response = await dw.dropway.fetch(request, env as unknown as ServerBindings, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  return { requests, client: new DropwayClient({ api: ORIGIN, token, fetch, attempts: 3, backoffMs: 1 }) };
}

async function publishingFixture() {
  const published: PublishEvent[] = [];
  const deleted: unknown[] = [];
  const metered: UsageEvent[] = [];
  const dw = await freshInstance({}, {
    hooks: [{ onPublish: event => { published.push(event); }, onDelete: event => { deleted.push(event); } }],
    adapters: { metering: { record: event => { metered.push(event); } } },
  });
  return { dw, published, deleted, metered, ...sdkFor(dw) };
}

describe("SDK generic publish with caller-retained replay headers", () => {
  it("rejects an empty option before transport instead of downgrading a retained key to unkeyed publishing", async () => {
    const h = await publishingFixture();
    const headers = { "Idempotency-Key": RAW_KEY };
    const { data: first } = await h.client.post<PublishReceipt>("/publish", BODY, { headers });
    expect(first.slug).toEqual(expect.any(String));
    expect((await worldState()).sites).toHaveLength(1);
    expect(await claims()).toHaveLength(1);
    const before = await worldState();
    const beforeClaims = await claims();
    const effects = effectSpies(() => {
      h.published.length = 0; h.deleted.length = 0; h.metered.length = 0;
    }, () => [h.published, h.deleted, h.metered]);
    h.requests.length = 0;

    // Without local validation, each explicit retry below creates a DIFFERENT
    // generated site: generic publishing intentionally still accepts omission.
    for (let attempt = 0; attempt < 2; attempt++) {
      const error: unknown = await h.client.post("/publish", BODY, { headers, idempotencyKey: "" })
        .then(() => null, error => error);
      expect.soft(error, "an invalid supplied option must reject, not execute or replay the retained header").toBeInstanceOf(DropwayError);
      expect.soft(error).toMatchObject({ code: "invalid_idempotency_key", hint: expect.stringMatching(/\S/) });
    }
    expect.soft(h.requests.length, "reject before fetch, header replacement, or automatic retry").toBe(0);
    effects.expectNoEffects();
    const after = await worldState();
    expect.soft(after.sites, "invalid options must not create duplicate generated sites").toHaveLength(1);
    expect.soft(after.versions, "invalid options must not create duplicate versions").toHaveLength(1);
    expect.soft(after, "no duplicate generated sites, versions, blobs, usage or cache changes").toEqual(before);
    expect.soft(await claims(), "invalid options cannot claim, overwrite or release the retained intent").toEqual(beforeClaims);
  });

  it("replays a raw-header-only publish as the original receipt with exactly one generated resource", async () => {
    const h = await publishingFixture();
    const options = { headers: { "Idempotency-Key": RAW_KEY } };
    const { data: first } = await h.client.post<PublishReceipt>("/publish", BODY, options);
    expect(first.replayed).not.toBe(true);
    const before = await worldState();
    expect(before.sites).toHaveLength(1);
    expect(before.versions).toHaveLength(1);
    const effects = effectSpies(() => {
      h.published.length = 0; h.deleted.length = 0; h.metered.length = 0;
    }, () => [h.published, h.deleted, h.metered]);
    const { data: replay } = await h.client.post<PublishReceipt>("/publish", BODY, options);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(h.requests).toEqual([
      { method: "POST", path: "/api/v1/publish", key: RAW_KEY },
      { method: "POST", path: "/api/v1/publish", key: RAW_KEY },
    ]);
    effects.expectNoEffects();
    expect(await worldState()).toEqual(before);
    expect(await claims()).toHaveLength(1);
    const page = await h.dw.call(first.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>Retained publish intent</h1>");
  });

  it("keeps omitted-key publishing compatible without silently promising deduplication", async () => {
    const h = await publishingFixture();
    const { data: first } = await h.client.post<PublishReceipt>("/publish", BODY);
    const { data: second } = await h.client.post<PublishReceipt>("/publish", BODY, { idempotencyKey: undefined });
    expect(second.slug).not.toBe(first.slug);
    expect(second.version.id).not.toBe(first.version.id);
    expect(first.replayed).not.toBe(true);
    expect(second.replayed).not.toBe(true);
    expect(h.requests).toEqual([
      { method: "POST", path: "/api/v1/publish", key: null },
      { method: "POST", path: "/api/v1/publish", key: null },
    ]);
    const state = await worldState();
    expect(state.sites).toHaveLength(2);
    expect(state.versions).toHaveLength(2);
    expect(h.published).toHaveLength(2);
    expect(await claims()).toEqual([]);
  });

  it("gives a valid explicit option precedence without consuming the retained raw key", async () => {
    const h = await publishingFixture();
    const headers = { "Idempotency-Key": RAW_KEY };
    const options = { headers, idempotencyKey: "explicit-publish-intent" };
    const { data: first } = await h.client.post<PublishReceipt>("/publish", BODY, options);
    expect((await h.client.post<PublishReceipt>("/publish", BODY, options)).data).toEqual({ ...first, replayed: true });
    // The raw key is still a fresh intent, proving which key actually owns the
    // first receipt instead of only checking the outgoing header spelling.
    const { data: raw } = await h.client.post<PublishReceipt>("/publish", BODY, { headers });
    expect(raw.replayed).not.toBe(true);
    expect(raw.slug).not.toBe(first.slug);
    expect((await h.client.post<PublishReceipt>("/publish", BODY, options)).data).toEqual({ ...first, replayed: true });
    expect((await h.client.post<PublishReceipt>("/publish", BODY, { headers })).data).toEqual({ ...raw, replayed: true });
    expect(h.requests.map(request => request.key)).toEqual([
      "explicit-publish-intent", "explicit-publish-intent", RAW_KEY, "explicit-publish-intent", RAW_KEY,
    ]);
    const state = await worldState();
    expect(state.sites).toHaveLength(2);
    expect(state.versions).toHaveLength(2);
    expect(h.published).toHaveLength(2);
    expect(await claims()).toHaveLength(2);
  });
});

for (const action of ACTIONS) it(`SDK ${action} cannot fall back to a valid retained raw header for an empty option`, async () => {
  const h = await fixture();
  const { client, requests } = sdkFor(h.dw, h.actor.key);
  await client.getSite({ slug: h.site.slug });
  requests.length = 0;
  const before = await snapshot();
  const observed = observe(h);
  const options = { headers: { "Idempotency-Key": "retained-version-intent" }, idempotencyKey: "" };
  const call = action === "restore"
    ? client.restoreVersion({ slug: h.site.id, id: h.target }, options)
    : client.deleteVersion({ slug: h.site.id, id: h.target, confirm: h.site.slug }, options);
  const error: unknown = await call.then(() => null, error => error);
  expect.soft(error).toBeInstanceOf(DropwayError);
  expect.soft(error).toMatchObject({ code: "invalid_idempotency_key", hint: expect.stringMatching(/\S/) });
  expect.soft(requests.length, "local rejection is valid; a server refusal must never retry").toBeLessThanOrEqual(1);
  if (requests.length > 0) {
    expect.soft(requests[0]!.key, "never substitute the retained valid key or omit the invalid option").toBe("");
    expect.soft(error).toMatchObject({ status: 400 });
  }
  observed.expectNoAction({ noClaim: true });
  expect.soft(await snapshot()).toEqual(before);
  expect.soft(await claims()).toEqual([]);
});
