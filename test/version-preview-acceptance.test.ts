import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { clearLiveMemoryCache, type ConfigOverrides } from "@dropway/core";
import { form, freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";

// R-13 / SRV-07: black-box acceptance tests, derived from docs/ROADMAP.md.
// Never mint a preview token in a test: obtain it from the real publish response.
const DAY = 24 * 60 * 60 * 1000;
const SLUG = "preview-history";
const OTHER = "preview-other";
const HTML_ONE = '<!doctype html><head><script src="/assets/app.js"></script></head><p>version one</p>';
const HTML_TWO = '<!doctype html><head><script src="/assets/app.js"></script></head><p>version two</p>';
const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };

type Publication = { slug: string; url: string; versionUrl?: string; version: { id: string; number: number } };
type Topology = { name: string; config: ConfigOverrides; root(slug: string): string };
const topologies: Topology[] = [
  { name: "path on dedicated sites origin", config: { appOrigin: ORIGIN, sitesOrigin: "https://sites.example" }, root: (slug) => `https://sites.example/${slug}/` },
  { name: "subdomain", config: { appOrigin: ORIGIN, sitesMode: "subdomain", sitesDomain: "sites.test" }, root: (slug) => `https://${slug}.sites.test/` },
  { name: "path on app origin", config: { appOrigin: ORIGIN }, root: (slug) => `${ORIGIN}/s/${slug}/` },
];

async function publish(dw: Instance, slug: string, second = false): Promise<Publication> {
  const res = await dw.json<Publication>("/api/v1/publish", {
    method: "POST", key: dw.ownerKey,
    body: form({
      "index.html": second ? HTML_TWO : HTML_ONE,
      "assets/app.js": second ? "console.log('two')" : "console.log('one')",
      "docs/note.txt": second ? "new note" : "old note",
    }, { slug }),
  });
  expect(res.status).toBe(second ? 200 : 201);
  expect(res.body.version.number).toBe(second ? 2 : 1);
  return res.body;
}

function signedUrl(result: Publication, expectedRoot: string): URL {
  expect(result.versionUrl, "publish must return a signed versionUrl").toBeTypeOf("string");
  const url = new URL(result.versionUrl!);
  expect(`${url.origin}${url.pathname}`).toBe(expectedRoot);
  expect(url.searchParams.get("dw_preview"), "versionUrl must contain a preview token").toBeTruthy();
  return url;
}

function previewCookie(res: Response, expectedPath: string): string {
  const value = res.headers.get("set-cookie");
  expect(value, "redeeming a preview link must set a cookie").toBeTruthy();
  const attributes = value!.split(";").map((part) => part.trim());
  expect(attributes.find((part) => part.toLowerCase().startsWith("path="))).toBe(`Path=${expectedPath}`);
  expect(attributes.some((part) => /^domain=/i.test(part)), "preview cookie must be host-only").toBe(false);
  return attributes[0]!;
}

function privacyHeaders(res: Response) {
  expect(res.headers.get("x-robots-tag")).toMatch(/\bnoindex\b/i);
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

for (const topology of topologies) {
  describe(`R-13 version previews: ${topology.name}`, () => {
    let dw: Instance;
    let first: Publication;
    let second: Publication;
    let beforeSecondPublish: number;
    let afterSecondPublish: number;
    const preview = (number: number, slug = SLUG) => topology.root(`${slug}--v${number}`);

    beforeEach(async () => {
      dw = await freshInstance(topology.config);
      first = await publish(dw, SLUG);
      beforeSecondPublish = Date.now();
      second = await publish(dw, SLUG, true);
      afterSecondPublish = Date.now();
    });
    afterEach(() => vi.useRealTimers());

    it("control: publishing creates two versions and the live URL serves the second", async () => {
      expect(first.url).toBe(topology.root(SLUG));
      expect(second.url).toBe(first.url);
      expect(second.version.id).not.toBe(first.version.id);
      const res = await dw.call(`${second.url}?raw=1`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(HTML_TWO);
    });

    // Catches resolving a preview through the live pointer instead of its number.
    it("owner Authorization serves the exact historical and current versions, including assets", async () => {
      const old = await dw.call(`${preview(1)}?raw=1`, { key: dw.ownerKey });
      expect(old.status).toBe(200);
      expect(await old.text()).toBe(HTML_ONE);
      const current = await dw.call(`${preview(2)}?raw=1`, { key: dw.ownerKey });
      expect(current.status).toBe(200);
      expect(await current.text()).toBe(HTML_TWO);
      const asset = await dw.call(`${preview(1)}assets/app.js`, { key: dw.ownerKey });
      expect(asset.status).toBe(200);
      expect(await asset.text()).toBe("console.log('one')");
      expect((await dw.call(preview(999), { key: dw.ownerKey })).status).toBe(404);
    });

    it("new publishes and unchanged republishes return signed versionUrl links", async () => {
      signedUrl(first, preview(1));
      signedUrl(second, preview(2));
      const unchanged = await dw.json<Publication>("/api/v1/publish", {
        method: "POST", key: dw.ownerKey,
        body: form({ "index.html": HTML_TWO, "assets/app.js": "console.log('two')", "docs/note.txt": "new note" }, { slug: SLUG }),
      });
      expect(unchanged.status).toBe(200);
      expect(unchanged.body.version.id).toBe(second.version.id);
      const link = signedUrl(unchanged.body, preview(2));
      const redeem = await dw.call(link.href);
      expect([302, 303, 307]).toContain(redeem.status);
    });

    it("JSON publish results also provide a redeemable signed versionUrl", async () => {
      const res = await dw.json<Publication>("/api/v1/publish", {
        key: dw.ownerKey, ...jsonBody({ slug: OTHER, files: [{ path: "index.html", content: "<p>JSON preview</p>" }] }),
      });
      expect(res.status).toBe(201);
      const link = signedUrl(res.body, preview(1, OTHER));
      const redeem = await dw.call(link.href);
      expect([302, 303, 307]).toContain(redeem.status);
      const cookie = previewCookie(redeem, new URL(preview(1, OTHER)).pathname);
      const page = await dw.call(`${preview(1, OTHER)}?raw=1`, { headers: { Cookie: cookie } });
      expect(page.status).toBe(200);
      expect(await page.text()).toBe("<p>JSON preview</p>");
    });

    it("a signed nested link sets a preview-root cookie and redirects without leaking the token", async () => {
      const link = signedUrl(first, preview(1));
      link.pathname += "docs/note.txt";
      link.searchParams.set("raw", "1");
      link.searchParams.set("keep", "yes");
      const redeem = await dw.call(link.href);
      expect([302, 303, 307]).toContain(redeem.status);
      privacyHeaders(redeem);
      const location = redeem.headers.get("location");
      expect(location).toBeTruthy();
      const clean = new URL(location!, link);
      expect(`${clean.origin}${clean.pathname}`).toBe(`${preview(1)}docs/note.txt`);
      expect(clean.searchParams.get("dw_preview")).toBeNull();
      expect(clean.searchParams.get("raw")).toBe("1");
      expect(clean.searchParams.get("keep")).toBe("yes");
      const cookie = previewCookie(redeem, new URL(preview(1)).pathname);
      const page = await dw.call(clean.href, { headers: { Cookie: cookie } });
      expect(page.status).toBe(200);
      expect(await page.text()).toBe("old note");
      privacyHeaders(page);
      const asset = await dw.call(`${preview(1)}assets/app.js`, { headers: { Cookie: cookie } });
      expect(asset.status).toBe(200);
      expect(await asset.text()).toBe("console.log('one')");
    });

    it("unauthenticated and invalid Authorization requests get 404 even for public live sites", async () => {
      expect((await dw.call(topology.root(SLUG))).status).toBe(200);
      for (const key of [undefined, "dw_not-a-real-key"]) {
        const res = await dw.call(preview(1), { key });
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("version one");
      }
    });

    it("owner credentials restricted to a different site cannot read this preview", async () => {
      await publish(dw, OTHER);
      const scoped = await dw.json("/api/v1/keys", {
        key: dw.ownerKey, ...jsonBody({ name: "other-only", scopes: ["sites:read"], site: OTHER }),
      });
      expect(scoped.status).toBe(201);
      const allowed = await dw.call(`${preview(1, OTHER)}?raw=1`, { key: scoped.body.key });
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toBe(HTML_ONE);
      const denied = await dw.call(preview(1), { key: scoped.body.key });
      expect(denied.status).toBe(404);
    });

    // Positive redemption first: a missing preview route cannot satisfy these refusals.
    it("signed links cannot be tampered with or replayed for another version or site", async () => {
      await publish(dw, OTHER);
      const link = signedUrl(first, preview(1));
      const valid = await dw.call(link.href);
      expect([302, 303, 307]).toContain(valid.status);
      const token = link.searchParams.get("dw_preview")!;
      const corrupted = new URL(link);
      corrupted.searchParams.set("dw_preview", `${token[0] === "a" ? "b" : "a"}${token.slice(1)}`);
      const corruptedSuffix = new URL(link);
      corruptedSuffix.searchParams.set("dw_preview", `${token.slice(0, -4)}${token.endsWith("AAAA") ? "BBBB" : "AAAA"}`);
      const wrongVersion = new URL(preview(2));
      wrongVersion.searchParams.set("dw_preview", token);
      const wrongSite = new URL(preview(1, OTHER));
      wrongSite.searchParams.set("dw_preview", token);
      for (const url of [corrupted, corruptedSuffix, wrongVersion, wrongSite]) {
        const res = await dw.call(url.href);
        expect(res.status).toBe(404);
        expect(res.headers.get("set-cookie")).toBeNull();
      }
    });

    it("a preview cookie cannot authorize another version or site even if manually forwarded", async () => {
      await publish(dw, OTHER);
      const redeem = await dw.call(signedUrl(first, preview(1)).href);
      expect([302, 303, 307]).toContain(redeem.status);
      const cookie = previewCookie(redeem, new URL(preview(1)).pathname);
      const own = await dw.call(`${preview(1)}?raw=1`, { headers: { Cookie: cookie } });
      expect(own.status).toBe(200);
      expect(await own.text()).toBe(HTML_ONE);
      for (const target of [preview(2), preview(1, OTHER)]) {
        expect((await dw.call(target, { headers: { Cookie: cookie } })).status).toBe(404);
      }
    });

    it("signed links remain valid until 24 hours, then return 404 without setting a cookie", async () => {
      const link = signedUrl(second, preview(2));
      // Bound issuance by the publish call, with a one-second margin for token precision.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(beforeSecondPublish + DAY - 1000);
      const before = await dw.call(link.href);
      expect([302, 303, 307]).toContain(before.status);
      vi.setSystemTime(afterSecondPublish + DAY + 1000);
      const expired = await dw.call(link.href);
      expect(expired.status).toBe(404);
      expect(expired.headers.get("set-cookie")).toBeNull();
    });

    it("the preview cookie cannot extend access beyond the signed link's 24-hour lifetime", async () => {
      const redeem = await dw.call(signedUrl(second, preview(2)).href);
      expect([302, 303, 307]).toContain(redeem.status);
      const cookie = previewCookie(redeem, new URL(preview(2)).pathname);
      const before = await dw.call(preview(2), { headers: { Cookie: cookie } });
      expect(before.status).toBe(200);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(afterSecondPublish + DAY + 1000);
      const expired = await dw.call(preview(2), { headers: { Cookie: cookie } });
      expect(expired.status).toBe(404);
    });

    it("preview privacy headers survive HTML, assets, HEAD, Range, 304 and missing-file responses", async () => {
      const html = await dw.call(preview(1), { key: dw.ownerKey, headers: NAV });
      expect(html.status).toBe(200);
      privacyHeaders(html);
      const assetUrl = `${preview(1)}assets/app.js`;
      const asset = await dw.call(assetUrl, { key: dw.ownerKey });
      expect(asset.status).toBe(200);
      privacyHeaders(asset);
      const etag = asset.headers.get("etag");
      expect(etag).toBeTruthy();
      const variants: [RequestInit, number][] = [
        [{ method: "HEAD" }, 200],
        [{ headers: { Range: "bytes=0-6" } }, 206],
        [{ headers: { "If-None-Match": etag! } }, 304],
      ];
      for (const [init, status] of variants) {
        const res = await dw.call(assetUrl, { ...init, key: dw.ownerKey });
        expect(res.status).toBe(status);
        privacyHeaders(res);
      }
      const missing = await dw.call(`${preview(1)}no-such-file.txt`, { key: dw.ownerKey });
      expect(missing.status).toBe(404);
      privacyHeaders(missing);
    });

    if (topology.name !== "subdomain") {
      it("HTML root-relative assets stay on the selected version rather than the live URL", async () => {
        const page = await dw.call(preview(1), { key: dw.ownerKey, headers: NAV });
        expect(page.status).toBe(200);
        expect(await page.text()).toContain(`src="${new URL(preview(1)).pathname}assets/app.js"`);
      });
    }

    it("a freshly published preview bypasses a stale live KV manifest without refreshing the live URL", async () => {
      // Save a real v1 KV entry, then simulate propagation lag after publishing v2.
      // No synthetic manifest shape and no service mocks: D1/R2/KV remain real.
      const laggedSlug = "preview-stale";
      await publish(dw, laggedSlug);
      const oldManifest = await env.CACHE.get(`live:${laggedSlug}`);
      expect(oldManifest).not.toBeNull();
      const latest = await publish(dw, laggedSlug, true);
      await env.CACHE.put(`live:${laggedSlug}`, oldManifest!);
      clearLiveMemoryCache();
      const live = await dw.call(`${topology.root(laggedSlug)}?raw=1`);
      expect(live.status).toBe(200);
      expect(await live.text()).toBe(HTML_ONE);
      const ownerPreview = await dw.call(`${preview(2, laggedSlug)}?raw=1`, { key: dw.ownerKey });
      expect(ownerPreview.status).toBe(200);
      expect(await ownerPreview.text()).toBe(HTML_TWO);
      const link = signedUrl(latest, preview(2, laggedSlug));
      const redeem = await dw.call(link.href);
      expect([302, 303, 307]).toContain(redeem.status);
      const cookie = previewCookie(redeem, new URL(preview(2, laggedSlug)).pathname);
      const signed = await dw.call(`${preview(2, laggedSlug)}?raw=1`, { headers: { Cookie: cookie } });
      expect(signed.status).toBe(200);
      expect(await signed.text()).toBe(HTML_TWO);
      // A broken implementation that repairs KV instead of bypassing it must fail.
      clearLiveMemoryCache();
      const stillOld = await dw.call(`${topology.root(laggedSlug)}?raw=1`);
      expect(await stillOld.text()).toBe(HTML_ONE);
    });

    it("manifest finalization also returns a usable signed versionUrl", async () => {
      const file = await manifestEntry("index.html", "<p>manifest version three</p>", "text/html; charset=utf-8");
      const { bytes, ...entry } = file;
      const pending = await dw.json(`/api/v1/sites/${SLUG}/deploys`, {
        key: dw.ownerKey, ...jsonBody({ files: [entry] }),
      });
      expect(pending.status).toBe(201);
      const upload = await dw.call(`/api/v1/blobs/${file.sha256}`, {
        method: "PUT", key: dw.ownerKey, body: bytes, headers: { "Content-Length": String(file.size) },
      });
      expect(upload.status).toBe(201);
      const finalized = await dw.json<Publication>(`/api/v1/sites/${SLUG}/deploys/${pending.body.deploy.id}/finalize`, {
        method: "POST", key: dw.ownerKey,
      });
      expect(finalized.status).toBe(200);
      const link = signedUrl(finalized.body, preview(3));
      const redeem = await dw.call(link.href);
      expect([302, 303, 307]).toContain(redeem.status);
      const cookie = previewCookie(redeem, new URL(preview(3)).pathname);
      const page = await dw.call(`${preview(3)}?raw=1`, { headers: { Cookie: cookie } });
      expect(page.status).toBe(200);
      expect(await page.text()).toBe("<p>manifest version three</p>");
    });
  });
}
