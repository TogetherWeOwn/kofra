import { beforeEach, describe, expect, it } from "vitest";
import { freshInstance, ORIGIN, type Instance } from "./helpers";

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Title -> code for /connect HTML (<h3>title</h3><pre><code>code</code></pre>). */
function htmlSnippets(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<h3>(.*?)<\/h3><pre><code>([\s\S]*?)<\/code><\/pre>/g)) {
    out.set(unescapeHtml(m[1]!), unescapeHtml(m[2]!));
  }
  return out;
}

/** Title -> code for /connect.md (### title fenced blocks). */
function mdSnippets(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of md.matchAll(/### ([^\n]+)\n\n```\n([\s\S]*?)\n```/g)) {
    out.set(m[1]!.trim(), m[2]!);
  }
  return out;
}

function findByLabel(snippets: Map<string, string>, ...needles: string[]): [string, string] {
  for (const [title, code] of snippets) {
    if (needles.every((n) => title.toLowerCase().includes(n.toLowerCase()))) return [title, code];
  }
  throw new Error(`no snippet matching ${needles.join("+")} among: ${[...snippets.keys()].join(" | ")}`);
}

const MCP_URL = `${ORIGIN}/mcp`;

function expectCursorConfig(code: string, label: string) {
  const parsed = JSON.parse(code);
  expect(parsed, `${label}: must be keyed by top-level mcpServers`).toHaveProperty("mcpServers");
  expect(parsed, `${label}: VS Code top-level key does not belong here`).not.toHaveProperty("servers");
  expect(parsed.mcpServers.kofra.url, `${label}: instance origin + /mcp`).toBe(MCP_URL);
  expect(parsed.mcpServers.kofra.headers?.Authorization, `${label}: env placeholder`).toBe("Bearer ${env:KOFRA_API_KEY}");
  expect(parsed.mcpServers.kofra.type, `${label}: Cursor entry has no type field`).toBeUndefined();
}

function expectVsCodeConfig(code: string, label: string) {
  const parsed = JSON.parse(code);
  expect(parsed, `${label}: must be keyed by top-level servers`).toHaveProperty("servers");
  expect(parsed, `${label}: Cursor top-level key does not belong here`).not.toHaveProperty("mcpServers");
  expect(parsed.servers.kofra.type, `${label}: type`).toBe("http");
  expect(parsed.servers.kofra.url, `${label}: instance origin + /mcp`).toBe(MCP_URL);
  // Concrete oracle: README.md prompt-input variant.
  expect(parsed.servers.kofra.headers?.Authorization, `${label}: input placeholder`).toBe("Bearer ${input:kofra-key}");
  expect(Array.isArray(parsed.inputs), `${label}: inputs array`).toBe(true);
  expect(parsed.inputs, `${label}: promptString input`).toContainEqual(
    expect.objectContaining({ type: "promptString", id: "kofra-key", password: true }),
  );
}

describe("/connect Cursor / VS Code / add-mcp (PR #37 review)", () => {
  it("Cursor snippet is destination-labelled and parses to the env-placeholder shape", async () => {
    const html = await (await dw.call("/connect")).text();
    const md = await (await dw.call("/connect.md")).text();
    const [htmlTitle, htmlCode] = findByLabel(htmlSnippets(html), "cursor");
    expect(htmlTitle).toMatch(/\.cursor\/mcp\.json/);
    expectCursorConfig(htmlCode, "/connect Cursor");
    const [mdTitle, mdCode] = findByLabel(mdSnippets(md), "cursor");
    expect(mdTitle).toMatch(/\.cursor\/mcp\.json/);
    expectCursorConfig(mdCode, "/connect.md Cursor");
    expect(mdCode, "HTML and Markdown Cursor snippets cannot drift").toBe(htmlCode);
  });

  it("VS Code snippet is destination-labelled and uses the prompt-input placeholder", async () => {
    const html = await (await dw.call("/connect")).text();
    const md = await (await dw.call("/connect.md")).text();
    const [htmlTitle, htmlCode] = findByLabel(htmlSnippets(html), "vs code");
    expect(htmlTitle).toMatch(/\.vscode\/mcp\.json/);
    expectVsCodeConfig(htmlCode, "/connect VS Code");
    const [mdTitle, mdCode] = findByLabel(mdSnippets(md), "vs code");
    expect(mdTitle).toMatch(/\.vscode\/mcp\.json/);
    expectVsCodeConfig(mdCode, "/connect.md VS Code");
    expect(mdCode, "HTML and Markdown VS Code snippets cannot drift").toBe(htmlCode);
  });

  it("add-mcp carries the Authorization header flag", async () => {
    const expected = `npx add-mcp ${MCP_URL} --header "Authorization: Bearer $KOFRA_API_KEY"`;
    const html = await (await dw.call("/connect")).text();
    const md = await (await dw.call("/connect.md")).text();
    const [, htmlCode] = findByLabel(htmlSnippets(html), "add-mcp");
    expect(htmlCode.trim()).toBe(expected);
    const [, mdCode] = findByLabel(mdSnippets(md), "add-mcp");
    expect(mdCode.trim()).toBe(expected);
  });
});

describe("home MCP panel (PR #37 review)", () => {
  it("shows labelled Cursor and VS Code snippets, not the generic ${KOFRA_API_KEY} JSON", async () => {
    const html = await (await dw.call("/")).text();
    expect(html).toMatch(/cursor/i);
    expect(html).toContain(".cursor/mcp.json");
    expect(html).toMatch(/vs code/i);
    expect(html).toContain(".vscode/mcp.json");
    const pres = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => unescapeHtml(m[1]!));
    const parsed = pres.flatMap((p) => {
      try {
        return [JSON.parse(p)];
      } catch {
        return [];
      }
    });
    // The old broken shape (Cursor key + http type + bare ${KOFRA_API_KEY}) must be gone.
    for (const p of parsed) {
      if (p?.mcpServers?.kofra && p.mcpServers.kofra.type === "http") {
        expect(p.mcpServers.kofra.headers?.Authorization).not.toBe("Bearer ${KOFRA_API_KEY}");
      }
    }
    const cursor = parsed.find((p) => p?.mcpServers?.kofra && !p?.servers);
    expect(cursor, "home MCP panel needs a Cursor mcpServers snippet").toBeTruthy();
    expectCursorConfig(JSON.stringify(cursor), "home Cursor");
    const vscode = parsed.find((p) => p?.servers?.kofra);
    expect(vscode, "home MCP panel needs a VS Code servers snippet").toBeTruthy();
    expectVsCodeConfig(JSON.stringify(vscode), "home VS Code");
  });
});
