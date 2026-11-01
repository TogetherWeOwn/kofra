import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The offline --dry-run plan must not only avoid writing local state, it must
// not read it either: instance resolution (./dropway.json, credentials.json)
// happens only on the network path. Snapshots and hashes cannot observe a
// read, so both files are FIFOs with no writer: any read blocks at open and
// this test times out instead of passing, while the correct plan exits at
// once without touching either path.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
let root = "";
let entry = "";

beforeAll(async () => {
  root = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "settings-offline-guard-"));
  entry = join(root, "bundle/dropway.mjs");
  await build({ entryPoints: [join(repoRoot, "packages/cli/src/cli.ts")], bundle: true, platform: "node",
    format: "esm", target: "node20", outfile: entry, logLevel: "silent" });
}, 120_000);

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe.runIf(process.platform !== "win32")("settings --dry-run config-read guard", () => {
  it("prints the plan without opening ./dropway.json or credentials.json", async () => {
    const project = join(root, "project"), config = join(root, "config");
    await mkdir(project); await mkdir(config);
    execFileSync("mkfifo", [join(project, "dropway.json")]);
    execFileSync("mkfifo", [join(config, "credentials.json")]);

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
      const child = spawn(process.execPath, [entry, "settings", "settings-fixture", "--spa", "false", "--dry-run", "--json"], {
        cwd: project,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, CI: "true", NO_COLOR: "1",
          KOFRA_CONFIG_DIR: config, KOFRA_API: "https://instance.test", KOFRA_API_KEY: "dw_offline_guard_synthetic" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("dry-run blocked opening local state, or prompted/hung"));
      }, 8_000);
      child.stdout.on("data", (value) => { stdout += value; });
      child.stderr.on("data", (value) => { stderr += value; });
      child.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("close", (code) => { clearTimeout(timeout); resolveRun({ code, stdout, stderr }); });
      child.stdin.end();
    });

    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, dryRun: true, site: "settings-fixture", patch: { spa: false } });
    expect(result.stdout + result.stderr).not.toContain("dw_offline_guard_synthetic");
  }, 30_000);
});
