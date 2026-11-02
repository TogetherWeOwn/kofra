/** Independent bundled-CLI contract; synthetic HTTP fixtures and no implementation imports.
 * Grammar selected for this handoff: --title/--description <string> (empty clears to null),
 * --spa/--render-markdown/--cross-origin-isolation true|false. No implicit toggles.
 * Run from root: npm run test:cli -- test/site-settings/settings.acceptance.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bundle, clean, failure, originalSite, requests, runCli, sandbox, secretMarkers,
  sitePath, success, testRoot, transport, type Ran, type Wire } from "./harness.ts";

let root: string, entry: string;
let server: Awaited<ReturnType<typeof transport>>;
let reply: (request: Wire) => Response;
let site: typeof originalSite;

beforeAll(async () => {
  root = await testRoot(); entry = await bundle(root);
  server = await transport(request => reply(request));
});
beforeEach(() => {
  site = structuredClone(originalSite); server.received.length = 0;
  reply = request => {
    if (request.url !== sitePath || !request.authenticated) return Response.json({ error: {
      code: "fixture_request_refused", message: "Unexpected request", hint: "Read or PATCH the explicit site only." },
    }, { status: 403 });
    if (request.method === "PATCH") {
      const patch = JSON.parse(request.body);
      for (const field of ["title", "description"] as const) if (field in patch) site[field] = patch[field];
      for (const field of ["spa", "renderMarkdown", "crossOriginIsolation"] as const) if (field in patch) site.settings[field] = patch[field];
    } else if (request.method !== "GET") return new Response(null, { status: 405 });
    return Response.json({ site });
  };
});
afterAll(async () => { await server?.close(); await clean(root); });

async function cli(args: string[], options: Parameters<typeof runCli>[4] = {}) {
  return runCli(entry, await sandbox(root, server.origin), server.origin, args, options);
}
function safeSite(result: Ran, expected: Record<string, unknown>) {
  expect(success(result).site).toMatchObject({ id: "site_settings_fixture", slug: "settings-fixture", ...expected });
}
function noNetwork(result: Ran) {
  expect(result.wire, "even a refused fetch attempt violates offline validation/dry-run").toEqual([]);
  expect(server.received).toEqual([]);
}

describe("settings: bundled CLI wire contract", () => {
  it("positive control: existing site command reaches the same authenticated fixture", async () => {
    const result = await cli(["site", "settings-fixture", "--json"]);
    expect(success(result).site).toMatchObject({ slug: "settings-fixture", title: "Original title" });
    requests(result, server.origin, [["GET", sitePath]]);
    expect(server.received.map(r => [r.method, r.url, r.body, r.authenticated])).toEqual([["GET", sitePath, "", true]]);
  });

  it("inspect is one authenticated GET, with stable identity and all five non-secret settings", async () => {
    const result = await cli(["settings", "settings-fixture", "--json"]);
    safeSite(result, { title: "Original title", description: "Original description",
      settings: { spa: true, renderMarkdown: true, crossOriginIsolation: true } });
    requests(result, server.origin, [["GET", sitePath]]);
    expect(server.received).toHaveLength(1);
  });

  it("sends only the explicitly requested title, keeping omitted metadata and booleans", async () => {
    const result = await cli(["settings", "settings-fixture", "--title", "New <literal> title", "--json"]);
    safeSite(result, { title: "New <literal> title", description: "Original description",
      settings: { spa: true, renderMarkdown: true, crossOriginIsolation: true } });
    requests(result, server.origin, [["PATCH", sitePath, { title: "New <literal> title" }]]);
    expect(server.received.map(r => JSON.parse(r.body))).toEqual([{ title: "New <literal> title" }]);
  });

  it("sends a description without synthesizing a title or resetting settings", async () => {
    const result = await cli(["settings", "settings-fixture", "--description", "A plain description", "--json"]);
    safeSite(result, { title: "Original title", description: "A plain description", settings: originalSite.settings });
    requests(result, server.origin, [["PATCH", sitePath, { description: "A plain description" }]]);
  });

  it.each([
    { flag: "--spa", field: "spa" }, { flag: "--render-markdown", field: "renderMarkdown" },
    { flag: "--cross-origin-isolation", field: "crossOriginIsolation" },
  ])("preserves explicit false for $flag without forwarding the CLI spelling", async ({ flag, field }) => {
    const result = await cli(["settings", "settings-fixture", flag, "false", "--json"]);
    safeSite(result, { title: "Original title", description: "Original description",
      settings: { ...originalSite.settings, [field]: false } });
    requests(result, server.origin, [["PATCH", sitePath, { [field]: false }]]);
  });

  it("normalizes every supported field in one PATCH, preserving explicit true", async () => {
    site.settings = { spa: false, renderMarkdown: false, crossOriginIsolation: false };
    const result = await cli(["settings", "settings-fixture", "--title", "New", "--description", "Text",
      "--spa", "true", "--render-markdown", "true", "--cross-origin-isolation", "true", "--json"]);
    safeSite(result, { title: "New", description: "Text", settings: originalSite.settings });
    requests(result, server.origin, [["PATCH", sitePath,
      { title: "New", description: "Text", spa: true, renderMarkdown: true, crossOriginIsolation: true }]]);
  });

  it("maps explicit empty title/description to null; neither is mistaken for omission", async () => {
    const result = await cli(["settings", "settings-fixture", "--title", "", "--description", "", "--json"]);
    safeSite(result, { title: null, description: null, settings: originalSite.settings });
    requests(result, server.origin, [["PATCH", sitePath, { title: null, description: null }]]);
  });

  it.each(["--help", "help"])('offers offline command help (%s) with grammar, read/write/dry-run and JSON', async mode => {
    const args = mode === "help" ? ["help", "settings"] : ["settings", "--help"];
    const result = await cli(args, { offline: true, noKey: true });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/settings\s+<site>/i);
    for (const flag of ["--title", "--description", "--spa", "--render-markdown", "--cross-origin-isolation", "--dry-run", "--json"]) expect(result.stdout).toContain(flag);
    expect(result.stdout).toMatch(/true.*false|false.*true/);
    expect(result.stdout).toMatch(/read|inspect/i);
    expect(result.stdout).toMatch(/offline|no network|contacts nothing/i);
    expect(result.stdout).toMatch(/empty|null|clear/i);
    noNetwork(result);
  });

  it("advertises settings <site> in root command help without network", async () => {
    const result = await cli(["--help"], { offline: true, noKey: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\s*(?:kofra\s+)?settings\s+<site>/m);
    noNetwork(result);
  });

  it("human inspect output names the site and settings without a non-TTY prompt", async () => {
    const result = await cli(["settings", "settings-fixture"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("settings-fixture");
    expect(result.stdout).toContain("Original title");
    expect(result.stdout).toMatch(/spa/i);
    requests(result, server.origin, [["GET", sitePath]]);
  });

  it("projects out claim/access/password secrets even when a transport returns extra fields", async () => {
    reply = () => Response.json({ site: { ...site, claimToken: secretMarkers[1], password: secretMarkers[2],
      settings: { ...site.settings, password: secretMarkers[2] } }, apiKey: secretMarkers[0] });
    const result = await cli(["settings", "settings-fixture", "--json"]);
    safeSite(result, { title: "Original title", settings: originalSite.settings });
    expect(result.json).not.toHaveProperty("apiKey");
    expect(result.json.site).not.toHaveProperty("claimToken");
    expect(result.json.site).not.toHaveProperty("password");
    expect(result.json.site.settings).not.toHaveProperty("password");
    requests(result, server.origin, [["GET", sitePath]]);
  });

  it("never prompts for a missing credential or falls back to setup/publish", async () => {
    const result = await cli(["settings", "settings-fixture", "--title", "New", "--json"], { noKey: true });
    const error = failure(result, 3);
    expect(error.hint).toMatch(/key|login/i);
    noNetwork(result);
  });
});

describe("settings: validation is offline and cannot use a stale project target", () => {
  it.each([
    [], ["--title", "New"], ["--spa", "false"], ["--title", "New", "--dry-run"],
    ["", "--title", "New"], ["--site", "stale-other-site", "--title", "New"],
    ["settings-fixture", "another-site", "--title", "New"],
  ].map(args => ({ args, label: JSON.stringify(args) })))("requires exactly one nonempty explicit site: $label", async ({ args }) => {
    const result = await cli(["settings", ...args, "--json"], { offline: true });
    const error = failure(result, 2);
    expect(error.hint).toMatch(/settings|site/i);
    noNetwork(result);
  });

  it.each([
    ["--unknown", "x"], ["--password", secretMarkers[2]!], ["--access", "public"], ["--key-id", "key_fixture"],
    ["--tenant", "tenant_fixture"], ["--runtime", "value"], ["--quota", "10"], ["--max-file-bytes", "10"],
    ["--access-mode", "public"], ["--instance-settings", "{}"], ["--keys", "revoke"],
    ["--data", '{"password":null}'], ["--spa", "yes"], ["--spa", "1"], ["--spa", "FALSE"],
    ["--render-markdown", "no"], ["--cross-origin-isolation", "0"], ["--spa"], ["--title"], ["--description"],
    ["--renderMarkdown", "false"], ["--crossOriginIsolation", "false"],
    ["--spa", "true", "--spa", "false"], ["--render-markdown", "true", "--render-markdown", "false"],
    ["--cross-origin-isolation", "true", "--cross-origin-isolation", "false"], ["--title", "A", "--title", "B"],
    ["--description", "A", "--description", "B"], ["--dry-run"],
  ].map(args => ({ args, label: JSON.stringify(args) })))("rejects unsupported/invalid/conflicting flags before all networking: $label", async ({ args }) => {
    const result = await cli(["settings", "settings-fixture", ...args, "--json"], { offline: true });
    const error = failure(result, 2);
    expect(error.hint).toMatch(/settings|--|unsupported|true|false/i);
    noNetwork(result);
  });
});

describe("settings: offline normalized dry-run", () => {
  it("emits a versioned exact plan without reads, writes, login or changes to config", async () => {
    const box = await sandbox(root, server.origin);
    const args = ["settings", "settings-fixture", "--title", "", "--description", "Plan text", "--spa", "false",
      "--render-markdown", "false", "--cross-origin-isolation", "true", "--dry-run", "--json"];
    const a = await runCli(entry, box, server.origin, args, { offline: true, noKey: true });
    expect(success(a)).toMatchObject({ schemaVersion: 1, dryRun: true, site: "settings-fixture",
      patch: { title: null, description: "Plan text", spa: false, renderMarkdown: false, crossOriginIsolation: true } });
    expect(Object.keys(a.json.patch).sort()).toEqual(["crossOriginIsolation", "description", "renderMarkdown", "spa", "title"]);
    expect(a.json).not.toHaveProperty("siteId"); // An offline plan cannot resolve a stable id from a slug.
    noNetwork(a);
    const b = await runCli(entry, box, server.origin, args, { offline: true, noKey: true });
    expect(success(b)).toEqual(a.json);
    expect(b.stdout).toBe(a.stdout);
    noNetwork(b);
  });

  it("does not contact the configured instance even when a saved credential is available", async () => {
    const result = await cli(["settings", "settings-fixture", "--spa", "false", "--dry-run", "--json"], { offline: true });
    expect(success(result)).toMatchObject({ schemaVersion: 1, dryRun: true, site: "settings-fixture", patch: { spa: false } });
    expect(result.json.patch).toEqual({ spa: false });
    noNetwork(result);
  });
});

describe("settings: server refusals retain actionable JSON and existing exit conventions", () => {
  it.each([
    { status: 401, exit: 3, code: "unauthorized" }, { status: 403, exit: 3, code: "insufficient_scope" },
    { status: 404, exit: 4, code: "site_not_found" }, { status: 409, exit: 5, code: "site_changed" },
    { status: 422, exit: 6, code: "invalid_request" },
  ])("preserves $status $code, hint, next action and request id on a single PATCH", async ({ status, exit, code }) => {
    const next = [{ tool: "get_site", args: { site: "settings-fixture" }, why: "Read current settings." }];
    reply = () => Response.json({ error: { code, message: "Settings fixture refused.",
      hint: "Read the explicit site and check its settings permission.", next, retryable: false,
      details: { field: "title" } }, requestId: "settings-fixture-request" }, { status });
    const result = await cli(["settings", "settings-fixture", "--title", "Refused", "--json"]);
    expect(failure(result, exit)).toMatchObject({ code, status, retryable: false, next,
      hint: "Read the explicit site and check its settings permission.", details: { field: "title" }, requestId: "settings-fixture-request" });
    requests(result, server.origin, [["PATCH", sitePath, { title: "Refused" }]]);
    expect(site).toEqual(originalSite);
  });

  it.each([429, 503])("preserves retryable HTTP %i and exit 7 without switching target or method", async status => {
    const next = [{ tool: "get_site", args: { site: "settings-fixture" }, why: "Check the explicit site later." }];
    reply = () => Response.json({ error: { code: "temporarily_unavailable", message: "Try settings later.",
      hint: "Retry the same explicit site later.", retryable: true, retryAfterSeconds: 0, next } },
    { status, headers: { "Retry-After": "0" } });
    const result = await cli(["settings", "settings-fixture", "--title", "Retryable", "--json"]);
    expect(failure(result, 7)).toMatchObject({ code: "temporarily_unavailable", status, retryable: true, next,
      retryAfterSeconds: 0, hint: "Retry the same explicit site later." });
    expect(result.wire.length).toBeGreaterThan(0);
    requests(result, server.origin, result.wire.map(() => ["PATCH", sitePath, { title: "Retryable" }]));
    expect(site).toEqual(originalSite);
  });

  it("keeps read failure identity deterministic without retrying or mutating", async () => {
    reply = () => Response.json({ error: { code: "site_not_found", message: "Site not found.",
      hint: "Check the explicit site with kofra list." } }, { status: 404 });
    const a = await cli(["settings", "settings-fixture", "--json"]);
    const b = await cli(["settings", "settings-fixture", "--json"]);
    expect(failure(a, 4)).toMatchObject({ code: "site_not_found", status: 404, hint: "Check the explicit site with kofra list." });
    expect(failure(b, 4)).toEqual(a.json.error);
    requests(a, server.origin, [["GET", sitePath]]); requests(b, server.origin, [["GET", sitePath]]);
    expect(site).toEqual(originalSite);
  });
});
