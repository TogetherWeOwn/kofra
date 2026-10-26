import { KIND_LABELS, type FileKind } from "@dropway/core";
import { escapeHtml, formatBytes } from "../html";
import { decodeText, standardTabs, viewerPage } from "./chrome";
import { codePage, readShownText } from "./code";
import type { Viewer, ViewerContext } from "./index";

/**
 * Files no other viewer handles (unknown types, archives, WebAssembly, 3D
 * models): an info page with size, type, SHA-256 and the first 256 bytes as a
 * hex dump, plus Download. A file that turns out to be UTF-8 text (a LICENSE
 * without an extension, a .lock file) is shown as text instead.
 *
 * Only for ?view=1: a plain navigation to such a file keeps downloading it,
 * so download links on sites behave as their authors expect.
 */
const BINARY_KINDS = new Set<FileKind>(["binary", "archive", "wasm", "model3d"]);

/** No NUL bytes, few control characters, and valid UTF-8: probably text. */
export function looksLikeText(b: Uint8Array): boolean {
  if (b.length === 0) return true;
  let control = 0;
  for (const x of b) {
    if (x === 0) return false;
    if (x < 9 || (x > 13 && x < 32)) control++;
  }
  if (control / b.length > 0.02) return false;
  try {
    // Ignore a multi-byte character cut off at the end of the sample.
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b.subarray(0, Math.max(0, b.length - 4)));
    return true;
  } catch {
    return false;
  }
}

/** Classic hex dump: offset, 16 bytes in hex, printable ASCII. */
export function hexDump(b: Uint8Array): string {
  const lines: string[] = [];
  for (let o = 0; o < b.length; o += 16) {
    const row = b.subarray(o, o + 16);
    const hex = Array.from(row, (x) => x.toString(16).padStart(2, "0")).join(" ");
    const txt = Array.from(row, (x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join("");
    lines.push(`${o.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${txt}`);
  }
  return lines.join("\n");
}

const MAGIC: Array<[RegExp, string]> = [
  [/^504b0304/, "ZIP archive (also .docx, .xlsx, .jar, .apk)"],
  [/^1f8b/, "gzip-compressed data"],
  [/^0061736d/, "WebAssembly module"],
  [/^7f454c46/, "ELF executable"],
  [/^4d5a/, "Windows executable"],
  [/^(cafebabe|cffaedfe|cefaedfe|feedfacf|feedface)/, "Mach-O binary or Java class"],
  [/^676c5446/, "glTF binary model"],
  [/^53514c69746520666f726d6174203300/, "SQLite database"],
  [/^377abcaf271c/, "7-Zip archive"],
  [/^526172211a07/, "RAR archive"],
  [/^28b52ffd/, "Zstandard-compressed data"],
  [/^425a68/, "bzip2-compressed data"],
  [/^fd377a585a00/, "xz-compressed data"],
  [/^25504446/, "PDF document"],
];

export const binaryViewer: Viewer = {
  id: "binary",
  version: 2, // The UTF-8 fallback uses the printable code page.
  maxBytes: Number.MAX_SAFE_INTEGER,
  matches: (file, _live, mode) => mode === "view" && BINARY_KINDS.has(file.kind),
  async render(vc) {
    const head = await vc.readBytes(0, Math.min(vc.file.size, 8192));
    if (vc.file.kind === "binary" && looksLikeText(head)) {
      const shown = vc.file.size <= head.byteLength ? { text: decodeText(head), truncated: false, shown: head.byteLength } : await readShownText(vc);
      return codePage(vc, {
        ...shown,
        lang: null,
        tabs: standardTabs(vc, { rendered: "Text" }),
        note: `<p class="dw-note">This file has no known type, but it looks like text, so it is shown as text.</p>`,
      });
    }
    return binaryInfoPage(vc, head);
  },
};

/** Shared binary fallback; note is plain text, never trusted markup. */
export function binaryInfoPage(vc: ViewerContext, head: Uint8Array, note?: string, headers?: Record<string, string>): Response {
  const hex = Array.from(head.subarray(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
  const magic = MAGIC.find(([re]) => re.test(hex))?.[1] ?? null;
  const rows: Array<[string, string]> = [
    ["Size", `${formatBytes(vc.file.size)} (${vc.file.size.toLocaleString("en-US")} bytes)`],
    ["Type", vc.file.contentType],
    ["Kind", KIND_LABELS[vc.file.kind]],
    ...(magic ? ([["Looks like", magic]] as Array<[string, string]>) : []),
    ["SHA-256", vc.file.sha256],
  ];
  const body = `<main style="max-width:52rem;margin:0 auto;padding:2rem 1.25rem 4rem">
<h1 style="font-size:1.35rem;margin:0 0 1rem;word-break:break-all">${escapeHtml(vc.file.path.split("/").pop() ?? vc.file.path)}</h1>
${note ? `<p class="dw-note">${escapeHtml(note)}</p>` : ""}
<table style="border-collapse:collapse;width:100%;font-size:.9rem;margin-bottom:1.25rem">${rows
      .map(([k, v]) => `<tr><th scope="row" style="text-align:left;padding:.4rem 1rem .4rem 0;color:var(--muted);font-weight:500;width:8rem;vertical-align:top">${escapeHtml(k)}</th><td style="padding:.4rem 0;word-break:break-all;font-family:${k === "SHA-256" ? "ui-monospace,monospace" : "inherit"}">${escapeHtml(v)}</td></tr>`)
      .join("")}</table>
<p><a class="dw-btn" href="${escapeHtml(vc.downloadUrl)}" rel="nofollow" download>Download</a></p>
<h2 style="font-size:.95rem;margin:2rem 0 .5rem;color:var(--muted)">First ${Math.min(256, head.byteLength)} bytes</h2>
<pre style="background:var(--code);padding:1rem;border-radius:8px;overflow:auto;font-size:.8rem;line-height:1.5">${escapeHtml(hexDump(head.subarray(0, 256)))}</pre></main>`;
  return viewerPage(vc, { tabs: standardTabs(vc, { rendered: "Info", raw: false }), body, headers });
}
