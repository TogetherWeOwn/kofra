/**
 * Offline command acceptance; synthetic inputs only, no Worker or credentials required.
 * Run: npm run test:cli -- test/publish-omissions.acceptance.test.ts
 * Additive wire contract: omissions: [{ path, reason }], sorted by relative path.
 * The generic "ignored" code deliberately does not require new matcher provenance.
 * Refusal metadata uses error.details.omissions; legacy result fields stay intact.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectFiles } from "../src/files.ts";
import { run, type Io } from "../src/main.ts";

const forbidden = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/config.ts", async (original) => ({
  ...await original<typeof import("../src/config.ts")>(),
  writeLink: async () => { forbidden.calls.push("project-link write"); throw new Error("forbidden project-link write"); },
  saveCredentials: async () => { forbidden.calls.push("credential write"); throw new Error("forbidden credential write"); },
  removeCredentials: async () => { forbidden.calls.push("credential removal"); throw new Error("forbidden credential removal"); },
}));
vi.mock("../src/encrypt.ts", () => ({
  encryptFiles: async () => { forbidden.calls.push("encrypted payload/key generation"); throw new Error("forbidden encryption"); },
}));

const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const manifestFile = (path: string, text: string) => ({ path, size: Buffer.byteLength(text), sha256: digest(text) });
const noFilesHint = "Check the path, and .dropwayignore rules.";
let work: string;
let cwd: string;
let config: string;

beforeEach(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "kofra-omissions-"));
  cwd = join(work, "project");
  config = join(work, "config-not-created");
  await mkdir(cwd);
  forbidden.calls.length = 0;
  vi.stubGlobal("fetch", async () => { forbidden.calls.push("global fetch"); throw new Error("forbidden network"); });
  vi.spyOn(globalThis.crypto.subtle, "generateKey").mockImplementation(async () => {
    forbidden.calls.push("key generation"); throw new Error("forbidden key generation");
  });
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
    forbidden.calls.push("random key material"); throw new Error("forbidden random key material");
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(work, { recursive: true, force: true });
});

async function tree(files: Record<string, string>, root = cwd) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

/** Do not follow symlinks; catch new files, content changes and permission changes. */
async function inventory(root: string, prefix = ""): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const abs = join(root, path);
    const st = await lstat(abs);
    rows.push({ path, mode: st.mode, value: st.isSymbolicLink() ? await readlink(abs) : st.isFile() ? digest(await readFile(abs)) : "directory" });
    if (st.isDirectory()) rows.push(...await inventory(root, path));
  }
  return rows;
}

async function command(args: string[], options: { root?: string; env?: NodeJS.ProcessEnv; fetch?: Io["fetch"] } = {}) {
  let stdout = "";
  let stderr = "";
  const before = await inventory(work);
  const io: Io = {
    cwd: options.root ?? cwd,
    env: { KOFRA_CONFIG_DIR: config, ...options.env },
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    stdinIsTTY: false,
    stderrIsTTY: false,
    readStdin: async () => { forbidden.calls.push("stdin"); throw new Error("forbidden stdin"); },
    prompt: async () => { forbidden.calls.push("prompt"); throw new Error("forbidden prompt"); },
    fetch: options.fetch ?? (async () => { forbidden.calls.push("injected fetch"); throw new Error("forbidden network"); }),
  };
  const code = await run(args, io);
  expect(forbidden.calls, "inventory/refusal must not contact a service, write config, prompt or encrypt").toEqual([]);
  expect(await inventory(work), "publish inventory/refusal must be read-only").toEqual(before);
  // Parsing the ENTIRE stdout rejects notes, multiple objects and trailing text.
  const json = args.includes("--json") ? JSON.parse(stdout) : undefined;
  return { code, stdout, stderr, json };
}

const dry = (extra: string[] = []) => command(["publish", ".", "--dry-run", "--json", ...extra]);
const authenticated = ["--api", "https://inventory.invalid", "--key", "dw_synthetic_not_a_credential"];

async function mixed(root = cwd, reverse = false) {
  const entries = Object.entries({
    ".dropwayignore": "drafts/\n*.map\n!keep.map\n",
    ".env": "OMITTED_CONTENT_SENTINEL=synthetic\n",
    ".git/config": "OMITTED_CONTENT_SENTINEL",
    "assets/app.js": "console.log(1)",
    "assets/app.js.map": "OMITTED_CONTENT_SENTINEL",
    "drafts/wip.html": "OMITTED_CONTENT_SENTINEL",
    "dropway.json": '{"api":"https://inventory.invalid","sites":{}}',
    "index.html": "<h1>hi</h1>",
    "keep.map": "kept",
  });
  await tree(Object.fromEntries(reverse ? entries.reverse() : entries), root);
  await symlink(join(root, "assets"), join(root, "linked-dir"));
  await symlink(join(work, "absent-target"), join(root, "broken"));
  await symlink(join(root, "index.html"), join(root, "file-alias.html"));
}

const mixedManifest = [
  manifestFile("assets/app.js", "console.log(1)"),
  manifestFile("file-alias.html", "<h1>hi</h1>"),
  manifestFile("index.html", "<h1>hi</h1>"),
  manifestFile("keep.map", "kept"),
];
const mixedIgnored = [".dropwayignore", ".env", ".git/", "assets/app.js.map", "drafts/"];
const mixedOmissions = [
  { path: ".dropwayignore", reason: "ignored" },
  { path: ".env", reason: "ignored" },
  { path: ".git/", reason: "ignored" },
  { path: "assets/app.js.map", reason: "ignored" },
  { path: "broken", reason: "broken_symlink" },
  { path: "drafts/", reason: "ignored" },
  { path: "dropway.json", reason: "excluded" },
  { path: "linked-dir", reason: "symlink_directory" },
];

describe("publish omission inventory: additive command-level goldens", () => {
  it("preserves baseline included paths, hashes, byte totals and ignored fields, including regular-file symlinks", async () => {
    await mixed();
    const baseline = await collectFiles(cwd, { exclude: [join(cwd, "dropway.json")] });
    expect(baseline.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))).toEqual(mixedManifest);
    expect(baseline.ignored).toEqual(mixedIgnored);
    const r = await dry();
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, dryRun: true, path: ".", files: mixedManifest, totalBytes: 40, ignored: mixedIgnored });
    expect(r.stdout + r.stderr).not.toContain("OMITTED_CONTENT_SENTINEL");
    expect(r.stdout + r.stderr).not.toContain(work);
    expect(r.stderr).toContain("linked-dir");
  });

  it.each([
    ["built-in file", { ".env": "synthetic" }, [{ path: ".env", reason: "ignored" }]],
    ["built-in directory", { "node_modules/x.js": "synthetic" }, [{ path: "node_modules/", reason: "ignored" }]],
    ["custom pattern", { ".dropwayignore": "*.map\n", "debug.map": "synthetic" }, [
      { path: ".dropwayignore", reason: "ignored" }, { path: "debug.map", reason: "ignored" },
    ]],
  ] as const)("explains %s without enumerating pruned descendants", async (_name, files, omissions) => {
    await tree({ ...files, "index.html": "ok" });
    const r = await dry();
    expect(r.code).toBe(0);
    expect(r.json.files).toEqual([manifestFile("index.html", "ok")]);
    expect(r.json.omissions).toEqual(omissions);
  });

  it("explains the explicit project-link exclusion even when custom negation requests inclusion", async () => {
    await tree({ ".dropwayignore": "!dropway.json\n", "dropway.json": "{}", "index.html": "ok" });
    const r = await dry();
    expect(r.code).toBe(0);
    expect(r.json.ignored).toEqual([".dropwayignore"]);
    expect(r.json.files).toEqual([manifestFile("index.html", "ok")]);
    expect(r.json.omissions).toEqual([
      { path: ".dropwayignore", reason: "ignored" }, { path: "dropway.json", reason: "excluded" },
    ]);
  });

  it("explains skipped directory links and loops without following them or disclosing absolute targets", async () => {
    await tree({ "index.html": "ok" });
    await tree({ "hidden.txt": "OUTSIDE_CONTENT_SENTINEL" }, join(work, "outside"));
    await symlink(join(work, "outside"), join(cwd, "external-dir"));
    await symlink(cwd, join(cwd, "loop"));
    const r = await dry();
    expect(r.code).toBe(0);
    expect(r.json.files).toEqual([manifestFile("index.html", "ok")]);
    expect(r.stdout + r.stderr).not.toContain(work);
    expect(r.stdout + r.stderr).not.toContain("OUTSIDE_CONTENT_SENTINEL");
    expect(r.json.omissions).toEqual([
      { path: "external-dir", reason: "symlink_directory" }, { path: "loop", reason: "symlink_directory" },
    ]);
  });

  it("explains broken links by relative link name, never by the target", async () => {
    await tree({ "index.html": "ok" });
    await symlink(join(work, "PRIVATE_TARGET_SENTINEL"), join(cwd, "missing-link"));
    const r = await dry();
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("PRIVATE_TARGET_SENTINEL");
    expect(r.stdout + r.stderr).not.toContain(work);
    expect(r.json.omissions).toEqual([{ path: "missing-link", reason: "broken_symlink" }]);
  });

  it("returns the complete mixed-tree golden with stable ordering independent of creation order and root", async () => {
    await mixed();
    const other = join(work, "other-project");
    await mkdir(other);
    await mixed(other, true);
    const a = await dry();
    const b = await command(["publish", ".", "--dry-run", "--json"], { root: other });
    const again = await dry();
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(again.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toBe(again.stdout);
    expect(a.json.omissions).toEqual(mixedOmissions);
  });

  it("preserves last-match negation and pruned-parent semantics rather than inventing a second inclusion algorithm", async () => {
    await tree({
      ".dropwayignore": "*.map\n!keep.map\n.env\n!.env\nblocked/\n!blocked/keep.txt\n",
      ".env": "SAFE_SYNTHETIC=1", "drop.map": "omit", "keep.map": "keep", "blocked/keep.txt": "still pruned", "index.html": "ok",
    });
    const r = await dry();
    expect(r.code).toBe(0);
    expect(r.json.files).toEqual([
      manifestFile(".env", "SAFE_SYNTHETIC=1"), manifestFile("index.html", "ok"), manifestFile("keep.map", "keep"),
    ]);
    expect(r.json.ignored).toEqual([".dropwayignore", "blocked/", "drop.map"]);
    expect(r.json.omissions).toEqual([
      { path: ".dropwayignore", reason: "ignored" }, { path: "blocked/", reason: "ignored" }, { path: "drop.map", reason: "ignored" },
    ]);
  });

  it("sends the same literal manifest on real publish, using only an injected transport, not network", async () => {
    await mixed();
    const calls: { method: string; path: string; body: unknown }[] = [];
    const version = { id: "ver_synthetic", number: 1 };
    const r = await command(["publish", ".", "--json", "--site", "inventory", "--no-save", ...authenticated], {
      fetch: async (request) => {
        calls.push({ method: request.method, path: new URL(request.url).pathname, body: request.method === "POST" ? await request.json() : null });
        if (request.method === "POST" && new URL(request.url).pathname === "/api/v1/sites/inventory/deploys") {
          return Response.json({ unchanged: true, deploy: version, missing: [], uploads: [], finalizeUrl: null });
        }
        if (request.method === "GET" && new URL(request.url).pathname === "/api/v1/sites/inventory") {
          return Response.json({ site: { slug: "inventory", url: "https://inventory.invalid/s/inventory/", currentVersion: version } });
        }
        throw new Error("unexpected request to injected transport");
      },
    });
    expect(r.code).toBe(0);
    expect(calls).toEqual([
      { method: "POST", path: "/api/v1/sites/inventory/deploys", body: { files: mixedManifest } },
      { method: "GET", path: "/api/v1/sites/inventory", body: null },
    ]);
    const preview = await dry();
    expect(preview.json.files).toEqual(mixedManifest);
  });
});

describe("special files and human-readable output", () => {
  const fifo = process.platform === "win32" ? it.skip : it;

  fifo("records FIFOs, and links to them, as special_file without opening them", async () => {
    await tree({ "index.html": "ok" });
    execFileSync("mkfifo", [join(cwd, "pipe")]);
    await symlink(join(cwd, "pipe"), join(cwd, "pipe-alias"));
    const r = await dry();
    expect(r.code).toBe(0);
    expect(r.json.files).toEqual([manifestFile("index.html", "ok")]);
    expect(r.json.omissions).toEqual([{ path: "pipe", reason: "special_file" }, { path: "pipe-alias", reason: "special_file" }]);
  });

  it("names every non-ignored omission in the human dry-run summary", async () => {
    await mixed();
    const r = await command(["publish", ".", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Would publish 4 files");
    expect(r.stdout).toContain("Ignored: .dropwayignore, .env, .git/, assets/app.js.map, drafts/");
    expect(r.stdout).toContain("Omitted: broken (broken link), dropway.json (explicitly excluded), linked-dir (symlinked folder)");
    expect(r.stdout).not.toContain(work);
  });

  fifo("labels special files in the human dry-run summary", async () => {
    await tree({ "index.html": "ok" });
    execFileSync("mkfifo", [join(cwd, "pipe")]);
    const r = await command(["publish", ".", "--dry-run"]);
    expect(r.stdout).toContain("Omitted: pipe (not a regular file)");
  });
});

describe("empty payload refuses locally with useful omission metadata", () => {
  it.each(["--dry-run", "real", "encrypted-real"])("refuses an actually empty directory: %s", async (mode) => {
    const flags = mode === "--dry-run" ? [mode] : [...authenticated, ...(mode === "encrypted-real" ? ["--encrypt"] : [])];
    const r = await command(["publish", ".", "--json", ...flags]);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, exitCode: 2, error: { code: "no_files", retryable: false, hint: noFilesHint, details: { omissions: [] } } });
  });

  it.each(["--dry-run", "real"])("refuses an all-omitted tree before any request: %s", async (mode) => {
    await tree({ ".env": "synthetic", "dropway.json": "{}" });
    await symlink(join(work, "missing"), join(cwd, "broken"));
    await symlink(cwd, join(cwd, "linked-dir"));
    const r = await command(["publish", ".", "--json", ...(mode === "real" ? authenticated : [mode])]);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, exitCode: 2, error: { code: "no_files", retryable: false, hint: noFilesHint } });
    expect(r.stdout + r.stderr).not.toContain(work);
    expect(r.json.error.details?.omissions).toEqual([
      { path: ".env", reason: "ignored" }, { path: "broken", reason: "broken_symlink" },
      { path: "dropway.json", reason: "excluded" }, { path: "linked-dir", reason: "symlink_directory" },
    ]);
  });
});

describe("existing offline and fail-closed safety contracts", () => {
  it.each([{ flags: [] }, { flags: ["--encrypt"] }, { flags: ["--wait"] }, { flags: ["--anonymous"] }])("needs no URL, key, prompts, writes or encrypted payload for dry-run $flags", async ({ flags }) => {
    await tree({ "index.html": "ok" });
    const r = await dry(flags);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, dryRun: true, files: [manifestFile("index.html", "ok")], totalBytes: 2 });
    expect(r.json.url).toBeUndefined();
    expect(r.json.claimToken).toBeUndefined();
    expect(r.stdout + r.stderr).not.toContain(work);
  });

  it("does not resolve even malformed configured URLs or echo synthetic environment values", async () => {
    await tree({ "index.html": "ok" });
    const r = await command(["publish", ".", "--dry-run", "--json"], {
      env: { KOFRA_API: "ftp://INVALID_ENV_SENTINEL", KOFRA_API_KEY: "ENV_VALUE_SENTINEL" },
    });
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/INVALID_ENV_SENTINEL|ENV_VALUE_SENTINEL/);
  });

  it.each([true, false])("keeps secret refusal fail-closed without echoing matched contents (dry-run=%s)", async (preview) => {
    const secret = "ghp_" + "q".repeat(36);
    await tree({ "index.html": `const key = "${secret}";` });
    const r = await command(["publish", ".", "--json", ...(preview ? ["--dry-run"] : authenticated)]);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, error: { code: "possible_secrets" } });
    expect(r.json.error.details.findings).toEqual([{ path: "index.html", line: 1, kind: "github_token" }]);
    expect(r.json.error.hint).toContain("--allow-secrets");
    expect(r.stdout + r.stderr).not.toContain(secret);
  });

  it("retains explicit allow-secrets eligibility without printing file bytes", async () => {
    const text = 'const key = "' + "ghp_" + "q".repeat(36) + '";';
    await tree({ "index.html": text });
    const r = await dry(["--allow-secrets"]);
    expect(r.code).toBe(0);
    expect(r.json.files).toEqual([manifestFile("index.html", text)]);
    expect(r.stdout + r.stderr).not.toContain(text);
  });

  it("does not globally ignore link-looking filenames or report exclusions outside the publish root", async () => {
    await tree({ "dropway.json": "{}", "dist/dropway.json": "public config", "dist/index.html": "ok" });
    const r = await command(["publish", "dist", "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ path: "dist", files: [manifestFile("dropway.json", "public config"), manifestFile("index.html", "ok")], ignored: [] });
    expect(r.stdout + r.stderr).not.toContain("../");
  });

  it("preserves regular-file symlink eligibility even when its target is outside the publish root", async () => {
    await tree({ "public.txt": "public external file" }, join(work, "outside"));
    await symlink(join(work, "outside/public.txt"), join(cwd, "alias.txt"));
    const r = await dry();
    expect(r.code).toBe(0);
    expect(r.json.files).toEqual([manifestFile("alias.txt", "public external file")]);
    expect(r.json.ignored).toEqual([]);
    expect(r.stdout + r.stderr).not.toContain(work);
    expect(r.stdout + r.stderr).not.toContain("public external file");
  });

  it("keeps a single ordinary file rooted at its basename", async () => {
    await tree({ "nested/report.md": "# Report" });
    const r = await command(["publish", "nested/report.md", "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ path: "nested/report.md", files: [manifestFile("report.md", "# Report")], totalBytes: 8, ignored: [] });
  });

  it("keeps ZIP dry-run an opaque archive summary, not a local contents inventory", async () => {
    // Intentionally not a valid ZIP: local dry-run must not try to unpack/scan it.
    await tree({ "bundle.zip": "OPAQUE_ARCHIVE_SENTINEL" });
    const r = await command(["publish", "bundle.zip", "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, dryRun: true, path: "bundle.zip", zip: true, bytes: 23 });
    expect(r.json.files).toBeUndefined();
    expect(r.json.ignored).toBeUndefined();
    expect(r.json.omissions).toBeUndefined();
    expect(r.stdout).not.toContain("OPAQUE_ARCHIVE_SENTINEL");
    const human = await command(["publish", "bundle.zip", "--dry-run"]);
    expect(human.code).toBe(0);
    expect(human.stdout + human.stderr).toMatch(/instance unpacks|opaque|not inspect/i);
  });

  it.each([
    [["--encrypt"], "encrypted_zip_unsupported", "bundle.zip"],
    [["--encrypt", "--spa"], "encrypted_spa_unsupported", "."],
  ] as const)("preserves incompatible encryption option refusal: %j", async (flags, code, target) => {
    await tree({ "index.html": "ok", "bundle.zip": "opaque" });
    const r = await command(["publish", target, "--dry-run", "--json", ...flags]);
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, error: { code } });
  });
});
