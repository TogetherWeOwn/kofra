import { describe, expect, it } from "vitest";
import { freshInstance, form, jsonBody, manifestEntry, ORIGIN } from "./helpers";
import { CLIENT_SCRIPT } from "../packages/server/src/ui/assets";

// Protected control for the Node VM receipt tests. Disposable real D1/R2/KV
// establish the response shapes and the exact script served to the browser.
// This does NOT implement or substitute for the interaction/feature assertions
// in packages/server/test/public-receipt.acceptance.test.ts.
describe("public receipt: real Worker boundary controls", () => {
  it("serves the exact first-party script exercised by the VM acceptance tests", async () => {
    const dw = await freshInstance();
    const page = await dw.call("/dashboard/publish");
    expect(page.status).toBe(200);
    const html = await page.text();
    const src = /src="([^"\s]*\/__dropway\/ui\/app-[^"\s]+\.js)"/.exec(html)?.[1];
    expect(src, "publisher shell must load its real first-party asset").toBeTruthy();
    const asset = await dw.call(src!);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe(CLIENT_SCRIPT);
  });

  it("returns exact ready-version metadata on finalize and unchanged deploy without extra backend fields", async () => {
    const dw = await freshInstance();
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "receipt-response" }) });
    expect(created.status).toBe(201);
    const entry = await manifestEntry("index.html", "receipt bytes");
    const body = { files: [{ path: entry.path, size: entry.size, sha256: entry.sha256 }] };
    const pending = await dw.json("/api/v1/sites/receipt-response/deploys", { key: dw.ownerKey, ...jsonBody(body) });
    expect(pending.status).toBe(201);
    const uploaded = await dw.json(`/api/v1/blobs/${entry.sha256}`, {
      key: dw.ownerKey, method: "PUT", body: entry.bytes, headers: { "Content-Length": String(entry.size) },
    });
    expect(uploaded.status).toBe(201);
    const finalized = await dw.json(`/api/v1/sites/receipt-response/deploys/${pending.body.deploy.id}/finalize`, { key: dw.ownerKey, method: "POST" });
    expect(finalized.status).toBe(200);
    expect(finalized.body.url).toBe(`${ORIGIN}/s/receipt-response/`);
    expect(finalized.body.site?.currentVersion).toMatchObject({ id: pending.body.deploy.id, number: 1, fileCount: 1, totalBytes: 13 });
    const unchanged = await dw.json("/api/v1/sites/receipt-response/deploys", { key: dw.ownerKey, ...jsonBody(body) });
    expect(unchanged.body.unchanged).toBe(true);
    expect(unchanged.body.deploy).toMatchObject({ id: pending.body.deploy.id, number: 1, fileCount: 1, totalBytes: 13 });
  });

  it("returns version-level totals plus a separate claim token on anonymous one-shot success", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const result = await dw.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "receipt bytes" }) });
    expect(result.status).toBe(201);
    expect(result.body.version).toMatchObject({ number: 1, fileCount: 1, totalBytes: 13 });
    expect(result.body.version.id).toEqual(expect.any(String));
    expect(result.body.claimToken).toMatch(/^dwc_/);
    expect(result.body.url).toBe(`${ORIGIN}/s/${result.body.slug}/`);
    // Never print/store the generated credential in an evidence document.
  });
});
