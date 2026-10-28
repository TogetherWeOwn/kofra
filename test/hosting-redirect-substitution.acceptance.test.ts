/** Protected test-first contract: invalid expanded destinations cannot interrupt site serving. */
import type { ConfigOverrides } from "@dropway/core";
import { beforeAll, describe, expect, it } from "vitest";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

type Topology = { name: string; config: ConfigOverrides; root: (slug: string) => string };
const topologies: Topology[] = [
  { name: "shared path", config: {}, root: slug => `${ORIGIN}/s/${slug}/` },
  { name: "dedicated path", config: { sitesMode: "path", sitesOrigin: "https://redirect-sites.example.test" }, root: slug => `https://redirect-sites.example.test/${slug}/` },
  { name: "subdomain", config: { sitesMode: "subdomain", sitesDomain: "redirect-sites.example.test" }, root: slug => `https://${slug}.redirect-sites.example.test/` },
];
const methods = ["GET", "HEAD"] as const;
const modes = ["live", "owner preview", "signed preview"] as const;
type Mode = typeof modes[number];
type Site = "later" | "fallback" | "controls";
const requests = modes.flatMap(mode => methods.map(method => ({ mode, method })));
const invalidExpansion = "/:a http://[::a]/ 302\n";
const stored = "Stored bytes survive an invalid expanded redirect.\n";
const target = "The later redirect reached its stored destination.\n";
const query = "A genuine query change redirects only once.\n";
const nested = "An unmatched nested file remains readable.\n";
const encoded = "An encoded self target serves the original bytes.\n";
const plain = "A plain self target serves the original bytes.\n";

type Published = { live: string; preview: string; cookie: string };
type Fixture = { instance: Instance; sites: Record<Site, Published> };

function expectPrivate(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

async function publish(instance: Instance, topology: Topology, site: Site, redirects: string, files: Record<string, string>): Promise<Published> {
  const slug = `redirect-expansion-${site}`;
  const result = await instance.json("/api/v1/publish", {
    method: "POST", key: instance.ownerKey, body: form({ ...files, _redirects: redirects }, { slug }),
  });
  expect(result.status).toBe(201);
  expect(result.body.version.number).toBe(1);
  expect(result.body.warnings.filter((warning: { code: string }) => warning.code === "invalid_hosting_rule")).toEqual([]);
  expect(typeof result.body.versionUrl).toBe("string");
  const preview = topology.root(`${slug}--v1`);
  const link = new URL(result.body.versionUrl);
  expect(link.origin).toBe(new URL(preview).origin);
  expect(link.pathname).toBe(new URL(preview).pathname);
  expect(link.searchParams.has("dw_preview")).toBe(true);
  const redemption = await instance.call(link.href);
  expect([302, 303, 307]).toContain(redemption.status);
  expectPrivate(redemption);
  expect(new URL(redemption.headers.get("location")!, preview).href).toBe(preview);
  const cookie = redemption.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  expect(cookie).toMatch(/;\s*Secure/i);
  expect(cookie).toMatch(/;\s*HttpOnly/i);
  expect(cookie).not.toMatch(/;\s*Domain=/i);
  expect(cookie).toContain(`Path=${new URL(preview).pathname}`);
  await redemption.arrayBuffer();
  return { live: topology.root(slug), preview, cookie: cookie!.split(";")[0]! };
}

async function fixture(topology: Topology): Promise<Fixture> {
  const instance = await freshInstance(topology.config);
  const later = await publish(instance, topology, "later", invalidExpansion + [
    "/hello /hello 302",
    "/hello /target.txt 307",
    "/outside https://docs.example.test/final 308",
    "/query /query?step=1 302",
    "",
  ].join("\n"), { hello: stored, "target.txt": target, query });
  const fallback = await publish(instance, topology, "fallback", invalidExpansion, {
    hello: stored, "nested/kept.txt": nested,
  });
  const controls = await publish(instance, topology, "controls", [
    "/literal http://[::1]/ 302",
    "/literal-https https://[2001:4860:4860::8888]/guide?fixed=yes 308",
    "/ipv6/:name http://[::1]/guide 307",
    "/external/:name https://docs.example.test/:name 308",
    "/self/* /self/:splat 302",
    "/plain /plain 302",
    "/query /query?step=1 302",
    "",
  ].join("\n"), { "self/a b.txt": encoded, plain, query });
  return { instance, sites: { later, fallback, controls } };
}

function root(f: Fixture, site: Site, mode: Mode) {
  return mode === "live" ? f.sites[site].live : f.sites[site].preview;
}

async function read(f: Fixture, site: Site, mode: Mode, method: string, path: string) {
  const url = new URL(path, root(f, site, mode)).href;
  const response = await f.instance.call(url, {
    method,
    ...(mode === "owner preview" ? { key: f.instance.ownerKey } : {}),
    ...(mode === "signed preview" ? { headers: { Cookie: f.sites[site].cookie } } : {}),
  });
  const body = await response.text();
  const diagnostic = `${method} ${mode} ${path} returned HTTP ${response.status}; body=${JSON.stringify(body)}`;
  return { response, body, diagnostic, url };
}

type Observed = Awaited<ReturnType<typeof read>>;
function expectStatus(observed: Observed, mode: Mode, status: number) {
  expect(observed.response.status, observed.diagnostic).toBe(status);
  if (mode !== "live") expectPrivate(observed.response);
}

function expectStored(observed: Observed, mode: Mode, method: string, bytes: string) {
  expectStatus(observed, mode, 200);
  expect(observed.response.headers.get("location")).toBeNull();
  expect(observed.body).toBe(method === "HEAD" ? "" : bytes);
}

function expectRedirect(observed: Observed, mode: Mode, status: number, location: string) {
  expectStatus(observed, mode, status);
  expect(observed.response.headers.get("location")).toBeTruthy();
  expect(new URL(observed.response.headers.get("location")!, observed.url).href).toBe(location);
  expect(observed.body).toBe("");
}

describe.each(topologies)("post-substitution redirect validity: $name", topology => {
  let f: Fixture;
  beforeAll(async () => { f = await fixture(topology); });

  describe("invalid expanded destinations", () => {
    it.each(requests)("$method $mode skips the invalid candidate and a self target before a later internal redirect", async ({ method, mode }) => {
      const response = await read(f, "later", mode, method, "hello?keep=a%2Fb&repeat=1&repeat=2");
      const destination = `${root(f, "later", mode)}target.txt?keep=a%2Fb&repeat=1&repeat=2`;
      expectRedirect(response, mode, 307, destination);
      expectStored(await read(f, "later", mode, method, destination), mode, method, target);
    });

    it.each(requests)("$method $mode continues to a later valid external redirect", async ({ method, mode }) => {
      const response = await read(f, "later", mode, method, "outside?keep=a%2Fb&repeat=1&repeat=2");
      expectRedirect(response, mode, 308, "https://docs.example.test/final?keep=a%2Fb&repeat=1&repeat=2");
    });

    it.each(requests)("$method $mode falls through to exact stored bytes without a later rule", async ({ method, mode }) => {
      expectStored(await read(f, "fallback", mode, method, "hello?keep=1"), mode, method, stored);
    });

    it.each(requests)("$method $mode falls through to an ordinary 404 without a stored file or later rule", async ({ method, mode }) => {
      const response = await read(f, "fallback", mode, method, "absent?keep=1");
      expectStatus(response, mode, 404);
      expect(response.response.headers.get("location")).toBeNull();
      if (method === "HEAD") expect(response.body).toBe("");
    });

    it.each(requests)("$method $mode preserves a later genuine query change and suppresses it after following", async ({ method, mode }) => {
      const response = await read(f, "later", mode, method, "query?step=0");
      const destination = `${root(f, "later", mode)}query?step=1`;
      expectRedirect(response, mode, 302, destination);
      expectStored(await read(f, "later", mode, method, destination), mode, method, query);
    });
  });

  describe("legitimate destinations and ordinary serving controls", () => {
    it.each(requests)("$method $mode retains a literal IPv6 destination and inherited encoded duplicate query", async ({ method, mode }) => {
      const response = await read(f, "controls", mode, method, "literal?keep=a%2Fb&repeat=1&repeat=2");
      expectRedirect(response, mode, 302, "http://[::1]/?keep=a%2Fb&repeat=1&repeat=2");
    });

    it.each(requests)("$method $mode retains a literal HTTPS IPv6 destination and its explicit query", async ({ method, mode }) => {
      const response = await read(f, "controls", mode, method, "literal-https?ignored=1");
      expectRedirect(response, mode, 308, "https://[2001:4860:4860::8888]/guide?fixed=yes");
    });

    it.each(requests)("$method $mode keeps IPv6 valid when the capture name is absent from the destination", async ({ method, mode }) => {
      const response = await read(f, "controls", mode, method, "ipv6/hello?keep=1");
      expectRedirect(response, mode, 307, "http://[::1]/guide?keep=1");
    });

    it.each(requests)("$method $mode substitutes a normal external destination without fetching it", async ({ method, mode }) => {
      const response = await read(f, "controls", mode, method, "external/guide?keep=a%2Fb&repeat=1&repeat=2");
      expectRedirect(response, mode, 308, "https://docs.example.test/guide?keep=a%2Fb&repeat=1&repeat=2");
    });

    it.each(requests)("$method $mode suppresses an encoded self target with inherited query", async ({ method, mode }) => {
      expectStored(await read(f, "controls", mode, method, "self/a%20b.txt?keep=1&keep=2"), mode, method, encoded);
    });

    it.each(requests)("$method $mode suppresses a plain self target", async ({ method, mode }) => {
      expectStored(await read(f, "controls", mode, method, "plain?keep=1"), mode, method, plain);
    });

    it.each(requests)("$method $mode redirects a genuine query change once", async ({ method, mode }) => {
      const response = await read(f, "controls", mode, method, "query?step=0");
      const destination = `${root(f, "controls", mode)}query?step=1`;
      expectRedirect(response, mode, 302, destination);
      expectStored(await read(f, "controls", mode, method, destination), mode, method, query);
    });

    it.each(requests)("$method $mode suppresses an already-identical explicit query", async ({ method, mode }) => {
      expectStored(await read(f, "controls", mode, method, "query?step=1"), mode, method, query);
    });

    it.each(requests)("$method $mode returns ordinary 404 for an unmatched controls path", async ({ method, mode }) => {
      const response = await read(f, "controls", mode, method, "absent?keep=1");
      expectStatus(response, mode, 404);
      expect(response.response.headers.get("location")).toBeNull();
      if (method === "HEAD") expect(response.body).toBe("");
    });

    it.each(requests)("$method $mode serves a nested file outside the invalid rule pattern", async ({ method, mode }) => {
      expectStored(await read(f, "fallback", mode, method, "nested/kept.txt"), mode, method, nested);
    });
  });

  describe("preview authorization precedes redirect evaluation", () => {
    for (const site of ["later", "fallback"] as const) {
      it.each(methods)(`%s refuses an unauthenticated ${site} preview without evaluating its invalid destination`, async method => {
        const response = await f.instance.call(`${f.sites[site].preview}hello`, { method });
        const body = await response.text();
        expect(response.status, `unauthenticated preview returned HTTP ${response.status}; body=${JSON.stringify(body)}`).toBe(404);
        expectPrivate(response);
        expect(response.headers.get("location")).toBeNull();
        expect(response.headers.get("set-cookie")).toBeNull();
        if (method === "HEAD") expect(body).toBe("");
      });
    }

    it.each(methods)("%s refuses a different site's preview cookie before evaluating the invalid destination", async method => {
      const response = await f.instance.call(`${f.sites.later.preview}hello`, {
        method, headers: { Cookie: f.sites.controls.cookie },
      });
      const body = await response.text();
      expect(response.status, `wrong-site preview cookie returned HTTP ${response.status}; body=${JSON.stringify(body)}`).toBe(404);
      expectPrivate(response);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      if (method === "HEAD") expect(body).toBe("");
    });
  });
});
