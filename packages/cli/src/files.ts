/**
 * Local files -> SourceFile[]: walk a directory (or take one file), apply
 * ignore rules, hash with SHA-256 (streaming for big files), and scan text for
 * credentials. Node only.
 */
import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { CliError, EXIT } from "./client.ts";
import { IgnoreMatcher } from "./ignore.ts";
import type { SourceFile } from "./publish.ts";
import { findSecrets, looksTextual, type SecretFinding } from "./secrets.ts";

/** Files up to this size are read once (hash + secret scan from memory); bigger ones are streamed. */
const IN_MEMORY_MAX = 4 * 1024 * 1024;

export interface CollectOptions {
  /** Absolute paths that must never be published (e.g. the dropway.json link file). */
  exclude?: string[];
  /** Skip the credential scan. */
  allowSecrets?: boolean;
  /** Parallel hashing. Default 16. */
  concurrency?: number;
  /** Refuse an oversized eligible set before reading any file content. */
  maxFiles?: number;
  maxBytes?: number;
  /** Refuse files whose size or mtime changes between enumeration and hashing. */
  verifyUnchanged?: boolean;
  signal?: AbortSignal;
}

/** Why one relative path was left out of the publish payload. Stable wire values. */
export type OmissionReason = "ignored" | "excluded" | "symlink_directory" | "broken_symlink" | "special_file";

export interface Omission {
  /** Relative POSIX path as walked (directories carry a trailing slash). */
  path: string;
  reason: OmissionReason;
}

export interface Collected {
  /** "dir" or "file". */
  kind: "dir" | "file";
  root: string;
  files: SourceFile[];
  totalBytes: number;
  ignored: string[];
  secrets: SecretFinding[];
  /** Symlinked directories that were skipped. */
  skippedLinks: string[];
  /** Every omitted path with its reason, sorted by path. Directories carry a trailing slash. */
  omissions: Omission[];
}

interface Entry {
  abs: string;
  rel: string;
  snapshot?: { size: number; mtimeMs: number };
}

const toPosix = (p: string) => p.split(sep).join("/");

async function walk(root: string, matcher: IgnoreMatcher, exclude: Set<string>, out: Entry[], ignored: string[], links: string[], omissions: Omission[], signal?: AbortSignal, relDir = "", verify = false) {
  signal?.throwIfAborted();
  const dirents = await readdir(join(root, relDir), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (verify && relDir && error.code === "ENOENT") sourceChanged(relDir);
    throw error;
  });
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of dirents) {
    signal?.throwIfAborted();
    const rel = relDir ? `${relDir}/${d.name}` : d.name;
    const abs = join(root, rel);
    if (exclude.has(abs)) {
      omissions.push({ path: rel, reason: "excluded" });
      continue;
    }
    let isDir = d.isDirectory();
    let isFile = d.isFile();
    if (d.isSymbolicLink()) {
      const s = await stat(abs).catch(() => null);
      if (!s) {
        omissions.push({ path: rel, reason: "broken_symlink" });
        continue;
      }
      if (s.isDirectory()) {
        // Following directory links can loop or escape the folder being published.
        links.push(rel);
        omissions.push({ path: rel, reason: "symlink_directory" });
        continue;
      }
      isFile = s.isFile();
      isDir = false;
    }
    if (matcher.ignores(rel, isDir)) {
      const shown = isDir ? `${rel}/` : rel;
      ignored.push(shown);
      omissions.push({ path: shown, reason: "ignored" });
      continue;
    }
    if (isDir) await walk(root, matcher, exclude, out, ignored, links, omissions, signal, rel, verify);
    else if (isFile) out.push({ abs, rel });
    else omissions.push({ path: rel, reason: "special_file" }); // FIFO, socket or device (or a link to one)
  }
}

function sourceChanged(path: string): never {
  throw new CliError({ code: "source_changed", message: `Local file changed while collecting: ${path}`,
    hint: "Re-run when the tree is quiet.", exitCode: EXIT.usage });
}

const missingAsChanged = (e: Entry, opts: CollectOptions) => (error: NodeJS.ErrnoException): never => {
  if (opts.verifyUnchanged && error.code === "ENOENT") sourceChanged(e.rel);
  throw error;
};

const statEntry = (e: Entry, opts: CollectOptions) => stat(e.abs).catch(missingAsChanged(e, opts));

async function hashFile(e: Entry, opts: CollectOptions, secrets: SecretFinding[]): Promise<SourceFile> {
  opts.signal?.throwIfAborted();
  const s = await statEntry(e, opts);
  const size = s.size;
  if (e.snapshot && (size !== e.snapshot.size || s.mtimeMs !== e.snapshot.mtimeMs)) sourceChanged(e.rel);
  let sha256: string;
  if (size <= IN_MEMORY_MAX) {
    const bytes = new Uint8Array(await readFile(e.abs, { signal: opts.signal }).catch(missingAsChanged(e, opts)));
    opts.signal?.throwIfAborted();
    sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!opts.allowSecrets && looksTextual(bytes)) secrets.push(...findSecrets(e.rel, new TextDecoder("latin1").decode(bytes)));
  } else {
    const h = createHash("sha256");
    try {
      for await (const chunk of createReadStream(e.abs, { signal: opts.signal })) {
        opts.signal?.throwIfAborted();
        h.update(chunk as Buffer);
      }
    } catch (error) {
      missingAsChanged(e, opts)(error as NodeJS.ErrnoException);
    }
    sha256 = h.digest("hex");
  }
  opts.signal?.throwIfAborted();
  if (opts.verifyUnchanged) {
    const after = await statEntry(e, opts);
    if (after.size !== size || after.mtimeMs !== s.mtimeMs) sourceChanged(e.rel);
  }
  return {
    path: e.rel,
    size,
    sha256,
    // openAsBlob streams from disk (Node 19.8+) and gives fetch an exact Content-Length.
    body: async () => (typeof openAsBlob === "function" ? await openAsBlob(e.abs) : new Uint8Array(await readFile(e.abs))),
  };
}

/** Collect the files to publish from a directory or a single file. */
export async function collectFiles(path: string, opts: CollectOptions = {}): Promise<Collected> {
  const root = resolve(path);
  const st = await stat(root).catch(() => null);
  if (!st) throw new CliError({ code: "path_not_found", message: `No such file or directory: ${path}`, exitCode: EXIT.usage });
  const exclude = new Set((opts.exclude ?? []).map((p) => resolve(p)));
  const ignored: string[] = [];
  const links: string[] = [];
  const omissions: Omission[] = [];
  let entries: Entry[] = [];
  let kind: Collected["kind"];

  if (st.isDirectory()) {
    kind = "dir";
    const ignoreFile = await readFile(join(root, ".dropwayignore"), "utf8").catch(() => "");
    const matcher = new IgnoreMatcher(ignoreFile.split("\n"));
    await walk(root, matcher, exclude, entries, ignored, links, omissions, opts.signal, "", opts.verifyUnchanged);
  } else if (st.isFile()) {
    kind = "file";
    const name = basename(root);
    if (new IgnoreMatcher([]).ignores(name)) {
      throw new CliError({
        code: "ignored_file",
        message: `Refusing to publish ${name}: files like it (credentials, VCS and OS metadata) are never published.`,
        hint: "Rename the file if it is safe to make public.",
        exitCode: EXIT.usage,
      });
    }
    entries = [{ abs: root, rel: name }];
  } else {
    throw new CliError({ code: "path_not_supported", message: `${path} is not a regular file or directory.`, exitCode: EXIT.usage });
  }

  if (opts.maxFiles !== undefined && entries.length > opts.maxFiles) {
    throw new CliError({ code: "collection_cap_exceeded", message: `Eligible file count ${entries.length} exceeds --max-files ${opts.maxFiles}.`,
      hint: "Raise --max-files or narrow the directory.", exitCode: EXIT.usage });
  }
  if (opts.maxBytes !== undefined || opts.verifyUnchanged) {
    let bytes = 0;
    for (const entry of entries) {
      opts.signal?.throwIfAborted();
      const s = await statEntry(entry, opts);
      entry.snapshot = { size: s.size, mtimeMs: s.mtimeMs };
      bytes += s.size;
    }
    if (opts.maxBytes !== undefined && bytes > opts.maxBytes) {
      throw new CliError({ code: "collection_cap_exceeded", message: `Eligible bytes ${bytes} exceeds --max-bytes ${opts.maxBytes}.`,
        hint: "Raise --max-bytes or narrow the directory.", exitCode: EXIT.usage });
    }
  }

  const secrets: SecretFinding[] = [];
  const files: SourceFile[] = new Array(entries.length);
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    try {
      for (let i = next++; i < entries.length && failure === undefined; i = next++) files[i] = await hashFile(entries[i]!, opts, secrets);
    } catch (error) {
      failure ??= error;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 16, entries.length)) }, worker));
  opts.signal?.throwIfAborted();
  if (failure !== undefined) throw failure;
  secrets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));

  omissions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    kind,
    root,
    files: files.map((f) => ({ ...f, path: toPosix(f.path) })),
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    ignored,
    secrets,
    skippedLinks: links,
    omissions,
  };
}
