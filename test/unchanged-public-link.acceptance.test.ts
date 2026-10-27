import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody, manifestEntry } from "./helpers";

// Real disposable Worker controls for the browser's unchanged-result recovery.
// The UI assertions live in the paired browser acceptance file, not here.
describe("unchanged public link: authorized Worker read contract", () => {
  for (const mode of [
    { name: "app path", config: { appOrigin: "https://publisher.test", sitesMode: "path" as const }, url: "https://publisher.test/s/link-current/" },
    { name: "separate sites origin", config: { appOrigin: "https://publisher.test", sitesMode: "path" as const, sitesOrigin: "https://files.example.test" }, url: "https://files.example.test/link-current/" },
    { name: "subdomain", config: { appOrigin: "https://publisher.test", sitesMode: "subdomain" as const, sitesDomain: "pages.example.test" }, url: "https://link-current.pages.example.test/" },
  ]) {
    it(`${mode.name}: an unchanged deploy keeps its identity while get_site returns the renamed live URL`, async () => {
      const dw = await freshInstance(mode.config);
      const call = (path: string, init: RequestInit = {}) => dw.json(path, { origin: "https://publisher.test", key: dw.ownerKey, ...init });
      const created = await call("/api/v1/sites", jsonBody({ slug: "link-before" }));
      expect(created.status).toBe(201);
      const entry = await manifestEntry("docs/<img onerror=alert(1)>.txt", "same bytes");
      const manifest = { files: [{ path: entry.path, size: entry.size, sha256: entry.sha256 }] };
      const pending = await call("/api/v1/sites/link-before/deploys", jsonBody(manifest));
      expect(pending.status).toBe(201);
      expect((await call(`/api/v1/blobs/${entry.sha256}`, { method: "PUT", body: entry.bytes, headers: { "Content-Length": String(entry.size) } })).status).toBe(201);
      const ready = await call(`/api/v1/sites/link-before/deploys/${pending.body.deploy.id}/finalize`, { method: "POST" });
      expect(ready.status).toBe(200);
      const unchanged = await call("/api/v1/sites/link-before/deploys", jsonBody(manifest));
      expect(unchanged.status).toBe(200);
      expect(unchanged.body.unchanged).toBe(true);
      expect(unchanged.body.deploy).toMatchObject({ id: pending.body.deploy.id, number: 1, fileCount: 1, totalBytes: 10 });

      expect((await call("/api/v1/sites/link-before/rename", jsonBody({ newSlug: "link-current" }))).status).toBe(200);
      const recovered = await call("/api/v1/sites/link-current");
      expect(recovered.status).toBe(200);
      expect(recovered.body.site).toMatchObject({ slug: "link-current", url: mode.url, currentVersionId: pending.body.deploy.id });
      const publicFile = await dw.call(mode.url + encodeURIComponent(entry.path.split("/")[0]!) + "/" + encodeURIComponent(entry.path.split("/")[1]!) + "?raw=1");
      expect(publicFile.status).toBe(200);
      expect(await publicFile.text()).toBe("same bytes");
      // This is an authorized management read, never an anonymous public-page fetch.
      const denied = await dw.json("/api/v1/sites/link-before", { origin: "https://publisher.test" });
      expect(denied.status).toBe(401);
      const versions = await call("/api/v1/sites/link-current/versions");
      expect(versions.status).toBe(200);
      expect(versions.body.versions).toHaveLength(1);
    });
  }
});
