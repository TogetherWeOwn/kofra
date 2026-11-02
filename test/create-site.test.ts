import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { tooLarge, type UsageEvent } from "@kofra/core";
import { form, freshInstance, jsonBody, manifestEntry } from "./helpers";
import { connectMcp } from "./mcp-helpers";

/**
 * A create call that fails must leave nothing behind: no empty site, a free slug,
 * nothing counted against per-IP limits. (Live repro 2026-10-22: POST /api/v1/sites
 * with a bad manifest answered 400 yet kept the site, and a retry got 409 slug_taken.)
 */

const BAD_SHA = "b".repeat(64);

async function siteCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sites").first<{ n: number }>();
  return row?.n ?? 0;
}

describe("POST /api/v1/sites with files: no orphan site on failure", () => {
  it("an invalid path is refused before the site exists, and the slug stays free", async () => {
    const dw = await freshInstance();
    const before = await siteCount();
    const bad = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "orphan-probe", files: [{ path: "../x.html", size: 5, sha256: BAD_SHA }] }) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_path");
    expect(await siteCount()).toBe(before);
    expect((await dw.json("/api/v1/sites/orphan-probe", { key: dw.ownerKey })).status).toBe(404);

    const good = await manifestEntry("index.html", "hello");
    const retry = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "orphan-probe", files: [{ path: good.path, size: good.size, sha256: good.sha256 }] }) });
    expect(retry.status).toBe(201);
    expect(retry.body.site.slug).toBe("orphan-probe");
    expect(retry.body.deploy.missing).toEqual([good.sha256]);
  });

  it("an oversized entry (413) leaves no site", async () => {
    const dw = await freshInstance();
    const before = await siteCount();
    const big = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "too-big", files: [{ path: "a.bin", size: 50_000_000_000, sha256: BAD_SHA }] }) });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("file_too_large");
    expect(await siteCount()).toBe(before);
    const empty = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ files: [] }) });
    expect(empty.status).toBe(400);
    expect(await siteCount()).toBe(before);
  });

  it("a deploy refused by policy removes the new site again and meters it as deleted", async () => {
    const events: UsageEvent["type"][] = [];
    const dw = await freshInstance(
      {},
      {
        adapters: {
          policy: {
            limits: (_p, _o, d) => d.config.limits,
            beforeDeploy: () => {
              throw tooLarge("storage_full", "No room for this version.", "Free some space.");
            },
          },
          metering: { record: (e) => void events.push(e.type) },
        },
      },
    );
    const before = await siteCount();
    const f = await manifestEntry("index.html", "hello");
    const refused = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "refused-site", files: [{ path: f.path, size: f.size, sha256: f.sha256 }] }) });
    expect(refused.status).toBe(413);
    expect(refused.body.error.code).toBe("storage_full");
    expect(await siteCount()).toBe(before);
    expect(events).toEqual(["site_created", "site_deleted"]);
    // Creating the site without files still works (the policy only blocks deploys).
    expect((await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "refused-site" }) })).status).toBe(201);
  });

  it("one-shot publish to a new site that is refused leaves no site", async () => {
    const dw = await freshInstance(
      {},
      {
        adapters: {
          policy: {
            limits: (_p, _o, d) => d.config.limits,
            beforeDeploy: () => {
              throw tooLarge("storage_full", "No room for this version.");
            },
          },
        },
      },
    );
    const before = await siteCount();
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "x" }, { slug: "refused-publish" }) });
    expect(pub.status).toBe(413);
    expect(await siteCount()).toBe(before);
  });

  it("one-shot publish with a file over the per-file cap creates nothing", async () => {
    const dw = await freshInstance({ limits: { maxFileBytes: 10 } });
    const before = await siteCount();
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "more than ten bytes" }, { slug: "cap-site" }) });
    expect(pub.status).toBe(413);
    expect(pub.body.error.code).toBe("file_too_large");
    expect(await siteCount()).toBe(before);
  });

  it("MCP publish_site that is refused leaves no site", async () => {
    const dw = await freshInstance(
      {},
      {
        adapters: {
          policy: {
            limits: (_p, _o, d) => d.config.limits,
            beforeDeploy: () => {
              throw tooLarge("storage_full", "No room for this version.");
            },
          },
        },
      },
    );
    const before = await siteCount();
    const mcp = await connectMcp(dw, dw.ownerKey);
    const r = await mcp.call("publish_site", { site: "mcp-refused", files: [{ path: "index.html", content: "<h1>x</h1>" }] });
    expect(r.isError).toBe(true);
    expect(await siteCount()).toBe(before);
    await mcp.client.close();
  });

  it("anonymous: failed creates use none of the per-IP allowance and the next valid create works", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true, sitesPerHourPerIp: 2 } });
    const ip = { "CF-Connecting-IP": "203.0.113.77", "Content-Type": "application/json" };
    const bad = JSON.stringify({ files: [{ path: "../x.html", size: 5, sha256: BAD_SHA }] });
    for (let i = 0; i < 3; i++) {
      const r = await dw.json("/api/v1/sites", { method: "POST", headers: ip, body: bad });
      expect(r.status).toBe(400);
    }
    expect(await siteCount()).toBe(0);
    const f = await manifestEntry("index.html", "anon");
    const ok = await dw.json("/api/v1/sites", { method: "POST", headers: ip, body: JSON.stringify({ files: [{ path: f.path, size: f.size, sha256: f.sha256 }] }) });
    expect(ok.status).toBe(201);
    expect(ok.body.claimToken).toMatch(/^dwc_/);
    expect(ok.body.deploy.missing).toEqual([f.sha256]);
  });
});
