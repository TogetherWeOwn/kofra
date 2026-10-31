import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  ApiError, clearLiveMemoryCache, createDeploy, defaultIdentity, deleteVersion, dropLive, getSiteFor, refreshLive,
  type PublishEvent, type UsageEvent, type VersionRow,
} from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";
import { effectSpies, isMutation, readsVersions, recordStatements, worldState } from "./interleave-harness";

/**
 * Independent regression for the exported `deleteVersion` service contract: fix
 * the implementation, not these assertions.
 *
 * The caller hands the service an incoming site row; the service reloads the site
 * by slug to re-authorize. If that slug now belongs to a different site the
 * principal can also access, the reload must not silently rebind the delete to
 * the replacement: the incoming immutable site id is the identity. This is a
 * service-level contract regression, not a public HTTP/MCP exploit: the adapters
 * resolve version membership before they call the service.
 * All state changes use real publishes/deploys; only the disposable identity and
 * lifecycle swap uses direct SQL, never fabricated rows or write results.
 */
const SLUG_A = "delete-binding-a";
const SLUG_B = "delete-binding-b";
const MOVED_AT = 1_700_000_000_444;

afterEach(() => {
  vi.restoreAllMocks();
  clearLiveMemoryCache();
});

async function publish(dw: Instance, slug: string, label: string, status = 201) {
  const r = await dw.json("/api/v1/publish", {
    key: dw.ownerKey,
    ...jsonBody({ slug, files: [
      { path: "index.html", content: `<h1>${label}</h1>`, contentType: "text/html" },
      { path: "unique.txt", content: `unique bytes of ${label}`, contentType: "text/plain" },
    ] }),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(status);
}

async function fixture() {
  const published: PublishEvent[] = [];
  const metered: UsageEvent[] = [];
  const deleted: unknown[] = [];
  const dw = await freshInstance({}, {
    hooks: [{ onPublish: (event) => { published.push(event); }, onDelete: (event) => { deleted.push(event); } }],
    adapters: { metering: { record: (event) => { metered.push(event); } } },
  });
  await publish(dw, SLUG_A, "A historical");
  await publish(dw, SLUG_A, "A live", 200);
  await publish(dw, SLUG_B, "B historical");
  await publish(dw, SLUG_B, "B live", 200);
  const ctx = createExecutionContext();
  const dc = dw.dropway.context(env as unknown as ServerBindings, ctx);
  const principal = await defaultIdentity.resolve(new Request(`${ORIGIN}/api/v1/me`, {
    headers: { Authorization: `Bearer ${dw.ownerKey}` },
  }), dc);
  if (principal.kind !== "member") throw new Error("Fixture owner did not resolve.");
  const load = (slug: string) => getSiteFor(dc, principal, slug, "sites:delete");
  const a = await load(SLUG_A);
  const b = await load(SLUG_B);
  expect(a.id).not.toBe(b.id);
  expect(a.tenant_id, "both sites belong to the one principal").toBe(b.tenant_id);
  const versionsOf = async (siteId: string) => (await env.DB.prepare("SELECT * FROM versions WHERE site_id = ? ORDER BY number")
    .bind(siteId).all<VersionRow>()).results;
  const [aOld, aLive] = await versionsOf(a.id);
  const [bOld, bLive] = await versionsOf(b.id);
  if (!aOld || !aLive || !bOld || !bLive) throw new Error("Fixture needs two ready versions per site.");
  expect(a.current_version_id).toBe(aLive.id);
  expect(b.current_version_id).toBe(bLive.id);
  const flush = () => waitOnExecutionContext(ctx);
  await flush();
  return { dw, dc, principal, a, b, aOld, aLive, bOld, bLive, published, metered, deleted, load, flush };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

const state = () => worldState([SLUG_A, SLUG_B, "delete-binding-retired", "delete-binding-renamed"]);

function observe(h: Harness) {
  return effectSpies(
    () => { h.published.length = 0; h.metered.length = 0; h.deleted.length = 0; },
    () => [h.published, h.metered, h.deleted],
  );
}

async function outcome<T>(promise: Promise<T>) {
  try { return { ok: true as const, value: await promise }; }
  catch (error: unknown) { return { ok: false as const, error }; }
}

function expectError(result: Awaited<ReturnType<typeof outcome>>, status: number, code: string) {
  expect.soft(result).toMatchObject({ ok: false, error: { status, code } });
  expect.soft(result.ok ? undefined : result.error).toBeInstanceOf(ApiError);
}

/** Site A's slug now resolves to site B, which the same principal may access. */
async function replaceAWithB(h: Harness, how: "retired" | "renamed") {
  const moveA = how === "retired"
    ? env.DB.prepare("UPDATE sites SET slug = ?, deleted_at = ?, updated_at = ? WHERE id = ?")
      .bind("delete-binding-retired", MOVED_AT, MOVED_AT, h.a.id)
    : env.DB.prepare("UPDATE sites SET slug = ?, updated_at = ? WHERE id = ?")
      .bind("delete-binding-renamed", MOVED_AT, h.a.id);
  await env.DB.batch([
    moveA,
    env.DB.prepare("UPDATE sites SET slug = ?, updated_at = ? WHERE id = ?").bind(SLUG_A, MOVED_AT, h.b.id),
  ]);
  await dropLive(h.dc, SLUG_A);
  await dropLive(h.dc, SLUG_B);
  await refreshLive(h.dc, h.b.id);
  if (how === "renamed") await refreshLive(h.dc, h.a.id);
  await h.flush();
  const reloaded = await h.load(SLUG_A);
  expect(reloaded, "B is reachable through A's old slug with the principal's normal authorization")
    .toMatchObject({ id: h.b.id, current_version_id: h.bLive.id });
  expect(await env.DB.prepare("SELECT id FROM versions WHERE id = ? AND site_id = ?").bind(h.bOld.id, h.b.id).first())
    .toEqual({ id: h.bOld.id });
}

describe("deleteVersion binds to the incoming site's immutable identity", () => {
  it.each(["retired", "renamed"] as const)(
    "refuses with site_not_found before any target lookup or write when the incoming site (%s) is replaced by another accessible site at its old slug",
    async (how) => {
      const h = await fixture();
      await replaceAWithB(h, how);
      const before = await state();
      const effects = observe(h);
      const statements = recordStatements();
      const batch = vi.spyOn(env.DB, "batch");
      // The caller still holds site A's row and names a version that belongs to B.
      const result = await outcome(deleteVersion(h.dc, h.principal, h.a, h.bOld.id));
      await h.flush();
      const wire = result.ok ? JSON.stringify(result.value) : JSON.stringify(result.error instanceof ApiError ? result.error.toJSON() : String(result.error));
      expectError(result, 404, "site_not_found");
      if (!result.ok && result.error instanceof ApiError) {
        expect.soft(result.error.message).toBe(`No site "${SLUG_A}" that this key can access.`);
      }
      expect.soft(wire, "no replacement identity or version in the refusal").not.toContain(h.b.id);
      expect.soft(wire).not.toContain(h.bOld.id);
      expect.soft(statements.filter(readsVersions), "identity mismatch refuses before any target lookup").toEqual([]);
      expect.soft(statements.filter(isMutation), "and before any write statement is even prepared").toEqual([]);
      expect.soft(batch.mock.calls.length, "no delete transaction is attempted").toBe(0);
      expect.soft(await state(), "A, B, manifests, usage, blobs and live caches are untouched").toEqual(before);
      effects.expectNoEffects();
    },
  );

  it("keeps the no-replacement foreign-version control: A's unchanged row cannot delete B's version", async () => {
    const h = await fixture();
    const before = await state();
    const effects = observe(h);
    const statements = recordStatements();
    const batch = vi.spyOn(env.DB, "batch");
    const result = await outcome(deleteVersion(h.dc, h.principal, h.a, h.bOld.id));
    await h.flush();
    expectError(result, 404, "version_not_found");
    expect.soft(statements.filter(isMutation)).toEqual([]);
    expect.soft(batch.mock.calls.length, "no delete transaction is attempted").toBe(0);
    expect.soft(await state()).toEqual(before);
    effects.expectNoEffects();
  });

  it("keeps normal same-identity deletion of the site's own non-live version, leaving the other site untouched", async () => {
    const h = await fixture();
    const before = await state();
    const effects = observe(h);
    expect(await deleteVersion(h.dc, h.principal, h.a, h.aOld.id)).toEqual({ deleted: true, id: h.aOld.id });
    await h.flush();
    const after = await state();
    expect(after.sites).toEqual(before.sites);
    expect(after.versions).toEqual(before.versions.filter((version) => version.id !== h.aOld.id));
    expect(after.files).toEqual(before.files.filter((file) => file.version_id !== h.aOld.id));
    expect(after.cache, "no live pointer or cache changes").toEqual(before.cache);
    expect(after.versions.filter((version) => version.site_id === h.b.id)).toEqual(before.versions.filter((version) => version.site_id === h.b.id));
    expect(await h.load(SLUG_A)).toMatchObject({ id: h.a.id, current_version_id: h.aLive.id });
    expect(await h.load(SLUG_B)).toMatchObject({ id: h.b.id, current_version_id: h.bLive.id });
    effects.expectNoEffects();
  });

  it("does not demand a fresh incoming row: unrelated updates to the same site keep the delete working", async () => {
    const h = await fixture();
    // The caller's row of site A predates a real publish that moved A's live pointer.
    await publish(h.dw, SLUG_A, "A newer live", 200);
    await h.flush();
    const fresh = await h.load(SLUG_A);
    expect(fresh.id).toBe(h.a.id);
    expect(fresh.current_version_id, "the incoming snapshot is stale in a non-identity field").not.toBe(h.a.current_version_id);
    const before = await state();
    const effects = observe(h);
    expect(await deleteVersion(h.dc, h.principal, h.a, h.aOld.id)).toEqual({ deleted: true, id: h.aOld.id });
    await h.flush();
    const after = await state();
    expect(after.versions).toEqual(before.versions.filter((version) => version.id !== h.aOld.id));
    expect(after.sites).toEqual(before.sites);
    effects.expectNoEffects();
  });

  it("keeps safe pending deletion, with a missing upload, on an unchanged site identity", async () => {
    const h = await fixture();
    const draft = await createDeploy(h.dc, h.principal, h.a, [await manifestEntry("draft.txt", "not uploaded yet", "text/plain")], {
      baseVersionId: h.aLive.id,
    });
    expect(draft.unchanged).toBe(false);
    expect(draft.missing.length).toBe(1);
    const pending = await env.DB.prepare("SELECT * FROM versions WHERE id = ?").bind(draft.version.id).first<VersionRow>();
    expect(pending).toMatchObject({ status: "pending", site_id: h.a.id });
    await h.flush();
    const before = await state();
    const effects = observe(h);
    expect(await deleteVersion(h.dc, h.principal, h.a, pending!.id)).toEqual({ deleted: true, id: pending!.id });
    await h.flush();
    const after = await state();
    expect(after.versions).toEqual(before.versions.filter((version) => version.id !== pending!.id));
    expect(after.files).toEqual(before.files.filter((file) => file.version_id !== pending!.id));
    expect(after.sites, "deleting a pending version never moves a live pointer").toEqual(before.sites);
    expect(after.cache).toEqual(before.cache);
    effects.expectNoEffects();
  });
});

