import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { zipSync, strToU8 } from "fflate";
import { form, freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

describe("one-shot publish", () => {
  it("publishes multipart files to a live URL", async () => {
    const { status, body } = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({ "index.html": "<h1>Hello</h1>", "assets/app.js": "console.log(1)" }),
    });
    expect(status).toBe(201);
    expect(body.url).toBe(`${ORIGIN}/s/${body.slug}/`);
    expect(body.files.sort()).toEqual(["assets/app.js", "index.html"]);
    expect(body.uploaded).toBe(2);
    expect(body.version.number).toBe(1);
    expect(body.version.live).toBe(true);

    const page = await dw.call(`/s/${body.slug}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toBe("<h1>Hello</h1>");
    const js = await dw.call(`/s/${body.slug}/assets/app.js`);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  it("accepts JSON files (including base64) and a chosen slug", async () => {
    const { status, body } = await dw.json("/api/v1/publish", {
      key: dw.ownerKey,
      ...jsonBody({ slug: "my-notes", files: [{ path: "index.md", content: "# Notes" }, { path: "pixel.bin", content: btoa("\u0001\u0002"), encoding: "base64" }] }),
    });
    expect(status).toBe(201);
    expect(body.slug).toBe("my-notes");
    const bin = await dw.call("/s/my-notes/pixel.bin");
    expect(new Uint8Array(await bin.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  it("accepts a single raw file body", async () => {
    const { status, body } = await dw.json("/api/v1/publish?path=report.md", {
      method: "POST",
      key: dw.ownerKey,
      headers: { "Content-Type": "text/markdown" },
      body: "# Report\n\nAll good.",
    });
    expect(status).toBe(201);
    expect(body.files).toEqual(["report.md"]);
    // A single file is served at the site root.
    const root = await dw.call(`/s/${body.slug}/`);
    expect(await root.text()).toContain("# Report");
  });

  it("unpacks a zip and strips a common top-level folder", async () => {
    const zip = zipSync({ "dist/index.html": strToU8("<p>zip</p>"), "dist/css/site.css": strToU8("p{}") });
    const { status, body } = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, headers: { "Content-Type": "application/zip" }, body: zip });
    expect(status).toBe(201);
    expect(body.files.sort()).toEqual(["css/site.css", "index.html"]);
    expect(await (await dw.call(`/s/${body.slug}/`)).text()).toBe("<p>zip</p>");
  });

  it("republishing to the same slug creates a new version; identical content is unchanged", async () => {
    const first = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "v1" }, { slug: "same-site" }) });
    expect(first.status).toBe(201);
    const second = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "v2" }, { slug: "same-site" }) });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.version.number).toBe(2);
    expect(await (await dw.call("/s/same-site/")).text()).toBe("v2");
    const third = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "v2" }, { slug: "same-site" }) });
    expect(third.body.unchanged).toBe(true);
    expect(third.body.version.number).toBe(2);
  });

  it("rejects requests without a key when anonymous publishing is off (the default)", async () => {
    const { status, body } = await dw.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "x" }) });
    expect(status).toBe(401);
    expect(body.error.code).toBe("anonymous_publish_disabled");
    expect(body.error.hint).toMatch(/API key/);
  });

  it("enforces the per-file size cap", async () => {
    const small = await freshInstance({ limits: { maxFileBytes: 10 } });
    const { status, body } = await small.json("/api/v1/publish", { method: "POST", key: small.ownerKey, body: form({ "index.html": "this is more than ten bytes" }) });
    expect(status).toBe(413);
    expect(body.error.code).toBe("file_too_large");
  });
});

describe("manifest (content-addressed) publish", () => {
  it("create site -> deploy -> upload missing -> finalize", async () => {
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "big-site" }) });
    expect(created.status).toBe(201);
    const a = await manifestEntry("index.html", "<h1>A</h1>");
    const b = await manifestEntry("about.html", "<h1>About</h1>");
    const deploy = await dw.json("/api/v1/sites/big-site/deploys", {
      key: dw.ownerKey,
      ...jsonBody({ files: [a, b].map(({ bytes: _b, ...e }) => e) }),
    });
    expect(deploy.status).toBe(201);
    expect(deploy.body.missing.sort()).toEqual([a.sha256, b.sha256].sort());
    expect(deploy.body.uploads[0].url).toMatch(/\/api\/v1\/blobs\/[a-f0-9]{64}$/);

    // Not live until finalize, and finalize refuses while files are missing.
    const early = await dw.json(`/api/v1/sites/big-site/deploys/${deploy.body.deploy.id}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("missing_blobs");

    for (const e of [a, b]) {
      const up = await dw.json(`/api/v1/blobs/${e.sha256}`, { method: "PUT", key: dw.ownerKey, body: e.bytes, headers: { "Content-Length": String(e.size) } });
      expect(up.status).toBe(201);
    }
    const fin = await dw.json(`/api/v1/sites/big-site/deploys/${deploy.body.deploy.id}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(fin.status).toBe(200);
    expect(fin.body.live).toBe(true);
    expect(fin.body.url).toBe(`${ORIGIN}/s/big-site/`);
    expect(await (await dw.call("/s/big-site/about.html")).text()).toBe("<h1>About</h1>");

    // Finalize again is safe.
    const again = await dw.json(`/api/v1/sites/big-site/deploys/${deploy.body.deploy.id}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(again.body.replayed).toBe(true);
  });

  it("rejects uploads whose bytes do not match the SHA-256", async () => {
    await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "hash-check" }) });
    const e = await manifestEntry("index.html", "real");
    await dw.json("/api/v1/sites/hash-check/deploys", { key: dw.ownerKey, ...jsonBody({ files: [{ path: e.path, size: e.size, sha256: e.sha256 }] }) });
    const bad = await dw.json(`/api/v1/blobs/${e.sha256}`, { method: "PUT", key: dw.ownerKey, body: "fake", headers: { "Content-Length": "4" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("hash_mismatch");
  });

  it("refuses blobs no pending deploy asked for", async () => {
    const e = await manifestEntry("x.txt", "unexpected");
    const res = await dw.json(`/api/v1/blobs/${e.sha256}`, { method: "PUT", key: dw.ownerKey, body: e.bytes, headers: { "Content-Length": String(e.size) } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("blob_not_expected");
  });

  it("detects a stale baseVersionId (409 version_conflict)", async () => {
    const first = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "one" }, { slug: "race-site" }) });
    const v1 = first.body.version.id;
    await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "two" }, { slug: "race-site" }) });
    const e = await manifestEntry("index.html", "three");
    const stale = await dw.json("/api/v1/sites/race-site/deploys", { key: dw.ownerKey, ...jsonBody({ baseVersionId: v1, files: [{ path: e.path, size: e.size, sha256: e.sha256 }] }) });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
  });
});

describe("dedupe", () => {
  it("never uploads the same bytes twice within a tenant, across sites", async () => {
    const shared = "body{color:red}";
    const one = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "a", "style.css": shared }) });
    expect(one.body.uploaded).toBe(2);
    const two = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "b", "style.css": shared }) });
    expect(two.body.uploaded).toBe(1);
    expect(two.body.reused).toBe(1);

    const e = await manifestEntry("style.css", shared);
    await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "third-site" }) });
    const d = await dw.json("/api/v1/sites/third-site/deploys", { key: dw.ownerKey, ...jsonBody({ files: [{ path: e.path, size: e.size, sha256: e.sha256 }] }) });
    expect(d.body.missing).toEqual([]);
    const blobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM blobs WHERE sha256 = ?").bind(e.sha256).first<{ n: number }>();
    expect(blobs?.n).toBe(1);
    const objects = await env.FILES.list({ prefix: "blobs/" });
    expect(objects.objects.filter((o) => o.key.startsWith(`blobs/${e.sha256}/`))).toHaveLength(1);
  });
});

describe("versions", () => {
  it("lists versions and restores an older one atomically", async () => {
    const v1 = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "first" }, { slug: "history" }) });
    await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "second" }, { slug: "history" }) });
    const list = await dw.json("/api/v1/sites/history/versions", { key: dw.ownerKey });
    expect(list.body.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
    expect(list.body.versions[0].live).toBe(true);

    const restored = await dw.json(`/api/v1/sites/history/versions/${v1.body.version.id}/restore`, { method: "POST", key: dw.ownerKey });
    expect(restored.status).toBe(200);
    expect(restored.body.restored).toBe(true);
    expect(await (await dw.call("/s/history/")).text()).toBe("first");
    const site = await dw.json("/api/v1/sites/history", { key: dw.ownerKey });
    expect(site.body.site.currentVersionId).toBe(v1.body.version.id);

    // The live version cannot be deleted; the other one can.
    const delLive = await dw.json(`/api/v1/sites/history/versions/${v1.body.version.id}`, { method: "DELETE", key: dw.ownerKey });
    expect(delLive.status).toBe(409);
    const other = list.body.versions[0].id;
    const del = await dw.json(`/api/v1/sites/history/versions/${other}`, { method: "DELETE", key: dw.ownerKey });
    expect(del.status).toBe(200);
  });
});

describe("read-back and site management", () => {
  it("lists files and returns raw bytes with ETag = sha256", async () => {
    await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "<b>x</b>", "data/a.json": '{"a":1}' }, { slug: "readback" }) });
    const files = await dw.json("/api/v1/sites/readback/files", { key: dw.ownerKey });
    expect(files.body.files.map((f: { path: string }) => f.path)).toEqual(["data/a.json", "index.html"]);
    expect(files.body.files[0].kind).toBe("json");
    const raw = await dw.call("/api/v1/sites/readback/files/index.html", { key: dw.ownerKey });
    expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(raw.headers.get("x-kofra-content-type")).toBe("text/html; charset=utf-8");
    expect(raw.headers.get("etag")).toBe(`"${files.body.files[1].sha256}"`);
    expect(await raw.text()).toBe("<b>x</b>");
  });

  it("gets, patches, lists and deletes sites", async () => {
    await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "x" }, { slug: "managed" }) });
    const patched = await dw.json("/api/v1/sites/managed", { method: "PATCH", key: dw.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Managed", spa: true }) });
    expect(patched.body.site.title).toBe("Managed");
    expect(patched.body.site.settings.spa).toBe(true);
    const list = await dw.json("/api/v1/sites", { key: dw.ownerKey });
    expect(list.body.sites.map((s: { slug: string }) => s.slug)).toContain("managed");
    const del = await dw.json("/api/v1/sites/managed", { method: "DELETE", key: dw.ownerKey });
    expect(del.body.deleted).toBe(true);
    expect((await dw.call("/s/managed/")).status).toBe(404);
    // The slug is free again.
    const again = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "managed" }) });
    expect(again.status).toBe(201);
  });
});
