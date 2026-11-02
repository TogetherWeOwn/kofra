/** A second Ctrl-C must still terminate compare when a filesystem read cannot abort. */
import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("lets a second OS SIGINT terminate a compare blocked in non-abortable stat", async () => {
  const work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "compare-double-sigint-"));
  try {
    const dist = join(work, "dist");
    const config = join(work, "config");
    await mkdir(dist);
    await mkdir(config);
    const bundle = join(work, "kofra.mjs");
    const preload = join(work, "blocked-stat.mjs");
    await build({ entryPoints: [fileURLToPath(new URL("../src/cli.ts", import.meta.url))], bundle: true,
      platform: "node", format: "esm", target: "node20", outfile: bundle, logLevel: "silent" });
    // Only the slow filesystem boundary is substituted. Command dispatch,
    // cancellation handlers, and both OS signals are real. The observer removes
    // itself after the first signal so it cannot mask default termination.
    await writeFile(preload, `
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const nativeStat = fsp.stat.bind(fsp);
fsp.stat = async (path, ...args) => {
  if (String(path) !== process.env.BLOCKED_COMPARE_ROOT) return nativeStat(path, ...args);
  process.once("SIGINT", () => process.send({ type: "first_sigint" }));
  setInterval(() => {}, 1000); // Model a native filesystem operation keeping the process alive.
  process.send({ type: "stat_gate" });
  return new Promise(() => {});
};
syncBuiltinESMExports();
`);
    const child = fork(bundle, ["compare", dist, "--site", "fixture", "--json"], {
      cwd: work, silent: true, execArgv: ["--import", preload],
      env: { ...process.env, HOME: work, KOFRA_CONFIG_DIR: config,
        KOFRA_API: "https://compare-double-sigint.invalid", KOFRA_API_KEY: "dw_synthetic_double_sigint_fixture",
        BLOCKED_COMPARE_ROOT: dist },
    });
    let stdout = "";
    let stderr = "";
    let firstSent = false;
    let secondSent = false;
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
        child.on("message", message => {
          const type = (message as { type?: string }).type;
          if (type === "stat_gate") firstSent = child.kill("SIGINT");
          if (type === "first_sigint") secondSent = child.kill("SIGINT");
        });
      });
      expect(firstSent, stderr).toBe(true);
      expect(secondSent, stderr).toBe(true);
      expect(closed, "second SIGINT must work without the SIGKILL deadline").toEqual({ code: null, signal: "SIGINT" });
      expect(stdout, "neither interrupt produces a partial comparison").toBe("");
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
