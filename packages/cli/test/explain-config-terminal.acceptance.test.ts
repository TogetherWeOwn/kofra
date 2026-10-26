/**
 * Human mapping operands must not inject terminal commands or diagnostic lines.
 * Exercise the real offline reader and formatter with synthetic local files;
 * escaping human text must never rewrite the logical JSON mapping.
 * Run: npm run test:cli -- test/explain-config-terminal.acceptance.test.ts
 */
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { explainConfig, explainConfigHuman } from "../src/explain-config.ts";

const probe = vi.hoisted(() => ({ active: false, reads: [] as string[], forbidden: [] as string[] }));

// Keep file reading/parsing real. Tripwires also catch writes that production
// catches internally, including mutate-then-restore attempts.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const writes = new Set(["appendFile", "chmod", "chown", "copyFile", "cp", "link", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile"]);
  const guarded: Record<string, unknown> = { ...actual };
  for (const [name, fn] of Object.entries(actual)) {
    if (typeof fn !== "function" || !(writes.has(name) || ["open", "readFile", "readdir"].includes(name))) continue;
    guarded[name] = (...args: unknown[]) => {
      if (probe.active) {
        if (writes.has(name) || name === "open") {
          probe.forbidden.push(name);
          throw new Error("offline diagnostics attempted a filesystem mutation");
        }
        probe.reads.push(String(args[0]));
      }
      return (fn as (...values: unknown[]) => unknown)(...args);
    };
  }
  return guarded;
});

const API = "https://diagnostics.example";
const MARKER = "[…truncated]";
const HIDDEN_KEY = "unrequested-mapping-canary";
const HIDDEN_SLUG = "unrequested-slug-canary";
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
const cases = Array.from({ length: 160 }, (_, code) => code)
  .filter((code) => code < 32 || code >= 127)
  .map((code) => ({ label: `U+${code.toString(16).toUpperCase().padStart(4, "0")}`, control: String.fromCharCode(code) }));
let work: string;
let cwd: string;
let config: string;
let network: number;

beforeEach(async () => {
  work = await fs.mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kofra-terminal-"));
  cwd = join(work, "project");
  config = join(work, "config");
  await fs.mkdir(cwd);
  await fs.mkdir(config);
  await fs.writeFile(join(config, "credentials.json"), JSON.stringify({ instances: {} }));
  probe.reads = [];
  probe.forbidden = [];
  network = 0;
  vi.stubGlobal("fetch", async () => { network++; throw new Error("offline network tripwire"); });
  vi.stubGlobal("XMLHttpRequest", class { constructor() { network++; throw new Error("offline XHR tripwire"); } });
});

afterEach(async () => {
  probe.active = false;
  vi.unstubAllGlobals();
  await fs.rm(work, { recursive: true, force: true });
});

// Include bytes and modification/change times, but not access time: a read is
// allowed to change atime. These calls run outside the diagnostic tripwires.
async function snapshot(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of [work, cwd, config, join(cwd, "dropway.json"), join(config, "credentials.json")]) {
    const stat = await fs.lstat(path, { bigint: true });
    result[path] = `${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (stat.isFile()) result[path] += `:${createHash("sha256").update(await fs.readFile(path)).digest("hex")}`;
  }
  return result;
}

async function diagnose(key: string, slug: string | null, expected = { key, slug }) {
  await fs.writeFile(join(cwd, "dropway.json"), JSON.stringify({
    api: API,
    sites: { ...(slug === null ? {} : { [key]: slug }), [HIDDEN_KEY]: HIDDEN_SLUG },
  }));
  const before = await snapshot();
  probe.active = true;
  let report: Awaited<ReturnType<typeof explainConfig>>;
  let human: string;
  try {
    report = await explainConfig({ api: API, path: key, env: { KOFRA_CONFIG_DIR: config }, cwd });
    expect(report).toMatchObject({ schema: "kofra.explain-config/v1", status: "needs_key", exitCode: 3 });
    expect(report.projectLink).toMatchObject({ state: "valid", apiMatchesEffective: true, sitesEntryCount: slug === null ? 1 : 2 });
    expect(JSON.parse(JSON.stringify(report)).projectLink.mapping, "JSON retains the original logical strings, subject only to its existing cap").toEqual(expected);
    const jsonBefore = JSON.stringify(report);
    human = explainConfigHuman(report);
    expect(JSON.stringify(report), "human rendering must not mutate the JSON report").toBe(jsonBefore);
  } finally {
    probe.active = false;
  }
  expect(network, "diagnostics and rendering never attempt network access").toBe(0);
  expect(probe.forbidden).toEqual([]);
  expect(probe.reads.sort(), "one read of each config file; never read the requested target or enumerate its files").toEqual([
    join(config, "credentials.json"), join(cwd, "dropway.json"),
  ].sort());
  expect(await snapshot(), "configuration bytes and metadata remain unchanged").toEqual(before);
  expect(human).not.toContain(HIDDEN_KEY);
  expect(human).not.toContain(HIDDEN_SLUG);
  expect(JSON.stringify(report)).not.toContain(HIDDEN_KEY);
  expect(JSON.stringify(report)).not.toContain(HIDDEN_SLUG);
  expect(report.checks.filter((check) => check.id === (slug ? "project_link.mapping_found" : "project_link.mapping_missing"))).toHaveLength(1);
  return { report, human };
}

function mappingOperands(human: string): [string, string] {
  const lines = human.split("\n");
  const mappings = lines.filter((line) => line.startsWith("Mapping: "));
  expect(mappings, "exactly one Mapping row, never an inventory").toHaveLength(1);
  const row = mappings[0]!;
  expect(row, "no raw C0, DEL or C1 terminal controls in the Mapping row").not.toMatch(CONTROLS);
  expect(human, "non-newline terminal controls cannot escape into another output row").not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  const operands = /^Mapping: (.*) -> (.*)$/.exec(row);
  expect(operands, "both mapping operands occupy the same human line").not.toBeNull();
  return [operands![1]!, operands![2]!];
}

describe("terminal-safe offline mapping diagnostics", () => {
  it.each(cases)("renders $label safely in both operands without changing JSON", async ({ control }) => {
    const { human } = await diagnose(`local${control}key-end`, `site${control}slug-end`);
    const [key, slug] = mappingOperands(human);
    // Endpoint canaries catch newline/CR line forging even if splitting on LF
    // would otherwise hide the dangerous suffix from the control-byte check.
    expect(key).toMatch(/^local.*key-end$/);
    expect(slug).toMatch(/^site.*slug-end$/);
  });

  it("keeps a combined forged-line, CSI and OSC payload on one Mapping line", async () => {
    const attack = "\nforged-status: ready\r\u001b[2J\u001b]8;;mailto:fixture@example.test\u0007\u009b31m";
    const { human } = await diagnose(`local${attack}key-end`, `site${attack}slug-end`);
    const [key, slug] = mappingOperands(human);
    expect(key).toMatch(/^local.*key-end$/);
    expect(slug).toMatch(/^site.*slug-end$/);
    expect(human.split("\n").some((line) => line.startsWith("forged-status:"))).toBe(false);
  });

  it("preserves ordinary Unicode instead of stripping or ASCII-encoding it", async () => {
    const { human } = await diagnose("local-café-東京-🛰️", "site-naïve-雪-🌱");
    expect(mappingOperands(human)).toEqual(["local-café-東京-🛰️", "site-naïve-雪-🌱"]);
  });

  it.each([null, ""])("keeps the existing missing-slug fallback for %j", async (slug) => {
    const key = "local\nforged-status\r\u001b[2J\u009b31m-key-end";
    const { human } = await diagnose(key, slug, { key, slug: null });
    const [displayedKey, displayedSlug] = mappingOperands(human);
    expect(displayedKey).toMatch(/^local.*-key-end$/);
    expect(displayedSlug).toBe("missing");
  });

  it("caps each displayed operand after control escaping expands it", async () => {
    const key = `local${"\u001b".repeat(1600)}`;
    const slug = `site${"\u009b".repeat(1600)}`;
    const { human } = await diagnose(key, slug, {
      key: `local${"\u001b".repeat(1024 - 5 - MARKER.length)}${MARKER}`,
      slug: `site${"\u009b".repeat(1024 - 4 - MARKER.length)}${MARKER}`,
    });
    for (const operand of mappingOperands(human)) {
      expect(operand.length, "escaped display text still fits the 1024-character operand budget").toBeLessThanOrEqual(1024);
      expect(operand.endsWith(MARKER), "truncation remains visible").toBe(true);
    }
  });
});
