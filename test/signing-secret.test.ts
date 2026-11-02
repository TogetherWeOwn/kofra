import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { resolveConfig, signingSecret } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";
import { lockedSite, SITE_PASSWORD } from "./site-password-fixtures";
import { instance as transferInstance, FILES as TRANSFER_FILES } from "./transfer-fixtures";

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

  it("serves the system page to visitors and refuses password gates at write time", async () => {
    const dw = await freshInstance();
    const url = await lockedSite(dw, "locked");
    const call = withoutSecrets(dw);

    // A visitor navigation gets the standard system page, not bare text.
    const page = await call(url, { headers: { Accept: "text/html" } });
    expect(page.status).toBe(503);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("This site can&#39;t be opened right now");
    expect(html).toContain("The site owner needs to finish configuring this instance.");
    expect(html).not.toContain("private content");

    // Non-HTML clients keep the previous bare-text refusal.
    const raw = await call(url);
    expect(raw.status).toBe(503);
    expect(raw.headers.get("content-type")).toContain("text/plain");
    expect(await raw.text()).toBe("Service unavailable");

    // Setting a site password is refused with the existing operator hint ...
    const access = await call(`/api/v1/sites/locked/access`, {
      key: dw.ownerKey, ...jsonBody({ mode: "password", password: "brand-new-password" }), method: "PUT",
    });
    expect(access.status).toBe(503);
    expect(((await access.json()) as { error: { code: string; hint: string } }).error).toMatchObject({
      code: "signing_secret_missing",
      hint: "The operator must set SIGNING_SECRET (or ADMIN_BOOTSTRAP_KEY) as a Worker secret.",
    });

    // ... as is creating a site with a password ...
    const created = await call("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "gated", password: "brand-new-password" }) });
    expect(created.status).toBe(503);
    expect(((await created.json()) as { error: { code: string } }).error.code).toBe("signing_secret_missing");

    // ... while unprotected sites and clearing a password are unaffected.
    const plain = await call("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "plain" }) });
    expect(plain.status).toBe(201);
    const cleared = await call(`/api/v1/sites/locked/access`, {
      key: dw.ownerKey, ...jsonBody({ mode: "public" }), method: "PUT",
    });
    expect(cleared.status).toBe(200);
  });

  it("refuses password-protected deliveries without a secret, leaving unprotected ones working", async () => {
    const dw = await transferInstance();
    const call = withoutSecrets(dw);
    const files = TRANSFER_FILES.map(({ path, content, contentType }) => ({ path, content, contentType }));

    const protectedDelivery = await call("/api/v1/transfers", {
      key: dw.ownerKey,
      ...jsonBody({ slug: "secret-parcel", files, recipients: ["reader@example.net"], password: "delivery-secret-1" }),
    });
    expect(protectedDelivery.status).toBe(503);
    expect(((await protectedDelivery.json()) as { error: { code: string; hint: string } }).error).toMatchObject({
      code: "signing_secret_missing",
      hint: "The operator must set SIGNING_SECRET (or ADMIN_BOOTSTRAP_KEY) as a Worker secret.",
    });

    const open = await call("/api/v1/transfers", {
      key: dw.ownerKey,
      ...jsonBody({ slug: "open-parcel", files, recipients: ["reader@example.net"] }),
    });
    expect(open.status).toBe(201);

    // Adding a password to the live unprotected delivery is refused too.
    const openBody = (await open.json()) as { transfer?: { id: string }; id?: string };
    const id = openBody.transfer?.id ?? openBody.id;
    const gated = await call(`/api/v1/transfers/${id}`, {
      key: dw.ownerKey, ...jsonBody({ password: "delivery-secret-1" }), method: "PATCH",
    });
    expect(gated.status).toBe(503);
    expect(((await gated.json()) as { error: { code: string } }).error.code).toBe("signing_secret_missing");
  });
});
