/** Pure metadata comparison. Callers obtain manifests through the existing authorized reads. */
export interface CompareFile {
  path: string;
  size?: unknown;
  sha256?: unknown;
}

export type CompareRecord =
  | { class: "changed"; path: string; localSize: number | null; localSha256: string | null; remoteSize: number | null; remoteSha256: string | null; reason?: "incomplete_metadata" }
  | { class: "local_only" | "remote_only" | "unchanged"; path: string; size: number; sha256: string };

export interface CompareWarning {
  code: string;
  message: string;
  path?: string;
}

const validSize = (size: unknown): size is number => typeof size === "number" && Number.isSafeInteger(size) && size >= 0;
const validHash = (hash: unknown): hash is string => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash);

/** UTF-8 byte order, independent of locale and UTF-16 surrogate ordering. */
function pathOrder(x: Uint8Array, y: Uint8Array): number {
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

export function compareManifests(local: readonly CompareFile[], remote: readonly CompareFile[], opts: { limit: number; includeUnchanged: boolean }) {
  const left = new Map(local.map(f => [f.path, f]));
  const right = new Map(remote.map(f => [f.path, f]));
  const counts = { changed: 0, localOnly: 0, remoteOnly: 0, unchanged: 0, localTotal: local.length, remoteTotal: remote.length };
  const bytes = { changedLocal: 0, changedRemote: 0, localOnly: 0, remoteOnly: 0, unchanged: 0,
    localTotal: local.reduce((n, f) => n + (validSize(f.size) ? f.size : 0), 0),
    remoteTotal: remote.reduce((n, f) => n + (validSize(f.size) ? f.size : 0), 0) };
  const groups: Record<CompareRecord["class"], CompareRecord[]> = { changed: [], local_only: [], remote_only: [], unchanged: [] };
  const warnings: CompareWarning[] = [];
  let incomplete = 0;
  const encoder = new TextEncoder();
  const paths = [...new Set([...left.keys(), ...right.keys()])].map(path => ({ path, bytes: encoder.encode(path) }));
  paths.sort((a, b) => pathOrder(a.bytes, b.bytes));
  for (const { path } of paths) {
    const l = left.get(path);
    const r = right.get(path);
    const ls = l && validSize(l.size) ? l.size : null;
    const rs = r && validSize(r.size) ? r.size : null;
    const lh = l && validHash(l.sha256) ? l.sha256 : null;
    const rh = r && validHash(r.sha256) ? r.sha256 : null;
    const invalid = (l && (ls === null || lh === null)) || (r && (rs === null || rh === null));
    if (invalid || (l && r && (ls !== rs || lh !== rh))) {
      counts.changed++;
      bytes.changedLocal += ls ?? 0;
      bytes.changedRemote += rs ?? 0;
      groups.changed.push({ class: "changed", path, localSize: ls, localSha256: lh, remoteSize: rs, remoteSha256: rh,
        ...(invalid ? { reason: "incomplete_metadata" as const } : {}) });
      if (invalid) {
        incomplete++;
        if (warnings.length < opts.limit) warnings.push({ code: "incomplete_metadata", path, message: "Missing or malformed metadata; classified as changed. Unknown byte sizes contribute 0 to totals." });
      }
    } else if (!r) {
      counts.localOnly++;
      bytes.localOnly += ls!;
      groups.local_only.push({ class: "local_only", path, size: ls!, sha256: lh! });
    } else if (!l) {
      counts.remoteOnly++;
      bytes.remoteOnly += rs ?? 0;
      groups.remote_only.push({ class: "remote_only", path, size: rs!, sha256: rh! });
    } else {
      counts.unchanged++;
      bytes.unchanged += ls!;
      if (opts.includeUnchanged) groups.unchanged.push({ class: "unchanged", path, size: ls!, sha256: lh! });
    }
  }
  if (incomplete > opts.limit) warnings.push({ code: "warnings_truncated", message: `Incomplete-metadata warnings capped at --limit ${opts.limit} of ${incomplete} affected paths.` });
  if (remote.length === 1 && remote[0]!.path === "encrypted.bin") warnings.push({ code: "possibly_encrypted", message: "Heuristic: this single encrypted.bin manifest may be an encrypted publish; metadata cannot distinguish it from plaintext with that filename. No decryption was attempted." });
  const records = [...groups.changed, ...groups.local_only, ...groups.remote_only, ...groups.unchanged];
  return { counts, bytes, records: records.slice(0, opts.limit), truncated: records.length > opts.limit, warnings };
}
