/** Protected test-first contract: compare the complete effective URL before suppressing a redirect. */
import type { ConfigOverrides } from "@dropway/core";
import { beforeEach, describe, expect, it } from "vitest";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

const slug = "hosting-redirect-url";
const topologies: { name: string; config: ConfigOverrides; base: string }[] = [
  { name: "shared path", config: {}, base: `${ORIGIN}/s/${slug}/` },
  { name: "dedicated path", config: { sitesMode: "path", sitesOrigin: "https://redirect-sites.example.test" }, base: `https://redirect-sites.example.test/${slug}/` },
  { name: "subdomain", config: { sitesMode: "subdomain", sitesDomain: "redirect-sites.example.test" }, base: `https://${slug}.redirect-sites.example.test/` },
];

async function publish(instance: Instance, files: Record<string, string>) {
  const result = await instance.json("/api/v1/publish", {
    method: "POST", key: instance.ownerKey, body: form(files, { slug }),
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  expect(result.body.warnings.filter((w: { code: string }) => w.code === "invalid_hosting_rule")).toEqual([]);
}

async function expectStored(response: Response, method: string, bytes: string) {
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode(method === "HEAD" ? "" : bytes));
}

describe.each(topologies)("redirect URL identity: $name", ({ config, base }) => {
  let instance: Instance;
  beforeEach(async () => { instance = await freshInstance(config); });

  // A decoded-path-only comparison mistakes each encoded self target for a new URL.
  it.each([
    { method: "GET", path: "a%20b.txt", file: "a b.txt" },
    { method: "HEAD", path: "a%20b.txt", file: "a b.txt" },
    { method: "GET", path: "100%25.txt", file: "100%.txt" },
    { method: "HEAD", path: "100%25.txt", file: "100%.txt" },
  ])("$method skips an encoded catch-all self target for $path, including its incoming query", async ({ method, path, file }) => {
    const bytes = "the requested stored file\n";
    await publish(instance, { [file]: bytes, _redirects: "/* /:splat 302\n" });
    await expectStored(await instance.call(`${base}${path}?q=one%20two&flag=1`, { method }), method, bytes);
  });

  it.each(["GET", "HEAD"])("%s skips a literal percent-encoded Unicode destination", async method => {
    const bytes = "unicode literal file\n";
    await publish(instance, { "café.html": bytes, _redirects: "/café.html /caf%C3%A9.html 302\n" });
    await expectStored(await instance.call(`${base}caf%C3%A9.html?lang=fr`, { method }), method, bytes);
  });

  it.each(["GET", "HEAD"])("%s continues to a later rule after an encoded catch-all self match", async method => {
    await publish(instance, {
      "a b.txt": "original\n", "done.txt": "later matching rule\n",
      _redirects: "/* /:splat 302\n/* /done.txt 307\n",
    });
    const response = await instance.call(`${base}a%20b.txt?keep=one%20two`, { method });
    expect(response.status).toBe(307);
    const destination = new URL(response.headers.get("location")!, base);
    expect(destination.href).toBe(`${base}done.txt?keep=one%20two`);
    await expectStored(await instance.call(destination.href, { method }), method, "later matching rule\n");
  });

  // A query is part of identity: this redirects once, but must not redirect again.
  it.each(["GET", "HEAD"])("%s redirects a genuine query change once and suppresses the followed self target", async method => {
    await publish(instance, { a: "query destination\n", _redirects: "/a /a?x=1 302\n" });
    const response = await instance.call(`${base}a?old=2`, { method });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!, base);
    expect(location.href).toBe(`${base}a?x=1`);
    await expectStored(await instance.call(location.href, { method }), method, "query destination\n");
  });

  it.each(["GET", "HEAD"])("%s suppresses a query-identical destination without a redundant redirect", async method => {
    await publish(instance, { a: "same query\n", _redirects: "/a /a?x=1 302\n" });
    await expectStored(await instance.call(`${base}a?x=1`, { method }), method, "same query\n");
  });

  it.each(["GET", "HEAD"])("%s preserves the original query when the destination supplies none, then skips plain self", async method => {
    await publish(instance, { a: "preserved query\n", _redirects: "/start /a 302\n/a /a 302\n" });
    const response = await instance.call(`${base}start?x=one%20two&x=3`, { method });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!, base);
    expect(location.href).toBe(`${base}a?x=one%20two&x=3`);
    await expectStored(await instance.call(location.href, { method }), method, "preserved query\n");
  });

  it.each(["GET", "HEAD"])("%s still serves a plain catch-all self match without redirecting", async method => {
    await publish(instance, { "plain.txt": "plain self\n", _redirects: "/* /:splat 302\n" });
    await expectStored(await instance.call(`${base}plain.txt`, { method }), method, "plain self\n");
  });

  it.each(["GET", "HEAD"])("%s preserves a deliberate external redirect", async method => {
    await publish(instance, { "index.html": "home\n", _redirects: "/out https://outside.example.test/there?x=1 302\n" });
    const response = await instance.call(`${base}out?old=2`, { method });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://outside.example.test/there?x=1");
    expect(await response.text()).toBe("");
  });

  it.each(["GET", "HEAD"])("%s keeps a slash-leading captured destination inside the same site's base", async method => {
    await publish(instance, { "index.html": "home\n", _redirects: "/escape/* /:splat 302\n" });
    const response = await instance.call(`${base}escape//outside.example.test/file?keep=1`, { method });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!, base);
    expect(location.origin).toBe(new URL(base).origin);
    expect(location.pathname.startsWith(new URL(base).pathname)).toBe(true);
    expect(location.search).toBe("?keep=1");
    expect(await response.text()).toBe("");
  });
});
