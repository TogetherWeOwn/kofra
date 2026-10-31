import { afterEach, describe, expect, it, vi } from "vitest";
import { strToU8, unzipSync, Zip, ZipPassThrough, zipSync } from "fflate";
import { sha256Hex, unzipFiles } from "@dropway/core";
import { freshInstance, jsonBody } from "./helpers";

// Ordinary format compatibility: a small valid ZIP whose outer entries are
// streamed (stored, written with data descriptors because their lengths are
// not known when the local header is emitted) and whose first entry is an
// ordinary embedded ZIP file. Central-directory readers accept this shape
// using the recorded entry boundaries; the publisher must too, on both the
// uploaded-ZIP and archiveUrl paths, with exact byte read-back. The fixture
// is built entirely with the pinned fflate library from benign text files.

const INDEX = "<h1>embedded archive fixture</h1>";
const INNER_TEXT = "ordinary file inside the embedded archive";

afterEach(() => vi.restoreAllMocks());

/** One streamed outer ZIP: bundle.zip (an embedded ZIP) + index.html, both stored. */
function buildStreamedOuterZip(innerZip: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((err, chunk, final) => {
      if (err) { reject(err); return; }
      chunks.push(chunk);
      if (!final) return;
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      resolve(out);
    });
    const bundle = new ZipPassThrough("bundle.zip");
    zip.add(bundle);
    // Push in small slices like a streaming writer would; lengths are not
    // known at header time, so the entry is closed with a data descriptor.
    for (let at = 0; at < innerZip.length; at += 16) {
      bundle.push(innerZip.subarray(at, at + 16), at + 16 >= innerZip.length);
    }
    const index = new ZipPassThrough("index.html");
    zip.add(index);
    index.push(strToU8(INDEX), true);
    zip.end();
  });
}

async function fixture() {
  const innerZip = zipSync({ "inner.txt": strToU8(INNER_TEXT) }, { level: 0 });
  const outerZip = await buildStreamedOuterZip(innerZip);
  return { innerZip, outerZip };
}

function expectValidStreamedStoredFixture(outerZip: Uint8Array, innerZip: Uint8Array) {
  // The first local header must carry the data-descriptor flag (general
  // purpose bit 3): that is the streamed shape under test, so a fixture
  // change that silently stopped streaming would fail here, not pass vacuously.
  const dv = new DataView(outerZip.buffer, outerZip.byteOffset, outerZip.byteLength);
  expect(dv.getUint32(0, true)).toBe(0x04034b50);
  expect(dv.getUint16(6, true) & 0x08, "outer entries must be written with data descriptors").toBe(0x08);
  expect(dv.getUint16(8, true), "outer entries must be stored (no compression)").toBe(0);
  // A central-directory reader accepts the fixture and returns both entries
  // byte-for-byte: the archive is ordinary and valid before any product code runs.
  const entries = unzipSync(outerZip);
  expect(Object.keys(entries).sort()).toEqual(["bundle.zip", "index.html"]);
  expect(entries["bundle.zip"]).toEqual(innerZip);
  expect(new TextDecoder().decode(entries["index.html"])).toBe(INDEX);
  // The embedded archive itself round-trips.
  expect(new TextDecoder().decode(unzipSync(innerZip)["inner.txt"])).toBe(INNER_TEXT);
}

async function expectServedExactly(dw: Awaited<ReturnType<typeof freshInstance>>, slug: string, innerZip: Uint8Array) {
  const page = await dw.call(`/s/${slug}/index.html?raw=1`);
  expect(page.status).toBe(200);
  expect(await page.text()).toBe(INDEX);
  const served = await dw.call(`/s/${slug}/bundle.zip?raw=1`);
  expect(served.status).toBe(200);
  const actual = new Uint8Array(await served.arrayBuffer());
  expect(actual).toEqual(innerZip);
  expect(await sha256Hex(actual)).toBe(await sha256Hex(innerZip));
}

describe("streamed stored ZIP containing an embedded ZIP", () => {
  it("extracts both entries with exact bytes through the shared unzip helper", async () => {
    const { innerZip, outerZip } = await fixture();
    expectValidStreamedStoredFixture(outerZip, innerZip);
    const files = unzipFiles(outerZip, 1_000_000);
    const byPath = new Map(files.map((f) => [f.path, f.bytes]));
    expect([...byPath.keys()].sort()).toEqual(["bundle.zip", "index.html"]);
    expect(byPath.get("bundle.zip")).toEqual(innerZip);
    expect(await sha256Hex(byPath.get("bundle.zip")!)).toBe(await sha256Hex(innerZip));
    expect(new TextDecoder().decode(byPath.get("index.html"))).toBe(INDEX);
  });

  it("publishes through the uploaded-ZIP path and serves the embedded archive byte-for-byte", async () => {
    const dw = await freshInstance();
    const { innerZip, outerZip } = await fixture();
    expectValidStreamedStoredFixture(outerZip, innerZip);
    const { status, body } = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      headers: { "Content-Type": "application/zip" },
      body: outerZip,
    });
    expect(status, JSON.stringify(body)).toBe(201);
    await expectServedExactly(dw, body.slug, innerZip);
  });

  it("publishes through the archiveUrl path and serves the embedded archive byte-for-byte", async () => {
    const dw = await freshInstance();
    const { innerZip, outerZip } = await fixture();
    expectValidStreamedStoredFixture(outerZip, innerZip);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new Request(input).url;
      if (url !== "https://93.184.216.34/embedded.zip") return new Response("unexpected", { status: 400 });
      return new Response(outerZip as unknown as BodyInit, { headers: { "Content-Type": "application/zip" } });
    });
    const result = await dw.json("/api/v1/publish", {
      ...jsonBody({ site: "embedded-archive", archiveUrl: "https://93.184.216.34/embedded.zip" }),
      key: dw.ownerKey,
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.status).toBe("live");
    await expectServedExactly(dw, "embedded-archive", innerZip);
  });
});
