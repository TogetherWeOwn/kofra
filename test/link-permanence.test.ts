import { beforeEach, describe, expect, it } from "vitest";
import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import {
  createTenantWithOwner,
  mintApiKey,
  resolveVersionAddress,
  runCleanup,
  type DropwayContext,
  type MemberPrincipal,
} from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import { SITES as TRANSFER_SITES, create as createTransfer, instance as transferInstance, op as transferOp } from "./transfer-fixtures";

const DAY = 24 * 3600_000;
const NAV = { Accept: "text/html,*/*;q=0.8", "Sec-Fetch-Dest": "document" };

async function publish(dw: Instance, slug: string | null, content = "hello", key?: string) {
  const fields: Record<string, string> = {};
  if (slug) fields.slug = slug;
  const res = await dw.json("/api/v1/publish", {
    method: "POST",
    ...(key === undefined ? { key: dw.ownerKey } : key === null ? {} : { key }),
    body: form({ "index.html": `<h1>${content}</h1>`, "docs/page.html": `<p>${content}</p>` }, fields),
  });
  expect([200, 201]).toContain(res.status);
  return res.body as { slug: string; url: string };
}

async function rename(dw: Instance, slug: string, newSlug: string, key?: string) {
  return dw.json(`/api/v1/sites/${slug}/rename`, {
    method: "POST",
    key: key ?? dw.ownerKey,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newSlug }),
  });
}

/** Run a function with a DropwayContext for an instance (for low-level tenant/key setup). */
async function asDc<T>(dw: Instance, fn: (dc: DropwayContext) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  try {
    return await fn(dw.dropway.context(env as unknown as ServerBindings, ctx));
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

/** A second tenant with its own owner key (cross-tenant tests). */
async function secondTenantKey(dw: Instance): Promise<string> {
  return asDc(dw, async (dc) => {
    const { tenant, owner } = await createTenantWithOwner(dc, { tenant: { name: "Other" }, owner: { email: "other@example.com" } });
    const k = await mintApiKey(dc, {
      tenantId: tenant.id,
      memberId: owner.id,
      scopes: ["sites:read", "sites:write", "sites:delete", "keys:write", "members:write", "data:write", "admin"],
    });
    return k.key;
  });
}

async function memberKeyWithoutAdmin(dw: Instance): Promise<string> {
  return asDc(dw, async (dc) => {
    const owner = (await dc.env.DB.prepare("SELECT * FROM members WHERE role = 'owner' LIMIT 1").first<{ id: string; tenant_id: string }>())!;
    const k = await mintApiKey(dc, { tenantId: owner.tenant_id, memberId: owner.id, scopes: ["sites:read", "sites:write", "sites:delete"] });
    return k.key;
  });
}

const tombstones = (slug: string) =>
  env.DB.prepare("SELECT * FROM slug_tombstones WHERE slug = ? ORDER BY created_at").bind(slug).all<Record<string, unknown>>();
const redirects = (slug: string) =>
  env.DB.prepare("SELECT * FROM slug_redirects WHERE slug = ?").bind(slug).all<Record<string, unknown>>();

describe("R-59 rename: old slug 308s to the new name (path mode)", () => {
  let dw: Instance;
  beforeEach(async () => {
    dw = await freshInstance();
    await publish(dw, "old-name");
  });

  it("rename_site returns oldSlug and redirectUntil ~12 months out", async () => {
    const before = Date.now();
    const res = await rename(dw, "old-name", "new-name");
    expect(res.status).toBe(200);
    expect(res.body.renamed).toBe(true);
    expect(res.body.oldSlug).toBe("old-name");
    expect(res.body.slug).toBe("new-name");
    expect(typeof res.body.redirectUntil).toBe("string");
    const until = Date.parse(res.body.redirectUntil);
    expect(until).toBeGreaterThanOrEqual(before + 365 * DAY - 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 365 * DAY + 60_000);
  });

  it("a no-op rename returns redirectUntil null", async () => {
    const res = await rename(dw, "old-name", "old-name");
    expect(res.status).toBe(200);
    expect(res.body.renamed).toBe(false);
    expect(res.body.redirectUntil).toBeNull();
  });

  it.each([
    ["/s/old-name/", `${ORIGIN}/s/new-name/`],
    ["/s/old-name/docs/page.html", `${ORIGIN}/s/new-name/docs/page.html`],
    ["/s/old-name/docs/page.html?x=1&y=two", `${ORIGIN}/s/new-name/docs/page.html?x=1&y=two`],
    ["/s/old-name/?raw=1", `${ORIGIN}/s/new-name/?raw=1`],
  ])("GET %s 308s to %s", async (path, location) => {
    await rename(dw, "old-name", "new-name");
    const res = await dw.call(path, { headers: NAV });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(location);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("redirects HEAD and POST too (308 preserves method)", async () => {
    await rename(dw, "old-name", "new-name");
    for (const method of ["HEAD", "POST"]) {
      const res = await dw.call("/s/old-name/docs/page.html?a=b", { method, headers: NAV });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/s/new-name/docs/page.html?a=b`);
    }
  });

  it("a rename chain a->b->c redirects a and b to c", async () => {
    await publish(dw, "chain-a");
    await rename(dw, "chain-a", "chain-b");
    await rename(dw, "chain-b", "chain-c");
    for (const old of ["chain-a", "chain-b"]) {
      const res = await dw.call(`/s/${old}/docs/page.html?q=1`, { headers: NAV });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/s/chain-c/docs/page.html?q=1`);
    }
    expect(await (await dw.call("/s/chain-c/", { headers: NAV })).text()).toContain("hello");
  });

  it("renaming back to your own old name works and flips the redirect", async () => {
    await rename(dw, "old-name", "new-name");
    const back = await rename(dw, "new-name", "old-name");
    expect(back.status).toBe(200);
    expect(back.body.slug).toBe("old-name");
    const res = await dw.call("/s/new-name/", { headers: NAV });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/s/old-name/`);
    expect(await (await dw.call("/s/old-name/", { headers: NAV })).text()).toContain("hello");
  });

  it("another tenant cannot create or rename to a redirect-bound name", async () => {
    await rename(dw, "old-name", "new-name");
    const other = await secondTenantKey(dw);
    const create = await dw.json("/api/v1/sites", {
      method: "POST",
      key: other,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "old-name" }),
    });
    expect(create.status).toBe(409);
    expect(create.body.error.code).toBe("slug_reserved");
    expect(create.body.error.hint?.trim().length).toBeGreaterThan(0);
    await publish(dw, "other-site", "other", other);
    const hijack = await rename(dw, "other-site", "old-name", other);
    expect(hijack.status).toBe(409);
    expect(hijack.body.error.code).toBe("slug_reserved");
  });

  it("when the redirect hold ends the old URL 404s and the name is free", async () => {
    await rename(dw, "old-name", "new-name");
    await env.DB.prepare("UPDATE slug_redirects SET hold_until = 1 WHERE slug = ?").bind("old-name").run();
    const res = await dw.call("/s/old-name/", { headers: NAV });
    expect(res.status).toBe(404);
    const other = await secondTenantKey(dw);
    const create = await dw.json("/api/v1/sites", {
      method: "POST",
      key: other,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "old-name" }),
    });
    expect(create.status).toBe(201);
  });
});

describe("R-59 rename: 308 in subdomain mode", () => {
  const APP = "https://app.test";
  const site = (slug: string) => `https://${slug}.sites.test`;
  let dw: Instance;
  beforeEach(async () => {
    dw = await freshInstance({ appOrigin: APP, sitesMode: "subdomain", sitesDomain: "sites.test" });
    await publish(dw, "old-name");
  });

  it.each([
    ["/", "/"],
    ["/docs/page.html", "/docs/page.html"],
    ["/docs/page.html?x=1&y=two", "/docs/page.html?x=1&y=two"],
  ])("GET %s 308s with path and query kept", async (path, expected) => {
    await rename(dw, "old-name", "new-name");
    const res = await dw.call(`${site("old-name")}${path}`, { headers: NAV });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${site("new-name")}${expected}`);
  });

  it("a rename chain redirects every old host to the current one", async () => {
    await publish(dw, "chain-a");
    await rename(dw, "chain-a", "chain-b");
    await rename(dw, "chain-b", "chain-c");
    for (const old of ["chain-a", "chain-b"]) {
      const res = await dw.call(`${site(old)}/docs/page.html`, { headers: NAV });
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(`${site("chain-c")}/docs/page.html`);
    }
  });
});

describe("R-59 delete and expiry: freed names are tombstoned", () => {
  let dw: Instance;
  beforeEach(async () => {
    dw = await freshInstance();
  });

  it("chosen names are held ~12 months, generated names ~90 days", async () => {
    const before = Date.now();
    await publish(dw, "chosen-name");
    const generated = await publish(dw, null, "random");
    expect((await dw.call(`/api/v1/sites/${generated.slug}`, { key: dw.ownerKey })).status).toBe(200);
    for (const slug of ["chosen-name", generated.slug]) {
      const del = await dw.call(`/api/v1/sites/${slug}`, { method: "DELETE", key: dw.ownerKey });
      expect(del.status).toBe(200);
    }
    const chosen = (await tombstones("chosen-name")).results;
    expect(chosen).toHaveLength(1);
    expect(Number(chosen[0]!.hold_until)).toBeGreaterThanOrEqual(before + 365 * DAY - 60_000);
    const random = (await tombstones(generated.slug)).results;
    expect(random).toHaveLength(1);
    expect(Number(random[0]!.hold_until)).toBeGreaterThanOrEqual(before + 90 * DAY - 60_000);
    expect(Number(random[0]!.hold_until)).toBeLessThanOrEqual(Date.now() + 90 * DAY + 60_000);
  });

  it("another tenant gets 409 slug_reserved creating or renaming to a tombstoned name", async () => {
    await publish(dw, "held-name");
    expect((await dw.call("/api/v1/sites/held-name", { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    const other = await secondTenantKey(dw);
    const create = await dw.json("/api/v1/sites", {
      method: "POST",
      key: other,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "held-name" }),
    });
    expect(create.status).toBe(409);
    expect(create.body.error.code).toBe("slug_reserved");
    expect(create.body.error.hint).toMatch(/reclaim|held|another/i);
    await publish(dw, "other-site", "other", other);
    const hijack = await rename(dw, "other-site", "held-name", other);
    expect(hijack.status).toBe(409);
    expect(hijack.body.error.code).toBe("slug_reserved");
  });

  it("the same tenant may reclaim a tombstoned name by create or rename", async () => {
    await publish(dw, "reclaim-me");
    await publish(dw, "rename-source");
    expect((await dw.call("/api/v1/sites/reclaim-me", { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    const again = await dw.json("/api/v1/sites", {
      method: "POST",
      key: dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "reclaim-me" }),
    });
    expect(again.status).toBe(201);
    expect((await dw.call("/api/v1/sites/reclaim-me", { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    const moved = await rename(dw, "rename-source", "reclaim-me");
    expect(moved.status).toBe(200);
    expect(moved.body.slug).toBe("reclaim-me");
  });

  it("deleting a renamed site holds the old names too", async () => {
    await publish(dw, "first-name");
    await rename(dw, "first-name", "second-name");
    expect((await dw.call("/api/v1/sites/second-name", { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    expect((await tombstones("first-name")).results).toHaveLength(1);
    expect((await tombstones("second-name")).results).toHaveLength(1);
    expect((await redirects("first-name")).results).toHaveLength(0);
    const other = await secondTenantKey(dw);
    for (const slug of ["first-name", "second-name"]) {
      const create = await dw.json("/api/v1/sites", {
        method: "POST",
        key: other,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      expect(create.status).toBe(409);
      expect(create.body.error.code).toBe("slug_reserved");
    }
  });

  it("when the hold ends the name is free again", async () => {
    await publish(dw, "fades-away");
    expect((await dw.call("/api/v1/sites/fades-away", { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    await env.DB.prepare("UPDATE slug_tombstones SET hold_until = 1 WHERE slug = ?").bind("fades-away").run();
    const other = await secondTenantKey(dw);
    const create = await dw.json("/api/v1/sites", {
      method: "POST",
      key: other,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "fades-away" }),
    });
    expect(create.status).toBe(201);
  });

  it("expired anonymous sites are tombstoned on cleanup", async () => {
    const anon = await freshInstance({ anonymous: { enabled: true } });
    const pub = await anon.json("/api/v1/publish", { method: "POST", body: form({ "index.html": "anon" }) });
    expect(pub.status).toBe(201);
    const slug = (pub.body as { slug: string }).slug;
    await asDc(anon, (dc) => runCleanup(dc, Date.now() + 30 * DAY));
    const rows = (await tombstones(slug)).results;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.hold_until)).toBeGreaterThan(Date.now());
    const create = await anon.json("/api/v1/sites", {
      method: "POST",
      key: anon.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    expect(create.status).toBe(409);
    expect(create.body.error.code).toBe("slug_reserved");
  });
});

describe("R-59 operator release with a reason", () => {
  let dw: Instance;
  beforeEach(async () => {
    dw = await freshInstance();
    await publish(dw, "held-one");
    await rename(dw, "held-one", "held-two");
    expect((await dw.call("/api/v1/sites/held-two", { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
  });

  const release = (slug: string, body: Record<string, unknown>, key?: string) =>
    dw.json("/api/v1/slugs/release", {
      method: "POST",
      key: key ?? dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, ...body }),
    });

  it("an operator with a reason releases the hold at once, with an audit row", async () => {
    const res = await release("held-one", { reason: "Trademark dispute #42", confirm: "held-one" });
    expect(res.status).toBe(200);
    expect(res.body.released).toBe(true);
    const rows = (await tombstones("held-one")).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.released_at).not.toBeNull();
    expect(rows[0]!.release_reason).toBe("Trademark dispute #42");
    expect(rows[0]!.released_by).not.toBeNull();
    const other = await secondTenantKey(dw);
    const create = await dw.json("/api/v1/sites", {
      method: "POST",
      key: other,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "held-one" }),
    });
    expect(create.status).toBe(201);
  });

  it("releasing a rename redirect frees the old name and stops the 308", async () => {
    await publish(dw, "redirect-me");
    await rename(dw, "redirect-me", "redirect-target");
    const res = await release("redirect-me", { reason: "Owner request", confirm: "redirect-me" });
    expect(res.status).toBe(200);
    expect((await dw.call("/s/redirect-me/", { headers: NAV })).status).toBe(404);
    const other = await secondTenantKey(dw);
    const create = await dw.json("/api/v1/sites", {
      method: "POST",
      key: other,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "redirect-me" }),
    });
    expect(create.status).toBe(201);
  });

  it("refuses without admin scope, without a reason, and for names nobody holds", async () => {
    const member = await memberKeyWithoutAdmin(dw);
    const forbidden = await release("held-one", { reason: "x", confirm: "held-one" }, member);
    expect(forbidden.status).toBe(403);
    const noReason = await release("held-one", { confirm: "held-one" });
    expect(noReason.status).toBe(400);
    const mismatch = await release("held-one", { reason: "x", confirm: "other" });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe("confirm_mismatch");
    const unknown = await release("never-held-name", { reason: "x", confirm: "never-held-name" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("slug_not_held");
    const malformed = await release("!!", { reason: "x", confirm: "!!" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("invalid_slug");
  });
});

describe("R-59 deleted versions answer 410, never another site's bytes", () => {
  let dw: Instance;
  beforeEach(async () => {
    dw = await freshInstance();
    await publish(dw, "versioned-site", "v1-content");
    await publish(dw, "versioned-site", "v2-content");
  });

  async function versionIds(slug: string): Promise<Array<{ id: string; number: number }>> {
    const res = await dw.json(`/api/v1/sites/${slug}/versions`, { key: dw.ownerKey });
    expect(res.status).toBe(200);
    return (res.body.versions as Array<{ id: string; number: number }>).sort((a, b) => a.number - b.number);
  }

  it("a deleted version's <slug>--v<N> answers 410 in path mode", async () => {
    const [v1] = await versionIds("versioned-site");
    const del = await dw.call(`/api/v1/sites/versioned-site/versions/${v1!.id}`, {
      method: "DELETE",
      key: dw.ownerKey,
    });
    expect(del.status).toBe(200);
    const gone = await dw.call("/s/versioned-site--v1/docs/page.html", { headers: NAV });
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toContain("v2-content");
  });

  it("live and never-existed versions do not 410", async () => {
    expect((await dw.call("/s/versioned-site--v2/", { headers: NAV })).status).toBe(404);
    expect((await dw.call("/s/versioned-site--v99/", { headers: NAV })).status).toBe(404);
    expect((await dw.call("/s/never-existed--v1/", { headers: NAV })).status).toBe(404);
  });

  it("after delete, the version addresses of a tombstoned name answer 410", async () => {
    expect((await dw.call("/api/v1/sites/versioned-site", { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    expect((await dw.call("/s/versioned-site--v2/", { headers: NAV })).status).toBe(410);
  });

  it("a renamed-away version address 308s to the new name", async () => {
    await rename(dw, "versioned-site", "renamed-site");
    const res = await dw.call("/s/versioned-site--v2/docs/page.html?q=1", { headers: NAV });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/s/renamed-site--v2/docs/page.html?q=1`);
  });

  it("after the hold ends and the name is reused, old version links never serve the new site's bytes", async () => {
    expect((await dw.call("/api/v1/sites/versioned-site", { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    await env.DB.prepare("UPDATE slug_tombstones SET hold_until = 1 WHERE slug = ?").bind("versioned-site").run();
    const other = await secondTenantKey(dw);
    await publish(dw, "versioned-site", "new-owner-bytes", other);
    for (const path of ["/s/versioned-site--v1/", "/s/versioned-site--v2/"]) {
      const res = await dw.call(path, { headers: NAV });
      expect([404, 410]).toContain(res.status);
      expect(await res.text()).not.toContain("new-owner-bytes");
    }
  });

  it("version addresses work from a separate sites origin", async () => {
    const APP = "https://app.test";
    const SITES = "https://sites.test";
    const split = await freshInstance({ appOrigin: APP, sitesOrigin: SITES });
    await publish(split, "split-site", "v1-content");
    await publish(split, "split-site", "v2-content");
    const list = await split.json("/api/v1/sites/split-site/versions", { key: split.ownerKey });
    const v1 = (list.body.versions as Array<{ id: string; number: number }>).find((v) => v.number === 1)!;
    const del = await split.call(`/api/v1/sites/split-site/versions/${v1.id}`, { method: "DELETE", key: split.ownerKey });
    expect(del.status).toBe(200);
    expect((await split.call(`${SITES}/split-site--v1/`, { headers: NAV })).status).toBe(410);
    expect((await split.call(`${SITES}/split-site--v2/`, { headers: NAV })).status).toBe(404);
    await rename(split, "split-site", "split-new");
    const moved = await split.call(`${SITES}/split-site--v2/docs/page.html?q=1`, { headers: NAV });
    expect(moved.status).toBe(308);
    expect(moved.headers.get("location")).toBe(`${SITES}/split-new--v2/docs/page.html?q=1`);
  });

  it("in subdomain mode the path-prefix form of a version address 301s to canonical", async () => {
    const sub = await freshInstance({ appOrigin: "https://app.test", sitesMode: "subdomain", sitesDomain: "sites.test" });
    await publish(sub, "versioned-site", "v1-content");
    const res = await sub.call("https://app.test/s/versioned-site--v1/docs/page.html?q=1", { headers: NAV });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://versioned-site--v1.sites.test/docs/page.html?q=1");
  });

  it("a deleted version's <slug>--v<N> answers 410 in subdomain mode", async () => {
    const sub = await freshInstance({ appOrigin: "https://app.test", sitesMode: "subdomain", sitesDomain: "sites.test" });
    await publish(sub, "versioned-site", "v1-content");
    await publish(sub, "versioned-site", "v2-content");
    const list = await sub.json("/api/v1/sites/versioned-site/versions", { key: sub.ownerKey });
    const v1 = (list.body.versions as Array<{ id: string; number: number }>).find((v) => v.number === 1)!;
    const del = await sub.call(`/api/v1/sites/versioned-site/versions/${v1.id}`, { method: "DELETE", key: sub.ownerKey });
    expect(del.status).toBe(200);
    const gone = await sub.call("https://versioned-site--v1.sites.test/docs/page.html", { headers: NAV });
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toContain("v2-content");
    expect((await sub.call("https://versioned-site--v2.sites.test/", { headers: NAV })).status).toBe(404);
  });
});

describe("R-59 operation parity", () => {
  let dw: Instance;
  beforeEach(async () => {
    dw = await freshInstance();
    await publish(dw, "parity-site");
  });

  it("rename_site over MCP returns oldSlug and redirectUntil", async () => {
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const res = await mcp.call("rename_site", { site: "parity-site", newSlug: "parity-new" });
      expect(res.isError).toBe(false);
      expect(res.data.oldSlug).toBe("parity-site");
      expect(typeof res.data.redirectUntil).toBe("string");
    } finally {
      await mcp.client.close();
    }
  });

  it("release_slug is a registered MCP tool and REST route", async () => {
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      expect((await mcp.tools()).map((t) => t.name)).toContain("release_slug");
    } finally {
      await mcp.client.close();
    }
    const openapi = await dw.json("/openapi.json");
    expect(openapi.status).toBe(200);
    expect(openapi.body.paths["/api/v1/slugs/release"]).toBeDefined();
    const llms = await dw.call("/llms-full.txt");
    expect(llms.status).toBe(200);
    expect(await llms.text()).toContain("slug_reserved");
  });
});

describe("R-59 review fixes", () => {
  it("pre-existing sites get the long (chosen) hold after upgrade", async () => {
    await reset();
    const before = env.TEST_MIGRATIONS.filter((m) => m.name < "0004_slug_holds.sql");
    expect(before.length).toBeGreaterThan(0);
    await applyD1Migrations(env.DB, before);
    const now = Date.now();
    await env.DB.prepare("INSERT INTO sites (id, slug, created_at, updated_at) VALUES ('site_legacy', 'legacy-name', ?, ?)").bind(now, now).run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name >= "0004_slug_holds.sql"));
    const row = await env.DB.prepare("SELECT slug_chosen FROM sites WHERE id = 'site_legacy'").first<{ slug_chosen: number }>();
    expect(row!.slug_chosen).toBe(1);
  });

  it("a never-existing middle version number is absent, a deleted one below live is gone", async () => {
    const dw = await freshInstance();
    await publish(dw, "gap-site", "v1-content");
    const site = (await env.DB.prepare("SELECT id FROM sites WHERE slug = 'gap-site'").first<{ id: string }>())!;
    // A version 3 that exists without a version 2 ever existing (abandoned upload numbering).
    await env.DB.prepare(
      "INSERT INTO versions (id, site_id, number, status, file_count, total_bytes, manifest_hash, source, created_at) VALUES ('ver_gap3', ?, 3, 'ready', 0, 0, 'gap', 'test', ?)",
    ).bind(site.id, Date.now()).run();
    await asDc(dw, async (dc) => {
      expect(await resolveVersionAddress(dc, "gap-site", 2)).toEqual({ kind: "absent" });
      expect(await resolveVersionAddress(dc, "gap-site", 3)).toEqual({ kind: "preview" });
    });
    await publish(dw, "gap-site", "v2-content");
    await env.DB.prepare("DELETE FROM version_files WHERE version_id IN (SELECT id FROM versions WHERE site_id = ? AND number = 1)").bind(site.id).run();
    await env.DB.prepare("DELETE FROM versions WHERE site_id = ? AND number = 1").bind(site.id).run();
    await asDc(dw, async (dc) => {
      expect(await resolveVersionAddress(dc, "gap-site", 1)).toEqual({ kind: "gone" });
    });
  });

  it("releasing an expired hold answers 404 slug_not_held", async () => {
    const dw = await freshInstance();
    await publish(dw, "stale-hold");
    expect((await dw.call("/api/v1/sites/stale-hold", { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
    await env.DB.prepare("UPDATE slug_tombstones SET hold_until = 1 WHERE slug = 'stale-hold'").run();
    const res = await dw.json("/api/v1/slugs/release", {
      method: "POST",
      key: dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "stale-hold", reason: "too late", confirm: "stale-hold" }),
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("slug_not_held");
  });

  it("a renamed transfer name does not 308 (permanent sender reservations win)", async () => {
    const dw = await transferInstance();
    const t = await createTransfer(dw, { slug: "parcel-old" });
    const renamed = await transferOp(dw, "rename_site", { site: t.slug, slug: "parcel-new" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.redirectUntil).toBeNull();
    expect((await redirects("parcel-old")).results).toHaveLength(0);
    expect((await dw.call(`${TRANSFER_SITES}/parcel-old/`, { headers: NAV })).status).not.toBe(308);
  });
});

describe("R-59 holds are configurable", () => {
  it("short rename holds come back in redirectUntil", async () => {
    const dw = await freshInstance({ slugHolds: { renameMs: 5000 } });
    await publish(dw, "short-hold");
    const before = Date.now();
    const res = await rename(dw, "short-hold", "short-target");
    expect(res.status).toBe(200);
    const until = Date.parse(res.body.redirectUntil);
    expect(until).toBeGreaterThanOrEqual(before + 4000);
    expect(until).toBeLessThanOrEqual(Date.now() + 6000);
  });
});

// Typecheck guard: the second-tenant helper must produce a usable member principal.
export type _PrincipalCheck = MemberPrincipal | null;
