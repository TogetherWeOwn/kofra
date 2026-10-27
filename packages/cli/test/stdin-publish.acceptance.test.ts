/**
 * Acceptance: publish a piped single file from stdin.
 *
 * Test-author handoff. Protected file: the builder consumes this branch as-is
 * and never edits this file. No product behavior is changed here.
 *
 * Contract pinned (behavioral, real CLI/Worker seams):
 * - `echo ... | kofra publish --stdin <filename> [--site ...] [--json] [--wait]`
 *   publishes exactly one file whose bytes come from stdin; the live URL serves
 *   byte-identical content and `--wait` resolves like path publish.
 * - `--json` shape, exit codes and `--dry-run` semantics match path publish
 *   (one JSON object on stdout, progress/notes on stderr only, no key leak).
 * - `--stdin` and the `<path>` positional are mutually exclusive (exit 2 with a
 *   hint, before any stdin read, network call or write).
 * - TTY stdin refuses exit 2 ("nothing piped") without hanging, prompting or
 *   networking; empty stdin is exit 2 naming the empty input, never a
 *   zero-byte publish surprise.
 * - Oversized piped input gets the actionable cap error (exit 6, established
 *   file_too_large code + hint), with no empty site left behind.
 * - Secret-bearing bytes refuse without `--allow-secrets` (exit 2,
 *   possible_secrets, no secret bytes in output), pass with it.
 * - `--dry-run` performs the offline preflight over piped bytes + filename
 *   without network mutation, config/credential writes or site creation.
 * - Single-read: piped bytes are consumed exactly once (no gh double-`-` pitfall).
 * - Filenames follow existing path validation: `__dropway/` and unsafe names
 *   fail with the established reserved_path/invalid_path codes.
 * - No browser is needed: live readiness is plain HTTP against a disposable
 *   local Worker over loopback (unstable_startWorker), exactly like e2e.
 *
 * Expected baseline: every `--stdin` contract test below fails with
 * `Unknown option --stdin` (exit 2) because the flag does not exist yet; the
 * path-publish controls pass. Infrastructure errors (Worker fails to start,
 * migrations fail) are not feature RED and must be fixed before reading the
 * verdict.
 *
 * Run: npm run test:cli -- test/stdin-publish.acceptance.test.ts
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../src/client.ts";
import { run, type Io } from "../src/main.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cliEntry = fileURLToPath(new URL("../bin/dropway.mjs", import.meta.url));
const BOOTSTRAP = "stdin-publish-acceptance-0123456789abcdef";

let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let api = "";
let work = "";
let configDir = "";
let apiKey = "";

// ---------------------------------------------------------------- shared harness

interface Wire {
  method: string;
  url: string;
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
  wire: Wire[];
  stdinReads: number;
}

/** Run the real CLI in-process with captured stdio, a wire tap and stdin counting. */
async function cli(
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    onlyEnv?: Record<string, string>;
    stdin?: string;
    stdinIsTTY?: boolean;
    stderrIsTTY?: boolean;
    fetch?: (req: Request) => Promise<Response>;
  } = {},
): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  const wire: Wire[] = [];
  let stdinReads = 0;
  const inner = opts.fetch ?? ((req: Request) => fetch(req));
  const io: Io = {
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    stdinIsTTY: opts.stdinIsTTY ?? false,
    stderrIsTTY: opts.stderrIsTTY ?? false,
    readStdin: async () => {
      stdinReads++;
      return opts.stdin ?? "";
    },
    prompt: async () => {
      throw new Error("acceptance must not prompt");
    },
    env: opts.onlyEnv ?? { KOFRA_CONFIG_DIR: configDir, KOFRA_API: api, ...opts.env },
    cwd: opts.cwd ?? work,
    fetch: async (req: Request) => {
      expect(new URL(req.url).origin, "CLI must only contact the disposable local Worker").toBe(api);
      wire.push({ method: req.method, url: req.url });
      return inner(req);
    },
  };
  const code = await run(args, io);
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* asserted per test */
  }
  return { code, stdout, stderr, json, wire, stdinReads };
}

/** stdout must be exactly one pretty-printed JSON object, nothing else. */
function expectSingleJson(stdout: string): any {
  const json = JSON.parse(stdout);
  expect(stdout).toBe(`${JSON.stringify(json, null, 2)}\n`);
  return json;
}

/** No credential material in captured output. */
function expectNoLeak(r: Ran): void {
  expect(r.stdout + r.stderr).not.toContain(apiKey);
  expect(r.stdout + r.stderr).not.toMatch(/dw_[A-Za-z0-9_-]{20}/);
}

async function project(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(work, name);
  for (const [p, content] of Object.entries(files)) {
    await mkdir(join(dir, p, ".."), { recursive: true });
    await writeFile(join(dir, p), content);
  }
  return dir;
}

async function apiJson(path: string, key: string = apiKey, base: string = api): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function liveBytes(url: string): Promise<{ status: number; bytes: Uint8Array; version: string | null }> {
  const res = await fetch(url, { headers: { Accept: "*/*" } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, bytes, version: res.headers.get("x-kofra-version") };
}

async function liveText(url: string): Promise<{ status: number; text: string; version: string | null }> {
  const res = await fetch(url, { headers: { Accept: "*/*" } });
  return { status: res.status, text: await res.text(), version: res.headers.get("x-kofra-version") };
}

/** Fail fast with a clear message instead of hanging the test on stalled work. */
async function mustSettle<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} stalled past ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Run the real binary as a subprocess with a real pipe (no TTY). */
async function spawnPipe(
  args: string[],
  stdinBytes: string,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; json: any }> {
  const env = { ...process.env, KOFRA_CONFIG_DIR: configDir, KOFRA_API: api, ...opts.env };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: opts.cwd ?? work,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("subprocess CLI timed out; piped publish must not hang"));
    }, 30_000);
    child.stdout.on("data", (d) => void (stdout += d));
    child.stderr.on("data", (d) => void (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* asserted per test */
      }
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.write(stdinBytes, (err) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      child.stdin.end();
    });
  });
}

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "stdin-publish-"));
  configDir = join(work, "config");
  const persist = join(work, "state");
  await promisify(execFile)(
    process.execPath,
    [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } },
  );
  worker = await unstable_startWorker({
    config: join(root, "wrangler.jsonc"),
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: {
      ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: BOOTSTRAP },
      ANONYMOUS_PUBLISH: { type: "plain_text", value: "false" },
    },
  });
  await worker.ready;
  api = (await worker.url).origin;
  const setup = await cli(["setup", "--email", "owner@example.com", "--json"], { env: { KOFRA_BOOTSTRAP_KEY: BOOTSTRAP } });
  expect(setup.code, setup.stdout + setup.stderr).toBe(0);
  apiKey = (JSON.parse(await readFile(join(configDir, "credentials.json"), "utf8")).instances[api].key as string);
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------- controls (must pass on baseline)

describe("path-publish controls (no --stdin)", () => {
  it("publishes a single file by path byte-identical (control)", async () => {
    // Fragment HTML (no <html> tag) avoids the path-mode shim injection, so the
    // live root is byte-identical; full documents are pinned via ?raw=1 below.
    const dir = await project("control-single", { "report.html": "<p>control</p>" });
    const r = await cli(["publish", join(dir, "report.html"), "--site", "stdin-control-single", "--json", "--no-save"]);
    expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: true, slug: "stdin-control-single", files: 1, uploaded: 1 });
    expectNoLeak(r);
    const live = await liveText(json.url as string);
    expect(live.status).toBe(200);
    expect(live.text).toBe("<p>control</p>");
    expect(live.version).toBe(json.version.id as string);
    const raw = await liveText(`${json.url as string}?raw=1`);
    expect(raw.text).toBe("<p>control</p>");
  });

  it("path --dry-run stays offline with no writes (control)", async () => {
    const dir = await project("control-dryrun", { "index.html": "<p>dry</p>" });
    const freshConfig = join(work, "control-dryrun-config");
    const freshCwd = await mkdtemp(join(work, "control-dryrun-cwd-"));
    const r = await cli(["publish", dir, "--dry-run", "--json"], {
      onlyEnv: { KOFRA_CONFIG_DIR: freshConfig, KOFRA_API: api },
      cwd: freshCwd,
      fetch: async () => {
        throw new Error("dry-run must stay offline");
      },
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(expectSingleJson(r.stdout)).toMatchObject({ dryRun: true });
    expect(r.wire).toHaveLength(0);
    await expect(readFile(join(freshConfig, "credentials.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(freshCwd, "dropway.json"), "utf8")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- the piped contract (RED until --stdin ships)

describe("stdin publish: piped bytes become a live single file", () => {
  it("publishes piped HTML byte-identical with --wait resolving", async () => {
    // Fragment HTML keeps the live root byte-identical in path mode (full
    // documents get the path-shim script; ?raw=1 still serves stored bytes).
    const html = "<p>piped html</p>";
    const r = await cli(["publish", "--stdin", "report.html", "--site", "stdin-html-acceptance", "--json", "--wait", "--no-save"], { stdin: html });
    expect(r.code, `piped HTML must publish, got: ${r.stdout}${r.stderr}`).toBe(EXIT.ok);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: true, slug: "stdin-html-acceptance", created: true, unchanged: false, files: 1, uploaded: 1, live: true });
    expect(json.version.number).toBe(1);
    expect(r.stderr).not.toContain('"ok"');
    expectNoLeak(r);
    expect(r.stdinReads, "piped bytes are consumed exactly once").toBe(1);
    const live = await liveBytes(json.url as string);
    expect(live.status).toBe(200);
    expect(Buffer.from(live.bytes).toString("utf8")).toBe(html);
    expect(live.version).toBe(json.version.id as string);
    const raw = await liveBytes(`${json.url as string}report.html?raw=1`);
    expect(raw.status).toBe(200);
    expect(Buffer.from(raw.bytes).toString("utf8"), "?raw=1 serves stored bytes").toBe(html);
  });

  it("publishes piped JSON byte-identical", async () => {
    const body = JSON.stringify({ piped: true, n: 42, nested: { ok: [1, 2, 3] } });
    const r = await cli(["publish", "--stdin", "data.json", "--site", "stdin-json-acceptance", "--json", "--no-save"], { stdin: body });
    expect(r.code, `piped JSON must publish, got: ${r.stdout}${r.stderr}`).toBe(EXIT.ok);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: true, slug: "stdin-json-acceptance", files: 1 });
    expectNoLeak(r);
    expect(r.stdinReads).toBe(1);
    const live = await liveBytes(json.url as string);
    expect(live.status).toBe(200);
    expect(Buffer.from(live.bytes).toString("utf8")).toBe(body);
    expect(live.version).toBe(json.version.id as string);
  });

  it("publishes piped Markdown byte-identical", async () => {
    const md = "# Piped report\n\nAll good.\n\n- one\n- two\n";
    const r = await cli(["publish", "--stdin", "notes.md", "--site", "stdin-md-acceptance", "--json", "--no-save"], { stdin: md });
    expect(r.code, `piped Markdown must publish, got: ${r.stdout}${r.stderr}`).toBe(EXIT.ok);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: true, slug: "stdin-md-acceptance", files: 1 });
    expectNoLeak(r);
    expect(r.stdinReads).toBe(1);
    const live = await liveBytes(`${json.url as string}?raw=1`);
    expect(live.status).toBe(200);
    expect(Buffer.from(live.bytes).toString("utf8")).toBe(md);
    expect(live.version).toBe(json.version.id as string);
  });

  it("publishes piped bytes with a Unicode filename byte-identical", async () => {
    const name = "café-\u{1F389}-résumé.html";
    const html = "<p>café \u{1F389} 日本語</p>";
    const r = await cli(["publish", "--stdin", name, "--site", "stdin-unicode-acceptance", "--json", "--no-save"], { stdin: html });
    expect(r.code, `Unicode filename must publish, got: ${r.stdout}${r.stderr}`).toBe(EXIT.ok);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: true, slug: "stdin-unicode-acceptance", files: 1 });
    expectNoLeak(r);
    expect(r.stdinReads).toBe(1);
    const files = await apiJson(`/api/v1/sites/stdin-unicode-acceptance/files`);
    expect(files.status).toBe(200);
    expect(files.body.files.map((f: { path: string }) => f.path)).toEqual([name]);
    const encoded = `${json.url as string}${name.split("/").map(encodeURIComponent).join("/")}?raw=1`;
    const live = await liveBytes(encoded);
    expect(live.status).toBe(200);
    expect(Buffer.from(live.bytes).toString("utf8")).toBe(html);
    const rootLive = await liveBytes(json.url as string);
    expect(rootLive.status).toBe(200);
    expect(Buffer.from(rootLive.bytes).toString("utf8"), "single-file root serves the file").toBe(html);
  });

  it("golden --json equals path-publish shape", async () => {
    const body = "<p>golden</p>";
    const dir = await project("stdin-golden-path", { "golden.html": body });
    const viaPath = await cli(["publish", join(dir, "golden.html"), "--site", "stdin-golden-path", "--json", "--no-save"]);
    expect(viaPath.code, viaPath.stdout + viaPath.stderr).toBe(EXIT.ok);
    const pathJson = expectSingleJson(viaPath.stdout);
    const viaStdin = await cli(["publish", "--stdin", "golden.html", "--site", "stdin-golden-stdin", "--json", "--no-save"], { stdin: body });
    expect(viaStdin.code, `stdin publish must succeed, got: ${viaStdin.stdout}${viaStdin.stderr}`).toBe(EXIT.ok);
    const stdinJson = expectSingleJson(viaStdin.stdout);
    expect(Object.keys(stdinJson).sort(), "stdin and path --json carry the same keys").toEqual(Object.keys(pathJson).sort());
    expect(stdinJson).toMatchObject({
      ok: true,
      slug: "stdin-golden-stdin",
      created: true,
      unchanged: false,
      files: 1,
      // The path publish already uploaded these identical bytes for this owner.
      uploaded: 0,
      reused: 1,
      api,
    });
    expect(typeof stdinJson.url).toBe("string");
    expect(typeof stdinJson.bytesUploaded).toBe("number");
    expect(Array.isArray(stdinJson.warnings)).toBe(true);
    expect(stdinJson.version).toMatchObject({ number: 1 });
    expect(typeof stdinJson.version.id).toBe("string");
    expect(viaStdin.stderr).not.toContain('"ok"');
    expectNoLeak(viaStdin);
  });

  it("subprocess with a real pipe publishes (no TTY)", async () => {
    const body = "<p>real pipe</p>";
    const r = await spawnPipe(["publish", "--stdin", "real.html", "--site", "stdin-realpipe-acceptance", "--json", "--no-save"], body);
    expect(r.code, `real pipe must publish, got: ${r.stdout}${r.stderr}`).toBe(EXIT.ok);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: true, slug: "stdin-realpipe-acceptance", files: 1 });
    expect(r.stdout + r.stderr).not.toContain(apiKey);
    const live = await liveText(json.url as string);
    expect(live.status).toBe(200);
    expect(live.text).toBe(body);
    expect(live.version).toBe(json.version.id as string);
  });
});

describe("stdin publish: refusals before side effects", () => {
  it("--stdin plus a positional is exit 2 without reading stdin or networking", async () => {
    const dir = await project("stdin-both", { "index.html": "<p>both</p>" });
    const r = await cli(["publish", "--stdin", "pipe.html", dir, "--json", "--no-save"], { stdin: "<p>piped</p>" });
    expect(r.code, `mutual exclusion must refuse, got: ${r.stdout}${r.stderr}`).toBe(EXIT.usage);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: false, exitCode: EXIT.usage });
    // Must name the mutual exclusion (not merely "Unknown option --stdin").
    expect(json.error.message).not.toMatch(/Unknown option/);
    expect(`${json.error.message} ${json.error.hint}`).toMatch(/mutually exclusive|either.*or|not both|--stdin.*positional|positional.*--stdin|drop.*positional/i);
    expect(r.stderr).not.toContain('"ok"');
    expect(r.wire, "refusal precedes any network call").toHaveLength(0);
    expect(r.stdinReads, "refusal precedes any stdin read").toBe(0);
    expectNoLeak(r);
  });

  it("--stdin plus a dash positional is exit 2 (no gh double-dash pitfall)", async () => {
    const r = await cli(["publish", "--stdin", "pipe.html", "-", "--json", "--no-save"], { stdin: "<p>piped</p>" });
    expect(r.code, `dash positional with --stdin must refuse, got: ${r.stdout}${r.stderr}`).toBe(EXIT.usage);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: false, exitCode: EXIT.usage });
    expect(json.error.message).not.toMatch(/Unknown option/);
    expect(`${json.error.message} ${json.error.hint}`).toMatch(/mutually exclusive|either.*or|not both|--stdin.*positional|positional.*--stdin|drop.*positional/i);
    expect(r.wire).toHaveLength(0);
    expect(r.stdinReads).toBe(0);
  });

  it("TTY stdin refuses exit 2 without hanging, prompting or networking", async () => {
    const r = await mustSettle(
      cli(["publish", "--stdin", "tty.html", "--site", "stdin-tty-acceptance", "--json", "--no-save"], {
        stdinIsTTY: true,
        stderrIsTTY: true,
      }),
      5000,
      "TTY stdin refusal",
    );
    expect(r.code, `TTY stdin must refuse, got: ${r.stdout}${r.stderr}`).toBe(EXIT.usage);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: false, exitCode: EXIT.usage });
    // Must name the missing pipe (not merely "Unknown option --stdin").
    expect(json.error.message).not.toMatch(/Unknown option/);
    expect(`${json.error.message} ${json.error.hint}`).toMatch(/piped|nothing piped|pipe.*stdin|stdin.*tty|tty|terminal/i);
    expect(r.wire).toHaveLength(0);
    expect(r.stdinReads, "TTY refusal precedes any stdin read").toBe(0);
  });

  it("--stdin without a filename is exit 2", async () => {
    const r = await cli(["publish", "--stdin", "--json", "--no-save"], { stdin: "<p>x</p>" });
    expect(r.code, `missing --stdin value must refuse, got: ${r.stdout}${r.stderr}`).toBe(EXIT.usage);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: false, exitCode: EXIT.usage });
    expect(json.error.message).not.toMatch(/Unknown option/);
    expect(`${json.error.message} ${json.error.hint}`).toMatch(/stdin.*(value|filename|name)|needs a value/i);
    expect(r.wire).toHaveLength(0);
    expect(r.stdinReads).toBe(0);
  });

  it("empty stdin is exit 2, never a zero-byte publish", async () => {
    const slug = "stdin-empty-acceptance";
    const r = await cli(["publish", "--stdin", "empty.html", "--site", slug, "--json", "--no-save"], { stdin: "" });
    expect(r.code, `empty stdin must refuse, got: ${r.stdout}${r.stderr}`).toBe(EXIT.usage);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: false, exitCode: EXIT.usage });
    expect(`${json.error.code} ${json.error.message} ${json.error.hint}`).toMatch(/empty/i);
    expect(r.wire, "empty input is refused before any mutation").toHaveLength(0);
    expect(r.stdinReads, "emptiness is detected from the single read").toBe(1);
    const site = await apiJson(`/api/v1/sites/${slug}`);
    expect(site.status, "no empty site is left behind").toBe(404);
  });

  it("reserved and unsafe filenames fail with the established codes, no site left behind", async () => {
    const reserved = await cli(["publish", "--stdin", "__dropway/evil.html", "--site", "stdin-reserved-acceptance", "--json", "--no-save"], {
      stdin: "<p>evil</p>",
    });
    expect(reserved.code, `reserved path must refuse, got: ${reserved.stdout}${reserved.stderr}`).toBe(EXIT.invalid);
    const reservedJson = expectSingleJson(reserved.stdout);
    expect(reservedJson).toMatchObject({ ok: false, exitCode: EXIT.invalid });
    expect(reservedJson.error.code).toBe("reserved_path");
    expect(reservedJson.error.hint).toMatch(/rename/i);
    const reservedSite = await apiJson("/api/v1/sites/stdin-reserved-acceptance");
    expect(reservedSite.status, "refused files leave no empty site").toBe(404);

    const unsafe = await cli(["publish", "--stdin", "../evil.html", "--site", "stdin-unsafe-acceptance", "--json", "--no-save"], {
      stdin: "<p>evil</p>",
    });
    expect(unsafe.code, `unsafe path must refuse, got: ${unsafe.stdout}${unsafe.stderr}`).toBe(EXIT.invalid);
    const unsafeJson = expectSingleJson(unsafe.stdout);
    expect(unsafeJson.error.code).toBe("invalid_path");
    const unsafeSite = await apiJson("/api/v1/sites/stdin-unsafe-acceptance");
    expect(unsafeSite.status).toBe(404);
  });
});

describe("stdin publish: secrets, dry-run and single-read", () => {
  const leak = "AKIA" + "Z".repeat(16);
  const leakyHtml = `<!doctype html><html><body><script>const k = "${leak}";</script></body></html>`;

  it("secret-bearing bytes refuse without --allow-secrets", async () => {
    const slug = "stdin-secret-refuse";
    const r = await cli(["publish", "--stdin", "leak.html", "--site", slug, "--json", "--no-save"], { stdin: leakyHtml });
    expect(r.code, `secrets must refuse, got: ${r.stdout}${r.stderr}`).toBe(EXIT.usage);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: false, exitCode: EXIT.usage });
    expect(json.error.code).toBe("possible_secrets");
    expect(json.error.details.findings).toEqual([{ path: "leak.html", line: 1, kind: "aws_access_key_id" }]);
    expect(r.stdout + r.stderr, "matched secret values are never printed").not.toContain(leak);
    expect(r.wire).toHaveLength(0);
    expect(r.stdinReads).toBe(1);
    const site = await apiJson(`/api/v1/sites/${slug}`);
    expect(site.status).toBe(404);
  });

  it("secret-bearing bytes pass with --allow-secrets", async () => {
    const r = await cli(["publish", "--stdin", "leak.html", "--site", "stdin-secret-allow", "--json", "--no-save", "--allow-secrets"], {
      stdin: leakyHtml,
    });
    expect(r.code, `allow-secrets must publish, got: ${r.stdout}${r.stderr}`).toBe(EXIT.ok);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: true, slug: "stdin-secret-allow", files: 1 });
    expect(r.stdout + r.stderr).not.toContain(leak);
    const live = await liveText(`${json.url as string}?raw=1`);
    expect(live.status).toBe(200);
    expect(live.text).toBe(leakyHtml);
  });

  it("--dry-run inventories piped bytes offline and changes nothing", async () => {
    const body = "<!doctype html><html><body><p>dry piped</p></body></html>";
    const freshConfig = join(work, "stdin-dryrun-config");
    const freshCwd = await mkdtemp(join(work, "stdin-dryrun-cwd-"));
    const r = await cli(["publish", "--stdin", "dry.html", "--site", "stdin-dryrun-acceptance", "--dry-run", "--json"], {
      onlyEnv: { KOFRA_CONFIG_DIR: freshConfig, KOFRA_API: api },
      cwd: freshCwd,
      stdin: body,
      fetch: async () => {
        throw new Error("dry-run must stay offline");
      },
    });
    expect(r.code, `dry-run must succeed offline, got: ${r.stdout}${r.stderr}`).toBe(EXIT.ok);
    const json = expectSingleJson(r.stdout);
    expect(json.dryRun).toBe(true);
    expect(json.files).toHaveLength(1);
    expect(json.files[0]).toMatchObject({ path: "dry.html", size: Buffer.byteLength(body), sha256: sha256Hex(body) });
    expect(r.wire).toHaveLength(0);
    expect(r.stdinReads).toBe(1);
    expect(r.stderr).not.toContain('"ok"');
    await expect(readFile(join(freshConfig, "credentials.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(freshCwd, "dropway.json"), "utf8")).rejects.toThrow();
    const site = await apiJson("/api/v1/sites/stdin-dryrun-acceptance");
    expect(site.status, "dry-run creates no site").toBe(404);
  });

  it("--dry-run still refuses secrets without --allow-secrets", async () => {
    const r = await cli(["publish", "--stdin", "leak.html", "--dry-run", "--json", "--no-save"], { stdin: leakyHtml });
    expect(r.code, `dry-run secrets must refuse, got: ${r.stdout}${r.stderr}`).toBe(EXIT.usage);
    const json = expectSingleJson(r.stdout);
    expect(json.error.code).toBe("possible_secrets");
    expect(r.wire).toHaveLength(0);
  });

  it("piped bytes are consumed exactly once on success, dry-run and empty", async () => {
    const ok = await cli(["publish", "--stdin", "once.html", "--site", "stdin-once-acceptance", "--json", "--no-save"], {
      stdin: "<p>once</p>",
    });
    expect(ok.code, `success must read once, got: ${ok.stdout}${ok.stderr}`).toBe(EXIT.ok);
    expect(ok.stdinReads).toBe(1);

    const dry = await cli(["publish", "--stdin", "once.html", "--dry-run", "--json", "--no-save"], { stdin: "<p>once</p>" });
    expect(dry.code).toBe(EXIT.ok);
    expect(dry.stdinReads).toBe(1);

    const empty = await cli(["publish", "--stdin", "once.html", "--site", "stdin-once-empty", "--json", "--no-save"], { stdin: "" });
    expect(empty.code).toBe(EXIT.usage);
    expect(empty.stdinReads).toBe(1);
  });
});

describe("stdin publish: oversized input", () => {
  it("path publish to a 1 KiB-limit instance refuses file_too_large (control)", async () => {
    const small = await startCappedInstance(1024);
    try {
      const dir = await project("stdin-cap-path", { "big.txt": `x`.repeat(2048) });
      const before = await apiJson("/api/v1/sites", small.key, small.api);
      expect(before.status).toBe(200);
      let stdout = "";
      let stderr = "";
      const wire: Wire[] = [];
      const io: Io = {
        stdout: (t) => void (stdout += t),
        stderr: (t) => void (stderr += t),
        stdinIsTTY: false,
        stderrIsTTY: false,
        readStdin: async () => "",
        prompt: async () => {
          throw new Error("must not prompt");
        },
        env: { KOFRA_CONFIG_DIR: join(work, "stdin-cap-path-config"), KOFRA_API: small.api, KOFRA_API_KEY: small.key },
        cwd: work,
        fetch: async (req: Request) => {
          wire.push({ method: req.method, url: req.url });
          return fetch(req);
        },
      };
      const code = await run(["publish", dir, "--site", "stdin-cap-path", "--json", "--no-save"], io);
      expect(code, `capped path publish must refuse, got: ${stdout}${stderr}`).toBe(EXIT.invalid);
      const json = JSON.parse(stdout);
      expect(json.error.code).toBe("file_too_large");
      expect(`${json.error.message} ${json.error.hint}`).toMatch(/limit|compress|split|smaller/i);
      const site = await apiJson("/api/v1/sites/stdin-cap-path", small.key, small.api);
      expect(site.status).toBe(404);
    } finally {
      await small.dispose();
    }
  });

  it("oversized piped input gets the actionable cap error, no empty site", async () => {
    const small = await startCappedInstance(1024);
    try {
      const body = `y`.repeat(2048);
      let stdout = "";
      let stderr = "";
      const io: Io = {
        stdout: (t) => void (stdout += t),
        stderr: (t) => void (stderr += t),
        stdinIsTTY: false,
        stderrIsTTY: false,
        readStdin: async () => body,
        prompt: async () => {
          throw new Error("must not prompt");
        },
        env: { KOFRA_CONFIG_DIR: join(work, "stdin-cap-stdin-config"), KOFRA_API: small.api, KOFRA_API_KEY: small.key },
        cwd: work,
        fetch: async (req: Request) => fetch(req),
      };
      const code = await run(["publish", "--stdin", "big.txt", "--site", "stdin-cap-stdin", "--json", "--no-save"], io);
      expect(code, `oversized stdin must refuse, got: ${stdout}${stderr}`).toBe(EXIT.invalid);
      const json = expectSingleJson(stdout);
      expect(json).toMatchObject({ ok: false, exitCode: EXIT.invalid });
      expect(json.error.code).toBe("file_too_large");
      expect(`${json.error.message} ${json.error.hint}`).toMatch(/limit|compress|split|smaller/i);
      expect(stdout + stderr).not.toContain(small.key);
      const site = await apiJson("/api/v1/sites/stdin-cap-stdin", small.key, small.api);
      expect(site.status, "refused bytes leave no empty site").toBe(404);
    } finally {
      await small.dispose();
    }
  });
});

// ---------------------------------------------------------------- capped disposable instance for the oversized contract

async function startCappedInstance(maxFileBytes: number): Promise<{ api: string; key: string; dispose: () => Promise<void> }> {
  const persist = await mkdtemp(join(work, "stdin-cap-state-"));
  await promisify(execFile)(
    process.execPath,
    [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } },
  );
  const capped = await unstable_startWorker({
    config: join(root, "wrangler.jsonc"),
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: {
      ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: `${BOOTSTRAP}-cap` },
      ANONYMOUS_PUBLISH: { type: "plain_text", value: "false" },
      MAX_FILE_BYTES: { type: "plain_text", value: String(maxFileBytes) },
    },
  });
  await capped.ready;
  const cappedApi = (await capped.url).origin;
  const setupRes = await fetch(`${cappedApi}/api/v1/setup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BOOTSTRAP}-cap`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com" }),
  });
  if (!setupRes.ok) throw new Error(`capped setup failed: ${setupRes.status} ${await setupRes.text()}`);
  const setupBody = (await setupRes.json()) as { apiKey: { key: string } };
  return {
    api: cappedApi,
    key: setupBody.apiKey.key,
    dispose: async () => {
      await capped.dispose();
      await rm(persist, { recursive: true, force: true });
    },
  };
}
