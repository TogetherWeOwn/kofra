/** Test-only CLI boundary; no download, path validation or integrity implementation. */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { run, type Io } from "../../src/main.ts";

export const sentinelKey = "dw_pull_disposable_sentinel_not_a_live_key";
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export type Wire = { url: URL; method: string };
export type Ran = { code: number; stdout: string; stderr: string; wire: Wire[] };

export async function tree(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    throw e;
  })).sort()) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) {
      for (const [child, bytes] of Object.entries(await tree(path))) result[`${name}/${child}`] = bytes;
    } else result[name] = (await readFile(path)).toString("base64");
  }
  return result;
}

export function object(result: Ran): any {
  let body: any;
  try { body = JSON.parse(result.stdout); } catch {
    throw new Error(`Expected exactly one JSON object; exit=${result.code}, stdout=${result.stdout}, stderr=${result.stderr}`);
  }
  expect(body !== null && typeof body === "object" && !Array.isArray(body)).toBe(true);
  return body;
}

export function receipt(result: Ran, site: string, versionId: string, dir: string) {
  const body = object(result);
  expect(Object.keys(body).sort()).toEqual(["dir", "failures", "files", "site", "versionId"]);
  expect(body).toMatchObject({ site, versionId, dir, files: expect.any(Array), failures: expect.any(Array) });
  for (const file of body.files) {
    expect(Object.keys(file).sort()).toEqual(["path", "sha256", "size"]);
    expect(file).toMatchObject({ path: expect.any(String), size: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  }
  for (const failure of body.failures) {
    expect(Object.keys(failure).sort()).toEqual(["code", "message", "path"]);
    expect(failure).toMatchObject({ path: expect.any(String), code: expect.stringMatching(/^[a-z][a-z0-9_]*$/), message: expect.any(String) });
    expect(failure.message.trim().length).toBeGreaterThan(0);
  }
  return body;
}

export async function pullHarness() {
  const work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kofra-pull-"));
  const cwd = join(work, "project");
  const config = join(work, "config");
  await mkdir(cwd);
  await mkdir(config);
  await writeFile(join(config, "credentials.json"), JSON.stringify({ instances: {} }) + "\n", { mode: 0o600 });
  await writeFile(join(cwd, "dropway.json"), JSON.stringify({ sites: { untouched: "keep-me" } }) + "\n");
  return {
    work, cwd, config,
    async cli(args: string[], options: {
      api: string; key?: string; env?: NodeJS.ProcessEnv;
      fetch: NonNullable<Io["fetch"]>;
    }): Promise<Ran> {
      const originalConfig = await tree(config);
      const originalLink = await readFile(join(cwd, "dropway.json"));
      let stdout = "";
      let stderr = "";
      let prompts = 0;
      const wire: Wire[] = [];
      const violations: string[] = [];
      const code = await run(args, {
        cwd, env: { HOME: work, KOFRA_CONFIG_DIR: config, KOFRA_API: options.api, KOFRA_API_KEY: options.key ?? sentinelKey, ...options.env },
        stdout: text => void (stdout += text), stderr: text => void (stderr += text),
        stdinIsTTY: false, stderrIsTTY: false,
        readStdin: async () => { prompts++; throw new Error("pull must not read stdin"); },
        prompt: async () => { prompts++; throw new Error("pull must not prompt"); },
        fetch: async request => {
          const url = new URL(request.url);
          wire.push({ url, method: request.method });
          if (url.origin !== options.api || request.method !== "GET") {
            violations.push("pull escaped its read-only instance boundary");
            throw new Error("Acceptance transport refused request");
          }
          return options.fetch(request);
        },
      });
      expect(violations, "read-only transport containment").toEqual([]);
      expect(prompts, "non-TTY pull must not consume stdin or prompt").toBe(0);
      expect(await tree(config), "pull must not persist credentials").toEqual(originalConfig);
      expect(await readFile(join(cwd, "dropway.json")), "pull must not relink the project").toEqual(originalLink);
      expect(stdout + stderr, "credential must not be printed").not.toContain(options.key ?? sentinelKey);
      return { code, stdout, stderr, wire };
    },
    async dispose() { await rm(work, { recursive: true, force: true }); },
  };
}
