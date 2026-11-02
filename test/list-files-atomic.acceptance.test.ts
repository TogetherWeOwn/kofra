import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  ApiError, clearLiveMemoryCache, defaultIdentity, deleteVersion, getSiteFor,
  listFiles, type VersionRow,
} from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, jsonBody, ORIGIN } from "./helpers";

/**
 * TWO-767: `listFiles` must never return ready metadata with an empty manifest.
 * It used to read the version row and the `version_files` rows in separate
 * awaits, so a concurrent `deleteVersion` landing between them produced exactly
 * that torn shape. The read is now one D1 batch (one consistent snapshot) with
 * a `file_count` guard that fails closed on any torn remainder.
 */
const SLUG = "list-files-atomic";

afterEach(() => {
  vi.restoreAllMocks();
  clearLiveMemoryCache();
});

async function fixture() {
  const dw = await freshInstance();
  for (const [status, label] of [[201, "historical"], [200, "live"]] as const) {
    const r = await dw.json("/api/v1/publish", {
      key: dw.ownerKey,
      ...jsonBody({ slug: SLUG, files: [
        { path: "index.html", content: `<h1>${label}</h1>`, contentType: "text/html" },
        { path: "nested/data.txt", content: `unique ${label}`, contentType: "text/plain" },
        { path: "shared.txt", content: "shared immutable bytes", contentType: "text/plain" },
      ] }),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(status);
  }
  const ctx = createExecutionContext();
  const dc = dw.dropway.context(env as unknown as ServerBindings, ctx);
  const principal = await defaultIdentity.resolve(new Request(`${ORIGIN}/api/v1/me`, {
    headers: { Authorization: `Bearer ${dw.ownerKey}` },
  }), dc);
  if (principal.kind !== "member") throw new Error("Fixture owner did not resolve.");
  const site = await getSiteFor(dc, principal, SLUG, "sites:delete");
  const versions = (await env.DB.prepare("SELECT * FROM versions WHERE site_id = ? ORDER BY number")
    .bind(site.id).all<VersionRow>()).results;
  expect(versions).toHaveLength(2);
  const [target, live] = versions;
  if (!target || !live) throw new Error("Fixture needs two ready versions.");
  expect(target.file_count).toBe(3);
  await waitOnExecutionContext(ctx);
  return { dw, dc, principal, site, target, live };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

async function outcome<T>(promise: Promise<T>) {
  try { return { ok: true as const, value: await promise }; }
  catch (error: unknown) { return { ok: false as const, error }; }
}

async function filesOf(h: Harness, versionId: string) {
  const listed = await listFiles(h.dc, h.site, versionId);
  expect(listed.version).toMatchObject({ id: versionId, status: "ready", fileCount: 3 });
  expect(listed.files).toHaveLength(3);
  return listed;
}

describe("listFiles pinned-version manifest read", () => {
  it("returns the complete manifest when nothing races it", async () => {
    const h = await fixture();
    const listed = await filesOf(h, h.target.id);
    expect(listed.files.map((f) => f.path).sort()).toEqual(["index.html", "nested/data.txt", "shared.txt"]);
  });

  it("fails closed instead of returning ready metadata with files: [] after a torn delete", async () => {
    const h = await fixture();
    // Simulate a deleteVersion whose manifest DELETE landed between the two
    // reads of the old implementation: version row present, file rows gone.
    const deleted = await env.DB.prepare("DELETE FROM version_files WHERE version_id = ?").bind(h.target.id).run();
    expect(deleted.meta.changes).toBe(3);
    const result = await outcome(listFiles(h.dc, h.site, h.target.id));
    expect(result.ok, "a torn manifest must fail, never read as ready with no files").toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ApiError);
      expect(result.error).toMatchObject({ status: 404, code: "version_not_found" });
    }
  });

  it("interleaves a real deleteVersion with the snapshot read and never returns a torn manifest", async () => {
    const h = await fixture();
    // Pause the snapshot read exactly once: run a real deleteVersion before the
    // read batch executes. The delete either wins completely (404) or, had it
    // lost, the read would have seen the full manifest. Ready + [] is impossible.
    const batch = env.DB.batch.bind(env.DB);
    let reads = 0;
    let competing = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async <T = unknown>(list: D1PreparedStatement[]) => {
      if (!competing && reads === 0) {
        reads++;
        competing = true;
        try {
          expect(await deleteVersion(h.dc, h.principal, h.site, h.target.id)).toEqual({ deleted: true, id: h.target.id });
        } finally { competing = false; }
      }
      return batch<T>(list);
    });
    const result = await outcome(listFiles(h.dc, h.site, h.target.id));
    expect(reads, "the deterministic read interleaving must execute once").toBe(1);
    expect(result.ok, "the winning delete must surface as version_not_found").toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ApiError);
      expect(result.error).toMatchObject({ status: 404, code: "version_not_found" });
    }
  });

  it("still reads a version a lost delete raced but did not touch", async () => {
    const h = await fixture();
    // A delete aimed at the live version is refused, so the historical read it
    // raced still returns the complete manifest.
    const batch = env.DB.batch.bind(env.DB);
    let reads = 0;
    let competing = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async <T = unknown>(list: D1PreparedStatement[]) => {
      if (!competing && reads === 0) {
        reads++;
        competing = true;
        try {
          const refused = await outcome(deleteVersion(h.dc, h.principal, h.site, h.live.id));
          expect(refused).toMatchObject({ ok: false, error: { status: 409, code: "version_is_live" } });
        } finally { competing = false; }
      }
      return batch<T>(list);
    });
    const listed = await listFiles(h.dc, h.site, h.target.id);
    expect(reads, "the deterministic read interleaving must execute once").toBe(1);
    expect(listed.version).toMatchObject({ id: h.target.id, status: "ready", fileCount: 3 });
    expect(listed.files).toHaveLength(3);
  });
});
