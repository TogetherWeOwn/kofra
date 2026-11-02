/** Built CLI against a disposable workerd/D1/R2/KV instance. No remote deployment.
 * Run: npm run test:cli -- test/site-settings/settings-worker.acceptance.test.ts
 */
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bundle, clean, isolatedEnv, repoRoot, requests, runCli, sandbox, success, testRoot, transport } from "./harness.ts";

let root: string, entry: string, origin: string, key: string;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let proxy: Awaited<ReturnType<typeof transport>>;
let slug: string, path: string, baseline: any;
let fixture = 0;

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(origin + "/api/v1" + path, { method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(response.ok, `disposable fixture ${method} ${path}: HTTP ${response.status}`).toBe(true);
  return response.json() as Promise<any>;
}
beforeAll(async () => {
  root = await testRoot(); entry = await bundle(root);
  const config = join(root, "wrangler.json"), persist = join(root, "state");
  await writeFile(config, JSON.stringify({ name: "dropway-settings-acceptance", main: join(repoRoot, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false",
      ADMIN_BOOTSTRAP_KEY: "settings_disposable_bootstrap_fixture" },
    d1_databases: [{ binding: "DB", database_name: "settings-acceptance", migrations_dir: join(repoRoot, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "settings-acceptance-files" }], kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(repoRoot, "node_modules/wrangler/bin/wrangler.js"),
    "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist],
    { cwd: repoRoot, env: isolatedEnv(root) });
  worker = await unstable_startWorker({ config,
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" } });
  await worker.ready; origin = (await worker.url).origin;
  key = "settings_disposable_bootstrap_fixture";
  const setup = await api("/setup", "POST", { email: "settings-owner@example.test" });
  key = setup.apiKey.key;
  expect(typeof key === "string" && key.startsWith("dw_"), "disposable setup must return an owner credential").toBe(true);
  proxy = await transport(async request => {
    if (request.url !== path || !["GET", "PATCH"].includes(request.method)) return new Response(null, { status: 405 });
    return fetch(origin + request.url, { method: request.method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(request.method === "GET" ? {} : { body: request.body }) });
  }, key);
}, 120_000);
beforeEach(async () => {
  slug = `settings-disposable-${++fixture}`; path = `/api/v1/sites/${slug}`;
  await api("/publish", "POST", { site: slug, title: "Worker title", description: "Worker description",
    spa: true, renderMarkdown: true, crossOriginIsolation: true,
    files: [{ path: "index.html", content: "<!doctype html><title>Settings fixture</title><p>Disposable content</p>" },
      { path: "readme.md", content: "# Disposable markdown" }] });
  baseline = await api(`/sites/${slug}`);
  proxy.received.length = 0;
});
afterAll(async () => { await proxy?.close(); await worker?.dispose(); await clean(root); });
async function cli(args: string[]) {
  return runCli(entry, await sandbox(root, proxy.origin), proxy.origin, args, { key, path });
}

describe("settings: disposable Worker execution", () => {
  it("positive control: real site and existing PATCH work before the new command exists", async () => {
    const read = await cli(["site", slug, "--json"]);
    expect(success(read).site).toMatchObject({ slug, title: "Worker title", description: "Worker description",
      settings: { spa: true, renderMarkdown: true, crossOriginIsolation: true } });
    requests(read, proxy.origin, [["GET", path]]);
    const changed = await cli(["api", "PATCH", `/sites/${slug}`, "--data", '{"title":"Control title"}', "--json"]);
    expect(changed.code, changed.stdout + changed.stderr).toBe(0);
    expect(changed.json.site).toMatchObject({ slug, title: "Control title", description: "Worker description" });
    requests(changed, proxy.origin, [["PATCH", path, { title: "Control title" }]]);
    expect((await api(`/sites/${slug}`)).site.title).toBe("Control title");
  });

  it("positive control: existing service applies false/null idempotently and changes live serving", async () => {
    const versions = await api(`/sites/${slug}/versions`);
    const patch = { title: null, description: null, spa: false, renderMarkdown: false, crossOriginIsolation: false };
    const first = await api(`/sites/${slug}`, "PATCH", patch);
    expect(first.site).toMatchObject({ slug, title: null, description: null,
      settings: { spa: false, renderMarkdown: false, crossOriginIsolation: false }, currentVersionId: baseline.site.currentVersionId });
    expect((await api(`/sites/${slug}`, "PATCH", patch)).site).toMatchObject({ slug, title: null, description: null,
      settings: { spa: false, renderMarkdown: false, crossOriginIsolation: false }, currentVersionId: first.site.currentVersionId });
    expect((await api(`/sites/${slug}/versions`)).versions).toEqual(versions.versions);
    const live = await fetch(origin + `/s/${slug}/index.html`);
    expect(live.status).toBe(200);
    expect(await live.text()).toContain("Disposable content");
    expect(live.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(live.headers.get("cross-origin-embedder-policy")).toBeNull();
    expect((await fetch(origin + `/s/${slug}/missing-route`)).status).toBe(404);
    const markdown = await fetch(origin + `/s/${slug}/readme.md`, { headers: { accept: "text/html", "sec-fetch-dest": "document" } });
    expect(await markdown.text()).toBe("# Disposable markdown");
  });

  it("inspects through the existing authenticated site GET and preserves identity", async () => {
    const result = await cli(["settings", slug, "--json"]);
    expect(success(result).site).toMatchObject({ id: expect.any(String), slug,
      title: "Worker title", description: "Worker description",
      settings: { spa: true, renderMarkdown: true, crossOriginIsolation: true } });
    requests(result, proxy.origin, [["GET", path]]);
    expect(proxy.received).toHaveLength(1);
    expect(proxy.received[0]!.authenticated).toBe(true);
    expect(await api(`/sites/${slug}`)).toEqual(baseline);
  });

  it("explicit false changes live behavior, preserving bytes, other fields and version identity", async () => {
    const beforeVersions = await api(`/sites/${slug}/versions`);
    const result = await cli(["settings", slug, "--spa", "false", "--render-markdown", "false",
      "--cross-origin-isolation", "false", "--json"]);
    expect(success(result).site).toMatchObject({ id: expect.any(String), slug, title: "Worker title", description: "Worker description",
      settings: { spa: false, renderMarkdown: false, crossOriginIsolation: false }, currentVersionId: baseline.site.currentVersionId });
    requests(result, proxy.origin, [["PATCH", path, { spa: false, renderMarkdown: false, crossOriginIsolation: false }]]);
    const fresh = await api(`/sites/${slug}`);
    expect(fresh.site).toMatchObject({ title: "Worker title", description: "Worker description",
      settings: { spa: false, renderMarkdown: false, crossOriginIsolation: false }, currentVersionId: baseline.site.currentVersionId });
    expect((await api(`/sites/${slug}/versions`)).versions).toEqual(beforeVersions.versions);
    const live = await fetch(origin + `/s/${slug}/index.html`);
    expect(live.status).toBe(200);
    expect(await live.text()).toContain("Disposable content");
    expect(live.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(live.headers.get("cross-origin-embedder-policy")).toBeNull();
    expect((await fetch(origin + `/s/${slug}/missing-route`)).status).toBe(404);
    const markdown = await fetch(origin + `/s/${slug}/readme.md`, { headers: { accept: "text/html", "sec-fetch-dest": "document" } });
    expect(await markdown.text()).toBe("# Disposable markdown");
  });

  it("clears only the explicit metadata and reapplies the patch without a new version", async () => {
    const beforeVersions = await api(`/sites/${slug}/versions`);
    const a = await cli(["settings", slug, "--title", "", "--description", "", "--json"]);
    expect(success(a).site).toMatchObject({ id: expect.any(String), slug, title: null, description: null,
      settings: { spa: true, renderMarkdown: true, crossOriginIsolation: true }, currentVersionId: baseline.site.currentVersionId });
    const afterFirst = await api(`/sites/${slug}`);
    const b = await cli(["settings", slug, "--title", "", "--description", "", "--json"]);
    expect(success(b).site).toMatchObject({ id: a.json.site.id, slug, title: null, description: null,
      settings: { spa: true, renderMarkdown: true, crossOriginIsolation: true }, currentVersionId: a.json.site.currentVersionId });
    requests(a, proxy.origin, [["PATCH", path, { title: null, description: null }]]);
    requests(b, proxy.origin, [["PATCH", path, { title: null, description: null }]]);
    expect((await api(`/sites/${slug}`)).site).toMatchObject({ slug, title: null, description: null,
      settings: { spa: true, renderMarkdown: true, crossOriginIsolation: true }, currentVersionId: afterFirst.site.currentVersionId });
    expect((await api(`/sites/${slug}/versions`)).versions).toEqual(beforeVersions.versions);
  });

  it("registers the settings CLI path on the existing update operation, not a new endpoint", async () => {
    const catalog = await api("/operations");
    const rows = Array.isArray(catalog) ? catalog : catalog.operations;
    const operations = rows.filter((row: any) => row.id === "update_site_settings");
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ method: "PATCH", path: "/api/v1/sites/{slug}",
      cli: { command: ["settings"] } });
  });
});
