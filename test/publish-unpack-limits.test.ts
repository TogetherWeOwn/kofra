import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { ApiError, unzipFiles } from "@dropway/core";
import { freshInstance } from "./helpers";

// One-shot publish parsing: the zip extractor's budgets and length checks for
// deflated entries (stored entries are covered in archive-attachment-sources),
// and the request byte cap, which must hold with or without Content-Length.

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;

/** Rewrite a field in every local and central header (offsets differ between the two). */
function patchHeaders(zip: Uint8Array, local: number, central: number, write: (dv: DataView, at: number) => void): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = dv.getUint32(i, true);
    if (sig === LOCAL) write(dv, i + local);
    if (sig === CENTRAL) write(dv, i + central);
  }
  return out;
}

const declareSize = (zip: Uint8Array, size: number) => patchHeaders(zip, 22, 24, (dv, at) => dv.setUint32(at, size, true));
const declareMethod = (zip: Uint8Array, method: number) => patchHeaders(zip, 8, 10, (dv, at) => dv.setUint16(at, method, true));

function refusal(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected an ApiError");
}

// 200 kB of zeros deflates to a few hundred bytes.
const bomb = () => zipSync({ "index.html": new Uint8Array(200_000) }, { level: 9 });

describe("zip extraction of deflated entries", () => {
  it("refuses an honest zip bomb from its declared size", () => {
    const zip = bomb();
    expect(zip.length).toBeLessThan(1_000);
    const err = refusal(() => unzipFiles(zip, 1_000));
    expect([err.status, err.code]).toEqual([413, "zip_too_large"]);
  });

  it("refuses an entry whose declared size is over budget before inflating it", () => {
    // Inflating would find 50 bytes and fail the length check (400): the budget must win first.
    const zip = declareSize(zipSync({ "index.html": strToU8("x".repeat(50)) }, { level: 9 }), 2_000_000);
    const err = refusal(() => unzipFiles(zip, 1_000));
    expect([err.status, err.code]).toEqual([413, "zip_too_large"]);
  });

  it("refuses a zip bomb that declares a tiny size, on the bytes it actually inflates", () => {
    const err = refusal(() => unzipFiles(declareSize(bomb(), 10), 1_000));
    expect([err.status, err.code]).toEqual([413, "zip_too_large"]);
  });

  it.each([
    ["shorter", 10],
    ["longer", 100],
  ])("refuses an entry that inflates to more or less than its declared size (declared %s)", (_label, declared) => {
    const zip = declareSize(zipSync({ "index.html": strToU8("x".repeat(50)) }, { level: 9 }), declared);
    const err = refusal(() => unzipFiles(zip, 10_000));
    expect([err.status, err.code]).toEqual([400, "invalid_zip"]);
  });

  it.each([
    ["a non-empty", "x".repeat(50)],
    // An empty entry would otherwise pass every length check as a 0-byte file.
    ["an empty", ""],
  ])("refuses an unsupported compression method on %s entry", (_label, body) => {
    const zip = declareMethod(zipSync({ "index.html": strToU8(body) }, { level: 9 }), 12);
    const err = refusal(() => unzipFiles(zip, 10_000));
    expect([err.status, err.code]).toEqual([400, "invalid_zip"]);
  });

  it("refuses a central directory entry that does not point at a local header", () => {
    const zip = zipSync({ "index.html": strToU8("hello") }, { level: 9 });
    const out = zip.slice();
    new DataView(out.buffer).setUint32(0, 0, true);
    const err = refusal(() => unzipFiles(out, 10_000));
    expect([err.status, err.code]).toEqual([400, "invalid_zip"]);
  });

  it("returns the exact bytes of honest deflated entries (control)", () => {
    const body = "<p>" + "hello ".repeat(100) + "</p>";
    const files = unzipFiles(zipSync({ "index.html": strToU8(body), "a/b.css": strToU8("p{}") }, { level: 9 }), 10_000);
    expect(files.map((f) => f.path).sort()).toEqual(["a/b.css", "index.html"]);
    expect(new TextDecoder().decode(files.find((f) => f.path === "index.html")!.bytes)).toBe(body);
  });
});

describe("one-shot publish request limits", () => {
  const LIMIT = { limits: { oneShotMaxBytes: 100 } };
  const sitesOf = async (dw: Awaited<ReturnType<typeof freshInstance>>) => (await dw.json("/api/v1/sites", { key: dw.ownerKey })).body.sites;

  it("refuses a body over the cap, whether or not it declares a Content-Length", async () => {
    const dw = await freshInstance(LIMIT);
    const bytes = strToU8("x".repeat(200));
    const declared = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, headers: { "Content-Type": "text/html" }, body: bytes });
    expect([declared.status, declared.body.error?.code]).toEqual([413, "request_too_large"]);
    const streamed = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
    const undeclared = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, headers: { "Content-Type": "text/html" }, body: streamed });
    expect([undeclared.status, undeclared.body.error?.code]).toEqual([413, "request_too_large"]);
    // A declared length over the cap is refused before the body is read.
    const tiny = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(strToU8("x")); c.close(); } });
    const overDeclared = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, headers: { "Content-Type": "text/html", "Content-Length": "1000" }, body: tiny });
    expect([overDeclared.status, overDeclared.body.error?.code]).toEqual([413, "request_too_large"]);
    expect(await sitesOf(dw)).toHaveLength(0);
  });

  it("refuses an uploaded zip that expands past the cap and creates no site", async () => {
    const dw = await freshInstance(LIMIT);
    const res = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, headers: { "Content-Type": "application/zip" }, body: bomb() });
    expect([res.status, res.body.error?.code]).toEqual([413, "zip_too_large"]);
    expect(await sitesOf(dw)).toHaveLength(0);
  });

  it("names a raw body from Content-Disposition, and refuses empty or unnameable bodies", async () => {
    const dw = await freshInstance();
    const named = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      headers: { "Content-Type": "text/plain", "Content-Disposition": "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt" },
      body: "cv",
    });
    expect(named.status, JSON.stringify(named.body)).toBe(201);
    expect(named.body.files).toEqual(["résumé.txt"]);
    const plain = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey, headers: { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="notes.txt"' }, body: "n",
    });
    expect(plain.body.files).toEqual(["notes.txt"]);
    const empty = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, headers: { "Content-Type": "text/html" }, body: new Uint8Array(0) });
    expect([empty.status, empty.body.error?.code]).toEqual([400, "empty_body"]);
    const pdf = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, headers: { "Content-Type": "application/pdf" }, body: "%PDF-1.4" });
    expect([pdf.status, pdf.body.error?.code]).toEqual([400, "path_required"]);
  });
});
