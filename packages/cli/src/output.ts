/** Small formatting helpers for human output. */

/**
 * Render control characters as visible \uXXXX escapes so untrusted names and
 * refs stay on one inert terminal line. JSON output keeps exact values; apply
 * this only at the human presentation boundary.
 */
export const escapeControl = (value: unknown) =>
  String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[u]}`;
}

/** Render rows as aligned columns (no borders). */
export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  if (!all.length) return "";
  const widths: number[] = [];
  for (const r of all) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return all.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2026-10-22T17:42:49.000Z" -> "2026-10-22 17:42". */
export const shortTime = (iso: string | null | undefined) => (iso ? iso.replace("T", " ").slice(0, 16) : "-");

/** Quote one argv word for display, so a pasted continuation command keeps working. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}
