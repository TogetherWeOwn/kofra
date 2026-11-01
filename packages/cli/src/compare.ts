/** Directory inspection over the collector and two authorized metadata reads; never downloads bytes. */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { compareManifests, type CompareFile } from "../../core/src/services/compare.ts";
import { CliError, EXIT, type DropwayClient } from "./client.ts";
import { linkPath } from "./config.ts";
import { collectFiles } from "./files.ts";
import { escapeControl as text, formatBytes, plural } from "./output.ts";
import type { VersionInfo } from "./publish.ts";

const enc = encodeURIComponent;

export interface CompareOptions {
  path: string;
  cwd: string;
  site: string;
  requestedRef: string;
  limit: number;
  maxFiles: number;
  maxBytes: number;
  includeUnchanged: boolean;
  signal: AbortSignal;
}

export function compareCancelled(): CliError {
  return new CliError({ code: "compare_cancelled", message: "Comparison cancelled; no complete result is available.",
    hint: "Re-run to get a complete comparison.", exitCode: EXIT.usage });
}

/**
 * Yield to the event loop so a SIGINT handler queued behind a synchronous
 * stretch still runs before stdout is written. Checked on both sides of the
 * yield: aborting anywhere in this window must cancel, never print success.
 */
export async function settleBeforeOutput(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise((resolve) => setImmediate(resolve));
  signal.throwIfAborted();
}

interface DirectVersion {
  site: string;
  version: VersionInfo;
  missing: string[];
}

/**
 * Read one version straight from the server ("live", "v3", "3" or an id),
 * mirroring getVersionDirect in main.ts without the import cycle. Dot-only
 * refs are refused locally: URL normalization would otherwise collapse them
 * onto a different endpoint.
 */
async function getVersionDirect(client: DropwayClient, slug: string, ref: string, signal: AbortSignal): Promise<DirectVersion> {
  if (ref === "" || ref === "." || ref === "..") {
    throw new CliError({
      code: "invalid_version_ref",
      message: `Invalid version ${JSON.stringify(ref)}.`,
      hint: `Use "live", "v3", "3" or a version id (see: kofra versions ${slug}).`,
      exitCode: EXIT.usage,
    });
  }
  const { data } = await client.get<DirectVersion>(`/sites/${enc(slug)}/versions/${enc(ref)}`, { redirect: "error", signal });
  return data;
}

function invalidResponse(message: string): CliError {
  return new CliError({ code: "invalid_compare_response", message,
    hint: "Retry against an instance that returns complete version metadata.", exitCode: EXIT.error });
}

export async function compareDirectory(client: DropwayClient, opts: CompareOptions) {
  const root = resolve(opts.cwd, opts.path);
  const st = await stat(root).catch(() => null);
  opts.signal.throwIfAborted();
  if (!st) throw new CliError({ code: "path_not_found", message: `No such directory: ${opts.path}`,
    hint: "Choose an existing directory to compare.", exitCode: EXIT.usage });
  if (!st.isDirectory()) {
    const zip = /\.zip$/i.test(root);
    throw new CliError({ code: zip ? "compare_zip_unsupported" : "compare_directory_only",
      message: zip ? "ZIP comparison is not supported." : "Compare accepts directories only.",
      hint: zip ? "Extract locally and compare the folder." : "Point at the containing directory (v1 compares directories only).", exitCode: EXIT.usage });
  }

  const base = `/sites/${enc(opts.site)}`;
  // Metadata reads must come from the configured origin: a redirect (moved
  // instance, http downgrade) is refused, never followed.
  const readOpts = { redirect: "error" as const, signal: opts.signal };
  let pinnedId: string;
  let selected: VersionInfo | undefined;
  if (opts.requestedRef === "live") {
    const { data } = await client.get<{ currentVersionId: string | null; versions: VersionInfo[] }>(`${base}/versions?limit=500`, readOpts);
    opts.signal.throwIfAborted();
    if (!data.currentVersionId) throw new CliError({ code: "no_live_version", message: `${opts.site} has no live version.`,
      hint: "Publish first, or pass an explicit --version.", exitCode: EXIT.notFound });
    pinnedId = data.currentVersionId;
    // A restored live version can lie outside the newest-500 list. Its immutable
    // manifest (the second read) supplies the number and remaining metadata.
    selected = data.versions.find(v => v.id === pinnedId);
  } else {
    const direct = await getVersionDirect(client, opts.site, opts.requestedRef, opts.signal);
    opts.signal.throwIfAborted();
    selected = direct.version;
    pinnedId = selected.id;
  }
  const resolvedAt = new Date().toISOString();
  const requireReady = (version: VersionInfo) => {
    if (version.status !== "ready") throw new CliError({ code: "version_not_ready", message: `Version ${version.id} is not ready.`,
      hint: "Wait for the publish to finalize, then re-run.", exitCode: EXIT.notFound });
  };
  if (selected) requireReady(selected);
  const { data } = await client.get<{ version: VersionInfo; files: CompareFile[] }>(`${base}/files?version=${enc(pinnedId)}`, readOpts);
  opts.signal.throwIfAborted();
  if (!data || !data.version || data.version.id !== pinnedId) throw new CliError({ code: "version_not_found", message: "The manifest does not match the pinned version.",
    hint: `Inspect versions with: kofra versions ${opts.site}`, exitCode: EXIT.notFound });
  requireReady(data.version);
  // A torn or trimmed manifest must never compare as complete: the immutable
  // version's row count is known, so refuse when the listing disagrees.
  if (!Array.isArray(data.files)) throw invalidResponse("The manifest did not list its files.");
  if (typeof data.version.fileCount === "number" && data.files.length !== data.version.fileCount) {
    throw invalidResponse(`The manifest listed ${data.files.length} files but the pinned version has ${data.version.fileCount}.`);
  }
  for (const row of data.files) {
    if (!row || typeof row !== "object" || typeof (row as CompareFile).path !== "string") throw invalidResponse("The manifest listed a file without a path.");
  }

  let local;
  try {
    local = await collectFiles(root, { exclude: [linkPath(opts.cwd)], maxFiles: opts.maxFiles, maxBytes: opts.maxBytes,
      verifyUnchanged: true, signal: opts.signal });
  } catch (error) {
    if (opts.signal.aborted) throw compareCancelled();
    if (error instanceof CliError && ["source_changed", "collection_cap_exceeded"].includes(error.code)) {
      throw new CliError({ code: error.code === "source_changed" ? "compare_source_changed" : "compare_cap_exceeded",
        message: error.message, hint: error.hint, exitCode: EXIT.usage });
    }
    throw error;
  }
  opts.signal.throwIfAborted();
  return { schemaVersion: 1, command: "compare", api: client.api, site: opts.site,
    local: { root: local.root, kind: local.kind },
    pinned: { versionId: pinnedId, number: data.version.number, requestedRef: opts.requestedRef, resolvedAt,
      fileCount: data.version.fileCount, totalBytes: data.version.totalBytes },
    ...compareManifests(local.files, data.files, opts), ignored: local.ignored, skippedLinks: local.skippedLinks, secretsFound: local.secrets.length };
}

/** Human rendering escapes through `text`; JSON retains exact paths. */
export function compareHuman(result: Awaited<ReturnType<typeof compareDirectory>>): string {
  const { counts: c, bytes: b, pinned: p } = result;
  const lines = [
    `Compared ${text(result.local.root)} against ${text(result.site)} v${p.number} (pinned ${text(p.versionId)}, ${p.requestedRef === "live" ? "live at resolve time" : `requested ${text(p.requestedRef)}`}).`,
    `  changed     ${plural(c.changed, "file")} (local ${formatBytes(b.changedLocal)}, remote ${formatBytes(b.changedRemote)})`,
    `  local_only  ${plural(c.localOnly, "file")} (${formatBytes(b.localOnly)})`,
    `  remote_only ${plural(c.remoteOnly, "file")} (${formatBytes(b.remoteOnly)})`,
    `  unchanged   ${plural(c.unchanged, "file")} (${formatBytes(b.unchanged)})`,
  ];
  for (const r of result.records) {
    const path = text(r.path);
    if (r.class === "changed") lines.push(`  ~ ${path} (${r.localSize === null ? "?" : formatBytes(r.localSize)} -> ${r.remoteSize === null ? "?" : formatBytes(r.remoteSize)})${r.reason ? ` (${r.reason})` : ""}`);
    else lines.push(`  ${{ local_only: "+", remote_only: "-", unchanged: "=" }[r.class]} ${path} (${formatBytes(r.size)}${r.class === "remote_only" ? ", remote only" : ""})`);
  }
  if (result.truncated) lines.push(`Records truncated to ${result.records.length}; counts and byte totals cover the full comparison.`);
  lines.push("remote_only paths are not deleted by publishing; publish replaces the version, it does not mirror deletions.");
  if (result.ignored.length) lines.push(`Ignored: ${result.ignored.map(text).join(", ")}.`);
  if (result.skippedLinks.length) lines.push(`Skipped symlinked folders: ${result.skippedLinks.map(text).join(", ")}.`);
  if (result.secretsFound) lines.push(`secretsFound: ${result.secretsFound}. Review the directory before any future publish.`);
  for (const warning of result.warnings) lines.push(`Warning (${warning.code}): ${warning.path ? `${text(warning.path)}: ` : ""}${warning.message}`);
  return lines.join("\n");
}
