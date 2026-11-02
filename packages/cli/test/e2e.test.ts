/**
 * End to end: the real CLI against the real Worker over HTTP.
 * The Worker runs locally (wrangler's unstable_startWorker: workerd with local
 * D1, R2 and KV) from the repository's own wrangler.jsonc, with migrations
 * applied by `wrangler d1 migrations apply --local`, exactly like a self-hoster.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { zipSync, strToU8 } from "fflate";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, type Io } from "../src/main.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliRoot = fileURLToPath(new URL("../", import.meta.url));
const BOOTSTRAP = "e2e-bootstrap-secret-0123456789abcdef";

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let api: string;
let work: string;
let configDir: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "dropway-e2e-"));
  configDir = join(work, "config");
  const persist = join(work, "state");
  await promisify(execFile)(process.execPath, [join(repoRoot, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], {
    cwd: repoRoot,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  worker = await unstable_startWorker({
    config: join(repoRoot, "wrangler.jsonc"),
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: {
      ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: BOOTSTRAP },
      ANONYMOUS_PUBLISH: { type: "plain_text", value: "true" },
    },
  });
  await worker.ready;
  api = (await worker.url).origin;
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

/** Run the CLI in-process with a captured Io (non-TTY, like an agent's shell). */
async function cli(args: string[], opts: { cwd?: string; env?: Record<string, string>; onlyEnv?: Record<string, string>; stdin?: string } = {}): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    stdinIsTTY: false,
    stderrIsTTY: false,
    readStdin: async () => opts.stdin ?? "",
    prompt: async () => {
      throw new Error("must not prompt when not a TTY");
    },
    env: opts.onlyEnv ?? { KOFRA_CONFIG_DIR: configDir, KOFRA_API: api, ...opts.env },
    cwd: opts.cwd ?? work,
  };
  const code = await run(args, io);
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* human output */
  }
  return { code, stdout, stderr, json };
}

async function project(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(work, name);
  for (const [p, content] of Object.entries(files)) {
    await mkdir(join(dir, p, ".."), { recursive: true });
    await writeFile(join(dir, p), content);
  }
  return dir;
}

const get = (url: string) => fetch(url, { headers: { Accept: "*/*" } });

describe("kofra CLI against a local instance", () => {
  let slug = "";

  it("sets up the instance and saves the owner key without printing it", async () => {
    const r = await cli(["setup", "--email", "owner@example.com", "--json"], { env: { KOFRA_BOOTSTRAP_KEY: BOOTSTRAP } });
    expect(r.code).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.apiKey).toBeUndefined();
    expect(r.stdout).not.toMatch(/dw_[A-Za-z0-9_-]{20}/);
    const credPath = join(configDir, "credentials.json");
    expect((await stat(credPath)).mode & 0o777).toBe(0o600);
    const creds = JSON.parse(await readFile(credPath, "utf8"));
    expect(creds.instances[api].key).toMatch(/^dw_/);

    const again = await cli(["setup", "--email", "x@example.com", "--json"], { env: { KOFRA_BOOTSTRAP_KEY: BOOTSTRAP } });
    expect(again.code).toBe(5);
    expect(again.json.ok).toBe(false);
  });

  it("whoami reports the owner", async () => {
    const r = await cli(["whoami", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ signedIn: true, principal: "member", api, keySource: "saved" });
    expect(r.json.member.email).toBe("owner@example.com");
  });

  it("accepts the former DROPWAY_* variables when no KOFRA_* variable is set", async () => {
    const OLD = "DROPWAY_"; // rebrand:keep
    const saved = await cli(["whoami", "--json"], { onlyEnv: { [`${OLD}CONFIG_DIR`]: configDir, [`${OLD}API`]: api } });
    expect(saved.code, saved.stdout).toBe(0);
    expect(saved.json).toMatchObject({ signedIn: true, api, keySource: "saved" });
    const key = JSON.parse(await readFile(join(configDir, "credentials.json"), "utf8")).instances[api].key;
    const fromEnv = await cli(["whoami", "--json"], { onlyEnv: { [`${OLD}CONFIG_DIR`]: join(work, "legacy-empty-config"), [`${OLD}API`]: api, [`${OLD}API_KEY`]: key } });
    expect(fromEnv.code, fromEnv.stdout).toBe(0);
    expect(fromEnv.json).toMatchObject({ signedIn: true, api, keySource: "env" });
    expect(fromEnv.json.member.email).toBe("owner@example.com");
  });

  it("publishes a folder, skips credentials, and links it in dropway.json", async () => {
    await project("app", {
      "dist/index.html": "<h1>v1</h1><script src='/assets/app.js'></script>",
      "dist/assets/app.js": "console.log('v1')",
      "dist/docs/readme.md": "# Docs",
      "dist/.env": "SECRET=1",
    });
    const cwd = join(work, "app");
    const r = await cli(["publish", "dist", "--json", "-m", "first"], { cwd });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.json).toMatchObject({ ok: true, created: true, unchanged: false, files: 3, uploaded: 3, reused: 0 });
    expect(r.json.version.number).toBe(1);
    slug = r.json.slug;
    expect(r.json.url).toBe(`${api}/s/${slug}/`);
    const page = await get(r.json.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>v1</h1>");
    expect((await get(`${r.json.url}.env`)).status).toBe(404);
    const link = JSON.parse(await readFile(join(cwd, "dropway.json"), "utf8"));
    expect(link).toMatchObject({ api, sites: { dist: slug } });
  });

  it("republishing identical files is 'unchanged' and updates the same site", async () => {
    const r = await cli(["publish", "dist", "--json"], { cwd: join(work, "app") });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ slug, unchanged: true, created: false, uploaded: 0, linkedFrom: "dropway.json" });
    expect(r.json.version.number).toBe(1);
  });

  it("uploads only changed files and can wait until the URL serves the new version", async () => {
    await writeFile(join(work, "app/dist/assets/app.js"), "console.log('v2')");
    const r = await cli(["publish", "dist", "--json", "--wait"], { cwd: join(work, "app") });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ slug, uploaded: 1, reused: 2, live: true });
    expect(r.json.version.number).toBe(2);
    expect(await (await get(`${r.json.url}assets/app.js`)).text()).toBe("console.log('v2')");
  });

  it("lists sites, versions and files", async () => {
    const list = await cli(["list", "--json"]);
    expect(list.json.sites.map((s: { slug: string }) => s.slug)).toContain(slug);
    const versions = await cli(["versions", slug, "--json"]);
    expect(versions.json.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
    expect(versions.json.versions[1].message).toBe("first");
    const files = await cli(["files", slug, "--json"]);
    expect(files.json.files.map((f: { path: string }) => f.path).sort()).toEqual(["assets/app.js", "docs/readme.md", "index.html"]);
    const human = await cli(["versions", slug]);
    expect(human.stdout).toMatch(/v2\s+live/);
  });

  it("restores the previous version by default, or a named one", async () => {
    const back = await cli(["restore", slug, "--json"]);
    expect(back.code).toBe(0);
    expect(back.json).toMatchObject({ restored: true, version: { number: 1 } });
    expect(await (await get(`${api}/s/${slug}/assets/app.js`)).text()).toBe("console.log('v1')");
    const fwd = await cli(["rollback", slug, "v2", "--json"]);
    expect(fwd.json.version.number).toBe(2);
    const missing = await cli(["restore", slug, "v9", "--json"]);
    expect(missing.code).toBe(4);
    expect(missing.json.error.code).toBe("version_not_found");
  });

  it("refuses a stale --base with a conflict exit code", async () => {
    const versions = await cli(["versions", slug, "--json"]);
    const old = versions.json.versions.find((v: { number: number }) => v.number === 1).id;
    await writeFile(join(work, "app/dist/index.html"), "<h1>v3</h1>");
    const r = await cli(["publish", "dist", "--json", "--base", old], { cwd: join(work, "app") });
    expect(r.code).toBe(5);
    expect(r.json.error.code).toBe("version_conflict");
  });

  it("refuses files that look like credentials unless --allow-secrets", async () => {
    const dir = await project("leaky", { "index.html": `<script>const k = "${"AKIA" + "Z".repeat(16)}"</script>` });
    const r = await cli(["publish", dir, "--json", "--no-save"]);
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe("possible_secrets");
    expect(r.json.error.details.findings).toEqual([{ path: "index.html", line: 1, kind: "aws_access_key_id" }]);
    expect(r.stdout).not.toContain("AKIA" + "Z".repeat(16));
    const ok = await cli(["publish", dir, "--json", "--no-save", "--allow-secrets"]);
    expect(ok.code).toBe(0);
  });

  it("publishes to a chosen name, a single file, and a zip", async () => {
    const dir = await project("named", { "index.html": "<p>named</p>" });
    const first = await cli(["publish", dir, "--site", "my-named-site", "--json", "--no-save"]);
    expect(first.json).toMatchObject({ slug: "my-named-site", created: true });
    await writeFile(join(dir, "index.html"), "<p>named 2</p>");
    const second = await cli(["publish", dir, "--site", "my-named-site", "--json", "--no-save"]);
    expect(second.json).toMatchObject({ slug: "my-named-site", created: false, uploaded: 1 });

    await project("single", { "report.md": "# Report\n\nAll good." });
    const single = await cli(["publish", join(work, "single/report.md"), "--json", "--no-save"]);
    expect(single.code).toBe(0);
    const root = await fetch(single.json.url, { headers: { Accept: "text/plain" } });
    expect(await root.text()).toContain("# Report");

    const zipPath = join(work, "site.zip");
    await writeFile(zipPath, zipSync({ "dist/index.html": strToU8("<p>zip</p>"), "dist/a.css": strToU8("p{}") }));
    const zip = await cli(["publish", zipPath, "--json", "--no-save"]);
    expect(zip.code, zip.stdout).toBe(0);
    expect(zip.json.files).toBe(2);
    expect(await (await get(zip.json.url)).text()).toBe("<p>zip</p>");
  });

  it("publishes anonymously (when the instance allows it) and updates with the claim token", async () => {
    const dir = await project("anon", { "index.html": "<p>anon</p>" });
    const r = await cli(["publish", dir, "--anonymous", "--json"], { env: { KOFRA_CONFIG_DIR: join(work, "empty-config") } });
    expect(r.code, r.stdout).toBe(0);
    expect(r.json.claimToken).toMatch(/^dwc_/);
    expect(r.json.expiresAt).toBeTruthy();
    await writeFile(join(dir, "index.html"), "<p>anon 2</p>");
    const upd = await cli(["publish", dir, "--key", r.json.claimToken, "--site", r.json.slug, "--json"], { env: { KOFRA_CONFIG_DIR: join(work, "empty-config") } });
    expect(upd.code, upd.stdout).toBe(0);
    expect(upd.json.version.number).toBe(2);
    // Anonymous publishes are never linked (the link file would point at an expiring site).
    await expect(stat(join(work, "dropway.json"))).rejects.toThrow();
  });

  it("fails cleanly without a key, with a bad key, or when the instance is unreachable", async () => {
    const dir = join(work, "named");
    const nokey = await cli(["publish", dir, "--json"], { env: { KOFRA_CONFIG_DIR: join(work, "empty-config") } });
    expect(nokey.code).toBe(3);
    expect(nokey.json.error.code).toBe("not_logged_in");
    const bad = await cli(["whoami", "--json", "--key", `dw_${"x".repeat(43)}`]);
    expect(bad.code).toBe(3);
    // POST is not retried on network errors (GETs are, with backoff), so this fails fast.
    const down = await cli(["api", "POST", "/sites", "--json", "--api", "http://127.0.0.1:9"]);
    expect(down.code).toBe(7);
    expect(down.json.error.code).toBe("network_error");
  });

  it("deletes only with confirmation", async () => {
    const refused = await cli(["delete", "my-named-site", "--json"]);
    expect(refused.code).toBe(2);
    expect(refused.json.error.code).toBe("confirmation_required");
    const del = await cli(["delete", "my-named-site", "--yes", "--json"]);
    expect(del.code).toBe(0);
    const gone = await cli(["site", "my-named-site", "--json"]);
    expect(gone.code).toBe(4);
  });

  it("has an api escape hatch and logs in and out with a piped key", async () => {
    const me = await cli(["api", "/me"]);
    expect(JSON.parse(me.stdout).principal).toBe("member");
    const key = JSON.parse(await readFile(join(configDir, "credentials.json"), "utf8")).instances[api].key;
    const other = join(work, "other-config");
    const login = await cli(["login", "--json"], { env: { KOFRA_CONFIG_DIR: other }, stdin: `${key}\n` });
    expect(login.code, login.stdout).toBe(0);
    expect(login.json.email).toBe("owner@example.com");
    const out = await cli(["logout", "--json"], { env: { KOFRA_CONFIG_DIR: other } });
    expect(out.json.removed).toBe(true);
    const after = await cli(["whoami", "--json"], { env: { KOFRA_CONFIG_DIR: other } });
    expect(after.code).toBe(3);
    expect(after.json.signedIn).toBe(false);
  });

  it("runs as a real process: the launcher (source) and the bundled build", async () => {
    const env = { ...process.env, KOFRA_CONFIG_DIR: configDir, KOFRA_API: api };
    const runProc = (args: string[]) =>
      new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: work, env });
        let stdout = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout }));
      });
    const viaLauncher = await runProc([join(cliRoot, "bin/kofra.mjs"), "whoami", "--json"]);
    expect(viaLauncher.code).toBe(0);
    expect(JSON.parse(viaLauncher.stdout).signedIn).toBe(true);

    const outfile = join(work, "bundle/kofra.mjs");
    await build({ entryPoints: [join(cliRoot, "src/cli.ts")], bundle: true, platform: "node", format: "esm", target: "node20", outfile, logLevel: "silent" });
    const dir = await project("bundled", { "index.html": "<p>bundled</p>" });
    const viaBundle = await runProc([outfile, "publish", dir, "--json", "--no-save"]);
    expect(viaBundle.code).toBe(0);
    expect(JSON.parse(viaBundle.stdout)).toMatchObject({ ok: true, created: true, uploaded: 1 });
    const missing = await runProc([outfile, "site", "does-not-exist", "--json"]);
    expect(missing.code).toBe(4);
  });
});
