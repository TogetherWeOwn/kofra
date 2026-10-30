import { beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "@dropway/core";
import { mcpInstructions } from "@dropway/server";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

// The instance moved from ORIGIN (https://dropway.test, the legacy host) to NEW.
const NEW = "https://kofra.test";
const DEPRECATED_AT = Date.parse("2026-10-23T00:00:00Z") / 1000;
const BROWSER_NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance({ appOrigin: NEW, legacyAppOrigins: [ORIGIN], legacyDeprecatedAt: DEPRECATED_AT, instanceName: "Kofra" });
});

const expectDeprecated = (res: Response, successor: string) => {
  expect(res.headers.get("deprecation")).toBe(`@${DEPRECATED_AT}`);
  expect(res.headers.get("link")).toContain(`<${successor}>; rel="successor-version"`);
};

/**
 * fetch() in CORS mode as a browser runs it from a page on `pageOrigin` (Fetch standard): follows
 * redirects and applies the CORS check to every response, redirects included, sending
 * `Origin: null` once a redirect crossed origins. Throws TypeError, as the browser does, at the
 * first response that fails the check.
 */
async function corsFetch(url: string, pageOrigin: string, credentials: "omit" | "include" = "omit"): Promise<Response[]> {
  const hops: Response[] = [];
  let current = new URL(url);
  let tainted = false;
  for (let i = 0; i < 20; i++) {
    const origin = tainted ? "null" : pageOrigin;
    const res = await dw.call(current.href, { headers: { Origin: origin, "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" } });
    const allow = res.headers.get("access-control-allow-origin");
    const ok = credentials === "omit" ? allow === "*" || allow === origin : allow === origin && res.headers.get("access-control-allow-credentials") === "true";
    if (!ok) throw new TypeError(`Failed to fetch: CORS check failed at ${current.href} (${res.status})`);
    hops.push(res);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status > 399 || !location) return hops;
    const next = new URL(location, current);
    if (next.origin !== current.origin && pageOrigin !== current.origin) tainted = true;
    current = next;
  }
  throw new TypeError("Failed to fetch: too many redirects");
}

/**
 * One row per path family servedOnLegacyOrigin() keeps (legacy.ts), read with GET and HEAD on the
 * old host. Each must answer in place with the migration headers; dropping its exemption turns
 * the row red (the read would get an empty 308 without them).
 */
const SERVED_READS: Array<[path: string, status: number, withKey: boolean]> = [
  ["/api/v1/me", 200, true],
  ["/mcp", 401, false],
  ["/mcp/x", 401, false], // sub-paths, mounted with app.all("/mcp/*")
  ["/health", 200, false],
  ["/.well-known/agent-skills/index.json", 200, false],
  ["/.well-known/agent-skills/kofra/SKILL.md", 200, false],
  ["/llms.txt", 200, false],
  ["/llms-full.txt", 200, false],
  ["/openapi.json", 200, false],
  ["/skill.md", 200, false],
];

describe("config", () => {
  it("parses LEGACY_APP_ORIGINS and LEGACY_DEPRECATED_AT; needs APP_ORIGIN; drops the current origin", () => {
    const c = resolveConfig({
      APP_ORIGIN: "https://kofra.app",
      LEGACY_APP_ORIGINS: "https://dropway.5150.workers.dev/, https://kofra.app  not-a-url https://dropway.5150.workers.dev https://old.example/x",
      LEGACY_DEPRECATED_AT: "2026-10-23",
    });
    expect(c.legacyAppOrigins).toEqual(["https://dropway.5150.workers.dev", "https://old.example"]);
    expect(c.legacyDeprecatedAt).toBe(DEPRECATED_AT);
    expect(resolveConfig({ LEGACY_DEPRECATED_AT: "1792713600" }).legacyDeprecatedAt).toBe(1792713600);
    expect(resolveConfig({ LEGACY_APP_ORIGINS: "https://dropway.5150.workers.dev" }).legacyAppOrigins).toEqual([]);
    expect(resolveConfig({}).legacyDeprecatedAt).toBe(0);
  });
});

describe("legacy app origin: agents keep working, pages move", () => {
  it("serves the REST API with a key on the old host, with Deprecation and Link to the same URL on the new one", async () => {
    const pub = await dw.json("/api/v1/publish?x=1", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "<p>hi</p>" }) });
    expect(pub.status).toBe(201);
    expectDeprecated(pub.res, `${NEW}/api/v1/publish?x=1`);
    // URLs in responses use the new origin.
    expect(pub.body.url).toBe(`${NEW}/s/${pub.body.slug}/`);
    const me = await dw.json("/api/v1/me", { key: dw.ownerKey });
    expect(me.status).toBe(200);
    expectDeprecated(me.res, `${NEW}/api/v1/me`);
    expect(me.res.headers.get("access-control-expose-headers")).toMatch(/Deprecation, Link$/);
    // Errors carry the headers too, and are never redirected.
    const bad = await dw.call("/api/v1/sites", { key: "dw_wrong" });
    expect(bad.status).toBe(401);
    expectDeprecated(bad, `${NEW}/api/v1/sites`);
  });

  for (const method of ["GET", "HEAD"]) {
    it.each(SERVED_READS)(`answers ${method} %s in place on the old host (status %i), never redirected`, async (path, status, withKey) => {
      const res = await dw.call(path, { method, key: withKey ? dw.ownerKey : null, headers: { Accept: "*/*" } });
      expect(res.status).toBe(status);
      expect(res.headers.get("location")).toBeNull();
      expectDeprecated(res, `${NEW}${path}`);
      if (method === "GET") expect((await res.text()).length).toBeGreaterThan(0);
    });
  }

  it("serves MCP, /health and /.well-known/* without redirecting; their URLs point at the new origin", async () => {
    const mcp = await dw.call("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    expect(mcp.status).toBe(401);
    expectDeprecated(mcp, `${NEW}/mcp`);
    expect(((await mcp.json()) as any).error.hint).toContain(`${NEW}/mcp`);
    expect(mcp.headers.get("www-authenticate")).toContain('realm="Kofra"');

    const health = await dw.call("/health");
    expect(health.status).toBe(200);
    expectDeprecated(health, `${NEW}/health`);
    const head = await dw.call("/health", { method: "HEAD" });
    expect(head.status).toBe(200);

    const index = await dw.call("/.well-known/agent-skills/index.json");
    expect(index.status).toBe(200);
    expectDeprecated(index, `${NEW}/.well-known/agent-skills/index.json`);
    const skills = ((await index.json()) as any).skills;
    expect(skills[0].url).toBe(`${NEW}/.well-known/agent-skills/kofra/SKILL.md`);
    expect(skills[0].description).toContain("with Kofra");
  });

  it("serves the agent documents (llms.txt, llms-full.txt, openapi.json, skill.md) built from APP_ORIGIN and INSTANCE_NAME", async () => {
    const llms = await dw.call("/llms.txt");
    expect(llms.status).toBe(200);
    expectDeprecated(llms, `${NEW}/llms.txt`);
    const text = await llms.text();
    expect(text).toMatch(/^# Kofra\n/);
    expect(text).toContain(`${NEW}/mcp`);
    expect(text).not.toContain(ORIGIN);

    const full = await dw.call("/llms-full.txt");
    expect(full.status).toBe(200);
    expectDeprecated(full, `${NEW}/llms-full.txt`);
    const ref = await full.text();
    expect(ref).toMatch(/^# Kofra\n/);
    expect(ref).toContain("\n# Full reference\n");
    expect(ref).toContain("\n## REST operations\n");
    expect(ref).toContain("\n## MCP tools\n");
    expect(ref).toContain(`${NEW}/mcp`);
    expect(ref).toContain(`homepage: ${NEW}`);
    expect(ref).not.toContain(ORIGIN);

    const api = await dw.json("/openapi.json");
    expect(api.status).toBe(200);
    expectDeprecated(api.res, `${NEW}/openapi.json`);
    expect(api.body.servers[0].url).toContain(NEW);

    const skill = await dw.call("/skill.md");
    expect(skill.status).toBe(200);
    const md = await skill.text();
    expect(md).toContain("\n# Kofra\n\nKofra turns files into a live URL.");
    expect(md).toMatch(/^name: kofra$/m);
    expect(md).toContain(`homepage: ${NEW}`);
    expect(md).toContain(`claude mcp add --transport http kofra ${NEW}/mcp`);
    expect(md).not.toContain(ORIGIN);
  });

  it("308s GET/HEAD page requests to the new origin with path and query kept, uncached", async () => {
    for (const path of ["/", "/login", "/dashboard", "/dashboard/sites/abc?tab=files", "/v/some-site/docs/a.md?mode=source", "/claim?slug=x#t", "/s/some-site/x?y=1", "/favicon.ico"]) {
      const res = await dw.call(path, { headers: BROWSER_NAV });
      expect(res.status, path).toBe(308);
      expect(res.headers.get("location"), path).toBe(`${NEW}${path.replace(/#.*$/, "")}`);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("access-control-allow-origin"), path).toBe("*");
      expect(res.headers.get("access-control-allow-credentials"), path).toBeNull();
    }
    const head = await dw.call("/dashboard", { method: "HEAD" });
    expect(head.status).toBe(308);
    expect(head.headers.get("location")).toBe(`${NEW}/dashboard`);
  });

  it("keeps published files readable cross-origin at their old URLs: the 308 carries Access-Control-Allow-Origin: *, never credentials", async () => {
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "<p>hi</p>", "data.json": '{"n":1}' }) });
    expect(pub.status).toBe(201);
    const old = `${ORIGIN}/s/${pub.body.slug}/data.json?v=2`;
    // A page on another origin reads the file at its old URL; the browser follows the 308.
    const hops = await corsFetch(old, "https://reader.example");
    expect(hops.map((r) => r.status)).toEqual([308, 200]);
    const [moved, file] = hops as [Response, Response];
    expect(moved.headers.get("location")).toBe(`${NEW}/s/${pub.body.slug}/data.json?v=2`);
    expect(moved.headers.get("access-control-allow-credentials")).toBeNull();
    expect(await file.json()).toEqual({ n: 1 });
    // Credentialed reads stop at the redirect, as they did at the old file.
    await expect(corsFetch(old, "https://reader.example", "include")).rejects.toThrow(TypeError);
  });

  it("serves other methods in place (webhooks and form posts are never redirected)", async () => {
    const post = await dw.call("/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "secret=x" });
    expect(post.status).not.toBe(308);
    expectDeprecated(post, `${NEW}/login`);
    const preflight = await dw.call("/api/v1/publish", { method: "OPTIONS", headers: { Origin: "https://agent.example", "Access-Control-Request-Method": "POST" } });
    expect(preflight.status).toBeLessThan(300);
  });

  it("leaves the new origin and unknown hosts unchanged", async () => {
    const home = await dw.call(`${NEW}/`, { headers: BROWSER_NAV });
    expect(home.status).toBe(200);
    expect(home.headers.get("deprecation")).toBeNull();
    const me = await dw.call(`${NEW}/api/v1/me`, { key: dw.ownerKey });
    expect(me.status).toBe(200);
    expect(me.headers.get("deprecation")).toBeNull();
    expect(me.headers.get("link")).toBeNull();
    const other = await dw.call("https://unrelated.test/", { headers: BROWSER_NAV });
    expect(other.status).toBe(200);
    expect(other.headers.get("deprecation")).toBeNull();
  });

  it("omits Deprecation when LEGACY_DEPRECATED_AT is unset, but keeps the successor Link", async () => {
    const undated = await freshInstance({ appOrigin: NEW, legacyAppOrigins: [ORIGIN], instanceName: "Kofra" });
    const me = await undated.call("/api/v1/me", { key: undated.ownerKey });
    expect(me.status).toBe(200);
    expect(me.headers.get("deprecation")).toBeNull();
    expect(me.headers.get("link")).toContain(`<${NEW}/api/v1/me>; rel="successor-version"`);
  });

  it("does nothing without APP_ORIGIN", async () => {
    const plain = await freshInstance({ legacyAppOrigins: [ORIGIN] });
    expect(plain.dropway.context({} as never, { waitUntil() {} }).config.legacyAppOrigins).toEqual([]);
    const res = await plain.call("/", { headers: BROWSER_NAV });
    expect(res.status).toBe(200);
  });
});

describe("instance name", () => {
  it("names the product in page titles, the dashboard, MCP instructions and system pages", async () => {
    const home = await (await dw.call(`${NEW}/`, { headers: BROWSER_NAV })).text();
    expect(home).toContain("<title>Kofra</title>");
    expect(home).toContain('<a class="k-wm" href="/">Kofra</a>');
    const login = await (await dw.call(`${NEW}/login`, { headers: BROWSER_NAV })).text();
    expect(login).toContain("<title>Sign in · Kofra</title>");
    expect(login).toContain("Sign in to Kofra");
    const missing = await (await dw.call(`${NEW}/s/no-such-site/`, { headers: BROWSER_NAV })).text();
    expect(missing).toContain(`<a href="${NEW}">Kofra</a>`);
    const instructions = mcpInstructions({ config: resolveConfig({ INSTANCE_NAME: "Kofra", APP_ORIGIN: NEW }), requestUrl: null } as never);
    expect(instructions).toMatch(/^Kofra publishes files/);
    expect(instructions).toContain(`${NEW}/llms.txt`);
    expect(mcpInstructions({ config: resolveConfig({}), requestUrl: null } as never)).toMatch(/^Kofra publishes files/);
  });
});
