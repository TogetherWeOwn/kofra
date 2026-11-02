import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { ConfigOverrides } from "@kofra/core";
import { createKofra, type ServerBindings } from "@kofra/server";
import { BOOTSTRAP, freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";

const CLAIM_PATH = "/api/v1/sites/{slug}/claim";
const REST_HEADING = `### POST ${CLAIM_PATH}`;
const cases = [
  { mode: "default", config: {}, enabled: false },
  { mode: "anonymous disabled", config: { anonymous: { enabled: false } }, enabled: false },
  { mode: "anonymous enabled", config: { anonymous: { enabled: true } }, enabled: true },
];

function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  expect(start, `missing discovery section: ${heading}`).toBeGreaterThanOrEqual(0);
  const next = lines.findIndex((line, i) => i > start && /^#{1,3} /.test(line));
  return lines.slice(start + 1, next === -1 ? undefined : next).join("\n");
}

/** A new app over the same D1/R2/KV bindings: deliberately no reset, migration or setup. */
function withStoredData(previous: Instance, config: ConfigOverrides): Instance {
  const kofra = createKofra({ config });
  const call: Instance["call"] = async (path, init = {}) => {
    const { key, origin, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (key) headers.set("Authorization", `Bearer ${key}`);
    const url = path.startsWith("http") ? path : `${origin ?? ORIGIN}${path}`;
    const ctx = createExecutionContext();
    const res = await kofra.fetch(new Request(url, { ...rest, headers, redirect: "manual" }), env as unknown as ServerBindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  return {
    kofra,
    ownerKey: previous.ownerKey,
    call,
    async json(path, init) {
      const res = await call(path, init);
      return { status: res.status, body: await res.json() as any, res };
    },
  };
}

async function issuedSiteThenDisable(config: ConfigOverrides = {}) {
  const enabled = await freshInstance({ anonymous: { enabled: true } });
  const pub = await enabled.json("/api/v1/publish", jsonBody({ files: [{ path: "index.html", content: "issued before disabling anonymous creation" }] }));
  expect(pub.status).toBe(201);
  expect(pub.body.site.anonymous).toBe(true);
  expect(pub.body.claimToken).toMatch(/^dwc_/);
  expect(pub.body.expiresAt).toBeTruthy();
  return { enabled, disabled: withStoredData(enabled, config), pub: pub.body };
}

describe.each(cases)("claim discovery ($mode)", ({ config, enabled }) => {
  let dw: Instance;
  let tools: any[];
  beforeEach(async () => {
    dw = await freshInstance(config);
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      tools = await mcp.tools();
    } finally {
      await mcp.client.close();
    }
  });

  it("lists claim_site in the actual MCP endpoint only when anonymous publishing is enabled", () => {
    expect(tools.some((t) => t.name === "claim_site")).toBe(enabled);
    for (const name of ["whoami", "publish_site", "list_sites"]) expect(tools.map((t) => t.name)).toContain(name);
  });

  it("retains the REST claim operation but maps it only to an available MCP tool", async () => {
    const doc = await dw.json("/openapi.json");
    expect(doc.status).toBe(200);
    const op = doc.body.paths[CLAIM_PATH]?.post;
    expect(op).toBeTruthy();
    expect(op.operationId).toBe("claim_site");
    expect(op.requestBody.content["application/json"].schema.required).toContain("claimToken");
    if (enabled) {
      expect(op["x-mcp-tool"]).toBe("claim_site");
      expect(op["x-mcp-exclude"]).toBeUndefined();
      expect(tools.find((t) => t.name === op["x-mcp-tool"])).toBeTruthy();
    } else {
      expect.soft(op["x-mcp-tool"]).toBeUndefined();
      expect.soft(op["x-mcp-exclude"]).toEqual(expect.any(String));
      expect.soft(op["x-mcp-exclude"] ?? "").toMatch(/anonymous/i);
      expect.soft(op["x-mcp-exclude"] ?? "").toMatch(/disabled|not enabled|off|unavailable|requires|only|enable/i);
      expect.soft(tools.map((t) => t.name)).not.toContain(op["x-mcp-tool"]);
    }
  });

  it("keeps full REST discovery without promising an unavailable claim tool", async () => {
    const res = await dw.call("/llms-full.txt");
    expect(res.status).toBe(200);
    const text = await res.text();
    const rest = section(text, REST_HEADING);
    expect(rest).toContain("operationId `claim_site`");
    if (enabled) {
      const claim = tools.find((t) => t.name === "claim_site");
      expect(claim).toBeTruthy();
      expect(rest).toContain(`MCP tool: \`${claim.name}\``);
      const documented = section(text, "### claim_site");
      expect(claim.description.length).toBeGreaterThan(0);
      expect(documented).toContain(claim.description);
      const schema = /^Input schema: `([^\n]+)`/m.exec(documented);
      expect(schema, "claim input schema in full discovery").toBeTruthy();
      expect(JSON.parse(schema![1]!)).toEqual(claim.inputSchema);
      expect(claim.inputSchema).toMatchObject({ type: "object", required: ["site", "claimToken"], properties: { site: { type: "string" }, claimToken: { type: "string" } } });
    } else {
      expect.soft(text.includes("MCP tool: `claim_site`"), "full discovery must not promise an unavailable claim MCP twin").toBe(false);
      expect.soft(/^### claim_site\s*$/m.test(text), "full discovery must omit the unavailable claim tool section").toBe(false);
      expect.soft(tools.map((t) => t.name)).not.toContain("claim_site");
    }
  });

  it("keeps the brief tool inventory and skill consistent with the configured capability", async () => {
    const brief = await dw.call("/llms.txt");
    const skill = await dw.call("/skill.md");
    expect(brief.status).toBe(200);
    expect(skill.status).toBe(200);
    const briefText = await brief.text();
    const skillText = await skill.text();
    expect(briefText).toContain(`\`POST ${CLAIM_PATH}\` (claim_site)`);
    expect(briefText).toContain(`${ORIGIN}/mcp`);
    expect(skillText).toContain(`${ORIGIN}/mcp`);
    expect(/^[-*] `claim_site`:/m.test(briefText)).toBe(enabled);
    if (enabled) {
      expect(briefText).toContain("Anonymous publishing is enabled");
      expect(skillText).toContain("accepts publishing without a key");
      expect(skillText).not.toContain("requires an API key");
    } else {
      expect(briefText).not.toContain("Anonymous publishing is enabled");
      expect(skillText).toContain("requires an API key");
      expect(skillText).not.toContain("accepts publishing without a key");
    }
  });
});

it("keeps all REST operationIds stable across anonymous capability changes", async () => {
  const defaultInstance = await freshInstance();
  const instances = [defaultInstance, withStoredData(defaultInstance, { anonymous: { enabled: false } }), withStoredData(defaultInstance, { anonymous: { enabled: true } })];
  const identities = [];
  for (const dw of instances) {
    const doc = await dw.json("/openapi.json");
    expect(doc.status).toBe(200);
    identities.push(Object.entries<Record<string, any>>(doc.body.paths).flatMap(([path, item]) => Object.entries<any>(item).map(([method, op]) => `${method} ${path}: ${op.operationId}`)).sort());
  }
  expect(identities[1]).toEqual(identities[0]);
  expect(identities[2]).toEqual(identities[0]);
  expect(identities[0]).toContain(`post ${CLAIM_PATH}: claim_site`);
});

describe.each(cases.filter((c) => !c.enabled))("previously issued REST claims ($mode)", ({ config }) => {
  it("claims into a member's tenant after anonymous creation is disabled without resetting storage", async () => {
    const { disabled, pub } = await issuedSiteThenDisable(config);
    const member = await disabled.json("/api/v1/members", { key: disabled.ownerKey, ...jsonBody({ email: "claimant@example.com", role: "member" }) });
    expect(member.status).toBe(201);
    const before = await disabled.json(`/api/v1/sites/${pub.slug}`, { key: pub.claimToken });
    expect(before.status).toBe(200);
    expect(before.body.site).toMatchObject({ slug: pub.slug, anonymous: true, expiresAt: pub.expiresAt });
    const claim = await disabled.json(`/api/v1/sites/${pub.slug}/claim`, { key: member.body.apiKey.key, ...jsonBody({ claimToken: pub.claimToken }) });
    expect(claim.status).toBe(200);
    expect(claim.body.site).toMatchObject({ slug: pub.slug, anonymous: false, expiresAt: null });
    const owned = await disabled.json(`/api/v1/sites/${pub.slug}`, { key: disabled.ownerKey });
    expect(owned.status).toBe(200);
    expect(owned.body.site).toMatchObject({ slug: pub.slug, anonymous: false, expiresAt: null });
    const live = await disabled.json(`/api/v1/sites/${pub.slug}/versions/live`, { key: member.body.apiKey.key });
    expect(live.status).toBe(200);
    expect(live.body.version).toMatchObject({ id: pub.version.id, number: 1, live: true });
    expect(await (await disabled.call(pub.url)).text()).toBe("issued before disabling anonymous creation");
    expect((await disabled.json(`/api/v1/sites/${pub.slug}`, { key: pub.claimToken })).status).toBe(401);
    const refused = await disabled.json("/api/v1/publish", jsonBody({ files: [{ path: "index.html", content: "new anonymous creation must still be off" }] }));
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe("anonymous_publish_disabled");
  });
});

it.each(["no member", "bootstrap", "claim credential", "read-only scope", "missing token", "wrong token", "another site's token"])("preserves REST claim authorization after disabling anonymous creation: %s", async (attempt) => {
  const { enabled, disabled, pub } = await issuedSiteThenDisable();
  let key: string | null = disabled.ownerKey;
  let claimToken: string | undefined = pub.claimToken;
  let code: string | undefined;
  if (attempt === "no member") key = null;
  if (attempt === "bootstrap") key = BOOTSTRAP;
  if (attempt === "claim credential") key = pub.claimToken;
  if (attempt === "read-only scope") {
    const reader = await disabled.json("/api/v1/keys", { key, ...jsonBody({ name: "claim-reader", scopes: ["sites:read"] }) });
    expect(reader.status).toBe(201);
    key = reader.body.key;
    code = "insufficient_scope";
  }
  if (attempt === "missing token") claimToken = undefined;
  if (attempt === "wrong token") claimToken = "dwc_not-the-issued-claim-token";
  if (attempt === "another site's token") {
    const other = await enabled.json("/api/v1/publish", jsonBody({ files: [{ path: "index.html", content: "another anonymous site" }] }));
    expect(other.status).toBe(201);
    claimToken = other.body.claimToken;
  }
  const denied = await disabled.json(`/api/v1/sites/${pub.slug}/claim`, { key, ...jsonBody({ claimToken }) });
  if (attempt === "missing token") expect(denied.status).toBe(400);
  else if (attempt === "wrong token" || attempt === "another site's token") expect(denied.status).toBe(404);
  else expect([401, 403]).toContain(denied.status);
  expect(denied.body.error.code).toEqual(expect.any(String));
  if (code) expect(denied.body.error.code).toBe(code);
  const unchanged = await disabled.json(`/api/v1/sites/${pub.slug}`, { key: pub.claimToken });
  expect(unchanged.status).toBe(200);
  expect(unchanged.body.site).toMatchObject({ slug: pub.slug, anonymous: true, expiresAt: pub.expiresAt });
  const valid = await disabled.json(`/api/v1/sites/${pub.slug}/claim`, { key: disabled.ownerKey, ...jsonBody({ claimToken: pub.claimToken }) });
  expect(valid.status).toBe(200);
  expect(valid.body.site.anonymous).toBe(false);
});
