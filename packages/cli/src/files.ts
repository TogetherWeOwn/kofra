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
  /** Refuse an oversized eligible set before reading any file content (compare only). */
  maxFiles?: number;
  maxBytes?: number;
  /** Refuse files whose size or mtime changes between enumeration and hashing (compare only). */
  verifyUnchanged?: boolean;
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

// ignoreBOM: EF BB BF is a legal POSIX filename prefix (U+FEFF), not a marker to strip.
const utf8Names = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * stat/lstat take no signal, so race them against abort: a stalled metadata
 * read must not hold fail-fast (or external cancel) open. Promise.race keeps
 * handlers on the underlying promise, so its later settlement is observed.
 */
async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal || signal.aborted) {
    signal?.throwIfAborted();
    return promise;
  }
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

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
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") sourceChanged(relDir || ".");
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
        s = await abortable(stat(abs), signal);
      } catch (error) {
        // Cancellation must propagate, not become a stale skip.
        signal?.throwIfAborted();
        // A link that itself vanished raced with the walk and must surface
        // as a change, not a stale skip.
        const gone = await abortable(lstat(abs), signal).then(
          () => false,
          (e: NodeJS.ErrnoException) => e?.code === "ENOENT",
        );
        if (gone) sourceChanged(rel);
        // Only an unresolvable target — gone (ENOENT), looping (ELOOP), or
        // through a non-directory (ENOTDIR) — is a broken link. Transient
        // filesystem failures (EIO, EMFILE, EACCES, ...) must fail loudly
        // instead of silently omitting the file from the published version.
        const code = asErrno(error)?.code;
        if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") {
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
  opts: { allowSecrets?: boolean; signal?: AbortSignal; verifyUnchanged?: boolean },
  secrets: SecretFinding[],
): Promise<SourceFile> {
  opts.signal?.throwIfAborted();
  let s;
  try {
    s = await abortable(stat(e.abs), opts.signal);
  } catch (error) {
    if (asErrno(error)?.code === "ENOENT") sourceChanged(e.rel);
    throw error;
  }
  const size = s.size;
  // A file rewritten between the snapshot pass and this stat hashes neither
  // the old nor the new bytes: refuse instead of reporting a mixed hash.
  if (opts.verifyUnchanged && e.snapshot && (size !== e.snapshot.size || s.mtimeMs !== e.snapshot.mtimeMs)) sourceChanged(e.rel);
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
  // ...nor one rewritten while its bytes were being read.
  if (opts.verifyUnchanged) {
    let after;
    try {
      after = await abortable(stat(e.abs), opts.signal);
    } catch (error) {
      if (asErrno(error)?.code === "ENOENT") sourceChanged(e.rel);
      throw error;
    }
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
  // An already-aborted call must report cancellation, not block on root
  // reads or fall through to path_not_found.
  opts.signal?.throwIfAborted();
  const root = resolve(path);
  const st = await abortable(
    stat(root).catch(() => null),
    opts.signal,
  );
  if (!st) throw new CliError({ code: "path_not_found", message: `No such file or directory: ${path}`, exitCode: EXIT.usage });
  const exclude = new Set((opts.exclude ?? []).map((p) => resolve(p)));
  const ignored: string[] = [];
  const links: string[] = [];
  const omissions: Omission[] = [];
  let entries: Entry[] = [];
  let kind: Collected["kind"];

  if (st.isDirectory()) {
    kind = "dir";
    const ignoreFile = await readFile(join(root, ".dropwayignore"), { encoding: "utf8", signal: opts.signal }).catch(() => {
      // A missing ignore file is fine, but cancellation must propagate.
      opts.signal?.throwIfAborted();
      return "";
    });
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

  // Compare-only bounds, checked from stat sizes before any file content is
  // read, so a refusal never claims a full comparison from a partial walk.
  if (opts.maxFiles !== undefined && entries.length > opts.maxFiles) {
    throw new CliError({ code: "collection_cap_exceeded", message: `Eligible file count ${entries.length} exceeds --max-files ${opts.maxFiles}.`,
      hint: "Raise --max-files or narrow the directory.", exitCode: EXIT.usage });
  }
  if (opts.maxBytes !== undefined || opts.verifyUnchanged) {
    let bytes = 0;
    for (const entry of entries) {
      opts.signal?.throwIfAborted();
      let s;
      try {
        s = await abortable(stat(entry.abs), opts.signal);
      } catch (error) {
        // Cancellation must propagate, not become a stale refusal.
        opts.signal?.throwIfAborted();
        if (opts.verifyUnchanged && asErrno(error)?.code === "ENOENT") sourceChanged(entry.rel);
        throw error;
      }
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
        files[i] = await hashFile(entries[i]!, { allowSecrets: opts.allowSecrets, signal: internal.signal, verifyUnchanged: opts.verifyUnchanged }, secrets);
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

const MAX_SITE_PATH = 1024;

/**
 * Validate the site path of piped bytes before any stdin read or network call.
 * Mirrors the server's `normaliseFilePath` and its `__dropway/` reservation
 * (packages/core/src/lib/paths.ts, services/deploys.ts); the CLI cannot import
 * @dropway/core, so keep the two in sync. Returns the normalised path.
 */
export function normaliseStdinPath(input: string): string {
  const segments = input.replace(/\\/g, "/").trim().replace(/^(?:\.\/)+/, "").replace(/^\/+/, "").split("/").filter((s) => s !== "" && s !== ".");
  const bad = (message: string, hint?: string) => new CliError({ code: "invalid_path", message, hint: hint ?? "Use a non-empty site-relative path of at most 1,024 characters, without .. or control characters.", exitCode: EXIT.invalid });
  if (!segments.length) throw bad(`File path "${input}" is empty.`, "Use names like index.html or assets/app.js.");
  if (segments.includes("..")) throw bad(`File path "${input}" contains "..".`, "Paths must stay inside the site root.");
  // eslint-disable-next-line no-control-regex
  if (segments.some((s) => /[\u0000-\u001f\u007f]/.test(s))) throw bad(`File path "${input}" contains control characters.`);
  const path = segments.join("/");
  if (path.length > MAX_SITE_PATH) throw bad(`File path is longer than ${MAX_SITE_PATH} characters.`);
  if (path === "__dropway" || path.startsWith("__dropway/")) {
    throw new CliError({
      code: "reserved_path",
      message: `Paths under __dropway/ are reserved for the server ("${path}").`,
      hint: "Rename the folder, for example to _dropway/ or assets/.",
      exitCode: EXIT.invalid,
    });
  }
  if (new IgnoreMatcher([]).ignoresWithParents(path)) {
    throw new CliError({
      code: "ignored_file",
      message: `Refusing to publish ${path}: files like it (credentials, VCS and OS metadata) are never published.`,
      hint: "Rename the file if it is safe to make public.",
      exitCode: EXIT.usage,
    });
  }
  return path;
}

/** Wrap already-read piped bytes as the single file `path` (from `normaliseStdinPath`), hashed and secret-scanned. Unlike path publishing (which skips files over 4 MiB), piped input is always scanned: fail-closed for piped secrets. */
export function collectStdinFile(path: string, bytes: Uint8Array, opts: Pick<CollectOptions, "allowSecrets"> = {}): Collected {
  const secrets = !opts.allowSecrets && looksTextual(bytes) ? findSecrets(path, new TextDecoder("latin1").decode(bytes)) : [];
  const file: SourceFile = {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    body: async () => bytes,
  };
  return { kind: "file", root: "-", files: [file], totalBytes: file.size, ignored: [], secrets, skippedLinks: [], omissions: [] };
}
