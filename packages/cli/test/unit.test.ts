import { mkdtemp, mkdir, readFile, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/args.ts";
import { CliError, DropwayClient, EXIT, exitCodeForStatus, movedTo, normaliseApi, errorFromResponse } from "../src/client.ts";
import { run, type Io } from "../src/main.ts";
import { configDir, linkKey, readCredentials, readLink, removeCredentials, saveCredentials, writeLink } from "../src/config.ts";
import { collectFiles } from "../src/files.ts";
import { publish } from "../src/publish.ts";
import { IgnoreMatcher } from "../src/ignore.ts";
import { findSecrets } from "../src/secrets.ts";
import { VERSION } from "../src/version.ts";

const tmp = () => mkdtemp(join(tmpdir(), "dropway-cli-"));

describe("args", () => {
  const specs = { site: { kind: "string" as const, short: "s" }, json: { kind: "boolean" as const }, yes: { kind: "boolean" as const, short: "y" }, save: { kind: "boolean" as const } };

  it("parses values, booleans, --x=y, --no-x, short flags and --", () => {
    const p = parseArgs(["dist", "--site", "my-site", "--json", "-y", "--no-save", "--", "--literal"], specs);
    expect(p.positionals).toEqual(["dist", "--literal"]);
    expect(p.flags).toEqual({ site: "my-site", json: true, yes: true, save: false });
    expect(parseArgs(["--site=a"], specs).flags.site).toBe("a");
    expect(parseArgs(["-smy-site"], specs).flags.site).toBe("my-site");
  });

  it("rejects unknown flags and missing values", () => {
    expect(() => parseArgs(["--nope"], specs)).toThrow(UsageError);
    expect(() => parseArgs(["--site"], specs)).toThrow(/needs a value/);
    expect(() => parseArgs(["--site", "--json"], specs)).toThrow(/needs a value/);
  });
});

describe("client helpers", () => {
  it("normalises instance URLs", () => {
    expect(normaliseApi("https://x.example.dev/")).toBe("https://x.example.dev");
    expect(normaliseApi("x.example.dev/api/v1")).toBe("https://x.example.dev");
    expect(normaliseApi("localhost:8787")).toBe("http://localhost:8787");
    expect(() => normaliseApi("ftp://x")).toThrow(CliError);
  });

  it("maps HTTP statuses to exit codes", () => {
    expect([401, 403, 404, 409, 400, 413, 429, 500, 503].map(exitCodeForStatus)).toEqual([3, 3, 4, 5, 6, 6, 7, 7, 7]);
  });

  it("reads the API error envelope", async () => {
    const res = new Response(JSON.stringify({ error: { code: "version_conflict", message: "moved", hint: "refetch", details: { liveVersionId: "ver_1" } }, requestId: "r1" }), { status: 409 });
    const e = await errorFromResponse(res);
    expect(e.toJSON()).toEqual({ code: "version_conflict", message: "moved", hint: "refetch", status: 409, retryable: false, details: { liveVersionId: "ver_1" }, requestId: "r1" });
    expect(e.exitCode).toBe(EXIT.conflict);
    const html = await errorFromResponse(new Response("<html>nope</html>", { status: 502 }));
    expect(html.code).toBe("http_502");
    expect(html.retryable).toBe(true);
  });

  it("notices an instance that moved (Link rel=successor-version, Deprecation optional) once, and keeps using it", async () => {
    const moved = { Deprecation: "@1792713600", Link: '<https://kofra.test/api/v1/me>; rel="successor-version"', "Content-Type": "application/json" };
    expect(movedTo(new Response("{}", { headers: moved }), "https://old.test")).toBe("https://kofra.test");
    expect(movedTo(new Response("{}", { headers: moved }), "https://kofra.test")).toBeNull();
    // Link alone is enough (an instance moved without LEGACY_DEPRECATED_AT sends no Deprecation header).
    expect(movedTo(new Response("{}", { headers: { Link: moved.Link } }), "https://old.test")).toBe("https://kofra.test");
    expect(movedTo(new Response("{}", { headers: { ...moved, Link: '<https://kofra.test/x>; rel="describedby"' } }), "https://old.test")).toBeNull();
    expect(movedTo(new Response("{}", { headers: { ...moved, Link: '<javascript:alert(1)>; rel="successor-version"' } }), "https://old.test")).toBeNull();

    const seen: string[] = [];
    const urls: string[] = [];
    const client = new DropwayClient({
      api: "https://old.test",
      token: "dw_x",
      onMoved: (o) => seen.push(o),
      fetch: async (req) => {
        urls.push(req.url);
        expect(req.headers.get("authorization")).toBe("Bearer dw_x");
        return new Response(JSON.stringify({ principal: "member" }), { headers: moved });
      },
    });
    await client.get("/me");
    await client.get("/me");
    expect(seen).toEqual(["https://kofra.test"]);
    expect(urls).toEqual(["https://old.test/api/v1/me", "https://old.test/api/v1/me"]);

    let stderr = "";
    const io: Io = {
      stdout: () => {},
      stderr: (t) => void (stderr += t),
      stdinIsTTY: false,
      stderrIsTTY: false,
      readStdin: async () => "",
      prompt: async () => "",
      env: { KOFRA_CONFIG_DIR: await tmp() },
      cwd: await tmp(),
      fetch: async () => new Response(JSON.stringify({ principal: "member", member: { email: "a@b.c", role: "owner" }, scopes: [] }), { headers: moved }),
    };
    expect(await run(["whoami", "--api", "https://old.test", "--key", "dw_x", "--json"], io)).toBe(EXIT.ok);
    expect(stderr).toBe("Note: https://old.test has moved to https://kofra.test. The old address still works for now; make the new one your default with: kofra login --api https://kofra.test\n");
  });

  it("keeps VERSION in sync with package.json", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });

  it("maps a refused credential-bearing instance URL to the usage exit class", async () => {
    let calls = 0;
    const client = new DropwayClient({
      api: "http://remote.test", token: "dw_secret",
      fetch: async () => { calls++; return new Response("{}"); },
    });
    await expect(client.get("/sites")).rejects.toMatchObject({ code: "invalid_api_url", exitCode: EXIT.usage });
    expect(calls).toBe(0);
  });

  it("refuses an anonymous publish over non-loopback HTTP before creating a site it could not claim", async () => {
    let calls = 0;
    const client = new DropwayClient({
      api: "http://remote.test", token: null,
      fetch: async () => { calls++; return new Response("{}"); },
    });
    const file = { path: "index.html", size: 1, sha256: "a".repeat(64), body: async () => new Uint8Array([65]) };
    await expect(publish(client, [file])).rejects.toMatchObject({ code: "invalid_api_url", exitCode: EXIT.usage });
    expect(calls).toBe(0);
  });

  it("keeps an anonymous loopback publish working with the minted claim token", async () => {
    const seen: Array<[string, string, string | null]> = [];
    const client = new DropwayClient({
      api: "http://127.0.0.1:8787", token: null,
      fetch: async (req) => {
        const url = new URL(req.url);
        seen.push([req.method, url.pathname, req.headers.get("authorization")]);
        if (req.method === "POST" && url.pathname === "/api/v1/sites") {
          return new Response(JSON.stringify({ site: { slug: "anon-site", url: "http://127.0.0.1:8787/s/anon-site/" }, claimToken: "dwc_claim" }));
        }
        if (req.method === "POST" && url.pathname.endsWith("/deploys")) {
          return new Response(JSON.stringify({ unchanged: true, deploy: { id: "ver_1", number: 1 }, missing: [], uploads: [], finalizeUrl: null }));
        }
        return new Response(JSON.stringify({ site: { slug: "anon-site", url: "http://127.0.0.1:8787/s/anon-site/", currentVersion: null } }));
      },
    });
    const file = { path: "index.html", size: 1, sha256: "a".repeat(64), body: async () => new Uint8Array([65]) };
    const result = await publish(client, [file]);
    expect(result).toMatchObject({ slug: "anon-site", created: true, unchanged: true, claimToken: "dwc_claim" });
    expect(seen[0]).toEqual(["POST", "/api/v1/sites", null]);
    expect(seen[1]![2]).toBe("Bearer dwc_claim");
  });
});

describe("read-file continuation pinning", () => {
  const page = (over: Record<string, unknown> = {}) => ({
    path: "big.txt", versionId: "ver_pinned", contentType: "text/plain", kind: "text", size: 10,
    sha256: "abc123", encoding: "text", offset: 0, length: 5, truncated: true, nextOffset: 5,
    content: "ABCDE", url: "https://site.test/big.txt", rawUrl: "https://api.test/raw",
    ...over,
  });

  async function harness(body: Record<string, unknown>) {
    let out = "";
    let err = "";
    const io: Io = {
      stdout: (t) => void (out += t),
      stderr: (t) => void (err += t),
      stdinIsTTY: false,
      stderrIsTTY: false,
      readStdin: async () => "",
      prompt: async () => { throw new Error("read-file must never prompt"); },
      env: { KOFRA_CONFIG_DIR: await tmp() },
      cwd: await tmp(),
      fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
    };
    return { io, stdout: () => out, stderr: () => err };
  }

  const BASE = ["--api", "https://api.test", "--key", "dw_test_key"];

  it("pins the returned id even when the request used a mutable alias", async () => {
    const h = await harness(page());
    const code = await run(["read-file", "my-site", "big.txt", ...BASE, "--version", "live"], h.io);
    expect(code).toBe(EXIT.ok);
    expect(h.stdout()).toBe("ABCDE");
    expect(h.stderr()).toContain("Truncated: continue with: kofra read-file my-site big.txt --offset 5 --version ver_pinned");
  });

  it("adds the pinned id when --version was omitted", async () => {
    const h = await harness(page());
    const code = await run(["read-file", "my-site", "big.txt", ...BASE], h.io);
    expect(code).toBe(EXIT.ok);
    expect(h.stderr()).toContain("--version ver_pinned");
  });

  it.each(["live", "v2", "7", "", "   "])("refuses a guessed continuation for %j identity", async (versionId) => {
    const h = await harness(page({ versionId }));
    const code = await run(["read-file", "my-site", "big.txt", ...BASE, "--version", "live"], h.io);
    expect(code).toBe(EXIT.error);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toMatch(/Error \(bad_read_file_version\):/);
    expect(h.stderr()).toContain("Fix: ");
    expect(h.stderr()).not.toContain("continue with:");
  });
});

describe("ignore rules", () => {
  it("ignores credentials and VCS folders by default", () => {
    const m = new IgnoreMatcher();
    for (const p of [".git", ".env", ".env.local", "sub/.env", "certs/server.pem", "node_modules", ".npmrc", ".dev.vars"]) expect(m.ignores(p, p === ".git" || p === "node_modules")).toBe(true);
    for (const p of ["index.html", "env.js", "assets/app.js", ".well-known/security.txt", "key.txt"]) expect(m.ignores(p)).toBe(false);
  });

  it("supports anchors, globs, ** and negation", () => {
    const m = new IgnoreMatcher(["/drafts/", "*.map", "**/tmp/**", "!keep.map", "docs/*.psd"], { defaults: false });
    expect(m.ignoresWithParents("drafts/a.html")).toBe(true);
    expect(m.ignoresWithParents("sub/drafts/a.html")).toBe(false);
    expect(m.ignores("assets/app.js.map")).toBe(true);
    expect(m.ignores("keep.map")).toBe(false);
    expect(m.ignores("a/b/tmp/c.txt")).toBe(true);
    expect(m.ignores("docs/x.psd")).toBe(true);
    expect(m.ignores("other/docs/x.psd")).toBe(false);
  });
});

describe("secret scan", () => {
  it("finds high-signal credentials with the line number, and never echoes them", () => {
    const aws = "AKIA" + "Q".repeat(16);
    const pk = "-----BEGIN OPENSSH " + "PRIVATE KEY-----";
    const found = findSecrets("config.js", `const a = 1;\nconst k = "${aws}";\n${pk}\n`);
    expect(found).toEqual([
      { path: "config.js", line: 3, kind: "private_key" },
      { path: "config.js", line: 2, kind: "aws_access_key_id" },
    ]);
    expect(JSON.stringify(found)).not.toContain(aws);
  });

  it("does not flag ordinary code", () => {
    expect(findSecrets("app.js", 'const sk = "sk-short"; const AKIA = 1; fetch("/api/key")')).toEqual([]);
  });
});

describe("collectFiles", () => {
  it("walks a folder, applies ignores and .dropwayignore, hashes, and skips symlinked folders", async () => {
    const dir = await tmp();
    await mkdir(join(dir, "assets"), { recursive: true });
    await mkdir(join(dir, "drafts"));
    await writeFile(join(dir, "index.html"), "<h1>hi</h1>");
    await writeFile(join(dir, "assets/app.js"), "console.log(1)");
    await writeFile(join(dir, ".env"), "SECRET=1");
    await writeFile(join(dir, "drafts/wip.html"), "wip");
    await writeFile(join(dir, ".dropwayignore"), "drafts/\n");
    await symlink(join(dir, "assets"), join(dir, "linked"));
    const c = await collectFiles(dir);
    expect(c.kind).toBe("dir");
    expect(c.files.map((f) => f.path)).toEqual(["assets/app.js", "index.html"]);
    expect(c.ignored.sort()).toEqual([".dropwayignore", ".env", "drafts/"]);
    expect(c.skippedLinks).toEqual(["linked"]);
    const html = c.files.find((f) => f.path === "index.html")!;
    expect(html.sha256).toBe(createHash("sha256").update("<h1>hi</h1>").digest("hex"));
    expect(html.size).toBe(11);
    const body = await html.body();
    expect(new TextDecoder().decode(body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer()))).toBe("<h1>hi</h1>");
  });

  it("publishes a single named file at its base name, but never a credentials file", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "report.md"), "# Report");
    await writeFile(join(dir, ".env"), "X=1");
    const c = await collectFiles(join(dir, "report.md"));
    expect(c.kind).toBe("file");
    expect(c.files.map((f) => f.path)).toEqual(["report.md"]);
    await expect(collectFiles(join(dir, ".env"))).rejects.toMatchObject({ code: "ignored_file", exitCode: EXIT.usage });
    await expect(collectFiles(join(dir, "missing"))).rejects.toMatchObject({ code: "path_not_found" });
  });

  it("reports secrets found in text files", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "index.html"), `<script>const key = "${"ghp_" + "a".repeat(36)}"</script>`);
    const c = await collectFiles(dir);
    expect(c.secrets).toEqual([{ path: "index.html", line: 1, kind: "github_token" }]);
    expect((await collectFiles(dir, { allowSecrets: true })).secrets).toEqual([]);
  });
});

describe("config", () => {
  it("resolves the config dir from env", () => {
    expect(configDir({ KOFRA_CONFIG_DIR: "/x/y" })).toBe("/x/y");
    expect(configDir({ XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/dropway");
  });

  it("saves credentials owner-only and removes them", async () => {
    const env = { KOFRA_CONFIG_DIR: await tmp() };
    const path = await saveCredentials("https://a.example", { key: "dw_x", email: "a@example.com" }, env);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const creds = await readCredentials(env);
    expect(creds.default).toBe("https://a.example");
    expect(creds.instances["https://a.example"]?.key).toBe("dw_x");
    expect(await removeCredentials("https://a.example", env)).toBe(true);
    expect((await readCredentials(env)).instances).toEqual({});
  });

  it("links published paths to sites in dropway.json, without secrets", async () => {
    const cwd = await tmp();
    expect(linkKey(cwd, "./dist/")).toBe("dist");
    expect(linkKey(cwd, ".")).toBe(".");
    expect((await writeLink(cwd, "https://a.example", "dist", "bright-otter-x7k2")).created).toBe(true);
    await writeLink(cwd, "https://a.example", "docs", "docs-site");
    // A different instance never overwrites the link.
    await writeLink(cwd, "https://b.example", "dist", "other");
    const link = await readLink(cwd);
    expect(link?.api).toBe("https://a.example");
    expect(link?.sites).toEqual({ dist: "bright-otter-x7k2", docs: "docs-site" });
    expect(await readFile(join(cwd, "dropway.json"), "utf8")).not.toMatch(/dw_|dwc_/);
  });
});

describe("settings command hardening", () => {
  const specs = { api: { kind: "string" as const, once: true }, "dry-run": { kind: "boolean" as const, once: true } };
  const BASE = ["--api", "https://api.test", "--key", "dw_test_key"];

  async function harness(respond: () => Response = () => { throw new Error("unexpected network request"); }) {
    let out = "";
    let err = "";
    let requests = 0;
    const io: Io = {
      stdout: (t) => void (out += t),
      stderr: (t) => void (err += t),
      stdinIsTTY: false,
      stderrIsTTY: false,
      readStdin: async () => "",
      prompt: async () => { throw new Error("settings must never prompt"); },
      env: { KOFRA_CONFIG_DIR: await tmp() },
      cwd: await tmp(),
      fetch: async () => { requests++; return respond(); },
    };
    return { io, stdout: () => out, stderr: () => err, requests: () => requests };
  }

  it("rejects option names inherited from Object.prototype as unknown", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(() => parseArgs([`--${name}`, "boom"], specs)).toThrow(/Unknown option/);
      expect(() => parseArgs([`--${name}=boom`], specs)).toThrow(/Unknown option/);
    }
  });

  it("rejects an inherited flag name on the command before networking", async () => {
    for (const flag of ["--constructor=boom", "--toString"]) {
      const h = await harness();
      expect(await run(["settings", "test-site", "--spa", "false", "--dry-run", "--json", flag], h.io)).toBe(EXIT.usage);
      expect(JSON.parse(h.stdout()).error.code).toBe("usage");
      expect(h.requests()).toBe(0);
    }
  });

  it("rejects a repeated --api, --key or --dry-run before networking", async () => {
    for (const repeat of [
      ["--api", "https://a.test", "--api", "https://b.test"],
      ["--key", "dw_one", "--key", "dw_two"],
      ["--dry-run", "--dry-run"],
    ]) {
      const h = await harness();
      expect(await run(["settings", "test-site", "--spa", "false", "--dry-run", ...repeat], h.io)).toBe(EXIT.usage);
      expect(h.stderr()).toMatch(/only once/);
      expect(h.stdout()).toBe("");
      expect(h.requests()).toBe(0);
    }
  });

  it("rejects . and .. as the explicit site before networking", async () => {
    for (const slug of [".", ".."]) {
      const h = await harness();
      expect(await run(["settings", slug, "--spa", "false", "--dry-run", "--json"], h.io)).toBe(EXIT.usage);
      expect(JSON.parse(h.stdout()).error.code).toBe("usage");
      expect(h.requests()).toBe(0);
    }
  });

  it.each([
    ["spa", "false"],
    ["renderMarkdown", 1],
    ["crossOriginIsolation", "true"],
  ])("rejects a wrong-typed %s independently", async (field, value) => {
    const settings = { spa: false, renderMarkdown: true, crossOriginIsolation: false, [field]: value };
    const h = await harness(() => new Response(JSON.stringify({
      site: { id: "site_1", slug: "test-site", title: null, description: null, currentVersionId: null, settings },
    }), { status: 200 }));
    expect(await run(["settings", "test-site", ...BASE, "--json"], h.io)).toBe(EXIT.error);
    expect(h.requests()).toBe(1);
    expect(JSON.parse(h.stdout())).toMatchObject({ ok: false, exitCode: EXIT.error, error: { code: "invalid_response" } });
  });

  it("escapes terminal controls in human settings output without changing JSON", async () => {
    const response = { site: { id: "site_1", slug: "test-site", title: "title\u001b[2J", description: "first\nsecond", currentVersionId: null,
      settings: { spa: false, renderMarkdown: true, crossOriginIsolation: false } } };
    const human = await harness(() => new Response(JSON.stringify(response), { status: 200 }));
    expect(await run(["settings", "test-site", ...BASE], human.io)).toBe(EXIT.ok);
    expect(human.stdout()).toContain("title\\u001b[2J");
    expect(human.stdout()).toContain("first\\u000asecond");
    expect(human.stdout()).not.toContain("\u001b");
    const json = await harness(() => new Response(JSON.stringify(response), { status: 200 }));
    expect(await run(["settings", "test-site", ...BASE, "--json"], json.io)).toBe(EXIT.ok);
    expect(JSON.parse(json.stdout()).site.title).toBe(response.site.title);
    expect(JSON.parse(json.stdout()).site.description).toBe(response.site.description);
  });

  it("fails with invalid_response when the site settings are not booleans", async () => {
    const wrong = { spa: "false", renderMarkdown: 1, crossOriginIsolation: "true" };
    const h = await harness(() => new Response(JSON.stringify({
      site: { id: "site_1", slug: "test-site", title: null, description: null, currentVersionId: null, settings: wrong },
    }), { status: 200 }));
    const code = await run(["settings", "test-site", ...BASE, "--json"], h.io);
    expect(code).toBe(EXIT.error);
    expect(h.requests()).toBe(1);
    const body = JSON.parse(h.stdout());
    expect(body).toMatchObject({ ok: false, exitCode: EXIT.error, error: { code: "invalid_response" } });
    expect(h.stdout()).not.toContain('"spa"');
  });
});
