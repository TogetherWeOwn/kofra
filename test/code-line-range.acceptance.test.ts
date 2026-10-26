/**
 * Protected acceptance (served page): select and link a line range without
 * editing the URL. Pins the REAL Worker output over HTTP — toolbar markup,
 * the static script hash in CSP, render identity, conditional requests and
 * raw/download byte identity — for the same contract whose interactions are
 * pinned in packages/server/test/code-line-range.acceptance.test.ts.
 * Only the Test Author may change this file.
 * Run: npx vitest run test/code-line-range.acceptance.test.ts
 */
import { beforeAll, describe, expect, it } from "vitest";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

const APP_TS =
  [
    "const alpha = 1;",
    "const beta = 2;",
    'const hostile = "</script><script>alert(1)</script>";',
    "const angles = \"<img src=x onerror=alert(1)> & 'quotes'\";",
    "const epsilon = 5;",
    "const zeta = 6;",
    "const eta = 7;",
    "const theta = 8;",
    "const iota = 9;",
    "const kappa = 10;",
    "const lambda = 'ünïcode ✓';",
    "const mu = '" + "x".repeat(400) + "'; // long line for wrap",
  ].join("\n") + "\n";
const INDEX_HTML = "<!doctype html><title>Home</title><p>one</p>\n<p>two</p>\n<p>three</p>\n";
const BIG_TXT = Array.from({ length: 20 }, (_, i) => `line${i + 1}-` + "a".repeat(60 * 1024)).join("\n") + "\n";

interface Tag {
  name: string;
  attrs: Map<string, string>;
  index: number;
  end: number;
}

function scanTags(html: string): Tag[] {
  const out: Tag[] = [];
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (const m of html.matchAll(re)) {
    const attrs = new Map<string, string>();
    for (const a of m[2]!.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs.set(a[1]!.toLowerCase(), a[2] ?? a[3] ?? a[4] ?? "");
    }
    out.push({ name: m[1]!.toLowerCase(), attrs, index: m.index, end: m.index + m[0].length });
  }
  return out;
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const visibleText = (html: string) => stripTags(html.replace(/<script>[\s\S]*?<\/script>/g, " ").replace(/<style>[\s\S]*?<\/style>/g, " "));

/** The existing code toolbar: from its opening tag to the source block. */
function toolbarRegion(html: string): string {
  const start = html.indexOf('class="dw-codehead"');
  expect(start, "code toolbar present").toBeGreaterThan(0);
  const src = html.indexOf('class="dw-src"', start);
  expect(src).toBeGreaterThan(start);
  return html.slice(html.lastIndexOf("<", start), html.lastIndexOf("<", src));
}

function labelsOf(html: string): Array<{ forId: string | null; text: string; index: number; end: number }> {
  const out = [];
  for (const m of html.matchAll(/<label((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/label>/g)) {
    const forId = /\bfor="([^"]*)"/.exec(m[1]!)?.[1] ?? /\bfor='([^']*)'/.exec(m[1]!)?.[1] ?? null;
    out.push({ forId, text: stripTags(m[2]!), index: m.index, end: m.index + m[0].length });
  }
  return out;
}

function inputAccessibleName(region: string, input: Tag, labels: ReturnType<typeof labelsOf>): string {
  const aria = input.attrs.get("aria-label");
  if (aria?.trim()) return aria.trim();
  const id = input.attrs.get("id");
  if (id) {
    const byFor = labels.find((l) => l.forId === id);
    if (byFor) return byFor.text;
  }
  const wrapping = labels.find((l) => input.index > l.index && input.index < l.end);
  return wrapping?.text ?? "";
}

/** Labelled, bounded first/last line inputs + explicit Select action in the toolbar. */
function expectRangeControls(html: string, renderedLines: number): void {
  const region = toolbarRegion(html);
  const labels = labelsOf(region);
  const inputs = scanTags(region).filter((t) => t.name === "input" && ["number", "text", ""].includes((t.attrs.get("type") ?? "text").toLowerCase()));
  const byName = (re: RegExp) => inputs.filter((i) => re.test(inputAccessibleName(region, i, labels)));
  const first = byName(/(first|start|from)\b[^]*\bline/i);
  const last = byName(/(last|end|to)\b[^]*\bline/i);
  expect(first, "labelled first/start line input in the code toolbar").toHaveLength(1);
  expect(last, "labelled last/end line input in the code toolbar").toHaveLength(1);
  expect(first[0]).not.toBe(last[0]);
  for (const input of [first[0]!, last[0]!]) {
    expect(input.attrs.get("min")).toBe("1");
    expect(input.attrs.get("max")).toBe(String(renderedLines));
    expect((input.attrs.get("type") ?? "").toLowerCase() === "number" || input.attrs.get("inputmode") === "numeric").toBe(true);
  }
  const buttonText = [...region.matchAll(/<button(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/button>/g)].map((m) => stripTags(m[1]!));
  const inputButtons = scanTags(region).filter((t) => t.name === "input" && ["submit", "button"].includes((t.attrs.get("type") ?? "").toLowerCase())).map((t) => t.attrs.get("value") ?? "");
  expect([...buttonText, ...inputButtons].filter((t) => /select/i.test(t)), "explicit Select action in the code toolbar").toHaveLength(1);
}

const lineIds = (html: string) => [...html.matchAll(/\bid="L(\d+)"/g)].map((m) => Number(m[1]));

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function scriptHashSource(script: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return "sha256-" + btoa(bin);
}

describe("served code viewer: line-range selection contract", () => {
  let dw: Instance;
  let slug: string;
  beforeAll(async () => {
    dw = await freshInstance();
    const res = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({ "src/app.ts": APP_TS, "index.html": INDEX_HTML, "big.txt": BIG_TXT }),
    });
    expect(res.status).toBe(201);
    slug = res.body.slug;
  });
  const get = (path: string, headers: Record<string, string> = NAV) => dw.call(`/s/${slug}/${path}`, { headers });

  it("control: baseline viewer keeps real anchors, Copy and Wrap in the toolbar", async () => {
    const res = await get("src/app.ts");
    expect(res.headers.get("x-kofra-viewer")).toBe("code");
    const html = await res.text();
    expect(lineIds(html)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const n of [1, 12]) expect(html).toContain(`<a href="#L${n}"`);
    const region = toolbarRegion(html);
    expect(region).toContain(">Copy</button>");
    expect(region).toContain('for="dw-wrap"');
    expect(region).toContain(">Wrap</label>");
    expect(html).toContain('id="dw-wrap"');
    // Hostile source stays inert text: exactly one real script element (the
    // viewer's) and no element smuggled out of the file content.
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;/script&gt;");
    // Raw / Download links stay fragment-free plain links.
    expect(html).toContain(`href="/s/${slug}/src/app.ts?raw=1"`);
    expect(html).toContain(`href="/s/${slug}/src/app.ts?download=1"`);
  });

  it("toolbar carries labelled bounded range inputs and an explicit Select action", async () => {
    const html = await (await get("src/app.ts")).text();
    expectRangeControls(html, 12);
  });

  it("a brief usage note explains shift-click selection without promising permanence", async () => {
    const html = await (await get("src/app.ts")).text();
    const text = visibleText(html) + " " + [...html.matchAll(/\btitle="([^"]*)"/g)].map((m) => m[1]).join(" ");
    expect(text).toMatch(/shift/i);
    expect(text).toMatch(/shift[^.]{0,120}(click|select|range|line)|(click|select|range|line)[^.]{0,120}shift/i);
    // A live URL stays live: never sold as a permanent/immutable link.
    expect(text).not.toMatch(/permalink|permanent link|immutable/i);
  });

  it("CSP allows exactly the served script by its static hash, across a 304 round-trip", async () => {
    const first = await get("src/app.ts");
    const html = await first.text();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    const expected = await scriptHashSource(scripts[0]!);
    const csp = first.headers.get("content-security-policy")!;
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBe(`script-src '${expected}'`);
    expect(csp).not.toMatch(/nonce-|'unsafe-inline'[^;]*script|script-src[^;]*'unsafe-inline'/);
    const etag = first.headers.get("etag")!;
    const cond = await get("src/app.ts", { ...NAV, "If-None-Match": etag });
    expect(cond.status).toBe(304);
    expect(cond.headers.get("etag")).toBe(etag);
    const condCsp = cond.headers.get("content-security-policy") ?? "";
    const condScriptSrc = condCsp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
    if (condScriptSrc) expect(condScriptSrc).toContain(`'${expected}'`);
    // The hash is static (not a per-response nonce): a fresh 200 after the
    // conditional request serves the identical script and hash.
    const again = await (await get("src/app.ts")).text();
    const againScripts = [...again.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(againScripts).toEqual(scripts);
  });

  it("render identity is bumped past the pre-feature code@1", async () => {
    const res = await get("src/app.ts");
    const etag = res.headers.get("etag")!;
    const m = /^W\/"code@(\d+)-[a-f0-9]{64}"$/.exec(etag);
    expect(m, etag).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(2);
    await res.text();
  });

  it("the source view of an HTML file gets the same range toolbar", async () => {
    const res = await get("index.html?view=source");
    expect(res.headers.get("x-kofra-viewer")).toBe("source");
    const html = await res.text();
    const lines = lineIds(html);
    expect(lines.length).toBeGreaterThan(0);
    expectRangeControls(html, lines[lines.length - 1]!);
  });

  it("raw and download bytes are byte-identical to the published files", async () => {
    for (const [path, source] of [["src/app.ts", APP_TS], ["big.txt", BIG_TXT]] as const) {
      const expected = await sha256Hex(new TextEncoder().encode(source));
      for (const suffix of ["?raw=1", "?download=1"]) {
        const res = await get(path + suffix);
        expect(res.headers.get("x-kofra-viewer"), path + suffix).toBeNull();
        expect(await sha256Hex(new Uint8Array(await res.arrayBuffer())), path + suffix).toBe(expected);
      }
    }
  });

  it("truncated source: the note stays, only rendered lines exist, inputs stop at the last rendered line", async () => {
    const html = await (await get("big.txt")).text();
    expect(visibleText(html)).toMatch(/Showing the first/i);
    const lines = lineIds(html);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(20);
    expect(html).not.toContain('<a href="#L20"');
    expectRangeControls(html, lines[lines.length - 1]!);
  });
});
