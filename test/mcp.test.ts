import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { mcpInstructions } from "@dropway/server";
import { sha256Hex } from "@dropway/core";
import { BOOTSTRAP, form, freshInstance, jsonBody, type Instance } from "./helpers";
import { b64, connectLegacyMcp, connectMcp, type McpTestClient } from "./mcp-helpers";

let dw: Instance;
let mcp: McpTestClient;

beforeEach(async () => {
  dw = await freshInstance();
  mcp = await connectMcp(dw, dw.ownerKey);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const CORE_TOOLS = [
  "whoami",
  "publish_site",
  "update_site_files",
  "finalize_version",
  "get_site",
  "list_sites",
  "list_files",
  "read_file",
  "list_versions",
  "restore_version",
  "update_site_settings",
  "set_site_access",
  "delete_site",
];
const OTHER_TOOLS = ["create_site", "rename_site", "get_version", "delete_version", "list_api_keys", "create_api_key", "revoke_api_key", "list_members", "add_member", "update_member", "remove_member"];

describe("MCP endpoint: transport and auth", () => {
  it("refuses calls without a credential with 401 and WWW-Authenticate", async () => {
    const res = await dw.call("/mcp", { method: "POST", ...jsonBody({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.hint).toContain("/mcp");
  });

  it("refuses bad keys and the bootstrap key", async () => {
    expect((await dw.call("/mcp", { method: "POST", key: "dw_nope", ...jsonBody({}) })).status).toBe(401);
    const boot = await dw.call("/mcp", { method: "POST", key: BOOTSTRAP, ...jsonBody({}) });
    expect(boot.status).toBe(403);
  });

  it("answers CORS preflight without a credential", async () => {
    const res = await dw.call("/mcp", { method: "OPTIONS", headers: { Origin: "http://localhost:6274", "Access-Control-Request-Method": "POST" } });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("lists every tool with annotations, output schemas and short descriptions", async () => {
    const tools = await mcp.tools();
    const names = tools.map((t) => t.name);
    for (const n of [...CORE_TOOLS, ...OTHER_TOOLS]) expect(names).toContain(n);
    expect(names).not.toContain("claim_site"); // anonymous publishing is off by default
    for (const t of tools) {
      expect(t.description.length).toBeLessThan(4096);
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type).toBe("object");
      expect(t.annotations).toBeTruthy();
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.whoami._meta?.["anthropic/alwaysLoad"]).toBe(true);
    expect(byName.publish_site._meta?.["anthropic/alwaysLoad"]).toBe(true);
    expect(byName.delete_site.annotations.destructiveHint).toBe(true);
    expect(byName.list_sites.annotations.readOnlyHint).toBe(true);
    expect(byName.publish_site.inputSchema.properties.idempotencyKey).toBeTruthy();
    // Stable order: core tools first, in spec order.
    expect(names.slice(0, CORE_TOOLS.length)).toEqual(CORE_TOOLS);
  });

  it("keeps the tool list small enough for agent context windows", async () => {
    // About 4 characters per token: all tools ~8k tokens, core ~5.5k (SPEC 9.2 budget for core: about 5k).
    // R-27a: the per-site noindex setting adds ~140 chars to the site-tool schemas.
    expect(JSON.stringify(await mcp.tools()).length).toBeLessThan(36_500);
    const core = await connectMcp(dw, dw.ownerKey, { path: "/mcp?toolsets=core" });
    expect(JSON.stringify(await core.tools()).length).toBeLessThan(24_000);
  });

  it("server instructions stay under 4,096 characters", () => {
    const text = mcpInstructions(dw.dropway.context(env as never, { waitUntil() {} }, new URL("https://dropway.test/mcp")));
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain("publish_site");
  });

  it("narrows tools with ?toolsets= and ?read_only=1", async () => {
    const core = await connectMcp(dw, dw.ownerKey, { path: "/mcp?toolsets=core" });
    expect((await core.tools()).map((t) => t.name)).toEqual(CORE_TOOLS);
    const ro = await connectMcp(dw, dw.ownerKey, { path: "/mcp?read_only=1" });
    const roTools = await ro.tools();
    expect(roTools.length).toBeGreaterThan(5);
    expect(roTools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    const header = await connectMcp(dw, dw.ownerKey, { headers: { "X-Kofra-Toolsets": "keys" } });
    expect((await header.tools()).map((t) => t.name)).toEqual(["list_api_keys", "create_api_key", "revoke_api_key"]);
  });

  it("works with a 2025-era (SDK v1) client through the stateless legacy lane", async () => {
    const legacy = await connectLegacyMcp(dw, dw.ownerKey, { headers: { "X-Kofra-Client": "codex/1.2" } });
    expect((await legacy.tools()).length).toBeGreaterThan(20);
    const r = await legacy.call("publish_site", { files: [{ path: "index.html", content: "<h1>legacy</h1>" }] });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe("live");
    expect(r.data.version.client).toBe("codex/1.2");
  });
});

describe("MCP tools: publish, read back, edit, roll back", () => {
  it("whoami describes the caller, the instance and the limits", async () => {
    const r = await mcp.call("whoami");
    expect(r.isError).toBe(false);
    expect(r.data.principal.kind).toBe("member");
    expect(r.data.principal.role).toBe("owner");
    expect(r.data.instance.mcp).toBe("https://dropway.test/mcp");
    expect(r.data.instance.anonymousPublish).toBe(false);
    expect(r.data.limits.maxFileBytes).toBeGreaterThan(0);
    expect(r.text.split("\n")[0]).toContain("owner");
  });

  it("publishes text and base64 files, serves them, and records the MCP client", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const r = await mcp.call("publish_site", {
      site: "agent-notes",
      title: "Agent notes",
      files: [
        { path: "index.html", content: "<h1>Hello from MCP</h1>" },
        { path: "notes.md", content: "# Notes\n\nHi." },
        { path: "img/dot.png", content: b64(png), encoding: "base64" },
      ],
      message: "first",
    });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe("live");
    expect(r.data.created).toBe(true);
    expect(r.data.slug).toBe("agent-notes");
    expect(r.data.files).toMatchObject({ total: 3, stored: 3, reused: 0, pending: 0 });
    expect(r.data.version.number).toBe(1);
    expect(r.data.version.client).toBe("dropway-test/1.0.0");
    expect(r.data.version.source).toBe("mcp");
    expect(r.data.site.title).toBe("Agent notes");
    expect(r.text.split("\n")[0]).toMatch(/^Created agent-notes v1 \(3 files/);
    expect(r.content.some((c) => c.type === "resource_link" && c.uri === r.data.url)).toBe(true);

    const page = await dw.call(new URL("index.html", r.data.url).href);
    expect(await page.text()).toContain("Hello from MCP");
    const img = await dw.call(new URL("img/dot.png", r.data.url).href);
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(png);

    const again = await mcp.call("publish_site", { site: "agent-notes", files: [{ path: "index.html", content: "<h1>Hello from MCP</h1>" }, { path: "notes.md", content: "# Notes\n\nHi." }, { path: "img/dot.png", content: b64(png), encoding: "base64" }] });
    expect(again.data.status).toBe("unchanged");
    expect(again.data.version.number).toBe(1);
  });

  it("returns agent-actionable validation errors for every bad field at once", async () => {
    const r = await mcp.call("publish_site", { files: [{ path: "a.html" }, { path: "b.html", content: "x", url: "https://example.com/x" }, { path: "../c", content: "x" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^invalid_request: /);
    expect(r.text).toContain("Fix: ");
    expect(r.data.error.details.fields.map((f: any) => f.field)).toEqual(["files[0]", "files[1]", "files[2].path"]);
  });

  it("fetches url sources server-side and refuses private or non-https URLs", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://assets.example.com/logo.svg") return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { "Content-Type": "image/svg+xml" } });
      if (url === "https://assets.example.com/moved") return new Response(null, { status: 302, headers: { Location: "https://assets.example.com/logo.svg" } });
      if (url === "https://assets.example.com/evil") return new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/admin" } });
      return new Response("nope", { status: 404 });
    });
    const ok = await mcp.call("publish_site", {
      files: [
        { path: "index.html", content: '<img src="logo.svg">' },
        { path: "logo.svg", url: "https://assets.example.com/logo.svg" },
        { path: "copy.svg", url: "https://assets.example.com/moved" },
      ],
    });
    expect(ok.isError).toBe(false);
    expect(ok.data.files.fetched).toBe(2);
    expect(ok.data.files.total).toBe(3);
    const svg = await mcp.call("read_file", { site: ok.data.slug, path: "copy.svg" });
    expect(svg.data.contentType).toContain("image/svg+xml");
    expect(svg.data.content).toContain("<svg");

    for (const [url, why] of [
      ["http://assets.example.com/logo.svg", "https"],
      ["https://127.0.0.1/x", "private"],
      ["https://10.1.2.3/x", "private"],
      ["https://169.254.169.254/latest/meta-data", "private"],
      ["https://[::1]/x", "IPv6"],
      ["https://localhost/x", "internal"],
      ["https://printer.local/x", "internal"],
      ["https://assets.example.com/evil", "private"],
    ] as const) {
      const r = await mcp.call("publish_site", { files: [{ path: "x.txt", url }] });
      expect(r.isError, url).toBe(true);
      expect(r.data.error.code, url).toBe("fetch_blocked");
      expect(r.data.error.message, url).toContain(why);
    }
    const missing = await mcp.call("publish_site", { files: [{ path: "x.txt", url: "https://assets.example.com/404" }] });
    expect(missing.data.error.code).toBe("fetch_failed");
    expect(missing.data.error.details.status).toBe(404);
    expect(spy).toHaveBeenCalled();
    // A failed source never leaves an empty site behind.
    const sites = await mcp.call("list_sites");
    expect(sites.data.sites.length).toBe(1);
  });

  it("sha256 sources: reuse stored bytes, or return upload links and finalize after the upload", async () => {
    const big = "x".repeat(5000);
    const sha = await sha256Hex(big);
    const r = await mcp.call("publish_site", { site: "upload-flow", files: [{ path: "index.html", content: "<p>hi</p>" }, { path: "data.txt", sha256: sha, size: big.length }] });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe("awaiting_upload");
    expect(r.data.files.pending).toBe(1);
    const item = r.data.upload.items[0];
    expect(item).toMatchObject({ path: "data.txt", sha256: sha, size: 5000, method: "PUT", url: `https://dropway.test/api/v1/blobs/${sha}` });
    expect(item.curl).toContain("--data-binary @'data.txt'");
    expect(r.data.next[0].tool).toBe("finalize_version");

    const early = await mcp.call("finalize_version", { site: "upload-flow", versionId: r.data.upload.versionId });
    expect(early.isError).toBe(true);
    expect(early.data.error.code).toBe("missing_blobs");
    expect(early.data.error.details.uploads[0].sha256).toBe(sha);

    const put = await dw.call(item.url, { method: "PUT", key: dw.ownerKey, body: new TextEncoder().encode(big), headers: { "Content-Type": "text/plain", "Content-Length": String(big.length) } });
    expect(put.status).toBe(201);
    const fin = await mcp.call("finalize_version", { site: "upload-flow", versionId: r.data.upload.versionId });
    expect(fin.isError).toBe(false);
    expect(fin.data.status).toBe("live");
    expect(await (await dw.call(new URL("data.txt", fin.data.url).href)).text()).toBe(big);

    // The same sha256 is now stored: a second site reuses it without any upload.
    const reuse = await mcp.call("publish_site", { files: [{ path: "copy.txt", sha256: sha }] });
    expect(reuse.data.status).toBe("live");
    expect(reuse.data.files).toMatchObject({ stored: 0, reused: 1, pending: 0 });
  });

  it("update_site_files writes, deletes and moves while carrying everything else over", async () => {
    const first = await mcp.call("publish_site", {
      site: "partial",
      files: [
        { path: "index.html", content: "<h1>v1</h1>" },
        { path: "a.txt", content: "a" },
        { path: "drafts/one.md", content: "1" },
        { path: "drafts/two.md", content: "2" },
        { path: "old-name.css", content: "body{}" },
      ],
    });
    const base = first.data.version.id;
    const r = await mcp.call("update_site_files", {
      site: "partial",
      baseVersionId: base,
      files: [{ path: "index.html", content: "<h1>v2</h1>" }, { path: "b.txt", copyFrom: { path: "a.txt" } }],
      delete: ["drafts/", "ghost.txt"],
      move: [{ from: "old-name.css", to: "style.css" }],
      message: "edit",
    });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe("live");
    expect(r.data.version.number).toBe(2);
    expect(r.data.changes.deleted.sort()).toEqual(["drafts/one.md", "drafts/two.md"]);
    expect(r.data.warnings.map((w: any) => w.code)).toContain("delete_missing");
    const files = await mcp.call("list_files", { site: "partial" });
    expect(files.data.files.map((f: any) => f.path)).toEqual(["a.txt", "b.txt", "index.html", "style.css"]);
    expect((await mcp.call("read_file", { site: "partial", path: "index.html" })).data.content).toBe("<h1>v2</h1>");
    expect((await mcp.call("read_file", { site: "partial", path: "b.txt" })).data.content).toBe("a");

    // A stale base version fails instead of overwriting the newer publish.
    const stale = await mcp.call("update_site_files", { site: "partial", baseVersionId: base, files: [{ path: "a.txt", content: "lost" }] });
    expect(stale.isError).toBe(true);
    expect(stale.data.error.code).toBe("version_conflict");
    expect(stale.data.error.details.liveVersionNumber).toBe(2);
    expect(stale.text).toContain("Fix: ");

    const empty = await mcp.call("update_site_files", { site: "partial" });
    expect(empty.data.error.code).toBe("invalid_request");
  });

  it("read_file pages through large files and returns base64 for binaries", async () => {
    const text = "0123456789".repeat(10_000);
    await mcp.call("publish_site", { site: "paging", files: [{ path: "big.txt", content: text }, { path: "bin.dat", content: b64(new Uint8Array([0, 1, 2, 255])), encoding: "base64" }] });
    const p1 = await mcp.call("read_file", { site: "paging", path: "big.txt", length: 40_000 });
    expect(p1.data).toMatchObject({ offset: 0, length: 40_000, truncated: true, nextOffset: 40_000, encoding: "text", size: 100_000 });
    const p3 = await mcp.call("read_file", { site: "paging", path: "big.txt", offset: 80_000, length: 40_000 });
    expect(p3.data).toMatchObject({ length: 20_000, truncated: false, nextOffset: null });
    expect(p1.data.content + (await mcp.call("read_file", { site: "paging", path: "big.txt", offset: 40_000, length: 40_000 })).data.content + p3.data.content).toBe(text);
    const bin = await mcp.call("read_file", { site: "paging", path: "bin.dat" });
    expect(bin.data.encoding).toBe("base64");
    expect(bin.data.content).toBe(b64(new Uint8Array([0, 1, 2, 255])));
    const missing = await mcp.call("read_file", { site: "paging", path: "nope.txt" });
    expect(missing.data.error.code).toBe("file_not_found");
  });

  it("read_file preserves UTF-8 characters across byte pages", async () => {
    const small = "aé中💩\uFEFFz";
    const boundary = "a".repeat(65_535) + "é" + "z";
    await mcp.call("publish_site", { site: "utf8-pages", files: [{ path: "small.txt", content: small }, { path: "boundary.txt", content: boundary }] });
    for (const [path, expected, length] of [
      ["small.txt", small, 1], ["small.txt", small, 2], ["small.txt", small, 3],
      ["boundary.txt", boundary, undefined],
    ] as const) {
      let offset = 0;
      let content = "";
      do {
        const page = await mcp.call("read_file", { site: "utf8-pages", path, offset, ...(length === undefined ? {} : { length }) });
        expect(page.isError).toBe(false);
        expect(page.data.offset).toBe(offset);
        expect(page.data.length).toBe(new TextEncoder().encode(page.data.content).length);
        expect(page.data.length).toBeGreaterThan(0);
        expect(page.data.length).toBeLessThanOrEqual((length ?? 65_536) + 3);
        content += page.data.content;
        if (page.data.nextOffset === null) {
          expect(page.data.truncated).toBe(false);
          expect(offset + page.data.length).toBe(page.data.size);
          break;
        }
        expect(page.data.truncated).toBe(true);
        expect(page.data.nextOffset).toBe(offset + page.data.length);
        offset = page.data.nextOffset;
      } while (true);
      expect(content).toBe(expected);
    }
  });

  it("read_file keeps text pages within the 1 MiB cap without splitting UTF-8", async () => {
    const prefix = "a".repeat(1_048_575);
    // Multipart publishing avoids the separate 1 MiB inline-file limit.
    const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "big.txt": prefix + "💩z" }, { slug: "utf8-cap" }) });
    expect(published.status).toBe(201);
    const first = await mcp.call("read_file", { site: "utf8-cap", path: "big.txt", length: 1_048_576 });
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({ content: prefix, offset: 0, length: 1_048_575, truncated: true, nextOffset: 1_048_575 });
    const last = await mcp.call("read_file", { site: "utf8-cap", path: "big.txt", offset: first.data.nextOffset, length: 1_048_576 });
    expect(last.data).toMatchObject({ content: "💩z", length: 5, truncated: false, nextOffset: null });
  });

  it("read_file defers a UTF-8 character that would cross the cap at a near-cap length", async () => {
    const prefix = "a".repeat(1_048_574);
    const content = prefix + "💩z";
    // Multipart publishing avoids the separate 1 MiB inline-file limit.
    const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "big.txt": content }, { slug: "utf8-near-cap" }) });
    expect(published.status).toBe(201);
    const first = await mcp.call("read_file", { site: "utf8-near-cap", path: "big.txt", offset: 0, length: 1_048_575 });
    expect(first.isError).toBe(false);
    // Extending this page to finish the four-byte character would return
    // 1,048,578 bytes, over the 1 MiB cap, so the character is deferred.
    expect(first.data).toMatchObject({ content: prefix, offset: 0, length: 1_048_574, truncated: true, nextOffset: 1_048_574, encoding: "text", size: 1_048_579 });
    expect(first.data.length).toBe(new TextEncoder().encode(first.data.content).length);
    expect(first.data.length).toBeGreaterThan(0);
    expect(first.data.nextOffset).toBe(first.data.offset + first.data.length);
    expect(first.data.nextOffset).toBeGreaterThan(first.data.offset);
    const last = await mcp.call("read_file", { site: "utf8-near-cap", path: "big.txt", offset: first.data.nextOffset, length: 1_048_575 });
    expect(last.isError).toBe(false);
    expect(last.data).toMatchObject({ content: "💩z", offset: 1_048_574, length: 5, truncated: false, nextOffset: null, encoding: "text", size: 1_048_579 });
    expect(first.data.content + last.data.content).toBe(content);
  });

  it("read_file applies the cap page-relatively at a large nonzero offset", async () => {
    const content = "a".repeat(1_048_576) + "💩z";
    // Multipart publishing avoids the separate 1 MiB inline-file limit.
    const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "big.txt": content }, { slug: "utf8-large-offset" }) });
    expect(published.status).toBe(201);
    const first = await mcp.call("read_file", { site: "utf8-large-offset", path: "big.txt", offset: 1_048_576, length: 1 });
    expect(first.isError).toBe(false);
    // The cap applies to this page (4 bytes), not the absolute file position.
    expect(first.data).toMatchObject({ content: "💩", offset: 1_048_576, length: 4, truncated: true, nextOffset: 1_048_580, encoding: "text", size: 1_048_581 });
    expect(first.data.length).toBeGreaterThan(0);
    expect(first.data.nextOffset).toBe(first.data.offset + first.data.length);
    expect(first.data.nextOffset).toBeGreaterThan(first.data.offset);
    const last = await mcp.call("read_file", { site: "utf8-large-offset", path: "big.txt", offset: first.data.nextOffset, length: 1 });
    expect(last.isError).toBe(false);
    expect(last.data).toMatchObject({ content: "z", offset: 1_048_580, length: 1, truncated: false, nextOffset: null, encoding: "text", size: 1_048_581 });
    expect(first.data.content + last.data.content).toBe("💩z");
  });

  it("read_file leaves base64 byte ranges exact and does not move an explicit text offset", async () => {
    await mcp.call("publish_site", { site: "utf8-ranges", files: [{ path: "text.txt", content: "éz" }] });
    for (const [offset, content] of [[0, "ww=="], [1, "qQ=="], [2, "eg=="]] as const) {
      const page = await mcp.call("read_file", { site: "utf8-ranges", path: "text.txt", encoding: "base64", offset, length: 1 });
      expect(page.data).toMatchObject({ content, offset, length: 1, nextOffset: offset < 2 ? offset + 1 : null });
    }
    const partial = await mcp.call("read_file", { site: "utf8-ranges", path: "text.txt", encoding: "text", offset: 1 });
    expect(partial.data).toMatchObject({ content: "�z", offset: 1, length: 2, nextOffset: null });
    const eof = await mcp.call("read_file", { site: "utf8-ranges", path: "text.txt", offset: 3 });
    expect(eof.data).toMatchObject({ content: "", length: 0, truncated: false, nextOffset: null });
  });

  it("read_file completes a valid E0 lower-bound sequence across a byte page", async () => {
    // E0 A0 80 is U+0800, the lowest valid three-byte UTF-8 sequence.
    const published = await mcp.call("publish_site", { site: "utf8-valid-e0", files: [{ path: "text.txt", content: b64(new Uint8Array([0xe0, 0xa0, 0x80, 0x7a])), encoding: "base64" }] });
    expect(published.isError).toBe(false);
    const first = await mcp.call("read_file", { site: "utf8-valid-e0", path: "text.txt", encoding: "text", offset: 0, length: 1 });
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({ content: "ࠀ", offset: 0, length: 3, truncated: true, nextOffset: 3, encoding: "text", size: 4 });
    expect(first.data.length).toBeGreaterThan(0);
    expect(first.data.nextOffset).toBe(first.data.offset + first.data.length);
    expect(first.data.nextOffset).toBeGreaterThan(first.data.offset);
    const last = await mcp.call("read_file", { site: "utf8-valid-e0", path: "text.txt", encoding: "text", offset: first.data.nextOffset, length: 1 });
    expect(last.isError).toBe(false);
    expect(last.data).toMatchObject({ content: "z", offset: 3, length: 1, truncated: false, nextOffset: null, encoding: "text", size: 4 });
    expect(first.data.content + last.data.content).toBe("ࠀz");
  });

  it("read_file does not extend a page for a malformed UTF-8 crossing", async () => {
    // Publish the exact bytes as base64 so no text decoding rewrites them.
    const published = await mcp.call("publish_site", { site: "utf8-malformed", files: [{ path: "bad.txt", content: b64(new Uint8Array([0xe0, 0x80, 0x80, 0x41])), encoding: "base64" }] });
    expect(published.isError).toBe(false);
    const page = await mcp.call("read_file", { site: "utf8-malformed", path: "bad.txt", encoding: "text", offset: 0, length: 1 });
    expect(page.isError).toBe(false);
    // E0 80 80 is not a valid sequence, so the page is not extended to three
    // bytes: the one requested byte decodes to a single replacement char.
    expect(page.data).toMatchObject({ content: "�", offset: 0, length: 1, truncated: true, nextOffset: 1, encoding: "text", size: 4 });
    // length/nextOffset count consumed file bytes, not the 3 bytes the
    // replacement character would re-encode to.
    expect(new TextEncoder().encode(page.data.content).length).toBe(3);
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data.nextOffset).toBe(page.data.offset + page.data.length);
    expect(page.data.nextOffset).toBeGreaterThan(page.data.offset);
  });

  it("read_file strips only an initial BOM and advances by consumed bytes", async () => {
    // Publish the exact BOM bytes as base64 so they stay at the file start.
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("hello")]);
    const published = await mcp.call("publish_site", { site: "utf8-initial-bom", files: [{ path: "bom.txt", content: b64(bytes), encoding: "base64" }] });
    expect(published.isError).toBe(false);
    // An ordinary initial read strips the BOM but consumes all 8 file bytes.
    const full = await mcp.call("read_file", { site: "utf8-initial-bom", path: "bom.txt", offset: 0 });
    expect(full.isError).toBe(false);
    expect(full.data).toMatchObject({ content: "hello", offset: 0, length: 8, truncated: false, nextOffset: null, encoding: "text", size: 8 });
    expect(new TextEncoder().encode(full.data.content).length).toBe(5);
    // A one-byte request extends to the whole 3-byte BOM, which decodes to
    // empty content; the cursor still advances by the consumed bytes.
    const first = await mcp.call("read_file", { site: "utf8-initial-bom", path: "bom.txt", encoding: "text", offset: 0, length: 1 });
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({ content: "", offset: 0, length: 3, truncated: true, nextOffset: 3, encoding: "text", size: 8 });
    expect(new TextEncoder().encode(first.data.content).length).toBe(0);
    expect(first.data.length).toBeGreaterThan(0);
    expect(first.data.nextOffset).toBe(first.data.offset + first.data.length);
    expect(first.data.nextOffset).toBeGreaterThan(first.data.offset);
    const rest = await mcp.call("read_file", { site: "utf8-initial-bom", path: "bom.txt", encoding: "text", offset: first.data.nextOffset });
    expect(rest.isError).toBe(false);
    expect(rest.data).toMatchObject({ content: "hello", offset: 3, length: 5, truncated: false, nextOffset: null, encoding: "text", size: 8 });
    expect(first.data.content + rest.data.content).toBe("hello");
  });

  it("versions: list, get by number, restore by number, delete with confirm", async () => {
    await mcp.call("publish_site", { site: "history", files: [{ path: "index.html", content: "one" }] });
    await mcp.call("publish_site", { site: "history", files: [{ path: "index.html", content: "two" }] });
    const list = await mcp.call("list_versions", { site: "history" });
    expect(list.data.versions.map((v: any) => [v.number, v.live])).toEqual([
      [2, true],
      [1, false],
    ]);
    const v1 = await mcp.call("get_version", { site: "history", version: "v1" });
    expect(v1.data.version).toMatchObject({ number: 1, status: "ready", live: false });
    const restored = await mcp.call("restore_version", { site: "history", version: "1" });
    expect(restored.data).toMatchObject({ restored: true, version: { number: 1, live: true } });
    expect(await (await dw.call(restored.data.url)).text()).toBe("one");
    const again = await mcp.call("restore_version", { site: "history", version: "v1" });
    expect(again.data.alreadyLive).toBe(true);
    const live = await mcp.call("delete_version", { site: "history", version: "live", confirm: "history" });
    expect(live.data.error.code).toBe("version_is_live");
    const wrong = await mcp.call("delete_version", { site: "history", version: "v2", confirm: "nope" });
    expect(wrong.data.error.code).toBe("confirm_mismatch");
    expect(wrong.data.error.details.expected).toBe("history");
    const del = await mcp.call("delete_version", { site: "history", version: "v2", confirm: "history" });
    expect(del.data.deleted).toBe(true);
    expect((await mcp.call("get_version", { site: "history", version: "v2" })).data.error.code).toBe("version_not_found");
  });

  it("settings, access, rename and delete", async () => {
    const pub = await mcp.call("publish_site", { site: "lifecycle", files: [{ path: "index.html", content: "<p>app</p>" }] });
    const spa = await mcp.call("update_site_settings", { site: pub.data.url, spa: true, title: "App" });
    expect(spa.data.site.settings.spa).toBe(true);
    expect(spa.data.site.title).toBe("App");
    expect(await (await dw.call(new URL("deep/route", pub.data.url).href, { headers: { Accept: "text/html" } })).text()).toContain("app");

    const pw = await mcp.call("set_site_access", { site: "lifecycle", mode: "password", password: "hunter22" });
    expect(pw.data.access.mode).toBe("password");
    expect((await dw.call(pub.data.url, { headers: { Accept: "text/html" } })).status).toBe(401);
    const noPw = await mcp.call("set_site_access", { site: "lifecycle", mode: "password" });
    expect(noPw.data.error.code).toBe("password_required");
    const priv = await mcp.call("set_site_access", { site: "lifecycle", mode: "private" });
    expect(priv.data.error.code).toBe("feature_unavailable");
    expect((await mcp.call("set_site_access", { site: "lifecycle", mode: "public" })).data.access.mode).toBe("public");
    expect((await dw.call(pub.data.url)).status).toBe(200);

    const renamed = await mcp.call("rename_site", { site: "lifecycle", newSlug: "lifecycle-two" });
    expect(renamed.data).toMatchObject({ renamed: true, oldSlug: "lifecycle", slug: "lifecycle-two" });
    expect(await (await dw.call(renamed.data.url)).text()).toContain("app");
    const oldUrl = await dw.call(pub.data.url);
    expect(oldUrl.status).toBe(308);
    expect(oldUrl.headers.get("location")).toBe(renamed.data.url);
    const taken = await mcp.call("publish_site", { site: "taken-name", files: [{ path: "index.html", content: "x" }] });
    expect((await mcp.call("rename_site", { site: "lifecycle-two", newSlug: taken.data.slug })).data.error.code).toBe("slug_taken");

    const noConfirm = await mcp.call("delete_site", { site: "lifecycle-two", confirm: "lifecycle" });
    expect(noConfirm.data.error.code).toBe("confirm_mismatch");
    const del = await mcp.call("delete_site", { site: "lifecycle-two", confirm: "lifecycle-two" });
    expect(del.data).toEqual({ deleted: true, slug: "lifecycle-two" });
    expect((await mcp.call("get_site", { site: "lifecycle-two" })).data.error.code).toBe("site_not_found");
  });

  it("accepts a site id or URL wherever a site is expected", async () => {
    const pub = await mcp.call("publish_site", { files: [{ path: "index.html", content: "x" }] });
    const row = await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind(pub.data.slug).first<{ id: string }>();
    expect((await mcp.call("get_site", { site: row!.id })).data.site.slug).toBe(pub.data.slug);
    expect((await mcp.call("get_site", { site: `${pub.data.url}index.html` })).data.site.slug).toBe(pub.data.slug);
    expect((await mcp.call("get_site", { site: `https://dropway.test/api/v1/sites/${pub.data.slug}` })).data.site.slug).toBe(pub.data.slug);
  });
});

describe("MCP tools: keys, members, scopes, idempotency", () => {
  it("create_api_key mints a scoped key that MCP enforces; revoke_api_key kills it", async () => {
    const k = await mcp.call("create_api_key", { name: "reader", scopes: ["sites:read"] });
    expect(k.isError).toBe(false);
    expect(k.data.key).toMatch(/^dw_/);
    const reader = await connectMcp(dw, k.data.key);
    expect((await reader.call("list_sites")).isError).toBe(false);
    const denied = await reader.call("publish_site", { files: [{ path: "index.html", content: "x" }] });
    expect(denied.isError).toBe(true);
    expect(denied.data.error.code).toBe("insufficient_scope");
    expect(denied.data.error.details.required).toBe("sites:write");
    const keys = await mcp.call("list_api_keys");
    expect(keys.data.keys.some((x: any) => x.id === k.data.id)).toBe(true);
    expect((await mcp.call("revoke_api_key", { id: k.data.id })).data.revoked).toBe(true);
    const res = await dw.call("/mcp", { method: "POST", key: k.data.key, ...jsonBody({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
  });

  it("a site-restricted key only sees its own site", async () => {
    const a = await mcp.call("publish_site", { site: "only-this", files: [{ path: "index.html", content: "a" }] });
    await mcp.call("publish_site", { site: "not-that", files: [{ path: "index.html", content: "b" }] });
    const k = await mcp.call("create_api_key", { name: "one-site", scopes: ["sites:read", "sites:write"], site: a.data.url });
    const scoped = await connectMcp(dw, k.data.key);
    expect((await scoped.call("list_sites")).data.sites.map((s: any) => s.slug)).toEqual(["only-this"]);
    expect((await scoped.call("get_site", { site: "not-that" })).data.error.code).toBe("site_not_found");
    expect((await scoped.call("update_site_files", { site: "only-this", files: [{ path: "x.txt", content: "ok" }] })).data.status).toBe("live");
  });

  it("idempotencyKey replays the first result and rejects a reused key with other arguments", async () => {
    const args = { site: "idem", files: [{ path: "index.html", content: "once" }], idempotencyKey: "op-123" };
    const first = await mcp.call("publish_site", args);
    const second = await mcp.call("publish_site", args);
    expect(second.data.replayed).toBe(true);
    expect(second.data.version.id).toBe(first.data.version.id);
    expect(second.text).toMatch(/^Replayed/);
    const versions = await mcp.call("list_versions", { site: "idem" });
    expect(versions.data.versions.length).toBe(1);
    const reused = await mcp.call("publish_site", { ...args, files: [{ path: "index.html", content: "twice" }] });
    expect(reused.data.error.code).toBe("idempotency_key_reused");

    const k1 = await mcp.call("create_api_key", { name: "ci", scopes: ["sites:read"], idempotencyKey: "key-1" });
    const k2 = await mcp.call("create_api_key", { name: "ci", scopes: ["sites:read"], idempotencyKey: "key-1" });
    expect(k1.data.key).toMatch(/^dw_/);
    expect(k2.data).toMatchObject({ id: k1.data.id, key: null, replayed: true });
  });

  it("members: add, list, change role, remove with confirm", async () => {
    const added = await mcp.call("add_member", { email: "agent@example.com", name: "Agent", role: "member" });
    expect(added.data.apiKey.key).toMatch(/^dw_/);
    const id = added.data.member.id;
    expect((await mcp.call("list_members")).data.members.map((m: any) => m.email)).toContain("agent@example.com");
    expect((await mcp.call("update_member", { id, role: "admin" })).data.member.role).toBe("admin");
    expect((await mcp.call("remove_member", { id, confirm: "someone@else" })).data.error.code).toBe("confirm_mismatch");
    expect((await mcp.call("remove_member", { id, confirm: "agent@example.com" })).data.removed).toBe(true);
  });

  it("extensions add tools through createDropway({ mcpTools }) and can replace a core tool", async () => {
    const ext = await freshInstance(
      {},
      {
        mcpTools: [
          {
            name: "hello_extension",
            toolset: "extra",
            description: "Says hello with the caller's tenant.",
            inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            outputSchema: { type: "object", properties: { greeting: { type: "string" } }, required: ["greeting"] },
            annotations: { readOnlyHint: true },
            scopes: ["sites:read"],
            async handler(args, ctx) {
              return { greeting: `hello ${args.name} from ${ctx.principal.kind}`, client: ctx.client };
            },
            summarize: (r) => r.greeting,
          },
          {
            name: "whoami",
            description: "Replaced by an extension.",
            inputSchema: { type: "object", properties: {} },
            async handler() {
              return { replaced: true };
            },
          },
        ],
      },
    );
    const c = await connectMcp(ext, ext.ownerKey);
    const tools = await c.tools();
    expect(tools.map((t) => t.name)).toContain("hello_extension");
    expect(tools.filter((t) => t.name === "whoami").length).toBe(1);
    const r = await c.call("hello_extension", { name: "ext" });
    expect(r.data.greeting).toBe("hello ext from member");
    expect(r.text.split("\n")[0]).toBe("hello ext from member");
    expect((await c.call("whoami")).data.replaced).toBe(true);
    const invalid = await c.call("hello_extension", {});
    expect(invalid.isError).toBe(true);
  });
});

describe("MCP with anonymous publishing on", () => {
  it("lists claim_site and claims an anonymous site", async () => {
    const anon = await freshInstance({ anonymous: { enabled: true } });
    const pub = await anon.json("/api/v1/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: [{ path: "index.html", content: "anon" }] }) });
    expect(pub.status).toBe(201);
    const c = await connectMcp(anon, anon.ownerKey);
    expect((await c.tools()).map((t) => t.name)).toContain("claim_site");
    const r = await c.call("claim_site", { site: pub.body.slug, claimToken: pub.body.claimToken });
    expect(r.data.claimed).toBe(true);
    expect(r.data.site.anonymous).toBe(false);
    // A claim token is a credential too: it can drive its own (now claimed) site no more.
    const asClaim = await anon.call("/mcp", { method: "POST", key: pub.body.claimToken, ...jsonBody({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(asClaim.status).toBe(401);
  });
});
