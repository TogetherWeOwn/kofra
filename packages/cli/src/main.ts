/**
 * The `kofra` command line. Every command:
 * - prints human text by default, or exactly one JSON object on stdout with --json;
 * - writes progress and prompts to stderr only;
 * - exits with a stable code (see EXIT in client.ts), so agents can branch on it.
 */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { bool, int, parseArgs, str, UsageError, type FlagSpecs, type Parsed } from "./args.ts";
import { CliError, DropwayClient, EXIT, normaliseApi, type FetchLike } from "./client.ts";
import { linkKey, linkPath, readCredentials, readLink, removeCredentials, saveCredentials, writeLink, type ProjectLink } from "./config.ts";
import { collectFiles } from "./files.ts";
import { encryptFiles } from "./encrypt.ts";
import { withLegacyEnv } from "./legacy-brand.ts";
import { formatBytes, plural, shellQuote, shortTime, table } from "./output.ts";
import { publish, publishZip, waitForVersion, type ProgressEvent, type PublishResult, type VersionInfo } from "./publish.ts";
import { VERSION } from "./version.ts";

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  readStdin(): Promise<string>;
  prompt(question: string, opts?: { hidden?: boolean }): Promise<string>;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: FetchLike;
}

// ---------------------------------------------------------------- flags and help

const GLOBAL: FlagSpecs = {
  api: { kind: "string" },
  key: { kind: "string" },
  json: { kind: "boolean" },
  quiet: { kind: "boolean", short: "q" },
  help: { kind: "boolean", short: "h" },
};

interface Command {
  summary: string;
  usage: string;
  flags: FlagSpecs;
  /** Exact maximum number of positional arguments; surplus is refused in run() before the command (and any side effect) starts. */
  maxPositionals: number;
  details?: string;
  run(p: Parsed, io: Io, out: Output): Promise<number>;
}

const HELP_FOOTER = `Global options:
  --api <url>      Instance URL (default: $KOFRA_API, then ./dropway.json, then your last login)
  --key <key>      API key or claim token (default: $KOFRA_API_KEY, then the saved key for the instance)
  --json           Print exactly one JSON object on stdout (for scripts and agents)
  -q, --quiet      No progress output
  -h, --help       Help for a command

Exit codes: 0 ok, 1 unexpected error, 2 usage/refused, 3 auth, 4 not found, 5 conflict,
            6 invalid or over a limit, 7 retryable (rate limit, server, network), 8 --wait timed out`;

// ---------------------------------------------------------------- output

class Output {
  private readonly io: Io;
  readonly json: boolean;
  private readonly quiet: boolean;

  constructor(io: Io, json: boolean, quiet: boolean) {
    this.io = io;
    this.json = json;
    this.quiet = quiet;
  }

  /** The command's result: JSON on stdout with --json, otherwise the human text. */
  result(data: Record<string, unknown>, human: string | (() => string)) {
    if (this.json) this.io.stdout(`${JSON.stringify({ ok: true, ...data }, null, 2)}\n`);
    else {
      const text = typeof human === "function" ? human() : human;
      if (text) this.io.stdout(text.endsWith("\n") ? text : `${text}\n`);
    }
  }

  /** Notes for people (stderr), hidden by --quiet. */
  note(text: string) {
    if (!this.quiet) this.io.stderr(`${text}\n`);
  }

  private lastProgress = "";
  /** A single updating progress line on stderr, only when stderr is a terminal. */
  progress(text: string | null) {
    if (this.quiet || !this.io.stderrIsTTY) return;
    if (text === null) {
      if (this.lastProgress) this.io.stderr("\r\x1b[2K");
      this.lastProgress = "";
      return;
    }
    this.lastProgress = text;
    this.io.stderr(`\r\x1b[2K${text}`);
  }

  error(err: CliError) {
    this.progress(null);
    if (this.json) {
      this.io.stdout(`${JSON.stringify({ ok: false, exitCode: err.exitCode, error: err.toJSON() }, null, 2)}\n`);
      return;
    }
    let text = `Error (${err.code}): ${err.message}`;
    if (err.hint) text += `\n  Fix: ${err.hint}`;
    const findings = err.details?.findings as Array<{ path: string; line: number; kind: string }> | undefined;
    if (findings?.length) text += `\n${findings.map((f) => `  ${f.path}:${f.line}  ${f.kind}`).join("\n")}`;
    if (err.requestId) text += `\n  Request id: ${err.requestId}`;
    this.io.stderr(`${text}\n`);
  }
}

// ---------------------------------------------------------------- shared helpers

interface Instance {
  api: string;
  key: string | null;
  keySource: "flag" | "env" | "saved" | null;
  link: ProjectLink | null;
}

async function resolveInstance(p: Parsed, io: Io): Promise<Instance> {
  const link = await readLink(io.cwd);
  const creds = await readCredentials(io.env);
  const raw = str(p, "api") ?? (io.env.KOFRA_API || io.env.KOFRA_URL || undefined) ?? link?.api ?? creds.default ?? undefined;
  if (!raw) {
    throw new CliError({
      code: "no_instance",
      message: "No Kofra instance is configured.",
      hint: "Pass --api https://<your-instance>, set KOFRA_API, or run `kofra login --api https://<your-instance>` once.",
      exitCode: EXIT.usage,
    });
  }
  const api = normaliseApi(raw);
  const flagKey = str(p, "key");
  if (flagKey) return { api, key: flagKey, keySource: "flag", link };
  if (io.env.KOFRA_API_KEY) return { api, key: io.env.KOFRA_API_KEY, keySource: "env", link };
  const saved = creds.instances[api]?.key;
  return { api, key: saved ?? null, keySource: saved ? "saved" : null, link };
}

function clientName(env: NodeJS.ProcessEnv): string {
  if (env.KOFRA_CLIENT) return env.KOFRA_CLIENT.slice(0, 120);
  if (env.CLAUDECODE === "1") return `claude-code/kofra-cli-${VERSION}`;
  return `kofra-cli/${VERSION}`;
}

/** Instances already reported as moved, per Io (one note per run). */
const movedNoted = new WeakMap<Io, Set<string>>();

function makeClient(io: Io, api: string, token: string | null): DropwayClient {
  const onMoved = (to: string) => {
    const seen = movedNoted.get(io) ?? new Set<string>();
    movedNoted.set(io, seen);
    if (seen.has(api)) return;
    seen.add(api);
    io.stderr(`Note: ${api} has moved to ${to}. The old address still works for now; make the new one your default with: kofra login --api ${to}\n`);
  };
  return new DropwayClient({ api, token, fetch: io.fetch, client: clientName(io.env), onMoved });
}

function requireKey(inst: Instance, what = "This command", hint = "Run `kofra login`, set KOFRA_API_KEY, or pass --key. (To publish without a key, use --anonymous if the instance allows it.)"): string {
  if (inst.key) return inst.key;
  throw new CliError({
    code: "not_logged_in",
    message: `${what} needs an API key for ${inst.api}.`,
    hint,
    exitCode: EXIT.auth,
  });
}

function positional(p: Parsed, index: number, name: string, usage: string): string {
  const v = p.positionals[index];
  if (!v) throw new UsageError(`Missing <${name}>. Usage: ${usage}`);
  return v;
}

const enc = encodeURIComponent;

interface VersionRow extends VersionInfo {
  live?: boolean;
}

async function listAllVersions(client: DropwayClient, slug: string): Promise<{ currentVersionId: string | null; versions: VersionRow[] }> {
  const { data } = await client.get<{ currentVersionId: string | null; versions: VersionRow[] }>(`/sites/${enc(slug)}/versions?limit=500`);
  return data;
}

/** "v3", "3" or a version id -> the version. Omitted -> the version before the live one (rollback).
 * Used only by the destructive commands (restore, delete), which keep their
 * historical list-based selection. Read-only commands resolve explicit refs
 * directly (getVersionDirect) so old versions stay readable. */
async function resolveVersion(client: DropwayClient, slug: string, ref: string | undefined): Promise<VersionRow> {
  const { currentVersionId, versions } = await listAllVersions(client, slug);
  if (!ref) {
    const live = versions.find((v) => v.id === currentVersionId);
    const previous = versions.filter((v) => v.id !== currentVersionId && (!live || v.number < live.number)).sort((a, b) => b.number - a.number)[0];
    if (!previous) {
      throw new CliError({ code: "no_previous_version", message: `${slug} has no version older than the live one.`, hint: `List versions with: kofra versions ${slug}`, exitCode: EXIT.notFound });
    }
    return previous;
  }
  const m = /^v?(\d+)$/i.exec(ref.trim());
  const found = m ? versions.find((v) => v.number === Number(m[1])) : versions.find((v) => v.id === ref.trim());
  if (!found) {
    throw new CliError({ code: "version_not_found", message: `${slug} has no finalized version "${ref}".`, hint: `List versions with: kofra versions ${slug}`, exitCode: EXIT.notFound });
  }
  return found;
}

interface DirectVersion {
  site: string;
  version: VersionRow;
  missing: string[];
}

/**
 * Read one version straight from the server ("live", "v3", "3" or an id).
 * Unlike resolveVersion this never pages history, so versions older than the
 * newest 500 stay readable. The ref travels as one encoded path segment, and
 * server errors (code, hint, request id) pass through untouched.
 */
async function getVersionDirect(client: DropwayClient, slug: string, ref: string): Promise<DirectVersion> {
  // encodeURIComponent leaves "." and ".." untouched, and URL normalization
  // would then collapse the request onto a different endpoint (or the list
  // route for ""). Refuse those locally instead of changing the endpoint.
  if (ref === "" || ref === "." || ref === "..") {
    throw new CliError({
      code: "invalid_version_ref",
      message: `Invalid version ${JSON.stringify(ref)}.`,
      hint: `Use "live", "v3", "3" or a version id (see: kofra versions ${slug}).`,
      exitCode: EXIT.usage,
    });
  }
  const { data } = await client.get<DirectVersion>(`/sites/${enc(slug)}/versions/${enc(ref)}`);
  return data;
}

/** Human text for one inspected version (used by `versions <name> <ref>`). */
function singleVersionHuman(slug: string, data: DirectVersion): string {
  const v = data.version;
  const lines = [
    `${slug} v${v.number} (${v.id}): ${v.status ?? "ready"}${v.live ? ", live" : ""}`,
    `Files:    ${v.fileCount ?? "?"} (${formatBytes(v.totalBytes ?? 0)})`,
    `Published: ${shortTime(v.finalizedAt ?? v.createdAt)}`,
  ];
  if (v.message) lines.push(`Message:   ${v.message}`);
  if (v.client) lines.push(`Client:    ${v.client}`);
  if (data.missing.length) lines.push(`Missing blobs: ${data.missing.length} (upload them, then finalize the version)`);
  return lines.join("\n");
}

async function confirm(io: Io, out: Output, p: Parsed, expected: string, what: string): Promise<void> {
  if (bool(p, "yes")) return;
  if (!io.stdinIsTTY || !io.stderrIsTTY || out.json) {
    throw new CliError({ code: "confirmation_required", message: `Refusing to ${what} without confirmation.`, hint: "Re-run with --yes.", exitCode: EXIT.usage });
  }
  const answer = await io.prompt(`Type "${expected}" to ${what}: `);
  if (answer.trim() !== expected) throw new CliError({ code: "not_confirmed", message: "Cancelled: the confirmation did not match.", exitCode: EXIT.usage });
}

async function readSecretInput(io: Io, question: string): Promise<string> {
  if (!io.stdinIsTTY) {
    const v = (await io.readStdin()).trim();
    if (v) return v;
  } else if (io.stderrIsTTY) {
    const v = (await io.prompt(question, { hidden: true })).trim();
    if (v) return v;
  }
  return "";
}

/** Remove exactly one trailing line terminator (`\r\n` or `\n`), nothing else. */
function stripLineTerminator(v: string): string {
  if (v.endsWith("\r\n")) return v.slice(0, -2);
  if (v.endsWith("\n")) return v.slice(0, -1);
  return v;
}

/**
 * Read a visitor password without changing it: the instance hashes and
 * verifies passwords byte-exactly, so (unlike API/bootstrap keys above)
 * surrounding spaces are part of the password. Only the one trailing line
 * terminator from the pipe/prompt is removed. Empty or whitespace-only
 * input still reads as "no password" and is refused before networking.
 */
async function readPasswordInput(io: Io, question: string): Promise<string> {
  if (!io.stdinIsTTY) {
    const v = stripLineTerminator(await io.readStdin());
    if (v.trim()) return v;
  } else if (io.stderrIsTTY) {
    const v = stripLineTerminator(await io.prompt(question, { hidden: true }));
    if (v.trim()) return v;
  }
  return "";
}

const versionLabel = (v: VersionInfo | null | undefined) => (v ? `v${v.number}` : "-");

// ---------------------------------------------------------------- commands

const publishCmd: Command = {
  summary: "Publish a folder, a file or a .zip to a live URL",
  usage: "kofra publish <path> [--site <name>] [--json]",
  maxPositionals: 1,
  flags: {
    site: { kind: "string", short: "s" },
    new: { kind: "boolean" },
    message: { kind: "string", short: "m" },
    title: { kind: "string" },
    spa: { kind: "boolean" },
    base: { kind: "string" },
    anonymous: { kind: "boolean" },
    wait: { kind: "boolean" },
    "wait-timeout": { kind: "string" },
    concurrency: { kind: "string" },
    encrypt: { kind: "boolean" },
    "allow-secrets": { kind: "boolean" },
    "dry-run": { kind: "boolean" },
    save: { kind: "boolean" },
  },
  details: `Options:
  -s, --site <name>     Update this site (created with that name if it does not exist)
  --new                 Always create a new site (ignore ./dropway.json)
  -m, --message <text>  Version message
  --title <text>        Site title
  --spa / --no-spa      Single-page app: unknown paths serve index.html
  --base <versionId>    Fail with a conflict (exit 5) unless this is still the live version
  --anonymous           Publish without a key (only if the instance allows it; the site expires)
  --wait                Return only once the live URL serves the new version
  --wait-timeout <s>    Seconds for --wait (default 90)
  --concurrency <n>     Parallel uploads (default 6)
  --encrypt             Encrypt locally with AES-256-GCM; share key only in the URL fragment
  --allow-secrets       Publish even if files look like they contain credentials
  --dry-run             List what would be published; contact nothing
  --no-save             Do not record the site in ./dropway.json

Only files the instance does not already have are uploaded (SHA-256 content
addressing); publishing identical files again reports "unchanged".
Never published: .git/, node_modules/, .env*, .dev.vars*, .npmrc, *.pem, *.key,
.dropway/, .DS_Store, plus patterns in <path>/.dropwayignore ("!" re-includes).
A .zip file is unpacked by the instance (one request, up to 25 MB by default).
After a publish with a key, ./dropway.json remembers the site for <path>, so
running the same command again updates that site.
With --dry-run --json the result also lists "omissions": every skipped path
with its reason (ignored, excluded, symlink_directory, broken_symlink), sorted
by path. Nothing publishable is refused with no_files (exit 2) before anything
is contacted. Fully offline agent check (no URL or key needed):
  kofra publish ./dist --dry-run --json | jq '{files: [.files[].path], omissions}'
This is a local inventory of what the CLI would send. It does not validate
server policy, quotas or limits, and it is not the server's dry run.`,
  async run(p, io, out) {
    const target = positional(p, 0, "path", this.usage);
    const anonymous = bool(p, "anonymous") === true;
    const dryRun = bool(p, "dry-run") === true;
    if (anonymous && str(p, "site")) throw new UsageError("--anonymous sites get a generated name; drop --site (or use --key <claimToken> --site <name> to update an anonymous site).");
    if (bool(p, "new") && str(p, "site")) throw new UsageError("Use either --new or --site, not both.");
    const concurrency = int(p, "concurrency", 1, 32);
    const waitTimeout = int(p, "wait-timeout", 1, 3600);

    const st = await stat(resolve(io.cwd, target)).catch(() => null);
    if (!st) throw new CliError({ code: "path_not_found", message: `No such file or directory: ${target}`, hint: "Choose an existing file or folder.", exitCode: EXIT.usage });
    const isZip = st.isFile() && /\.zip$/i.test(target);
    const encrypt = bool(p, "encrypt") === true;
    if (encrypt && isZip) throw new CliError({ code: "encrypted_zip_unsupported", message: "Encrypted publishing does not support ZIP archives.", hint: "Extract the archive locally, then publish its folder with --encrypt.", exitCode: EXIT.usage });
    if (encrypt && bool(p, "spa")) throw new CliError({ code: "encrypted_spa_unsupported", message: "Encrypted publishing does not support SPA routing.", hint: "Publish a static entry document without --spa.", exitCode: EXIT.usage });

    const inst = dryRun ? null : await resolveInstance(p, io);
    const token = anonymous ? null : inst ? requireKey(inst, "Publishing") : null;
    const isClaim = token?.startsWith("dwc_") ?? false;
    if (isClaim && !str(p, "site")) throw new UsageError("A claim token publishes only to its own anonymous site: add --site <name>.");
    const key = linkKey(io.cwd, target);
    let site = str(p, "site");
    let linked = false;
    if (inst && !site && !anonymous && !isClaim && bool(p, "new") !== true && inst.link?.api === inst.api) {
      site = inst.link.sites?.[key];
      linked = !!site;
    }
    const settings = { message: str(p, "message"), title: str(p, "title"), spa: bool(p, "spa") };

    let result: PublishResult;
    let waitUrl: string | undefined;
    if (isZip) {
      if (dryRun) {
        out.result({ dryRun: true, path: target, zip: true, bytes: st.size }, `Would upload ${target} (${formatBytes(st.size)}); the instance unpacks it.`);
        return EXIT.ok;
      }
      const client = makeClient(io, inst!.api, token);
      out.progress(`Uploading ${target} (${formatBytes(st.size)})...`);
      const bytes = new Uint8Array(await readFile(resolve(io.cwd, target)));
      result = await publishZip(client, bytes, { site, ...settings, baseVersionId: str(p, "base") });
      out.progress(null);
    } else {
      out.progress("Reading files...");
      const collected = await collectFiles(resolve(io.cwd, target), { exclude: [linkPath(io.cwd)], allowSecrets: bool(p, "allow-secrets") === true });
      out.progress(null);
      for (const l of collected.skippedLinks) out.note(`Skipped symlinked folder ${l}/`);
      if (collected.secrets.length) {
        throw new CliError({
          code: "possible_secrets",
          message: `Refusing to publish: ${plural(collected.secrets.length, "file location")} look like credentials. Published files are public.`,
          hint: "Remove them or add the files to .dropwayignore. If they are not secrets, re-run with --allow-secrets.",
          details: { findings: collected.secrets },
          exitCode: EXIT.usage,
        });
      }
      if (!collected.files.length) {
        throw new CliError({
          code: "no_files",
          message: "There are no files to publish.",
          hint: "Check the path, and .dropwayignore rules.",
          details: { omissions: collected.omissions },
          exitCode: EXIT.usage,
        });
      }
      if (dryRun) {
        out.result(
          { dryRun: true, path: target, files: collected.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })), totalBytes: collected.totalBytes, ignored: collected.ignored, omissions: collected.omissions },
          () => {
            const extras = collected.omissions.filter((o) => o.reason !== "ignored");
            const label = (reason: string) => (reason === "excluded" ? "explicitly excluded" : reason === "symlink_directory" ? "symlinked folder" : reason === "special_file" ? "not a regular file" : "broken link");
            return [
              ...collected.files.map((f) => `${f.path}  ${formatBytes(f.size)}`),
              `Would publish ${plural(collected.files.length, "file")} (${formatBytes(collected.totalBytes)}).${collected.ignored.length ? ` Ignored: ${collected.ignored.join(", ")}` : ""}${extras.length ? ` Omitted: ${extras.map((o) => `${o.path} (${label(o.reason)})`).join(", ")}` : ""}`,
            ].join("\n");
          },
        );
        return EXIT.ok;
      }
      const encrypted = encrypt ? await encryptFiles(collected.files) : null;
      const client = makeClient(io, inst!.api, token);
      result = await publish(client, encrypted?.files ?? collected.files, {
        site,
        ...settings,
        baseVersionId: str(p, "base"),
        concurrency,
        onProgress: (e: ProgressEvent) => {
          if (e.phase === "deploy") out.progress(`Checking ${plural(e.files, "file")} against ${inst!.api}...`);
          else if (e.phase === "upload" && e.total) out.progress(`Uploading ${e.done}/${e.total} files (${formatBytes(e.bytes)} of ${formatBytes(e.totalBytes)})...`);
          else if (e.phase === "finalize") out.progress("Going live...");
        },
      });
      if (encrypted) {
        waitUrl = new URL("encrypted.bin?raw=1", result.url).href;
        result.url = `${inst!.api}/__dropway/encrypted/${enc(result.slug)}#${encrypted.fragment}`;
        result.warnings.push({ code: "encrypted_link", message: "Anyone with this full URL can decrypt. Keep it safe: lost keys cannot be recovered. Each encrypted republish creates a new key. See the CLI guide for host/recipient limits." });
      }
      out.progress(null);
    }

    let savedLink: string | null = null;
    if (!anonymous && !isClaim && bool(p, "save") !== false && !result.claimToken) {
      const saved = await writeLink(io.cwd, inst!.api, key, result.slug).catch(() => null);
      if (saved?.created) savedLink = saved.path;
    }

    let waited: boolean | undefined;
    if (bool(p, "wait") && result.version?.id) {
      out.progress("Waiting for the live URL to serve the new version...");
      waited = await waitForVersion(waitUrl ?? result.url, result.version.id, { timeoutMs: (waitTimeout ?? 90) * 1000, fetch: io.fetch });
      out.progress(null);
    }

    out.result({ ...result, api: inst!.api, ...(linked ? { linkedFrom: "dropway.json" } : {}), ...(waited !== undefined ? { live: waited } : {}) }, () => {
      const v = versionLabel(result.version);
      const lines = result.unchanged
        ? [`No changes: ${result.slug} is already live at ${v}.`]
        : [
            `Published ${result.slug} ${v}: ${plural(result.files, "file")}, ${result.uploaded} uploaded, ${result.reused} already stored (${formatBytes(result.bytesUploaded)} sent).`,
          ];
      lines.push(result.url);
      for (const w of result.warnings) lines.push(`Warning (${w.code}): ${w.message}`);
      if (result.claimToken) {
        lines.push(`Anonymous site: it expires ${result.expiresAt ?? "soon"}.`);
        lines.push(`Claim token (keep it to update or claim this site): ${result.claimToken}`);
        if (result.claimUrl) lines.push(`Claim it: ${result.claimUrl}`);
      }
      return lines.join("\n");
    });
    if (savedLink) out.note(`Saved the site name to ${savedLink}: publishing ${target} again updates ${result.slug}. (--no-save to skip, --new for a new site)`);
    if (waited === false) {
      out.note(`The live URL did not serve ${versionLabel(result.version)} within ${waitTimeout ?? 90}s. It usually catches up within a minute.`);
      return EXIT.waitTimeout;
    }
    return EXIT.ok;
  },
};

const listCmd: Command = {
  summary: "List your sites",
  usage: "kofra list [--limit <n>] [--all]",
  maxPositionals: 0,
  flags: { limit: { kind: "string" }, all: { kind: "boolean" }, cursor: { kind: "string" } },
  async run(p, io, out) {
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, requireKey(inst));
    const limit = int(p, "limit", 1, 200) ?? 50;
    type SiteItem = { slug: string; url: string; title: string | null; anonymous: boolean; expiresAt: string | null; currentVersion: VersionInfo | null; updatedAt: string | null };
    const sites: SiteItem[] = [];
    let cursor = str(p, "cursor") ?? null;
    for (;;) {
      const q = new URLSearchParams({ limit: String(bool(p, "all") ? 200 : limit) });
      if (cursor) q.set("cursor", cursor);
      const { data } = await client.get<{ sites: SiteItem[]; nextCursor: string | null }>(`/sites?${q}`);
      sites.push(...data.sites);
      cursor = data.nextCursor;
      if (!bool(p, "all") || !cursor) break;
    }
    out.result({ sites, nextCursor: cursor }, () => {
      if (!sites.length) return "No sites yet. Publish one with: kofra publish <path>";
      const rows = sites.map((s) => [s.slug, versionLabel(s.currentVersion), String(s.currentVersion?.fileCount ?? 0), shortTime(s.updatedAt), s.url]);
      let text = table(rows, ["SITE", "LIVE", "FILES", "UPDATED", "URL"]);
      if (cursor) text += `\nMore: kofra list --cursor ${cursor} (or --all)`;
      return text;
    });
    return EXIT.ok;
  },
};

const siteCmd: Command = {
  summary: "Show one site",
  usage: "kofra site <name>",
  maxPositionals: 1,
  flags: {},
  async run(p, io, out) {
    const slug = positional(p, 0, "name", this.usage);
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, requireKey(inst));
    const { data } = await client.get<{ site: Record<string, any> }>(`/sites/${enc(slug)}`);
    const s = data.site;
    out.result({ site: s }, () =>
      [
        `${s.slug}${s.title ? ` (${s.title})` : ""}`,
        `URL:      ${s.url}`,
        `Live:     ${s.currentVersion ? `v${s.currentVersion.number} (${s.currentVersion.id}), ${plural(s.currentVersion.fileCount, "file")}, ${formatBytes(s.currentVersion.totalBytes)}` : "nothing published"}`,
        `Settings: spa=${s.settings?.spa} renderMarkdown=${s.settings?.renderMarkdown} password=${s.settings?.passwordProtected}`,
        ...(s.expiresAt ? [`Expires:  ${s.expiresAt}`] : []),
        `Updated:  ${shortTime(s.updatedAt)}`,
      ].join("\n"),
    );
    return EXIT.ok;
  },
};

const RENAME_LINK_GUIDANCE = "Saved local project mappings remain unchanged. Before a later publish, update the affected dropway.json mapping or use kofra publish <path> --site <new-slug> to update and save the explicit target.";

/** Recover the old canonical address only for a recognizable returned site URL. */
function renamedFromUrl(url: string, slug: string, oldSlug: string): string | null {
  try {
    const old = new URL(url);
    if (old.hostname.startsWith(`${slug}.`)) {
      old.hostname = `${oldSlug}${old.hostname.slice(slug.length)}`;
    } else if (old.pathname.endsWith(`/${slug}/`)) {
      old.pathname = `${old.pathname.slice(0, -(slug.length + 1))}${oldSlug}/`;
    } else {
      return null;
    }
    return old.href;
  } catch {
    return null;
  }
}

const renameCmd: Command = {
  summary: "Rename an explicit site; leave local project mappings unchanged",
  usage: "kofra rename <source> <new-slug> --yes [--dry-run] [--json]",
  maxPositionals: 2,
  flags: { yes: { kind: "boolean", short: "y" }, "dry-run": { kind: "boolean" } },
  details: `The source must be an explicit site slug, id or URL; saved targets are never used.
  --yes       Required to rename, even in a terminal; this command never prompts
  --dry-run   Offline normalized target/patch plan; no key or --yes needed

Calls rename_site once through POST /api/v1/sites/{source}/rename. The server
validates the name and permissions. A canonical no-op is a successful result.
Only a returned redirectUntil establishes an old-URL redirect deadline; no
redirect duration is assumed. Release and override flags are not supported.

${RENAME_LINK_GUIDANCE}

Examples:
  kofra rename old-report new-report --dry-run --json
  kofra rename old-report new-report --yes --json`,
  async run(p, io, out) {
    const source = positional(p, 0, "source", this.usage);
    const slug = positional(p, 1, "new-slug", this.usage).trim().toLowerCase();
    if (!source.trim() || source === "." || source === "..") throw new UsageError("Use an explicit site slug, id or URL as the source.");
    if (!slug) throw new UsageError("The new slug must not be empty.");
    const dryRun = bool(p, "dry-run") === true;
    if (!dryRun && bool(p, "yes") !== true) {
      throw new CliError({ code: "confirmation_required", message: "Refusing to rename without --yes.", hint: "Re-run with --yes, or inspect an offline plan with --dry-run.", exitCode: EXIT.usage });
    }
    const inst = await resolveInstance(p, io);
    if (dryRun) {
      const plan = { schemaVersion: 1, operation: "rename_site", target: { api: inst.api, site: source }, patch: { slug }, localLinksUpdated: false };
      if (out.json) io.stdout(`${JSON.stringify(plan, null, 2)}\n`);
      else out.result(plan, `Would rename ${source} to ${slug} on ${inst.api}. No request made; source identity and server policy are not resolved.\n${RENAME_LINK_GUIDANCE}`);
      return EXIT.ok;
    }
    const client = makeClient(io, inst.api, requireKey(inst, "Renaming", "Run `kofra login`, set KOFRA_API_KEY, or pass --key."));
    const result = await client.renameSite({ slug: source, newSlug: slug });
    const data = { ...result, localLinksUpdated: false };
    // Preserve the API body, including identity and null deadlines, without an envelope.
    if (out.json) io.stdout(`${JSON.stringify(data, null, 2)}\n`);
    else out.result(data, () => {
      const oldUrl = result.url && result.slug && result.oldSlug ? renamedFromUrl(result.url, result.slug, result.oldSlug) : null;
      return [
        result.renamed ? `Renamed ${result.oldSlug} to ${result.slug}.` : `${result.slug}: unchanged (no rename).`,
        oldUrl ? `Old URL: ${oldUrl}` : `Old name: ${result.oldSlug ?? "not returned"} (old URL unavailable from the returned address).`,
        `New URL: ${result.url}`,
        ...(result.redirectUntil ? [`Old URL redirects until ${result.redirectUntil}.`] : []),
        RENAME_LINK_GUIDANCE,
      ].join("\n");
    });
    return EXIT.ok;
  },
};

const filesCmd: Command = {
  summary: "List the files of a site's live (or given) version",
  usage: "kofra files <name> [--version <v>]",
  maxPositionals: 1,
  flags: { version: { kind: "string" } },
  details: `The version may be "live", "v3", "3" or a version id; it is read
directly from the server, so versions older than the newest 500 work too.
Without --version, the live version's files are listed.`,
  async run(p, io, out) {
    const slug = positional(p, 0, "name", this.usage);
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, requireKey(inst));
    const ref = str(p, "version");
    // Any explicit --version (even an empty one) resolves directly: the server
    // answers 404 for unknown refs instead of silently listing the live version.
    const versionId = ref !== undefined ? (await getVersionDirect(client, slug, ref)).version.id : null;
    const { data } = await client.get<{ version: VersionInfo | null; files: Array<{ path: string; size: number; contentType: string; url: string; rawUrl: string }> }>(
      `/sites/${enc(slug)}/files${versionId ? `?version=${enc(versionId)}` : ""}`,
    );
    out.result({ version: data.version, files: data.files }, () =>
      data.files.length ? table(data.files.map((f) => [f.path, formatBytes(f.size), f.contentType, f.url]), ["PATH", "SIZE", "TYPE", "URL"]) : "No files.",
    );
    return EXIT.ok;
  },
};

/**
 * A response versionId is only a safe continuation when the server resolves
 * it as an id: never live, numeric, vN or blank (mirror of resolveVersionRef
 * in site-ops, which trims and matches "live" and /^v?(\d{1,9})$/i first).
 */
function isImmutableVersionId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const id = value.trim();
  return id !== "" && id.toLowerCase() !== "live" && !/^v?\d{1,9}$/i.test(id);
}

interface ReadFilePage {
  path: string;
  versionId: string;
  contentType: string;
  kind: string;
  size: number;
  sha256: string;
  encoding: string;
  offset: number;
  length: number;
  truncated: boolean;
  nextOffset: number | null;
  content: string;
  url: string;
  rawUrl: string;
}

const readFileCmd: Command = {
  summary: "Read one file's content (one bounded page)",
  usage: "kofra read-file <site> <path> [--version <v>] [--offset <n>] [--length <n>] [--encoding auto|text|base64]",
  maxPositionals: 2,
  flags: {
    version: { kind: "string" },
    offset: { kind: "string" },
    length: { kind: "string" },
    encoding: { kind: "string" },
  },
  details: `One bounded page per call (default 64 KiB, up to 1 MiB with --length).
The version ("live", "v3", "3" or an id) is passed straight to
GET /api/v1/read-file (operation read_file; MCP tool read_file): no
version listing and no auto-fetch of the whole file.

With --json, stdout is exactly the API page (path, versionId,
contentType, size, sha256, encoding, offset, length, truncated,
nextOffset, content, url, rawUrl). Without --json, stdout carries only
the page content byte-for-byte (no added newline; base64 stays base64,
so redirection is safe) and the page metadata goes to stderr, so
pipes get clean content and truncation is never silent (shown even with
--quiet). A truncated page prints a continuation pinned to the returned
immutable version id, so the next page reads the same version even
after live moves; a page without one fails instead of guessing.

Examples:
  kofra read-file my-site index.html
  kofra read-file my-site image.png --encoding base64 > image.b64
  kofra read-file my-site big.txt --length 65536 --json
  kofra read-file my-site big.txt --offset 65536 --length 65536`,
  async run(p, io, out) {
    const slug = positional(p, 0, "site", this.usage);
    const filePath = positional(p, 1, "path", this.usage);
    const version = str(p, "version");
    const encoding = str(p, "encoding");
    if (encoding !== undefined && encoding !== "auto" && encoding !== "text" && encoding !== "base64") {
      throw new UsageError("--encoding must be auto, text or base64.");
    }
    const offsetRaw = str(p, "offset");
    let offset: number | undefined;
    if (offsetRaw !== undefined) {
      if (offsetRaw.trim() === "") throw new UsageError("--offset must be a whole number 0 or greater.");
      const n = Number(offsetRaw);
      if (!Number.isSafeInteger(n) || n < 0) throw new UsageError("--offset must be a whole number 0 or greater.");
      offset = n;
    }
    const length = int(p, "length", 1, 1048576);
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, requireKey(inst));
    const q = new URLSearchParams({ site: slug, path: filePath });
    if (version !== undefined) q.set("version", version);
    if (offset !== undefined) q.set("offset", String(offset));
    if (length !== undefined) q.set("length", String(length));
    if (encoding !== undefined) q.set("encoding", encoding);
    const { data } = await client.get<ReadFilePage>(`/read-file?${q}`);
    if (out.json) {
      out.result(data as unknown as Record<string, unknown>, () => data.content);
    } else {
      // A requested "live"/"v3"/"3" (or no --version at all) may resolve to
      // a different version by the time the agent continues, so the
      // continuation always pins the id this page was actually read from.
      if (data.truncated && data.nextOffset !== null && !isImmutableVersionId(data.versionId)) {
        throw new CliError({
          code: "bad_read_file_version",
          message: `The read-file response for ${slug} ${filePath} carries no immutable version id; refusing to print a continuation that could read another version.`,
          hint: "Re-run with an explicit version id (`kofra versions <site>` lists them). If this repeats, report the response to the instance operator.",
          exitCode: EXIT.error,
        });
      }
      // Human output is the content byte-for-byte: no added newline, so
      // redirection stays safe and base64 can be decoded as-is.
      io.stdout(data.content);
      const end = data.offset + data.length;
      const range = data.size === 0 ? "empty file" : `bytes ${data.offset}-${Math.max(data.offset, end - 1)} of ${data.size}`;
      let line = `${data.path} — ${formatBytes(data.size)} (${data.contentType}), encoding ${data.encoding}, version ${data.versionId}, ${range}. SHA-256: ${data.sha256}`;
      if (data.truncated && data.nextOffset !== null) {
        const cont = [`kofra read-file ${shellQuote(slug)} ${shellQuote(data.path)}`, `--offset ${data.nextOffset}`];
        cont.push(`--version ${shellQuote(data.versionId)}`);
        if (length !== undefined) cont.push(`--length ${length}`);
        if (encoding !== undefined) cont.push(`--encoding ${encoding}`);
        line += `\nTruncated: continue with: ${cont.join(" ")}`;
      }
      io.stderr(`${line}\n`);
    }
    return EXIT.ok;
  },
};

const versionsCmd: Command = {
  summary: "List a site's versions, or inspect one",
  usage: "kofra versions <name> [ref]",
  maxPositionals: 2,
  flags: {},
  details: `Inspect one version directly, without paging history (this works even
for versions older than the newest 500 the list shows):
  kofra versions <name> live          the live version
  kofra versions <name> v3            version number 3 ("3" works too)
  kofra versions <name> <versionId>   the exact version id

A bare "kofra versions <name>" lists the newest 500 versions only, newest
first; older versions stay inspectable by ref as above.`,
  async run(p, io, out) {
    const slug = positional(p, 0, "name", this.usage);
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, requireKey(inst));
    const ref = p.positionals[1];
    if (ref === undefined) {
      const data = await listAllVersions(client, slug);
      out.result(data as unknown as Record<string, unknown>, () =>
        data.versions.length
          ? table(
              data.versions.map((v) => [`v${v.number}`, v.id === data.currentVersionId ? "live" : "", v.id, shortTime(v.finalizedAt ?? v.createdAt), String(v.fileCount ?? ""), formatBytes(v.totalBytes ?? 0), v.client ?? "", v.message ?? ""]),
              ["VERSION", "", "ID", "PUBLISHED", "FILES", "SIZE", "CLIENT", "MESSAGE"],
            )
          : "No versions yet.",
      );
      return EXIT.ok;
    }
    const data = await getVersionDirect(client, slug, ref);
    out.result(data as unknown as Record<string, unknown>, () => singleVersionHuman(slug, data));
    return EXIT.ok;
  },
};

const restoreCmd: Command = {
  summary: "Make an older version live again (default: the one before the live version)",
  usage: "kofra restore <name> [v<N> | <N> | <versionId>]",
  maxPositionals: 2,
  flags: {},
  async run(p, io, out) {
    const slug = positional(p, 0, "name", this.usage);
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, requireKey(inst));
    const v = await resolveVersion(client, slug, p.positionals[1]);
    const { data } = await client.post<{ restored: boolean; alreadyLive: boolean; version: VersionInfo; url: string }>(`/sites/${enc(slug)}/versions/${enc(v.id)}/restore`, {}, { retry: "safe" });
    out.result(data, () => (data.alreadyLive ? `${slug} v${data.version.number} is already live.\n${data.url}` : `Restored ${slug} to v${data.version.number}.\n${data.url}`));
    return EXIT.ok;
  },
};

const deleteCmd: Command = {
  summary: "Delete a site (or one non-live version with --version)",
  usage: "kofra delete <name> [--version <v>] --yes",
  maxPositionals: 1,
  flags: { yes: { kind: "boolean", short: "y" }, version: { kind: "string" } },
  async run(p, io, out) {
    const slug = positional(p, 0, "name", this.usage);
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, requireKey(inst));
    const ref = str(p, "version");
    if (ref) {
      const v = await resolveVersion(client, slug, ref);
      await confirm(io, out, p, slug, `delete version v${v.number} of ${slug}`);
      const { data } = await client.request("DELETE", `/sites/${enc(slug)}/versions/${enc(v.id)}`);
      out.result({ ...data, slug, version: v.number }, `Deleted version v${v.number} of ${slug}.`);
      return EXIT.ok;
    }
    await confirm(io, out, p, slug, `delete the site ${slug}`);
    const { data } = await client.request("DELETE", `/sites/${enc(slug)}`);
    out.result(data, `Deleted ${slug}. Its URL stops working now; the name is free again.`);
    return EXIT.ok;
  },
};

const accessCmd: Command = {
  summary: "Set who can open a site (public or password-protected)",
  usage: "kofra access <site> --mode <public|password|restricted|private> --yes [--json]",
  maxPositionals: 1,
  flags: {
    mode: { kind: "string" },
    yes: { kind: "boolean", short: "y" },
    "dry-run": { kind: "boolean" },
  },
  details: `The site is explicit: pass its slug, id or URL (never inferred from ./dropway.json).

Options:
  --mode <mode>   public (anyone with the link) or password (visitors must
                  enter the password). restricted and private are not available
                  on this edition yet: the server answers 501 feature_unavailable.
  --yes, -y       Required: confirm the change (never prompts, even in a terminal).
  --dry-run       Print the plan without contacting the instance (no --yes or
                  key needed): one JSON object with planVersion, site, mode and
                  passwordSupplied. The password itself never appears.
  --json          Print exactly one JSON object on stdout.

With --mode password the visitor password comes from piped stdin, or from one
no-echo prompt in a terminal; empty input is refused before anything is sent.
Only the trailing newline is removed: surrounding spaces are part of the
password and are sent exactly as entered.
Changing the password signs everyone out. The password is never printed, logged
or echoed back in errors.

Examples:
  kofra access my-site --mode public --yes
  echo "$PASSWORD" | kofra access my-site --mode password --yes --json
  kofra access my-site --mode password --dry-run --json`,
  async run(p, io, out) {
    const site = positional(p, 0, "site", this.usage);
    const mode = str(p, "mode");
    if (!mode) throw new UsageError(`Missing --mode. Usage: ${this.usage}`);
    if (mode !== "public" && mode !== "password" && mode !== "restricted" && mode !== "private") {
      throw new UsageError(`--mode must be public, password, restricted or private (got ${JSON.stringify(mode)}).`);
    }
    if (bool(p, "dry-run") === true) {
      // Offline plan: no instance resolution, no key, no requests, no writes.
      // Never prompts and never fails for a missing password.
      let passwordSupplied = false;
      if (mode === "password" && !io.stdinIsTTY) passwordSupplied = stripLineTerminator(await io.readStdin()).trim() !== "";
      out.result({ dryRun: true, planVersion: 1, site, mode, passwordSupplied }, () =>
        mode === "password"
          ? `Dry run: would set ${site} access to password (${passwordSupplied ? "password supplied" : "no password supplied"}).`
          : `Dry run: would set ${site} access to ${mode}${mode === "public" ? " (visitors would not need a password)" : ""}.`,
      );
      return EXIT.ok;
    }
    if (bool(p, "yes") !== true) {
      throw new CliError({
        code: "confirmation_required",
        message: `Refusing to change ${site} access without confirmation.`,
        hint: "Re-run with --yes.",
        exitCode: EXIT.usage,
      });
    }
    let password = "";
    if (mode === "password") {
      password = await readPasswordInput(io, "Visitor password: ");
      if (!password) {
        throw new CliError({
          code: "missing_password",
          message: "Missing the visitor password.",
          hint: "Pipe the visitor password on stdin or run in a terminal to be prompted.",
          exitCode: EXIT.usage,
        });
      }
    }
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, requireKey(inst, "Setting site access"));
    const typedMode = mode as "public" | "password" | "restricted" | "private";
    const data = await client.setSiteAccess(mode === "password" ? { slug: site, mode: typedMode, password } : { slug: site, mode: typedMode });
    out.result({ site: data.site, access: data.access }, () => {
      if (mode === "password") return `${site} is now password-protected: visitors need the password to open it.\nChanging the password signs everyone out.`;
      if (mode === "public") return `${site} is now public: visitors do not need a password to open it.\nChanging the password signs everyone out.`;
      return `${site} access mode is now ${mode}.`;
    });
    return EXIT.ok;
  },
};

const whoamiCmd: Command = {
  summary: "Show the instance and the identity of your key",
  usage: "kofra whoami",
  maxPositionals: 0,
  flags: {},
  async run(p, io, out) {
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, inst.key);
    const { data } = await client.get<Record<string, any>>("/me");
    const signedIn = data.principal === "member" || data.principal === "claim_token";
    out.result({ ok: signedIn, signedIn, api: inst.api, keySource: inst.keySource, ...data }, () => {
      if (data.principal === "member") {
        const m = data.member ?? {};
        return [
          `Instance: ${inst.api}`,
          `Signed in as ${m.email ?? m.name ?? m.id} (${m.role})${data.tenant?.name ? ` in ${data.tenant.name}` : ""}`,
          `Key: ${data.keyId} (${inst.keySource ?? "?"}), scopes: ${(data.scopes ?? []).join(" ")}${data.siteRestriction ? `, only site ${data.siteRestriction}` : ""}`,
        ].join("\n");
      }
      if (data.principal === "claim_token") return `Instance: ${inst.api}\nUsing a claim token for one anonymous site (${data.siteId}).`;
      return `Instance: ${inst.api}\nNot signed in. Anonymous publishing is ${data.anonymousPublish ? "on" : "off"} here.\nRun: kofra login --api ${inst.api}`;
    });
    return signedIn ? EXIT.ok : EXIT.auth;
  },
};

const loginCmd: Command = {
  summary: "Save an API key for an instance",
  usage: "kofra login [--api <url>] [--key <dw_...>]   (or pipe the key on stdin)",
  maxPositionals: 0,
  flags: {},
  details: `The key is checked against the instance, then saved to ${"<config dir>/credentials.json"}
(mode 0600; config dir: $KOFRA_CONFIG_DIR, $XDG_CONFIG_HOME/dropway or ~/.config/dropway).
The instance becomes your default. Get a key from the instance owner, or create
the owner key on a new instance with: kofra setup --api <url> --email <you>`,
  async run(p, io, out) {
    let raw = str(p, "api") ?? (io.env.KOFRA_API || io.env.KOFRA_URL || undefined);
    if (!raw) {
      const link = await readLink(io.cwd);
      raw = link?.api ?? (await readCredentials(io.env)).default ?? undefined;
    }
    if (!raw && io.stdinIsTTY && io.stderrIsTTY) raw = (await io.prompt("Kofra URL (e.g. https://dropway.example.workers.dev): ")).trim();
    if (!raw) throw new UsageError("Missing the instance URL: pass --api <url>.");
    const api = normaliseApi(raw);
    const key = str(p, "key") ?? (await readSecretInput(io, "API key (dw_...): "));
    if (!key) throw new UsageError("Missing the API key: pass --key, pipe it on stdin, or run in a terminal to be prompted.");
    if (!key.startsWith("dw_")) throw new UsageError("API keys start with dw_.");
    const client = makeClient(io, api, key);
    const { data } = await client.get<Record<string, any>>("/me");
    if (data.principal !== "member") {
      throw new CliError({ code: "invalid_api_key", message: "The instance did not accept this key.", exitCode: EXIT.auth });
    }
    const path = await saveCredentials(api, { key, email: data.member?.email ?? null, tenantId: data.tenant?.id ?? null }, io.env);
    out.result({ api, email: data.member?.email ?? null, role: data.member?.role ?? null, scopes: data.scopes ?? [], savedTo: path }, `Logged in to ${api} as ${data.member?.email ?? data.member?.id}. Key saved to ${path}.`);
    return EXIT.ok;
  },
};

const logoutCmd: Command = {
  summary: "Forget the saved key for an instance",
  usage: "kofra logout [--api <url>]",
  maxPositionals: 0,
  flags: {},
  async run(p, io, out) {
    const creds = await readCredentials(io.env);
    const raw = str(p, "api") ?? (io.env.KOFRA_API || io.env.KOFRA_URL || undefined) ?? creds.default ?? undefined;
    if (!raw) throw new UsageError("Not logged in anywhere.");
    const api = normaliseApi(raw);
    const removed = await removeCredentials(api, io.env);
    out.result({ api, removed }, removed ? `Removed the saved key for ${api}.` : `No saved key for ${api}.`);
    return EXIT.ok;
  },
};

const setupCmd: Command = {
  summary: "First run of a new instance: create the owner and save their API key",
  usage: "kofra setup --api <url> --email <you@example.com>   (bootstrap key from $KOFRA_BOOTSTRAP_KEY, stdin or a prompt)",
  maxPositionals: 0,
  flags: { email: { kind: "string" }, name: { kind: "string" }, "show-key": { kind: "boolean" }, save: { kind: "boolean" } },
  details: `Uses the instance's ADMIN_BOOTSTRAP_KEY secret once to create the owner.
The owner API key is saved like \`kofra login\` (the full key is printed only with
--show-key, or when --no-save skips saving it).`,
  async run(p, io, out) {
    const raw = str(p, "api") ?? (io.env.KOFRA_API || io.env.KOFRA_URL || undefined);
    if (!raw) throw new UsageError("Missing --api <url> (the instance to set up).");
    const api = normaliseApi(raw);
    const bootstrap = io.env.KOFRA_BOOTSTRAP_KEY || (await readSecretInput(io, "Bootstrap key (ADMIN_BOOTSTRAP_KEY): "));
    if (!bootstrap) throw new UsageError("Missing the bootstrap key: set KOFRA_BOOTSTRAP_KEY, pipe it on stdin, or run in a terminal.");
    const client = makeClient(io, api, bootstrap);
    const body: Record<string, string> = {};
    const email = str(p, "email");
    if (email) body.email = email;
    const name = str(p, "name");
    if (name) body.name = name;
    const { data } = await client.post<{ apiKey: { key: string; id?: string }; member?: { email?: string | null }; tenant?: { id?: string } }>("/setup", body);
    const key = data.apiKey.key;
    let savedTo: string | null = null;
    if (bool(p, "save") !== false) savedTo = await saveCredentials(api, { key, email: data.member?.email ?? email ?? null, tenantId: data.tenant?.id ?? null }, io.env);
    const showKey = bool(p, "show-key") === true || savedTo === null;
    out.result({ api, email: data.member?.email ?? email ?? null, keyId: data.apiKey.id ?? null, ...(showKey ? { apiKey: key } : {}), savedTo }, () =>
      [
        `Instance ${api} is set up. Owner: ${data.member?.email ?? email ?? "(no email)"}.`,
        savedTo ? `Owner API key saved to ${savedTo}.` : "",
        showKey
          ? `Owner API key (shown once): ${key}`
          : `The key is not printed (--show-key prints it). For CI or an MCP client, create a separate key: kofra api POST /keys --data '{"name":"ci"}'`,
        `Next: kofra publish <folder>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return EXIT.ok;
  },
};

interface KeyItem {
  id: string;
  name: string | null;
  prefix: string;
  memberId: string;
  scopes: string[];
  siteId: string | null;
  current?: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
}

/** Validate a key record's shape without judging its values or dropping extension fields. */
function isKeyItem(value: unknown): value is KeyItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const text = (v: unknown): v is string => typeof v === "string";
  const nullableText = (v: unknown): v is string | null => v === null || typeof v === "string";
  return text(row.id)
    && nullableText(row.name)
    && text(row.prefix)
    && text(row.memberId)
    && Array.isArray(row.scopes) && row.scopes.every((s) => typeof s === "string")
    && nullableText(row.siteId)
    && (row.current === undefined || typeof row.current === "boolean")
    && nullableText(row.createdAt)
    && nullableText(row.lastUsedAt)
    && nullableText(row.expiresAt)
    && typeof row.revoked === "boolean";
}

const keysCmd: Command = {
  summary: "List your API keys (safe metadata only, never the secrets)",
  usage: "kofra keys ls [--all] [--json]",
  maxPositionals: 1,
  flags: { all: { kind: "boolean" } },
  details: `List API keys as safe metadata only: id, name, prefix, scopes, site
restriction, expiry and last use. The secrets themselves are never shown.

Examples:
  kofra keys ls            # your own keys
  kofra keys ls --all      # every member's keys (needs members:write)
  kofra keys ls --json     # one JSON object: { keys: [...] }

Listing needs the keys:write scope. With --all the server also lists other
members' keys when your key has the members:write scope; otherwise --all
still lists only your own keys. Create and revoke keys with the generic
command, e.g.: kofra api POST /keys --data '{"name":"ci"}'`,
  async run(p, io, out) {
    const [sub] = p.positionals;
    if (sub !== "ls") {
      throw new UsageError(sub === undefined ? `Missing subcommand. Usage: ${this.usage}` : `Unknown keys subcommand "${sub}". Usage: ${this.usage}`);
    }
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, requireKey(inst, "Listing keys"));
    const { data } = await client.get<unknown>(bool(p, "all") === true ? "/keys?all=true" : "/keys");
    const keys = data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as { keys?: unknown }).keys
      : undefined;
    if (!Array.isArray(keys) || !keys.every(isKeyItem)) {
      throw new CliError({
        code: "invalid_key_list",
        message: `The instance answered ${inst.api}/api/v1/keys with an unexpected shape.`,
        hint: "Is this a Kofra instance? Check --api / KOFRA_API (use the origin, without /api/v1).",
        exitCode: EXIT.error,
      });
    }
    out.result({ keys }, () => {
      if (!keys.length) return "No API keys.";
      // Escape data before table layout so names cannot control the terminal or forge rows.
      const textCell = (value: string) => value.replace(
        /[\u0000-\u001f\u007f-\u009f]/g,
        (control) => `\\u${control.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
      const rows = keys.map((k) => [
        k.current === true ? "*" : "",
        k.id,
        k.name ?? "-",
        k.prefix,
        k.scopes.join(" "),
        k.siteId ?? "-",
        shortTime(k.createdAt),
        shortTime(k.lastUsedAt),
        k.expiresAt ?? "-",
      ].map(textCell));
      return table(rows, ["CURRENT (*)", "ID", "NAME", "PREFIX", "SCOPES", "SITE", "CREATED", "LAST USED", "EXPIRES"]);
    });
    return EXIT.ok;
  },
};

interface CatalogOperation extends Record<string, unknown> {
  id: string;
  method: string;
  path: string;
  scopes: string[];
  inputSchema: Record<string, unknown>;
  cli?: { command: string[]; positional?: string[] };
}

/** Validate the public catalog's fields without dropping extension metadata. */
function isCatalogOperation(value: unknown): value is CatalogOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
  const cli = row.cli as Record<string, unknown> | undefined;
  return typeof row.id === "string" && row.id.length > 0
    && typeof row.method === "string" && row.method.length > 0
    && typeof row.path === "string" && row.path.length > 0
    && strings(row.scopes)
    && row.inputSchema !== null && typeof row.inputSchema === "object" && !Array.isArray(row.inputSchema)
    && (cli === undefined || (cli !== null && typeof cli === "object" && !Array.isArray(cli)
      && strings(cli.command) && (cli.positional === undefined || strings(cli.positional))));
}

/** The catalog row without its input schema; every other field stays exactly as the server sent it. */
function stripInputSchema(row: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (key !== "inputSchema") compact[key] = value;
  return compact;
}

function operationDetail(row: Record<string, unknown>, withSchema: boolean): string {
  const scopes = Array.isArray(row.scopes) ? row.scopes.map(String) : [];
  const cli = row.cli as { command?: unknown; positional?: unknown } | undefined;
  const lines = [
    String(row.id),
    `  ${String(row.method)} ${String(row.path)}`,
    `  Scopes: ${scopes.length ? scopes.join(" ") : "(none)"}`,
  ];
  if (cli && Array.isArray(cli.command)) {
    const positionals = Array.isArray(cli.positional) ? cli.positional.map((name) => `<${String(name)}>`).join(" ") : "";
    lines.push(`  CLI: kofra ${cli.command.map(String).join(" ")}${positionals ? ` ${positionals}` : ""}`);
  }
  if (withSchema) lines.push(`  Input schema:\n${JSON.stringify(row.inputSchema ?? {}, null, 2)}`);
  return lines.join("\n");
}

const duplicateCmd: Command = {
  summary: "Duplicate a live site: duplicate <source> <new-slug>",
  usage: "kofra duplicate <source> <new-slug> [--message <text>] [--idempotency-key <key>] [--dry-run] [--json]",
  maxPositionals: 2,
  flags: {
    message: { kind: "string", short: "m" },
    "idempotency-key": { kind: "string" },
    "dry-run": { kind: "boolean" },
  },
  details: `Both targets are required: source is a slug, site id or site URL. Neither
is inferred from a local project mapping. The existing live manifest becomes
version 1 of a new site; no local files are read or uploaded and no links are saved.
Only SPA mode is copied. Passwords/access gates and other settings are not copied;
re-apply protection explicitly. The destination is live immediately, not opened
in a browser or automatically protected.

--dry-run emits one schemaVersion: 1 JSON plan even without --json. It is entirely
offline: no instance, credentials or files are read, and no source id is resolved.
--idempotency-key preserves an explicit key (1-255 printable ASCII characters,
no spaces); otherwise one is generated per invocation. Invalid keys are rejected
before any I/O, including with --dry-run. To recover an unknown outcome, repeat
the identical source, new slug and message with the same explicit key (within the
server's 24h window).
Mutations retry only rate-limit refusals, not network failures or server errors.

Examples:
  kofra duplicate template template-copy --message "Template snapshot"
  kofra duplicate site_abc123 template-copy --idempotency-key copy-01 --json
  kofra duplicate template template-copy --dry-run`,
  async run(p, io, out) {
    const source = positional(p, 0, "source", this.usage);
    const newSlug = positional(p, 1, "new-slug", this.usage);
    if (!source.trim() || !newSlug.trim()) {
      throw new UsageError(`Exactly two nonempty targets are required. Usage: ${this.usage}`);
    }
    const explicitKey = str(p, "idempotency-key");
    if (explicitKey !== undefined && !/^[\x21-\x7e]{1,255}$/.test(explicitKey)) {
      throw new UsageError("--idempotency-key must be 1-255 printable ASCII characters without spaces.");
    }
    const message = str(p, "message");
    if (bool(p, "dry-run")) {
      io.stdout(`${JSON.stringify({ schemaVersion: 1, operation: "duplicate_site", source, newSlug, ...(message !== undefined ? { message } : {}) }, null, 2)}\n`);
      return EXIT.ok;
    }
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, requireKey(inst));
    // Generate once, outside the SDK's bounded rate-limit retry loop.
    const idempotencyKey = explicitKey ?? crypto.randomUUID();
    const result = await client.duplicateSite({ site: source, newSlug, ...(message !== undefined ? { message } : {}) }, { idempotencyKey });
    out.result(result, () => `${result.url}\nDuplicated into ${result.slug} (${plural(result.fileCount, "file")}, ${formatBytes(result.totalBytes)}).`);
    out.note("Only SPA mode is copied. Passwords/access gates and other settings are not copied; re-apply protection explicitly.");
    if (result.note) out.note(result.note);
    if (Array.isArray(result.warnings)) {
      for (const warning of result.warnings) {
        if (warning && typeof warning === "object" && typeof warning.message === "string") {
          out.note(`Warning (${warning.code}): ${warning.message}${typeof warning.fix === "string" ? ` ${warning.fix}` : ""}`);
        }
      }
    }
    return EXIT.ok;
  },
};

const operationsCmd: Command = {
  summary: "List API operations, or inspect one, without running anything",
  usage: "kofra operations [operationId] [--schema] [--json]",
  maxPositionals: 1,
  flags: { schema: { kind: "boolean" } },
  details: `Reads the instance's public operation catalog (GET /api/v1/operations): the
operation ids, methods, paths, required scopes and CLI paths. Nothing is
executed, so inspecting an advertised DELETE is safe. No API key is needed
and none is sent.

With an exact operation id, shows that one row instead of the list. Input
schemas are omitted by default; add --schema (with an id) to include the
row's unchanged inputSchema.

Examples:
  kofra operations --json
  kofra operations list_versions --json
  kofra operations create_site --schema --json`,
  async run(p, io, out) {
    const [id] = p.positionals;
    const withSchema = bool(p, "schema") === true;
    if (withSchema && id === undefined) throw new UsageError(`--schema needs an operation id. Usage: ${this.usage}`);
    const inst = await resolveInstance(p, io);
    // The catalog is public metadata: discover it without a credential.
    const client = makeClient(io, inst.api, null);
    const { data } = await client.get<unknown>("/operations");
    const rows = Array.isArray(data) ? data : (data as { operations?: unknown } | null)?.operations;
    if (!Array.isArray(rows) || !rows.every(isCatalogOperation)) {
      throw new CliError({
        code: "invalid_catalog",
        message: `The instance answered ${inst.api}/api/v1/operations with an unexpected shape.`,
        hint: "Is this a Kofra instance? Check --api / KOFRA_API (use the origin, without /api/v1).",
        exitCode: EXIT.error,
      });
    }
    if (id === undefined) {
      const operations = rows.map(stripInputSchema);
      out.result({ operations }, () => {
        if (!operations.length) return "No operations: the instance answered with an empty catalog.";
        return table(
          rows.map((r) => [r.id, r.method, r.path, r.scopes.join(" ") || "(none)", r.cli ? `kofra ${r.cli.command.join(" ")}` : "-"]),
          ["OPERATION", "METHOD", "PATH", "SCOPES", "CLI"],
        );
      });
      return EXIT.ok;
    }
    const found = rows.find((r) => r.id === id);
    if (!found) {
      throw new CliError({
        code: "operation_not_found",
        message: `No operation "${id}".`,
        hint: "List available operations with: kofra operations --json",
        exitCode: EXIT.notFound,
      });
    }
    out.result({ operation: withSchema ? found : stripInputSchema(found) }, () => operationDetail(found, withSchema));
    return EXIT.ok;
  },
};

const apiCmd: Command = {
  summary: "Call any REST endpoint (escape hatch)",
  usage: "kofra api <operationId | [METHOD] path> [--data <json> | --data @file.json | --data -]",
  maxPositionals: 2,
  flags: { data: { kind: "string", short: "d" } },
  details: `Paths are relative to /api/v1 (e.g. /me, /sites, /keys). Examples:
  kofra api /sites/my-site
  kofra api PATCH /sites/my-site --data '{"spa": true}'
  kofra api POST /keys --data '{"name":"ci","scopes":["sites:read","sites:write"]}'`,
  async run(p, io, out) {
    let [method, path] = p.positionals;
    const operationId = method && !path && /^[a-z][a-z0-9_]+$/.test(method) ? method : null;
    if (method && !path) {
      path = method;
      method = "GET";
    }
    if (!method || !path) throw new UsageError(`Usage: ${this.usage}`);
    method = method.toUpperCase();
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(method)) throw new UsageError(`Unknown method ${method}.`);
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, inst.key);
    let json: unknown;
    const d = str(p, "data");
    if (d !== undefined) {
      const text = d === "-" ? await io.readStdin() : d.startsWith("@") ? await readFile(resolve(io.cwd, d.slice(1)), "utf8") : d;
      try {
        json = JSON.parse(text);
      } catch {
        throw new UsageError("--data must be JSON.");
      }
    }
    if (operationId) {
      const catalog = await client.get<{ operations: { id: string; method: string; path: string }[] }>("/operations")
        .then((result) => result.data).catch(() => null);
      const operation = catalog?.operations?.find((entry) => entry.id === operationId);
      if (!operation) {
        // Preserve the original `api sites` shorthand for GET /sites.
        method = "GET";
        path = operationId;
      } else {
        if (json !== undefined && (!json || typeof json !== "object" || Array.isArray(json))) throw new UsageError("Operation --data must be a JSON object.");
        const args = { ...(json as Record<string, unknown> | undefined) };
        method = operation.method.toUpperCase();
        path = operation.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
          if (args[name] === undefined) throw new UsageError(`Operation ${operationId} requires ${name}.`);
          const value = encodeURIComponent(String(args[name]));
          delete args[name];
          return value;
        });
        if (method === "GET" || method === "HEAD") {
          const query = new URLSearchParams();
          for (const [key, value] of Object.entries(args)) if (value !== undefined) query.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
          if (query.size) path += `?${query}`;
          json = undefined;
        } else json = args;
      }
    }
    const { data } = await client.request(method, path, { json, retry: method === "GET" || method === "HEAD" ? "safe" : "rate-limit" });
    // The raw response, even without --json: this command is for scripts.
    io.stdout(`${JSON.stringify(data, null, 2)}\n`);
    return EXIT.ok;
  },
};

const COMMANDS: Record<string, Command> = {
  publish: publishCmd,
  duplicate: duplicateCmd,
  list: listCmd,
  site: siteCmd,
  rename: renameCmd,
  files: filesCmd,
  "read-file": readFileCmd,
  versions: versionsCmd,
  restore: restoreCmd,
  delete: deleteCmd,
  access: accessCmd,
  whoami: whoamiCmd,
  keys: keysCmd,
  login: loginCmd,
  logout: logoutCmd,
  setup: setupCmd,
  api: apiCmd,
  operations: operationsCmd,
};

const ALIASES: Record<string, string> = {
  deploy: "publish",
  ls: "list",
  sites: "list",
  info: "site",
  rollback: "restore",
  rm: "delete",
};

function mainHelp(): string {
  const rows = Object.entries(COMMANDS).map(([name, c]) => [`  ${name}`, c.summary]);
  return `kofra ${VERSION}: publish files, folders and sites to a live URL on a Kofra instance.

Usage: kofra <command> [options]

Commands:
${table(rows)}

Quick start:
  kofra login --api https://<your-instance>    # paste an API key once
  kofra publish ./dist                          # prints the live URL
  kofra publish ./dist --json                   # one JSON object for agents

${HELP_FOOTER}

Docs: https://github.com/TogetherWeOwn/dropway/tree/main/packages/cli`;
}

function commandHelp(name: string, c: Command): string {
  return `kofra ${name}: ${c.summary}

Usage: ${c.usage}
${c.details ? `\n${c.details}\n` : ""}
${HELP_FOOTER}`;
}

/** Run the CLI. Returns the exit code (never calls process.exit). */
export async function run(argv: string[], io: Io): Promise<number> {
  io = { ...io, env: withLegacyEnv(io.env) };
  const first = argv[0];
  if (!first || first === "help" || first === "--help" || first === "-h") {
    const topic = first === "help" ? argv[1] : undefined;
    const name = topic ? (ALIASES[topic] ?? topic) : undefined;
    const c = name ? COMMANDS[name] : undefined;
    io.stdout(`${c && name ? commandHelp(name, c) : mainHelp()}\n`);
    return EXIT.ok;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    io.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }
  const name = ALIASES[first] ?? first;
  const command = COMMANDS[name];
  const wantsJson = argv.includes("--json");
  const out = new Output(io, wantsJson, argv.includes("--quiet") || argv.includes("-q"));
  if (!command) {
    out.error(new CliError({ code: "unknown_command", message: `Unknown command "${first}".`, hint: "Run `kofra help` for the list of commands.", exitCode: EXIT.usage }));
    return EXIT.usage;
  }
  try {
    const p = parseArgs(argv.slice(1), { ...GLOBAL, ...command.flags });
    // Refuse surplus positionals here, before the command body runs: no
    // filesystem stat/read, instance/key resolution, network call, stdin
    // read, prompt or write may precede this check.
    if (p.positionals.length > command.maxPositionals) throw new UsageError(`Too many arguments. Usage: ${command.usage}`);
    if (bool(p, "help")) {
      io.stdout(`${commandHelp(name, command)}\n`);
      return EXIT.ok;
    }
    return await command.run(p, io, new Output(io, bool(p, "json") === true, bool(p, "quiet") === true));
  } catch (e) {
    const err =
      e instanceof CliError
        ? e
        : e instanceof UsageError
          ? new CliError({ code: "usage", message: e.message, hint: `Run \`kofra ${name} --help\`.`, exitCode: EXIT.usage })
          : new CliError({ code: "unexpected_error", message: (e as Error)?.message ?? String(e), exitCode: EXIT.error });
    out.error(err);
    return err.exitCode;
  }
}

/** Io bound to the real process. */
export function nodeIo(): Io {
  return {
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    stdinIsTTY: !!process.stdin.isTTY,
    stderrIsTTY: !!process.stderr.isTTY,
    env: process.env,
    cwd: process.cwd(),
    readStdin() {
      if (process.stdin.isTTY) return Promise.resolve("");
      // Some agent shells leave stdin open without ever writing to it: give up if nothing
      // arrives within 5 s, instead of hanging (the caller then explains what to pass).
      return new Promise((resolveRead) => {
        const chunks: Buffer[] = [];
        const done = () => {
          clearTimeout(timer);
          process.stdin.off("data", onData).off("end", done).off("error", done);
          process.stdin.pause();
          resolveRead(Buffer.concat(chunks).toString("utf8"));
        };
        const onData = (c: Buffer) => {
          chunks.push(c);
          clearTimeout(timer);
        };
        const timer = setTimeout(done, 5000);
        process.stdin.on("data", onData).once("end", done).once("error", done);
      });
    },
    prompt(question, opts = {}) {
      return new Promise((resolvePrompt) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
        if (opts.hidden) {
          // Echo the question but not the typed characters.
          (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
            if (s.includes(question)) process.stderr.write(question);
          };
        }
        rl.question(question, (answer) => {
          rl.close();
          if (opts.hidden) process.stderr.write("\n");
          resolvePrompt(answer);
        });
      });
    },
  };
}
