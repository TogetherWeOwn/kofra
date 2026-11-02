/**
 * Offline acceptance for the link-host env-key refusal (D14 step 2a).
 *
 * Contract: when the effective API origin comes only from the committed
 * ./dropway.json project link and the key comes from $KOFRA_API_KEY, no
 * command sends that key to that host: the CLI fails fast with
 * `env_key_to_link_host` (exit 2) before any request leaves the machine.
 * Unaffected combinations keep working: --api + env key, link + saved key,
 * link + anonymous publish, explicit --key, saved-default origins, and
 * commands run with projectLink: false (piped publish).
 *
 * Run: npm run test:cli -- test/link-env-key-refusal.test.ts
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveCredentials } from "../src/config.ts";
import { run, type Io } from "../src/main.ts";

const LINK_API = "https://someone-elses-host.invalid";
const OWN_API = "https://my-own-instance.invalid";
const ENV_KEY = "dw_synthetic_env_key_never_print_001";
const SAVED_KEY = "dw_synthetic_saved_key_never_print_002";
const FLAG_KEY = "dw_synthetic_flag_key_never_print_003";

let work: string;
let cwd: string;
let config: string;

beforeEach(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "kofra-link-refusal-"));
  cwd = join(work, "project");
  config = join(work, "config");
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  requests: Array<{ url: string; auth: string | null }>;
}

async function command(args: string[], opts: { env?: NodeJS.ProcessEnv; root?: string; stdinText?: string } = {}): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  const requests: Ran["requests"] = [];
  const io: Io = {
    cwd: opts.root ?? cwd,
    env: { KOFRA_CONFIG_DIR: config, HOME: work, ...opts.env },
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    stdinIsTTY: false,
    stderrIsTTY: false,
    readStdin: async () => opts.stdinText ?? "",
    prompt: async () => { throw new Error("refusal tests must never prompt"); },
    fetch: (async (request: Request) => {
      requests.push({ url: request.url, auth: request.headers.get("authorization") });
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/me") {
        return Response.json({ principal: "member", member: { email: "owner@example.com", role: "owner" }, scopes: ["sites:read"] });
      }
      throw new Error(`unexpected request to injected transport: ${request.method} ${url.pathname}`);
    }) as Io["fetch"],
  };
  const code = await run(args, io);
  return { code, stdout, stderr, requests };
}

async function writeProjectLink(root: string, api: string): Promise<void> {
  await writeFile(join(root, "dropway.json"), JSON.stringify({ api, sites: {} }));
}

function refusal(r: Ran): void {
  expect(r.code).toBe(2);
  expect(r.requests, "refusal must send no request").toEqual([]);
  const body = JSON.parse(r.stdout);
  expect(body).toMatchObject({ ok: false, exitCode: 2, error: { code: "env_key_to_link_host" } });
  expect(String(body.error.hint)).toMatch(/--api/);
  expect(String(body.error.hint)).toMatch(/kofra login/);
  for (const secret of [ENV_KEY, SAVED_KEY, FLAG_KEY]) {
    expect(r.stdout + r.stderr).not.toContain(secret);
  }
}

describe("env key to a link-only host is refused before any request", () => {
  it("whoami with a link host + env key fails fast with no request", async () => {
    await writeProjectLink(cwd, LINK_API);
    const r = await command(["whoami", "--json"], { env: { KOFRA_API_KEY: ENV_KEY } });
    refusal(r);
  });

  it("settings with a link host + env key fails fast with no request", async () => {
    await writeProjectLink(cwd, LINK_API);
    const r = await command(["settings", "some-site", "--json"], { env: { KOFRA_API_KEY: ENV_KEY } });
    refusal(r);
  });

  it("a real publish with a link host + env key fails before hashing or contacting anything", async () => {
    await writeProjectLink(cwd, LINK_API);
    await writeFile(join(cwd, "index.html"), "<h1>hi</h1>");
    const r = await command(["publish", ".", "--json"], { env: { KOFRA_API_KEY: ENV_KEY } });
    refusal(r);
  });

  it("human output names the error and the fix", async () => {
    await writeProjectLink(cwd, LINK_API);
    const r = await command(["whoami"], { env: { KOFRA_API_KEY: ENV_KEY } });
    expect(r.code).toBe(2);
    expect(r.requests).toEqual([]);
    expect(r.stderr).toMatch(/Error \(env_key_to_link_host\)/);
    expect(r.stderr).toMatch(/Fix: .*--api/);
    expect(r.stderr + r.stdout).not.toContain(ENV_KEY);
  });
});

describe("unaffected combinations keep working", () => {
  it("--api + env key reaches the instance", async () => {
    await writeProjectLink(cwd, LINK_API);
    const r = await command(["whoami", "--json", "--api", OWN_API], { env: { KOFRA_API_KEY: ENV_KEY } });
    expect(r.code).toBe(0);
    expect(r.requests.length).toBe(1);
    expect(r.requests[0]!.auth).toBe(`Bearer ${ENV_KEY}`);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, api: OWN_API });
  });

  it("link host + the saved key for that origin reaches the instance", async () => {
    await writeProjectLink(cwd, LINK_API);
    await saveCredentials(LINK_API, { key: SAVED_KEY }, { KOFRA_CONFIG_DIR: config, HOME: work });
    const r = await command(["whoami", "--json"]);
    expect(r.code).toBe(0);
    expect(r.requests.length).toBe(1);
    expect(r.requests[0]!.auth).toBe(`Bearer ${SAVED_KEY}`);
  });

  it("explicit --key names both endpoint and credential, so it reaches the link host", async () => {
    await writeProjectLink(cwd, LINK_API);
    const r = await command(["whoami", "--json", "--key", FLAG_KEY], { env: { KOFRA_API_KEY: ENV_KEY } });
    expect(r.code).toBe(0);
    expect(r.requests.length).toBe(1);
    expect(r.requests[0]!.auth).toBe(`Bearer ${FLAG_KEY}`);
  });

  it("saved-default origin + env key reaches the saved instance", async () => {
    await saveCredentials(OWN_API, { key: SAVED_KEY }, { KOFRA_CONFIG_DIR: config, HOME: work });
    const r = await command(["whoami", "--json"], { env: { KOFRA_API_KEY: ENV_KEY } });
    expect(r.code).toBe(0);
    expect(r.requests.length).toBe(1);
    expect(r.requests[0]!.url).toContain(new URL(OWN_API).host);
    expect(r.requests[0]!.auth).toBe(`Bearer ${ENV_KEY}`);
  });

  it("env origin + env key reaches the instance even with a foreign link present", async () => {
    await writeProjectLink(cwd, LINK_API);
    const r = await command(["whoami", "--json"], { env: { KOFRA_API: OWN_API, KOFRA_API_KEY: ENV_KEY } });
    expect(r.code).toBe(0);
    expect(r.requests.length).toBe(1);
    expect(r.requests[0]!.url).toContain(new URL(OWN_API).host);
  });

  it("link host + anonymous publish never sends the env key", async () => {
    await writeProjectLink(cwd, LINK_API);
    await writeFile(join(cwd, "index.html"), "<h1>hi</h1>");
    const requests: Ran["requests"] = [];
    let stdout = "";
    let stderr = "";
    const io: Io = {
      cwd,
      env: { KOFRA_CONFIG_DIR: config, HOME: work, KOFRA_API_KEY: ENV_KEY },
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      stdinIsTTY: false,
      stderrIsTTY: false,
      readStdin: async () => { throw new Error("anonymous publish must not read stdin"); },
      prompt: async () => { throw new Error("must never prompt"); },
      fetch: (async (request: Request) => {
        requests.push({ url: request.url, auth: request.headers.get("authorization") });
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/api/v1/sites") {
          return Response.json({ site: { slug: "anon-site", url: `${LINK_API}/s/anon-site/` }, claimToken: "dwc_synthetic_claim_never_print_004" });
        }
        if (request.method === "POST" && url.pathname === "/api/v1/sites/anon-site/deploys") {
          return Response.json({ unchanged: true, deploy: { id: "ver_1", number: 1 }, missing: [], uploads: [], finalizeUrl: null });
        }
        if (url.pathname === "/api/v1/sites/anon-site") {
          return Response.json({ site: { slug: "anon-site", url: `${LINK_API}/s/anon-site/`, currentVersion: null } });
        }
        throw new Error(`unexpected request to injected transport: ${request.method} ${url.pathname}`);
      }) as Io["fetch"],
    };
    const code = await run(["publish", ".", "--json", "--anonymous", "--no-save"], io);
    expect(code).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((req) => req.auth !== `Bearer ${ENV_KEY}`)).toBe(true);
    expect(stdout + stderr).not.toContain(ENV_KEY);
  });

  it("piped publish ignores the project link, so link + env key still works", async () => {
    await writeProjectLink(cwd, LINK_API);
    const requests: Ran["requests"] = [];
    let stdout = "";
    let stderr = "";
    const io: Io = {
      cwd,
      env: { KOFRA_CONFIG_DIR: config, HOME: work, KOFRA_API: OWN_API, KOFRA_API_KEY: ENV_KEY },
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
      stdinIsTTY: false,
      stderrIsTTY: false,
      readStdin: async () => "<h1>piped</h1>",
      prompt: async () => { throw new Error("must never prompt"); },
      fetch: (async (request: Request) => {
        requests.push({ url: request.url, auth: request.headers.get("authorization") });
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/api/v1/sites/piped-site/deploys") {
          return Response.json({ unchanged: true, deploy: { id: "ver_1", number: 1 }, missing: [], uploads: [], finalizeUrl: null });
        }
        if (url.pathname === "/api/v1/sites/piped-site") {
          return Response.json({ site: { slug: "piped-site", url: `${OWN_API}/s/piped-site/`, currentVersion: { id: "ver_1", number: 1 } } });
        }
        throw new Error(`unexpected request to injected transport: ${request.method} ${url.pathname}`);
      }) as Io["fetch"],
    };
    const code = await run(["publish", "--stdin", "index.html", "--json", "--site", "piped-site", "--no-save"], io);
    expect(code).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((req) => req.url.includes(new URL(OWN_API).host))).toBe(true);
    expect(stdout).not.toContain(ENV_KEY);
    expect(stderr).not.toContain(ENV_KEY);
  });
});
