/**
 * Live acceptance for `kofra access` (TOG-41690) against a disposable workerd
 * Worker with disposable D1/R2/KV. No production instance is touched.
 *
 * Covers the real `public`/`password` round-trip (including the sign-out on
 * password change), `restricted`/`private` passthrough, missing/foreign and
 * scope refusals, plus subprocess checks of the built CLI. Offline argv,
 * dry-run and password-safety cases live in access-offline.acceptance.test.ts.
 *
 * These tests fail on main (no `access` command) with `unknown_command`.
 *
 * Run: npm run test:cli -- test/access-live.acceptance.test.ts
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, type Io } from "../src/main.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const mainSlug = "access-live-main";
const otherSlug = "access-live-other";
const bootstrap = "access-live-local-bootstrap-0123456789abcdef";
const sentinel1 = "live-sentinel-one-pw-9f8e7d6c5b4a9137845f6a7b8c9d0e1f2";
const sentinel2 = "live-sentinel-two-pw-1a2b3c4d5e6f708192a3b4c5d6e7f8091a2";
const wrongPw = "live-wrong-pw-0000000000000000000000000000000000000000";
// Byte-exact: surrounding spaces are part of the password; the trimmed
// variant is a different (wrong) password at the visitor gate.
const spacedPw = "  live spaced pass phrase 5e6f  ";
const spacedPwTrimmed = "live spaced pass phrase 5e6f";

type Wire = { method: string; url: URL };
type Ran = { code: number; stdout: string; stderr: string; wire: Wire[]; prompts: number };

let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let work: string;
let home: string;
let api: string;
let ownerKey: string;
let readerKey: string;
let restrictedKey: string;
let bundle: string;

function fixtureUrl(path: string, origin: string) {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\x00-\x20\x7f#]/.test(path)) {
    throw new Error("fixture requires an origin-relative path and query");
  }
  const url = new URL(origin);
  const query = path.indexOf("?");
  url.pathname = query < 0 ? path : path.slice(0, query);
  url.search = query < 0 ? "" : path.slice(query);
  return url;
}

async function request(path: string, init: RequestInit = {}, key = ownerKey) {
  const url = fixtureUrl(path, api);
  const headers = new Headers(init.headers);
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return fetch(url, { ...init, headers, redirect: "manual" });
}

async function publish(slug: string, html: string) {
  const body = new FormData();
  body.set("slug", slug);
  body.set("index.html", new File([html], "index.html", { type: "text/html" }));
  const res = await request("/api/v1/publish", { method: "POST", body });
  expect(res.ok, `fixture publish HTTP ${res.status}`).toBe(true);
  return (await res.json()) as any;
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kofra-access-live-"));
  home = join(work, "client");
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(join(home, "dropway.json"), JSON.stringify({ sites: { untouched: "keep-me" } }));
  await writeFile(join(home, "config", "credentials.json"), JSON.stringify({ instances: {} }), { mode: 0o600 });
  await writeFile(join(home, "untouched.txt"), "keep these bytes\n");
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(config, JSON.stringify({
    name: "dropway-access-live-acceptance", main: join(root, "apps/worker/src/index.ts"),
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
    vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
    d1_databases: [{ binding: "DB", database_name: "access-live-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
    r2_buckets: [{ binding: "FILES", bucket_name: "access-live-acceptance-files" }],
    kv_namespaces: [{ binding: "CACHE" }],
  }));
  const wrangler = join(dirname(fileURLToPath(import.meta.resolve("wrangler/package.json"))), "bin/wrangler.js");
  await promisify(execFile)(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config,
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  api = (await worker.url).origin;
  const setup = await request("/api/v1/setup", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "access-fixture@example.com" }),
  }, bootstrap);
  expect(setup.status).toBe(201);
  ownerKey = ((await setup.json()) as any).apiKey.key;
  await publish(mainSlug, "<h1>access live main</h1>");
  await publish(otherSlug, "<h1>access live other</h1>");
  for (const [scopes, site] of [[["sites:read"], undefined], [["sites:read", "sites:write"], otherSlug]] as const) {
    const res = await request("/api/v1/keys", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(site ? { scopes, site } : { scopes }),
    });
    expect(res.ok, `fixture key HTTP ${res.status}`).toBe(true);
    const key = ((await res.json()) as any).key as string;
    if (site) restrictedKey = key;
    else readerKey = key;
  }
  bundle = join(work, "bundle", "kofra.mjs");
  await build({ entryPoints: [join(root, "packages/cli/src/cli.ts")], bundle: true, platform: "node", format: "esm", target: "node20", outfile: bundle, logLevel: "silent" });
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function snapshot(dir = home): Promise<Record<string, string>> {
  const metadata = (info: { mode: bigint; mtimeNs: bigint; ctimeNs: bigint }) => `${info.mode}:${info.mtimeNs}:${info.ctimeNs}`;
  const directory = await stat(dir, { bigint: true });
  const result: Record<string, string> = { ".": metadata(directory) };
  for (const entry of (await readdir(dir)).sort()) {
    const path = join(dir, entry);
    const info = await stat(path, { bigint: true });
    if (info.isDirectory()) {
      for (const [nested, value] of Object.entries(await snapshot(path))) result[`${entry}/${nested}`] = value;
    } else result[entry] = `${metadata(info)}:${(await readFile(path)).toString("base64")}`;
  }
  return result;
}

function assertNoSecrets(output: string) {
  for (const secret of [bootstrap, ownerKey, readerKey, restrictedKey, sentinel1, sentinel2, spacedPw, spacedPwTrimmed]) {
    expect(output.includes(secret), "credentials and visitor passwords must not appear in output").toBe(false);
  }
}

async function cli(args: string[], opts: { key?: string; stdin?: string } = {}): Promise<Ran> {
  const before = await snapshot();
  const wire: Wire[] = [];
  let stdout = "";
  let stderr = "";
  let prompts = 0;
  const io: Io = {
    cwd: home,
    env: { KOFRA_API: api, KOFRA_API_KEY: opts.key ?? ownerKey, KOFRA_CONFIG_DIR: join(home, "config"), HOME: home },
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    stdinIsTTY: false,
    stderrIsTTY: false,
    readStdin: async () => opts.stdin ?? "",
    prompt: async () => {
      prompts++;
      throw new Error("live non-TTY access must not prompt");
    },
    fetch: (async (input: Request) => {
      const url = new URL(input.url);
      expect(url.origin, "CLI must contact only the disposable Worker").toBe(api);
      wire.push({ method: input.method, url });
      return fetch(input);
    }) as Io["fetch"],
  };
  const code = await run(args, io);
  expect(await snapshot(), "access must not write local config or project files").toEqual(before);
  expect(prompts, "non-TTY access must not prompt").toBe(0);
  assertNoSecrets(stdout + stderr);
  return { code, stdout, stderr, wire, prompts };
}

function object(r: Ran) {
  let parsed: any;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`stdout must be exactly one JSON object (exit ${r.code}): ${r.stdout}`);
  }
  expect(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)).toBe(true);
  return parsed;
}

async function passwordProtected(slug: string): Promise<boolean> {
  const res = await request(`/api/v1/sites/${slug}`, {}, ownerKey);
  expect(res.status).toBe(200);
  return ((await res.json()) as any).site.settings.passwordProtected === true;
}

async function ensurePublic(slug: string) {
  const res = await request(`/api/v1/sites/${slug}/access`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "public" }),
  }, ownerKey);
  expect(res.status).toBe(200);
}

async function liveGet(slug: string, cookie?: string) {
  const headers = new Headers({ Accept: "text/html" });
  if (cookie) headers.set("Cookie", cookie);
  return fetch(fixtureUrl(`/s/${slug}/`, api), { headers, redirect: "manual" });
}

async function tryPassword(slug: string, password: string): Promise<{ status: number; cookie: string | null; text: string }> {
  const form = new FormData();
  form.set("password", password);
  form.set("next", `/s/${slug}/`);
  const res = await fetch(fixtureUrl(`/s/${slug}/__dropway/password`, api), { method: "POST", body: form, redirect: "manual" });
  const text = await res.text();
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, cookie: setCookie ? setCookie.split(";")[0]! : null, text };
}

describe("live public/password round-trip on a disposable Worker", () => {
  it("locks with a piped password, signs everyone out on change, and unlocks with public", async () => {
    await ensurePublic(mainSlug);
    expect(await passwordProtected(mainSlug)).toBe(false);
    expect((await liveGet(mainSlug)).status).toBe(200);

    // Lock with the first sentinel via piped stdin.
    const locked = await cli(["access", mainSlug, "--mode", "password", "--yes", "--json"], { stdin: `${sentinel1}\n` });
    expect(locked.code, locked.stdout + locked.stderr).toBe(0);
    expect(locked.wire).toHaveLength(1);
    expect(locked.wire[0]!.method).toBe("PUT");
    expect(locked.wire[0]!.url.pathname).toBe(`/api/v1/sites/${mainSlug}/access`);
    expect(object(locked)).toMatchObject({ ok: true, site: { slug: mainSlug }, access: { mode: "password" } });
    expect(await passwordProtected(mainSlug)).toBe(true);
    const gated = await liveGet(mainSlug);
    expect(gated.status).toBe(401);
    expect(await gated.text()).toMatch(/password protected/i);

    // The password works; a wrong one does not.
    const firstLogin = await tryPassword(mainSlug, sentinel1);
    expect(firstLogin.status).toBe(303);
    expect(firstLogin.cookie).toBeTruthy();
    expect((await liveGet(mainSlug, firstLogin.cookie!)).status).toBe(200);
    const wrong = await tryPassword(mainSlug, wrongPw);
    expect(wrong.status).toBe(401);
    expect(wrong.text).toMatch(/not right/i);

    // Changing the password signs everyone out: the old cookie and old password die.
    const relocked = await cli(["access", mainSlug, "--mode", "password", "--yes", "--json"], { stdin: sentinel2 });
    expect(relocked.code).toBe(0);
    expect(object(relocked)).toMatchObject({ access: { mode: "password" } });
    expect((await liveGet(mainSlug, firstLogin.cookie!)).status).toBe(401);
    expect((await tryPassword(mainSlug, sentinel1)).status).toBe(401);
    const secondLogin = await tryPassword(mainSlug, sentinel2);
    expect(secondLogin.status).toBe(303);
    expect((await liveGet(mainSlug, secondLogin.cookie!)).status).toBe(200);

    // Human output states the gate and the sign-out warning without the password.
    const human = await cli(["access", mainSlug, "--mode", "password", "--yes"], { stdin: sentinel2 });
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/password/i);
    expect(human.stdout).toMatch(/visitor/i);
    expect(human.stdout).toMatch(/signs everyone out/i);

    // Unlock: public clears the gate.
    const opened = await cli(["access", mainSlug, "--mode", "public", "--yes", "--json"]);
    expect(opened.code).toBe(0);
    expect(object(opened)).toMatchObject({ ok: true, site: { slug: mainSlug }, access: { mode: "public" } });
    expect(await passwordProtected(mainSlug)).toBe(false);
    const open = await liveGet(mainSlug);
    expect(open.status).toBe(200);
    expect(await open.text()).toContain("access live main");

    const humanPublic = await cli(["access", mainSlug, "--mode", "public", "--yes"]);
    expect(humanPublic.code).toBe(0);
    expect(humanPublic.stdout).toMatch(/public/i);
    expect(humanPublic.stdout).toMatch(/password/i);
  });

  it.each(["restricted", "private"])("passes live %s through as 501 without changing the site", async (mode) => {
    await ensurePublic(mainSlug);
    const r = await cli(["access", mainSlug, "--mode", mode, "--yes", "--json"]);
    expect(r.wire).toHaveLength(1);
    expect(r.code).toBe(7);
    expect(object(r)).toMatchObject({ ok: false, exitCode: 7, error: { code: "feature_unavailable", status: 501 } });
    expect(await passwordProtected(mainSlug)).toBe(false);
    expect((await liveGet(mainSlug)).status).toBe(200);
  });

  it("keeps stable live exits for missing, foreign and refused callers", async () => {
    const missing = await cli(["access", "ghost-access-live-000", "--mode", "public", "--yes", "--json"]);
    expect(missing.wire).toHaveLength(1);
    expect(missing.code).toBe(4);
    expect(object(missing)).toMatchObject({ ok: false, exitCode: 4, error: { code: "site_not_found", status: 404 } });

    // A key restricted to the other site sees the main site as missing (no leak).
    const foreign = await cli(["access", mainSlug, "--mode", "public", "--yes", "--json"], { key: restrictedKey });
    expect(foreign.wire).toHaveLength(1);
    expect(foreign.code).toBe(4);
    expect(object(foreign)).toMatchObject({ error: { code: "site_not_found" } });

    // A read-only key is refused with its scope error, and the site stays public.
    const refused = await cli(["access", mainSlug, "--mode", "password", "--yes", "--json"], { key: readerKey, stdin: sentinel1 });
    expect(refused.wire).toHaveLength(1);
    expect(refused.code).toBe(3);
    expect(object(refused)).toMatchObject({ ok: false, exitCode: 3, error: { code: "insufficient_scope", status: 403 } });
    expect(await passwordProtected(mainSlug)).toBe(false);
  });

  it("refuses live mutations without --yes and empty passwords before any request", async () => {
    const noYes = await cli(["access", mainSlug, "--mode", "public", "--json"]);
    expect(noYes.wire).toEqual([]);
    expect(noYes.code).toBe(2);
    expect(object(noYes).error.hint).toMatch(/--yes/);

    const empty = await cli(["access", mainSlug, "--mode", "password", "--yes", "--json"], { stdin: "" });
    expect(empty.wire).toEqual([]);
    expect(empty.code).toBe(2);
  });

  it("keeps live dry-run offline even with valid credentials", async () => {
    const r = await cli(["access", mainSlug, "--mode", "password", "--dry-run", "--json"], { stdin: sentinel1 });
    expect(r.code).toBe(0);
    expect(r.wire).toEqual([]);
    expect(object(r)).toEqual({ ok: true, dryRun: true, planVersion: 1, site: mainSlug, mode: "password", passwordSupplied: true });
  });
});

describe("live byte-exact visitor password", () => {
  it("stores the exact spaced password: exact login succeeds, trimmed login fails", async () => {
    await ensurePublic(mainSlug);
    const locked = await cli(["access", mainSlug, "--mode", "password", "--yes", "--json"], { stdin: `${spacedPw}\n` });
    expect(locked.code, locked.stdout + locked.stderr).toBe(0);
    expect(locked.wire).toHaveLength(1);
    expect(object(locked)).toMatchObject({ ok: true, site: { slug: mainSlug }, access: { mode: "password" } });
    expect(await passwordProtected(mainSlug)).toBe(true);
    expect((await liveGet(mainSlug)).status).toBe(401);

    // The trimmed variant is a different password and must be refused.
    const trimmed = await tryPassword(mainSlug, spacedPwTrimmed);
    expect(trimmed.status).toBe(401);
    expect(trimmed.text).toMatch(/not right/i);

    // The exact spaced value the operator supplied must open the gate.
    const exact = await tryPassword(mainSlug, spacedPw);
    expect(exact.status).toBe(303);
    expect(exact.cookie).toBeTruthy();
    expect((await liveGet(mainSlug, exact.cookie!)).status).toBe(200);

    await ensurePublic(mainSlug);
    expect(await passwordProtected(mainSlug)).toBe(false);
  });
});

describe("built CLI subprocess against the disposable Worker", () => {
  it("runs dry-run offline as a non-TTY process with no config writes", async () => {
    const before = await snapshot();
    const execution = promisify(execFile)(process.execPath, [bundle, "access", mainSlug, "--mode", "password", "--dry-run", "--json"], {
      cwd: home, timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: home, KOFRA_CONFIG_DIR: join(home, "config") },
    });
    execution.child.stdin!.end(sentinel1);
    const result = await execution.then(
      (r) => ({ code: 0, stdout: String(r.stdout), stderr: String(r.stderr) }),
      (e: any) => ({ code: typeof e.code === "number" ? e.code : -1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }),
    );
    assertNoSecrets(result.stdout + result.stderr);
    expect(await snapshot()).toEqual(before);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, dryRun: true, planVersion: 1, site: mainSlug, mode: "password", passwordSupplied: true });
  });

  it("sets public through the built CLI as a non-TTY process", async () => {
    await ensurePublic(mainSlug);
    // Lock first via the API so the subprocess has a real mutation to clear.
    const lock = await request(`/api/v1/sites/${mainSlug}/access`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "password", password: sentinel1 }),
    }, ownerKey);
    expect(lock.status).toBe(200);
    const before = await snapshot();
    const child = spawn(process.execPath, [bundle, "access", mainSlug, "--mode", "public", "--yes", "--json"], {
      cwd: home, timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: home, KOFRA_CONFIG_DIR: join(home, "config"), KOFRA_API: api, KOFRA_API_KEY: ownerKey },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => void (stdout += d));
    child.stderr.on("data", (d) => void (stderr += d));
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assertNoSecrets(stdout + stderr);
    expect(await snapshot()).toEqual(before);
    expect(code, stdout + stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, site: { slug: mainSlug }, access: { mode: "public" } });
    expect(await passwordProtected(mainSlug)).toBe(false);
  });
});
