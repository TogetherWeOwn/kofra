import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { resolveConfig, signingSecret } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";
import { lockedSite, SITE_PASSWORD } from "./site-password-fixtures";

/** The same instance, reached with neither SIGNING_SECRET nor ADMIN_BOOTSTRAP_KEY set. */
function withoutSecrets(dw: Instance) {
  const bare = { ...env, ADMIN_BOOTSTRAP_KEY: undefined, SIGNING_SECRET: undefined } as unknown as ServerBindings;
  return async (url: string, init: RequestInit & { key?: string } = {}) => {
    const { key, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (key) headers.set("Authorization", `Bearer ${key}`);
    const ctx = createExecutionContext();
    const res = await dw.dropway.fetch(new Request(url.startsWith("http") ? url : `${ORIGIN}${url}`, { ...rest, headers, redirect: "manual" }), bare, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

describe("signing secret", () => {
  it("has no built-in fallback unless the insecure dev flag is on", () => {
    expect(resolveConfig({}).signingSecret).toBeNull();
    expect(() => signingSecret(resolveConfig({}))).toThrow(expect.objectContaining({ status: 503, code: "signing_secret_missing", retryable: false }));
    expect(resolveConfig({ ALLOW_INSECURE_DEV_SECRET: "true" }).signingSecret).toBeTruthy();
    expect(resolveConfig({ ADMIN_BOOTSTRAP_KEY: "bootstrap" }).signingSecret).toBe("bootstrap");
    expect(resolveConfig({ ADMIN_BOOTSTRAP_KEY: "bootstrap", SIGNING_SECRET: " own " }).signingSecret).toBe("own");
  });

  it("refuses signed capabilities with 503 and keeps unsigned routes working", async () => {
    const dw = await freshInstance();
    const url = await lockedSite(dw, "locked");
    const call = withoutSecrets(dw);

    expect((await call("/health")).status).toBe(200);
    expect((await call("/api/v1/sites", { key: dw.ownerKey })).status).toBe(200);

    // A manifest publish hands out signed dwu_ upload tokens.
    const entry = await manifestEntry("index.html", "hello");
    const publish = await call("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ site: "manifest", files: [entry] }) });
    expect(publish.status).toBe(503);
    expect(((await publish.json()) as { error: { code: string } }).error.code).toBe("signing_secret_missing");
    // The refused publish leaves no pending version behind and stores no bytes, also for an existing site.
    const versions = () => env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<number>("n");
    const before = await versions();
    const objects = async () => (await env.FILES.list()).objects.length;
    const objectsBefore = await objects();
    const update = await call("/api/v1/publish", {
      key: dw.ownerKey,
      ...jsonBody({ site: "locked", files: [entry, { path: "new.txt", content: "inline bytes, not stored" }] }),
    });
    expect(update.status).toBe(503);
    expect(await versions()).toBe(before);
    expect(await objects()).toBe(objectsBefore);
    // A hash the site already stores needs no upload token, so it still publishes.
    const stored = await manifestEntry("index.html", "private content");
    const reuse = await call("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ site: "locked", files: [{ ...stored, path: "copy.html" }] }) });
    expect(reuse.status).toBeLessThan(300);

    const page = await call(url);
    expect(page.status).toBe(503);
    expect(await page.text()).not.toContain("private content");
    const unlock = await call(new URL("__dropway/password", url).href, { method: "POST", body: new URLSearchParams({ password: SITE_PASSWORD }) });
    expect(unlock.status).toBe(503);
    expect(unlock.headers.get("set-cookie")).toBeNull();
  });
});
