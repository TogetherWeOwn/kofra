import { strToU8 } from "fflate";
import type { DropwayContext } from "../context";
import { ApiError, conflict, forbidden, tooLarge } from "../errors";
import type { Principal } from "../principal";
import { blobScope, readBlob } from "./blobs";
import { getSiteByRef, resolveVersionRef } from "./site-ops";
import type { SiteRow, VersionRow } from "./sites";

/**
 * Exact version bytes as a ZIP (VERSION-ZIP). One version's served manifest
 * becomes a deterministic `application/zip`: entries stored uncompressed and
 * sorted by path, one fixed timestamp on every entry, sizes and CRCs up front
 * (no data descriptors), so the same version always yields identical bytes.
 * Stored entries keep worker CPU minimal; names are UTF-8 (bit 11) via fflate.
 *
 * The archive streams: blobs are read one file at a time and each entry is
 * emitted as soon as its bytes are checksummed, so a version is never buffered
 * whole in worker memory. Per-file buffering is inherent to the format choice:
 * with sizes known from the manifest the local headers carry them directly.
 */

export interface ExportFile {
  path: string;
  sha256: string;
  size: number;
}

export interface VersionExport {
  slug: string;
  versionId: string;
  versionNumber: number;
  filename: string;
  fileCount: number;
  totalBytes: number;
  stream: ReadableStream<Uint8Array>;
}

/** Fixed DOS timestamp on every entry: 2020-01-01 00:00:00 (time 0x0000, date 0x5021). */
const ZIP_DOS_TIME = 0x0000;
const ZIP_DOS_DATE = 0x5021;
/** Bit 11: entry names are UTF-8. Bit 3 (data descriptors) stays 0: sizes are known. */
const ZIP_FLAGS = 0x0800;
/** Entries are stored (method 0), never deflated: deterministic and CPU-free. */
const ZIP_METHOD_STORE = 0;
const ZIP_VERSION_NEEDED = 10;
/** Classic ZIP (no zip64) counts entries in 16 bits; the file-count cap never exceeds it. */
const MAX_ZIP_ENTRIES = 0xffff;
/** Classic ZIP (no zip64) stores sizes and offsets in 32 bits; total bytes never exceed it. */
const MAX_ZIP_BYTES = 0xffffffff;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name: Uint8Array, crc: number, size: number): Uint8Array {
  const out = new Uint8Array(30);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, ZIP_VERSION_NEEDED, true);
  v.setUint16(6, ZIP_FLAGS, true);
  v.setUint16(8, ZIP_METHOD_STORE, true);
  v.setUint16(10, ZIP_DOS_TIME, true);
  v.setUint16(12, ZIP_DOS_DATE, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, size, true);
  v.setUint32(22, size, true);
  v.setUint16(26, name.length, true);
  v.setUint16(28, 0, true);
  return out;
}

interface CentralEntry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

function centralRecord(e: CentralEntry): Uint8Array {
  const out = new Uint8Array(46);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, (3 << 8) | ZIP_VERSION_NEEDED, true); // Made by UNIX, needs 1.0 to extract.
  v.setUint16(6, ZIP_VERSION_NEEDED, true);
  v.setUint16(8, ZIP_FLAGS, true);
  v.setUint16(10, ZIP_METHOD_STORE, true);
  v.setUint16(12, ZIP_DOS_TIME, true);
  v.setUint16(14, ZIP_DOS_DATE, true);
  v.setUint32(16, e.crc, true);
  v.setUint32(20, e.size, true);
  v.setUint32(24, e.size, true);
  v.setUint16(28, e.name.length, true);
  v.setUint16(30, 0, true);
  v.setUint16(32, 0, true);
  v.setUint16(34, 0, true);
  v.setUint16(36, 0, true);
  v.setUint32(38, 0, true);
  v.setUint32(42, e.offset, true);
  return out;
}

function endRecord(count: number, dirSize: number, dirOffset: number): Uint8Array {
  const out = new Uint8Array(22);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(4, 0, true);
  v.setUint16(6, 0, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, dirSize, true);
  v.setUint32(16, dirOffset, true);
  v.setUint16(20, 0, true);
  return out;
}

async function readExportBytes(dc: DropwayContext, file: ExportFile): Promise<Uint8Array> {
  const blob = await readBlob(dc, file.sha256, file.size);
  if (!blob) {
    throw new ApiError(502, "blob_missing", `The file "${file.path}" is listed but its contents could not be read.`, "Retry shortly.", {
      path: file.path,
      sha256: file.sha256,
    });
  }
  if (!blob.body) return new Uint8Array(0);
  return new Uint8Array(await new Response(blob.body).arrayBuffer());
}

interface ZipEntry extends ExportFile {
  /** UTF-8 entry name, encoded once up front (also sizes the archive pre-stream). */
  name: Uint8Array;
}

/**
 * A pull-driven ZIP stream over already-sorted manifest entries. Each pull reads
 * at most one blob and emits that entry, so the first ZIP bytes flow before
 * later blobs are read and each blob is read exactly once.
 */
function zipStream(dc: DropwayContext, entries: ZipEntry[]): ReadableStream<Uint8Array> {
  const central: CentralEntry[] = [];
  let index = 0;
  let offset = 0;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      if (index < entries.length) {
        const entry = entries[index++]!;
        const bytes = await readExportBytes(dc, entry);
        const crc = crc32(bytes);
        controller.enqueue(localHeader(entry.name, crc, bytes.length));
        controller.enqueue(entry.name);
        if (bytes.length) controller.enqueue(bytes);
        central.push({ name: entry.name, crc, size: bytes.length, offset });
        offset += 30 + entry.name.length + bytes.length;
        return;
      }
      const dirOffset = offset;
      let dirSize = 0;
      for (const entry of central) {
        controller.enqueue(centralRecord(entry));
        controller.enqueue(entry.name);
        dirSize += 46 + entry.name.length;
      }
      controller.enqueue(endRecord(central.length, dirSize, dirOffset));
      controller.close();
      finished = true;
    },
  }, { highWaterMark: 0 });
}

const fileByFileHint = (slug: string, versionId: string) =>
  `Download file by file instead: list the manifest with list_files (GET /api/v1/sites/${slug}/files?version=${versionId}) and read each file with read_file or GET /api/v1/sites/${slug}/files/{path}.`;

/**
 * Refuse a pending version whose bytes are not all uploaded yet, with the same
 * D1-only missing check finalize uses (no blob reads, so streaming is
 * unaffected). Without it the export would start with 200 and die mid-stream.
 */
async function refusePendingWithMissingBytes(dc: DropwayContext, site: SiteRow, version: VersionRow): Promise<void> {
  const scope = blobScope({ siteId: site.id, tenantId: site.tenant_id });
  const { results: missingRows } = await dc.env.DB.prepare(
    `SELECT DISTINCT vf.sha256 FROM version_files vf
       LEFT JOIN blob_scopes bs ON bs.sha256 = vf.sha256 AND bs.scope = ?
       LEFT JOIN blobs b ON b.sha256 = vf.sha256
      WHERE vf.version_id = ? AND (bs.sha256 IS NULL OR b.sha256 IS NULL) LIMIT 200`,
  )
    .bind(scope, version.id)
    .all<{ sha256: string }>();
  if (missingRows.length) {
    throw conflict(
      "missing_blobs",
      `Version v${version.number} of "${site.slug}" still awaits ${missingRows.length} upload(s).`,
      "Upload the missing bytes and finalize the version, then export again.",
      { missing: missingRows.map((r) => r.sha256) },
    );
  }
}

/**
 * Resolve a site plus a version ref ("live", "vN", "N" or an id) to a
 * streaming ZIP export. Auth equals version-read auth; transfer slugs are
 * refused (versions only, never transfers). Over-cap versions answer 413
 * naming their counts; the caps are the effective policy limits.
 */
export async function exportVersionZip(dc: DropwayContext, p: Principal, siteRef: unknown, versionRef: unknown): Promise<VersionExport> {
  const site = await getSiteByRef(dc, p, siteRef, "sites:read");
  if (site.mode === "transfer") {
    throw forbidden("Transfer files are only available as sites-host downloads.", "Use the transfer page's download links.", "transfer_download_required");
  }
  const version = await resolveVersionRef(dc, site, versionRef);
  if (version.status === "pending") await refusePendingWithMissingBytes(dc, site, version);
  const { results } = await dc.env.DB.prepare("SELECT path, sha256, size FROM version_files WHERE version_id = ? ORDER BY path")
    .bind(version.id)
    .all<ExportFile>();
  // Explicit sort: entry order must not depend on database collation.
  const files = [...results].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const fileCount = files.length;
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const entries: ZipEntry[] = files.map((f) => ({ ...f, name: strToU8(f.path) }));
  // Exact archive size: file bytes plus 30 + name per local entry, 46 + name
  // per central entry, and the 22-byte end record. The format ceiling gates
  // this, not the manifest total, so near-4 GiB versions cannot wrap offsets.
  const archiveBytes = totalBytes + entries.reduce((n, e) => n + 76 + 2 * e.name.length, 0) + 22;
  const lim = await dc.adapters.policy.limits(p, { tenantId: site.tenant_id, siteId: site.id }, dc);
  const countLimit = Math.min(lim.maxFiles, MAX_ZIP_ENTRIES);
  if (fileCount > countLimit) {
    throw tooLarge(
      "export_too_many_files",
      `Version v${version.number} of "${site.slug}" holds ${fileCount} files (${totalBytes} bytes); a ZIP export covers at most ${countLimit} files${countLimit < lim.maxFiles ? " (classic ZIP counts entries in 16 bits)" : ""}.`,
      fileByFileHint(site.slug, version.id),
      { fileCount, totalBytes, limit: countLimit },
    );
  }
  if (totalBytes > lim.maxSiteBytes) {
    throw tooLarge(
      "export_too_large",
      `Version v${version.number} of "${site.slug}" holds ${fileCount} files (${totalBytes} bytes); a ZIP export covers at most ${lim.maxSiteBytes} bytes.`,
      fileByFileHint(site.slug, version.id),
      { fileCount, totalBytes, limit: lim.maxSiteBytes },
    );
  }
  if (archiveBytes > MAX_ZIP_BYTES) {
    throw tooLarge(
      "export_too_large",
      `Version v${version.number} of "${site.slug}" holds ${fileCount} files (${totalBytes} bytes); its ZIP archive would pass the classic ZIP 32-bit ceiling of ${MAX_ZIP_BYTES} bytes (no zip64).`,
      fileByFileHint(site.slug, version.id),
      { fileCount, totalBytes, limit: MAX_ZIP_BYTES },
    );
  }
  return {
    slug: site.slug,
    versionId: version.id,
    versionNumber: version.number,
    filename: `${site.slug}-v${version.number}.zip`,
    fileCount,
    totalBytes,
    stream: zipStream(dc, entries),
  };
}
