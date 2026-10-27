/**
 * Mutation guards for pull's local-safety and integrity checks. Separate from the
 * protected acceptance files, which stay unchanged. Only HTTP is substituted.
 */
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pullHarness, sha256, tree } from "./fixtures/pull-harness";

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

  it("gives verified files the normal umask-adjusted mode, not 0600", async () => {
    const previous = process.umask(0o022);
    try {
      const r = await pull("out");
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect((await stat(join(h.cwd, "out", "bytes.txt"))).mode & 0o777).toBe(0o644);
    } finally { process.umask(previous); }
  });

  it.each([".git/config", ".GIT/config", "nested/.Git/hooks/x"])("refuses %s as unsafe", async path => {
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

  it("still pulls into an existing plain-directory destination", async () => {
    await mkdir(join(h.cwd, "plain"));
    await writeFile(join(h.cwd, "plain", "keep.txt"), "x");
    const r = await pull("plain", {}, ["--force"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect((await readFile(join(h.cwd, "plain", "bytes.txt"))).equals(body)).toBe(true);
  });
});
