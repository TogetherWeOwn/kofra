/**
 * Public acceptance contract (PUB-20): root action.yml, composite bash steps.
 * Inputs: folder, api (Kofra instance), token (Kofra key), github-token.
 * Outputs: url and slug on publish. Same repository + PR updates one preview;
 * another repository or PR gets another preview. Closed events need no folder.
 * Missing credentials and untrusted events must have no external side effects.
 * Real CLI + local Worker; GitHub REST comments are an in-memory HTTP fake.
 * No registry install, real GitHub call, privileged PR checkout, or deployment.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { actionMetadata, executeAction } from "./helpers/composite-action.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bootstrap = "local-preview-test-bootstrap-only";
const githubToken = "local-github-test-token-not-a-credential";
const html = "<h1>Preview bytes, not a mocked publish result</h1>";
const binary = new Uint8Array([0, 255, 42, 128]);
let work: string;
let api: string;
let githubApi: string;
let key: string;
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let github: Server;
let cliBundle: string;
let bin: string;
let fetchGuard: string;
let serial = 0;
let githubFailure = false;
interface Comment { id: number; body: string; user: { login: string; type: string }; }
const comments = new Map<string, Comment[]>();
const mutations: { method: string; path: string; body: any }[] = [];

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "preview-action-"));
  const persist = join(work, "state");
  await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  worker = await unstable_startWorker({
    config: join(root, "wrangler.jsonc"),
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
  });
  await worker.ready;
  api = (await worker.url).origin;
  const setup = await fetch(`${api}/api/v1/setup`, {
    method: "POST", headers: { Authorization: `Bearer ${bootstrap}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "preview@example.test" }),
  });
  expect(setup.status).toBe(201);
  key = (await setup.json() as any).apiKey.key;
  expect(typeof key).toBe("string");
  cliBundle = join(work, "kofra.mjs");
  await build({ entryPoints: [join(root, "packages/cli/src/cli.ts")], bundle: true, platform: "node", format: "esm", target: "node20", outfile: cliBundle, logLevel: "silent" });
  bin = join(work, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "dropway"), `#!/bin/sh\nexec "$TEST_NODE" "$TEST_CLI" "$@"\n`, { mode: 0o755 });
  // Unsupported external launchers fail closed instead of installing or sending data.
  for (const command of ["npx", "npm", "curl", "gh", "wget", "git"]) {
    await writeFile(join(bin, command), "#!/bin/sh\nprintf '%s\\n' 'external command disabled in offline action acceptance' >&2\nexit 97\n", { mode: 0o755 });
  }
  fetchGuard = join(work, "local-fetch-only.mjs");
  await writeFile(fetchGuard, `const realFetch = globalThis.fetch; globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!process.env.TEST_ALLOWED_ORIGINS.split(',').includes(url.origin)) throw new Error('nonlocal fetch disabled in offline action acceptance');
    return realFetch(input, init);
  };`);
  github = createServer(async (req, res) => {
    const url = new URL(req.url!, githubApi);
    const method = req.method!;
    res.setHeader("Content-Type", "application/json");
    const send = (status: number, value: unknown) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${githubToken}` && req.headers.authorization !== `token ${githubToken}`) return send(401, { message: "unauthorized" });
    if (githubFailure) return send(403, { message: `permission denied ${githubToken}` });
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const issue = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/);
    if (issue) {
      const target = `${issue[1]}#${issue[2]}`;
      const list = comments.get(target) ?? [];
      if (method === "GET") {
        const page = Number(url.searchParams.get("page") ?? 1);
        const size = Number(url.searchParams.get("per_page") ?? 30);
        if (list.length > page * size) res.setHeader("Link", `<${githubApi}${url.pathname}?per_page=${size}&page=${page + 1}>; rel="next"`);
        return send(200, list.slice((page - 1) * size, page * size));
      }
      if (method === "POST") {
        mutations.push({ method, path: url.pathname, body });
        const comment = { id: ++serial, body: body.body, user: { login: "github-actions[bot]", type: "Bot" } };
        comments.set(target, [...list, comment]);
        return send(201, comment);
      }
    }
    const edit = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/);
    if (edit && method === "PATCH") {
      const found = [...comments.entries()].filter(([target]) => target.startsWith(`${edit[1]}#`)).flatMap(([, list]) => list).find((comment) => comment.id === Number(edit[2]));
      if (found) {
        mutations.push({ method, path: url.pathname, body });
        found.body = body.body;
        return send(200, found);
      }
    }
    return send(404, { message: "unsupported test GitHub route" });
  });
  await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve));
  githubApi = `http://127.0.0.1:${(github.address() as any).port}`;
}, 120_000);

afterAll(async () => {
  if (github) await new Promise<void>((resolve, reject) => github.close((error) => error ? reject(error) : resolve()));
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function sites() {
  const response = await fetch(`${api}/api/v1/sites`, { headers: { Authorization: `Bearer ${key}` } });
  expect(response.status).toBe(200);
  return (await response.json() as any).sites.map((site: any) => site.slug).sort();
}

async function preview(options: { repository?: string; number?: number; action?: string; eventName?: string; fork?: boolean; folder?: boolean; content?: string; inputs?: Record<string, string>; setup?: (cwd: string) => Promise<void>; env?: Record<string, string> } = {}) {
  const repository = options.repository ?? "sample/docs";
  const number = options.number ?? ++serial + 100;
  const temp = await mkdtemp(join(work, "run-"));
  const cwd = join(temp, "workspace");
  await mkdir(cwd);
  if (options.folder !== false) {
    await mkdir(join(cwd, "build output/assets"), { recursive: true });
    await writeFile(join(cwd, "build output/index.html"), options.content ?? html);
    await writeFile(join(cwd, "build output/assets/data.bin"), binary);
  }
  if (options.setup) await options.setup(cwd);
  const repo = { id: repository === "sample/docs" ? 1001 : 2002, full_name: repository, fork: false };
  const event = {
    action: options.action ?? "opened", number, repository: repo,
    pull_request: {
      number, title: "Preview $(touch should-not-execute)", state: options.action === "closed" ? "closed" : "open",
      head: { sha: "b".repeat(40), ref: "preview-content", repo: options.fork ? { id: 3003, full_name: "outside/docs", fork: true } : repo },
      base: { ref: "main", repo },
    },
  };
  const result = await executeAction({
    root, cwd, temp, event, repository, eventName: options.eventName,
    inputs: { folder: "build output", api, token: key, "github-token": githubToken, ...options.inputs },
    // Do not inherit CI, host, cloud, or Paperclip credentials into action processes.
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: temp, RUNNER_TEMP: temp,
      GITHUB_TOKEN: options.inputs?.["github-token"] ?? githubToken, GITHUB_API_URL: githubApi,
      TEST_NODE: process.execPath, TEST_CLI: cliBundle, TEST_ALLOWED_ORIGINS: `${api},${githubApi}`,
      NODE_OPTIONS: `--import=${fetchGuard}`, KOFRA_CONFIG_DIR: join(temp, "config"), CI: "true",
      ...options.env,
    },
  });
  const visible = result.logs + JSON.stringify(result.outputs) + JSON.stringify([...comments.values()]);
  expect([key, githubToken].some((token) => visible.includes(token)), "credentials must not appear in logs, outputs, summaries, or comments").toBe(false);
  return { ...result, number, repository, cwd };
}

function published(result: Awaited<ReturnType<typeof preview>>) {
  expect(result.code, "publish must succeed").toBe(0);
  expect(result.outputs.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  expect(result.outputs.url).toBe(`${api}/s/${result.outputs.slug}/`);
}

/** The documented preview identity: pr-<sha256(repository)[:20]>-<PR number>. */
function previewSlug(repository: string, number: number) {
  return `pr-${createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 20)}-${number}`;
}

// Controls prove the real CLI and local runner work even before action.yml exists.
it("control: the existing CLI publishes the fixture bytes and deletes its named site", async () => {
  const folder = join(work, "control");
  await mkdir(folder);
  await writeFile(join(folder, "index.html"), html);
  const env = { PATH: process.env.PATH, KOFRA_API: api, KOFRA_API_KEY: key, KOFRA_CONFIG_DIR: join(work, "control-config") };
  const result = await promisify(execFile)(process.execPath, [cliBundle, "publish", folder, "--site", "preview-harness-control", "--json", "--no-save"], { env });
  const output = JSON.parse(result.stdout);
  expect(await (await fetch(`${output.url}?raw=1`)).text()).toBe(html);
  await promisify(execFile)(process.execPath, [cliBundle, "delete", output.slug, "--yes", "--json"], { env });
  expect((await sites()).includes(output.slug)).toBe(false);
});

it("control: local runner executes declared bash steps and resolves step outputs", async () => {
  const temp = await mkdtemp(join(work, "runner-control-"));
  await writeFile(join(temp, "action.yml"), JSON.stringify({
    runs: { using: "composite", steps: [{ id: "result", shell: "bash", run: 'printf "answer=executed\\n" >> "$GITHUB_OUTPUT"' }] },
    outputs: { answer: { value: "${{ steps.result.outputs.answer }}" } },
  }));
  const result = await executeAction({ root: temp, cwd: temp, temp, event: {}, repository: "sample/docs", inputs: {}, env: {} });
  expect(result).toMatchObject({ code: 0, outputs: { answer: "executed" } });
});

describe("composite PR preview acceptance", () => {
  it("ships root composite metadata with the public inputs and outputs", async () => {
    const metadata = await actionMetadata(root);
    expect(Object.keys(metadata.inputs)).toEqual(expect.arrayContaining(["folder", "api", "token", "github-token"]));
    expect(Object.keys(metadata.outputs)).toEqual(expect.arrayContaining(["url", "slug"]));
  });

  it("publishes exact folder bytes and comments the resulting URL on the correct PR", async () => {
    const result = await preview();
    published(result);
    expect(await (await fetch(`${result.outputs.url}?raw=1`)).text()).toBe(html);
    expect(new Uint8Array(await (await fetch(`${result.outputs.url}assets/data.bin?raw=1`)).arrayBuffer())).toEqual(binary);
    const posted = comments.get(`${result.repository}#${result.number}`)!;
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain(result.outputs.url);
    expect(posted[0]!.body).toMatch(/<!--[\s\S]+?-->/);
    await expect(readFile(join(result.cwd, "should-not-execute"))).rejects.toThrow();
  });

  it("keeps one identity across fresh runners, but isolates PRs and repositories", async () => {
    const first = await preview({ number: 201 });
    const repeat = await preview({ number: 201, action: "synchronize", content: "<h1>Updated preview</h1>" });
    const otherPr = await preview({ number: 202 });
    const otherRepo = await preview({ number: 201, repository: "another/docs" });
    for (const result of [first, repeat, otherPr, otherRepo]) published(result);
    expect(repeat.outputs.slug).toBe(first.outputs.slug);
    expect(await (await fetch(`${first.outputs.url}?raw=1`)).text()).toBe("<h1>Updated preview</h1>");
    expect(new Set([first.outputs.slug, otherPr.outputs.slug, otherRepo.outputs.slug]).size).toBe(3);
  });

  it("updates its marked comment beyond page one without touching unrelated comments", async () => {
    const first = await preview({ number: 203 });
    published(first);
    const target = "sample/docs#203";
    const original = comments.get(target)![0]!;
    const unrelated = Array.from({ length: 105 }, (_, i) => ({ id: 10000 + i, body: `unrelated ${i}`, user: { login: "person", type: "User" } }));
    comments.set(target, [...structuredClone(unrelated), { ...original, body: original.body.replace(first.outputs.url!, "https://stale.example.test/") }]);
    const start = mutations.length;
    const update = await preview({ number: 203, action: "synchronize" });
    published(update);
    expect(comments.get(target)).toHaveLength(106);
    expect(comments.get(target)!.slice(0, 105)).toEqual(unrelated);
    expect(comments.get(target)![105]).toMatchObject({ id: original.id, body: expect.stringContaining(update.outputs.url!) });
    expect(mutations.slice(start).filter((entry) => entry.method === "POST")).toHaveLength(0);
    expect(mutations.slice(start).some((entry) => entry.method === "PATCH")).toBe(true);
  });

  it("close deletes only that preview, without a build folder, and repeated close succeeds", async () => {
    const first = await preview({ number: 204 });
    const neighbor = await preview({ number: 205 });
    published(first); published(neighbor);
    const before = await sites();
    const closed = await preview({ number: 204, action: "closed", folder: false });
    expect(closed.code, "cleanup must not try to read or publish the absent build folder").toBe(0);
    expect(await sites()).toEqual(before.filter((slug: string) => slug !== first.outputs.slug));
    expect((await fetch(`${first.outputs.url}?raw=1`)).status).toBe(404);
    expect(await (await fetch(`${neighbor.outputs.url}?raw=1`)).text()).toBe(html);
    const again = await preview({ number: 204, action: "closed", folder: false });
    expect(again.code).toBe(0);
    expect(await sites()).toEqual(before.filter((slug: string) => slug !== first.outputs.slug));
  });

  it.each(["token", "github-token", "api"])("missing %s fails without publishing or commenting", async (name) => {
    const before = await sites();
    const count = mutations.length;
    const result = await preview({ inputs: { [name]: "" } });
    expect(result.code, "missing credentials must fail, not silently succeed").not.toBe(0);
    expect(result.outputs.url ?? "").toBe("");
    expect(result.outputs.slug ?? "").toBe("");
    expect(await sites()).toEqual(before);
    expect(mutations).toHaveLength(count);
  });

  it.each([
    { fork: true }, { eventName: "pull_request_target" }, { eventName: "workflow_run" }, { action: "edited" },
  ])("untrusted or unsupported context %j skips successfully with no side effects", async (context) => {
    const before = await sites();
    const count = mutations.length;
    const result = await preview(context);
    expect(result.code, "unsupported context must skip successfully").toBe(0);
    expect(await sites()).toEqual(before);
    expect(mutations).toHaveLength(count);
  });

  it("publish and cleanup authentication failures remain failures without leaking the key", async () => {
    const before = await sites();
    const count = mutations.length;
    for (const action of ["opened", "closed"]) {
      const result = await preview({ number: 206, action, folder: action !== "closed", inputs: { token: "dw_invalid_local_test_key" } });
      expect(result.code).not.toBe(0);
      expect(result.logs.includes("dw_invalid_local_test_key")).toBe(false);
    }
    expect(await sites()).toEqual(before);
    expect(mutations).toHaveLength(count);
  });

  it("a GitHub permission failure is reported without echoing its token", async () => {
    githubFailure = true;
    try {
      const result = await preview({ number: 207 });
      expect(result.code).not.toBe(0);
      expect(comments.has("sample/docs#207")).toBe(false);
    } finally { githubFailure = false; }
  });

  it("refuses a build containing a file symlink, so outside bytes are never published", async () => {
    const before = await sites();
    const count = mutations.length;
    const result = await preview({
      number: 208,
      setup: async (cwd) => {
        const secret = join(dirname(cwd), "private-ci-settings.json");
        await writeFile(secret, JSON.stringify({ environment: "staging", replicas: 2 }));
        await symlink(secret, join(cwd, "build output/assets/linked.json"));
      },
    });
    expect(result.code).not.toBe(0);
    expect(await sites()).toEqual(before);
    expect(mutations).toHaveLength(count);
    const slug = previewSlug("sample/docs", 208);
    expect((await fetch(`${api}/s/${slug}/assets/linked.json?raw=1`)).status).toBe(404);
  });

  it("refuses an existing folder outside the workspace", async () => {
    const before = await sites();
    const count = mutations.length;
    const result = await preview({
      number: 209, folder: false, inputs: { folder: "../outside" },
      setup: async (cwd) => {
        await mkdir(join(dirname(cwd), "outside"), { recursive: true });
        await writeFile(join(dirname(cwd), "outside/index.html"), html);
      },
    });
    expect(result.code).not.toBe(0);
    expect(await sites()).toEqual(before);
    expect(mutations).toHaveLength(count);
  });

  it("refuses a folder that is a symlink to outside the workspace", async () => {
    const before = await sites();
    const count = mutations.length;
    const result = await preview({
      number: 210, folder: false, inputs: { folder: "linked" },
      setup: async (cwd) => {
        await mkdir(join(dirname(cwd), "outside"), { recursive: true });
        await writeFile(join(dirname(cwd), "outside/index.html"), html);
        await symlink(join(dirname(cwd), "outside"), join(cwd, "linked"));
      },
    });
    expect(result.code).not.toBe(0);
    expect(await sites()).toEqual(before);
    expect(mutations).toHaveLength(count);
  });

  it.each([
    ["credential-bearing", (origin: string) => origin.replace("://", "://user:pass@")],
    ["whitespace", (origin: string) => `${origin} `],
    ["non-origin path", (origin: string) => `${origin}/api/v1`],
  ])("refuses a %s api URL without side effects", async (_label, mutate) => {
    const before = await sites();
    const count = mutations.length;
    const result = await preview({ number: 211, inputs: { api: mutate(api) } });
    expect(result.code).not.toBe(0);
    expect(await sites()).toEqual(before);
    expect(mutations).toHaveLength(count);
  });

  it("does not leak parent-only env or preloads into the CLI child", async () => {
    const dir = join(work, "sentinel");
    await mkdir(dir, { recursive: true });
    const marker = join(dir, "child-marker.txt");
    await rm(marker, { force: true });
    const recorder = join(dir, "recorder.mjs");
    await writeFile(recorder, `import { appendFileSync } from "node:fs";
if (process.env.KOFRA_API_KEY && process.env.DW_PARENT_ONLY) appendFileSync(${JSON.stringify(marker)}, "leaked\\n");
`);
    const result = await preview({ number: 212, env: { NODE_OPTIONS: `--import=${recorder}`, DW_PARENT_ONLY: "1" } });
    published(result);
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });

  it("cleanup with a key missing sites:read fails while the preview stays live", async () => {
    const first = await preview({ number: 213 });
    published(first);
    const created = await fetch(`${api}/api/v1/keys`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "write-only-cleanup", scopes: ["sites:write"] }),
    });
    expect(created.status).toBe(201);
    const writeOnly = (await created.json() as any).key;
    expect(typeof writeOnly).toBe("string");
    const closed = await preview({ number: 213, action: "closed", folder: false, inputs: { token: writeOnly } });
    expect(closed.code).not.toBe(0);
    expect(await (await fetch(`${first.outputs.url}?raw=1`)).text()).toBe(html);
  });

  it("cleanup with a neighbor-site-restricted key refuses instead of reporting success", async () => {
    const previewBytes = "<h1>Preview B must remain live</h1>";
    const neighborBytes = "<h1>Neighbor A must remain live</h1>";
    const first = await preview({ number: 216, content: previewBytes });
    const neighbor = await preview({ number: 217, content: neighborBytes });
    published(first); published(neighbor);
    expect(first.outputs.slug).not.toBe(neighbor.outputs.slug);
    const created = await fetch(`${api}/api/v1/keys`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "restricted-cleanup", scopes: ["sites:read", "sites:write"], site: neighbor.outputs.slug }),
    });
    expect(created.status).toBe(201);
    const restricted = (await created.json() as any).key;
    expect(typeof restricted).toBe("string");
    expect(/^dw_[A-Za-z0-9_-]{43}$/.test(restricted), "fixture must return a valid key without printing it").toBe(true);
    const identity = await promisify(execFile)(process.execPath, [cliBundle, "whoami", "--json"], {
      env: { PATH: process.env.PATH, KOFRA_API: api, KOFRA_API_KEY: restricted, KOFRA_CONFIG_DIR: join(work, "restricted-cleanup-config") },
    });
    expect((identity.stdout + identity.stderr).includes(restricted), "whoami must not print the restricted key").toBe(false);
    const whoami = JSON.parse(identity.stdout);
    expect(whoami.signedIn).toBe(true);
    expect(whoami.scopes).toEqual(["sites:read", "sites:write"]);
    expect(typeof whoami.siteRestriction).toBe("string");
    expect(Boolean(whoami.siteRestriction), "fixture identity must have a non-null site restriction").toBe(true);
    const before = await sites();
    expect(before).toEqual(expect.arrayContaining([first.outputs.slug, neighbor.outputs.slug]));
    const count = mutations.length;
    const beforeComments = structuredClone([...comments.entries()]);
    const closed = await preview({ number: 216, action: "closed", folder: false, inputs: { token: restricted } });
    const visible = closed.logs + JSON.stringify(closed.outputs) + JSON.stringify([...comments.values()]) + JSON.stringify(mutations);
    expect(visible.includes(restricted), "restricted key must not appear in logs, outputs, summaries, or comments").toBe(false);
    expect(closed.code, "site-restricted cleanup must fail, not claim another preview was deleted").not.toBe(0);
    expect(closed.outputs.url ?? "").toBe("");
    expect(closed.outputs.slug ?? "").toBe("");
    expect(await sites()).toEqual(before);
    const previewResponse = await fetch(`${first.outputs.url}?raw=1`);
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.text()).toBe(previewBytes);
    const neighborResponse = await fetch(`${neighbor.outputs.url}?raw=1`);
    expect(neighborResponse.status).toBe(200);
    expect(await neighborResponse.text()).toBe(neighborBytes);
    expect(mutations).toHaveLength(count);
    expect([...comments.entries()]).toEqual(beforeComments);
  });

  it("cleanup against a non-Kofra origin fails instead of reporting success", async () => {
    const before = await sites();
    // The fake GitHub API stands in for a foreign origin: authenticated requests
    // get plain 404s with no Kofra error envelope, which must never read as
    // "already absent".
    const result = await preview({ number: 214, action: "closed", folder: false, inputs: { api: githubApi, token: githubToken } });
    expect(result.code).not.toBe(0);
    expect(await sites()).toEqual(before);
  });

  it("updates only its own bot comment when others reuse the marker", async () => {
    const first = await preview({ number: 215 });
    published(first);
    const target = "sample/docs#215";
    const genuine = comments.get(target)![0]!;
    const marker = genuine.body.split("\n")[0]!;
    const foreign = { id: 99001, body: `${marker}\nUnrelated automation`, user: { login: "unrelated-app[bot]", type: "Bot" } };
    const human = { id: 99002, body: `${marker}\nCopied marker`, user: { login: "person", type: "User" } };
    comments.set(target, [foreign, human, { ...genuine, body: genuine.body.replace(first.outputs.url!, "https://stale.example.test/") }]);
    const start = mutations.length;
    const update = await preview({ number: 215, action: "synchronize" });
    published(update);
    const patches = mutations.slice(start).filter((entry) => entry.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.path).toBe(`/repos/sample/docs/issues/comments/${genuine.id}`);
    const list = comments.get(target)!;
    expect(list.find((comment) => comment.id === genuine.id)!.body).toContain(update.outputs.url!);
    expect(list.find((comment) => comment.id === 99001)!.body).toBe(foreign.body);
    expect(list.find((comment) => comment.id === 99002)!.body).toBe(human.body);
  });
});
