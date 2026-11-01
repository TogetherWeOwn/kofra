import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { databaseBoundary, request } from "./delivery-review-fixtures";
import { form, freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";

const HTML = '<!doctype html><title>Published bytes</title><script src="/app.js"></script>';
let dw: Instance;
beforeEach(async () => { dw = await freshInstance(); });

async function pending() {
  const site = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "warning-fault" }) });
  expect(site.status).toBe(201);
  const entry = await manifestEntry("index.html", HTML);
  const created = await dw.json("/api/v1/sites/warning-fault/versions", {
    key: dw.ownerKey, ...jsonBody({ files: [{ path: entry.path, sha256: entry.sha256, size: entry.size }] }),
  });
  expect(created.status).toBe(201);
  const upload = await dw.call(`/api/v1/blobs/${entry.sha256}`, {
    method: "PUT", key: dw.ownerKey, body: entry.bytes, headers: { "Content-Length": String(entry.size) },
  });
  expect(upload.status).toBe(201);
  return created.body.version.id as string;
}

function warningFailure() {
  let faults = 0;
  let publishedAtFailure = false;
  const DB = databaseBoundary(async (statements) => {
    // The ordered advisory-file read observed at the D1 boundary. Other reads,
    // real authorization, storage and the publication transaction remain intact.
    const advisory = statements.some((sql) => sql.replace(/\s+/g, " ").trim().startsWith(
      "SELECT vf.path, vf.sha256, vf.size, vf.content_type AS contentType, COALESCE(b.storage_key, 'blobs/' || b.sha256) AS storageKey FROM version_files vf LEFT JOIN blobs b ON b.sha256 = vf.sha256 WHERE vf.version_id = ? ORDER BY vf.path",
    ));
    if (!advisory) return;
    const live = await env.DB.prepare(`SELECT v.status FROM versions v JOIN sites s ON s.current_version_id = v.id WHERE s.slug = ?`)
      .bind("warning-fault").first<{ status: string }>();
    publishedAtFailure = live?.status === "ready";
    faults++;
    throw new Error("injected advisory warning query failure");
  });
  return { DB, get faults() { return faults; }, get publishedAtFailure() { return publishedAtFailure; } };
}

async function withDatabase(path: string, init: RequestInit, DB: D1Database) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${dw.ownerKey}`);
  return request(dw, `${ORIGIN}${path}`, { ...init, headers }, { DB });
}

async function expectLiveBytes() {
  const page = await dw.call("/s/warning-fault/?raw=1");
  expect(page.status).toBe(200);
  expect(await page.text()).toBe(HTML);
}

describe("advisory warning failures", () => {
  it.each([false, true])("preserves successful finalize when the warning query fails (ready replay: %s)", async (replay) => {
    const id = await pending();
    const path = `/api/v1/sites/warning-fault/versions/${id}/finalize`;
    if (replay) {
      const first = await dw.json(path, { method: "POST", key: dw.ownerKey });
      expect(first.status).toBe(200);
      expect(first.body.warnings.map((w: { code: string }) => w.code)).toContain("root_absolute_paths");
    }
    const fault = warningFailure();
    const response = await withDatabase(path, { method: "POST" }, fault.DB);
    const body = await response.json() as Record<string, any>;
    expect.soft(response.status).toBe(200);
    expect.soft(body.warnings).toEqual([]);
    if (replay) expect.soft(body.replayed).toBe(true);
    expect(fault.faults).toBeGreaterThan(0);
    expect(fault.publishedAtFailure).toBe(true);
    await expectLiveBytes();
  });

  it("preserves unchanged multipart success when the warning query fails", async () => {
    const first = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form({ "index.html": HTML }, { slug: "warning-fault" }),
    });
    expect(first.status).toBe(201);
    expect(first.body.warnings.map((w: { code: string }) => w.code)).toContain("root_absolute_paths");
    const fault = warningFailure();
    const response = await withDatabase("/api/v1/publish", {
      method: "POST", body: form({ "index.html": HTML }, { slug: "warning-fault" }),
    }, fault.DB);
    const body = await response.json() as Record<string, any>;
    expect.soft(response.status).toBe(200);
    expect.soft(body.unchanged).toBe(true);
    expect.soft(body.warnings).toEqual([]);
    expect(fault.faults).toBeGreaterThan(0);
    expect(fault.publishedAtFailure).toBe(true);
    await expectLiveBytes();
  });

  it("preserves unchanged file-source success when the warning query fails", async () => {
    const input = { site: "warning-fault", files: [{ path: "index.html", content: HTML }] };
    const first = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody(input) });
    expect(first.status).toBe(201);
    expect(first.body.warnings.map((w: { code: string }) => w.code)).toContain("root_absolute_paths");
    const fault = warningFailure();
    const response = await withDatabase("/api/v1/publish", jsonBody(input), fault.DB);
    const body = await response.json() as Record<string, any>;
    expect.soft(response.status).toBe(200);
    expect.soft(body.status).toBe("unchanged");
    expect.soft(body.warnings).toEqual([]);
    expect.soft(fault.faults).toBeGreaterThan(0);
    if (fault.faults) expect(fault.publishedAtFailure).toBe(true);
    await expectLiveBytes();
  });

  it("does not turn unauthorized finalize into success", async () => {
    const id = await pending();
    const fault = warningFailure();
    const response = await request(dw, `${ORIGIN}/api/v1/sites/warning-fault/versions/${id}/finalize`, { method: "POST" }, { DB: fault.DB });
    expect(response.status).toBe(401);
    expect(fault.faults).toBe(0);
    const version = await env.DB.prepare("SELECT status FROM versions WHERE id = ?").bind(id).first<{ status: string }>();
    expect(version?.status).toBe("pending");
  });

  it("does not swallow failure of the actual finalize transaction", async () => {
    const id = await pending();
    let faults = 0;
    const DB = databaseBoundary(async (sql) => {
      if (sql.some((statement) => /\bUPDATE\s+versions\b/i.test(statement))) {
        faults++;
        throw new Error("injected finalize transaction failure");
      }
    });
    const response = await withDatabase(`/api/v1/sites/warning-fault/versions/${id}/finalize`, { method: "POST" }, DB);
    expect(response.status).toBe(500);
    expect(faults).toBeGreaterThan(0);
    const version = await env.DB.prepare("SELECT status FROM versions WHERE id = ?").bind(id).first<{ status: string }>();
    expect(version?.status).toBe("pending");
    expect((await dw.call("/s/warning-fault/?raw=1")).status).toBe(404);
  });

  it("does not swallow a blob storage write failure during publish", async () => {
    let faults = 0;
    const FILES = new Proxy(env.FILES, { get(target, property) {
      if (property === "put") return async () => { faults++; throw new Error("injected blob storage write failure"); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const response = await request(dw, `${ORIGIN}/api/v1/publish`, {
      method: "POST", headers: { Authorization: `Bearer ${dw.ownerKey}` },
      body: form({ "index.html": HTML }, { slug: "warning-fault" }),
    }, { FILES });
    expect(response.status).toBe(500);
    expect(faults).toBeGreaterThan(0);
    expect((await dw.call("/s/warning-fault/?raw=1")).status).toBe(404);
  });
});
