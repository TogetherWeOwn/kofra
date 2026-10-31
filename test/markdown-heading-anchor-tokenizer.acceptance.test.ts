/**
 * Protected acceptance: reserve only headings the production tokenizer serves,
 * in effective output order. The paired implementation must not edit this file.
 * Expectations are hand-derived from the compatibility contract and checked
 * against baseline workerd output, not an independent HTML scanner.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { renderMarkdown } from "../packages/server/src/viewers/markdown";
import { sanitizeHtml } from "../packages/server/src/viewers/sanitize";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };

const fixtures: Record<string, string> = {
  "inline-owner.md": '## Notes <h2 id="notes"></h2>\n',
  "inline-following.md": '## Notes <h2 id="install"></h2>\n\n## Install\n',
  "frame.md": '<frame><h2 id="install">Ghost</h2></frame>\n\n## Install\n',
  "script-double-escaped.md": '<script>\x3c!--<script></script><h2 id="install">Ghost</h2>--></script>\n\n## Install\n',
  "ancestor-div.md": '<div><template></div><h2 id="install">Raw</h2>\n\n## Install\n',
  "ancestor-p.md": '<p><template></p><h2 id="install">Raw</h2>\n\n## Install\n',
  "ancestor-section.md": '<section><template></section><h2 id="install">Raw</h2>\n\n## Install\n',
  "ancestor-span.md": '<span><template></span><h2 id="install">Raw</h2>\n\n## Install\n',
  "ancestor-blockquote.md": '<blockquote><template></blockquote><h2 id="install">Raw</h2>\n\n## Install\n',
  "abrupt-empty.md": '\x3c!--><h2 id="install">Raw</h2>\n\n## Install\n',
  "abrupt-dash.md": '\x3c!---><h2 id="install">Raw</h2>\n\n## Install\n',
  "recovery-empty.md": '\x3c!-->\n\nRecovered paragraph.\n\n<h2 id="install">Raw</h2>\n\n## Install\n\n<h2 id="other">Other raw</h2>\n\n## Other\n',
  "recovery-dash.md": '\x3c!--->\n\nRecovered paragraph.\n\n<h2 id="install">Raw</h2>\n\n## Install\n\n<h2 id="other">Other raw</h2>\n\n## Other\n',
  "token-boundary.md": '# T\n\n<h2 id="victim"\n\ntext\n\n<h2 id="other">O</h2>\n\n## Victim\n',
  "duplicate-attributes.md": '<h2 id="install" id="other">Raw</h2>\n\n## Install\n',
  "future-raw-suffix.md": '<h2 id="notes">Raw Notes</h2>\n\n## Notes\n\n<h2 id="notes-1">Future Raw</h2>\n',
  "void-meta.md": '<meta><h2 id="install">Raw</h2>\n\n## Install\n',
};

interface Heading {
  id: string | null;
  text: string;
}

async function inspect(html: string, scope = "article.dw-md"): Promise<{ headings: Heading[]; links: string[] }> {
  const headings: Heading[] = [];
  const links: string[] = [];
  const prefix = scope ? `${scope} ` : "";
  await new HTMLRewriter()
    .on([1, 2, 3, 4, 5, 6].map((n) => `${prefix}h${n}`).join(","), {
      element(el) {
        headings.push({ id: el.getAttribute("id"), text: "" });
      },
      text(chunk) {
        headings[headings.length - 1]!.text += chunk.text;
      },
    })
    .on(`${prefix}a.dw-anchor`, {
      element(el) {
        links.push(el.getAttribute("href")!);
      },
    })
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    .text();
  return { headings, links };
}

function expectUnambiguousLinks(headings: Heading[], links: string[]) {
  for (const link of links) {
    expect(headings.filter((h) => h.id === link.slice(1)), `${link} has exactly one served heading destination`).toHaveLength(1);
  }
}

describe("Markdown anchors follow the served workerd tokenizer", () => {
  let dw: Instance;
  let slug: string;

  beforeAll(async () => {
    dw = await freshInstance();
    const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(fixtures) });
    expect(published.status).toBe(201);
    slug = published.body.slug;
  });

  const page = async (path: string) => {
    const res = await dw.call(`/s/${slug}/${path}`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("markdown");
    return res.text();
  };

  it("keeps the outer Markdown heading as the first #notes owner before its inline raw child", async () => {
    const { headings, links } = await inspect(await page("inline-owner.md"));
    // Both ids predate this fix. Moving the first, reachable owner is forbidden;
    // this is deliberately not a request to deduplicate the later raw heading.
    expect(headings.map((h) => h.id)).toEqual(["notes", "notes"]);
    expect(headings[0]!.text).toBe("Notes ");
    expect(links).toEqual(["#notes"]);
  });

  it("still reserves an inline raw id for a subsequent Markdown heading", async () => {
    const { headings, links } = await inspect(await page("inline-following.md"));
    expect(headings.map((h) => h.id)).toEqual(["notes", "install", "install-1"]);
    expect(links).toEqual(["#notes", "#install-1"]);
    expectUnambiguousLinks(headings, links);
  });

  it.each(["frame.md", "script-double-escaped.md"])(
    "does not reserve the Ghost heading actually removed from %s",
    async (path) => {
      const html = await page(path);
      expect(html).not.toContain("Ghost");
      const { headings, links } = await inspect(html);
      expect(headings.map((h) => h.id)).toEqual(["install"]);
      expect(headings[0]!.text).toBe("Install#");
      expect(links).toEqual(["#install"]);
      expectUnambiguousLinks(headings, links);
    },
  );

  it.each(["div", "p", "section", "span", "blockquote"])(
    "recognizes the raw heading served after a %s close ends template removal",
    async (tag) => {
      const { headings, links } = await inspect(await page(`ancestor-${tag}.md`));
      expect(headings.map((h) => h.id)).toEqual(["install", "install-1"]);
      expect(headings[0]!.text).toBe("Raw");
      expect(links).toEqual(["#install-1"]);
      expectUnambiguousLinks(headings, links);
    },
  );

  it.each(["abrupt-empty.md", "abrupt-dash.md"])("reserves the real raw heading after the abrupt comment in %s", async (path) => {
    const { headings, links } = await inspect(await page(path));
    expect(headings.map((h) => h.id)).toEqual(["install", "install-1"]);
    expect(headings[0]!.text).toBe("Raw");
    expect(links).toEqual(["#install-1"]);
    expectUnambiguousLinks(headings, links);
  });

  it.each(["recovery-empty.md", "recovery-dash.md"])("recovers comment state across following generated and raw tokens in %s", async (path) => {
    const html = await page(path);
    expect(html).toContain("Recovered paragraph.");
    const { headings, links } = await inspect(html);
    expect(headings.map((h) => h.id)).toEqual(["install", "install-1", "other", "other-1"]);
    expect(links).toEqual(["#install-1", "#other-1"]);
    expectUnambiguousLinks(headings, links);
  });

  it("reserves a raw id whose tag is completed by generated paragraph markup after an HTML-token boundary", async () => {
    const { headings, links } = await inspect(await page("token-boundary.md"));
    expect(headings.map((h) => h.id)).toEqual(["t", "victim", "other", "victim-1"]);
    expect(headings[1]!.text).toContain("text");
    expect(headings[2]!.text).toBe("O");
    expect(links).toEqual(["#t", "#victim-1"]);
    expectUnambiguousLinks(headings, links);
  });

  it("does not invent a heading from an unfinished raw tag at true fragment EOF", async () => {
    const fragment = await sanitizeHtml(renderMarkdown('# T\n\n<h2 id="discarded"', "eof.md").html);
    // Do not append a closing wrapper here: unlike true EOF, viewer chrome can
    // complete the pending tag, just as generated paragraph markup does above.
    const { headings, links } = await inspect(fragment, "");
    expect(headings.map((h) => h.id)).toEqual(["t"]);
    expect(links).toEqual(["#t"]);
  });

  it("keeps the first duplicate id attribute as the raw heading destination", async () => {
    const { headings, links } = await inspect(await page("duplicate-attributes.md"));
    expect(headings.map((h) => h.id)).toEqual(["install", "install-1"]);
    expect(headings[0]!.text).toBe("Raw");
    expect(links).toEqual(["#install-1"]);
    expectUnambiguousLinks(headings, links);
  });

  it("reserves a later raw suffix owner before moving an already-shadowed Markdown heading", async () => {
    const { headings, links } = await inspect(await page("future-raw-suffix.md"));
    expect(headings.map((h) => h.id)).toEqual(["notes", "notes-2", "notes-1"]);
    expect(headings.find((h) => h.id === "notes-1")!.text).toBe("Future Raw");
    expect(links).toEqual(["#notes-2"]);
    expectUnambiguousLinks(headings, links);
  });

  it("does not treat a void meta tag as containing the following served raw heading", async () => {
    const { headings, links } = await inspect(await page("void-meta.md"));
    // The real sanitizer keeps this heading, unlike the closed-frame fixture.
    expect(headings.map((h) => h.id)).toEqual(["install", "install-1"]);
    expect(headings[0]!.text).toBe("Raw");
    expect(links).toEqual(["#install-1"]);
    expectUnambiguousLinks(headings, links);
  });
});
