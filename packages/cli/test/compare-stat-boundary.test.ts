/**
 * Stat-boundary fault contract for the collector (docs/CLI_COMPARE.md §6/§8):
 * under verifyUnchanged, a file that disappears at any stat — snapshot,
 * pre-hash or post-hash — is `source_changed` (surfacing as
 * `compare_source_changed`); any other stat error, and every error on the
 * publish path (verifyUnchanged off), propagates untouched.
 *
 * Only `node:fs/promises` `stat` is interposed, counting calls per path and
 * injecting one coded error at a chosen boundary. Everything else — walk,
 * read, hash, dispatch — is the real implementation on a real filesystem.
 *
 * Run: npm run test:cli -- test/compare-stat-boundary.test.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/client.ts";
import { collectFiles } from "../src/files.ts";
import { run, type Io } from "../src/main.ts";

const fault = vi.hoisted(() => ({ target: "", failAt: -1, code: "ENOENT", count: 0 }));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (path: unknown, ...args: unknown[]) => {
      if (fault.target && String(path) === fault.target) {
        fault.count++;
        if (fault.count === fault.failAt) {
          const err = new Error(`injected ${fault.code}`) as NodeJS.ErrnoException;
          err.code = fault.code;
          throw err;
        }
      }
      return (actual.stat as (...a: any[]) => any)(path, ...args);
    },
  };
});

const API = "https://compare-stat-fixture.invalid";
const KEY = "dw_synthetic_stat_fixture_not_a_credential";
let work: string;
let dist: string;

beforeEach(async () => {
  fault.target = "";
  fault.failAt = -1;
  fault.code = "ENOENT";
  fault.count = 0;
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "compare-stat-"));
  dist = join(work, "dist");
  await mkdir(dist, { recursive: true });
});
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

/** One eligible file; arm the injected error at its failAt-th stat. */
async function arm(failAt: number, code = "ENOENT", dir = dist) {
  await writeFile(join(dir, "payload.txt"), "payload");
  fault.target = join(dir, "payload.txt");
  fault.failAt = failAt;
  fault.code = code;
  fault.count = 0;
}

async function errOf(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error("expected collectFiles to reject");
}

describe("collectFiles with verifyUnchanged: disappearing file at each stat boundary", () => {
  // With verifyUnchanged, target stats run: 1 = snapshot, 2 = pre-hash, 3 = post-hash.
  it.each([[1, "snapshot"], [2, "pre-hash"], [3, "post-hash"]] as const)(
    "maps ENOENT at the %s stat (%s) to source_changed naming the relative path", async (failAt, _label) => {
      await arm(failAt);
      const err = await errOf(collectFiles(dist, { verifyUnchanged: true }));
      expect(fault.count, "the injected boundary was reached").toBe(failAt);
      expect(err).toBeInstanceOf(CliError);
      expect(err).toMatchObject({ code: "source_changed", exitCode: 2 });
      expect(err.message).toContain("payload.txt");
      expect(err.message, "relative path, not absolute").not.toContain(work);
      expect(err.hint).toMatch(/^Re-run when the tree is quiet\.?$/);
    });

  it("propagates a non-ENOENT post-hash stat error unchanged", async () => {
    await arm(3, "EACCES");
    const err = await errOf(collectFiles(dist, { verifyUnchanged: true }));
    expect(fault.count).toBe(3);
    expect(err).not.toBeInstanceOf(CliError);
    expect(err.code).toBe("EACCES");
  });

  it("surfaces the raw ENOENT when verifyUnchanged is off (the publish default)", async () => {
    // Publish collects without verifyUnchanged/maxBytes, so no snapshot pass
    // runs and the first target stat is the pre-hash one.
    await arm(1);
    const err = await errOf(collectFiles(dist));
    expect(fault.count).toBe(1);
    expect(err).not.toBeInstanceOf(CliError);
    expect(err.code).toBe("ENOENT");
  });
});

describe("compare CLI: stat-boundary disappearance surfacing", () => {
  it("renames a post-hash ENOENT to compare_source_changed, exit 2, after the two reads", async () => {
    const cwd = join(work, "project");
    const projectDist = join(cwd, "dist");
    const config = join(work, "config");
    await mkdir(projectDist, { recursive: true });
    await mkdir(config, { recursive: true });
    await writeFile(join(cwd, "dropway.json"), JSON.stringify({ api: API, sites: {} }));
    await writeFile(join(config, "credentials.json"), JSON.stringify({ default: API, instances: { [API]: { key: KEY } } }), { mode: 0o600 });
    await arm(3, "ENOENT", projectDist);
    const pinned = { id: "ver_stat_pinned", number: 1, status: "ready", live: true, fileCount: 0, totalBytes: 0,
      source: "cli", message: null, client: null, createdAt: "2026-10-24T12:00:00.000Z", finalizedAt: "2026-10-24T12:00:01.000Z" };
    let stdout = "";
    let stderr = "";
    let reads = 0;
    const io: Io = {
      cwd, env: { HOME: work, KOFRA_CONFIG_DIR: config, KOFRA_API: API, KOFRA_API_KEY: KEY },
      stdout: t => void (stdout += t), stderr: t => void (stderr += t),
      stdinIsTTY: false, stderrIsTTY: false,
      readStdin: async () => { throw new Error("compare must not read stdin"); },
      prompt: async () => { throw new Error("compare must not prompt"); },
      fetch: async req => {
        reads++;
        const body = new URL(req.url).pathname.endsWith("/versions")
          ? { currentVersionId: pinned.id, versions: [pinned] }
          : { version: pinned, files: [] };
        return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
      },
    };
    const code = await run(["compare", "dist", "--site", "stat-site", "--json"], io);
    expect(code, stdout + stderr).toBe(2);
    expect(reads).toBe(2);
    expect(fault.count).toBe(3);
    const body = JSON.parse(stdout);
    expect(body).toMatchObject({ ok: false, exitCode: 2, error: { code: "compare_source_changed" } });
    expect(body.error.message).toContain("payload.txt");
    expect(body.error.message).not.toContain(work);
    expect(body.error.hint).toMatch(/^Re-run when the tree is quiet\.?$/);
    expect(body.records).toBeUndefined();
    expect(stdout + stderr).not.toContain(KEY);
  });
});
