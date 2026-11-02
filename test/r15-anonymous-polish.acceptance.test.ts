import { describe, expect, it } from "vitest";
import { clearLiveMemoryCache, type ConfigOverrides } from "@kofra/core";
import { createKofra, type ServerBindings } from "@kofra/server";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { form, freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const HTML = '<!doctype html>\r\n<html><head><title>Anonymous café</title></head><body><p>Original bytes ✓</p></body></html>\r\n';
const MODES: { name: string; config: ConfigOverrides }[] = [
  { name: "app-origin paths", config: { appOrigin: ORIGIN } },
  { name: "dedicated-origin paths", config: { appOrigin: ORIGIN, sitesOrigin: "https://sites.example" } },
  { name: "subdomains", config: { appOrigin: ORIGIN, sitesMode: "subdomain", sitesDomain: "sites.test" } },
];

async function publish(dw: Instance, content: string, anonymous: boolean, slug?: string) {
  const result = await dw.json("/api/v1/publish", {
    method: "POST", key: anonymous ? null : dw.ownerKey,
    body: form({ "index.html": content }, slug ? { slug } : {}),
  });
  expect(result.status).toBe(201);
  expect(result.body.site.anonymous).toBe(anonymous);
  return result.body as { slug: string; url: string; claimToken?: string; version: { id: string } };
}

interface Link { text: string; href: string | null; target: string | null; onclick: string | null }

// Parse the served HTML in workerd instead of depending on the injected markup's spelling.
async function reportLinks(html: string): Promise<Link[]> {
  const links: Link[] = [];
  let current: Link | null = null;
  await new HTMLRewriter().on("a", {
    element(element) {
      current = { text: "", href: element.getAttribute("href"), target: element.getAttribute("target"), onclick: element.getAttribute("onclick") };
      links.push(current);
      element.onEndTag(() => { current = null; });
    },
    text(chunk) { if (current) current.text += chunk.text; },
  }).transform(new Response(html)).text();
  return links.filter((link) => link.text.replace(/\s+/g, " ").trim() === "Report abuse");
}

describe.each(MODES)("R-15 anonymous HTML: $name", ({ config, name }) => {
  it("adds one fixed, script-free report link to each served anonymous page", async () => {
    const dw = await freshInstance({ ...config, anonymous: { enabled: true } });
    const site = await publish(dw, HTML, true);
    for (const path of ["", "index.html"]) {
      const response = await dw.call(new URL(path, site.url).href, { headers: NAV });
      expect(response.status).toBe(200);
      const html = await response.text();
      const links = await reportLinks(html);
      expect(links).toHaveLength(1);
      const link = links[0]!;
      expect(link.href).toBeTruthy();
      expect(new URL(link.href!, site.url).protocol).toMatch(/^(https:|mailto:)$/);
      expect(link.onclick).toBeNull();
      expect([null, "_self", "_blank"]).toContain(link.target);
      // The input has no CSS: fixed positioning must come from the injected UI.
      expect(html).toMatch(/position\s*:\s*fixed\b/i);
      expect(html).toContain("Original bytes ✓");
      if (name !== "subdomains") {
        expect(response.headers.get("content-security-policy")).toContain("sandbox");
        expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
      }
    }
  });

  it("adds the report link even to HTML fragments without an explicit body element", async () => {
    const dw = await freshInstance({ ...config, anonymous: { enabled: true } });
    const site = await publish(dw, "<h1>Anonymous fragment</h1>", true);
    const response = await dw.call(site.url, { headers: NAV });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(await reportLinks(html)).toHaveLength(1);
    expect(html).toContain("Anonymous fragment");
  });

  it("does not rewrite raw HTML bytes, including UTF-8 and CRLF, or the stored file", async () => {
    const dw = await freshInstance({ ...config, anonymous: { enabled: true } });
    const site = await publish(dw, HTML, true);
    for (const path of ["?raw=1", "index.html?raw=1"]) {
      const raw = await dw.call(new URL(path, site.url).href, { headers: NAV });
      expect(raw.status).toBe(200);
      expect(raw.headers.get("content-type")).toContain("text/plain");
      expect(new Uint8Array(await raw.arrayBuffer())).toEqual(new TextEncoder().encode(HTML));
    }
    const stored = await dw.call(`/api/v1/sites/${site.slug}/files/index.html`, { key: site.claimToken });
    expect(stored.status).toBe(200);
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(new TextEncoder().encode(HTML));
  });

  it("does not inject an anonymous report link into an owned HTML site", async () => {
    const dw = await freshInstance({ ...config, anonymous: { enabled: true } });
    const site = await publish(dw, HTML, false);
    const response = await dw.call(site.url, { headers: NAV });
    expect(response.status).toBe(200);
    expect(await reportLinks(await response.text())).toEqual([]);
  });

  it("stops injecting the anonymous report link after the owner claims the site", async () => {
    const dw = await freshInstance({ ...config, anonymous: { enabled: true } });
    const site = await publish(dw, HTML, true);
    const claim = await dw.json(`/api/v1/sites/${site.slug}/claim`, {
      key: dw.ownerKey, ...jsonBody({ claimToken: site.claimToken }),
    });
    expect(claim.status).toBe(200);
    const response = await dw.call(site.url, { headers: NAV });
    expect(response.status).toBe(200);
    expect(await reportLinks(await response.text())).toEqual([]);
  });
});

it("R-15 report destination cannot be redirected by a publisher's base element", async () => {
  const dw = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test", sitesSandbox: true, anonymous: { enabled: true } });
  const content = HTML.replace("<head>", '<head><base href="https://attacker.example/">');
  const site = await publish(dw, content, true);
  const response = await dw.call(site.url, { headers: NAV });
  expect(response.status).toBe(200);
  const links = await reportLinks(await response.text());
  expect(links).toHaveLength(1);
  const href = links[0]!.href!;
  // An absolute destination survives both an opaque sandbox and an untrusted <base>.
  expect(href).toMatch(/^(https:\/\/|mailto:)/);
  expect(new URL(href).hostname).not.toBe("attacker.example");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
});

describe("R-15 generated and existing slugs", () => {
  it("uses six suffix characters when create_site generates a slug", async () => {
    const dw = await freshInstance();
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({}) });
    expect(created.status).toBe(201);
    expect(created.body.site.slug).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{6}$/);
  });

  it.each([false, true])("uses six suffix characters for one-call publish (anonymous=%s)", async (anonymous) => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const site = await publish(dw, HTML, anonymous);
    expect(site.slug).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{6}$/);
    const live = await dw.call(site.url, { headers: NAV });
    expect(live.status).toBe(200);
    expect(await live.text()).toContain("Original bytes ✓");
  });

  it.each(MODES)("preserves four-character legacy slugs across a new Worker and republish: $name", async ({ config }) => {
    const dw = await freshInstance(config);
    const legacy = await publish(dw, HTML, false, "bright-otter-x7k2");
    expect(legacy.slug).toBe("bright-otter-x7k2");
    clearLiveMemoryCache();
    const nextWorker = createKofra({ config });
    const ctx = createExecutionContext();
    const response = await nextWorker.fetch(new Request(legacy.url, { headers: NAV }), env as unknown as ServerBindings, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Original bytes ✓");
    const updated = await dw.json("/api/v1/publish?slug=bright-otter-x7k2", {
      method: "POST", key: dw.ownerKey, body: form({ "index.html": "<p>Legacy URL still works</p>" }),
    });
    expect(updated.status).toBe(200);
    expect(updated.body.slug).toBe("bright-otter-x7k2");
    expect(updated.body.url).toBe(legacy.url);
    const live = await dw.call(legacy.url, { headers: NAV });
    expect(live.status).toBe(200);
    expect(await live.text()).toContain("Legacy URL still works");
  });
});
