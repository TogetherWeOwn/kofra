/**
 * Shared harness for the `kofra claim` acceptance contract (TOG-43034 Test
 * Author handoff; Builder: TOG-43037). Both claim test files run the real CLI
 * through this module so snapshots, output parsing, the unknown-command guard
 * and credential redaction live in exactly one place.
 *
 * Every run proves: project and credential files are byte-identical
 * afterwards, no handled credential appears in stdout/stderr or request URLs,
 * and (for live runs) every request targets the disposable fixture Worker.
 * Nothing here contacts production or private fixtures.
 */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { run, type Io } from "../../src/main.ts";

export interface ClaimWire {
  method: string;
  url: URL;
  hasAuth: boolean;
  /** True when the request carried the expected credential (or any credential when none was set). */
  authenticated: boolean;
  /** Sorted top-level JSON body keys for requests with a body (never the secret values); null for GET/HEAD. */
  bodyKeys: string[] | null;
}

export interface ClaimRan {
  code: number;
  stdout: string;
  stderr: string;
  wire: ClaimWire[];
  prompts: number;
  promptHidden: boolean[];
  stdinReads: number;
}

export async function snapshot(dir: string): Promise<Record<string, string>> {
  const metadata = (info: { mode: bigint; mtimeNs: bigint; ctimeNs: bigint }) => `${info.mode}:${info.mtimeNs}:${info.ctimeNs}`;
  const directory = await stat(dir, { bigint: true });
  const result: Record<string, string> = { ".": metadata(directory) };
  for (const entry of (await readdir(dir)).sort()) {
    const path = join(dir, entry);
    const info = await stat(path, { bigint: true });
    if (info.isDirectory()) {
      for (const [nested, value] of Object.entries(await snapshot(path))) result[`${entry}/${nested}`] = value;
    } else result[entry] = `${metadata(info)}:${(await readFile(path)).toString("base64")}`;
  }
  return result;
}

/** Every credential a test handles; nothing here may appear in CLI output or request URLs. */
export class SecretSet {
  private readonly values = new Set<string>();

  add(...secrets: Array<string | null | undefined>): void {
    for (const secret of secrets) if (secret) this.values.add(secret);
  }

  assertAbsent(text: string, what: string): void {
    for (const secret of this.values) expect(text.includes(secret), `${what} leaks a handled credential`).toBe(false);
  }
}

/** Parse ALL of stdout as exactly one JSON object (rejects banners, JSONL, trailing notes). */
export function claimObject(r: ClaimRan): any {
  let parsed: any;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`stdout must be exactly one JSON object (exit ${r.code}): ${r.stdout}`);
  }
  expect(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)).toBe(true);
  return parsed;
}

/**
 * The baseline guard: `claim` does not exist yet, so every negative case
 * would trivially "pass" with exit 2 unless it proves the failure came from
 * the real command. Call this in every non-zero test before asserting codes.
 */
export function expectKnownCommand(r: ClaimRan): void {
  if (r.code === 0) return; // unknown_command always exits 2.
  try {
    const parsed = JSON.parse(r.stdout) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    expect(typeof code === "string" && code.length > 0, `JSON failure must carry a stable error code: ${r.stdout}`).toBe(true);
    expect(code).not.toBe("unknown_command");
    return;
  } catch (e) {
    if (e instanceof Error && /stable error code|unknown_command/.test(e.message)) throw e;
  }
  const m = /^Error \(([^)]+)\):/m.exec(r.stderr);
  expect(m, `stderr must carry a stable error code, got: ${r.stderr}`).toBeTruthy();
  expect(m![1]).not.toBe("unknown_command");
}

export interface ClaimFiles {
  dir: string;
  home: string;
  configDir: string;
  cleanup(): Promise<void>;
}

/**
 * A disposable project + config pair. The project mapping points at an
 * invalid origin on purpose: `claim` takes its site explicitly, so a passing
 * run proves the mapping was ignored (live runs additionally guard every
 * request origin).
 */
export async function createClaimFiles(prefix: string): Promise<ClaimFiles> {
  const dir = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), prefix));
  const home = join(dir, "project");
  const configDir = join(dir, "config");
  await mkdir(home, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(join(home, "dropway.json"), JSON.stringify({ api: "https://mapping.invalid", sites: { ".": "mapped-must-be-ignored" } }));
  await writeFile(join(home, "untouched.txt"), "keep these bytes\n");
  await writeFile(join(configDir, "credentials.json"), JSON.stringify({ version: 1, instances: {} }), { mode: 0o600 });
  return { dir, home, configDir, cleanup: async () => void (await rm(dir, { recursive: true, force: true })) };
}

export interface RunClaimOptions {
  env: NodeJS.ProcessEnv;
  stdin?: string;
  stdinIsTTY?: boolean;
  stderrIsTTY?: boolean;
  promptImpl?: (question: string, opts?: { hidden?: boolean }) => Promise<string>;
  /** Defaults to throwing: tests that expect zero requests fail loudly if one is made. */
  fetchImpl?: Io["fetch"];
  secrets?: SecretSet;
  /** When set, every request must target this origin. */
  allowedOrigin?: string;
  /** Credential the CLI is expected to send; recorded as a boolean, never stored. */
  expectedAuth?: string | null;
}

/** Run the real CLI argv parser + command with captured stdio and a recorded wire. */
export async function runClaim(files: ClaimFiles, args: string[], opts: RunClaimOptions): Promise<ClaimRan> {
  const beforeHome = await snapshot(files.home);
  const beforeConfig = await snapshot(files.configDir);
  let stdout = "";
  let stderr = "";
  let prompts = 0;
  const promptHidden: boolean[] = [];
  let stdinReads = 0;
  const wire: ClaimWire[] = [];
  const secrets = opts.secrets ?? new SecretSet();
  const inner = opts.fetchImpl
    ?? (async () => {
      throw new Error("claim test expected zero requests");
    });
  const fetch: Io["fetch"] = (async (input: Request) => {
    const url = new URL(input.url);
    if (opts.allowedOrigin !== undefined) expect(url.origin, "CLI must contact only the disposable fixture").toBe(opts.allowedOrigin);
    let bodyKeys: string[] | null = null;
    if (input.method !== "GET" && input.method !== "HEAD") {
      const text = await input.clone().text();
      bodyKeys = [];
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) bodyKeys = Object.keys(parsed).sort();
        } catch {
          bodyKeys = [];
        }
      }
    }
    const auth = input.headers.get("authorization");
    wire.push({ method: input.method, url, hasAuth: auth !== null, authenticated: opts.expectedAuth ? auth === `Bearer ${opts.expectedAuth}` : auth !== null, bodyKeys });
    secrets.assertAbsent(url.href, `${input.method} ${url.pathname}`);
    return inner(input);
  }) as Io["fetch"];
  const io: Io = {
    cwd: files.home,
    env: opts.env,
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    stdinIsTTY: opts.stdinIsTTY ?? false,
    stderrIsTTY: opts.stderrIsTTY ?? false,
    readStdin: async () => {
      stdinReads++;
      return opts.stdin ?? "";
    },
    prompt: async (question, promptOpts) => {
      prompts++;
      promptHidden.push(promptOpts?.hidden === true);
      if (opts.promptImpl) return opts.promptImpl(question, promptOpts);
      throw new Error("unexpected prompt in claim test");
    },
    fetch,
  };
  const code = await run(args, io);
  expect(await snapshot(files.home), "claim must leave project files byte-identical").toEqual(beforeHome);
  expect(await snapshot(files.configDir), "claim must leave credentials byte-identical").toEqual(beforeConfig);
  secrets.assertAbsent(stdout, "stdout");
  secrets.assertAbsent(stderr, "stderr");
  return { code, stdout, stderr, wire, prompts, promptHidden, stdinReads };
}
