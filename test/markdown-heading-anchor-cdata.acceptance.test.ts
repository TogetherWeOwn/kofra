/**
 * Protected acceptance: foreign CDATA text cannot reserve a phantom heading.
 * The paired implementation must not edit this file. Expectations are literal,
 * checked independently with the real sanitizer/containment and final reparse.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { renderMarkdown } from "../packages/server/src/viewers/markdown";
import { sanitizeHtml } from "../packages/server/src/viewers/sanitize";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
const MARKDOWN = "## Install\n";
type Expected = { headings: readonly (readonly string[])[]; links: readonly string[] };
type Fixture = Expected & { name: string; raw: string };
type Consumer = "cell" | "markdown-output" | "html-output";

const cases: readonly Fixture[] = [
  {
    name: "svg-cdata",
    raw: '<div><svg><![CDATA[> </svg><h2 id="install">Ghost</h2> ]]></svg></div>',
    headings: [["install", "Install#"]], links: ["#install"],
  },
  {
    name: "math-cdata",
    raw: '<div><math><![CDATA[> </math><h2 id="install">Ghost</h2> ]]></math></div>',
    headings: [["install", "Install#"]], links: ["#install"],
  },
  {
    name: "svg-real-after-cdata",
    raw: '<div><svg><![CDATA[> </svg><h2 id="ghost">Ghost</h2> ]]></svg><h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "math-real-after-cdata",
    raw: '<div><math><![CDATA[> </math><h2 id="ghost">Ghost</h2> ]]></math><h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "html-cdata-control",
    raw: '<div><![CDATA[> <h2 id="install">Raw</h2> ]]></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "html-bogus-declaration-control",
    raw: '<div><!fixture> <h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "svg-integration-control",
    raw: '<div><svg><foreignObject><![CDATA[> </svg><h2 id="install">Raw</h2> ]]></foreignObject></svg></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "math-integration-control",
    raw: '<div><math><mtext><![CDATA[> </math><h2 id="install">Raw</h2> ]]></mtext></math></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "svg-lowercase-control",
    raw: '<div><svg><![cdata[> </svg><h2 id="install">Raw</h2> ]]></svg></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "math-lowercase-control",
    raw: '<div><math><![cdata[> </math><h2 id="install">Raw</h2> ]]></math></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "svg-unterminated",
    raw: '<div><svg><![CDATA[> </svg><h2 id="install">Ghost</h2> ',
    headings: [], links: [],
  },
  {
    name: "math-unterminated",
    raw: '<div><math><![CDATA[> </math><h2 id="install">Ghost</h2> ',
    headings: [], links: [],
  },
  {
    name: "svg-extra-bracket-terminator",
    raw: '<div><svg><![CDATA[> </svg><h2 id="install">Ghost</h2> ]]]></svg></div>',
    headings: [["install", "Install#"]], links: ["#install"],
  },
  {
    name: "svg-adjacent-sections-control",
    raw: '<div><svg><![CDATA[> </svg><h2 id="install">Ghost</h2> ]]><![CDATA[> </svg>]]></svg><h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
];

// Containment escapes the entire CDATA section even in HTML/integration-point
// contexts; those raw headings disappear in outputs, not in Markdown cells.
// An unfinished HTML output cannot swallow the following Markdown cell either.
// These are independently observed consumer differences, not scanner-derived.
const outputExpectations: Record<string, Expected> = {
  "html-cdata-control": { headings: [["install", "Install#"]], links: ["#install"] },
  "svg-integration-control": { headings: [["install", "Install#"]], links: ["#install"] },
  "math-integration-control": { headings: [["install", "Install#"]], links: ["#install"] },
};
const htmlOutputExpectations: Record<string, Expected> = {
  "svg-unterminated": { headings: [["install", "Install#"]], links: ["#install"] },
  "math-unterminated": { headings: [["install", "Install#"]], links: ["#install"] },
};
const source = (fixture: Fixture) => `${fixture.raw}\n\n${MARKDOWN}`;
function notebook(fixture: Fixture, consumer: Consumer) {
  const markdownCell = (text: string) => ({ cell_type: "markdown", metadata: {}, source: text });
  const outputCell = (mime: string, text: string) => ({
    cell_type: "code", metadata: {}, source: "", execution_count: null,
    outputs: [{ output_type: "display_data", metadata: {}, data: { [mime]: text } }],
  });
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

async function expectDestinations(html: string, scope: string, expected: Expected) {
  const headings: Array<[string | null, string]> = [];
  const links: string[] = [];
  await new HTMLRewriter()
    .on([1, 2, 3, 4, 5, 6].map((n) => `${scope} h${n}`).join(","), {
      element(el) { headings.push([el.getAttribute("id"), ""]); },
      text(chunk) { headings[headings.length - 1]![1] += chunk.text; },
    })
    .on(`${scope} a.dw-anchor`, { element(el) { links.push(el.getAttribute("href")!); } })
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    .text();
  expect.soft(headings).toEqual(expected.headings);
  expect.soft(links).toEqual(expected.links);
  for (const link of links) {
    expect(headings.filter(([id]) => id === link.slice(1)), `${link} has exactly one final destination`).toEqual([[link.slice(1), "Install#"]]);
  }
}

describe("Markdown anchors do not reserve foreign CDATA text", () => {
  it.each(cases)("keeps synchronous helper destinations after sanitizer reparse for $name", async (fixture) => {
    const rendered = renderMarkdown(source(fixture), `${fixture.name}.md`);
    expect(rendered).not.toBeInstanceOf(Promise);
    expect(typeof rendered.html).toBe("string");
    const sanitized = await sanitizeHtml(rendered.html);
    await expectDestinations(`<article class="dw-md">${sanitized}</article>`, "article.dw-md", fixture);
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
      await expectDestinations(await page(`${fixture.name}.md`, "markdown"), "article.dw-md", fixture);
    });
    describe.each(["cell", "markdown-output", "html-output"] as const)("notebook %s", (consumer) => {
      it.each(cases)("keeps notebook HTTP destinations after final reparse for $name", async (fixture) => {
        const expected = consumer === "cell" ? fixture
          : (consumer === "html-output" ? htmlOutputExpectations[fixture.name] : undefined) ?? outputExpectations[fixture.name] ?? fixture;
        await expectDestinations(await page(`${fixture.name}-${consumer}.ipynb`, "notebook"), "main.dw-nb", expected);
      });
    });
  });
});
