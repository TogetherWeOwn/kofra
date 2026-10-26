/** Real CLI entrypoint + OS SIGINT; filesystem faults are test-only preloads. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const preload = fileURLToPath(new URL("./helpers/compare-faults.mjs", import.meta.url));
const API = "https://compare-process.invalid";
const KEY = "dw_synthetic_process_fixture_not_a_credential";
let work: string;
let bundle: string;
let sequence = 0;

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "compare-process-"));
  bundle = join(work, "kofra.mjs");
  await build({ entryPoints: [join(root, "packages/cli/src/cli.ts")], bundle: true,
    platform: "node", format: "esm", target: "node20", outfile: bundle, logLevel: "silent" });
});
afterAll(async () => { if (work) await rm(work, { recursive: true, force: true }); });

async function inventory(dir: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const s = await stat(path, { bigint: true });
    result.push([name, String(s.mode), String(s.ino), String(s.mtimeNs), String(s.ctimeNs), String(s.size),
      s.isDirectory() ? await inventory(path) : s.size < 10_000_000 ? (await readFile(path)).toString("base64") : "sparse-fixture"]);
  }
  return result;
}

type Event = { type: string; path?: string; method?: string; authenticated?: boolean };
async function invoke(opts: { mode: "observe" | "cap" | "mtime" | "size" | "cancel"; sizes?: number[]; flags?: string[]; control?: "buffer" | "stream" | "signal" }) {
  const dir = join(work, `case-${++sequence}`);
  const home = join(dir, "home");
  const dist = join(home, "dist");
  const config = join(home, "config");
  await mkdir(dist, { recursive: true });
  await mkdir(config);
  await writeFile(join(home, "dropway.json"), JSON.stringify({ api: API, sites: { dist: "stale-site" } }));
  await writeFile(join(config, "credentials.json"), JSON.stringify({ instances: {} }), { mode: 0o600 });
  const targets: string[] = [];
  for (const [i, size] of (opts.sizes ?? [3, 4, 5]).entries()) {
    const path = join(dist, `payload-${i}.txt`);
    await writeFile(path, "");
    await truncate(path, size); // Sparse sizes let default 2 GiB refusal stay cheap.
    targets.push(path);
  }
  const journal = join(dir, "events.jsonl");
  const setup = join(dir, "setup.json");
  await writeFile(journal, "");
  await writeFile(setup, JSON.stringify({ api: API, key: KEY, site: "compare-process", targets, journal, mode: opts.mode,
    version: { id: "ver_process_pinned", number: 1, status: "ready", fileCount: 0, totalBytes: 0,
      source: "cli", message: null, client: null, createdAt: "2026-10-24T12:00:00.000Z", finalizedAt: "2026-10-24T12:00:01.000Z" },
  }));
  const before = await inventory(home);
  const configBefore = await inventory(config);
  const linkBefore = await readFile(join(home, "dropway.json"), "utf8");
  const args = opts.control ? ["--input-type=module", "-e", opts.control === "signal"
    ? "process.once('SIGINT', () => { process.stderr.write('fixture_received_sigint'); process.exitCode = 2; }); await (await import('node:fs/promises')).readFile('dist/payload-0.txt')"
    : opts.control === "buffer" ? "await (await import('node:fs/promises')).readFile('dist/payload-0.txt')"
    : "for await (const c of (await import('node:fs')).createReadStream('dist/payload-0.txt')) {}"]
    : [bundle, "compare", "dist", "--site", "compare-process", "--json", ...(opts.flags ?? [])];
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; signalled: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", preload, ...args], { cwd: home,
      env: { PATH: process.env.PATH, HOME: home, KOFRA_CONFIG_DIR: config, KOFRA_API: API, KOFRA_API_KEY: KEY, COMPARE_FAULT_SETUP: setup, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    let stderr = "";
    let signalled = false;
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("compare process exceeded 15s watchdog")); }, 15_000);
    child.stdout!.on("data", b => { stdout += b; });
    child.stderr!.on("data", b => { stderr += b; });
    child.on("message", (message: any) => {
      if (message?.type === "hash_gate" && !signalled) {
        signalled = child.kill("SIGINT");
        // Permit the one in-flight read to finish, without a timing race/sleep.
        if (child.connected) child.send({ release: true }, () => {});
      }
    });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr, signalled }); });
  });
  const events: Event[] = (await readFile(journal, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(events.filter(e => ["forbidden_request", "unpinned_request"].includes(e.type))).toEqual([]);
  expect(events.filter(e => e.type === "request").every(e => e.method === "GET" && e.authenticated)).toBe(true);
  expect(result.stdout + result.stderr).not.toContain(KEY);
  expect(await inventory(config), "credentials never change").toEqual(configBefore);
  expect(await readFile(join(home, "dropway.json"), "utf8")).toBe(linkBefore);
  if (!["mtime", "size"].includes(opts.mode)) expect(await inventory(home), "no CLI filesystem writes").toEqual(before);
  return { ...result, events, targets, home };
}

function capError(r: Awaited<ReturnType<typeof invoke>>, flag: string, observed: number) {
  expect(r.code, r.stdout + r.stderr).toBe(2);
  expect(r.signal).toBeNull();
  const body = JSON.parse(r.stdout);
  expect(body).toMatchObject({ ok: false, exitCode: 2, error: { code: "compare_cap_exceeded", hint: expect.any(String) } });
  expect(JSON.stringify(body.error)).toContain(flag);
  expect(JSON.stringify(body.error)).toContain(String(observed));
  expect(body.error.hint).toMatch(/raise|increase|narrow|smaller/i);
  expect(r.events.filter(e => e.type === "read"), "eligible file content must not be opened before caps pass").toEqual([]);
}

describe("compare fault-preload controls (not product assertions)", () => {
  it("delivers a real OS SIGINT only after the read gate and releases the child", async () => {
    const r = await invoke({ mode: "cancel", sizes: [3], control: "signal" });
    expect(r.code).toBe(2);
    expect(r.signal).toBeNull();
    expect(r.signalled).toBe(true);
    expect(r.stderr).toBe("fixture_received_sigint");
    expect(r.stdout).toBe("");
    expect(r.events.filter(e => e.type === "hash_gate")).toHaveLength(1);
  });
  it.each(["buffer", "stream"] as const)("observes a real %s read without changing its input", async control => {
    const r = await invoke({ mode: "observe", sizes: [control === "buffer" ? 3 : 4_194_305], control });
    expect(r.code, r.stderr).toBe(0);
    expect(r.events.filter(e => e.type === "read")).toEqual(expect.arrayContaining([expect.objectContaining({ path: r.targets[0] })]));
  });
  it.each(["mtime", "size"] as const)("actually injects a %s change at the content-read boundary", async mode => {
    const r = await invoke({ mode, sizes: [3], control: "buffer" });
    expect(r.code, r.stderr).toBe(0);
    expect(r.events.filter(e => e.type === "source_mutated")).toHaveLength(1);
    if (mode === "size") expect((await stat(r.targets[0]!)).size).toBeGreaterThan(3);
  });
});

describe("compare bounds and interruption through the real entrypoint", () => {
  it("refuses max-files before reading even one eligible byte", async () => {
    capError(await invoke({ mode: "cap", flags: ["--max-files", "1"] }), "--max-files", 3);
  });
  it("refuses max-bytes using total stat sizes before reading any content", async () => {
    capError(await invoke({ mode: "cap", flags: ["--max-bytes", "1"] }), "--max-bytes", 12);
  });
  it("enforces the default 2 GiB cap without opening the sparse input", async () => {
    capError(await invoke({ mode: "cap", sizes: [2_147_483_649] }), "--max-bytes", 2_147_483_649);
  });
  it.each([
    { mode: "mtime" as const, size: 3 },
    { mode: "size" as const, size: 4_194_305 },
  ])("fails on a mid-hash $mode change, including the streamed path", async ({ mode, size }) => {
    const r = await invoke({ mode, sizes: [size] });
    expect(r.code, r.stdout + r.stderr).toBe(2);
    const body = JSON.parse(r.stdout);
    expect(body).toMatchObject({ ok: false, exitCode: 2, error: { code: "compare_source_changed", hint: expect.any(String) } });
    expect(JSON.stringify(body.error)).toContain("payload-0.txt");
    expect(body.error.hint).toMatch(/quiet|re-run|rerun|chang/i);
    expect(r.events.filter(e => e.type === "source_mutated"), "fault must fire, not a setup refusal").toHaveLength(1);
    expect(body.records).toBeUndefined();
  });
  it.each([3, 4_194_305])("handles OS SIGINT during hashing of %s bytes without any partial JSON", async size => {
    const r = await invoke({ mode: "cancel", sizes: [size] });
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.signal, "default OS termination is not handled cancellation").toBeNull();
    expect(r.signalled, "SIGINT was sent only after the actual read began").toBe(true);
    expect(r.events.filter(e => e.type === "hash_gate")).toHaveLength(1);
    expect(r.stdout, "no success or partial/error JSON on cancellation").toBe("");
    expect(r.stderr).toContain("compare_cancelled");
    expect(r.stderr).toMatch(/Fix: .*(?:re-run|rerun|complete)/i);
  });
});
