import { abortAllDurableObjects, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { BOOTSTRAP, freshInstance, jsonBody } from "./helpers";

it("replaces a stopped D1 fixture without retaining its owner or accepting duplicate setup", async () => {
  const previous = await freshInstance();
  const previousTenant = await env.DB.prepare("SELECT id FROM tenants").first<{ id: string }>();
  expect(previousTenant).not.toBeNull();

  // Stop the D1 actor while retaining its storage, without a timing-based test.
  await abortAllDurableObjects();
  const next = await freshInstance();
  const tenants = await env.DB.prepare("SELECT id FROM tenants").all<{ id: string }>();
  expect(tenants.results).toHaveLength(1);
  expect(tenants.results[0]!.id).not.toBe(previousTenant!.id);
  expect(next.ownerKey).not.toBe(previous.ownerKey);

  const staleKey = await next.json("/api/v1/sites", { key: previous.ownerKey });
  expect(staleKey.status).toBe(401);
  const currentKey = await next.json("/api/v1/sites", { key: next.ownerKey });
  expect(currentKey.status).toBe(200);

  const duplicate = await next.json("/api/v1/setup", { key: BOOTSTRAP, ...jsonBody({ email: "other@example.com" }) });
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.error.code).toBe("already_set_up");
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())?.n).toBe(1);
});
