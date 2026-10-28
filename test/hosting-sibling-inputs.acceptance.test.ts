/** Protected test-first contract: private root hosting inputs are not navigable siblings. */
import type { ConfigOverrides } from "@dropway/core";
import { beforeAll, describe, expect, it } from "vitest";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const slug = "hosting-sibling-inputs";
const topologies: { name: string; config: ConfigOverrides; base: string }[] = [
  { name: "shared path", config: {}, base: `${ORIGIN}/s/${slug}/` },
  { name: "dedicated path", config: { sitesMode: "path", sitesOrigin: "https://sibling-sites.example.test" }, base: `https://sibling-sites.example.test/${slug}/` },
  { name: "subdomain", config: { sitesMode: "subdomain", sitesDomain: "sibling-sites.example.test" }, base: `https://${slug}.sibling-sites.example.test/` },
];
const files = {
  "omega.txt": "last visible file\n",
  _headers: "/*\n  X-Sibling-Check: yes\n",
  "folder/omega café 100%.txt": "last nested file\n",
  "alpha.txt": "first visible file\n",
  _redirects: "/jump /alpha.txt 302\n",
  "folder/_redirects": "ordinary nested redirects-named file\n",
  "folder/_headers": "ordinary nested headers-named file\n",
};

type Link = { href: string; rel: string; label: string };
async function links(html: string, selector = '.dw-vbar a[rel="prev"], .dw-vbar a[rel="next"]'): Promise<Link[]> {
  const found: Link[] = [];
  await new HTMLRewriter().on(selector, {
    element(element) {
      found.push({ href: element.getAttribute("href") ?? "", rel: element.getAttribute("rel") ?? "", label: element.getAttribute("aria-label") ?? "" });
    },
  }).transform(new Response(html)).text();
  return found;
}

async function view(instance: Instance, url: string) {
  const response = await instance.call(url, { headers: NAV });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-sibling-check")).toBe("yes");
  const html = await response.text();
  return { html, navigation: await links(html) };
}

function destinations(found: Link[], base: string) {
  return found.map(link => ({ rel: link.rel, href: new URL(link.href, base).href }));
}

describe.each(topologies)("hosting inputs in sibling navigation: $name", ({ config, base }) => {
  let instance: Instance;
  beforeAll(async () => {
    instance = await freshInstance(config);
    const result = await instance.json("/api/v1/publish", { method: "POST", key: instance.ownerKey, body: form(files, { slug }) });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.warnings.filter((warning: { code: string }) => warning.code === "invalid_hosting_rule")).toEqual([]);
  });

  it("the first visible root file has no Previous and its Next reaches the last file", async () => {
    const first = await view(instance, `${base}alpha.txt`);
    expect.soft(destinations(first.navigation, base)).toEqual([{ rel: "next", href: `${base}omega.txt` }]);
    const next = first.navigation.find(link => link.rel === "next");
    expect(next).toBeDefined();
    expect(next!.label).toContain("omega.txt");
    const followed = await view(instance, new URL(next!.href, base).href);
    expect(followed.html).toContain("last visible file");
    expect(destinations(followed.navigation, base)).toEqual([{ rel: "prev", href: `${base}alpha.txt` }]);
  });

  it("the last visible root file has no Next and its Previous reaches the first file", async () => {
    const last = await view(instance, `${base}omega.txt`);
    expect(destinations(last.navigation, base)).toEqual([{ rel: "prev", href: `${base}alpha.txt` }]);
    const previous = last.navigation[0]!;
    const followed = await view(instance, new URL(previous.href, base).href);
    expect(followed.html).toContain("first visible file");
  });

  it("neither root hosting input is linked anywhere in either rendered root file", async () => {
    for (const path of ["alpha.txt", "omega.txt"]) {
      const page = await view(instance, `${base}${path}`);
      const targets = (await links(page.html, "a[href]")).map(link => new URL(link.href, base).pathname);
      expect(targets).not.toContain(new URL(`${base}_headers`).pathname);
      expect(targets).not.toContain(new URL(`${base}_redirects`).pathname);
    }
  });

  it.each(["GET", "HEAD"])("%s keeps root hosting inputs private while the ordinary files remain live", async method => {
    for (const path of ["_headers", "_redirects"]) {
      const response = await instance.call(`${base}${path}?view=1`, { method, headers: NAV });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(files[path as "_headers" | "_redirects"].trim());
    }
    const response = await instance.call(`${base}alpha.txt`, { method });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(method === "HEAD" ? "" : files["alpha.txt"]);
  });

  it.each([
    { path: "folder/_headers", expected: [{ rel: "next", path: "folder/_redirects" }] },
    { path: "folder/_redirects", expected: [{ rel: "prev", path: "folder/_headers" }, { rel: "next", path: "folder/omega%20caf%C3%A9%20100%25.txt" }] },
    { path: "folder/omega%20caf%C3%A9%20100%25.txt", expected: [{ rel: "prev", path: "folder/_redirects" }] },
  ])("keeps the ordinary nested file $path in name-ordered, encoded sibling links", async ({ path, expected }) => {
    // Extensionless files normally download; explicitly request their binary viewer's bar.
    const page = await view(instance, `${base}${path}?view=1`);
    expect(destinations(page.navigation, base)).toEqual(expected.map(link => ({ rel: link.rel, href: `${base}${link.path}` })));
    for (const link of page.navigation) {
      const target = new URL(link.href, base);
      expect(target.search).toBe("");
      expect(target.origin).toBe(new URL(base).origin);
      const response = await instance.call(target.href);
      expect(response.status).toBe(200);
      const storedPath = decodeURIComponent(target.pathname.slice(new URL(base).pathname.length)) as keyof typeof files;
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode(files[storedPath]));
    }
  });
});
