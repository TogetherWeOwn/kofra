import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { effectiveSigningSecret, hmacHex, ipHash, resolveConfig, sha256Hex, signingSecret, type DropwayContext } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP, freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";
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
    expect(resolveConfig({ ADMIN_BOOTSTRAP_KEY: BOOTSTRAP }).signingSecret).toBe(BOOTSTRAP);
    expect(resolveConfig({ ADMIN_BOOTSTRAP_KEY: BOOTSTRAP, SIGNING_SECRET: " own-strong-secret-0123456789abcdef " }).signingSecret)
      .toBe("own-strong-secret-0123456789abcdef");
  });

  it("refuses short operator secrets at startup, from vars and overrides", () => {
    for (const vars of [{ SIGNING_SECRET: "short" }, { SIGNING_SECRET: "s".repeat(31) }, { ADMIN_BOOTSTRAP_KEY: "short" }]) {
      expect(() => resolveConfig(vars)).toThrow(/Invalid (SIGNING_SECRET|ADMIN_BOOTSTRAP_KEY): expected at least 32 characters\./);
    }
    expect(() => resolveConfig({}, { signingSecret: "s".repeat(31) })).toThrow(/Invalid SIGNING_SECRET: expected at least 32 characters\./);
    expect(() => resolveConfig({}, { adminBootstrapKey: "short" })).toThrow(/Invalid ADMIN_BOOTSTRAP_KEY: expected at least 32 characters\./);
    // The 32-character minimum itself passes, and unset stays unset.
    expect(resolveConfig({ SIGNING_SECRET: "s".repeat(32) }).signingSecret).toBe("s".repeat(32));
    expect(resolveConfig({ ADMIN_BOOTSTRAP_KEY: "b".repeat(32) }).signingSecret).toBe("b".repeat(32));
    expect(resolveConfig({ SIGNING_SECRET: "   " }).signingSecret).toBeNull();
    // A whitespace-only override is trimmed like vars: blank means unset and fails closed,
    // never a weak effective key — even with a bootstrap key present it must not derive.
    expect(resolveConfig({}, { signingSecret: "   " }).signingSecret).toBeNull();
    expect(resolveConfig({ ADMIN_BOOTSTRAP_KEY: BOOTSTRAP }, { signingSecret: "   " }).signingSecret).toBeNull();
  });

  it("derives the signing key from the bootstrap key instead of reusing it", async () => {
    const bootstrapOnly = { config: resolveConfig({ ADMIN_BOOTSTRAP_KEY: BOOTSTRAP }) };
    expect(bootstrapOnly.config.signingSecretFromBootstrap).toBe(true);
    const key = await effectiveSigningSecret(bootstrapOnly);
    expect(key).toBe(await hmacHex(BOOTSTRAP, "dw-signing-v1"));
    expect(key).not.toBe(BOOTSTRAP);
    // The derivation is cached per config object.
    expect(await effectiveSigningSecret(bootstrapOnly)).toBe(key);
    // An explicit secret is single-purpose and used directly, unchanged.
    const explicit = { config: resolveConfig({ ADMIN_BOOTSTRAP_KEY: BOOTSTRAP, SIGNING_SECRET: "explicit-strong-secret-0123456789" }) };
    expect(explicit.config.signingSecretFromBootstrap).toBe(false);
    expect(await effectiveSigningSecret(explicit)).toBe("explicit-strong-secret-0123456789");
    // Unset still fails closed, like the sync accessor.
    await expect(effectiveSigningSecret({ config: resolveConfig({}) }))
      .rejects.toMatchObject({ status: 503, code: "signing_secret_missing" });
  });

  it("keys IP hashes instead of salting them", async () => {
    const dc = { config: resolveConfig({ ADMIN_BOOTSTRAP_KEY: BOOTSTRAP }) } as unknown as DropwayContext;
    const key = await effectiveSigningSecret(dc);
    await expect(ipHash(dc, "192.0.2.1")).resolves.toBe((await hmacHex(key, "ip:192.0.2.1")).slice(0, 32));
    // The old salted construction no longer matches.
    await expect(ipHash(dc, "192.0.2.1")).resolves.not.toBe((await sha256Hex(`${BOOTSTRAP}:192.0.2.1`)).slice(0, 32));
  });

  it("refuses the insecure dev secret with any non-loopback configured origin", () => {
    const dev = { ALLOW_INSECURE_DEV_SECRET: "true" };
    // Loopback-only development keeps working.
    expect(resolveConfig(dev).signingSecret).toBeTruthy();
    expect(resolveConfig({ ...dev, APP_ORIGIN: "http://localhost:8787" }).signingSecret).toBeTruthy();
    expect(resolveConfig({ ...dev, APP_ORIGIN: "http://127.0.0.1:8787", SITES_ORIGIN: "http://[::1]:8787" }).signingSecret).toBeTruthy();
    expect(resolveConfig({ ...dev, APP_ORIGIN: "https://app.localhost" }).signingSecret).toBeTruthy();
    // A loopback SITES_DOMAIN keeps working: bare, subdomain-style, wildcard and IP-literal forms.
    expect(resolveConfig({ ...dev, SITES_DOMAIN: "localhost" }).signingSecret).toBeTruthy();
    expect(resolveConfig({ ...dev, SITES_MODE: "subdomain", SITES_DOMAIN: "sites.localhost" }).signingSecret).toBeTruthy();
    expect(resolveConfig({ ...dev, SITES_MODE: "subdomain", SITES_DOMAIN: "*.localhost" }).signingSecret).toBeTruthy();
    expect(resolveConfig({ ...dev, SITES_MODE: "subdomain", SITES_DOMAIN: "127.0.0.1" }).signingSecret).toBeTruthy();
    expect(resolveConfig({ ...dev, SITES_MODE: "subdomain", SITES_DOMAIN: "::1" }).signingSecret).toBeTruthy();
    expect(resolveConfig(dev, { sitesMode: "subdomain", sitesDomain: "sites.localhost" }).signingSecret).toBeTruthy();
    // Any configured non-loopback origin refuses at startup.
    for (const vars of [
      { ...dev, APP_ORIGIN: "https://example.com" },
      { ...dev, APP_ORIGIN: "http://192.0.2.1:8787" },
      { ...dev, APP_ORIGIN: "http://localhost:8787", SITES_ORIGIN: "https://sites.example.com" },
      { ...dev, APP_ORIGIN: "http://localhost:8787", LEGACY_APP_ORIGINS: "https://old.example.com" },
      { ...dev, APP_ORIGIN: "http://localhost:8787", LEGACY_SITES_ORIGINS: "https://old-sites.example.com" },
      // A non-loopback SITES_DOMAIN refuses too, as does an unparseable one (fail closed).
      { ...dev, SITES_DOMAIN: "example.com" },
      { ...dev, APP_ORIGIN: "http://localhost:8787", SITES_DOMAIN: "sites.example.com" },
      { ...dev, APP_ORIGIN: "http://localhost:8787", SITES_DOMAIN: "[::1" },
    ]) {
      expect(() => resolveConfig(vars)).toThrow(/Invalid ALLOW_INSECURE_DEV_SECRET: configured origin \S+ is not loopback\./);
    }
    expect(() => resolveConfig(dev, { sitesMode: "subdomain", sitesDomain: "sites.example.com" }))
      .toThrow(/Invalid ALLOW_INSECURE_DEV_SECRET: configured origin \S+ is not loopback\./);
    // A real secret takes precedence over the flag: no refusal.
    expect(resolveConfig({ ...dev, APP_ORIGIN: "https://example.com", ADMIN_BOOTSTRAP_KEY: BOOTSTRAP }).signingSecret).toBe(BOOTSTRAP);
    expect(resolveConfig({ ...dev, APP_ORIGIN: "https://example.com", SIGNING_SECRET: "explicit-strong-secret-0123456789" }).signingSecret)
      .toBe("explicit-strong-secret-0123456789");
  });

  it("rejects upload tokens MACed with the raw bootstrap key on a bootstrap-only instance", async () => {
    const dw = await freshInstance();
    const entry = await manifestEntry("data.txt", "rotation bytes");
    const { bytes: _bytes, ...manifest } = entry;
    const pending = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ site: "rotation-site", files: [manifest] }) });
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe("awaiting_upload");
    const item = pending.body.upload.items[0];
    const auth: string = new Headers(item.headers).get("Authorization")!;
    expect(auth).toMatch(/^Bearer dwu_\S+$/);
    // A token MACed with the bearer value itself — valid before the derivation — no longer verifies.
    const payload = auth.slice("Bearer ".length, auth.lastIndexOf("."));
    const forged = new Headers({ Authorization: `Bearer ${payload}.${await hmacHex(BOOTSTRAP, payload)}` });
    forged.set("Content-Length", String(entry.size));
    expect((await dw.call(item.url, { method: "PUT", headers: forged, body: entry.bytes })).status).toBe(403);
    // The derived token uploads fine, so bootstrap-only signing still works end to end.
    const real = new Headers({ Authorization: auth });
    real.set("Content-Length", String(entry.size));
    expect((await dw.call(item.url, { method: "PUT", headers: real, body: entry.bytes })).status).toBe(201);
  });

  it("verifies explicit-secret test vectors unchanged", async () => {
    const secret = "explicit-strong-secret-0123456789";
    const dw = await freshInstance({ signingSecret: secret });
    // The issued token is MACed with the explicit secret itself.
    const entry = await manifestEntry("data.txt", "explicit bytes");
    const { bytes: _bytes, ...manifest } = entry;
    const pending = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ site: "explicit-site", files: [manifest] }) });
    expect(pending.status).toBe(202);
    const item = pending.body.upload.items[0];
    const auth: string = new Headers(item.headers).get("Authorization")!;
    const payload = auth.slice("Bearer ".length, auth.lastIndexOf("."));
    expect(auth).toBe(`Bearer ${payload}.${await hmacHex(secret, payload)}`);
    const headers = new Headers({ Authorization: auth });
    headers.set("Content-Length", String(entry.size));
    expect((await dw.call(item.url, { method: "PUT", headers, body: entry.bytes })).status).toBe(201);
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
