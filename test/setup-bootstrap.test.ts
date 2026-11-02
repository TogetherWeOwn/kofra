import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { clearLiveMemoryCache } from "@dropway/core";
import { createDropway, type ServerBindings } from "@dropway/server";
import { BOOTSTRAP, ORIGIN, freshInstance, jsonBody, type Instance } from "./helpers";
import { CLIENT_SCRIPT } from "../packages/server/src/ui/assets";

const MESSAGE = "That bootstrap secret doesn't match this instance.";
const HINT =
  "Paste the exact ADMIN_BOOTSTRAP_KEY secret set on the Worker at deploy time. It is the value you generated during setup (for example with openssl rand -hex 32) — not an API key.";

// A mistyped `openssl rand -hex 32` value, a well-formed but unknown dw_ key,
// and a credential in no recognizable shape.
const WRONG_HEX = "a".repeat(64);
const WRONG_DW = `dw_${"b".repeat(43)}`;
const GARBAGE = "definitely-not-a-credential";
const WRONG = [WRONG_HEX, WRONG_DW, GARBAGE];

/** A Kofra that has not run setup yet, mirroring freshInstance without the setup call. */
async function bareInstance(): Promise<Instance> {
  await env.DB.prepare("SELECT 1").first();
  await env.FILES.list({ limit: 1 });
  await env.CACHE.list({ limit: 1 });
  await caches.default.delete(new Request(`${ORIGIN}/__fixture_reset__`));
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  clearLiveMemoryCache();
  const dropway = createDropway({});

  const call: Instance["call"] = async (path, init = {}) => {
    const { key, origin, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (key) headers.set("Authorization", `Bearer ${key}`);
    const url = path.startsWith("http") ? path : `${origin ?? ORIGIN}${path}`;
    const ctx = createExecutionContext();
    const res = await dropway.fetch(new Request(url, { ...rest, headers, redirect: "manual" }), env as unknown as ServerBindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  const json: Instance["json"] = async (path, init) => {
    const res = await call(path, init);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, res };
  };
  return { dropway, ownerKey: "", call, json };
}

describe("setup and recovery bootstrap errors", () => {
  it("wrong credentials on setup share one 403 answer, before and after setup", async () => {
    for (const dw of [await bareInstance(), await freshInstance()]) {
      for (const key of WRONG) {
        const res = await dw.json("/api/v1/setup", { key, ...jsonBody({}) });
        expect(res.status, key).toBe(403);
        expect(res.body.error.code, key).toBe("bootstrap_key_required");
        expect(res.body.error.message, key).toBe(MESSAGE);
        expect(res.body.error.hint, key).toBe(HINT);
      }
    }
  });

  it("the legacy accounts alias answers the same way", async () => {
    const dw = await freshInstance();
    const res = await dw.json("/api/v1/accounts", { key: WRONG_HEX, ...jsonBody({}) });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "bootstrap_key_required", message: MESSAGE, hint: HINT });
  });

  it("a malformed Authorization header on setup keeps its syntax error", async () => {
    const dw = await freshInstance();
    const res = await dw.json("/api/v1/setup", {
      method: "POST",
      headers: { Authorization: "Basic abc", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_authorization");
  });

  it("the correct bootstrap secret still sets up a fresh instance", async () => {
    const dw = await bareInstance();
    const res = await dw.json("/api/v1/setup", { key: BOOTSTRAP, ...jsonBody({ email: "owner@example.com" }) });
    expect(res.status).toBe(201);
    expect(res.body.tenant.id).toBeTruthy();
    expect(res.body.apiKey.key.startsWith("dw_")).toBe(true);
    expect((await dw.json("/api/v1/me", { key: res.body.apiKey.key })).status).toBe(200);
  });

  it("the correct bootstrap secret still reaches past the boundary on a set-up instance", async () => {
    const dw = await freshInstance();
    const res = await dw.json("/api/v1/setup", { key: BOOTSTRAP, ...jsonBody({}) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("already_set_up");
  });

  it("wrong credentials on recover share one 403 answer", async () => {
    const dw = await freshInstance();
    for (const key of WRONG) {
      const res = await dw.json("/api/v1/setup/recover", { method: "POST", key });
      expect(res.status, key).toBe(403);
      expect(res.body.error.code, key).toBe("bootstrap_key_required");
      expect(res.body.error.message, key).toBe(MESSAGE);
      expect(res.body.error.hint, key).toBe(HINT);
    }
  });

  it("no credential keeps its 403 behavior with the new hint", async () => {
    const dw = await freshInstance();
    for (const path of ["/api/v1/setup", "/api/v1/setup/recover"]) {
      const res = await dw.json(path, jsonBody({}));
      expect(res.status, path).toBe(403);
      expect(res.body.error.code, path).toBe("bootstrap_key_required");
      expect(res.body.error.hint, path).toBe(HINT);
    }
  });

  it("the correct bootstrap secret recovers with the S4 note; older keys keep working", async () => {
    const dw = await freshInstance();
    const res = await dw.json("/api/v1/setup/recover", { method: "POST", key: BOOTSTRAP });
    expect(res.status).toBe(201);
    expect(res.body.note).toContain("Store apiKey.key now; it is shown only once.");
    expect(res.body.note).toContain("Older owner keys still work.");
    expect(res.body.note).toContain("Revoke older keys with DELETE /api/v1/keys/:id if one was lost or shared.");
    // Recovery mints an additional key: the previous owner key keeps working.
    expect((await dw.json("/api/v1/me", { key: dw.ownerKey })).status).toBe(200);
    expect((await dw.json("/api/v1/me", { key: res.body.apiKey.key })).status).toBe(200);
  });

  it("the same wrong credentials on other routes keep today's errors", async () => {
    const dw = await freshInstance();
    const badDw = await dw.json("/api/v1/sites", { key: WRONG_DW });
    expect(badDw.status).toBe(401);
    expect(badDw.body.error.code).toBe("invalid_api_key");
    for (const key of [WRONG_HEX, GARBAGE]) {
      const res = await dw.json("/api/v1/sites", { key });
      expect(res.status, key).toBe(401);
      expect(res.body.error.code, key).toBe("invalid_api_key");
      expect(res.body.error.message, key).toBe("Unrecognised token format.");
    }
  });

  it("the recover success state tells the browser older keys still work", async () => {
    expect(CLIENT_SCRIPT).toContain("Older owner keys still work. If you recovered because a key was lost or shared, revoke it under ");
    expect(CLIENT_SCRIPT).toContain('href: "/dashboard/keys"');
  });
});
