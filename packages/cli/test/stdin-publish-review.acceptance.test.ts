/**
 * Protected test-author acceptance additions for stdin publish review findings.
 * The Builder integrates these tests unchanged into the existing feature PR.
 * Real executable + pipe; synthetic transport never contacts a nonlocal host.
 * Build first: npm run build -w packages/cli
 * Run: npm run test:cli -- test/stdin-publish-review.acceptance.test.ts
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultApi, defaultKey, digest, envKey, explicitApi, explicitKey, linkedApi, linkedKey,
  stdinNodeHarness, stdinObject, type StdinNodeHarness,
} from "./helpers/stdin-publish-node.ts";

let h: StdinNodeHarness;
beforeEach(async () => { h = await stdinNodeHarness(); });
afterEach(async () => { await h?.dispose(); });

const input = Buffer.from("piped report\n");
const publish = ["publish", "--stdin", "report.txt", "--site", "stdin-selected-fixture", "--json"];

describe("stdin destination security", () => {
  // Break caught: consulting the checkout link selects a foreign origin before
  // attaching an explicit key or environment key. The transport is synthetic.
  it.each([
    { name: "--key", flags: ["--key", explicitKey], env: {}, key: explicitKey },
    { name: "KOFRA_API_KEY", flags: [], env: { KOFRA_API_KEY: envKey }, key: envKey },
  ])("uses the saved default, never the checkout link, with $name", async ({ flags, env, key }) => {
    await h.credentials();
    await h.link();
    const r = await h.run([...publish, ...flags], input, { env });
    const json = stdinObject(r);
    expect(r.wire.length, "success must exercise instance resolution and authentication").toBeGreaterThan(0);
    expect(r.wire.map(request => request.authorization)).toEqual([`Bearer ${key}`, `Bearer ${key}`]);
    expect(r.wire.map(request => new URL(request.url).origin), r.stdout + r.stderr).toEqual([defaultApi, defaultApi]);
    expect(r.reads.filter(read => read.path === r.linkPath), "stdin never reads or probes dropway.json").toEqual([]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json).toMatchObject({ ok: true, api: defaultApi, slug: "stdin-selected-fixture", files: 1 });
    expect(r.stdinReads).toBe(1);
  });

  it("uses the saved default's own key, not credentials belonging to the linked origin", async () => {
    await h.credentials();
    await h.link();
    const r = await h.run(publish, input);
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire.map(request => ({ origin: new URL(request.url).origin, key: request.authorization }))).toEqual([
      { origin: defaultApi, key: `Bearer ${defaultKey}` }, { origin: defaultApi, key: `Bearer ${defaultKey}` },
    ]);
    expect(json.api).toBe(defaultApi);
    expect(r.reads.filter(read => read.path === r.linkPath)).toEqual([]);
  });

  it.each([
    { name: "--api over environment, link and default", flags: ["--api", explicitApi], env: { KOFRA_API: "https://environment.invalid" }, api: explicitApi },
    { name: "KOFRA_API over link and default", flags: [], env: { KOFRA_API: explicitApi }, api: explicitApi },
    { name: "KOFRA_URL over link and default", flags: [], env: { KOFRA_URL: explicitApi }, api: explicitApi },
  ])("honors $name without consulting the checkout link", async ({ flags, env, api }) => {
    await h.credentials();
    await h.link();
    const r = await h.run([...publish, ...flags, "--key", explicitKey], input, { env });
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json.api).toBe(api);
    expect(r.wire.map(request => new URL(request.url).origin)).toEqual([api, api]);
    expect(r.wire.map(request => request.authorization)).toEqual([`Bearer ${explicitKey}`, `Bearer ${explicitKey}`]);
    expect(r.reads.filter(read => read.path === r.linkPath), "an override is not permission to read project links").toEqual([]);
  });

  it.each([
    { name: "--key", flags: ["--key", explicitKey], env: {} },
    { name: "KOFRA_API_KEY", flags: [], env: { KOFRA_API_KEY: envKey } },
  ])("returns no_instance when only a checkout link exists ($name)", async ({ flags, env }) => {
    await h.link();
    const r = await h.run([...publish, ...flags], input, { env });
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(json).toMatchObject({ ok: false, exitCode: 2, error: { code: "no_instance" } });
    expect(r.wire, "a link-only checkout is not an instance choice for piped data").toEqual([]);
    expect(r.reads.filter(read => read.path === r.linkPath)).toEqual([]);
  });

  it("creates a new site without reusing or rewriting a filename/project mapping", async () => {
    await h.credentials();
    await h.link();
    const r = await h.run(["publish", "--stdin", "report.txt", "--api", explicitApi, "--key", explicitKey, "--json"], input);
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json).toMatchObject({ ok: true, created: true, api: explicitApi, slug: "stdin-created-fixture", files: 1 });
    expect(r.wire.map(request => ({ method: request.method, path: new URL(request.url).pathname }))).toEqual([
      { method: "POST", path: "/api/v1/sites" },
      { method: "POST", path: "/api/v1/sites/stdin-created-fixture/deploys" },
      { method: "GET", path: "/api/v1/sites/stdin-created-fixture" },
    ]);
    expect(r.reads.filter(read => read.path === r.linkPath)).toEqual([]);
    expect(r.stdinReads).toBe(1);
  });
});

const offlineEnv = { KOFRA_API: defaultApi, KOFRA_API_KEY: explicitKey };

// Positive control: skipping project links is stdin-specific, not a change to
// the established destination/mapping behavior of publish <path>.
describe("stdin review: path-publish control", () => {
  it("still selects the checkout origin, per-origin key and filename mapping for a path", async () => {
    await h.credentials();
    await h.link();
    await writeFile(join(h.cwd, "report.txt"), input);
    const r = await h.run(["publish", "report.txt", "--json", "--no-save"], Buffer.alloc(0));
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json).toMatchObject({ ok: true, api: linkedApi, slug: "linked-file-site", files: 1 });
    expect(r.wire.map(request => ({ origin: new URL(request.url).origin, key: request.authorization }))).toEqual([
      { origin: linkedApi, key: `Bearer ${linkedKey}` }, { origin: linkedApi, key: `Bearer ${linkedKey}` },
    ]);
    expect(r.reads.some(read => read.path === r.linkPath && read.operation === "readFile")).toBe(true);
    expect(r.stdinReads).toBe(0);
  });
});

/** Five legal segments; the four separators contribute four characters. */
const longPath = (length: number) => ["a".repeat(250), "b".repeat(250), "c".repeat(250), "d".repeat(250), "e".repeat(length - 1004)].join("/");

describe("stdin review: filename branches before consuming the pipe", () => {
  // Breaks caught: reserved exact-prefix omission, ignoring only the leaf,
  // an off-by-one maximum, or moving filename validation after stdin/fetch.
  it.each([
    { label: "bare reserved prefix", name: "__dropway", code: "reserved_path", exit: 6 },
    { label: "ignored ancestor", name: "node_modules/x.js", code: "ignored_file", exit: 2 },
    { label: "1025-character normalized path", name: longPath(1025), code: "invalid_path", exit: 6 },
  ])("refuses $label with $code before reads or transport", async ({ name, code, exit }) => {
    const r = await h.run(["publish", "--stdin", name, "--json"], input, { env: offlineEnv });
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(exit);
    expect(json).toMatchObject({ ok: false, exitCode: exit, error: { code } });
    expect(r.stdinReads, "invalid filenames are rejected before touching the pipe").toBe(0);
    expect(r.wire).toEqual([]);
  });

  it.each([1023, 1024])("accepts a normalized %i-character path made of valid segments", async length => {
    const name = longPath(length);
    expect(name.length).toBe(length);
    const r = await h.run(["publish", "--stdin", name, "--dry-run", "--json"], input, { env: offlineEnv });
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json).toMatchObject({ ok: true, dryRun: true, totalBytes: 13 });
    expect(json.files).toEqual([expect.objectContaining({ path: name, size: 13, sha256: digest(input) })]);
    expect(r.stdinReads).toBe(1);
    expect(r.wire).toEqual([]);
  });
});

describe("stdin review: ZIP source precedence", () => {
  // Break caught: unconditionally stat'ing the --stdin filename discovers a
  // same-name local ZIP and selects the path/unpack branch instead of the pipe.
  it("keeps one raw piped archive.zip even when a different valid archive.zip exists locally", async () => {
    const local = zipSync({ "local-only.txt": Buffer.from("local archive bytes") });
    const piped = zipSync({ "piped-only.txt": Buffer.from("different pipe bytes") });
    await writeFile(join(h.cwd, "archive.zip"), local);
    expect(digest(local)).not.toBe(digest(piped));
    const r = await h.run(["publish", "--stdin", "archive.zip", "--dry-run", "--json"], piped, { env: offlineEnv });
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json.files).toEqual([expect.objectContaining({ path: "archive.zip", size: piped.length, sha256: digest(piped) })]);
    expect(json.totalBytes).toBe(piped.length);
    expect(json.zip, "piped .zip is a raw file, never an extraction request").not.toBe(true);
    expect(r.stdinReads).toBe(1);
    expect(r.wire).toEqual([]);
    expect(r.reads.filter(read => read.path === join(h.cwd, "archive.zip")), "stdin never stats or reads the local namesake").toEqual([]);
  });

  it("the path-publish ZIP control still stats the local archive and reports its own bytes", async () => {
    const local = zipSync({ "local-only.txt": Buffer.from("local ZIP control") });
    await writeFile(join(h.cwd, "archive.zip"), local);
    const r = await h.run(["publish", "archive.zip", "--dry-run", "--json"], input, { env: offlineEnv });
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json).toMatchObject({ ok: true, dryRun: true, zip: true, bytes: local.length });
    expect(r.stdinReads).toBe(0);
    expect(r.wire).toEqual([]);
    expect(r.reads.some(read => read.path === join(h.cwd, "archive.zip") && read.operation === "stat")).toBe(true);
  });
});

describe("stdin review: intentional empty input", () => {
  const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  // Break caught: dropping !allowEmpty from the empty-input refusal (which
  // incorrectly rejects opted-in empty files), or dropping the refusal entirely.
  it("--allow-empty produces a zero-byte raw dry-run inventory with the empty SHA-256", async () => {
    const r = await h.run(["publish", "--stdin", "empty.bin", "--allow-empty", "--dry-run", "--json"], Buffer.alloc(0), { env: offlineEnv });
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json).toMatchObject({ ok: true, dryRun: true, totalBytes: 0 });
    expect(json.files).toEqual([expect.objectContaining({ path: "empty.bin", size: 0, sha256: emptySha256 })]);
    expect(json.zip).not.toBe(true);
    expect(r.stdinReads).toBe(1);
    expect(r.wire).toEqual([]);
  });

  it("--allow-empty sends the exact zero-byte manifest on publish with one read", async () => {
    const r = await h.run(["publish", "--stdin", "empty.bin", "--allow-empty", "--site", "stdin-selected-fixture", "--json"], Buffer.alloc(0), { env: offlineEnv });
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(json).toMatchObject({ ok: true, files: 1 });
    expect(r.wire[0]).toMatchObject({ method: "POST", body: { files: [
      { path: "empty.bin", size: 0, sha256: emptySha256 },
    ] } });
    expect(r.stdinReads).toBe(1);
  });

  it("without --allow-empty the production CLI still refuses empty input before fetch", async () => {
    const r = await h.run(["publish", "--stdin", "empty.bin", "--json"], Buffer.alloc(0), { env: offlineEnv });
    const json = stdinObject(r);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(json).toMatchObject({ ok: false, exitCode: 2, error: { code: "empty_stdin" } });
    expect(r.stdinReads).toBe(1);
    expect(r.wire).toEqual([]);
  });
});
