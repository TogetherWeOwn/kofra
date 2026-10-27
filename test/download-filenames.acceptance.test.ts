import { beforeEach, describe, expect, it } from "vitest";
import { gzipSync, strToU8 } from "fflate";
import { clearLiveMemoryCache, sha256Hex } from "@dropway/core";
import { DropwayClient, type FetchLike } from "../packages/cli/src/client.ts";
import { publish as cliPublish, type SourceFile } from "../packages/cli/src/publish.ts";
import { freshInstance, jsonBody, ORIGIN, type Instance } from "./helpers";
import { create, get, instance, siteFile } from "./transfer-fixtures";

// These are wire expectations, not an invocation or a copy of the header builder.
// Catch raw Unicode/Latin-1 headers, lossy normalization, unsafe quoted strings,
// double encoding, and accidentally applying the site's ASCII policy to transfers.
const NAMES = [
  { path: "資料.txt", fallback: "__.txt", encoded: "%E8%B3%87%E6%96%99.txt" },
  { path: "отчёт.txt", fallback: "_____.txt", encoded: "%D0%BE%D1%82%D1%87%D1%91%D1%82.txt" },
  { path: "ملف.txt", fallback: "___.txt", encoded: "%D9%85%D9%84%D9%81.txt" },
  { path: "café.txt", fallback: "caf_.txt", encoded: "caf%C3%A9.txt" },
  { path: "🚀.txt", fallback: "__.txt", encoded: "%F0%9F%9A%80.txt" },
  { path: "café.txt", fallback: "cafe_.txt", encoded: "cafe%CC%81.txt" },
  {
    path: '日";name=\'(!)*%25.txt', fallback: '__;name=\'(!)*%25.txt',
    encoded: "%E6%97%A5%22%3Bname%3D%27%28!%29%2a%2525.txt",
  },
];
const PAYLOAD = new Uint8Array([0, 255, 13, 10, 65, 128, 1, 127, 42]);
const BASE64 = "AP8NCkGAAX8q";
const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };

interface PublishFile {
  path: string;
  content: string;
  encoding?: "base64";
  contentType?: string;
}

async function publish(dw: Instance, files: PublishFile[]) {
  const result = await dw.json("/api/v1/publish", {
    key: dw.ownerKey,
    ...jsonBody({ slug: "download-names", files }),
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.slug as string;
}

function fileUrl(slug: string, path: string, query = "?download=1") {
  return `/s/${slug}/${path.split("/").map(encodeURIComponent).join("/")}${query}`;
}

async function bytes(response: Response) {
  return new Uint8Array(await response.arrayBuffer());
}

function safeHeader(response: Response) {
  const header = response.headers.get("content-disposition");
  expect(header).not.toBeNull();
  expect.soft(header).toMatch(/^[\x20-\x7e]+$/);
  expect(response.headers.get("x-injected")).toBeNull();
  return header!;
}

let dw: Instance;
beforeEach(async () => { dw = await freshInstance(); });

describe("published download filenames", () => {
  // workerd 1.20261019.1 accepts raw Unicode headers with a warning, unlike
  // browser/Node ByteString conversion. Assert the portable wire contract,
  // not a fictitious requirement that the baseline Worker must throw or 5xx.
  it.each(NAMES)("preserves $path through an ASCII fallback and UTF-8 filename*", async ({ path, fallback, encoded }) => {
    const slug = await publish(dw, [{ path: `nested/${path}`, content: BASE64, encoding: "base64" }]);
    const response = await dw.call(fileUrl(slug, `nested/${path}`), { headers: NAV });
    expect(response.status).toBe(200);
    expect(await bytes(response)).toEqual(PAYLOAD);
    expect.soft(safeHeader(response)).toBe(`attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-kofra-viewer")).toBeNull();
  });

  it.each([
    { path: "report.txt", header: 'attachment; filename="report.txt"' },
    { path: "Quarterly report (final).txt", header: 'attachment; filename="Quarterly report (final).txt"' },
    { path: 'say"hello.txt', header: 'attachment; filename="say_hello.txt"' },
    { path: "cost'(!)*%25.txt", header: 'attachment; filename="cost\'(!)*%25.txt"' },
    { path: "semi;name=other.txt", header: 'attachment; filename="semi;name=other.txt"' },
  ])("keeps the ASCII header byte-identical for $path", async ({ path, header }) => {
    const slug = await publish(dw, [{ path: `folder/${path}`, content: BASE64, encoding: "base64" }]);
    const response = await dw.call(fileUrl(slug, `folder/${path}`));
    expect(response.status).toBe(200);
    expect(await bytes(response)).toEqual(PAYLOAD);
    expect.soft(safeHeader(response)).toBe(header);
  });

  it("does not confuse a literal percent escape in a name with URL decoding", async () => {
    const slug = await publish(dw, [{ path: "café%0d%0aX-Injected.txt", content: "literal percent escapes" }]);
    const response = await dw.call(fileUrl(slug, "café%0d%0aX-Injected.txt"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("literal percent escapes");
    expect.soft(safeHeader(response)).toBe('attachment; filename="caf_%0d%0aX-Injected.txt"; filename*=UTF-8\'\'caf%C3%A9%250d%250aX-Injected.txt');
  });

  it("does not truncate a long legal UTF-8 filename or its extended parameter", async () => {
    // 1,021 UTF-8 bytes, below the published-path limit, with no external fixture.
    const path = `${"日".repeat(339)}.txt`;
    const slug = await publish(dw, [{ path, content: "long legal name" }]);
    const response = await dw.call(fileUrl(slug, path));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("long legal name");
    expect.soft(safeHeader(response)).toBe(`attachment; filename="${"_".repeat(339)}.txt"; filename*=UTF-8''${"%E6%97%A5".repeat(339)}.txt`);
  });

  it("uses the published basename after existing backslash path normalization", async () => {
    const slug = await publish(dw, [{ path: "folder\\report.txt", content: "normalized path" }]);
    const response = await dw.call(fileUrl(slug, "folder/report.txt"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("normalized path");
    expect.soft(safeHeader(response)).toBe('attachment; filename="report.txt"');
  });

  it.each(["\u0000", "\u0001", "\t", "\r", "\n", "\u001f", "\u007f", "\r\nX-Injected: yes"])(
    "continues rejecting an unpublishable control/injection sequence %j", async (control) => {
      const result = await dw.json("/api/v1/publish", {
        key: dw.ownerKey,
        ...jsonBody({ slug: "refused-download-name", files: [{ path: `bad${control}.txt`, content: "must not publish" }] }),
      });
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("invalid_request");
      expect(result.body.error.details.fields).toEqual(expect.arrayContaining([expect.objectContaining({ field: "files[0].path" })]));
      expect(result.res.headers.get("content-disposition")).toBeNull();
      expect(result.res.headers.get("x-injected")).toBeNull();
      const missing = await dw.call("/s/refused-download-name/bad.txt?download=1");
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-disposition")).toBeNull();
    },
  );

  it("preserves filenames published through the real CLI manifest/upload/finalize protocol", async () => {
    const fetch: FetchLike = async (request) => {
      const headers = new Headers(request.headers);
      const body = request.body ? await request.arrayBuffer() : undefined;
      // Supply the byte length that Node's network fetch supplies for uploads.
      if (body) headers.set("content-length", String(body.byteLength));
      return dw.call(request.url, { method: request.method, headers, body });
    };
    const client = new DropwayClient({ api: ORIGIN, token: dw.ownerKey, fetch });
    const files: SourceFile[] = await Promise.all([NAMES[0]!, NAMES[3]!].map(async ({ path }) => ({
      path, size: PAYLOAD.length, sha256: await sha256Hex(PAYLOAD), body: async () => PAYLOAD,
    })));
    const result = await cliPublish(client, files, { site: "cli-download-names" });
    expect(result).toMatchObject({ created: true, files: 2 });
    for (const { path, fallback, encoded } of [NAMES[0]!, NAMES[3]!]) {
      const response = await dw.call(fileUrl(result.slug, path));
      expect(response.status).toBe(200);
      expect(await bytes(response)).toEqual(PAYLOAD);
      expect.soft(safeHeader(response)).toBe(`attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    }
  });

  it("never turns an absent file or site into an attachment", async () => {
    const slug = await publish(dw, [{ path: "café.txt", content: "exists" }]);
    for (const url of [fileUrl(slug, "missing-資料.txt"), fileUrl("unknown-download-site", "資料.txt")]) {
      const response = await dw.call(url);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-disposition")).toBeNull();
    }
  });
});

describe("download byte modes and validators", () => {
  it("retains status, byte ranges, validators and CSP on a Unicode-named download", async () => {
    const path = "資料.bin";
    const slug = await publish(dw, [{ path, content: BASE64, encoding: "base64" }]);
    const inline = await dw.call(fileUrl(slug, path, ""));
    expect(inline.status).toBe(200);
    expect(await bytes(inline)).toEqual(PAYLOAD);
    expect(inline.headers.get("content-disposition")).toBeNull();
    const ranged = await dw.call(fileUrl(slug, path), { headers: { Range: "bytes=2-5" } });
    expect(ranged.status).toBe(206);
    expect(await bytes(ranged)).toEqual(new Uint8Array([13, 10, 65, 128]));
    expect(ranged.headers.get("content-range")).toBe("bytes 2-5/9");
    expect(ranged.headers.get("content-length")).toBe("4");
    expect(ranged.headers.get("accept-ranges")).toBe("bytes");
    expect.soft(safeHeader(ranged)).toBe('attachment; filename="__.bin"; filename*=UTF-8\'\'%E8%B3%87%E6%96%99.bin');
    for (const name of ["etag", "cache-control", "content-security-policy", "x-content-type-options"]) {
      expect(ranged.headers.get(name), name).toBe(inline.headers.get(name));
    }
  });

  it("preserves ETag/304 semantics without contaminating subsequent raw or inline responses", async () => {
    const path = "café.txt";
    const slug = await publish(dw, [{ path, content: BASE64, encoding: "base64" }]);
    const etag = `"${await sha256Hex(PAYLOAD)}"`;
    const first = await dw.call(fileUrl(slug, path));
    expect(first.status).toBe(200);
    expect(await bytes(first)).toEqual(PAYLOAD);
    expect.soft(safeHeader(first)).toBe('attachment; filename="caf_.txt"; filename*=UTF-8\'\'caf%C3%A9.txt');
    expect(first.headers.get("etag")).toBe(etag);
    expect(first.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const conditional = await dw.call(fileUrl(slug, path), { headers: { "If-None-Match": etag } });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    expect(conditional.headers.get("etag")).toBe(etag);
    expect(conditional.headers.get("cache-control")).toBe(first.headers.get("cache-control"));
    clearLiveMemoryCache();
    for (const query of ["", "?raw=1", "?download=0"]) {
      const response = await dw.call(fileUrl(slug, path, query));
      expect(response.status).toBe(200);
      expect(await bytes(response)).toEqual(PAYLOAD);
      expect(response.headers.get("etag")).toBe(etag);
      expect(response.headers.get("content-disposition")).toBeNull();
    }
  });

  it("keeps HTML download/raw bytes exact while ordinary inline HTML is still sandboxed and rewritten", async () => {
    const path = "資料.html";
    const content = '<!doctype html><html><head></head><body><a href="/asset.txt">asset</a></body></html>';
    const slug = await publish(dw, [{ path, content }, { path: "asset.txt", content: "asset" }]);
    const inline = await dw.call(fileUrl(slug, path, ""), { headers: NAV });
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-disposition")).toBeNull();
    expect(inline.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(await inline.text()).toContain(`href="/s/${slug}/asset.txt"`);
    const raw = await dw.call(fileUrl(slug, path, "?raw=1"), { headers: NAV });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(raw.headers.get("content-disposition")).toBeNull();
    expect(await raw.text()).toBe(content);
    for (const query of ["?download=1", "?raw=1&download=1"]) {
      const download = await dw.call(fileUrl(slug, path, query), { headers: NAV });
      expect(download.status).toBe(200);
      expect(await download.text()).toBe(content);
      expect.soft(safeHeader(download)).toBe('attachment; filename="__.html"; filename*=UTF-8\'\'%E8%B3%87%E6%96%99.html');
      expect(download.headers.get("x-kofra-viewer")).toBeNull();
      expect(download.headers.get("content-security-policy")).toBe(inline.headers.get("content-security-policy"));
    }
  });

  it("keeps unsatisfiable range status and content-range unchanged", async () => {
    const slug = await publish(dw, [{ path: "資料.txt", content: "short" }]);
    const response = await dw.call(fileUrl(slug, "資料.txt"), { headers: { Range: "bytes=9999-" } });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */5");
    expect.soft(safeHeader(response)).toBe('attachment; filename="__.txt"; filename*=UTF-8\'\'%E8%B3%87%E6%96%99.txt');
  });

  it("preserves original-byte serving with a gzip sibling and explicitly downloads the gzip bytes", async () => {
    const content = "const answer = 42;\n";
    const compressed = gzipSync(strToU8(content));
    const slug = await publish(dw, [
      { path: "café.js", content, contentType: "text/javascript" },
      { path: "café.js.gz", content: btoa(String.fromCharCode(...compressed)), encoding: "base64", contentType: "application/gzip" },
    ]);
    const inline = await dw.call(fileUrl(slug, "café.js", ""), { headers: { "Accept-Encoding": "gzip" } });
    expect(inline.status).toBe(200);
    // Baseline does not negotiate the sibling here; this fix must not add it.
    expect(inline.headers.get("content-encoding")).toBeNull();
    expect(await inline.text()).toBe(content);
    expect(inline.headers.get("content-disposition")).toBeNull();
    for (const query of ["?raw=1", "?download=1"]) {
      const response = await dw.call(fileUrl(slug, "café.js", query), { headers: { "Accept-Encoding": "gzip" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.text()).toBe(content);
      if (query === "?download=1") {
        expect.soft(safeHeader(response)).toBe('attachment; filename="caf_.js"; filename*=UTF-8\'\'caf%C3%A9.js');
      } else {
        expect(response.headers.get("content-disposition")).toBeNull();
      }
    }
    const gzipDownload = await dw.call(fileUrl(slug, "café.js.gz"), { headers: { "Accept-Encoding": "gzip" } });
    expect(gzipDownload.status).toBe(200);
    expect(await bytes(gzipDownload)).toEqual(compressed);
    expect(gzipDownload.headers.get("content-encoding")).toBeNull();
    expect.soft(safeHeader(gzipDownload)).toBe('attachment; filename="caf_.js.gz"; filename*=UTF-8\'\'caf%C3%A9.js.gz');
  });
});

describe("transfer filename compatibility", () => {
  it.each([
    { path: "report.txt", fallback: "report.txt", encoded: "report.txt" },
    { path: "cost'(!)*.txt", fallback: "cost'(!)*.txt", encoded: "cost%27%28!%29%2a.txt" },
    ...NAMES,
  ])("retains the existing header and counting behavior for $path", async ({ path, fallback, encoded }) => {
    const transferDw = await instance();
    const transfer = await create(transferDw, { files: [{ path, content: BASE64, encoding: "base64" }] });
    const url = siteFile(transfer, encodeURIComponent(path));
    const response = await transferDw.call(url);
    expect(response.status).toBe(200);
    expect(await bytes(response)).toEqual(PAYLOAD);
    // Unlike ordinary site downloads, transfers already include filename* for ASCII.
    expect.soft(safeHeader(response)).toBe(`attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await get(transferDw, transfer)).files[0]!.downloads).toBe(1);
    const resumed = await transferDw.call(url, { headers: { Range: "bytes=2-5" } });
    expect(resumed.status).toBe(206);
    expect(await bytes(resumed)).toEqual(new Uint8Array([13, 10, 65, 128]));
    expect.soft(safeHeader(resumed)).toBe(response.headers.get("content-disposition"));
    expect((await get(transferDw, transfer)).files[0]!.downloads).toBe(1);
  });
});
