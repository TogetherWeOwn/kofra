/**
 * Local files -> SourceFile[]: walk a directory (or take one file), apply
 * ignore rules, hash with SHA-256 (streaming for big files), and scan text for
 * credentials. Node only.
 */
import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
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
  /** Abort collection (the future `diff` cancels here; publish never passes one). */
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
}

const toPosix = (p: string) => p.split(sep).join("/");

const utf8Names = new TextDecoder("utf-8", { fatal: true });

function sourceChanged(path: string): never {
  throw new CliError({
    code: "source_changed",
    message: `Local file changed while collecting: ${path}`,
    hint: "Re-run when the tree is quiet.",
    exitCode: EXIT.usage,
  });
}

function invalidFilename(dirRel: string, raw: Buffer): never {
  throw new CliError({
    code: "invalid_filename",
    message: `File name is not valid UTF-8 in ${dirRel || "."}: 0x${raw.toString("hex")}`,
    hint: "Rename the file to valid UTF-8.",
    exitCode: EXIT.usage,
  });
}

async function walk(
  root: string,
  matcher: IgnoreMatcher,
  exclude: Set<string>,
  out: Entry[],
  ignored: string[],
  links: string[],
  omissions: Omission[],
  seen: Set<string>,
  signal?: AbortSignal,
  relDir = "",
) {
  signal?.throwIfAborted();
  let dirents;
  try {
    dirents = await readdir(join(root, relDir), { withFileTypes: true, encoding: "buffer" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && relDir) sourceChanged(relDir);
    throw error;
  }
  // Decode raw bytes strictly: a non-UTF-8 name must fail instead of
  // collapsing to U+FFFD and overwriting a real U+FFFD name in a Map.
  const names: Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }> = [];
  for (const d of dirents) {
    signal?.throwIfAborted();
    const raw = d.name as unknown as Buffer;
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as unknown as string);
    let name: string;
    try {
      name = utf8Names.decode(buf);
    } catch {
      invalidFilename(relDir, buf);
    }
    names.push({ name: name!, isDirectory: d.isDirectory(), isFile: d.isFile(), isSymlink: d.isSymbolicLink() });
  }
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of names) {
    signal?.throwIfAborted();
    const rel = relDir ? `${relDir}/${d.name}` : d.name;
    if (seen.has(rel)) {
      throw new CliError({
        code: "duplicate_path",
        message: `Duplicate file path after decoding: ${rel}`,
        hint: "Rename one of the files so decoded paths are unique.",
        exitCode: EXIT.usage,
      });
    }
    seen.add(rel);
    const abs = join(root, rel);
    if (exclude.has(abs)) {
      omissions.push({ path: rel, reason: "excluded" });
      continue;
    }
    let isDir = d.isDirectory;
    let isFile = d.isFile;
    if (d.isSymlink) {
      let s;
      try {
        s = await stat(abs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          // A link whose target is gone is broken; a link that itself vanished
          // raced with the walk and must surface as a change, not a stale skip.
          const gone = await lstat(abs).then(() => false, (e: NodeJS.ErrnoException) => e?.code === "ENOENT");
          if (gone) sourceChanged(rel);
          omissions.push({ path: rel, reason: "broken_symlink" });
          continue;
        }
        throw error;
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
    if (isDir) await walk(root, matcher, exclude, out, ignored, links, omissions, seen, signal, rel);
    else if (isFile) out.push({ abs, rel });
    else omissions.push({ path: rel, reason: "special_file" }); // FIFO, socket or device (or a link to one)
  }
}

const asErrno = (error: unknown): NodeJS.ErrnoException | null =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException)
    : null;

async function hashFile(
  e: Entry,
  opts: { allowSecrets?: boolean; signal?: AbortSignal },
  secrets: SecretFinding[],
): Promise<SourceFile> {
  opts.signal?.throwIfAborted();
  let s;
  try {
    s = await stat(e.abs);
  } catch (error) {
    if (asErrno(error)?.code === "ENOENT") sourceChanged(e.rel);
    throw error;
  }
  const size = s.size;
  let sha256: string;
  if (size <= IN_MEMORY_MAX) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(e.abs, { signal: opts.signal }));
    } catch (error) {
      if (asErrno(error)?.code === "ENOENT") sourceChanged(e.rel);
      throw error;
    }
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
      if (asErrno(error)?.code === "ENOENT") sourceChanged(e.rel);
      throw error;
    }
    sha256 = h.digest("hex");
  }
  opts.signal?.throwIfAborted();
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
    await walk(root, matcher, exclude, entries, ignored, links, omissions, new Set(), opts.signal);
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

  const secrets: SecretFinding[] = [];
  const files: SourceFile[] = new Array(entries.length);
  // Fail fast: the first worker error aborts the shared signal so stalled
  // siblings settle instead of holding Promise.all open, and no new entries
  // are scheduled after the failure.
  const internal = new AbortController();
  const onExternalAbort = () => {
    if (!internal.signal.aborted) internal.abort();
  };
  opts.signal?.throwIfAborted();
  opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    try {
      for (;;) {
        if (failure !== undefined || internal.signal.aborted) return;
        const i = next++;
        if (i >= entries.length) return;
        files[i] = await hashFile(entries[i]!, { allowSecrets: opts.allowSecrets, signal: internal.signal }, secrets);
      }
    } catch (error) {
      failure ??= error;
      if (!internal.signal.aborted) internal.abort();
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 16, entries.length)) }, worker),
    );
  } finally {
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
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
