/** Protected test-first contract: validators describe served metadata as well as stored bytes. */
import type { ConfigOverrides } from "@dropway/core";
import { beforeAll, describe, expect, it } from "vitest";
import { form, freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";

type Topology = { name: string; config: ConfigOverrides; root: (slug: string) => string };
const topologies: Topology[] = [
  { name: "shared path", config: {}, root: slug => `${ORIGIN}/s/${slug}/` },
  { name: "dedicated path", config: { sitesMode: "path", sitesOrigin: "https://validator-sites.example.test" }, root: slug => `https://validator-sites.example.test/${slug}/` },
  { name: "subdomain", config: { sitesMode: "subdomain", sitesDomain: "validator-sites.example.test" }, root: slug => `https://${slug}.validator-sites.example.test/` },
];
const changes = ["removed", "changed"] as const;
type Change = typeof changes[number];
const modes = ["live", "owner preview", "signed preview"] as const;
type Mode = typeof modes[number];
type Version = 1 | 2;
const methods = ["GET", "HEAD"] as const;
const requests = changes.flatMap(change => modes.flatMap(mode => methods.map(method => ({ change, mode, method }))));
const controls = changes.flatMap(change => modes.map(mode => ({ change, mode })));

type Resource = { name: string; path: string; kind: "raw" | "html" | "css"; bytes: string };
const resources: Resource[] = [
  { name: "raw bytes", path: "raw.txt", kind: "raw", bytes: "Identical stored bytes in both versions.\n" },
  { name: "HTML", path: "index.html", kind: "html", bytes: '<!doctype html><html><head><title>Validator fixture</title></head><body><a id="asset" href="/raw.txt">Read bytes</a></body></html>' },
  { name: "CSS", path: "style.css", kind: "css", bytes: "body{background:url(/image.png)}\n" },
];
const empty: Resource = { name: "empty raw bytes", path: "empty.txt", kind: "raw", bytes: "" };
const stable: Resource = { name: "unmatched bytes", path: "stable.txt", kind: "raw", bytes: "No hosting header rule matches this file.\n" };
type Snapshot = { etag: string };
type Preview = { root: string; cookie: string };
type Site = { slug: string; live: string; previews: Record<Version, Preview>; before: Record<Mode, Record<string, Snapshot>> };
type Fixture = { instance: Instance; sites: Record<Change, Site> };

function expectPrivate(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

function root(site: Site, mode: Mode, version: Version) {
  return mode === "live" ? site.live : site.previews[version].root;
}

async function read(f: Fixture, site: Site, mode: Mode, method: string, resource: Resource, headers: HeadersInit = {}, version: Version = 2) {
  const merged = new Headers(headers);
  if (mode === "signed preview") merged.set("Cookie", site.previews[version].cookie);
  const response = await f.instance.call(`${root(site, mode, version)}${resource.path}`, {
    method, headers: merged, ...(mode === "owner preview" ? { key: f.instance.ownerKey } : {}),
  });
  const body = await response.text();
  const diagnostic = `${method} ${mode} v${version} ${resource.path}: If-None-Match=${merged.get("if-none-match")}; HTTP ${response.status}, ETag=${response.headers.get("etag")}, Content-Language=${response.headers.get("content-language")}, X-Representation=${response.headers.get("x-representation")}, body=${JSON.stringify(body)}`;
  return { response, body, diagnostic };
}

type Observed = Awaited<ReturnType<typeof read>>;
function expectStatus(observed: Observed, mode: Mode, status: number) {
  expect(observed.response.status, observed.diagnostic).toBe(status);
  expect(observed.response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(observed.response.headers.get("set-cookie")).toBeNull();
  expect(observed.response.headers.get("location")).toBeNull();
  if (mode !== "live") expectPrivate(observed.response);
}

function expectMetadata(observed: Observed, change: Change, version: Version = 2) {
  expect(observed.response.headers.get("content-language"), observed.diagnostic).toBe(version === 1 ? "fr" : change === "changed" ? "en" : null);
  expect(observed.response.headers.get("x-representation"), observed.diagnostic).toBe(version === 1 ? "original" : change === "changed" ? "replacement" : null);
}

async function expectBody(observed: Observed, resource: Resource, method: string, base: string) {
  if (method === "HEAD") {
    expect(observed.body).toBe("");
  } else if (resource.kind === "html") {
    const hrefs: string[] = [];
    await new HTMLRewriter().on("a#asset", { element(element) { hrefs.push(element.getAttribute("href")!); } })
      .transform(new Response(observed.body)).text();
    expect(hrefs).toEqual([`${new URL(base).pathname}raw.txt`]);
    expect(observed.body).toContain("<title>Validator fixture</title>");
  } else if (resource.kind === "css") {
    expect(observed.body).toBe(`body{background:url(${new URL(base).pathname}image.png)}\n`);
  } else {
    expect(observed.body).toBe(resource.bytes);
  }
}

function headerFile(language: string, label: string) {
  return [...resources, empty].map(resource => `/${resource.path}\n  Content-Language: ${language}\n  X-Representation: ${label}\n`).join("");
}

async function publish(f: Fixture, topology: Topology, site: Site, change: Change, version: Version) {
  const files: Record<string, string> = Object.fromEntries([...resources, empty, stable].map(resource => [resource.path, resource.bytes]));
  if (version === 1 || change === "changed") files._headers = headerFile(version === 1 ? "fr" : "en", version === 1 ? "original" : "replacement");
  const published = await f.instance.json("/api/v1/publish", {
    method: "POST", key: f.instance.ownerKey, body: form(files, { slug: site.slug }),
  });
  expect(published.status, JSON.stringify(published.body)).toBe(version === 1 ? 201 : 200);
  expect(published.body.version.number).toBe(version);
  expect(published.body.warnings.filter((warning: { code: string }) => warning.code === "invalid_hosting_rule")).toEqual([]);
  const preview = topology.root(`${site.slug}--v${version}`);
  const link = new URL(published.body.versionUrl);
  expect(`${link.origin}${link.pathname}`).toBe(preview);
  expect(link.searchParams.has("dw_preview")).toBe(true);
  const redeemed = await f.instance.call(link.href);
  expect([302, 303, 307]).toContain(redeemed.status);
  expectPrivate(redeemed);
  expect(new URL(redeemed.headers.get("location")!, preview).href).toBe(preview);
  const cookie = redeemed.headers.get("set-cookie");
  expect(cookie).toMatch(/;\s*Secure/i);
  expect(cookie).toMatch(/;\s*HttpOnly/i);
  expect(cookie).not.toMatch(/;\s*Domain=/i);
  expect(cookie).toContain(`Path=${new URL(preview).pathname}`);
  await redeemed.arrayBuffer();
  site.previews[version] = { root: preview, cookie: cookie!.split(";")[0]! };
}

async function fixture(topology: Topology): Promise<Fixture> {
  const f: Fixture = { instance: await freshInstance(topology.config), sites: {} as Record<Change, Site> };
  for (const change of changes) {
    const slug = `header-validator-${change}`;
    const site: Site = { slug, live: topology.root(slug), previews: {} as Record<Version, Preview>, before: {} as Site["before"] };
    f.sites[change] = site;
    await publish(f, topology, site, change, 1);
    for (const mode of modes) {
      site.before[mode] = {};
      for (const resource of [...resources, empty]) {
        const observed = await read(f, site, mode, "GET", resource, {}, 1);
        expectStatus(observed, mode, 200);
        expectMetadata(observed, change, 1);
        await expectBody(observed, resource, "GET", root(site, mode, 1));
        const etag = observed.response.headers.get("etag");
        expect(etag).toBeTruthy();
        site.before[mode][resource.name] = { etag: etag! };
      }
    }
    await publish(f, topology, site, change, 2);
  }
  return f;
}

describe.each(topologies)("header-aware file validators: $name", topology => {
  let f: Fixture;
  beforeAll(async () => { f = await fixture(topology); });

  for (const resource of resources) {
    it.each(requests)(`$method $mode ${resource.name} replaces a v1 validator when headers are $change`, async ({ change, mode, method }) => {
      const site = f.sites[change];
      const old = site.before[mode][resource.name]!.etag;
      const observed = await read(f, site, mode, method, resource, { "If-None-Match": old });
      expectStatus(observed, mode, 200);
      expectMetadata(observed, change);
      expect(observed.response.headers.get("etag")).toBeTruthy();
      expect(observed.response.headers.get("etag")).not.toBe(old);
      await expectBody(observed, resource, method, root(site, mode, 2));
    });
  }

  if (topology.name === "shared path") {
    it.each(changes.flatMap(change => methods.map(method => ({ change, method }))))("$method live also invalidates the empty-file representation when headers are $change", async ({ change, method }) => {
      const site = f.sites[change];
      const old = site.before.live[empty.name]!.etag;
      const observed = await read(f, site, "live", method, empty, { "If-None-Match": old });
      expectStatus(observed, "live", 200);
      expectMetadata(observed, change);
      expect(observed.response.headers.get("etag")).toBeTruthy();
      expect(observed.response.headers.get("etag")).not.toBe(old);
      expect(observed.body).toBe("");
    });
  }

  it.each(controls)("$mode keeps current bytes, metadata, GET/HEAD validators and security after headers are $change", async ({ change, mode }) => {
    const site = f.sites[change];
    for (const resource of resources) {
      const current = await read(f, site, mode, "GET", resource);
      expectStatus(current, mode, 200);
      expectMetadata(current, change);
      await expectBody(current, resource, "GET", root(site, mode, 2));
      const etag = current.response.headers.get("etag");
      expect(etag).toBeTruthy();
      if (resource.kind === "html" && topology.name === "shared path") {
        expect(current.response.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
        expect(current.response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
      }
      for (const method of methods) {
        const headOrGet = await read(f, site, mode, method, resource);
        expectStatus(headOrGet, mode, 200);
        expectMetadata(headOrGet, change);
        expect(headOrGet.response.headers.get("etag")).toBe(etag);
        await expectBody(headOrGet, resource, method, root(site, mode, 2));
        const conditional = await read(f, site, mode, method, resource, { "If-None-Match": etag! });
        expectStatus(conditional, mode, 304);
        expectMetadata(conditional, change);
        expect(conditional.response.headers.get("etag")).toBe(etag);
        expect(conditional.body).toBe("");
      }
    }
  });

  it.each(controls.filter(test => test.mode !== "live"))("$mode keeps immutable v1 metadata and its validators after headers are $change in v2", async ({ change, mode }) => {
    const site = f.sites[change];
    for (const resource of resources) {
      const original = await read(f, site, mode, "GET", resource, {}, 1);
      expectStatus(original, mode, 200);
      expectMetadata(original, change, 1);
      await expectBody(original, resource, "GET", root(site, mode, 1));
      const etag = site.before[mode][resource.name]!.etag;
      expect(original.response.headers.get("etag")).toBe(etag);
      for (const method of methods) {
        const conditional = await read(f, site, mode, method, resource, { "If-None-Match": etag }, 1);
        expectStatus(conditional, mode, 304);
        expectMetadata(conditional, change, 1);
        expect(conditional.body).toBe("");
      }
    }
  });

  it.each(controls)("$mode does not leak matching-file metadata onto an unmatched file after headers are $change", async ({ change, mode }) => {
    const site = f.sites[change];
    const current = await read(f, site, mode, "GET", stable);
    expectStatus(current, mode, 200);
    expect(current.response.headers.get("content-language")).toBeNull();
    expect(current.response.headers.get("x-representation")).toBeNull();
    await expectBody(current, stable, "GET", root(site, mode, 2));
    const etag = current.response.headers.get("etag");
    expect(etag).toBeTruthy();
    for (const method of methods) {
      const conditional = await read(f, site, mode, method, stable, { "If-None-Match": etag! });
      expectStatus(conditional, mode, 304);
      expect(conditional.response.headers.get("content-language")).toBeNull();
      expect(conditional.response.headers.get("x-representation")).toBeNull();
      expect(conditional.body).toBe("");
    }
  });

  it.each(methods)("%s refuses missing or wrong-version preview authorization before conditional serving", async method => {
    const site = f.sites.removed;
    for (const cookie of ["", site.previews[1].cookie]) {
      const response = await f.instance.call(`${site.previews[2].root}raw.txt`, {
        method, headers: { Cookie: cookie, "If-None-Match": site.before.live["raw bytes"]!.etag },
      });
      expect(response.status).toBe(404);
      expectPrivate(response);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      const body = await response.text();
      expect(body).not.toContain(resources[0]!.bytes.trim());
      if (method === "HEAD") expect(body).toBe("");
    }
  });

  it("keeps the current password gate ahead of matching validators for live and authorized preview GET/HEAD", async () => {
    const site = f.sites.removed;
    const current = await read(f, site, "live", "GET", resources[0]!);
    expectStatus(current, "live", 200);
    const etag = current.response.headers.get("etag");
    expect(etag).toBeTruthy();
    const locked = await f.instance.json(`/api/v1/sites/${site.slug}/access`, {
      ...jsonBody({ mode: "password", password: "validator-fixture-password" }), method: "PUT", key: f.instance.ownerKey,
    });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    for (const mode of modes) {
      for (const method of methods) {
        const observed = await read(f, site, mode, method, resources[0]!, { "If-None-Match": etag! });
        expect(observed.response.status, observed.diagnostic).toBe(401);
        if (mode === "live") expect(observed.response.headers.get("cache-control")).toBe("no-store");
        else expectPrivate(observed.response);
        expect(observed.body).not.toContain(resources[0]!.bytes.trim());
        if (method === "HEAD") expect(observed.body).toBe("");
      }
    }
  });
});
