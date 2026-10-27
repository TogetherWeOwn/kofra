/**
 * CSV viewer compatibility contract (paired tests; keep unchanged in the fix).
 * Detection samples at most 64 Ki UTF-16 code units and five complete, nonempty
 * logical records, not five physical lines. Ignore an unfinished trailing record;
 * use the completed prefix, or comma if none is available. Reaching the character
 * budget mid-record is not EOF. A complete final record needs no trailing newline.
 * Only separators outside quotes vote; doubled quotes stay inside their field.
 * Existing comma/tab/semicolon/pipe order breaks ties; .tsv always selects tab.
 * The fix must document this policy in the canonical viewer architecture note.
 * Render changes must invalidate both csv@1 fragments and conditional ETags,
 * without changing raw/download bytes, no-script CSP or existing viewer caps.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { csvViewer, detectDelimiter, parseCsv } from "../packages/server/src/viewers/csv";
import { cachedRender, clearRenderMemoryCache } from "../packages/server/src/viewers/cache";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

const SAMPLE_CHARS = 64 * 1024;
const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
const quotedSemicolon = '"last,name";note\n"Doe,Jane";ok\n';
const reverseComma = 'name,"note;with;semicolons"\nJane,"one;two;three"\n';

// Literal expected delimiters are independent of the parser/detector.
const detectionCases: Array<[string, string, string]> = [
  ["quoted commas do not win a semicolon tie", quotedSemicolon, ";"],
  ["quoted semicolons do not defeat comma", reverseComma, ","],
  ["quoted pipes do not defeat tab", 'name\t"note|with|pipes"\nJane\t"one|two|three"\n', "\t"],
  ["quoted tabs do not defeat pipe", 'name|"note\twith\ttabs"\nJane|"one\ttwo\tthree"\n', "|"],
  ["LF inside a field is not a record boundary", '"last,\nname";note\n"Doe,\nJane";ok\n', ";"],
  ["CRLF inside a field is not a record boundary", '"last,\r\nname";note\r\n"Doe,\r\nJane";ok\r\n', ";"],
  ["bare CR is a logical record boundary", '"last,name";note\r"Doe,Jane";ok\r', ";"],
  ["doubled quotes do not expose quoted separators", '"say ""a,b,c""";note\r\n"say ""d,e,f""";ok\r\n', ";"],
  ["multiple physical lines still form one sampled record", '"a,\nb,\nc,\nd,\ne,\nf";note\n"g,\nh";ok\n', ";"],
  ["ordinary comma", "name,note\nJane,ok\n", ","],
  ["ordinary tab", "name\tnote\nJane\tok\n", "\t"],
  ["ordinary semicolon", "name;note\nJane;ok\n", ";"],
  ["ordinary pipe", "name|note\nJane|ok\n", "|"],
  ["empty input falls back to comma", "", ","],
  ["empty records fall back to comma", "\r\n\n\r\n", ","],
  ["one column falls back to comma", "name\nJane\n", ","],
  ["unknown separator falls back to comma", "name:note\nJane:ok\n", ","],
  ["a quoted one-column file has no separator evidence", '"name;note"\n"Jane;ok"\n', ","],
  ["comma wins an outside-quote tie", "a,b;c\n1,2;3\n", ","],
  ["tab wins a tie without commas", "a\tb;c\n1\t2;3\n", "\t"],
  ["semicolon wins a tie without commas or tabs", "a;b|c\n1;2|3\n", ";"],
  ["a complete final record needs no newline", '"last,name";note', ";"],
  ["a sole unfinished quoted record has no vote", '"a;b;c;d', ","],
  ["an unfinished record cannot overturn the complete prefix", 'name;note\n"a,b,c,d', ";"],
];

describe("CSV delimiter logical-record contract", () => {
  it.each(detectionCases)("%s", (_label, text, delimiter) => {
    expect(detectDelimiter(text, "data.csv")).toBe(delimiter);
  });

  it.each(["data.tsv", "DATA.TSV"])("%s overrides all delimiter evidence", (path) => {
    expect(detectDelimiter(quotedSemicolon, path)).toBe("\t");
    expect(detectDelimiter('"unterminated;field', path)).toBe("\t");
    expect(detectDelimiter("", path)).toBe("\t");
  });

  it("stops voting after five complete records, even when later evidence disagrees", () => {
    const firstFive = "a;b\n1;2\n3;4\n5;6\n7;8\n";
    expect(detectDelimiter(firstFive + "a,b,c,d\n".repeat(10_000), "data.csv")).toBe(";");
  });

  it("stops at the character budget rather than scanning a long first record", () => {
    const prefix = "x".repeat(SAMPLE_CHARS);
    expect(detectDelimiter(prefix + ";late;separators\n", "data.csv")).toBe(",");
  });

  it("discards an unquoted record cut by the character budget", () => {
    const prefix = "name;note\n";
    const cutRecord = "a,b,c," + "x".repeat(SAMPLE_CHARS - prefix.length - 6);
    expect(detectDelimiter(prefix + cutRecord + ",late\n", "data.csv")).toBe(";");
  });

  it("retains completed evidence when a quoted record crosses the character budget", () => {
    const prefix = '"last,name";note\n';
    const cutRecord = '"' + "x".repeat(SAMPLE_CHARS - prefix.length - 1);
    expect(detectDelimiter(prefix + cutRecord + '",many,commas\n', "data.csv")).toBe(";");
  });

  it("does not let a closing quote beyond the sample budget turn an unfinished record into evidence", () => {
    const openRecord = '"' + "x".repeat(SAMPLE_CHARS - 1);
    expect(detectDelimiter(openRecord + '";late;separators\n', "data.csv")).toBe(",");
  });

  it("terminates safely on a large adversarial unfinished quoted field", () => {
    // Local generated data only; no wall-clock performance assertion.
    const text = '"' + '"";|\t'.repeat(400_000);
    expect(detectDelimiter(text, "data.csv")).toBe(",");
  });

  it("passes the selected delimiter into the existing quoted-field parser", () => {
    const text = '"last,\r\nname";note\r\n"Doe,\r\nJane";"said ""hi"""\r\n';
    expect(parseCsv(text, detectDelimiter(text, "data.csv"), 100)).toEqual({
      rows: [["last,\r\nname", "note"], ["Doe,\r\nJane", 'said "hi"']],
      complete: true,
    });
  });
});

const fixtures: Record<string, string> = {
  "quoted.csv": quotedSemicolon,
  "reverse.csv": reverseComma,
  "multiline.csv": '"last,\r\nname";note\r\n"Doe,\r\nJane";"said ""hi"""\r\n',
  "escaped.csv": 'name;note\r\n"<img src=x onerror=alert(1)>, &";"<script>alert(1)</script>"\r\n',
  "override.tsv": "name,note\nJane,ok\n",
  "same.csv": 'name\tnote\n"a,b,c"\tok\n',
  "same.tsv": 'name\tnote\n"a,b,c"\tok\n',
  "empty.csv": "",
  "single.csv": "name\nJane\n",
  "tie.csv": "a,b;c\n1,2;3\n",
  "rows.csv": "name;value\n" + Array.from({ length: 2_001 }, (_, i) => `row-${i + 1};${i + 1}\n`).join(""),
  "cell.csv": "name,note\nJane," + "x".repeat(1_001) + "\n",
  // The first 4 MiB ends immediately before the quote. The cell and row caps
  // still apply, and the tail must remain available only in raw/download mode.
  "bytes.csv": 'name,note\nJane,ok\nLong,"' + "x".repeat(4 * 1024 * 1024 - 'name,note\nJane,ok\nLong,"'.length) + '"\nTAIL_ONLY,not-rendered\n',
};

/** Inspect only actual table cells; viewer chrome/counts cannot satisfy these. */
function tableRows(html: string): string[][] {
  const table = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/)?.[1] ?? "";
  return Array.from(table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g), (row) =>
    Array.from(row[1]!.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/g))
      .filter((cell) => !/\bclass="[^"]*\brn\b/.test(cell[2]!))
      .map((cell) => cell[3]!),
  );
}

describe("CSV viewer rendered/raw compatibility in workerd", () => {
  let dw: Instance;
  let slug: string;
  beforeAll(async () => {
    dw = await freshInstance();
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, body: form(fixtures),
    });
    expect(published.status).toBe(201);
    slug = published.body.slug;
  });
  beforeEach(() => clearRenderMemoryCache());
  const get = (path: string, headers: Record<string, string> = NAV) => dw.call(`/s/${slug}/${path}`, { headers });

  const renderCases: Array<[string, string[][], string]> = [
    ["quoted.csv", [["last,name", "note"], ["Doe,Jane", "ok"]], "1 rows · 2 columns · semicolon-separated"],
    ["reverse.csv", [["name", "note;with;semicolons"], ["Jane", "one;two;three"]], "1 rows · 2 columns · comma-separated"],
    ["multiline.csv", [["last,\r\nname", "note"], ["Doe,\r\nJane", 'said &quot;hi&quot;']], "1 rows · 2 columns · semicolon-separated"],
    ["override.tsv", [["name,note"], ["Jane,ok"]], "1 rows · 1 columns · tab-separated"],
    ["single.csv", [["name"], ["Jane"]], "1 rows · 1 columns · comma-separated"],
    ["tie.csv", [["a", "b;c"], ["1", "2;3"]], "1 rows · 2 columns · comma-separated"],
  ];
  it.each(renderCases)("renders intended cells and counts for %s", async (path, rows, count) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("csv");
    const html = await res.text();
    expect(tableRows(html)).toEqual(rows);
    expect(html).toContain(count);
  });

  it("renders an empty file without inventing rows", async () => {
    const html = await (await get("empty.csv")).text();
    expect(tableRows(html)).toEqual([]);
    expect(html).toContain("0 rows");
  });

  it("escapes user cells and keeps the viewer's no-script CSP", async () => {
    const res = await get("escaped.csv");
    const html = await res.text();
    expect(tableRows(html)).toEqual([
      ["name", "note"],
      ["&lt;img src=x onerror=alert(1)&gt;, &amp;", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ]);
    expect(html).not.toMatch(/<script\b|<img\b|<input\b/i);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/(?:^|;)\s*script-src(?!\s+'none'\s*(?:;|$))/);
    expect(csp).toContain("sandbox");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it.each(["?raw=1", "?download=1", ""])("preserves exact CRLF/quote bytes in non-rendered mode %s", async (query) => {
    const headers = query ? NAV : { Accept: "*/*", "Sec-Fetch-Dest": "empty" };
    const res = await get(`multiline.csv${query}`, headers);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new TextEncoder().encode(fixtures["multiline.csv"]!));
    if (query === "?raw=1") expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    if (query === "?download=1") expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("keeps the 2,000-data-row limit and its truncation notice", async () => {
    const html = await (await get("rows.csv")).text();
    const rows = tableRows(html);
    expect(rows).toHaveLength(2_001);
    expect(rows[0]).toEqual(["name", "value"]);
    expect(rows[2_000]).toEqual(["row-2000", "2000"]);
    expect(html).not.toContain("row-2001");
    expect(html).toContain("showing the first 2,000 rows");
  });

  it("keeps the 1,000-character cell limit", async () => {
    const html = await (await get("cell.csv")).text();
    expect(tableRows(html)).toEqual([["name", "note"], ["Jane", "x".repeat(1_000) + "…"]]);
    expect(html).not.toContain("x".repeat(1_001));
  });

  it("keeps the 4 MiB render limit while raw/download still return the full file", async () => {
    const html = await (await get("bytes.csv")).text();
    expect(tableRows(html)).toEqual([["name", "note"], ["Jane", "ok"]]);
    expect(html).not.toContain("TAIL_ONLY");
    expect(html).toContain("showing the first");
    for (const query of ["?raw=1", "?download=1"]) {
      const res = await get(`bytes.csv${query}`);
      // ASCII fixture: exact string equality checks every stored byte without
      // millions of per-element Vitest comparisons.
      expect(await res.text()).toBe(fixtures["bytes.csv"]!);
    }
  });

  it("does not share a cached comma decision with an identical .tsv file", async () => {
    const csv = await (await get("same.csv")).text();
    const tsv = await (await get("same.tsv")).text();
    expect(tableRows(csv)).toEqual([["name", "note"], ["a,b,c", "ok"]]);
    expect(tableRows(tsv)).toEqual([["name", "note"], ["a,b,c", "ok"]]);
    expect(csv).toContain("tab-separated");
    expect(tsv).toContain("tab-separated");
    // A conflicting .tsv extension must override auto-detection, including after
    // the same bytes were cached under .csv.
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({ "a.csv": quotedSemicolon, "a.tsv": quotedSemicolon }),
    });
    expect(published.status).toBe(201);
    await (await dw.call(`/s/${published.body.slug}/a.csv`, { headers: NAV })).text();
    const overridden = await dw.call(`/s/${published.body.slug}/a.tsv`, { headers: NAV });
    expect(tableRows(await overridden.text())).toEqual([['last,name;note'], ['Doe,Jane;ok']]);
  });

  it.each(["memory", "edge"])("cannot reuse a legacy csv@1 wrong-column fragment from %s", async (tier) => {
    const hash = await sha256Hex(new TextEncoder().encode(quotedSemicolon));
    const key = `csv@1/csv/${hash}`;
    const url = `${ORIGIN}/s/${slug}/quoted.csv`;
    const oldHtml = '<p>LEGACY_WRONG_COLUMNS</p><table><tr><th>last</th><th>name;note</th></tr></table>';
    // Remove earlier requests' fragments so this test exercises the upgrade,
    // not a correctly rendered fragment left by another test.
    await caches.default.delete(new Request(`${ORIGIN}/__dropway/render/${key}`));
    await caches.default.delete(new Request(`${ORIGIN}/__dropway/render/csv@${csvViewer.version}/csv/${hash}`));
    if (tier === "memory") {
      const ctx = createExecutionContext();
      const dc = dw.dropway.context(env as unknown as ServerBindings, ctx, new URL(url));
      await cachedRender(dc, key, async () => oldHtml);
      await waitOnExecutionContext(ctx);
    } else {
      await caches.default.put(new Request(`${ORIGIN}/__dropway/render/${key}`), new Response(oldHtml, {
        headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=2592000" },
      }));
      clearRenderMemoryCache();
    }
    const res = await dw.call(url, { headers: NAV });
    const html = await res.text();
    expect(html).not.toContain("LEGACY_WRONG_COLUMNS");
    expect(tableRows(html)).toEqual([["last,name", "note"], ["Doe,Jane", "ok"]]);
    expect(res.headers.get("x-kofra-render-cache")).toBe("miss");
    const again = await dw.call(url, { headers: NAV });
    expect(again.headers.get("x-kofra-render-cache")).toBe("memory");
    expect(tableRows(await again.text())).toEqual([["last,name", "note"], ["Doe,Jane", "ok"]]);
  });

  it("does not answer 304 to an old csv@1 ETag, but revalidates a new render", async () => {
    const hash = await sha256Hex(new TextEncoder().encode(quotedSemicolon));
    const legacy = `W/"csv@1-${hash}"`;
    const res = await get("quoted.csv", { ...NAV, "If-None-Match": legacy });
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag")!;
    expect(etag).not.toBe(legacy);
    expect(etag).toMatch(/^W\/"csv@4-[a-f0-9]{64}-[A-Za-z0-9_-]+"$/);
    expect(tableRows(await res.text())).toEqual([["last,name", "note"], ["Doe,Jane", "ok"]]);
    const fresh = await get("quoted.csv", { ...NAV, "If-None-Match": etag });
    expect(fresh.status).toBe(304);
    expect(await fresh.text()).toBe("");
  });
});
