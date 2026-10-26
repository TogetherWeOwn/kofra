import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { form, freshInstance, jsonBody, manifestEntry, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

const patchFiles = (key: string, slug: string, body: unknown, client = "test-agent") =>
  dw.json(`/api/v1/sites/${slug}/files`, {
    key,
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Kofra-Client": client },
    body: JSON.stringify(body),
  });

describe("versions naming: canonical /versions routes with /deploys aliases", () => {
  it("runs the manifest flow on /versions, resolves refs everywhere, and keeps /deploys working", async () => {
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "named" }) })).status).toBe(201);
    const a = await manifestEntry("index.html", "<h1>A</h1>");
    const b = await manifestEntry("about.html", "<h1>About</h1>");

    const created = await dw.json("/api/v1/sites/named/versions", {
      key: dw.ownerKey,
      ...jsonBody({ files: [a, b].map(({ bytes: _bytes, ...e }) => e) }),
    });
    expect(created.status).toBe(201);
    const pendingId = created.body.deploy.id as string;
    expect(created.body.deploy).toMatchObject({ number: 1, status: "pending" });
    expect(created.body.finalizeUrl).toBe(`https://dropway.test/api/v1/sites/named/versions/${pendingId}/finalize`);
    expect(created.body.missing.sort()).toEqual([a.sha256, b.sha256].sort());

    // get_version: every ref form resolves to the pending version, with counts
    // and fresh upload items (usable curl + a dwu_ token for this writer).
    for (const ref of ["v1", "1", pendingId]) {
      const got = await dw.json(`/api/v1/sites/named/versions/${ref}`, { key: dw.ownerKey });
      expect(got.status, ref).toBe(200);
      expect(got.body.version).toMatchObject({ id: pendingId, number: 1, status: "pending", live: false, fileCount: 2 });
      expect(got.body.missing.sort()).toEqual([a.sha256, b.sha256].sort());
      const items = got.body.upload?.items ?? got.body.uploads;
      expect(items, ref).toHaveLength(2);
      expect(items[0]).toMatchObject({ method: "PUT", size: expect.any(Number) });
      expect(items[0].url).toMatch(/\/api\/v1\/blobs\/[a-f0-9]{64}$/);
      expect(items[0].curl).toContain("curl");
      expect(items.map((i: any) => i.sha256).sort()).toEqual([a.sha256, b.sha256].sort());
      expect(items.flatMap((i: any) => i.paths ?? [i.path]).sort()).toEqual(["about.html", "index.html"]);
    }

    // The legacy status alias still answers.
    const legacy = await dw.json(`/api/v1/sites/named/deploys/${pendingId}`, { key: dw.ownerKey });
    expect(legacy.status).toBe(200);
    expect(legacy.body.deploy.id).toBe(pendingId);
    expect(legacy.body.missing.sort()).toEqual([a.sha256, b.sha256].sort());

    // Finalizing too early on the canonical route returns fresh upload items
    // in the error itself (no separate refresh call).
    const early = await dw.json(`/api/v1/sites/named/versions/${pendingId}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("missing_blobs");
    const errorItems = early.body.error.details.uploads ?? early.body.error.details.upload?.items;
    expect(errorItems.map((i: any) => i.sha256).sort()).toEqual([a.sha256, b.sha256].sort());
    expect(errorItems[0].curl).toContain("--data-binary");

    // Upload with only the fresh items' headers (dwu_ token, no API key).
    const bySha = new Map([a, b].map((e) => [e.sha256, e]));
    for (const item of errorItems) {
      const e = bySha.get(item.sha256)!;
      const up = await dw.call(item.url, {
        method: "PUT",
        body: e.bytes,
        headers: { ...item.headers, "Content-Length": String(e.size) },
      });
      expect(up.status, item.sha256).toBe(201);
    }

    // Finalize by version-number ref on the canonical route.
    const fin = await dw.json("/api/v1/sites/named/versions/v1/finalize", { method: "POST", key: dw.ownerKey });
    expect(fin.status).toBe(200);
    expect(fin.body.live).toBe(true);
    expect(await (await dw.call("/s/named/about.html")).text()).toBe("<h1>About</h1>");

    const live = await dw.json("/api/v1/sites/named/versions/live", { key: dw.ownerKey });
    expect(live.body.version).toMatchObject({ id: pendingId, status: "ready", live: true });
    expect(live.body.missing).toEqual([]);

    // The alias manifest flow still creates and finalizes a version.
    const c = await manifestEntry("index.html", "<h1>C</h1>");
    const aliasCreated = await dw.json("/api/v1/sites/named/deploys", {
      key: dw.ownerKey,
      ...jsonBody({ files: [{ path: c.path, size: c.size, sha256: c.sha256 }] }),
    });
    expect(aliasCreated.status).toBe(201);
    const up = await dw.json(`/api/v1/blobs/${c.sha256}`, { method: "PUT", key: dw.ownerKey, body: c.bytes, headers: { "Content-Length": String(c.size) } });
    expect(up.status).toBe(201);
    const aliasFin = await dw.json(`/api/v1/sites/named/deploys/${aliasCreated.body.deploy.id}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(aliasFin.status).toBe(200);
    expect(aliasFin.body.live).toBe(true);
    expect(await (await dw.call("/s/named/")).text()).toBe("<h1>C</h1>");

    // Restore and delete accept refs on the canonical routes too.
    const restored = await dw.json("/api/v1/sites/named/versions/1/restore", { method: "POST", key: dw.ownerKey });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ restored: true, version: { number: 1 } });
    expect(await (await dw.call("/s/named/")).text()).toBe("<h1>A</h1>");
    const deleted = await dw.json("/api/v1/sites/named/versions/v2", { method: "DELETE", key: dw.ownerKey });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
    expect((await dw.json("/api/v1/sites/named/versions/v2", { key: dw.ownerKey })).status).toBe(404);
  });

  it("finalizes via a site id in the slug segment and answers 200 with the live site", async () => {
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "by-site-id" }) })).status).toBe(201);
    const row = await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind("by-site-id").first<{ id: string }>();
    expect(row?.id).toMatch(/^site_/);
    const e = await manifestEntry("index.html", "<h1>by id</h1>");
    const created = await dw.json("/api/v1/sites/by-site-id/versions", {
      key: dw.ownerKey,
      ...jsonBody({ files: [{ path: e.path, size: e.size, sha256: e.sha256 }] }),
    });
    expect(created.status).toBe(201);
    const up = await dw.json(`/api/v1/blobs/${e.sha256}`, { method: "PUT", key: dw.ownerKey, body: e.bytes, headers: { "Content-Length": String(e.size) } });
    expect(up.status).toBe(201);
    const fin = await dw.json(`/api/v1/sites/${row!.id}/versions/${created.body.deploy.id}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(fin.status).toBe(200);
    expect(fin.body.live).toBe(true);
    expect(fin.body.site.slug).toBe("by-site-id");
    expect(await (await dw.call("/s/by-site-id/")).text()).toBe("<h1>by id</h1>");
  });

  it("reports the true total when more than 200 blobs are missing", async () => {
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "many-missing" }) })).status).toBe(201);
    const entries = await Promise.all(Array.from({ length: 201 }, (_, i) => manifestEntry(`f${i}.txt`, `file-${i}`)));
    const created = await dw.json("/api/v1/sites/many-missing/versions", {
      key: dw.ownerKey,
      ...jsonBody({ files: entries.map(({ bytes: _bytes, ...e }) => e) }),
    });
    expect(created.status).toBe(201);
    const fin = await dw.json(`/api/v1/sites/many-missing/versions/${created.body.deploy.id}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(fin.status).toBe(409);
    expect(fin.body.error.code).toBe("missing_blobs");
    expect(fin.body.error.details.missing).toHaveLength(200);
    expect(fin.body.error.details.totalMissing).toBe(201);
    expect(fin.body.error.message).toContain("201");
    expect(fin.body.error.message).toContain("(first 200 listed)");
  });

  it("gives MCP get_version the same fresh upload items for a pending version", async () => {
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const pending = await mcp.call("publish_site", {
        site: "mcp-pending",
        files: [{ path: "index.html", content: "hi" }, { path: "data.txt", sha256: "a".repeat(64), size: 3 }],
      });
      expect(pending.data.status).toBe("awaiting_upload");
      const got = await mcp.call("get_version", { site: "mcp-pending", version: pending.data.upload.versionId });
      expect(got.isError).toBe(false);
      expect(got.data.version).toMatchObject({ status: "pending", fileCount: 2 });
      expect(got.data.missing).toEqual(["a".repeat(64)]);
      const items = got.data.upload?.items ?? got.data.uploads;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ sha256: "a".repeat(64), method: "PUT" });
      expect(items[0].headers.Authorization).toMatch(/^Bearer dwu_/);
    } finally {
      await mcp.client.close();
    }
  });

  it("does not hand a dwu_ upload token to a read-only key through get_version", async () => {
    await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "readonly-pending" }) });
    const e = await manifestEntry("index.html", "pending");
    const created = await dw.json("/api/v1/sites/readonly-pending/versions", {
      key: dw.ownerKey,
      ...jsonBody({ files: [{ path: e.path, size: e.size, sha256: e.sha256 }] }),
    });
    expect(created.status).toBe(201);
    const reader = await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ name: "reader", scopes: ["sites:read"] }) });
    expect(reader.status).toBe(201);
    const got = await dw.json(`/api/v1/sites/readonly-pending/versions/${created.body.deploy.id}`, { key: reader.body.key });
    expect(got.status).toBe(200);
    expect(got.body.missing).toEqual([e.sha256]);
    expect(JSON.stringify(got.body)).not.toContain("dwu_");
  });

  it("answers a uniform, non-disclosing 404 for unknown or foreign version refs on finalize, restore and delete", async () => {
    await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "ref-owner" }) });
    const e = await manifestEntry("index.html", "x");
    const created = await dw.json("/api/v1/sites/ref-owner/versions", {
      key: dw.ownerKey,
      ...jsonBody({ files: [{ path: e.path, size: e.size, sha256: e.sha256 }] }),
    });
    const foreignId = created.body.deploy.id as string;
    await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "ref-target" }) });
    for (const ref of ["v999", "999", "ver_not_there", foreignId]) {
      for (const [method, suffix] of [["POST", "/finalize"], ["POST", "/restore"], ["DELETE", ""]] as const) {
        const res = await dw.json(`/api/v1/sites/ref-target/versions/${ref}${suffix}`, { method, key: dw.ownerKey });
        expect(res.status, `${method} ${ref}${suffix}`).toBe(404);
        expect(res.body.error.code, `${method} ${ref}${suffix}`).toBe("version_not_found");
      }
    }
  });

  it("gives a claim token (the site's only writer credential) fresh upload items", async () => {
    const anon = await freshInstance({ anonymous: { enabled: true } });
    const published = await anon.json("/api/v1/publish", {
      method: "POST", body: form({ "index.html": "hi" }),
    });
    expect(published.status).toBe(201);
    const claimToken = published.body.claimToken as string;
    const slug = published.body.slug as string;
    expect(claimToken).toMatch(/^dwc_/);
    const e = await manifestEntry("index.html", "next pending");
    const created = await anon.json(`/api/v1/sites/${slug}/versions`, {
      key: claimToken,
      ...jsonBody({ files: [{ path: e.path, size: e.size, sha256: e.sha256 }] }),
    });
    expect(created.status).toBe(201);
    const got = await anon.json(`/api/v1/sites/${slug}/versions/${created.body.deploy.id}`, { key: claimToken });
    expect(got.status).toBe(200);
    expect(got.body.upload.items[0].headers.Authorization).toMatch(/^Bearer dwu_/);
  });
});

describe("partial updates: two agents, conflict, rebase", () => {
  it("second agent gets version_conflict with next, rebases, and both changes are live", async () => {
    const first = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form(
        { "index.html": "<h1>home</h1>", "a.txt": "a1", "b.txt": "b1", "drafts/x.md": "x", "old.css": "body{}" },
        { slug: "shared" },
      ),
    });
    expect(first.status).toBe(201);
    const baseId = first.body.version.id as string;

    const keyA = (await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ name: "agent-a", scopes: ["sites:read", "sites:write"] }) })).body.key as string;
    const keyB = (await dw.json("/api/v1/keys", { key: dw.ownerKey, ...jsonBody({ name: "agent-b", scopes: ["sites:read", "sites:write"] }) })).body.key as string;

    // Agent A edits on the shared base: write, folder delete, move.
    const editA = await patchFiles(keyA, "shared", {
      baseVersionId: baseId,
      files: [{ path: "a.txt", content: "a2-by-a" }],
      delete: ["drafts/"],
      move: [{ from: "old.css", to: "style.css" }],
    }, "agent-a/1");
    expect(editA.status).toBe(200);
    expect(editA.body.status).toBe("live");
    expect(editA.body.version.number).toBe(2);
    expect(editA.body.changes.deleted).toEqual(["drafts/x.md"]);

    // Agent B tries the same stale base.
    const stale = await patchFiles(keyB, "shared", {
      baseVersionId: baseId,
      files: [{ path: "b.txt", content: "b2-by-b" }],
    }, "agent-b/1");
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect(stale.body.error.details.liveVersionId).toBe(editA.body.version.id);
    expect(stale.body.error.details.liveVersionNumber).toBe(2);
    expect(stale.body.error.next).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: "get_site", args: { site: "shared" } })]),
    );
    // B's stale write did not land.
    expect(await (await dw.call("/s/shared/b.txt")).text()).toBe("b1");

    // B rebases onto the live version named in the conflict and retries.
    const rebased = await patchFiles(keyB, "shared", {
      baseVersionId: stale.body.error.details.liveVersionId,
      files: [{ path: "b.txt", content: "b2-by-b" }],
    }, "agent-b/1");
    expect(rebased.status).toBe(200);
    expect(rebased.body.status).toBe("live");
    expect(rebased.body.version.number).toBe(3);

    // Both changes are live; untouched files carried over.
    expect(await (await dw.call("/s/shared/a.txt")).text()).toBe("a2-by-a");
    expect(await (await dw.call("/s/shared/b.txt")).text()).toBe("b2-by-b");
    expect(await (await dw.call("/s/shared/style.css")).text()).toBe("body{}");
    expect(await (await dw.call("/s/shared/")).text()).toContain("home");
    const files = await dw.json("/api/v1/sites/shared/files", { key: dw.ownerKey });
    expect(files.body.files.map((f: any) => f.path)).toEqual(["a.txt", "b.txt", "index.html", "style.css"]);
  });
});
