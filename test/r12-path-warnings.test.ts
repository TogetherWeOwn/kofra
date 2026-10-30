import { beforeEach, describe, expect, it } from "vitest";
import { form, freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";

const BROWSER_NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

// The AWS documentation example key id (not a credential); it matches the high-signal AKIA shape.
const EXAMPLE_KEY = "AKIAIOSFODNN7EXAMPLE";

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

const warnCodes = (warnings: Array<{ code: string }>) => warnings.map((w) => w.code);

describe("publish warnings (PUB-12)", () => {
  it("one-shot publish returns every R-12 warning kind with fix text", async () => {
    const res = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form(
        {
          "index.html": '<!doctype html><title>App</title><script src="/assets/app.js"></script><script>localStorage.setItem("k", "v")</script>',
          "assets/app.js": `fetch("/api/data")\nconst key = "${EXAMPLE_KEY}";\n`,
          "app.wasm": new Uint8Array([0, 97, 115, 109]),
          ".dropway/config.json": "{oops",
        },
        { spa: "true" },
      ),
    });
    expect(res.status).toBe(201);
    const warnings = res.body.warnings as Array<{ code: string; message: string; path?: string; line?: number; fix?: string }>;
    expect(warnCodes(warnings)).toEqual(
      expect.arrayContaining(["root_absolute_paths", "spa_without_base", "uses_browser_storage", "wasm_without_coi", "possible_secret", "invalid_config"]),
    );
    for (const w of warnings) expect(w.fix, `warning ${w.code} carries fix text`).toBeTruthy();
    const secret = warnings.find((w) => w.code === "possible_secret")!;
    expect(secret.path).toBe("assets/app.js");
    expect(secret.line).toBe(2);
    expect(secret.message).not.toContain(EXAMPLE_KEY);
    const config = warnings.find((w) => w.code === "invalid_config")!;
    expect(config.path).toBe(".dropway/config.json");
  });

  it("a clean publish returns none of the R-12 warnings", async () => {
    const res = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form(
        {
          "index.html": '<!doctype html><title>Ok</title><base href="./"><script src="assets/app.js"></script>',
          "assets/app.js": 'fetch("data.json")',
          ".dropway/config.json": '{"note":"valid"}',
        },
        { spa: "true" },
      ),
    });
    expect(res.status).toBe(201);
    const codes = warnCodes(res.body.warnings);
    for (const code of ["root_absolute_paths", "spa_without_base", "uses_browser_storage", "wasm_without_coi", "possible_secret", "invalid_config"]) {
      expect(codes).not.toContain(code);
    }
  });

  it("root_absolute_paths and spa_without_base are path-mode warnings (silent in subdomain mode)", async () => {
    const sub = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test" });
    const res = await sub.json("/api/v1/publish", {
      method: "POST",
      key: sub.ownerKey,
      body: form(
        {
          "index.html": '<!doctype html><title>App</title><script src="/assets/app.js"></script><script>localStorage.setItem("k", "v")</script>',
          "assets/app.js": 'fetch("/api/data")',
        },
        { spa: "true" },
      ),
    });
    expect(res.status).toBe(201);
    const codes = warnCodes(res.body.warnings);
    expect(codes).not.toContain("root_absolute_paths");
    expect(codes).not.toContain("spa_without_base");
    // Subdomain mode is unsandboxed by default, so browser storage works there.
    expect(codes).not.toContain("uses_browser_storage");
  });

  it("finalize returns warnings, and a replayed finalize returns them again", async () => {
    await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "warn-site" }) });
    const a = await manifestEntry("index.html", "<h1>A</h1>");
    const b = await manifestEntry("app.wasm", "\0asm");
    const deploy = await dw.json("/api/v1/sites/warn-site/deploys", {
      key: dw.ownerKey,
      ...jsonBody({ files: [a, b].map(({ bytes: _b, ...e }) => e) }),
    });
    expect(deploy.status).toBe(201);
    for (const e of [a, b]) {
      const up = await dw.json(`/api/v1/blobs/${e.sha256}`, { method: "PUT", key: dw.ownerKey, body: e.bytes, headers: { "Content-Length": String(e.size) } });
      expect(up.status).toBe(201);
    }
    const fin = await dw.json(`/api/v1/sites/warn-site/deploys/${deploy.body.deploy.id}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(fin.status).toBe(200);
    expect(warnCodes(fin.body.warnings)).toContain("wasm_without_coi");
    const again = await dw.json(`/api/v1/sites/warn-site/deploys/${deploy.body.deploy.id}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(again.body.replayed).toBe(true);
    expect(warnCodes(again.body.warnings)).toContain("wasm_without_coi");
  });
});

describe("reserved and private paths", () => {
  it("rejects __dropway/ paths at one-shot publish and at manifest deploy", async () => {
    const pub = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({ "index.html": "<p>x</p>", "__dropway/evil.txt": "nope" }),
    });
    expect(pub.status).toBe(400);
    expect(pub.body.error.code).toBe("reserved_path");

    await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "reserved-site" }) });
    const e = await manifestEntry("__dropway/evil.txt", "nope");
    const deploy = await dw.json("/api/v1/sites/reserved-site/deploys", {
      key: dw.ownerKey,
      ...jsonBody({ files: [{ path: e.path, size: e.size, sha256: e.sha256 }] }),
    });
    expect(deploy.status).toBe(400);
    expect(deploy.body.error.code).toBe("reserved_path");
  });

  it(".dropway/* files are stored (owner read-back works) but never served", async () => {
    const pub = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({ "index.html": "<p>home</p>", ".dropway/notes.txt": "internal note", ".dropway/index.html": "<p>hidden home</p>", "docs/guide.txt": "guide" }),
    });
    expect(pub.status).toBe(201);
    const slug = pub.body.slug as string;

    const listed = await dw.json(`/api/v1/sites/${slug}/files`, { key: dw.ownerKey });
    expect(listed.body.files.map((f: { path: string }) => f.path)).toContain(".dropway/notes.txt");
    const readBack = await dw.call(`/api/v1/sites/${slug}/files/.dropway/notes.txt`, { key: dw.ownerKey });
    expect(readBack.status).toBe(200);
    expect(await readBack.text()).toContain("internal note");

    for (const suffix of ["", "?raw=1", "?view=1"]) {
      const served = await dw.call(`/s/${slug}/.dropway/notes.txt${suffix}`, { headers: BROWSER_NAV });
      expect(served.status, `serving .dropway with ${suffix || "no query"}`).toBe(404);
      expect(await served.text()).not.toContain("internal note");
    }
    const dir = await dw.call(`/s/${slug}/.dropway/`, { headers: BROWSER_NAV });
    expect(dir.status).toBe(404);
    // Even an index file inside .dropway/ is not served through directory resolution.
    const indexDir = await dw.call(`/s/${slug}/.dropway`, { headers: BROWSER_NAV });
    expect(indexDir.status).toBe(404);

    // A folder listing never names the .dropway folder.
    const listingSite = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({ "a.txt": "a", "b/c.txt": "c", ".dropway/notes.txt": "internal note" }),
    });
    const listing = await (await dw.call(`/s/${listingSite.body.slug}/`, { headers: BROWSER_NAV })).text();
    expect(listing).toContain("a.txt");
    expect(listing).not.toContain(".dropway");
  });
});

describe("SPA navigation fallback by Referer (SRV-02)", () => {
  it("redirects a navigation from inside an SPA site to the same path inside the site", async () => {
    const pub = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({ "index.html": "<!doctype html><title>SPA</title>" }, { spa: "true" }),
    });
    const slug = pub.body.slug as string;
    const res = await dw.call("/some/client/route?tab=2", { headers: { ...BROWSER_NAV, Referer: `${ORIGIN}/s/${slug}/` } });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`/s/${slug}/some/client/route?tab=2`);
    // The redirect target is then served by the SPA fallback.
    const page = await dw.call(`/s/${slug}/some/client/route?tab=2`, { headers: BROWSER_NAV });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>SPA</title>");
  });

  it("does not redirect missing paths for non-SPA sites, sub-resources, or app routes", async () => {
    const plain = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({ "index.html": "<p>plain</p>" }),
    });
    const plainSlug = plain.body.slug as string;
    const notSpa = await dw.call("/some/client/route", { headers: { ...BROWSER_NAV, Referer: `${ORIGIN}/s/${plainSlug}/` } });
    expect(notSpa.status).toBe(404);

    const spaPub = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({ "index.html": "<!doctype html><title>SPA</title>" }, { spa: "true" }),
    });
    const spaSlug = spaPub.body.slug as string;
    const subResource = await dw.call("/some/client/route", { headers: { "Sec-Fetch-Dest": "script", Referer: `${ORIGIN}/s/${spaSlug}/` } });
    expect(subResource.status).toBe(404);

    // A navigation from an SPA page to a real app route still reaches the app.
    const appRoute = await dw.call("/openapi.json", { headers: { ...BROWSER_NAV, Referer: `${ORIGIN}/s/${spaSlug}/` } });
    expect(appRoute.status).toBe(200);
    expect(((await appRoute.json()) as { openapi: string }).openapi).toBe("3.1.0");
  });

  it("redirects SPA navigations on a separate sites origin too", async () => {
    const two = await freshInstance({ appOrigin: ORIGIN, sitesOrigin: "https://sites.example" });
    const pub = await two.json("/api/v1/publish", {
      method: "POST",
      key: two.ownerKey,
      body: form({ "index.html": "<!doctype html><title>SPA</title>" }, { spa: "true" }),
    });
    const slug = pub.body.slug as string;
    const res = await two.call("https://sites.example/deep/link", { headers: { ...BROWSER_NAV, Referer: `https://sites.example/${slug}/` } });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`/${slug}/deep/link`);
  });
});
