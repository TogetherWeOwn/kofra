/** Real disposable Worker parity, without setup/login or any API mutation.
 * Run: npm run test:cli -- test/operations-inspection-worker.acceptance.test.ts
 */
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  catalogPath, catalogServer, cleanRoot, isolatedEnv, jsonSuccess, repoRoot,
  runCli, sandbox, tempRoot,
} from "./helpers/operations-inspection.ts";

let root: string;
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let proxy: Awaited<ReturnType<typeof catalogServer>>;
let rows: any[];

beforeAll(async () => {
  root = await tempRoot();
  const config = join(root, "wrangler.json");
  const persist = join(root, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-operations-acceptance", main: join(repoRoot, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "operations-acceptance", migrations_dir: join(repoRoot, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "operations-acceptance-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  await promisify(execFile)(process.execPath, [join(repoRoot, "node_modules/wrangler/bin/wrangler.js"),
    "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist],
    { cwd: repoRoot, env: isolatedEnv(root) });
  worker = await unstable_startWorker({ config,
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" } });
  await worker.ready;
  const origin = (await worker.url).origin;
  const response = await fetch(origin + catalogPath);
  expect(response.status).toBe(200);
  const body: any = await response.json();
  rows = Array.isArray(body) ? body : body.operations;
  expect(rows.length).toBeGreaterThan(20);
  // The proxy observes the CLI's real network boundary, refusing every other route.
  proxy = await catalogServer(() => fetch(origin + catalogPath));
}, 120_000);

afterAll(async () => {
  await proxy?.close();
  await worker?.dispose();
  await cleanRoot(root);
});

describe("native operations inspection: disposable Worker", () => {
  it("retains the existing public catalog as a no-credential positive control", async () => {
    expect(rows.map(row => row.id)).toContain("list_versions");
    expect(rows.find(row => row.id === "list_versions")).toMatchObject({
      method: "GET", scopes: ["sites:read"], inputSchema: { type: "object" }, cli: { command: ["versions", "ls"] },
    });
  });

  it("lists the same live rows and order as the Worker, stripping only inputSchema", async () => {
    const result = await runCli(await sandbox(root), proxy.origin, ["operations", "--json"]);
    const expected = rows.map(({ inputSchema: _schema, ...metadata }) => metadata);
    expect(jsonSuccess(result).operations).toEqual(expected);
    expect(result.wire).toHaveLength(1);
    expect(result.wire[0]!.headers.authorization).toBeUndefined();
  });

  it("inspects an advertised destructive operation through the catalog GET only", async () => {
    const row = rows.find(row => row.method === "DELETE");
    expect(row, "fixture must advertise a destructive operation").toBeDefined();
    const result = await runCli(await sandbox(root), proxy.origin, ["operations", row.id, "--schema", "--json"]);
    expect(jsonSuccess(result).operation).toEqual(row);
    expect(result.wire).toHaveLength(1);
    expect(proxy.requests.every(request => request.method === "GET" && request.url === catalogPath && request.body === "")).toBe(true);
  });

  it("keeps the existing explicit api GET /operations escape hatch compatible", async () => {
    const result = await runCli(await sandbox(root), proxy.origin, ["api", "GET", "/operations", "--json"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const catalog = Array.isArray(result.json) ? result.json : result.json.operations;
    expect(catalog).toEqual(rows);
    expect(result.wire).toHaveLength(1);
  });
});
