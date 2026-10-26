import { beforeEach, describe, expect, it } from "vitest";
import { form, freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";
import { b64, connectMcp } from "./mcp-helpers";

const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const SITES = "https://sites.example";
const WARNING_FILES = {
  "index.html": '<!doctype html><title>Warning fixture</title><script src="/assets/app.js"></script>',
  "assets/app.js": 'fetch("/api/data")',
  "app.wasm": new Uint8Array([0, 97, 115, 109]),
};

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

describe("unchanged publication warnings", () => {
  it("retains path and wasm warnings when identical multipart bytes are published again", async () => {
    const publish = () => dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form(WARNING_FILES, { slug: "same-multipart" }),
    });
    const first = await publish();
    expect(first.status).toBe(201);
    expect(first.body.warnings.map((w: { code: string }) => w.code)).toEqual(
      expect.arrayContaining(["root_absolute_paths", "wasm_without_coi"]),
    );
    const again = await publish();
    expect(again.status).toBe(200);
    expect(again.body.unchanged).toBe(true);
    expect(first.body.version.id).toEqual(expect.any(String));
    expect(again.body.version.id).toBe(first.body.version.id);
    expect(again.body.warnings).toEqual(first.body.warnings);
  });

  it.each(["REST publish", "MCP publish", "REST update", "MCP update"])("retains nonempty warnings for unchanged file sources via %s", async (surface) => {
    const files = Object.entries(WARNING_FILES).map(([path, content]) => typeof content === "string"
      ? { path, content }
      : { path, content: b64(content), encoding: "base64" });
    const input = { site: "same-sources", files };
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const publish = async () => {
        if (surface.startsWith("MCP")) {
          const result = await mcp.call("publish_site", input);
          expect(result.isError).toBe(false);
          return result.data;
        }
        const result = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody(input) });
        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        return result.body;
      };
      const first = await publish();
      expect(first.status).toBe("live");
      expect(first.warnings.map((w: { code: string }) => w.code)).toEqual(
        expect.arrayContaining(["root_absolute_paths", "wasm_without_coi"]),
      );
      let again: Record<string, any>;
      if (surface === "MCP update") {
        const result = await mcp.call("update_site_files", { ...input, baseVersionId: first.version.id });
        expect(result.isError).toBe(false);
        again = result.data;
      } else if (surface === "REST update") {
        const result = await dw.json("/api/v1/sites/same-sources/files", {
          key: dw.ownerKey, ...jsonBody({ files, baseVersionId: first.version.id }), method: "PATCH",
        });
        expect(result.status).toBe(200);
        again = result.body;
      } else {
        again = await publish();
      }
      expect(again.status).toBe("unchanged");
      expect(again.version.id).toBe(first.version.id);
      expect(again.warnings).toEqual(first.warnings);
    } finally {
      await mcp.client.close();
    }
  });
});

describe("a sole private configuration file", () => {
  const privateBytes = "private configuration sentinel that must not become the home page";

  it.each(["", "?raw=1", "?view=1", "?download=1"])("does not expose .dropway through the single-file root shortcut %s", async (query) => {
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form({ ".dropway": privateBytes }, { slug: "private-only" }),
    });
    expect(published.status).toBe(201);
    const root = await dw.call(`/s/private-only/${query}`, { headers: NAV });
    expect.soft(root.status).toBe(404);
    expect.soft(new TextDecoder().decode(await root.arrayBuffer())).not.toContain(privateBytes);
    const direct = await dw.call(`/s/private-only/.dropway${query}`, { headers: NAV });
    expect(direct.status).toBe(404);
    expect(await direct.text()).not.toContain(privateBytes);
    const ownerRead = await dw.call("/api/v1/sites/private-only/files/.dropway", { key: dw.ownerKey });
    expect(ownerRead.status).toBe(200);
    expect(new TextDecoder().decode(await ownerRead.arrayBuffer())).toBe(privateBytes);
  });

  it("preserves the public single-file root shortcut", async () => {
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form({ "note.txt": "ordinary public file" }, { slug: "public-only" }),
    });
    expect(published.status).toBe(201);
    const root = await dw.call("/s/public-only/?raw=1");
    expect(root.status).toBe(200);
    expect(await root.text()).toBe("ordinary public file");
  });
});

describe("SPA Referer routing boundaries", () => {
  it.each(["/dashboard", "/login", "/api", "/v/spa-app/route", "/docs/getting-started"])(
    "preserves extensionless app-route behavior at %s even with an SPA Referer", async (path) => {
      const published = await dw.json("/api/v1/publish", {
        method: "POST", key: dw.ownerKey,
        body: form({ "index.html": "<!doctype html><title>SPA boundary sentinel</title>" }, { slug: "spa-app", spa: "true" }),
      });
      expect(published.status).toBe(201);
      const baseline = await dw.call(path, { headers: NAV });
      const referred = await dw.call(path, { headers: { ...NAV, Referer: `${ORIGIN}/s/spa-app/` } });
      expect(baseline.status).not.toBe(307);
      expect(referred.status).toBe(baseline.status);
      expect(referred.headers.get("location")).toBe(baseline.headers.get("location"));
      expect(referred.headers.get("content-type")).toBe(baseline.headers.get("content-type"));
      expect(await referred.text()).not.toContain("SPA boundary sentinel");
    },
  );

  it.each([
    { path: "/site-b", status: 301, location: "/site-b/", title: null },
    { path: "/site-b/about", status: 200, location: null, title: "B about page" },
  ])("does not let SPA A capture navigation to live B at $path", async ({ path, status, location, title }) => {
    dw = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: SITES });
    const a = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({ "index.html": "<!doctype html><title>SPA A</title>" }, { slug: "site-a", spa: "true" }),
    });
    expect(a.status).toBe(201);
    const b = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({ "index.html": "<!doctype html><title>B home</title>", "about.html": "<!doctype html><title>B about page</title>" }, { slug: "site-b" }),
    });
    expect(b.status).toBe(201);
    const baseline = await dw.call(`${SITES}${path}`, { headers: NAV });
    expect(baseline.status).toBe(status);
    expect(baseline.headers.get("location")).toBe(location);
    const page = await dw.call(`${SITES}${path}`, { headers: { ...NAV, Referer: `${SITES}/site-a/` } });
    expect(page.status).toBe(status);
    expect(page.headers.get("location")).toBe(location);
    expect(page.status).toBe(baseline.status);
    expect(page.headers.get("location")).toBe(baseline.headers.get("location"));
    if (title) {
      expect(await baseline.text()).toContain(`<title>${title}</title>`);
      expect(await page.text()).toContain(`<title>${title}</title>`);
    }
  });

  it.each([
    { state: "retained", status: 404, location: null },
    { state: "deleted version", status: 410, location: null },
    { state: "deleted site", status: 410, location: null },
    { state: "renamed", status: 308, location: `${SITES}/renamed-base--v1/docs/page?tab=2` },
  ])("does not let SPA A capture a $state version address", async ({ state, status, location }) => {
    dw = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: SITES });
    const spa = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({ "index.html": "<!doctype html><title>SPA A</title>" }, { slug: "site-a", spa: "true" }),
    });
    expect(spa.status).toBe(201);
    for (const content of ["old B", "live B"]) {
      const published = await dw.json("/api/v1/publish", {
        method: "POST", key: dw.ownerKey,
        body: form({ "index.html": `<title>${content}</title>`, "docs/page": content }, { slug: "base-site" }),
      });
      expect([200, 201]).toContain(published.status);
    }
    const versions = await dw.json("/api/v1/sites/base-site/versions", { key: dw.ownerKey });
    expect(versions.status).toBe(200);
    const v1 = versions.body.versions.find((v: { number: number }) => v.number === 1);
    expect(v1.id).toEqual(expect.any(String));
    if (state === "deleted version") {
      expect((await dw.call(`/api/v1/sites/base-site/versions/${v1.id}`, { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    } else if (state === "deleted site") {
      expect((await dw.call("/api/v1/sites/base-site", { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    } else if (state === "renamed") {
      const renamed = await dw.json("/api/v1/sites/base-site/rename", { key: dw.ownerKey, ...jsonBody({ newSlug: "renamed-base" }) });
      expect(renamed.status).toBe(200);
    }
    const url = `${SITES}/base-site--v1/docs/page?tab=2`;
    const baseline = await dw.call(url, { headers: NAV });
    expect(baseline.status).toBe(status);
    expect(baseline.headers.get("location")).toBe(location);
    const referred = await dw.call(url, { headers: { ...NAV, Referer: `${SITES}/site-a/` } });
    expect(referred.status).toBe(status);
    expect(referred.headers.get("location")).toBe(location);
    expect(await referred.text()).not.toContain("<title>SPA A</title>");
  });

  it("does not let SPA A capture a renamed-away slug address", async () => {
    dw = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: SITES });
    const spa = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({ "index.html": "<!doctype html><title>SPA A</title>" }, { slug: "site-a", spa: "true" }),
    });
    expect(spa.status).toBe(201);
    const plain = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({
        "index.html": "<!doctype html><title>B home</title>",
        "deep/link": "B deep link",
      }, { slug: "site-b" }),
    });
    expect(plain.status).toBe(201);
    const renamed = await dw.json("/api/v1/sites/site-b/rename", { key: dw.ownerKey, ...jsonBody({ newSlug: "site-c" }) });
    expect(renamed.status).toBe(200);
    for (const [oldPath, location] of [
      ["/site-b/", `${SITES}/site-c/`],
      ["/site-b/deep/link", `${SITES}/site-c/deep/link`],
    ]) {
      const baseline = await dw.call(`${SITES}${oldPath}`, { headers: NAV });
      expect(baseline.status).toBe(308);
      expect(baseline.headers.get("location")).toBe(location);
      const referred = await dw.call(`${SITES}${oldPath}`, { headers: { ...NAV, Referer: `${SITES}/site-a/` } });
      expect(referred.status).toBe(baseline.status);
      expect(referred.headers.get("location")).toBe(baseline.headers.get("location"));
      expect(referred.status).toBe(308);
      expect(referred.headers.get("location")).toBe(location);
      expect(referred.headers.get("location")).not.toContain("/site-a/");
    }
  });

  it("still redirects an unknown slug-shaped deep navigation into the referring SPA", async () => {
    dw = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: SITES });
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({ "index.html": "<!doctype html><title>SPA A</title>" }, { slug: "site-a", spa: "true" }),
    });
    expect(published.status).toBe(201);
    const page = await dw.call(`${SITES}/deep/link?tab=2`, { headers: { ...NAV, Referer: `${SITES}/site-a/` } });
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("/site-a/deep/link?tab=2");
    const target = await dw.call(`${SITES}/site-a/deep/link?tab=2`, { headers: NAV });
    expect(target.status).toBe(200);
    expect(await target.text()).toContain("<title>SPA A</title>");
  });
});
