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
import { formatBytes, plural, shortTime, table } from "./output.ts";
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

function requireKey(inst: Instance, what = "This command"): string {
  if (inst.key) return inst.key;
  throw new CliError({
    code: "not_logged_in",
    message: `${what} needs an API key for ${inst.api}.`,
    hint: "Run `kofra login`, set KOFRA_API_KEY, or pass --key. (To publish without a key, use --anonymous if the instance allows it.)",
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

/** "v3", "3" or a version id -> the version. Omitted -> the version before the live one (rollback). */
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

const versionLabel = (v: VersionInfo | null | undefined) => (v ? `v${v.number}` : "-");

// ---------------------------------------------------------------- commands

const publishCmd: Command = {
  summary: "Publish a folder, a file or a .zip to a live URL",
  usage: "kofra publish <path> [--site <name>] [--json]",
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
running the same command again updates that site.`,
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
      result = await publishZip(client, bytes, { site, ...settings });
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
      if (dryRun) {
        out.result(
          { dryRun: true, path: target, files: collected.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })), totalBytes: collected.totalBytes, ignored: collected.ignored },
          () =>
            [
              ...collected.files.map((f) => `${f.path}  ${formatBytes(f.size)}`),
              `Would publish ${plural(collected.files.length, "file")} (${formatBytes(collected.totalBytes)}).${collected.ignored.length ? ` Ignored: ${collected.ignored.join(", ")}` : ""}`,
            ].join("\n"),
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

const filesCmd: Command = {
  summary: "List the files of a site's live (or given) version",
  usage: "kofra files <name> [--version <v>]",
  flags: { version: { kind: "string" } },
  async run(p, io, out) {
    const slug = positional(p, 0, "name", this.usage);
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, requireKey(inst));
    const ref = str(p, "version");
    const versionId = ref ? (await resolveVersion(client, slug, ref)).id : null;
    const { data } = await client.get<{ version: VersionInfo | null; files: Array<{ path: string; size: number; contentType: string; url: string; rawUrl: string }> }>(
      `/sites/${enc(slug)}/files${versionId ? `?version=${enc(versionId)}` : ""}`,
    );
    out.result({ version: data.version, files: data.files }, () =>
      data.files.length ? table(data.files.map((f) => [f.path, formatBytes(f.size), f.contentType, f.url]), ["PATH", "SIZE", "TYPE", "URL"]) : "No files.",
    );
    return EXIT.ok;
  },
};

const versionsCmd: Command = {
  summary: "List a site's versions",
  usage: "kofra versions <name>",
  flags: {},
  async run(p, io, out) {
    const slug = positional(p, 0, "name", this.usage);
    const inst = await resolveInstance(p, io);
    const client = makeClient(io, inst.api, requireKey(inst));
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
  },
};

const restoreCmd: Command = {
  summary: "Make an older version live again (default: the one before the live version)",
  usage: "kofra restore <name> [v<N> | <N> | <versionId>]",
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

const whoamiCmd: Command = {
  summary: "Show the instance and the identity of your key",
  usage: "kofra whoami",
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

const operationsCmd: Command = {
  summary: "List API operations, or inspect one, without running anything",
  usage: "kofra operations [operationId] [--schema] [--json]",
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
    const [id, extra] = p.positionals;
    if (extra !== undefined) throw new UsageError(`Too many arguments. Usage: ${this.usage}`);
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
  list: listCmd,
  site: siteCmd,
  files: filesCmd,
  versions: versionsCmd,
  restore: restoreCmd,
  delete: deleteCmd,
  whoami: whoamiCmd,
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
