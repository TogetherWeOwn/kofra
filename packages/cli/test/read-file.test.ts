import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/client.ts";
import { run, type Io } from "../src/main.ts";

interface Page {
  path: string;
  versionId: string;
  contentType: string;
  kind: string;
  size: number;
  sha256: string;
  encoding: string;
  offset: number;
  length: number;
  truncated: boolean;
  nextOffset: number | null;
  content: string;
  url: string;
  rawUrl: string;
}

const page = (over: Partial<Page> = {}): Page => ({
  path: "index.html",
  versionId: "ver_3",
  contentType: "text/html",
  kind: "text",
  size: 12,
  sha256: "abc123",
  encoding: "text",
  offset: 0,
  length: 12,
  truncated: false,
  nextOffset: null,
  content: "<h1>hi</h1>\n",
  url: "https://site.test/index.html",
  rawUrl: "https://api.test/api/v1/raw/site/index.html",
  ...over,
});

interface SeenRequest {
  method: string;
  url: string;
}

interface Harness {
  io: Io;
  stdout: () => string;
  stderr: () => string;
  requests: SeenRequest[];
  configDir: string;
}

async function harness(respond: (req: Request) => Response): Promise<Harness> {
  let out = "";
  let err = "";
  const requests: SeenRequest[] = [];
  const configDir = await mkdtemp(join(tmpdir(), "kofra-read-file-"));
  const io: Io = {
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t),
    stdinIsTTY: false,
    stderrIsTTY: false,
    readStdin: async () => "",
    prompt: async () => {
      throw new Error("read-file must never prompt");
    },
    env: { KOFRA_CONFIG_DIR: configDir },
    cwd: await mkdtemp(join(tmpdir(), "kofra-read-file-cwd-")),
    fetch: async (req) => {
      requests.push({ method: req.method, url: req.url });
      return respond(req instanceof Request ? req : new Request(req as unknown as string));
    },
  };
  return { io, stdout: () => out, stderr: () => err, requests, configDir };
}

const okPage = (p: Page) => new Response(JSON.stringify(p), { status: 200 });
const BASE = ["--api", "https://api.test", "--key", "dw_test_key"];

describe("read-file", () => {
  it("reads one bounded page as JSON with a single GET", async () => {
    const h = await harness(() => okPage(page()));
    const code = await run(["read-file", "my-site", "index.html", ...BASE, "--json"], h.io);
    expect(code).toBe(EXIT.ok);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.method).toBe("GET");
    const url = new URL(h.requests[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.test/api/v1/read-file");
    expect(url.searchParams.get("site")).toBe("my-site");
    expect(url.searchParams.get("path")).toBe("index.html");
    expect(url.searchParams.has("version")).toBe(false);
    expect(url.searchParams.has("encoding")).toBe(false);
    const parsed = JSON.parse(h.stdout());
    expect(parsed).toMatchObject({
      ok: true,
      path: "index.html",
      versionId: "ver_3",
      size: 12,
      sha256: "abc123",
      encoding: "text",
      content: "<h1>hi</h1>\n",
      truncated: false,
      nextOffset: null,
    });
    expect(h.stderr()).toBe("");
  });

  it("passes version, offset, length and encoding straight through", async () => {
    const h = await harness(() => okPage(page({ encoding: "base64", contentType: "image/png", content: "aGk=" })));
    const code = await run(
      ["read-file", "my-site", "img.png", ...BASE, "--version", "v2", "--offset", "10", "--length", "100", "--encoding", "base64", "--json"],
      h.io,
    );
    expect(code).toBe(EXIT.ok);
    expect(h.requests).toHaveLength(1);
    const params = new URL(h.requests[0]!.url).searchParams;
    expect(params.get("version")).toBe("v2");
    expect(params.get("offset")).toBe("10");
    expect(params.get("length")).toBe("100");
    expect(params.get("encoding")).toBe("base64");
    expect(JSON.parse(h.stdout()).content).toBe("aGk=");
  });

  it("prints content to stdout and page metadata to stderr without --json", async () => {
    const h = await harness(() => okPage(page()));
    const code = await run(["read-file", "my-site", "index.html", ...BASE], h.io);
    expect(code).toBe(EXIT.ok);
    expect(h.stdout()).toBe("<h1>hi</h1>\n");
    expect(h.stderr()).toContain("index.html");
    expect(h.stderr()).toContain("12 B");
    expect(h.stderr()).toContain("text/html");
    expect(h.stderr()).toContain("encoding text");
    expect(h.stderr()).toContain("ver_3");
    expect(h.stderr()).toContain("bytes 0-11 of 12");
    expect(h.stderr()).toContain("abc123");
    expect(h.stderr()).not.toContain("Truncated");
  });

  it("reports truncation with a continuation command", async () => {
    const h = await harness(() => okPage(page({ path: "big.txt", size: 70000, offset: 0, length: 65536, truncated: true, nextOffset: 65536 })));
    const code = await run(["read-file", "my-site", "big.txt", ...BASE, "--length", "65536", "--version", "v2"], h.io);
    expect(code).toBe(EXIT.ok);
    expect(h.stderr()).toContain("Truncated: continue with: kofra read-file my-site big.txt --offset 65536 --version v2 --length 65536");
  });

  it("shell-quotes paths with metacharacters in the continuation command", async () => {
    const h = await harness(() => okPage(page({ path: "docs/a #1.txt", size: 70000, offset: 0, length: 65536, truncated: true, nextOffset: 65536 })));
    const code = await run(["read-file", "my-site", "docs/a #1.txt", ...BASE], h.io);
    expect(code).toBe(EXIT.ok);
    expect(h.stderr()).toContain("Truncated: continue with: kofra read-file my-site 'docs/a #1.txt' --offset 65536");
  });

  it("keeps human content byte-for-byte with no added newline", async () => {
    const h = await harness(() => okPage(page({ content: "no-newline", size: 10, length: 10 })));
    const code = await run(["read-file", "my-site", "index.html", ...BASE], h.io);
    expect(code).toBe(EXIT.ok);
    expect(h.stdout()).toBe("no-newline");
  });

  it("describes an empty file without a byte range", async () => {
    const h = await harness(() => okPage(page({ size: 0, length: 0, content: "" })));
    const code = await run(["read-file", "my-site", "empty.txt", ...BASE], h.io);
    expect(code).toBe(EXIT.ok);
    expect(h.stderr()).toContain("empty file");
  });

  it("rejects an unknown encoding before any request", async () => {
    const h = await harness(() => okPage(page()));
    const code = await run(["read-file", "my-site", "index.html", ...BASE, "--encoding", "hex"], h.io);
    expect(code).toBe(EXIT.usage);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("Error (usage): --encoding must be auto, text or base64.");
    expect(h.stderr()).toContain("Fix: Run `kofra read-file --help`.");
  });

  it.each(["--offset=abc", "1.5", "abc", ""])("rejects --offset %j before any request", async (offset) => {
    const h = await harness(() => okPage(page()));
    const flag = offset.startsWith("--offset=") ? [offset] : ["--offset", offset];
    const code = await run(["read-file", "my-site", "index.html", ...BASE, ...flag], h.io);
    expect(code).toBe(EXIT.usage);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("--offset must be a whole number 0 or greater.");
  });

  it("rejects a negative --offset before any request", async () => {
    const h = await harness(() => okPage(page()));
    const code = await run(["read-file", "my-site", "index.html", ...BASE, "--offset=-1"], h.io);
    expect(code).toBe(EXIT.usage);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("--offset must be a whole number 0 or greater.");
  });

  it.each(["0", "1048577", "abc"])("rejects --length %j before any request", async (length) => {
    const h = await harness(() => okPage(page()));
    const code = await run(["read-file", "my-site", "index.html", ...BASE, "--length", length], h.io);
    expect(code).toBe(EXIT.usage);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("--length must be a whole number from 1 to 1048576.");
  });

  it("rejects extra positionals, unknown flags and missing arguments before any request", async () => {
    for (const argv of [
      ["read-file", "s", "p", "extra", ...BASE],
      ["read-file", "s", "p", ...BASE, "--bogus", "1"],
      ["read-file", "only-site", ...BASE],
    ]) {
      const h = await harness(() => okPage(page()));
      const code = await run(argv, h.io);
      expect(code).toBe(EXIT.usage);
      expect(h.requests).toHaveLength(0);
    }
  });

  it("maps a missing file to exit 4 with the server code and hint", async () => {
    const h = await harness(
      () => new Response(JSON.stringify({ error: { code: "file_not_found", message: "No such file.", hint: "Check the path." } }), { status: 404 }),
    );
    const code = await run(["read-file", "my-site", "gone.html", ...BASE, "--json"], h.io);
    expect(code).toBe(EXIT.notFound);
    const parsed = JSON.parse(h.stdout());
    expect(parsed.ok).toBe(false);
    expect(parsed.exitCode).toBe(EXIT.notFound);
    expect(parsed.error.code).toBe("file_not_found");
    expect(parsed.error.hint).toBe("Check the path.");
  });

  it("writes no local config and keeps credentials out of output", async () => {
    const h = await harness(() => okPage(page()));
    const code = await run(["read-file", "my-site", "index.html", ...BASE, "--json"], h.io);
    expect(code).toBe(EXIT.ok);
    expect(await readdir(h.configDir)).toEqual([]);
    expect(h.stdout()).not.toContain("dw_test_key");
    expect(h.stderr()).not.toContain("dw_test_key");
  });

  it("documents itself in help", async () => {
    const h = await harness(() => okPage(page()));
    expect(await run(["read-file", "--help"], h.io)).toBe(EXIT.ok);
    expect(h.stdout()).toContain("kofra read-file <site> <path>");
    expect(h.stdout()).toContain("--encoding auto|text|base64");
    const h2 = await harness(() => okPage(page()));
    expect(await run(["help"], h2.io)).toBe(EXIT.ok);
    expect(h2.stdout()).toContain("read-file");
  });
});
