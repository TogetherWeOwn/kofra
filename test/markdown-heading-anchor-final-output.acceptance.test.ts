/**
 * Protected acceptance: only headings in the final reparsed viewer output may
 * reserve fragment destinations. The paired implementation must not edit this
 * file. Sanitizer-created seams and tag names are checked through real workerd
 * output, with literal expected destinations rather than a second scanner.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { renderMarkdown } from "../packages/server/src/viewers/markdown";
import { sanitizeHtml } from "../packages/server/src/viewers/sanitize";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
const MARKDOWN = "## Install\n";

const cases = [
  {
    name: "comment-seam-empty",
    raw: '<div><<!-->!<h2 id="install">Ghost</h2></div>',
    headings: [["install", "Install#"]],
    links: ["#install"],
  },
  {
    name: "comment-seam-dash",
    raw: '<div><<!--->!<h2 id="install">Ghost</h2></div>',
    headings: [["install", "Install#"]],
    links: ["#install"],
  },
  {
    name: "comment-seam-ordinary",
    raw: '<div><<!--x-->!<h2 id="install">Ghost</h2></div>',
    headings: [["install", "Install#"]],
    links: ["#install"],
  },
  {
    name: "distinct-unicode-names",
    raw: '<div><xİ><template></xi̇><h2 id="install">Ghost</h2></div>',
    headings: [["install", "Install#"]],
    links: ["#install"],
  },
  // Matching Unicode names really end the ancestor and its dropped template.
  {
    name: "matching-unicode-control",
    raw: '<div><xİ><template></xİ><h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]],
    links: ["#install-1"],
  },
  {
    name: "ascii-case-control",
    raw: '<div><XWIDGET><template></xwidget><h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]],
    links: ["#install-1"],
  },
  // Without either side of the `<` + `!` seam, comment removal must leave
  // the real raw heading reachable and reserve its destination.
  {
    name: "no-left-lt-empty-control",
    raw: '<div><!-->!<h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]],
    links: ["#install-1"],
  },
  {
    name: "no-left-lt-dash-control",
    raw: '<div><!--->!<h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]],
    links: ["#install-1"],
  },
  {
    name: "no-left-lt-ordinary-control",
    raw: '<div><!--x-->!<h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]],
    links: ["#install-1"],
  },
  {
    name: "no-right-bang-control",
    raw: '<div><<!--x--><h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]],
    links: ["#install-1"],
  },
] as const;

type Case = (typeof cases)[number];
type Consumer = "cell" | "markdown-output" | "html-output";

function source(fixture: Case) {
  return `${fixture.raw}\n\n${MARKDOWN}`;
}

function notebook(fixture: Case, consumer: Consumer) {
  const markdownCell = (text: string) => ({ cell_type: "markdown", metadata: {}, source: text });
  const outputCell = (mime: string, text: string) => ({
    cell_type: "code", metadata: {}, source: "", execution_count: null,
    outputs: [{ output_type: "display_data", metadata: {}, data: { [mime]: text } }],
  });
  // text/html is not Markdown: put the exact raw prefix in that output and
  // the generated Install heading in the following real Markdown cell.
  const cells = consumer === "cell"
    ? [markdownCell(source(fixture))]
    : consumer === "markdown-output"
      ? [outputCell("text/markdown", source(fixture))]
      : [outputCell("text/html", fixture.raw), markdownCell(MARKDOWN)];
  return JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 });
}

const fixtures: Record<string, string> = {};
for (const fixture of cases) {
  fixtures[`${fixture.name}.md`] = source(fixture);
  for (const consumer of ["cell", "markdown-output", "html-output"] as const) {
    fixtures[`${fixture.name}-${consumer}.ipynb`] = notebook(fixture, consumer);
  }
}

async function expectFinalDestinations(html: string, scope: string, fixture: Case) {
  const headings: Array<[string | null, string]> = [];
  const links: string[] = [];
  // This is a NEW parse of already-sanitized, fully wrapped output, not a
  // handler attached to the sanitizer's first pass over the source bytes.
  await new HTMLRewriter()
    .on([1, 2, 3, 4, 5, 6].map((n) => `${scope} h${n}`).join(","), {
      element(el) {
        headings.push([el.getAttribute("id"), ""]);
      },
      text(chunk) {
        headings[headings.length - 1]![1] += chunk.text;
      },
    })
    .on(`${scope} a.dw-anchor`, {
      element(el) {
        links.push(el.getAttribute("href")!);
      },
    })
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    .text();
  expect.soft(headings).toEqual(fixture.headings);
  expect.soft(links).toEqual(fixture.links);
  for (const link of links) {
    expect(headings.filter(([id]) => id === link.slice(1)), `${link} has exactly one final heading destination`).toHaveLength(1);
  }
}

describe("Markdown anchors follow final output interpretation", () => {
  it.each(cases)("keeps synchronous helper destinations after sanitizer reparse for $name", async (fixture) => {
    const rendered = renderMarkdown(source(fixture), `${fixture.name}.md`);
    expect(rendered).not.toBeInstanceOf(Promise);
    expect(typeof rendered.html).toBe("string");
    const sanitized = await sanitizeHtml(rendered.html);
    await expectFinalDestinations(`<article class="dw-md">${sanitized}</article>`, "article.dw-md", fixture);
  });

  describe("actual HTTP viewers", () => {
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

    it.each(cases)("keeps Markdown HTTP destinations after final reparse for $name", async (fixture) => {
      await expectFinalDestinations(await page(`${fixture.name}.md`, "markdown"), "article.dw-md", fixture);
    });

    describe.each(["cell", "markdown-output", "html-output"] as const)("notebook %s", (consumer) => {
      it.each(cases)("keeps notebook HTTP destinations after final reparse for $name", async (fixture) => {
        await expectFinalDestinations(await page(`${fixture.name}-${consumer}.ipynb`, "notebook"), "main.dw-nb", fixture);
      });
    });
  });
});
