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

async function walk(root: string, matcher: IgnoreMatcher, exclude: Set<string>, out: Entry[], ignored: string[], links: string[], omissions: Omission[], relDir = "") {
  const dirents = await readdir(join(root, relDir), { withFileTypes: true });
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of dirents) {
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
    if (isDir) await walk(root, matcher, exclude, out, ignored, links, omissions, rel);
    else if (isFile) out.push({ abs, rel });
    else omissions.push({ path: rel, reason: "special_file" }); // FIFO, socket or device (or a link to one)
  }
}

async function hashFile(e: Entry, scan: boolean, secrets: SecretFinding[]): Promise<SourceFile> {
  const s = await stat(e.abs);
  const size = s.size;
  let sha256: string;
  if (size <= IN_MEMORY_MAX) {
    const bytes = new Uint8Array(await readFile(e.abs));
    sha256 = createHash("sha256").update(bytes).digest("hex");
    if (scan && looksTextual(bytes)) secrets.push(...findSecrets(e.rel, new TextDecoder("latin1").decode(bytes)));
  } else {
    const h = createHash("sha256");
    for await (const chunk of createReadStream(e.abs)) h.update(chunk as Buffer);
    sha256 = h.digest("hex");
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
    await walk(root, matcher, exclude, entries, ignored, links, omissions);
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
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < entries.length; i = next++) files[i] = await hashFile(entries[i]!, !opts.allowSecrets, secrets);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 16, entries.length)) }, worker));
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
