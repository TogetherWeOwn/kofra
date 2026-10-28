import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, type Io } from "../src/main.ts";
import { EXIT } from "../src/client.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function invoke(args: string[], site: Record<string, unknown> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "settings-review-"));
  dirs.push(cwd);
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
});
