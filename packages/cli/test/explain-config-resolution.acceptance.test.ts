/**
 * Compatibility pins for diagnostic matrix 35 and malformed-but-usable links.
 * These must be GREEN before implementation: classification must not tighten
 * existing publish/login resolution. No diagnostic or config helper is mocked.
 * Run: npm run test:cli -- test/explain-config-resolution.acceptance.test.ts
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type Io } from "../src/main.ts";

const API = "https://permissive-config.example.test";
const KEY = "dw_test_PermissiveResolverCanary0123456789";
const SITE = "linked-fixture-site";
let work: string;
let cwd: string;
let config: string;

beforeEach(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kofra-explain-resolution-"));
  cwd = join(work, "project");
  config = join(work, "config");
  await mkdir(join(cwd, "dist"), { recursive: true });
  await mkdir(config);
  await writeFile(join(cwd, "dist", "index.html"), "<h1>synthetic publish fixture</h1>");
});
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

async function seed(kind: "credentials" | "project") {
  await writeFile(join(config, "credentials.json"), JSON.stringify({
    default: kind === "credentials" ? API : "https://shadowed-default.example.test",
    instances: { [API]: { key: KEY }, ...(kind === "credentials" ? { unrelated: null } : {}) },
  }));
  // The unrelated non-string mapping makes the project file invalid_shape but
  // cannot veto its usable api or the requested string mapping in publish.
  if (kind === "project") await writeFile(join(cwd, "dropway.json"), JSON.stringify({ api: API, sites: { dist: SITE, unrelated: 17 } }));
}

async function command(args: string[], fetch: NonNullable<Io["fetch"]>) {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    cwd, env: { KOFRA_CONFIG_DIR: config },
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
    stdinIsTTY: false, stderrIsTTY: false,
    readStdin: async () => { throw new Error("regression fixture must not read stdin"); },
    prompt: async () => { throw new Error("regression fixture must not prompt"); },
    fetch,
  };
  const code = await run(args, io);
  expect(code, stdout + stderr).toBe(0);
  expect(stdout + stderr, "neither publish nor login may print the synthetic saved key").not.toContain(KEY);
  return JSON.parse(stdout);
}

describe("diagnostics must not change existing resolver behavior", () => {
  it.each(["credentials", "project"] as const)("publish still uses malformed-but-usable %s", async (kind) => {
    await seed(kind);
    const beforeCredentials = await readFile(join(config, "credentials.json"), "utf8");
    const beforeLink = kind === "project" ? await readFile(join(cwd, "dropway.json"), "utf8") : null;
    const wire: { method: string; path: string; origin: string; auth: string | null }[] = [];
    const version = { id: "ver_synthetic", number: 1 };
    const result = await command(["publish", "dist", ...(kind === "credentials" ? ["--site", SITE] : []), "--json", "--no-save"], async (request) => {
      const url = new URL(request.url);
      wire.push({ method: request.method, path: url.pathname, origin: url.origin, auth: request.headers.get("authorization") });
      if (request.method === "POST" && url.pathname === `/api/v1/sites/${SITE}/deploys`) {
        const manifest = await request.json() as { files: { path: string }[] };
        expect(manifest.files.map((f) => f.path)).toEqual(["index.html"]);
        return Response.json({ unchanged: true, deploy: version, missing: [], uploads: [], finalizeUrl: null });
      }
      if (request.method === "GET" && url.pathname === `/api/v1/sites/${SITE}`) {
        return Response.json({ site: { slug: SITE, url: `${API}/s/${SITE}/`, currentVersion: version } });
      }
      throw new Error("unexpected request in permissive-config regression fixture");
    });
    expect(wire).toEqual([
      { method: "POST", path: `/api/v1/sites/${SITE}/deploys`, origin: API, auth: `Bearer ${KEY}` },
      { method: "GET", path: `/api/v1/sites/${SITE}`, origin: API, auth: `Bearer ${KEY}` },
    ]);
    expect(result).toMatchObject({ ok: true, slug: SITE, unchanged: true, created: false, uploaded: 0 });
    if (kind === "project") expect(result.linkedFrom).toBe("dropway.json");
    expect(await readFile(join(config, "credentials.json"), "utf8")).toBe(beforeCredentials);
    if (beforeLink !== null) expect(await readFile(join(cwd, "dropway.json"), "utf8")).toBe(beforeLink);
  });

  it.each(["credentials", "project"] as const)("login still resolves the origin from malformed-but-usable %s", async (kind) => {
    await seed(kind);
    const calls: string[] = [];
    const result = await command(["login", "--key", KEY, "--json"], async (request) => {
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
      calls.push(request.url);
      return Response.json({ principal: "member", member: { id: "mem_fixture", email: "fixture@example.test", role: "owner" }, tenant: { id: "tenant_fixture" }, scopes: ["sites:write"] });
    });
    expect(calls).toEqual([`${API}/api/v1/me`]);
    expect(result).toMatchObject({ ok: true, api: API, email: "fixture@example.test" });
    // Login is deliberately not subject to explain-config's no-write sentinel:
    // its existing save behavior is part of the regression being protected.
    const persisted = JSON.parse(await readFile(join(config, "credentials.json"), "utf8"));
    expect(persisted.default).toBe(API);
    expect(persisted.instances[API].key).toBe(KEY);
    if (kind === "credentials") expect(persisted.instances.unrelated).toBeNull();
  });
});
