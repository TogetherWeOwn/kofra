/**
 * Live acceptance for `kofra claim <site> --token <claimToken>` (TOG-43034
 * Test Author handoff; Builder: TOG-43037) against a disposable workerd
 * Worker with disposable D1/R2/KV and anonymous publishing on. No production
 * instance is touched. Offline argv, help and dry-run-shape cases live in
 * claim-offline.acceptance.test.ts; both files share
 * fixtures/claim-harness.ts (one runner, one redaction guard).
 *
 * Server truth pinned here was verified against the real Worker on main
 * (2026-10-27 probe): unknown site and wrong token both answer 404
 * site_not_found (indistinguishable by design, no existence leak); a
 * malformed (non-dwc_) token answers 400 claim_token_required; a read-only
 * key answers 403 insufficient_scope; an expired-but-present anonymous site
 * is rescued by a successful claim (claimSite has no expiry gate); a repeat
 * claim by the owning tenant answers 200 with the same shape (no
 * already-flag, so truthful already-wording must come from a server read,
 * never invention); the claim token answers 401 after the claim.
 *
 * These tests fail on main (no `claim` command) with `unknown_command`.
 * Every negative case calls expectKnownCommand first so a missing command
 * cannot accidentally pass.
 *
 * Run: npm run test:cli -- test/claim-live.acceptance.test.ts
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Io } from "../src/main.ts";
import { claimObject, createClaimFiles, expectKnownCommand, runClaim, SecretSet, type ClaimFiles, type ClaimRan } from "./fixtures/claim-harness.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bootstrap = "claim-live-local-bootstrap-0123456789abcdef";
const GHOST = "ghost-claim-acceptance-000";
const WRONG_TOKEN = "dwc_claim_acceptance_wrong_token_000000000001";
const MALFORMED_TOKEN = "not-a-claim-token";

let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let work: string;
let files: ClaimFiles;
let secrets: SecretSet;
let api: string;
let ownerKey: string;
let readerKey: string;
let bundle: string;

function fixtureUrl(path: string, origin: string): URL {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\x00-\x20\x7f#]/.test(path)) {
    throw new Error("fixture requires an origin-relative path and query");
  }
  const url = new URL(origin);
  const query = path.indexOf("?");
  url.pathname = query < 0 ? path : path.slice(0, query);
  url.search = query < 0 ? "" : path.slice(query);
  return url;
}

async function request(path: string, init: RequestInit = {}, key: string | null = ownerKey): Promise<Response> {
  const url = fixtureUrl(path, api);
  const headers = new Headers(init.headers);
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return fetch(url, { ...init, headers, redirect: "manual" });
}

async function json(path: string, init: RequestInit = {}, key: string | null = ownerKey): Promise<{ status: number; body: any }> {
  const res = await request(path, init, key);
  return { status: res.status, body: (await res.json()) as any };
}

/** Publish one anonymous file; registers the claim token as a never-print secret. */
async function publishAnon(tag: string): Promise<{ slug: string; claimToken: string; expiresAt: string; url: string; versionId: string }> {
  const res = await request(
    "/api/v1/publish",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: [{ path: "index.html", content: `<p>claim acceptance ${tag}</p>` }] }) },
    null,
  );
  expect(res.status, `fixture publish HTTP ${res.status}`).toBe(201);
  const body = (await res.json()) as any;
  expect(body.claimToken).toMatch(/^dwc_/);
  secrets.add(body.claimToken);
  return { slug: body.slug, claimToken: body.claimToken, expiresAt: body.expiresAt, url: body.url, versionId: body.version.id };
}

async function expireSite(slug: string): Promise<void> {
  const res = await request("/api/v1/__fixture/expire-site", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) }, bootstrap);
  expect(res.status, `fixture expire HTTP ${res.status}`).toBe(200);
}

async function readSite(slug: string, key: string | null): Promise<{ status: number; body: any }> {
  return json(`/api/v1/sites/${encodeURIComponent(slug)}`, {}, key);
}

async function versionIds(slug: string): Promise<string[]> {
  const res = await json(`/api/v1/sites/${encodeURIComponent(slug)}/versions`);
  expect(res.status).toBe(200);
  return (res.body.versions as Array<{ id: string }>).map((v) => v.id).sort();
}

async function cli(args: string[], opts: { key?: string | null; stdin?: string } = {}): Promise<ClaimRan> {
  const key = opts.key === undefined ? ownerKey : opts.key;
  return runClaim(files, args, {
    env: { KOFRA_API: api, ...(key === null ? {} : { KOFRA_API_KEY: key }), KOFRA_CONFIG_DIR: files.configDir, HOME: files.home },
    stdin: opts.stdin,
    fetchImpl: (async (input: Request) => fetch(input)) as Io["fetch"],
    allowedOrigin: api,
    expectedAuth: key,
    secrets,
  });
}

/** The mutation POSTs a run made; the claim endpoint takes exactly one per claim. */
function claimPosts(r: ClaimRan, slug: string) {
  return r.wire.filter((w) => w.method === "POST" && w.url.pathname === `/api/v1/sites/${slug}/claim`);
}

beforeAll(async () => {
  secrets = new SecretSet();
  secrets.add(bootstrap, WRONG_TOKEN, MALFORMED_TOKEN);
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kofra-claim-live-"));
  files = await createClaimFiles("kofra-claim-live-home-");
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  await writeFile(
    config,
    JSON.stringify({
      name: "dropway-claim-cli-acceptance",
      main: join(root, "test/fixtures/claim-cli.worker.ts"),
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "true" },
      d1_databases: [{ binding: "DB", database_name: "claim-cli-acceptance", migrations_dir: join(root, "packages/core/migrations") }],
      r2_buckets: [{ binding: "FILES", bucket_name: "claim-cli-acceptance-files" }],
      kv_namespaces: [{ binding: "CACHE" }],
    }),
  );
  const wrangler = join(dirname(fileURLToPath(import.meta.resolve("wrangler/package.json"))), "bin/wrangler.js");
  await promisify(execFile)(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
    cwd: root,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  worker = await unstable_startWorker({
    config,
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  api = (await worker.url).origin;
  const setup = await request("/api/v1/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "claim-fixture@example.com" }) }, bootstrap);
  expect(setup.status).toBe(201);
  ownerKey = ((await setup.json()) as any).apiKey.key;
  secrets.add(ownerKey);
  const reader = await json("/api/v1/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "claim-reader", scopes: ["sites:read"] }) });
  expect(reader.status).toBe(201);
  readerKey = reader.body.key as string;
  secrets.add(readerKey);
  bundle = join(work, "bundle", "kofra.mjs");
  await build({ entryPoints: [join(root, "packages/cli/src/cli.ts")], bundle: true, platform: "node", format: "esm", target: "node20", outfile: bundle, logLevel: "silent" });
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
  await files?.cleanup();
  if (work) await rm(work, { recursive: true, force: true });
});

describe("golden claim from the terminal", () => {
  it("(1) claims an anonymous site with --json and shows it owned", async () => {
    const site = await publishAnon("golden-json");
    expect((await readSite(site.slug, ownerKey)).status, "owner cannot see the anonymous site before the claim").toBe(404);

    const r = await cli(["claim", site.slug, "--token", site.claimToken, "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.prompts).toBe(0);
    const posts = claimPosts(r, site.slug);
    expect(posts, "exactly one claim mutation").toHaveLength(1);
    expect(r.wire.length, "at most one server-truth pre-read plus the claim").toBeLessThanOrEqual(2);
    expect(r.wire.every((w) => w.authenticated), "every request carries the API key").toBe(true);
    expect(posts[0]!.bodyKeys, "the token travels as one claimToken body field").toEqual(["claimToken"]);

    const out = claimObject(r);
    expect(out).toMatchObject({ ok: true, site: { slug: site.slug, anonymous: false, expiresAt: null }, url: expect.any(String) });
    const owned = await readSite(site.slug, ownerKey);
    expect(owned.status).toBe(200);
    expect(owned.body.site).toMatchObject({ slug: site.slug, anonymous: false, expiresAt: null });
    expect(out.url).toBe(owned.body.site.url);
    expect(owned.body.site.currentVersionId).toBe(site.versionId);
    expect((await readSite(site.slug, site.claimToken)).status, "the claim token stops working").toBe(401);
  });

  it("human success prints the kept URL, the slug and the owner dashboard link", async () => {
    const site = await publishAnon("golden-human");
    const r = await cli(["claim", site.slug, "--token", site.claimToken]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const owned = await readSite(site.slug, ownerKey);
    expect(owned.status).toBe(200);
    expect(r.stdout).toContain(site.slug);
    expect(r.stdout).toContain(owned.body.site.url);
    expect(r.stdout).toContain("/dashboard");
  });
});

describe("claim refusals keep the site untouched", () => {
  it("(2) unknown site stays not-found without leaking", async () => {
    const victim = await publishAnon("unknown-victim");
    const r = await cli(["claim", GHOST, "--token", victim.claimToken, "--json"]);
    expect(r.code).toBe(4);
    expectKnownCommand(r);
    expect(claimPosts(r, GHOST)).toHaveLength(1);
    expect(claimObject(r)).toMatchObject({ ok: false, exitCode: 4, error: { code: "site_not_found", status: 404, hint: expect.any(String) } });
    const still = await readSite(victim.slug, victim.claimToken);
    expect(still.status).toBe(200);
    expect(still.body.site).toMatchObject({ slug: victim.slug, anonymous: true, expiresAt: victim.expiresAt });
  });

  it("(3) a wrong token is refused and the original token keeps working", async () => {
    const site = await publishAnon("bad-token");
    const r = await cli(["claim", site.slug, "--token", WRONG_TOKEN, "--json"]);
    expect(r.code).toBe(4);
    expectKnownCommand(r);
    expect(claimPosts(r, site.slug)).toHaveLength(1);
    expect(claimObject(r)).toMatchObject({ ok: false, exitCode: 4, error: { code: "site_not_found", status: 404 } });
    const still = await readSite(site.slug, site.claimToken);
    expect(still.status).toBe(200);
    expect(still.body.site).toMatchObject({ slug: site.slug, anonymous: true, expiresAt: site.expiresAt });
    expect((await readSite(site.slug, ownerKey)).status).toBe(404);
  });

  it("(3b) a malformed token is refused without mutating or leaking", async () => {
    // Both designs are acceptable: pass the token to the server (400
    // claim_token_required -> exit 6) or validate the dwc_ shape locally
    // (exit 2 with a token hint, like `login`). What is pinned: refused,
    // silent about the value, and the site untouched.
    const site = await publishAnon("malformed-token");
    const r = await cli(["claim", site.slug, "--token", MALFORMED_TOKEN, "--json"]);
    expectKnownCommand(r);
    expect([2, 6], `malformed token exit, got ${r.code}: ${r.stdout}${r.stderr}`).toContain(r.code);
    if (r.code === 6) {
      expect(claimPosts(r, site.slug)).toHaveLength(1);
      expect(claimObject(r)).toMatchObject({ ok: false, exitCode: 6, error: { code: "claim_token_required", status: 400 } });
    } else {
      expect(claimPosts(r, site.slug)).toHaveLength(0);
      expect(String(claimObject(r).error.hint ?? "")).toMatch(/token/i);
    }
    const still = await readSite(site.slug, site.claimToken);
    expect(still.status).toBe(200);
    expect(still.body.site).toMatchObject({ slug: site.slug, anonymous: true });
  });

  it("(4) an expired anonymous site is rescued by claiming it", async () => {
    // Verified server behaviour (main, 2026-10-27): claimSite has no expiry
    // gate, so a past-expiry but not yet cleaned site claims successfully and
    // stops expiring. The CLI reports that truthfully; it must not invent an
    // expiry refusal the server never returns.
    const site = await publishAnon("expired");
    expect(Date.parse((await readSite(site.slug, site.claimToken)).body.site.expiresAt)).toBeGreaterThan(Date.now());
    await expireSite(site.slug);
    expect(Date.parse((await readSite(site.slug, site.claimToken)).body.site.expiresAt), "fixture backdated the expiry").toBeLessThan(Date.now());

    const r = await cli(["claim", site.slug, "--token", site.claimToken, "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(claimObject(r)).toMatchObject({ ok: true, site: { slug: site.slug, anonymous: false, expiresAt: null } });
    const owned = await readSite(site.slug, ownerKey);
    expect(owned.status).toBe(200);
    expect(owned.body.site).toMatchObject({ slug: site.slug, anonymous: false, expiresAt: null });
    expect((await readSite(site.slug, site.claimToken)).status).toBe(401);
  });
});

describe("claim dry-run and idempotence", () => {
  it("(6) --dry-run performs no mutation", async () => {
    const site = await publishAnon("dry-run");
    const before = (await readSite(site.slug, site.claimToken)).body;

    const r = await cli(["claim", site.slug, "--token", site.claimToken, "--dry-run", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toEqual([]);
    expect(r.prompts).toBe(0);
    expect(claimObject(r)).toMatchObject({ ok: true, dryRun: true, site: site.slug, operation: "claim_site" });

    const after = (await readSite(site.slug, site.claimToken)).body;
    expect(after).toEqual(before);
    expect((await readSite(site.slug, ownerKey)).status, "still invisible to the owner").toBe(404);
  });

  it("dry-run needs no --token and still mutates nothing", async () => {
    const site = await publishAnon("dry-run-no-token");
    const before = (await readSite(site.slug, site.claimToken)).body;
    const r = await cli(["claim", site.slug, "--dry-run", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toEqual([]);
    expect(claimObject(r)).toMatchObject({ ok: true, dryRun: true, site: site.slug });
    expect((await readSite(site.slug, site.claimToken)).body).toEqual(before);
  });

  it("(7) claiming twice reports the already-owned state with exit 0", async () => {
    // The server answers a repeat claim with the same 200 shape (no
    // already-flag), so the already-wording below must come from a server
    // read (e.g. a pre-read showing the caller already owns the site), never
    // from client invention.
    const site = await publishAnon("double");
    const first = await cli(["claim", site.slug, "--token", site.claimToken, "--json"]);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const versionsBefore = await versionIds(site.slug);

    const second = await cli(["claim", site.slug, "--token", site.claimToken]);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain(site.slug);
    expect(second.stdout).toMatch(/already|unchanged/);

    const third = await cli(["claim", site.slug, "--token", site.claimToken, "--json"]);
    expect(third.code, third.stdout + third.stderr).toBe(0);
    expect(claimObject(third)).toMatchObject({ ok: true, site: { slug: site.slug, anonymous: false } });
    expect(await versionIds(site.slug), "repeat claims create no versions").toEqual(versionsBefore);
    expect((await readSite(site.slug, site.claimToken)).status).toBe(401);
  });
});

describe("claim credentials and exit codes", () => {
  it("(8) the claim token never appears in output or request URLs", async () => {
    // The harness already redacts every registered secret on every run; this
    // case names the invariant explicitly on a fresh golden plus an error.
    const site = await publishAnon("redaction");
    const ok = await cli(["claim", site.slug, "--token", site.claimToken, "--json"]);
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout + ok.stderr).not.toContain(site.claimToken);
    expect(ok.wire.map((w) => w.url.href).join("\n")).not.toContain("dwc_");

    const other = await publishAnon("redaction-error");
    const bad = await cli(["claim", other.slug, "--token", WRONG_TOKEN, "--json"]);
    expect(bad.code).toBe(4);
    expectKnownCommand(bad);
    expect(bad.stdout + bad.stderr).not.toContain(WRONG_TOKEN);
    expect(bad.stdout + bad.stderr).not.toContain(other.claimToken);
  });

  it("(9) exit codes match the CLI contract", async () => {
    const golden = await publishAnon("exits-golden");
    const r0 = await cli(["claim", golden.slug, "--token", golden.claimToken, "--json"]);
    expect(r0.code, r0.stdout + r0.stderr).toBe(0);

    const other = await publishAnon("exits-errors");
    const r4a = await cli(["claim", GHOST, "--token", other.claimToken, "--json"]);
    expect(r4a.code).toBe(4);
    expectKnownCommand(r4a);

    const r4b = await cli(["claim", other.slug, "--token", WRONG_TOKEN, "--json"]);
    expect(r4b.code).toBe(4);
    expectKnownCommand(r4b);

    const r2 = await cli(["claim", other.slug, "--json"]);
    expect(r2.code).toBe(2);
    expectKnownCommand(r2);
    expect(r2.wire).toEqual([]);
    expect(r2.prompts).toBe(0);

    const r3a = await cli(["claim", other.slug, "--token", other.claimToken, "--json"], { key: null });
    expect(r3a.code).toBe(3);
    expectKnownCommand(r3a);
    expect(r3a.wire).toEqual([]);

    const r3b = await cli(["claim", other.slug, "--token", other.claimToken, "--json"], { key: readerKey });
    expect(r3b.code).toBe(3);
    expectKnownCommand(r3b);
    expect(claimObject(r3b)).toMatchObject({ ok: false, exitCode: 3, error: { code: "insufficient_scope", status: 403 } });
    expect((await readSite(other.slug, other.claimToken)).body.site).toMatchObject({ anonymous: true });

    const rDry = await cli(["claim", other.slug, "--dry-run", "--json"]);
    expect(rDry.code).toBe(0);
    expect(rDry.wire).toEqual([]);

    const keep = await cli(["claim", other.slug, "--token", other.claimToken, "--json"]);
    expect(keep.code).toBe(0);
    const rAgain = await cli(["claim", other.slug, "--token", other.claimToken, "--json"]);
    expect(rAgain.code).toBe(0);
  });
});

describe("built CLI subprocess against the disposable Worker", () => {
  it("dry-runs offline as a non-TTY process with no config writes", async () => {
    const execution = promisify(execFile)(process.execPath, [bundle, "claim", "some-site", "--dry-run", "--json"], {
      cwd: files.home,
      timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: files.home, KOFRA_CONFIG_DIR: files.configDir },
    });
    const result = await execution.then(
      (r) => ({ code: 0, stdout: String(r.stdout), stderr: String(r.stderr) }),
      (e: any) => ({ code: typeof e.code === "number" ? e.code : -1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }),
    );
    secrets.assertAbsent(result.stdout, "subprocess stdout");
    secrets.assertAbsent(result.stderr, "subprocess stderr");
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, dryRun: true, site: "some-site", operation: "claim_site" });
  });

  it("claims through the built CLI as a non-TTY process", async () => {
    const site = await publishAnon("subprocess");
    const child = spawn(process.execPath, [bundle, "claim", site.slug, "--token", site.claimToken, "--json"], {
      cwd: files.home,
      timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: files.home, KOFRA_CONFIG_DIR: files.configDir, KOFRA_API: api, KOFRA_API_KEY: ownerKey },
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
    secrets.assertAbsent(stdout, "subprocess stdout");
    secrets.assertAbsent(stderr, "subprocess stderr");
    expect(code, stdout + stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, site: { slug: site.slug, anonymous: false } });
    expect((await readSite(site.slug, ownerKey)).body.site).toMatchObject({ slug: site.slug, anonymous: false, expiresAt: null });
  });
});
