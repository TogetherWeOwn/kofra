import { extname } from "@dropway/core";
import { escapeHtml, formatBytes } from "../html";
import { cachedRender } from "./cache";
import { decodeText, standardTabs, viewerPage } from "./chrome";
import type { Viewer } from "./index";

/**
 * CSV and TSV: a table with a sticky header, row numbers, right-aligned
 * numeric columns, and row/column counts. Shows the first 2,000 rows; reads at
 * most the first 4 MB of the file, so even very large files open fast.
 */
// 4 was issued separately for the report print treatment plus shared-link
// head tags and for the Phone disclosure in the viewer bar; neither 4
// identifies the merged bytes, so the merged render moves to 5.
const CSV_VERSION = 5;
export const MAX_ROWS = 2_000;
const READ_MAX_BYTES = 4 * 1024 * 1024;
const MAX_CELL = 1_000;
/** Delimiter detection scans at most 64 Ki UTF-16 code units ... */
const DETECT_SAMPLE_CHARS = 64 * 1024;
/** ... and lets at most five complete nonempty logical records vote. */
const DETECT_MAX_RECORDS = 5;
/** Candidate order is also the tie-break order: comma, tab, semicolon, pipe. */
const DELIMITER_CANDIDATES = [",", "\t", ";", "|"];

const CSV_CSS = `
.dw-csv{padding:12px 18px 48px}
.dw-csvmeta{font:400 12.5px/1.4 var(--mono);color:var(--ink-2);margin:4px 0 10px}
.dw-csvwrap{overflow:auto;max-height:calc(100vh - 8rem);border:1px solid var(--rule-soft);border-top:1px solid var(--accent);background:var(--paper-2)}
.dw-csvwrap table{border-collapse:separate;border-spacing:0;font-size:14px;min-width:100%}
.dw-csvwrap th,.dw-csvwrap td{padding:7px 12px;border-bottom:1px solid var(--rule-soft);border-right:1px solid var(--rule-faint);white-space:nowrap;max-width:28rem;overflow:hidden;text-overflow:ellipsis;vertical-align:top;text-align:left}
.dw-csvwrap thead th{position:sticky;top:0;background:var(--paper-2);font:500 10.5px/1.3 var(--mono);text-transform:uppercase;letter-spacing:.11em;color:var(--accent-2);border-bottom:1px solid var(--rule);z-index:1}
.dw-csvwrap td.n{text-align:right;font-variant-numeric:tabular-nums}
.dw-csvwrap th.rn,.dw-csvwrap td.rn{position:sticky;left:0;background:var(--paper-3);color:var(--muted);text-align:right;font:400 12px/1.6 var(--mono);user-select:none}
.dw-csvwrap thead th.rn{z-index:2}
.dw-csvwrap tbody tr:hover td{background:var(--accent-wash)}
`;

/**
 * Pick the delimiter by counting candidates outside quoted fields across
 * complete logical records (LF, CRLF and bare CR boundaries; LF/CRLF inside
 * quotes are field content; `""` is an escaped quote, like {@link parseCsv}).
 * A quote opens only at a field start, matching the parser.
 *
 * Bounded: at most {@link DETECT_SAMPLE_CHARS} UTF-16 code units are scanned
 * and at most {@link DETECT_MAX_RECORDS} complete nonempty records vote, so
 * detection is O(sample budget) time and O(1) memory. Hitting the character
 * budget mid-record is not EOF: a trailing unterminated record is discarded
 * and the completed prefix decides; with no completed record the fallback is
 * comma. An unterminated quote at true EOF likewise casts no vote. Empty
 * records cast no vote. Callers must pass the whole sample: the detector
 * slices internally, which is what lets it tell a budget cut from EOF. A
 * candidate seen a consistent nonzero number of times
 * in every voting record wins; remaining ties keep candidate order, and files
 * with no candidate evidence fall back to comma. `.tsv` always selects tab.
 */
export function detectDelimiter(sample: string, path: string): string {
  if (extname(path) === "tsv") return "\t";
  const truncated = sample.length > DETECT_SAMPLE_CHARS;
  const text = truncated ? sample.slice(0, DETECT_SAMPLE_CHARS) : sample;
  // Per-record outside-quote counts, one row per voting record.
  const votes: number[][] = [];
  let counts = [0, 0, 0, 0];
  let quoted = false;
  let fieldStart = true;
  let sawChar = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      sawChar = true;
      if (ch === '"') {
        if (text[i + 1] === '"') {
          i += 2;
          continue;
        }
        quoted = false;
        fieldStart = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      sawChar = true;
      if (fieldStart) quoted = true;
      else fieldStart = false;
      i++;
      continue;
    }
    const cand = DELIMITER_CANDIDATES.indexOf(ch);
    if (cand >= 0) {
      sawChar = true;
      fieldStart = true;
      counts[cand]!++;
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++;
      if (sawChar) {
        votes.push(counts);
        if (votes.length >= DETECT_MAX_RECORDS) break;
        counts = [0, 0, 0, 0];
      }
      sawChar = false;
      fieldStart = true;
      continue;
    }
    sawChar = true;
    fieldStart = false;
    i++;
  }
  // The budget boundary is not EOF: only a fully seen, balanced trailing
  // record completes without a newline.
  if (!truncated && sawChar && !quoted && votes.length < DETECT_MAX_RECORDS) votes.push(counts);
  let best = ",";
  let bestScore = 0;
  for (let c = 0; c < DELIMITER_CANDIDATES.length; c++) {
    const column = votes.map((v) => v[c]!);
    const min = column.length ? Math.min(...column) : 0;
    const score = min > 0 && column.every((x) => x === column[0]) ? min + 1000 : min;
    if (score > bestScore) {
      best = DELIMITER_CANDIDATES[c]!;
      bestScore = score;
    }
  }
  return best;
}

/** RFC 4180 parser (quoted fields, doubled quotes, CRLF), stopping after `maxRows` rows. */
export function parseCsv(text: string, delimiter: string, maxRows: number): { rows: string[][]; complete: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++;
      if (rows.length >= maxRows) return { rows, complete: i >= n };
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows, complete: true };
}

const NUMERIC = /^\s*[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?%?\s*$/;

function cell(v: string): string {
  return escapeHtml(v.length > MAX_CELL ? `${v.slice(0, MAX_CELL)}…` : v);
}

/** The table HTML and counts (exported for tests). */
export function renderCsvTable(rows: string[][]): { html: string; columns: number } {
  if (!rows.length) return { html: '<p class="k-banner k-notebar" role="note">This file has no rows.</p>', columns: 0 };
  const columns = Math.max(...rows.map((r) => r.length));
  const [header, ...body] = rows;
  const numeric = Array.from({ length: columns }, (_, c) => {
    let seen = 0;
    for (const r of body) {
      const v = r[c] ?? "";
      if (v.trim() === "") continue;
      if (!NUMERIC.test(v)) return false;
      seen++;
    }
    return seen > 0;
  });
  const head = `<thead><tr><th class="rn" scope="col">#</th>${Array.from({ length: columns }, (_, c) => `<th scope="col" title="${cell(header![c] ?? "")}">${cell(header![c] ?? "")}</th>`).join("")}</tr></thead>`;
  const rowsHtml = body
    .map((r, i) => `<tr><td class="rn">${i + 1}</td>${Array.from({ length: columns }, (_, c) => `<td${numeric[c] ? ' class="n"' : ""}>${cell(r[c] ?? "")}</td>`).join("")}</tr>`)
    .join("");
  return { html: `<table>${head}<tbody>${rowsHtml}</tbody></table>`, columns };
}

export const csvViewer: Viewer = {
  id: "csv",
  version: CSV_VERSION,
  maxBytes: Number.MAX_SAFE_INTEGER,
  matches: (file, _live, mode) => file.kind === "csv" && mode !== "source",
  async render(vc) {
    const partial = vc.file.size > READ_MAX_BYTES;
    let meta = "";
    const r = await cachedRender(vc.dw, `csv@${CSV_VERSION}/${extname(vc.file.path)}/${vc.file.sha256}`, async () => {
      const text = decodeText(await vc.readBytes(0, partial ? READ_MAX_BYTES : vc.file.size));
      const delimiter = detectDelimiter(text, vc.file.path);
      const parsed = parseCsv(text, delimiter, MAX_ROWS + 1);
      // A partial read can end mid-row.
      if (partial && parsed.complete && parsed.rows.length > 1) parsed.rows.pop();
      const { html, columns } = renderCsvTable(parsed.rows);
      const dataRows = Math.max(parsed.rows.length - 1, 0);
      const more = !parsed.complete || partial;
      const delim = delimiter === "\t" ? "tab" : delimiter === "," ? "comma" : delimiter === ";" ? "semicolon" : "pipe";
      return `<!--meta-->${dataRows.toLocaleString("en-US")}${more ? "+" : ""} rows · ${columns} columns · ${delim}-separated${
        more ? ` · showing the first ${Math.min(dataRows, MAX_ROWS).toLocaleString("en-US")} rows of ${formatBytes(vc.file.size)}` : ""
      }<!--/meta--><div class="dw-csvwrap" tabindex="0" role="region" aria-label="${escapeHtml(`Table: ${vc.file.path}`)}">${html}</div>`;
    });
    const m = /^<!--meta-->(.*?)<!--\/meta-->/.exec(r.html);
    if (m) meta = m[1]!;
    return viewerPage(vc, {
      tabs: standardTabs(vc, { rendered: "Table", source: true }),
      print: true,
      css: CSV_CSS,
      body: `<div class="dw-csv"><p class="dw-csvmeta">${meta}</p>${m ? r.html.slice(m[0].length) : r.html}</div>`,
      headers: { "X-Kofra-Render-Cache": r.cache },
    });
  },
};
