import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, type Io } from "../src/main.ts";
import { EXIT } from "../src/client.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function invoke(args: string[], site: Record<string, unknown> = {}, link?: Record<string, unknown>) {
  const cwd = await mkdtemp(join(tmpdir(), "settings-review-"));
  dirs.push(cwd);
  if (link) await writeFile(join(cwd, "dropway.json"), JSON.stringify(link));
  let stdout = "", stderr = "";
  const requests: Request[] = [];
  const io: Io = {
    cwd, env: { KOFRA_CONFIG_DIR: join(cwd, "config") }, stdinIsTTY: false, stderrIsTTY: false,
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
    readStdin: async () => { throw new Error("must not read stdin"); },
    prompt: async () => { throw new Error("must not prompt"); },
    fetch: async (request) => {
      requests.push(request);
      return new Response(JSON.stringify({ site: {
        slug: "settings-fixture", title: null, description: null, currentVersionId: null,
        settings: { spa: false, renderMarkdown: true, crossOriginIsolation: false }, ...site,
      } }), { status: 200 });
    },
  };
  const code = await run(["settings", ...args], io);
  return { code, stdout, stderr, requests };
}

const AUTH = ["--api", "https://api.test", "--key", "dw_test"];

describe("settings review regressions", () => {
  it.each(["--json=true", "--json=1"])("uses a JSON error envelope for %s", async (flag) => {
    const r = await invoke(["settings-fixture", "--spa", "invalid", flag]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { code: "usage" } });
    expect(r.requests).toHaveLength(0);
  });

  it.each(["my site", "Uppercase", "-leading", "trailing-", "double--hyphen", "slash/name", "a", "ab", "a".repeat(64)])(
    "rejects malformed slug %s before dry-run or network", async (slug) => {
      for (const mode of [["--dry-run"], AUTH]) {
        const r = await invoke([...mode, "--spa", "false", "--json", "--", slug]);
        expect(r.code).toBe(EXIT.usage);
        expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { code: "usage" } });
        expect(r.requests).toHaveLength(0);
      }
    },
  );

  it("keeps existing 63-character slugs usable", async () => {
    const slug = "a".repeat(63);
    const r = await invoke([slug, "--spa", "false", "--dry-run", "--json"]);
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout)).toMatchObject({ site: slug, patch: { spa: false } });
    expect(r.requests).toHaveLength(0);
  });

  it.each([{ patch: [] }, { patch: ["--spa", "true"] }])("accepts legacy responses without an id for read/write $patch", async ({ patch }) => {
    const r = await invoke(["settings-fixture", ...AUTH, ...patch, "--json"]);
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, site: { id: null, slug: "settings-fixture" } });
    expect(r.requests.map((request) => request.method)).toEqual([patch.length ? "PATCH" : "GET"]);
  });

  it("omits a missing legacy id in human output", async () => {
    const r = await invoke(["settings-fixture", ...AUTH]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stdout).toContain("Settings for settings-fixture\n");
    expect(r.stdout).not.toMatch(/null|undefined|\(\)/);
    expect(r.requests).toHaveLength(1);
  });

  it.each([
    ["title", { nested: "no" }], ["title", 42],
    ["description", ["no"]], ["description", 42],
    ["currentVersionId", { id: "ver" }], ["currentVersionId", 7],
  ])("rejects a wrong-typed %s in a successful site response", async (field, value) => {
    for (const mode of [[], ["--spa", "false"]]) {
      const r = await invoke(["settings-fixture", ...AUTH, ...mode, "--json"], { [field]: value });
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.error);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { code: "invalid_response" } });
    }
  });

  it("escapes DEL and C1 controls in the human dry-run plan while preserving JSON values", async () => {
    const title = "a\u007f\u009bb";
    const human = await invoke(["settings-fixture", "--title", title, "--dry-run"]);
    expect(human.code).toBe(EXIT.ok);
    expect(human.stdout).not.toContain("\u007f");
    expect(human.stdout).not.toContain("\u009b");
    expect(human.stdout).toContain("\\u007f");
    expect(human.stdout).toContain("\\u009b");
    const json = await invoke(["settings-fixture", "--title", title, "--dry-run", "--json"]);
    expect(JSON.parse(json.stdout).patch.title).toBe(title);
    expect(json.requests).toHaveLength(0);
  });

  it("still honours --json when a missing flag value precedes it", async () => {
    const r = await invoke(["settings-fixture", "--spa", "--json"]);
    expect(r.code).toBe(EXIT.usage);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { code: "usage" } });
    expect(r.requests).toHaveLength(0);
  });

  it("does not select JSON for an error from a --json token after --", async () => {
    const r = await invoke(["settings-fixture", "--spa", "false", "--", "--json=true"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Error (usage):");
    expect(r.requests).toHaveLength(0);
  });

  it("uses the last value when --json is overridden on a rejected command line", async () => {
    const r = await invoke(["settings-fixture", "--json=true", "--json=false", "--spa", "false"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("only once");
    expect(r.requests).toHaveLength(0);
  });

  it("keeps --dry-run offline even when local instance files would poison resolution", async () => {
    // A resolver run before the offline plan would read ./dropway.json and
    // throw on this instance URL, or require a key that no source provides.
    for (const link of [{ api: "ftp://invalid" }, { api: "https://api.test" }]) {
      const r = await invoke(["settings-fixture", "--spa", "false", "--dry-run", "--json"], {}, link);
      expect(r.code, r.stdout + r.stderr).toBe(EXIT.ok);
      expect(JSON.parse(r.stdout)).toMatchObject({ dryRun: true, patch: { spa: false } });
      expect(r.requests).toHaveLength(0);
    }
  });
});
