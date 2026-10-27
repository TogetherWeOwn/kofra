/** Test-only disposable Worker. Never accepts a remote target or deploys anything. */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { expect } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const bootstrap = "unchanged-link-disposable-bootstrap-0123456789";
export const tree = [
  { name: "index.html", mimeType: "text/html", buffer: Buffer.from("<h1>Unchanged link fixture</h1>") },
  { name: "notes-<img onerror=alert(1)>.txt", mimeType: "text/plain", buffer: Buffer.from("literal hostile filename") },
];
export const totalBytes = 55;
export const jsonBody = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export async function startFixture() {
  const work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "unchanged-link-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
  let origin = "";
  let key = bootstrap;
  const request = (path: string, init: RequestInit = {}) => {
    const url = new URL(path, origin);
    if (url.origin !== origin || url.hostname !== "127.0.0.1") throw Error("fixture must stay on its disposable loopback Worker");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${key}`);
    return fetch(url, { ...init, headers });
  };
  const json = async (path: string, init: RequestInit = {}) => {
    const response = await request(path, init);
    expect(response.ok, `fixture ${init.method ?? "GET"} ${path}: ${response.status}`).toBe(true);
    return await response.json() as any;
  };
  const dispose = async () => { await worker?.dispose(); await rm(work, { recursive: true, force: true }); };
  try {
    await writeFile(config, JSON.stringify({
      name: "dropway-unchanged-link-test", main: join(root, "apps/worker/src/index.ts"),
      compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
      vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "true" },
      d1_databases: [{ binding: "DB", database_name: "unchanged-link", migrations_dir: join(root, "packages/core/migrations") }],
      r2_buckets: [{ binding: "FILES", bucket_name: "unchanged-link-files" }], kv_namespaces: [{ binding: "CACHE" }],
    }));
    await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
      cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    });
    worker = await unstable_startWorker({
      config, dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
      bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
    });
    await worker.ready;
    origin = (await worker.url).origin;
    key = (await json("/api/v1/setup", jsonBody({ email: "unchanged-fixture@example.test" }))).apiKey.key;
    const seed = async (slug: string) => {
      const body = new FormData();
      body.set("slug", slug);
      for (const file of tree) body.append(file.name, new File([new Uint8Array(file.buffer)], file.name, { type: file.mimeType }));
      const result = await json("/api/v1/publish", { method: "POST", body });
      const site = (await json(`/api/v1/sites/${slug}`)).site;
      expect(result.version).toMatchObject({ number: 1, fileCount: 2, totalBytes });
      return { site, version: result.version };
    };
    return { origin, ownerKey: key, request, json, seed, dispose };
  } catch (error) { await dispose(); throw error; }
}
export type Fixture = Awaited<ReturnType<typeof startFixture>>;
