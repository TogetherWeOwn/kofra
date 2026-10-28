import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const cli = fileURLToPath(new URL("../../bin/dropway.mjs", import.meta.url));
const bundle = fileURLToPath(new URL("../../dist/dropway.mjs", import.meta.url));
const transport = fileURLToPath(new URL("./stdin-publish-transport.mjs", import.meta.url));

export const defaultApi = "https://default.invalid";
export const linkedApi = "https://linked.invalid";
export const explicitApi = "https://explicit.invalid";
export const defaultKey = "dw_stdin_default_synthetic_fixture";
export const linkedKey = "dw_stdin_link_synthetic_fixture";
export const explicitKey = "dw_stdin_explicit_synthetic_fixture";
export const envKey = "dw_stdin_env_synthetic_fixture";
export const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export interface StdinWire {
  kind: "fetch";
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

interface FileRead { kind: "fs"; operation: string; path: string }
interface StdinRead { kind: "stdin" }
type Audit = StdinWire | FileRead | StdinRead;

/** Read-only snapshot: catches new files, rewrites and mode changes, not access times. */
async function snapshot(root: string, prefix = ""): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const absolute = join(root, path);
    const stat = await lstat(absolute, { bigint: true });
    rows.push({ path, mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      value: stat.isFile() ? digest(await readFile(absolute)) : "directory" });
    if (stat.isDirectory()) rows.push(...await snapshot(root, path));
  }
  return rows;
}

/** Real executable, real pipe and filesystem; only the external fetch boundary is replaced. */
export async function stdinNodeHarness() {
  const work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "stdin-node-"));
  const home = join(work, "home");
  const cwd = join(home, "project");
  const config = join(home, "config");
  const auditFile = join(work, "audit.jsonl");
  const setupFile = join(work, "setup.json");
  await mkdir(cwd, { recursive: true });
  await mkdir(config);
  await writeFile(auditFile, "");
  await writeFile(setupFile, JSON.stringify({ home, auditFile }));

  return {
    cwd,
    config,
    async dispose() { await rm(work, { recursive: true, force: true }); },
    async link() {
      await writeFile(join(cwd, "dropway.json"), JSON.stringify({ version: 1, api: linkedApi,
        sites: { ".": "linked-project-site", "report.txt": "linked-file-site" } }));
    },
    async credentials() {
      await writeFile(join(config, "credentials.json"), JSON.stringify({ version: 1, default: defaultApi,
        instances: { [defaultApi]: { key: defaultKey }, [linkedApi]: { key: linkedKey } } }), { mode: 0o600 });
    },
    async run(args: string[], input: Uint8Array | null, options: {
      env?: NodeJS.ProcessEnv; timeoutMs?: number; bundled?: boolean; entry?: string;
    } = {}) {
      await writeFile(auditFile, "");
      const before = await snapshot(home);
      const started = Date.now();
      const result = await new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }>((resolveRun, reject) => {
        const child = spawn(process.execPath, ["--import", transport, options.entry ?? (options.bundled ? bundle : cli), ...args], {
          cwd,
          env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "xdg"),
            KOFRA_CONFIG_DIR: config, STDIN_ACCEPTANCE_SETUP: setupFile, NO_COLOR: "1", ...options.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 20_000);
        child.stdout.on("data", bytes => { stdout += bytes; });
        child.stderr.on("data", bytes => { stderr += bytes; });
        child.on("error", error => { clearTimeout(timer); child.kill("SIGKILL"); reject(error); });
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          // An early refusal may close the pipe before the producer finishes.
          if (error.code !== "EPIPE") { clearTimeout(timer); child.kill("SIGKILL"); reject(error); }
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          child.stdin.destroy();
          resolveRun({ code, signal, stdout, stderr, timedOut });
        });
        // null deliberately leaves an otherwise silent pipe OPEN for the deadline test.
        if (input !== null) child.stdin.end(input);
      });
      const elapsedMs = Date.now() - started;
      const audit: Audit[] = (await readFile(auditFile, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(await snapshot(home), "stdin must not write project mappings, credentials or source files").toEqual(before);
      for (const key of [defaultKey, linkedKey, explicitKey, envKey]) {
        expect(result.stdout + result.stderr, "synthetic credential must not appear in output").not.toContain(key);
      }
      return { ...result, elapsedMs,
        wire: audit.filter((entry): entry is StdinWire => entry.kind === "fetch"),
        reads: audit.filter((entry): entry is FileRead => entry.kind === "fs"),
        stdinReads: audit.filter(entry => entry.kind === "stdin").length,
        linkPath: resolve(cwd, "dropway.json"),
      };
    },
  };
}

export type StdinNodeHarness = Awaited<ReturnType<typeof stdinNodeHarness>>;
export type StdinNodeResult = Awaited<ReturnType<StdinNodeHarness["run"]>>;

export function stdinObject(result: StdinNodeResult): any {
  expect(result.timedOut, `CLI exceeded its child deadline: ${result.stdout}${result.stderr}`).toBe(false);
  expect(result.signal).toBeNull();
  const json = JSON.parse(result.stdout);
  expect(result.stdout, "stdout contains exactly one JSON object").toBe(`${JSON.stringify(json, null, 2)}\n`);
  return json;
}
