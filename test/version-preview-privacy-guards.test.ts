import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultIdentity, type ConfigOverrides } from "@dropway/core";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";

// R-13: preview privacy guards, exercised through the public Worker with real publish tokens.
const SLUG = "preview-guards";
const PAGE = "<!doctype html><p>preview guard page</p>";
const SCRIPT = "console.log('preview guard script')";
// A content-hashed build output: live sites cache it as public, immutable.
const ASSET = "assets/app-1a2b3c4d.js";
const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
type Publication = { versionUrl: string; version: { id: string; number: number } };
type Topology = { name: string; config: ConfigOverrides; root(slug: string): string; sandboxed: boolean };
const topologies: Topology[] = [
  { name: "path on app origin", config: { appOrigin: ORIGIN }, root: (slug) => `${ORIGIN}/s/${slug}/`, sandboxed: true },
  { name: "path on dedicated sites origin", config: { appOrigin: ORIGIN, sitesOrigin: "https://sites.example" }, root: (slug) => `https://sites.example/${slug}/`, sandboxed: false },
  { name: "subdomain", config: { appOrigin: ORIGIN, sitesMode: "subdomain", sitesDomain: "sites.test" }, root: (slug) => `https://${slug}.sites.test/`, sandboxed: false },
];

async function publish(dw: Instance): Promise<Publication> {
  const result = await dw.json<Publication>("/api/v1/publish", {
    key: dw.ownerKey, ...jsonBody({ site: SLUG, files: [{ path: "index.html", content: PAGE }, { path: ASSET, content: SCRIPT }] }),
  });
  expect([200, 201]).toContain(result.status);
  expect(result.body.versionUrl).toBeTypeOf("string");
  return result.body;
}

async function previewCookie(dw: Instance, publication: Publication): Promise<string> {
  const redeem = await dw.call(publication.versionUrl);
  expect([302, 303, 307]).toContain(redeem.status);
  const setCookie = redeem.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0]!;
}

function expectPrivate(res: Response) {
  expect(res.headers.get("x-robots-tag") ?? "").toMatch(/\bnoindex\b/i);
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  const cache = (res.headers.get("cache-control") ?? "").toLowerCase();
  expect(cache).toMatch(/\bprivate\b/);
  expect(cache).toMatch(/\bno-store\b/);
  expect(cache).not.toMatch(/\bpublic\b|\bimmutable\b|max-age=[1-9]/);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
}

for (const topology of topologies) {
  describe(`R-13 preview privacy guards: ${topology.name}`, () => {
    let dw: Instance;
    const versionRoot = topology.root(`${SLUG}--v1`);
    beforeEach(async () => { dw = await freshInstance(topology.config); });
    afterEach(() => { vi.restoreAllMocks(); });

    if (!topology.sandboxed) {
      // Catches a Lax preview cookie letting a sibling subdomain load the preview's scripts.
      it("a preview cookie grants subresources only to same-origin requests, not same-site or cross-site", async () => {
        const cookie = await previewCookie(dw, await publish(dw));
        const asset = `${versionRoot}${ASSET}`;
        for (const site of ["same-site", "cross-site"]) {
          const denied = await dw.call(asset, { headers: { Cookie: cookie, "Sec-Fetch-Dest": "script", "Sec-Fetch-Site": site } });
          expect(denied.status, `Sec-Fetch-Site: ${site}`).toBe(404);
          expect(await denied.text()).not.toContain(SCRIPT);
        }
        const sameOrigin = await dw.call(asset, { headers: { Cookie: cookie, "Sec-Fetch-Dest": "script", "Sec-Fetch-Site": "same-origin" } });
        expect(sameOrigin.status).toBe(200);
        expect(await sameOrigin.text()).toBe(SCRIPT);
        // A top-level navigation from a sibling or another site is how the signed link is meant to be used.
        for (const site of ["same-site", "cross-site"]) {
          const page = await dw.call(versionRoot, { headers: { ...NAV, Cookie: cookie, "Sec-Fetch-Site": site } });
          expect(page.status, `navigation with Sec-Fetch-Site: ${site}`).toBe(200);
          expect(await page.text()).toContain("preview guard page");
        }
      });
    }

    // Catches preview bytes inheriting the live site's shared-cache and CORS headers.
    it("preview responses are private, no-store and not CORS-readable, even for fingerprinted assets", async () => {
      const cookie = await previewCookie(dw, await publish(dw));
      // Control: the same live asset is publicly cacheable and CORS-readable, so the preview must override it.
      const live = await dw.call(`${topology.root(SLUG)}${ASSET}`);
      expect(live.status).toBe(200);
      expect(live.headers.get("cache-control")).toMatch(/\bimmutable\b/);
      expect(live.headers.get("access-control-allow-origin")).toBe("*");
      const responses: [string, Response][] = [
        ["cookie asset", await dw.call(`${versionRoot}${ASSET}`, { headers: { Cookie: cookie } })],
        ["owner asset", await dw.call(`${versionRoot}${ASSET}`, { key: dw.ownerKey })],
        ["cookie page", await dw.call(versionRoot, { headers: { ...NAV, Cookie: cookie } })],
        ["owner HEAD", await dw.call(`${versionRoot}${ASSET}`, { method: "HEAD", key: dw.ownerKey })],
      ];
      for (const [label, res] of responses) {
        expect(res.status, label).toBe(200);
        expectPrivate(res);
      }
    });

    // Catches the routed 500 fallback dropping preview privacy (the URL may still carry the bearer token).
    it("an unexpected error on a preview route answers 500 with preview privacy headers", async () => {
      dw = await freshInstance(topology.config, { adapters: { identity: {
        resolve(request, dc) {
          if (request.headers.has("X-Preview-Error")) throw new Error("preview identity failure");
          return defaultIdentity.resolve(request, dc);
        },
      } } });
      const publication = await publish(dw);
      vi.spyOn(console, "error").mockImplementation(() => {});
      for (const url of [publication.versionUrl, versionRoot]) {
        const failure = await dw.call(url, { key: dw.ownerKey, headers: { "X-Preview-Error": "yes" } });
        expect(failure.status).toBe(500);
        expectPrivate(failure);
      }
    });

    // Catches a deleted version's 410 being indexable or leaking its address through a Referer.
    it("a deleted version answers 410 with preview privacy headers", async () => {
      const first = await publish(dw);
      const newer = await dw.json("/api/v1/publish", {
        key: dw.ownerKey, ...jsonBody({ site: SLUG, files: [{ path: "index.html", content: "<p>newer</p>" }] }),
      });
      expect(newer.status).toBe(200);
      const deleted = await dw.call(`/api/v1/sites/${SLUG}/versions/${first.version.id}`, { method: "DELETE", key: dw.ownerKey });
      expect(deleted.status).toBe(200);
      for (const url of [versionRoot, `${versionRoot}${ASSET}`, first.versionUrl]) {
        const gone = await dw.call(url, { headers: NAV });
        expect(gone.status, url).toBe(410);
        expectPrivate(gone);
      }
    });
  });
}
