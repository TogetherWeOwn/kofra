/** Real process boundary: matrix 22–25 and generated help/discovery. */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const API = "https://process-fixture.example.test";
const KEY = "dw_test_ProcessCanary0123456789";
const guard = fileURLToPath(new URL("./helpers/explain-config-guard.mjs", import.meta.url));
let work: string;
let cwd: string;
let config: string;
let entry: string;

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kofra-explain-process-"));
  cwd = join(work, "project");
  config = join(work, "custom-path-canary");
  entry = join(work, "cli.mjs");
  await mkdir(cwd);
  await mkdir(config);
  await writeFile(join(config, "credentials.json"), JSON.stringify({ default: API, instances: { [API]: { key: KEY } } }));
  await writeFile(join(cwd, "dropway.json"), JSON.stringify({ api: API, sites: { dist: "chosen-site" } }));
  await build({ entryPoints: [fileURLToPath(new URL("../src/cli.ts", import.meta.url))], outfile: entry, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
});
afterAll(async () => { if (work) await rm(work, { recursive: true, force: true }); });

async function cli(args: string[], options: { guarded?: boolean; openStdin?: boolean } = {}) {
  const files = [join(config, "credentials.json"), join(cwd, "dropway.json")];
  const before = await Promise.all(files.map(async (p) => [await readFile(p, "utf8"), (await stat(p, { bigint: true })).mtimeNs]));
  const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // Intentionally no inherited credentials, network/proxy settings or loaders.
    const child = spawn(process.execPath, [...(options.guarded ? ["--import", guard] : []), entry, ...args], {
      cwd, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: work, KOFRA_CONFIG_DIR: config, NO_COLOR: "1", CI: "true" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("diagnostic timed out; it may have read stdin or prompted")); }, 4000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    if (!options.openStdin) child.stdin.end();
  });
  const after = await Promise.all(files.map(async (p) => [await readFile(p, "utf8"), (await stat(p, { bigint: true })).mtimeNs]));
  expect(after, "actual CLI must leave files and modification times unchanged").toEqual(before);
  expect(r.stdout + r.stderr).not.toContain(KEY);
  expect(r.stdout + r.stderr).not.toContain("EXPLAIN_FORBIDDEN_SIDE_EFFECT");
  return r;
}

describe("offline explain-config as a bundled real CLI process", () => {
  it("22/23/24: DNS/network/writes sabotaged produce exactly the same bytes", async () => {
    const ordinary = await cli(["explain-config", "dist", "--json"]);
    expect(ordinary.code, ordinary.stderr + ordinary.stdout).toBe(0);
    expect(JSON.parse(ordinary.stdout)).toMatchObject({ schema: "kofra.explain-config/v1", status: "ready", exitCode: 0, projectLink: { mapping: { key: "dist", slug: "chosen-site" } } });
    const guarded = await cli(["explain-config", "dist", "--json"], { guarded: true });
    expect(guarded).toEqual(ordinary);
    const repeat = await cli(["explain-config", "dist", "--json"], { guarded: true });
    expect(repeat).toEqual(guarded);
  });

  it.each([false, true])("25: piped stdout with stdin held open=%s exits promptly without consuming input", async (openStdin) => {
    const r = await cli(["explain-config", "--json"], { guarded: true, openStdin });
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ schema: "kofra.explain-config/v1", status: "ready", key: { kind: "api_key" }, configDir: { path: null } });
  });

  it("global help discovers exactly one token-efficient command table line", async () => {
    const r = await cli(["help"], { guarded: true });
    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n").filter((line) => /^\s*explain-config\s/.test(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Show which configuration wins, without contacting anything");
  });

  it.each([["help", "explain-config"], ["explain-config", "--help"]].map((args) => ({ args })))("topic help $args shows usage and safe exit-3 guidance", async ({ args }) => {
    const r = await cli(args, { guarded: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("explain-config [path]");
    for (const flag of ["--api", "--key", "--json", "-q"]) expect(r.stdout).toContain(flag);
    expect(r.stdout).toMatch(/--anonymous/);
    expect(r.stdout).toMatch(/exit\s+3/i);
    expect(r.stdout).toMatch(/(?:never|do not|don't).*auto.?login/i);
    expect(r.stdout).toMatch(/CLI_DIAGNOSTICS\.md/);
    expect(r.stderr).toBe("");
  });
});
