import { extname } from "@dropway/core";
import { escapeHtml, formatBytes } from "../html";
import { binaryInfoPage } from "./binary";
import { cachedRender } from "./cache";
import { standardTabs, viewerPage } from "./chrome";
import type { Viewer, ViewerContext } from "./index";

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 1_000;
const EOCD_BYTES = 22;
const MAX_COMMENT_BYTES = 65_535;

const ARCHIVE_CSS = `
.dw-archive{max-width:70rem;margin:auto;padding:1rem 1.25rem 3rem}
.dw-archive h1{font-size:1.35rem;overflow-wrap:anywhere}
.dw-archive-table{overflow:auto;border:1px solid var(--rule-soft);border-radius:8px}
.dw-archive table{border-collapse:collapse;width:100%;font-size:.9rem}
.dw-archive th,.dw-archive td{padding:.5rem .75rem;border-bottom:1px solid var(--rule-soft);text-align:left}
.dw-archive th{background:var(--paper-3)}
.dw-archive td:first-child{font-family:ui-monospace,monospace;overflow-wrap:anywhere;white-space:pre-wrap;min-width:12rem}
.dw-archive-note{color:var(--muted);margin:.25rem 0 .75rem}
.dw-archive-cap{caption-side:top;text-align:left;padding:.5rem .75rem;color:var(--muted)}
.dw-archive .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
`;

// ZIP's original filename encoding when the UTF-8 flag is absent.
const CP437 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

/** Decode an entry name: strict UTF-8 when flag bit 11 is set, CP437 otherwise. */
function entryName(bytes: Uint8Array, utf8: boolean): string | null {
  if (utf8) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return null;
    }
  }
  return Array.from(bytes, (b) => b < 128 ? String.fromCharCode(b) : CP437[b - 128]).join("");
}

/**
 * A short blob read (serve.ts hands back empty bytes for a missing object):
 * a storage failure, not a verdict about the ZIP bytes. Listing fragments are
 * cached immutably by content hash, so this must throw past cachedRender —
 * returning null would cache a permanent invalid-ZIP verdict for that hash.
 */
class ArchiveReadError extends Error {}

/** Read only the end record and central directory; never open or inflate entries. */
async function archiveListing(vc: ViewerContext): Promise<string | null> {
  const tailOffset = Math.max(0, vc.file.size - EOCD_BYTES - MAX_COMMENT_BYTES);
  const tail = await vc.readBytes(tailOffset, vc.file.size - tailOffset);
  if (tail.length !== vc.file.size - tailOffset) throw new ArchiveReadError("short tail read");
  const end = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - EOCD_BYTES; i >= 0; i--) {
    if (end.getUint32(i, true) === 0x06054b50 && i + EOCD_BYTES + end.getUint16(i + 20, true) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = end.getUint16(eocd + 10, true);
  const size = end.getUint32(eocd + 12, true);
  const offset = end.getUint32(eocd + 16, true);
  // Split archives and ZIP64 are intentionally unsupported in this bounded viewer.
  if (end.getUint16(eocd + 4, true) !== 0 || end.getUint16(eocd + 6, true) !== 0 ||
      end.getUint16(eocd + 8, true) !== count || count === 0xffff ||
      size === 0xffffffff || offset === 0xffffffff || offset + size !== tailOffset + eocd ||
      count * 46 > size) return null;
  const directory = await vc.readBytes(offset, size);
  if (directory.length !== size) throw new ArchiveReadError("short directory read");
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const rows: string[] = [];
  let cursor = 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > size || view.getUint32(cursor, true) !== 0x02014b50) return null;
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const disk = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (!nameLength || next > size || disk !== 0 || compressed === 0xffffffff ||
        uncompressed === 0xffffffff || localOffset === 0xffffffff || localOffset + 30 + compressed > offset) return null;
    // Reject truncated extra fields rather than trusting their declared lengths.
    let extra = cursor + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra < extraEnd) {
      if (extra + 4 > extraEnd) return null;
      const id = view.getUint16(extra, true);
      const length = view.getUint16(extra + 2, true);
      extra += 4 + length;
      if (extra > extraEnd || id === 0x0001) return null;
    }
    const name = entryName(directory.subarray(cursor + 46, cursor + 46 + nameLength), (flags & 0x800) !== 0);
    if (name === null) return null;
    const bytes = name.endsWith("/") ? 0 : uncompressed;
    total += bytes;
    if (i < MAX_ENTRIES) {
      const label = method === 0 ? "Stored" : method === 8 ? "Deflated" : `Method ${method}`;
      rows.push(`<tr><td>${escapeHtml(name)}</td><td class="n">${formatBytes(bytes)}</td><td>${label}</td></tr>`);
    }
    cursor = next;
  }
  if (cursor !== size) return null;
  const notice = count > MAX_ENTRIES ? `<p class="k-small dw-archive-note">Showing the first ${MAX_ENTRIES.toLocaleString("en-US")} of ${count.toLocaleString("en-US")} entries.</p>` : "";
  return `<p>${count.toLocaleString("en-US")} ${count === 1 ? "entry" : "entries"} · ${formatBytes(total)} uncompressed</p>${notice}
<p class="k-small dw-archive-note">Central-directory metadata only, in archive order. Entry contents are not extracted or verified.</p>
<div class="dw-archive-table"><table><caption class="k-small dw-archive-cap">ZIP entries</caption><thead><tr><th scope="col">Path</th><th scope="col" class="n">Uncompressed size</th><th scope="col">Method</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

export const archiveViewer: Viewer = {
  id: "archive",
  // 3 was issued separately for the shared-link head tags (with shared-bar
  // sibling navigation) and for the Phone disclosure, so the merged render
  // moves to 4.
  version: 4,
  // Large and unsupported archives still get an info page, but are never parsed.
  maxBytes: Number.MAX_SAFE_INTEGER,
  matches: (file, _live, mode) => file.kind === "archive" && mode !== "source",
  async render(vc) {
    let note = extname(vc.file.path) !== "zip" ? "Only ZIP archives can be listed. Download this archive to open it." :
      vc.file.size > MAX_ARCHIVE_BYTES ? `This ZIP is too large to list (limit ${formatBytes(MAX_ARCHIVE_BYTES)}). Download it to open it.` : "";
    let transient = false;
    if (!note) {
      let r: Awaited<ReturnType<typeof cachedRender>> | null = null;
      try {
        r = await cachedRender(vc.dw, `archive@${archiveViewer.version}/${vc.file.sha256}`, async () => await archiveListing(vc) ?? "");
      } catch (e) {
        // Short reads store no fragment; this request still falls back, and
        // its page is non-storable (serve.ts withholds the listing ETag) so
        // a reload after storage recovers is not answered 304 from the
        // fallback. Deterministic parse failures return null, stay cached.
        if (!(e instanceof ArchiveReadError)) throw e;
        transient = true;
      }
      if (r?.html) {
        return viewerPage(vc, {
          tabs: standardTabs(vc, { rendered: "Entries" }),
          css: ARCHIVE_CSS,
          body: `<div class="dw-archive"><h1>${escapeHtml(vc.file.path.split("/").pop() ?? vc.file.path)}</h1>${r.html}</div>`,
          headers: { "X-Kofra-Render-Cache": r.cache },
        });
      }
      note = "This ZIP could not be read: it is invalid, truncated or uses an unsupported ZIP format (ZIP64 or split archives). Download it to open it.";
    }
    return binaryInfoPage(vc, await vc.readBytes(0, Math.min(vc.file.size, 8192)), note, transient ? { "Cache-Control": "no-store" } : undefined);
  },
};
