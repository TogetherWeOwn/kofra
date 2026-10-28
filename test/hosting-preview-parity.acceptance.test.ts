/** Protected test-first contract: authorized immutable previews share hosting behavior, not live pointers. */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { clearLiveMemoryCache, type ConfigOverrides } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { form, freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const slug = "hosting-preview-parity";
const DAY = 24 * 60 * 60 * 1000;
type Version = 1 | 2;
type Credential = "owner" | "signed";
type Topology = { name: string; config: ConfigOverrides; live: string; root: (version: number) => string };
const topologies: Topology[] = [
  { name: "shared path", config: {}, live: `${ORIGIN}/s/${slug}/`, root: version => `${ORIGIN}/s/${slug}--v${version}/` },
  { name: "dedicated path", config: { sitesMode: "path", sitesOrigin: "https://preview-sites.example.test" }, live: `https://preview-sites.example.test/${slug}/`, root: version => `https://preview-sites.example.test/${slug}--v${version}/` },
  { name: "subdomain", config: { sitesMode: "subdomain", sitesDomain: "preview-sites.example.test" }, live: `https://${slug}.preview-sites.example.test/`, root: version => `https://${slug}--v${version}.preview-sites.example.test/` },
];
const guide: Record<Version, string> = {
  1: "# Exact version one\n\nHistorical Markdown bytes.\n",
  2: "# Exact version two\n\nCurrent Markdown bytes.\n",
};
const versionName: Record<Version, string> = { 1: "one", 2: "two" };
const versions = [1, 2] as const;
const credentials = ["owner", "signed"] as const;
const previewCases = versions.flatMap(version => credentials.map(credential => ({ version, credential })));
const requestCases = previewCases.flatMap(test => ["GET", "HEAD"].flatMap(method => ["", "?view=1"].map(query => ({ ...test, method, query }))));

function expectPrivate(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

async function expectBytes(response: Response, method: string, bytes: string) {
  const actual = new Uint8Array(await response.arrayBuffer());
  const expected = new TextEncoder().encode(method === "HEAD" ? "" : bytes);
  expect(actual).toHaveLength(expected.length);
  expect(actual).toEqual(expected);
}

async function patchViewers(instance: Instance, enabled: boolean) {
  const result = await instance.json(`/api/v1/sites/${slug}`, {
    ...jsonBody({ viewers: enabled }), method: "PATCH", key: instance.ownerKey,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body.site.settings.viewers).toBe(enabled);
}

async function redeem(instance: Instance, link: string, root: string) {
  const url = new URL(link);
  expect(url.origin).toBe(new URL(root).origin);
  expect(url.pathname).toBe(new URL(root).pathname);
  expect(url.searchParams.has("dw_preview")).toBe(true);
  const response = await instance.call(url.href);
  expect([302, 303, 307]).toContain(response.status);
  expectPrivate(response);
  const clean = new URL(response.headers.get("location")!, root);
  expect(clean.href).toBe(root);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  expect(setCookie).toMatch(/;\s*Secure/i);
  expect(setCookie).toMatch(/;\s*HttpOnly/i);
  expect(setCookie).not.toMatch(/;\s*Domain=/i);
  expect(setCookie).toContain(`Path=${new URL(root).pathname}`);
  const maxAge = Number(/Max-Age=(\d+)/i.exec(setCookie!)?.[1]);
  expect(maxAge).toBeGreaterThan(0);
  expect(maxAge).toBeLessThanOrEqual(86400);
  await response.arrayBuffer();
  return setCookie!.split(";")[0]!;
}

async function fixture(topology: Topology) {
  const instance = await freshInstance(topology.config);
  const links = {} as Record<Version, string>;
  let liveV1: string | null = null;
  for (const version of versions) {
    const html = `<!doctype html><html><head><title>${versionName[version]}</title></head><body><a id="preview-guide" href="/guide.md">Guide</a></body></html>`;
    const result = await instance.json("/api/v1/publish", {
      method: "POST", key: instance.ownerKey, body: form({
        "index.html": html,
        "guide.md": guide[version],
        _headers: `/*\n  X-Preview-Check: yes\n  X-Preview-Version: ${versionName[version]}\n  Cache-Control: public, max-age=600\n`,
        _redirects: `/jump /guide.md 302\n${version === 1 ? "/old-only /guide.md 307" : "/new-only /guide.md 308"}\n`,
      }, { slug }),
    });
    expect(result.status, JSON.stringify(result.body)).toBe(version === 1 ? 201 : 200);
    expect(result.body.version.number).toBe(version);
    expect(result.body.warnings.filter((warning: { code: string }) => warning.code === "invalid_hosting_rule")).toEqual([]);
    expect(typeof result.body.versionUrl).toBe("string");
    links[version] = result.body.versionUrl;
    if (version === 1) {
      liveV1 = await env.CACHE.get(`live:${slug}`);
      expect(liveV1).toBeTruthy();
      await patchViewers(instance, false);
    }
  }
  const issuedBy = Date.now();
  const cookies = {} as Record<Version, string>;
  for (const version of versions) cookies[version] = await redeem(instance, links[version], topology.root(version));
  return { instance, links, cookies, liveV1: liveV1!, issuedBy };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function access(f: Fixture, version: Version, credential: Credential, headers: HeadersInit = {}) {
  const merged = new Headers(headers);
  if (credential === "signed") merged.set("Cookie", f.cookies[version]);
  return { ...(credential === "owner" ? { key: f.instance.ownerKey } : {}), headers: merged };
}

afterEach(() => { vi.useRealTimers(); });

describe.each(topologies)("preview hosting parity: $name", topology => {
  describe("ready version reads", () => {
    let f: Fixture;
    beforeAll(async () => { f = await fixture(topology); });

    it.each(requestCases)("$credential v$version $method $query serves exact Markdown bytes with current viewers:false", async ({ version, credential, method, query }) => {
      const response = await f.instance.call(`${topology.root(version)}guide.md${query}`, { ...access(f, version, credential, NAV), method });
      expect(response.status).toBe(200);
      expectPrivate(response);
      expect.soft(response.headers.get("x-kofra-viewer")).toBeNull();
      expect.soft(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      await expectBytes(response, method, guide[version]);
    });

    it.each(["GET", "HEAD"].flatMap(method => ["", "?view=1"].map(query => ({ method, query }))))("live $method $query is the raw-byte control for viewers:false", async ({ method, query }) => {
      const response = await f.instance.call(`${topology.live}guide.md${query}`, { method, headers: NAV });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-kofra-viewer")).toBeNull();
      expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      await expectBytes(response, method, guide[2]);
    });

    it.each(previewCases)("$credential v$version honors the raw validator on viewer-disabled navigation and explicit view requests", async ({ version, credential }) => {
      const first = await f.instance.call(`${topology.root(version)}guide.md?raw=1`, access(f, version, credential));
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();
      await expectBytes(first, "GET", guide[version]);
      for (const query of ["", "?view=1"]) {
        const response = await f.instance.call(`${topology.root(version)}guide.md${query}`, access(f, version, credential, { ...NAV, "If-None-Match": etag! }));
        expect(response.status).toBe(304);
        expectPrivate(response);
        expect(response.headers.get("x-kofra-viewer")).toBeNull();
        await expectBytes(response, "HEAD", "");
      }
    });

    it.each(previewCases)("$credential v$version applies that immutable version's headers on GET, HEAD and 304", async ({ version, credential }) => {
      const url = `${topology.root(version)}guide.md?raw=1`;
      const first = await f.instance.call(url, access(f, version, credential));
      expect(first.status).toBe(200);
      expectPrivate(first);
      expect.soft(first.headers.get("x-preview-check")).toBe("yes");
      expect.soft(first.headers.get("x-preview-version")).toBe(versionName[version]);
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();
      await expectBytes(first, "GET", guide[version]);
      for (const method of ["GET", "HEAD"]) {
        const response = await f.instance.call(url, { ...access(f, version, credential, { "If-None-Match": etag! }), method });
        expect(response.status).toBe(304);
        expectPrivate(response);
        expect.soft(response.headers.get("x-preview-check")).toBe("yes");
        expect.soft(response.headers.get("x-preview-version")).toBe(versionName[version]);
        await expectBytes(response, "HEAD", "");
      }
    });

    it.each(previewCases.flatMap(test => ["GET", "HEAD"].map(method => ({ ...test, method }))))("$credential v$version $method applies redirects under its version prefix, never the live root", async ({ version, credential, method }) => {
      const root = topology.root(version);
      const response = await f.instance.call(`${root}jump?keep=one%20two`, { ...access(f, version, credential), method });
      expectPrivate(response);
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!, root);
      expect(location.href).toBe(`${root}guide.md?keep=one%20two`);
      expect(response.headers.get("x-preview-check")).toBe("yes");
      expect(response.headers.get("x-preview-version")).toBe(versionName[version]);
      await expectBytes(response, "HEAD", "");
      const followed = await f.instance.call(location.href, { ...access(f, version, credential, NAV), method });
      expect(followed.status).toBe(200);
      expectPrivate(followed);
      expect(followed.headers.get("x-kofra-viewer")).toBeNull();
      await expectBytes(followed, method, guide[version]);
    });

    it.each(["GET", "HEAD"])("live %s applies current custom headers and the configured redirect", async method => {
      const first = await f.instance.call(`${topology.live}guide.md`, { method, headers: NAV });
      expect(first.status).toBe(200);
      expect(first.headers.get("x-preview-check")).toBe("yes");
      expect(first.headers.get("x-preview-version")).toBe("two");
      await expectBytes(first, method, guide[2]);
      const redirected = await f.instance.call(`${topology.live}jump?keep=1`, { method });
      expect(redirected.status).toBe(302);
      expect(new URL(redirected.headers.get("location")!, topology.live).href).toBe(`${topology.live}guide.md?keep=1`);
      await expectBytes(redirected, "HEAD", "");
    });

    it.each(credentials)("%s uses v1 and v2 redirect tables independently after v2 is live", async credential => {
      for (const version of versions) {
        const own = version === 1 ? "old-only" : "new-only";
        const other = version === 1 ? "new-only" : "old-only";
        const response = await f.instance.call(`${topology.root(version)}${own}`, access(f, version, credential));
        expect(response.status).toBe(version === 1 ? 307 : 308);
        expectPrivate(response);
        expect(new URL(response.headers.get("location")!, topology.root(version)).href).toBe(`${topology.root(version)}guide.md`);
        await response.arrayBuffer();
        const absent = await f.instance.call(`${topology.root(version)}${other}`, access(f, version, credential));
        expect(absent.status).toBe(404);
        expectPrivate(absent);
        await absent.arrayBuffer();
      }
    });

    it.each(previewCases)("$credential v$version keeps raw GET, HEAD, range, 304 and errors private", async ({ version, credential }) => {
      const url = `${topology.root(version)}guide.md?raw=1`;
      const first = await f.instance.call(url, access(f, version, credential));
      expect(first.status).toBe(200);
      expectPrivate(first);
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();
      await expectBytes(first, "GET", guide[version]);
      const head = await f.instance.call(url, { ...access(f, version, credential), method: "HEAD" });
      expect(head.status).toBe(200);
      expectPrivate(head);
      expect(head.headers.get("etag")).toBe(etag);
      await expectBytes(head, "HEAD", "");
      const conditional = await f.instance.call(url, access(f, version, credential, { "If-None-Match": etag! }));
      expect(conditional.status).toBe(304);
      expectPrivate(conditional);
      await expectBytes(conditional, "HEAD", "");
      const range = await f.instance.call(url, access(f, version, credential, { Range: "bytes=0-4" }));
      expect(range.status).toBe(206);
      expectPrivate(range);
      expect(range.headers.get("content-range")).toBe(`bytes 0-4/${new TextEncoder().encode(guide[version]).length}`);
      await expectBytes(range, "GET", "# Exa");
      const missing = await f.instance.call(`${topology.root(version)}missing.txt`, access(f, version, credential));
      expect(missing.status).toBe(404);
      expectPrivate(missing);
      await missing.arrayBuffer();
    });

    it.each(previewCases)("$credential v$version rewrites HTML links under the immutable preview prefix without leaking its capability", async ({ version, credential }) => {
      const root = topology.root(version);
      const response = await f.instance.call(`${root}index.html`, access(f, version, credential, NAV));
      expect(response.status).toBe(200);
      expectPrivate(response);
      const html = await response.text();
      const hrefs: string[] = [];
      await new HTMLRewriter().on("a#preview-guide", { element(element) { hrefs.push(element.getAttribute("href")!); } }).transform(new Response(html)).text();
      expect(hrefs.map(href => new URL(href, root).href)).toEqual([`${root}guide.md`]);
      expect(html).not.toContain(new URL(f.links[version]).searchParams.get("dw_preview")!);
    });

    it.each(versions)("v%s still requires preview authorization even though the live site is public", async version => {
      for (const method of ["GET", "HEAD"]) {
        const response = await f.instance.call(`${topology.root(version)}guide.md`, { method, headers: NAV });
        expect(response.status).toBe(404);
        expectPrivate(response);
        expect(response.headers.get("set-cookie")).toBeNull();
        const bytes = new TextDecoder().decode(await response.arrayBuffer());
        expect(bytes).not.toContain(guide[version].trim());
      }
    });

    it("does not accept a v1 cookie or signed token for the v2 root", async () => {
      const cookieDenied = await f.instance.call(`${topology.root(2)}guide.md`, { headers: { Cookie: f.cookies[1] } });
      expect(cookieDenied.status).toBe(404);
      expectPrivate(cookieDenied);
      await cookieDenied.arrayBuffer();
      const wrongVersion = new URL(topology.root(2));
      wrongVersion.search = new URL(f.links[1]).search;
      const tokenDenied = await f.instance.call(wrongVersion.href);
      expect(tokenDenied.status).toBe(404);
      expectPrivate(tokenDenied);
      expect(tokenDenied.headers.get("set-cookie")).toBeNull();
      await tokenDenied.arrayBuffer();
    });

    it("expires signed links and cookies at their fixed deadline while owner access remains authorized", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(f.issuedBy + DAY + 1000);
      for (const version of versions) {
        for (const response of [
          await f.instance.call(f.links[version]),
          await f.instance.call(`${topology.root(version)}guide.md`, access(f, version, "signed")),
        ]) {
          expect(response.status).toBe(404);
          expectPrivate(response);
          expect(response.headers.get("set-cookie")).toBeNull();
          await response.arrayBuffer();
        }
        const owner = await f.instance.call(`${topology.root(version)}guide.md?raw=1`, access(f, version, "owner"));
        expect(owner.status).toBe(200);
        expectPrivate(owner);
        await expectBytes(owner, "GET", guide[version]);
      }
    });
  });

  it("applies the current viewer setting to both historical versions, not a version snapshot or a preview default", async () => {
    const f = await fixture(topology);
    await patchViewers(f.instance, true);
    for (const { version, credential } of previewCases) {
      const response = await f.instance.call(`${topology.root(version)}guide.md`, access(f, version, credential, NAV));
      expect(response.status).toBe(200);
      expectPrivate(response);
      expect(response.headers.get("x-kofra-viewer")).toBe("markdown");
      expect(await response.text()).toContain(`Exact version ${versionName[version]}`);
    }
    await patchViewers(f.instance, false);
    for (const { version, credential } of previewCases) {
      const response = await f.instance.call(`${topology.root(version)}guide.md?view=1`, access(f, version, credential, NAV));
      expect(response.status).toBe(200);
      expectPrivate(response);
      expect.soft(response.headers.get("x-kofra-viewer")).toBeNull();
      await expectBytes(response, "GET", guide[version]);
    }
  });

  it("keeps a real uploaded but pending version inaccessible to its owner and an older signed capability", async () => {
    const f = await fixture(topology);
    const entry = await manifestEntry("guide.md", "pending replacement must not be served\n", "text/markdown; charset=utf-8");
    const { bytes, ...file } = entry;
    const pending = await f.instance.json(`/api/v1/sites/${slug}/versions`, { key: f.instance.ownerKey, ...jsonBody({ files: [file] }) });
    expect(pending.status, JSON.stringify(pending.body)).toBe(201);
    expect(pending.body.version).toMatchObject({ number: 3, status: "pending" });
    const upload = await f.instance.call(`/api/v1/blobs/${entry.sha256}`, {
      method: "PUT", key: f.instance.ownerKey, headers: { "Content-Length": String(entry.size) }, body: bytes,
    });
    expect(upload.status).toBe(201);
    await upload.arrayBuffer();
    for (const method of ["GET", "HEAD"]) {
      const response = await f.instance.call(`${topology.root(3)}guide.md`, { method, key: f.instance.ownerKey });
      expect(response.status).toBe(404);
      expectPrivate(response);
      await response.arrayBuffer();
    }
    const signed = new URL(topology.root(3));
    signed.search = new URL(f.links[1]).search;
    const denied = await f.instance.call(signed.href);
    expect(denied.status).toBe(404);
    expectPrivate(denied);
    expect(denied.headers.get("set-cookie")).toBeNull();
    await denied.arrayBuffer();
    const ready = await f.instance.call(`${topology.root(1)}guide.md?raw=1`, access(f, 1, "signed"));
    expect(ready.status).toBe(200);
    await expectBytes(ready, "GET", guide[1]);
  });

  it("enforces the current password before preview file bytes or hosting redirects and preserves the existing unlock", async () => {
    const f = await fixture(topology);
    const password = "preview-hosting-test-password";
    const setting = await f.instance.json(`/api/v1/sites/${slug}/access`, {
      key: f.instance.ownerKey, ...jsonBody({ mode: "password", password }), method: "PUT",
    });
    expect(setting.status, JSON.stringify(setting.body)).toBe(200);
    let action: string | undefined;
    for (const credential of credentials) {
      for (const path of ["guide.md?raw=1", "jump"]) {
        const response = await f.instance.call(`${topology.root(1)}${path}`, access(f, 1, credential, NAV));
        expect(response.status).toBe(401);
        expectPrivate(response);
        expect(response.headers.get("location")).toBeNull();
        const html = await response.text();
        expect(html).toContain('type="password"');
        expect(html).not.toContain(guide[1].trim());
        if (path.startsWith("guide")) await new HTMLRewriter().on("form[action]", { element(element) { action = element.getAttribute("action") ?? undefined; } }).transform(new Response(html)).text();
      }
    }
    expect(action).toBeTruthy();
    const unlock = new URL(action!.replaceAll("&amp;", "&"), topology.root(1));
    const response = await f.instance.call(unlock.href, {
      method: "POST", headers: { Cookie: f.cookies[1], Origin: unlock.origin, "Sec-Fetch-Site": "same-origin" },
      body: new URLSearchParams({ password, next: `${new URL(topology.root(1)).pathname}guide.md?raw=1` }),
    });
    expect(response.status).toBe(303);
    expectPrivate(response);
    const passwordCookies = response.headers.getSetCookie().map(cookie => cookie.split(";")[0]!);
    expect(passwordCookies.length).toBeGreaterThan(0);
    await response.arrayBuffer();
    const allowed = await f.instance.call(`${topology.root(1)}guide.md?raw=1`, { headers: { Cookie: [f.cookies[1], ...passwordCookies].join("; ") } });
    expect(allowed.status).toBe(200);
    expectPrivate(allowed);
    await expectBytes(allowed, "GET", guide[1]);
  });

  it("neither reads nor mutates the live KV pointer while serving authorized exact-version previews", async () => {
    const f = await fixture(topology);
    await env.CACHE.put(`live:${slug}`, f.liveV1);
    clearLiveMemoryCache();
    const liveReads: string[] = [];
    const liveWrites: string[] = [];
    // Call through to the real KV binding; do not fake the serving path or its side effects.
    const CACHE = new Proxy(env.CACHE, { get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const key = args[0];
        if (typeof key === "string" && key.startsWith("live:")) {
          if (property === "get" || property === "getWithMetadata") liveReads.push(key);
          if (property === "put" || property === "delete") liveWrites.push(key);
        }
        return Reflect.apply(value, target, args);
      };
    } });
    for (const { version, credential } of previewCases) {
      for (const method of ["GET", "HEAD"]) {
        const headers = new Headers(credential === "owner" ? { Authorization: `Bearer ${f.instance.ownerKey}` } : { Cookie: f.cookies[version] });
        const ctx = createExecutionContext();
        const response = await f.instance.dropway.fetch(new Request(`${topology.root(version)}guide.md?raw=1`, { method, headers }), { ...env, CACHE } as unknown as ServerBindings, ctx);
        await waitOnExecutionContext(ctx);
        expect(response.status).toBe(200);
        expectPrivate(response);
        await expectBytes(response, method, guide[version]);
      }
    }
    expect(liveReads).toEqual([]);
    expect(liveWrites).toEqual([]);
    expect(await env.CACHE.get(`live:${slug}`)).toBe(f.liveV1);
    clearLiveMemoryCache();
    const stillLiveV1 = await f.instance.call(`${topology.live}guide.md?raw=1`);
    expect(stillLiveV1.status).toBe(200);
    await expectBytes(stillLiveV1, "GET", guide[1]);
  });
});
