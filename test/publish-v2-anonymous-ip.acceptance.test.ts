import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { bearerToken, defaultIdentity } from "@dropway/core";
import { freshInstance, jsonBody, type Instance } from "./helpers";

// Review-round guard pin: without a real client IP there is no safe anonymous
// idempotency scope. requestIp() falls back to the 0.0.0.0 sentinel; scoping
// replay by that sentinel (or by an empty IP from an embedding identity
// adapter) would hand one anonymous caller's claim token to every other
// header-less caller. Each such publish must execute independently.
function anonymousPublish(dw: Instance, body: Record<string, unknown>, key: string) {
  const init = jsonBody(body);
  return dw.json("/api/v1/publish", { ...init, headers: { ...init.headers, "Idempotency-Key": key } });
}

async function expectIndependentPublishes(dw: Instance, key: string) {
  const body = { files: [{ path: "note.txt", content: "same body, no client ip" }] };
  const first = await anonymousPublish(dw, body, key);
  const second = await anonymousPublish(dw, body, key);
  for (const result of [first, second]) {
    expect(result.status).toBe(201);
    expect(result.body.status).toBe("live");
    expect(result.body.site.anonymous).toBe(true);
    expect(result.body.claim.token).toMatch(/^dwc_\S+$/);
    expect(result.body.replayed).not.toBe(true);
  }
  expect(second.body.site.id).not.toBe(first.body.site.id);
  expect(second.body.claim.token).not.toBe(first.body.claim.token);
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM sites WHERE tenant_id IS NULL").first<{ count: number }>();
  expect(row?.count).toBe(2);
  // Each claim token controls only its own site.
  for (const result of [first, second]) {
    const stored = await dw.call(`/api/v1/sites/${result.body.site.id}/files/note.txt`, { key: result.body.claim.token });
    expect(stored.status).toBe(200);
    expect(await stored.text()).toBe("same body, no client ip");
  }
}

describe("anonymous idempotency without a client IP", () => {
  // Kills a mutant that scopes anonymous replay by the 0.0.0.0 sentinel:
  // under it the second publish replays the first site and claim token.
  it("never replays keyed anonymous publishes with no cf-connecting-ip header", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    await expectIndependentPublishes(dw, "no-ip-header");
  });

  // An embedding identity adapter may report an empty IP instead of the
  // sentinel; that must disable anonymous replay in exactly the same way.
  it("never replays keyed anonymous publishes for an empty-IP principal", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } }, { adapters: {
      identity: { async resolve(request, dc) {
        if (!bearerToken(request)) return { kind: "anonymous", ip: "" };
        return defaultIdentity.resolve(request, dc);
      } },
    } });
    await expectIndependentPublishes(dw, "empty-ip-principal");
  });
});
