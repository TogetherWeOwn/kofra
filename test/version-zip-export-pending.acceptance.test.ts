/**
 * Pending exports must refuse missing bytes before committing a ZIP response.
 * Regression: removing the pending preflight returns 200, then fails mid-stream.
 * Uses disposable workerd/D1/R2/KV fixtures and the public manifest upload flow.
 */
import { sha256Hex } from "@dropway/core";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody, type Instance } from "./helpers";

async function pendingVersion(dw: Instance) {
  const slug = "zip-pending";
  const files = [
    { path: "index.html", bytes: new TextEncoder().encode("<h1>already uploaded</h1>\n") },
    { path: "assets/withheld.bin", bytes: new Uint8Array([0, 255, 128, 13, 10, 42]) },
  ];
  const manifest = await Promise.all(files.map(async (file) => ({
    path: file.path,
    size: file.bytes.length,
    sha256: await sha256Hex(file.bytes),
  })));
  const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug }) });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const deploy = await dw.json(`/api/v1/sites/${slug}/deploys`, {
    key: dw.ownerKey,
    ...jsonBody({ files: manifest }),
  });
  expect(deploy.status, JSON.stringify(deploy.body)).toBe(201);
  expect(deploy.body.deploy.id).toEqual(expect.any(String));
  expect(deploy.body.deploy.id.length).toBeGreaterThan(0);
  expect(deploy.body.missing).toEqual(expect.arrayContaining(manifest.map((file) => file.sha256)));

  const upload = await dw.json(`/api/v1/blobs/${manifest[0]!.sha256}`, {
    method: "PUT",
    key: dw.ownerKey,
    headers: { "Content-Length": String(files[0]!.bytes.length) },
    body: files[0]!.bytes,
  });
  expect([200, 201], JSON.stringify(upload.body)).toContain(upload.status);
  // No upload of the second nonempty file, and no finalize: address this pending id directly.
  const versionId = deploy.body.deploy.id as string;
  const versionPath = `/api/v1/sites/${slug}/versions/${encodeURIComponent(versionId)}`;
  const version = await dw.json(versionPath, { key: dw.ownerKey });
  expect(version.status, JSON.stringify(version.body)).toBe(200);
  expect(version.body.version.status).toBe("pending");
  return { slug, versionId, exportPath: `${versionPath}/export`, files, manifest };
}

describe("export_version: pending missing-byte preflight", () => {
  it("returns JSON 409 missing_blobs before reading any ZIP body", async () => {
    const dw = await freshInstance();
    const pending = await pendingVersion(dw);
    const res = await dw.call(pending.exportPath, {
      key: dw.ownerKey,
      headers: { Accept: "application/zip" },
    });
    try {
      // Status is asserted before consuming anything: a broken 200 stream is not a refusal.
      expect(res.status).toBe(409);
      expect(res.bodyUsed).toBe(false);
      expect(res.headers.get("content-type")).toMatch(/^application\/json\b/);
      const body = await res.json() as {
        error: { code: string; details: { missing: string[] }; hint: string };
        requestId: string;
      };
      expect(body.error.code).toBe("missing_blobs");
      expect(body.requestId).toEqual(expect.any(String));
      expect(body.requestId.trim().length).toBeGreaterThan(0);
      expect(body.error.details.missing).toContain(pending.manifest[1]!.sha256);
      expect(body.error.details.missing).not.toContain(pending.manifest[0]!.sha256);
      expect(body.error.hint).toMatch(/upload/i);
      expect(body.error.hint).toMatch(/finaliz/i);
    } finally {
      if (!res.bodyUsed) await res.body?.cancel();
    }
  });

  it("exports exact bytes after uploading the missing blob and finalizing the same version", async () => {
    const dw = await freshInstance();
    const pending = await pendingVersion(dw);
    const withheld = pending.files[1]!;
    const upload = await dw.json(`/api/v1/blobs/${pending.manifest[1]!.sha256}`, {
      method: "PUT",
      key: dw.ownerKey,
      headers: { "Content-Length": String(withheld.bytes.length) },
      body: withheld.bytes,
    });
    expect([200, 201], JSON.stringify(upload.body)).toContain(upload.status);
    const finalized = await dw.json(`/api/v1/sites/${pending.slug}/deploys/${pending.versionId}/finalize`, {
      method: "POST",
      key: dw.ownerKey,
    });
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
    expect(finalized.body.live).toBe(true);

    const res = await dw.call(pending.exportPath, { key: dw.ownerKey, headers: { Accept: "application/zip" } });
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^application\/zip\b/);
      const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
      expect(Object.keys(entries).sort()).toEqual(pending.files.map((file) => file.path).sort());
      for (const file of pending.files) {
        expect(entries[file.path], `${file.path} must round-trip byte-for-byte`).toEqual(file.bytes);
      }
    } finally {
      if (!res.bodyUsed) await res.body?.cancel();
    }
  });
});
