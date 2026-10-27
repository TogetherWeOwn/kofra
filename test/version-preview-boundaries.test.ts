import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, defaultIdentity, type ConfigOverrides, type PolicyAdapter } from "@dropway/core";
import { freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";
import { create as createTransfer, op } from "./transfer-fixtures";

// R-13: public Worker boundaries, without minting tokens or mocking authorization/storage.
const DAY = 24 * 60 * 60 * 1000;
const SLUG = "preview-boundary";
const CONTENT = "exact preview bytes";
type Publication = { status: string; versionUrl: string; version: { id: string; number: number } };
const topologies: { name: string; config: ConfigOverrides; root: string }[] = [
  { name: "path on app origin", config: { appOrigin: ORIGIN }, root: `${ORIGIN}/s/${SLUG}--v1/` },
  { name: "path on dedicated sites origin", config: { appOrigin: ORIGIN, sitesOrigin: "https://sites.example" }, root: `https://sites.example/${SLUG}--v1/` },
  { name: "subdomain", config: { appOrigin: ORIGIN, sitesMode: "subdomain", sitesDomain: "sites.test" }, root: `https://${SLUG}--v1.sites.test/` },
];

async function publish(dw: Instance): Promise<Publication> {
  const result = await dw.json<Publication>("/api/v1/publish", {
    key: dw.ownerKey, ...jsonBody({ site: SLUG, files: [{ path: "index.html", content: CONTENT }] }),
  });
  expect([200, 201]).toContain(result.status);
  return result.body;
}

function signedLink(result: Publication, root: string): URL {
  expect(result.versionUrl).toBeTypeOf("string");
  const link = new URL(result.versionUrl);
  expect(`${link.origin}${link.pathname}`).toBe(root);
  expect(link.searchParams.get("dw_preview")).toBeTruthy();
  return link;
}

async function redeem(dw: Instance, link: URL) {
  const response = await dw.call(link.href);
  expect([302, 303, 307]).toContain(response.status);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  const location = response.headers.get("location");
  expect(location).toBeTruthy();
  const clean = new URL(location!, link);
  expect(clean.origin).toBe(link.origin);
  expect(clean.pathname).toBe(link.pathname);
  expect(clean.searchParams.has("dw_preview")).toBe(false);
  return { response, setCookie: setCookie!, cookie: setCookie!.split(";")[0]!, clean };
}

async function expectBytes(dw: Instance, root: string, cookie: string, key?: string) {
  const page = await dw.call(`${root}?raw=1`, { key, headers: { Cookie: cookie } });
  expect(page.status).toBe(200);
  expect(await page.text()).toBe(CONTENT);
}

async function expectDenied(dw: Instance, url: string, init?: RequestInit & { key?: string }) {
  const denied = await dw.call(url, init);
  expect(denied.status).toBe(404);
  expect(denied.headers.get("set-cookie")).toBeNull();
  expect(await denied.text()).not.toContain(CONTENT);
}

describe("R-13 preview capability discovery", () => {
  it("advertises built-in version_previews as available with the default policy", async () => {
    const dw = await freshInstance();
    const me = await dw.json("/api/v1/me", { key: dw.ownerKey });
    expect(me.status).toBe(200);
    const decision = me.body.capabilities.version_previews;
    expect(decision).toBeDefined();
    expect(decision.allowed ?? decision.available).toBe(true);
    expect(JSON.stringify(decision)).not.toContain("feature_unavailable");
  });

  it("advertises adapter refusal and publishes live bytes without minting a disabled preview", async () => {
    const policy: PolicyAdapter = {
      limits: (_principal, _owner, dc) => dc.config.limits,
      capability: (_principal, capability) => capability === "version_previews"
        ? { allowed: false, error: new ApiError(403, "previews_disabled", "Previews are disabled.", "Ask the instance administrator.") }
        : { allowed: true },
    };
    const dw = await freshInstance({}, { adapters: { policy } });
    const result = await dw.json("/api/v1/publish", {
      key: dw.ownerKey, ...jsonBody({ site: SLUG, files: [{ path: "index.html", content: CONTENT }] }),
    });
    expect(result.status).toBe(201);
    expect(result.body.status).toBe("live");
    expect(result.body.versionUrl).toBeUndefined();
    const live = await dw.call(`${result.body.url}?raw=1`);
    expect(live.status).toBe(200);
    expect(await live.text()).toBe(CONTENT);
    const me = await dw.json("/api/v1/me", { key: dw.ownerKey });
    expect(me.status).toBe(200);
    const decision = me.body.capabilities.version_previews;
    expect(decision).toBeDefined();
    expect(decision.allowed ?? decision.available).toBe(false);
    expect(JSON.stringify(decision)).toContain("previews_disabled");
    expect(JSON.stringify(decision)).toContain("Ask the instance administrator.");
  });
});

describe("R-13 preview URL transport", () => {
  // Catches issuance losing the HTTPS requirement or also refusing loopback development.
  it.each([
    { origin: "http://preview.example", preview: false },
    { origin: "http://127.0.0.1", preview: true },
  ])("issues a signed preview only on loopback HTTP: $origin", async ({ origin, preview }) => {
    const dw = await freshInstance({ appOrigin: origin, sitesMode: "path" });
    const result = await dw.json<Publication>("/api/v1/publish", {
      origin, key: dw.ownerKey, ...jsonBody({ site: SLUG, files: [{ path: "index.html", content: CONTENT }] }),
    });
    expect(result.status).toBe(201);
    expect(result.body.status).toBe("live");
    const live = await dw.call(`${origin}/s/${SLUG}/?raw=1`);
    expect(live.status).toBe(200);
    expect(await live.text()).toBe(CONTENT);
    if (!preview) {
      expect(result.body.versionUrl).toBeUndefined();
      return;
    }
    const root = `${origin}/s/${SLUG}--v1/`;
    const session = await redeem(dw, signedLink(result.body, root));
    await expectBytes(dw, root, session.cookie);
  });
});

for (const topology of topologies) {
  describe(`R-13 preview boundary: ${topology.name}`, () => {
    let dw: Instance;
    beforeEach(async () => { dw = await freshInstance(topology.config); });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    // Catches a request exception recording the signed URL's bearer capability in diagnostics.
    it("redacts the preview capability from unexpected request-error logs and responses", async () => {
      dw = await freshInstance(topology.config, { adapters: { identity: {
        resolve(request, dc) {
          if (request.headers.has("X-Preview-Error")) throw new Error(`preview identity failure: ${request.url}`);
          return defaultIdentity.resolve(request, dc);
        },
      } } });
      const link = signedLink(await publish(dw), topology.root);
      const token = link.searchParams.get("dw_preview")!;
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const failure = await dw.call(link.href, { key: dw.ownerKey, headers: { "X-Preview-Error": "yes" } });
      expect(failure.status).toBe(500);
      const log = errors.mock.calls.flat().map((value) => value instanceof Error
        ? value.stack ?? value.message : typeof value === "string" ? value : JSON.stringify(value)).join("\n");
      expect(log).toContain("serve_error");
      expect(log).toContain(topology.root);
      expect(log).not.toContain(token);
      expect(await failure.text()).not.toContain(token);
    });

    // Catches privacy headers being lost on native rename redirects before preview serving starts.
    it("renamed preview addresses preserve their signed capability and privacy on the native redirect", async () => {
      const link = signedLink(await publish(dw), topology.root);
      const renamed = await op(dw, "rename_site", { site: SLUG, slug: `${SLUG}-renamed` });
      expect(renamed.status).toBe(200);
      const redirect = await dw.call(link.href);
      expect(redirect.status).toBe(308);
      expect(redirect.headers.get("set-cookie")).toBeNull();
      expect(redirect.headers.get("x-robots-tag") ?? "").toMatch(/\bnoindex\b/i);
      expect(redirect.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await redirect.text()).not.toContain(CONTENT);
      const location = redirect.headers.get("location");
      expect(location).toBeTruthy();
      const destination = new URL(location!, link);
      const renamedRoot = topology.root.replace(SLUG, `${SLUG}-renamed`);
      expect(`${destination.origin}${destination.pathname}`).toBe(renamedRoot);
      expect(destination.searchParams.get("dw_preview")).toBe(link.searchParams.get("dw_preview"));
      const session = await redeem(dw, destination);
      await expectBytes(dw, renamedRoot, session.cookie);
    });

    if (topology.name !== "path on app origin") {
      // Catches alternate-origin routing dropping preview privacy before the signed-link redirect.
      it("app-prefix redirects to the canonical sites origin retain preview privacy", async () => {
        const link = signedLink(await publish(dw), topology.root);
        const alias = new URL(`/s/${SLUG}--v1/`, ORIGIN);
        alias.search = link.search;
        const redirect = await dw.call(alias.href);
        expect([301, 302, 307, 308]).toContain(redirect.status);
        expect(redirect.headers.get("set-cookie")).toBeNull();
        expect(redirect.headers.get("x-robots-tag") ?? "").toMatch(/\bnoindex\b/i);
        expect(redirect.headers.get("referrer-policy")).toBe("no-referrer");
        const location = redirect.headers.get("location");
        expect(location).toBeTruthy();
        const destination = new URL(location!, alias);
        expect(`${destination.origin}${destination.pathname}`).toBe(topology.root);
        expect(destination.searchParams.get("dw_preview")).toBe(link.searchParams.get("dw_preview"));
        const session = await redeem(dw, destination);
        await expectBytes(dw, topology.root, session.cookie);
      });
    }

    // Catches reusing a version's original, now expired publish capability on unchanged republish.
    it("unchanged republish after 24 hours renews only the capability, not the exact-version address", async () => {
      const issuedAt = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(issuedAt);
      const first = await publish(dw);
      expect(first.status).toBe("live");
      const original = signedLink(first, topology.root);
      const oldSession = await redeem(dw, original);
      await expectBytes(dw, topology.root, oldSession.cookie);

      vi.setSystemTime(issuedAt + DAY + 1000);
      await expectDenied(dw, original.href);
      await expectDenied(dw, topology.root, { headers: { Cookie: oldSession.cookie } });
      const renewedAt = Date.now();
      const again = await publish(dw);
      expect(again.status).toBe("unchanged");
      expect(again.version.id).toBe(first.version.id);
      expect(again.version.number).toBe(1);
      const renewed = signedLink(again, topology.root);
      expect(renewed.searchParams.get("dw_preview")).not.toBe(original.searchParams.get("dw_preview"));
      const newSession = await redeem(dw, renewed);
      await expectBytes(dw, topology.root, newSession.cookie);
      // Renewal must not resurrect the previously expired token or its cookie.
      await expectDenied(dw, original.href);
      await expectDenied(dw, topology.root, { headers: { Cookie: oldSession.cookie } });

      vi.setSystemTime(renewedAt + DAY - 1000);
      await expectBytes(dw, topology.root, newSession.cookie);
      await redeem(dw, renewed);
      vi.setSystemTime(renewedAt + DAY + 1000);
      await expectDenied(dw, renewed.href);
      await expectDenied(dw, topology.root, { headers: { Cookie: newSession.cookie } });
    });

    // Catches stale capabilities remaining usable after an embedding adapter disables previews.
    it("live version_previews policy denial refuses owner, signed-link and cookie access", async () => {
      let denied = false;
      const policy: PolicyAdapter = {
        limits: (_principal, _owner, dc) => dc.config.limits,
        capability: (_principal, capability) => capability === "version_previews" && denied
          ? { allowed: false, error: new ApiError(403, "previews_disabled", "Previews are disabled.", "Ask the instance administrator.") }
          : { allowed: true },
      };
      dw = await freshInstance(topology.config, { adapters: { policy } });
      const link = signedLink(await publish(dw), topology.root);
      const session = await redeem(dw, link);
      await expectBytes(dw, topology.root, session.cookie);
      denied = true;
      await expectDenied(dw, topology.root, { key: dw.ownerKey });
      await expectDenied(dw, link.href);
      await expectDenied(dw, topology.root, { headers: { Cookie: session.cookie } });
      denied = false;
      await expectBytes(dw, topology.root, session.cookie, dw.ownerKey);
    });

    // Catches passing an invalid preview cookie through a higher-priority denial before owner auth.
    it("an expired preview cookie does not revoke otherwise valid owner Authorization", async () => {
      const publication = await publish(dw);
      const session = await redeem(dw, signedLink(publication, topology.root));
      await expectBytes(dw, topology.root, session.cookie);
      const afterPublish = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(afterPublish + DAY + 1000);
      await expectDenied(dw, topology.root, { headers: { Cookie: session.cookie } });
      const owner = await dw.call(`${topology.root}?raw=1`, { key: dw.ownerKey });
      expect(owner.status).toBe(200);
      expect(await owner.text()).toBe(CONTENT);
      await expectBytes(dw, topology.root, session.cookie, dw.ownerKey);
    });

    // Catches accepting pending manifests on the version route before finalize has committed bytes.
    it("a pending version cannot be previewed even by the owner", async () => {
      const first = await publish(dw);
      const entry = await manifestEntry("index.html", "pending replacement", "text/html; charset=utf-8");
      const { bytes, ...file } = entry;
      const pending = await dw.json(`/api/v1/sites/${SLUG}/versions`, {
        key: dw.ownerKey, ...jsonBody({ files: [file] }),
      });
      expect(pending.status).toBe(201);
      expect(pending.body.version.status).toBe("pending");
      expect(pending.body.version.number).toBe(2);
      // The bytes exist, so refusal cannot pass merely because the R2 object is missing.
      const upload = await dw.call(`/api/v1/blobs/${entry.sha256}`, {
        method: "PUT", key: dw.ownerKey, body: bytes, headers: { "Content-Length": String(entry.size) },
      });
      expect(upload.status).toBe(201);
      const pendingRoot = topology.root.replace("--v1", "--v2");
      await expectDenied(dw, pendingRoot, { key: dw.ownerKey });
      const replay = signedLink(first, topology.root);
      replay.pathname = new URL(pendingRoot).pathname;
      replay.hostname = new URL(pendingRoot).hostname;
      await expectDenied(dw, replay.href);
      const session = await redeem(dw, signedLink(first, topology.root));
      await expectBytes(dw, topology.root, session.cookie);
    });

    // Transfers require a separate sites origin; shared-app-origin creation is already refused.
    if (topology.name !== "path on app origin") {
      // Catches the generic version route serving transfer bytes outside download/lifecycle gates.
      it("transfer versions never become site previews, including with owner credentials", async () => {
        const transfer = await createTransfer(dw, { slug: SLUG, files: [{ path: "index.html", content: CONTENT }] });
        expect(transfer.mode).toBe("transfer");
        const versions = await dw.json(`/api/v1/sites/${SLUG}/versions`, { key: dw.ownerKey });
        expect(versions.status).toBe(200);
        expect(versions.body.versions).toEqual(expect.arrayContaining([
          expect.objectContaining({ number: 1, status: "ready" }),
        ]));
        for (const suffix of ["", "?raw=1", "?view=1", "index.html?download=1"]) {
          await expectDenied(dw, `${topology.root}${suffix}`, { key: dw.ownerKey });
          await expectDenied(dw, `${topology.root}${suffix}`);
        }
      });
    }

    // Catches routing preview password POSTs back through a GET-only preview gate or live address.
    it("a password-protected historical preview completes its actual POST unlock flow", async () => {
      const first = await publish(dw);
      const newer = await dw.json("/api/v1/publish", {
        key: dw.ownerKey, ...jsonBody({ site: SLUG, files: [{ path: "index.html", content: "new live version" }] }),
      });
      expect(newer.status).toBe(200);
      expect(newer.body.version.number).toBe(2);
      const access = await dw.json(`/api/v1/sites/${SLUG}/access`, {
        key: dw.ownerKey, ...jsonBody({ mode: "password", password: "preview-test-password" }), method: "PUT",
      });
      expect(access.status).toBe(200);
      const session = await redeem(dw, signedLink(first, topology.root));
      const locked = await dw.call(session.clean.href, { headers: { Accept: "text/html", Cookie: session.cookie } });
      expect(locked.status).toBe(401);
      const html = await locked.text();
      expect(html).not.toContain(CONTENT);
      const form = html.match(/<form\b[^>]*>/i)?.[0];
      expect(form, "password challenge must offer a real unlock form").toBeTruthy();
      const action = form!.match(/\baction=["']([^"']*)["']/i)?.[1] ?? "";
      const unlock = new URL(action.replace(/&amp;/g, "&"), session.clean);
      expect(unlock.origin).toBe(session.clean.origin);
      expect(unlock.pathname.startsWith(new URL(topology.root).pathname)).toBe(true);
      const post = (password: string) => dw.call(unlock.href, {
        method: "POST", body: new URLSearchParams({ password }),
        headers: { Origin: unlock.origin, Cookie: session.cookie },
      });
      expect((await post("wrong-password")).status).toBe(401);
      const unlocked = await post("preview-test-password");
      expect(unlocked.status).toBe(303);
      const passwordCookies = unlocked.headers.getSetCookie().map((value) => value.split(";")[0]!);
      expect(passwordCookies.length).toBeGreaterThan(0);
      const location = unlocked.headers.get("location");
      expect(location).toBeTruthy();
      const destination = new URL(location!, unlock);
      expect(`${destination.origin}${destination.pathname}`).toBe(topology.root);
      expect(destination.searchParams.has("dw_preview")).toBe(false);
      await expectBytes(dw, topology.root, [session.cookie, ...passwordCookies].join("; "));
    });

    if (topology.name === "path on dedicated sites origin") {
      // Catches reverting preview shim injection to sandbox-only behavior despite no-referrer.
      it("injects exactly one version-scoped path shim into unsandboxed preview HTML", async () => {
        dw = await freshInstance({ ...topology.config, sitesSandbox: false });
        const content = '<!doctype html><html><head><title>Preview</title></head><body><script>fetch("/runtime.json")</script></body></html>';
        const result = await dw.json<Publication>("/api/v1/publish", {
          key: dw.ownerKey, ...jsonBody({ site: SLUG, files: [{ path: "index.html", content }] }),
        });
        expect(result.status).toBe(201);
        const session = await redeem(dw, signedLink(result.body, topology.root));
        const page = await dw.call(session.clean.href, {
          headers: { Cookie: session.cookie, Accept: "text/html", "Sec-Fetch-Dest": "document" },
        });
        expect(page.status).toBe(200);
        expect(page.headers.get("content-type")).toContain("text/html");
        expect(page.headers.get("content-security-policy") ?? "").not.toMatch(/\bsandbox\b/i);
        expect(page.headers.get("referrer-policy")).toBe("no-referrer");
        const html = await page.text();
        expect(html.split('<script data-dropway="path-shim">')).toHaveLength(2);
        expect(html).toContain('("/preview-boundary--v1/",');
      });
    }

    // Catches bearer cookies missing browser security/isolation attributes.
    it("redeems to a Secure HttpOnly host-only cookie confined to the version root", async () => {
      const session = await redeem(dw, signedLink(await publish(dw), topology.root));
      const attributes = session.setCookie.split(";").map((part) => part.trim());
      if (topology.name === "subdomain") {
        expect(session.setCookie).toMatch(/^__Host-dw_preview=/);
        expect(attributes).toContain("SameSite=Lax");
      }
      expect(attributes.some((part) => /^secure$/i.test(part))).toBe(true);
      expect(attributes.some((part) => /^httponly$/i.test(part))).toBe(true);
      expect(attributes.some((part) => /^domain=/i.test(part))).toBe(false);
      expect(attributes.find((part) => /^path=/i.test(part))).toBe(`Path=${new URL(topology.root).pathname}`);
      const maxAge = attributes.find((part) => /^max-age=/i.test(part));
      expect(maxAge).toBeTruthy();
      expect(Number(maxAge!.split("=")[1])).toBeGreaterThan(0);
      expect(Number(maxAge!.split("=")[1])).toBeLessThanOrEqual(DAY / 1000);
      await expectBytes(dw, topology.root, session.cookie);
    });

    // Catches 304/HEAD fast paths or identity error fallbacks bypassing the preview permission check.
    it.each(["missing", "bad bearer", "wrong scope", "other site"])("%s Authorization cannot read a preview through conditional GET or HEAD", async (credential) => {
      await publish(dw);
      const control = await dw.call(`${topology.root}?raw=1`, { key: dw.ownerKey });
      expect(control.status).toBe(200);
      expect(await control.text()).toBe(CONTENT);
      const etag = control.headers.get("etag");
      expect(etag).toBeTruthy();
      const authorized = await dw.call(`${topology.root}?raw=1`, {
        key: dw.ownerKey, headers: { "If-None-Match": etag! },
      });
      expect(authorized.status).toBe(304);
      let key: string | undefined;
      if (credential === "bad bearer") key = "dw_not-a-real-key";
      else if (credential === "wrong scope" || credential === "other site") {
        if (credential === "other site") {
          const other = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "other-preview-boundary" }) });
          expect(other.status).toBe(201);
        }
        const created = await dw.json("/api/v1/keys", {
          key: dw.ownerKey, ...jsonBody({
            name: credential, scopes: credential === "wrong scope" ? ["sites:write"] : ["sites:read"],
            ...(credential === "other site" ? { site: "other-preview-boundary" } : {}),
          }),
        });
        expect(created.status).toBe(201);
        key = created.body.key;
      }
      for (const init of [
        { headers: { "If-None-Match": etag! } },
        { headers: { "If-None-Match": "*" } },
        { method: "HEAD", headers: { "If-None-Match": etag! } },
      ]) {
        await expectDenied(dw, `${topology.root}?raw=1`, { ...init, key });
      }
    });
  });
}
