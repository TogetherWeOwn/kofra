/**
 * Protected acceptance: heading reservations follow the production tokenizer,
 * including abrupt script comments, bogus end tags and DOM character references.
 * The paired implementation must not edit this file. Expected destinations are
 * hand-derived from the compatibility contract, not a second HTML scanner.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { renderMarkdown } from "../packages/server/src/viewers/markdown";
import { sanitizeHtml } from "../packages/server/src/viewers/sanitize";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };

const cases = [
  {
    name: "script-abrupt-empty",
    source: '<h2 id="notes">Raw</h2>\n\n## Notes\n\n<script><!--><script></script><h2 id="notes-1">Future</h2></script>\n',
    headings: [["notes", "Raw"], ["notes-2", "Notes#"], ["notes-1", "Future"]],
    links: ["#notes-2"],
  },
  {
    name: "script-abrupt-dash",
    source: '<h2 id="notes">Raw</h2>\n\n## Notes\n\n<script><!---><script></script><h2 id="notes-1">Future</h2></script>\n',
    headings: [["notes", "Raw"], ["notes-2", "Notes#"], ["notes-1", "Future"]],
    links: ["#notes-2"],
  },
  {
    name: "bogus-end-digit",
    source: '<div></3 <h2 id="install">Not a heading</h2></div>\n\n## Install\n',
    headings: [["install", "Install#"]],
    links: ["#install"],
  },
  {
    name: "bogus-end-space",
    source: '<div></ <h2 id="install">Not a heading</h2></div>\n\n## Install\n',
    headings: [["install", "Install#"]],
    links: ["#install"],
  },
  {
    name: "bogus-end-question",
    source: '<div></? <h2 id="install">Not a heading</h2></div>\n\n## Install\n',
    headings: [["install", "Install#"]],
    links: ["#install"],
  },
  // Unlike a bogus end-tag comment, neither control consumes the next h2.
  {
    name: "empty-end-control",
    source: '<div></><h2 id="install">Raw</h2></div>\n\n## Install\n',
    headings: [["install", "Raw"], ["install-1", "Install#"]],
    links: ["#install-1"],
  },
  {
    name: "ordinary-text-control",
    source: '<div>Ordinary text <h2 id="install">Raw</h2></div>\n\n## Install\n',
    headings: [["install", "Raw"], ["install-1", "Install#"]],
    links: ["#install-1"],
  },
  // HTMLRewriter exposes the authored attribute spelling. Preserve it exactly;
  // the allocated Markdown id must skip the future heading's decoded DOM id.
  {
    name: "named-reference-future",
    source: '<h2 id="æ">Raw</h2>\n\n## æ\n\n<h2 id="&aelig;-1">Future</h2>\n',
    headings: [["æ", "Raw"], ["æ-2", "æ#"], ["&aelig;-1", "Future"]],
    links: ["#æ-2"],
  },
  {
    name: "c1-reference-future",
    source: '<h2 id="ƒ">Raw</h2>\n\n## ƒ\n\n<h2 id="&#131;-1">Future</h2>\n',
    headings: [["ƒ", "Raw"], ["ƒ-2", "ƒ#"], ["&#131;-1", "Future"]],
    links: ["#ƒ-2"],
  },
  {
    name: "named-literal-control",
    source: '<h2 id="æ">Raw</h2>\n\n## æ\n\n<h2 id="æ-1">Future</h2>\n',
    headings: [["æ", "Raw"], ["æ-2", "æ#"], ["æ-1", "Future"]],
    links: ["#æ-2"],
  },
  {
    name: "c1-literal-control",
    source: '<h2 id="ƒ">Raw</h2>\n\n## ƒ\n\n<h2 id="ƒ-1">Future</h2>\n',
    headings: [["ƒ", "Raw"], ["ƒ-2", "ƒ#"], ["ƒ-1", "Future"]],
    links: ["#ƒ-2"],
  },
  {
    name: "unknown-reference-control",
    source: '<h2 id="æ">Raw</h2>\n\n## æ\n\n<h2 id="&kofraUnknown;-1">Future</h2>\n',
    headings: [["æ", "Raw"], ["æ-1", "æ#"], ["&kofraUnknown;-1", "Future"]],
    links: ["#æ-1"],
  },
] as const;

type Case = (typeof cases)[number];

async function inspect(html: string, scope: string) {
  const headings: Array<[string | null, string]> = [];
  const links: string[] = [];
  const prefix = scope ? `${scope} ` : "";
  await new HTMLRewriter()
    .on([1, 2, 3, 4, 5, 6].map((n) => `${prefix}h${n}`).join(","), {
      element(el) {
        headings.push([el.getAttribute("id"), ""]);
      },
      text(chunk) {
        headings[headings.length - 1]![1] += chunk.text;
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

async function expectDestinations(html: string, scope: string, fixture: Case) {
  const { headings, links } = await inspect(html, scope);
  expect(headings).toEqual(fixture.headings);
  expect(links).toEqual(fixture.links);
  for (const link of links) {
    expect(headings.filter(([id]) => id === link.slice(1)), `${link} has exactly one served heading destination`).toHaveLength(1);
  }
}

function notebook(source: string, consumer: "cell" | "output") {
  const cell = consumer === "cell"
    ? { cell_type: "markdown", metadata: {}, source }
    : {
      cell_type: "code", metadata: {}, source: "", execution_count: null,
      outputs: [{ output_type: "display_data", metadata: {}, data: { "text/markdown": source } }],
    };
  return JSON.stringify({ cells: [cell], metadata: {}, nbformat: 4, nbformat_minor: 5 });
}

const fixtures: Record<string, string> = {};
for (const fixture of cases) {
  fixtures[`${fixture.name}.md`] = fixture.source;
  fixtures[`${fixture.name}-cell.ipynb`] = notebook(fixture.source, "cell");
  fixtures[`${fixture.name}-output.ipynb`] = notebook(fixture.source, "output");
}

describe("Markdown tokenizer transitions preserve existing destinations", () => {
  it.each(cases)("keeps synchronous helper destinations for $name", async (fixture) => {
    const rendered = renderMarkdown(fixture.source, `${fixture.name}.md`);
    expect(rendered).not.toBeInstanceOf(Promise);
    expect(typeof rendered.html).toBe("string");
    await expectDestinations(await sanitizeHtml(rendered.html), "", fixture);
  });

  describe("served Worker viewers", () => {
    let dw: Instance;
    let slug: string;

    beforeAll(async () => {
      dw = await freshInstance();
      const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(fixtures) });
      expect(published.status).toBe(201);
      slug = published.body.slug;
    });

    const page = async (path: string, viewer: "markdown" | "notebook") => {
      const res = await dw.call(`/s/${slug}/${path}`, { headers: NAV });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-kofra-viewer")).toBe(viewer);
      return res.text();
    };

    it.each(cases)("keeps Markdown HTTP destinations for $name", async (fixture) => {
      await expectDestinations(await page(`${fixture.name}.md`, "markdown"), "article.dw-md", fixture);
    });

    describe.each(["cell", "output"] as const)("notebook Markdown %s", (consumer) => {
      it.each(cases)("keeps notebook HTTP destinations for $name", async (fixture) => {
        await expectDestinations(await page(`${fixture.name}-${consumer}.ipynb`, "notebook"), "main.dw-nb", fixture);
      });
    });
  });
});
