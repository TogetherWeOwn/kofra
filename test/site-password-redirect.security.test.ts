import { describe, expect, it } from "vitest";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

// After a correct site password the form 303s to its hidden `next` field, which the visitor
// (or a page linking to the form) controls. It must stay on the site's origin and under its base.
// Browsers strip tabs/newlines before resolving a Location and treat a backslash as a slash,
// so "/\host", "/<tab>/host" and normalized double-slashes ("/.//host", "/a/..//host") all
// leave the origin. Dot-segments can also escape a path-mode site base ("/s/a/../b").
const OFF_SITE = [
  "//attacker.test/",
  "/\\attacker.test/",
  "\\\\attacker.test/",
  "/\t/attacker.test/",
  "/\n/attacker.test/",
  "/\r/attacker.test/",
  "/\t\\attacker.test/",
  " //attacker.test/",
  "https://attacker.test/",
  "HTTPS://attacker.test/",
  "https:attacker.test",
  "//attacker.test@attacker.test/",
  "javascript:alert(1)",
  "%2F%2Fattacker.test/",
  "%2f%5cattacker.test/",
  "/.//attacker.test/x",
  "/a/..//attacker.test",
];

async function locked(dw: Instance, slug: string): Promise<void> {
  const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "private" }, { slug }) });
  expect(pub.status).toBe(201);
  const lock = await dw.json(`/api/v1/sites/${slug}/access`, {
    method: "PUT", key: dw.ownerKey, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "password", password: "secret1" }),
  });
  expect(lock.status).toBe(200);
}

function unlock(dw: Instance, url: string, next: string): Promise<Response> {
  return dw.call(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams({ password: "secret1", next }),
  });
}

describe.each([
  { name: "subdomain sites", config: { appOrigin: ORIGIN, sitesMode: "subdomain" as const, sitesDomain: "sites.test" }, site: "https://locked.sites.test", base: "/" },
  { name: "app-origin paths", config: { appOrigin: ORIGIN }, site: `${ORIGIN}/s/locked`, base: "/s/locked/" },
])("site password redirect: $name", ({ config, site, base }) => {
  it.each(OFF_SITE)("redirects to the site root instead of %j", async (next) => {
    const dw = await freshInstance(config);
    await locked(dw, "locked");
    const res = await unlock(dw, `${site}/__dropway/password`, next);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(base);
  });

  it("keeps a deep page on the same site, query and hash intact", async () => {
    const dw = await freshInstance(config);
    await locked(dw, "locked");
    const res = await unlock(dw, `${site}/__dropway/password`, `${base}docs/page.html?x=1#frag`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${base}docs/page.html?x=1#frag`);
  });

  it("keeps a literal backslash in the query or fragment", async () => {
    const dw = await freshInstance(config);
    await locked(dw, "locked");
    for (const next of [`${base}docs?search=C:\\notes`, `${base}docs#sec\\tion`]) {
      const res = await unlock(dw, `${site}/__dropway/password`, next);
      expect(res.status, next).toBe(303);
      expect(res.headers.get("location")).toBe(next);
    }
  });
});

it("site password redirect: app-origin paths do not reach another site through dot-segments", async () => {
  const dw = await freshInstance({ appOrigin: ORIGIN });
  await locked(dw, "locked");
  for (const next of ["/s/locked/../other/", "/s/locked/%2e%2e/other/"]) {
    const res = await unlock(dw, `${ORIGIN}/s/locked/__dropway/password`, next);
    expect(res.status, next).toBe(303);
    expect(res.headers.get("location")).toBe("/s/locked/");
  }
});
