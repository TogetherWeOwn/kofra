/**
 * Mutation guards for pull's local-safety and integrity checks. Separate from the
 * protected acceptance files, which stay unchanged. Only HTTP is substituted.
 */
import { lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pullHarness, sha256, tree } from "./fixtures/pull-harness";
import { fileTarget, type FileTargetFs } from "../src/pull.ts";

const api = "https://pull-guards.example";
const site = "guards";
const versionId = "ver_guards_fixture";
const base = `/api/v1/sites/${site}`;
const body = Buffer.from("guarded bytes\n");
let h: Awaited<ReturnType<typeof pullHarness>>;

beforeEach(async () => {
  h = await pullHarness();
  vi.stubGlobal("fetch", async () => { throw new Error("Unexpected network outside guard transport"); });
});
afterEach(async () => { vi.unstubAllGlobals(); await h?.dispose(); });

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });

function transport(opts: { path?: string; resolvedId?: string; content?: (b: Buffer) => string } = {}) {
  const path = opts.path ?? "bytes.txt";
  const version = { id: opts.resolvedId ?? versionId, number: 1, status: "ready", live: true, fileCount: 1, totalBytes: body.length };
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname.startsWith(`${base}/versions/`)) return json({ site, version, missing: [] });
    if (url.pathname === `${base}/files`) return json({ site, version: { id: versionId }, total: 1, nextCursor: null,
      files: [{ path, size: body.length, sha256: sha256(body) }] });
    if (url.pathname === "/api/v1/read-file") return json({ path, versionId, size: body.length, sha256: sha256(body), encoding: "base64",
      offset: 0, length: body.length, content: (opts.content ?? (b => b.toString("base64")))(body), truncated: false, nextOffset: null });
    throw new Error(`unexpected endpoint ${url.pathname}`);
  };
}
const pull = (target: string, opts: Parameters<typeof transport>[0] = {}, flags: string[] = []) =>
  h.cli(["pull", site, target, ...flags, "--json"], { api, fetch: transport(opts) });

describe("pull guards", () => {
  it("refuses a destination beneath a symlinked ancestor without writing outside", async () => {
    const outside = join(h.work, "outside");
    await mkdir(outside);
    await symlink(outside, join(h.cwd, "link"), "dir");
    const r = await pull("link/shot");
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(await tree(outside)).toEqual({});
  });

  it.each(["link/sub/shot", "link/sub/deep/out"])("refuses %s when the path below the symlink does not exist yet", async target => {
    const outside = join(h.work, "outside");
    await mkdir(outside);
    await symlink(outside, join(h.cwd, "link"), "dir");
    const r = await pull(target);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    // The missing intermediate directory must not hide `link` from the walk.
    expect(await tree(outside)).toEqual({});
    expect(await tree(join(h.cwd, "link", "sub")).catch(() => ({}))).toEqual({});
  });

  it("gives verified files the normal umask-adjusted mode, not 0600", async () => {
    const previous = process.umask(0o022);
    try {
      const r = await pull("out");
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const target = join(h.cwd, "out", "bytes.txt");
      // Node does not enforce POSIX permission bits on Windows, so the exact
      // mode assertion only holds where the mode has meaning; elsewhere the
      // pulled bytes themselves prove the download landed.
      if (process.platform === "win32") {
        expect((await readFile(target)).equals(body)).toBe(true);
      } else {
        expect((await stat(target)).mode & 0o777).toBe(0o644);
      }
    } finally { process.umask(previous); }
  });

  it.each([".git/config", ".GIT/config", "nested/.Git/hooks/x", ".gitmodules", "nested/.gitattributes", ".GITMODULES"])("refuses %s as unsafe", async path => {
    const r = await pull("out", { path });
    expect(r.code, r.stdout + r.stderr).toBeGreaterThan(0);
    expect(JSON.parse(r.stdout).failures).toEqual([expect.objectContaining({ path, code: "unsafe_pull_path" })]);
    expect(await tree(join(h.cwd, "out")).catch(() => ({}))).toEqual({});
  });

  it("refuses a server that resolves the version to a mutable reference", async () => {
    const r = await pull("out", { resolvedId: "live" });
    expect(r.code, r.stdout + r.stderr).toBeGreaterThan(0);
    expect(r.stderr + r.stdout).toContain("invalid_pull_version");
    expect(r.wire.some(w => w.url.pathname === "/api/v1/read-file")).toBe(false);
  });

  it("rejects noncanonical base64 pages instead of decoding them leniently", async () => {
    const r = await pull("out", { content: b => `${b.toString("base64")}\n` });
    expect(r.code, r.stdout + r.stderr).toBeGreaterThan(0);
    expect(JSON.parse(r.stdout).failures).toEqual([expect.objectContaining({ path: "bytes.txt", code: "invalid_pull_response" })]);
    expect(await tree(join(h.cwd, "out"))).toEqual({});
  });

  it("refuses to overwrite a file reached by a different manifest path", async () => {
    // On a case-insensitive disk "README.md" and an existing "readme.md" resolve
    // to one inode. That cannot be reproduced on a case-sensitive test disk, so
    // the guard is pinned directly: an existing file whose exact manifest path
    // was not present before this pull must not be replaced.
    const dir = join(h.cwd, "alias");
    await mkdir(dir);
    await writeFile(join(dir, "extra.bin"), "keep");
    await expect(fileTarget(dir, ["extra.bin"], new Set<string>())).rejects.toMatchObject({ code: "pull_path_collision" });
    // A path that was present before the pull is still replaceable.
    await expect(fileTarget(dir, ["extra.bin"], new Set(["extra.bin"]))).resolves.toBe(join(dir, "extra.bin"));
  });

  it("refuses a parent directory that differs only in case on an insensitive disk", async () => {
    // A case-sensitive test disk cannot reproduce this: `a` beside `A` is just
    // a missing directory there. Simulate the insensitive disk instead, where
    // `statPath` resolves `a` to the existing `A` while `listDir` reports the
    // exact on-disk spelling.
    const dir = join(h.cwd, "caseparent");
    await mkdir(join(dir, "A"), { recursive: true });
    const insensitive: FileTargetFs = {
      statPath: async (path: string) => {
        try {
          return await lstat(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          const entries = await readdir(dirname(path));
          const hit = entries.find(entry => entry.toLowerCase() === basename(path).toLowerCase());
          if (!hit) return null;
          return lstat(join(dirname(path), hit));
        }
      },
      listDir: (path: string) => readdir(path),
      makeDir: (path: string) => mkdir(path, { recursive: true }),
    };
    await expect(fileTarget(dir, ["a", "two.txt"], new Set(["a/two.txt"]), insensitive))
      .rejects.toMatchObject({ code: "pull_path_collision" });
    // The exact-spelled manifest name still resolves through the same disk.
    await expect(fileTarget(dir, ["A", "two.txt"], new Set(["A/two.txt"]), insensitive))
      .resolves.toBe(join(dir, "A", "two.txt"));
  });

  it("still pulls into an existing plain-directory destination", async () => {
    await mkdir(join(h.cwd, "plain"));
    await writeFile(join(h.cwd, "plain", "keep.txt"), "x");
    const r = await pull("plain", {}, ["--force"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect((await readFile(join(h.cwd, "plain", "bytes.txt"))).equals(body)).toBe(true);
  });
});
