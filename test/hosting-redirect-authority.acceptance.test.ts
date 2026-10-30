/** Protected test-first contract: URL authorities are literals, not redirect capture templates. */
import type { ConfigOverrides } from "@dropway/core";
import { beforeAll, describe, expect, it } from "vitest";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

type Topology = { name: string; config: ConfigOverrides; root: (slug: string) => string };
const topologies: Topology[] = [
  { name: "shared path", config: {}, root: slug => `${ORIGIN}/s/${slug}/` },
  { name: "dedicated path", config: { sitesMode: "path", sitesOrigin: "https://authority-sites.example.test" }, root: slug => `https://authority-sites.example.test/${slug}/` },
  { name: "subdomain", config: { sitesMode: "subdomain", sitesDomain: "authority-sites.example.test" }, root: slug => `https://${slug}.authority-sites.example.test/` },
];
const slug = "redirect-authority-literals";
const methods = ["GET", "HEAD"] as const;
const modes = ["live", "owner preview", "signed preview"] as const;
type Mode = typeof modes[number];
const requests = modes.flatMap(mode => methods.map(method => ({ mode, method })));
const stored = "An invalid capture reference leaves this stored file readable.\n";
const self = "An encoded self target keeps its bytes.\n";
const query = "A query-changing redirect is suppressed after following once.\n";
const rules = [
  "/literal-db8 https://[2001:db8::1]/guide 302",
  "/literal-abcd http://[::abcd]/guide?fixed=yes 308",
  "/same-db8/:db8 https://[2001:db8::1]/:db8?chosen=:db8 307",
  "/same-abcd/:abcd https://[::abcd]/:abcd?chosen=:abcd 308",
  "/numeric/:name http://[::1]/:name?chosen=:name 302",
  "/external/:name https://docs.example.test/:name 307",
  "/bad-path/:name https://[::1]/:missing 302",
  "/bad-query/:name https://docs.example.test/guide?chosen=:missing 302",
  "/self/* /self/:splat 302",
  "/query /query?step=1 302",
  "",
].join("\n");
type Warning = { code: string; path?: string; line?: number; message: string; fix?: string };
type Fixture = { instance: Instance; live: string; preview: string; cookie: string; warnings: Warning[] };

function expectPrivate(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

async function fixture(topology: Topology): Promise<Fixture> {
  const instance = await freshInstance(topology.config);
  const published = await instance.json("/api/v1/publish", {
    method: "POST", key: instance.ownerKey, body: form({
      _redirects: rules,
      "bad-path/kept": stored,
      "bad-query/kept": stored,
      "self/a b.txt": self,
      query,
    }, { slug }),
  });
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  expect(published.body.version.number).toBe(1);
  expect(typeof published.body.versionUrl).toBe("string");
  const preview = topology.root(`${slug}--v1`);
  const link = new URL(published.body.versionUrl);
  expect(`${link.origin}${link.pathname}`).toBe(preview);
  expect(link.searchParams.has("dw_preview")).toBe(true);
  const redemption = await instance.call(link.href);
  expect([302, 303, 307]).toContain(redemption.status);
  expectPrivate(redemption);
  expect(new URL(redemption.headers.get("location")!, preview).href).toBe(preview);
  const cookie = redemption.headers.get("set-cookie");
  expect(cookie).toMatch(/;\s*Secure/i);
  expect(cookie).toMatch(/;\s*HttpOnly/i);
  expect(cookie).not.toMatch(/;\s*Domain=/i);
  expect(cookie).toContain(`Path=${new URL(preview).pathname}`);
  await redemption.arrayBuffer();
  return { instance, live: topology.root(slug), preview, cookie: cookie!.split(";")[0]!, warnings: published.body.warnings };
}

function root(f: Fixture, mode: Mode) {
  return mode === "live" ? f.live : f.preview;
}

async function read(f: Fixture, mode: Mode, method: string, path: string) {
  const url = new URL(path, root(f, mode)).href;
  const response = await f.instance.call(url, {
    method,
    ...(mode === "owner preview" ? { key: f.instance.ownerKey } : {}),
    ...(mode === "signed preview" ? { headers: { Cookie: f.cookie } } : {}),
  });
  const body = await response.text();
  return { response, body, url, diagnostic: `${method} ${mode} ${path}: HTTP ${response.status}, Location=${response.headers.get("location")}, body=${JSON.stringify(body)}` };
}

type Observed = Awaited<ReturnType<typeof read>>;
function expectRedirect(observed: Observed, mode: Mode, status: number, location: string) {
  expect(observed.response.status, observed.diagnostic).toBe(status);
  expect(observed.response.headers.get("location"), observed.diagnostic).toBe(location);
  expect(observed.body).toBe("");
  if (mode !== "live") expectPrivate(observed.response);
}

function expectStored(observed: Observed, mode: Mode, method: string, bytes: string) {
  expect(observed.response.status, observed.diagnostic).toBe(200);
  expect(observed.response.headers.get("location")).toBeNull();
  expect(observed.body).toBe(method === "HEAD" ? "" : bytes);
  if (mode !== "live") expectPrivate(observed.response);
}

describe.each(topologies)("literal redirect authorities: $name", topology => {
  let f: Fixture;
  beforeAll(async () => { f = await fixture(topology); });

  it("publishes alphabetic IPv6 authorities without treating their components as unknown captures", () => {
    const unexpected = f.warnings.filter(warning => warning.code === "invalid_hosting_rule" && ![7, 8].includes(warning.line!));
    expect(unexpected).toEqual([]);
  });

  it("still warns on genuinely unknown placeholders in the destination path and query", () => {
    const unknown = f.warnings.filter(warning => warning.path === "_redirects" && [7, 8].includes(warning.line!));
    expect(unknown.map(warning => warning.line)).toEqual([7, 8]);
    for (const warning of unknown) {
      expect(warning.code).toBe("invalid_hosting_rule");
      expect(warning.message).toContain(":missing");
      expect(warning.fix).toBeTruthy();
    }
  });

  it.each(requests)("$method $mode redirects to a literal documentation IPv6 address and inherits the query", async ({ method, mode }) => {
    expectRedirect(await read(f, mode, method, "literal-db8?keep=a%2Fb&repeat=1&repeat=2"), mode, 302,
      "https://[2001:db8::1]/guide?keep=a%2Fb&repeat=1&repeat=2");
  });

  it.each(requests)("$method $mode redirects to a compressed alphabetic IPv6 address with its explicit query", async ({ method, mode }) => {
    expectRedirect(await read(f, mode, method, "literal-abcd?ignored=1"), mode, 308,
      "http://[::abcd]/guide?fixed=yes");
  });

  it.each(requests)("$method $mode leaves db8 in the authority literal while substituting the same-named path and query capture", async ({ method, mode }) => {
    expectRedirect(await read(f, mode, method, "same-db8/beef?ignored=1"), mode, 307,
      "https://[2001:db8::1]/beef?chosen=beef");
  });

  it.each(requests)("$method $mode leaves abcd in the authority literal while substituting the same-named path and query capture", async ({ method, mode }) => {
    expectRedirect(await read(f, mode, method, "same-abcd/beef?ignored=1"), mode, 308,
      "https://[::abcd]/beef?chosen=beef");
  });

  it.each(requests)("$method $mode retains numeric IPv6 and ordinary path/query capture expansion", async ({ method, mode }) => {
    expectRedirect(await read(f, mode, method, "numeric/guide?ignored=1"), mode, 302,
      "http://[::1]/guide?chosen=guide");
  });

  it.each(requests)("$method $mode retains DNS external redirects and inherited encoded duplicate query parameters", async ({ method, mode }) => {
    expectRedirect(await read(f, mode, method, "external/guide?keep=a%2Fb&repeat=1&repeat=2"), mode, 307,
      "https://docs.example.test/guide?keep=a%2Fb&repeat=1&repeat=2");
  });

  for (const path of ["bad-path/kept", "bad-query/kept"]) {
    it.each(requests)(`$method $mode rejects the unknown capture in ${path} instead of redirecting`, async ({ method, mode }) => {
      expectStored(await read(f, mode, method, path), mode, method, stored);
    });
  }

  it.each(requests)("$method $mode still suppresses an encoded self target with inherited query", async ({ method, mode }) => {
    expectStored(await read(f, mode, method, "self/a%20b.txt?keep=1&keep=2"), mode, method, self);
  });

  it.each(requests)("$method $mode still follows a genuine query change once and suppresses its identical destination", async ({ method, mode }) => {
    const observed = await read(f, mode, method, "query?step=0");
    expect(observed.response.status, observed.diagnostic).toBe(302);
    const destination = `${root(f, mode)}query?step=1`;
    expect(new URL(observed.response.headers.get("location")!, observed.url).href).toBe(destination);
    if (mode !== "live") expectPrivate(observed.response);
    expect(observed.body).toBe("");
    expectStored(await read(f, mode, method, destination), mode, method, query);
  });

  it.each(methods)("%s does not disclose or execute a preview redirect before authorization", async method => {
    const response = await f.instance.call(`${f.preview}literal-db8`, { method });
    expect(response.status).toBe(404);
    expectPrivate(response);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.text();
    expect(body).not.toContain("2001:db8");
    if (method === "HEAD") expect(body).toBe("");
  });
});
