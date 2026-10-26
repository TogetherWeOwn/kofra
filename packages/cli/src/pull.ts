/** Node-only download orchestration. Remote bytes are always bounded read_file pages. */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CliError, EXIT, type DropwayClient, type ExitCode } from "./client.ts";

interface FileInfo {
  path: string;
  size: number;
  sha256: string;
}

interface ManifestPage {
  version: { id: string } | null;
  files: FileInfo[];
  nextCursor?: string | null;
}

interface ReadPage extends FileInfo {
  versionId: string;
  encoding: string;
  offset: number;
  length: number;
  content: string;
  truncated: boolean;
  nextOffset: number | null;
}

export interface PullReceipt {
  site: string;
  versionId: string;
  dir: string;
  files: FileInfo[];
  failures: Array<{ path: string; code: string; message: string }>;
}

const PAGE_BYTES = 1_048_576;

function invalidResponse(message: string): CliError {
  return new CliError({ code: "invalid_pull_response", message, hint: "Retry against an instance with valid file metadata and bounded read_file pages.", exitCode: EXIT.error });
}

async function localStat(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** This preflight never creates anything, even when the destination is absent. */
export async function checkPullDirectory(dir: string, force: boolean): Promise<void> {
  const info = await localStat(dir);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CliError({ code: "invalid_pull_directory", message: "The pull destination must be a directory, not a file or symlink.", hint: "Choose a new or empty directory.", exitCode: EXIT.usage });
  }
  if (!force && (await readdir(dir)).length) {
    throw new CliError({ code: "pull_directory_not_empty", message: "The pull destination is not empty.", hint: "Choose an empty directory, or use --force to overwrite pulled paths and preserve local extras.", exitCode: EXIT.usage });
  }
}

function pathSegments(path: string): string[] {
  const segments = path.split("/");
  // Refuse rather than normalize: Windows drives, alternate streams, UNC paths
  // and dot/empty segments must not acquire a different local meaning. A
  // `.git` segment is never site content (publishing excludes it); materializing
  // one would let server bytes become trusted Git configuration on this disk.
  if (!path || /[\\:\u0000-\u001f\u007f]/.test(path) || segments.some(s => !s || s === "." || s === ".." || s.toLowerCase() === ".git" || /[. ]$/.test(s)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) {
    throw new CliError({ code: "unsafe_pull_path", message: "The listed path is not a safe relative file path.", hint: "Use paths with nonempty forward-slash-separated names, without dot segments or drive syntax.", exitCode: EXIT.invalid });
  }
  return segments;
}

/** Never follow local symlinks in the server-controlled part of the destination. */
async function fileTarget(dir: string, segments: string[], existingPaths: ReadonlySet<string>): Promise<string> {
  await mkdir(dir, { recursive: true });
  let parent = dir;
  for (const segment of segments.slice(0, -1)) {
    const next = join(parent, segment);
    const info = await localStat(next);
    if (!info) await mkdir(next);
    else if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new CliError({ code: "unsafe_pull_path", message: "A local parent is not a directory or is a symlink.", hint: "Choose a destination without conflicting files or symlink parents.", exitCode: EXIT.usage });
    }
    parent = next;
  }
  const target = join(parent, segments[segments.length - 1]!);
  const info = await localStat(target);
  if (info && !info.isFile()) {
    throw new CliError({ code: "unsafe_pull_path", message: "The local target is not a regular file.", hint: "Choose a destination without conflicting directories or symlinks.", exitCode: EXIT.usage });
  }
  // Only exact paths present before this pull may be replaced. On a
  // case/normalization-insensitive disk, a different manifest name may now
  // resolve to an earlier download (or an extra), and must not overwrite it.
  if (info && !existingPaths.has(segments.join("/"))) {
    throw new CliError({ code: "pull_path_collision", message: "The local path aliases another file on this filesystem.", hint: "Use a case-sensitive destination that preserves distinct manifest paths.", exitCode: EXIT.invalid });
  }
  return target;
}

async function localFiles(dir: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await localFiles(join(dir, entry.name), `${path}/`));
    else result.push(path); // Symlinks are reported, never traversed.
  }
  return result;
}

async function manifest(client: DropwayClient, site: string, versionId: string): Promise<FileInfo[]> {
  const files: FileInfo[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ version: versionId, limit: "1000" });
    if (cursor !== null) query.set("cursor", cursor);
    const { data } = await client.get<ManifestPage>(`/sites/${encodeURIComponent(site)}/files?${query}`);
    if (!data || data.version?.id !== versionId || !Array.isArray(data.files)
      || data.files.some(file => !file || typeof file.path !== "string")) {
      throw invalidResponse("The file listing did not describe the pinned version.");
    }
    files.push(...data.files);
    cursor = data.nextCursor ?? null;
    if (cursor !== null) {
      if (typeof cursor !== "string" || !cursor || cursors.has(cursor) || !data.files.length) {
        throw invalidResponse("The file listing returned a non-progressing continuation.");
      }
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return files;
}

async function download(client: DropwayClient, site: string, versionId: string, file: FileInfo, target: string): Promise<void> {
  const temporary = join(dirname(target), `.kofra-pull-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    const digest = createHash("sha256");
    let offset = 0;
    do {
      const query = new URLSearchParams({ site, path: file.path, version: versionId, encoding: "base64", offset: String(offset), length: String(PAGE_BYTES) });
      const { data } = await client.get<ReadPage>(`/read-file?${query}`);
      if (!data || data.versionId !== versionId || data.path !== file.path || data.size !== file.size || data.sha256 !== file.sha256
        || data.encoding !== "base64" || data.offset !== offset || !Number.isSafeInteger(data.length)
        || data.length < 0 || data.length > PAGE_BYTES || typeof data.content !== "string"
        || data.content.length > Math.ceil(PAGE_BYTES / 3) * 4) {
        throw invalidResponse("The file page metadata did not match the pinned manifest.");
      }
      const bytes = Buffer.from(data.content, "base64");
      const end = offset + bytes.length;
      if (bytes.toString("base64") !== data.content || bytes.length !== data.length || end > file.size
        || (end < file.size ? data.truncated !== true || data.nextOffset !== end || bytes.length === 0
          : data.truncated !== false || data.nextOffset !== null)) {
        throw invalidResponse("The file page was incomplete, oversized or did not advance its byte offset.");
      }
      await handle.writeFile(bytes);
      digest.update(bytes);
      offset = end;
    } while (offset < file.size);
    if (offset !== file.size || digest.digest("hex") !== file.sha256) {
      throw new CliError({ code: "pull_integrity_mismatch", message: "Downloaded bytes did not match the server's size and SHA-256.", hint: "Retry the pinned version; do not use unverified bytes.", exitCode: EXIT.invalid });
    }
    // The temporary stayed owner-only while unverified; a verified file gets
    // the normal umask-adjusted mode a plain file creation would produce.
    await handle.chmod(0o666 & ~process.umask());
    await handle.close();
    await rename(temporary, target);
  } finally {
    try { await handle.close(); } finally {
      await unlink(temporary).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
    }
  }
}

export async function pullVersion(client: DropwayClient, site: string, versionId: string, dir: string, note: (text: string) => void): Promise<{ receipt: PullReceipt; exitCode: ExitCode }> {
  const files = await manifest(client, site, versionId);
  const receipt: PullReceipt = { site, versionId, dir, files: [], failures: [] };
  const paths = new Set<string>();
  const duplicates = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) duplicates.add(file.path);
    paths.add(file.path);
  }
  const existingPaths = new Set(await localStat(dir) ? await localFiles(dir) : []);
  for (const path of [...existingPaths].sort()) {
    if (!paths.has(path)) note(`Preserved local extra: ${JSON.stringify(path)}`);
  }
  let exitCode: ExitCode = EXIT.ok;
  for (const file of files) {
    try {
      const segments = pathSegments(file.path);
      if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || duplicates.has(file.path)) {
        throw invalidResponse("The listed file lacks a unique path, valid size or SHA-256.");
      }
      const target = await fileTarget(dir, segments, existingPaths);
      note(`Pulling ${JSON.stringify(file.path)}`);
      await download(client, site, versionId, file, target);
      receipt.files.push({ path: file.path, size: file.size, sha256: file.sha256 });
    } catch (e) {
      const err = e instanceof CliError ? e : new CliError({ code: "pull_file_failed", message: "The local file could not be written or replaced.", hint: "Check destination permissions and available disk space, then retry.", exitCode: EXIT.error });
      receipt.failures.push({ path: file.path, code: err.code, message: err.message });
      if (exitCode === EXIT.ok) exitCode = err.exitCode;
      note(`Failed ${JSON.stringify(file.path)} (${err.code}): ${err.message}`);
    }
  }
  return { receipt, exitCode };
}
