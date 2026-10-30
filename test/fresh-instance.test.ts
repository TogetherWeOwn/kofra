import { abortAllDurableObjects, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { BOOTSTRAP, ORIGIN, freshInstance, jsonBody } from "./helpers";

it("replaces a stopped D1 fixture without retaining its owner or accepting duplicate setup", async () => {
  const previous = await freshInstance();
  const previousKey = previous.ownerKey;
  expect((await previous.json("/api/v1/sites", { key: previousKey })).status).toBe(200);
  const previousTenant = await env.DB.prepare("SELECT id FROM tenants").first<{ id: string }>();
  expect(previousTenant).not.toBeNull();

  // Stop the D1 actor while retaining its storage, without a timing-based test.
  await abortAllDurableObjects();
  const next = await freshInstance();
  const tenants = await env.DB.prepare("SELECT id FROM tenants").all<{ id: string }>();
  expect(tenants.results).toHaveLength(1);
  expect(tenants.results[0]!.id).not.toBe(previousTenant!.id);
  expect(next.ownerKey).not.toBe(previousKey);

  const staleKey = await next.json("/api/v1/sites", { key: previousKey });
  expect(staleKey.status).toBe(401);
  const currentKey = await next.json("/api/v1/sites", { key: next.ownerKey });
  expect(currentKey.status).toBe(200);

  const duplicate = await next.json("/api/v1/setup", { key: BOOTSTRAP, ...jsonBody({ email: "other@example.com" }) });
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.error.code).toBe("already_set_up");
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n).toBe(1);
});

it("clears stopped R2, KV and Cache API fixtures so a previous site's bytes cannot be served", async () => {
  const previous = await freshInstance();
  const content = "previous-fixture-content-must-not-survive";
  const slug = "stopped-fixture";
  const published = await previous.json("/api/v1/publish", {
    key: previous.ownerKey,
    ...jsonBody({ slug, files: [{ path: "index.txt", content }] }),
  });
  expect(published.status).toBe(201);
  const oldSite = await previous.call(`/s/${slug}/index.txt?raw=1`);
  expect(oldSite.status).toBe(200);
  expect(await oldSite.text()).toBe(content);

  const sentinel = "fixture-reset-sentinel";
  const cacheRequest = new Request(`${ORIGIN}/__fixture_reset_sentinel`);
  await env.FILES.put(sentinel, content);
  await env.CACHE.put(sentinel, content);
  await caches.default.put(cacheRequest, new Response(content, { headers: { "Cache-Control": "public, max-age=3600" } }));
  expect(await (await env.FILES.get(sentinel))?.text()).toBe(content);
  expect(await env.CACHE.get(sentinel)).toBe(content);
  expect(await (await caches.default.match(cacheRequest))?.text()).toBe(content);

  await abortAllDurableObjects();
  const next = await freshInstance();
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE slug = ?").bind(slug).first<{ n: number }>())?.n).toBe(0);
  expect.soft((await env.FILES.list({ limit: 1 })).objects.map((object) => object.key), "R2 starts empty").toEqual([]);
  expect.soft(await (await env.FILES.get(sentinel))?.text(), "R2 sentinel is absent").toBeUndefined();
  expect.soft((await env.CACHE.list({ limit: 1 })).keys.map((key) => key.name), "KV starts empty").toEqual([]);
  expect.soft(await env.CACHE.get(sentinel), "KV sentinel is absent").toBeNull();
  expect.soft(await (await caches.default.match(cacheRequest))?.text(), "Cache API starts empty").toBeUndefined();
  const staleSite = await next.call(`/s/${slug}/index.txt?raw=1`);
  expect.soft(staleSite.status, "a prior site is no longer served").toBe(404);
  expect.soft(await staleSite.text()).not.toContain(content);
});
