/**
 * Offline acceptance for `kofra claim <site> --token <claimToken>` (TOG-43034
 * Test Author handoff; Builder: TOG-43037).
 *
 * Contract under test (from the TOG-42994 roadmap CLI-CLAIM item):
 * - `claim <site> --token <claimToken> [--json] [--dry-run]` keeps an
 *   anonymous site from the terminal. The site is explicit, never inferred
 *   from ./dropway.json. Missing/extra args, a missing --token and unknown
 *   flags fail locally (exit 2, zero requests, never a prompt in non-TTY).
 * - `--dry-run` prints the resolved site reference and the operation that
 *   would run, then performs no mutation: zero requests, no credential
 *   requirement, --token optional. JSON plan: one object with
 *   { ok, dryRun, site, operation: "claim_site" } (access/duplicate dry-run
 *   precedent: dryRun flag + operation id).
 * - The claim token never appears in stdout, stderr, JSON or errors, on
 *   success or failure (sentinel checks on every run).
 * - Live behaviour (golden --json, unknown/bad/expired tokens, double claim,
 *   the exit-code table, the built binary) is pinned in
 *   claim-live.acceptance.test.ts against a disposable workerd Worker.
 *
 * These tests fail on main (no `claim` command) with `unknown_command`.
 * Every negative case calls expectKnownCommand first so a missing command
 * cannot accidentally pass.
 *
 * Run: npm run test:cli -- test/claim-offline.acceptance.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimObject, createClaimFiles, expectKnownCommand, runClaim, SecretSet, type ClaimFiles, type ClaimRan } from "./fixtures/claim-harness.ts";

const STUB_API = "https://claim-stub.invalid";
const STUB_KEY = "dw_synthetic_not_a_credential";
const TOKEN = "dwc_claim_offline_sentinel_never_print_001";

let files: ClaimFiles;
let secrets: SecretSet;

beforeEach(async () => {
  files = await createClaimFiles("kofra-claim-offline-");
  secrets = new SecretSet();
  secrets.add(STUB_KEY, TOKEN);
});

afterEach(async () => {
  await files.cleanup();
});

function cli(args: string[], opts: { env?: NodeJS.ProcessEnv; stdin?: string } = {}): Promise<ClaimRan> {
  return runClaim(files, args, {
    env: opts.env ?? { KOFRA_API: STUB_API, KOFRA_API_KEY: STUB_KEY, KOFRA_CONFIG_DIR: files.configDir, HOME: files.home },
    stdin: opts.stdin,
    secrets,
  });
}

describe("claim help is offline", () => {
  it.each([[["claim", "--help"]], [["help", "claim"]]])("shows %j without network", async (args) => {
    const r = await cli(args, { env: { KOFRA_CONFIG_DIR: files.configDir, HOME: files.home } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toEqual([]);
    expect(r.prompts).toBe(0);
    for (const token of ["claim", "<site>", "--token", "--dry-run", "--json"]) expect(r.stdout).toContain(token);
  });

  it("lists claim in the top-level help", async () => {
    const r = await cli(["help"], { env: { KOFRA_CONFIG_DIR: files.configDir, HOME: files.home } });
    expect(r.code).toBe(0);
    // A command-table row (`  claim <summary>`), not the existing --key line
    // that already mentions claim tokens.
    expect(r.stdout).toMatch(/^  claim\s/m);
  });
});

describe("claim argv validation is local", () => {
  it("(5) missing --token is refused in non-TTY with exit 2 and a hint", async () => {
    const r = await cli(["claim", "some-site", "--json"]);
    expect(r.code).toBe(2);
    expectKnownCommand(r);
    expect(r.wire).toEqual([]);
    expect(r.prompts, "non-TTY claim must never prompt for the token").toBe(0);
    const err = claimObject(r).error;
    expect(typeof err.code === "string" && err.code.length > 0).toBe(true);
    expect(String(err.hint ?? "")).toMatch(/--token/);
  });

  it.each([" ", ".", ".."])("rejects invalid site %j locally, including dry-run", async (site) => {
    for (const extra of [["--token", TOKEN], ["--dry-run"]]) {
      const r = await cli(["claim", site, ...extra, "--json"]);
      expect(r.code).toBe(2);
      expectKnownCommand(r);
      expect(r.wire).toEqual([]);
      expect(claimObject(r)).toMatchObject({ ok: false, exitCode: 2, error: { message: "Use an explicit site slug." } });
    }
  });

  it("rejects malformed tokens locally", async () => {
    const r = await cli(["claim", "some-site", "--token", "invalid", "--json"]);
    expect(r.code).toBe(2);
    expect(r.wire).toEqual([]);
    expect(claimObject(r)).toMatchObject({ ok: false, exitCode: 2, error: { code: "claim_token_invalid" } });
  });

  it("missing --token says --token in human output too", async () => {
    const r = await cli(["claim", "some-site"]);
    expect(r.code).toBe(2);
    expectKnownCommand(r);
    expect(r.wire).toEqual([]);
    expect(r.prompts).toBe(0);
    expect(r.stderr).toMatch(/--token/);
  });

  it("missing site is refused before any request without echoing --token", async () => {
    const r = await cli(["claim", "--token", TOKEN, "--json"]);
    expect(r.code).toBe(2);
    expectKnownCommand(r);
    expect(r.wire).toEqual([]);
    expect(r.prompts).toBe(0);
  });

  it("surplus positionals are refused before any request", async () => {
    const r = await cli(["claim", "site-a", "site-b", "--token", TOKEN, "--json"]);
    expect(r.code).toBe(2);
    expectKnownCommand(r);
    expect(r.wire).toEqual([]);
  });

  it("unknown flags are refused before any request", async () => {
    const r = await cli(["claim", "some-site", "--token", TOKEN, "--bogus", "--json"]);
    expect(r.code).toBe(2);
    expectKnownCommand(r);
    expect(r.wire).toEqual([]);
  });
});

describe("claim --dry-run is an offline plan", () => {
  it("(6) dry-run prints the resolved site and operation with zero requests and no credentials", async () => {
    const r = await cli(["claim", "some-site", "--dry-run", "--json"], { env: { KOFRA_CONFIG_DIR: files.configDir, HOME: files.home } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toEqual([]);
    expect(r.prompts).toBe(0);
    expect(claimObject(r)).toMatchObject({ ok: true, dryRun: true, site: "some-site", operation: "claim_site" });
  });

  it("dry-run human output names the site without contacting anything", async () => {
    const r = await cli(["claim", "some-site", "--dry-run"], { env: { KOFRA_CONFIG_DIR: files.configDir, HOME: files.home } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toEqual([]);
    expect(r.stdout).toContain("some-site");
    expect(r.stdout).toMatch(/dry.?run/i);
    expect(r.stdout).toMatch(/claim/i);
  });

  it("dry-run tolerates --token but never prints it", async () => {
    const r = await cli(["claim", "some-site", "--token", TOKEN, "--dry-run", "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.wire).toEqual([]);
  });

  it("(8) usage errors never echo the --token value", async () => {
    const r = await cli(["claim", "--token", TOKEN, "--bogus", "--json"]);
    expect(r.code).toBe(2);
    expectKnownCommand(r);
    expect(r.wire).toEqual([]);
  });
});
