import { env } from "cloudflare:test";
import { clearLiveMemoryCache } from "@dropway/core";
import { beforeEach, describe, expect, it } from "vitest";
import { form, freshInstance, jsonBody, manifestEntry, type Instance } from "./helpers";

const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

let dw: Instance;
beforeEach(async () => { dw = await freshInstance(); });

const publish = (files: Record<string, string>, fields: Record<string, string> = {}, inst: Instance = dw) =>
  inst.json("/api/v1/publish", { method: "POST", key: inst.ownerKey, body: form(files, fields) });

const warningsOf = (body: any): Array<{ code: string; message: string }> => body.warnings ?? [];

/** Resolve the (possibly site-relative) Location of a redirect response. */
const destinationOf = (response: Response) => new URL(response.headers.get("location")!, "https://dropway.test").href;

async function pendingVersion(slug: string, files: Record<string, string>): Promise<string> {
  const site = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug }) });
  expect(site.status).toBe(201);
  const entries = await Promise.all(Object.entries(files).map(([path, content]) => manifestEntry(path, content)));
  const created = await dw.json(`/api/v1/sites/${slug}/versions`, {
    key: dw.ownerKey,
    ...jsonBody({ files: entries.map((e) => ({ path: e.path, sha256: e.sha256, size: e.size })) }),
  });
  expect(created.status).toBe(201);
  for (const entry of entries) {
    const upload = await dw.call(`/api/v1/blobs/${entry.sha256}`, {
      method: "PUT", key: dw.ownerKey, body: entry.bytes, headers: { "Content-Length": String(entry.size) },
    });
    expect(upload.status).toBe(201);
  }
  return created.body.version.id as string;
}

const finalize = (slug: string, id: string) =>
  dw.json(`/api/v1/sites/${slug}/versions/${id}/finalize`, { method: "POST", key: dw.ownerKey });

describe("redirects parsed at finalize (SRV-09)", () => {
  it("serves 301/302/307/308 redirects that stay on the site origin+prefix", async () => {
    const pub = await publish(
      {
        "index.html": "<p>home</p>",
        "new.html": "<p>new</p>",
        _redirects: "/old301 /new.html 301\n/old302 /new.html 302\n/old307 /new.html 307\n/old /new.html 308\n",
      },
      { slug: "redirect-status" },
    );
    expect(pub.status).toBe(201);
    expect(warningsOf(pub.body).filter((w) => w.code === "invalid_hosting_rule")).toEqual([]);

    for (const [from, status] of [["/old301", 301], ["/old302", 302], ["/old307", 307], ["/old", 308]] as const) {
      const response = await dw.call(`/s/redirect-status${from}`);
      expect(response.status).toBe(status);
      expect(destinationOf(response)).toBe("https://dropway.test/s/redirect-status/new.html");
    }
    // The destination itself is served, not redirected again.
    const target = await dw.call("/s/redirect-status/new.html");
    expect(target.status).toBe(200);
    expect(await target.text()).toBe("<p>new</p>");
  });

  it("supports whole-segment placeholders and one trailing splat, inheriting the query", async () => {
    const pub = await publish(
      {
        "archive/2024/hello.txt": "archived\n",
        _redirects: "/blog/:year/* /archive/:year/:splat 302\n",
      },
      { slug: "redirect-splat" },
    );
    expect(pub.status).toBe(201);

    const response = await dw.call("/s/redirect-splat/blog/2024/hello.txt?x=1");
    expect(response.status).toBe(302);
    expect(destinationOf(response)).toBe("https://dropway.test/s/redirect-splat/archive/2024/hello.txt?x=1");
    const stored = await dw.call("https://dropway.test/s/redirect-splat/archive/2024/hello.txt?x=1");
    expect(stored.status).toBe(200);
    expect(await stored.text()).toBe("archived\n");
  });

  it("skips self-looping rules and serves the stored file", async () => {
    const pub = await publish(
      { "index.html": "<p>home</p>", _redirects: "/* /index.html 302\n" },
      { slug: "redirect-self" },
    );
    expect(pub.status).toBe(201);
    // "/" is not the rule's own destination, so it redirects once to it ...
    const root = await dw.call("/s/redirect-self/");
    expect(root.status).toBe(302);
    expect(destinationOf(root)).toBe("https://dropway.test/s/redirect-self/index.html");
    // ... and the destination itself is served instead of looping.
    const home = await dw.call("/s/redirect-self/index.html");
    expect(home.status).toBe(200);
    expect(await home.text()).toBe("<p>home</p>");
  });

  it("turns invalid lines into warnings, not redirects (absolute https destinations stay valid)", async () => {
    const pub = await publish(
      {
        "index.html": "<p>home</p>",
        "new.html": "<p>new</p>",
        _redirects: "this is not a rule\n/frag /new.html#x 302\n/away https://example.test/elsewhere 302\n/ok /new.html 302\n",
      },
      { slug: "redirect-invalid" },
    );
    expect(pub.status).toBe(201);
    const invalid = warningsOf(pub.body).filter((w) => w.code === "invalid_hosting_rule");
    expect(invalid).toHaveLength(2);

    const frag = await dw.call("/s/redirect-invalid/frag");
    expect(frag.status).toBe(404);
    const away = await dw.call("/s/redirect-invalid/away");
    expect(away.status).toBe(302);
    expect(away.headers.get("location")).toBe("https://example.test/elsewhere");
    const ok = await dw.call("/s/redirect-invalid/ok");
    expect(ok.status).toBe(302);
    expect(destinationOf(ok)).toBe("https://dropway.test/s/redirect-invalid/new.html");
  });

  it("replayed finalizes return the stored warnings", async () => {
    const id = await pendingVersion("redirect-replay", {
      "index.html": "<p>home</p>",
      _redirects: "this is not a rule\n",
    });
    const first = await finalize("redirect-replay", id);
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);
    const codes = (first.body.warnings as Array<{ code: string }>).map((w) => w.code);
    expect(codes).toContain("invalid_hosting_rule");

    const second = await finalize("redirect-replay", id);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.warnings).toEqual(first.body.warnings);
  });

  it("restore and duplicate carry the parsed rules to the new live version", async () => {
    const first = await publish(
      { "index.html": "<p>v1</p>", "new.html": "<p>new</p>", _redirects: "/old /new.html 302\n" },
      { slug: "redirect-carry" },
    );
    expect(first.status).toBe(201);
    const v1 = first.body.version.id as string;

    const second = await publish({ "index.html": "<p>v2</p>" }, { slug: "redirect-carry" });
    expect(second.status).toBe(200);
    expect((await dw.call("/s/redirect-carry/old")).status).toBe(404);

    // Restore: flipping the pointer back to v1 brings its rules back too.
    const restored = await dw.json(`/api/v1/sites/redirect-carry/versions/${v1}/restore`, { method: "POST", key: dw.ownerKey });
    expect(restored.status).toBe(200);
    const back = await dw.call("/s/redirect-carry/old");
    expect(back.status).toBe(302);
    expect(destinationOf(back)).toBe("https://dropway.test/s/redirect-carry/new.html");

    // Duplicate: the copy's first version serves the same redirect.
    const copy = await dw.json("/api/v1/sites/redirect-carry/duplicate", {
      method: "POST", key: dw.ownerKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newSlug: "redirect-copy" }),
    });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    const copied = await dw.call("/s/redirect-copy/old");
    expect(copied.status).toBe(302);
    expect(destinationOf(copied)).toBe("https://dropway.test/s/redirect-copy/new.html");
  });
});

describe("headers parsed at finalize (SRV-09)", () => {
  it("applies matching _headers and rejects platform headers with a warning", async () => {
    const pub = await publish(
      {
        "index.html": "<p>home</p>",
        "new.html": "<p>new</p>",
        _redirects: "/old /new.html 302\n",
        _headers: "/new.html\n  X-Custom: yes\n  Set-Cookie: x=1\n/*\n  X-Site: yes\n",
      },
      { slug: "headers-apply" },
    );
    expect(pub.status).toBe(201);
    expect(warningsOf(pub.body).filter((w) => w.code === "invalid_hosting_rule")).toHaveLength(1);

    const file = await dw.call("/s/headers-apply/new.html");
    expect(file.status).toBe(200);
    expect(file.headers.get("x-custom")).toBe("yes");
    expect(file.headers.get("x-site")).toBe("yes");
    expect(file.headers.get("set-cookie")).toBeNull();

    // _headers match the request path, so a request-path rule travels on the
    // redirect response while the destination-only rule does not.
    const redirect = await dw.call("/s/headers-apply/old");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("x-site")).toBe("yes");
    expect(redirect.headers.get("x-custom")).toBeNull();
  });

  it("rejects oversized header values with a warning", async () => {
    const pub = await publish(
      {
        "index.html": "<p>home</p>",
        _headers: `/index.html\n  X-Big: ${"y".repeat(5000)}\n`,
      },
      { slug: "headers-big" },
    );
    expect(pub.status).toBe(201);
    expect(warningsOf(pub.body).filter((w) => w.code === "invalid_hosting_rule")).toHaveLength(1);
    expect((await dw.call("/s/headers-big/index.html")).headers.get("x-big")).toBeNull();
  });

  it("never serves _redirects/_headers and never lists them", async () => {
    const pub = await publish(
      {
        "alpha.txt": "first\n",
        "omega.txt": "last\n",
        _redirects: "/jump /alpha.txt 302\n",
        _headers: "/*\n  X-Site: yes\n",
      },
      { slug: "config-hidden" },
    );
    expect(pub.status).toBe(201);

    for (const name of ["_redirects", "_headers"]) {
      const direct = await dw.call(`/s/config-hidden/${name}`);
      expect(direct.status).toBe(404);
      await direct.arrayBuffer();
    }

    // Custom headers still apply even though the source file is hidden.
    const alpha = await dw.call("/s/config-hidden/alpha.txt", { headers: NAV });
    expect(alpha.status).toBe(200);
    expect(alpha.headers.get("x-site")).toBe("yes");

    // Root listing names the visible files only.
    const listing = await dw.call("/s/config-hidden/", { headers: NAV });
    expect(listing.status).toBe(200);
    const listingHtml = await listing.text();
    expect(listingHtml).toContain("alpha.txt");
    expect(listingHtml).not.toContain("_redirects");
    expect(listingHtml).not.toContain("_headers");

    // Prev/next navigation skips the hidden inputs.
    const html = await alpha.text();
    const nav = [...html.matchAll(/<a\s+([^>]*?)>/g)]
      .map((m) => m[1]!)
      .filter((attrs) => /rel="(prev|next)"/.test(attrs))
      .map((attrs) => ({ rel: /rel="(prev|next)"/.exec(attrs)![1], href: /href="([^"]+)"/.exec(attrs)![1] }));
    expect(nav).toEqual([{ rel: "next", href: "/s/config-hidden/omega.txt" }]);
  });

  it("applies matching _headers to folder listings", async () => {
    const pub = await publish(
      { "one.txt": "1\n", "two.txt": "2\n", _headers: "/*\n  X-Site: yes\n" },
      { slug: "headers-listing" },
    );
    expect(pub.status).toBe(201);

    const listing = await dw.call("/s/headers-listing/", { headers: NAV });
    expect(listing.status).toBe(200);
    expect(listing.headers.get("x-site")).toBe("yes");
    await listing.arrayBuffer();
  });

  it("an identical republish backfills rules for a pre-migration version", async () => {
    const files = {
      "index.html": "<p>home</p>",
      "new.html": "<p>new</p>",
      _redirects: "/old /new.html 302\n",
    };
    const first = await publish(files, { slug: "config-backfill" });
    expect(first.status).toBe(201);
    const id = first.body.version.id as string;

    // Simulate a version finalized before migration 0012: ready with hosting
    // files in its manifest but no parsed config. Drop every serving cache so
    // the next read rebuilds from D1.
    await env.DB.prepare("UPDATE versions SET config_json = NULL WHERE id = ?").bind(id).run();
    clearLiveMemoryCache();
    await env.CACHE.delete("live:config-backfill");
    await caches.default.delete(new Request("https://dropway.invalid/__dropway/ptr/config-backfill"));

    const stale = await dw.call("/s/config-backfill/old");
    expect(stale.status).toBe(404);
    await stale.arrayBuffer();

    // Republishing the identical files backfills the config in place: no new
    // version, and the redirect serves afterwards.
    const second = await publish(files, { slug: "config-backfill" });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.unchanged).toBe(true);

    const row = await env.DB.prepare("SELECT config_json FROM versions WHERE id = ?").bind(id)
      .first<{ config_json: string | null }>();
    expect(row?.config_json).toContain("/old");

    const back = await dw.call("/s/config-backfill/old");
    expect(back.status).toBe(302);
    expect(destinationOf(back)).toBe("https://dropway.test/s/config-backfill/new.html");
  });

  it("nested files named _redirects stay ordinary content", async () => {
    const pub = await publish(
      { "index.html": "<p>home</p>", "folder/_redirects": "nested bytes\n" },
      { slug: "config-nested" },
    );
    expect(pub.status).toBe(201);
    const nested = await dw.call("/s/config-nested/folder/_redirects");
    expect(nested.status).toBe(200);
    expect(new TextDecoder().decode(new Uint8Array(await nested.arrayBuffer()))).toBe("nested bytes\n");
  });
});
