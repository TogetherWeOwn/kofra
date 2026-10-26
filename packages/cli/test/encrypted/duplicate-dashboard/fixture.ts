/** Disposable Worker fixture shared by the protected dashboard acceptance tests. */
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { expect } from "vitest";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
export const sourceSlug = "dashboard-duplicate-source";
const bootstrap = "duplicate-dashboard-disposable-bootstrap-0123456789";

async function port() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("expected a local TCP port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export async function startFixture() {
  const work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "duplicate-dashboard-"));
  const origin = `http://127.0.0.1:${await port()}`;
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
  let ownerKey = bootstrap;
  const request = (path: string, init: RequestInit = {}) => {
    const url = new URL(path, origin);
    if (url.origin !== origin) throw Error("fixture requests must stay on the disposable Worker");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${ownerKey}`);
    return fetch(url, { ...init, headers });
  };
  const json = async (path: string, init: RequestInit = {}) => {
    const response = await request(path, init);
    const body = await response.json() as any;
    expect(response.ok, `fixture ${path}: ${response.status} ${JSON.stringify(body)}`).toBe(true);
    return body;
  };
  const dispose = async () => {
    await worker?.dispose();
    await rm(work, { recursive: true, force: true });
  };
  try {
    await writeFile(config, JSON.stringify({
      name: "dropway-duplicate-dashboard-test", main: join(root, "apps/worker/src/index.ts"),
      compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
      vars: { APP_ORIGIN: origin, SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
      d1_databases: [{ binding: "DB", database_name: "duplicate-dashboard", migrations_dir: join(root, "packages/core/migrations") }],
      r2_buckets: [{ binding: "FILES", bucket_name: "duplicate-dashboard-files" }], kv_namespaces: [{ binding: "CACHE" }],
    }));
    await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
      cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    });
    worker = await unstable_startWorker({
      config, dev: { server: { hostname: "127.0.0.1", port: Number(new URL(origin).port) }, inspector: false, persist, watch: false, logLevel: "error" },
      bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
    });
    await worker.ready;
    const setup = await json("/api/v1/setup", jsonBody({ email: "duplicate-dashboard@example.com" }));
    ownerKey = setup.apiKey.key;
    const form = new FormData();
    form.set("slug", sourceSlug);
    form.append("index.html", new File(["<h1>Disposable original</h1>"], "index.html"));
    await json("/api/v1/publish", { method: "POST", body: form });
    await json(`/api/v1/sites/${sourceSlug}`, { ...jsonBody({ spa: true, title: "Original title", password: "fixture-password-only", renderMarkdown: false, crossOriginIsolation: true }), method: "PATCH" });
    const source = (await json(`/api/v1/sites/${sourceSlug}`)).site;
    const destinationResponse = await json(`/api/v1/sites/${sourceSlug}/duplicate`, jsonBody({ newSlug: "dashboard-returned-copy", message: "Response identity fixture" }));
    expect(destinationResponse.slug).toBe("dashboard-returned-copy");
    expect(source.settings).toMatchObject({ spa: true, passwordProtected: true, renderMarkdown: false, crossOriginIsolation: true });
    const htmlResponse = await request(`/dashboard/sites/${sourceSlug}`);
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    const scriptPath = /<script src="(\/__dropway\/ui\/app-[0-9a-f]{8}\.js)" defer><\/script>/.exec(html)?.[1];
    const bootText = /<script type="application\/json" id="dw-boot">(.*?)<\/script>/s.exec(html)?.[1];
    expect(scriptPath, "the real dashboard shell advertises its executable script").toBeTruthy();
    expect(bootText, "the real dashboard shell supplies its boot payload").toBeTruthy();
    const scriptResponse = await request(scriptPath!);
    expect(scriptResponse.status).toBe(200);
    expect(scriptResponse.headers.get("content-type")).toContain("javascript");
    const script = await scriptResponse.text();
    const snapshot = async () => ({
      site: (await json(`/api/v1/sites/${sourceSlug}`)).site,
      versions: await json(`/api/v1/sites/${sourceSlug}/versions`),
      files: await json(`/api/v1/sites/${sourceSlug}/files`),
    });
    return { origin, ownerKey, source, destinationResponse, html, bootText: bootText!, script, scriptPath: scriptPath!, request, json, snapshot, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export function jsonBody(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
export type Fixture = Awaited<ReturnType<typeof startFixture>>;
export type Wire = { method: string; path: string; headers: Headers; body: string };
export type Reply = (wire: Wire) => Promise<Response>;
export const mutations = (wire: Wire[]) => wire.filter(call => !["GET", "HEAD", "OPTIONS"].includes(call.method));
export const response = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export const refusal = (code: string, hint: string, status = 409) => response({ error: { code, message: "The duplicate was refused.", hint, retryable: false } }, status);
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
