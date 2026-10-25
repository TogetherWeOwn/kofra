import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@dropway/core";
import { CORE_MCP_TOOLS, skillMarkdown } from "@dropway/server";
import repoSkill from "../skills/kofra/SKILL.md?raw";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

/** "/api/v1/sites/:slug/files/:path{.+}" and "/api/v1/sites/{slug}/files/{path}" both become "/api/v1/sites/{}/files/{}". */
const shape = (p: string) =>
  p
    .replace(/:[A-Za-z0-9_]+(\{[^}]*\})?/g, "{}")
    .replace(/\{[A-Za-z0-9_]+\}/g, "{}")
    .replace(/\/\*$/, "/{}"); // a trailing wildcard ("/v/:slug/*") is documented as a {path} parameter

describe.each([
  { mode: "default", config: {}, claimEnabled: false },
  { mode: "anonymous disabled", config: { anonymous: { enabled: false } }, claimEnabled: false },
  { mode: "anonymous enabled", config: { anonymous: { enabled: true } }, claimEnabled: true },
])("/openapi.json ($mode)", ({ config, claimEnabled }) => {
  beforeEach(async () => {
    dw = await freshInstance(config);
  });
  it("documents every route the app serves", async () => {
    const doc = (await dw.json("/openapi.json")).body;
    const documented = new Set<string>();
    for (const [path, item] of Object.entries<Record<string, unknown>>(doc.paths)) {
      for (const method of Object.keys(item)) documented.add(`${method.toUpperCase()} ${shape(path)}`);
    }
    const missing: string[] = [];
    for (const r of dw.dropway.app.routes) {
      if (r.method === "ALL" && r.path.endsWith("*")) continue; // middleware (and the /mcp/* catch-all, which only 404s)
      const method = r.method === "ALL" ? "POST" : r.method;
      if (!documented.has(`${method} ${shape(r.path)}`)) missing.push(`${r.method} ${r.path}`);
    }
    expect(missing).toEqual([]);
  });

  it("uses snake_case operationIds that name MCP tools, or says why there is none", async () => {
    const doc = (await dw.json("/openapi.json")).body;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("https://dropway.test");
    const mcp = await connectMcp(dw, dw.ownerKey);
    let tools;
    try {
      tools = await mcp.tools();
    } finally {
      await mcp.client.close();
    }
    const toolNames = new Set(tools.map((t) => t.name));
    expect([...toolNames].sort()).toEqual(CORE_MCP_TOOLS.filter((t) => claimEnabled || t.name !== "claim_site").map((t) => t.name).sort());
    const ids = new Set<string>();
    for (const item of Object.values<Record<string, any>>(doc.paths)) {
      for (const op of Object.values<any>(item)) {
        expect(op.operationId).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(ids.has(op.operationId), op.operationId).toBe(false);
        ids.add(op.operationId);
        if (op["x-mcp-tool"]) expect(toolNames.has(op["x-mcp-tool"]), op.operationId).toBe(true);
        else expect(op["x-mcp-exclude"], op.operationId).toBeTruthy();
      }
    }
    // Every MCP tool except instance-only conveniences has a REST twin.
    const restTools = new Set([...Object.values<Record<string, any>>(doc.paths)].flatMap((item) => Object.values<any>(item).map((op) => op["x-mcp-tool"]).filter(Boolean)));
    expect([...toolNames].filter((n) => !restTools.has(n))).toEqual([]);
  });
});

describe("REST twins of the agent tools", () => {
  const pub = (slug: string, files: Record<string, string>) =>
    dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, ...jsonBody({ slug, files: Object.entries(files).map(([path, content]) => ({ path, content })) }) });

  it("PATCH /sites/{slug}/files updates some files, honours Idempotency-Key and baseVersionId", async () => {
    const first = await pub("rest-edit", { "index.html": "one", "keep.txt": "k" });
    const base = first.body.version.id;
    const init = { method: "PATCH", key: dw.ownerKey, headers: { "Content-Type": "application/json", "Idempotency-Key": "edit-1" }, body: JSON.stringify({ baseVersionId: base, files: [{ path: "index.html", content: "two" }] }) };
    const r = await dw.json("/api/v1/sites/rest-edit/files", init);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "live", version: { number: 2 }, changes: { written: 1, carriedOver: 1 } });
    const replay = await dw.json("/api/v1/sites/rest-edit/files", init);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.version.id).toBe(r.body.version.id);
    const stale = await dw.json("/api/v1/sites/rest-edit/files", { method: "PATCH", key: dw.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseVersionId: base, delete: ["keep.txt"] }) });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
  });

  it("PUT /access, POST /rename and GET /versions/{version}", async () => {
    await pub("rest-site", { "index.html": "hi" });
    const pw = await dw.json("/api/v1/sites/rest-site/access", { method: "PUT", key: dw.ownerKey, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "password", password: "secret1" }) });
    expect(pw.body.access.mode).toBe("password");
    const v = await dw.json("/api/v1/sites/rest-site/versions/v1", { key: dw.ownerKey });
    expect(v.body.version).toMatchObject({ number: 1, live: true });
    const live = await dw.json("/api/v1/sites/rest-site/versions/live", { key: dw.ownerKey });
    expect(live.body.version.id).toBe(v.body.version.id);
    const rn = await dw.json("/api/v1/sites/rest-site/rename", { method: "POST", key: dw.ownerKey, ...jsonBody({ newSlug: "rest-site-2" }) });
    expect(rn.body).toMatchObject({ renamed: true, slug: "rest-site-2", oldSlug: "rest-site" });
    expect((await dw.json("/api/v1/sites/rest-site-2", { key: dw.ownerKey })).body.site.settings.passwordProtected).toBe(true);
  });
});

describe("llms.txt, llms-full.txt and the Agent Skill", () => {
  it("llms.txt lists the MCP endpoint, the docs and every REST operation and tool", async () => {
    const res = await dw.call("/llms.txt");
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toMatch(/^# Kofra\n\n> /);
    expect(text).toContain("https://dropway.test/mcp");
    expect(text).toContain("https://dropway.test/llms-full.txt");
    expect(text).toContain("npx skills add https://dropway.test");
    for (const t of CORE_MCP_TOOLS.filter((x) => x.name !== "claim_site")) expect(text).toContain(`\`${t.name}\``);
    expect(text).not.toContain("`claim_site`"); // anonymous publishing is off
    expect(text).toContain("`PATCH /api/v1/sites/{slug}/files` (update_site_files)");
  });

  it("llms-full.txt carries every tool's input schema, every operation and the error codes", async () => {
    const text = await (await dw.call("/llms-full.txt")).text();
    expect(text).toContain("### publish_site");
    expect(text).toContain("accepts idempotencyKey");
    expect(text).toContain("### POST /api/v1/publish");
    expect(text).toContain("version_conflict");
    expect(text).toContain("name: kofra");
    const doc = (await dw.json("/openapi.json")).body;
    for (const item of Object.values<Record<string, any>>(doc.paths)) for (const op of Object.values<any>(item)) expect(text).toContain(`operationId \`${op.operationId}\``);
  });

  it("/skill.md is a valid Agent Skill templated with this instance", async () => {
    const res = await dw.call("/skill.md");
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const md = await res.text();
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
    expect(fm).toBeTruthy();
    expect(fm![1]).toMatch(/^name: kofra$/m);
    const description = /^description: (.+)$/m.exec(fm![1]!)![1]!;
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(md).toContain("https://dropway.test/mcp");
    expect(md).toContain("requires an API key");
    expect(md).not.toContain("$KOFRA_URL");
    expect(md.length).toBeLessThan(8000); // about 2,000 tokens
  });

  it("the well-known index points at the skill with a matching digest", async () => {
    const index = (await dw.json("/.well-known/agent-skills/index.json")).body;
    expect(index.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    const entry = index.skills[0];
    expect(entry).toMatchObject({ name: "kofra", type: "skill-md", url: "https://dropway.test/.well-known/agent-skills/kofra/SKILL.md" });
    const body = await (await dw.call(entry.url)).text();
    expect(entry.digest).toBe(`sha256:${await sha256Hex(body)}`);
    const legacy = (await dw.json("/.well-known/skills/index.json")).body;
    expect(legacy.skills[0]).toMatchObject({ name: "kofra", files: ["SKILL.md"] });
    expect((await dw.call("/.well-known/skills/kofra/SKILL.md")).status).toBe(200);
  });

  it("skills/kofra/SKILL.md in the repository is up to date (npm run skill:sync)", () => {
    expect(repoSkill).toBe(skillMarkdown(null));
  });
});

describe("/connect, /connect.md, the api-catalog and robots.txt (R-11)", () => {
  const CLAUDE = `claude mcp add --transport http kofra ${ORIGIN}/mcp`;

  it("/connect renders every setup section as script-free HTML", async () => {
    const res = await dw.call("/connect");
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).not.toContain("<script");
    for (const s of ["MCP (recommended)", "Agent Skill", "CLI", "REST"]) expect(html).toContain(s);
    expect(html).toContain(CLAUDE);
    expect(html).toContain(`npx skills add ${ORIGIN} -g`);
    expect(html).toContain(`curl ${ORIGIN}/api/v1/publish`);
    expect(html).toContain(`<a href="/llms.txt">/llms.txt</a>`);
  });

  it("/connect.md carries the same commands as /connect", async () => {
    const res = await dw.call("/connect.md");
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const md = await res.text();
    expect(md).toContain(CLAUDE);
    expect(md).toContain("[mcp_servers.kofra]");
    expect(md).toContain(`npx skills add ${ORIGIN} -g`);
    expect(md).toContain(`npx kofra login --api ${ORIGIN}`);
    expect(md).toContain(`curl ${ORIGIN}/api/v1/publish`);
    // every snippet on the HTML page appears verbatim in the Markdown: the two cannot drift
    const html = await (await dw.call("/connect")).text();
    const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const snippets = [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)];
    expect(snippets.length).toBeGreaterThan(0);
    for (const m of snippets) expect(md).toContain(unescape(m[1]!));
  });

  it("/.well-known/api-catalog links the OpenAPI, docs and MCP endpoint", async () => {
    const { status, body, res } = await dw.json("/.well-known/api-catalog");
    expect(status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/linkset+json");
    const link = body.linkset[0];
    expect(link.anchor).toBe(`${ORIGIN}/`);
    expect(link["service-desc"]).toEqual([{ href: `${ORIGIN}/openapi.json`, type: "application/openapi+json;version=3.1.0" }]);
    expect(link["service-doc"].map((l: { href: string }) => l.href)).toEqual([`${ORIGIN}/llms.txt`, `${ORIGIN}/llms-full.txt`, `${ORIGIN}/skill.md`, `${ORIGIN}/connect.md`]);
    expect(link.mcp[0].href).toBe(`${ORIGIN}/mcp`);
  });

  it("/robots.txt keeps discovery crawlable and key-gated shells out", async () => {
    const res = await dw.call("/robots.txt");
    expect(res.headers.get("content-type")).toContain("text/plain");
    const txt = await res.text();
    for (const p of ["/dashboard", "/login", "/claim", "/v/", "/view/", "/mcp", "/api/"]) expect(txt).toContain(`Disallow: ${p}`);
    expect(txt).not.toContain("/connect");
    expect(txt).not.toContain("/llms.txt");
  });

  it("the home page links /connect", async () => {
    expect(await (await dw.call("/")).text()).toContain(`<a href="/connect">/connect</a>`);
  });
});
