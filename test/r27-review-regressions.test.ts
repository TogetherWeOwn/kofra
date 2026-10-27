import { beforeEach, describe, expect, it } from "vitest";
import type { ConfigOverrides } from "@dropway/core";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

const JSON_HEADERS = { "Content-Type": "application/json" };
const BROWSER_NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const METHODS = ["GET", "HEAD"] as const;

interface Warning {
  code: string;
  message: string;
  path?: string;
  line?: number;
  fix?: string;
}

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

const publish = (files: Record<string, string>, fields: Record<string, string>, inst = dw) =>
  inst.json("/api/v1/publish", { method: "POST", key: inst.ownerKey, body: form(files, fields) });

const hostingWarnings = (body: { warnings?: Warning[] }): Warning[] =>
  (body.warnings ?? []).filter((warning) => warning.code === "invalid_hosting_rule");

const warningAt = (path: string, line: number) => expect.objectContaining({
  code: "invalid_hosting_rule",
  message: expect.stringMatching(/\S/),
  path,
  line,
  fix: expect.stringMatching(/\S/),
});

const WARNING_FILES = {
  "index.html": "<p>warning replay</p>",
  _redirects: "# A valid rule followed by an invalid rule\n/ok /index.html 302\nnot-a-rule\n",
};

describe("structured hosting-warning replay", () => {
  it("retains complete warning objects on a byte-identical REST republish", async () => {
    const first = await publish(WARNING_FILES, { slug: "warning-republish" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const initial = hostingWarnings(first.body);
    expect(initial).toEqual([warningAt("_redirects", 3)]);

    const replay = await publish(WARNING_FILES, { slug: "warning-republish" });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.unchanged).toBe(true);
    expect(replay.body.version.id).toBe(first.body.version.id);
    expect(hostingWarnings(replay.body)).toEqual(initial);
  });

  it("retains complete warning objects on repeated finalized-version finalize", async () => {
    const first = await publish(WARNING_FILES, { slug: "warning-finalize" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const initial = hostingWarnings(first.body);
    expect(initial).toEqual([warningAt("_redirects", 3)]);

    for (let attempt = 1; attempt <= 2; attempt++) {
      const replay = await dw.json(`/api/v1/sites/warning-finalize/deploys/${first.body.version.id}/finalize`, {
        method: "POST", key: dw.ownerKey,
      });
      expect(replay.status, `finalize ${attempt}: ${JSON.stringify(replay.body)}`).toBe(200);
      expect.soft(hostingWarnings(replay.body), `finalize ${attempt}`).toEqual(initial);
    }
  });
});

describe("header value length boundary", () => {
  it("emits a 4096-character custom header on GET and HEAD", async () => {
    const value = "a".repeat(4096);
    const pub = await publish({ "index.html": "<p>boundary</p>", _headers: `/*\n  X-Boundary: ${value}\n` }, { slug: "header-boundary" });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    expect(hostingWarnings(pub.body)).toEqual([]);

    for (const method of METHODS) {
      const res = await dw.call("/s/header-boundary/index.html", { method });
      expect.soft(res.status, method).toBe(200);
      expect.soft(res.headers.get("x-boundary"), method).toBe(value);
      if (method === "HEAD") expect(await res.text()).toBe("");
    }
  });

  it.each([4097, 5000])("rejects a %i-character custom header with a located warning and no GET/HEAD emission", async (length) => {
    const pub = await publish({
      "index.html": "<p>over limit</p>",
      _headers: `/*\n  X-Too-Long: ${"a".repeat(length)}\n  X-Allowed: still-here\n`,
    }, { slug: "header-over-limit" });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    expect.soft(hostingWarnings(pub.body)).toEqual([warningAt("_headers", 2)]);

    for (const method of METHODS) {
      const res = await dw.call("/s/header-over-limit/index.html", { method });
      expect.soft(res.status, method).toBe(200);
      expect.soft(res.headers.get("x-too-long"), method).toBeNull();
      expect.soft(res.headers.get("x-allowed"), method).toBe("still-here");
      if (method === "HEAD") expect(await res.text()).toBe("");
    }
  });
});

const REDIRECT_MODES: Array<{ name: string; config: ConfigOverrides; origin: string; base: string }> = [
  { name: "shared app path", config: {}, origin: ORIGIN, base: "/s/redirect-site/" },
  { name: "subdomain", config: { sitesMode: "subdomain", sitesDomain: "sites.test" }, origin: "https://redirect-site.sites.test", base: "/" },
];
const REDIRECT_FILES = {
  "index.html": "<p>redirect home</p>",
  _redirects: "/go* /:splat 302\n/outside https://example.com/ordinary 307\n",
};

describe.each(REDIRECT_MODES)("root-relative redirects ($name)", ({ config, origin, base }) => {
  it("keeps a slash-leading splat root-relative and on the site origin", async () => {
    const inst = await freshInstance(config);
    const pub = await publish(REDIRECT_FILES, { slug: "redirect-site" }, inst);
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    expect(hostingWarnings(pub.body)).toEqual([]);

    const requestUrl = `${origin}${base}go/evil.example`;
    const res = await inst.call(requestUrl);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect.soft(location).toMatch(/^\//);
    expect.soft(location).not.toMatch(/^\/\//);
    expect.soft(location.startsWith(base), "retains the site's path prefix").toBe(true);
    expect.soft(new URL(location, requestUrl).origin).toBe(origin);
  });

  it("retains ordinary root-relative substitution and its path-mode prefix", async () => {
    const inst = await freshInstance(config);
    const pub = await publish(REDIRECT_FILES, { slug: "redirect-site" }, inst);
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const res = await inst.call(`${origin}${base}goordinary`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${base}ordinary`);
  });

  it("preserves ordinary external absolute redirects", async () => {
    const inst = await freshInstance(config);
    const pub = await publish(REDIRECT_FILES, { slug: "redirect-site" }, inst);
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const res = await inst.call(`${origin}${base}outside`);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://example.com/ordinary");
  });
});

const SPA_HOME = "<p>SPA fallback must not answer robots.txt</p>";
const UPLOADED_ROBOTS = "# Keep these bytes verbatim\r\nUser-agent: *\r\nDisallow: /private/\r\n";
const ROBOTS_FILES = { "index.html": SPA_HOME, "landing.html": "<p>redirect target</p>", _redirects: "/* /landing.html 302\n" };
const ROBOTS_CASES: Array<{ name: string; noindex: boolean; files: Record<string, string>; status: number; body: string | null }> = [
  { name: "uploaded robots.txt", noindex: true, files: { "robots.txt": UPLOADED_ROBOTS }, status: 200, body: UPLOADED_ROBOTS },
  { name: "generated noindex robots.txt", noindex: true, files: {}, status: 200, body: "User-agent: *\nDisallow: /\n" },
  { name: "missing indexable robots.txt", noindex: false, files: {}, status: 404, body: null },
];

describe.each(ROBOTS_CASES)("robots.txt before catch-all redirects: $name", ({ noindex, files, status, body }) => {
  it.each(METHODS)("honors SRV-12 on %s even with SPA fallback enabled", async (method) => {
    const pub = await publish({ ...ROBOTS_FILES, ...files }, { slug: "robots-precedence", spa: "true" });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const settings = await dw.json("/api/v1/sites/robots-precedence", {
      method: "PATCH", key: dw.ownerKey, headers: JSON_HEADERS, body: JSON.stringify({ noindex, spa: true }),
    });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    expect(settings.body.site.settings).toMatchObject({ noindex, spa: true });

    const res = await dw.call("/s/robots-precedence/robots.txt", { method, headers: BROWSER_NAV });
    expect.soft(res.status).toBe(status);
    expect.soft(res.headers.get("location")).toBeNull();
    expect.soft(res.headers.get("x-kofra-viewer")).toBeNull();
    const text = await res.text();
    if (method === "HEAD") {
      expect.soft(text).toBe("");
    } else if (body !== null) {
      expect.soft(text).toBe(body);
    } else {
      expect.soft(text).not.toContain(SPA_HOME);
    }
    if (status === 200) expect.soft(res.headers.get("content-type") ?? "").toContain("text/plain");
  });
});

describe("robots precedence preserves other routing gates", () => {
  it.each(METHODS)("keeps the catch-all redirect on other paths for %s", async (method) => {
    const pub = await publish(ROBOTS_FILES, { slug: "robots-other-path", spa: "true" });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const res = await dw.call("/s/robots-other-path/ordinary-path", { method });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/s/robots-other-path/landing.html");
  });

  it.each(METHODS)("keeps the password gate ahead of robots.txt and redirects on %s", async (method) => {
    const pub = await publish({ ...ROBOTS_FILES, "robots.txt": UPLOADED_ROBOTS }, { slug: "robots-gated" });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const locked = await dw.json("/api/v1/sites/robots-gated/access", {
      method: "PUT", key: dw.ownerKey, headers: JSON_HEADERS,
      body: JSON.stringify({ mode: "password", password: "test-robots-password" }),
    });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);

    const res = await dw.call("/s/robots-gated/robots.txt", { method });
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control") ?? "").toContain("no-store");
    expect(await res.text()).not.toContain(UPLOADED_ROBOTS);
  });
});

const SHARED_ORIGINS: Array<{ name: string; config: ConfigOverrides; origin: string; base: string }> = [
  { name: "shared app origin", config: {}, origin: ORIGIN, base: "/s/origin-policies/" },
  { name: "shared sites origin", config: { sitesOrigin: "https://sites.test" }, origin: "https://sites.test", base: "/origin-policies/" },
];
const ORIGIN_HEADERS = [
  { name: "aCcEpT-cH", value: "Sec-CH-UA-Platform" },
  { name: "nEl", value: '{"report_to":"site","max_age":60}' },
  { name: "rEpOrT-tO", value: '{"group":"site","max_age":60,"endpoints":[{"url":"https://reports.example/collect"}]}' },
  { name: "rEpOrTiNg-EnDpOiNtS", value: 'site="https://reports.example/collect"' },
  { name: "sErViCe-WoRkEr-AlLoWeD", value: "/" },
];

describe.each(SHARED_ORIGINS)("origin-scoped _headers policies ($name)", ({ config, origin, base }) => {
  it.each(ORIGIN_HEADERS)("rejects mixed-case $name while allowing an ordinary custom header", async ({ name, value }) => {
    const inst = await freshInstance(config);
    const pub = await publish({
      "index.html": "<p>origin policy</p>",
      _headers: `/*\n  ${name}: ${value}\n  X-Site-Custom: allowed\n`,
    }, { slug: "origin-policies" }, inst);
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    expect.soft(hostingWarnings(pub.body)).toEqual([warningAt("_headers", 2)]);

    for (const method of METHODS) {
      const res = await inst.call(`${origin}${base}index.html`, { method });
      expect.soft(res.status, method).toBe(200);
      expect.soft(res.headers.get(name), `${method} ${name}`).toBeNull();
      expect.soft(res.headers.get("x-site-custom"), method).toBe("allowed");
      if (method === "HEAD") expect(await res.text()).toBe("");
    }
  });
});
