// rebrand:keep-file (scripts/rebrand.mjs never edits this file.)
/**
 * Acceptance: ZIP base conflicts and a bounded live-version wait.
 *
 * Test-author handoff. Protected file: the builder consumes this branch as-is
 * and never edits this file. No product behavior is changed here.
 *
 * Contract pinned (behavioral, real CLI/Worker seams):
 * - `publish <zip> --base <id>` carries the base into the existing one-shot
 *   server handling. A stale base fails with version_conflict (exit 5) and
 *   leaves live bytes/version unchanged; a current base succeeds. One POST to
 *   /api/v1/publish (no conflict retry, no new endpoint).
 * - `--wait-timeout` bounds live-version polling including in-flight waits.
 *   Stalled work aborts (AbortSignal), response bodies are disposed without an
 *   unbounded cleanup wait, and no poll starts after the deadline. Timeout
 *   keeps the existing shape: waitForVersion false, CLI exit 8, one JSON
 *   result with live:false plus an actionable stderr note.
 * - Live requires successful HTTP status AND the expected version id, under
 *   either X-Kofra-Version or the legacy X-Dropway-Version. Error statuses
 *   with a matching header, wrong/stale headers, network failures and
 *   body-cancellation failures are never live:true.
 * - Agent contract: exactly one JSON object on stdout (result or error),
 *   progress/notes on stderr only, no key disclosure. --dry-run stays fully
 *   offline with no credential/config writes and publishes nothing.
 * - publish.ts/client.ts stay fetch-only (no Node imports); erasable syntax
 *   is enforced by the CLI tsconfig (erasableSyntaxOnly) via typecheck.
 *
 * No browser is needed: live readiness is plain HTTP polling, fully covered
 * with controlled fetch plus a disposable local Worker over loopback. The
 * existing encrypted ciphertext wait-target browser suite stays the owner of
 * encrypted loader behavior and is preserved by reference, not duplicated.
 *
 * Expected baseline: the stale-ZIP, wire-format, stalled-deadline, AbortSignal,
 * slow-fetch, hanging/rejecting-cancel and error-status tests fail for the
 * contract reasons above; ordinary ZIP/manifest/dry-run/header-success controls
 * pass. Infrastructure errors (Worker fails to start, migrations fail) are not
 * feature RED and must be fixed before reading the verdict.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { strToU8, zipSync } from "fflate";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../src/client.ts";
import { run, type Io } from "../src/main.ts";
import { waitForVersion } from "../src/publish.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const BOOTSTRAP = "zip-base-live-wait-acceptance-0123456789abcdef";

let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let api = "";
let work = "";
let configDir = "";
let apiKey = "";

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
}

/** Run the real CLI in-process with captured stdio and a wire tap. */
async function cli(
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    onlyEnv?: Record<string, string>;
    stdin?: string;
    fetch?: (req: Request) => Promise<Response>;
  } = {},
): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  const wire: Wire[] = [];
  const inner = opts.fetch ?? ((req: Request) => fetch(req));
  const io: Io = {
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    stdinIsTTY: false,
    stderrIsTTY: false,
    readStdin: async () => opts.stdin ?? "",
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
  return { code, stdout, stderr, json, wire };
}

/** stdout must be exactly one pretty-printed JSON object, nothing else. */
function expectSingleJson(stdout: string): any {
  const json = JSON.parse(stdout);
  expect(stdout).toBe(`${JSON.stringify(json, null, 2)}\n`);
  return json;
}

async function project(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(work, name);
  for (const [p, content] of Object.entries(files)) {
    await mkdir(join(dir, p, ".."), { recursive: true });
    await writeFile(join(dir, p), content);
  }
  return dir;
}

async function writeZip(path: string, entries: Record<string, string>): Promise<void> {
  const input: Record<string, Uint8Array> = {};
  for (const [p, content] of Object.entries(entries)) input[p] = strToU8(content);
  await writeFile(path, zipSync(input));
}

async function apiJson(path: string): Promise<any> {
  const res = await fetch(`${api}${path}`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
  if (!res.ok) throw new Error(`API ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function liveText(url: string): Promise<{ status: number; text: string; version: string | null }> {
  const res = await fetch(url, { headers: { Accept: "*/*" } });
  return { status: res.status, text: await res.text(), version: res.headers.get("x-kofra-version") };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

const okRes = (version: string, header = "X-Kofra-Version", status = 200) =>
  new Response("ok", { status, headers: { [header]: version } });
const errRes = (version: string, status: number, header = "X-Kofra-Version") =>
  new Response("err", { status, headers: { [header]: version } });
const hangingCancelRes = (version: string) =>
  ({
    ok: true,
    status: 200,
    headers: new Headers({ "X-Kofra-Version": version }),
    body: { cancel: () => new Promise<void>(() => {}) },
  }) as unknown as Response;
const rejectingCancelRes = (version: string) =>
  ({
    ok: true,
    status: 200,
    headers: new Headers({ "X-Kofra-Version": version }),
    body: {
      cancel: async () => {
        throw new Error("cancel boom");
      },
    },
  }) as unknown as Response;

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "zip-base-live-wait-"));
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
  apiKey = JSON.parse(await readFile(join(configDir, "credentials.json"), "utf8")).instances[api].key as string;
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

describe("ZIP --base through the real CLI and Worker", () => {
  it("publishes a ZIP ordinarily (control)", async () => {
    const zipPath = join(work, "ordinary-site.zip");
    await writeZip(zipPath, { "index.html": "<p>zip-ordinary-v1</p>", "a.css": "p{color:blue}" });
    const r = await cli(["publish", zipPath, "--site", "zip-ordinary-acceptance", "--json", "--no-save"]);
    expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ ok: true, slug: "zip-ordinary-acceptance", created: true, unchanged: false, files: 2 });
    expect(json.version.number).toBe(1);
    expect(r.stderr).not.toContain('"ok"');
    expect(r.stdout + r.stderr).not.toContain(apiKey);
    const live = await liveText(json.url as string);
    expect(live.status).toBe(200);
    expect(live.text).toBe("<p>zip-ordinary-v1</p>");
    expect(live.version).toBe(json.version.id as string);
    const posts = r.wire.filter((w) => w.method === "POST");
    expect(posts).toHaveLength(1);
    expect(new URL(posts[0]!.url).pathname).toBe("/api/v1/publish");
  });

  it("rejects a ZIP update with a stale --base: exit 5, live unchanged", async () => {
    const slug = "zip-stale-acceptance";
    const zip1 = join(work, "zip-stale-v1.zip");
    await writeZip(zip1, { "index.html": "zip-stale-v1" });
    const first = await cli(["publish", zip1, "--site", slug, "--json", "--no-save"]);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const id1 = first.json.version.id as string;
    const url = first.json.url as string;
    const zip2 = join(work, "zip-stale-v2.zip");
    await writeZip(zip2, { "index.html": "zip-stale-v2" });
    const second = await cli(["publish", zip2, "--site", slug, "--json", "--no-save"]);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    const id2 = second.json.version.id as string;
    expect(second.json.version.number).toBe(2);

    const zip3 = join(work, "zip-stale-v3.zip");
    await writeZip(zip3, { "index.html": "zip-stale-v3" });
    const stale = await cli(["publish", zip3, "--site", slug, "--base", id1, "--json", "--no-save"]);
    expect(stale.code, `stale ZIP --base must conflict, got: ${stale.stdout}${stale.stderr}`).toBe(EXIT.conflict);
    const json = expectSingleJson(stale.stdout);
    expect(json).toMatchObject({ ok: false, exitCode: 5 });
    expect(json.error.code).toBe("version_conflict");
    expect(stale.stderr).not.toContain('"ok"');
    expect(stale.stdout + stale.stderr).not.toContain(apiKey);

    const posts = stale.wire.filter((w) => w.method === "POST");
    expect(posts, "a conflicted publish is sent once, never retried").toHaveLength(1);
    const postUrl = new URL(posts[0]!.url);
    expect(postUrl.pathname, "no new endpoint for the ZIP guard").toBe("/api/v1/publish");
    expect(postUrl.searchParams.get("baseVersionId"), "--base must reach the server").toBe(id1);

    const live = await liveText(url);
    expect(live.status).toBe(200);
    expect(live.text, "stale base leaves live bytes unchanged").toBe("zip-stale-v2");
    expect(live.version, "stale base leaves the live version unchanged").toBe(id2);
    const vers = await apiJson(`/api/v1/sites/${slug}/versions`);
    expect(vers.currentVersionId).toBe(id2);
    expect(vers.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
  });

  it("accepts a ZIP update with the current --base (control)", async () => {
    const slug = "zip-current-acceptance";
    const zip1 = join(work, "zip-current-v1.zip");
    await writeZip(zip1, { "index.html": "zip-current-v1" });
    const first = await cli(["publish", zip1, "--site", slug, "--json", "--no-save"]);
    expect(first.code).toBe(0);
    const zip2 = join(work, "zip-current-v2.zip");
    await writeZip(zip2, { "index.html": "zip-current-v2" });
    const second = await cli(["publish", zip2, "--site", slug, "--json", "--no-save"]);
    expect(second.code).toBe(0);
    const id2 = second.json.version.id as string;
    const zip3 = join(work, "zip-current-v3.zip");
    await writeZip(zip3, { "index.html": "zip-current-v3" });
    const third = await cli(["publish", zip3, "--site", slug, "--base", id2, "--json", "--no-save"]);
    expect(third.code, third.stdout + third.stderr).toBe(0);
    expect(third.json.version.number).toBe(3);
    const live = await liveText(third.json.url as string);
    expect(live.text).toBe("zip-current-v3");
    expect(live.version).toBe(third.json.version.id as string);
  });

  it("rejects a manifest update with a stale --base without retry (control)", async () => {
    const slug = "manifest-stale-acceptance";
    const dir = await project(slug, { "index.html": "manifest-v1" });
    const first = await cli(["publish", dir, "--site", slug, "--json", "--no-save"]);
    expect(first.code).toBe(0);
    const id1 = first.json.version.id as string;
    await writeFile(join(dir, "index.html"), "manifest-v2");
    const second = await cli(["publish", dir, "--site", slug, "--json", "--no-save"]);
    expect(second.code).toBe(0);
    const id2 = second.json.version.id as string;
    await writeFile(join(dir, "index.html"), "manifest-v3");
    const stale = await cli(["publish", dir, "--site", slug, "--base", id1, "--json", "--no-save"]);
    expect(stale.code, stale.stdout + stale.stderr).toBe(EXIT.conflict);
    expect(stale.json.error.code).toBe("version_conflict");
    const deployPosts = stale.wire.filter((w) => w.method === "POST" && new URL(w.url).pathname.includes("/deploys"));
    expect(deployPosts, "a conflicted manifest publish is sent once").toHaveLength(1);
    const live = await liveText(second.json.url as string);
    expect(live.text).toBe("manifest-v2");
    expect(live.version).toBe(id2);
  });

  it("server enforces baseVersionId for ZIP one-shot publish (control)", async () => {
    const slug = "zip-direct-acceptance";
    const postZip = async (content: string, base: string | null) => {
      const body = zipSync({ "index.html": strToU8(content) });
      const url = `${api}/api/v1/publish?slug=${slug}${base ? `&baseVersionId=${encodeURIComponent(base)}` : ""}`;
      return fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/zip" },
        body: new Blob([body]),
      });
    };
    const r1 = await postZip("direct-v1", null);
    expect(r1.status).toBe(201);
    const id1 = ((await r1.json()) as any).version.id as string;
    const r2 = await postZip("direct-v2", null);
    expect(r2.status).toBe(200);
    const id2 = ((await r2.json()) as any).version.id as string;
    const stale = await postZip("direct-v3", id1);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).error.code).toBe("version_conflict");
    const live = await liveText(`${api}/s/${slug}/`);
    expect(live.text).toBe("direct-v2");
    expect(live.version).toBe(id2);
  });

  it("ZIP --dry-run stays offline with no writes (control)", async () => {
    const zipPath = join(work, "dryrun.zip");
    await writeZip(zipPath, { "index.html": "<p>dry</p>" });
    const freshConfig = join(work, "dryrun-zip-config");
    const freshCwd = await mkdtemp(join(work, "dryrun-zip-cwd-"));
    const r = await cli(["publish", zipPath, "--dry-run", "--json"], {
      onlyEnv: { KOFRA_CONFIG_DIR: freshConfig, KOFRA_API: api },
      cwd: freshCwd,
      fetch: async () => {
        throw new Error("dry-run must stay offline");
      },
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ dryRun: true, zip: true });
    expect(r.wire).toHaveLength(0);
    await expect(readFile(join(freshConfig, "credentials.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(freshCwd, "dropway.json"), "utf8")).rejects.toThrow();
    expect(r.stderr).not.toContain('"ok"');
  });

  it("folder --dry-run stays offline with no writes (control)", async () => {
    const dir = await project("dryrun-folder", { "index.html": "<p>dry</p>", "a.txt": "hi" });
    const freshConfig = join(work, "dryrun-folder-config");
    const freshCwd = await mkdtemp(join(work, "dryrun-folder-cwd-"));
    const r = await cli(["publish", dir, "--dry-run", "--json"], {
      onlyEnv: { KOFRA_CONFIG_DIR: freshConfig, KOFRA_API: api },
      cwd: freshCwd,
      fetch: async () => {
        throw new Error("dry-run must stay offline");
      },
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const json = expectSingleJson(r.stdout);
    expect(json).toMatchObject({ dryRun: true });
    expect(json.files).toHaveLength(2);
    expect(r.wire).toHaveLength(0);
    await expect(readFile(join(freshConfig, "credentials.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(freshCwd, "dropway.json"), "utf8")).rejects.toThrow();
  });
});

describe("live-version wait is bounded and requires success plus version", () => {
  it("never-resolving fetch does not strand the helper", async () => {
    const result = await mustSettle(
      waitForVersion("https://site.example/", "v_1", { timeoutMs: 100, intervalMs: 10, fetch: () => new Promise<Response>(() => {}) }),
      1000,
      "never-resolving fetch",
    );
    expect(result).toBe(false);
  });

  it("honors AbortSignal and terminates on expiry", async () => {
    const signals: AbortSignal[] = [];
    const result = await mustSettle(
      waitForVersion("https://site.example/", "v_1", {
        timeoutMs: 100,
        intervalMs: 10,
        fetch: async (req: Request) => {
          signals.push(req.signal);
          return new Promise<Response>((_, reject) => {
            req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          });
        },
      }),
      1000,
      "AbortSignal fetch",
    );
    expect(result).toBe(false);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]!.aborted, "expiry aborts the outstanding poll").toBe(true);
  });

  it("slow fetch past the deadline resolves at the deadline with no post-deadline poll", async () => {
    const starts: number[] = [];
    const t0 = Date.now();
    const result = await waitForVersion("https://site.example/", "v_1", {
      timeoutMs: 100,
      intervalMs: 10,
      fetch: async () => {
        starts.push(Date.now() - t0);
        await sleep(2000);
        return okRes("v_0");
      },
    });
    expect(result).toBe(false);
    expect(Date.now() - t0, "in-flight waits count against the budget").toBeLessThan(1000);
    expect(starts, "no poll starts after the deadline").toHaveLength(1);
  });

  it("hanging body.cancel does not strand the helper", async () => {
    const result = await mustSettle(
      waitForVersion("https://site.example/", "v_1", { timeoutMs: 100, intervalMs: 10, fetch: async () => hangingCancelRes("v_1") }),
      1000,
      "hanging body.cancel",
    );
    expect(result).toBe(false);
  });

  it("rejecting body.cancel with a matching header is not live", async () => {
    const result = await waitForVersion("https://site.example/", "v_1", {
      timeoutMs: 0,
      intervalMs: 1,
      fetch: async () => rejectingCancelRes("v_1"),
    });
    expect(result).toBe(false);
  });

  it("403 with a matching X-Kofra-Version is not live", async () => {
    const result = await waitForVersion("https://site.example/", "v_1", {
      timeoutMs: 0,
      intervalMs: 1,
      fetch: async () => errRes("v_1", 403),
    });
    expect(result).toBe(false);
  });

  it("500 with a matching X-Kofra-Version is not live", async () => {
    const result = await waitForVersion("https://site.example/", "v_1", {
      timeoutMs: 0,
      intervalMs: 1,
      fetch: async () => errRes("v_1", 500),
    });
    expect(result).toBe(false);
  });

  it("error statuses with a matching legacy header are not live", async () => {
    for (const status of [403, 500]) {
      const result = await waitForVersion("https://site.example/", "v_1", {
        timeoutMs: 0,
        intervalMs: 1,
        fetch: async () => errRes("v_1", status, "X-Dropway-Version"),
      });
      expect(result, `HTTP ${status} with a matching legacy header`).toBe(false);
    }
  });

  it("200 with a matching X-Kofra-Version is live (control)", async () => {
    const result = await waitForVersion("https://site.example/", "v_1", {
      timeoutMs: 0,
      intervalMs: 1,
      fetch: async () => okRes("v_1"),
    });
    expect(result).toBe(true);
  });

  it("200 with a matching legacy header is live (control)", async () => {
    const result = await waitForVersion("https://site.example/", "v_1", {
      timeoutMs: 0,
      intervalMs: 1,
      fetch: async () => okRes("v_1", "X-Dropway-Version"),
    });
    expect(result).toBe(true);
  });

  it("200 with a wrong or missing version is not live (control)", async () => {
    expect(
      await waitForVersion("https://site.example/", "v_1", { timeoutMs: 0, intervalMs: 1, fetch: async () => okRes("v_0") }),
    ).toBe(false);
    expect(
      await waitForVersion("https://site.example/", "v_1", {
        timeoutMs: 0,
        intervalMs: 1,
        fetch: async () => new Response("ok", { status: 200 }),
      }),
    ).toBe(false);
  });

  it("network error is not live and stays bounded (control)", async () => {
    const result = await mustSettle(
      waitForVersion("https://site.example/", "v_1", {
        timeoutMs: 0,
        intervalMs: 1,
        fetch: async () => {
          throw new Error("boom");
        },
      }),
      1000,
      "network error",
    );
    expect(result).toBe(false);
  });

  it("fast wrong-version polls stop at the deadline (control)", async () => {
    const starts: number[] = [];
    const t0 = Date.now();
    const result = await waitForVersion("https://site.example/", "v_1", {
      timeoutMs: 200,
      intervalMs: 10,
      fetch: async () => {
        starts.push(Date.now() - t0);
        return okRes("v_0");
      },
    });
    expect(result).toBe(false);
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.length).toBeLessThan(50);
    for (const s of starts) expect(s).toBeLessThan(1000);
  });

  it("publish and client stay fetch-only (control)", async () => {
    const entries = [
      ["publish.ts", await readFile(join(root, "packages/cli/src/publish.ts"), "utf8")],
      ["client.ts", await readFile(join(root, "packages/cli/src/client.ts"), "utf8")],
    ] as const;
    for (const [name, text] of entries) {
      expect(text, `${name} stays fetch-only`).not.toMatch(/from\s+["']node:/);
      expect(text, `${name} stays fetch-only`).not.toMatch(/\bprocess\./);
      expect(text, `${name} stays fetch-only`).not.toMatch(/\bBuffer\./);
    }
  });
});

describe("CLI --wait-timeout bounds a stalled live URL", () => {
  it("stalled live poll exits 8 within budget with actionable JSON", async () => {
    const dir = await project("wait-stalled", { "index.html": "wait-stalled-v1" });
    const liveStarts: number[] = [];
    const signals: AbortSignal[] = [];
    const t0 = Date.now();
    const stallingFetch = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) return fetch(req);
      liveStarts.push(Date.now() - t0);
      signals.push(req.signal);
      return new Promise<Response>((_, reject) => {
        req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    };
    const r = await mustSettle(
      cli(["publish", dir, "--site", "wait-stalled-acceptance", "--wait", "--wait-timeout", "1", "--json", "--no-save"], {
        fetch: stallingFetch,
      }),
      10_000,
      "CLI --wait with a stalled live URL",
    );
    expect(r.code).toBe(EXIT.waitTimeout);
    const json = expectSingleJson(r.stdout);
    expect(json.live).toBe(false);
    expect(json.ok).toBe(true);
    expect(r.stderr).toMatch(/did not serve|catches up|within 1s/i);
    expect(liveStarts.length).toBeGreaterThanOrEqual(1);
    expect(liveStarts, "no poll starts after the deadline").toHaveLength(1);
    expect(signals[0]!.aborted, "expiry aborts the outstanding poll").toBe(true);
    expect(r.stdout + r.stderr).not.toContain(apiKey);
    for (const w of r.wire) {
      if (!new URL(w.url).pathname.startsWith("/api/")) expect(w.method, "wait polls, never mutates").toBe("GET");
    }
  });
});
