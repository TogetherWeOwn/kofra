/** Directory inspection over the collector and two authorized metadata reads; never downloads bytes. */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { compareManifests, type CompareFile } from "../../core/src/services/compare.ts";
import { CliError, EXIT, type DropwayClient } from "./client.ts";
import { linkPath } from "./config.ts";
import { collectFiles } from "./files.ts";
import { formatBytes, plural } from "./output.ts";
import type { VersionInfo } from "./publish.ts";

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

  const base = `/sites/${encodeURIComponent(opts.site)}`;
  let pinnedId: string;
  let selected: VersionInfo | undefined;
  if (opts.requestedRef === "live") {
    const { data } = await client.get<{ currentVersionId: string | null; versions: VersionInfo[] }>(`${base}/versions?limit=500`);
    opts.signal.throwIfAborted();
    if (!data.currentVersionId) throw new CliError({ code: "no_live_version", message: `${opts.site} has no live version.`,
      hint: "Publish first, or pass an explicit --version.", exitCode: EXIT.notFound });
    pinnedId = data.currentVersionId;
    // A restored live version can lie outside the newest-500 list. Its immutable
    // manifest (the second read) supplies the number and remaining metadata.
    selected = data.versions.find(v => v.id === pinnedId);
  } else {
    if (["", ".", ".."].includes(opts.requestedRef)) throw new CliError({ code: "invalid_version_ref", message: "Invalid version reference.",
      hint: `Use live, v3, 3 or a version id; see: kofra versions ${opts.site}`, exitCode: EXIT.usage });
    const { data } = await client.get<{ version: VersionInfo }>(`${base}/versions/${encodeURIComponent(opts.requestedRef)}`);
    opts.signal.throwIfAborted();
    selected = data.version;
    pinnedId = selected.id;
  }
  const resolvedAt = new Date().toISOString();
  const requireReady = (version: VersionInfo) => {
    if (version.status !== "ready") throw new CliError({ code: "version_not_ready", message: `Version ${version.id} is not ready.`,
      hint: "Wait for the publish to finalize, then re-run.", exitCode: EXIT.notFound });
  };
  if (selected) requireReady(selected);
  const { data } = await client.get<{ version: VersionInfo; files: CompareFile[] }>(`${base}/files?version=${encodeURIComponent(pinnedId)}`);
  opts.signal.throwIfAborted();
  if (data.version.id !== pinnedId) throw new CliError({ code: "version_not_found", message: "The manifest does not match the pinned version.",
    hint: `Inspect versions with: kofra versions ${opts.site}`, exitCode: EXIT.notFound });
  requireReady(data.version);

  let local;
  try {
    local = await collectFiles(root, { exclude: [linkPath(opts.cwd)], maxFiles: opts.maxFiles, maxBytes: opts.maxBytes,
      verifyUnchanged: true, signal: opts.signal });
  } catch (error) {
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

/** Keep untrusted filenames/refs on one inert terminal line. JSON retains exact paths. */
const text = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

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
