/**
 * Protected acceptance: replacement anchors preserve all surviving destinations,
 * while reservation context follows real sanitizer policy and final output.
 * The paired implementation must not edit this file. Literal expectations were
 * checked with raw HTML plus a prewritten sentinel, without renderMarkdown.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { renderMarkdown } from "../packages/server/src/viewers/markdown";
import { sanitizeHtml } from "../packages/server/src/viewers/sanitize";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
type Destinations = {
  ids: readonly (readonly [string, string])[];
  headings: readonly (readonly [string, string])[];
  links: readonly string[];
};
type Fixture = {
  name: string; before: string; after: string; markdown: string;
  expected: Destinations;
  markdownOutput?: Destinations;
  htmlOutput?: Destinations;
  nonheadingBaseOwner?: boolean;
};
type Consumer = "cell" | "markdown-output" | "html-output";

const installOnly: Destinations = {
  ids: [["h2", "install"]], headings: [["install", "Install#"]], links: ["#install"],
};
const ghostThenInstall: Destinations = {
  ids: [["h2", "install"], ["h2", "install-1"]],
  headings: [["install", "Ghost"], ["install-1", "Install#"]], links: ["#install-1"],
};
const notesMovedOnce: Destinations = {
  ids: [["h2", "notes"], ["h2", "notes-1"]],
  headings: [["notes", "Raw"], ["notes-1", "Notes#"]], links: ["#notes-1"],
};
const futureHeading: Destinations = {
  ids: [["h2", "notes"], ["h2", "notes-2"], ["h2", "notes-1"]],
  headings: [["notes", "Raw"], ["notes-2", "Notes#"], ["notes-1", "Future"]], links: ["#notes-2"],
};
const rawNotes = '<h2 id="notes">Raw</h2>';
const foreignSuffix = (root: string, point: string) => `<div><${root}><${point}/><style></${root}><h2 id="notes-1">Future</h2></style></div>`;
const annotation = (attribute: string) => `<div><math><annotation-xml${attribute}><style></math><h2 id="install">Ghost</h2></style></annotation-xml></math></div>`;

const cases: readonly Fixture[] = [
  {
    name: "future-nonheading-div", before: rawNotes, after: '<div id="notes-1">Later</div>', markdown: "## Notes\n",
    expected: {
      ids: [["h2", "notes"], ["h2", "notes-2"], ["div", "notes-1"]],
      headings: [["notes", "Raw"], ["notes-2", "Notes#"]], links: ["#notes-2"],
    },
  },
  {
    name: "future-nonheading-span", before: rawNotes, after: '<span id="notes-1">Later</span>', markdown: "## Notes\n",
    expected: {
      ids: [["h2", "notes"], ["h2", "notes-2"], ["span", "notes-1"]],
      headings: [["notes", "Raw"], ["notes-2", "Notes#"]], links: ["#notes-2"],
    },
  },
  {
    name: "dropped-future-nonheading-control", before: rawNotes,
    after: '<template><div id="notes-1">Ghost destination</div></template>', markdown: "## Notes\n",
    expected: notesMovedOnce,
  },
  {
    // A non-heading alone must not become a new relocation trigger.
    name: "nonheading-only-control", before: '<div id="install">Raw</div>', after: "", markdown: "## Install\n",
    expected: { ids: [["div", "install"], ["h2", "install"]], headings: [["install", "Install#"]], links: ["#install"] },
    nonheadingBaseOwner: true,
  },
  {
    name: "svg-foreign-object-slash", before: rawNotes, after: foreignSuffix("svg", "foreignObject"), markdown: "## Notes\n",
    expected: futureHeading,
  },
  {
    name: "svg-desc-slash", before: rawNotes, after: foreignSuffix("svg", "desc"), markdown: "## Notes\n",
    expected: futureHeading,
  },
  {
    name: "math-mtext-slash", before: rawNotes, after: foreignSuffix("math", "mtext"), markdown: "## Notes\n",
    expected: futureHeading,
  },
  {
    name: "math-annotation-slash", before: rawNotes, after: foreignSuffix("math", 'annotation-xml encoding="text/html"'), markdown: "## Notes\n",
    expected: futureHeading,
  },
  {
    name: "svg-root-slash-input", before: '<div><svg/><input><h2 id="install">Raw</h2></div>', after: "", markdown: "## Install\n",
    expected: installOnly,
  },
  {
    name: "math-root-slash-input", before: '<div><math/><input><h2 id="install">Raw</h2></div>', after: "", markdown: "## Install\n",
    expected: installOnly,
  },
  {
    name: "html-slash-control", before: rawNotes,
    after: '<div><div/><style></div><h2 id="notes-1">Ghost</h2></style></div>', markdown: "## Notes\n",
    expected: notesMovedOnce,
  },
  {
    name: "kelvin-link", before: '<div><linK><h2 id="install">Raw</h2></linK></div>', after: "", markdown: "## Install\n",
    expected: installOnly,
  },
  {
    // ASCII LINK is a void element; its following heading really survives.
    name: "ascii-link-control", before: '<div><LINK><h2 id="install">Raw</h2></LINK></div>', after: "", markdown: "## Install\n",
    expected: {
      ids: [["h2", "install"], ["h2", "install-1"]],
      headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
    },
  },
  {
    name: "kelvin-structural-identity-control", before: '<div><xK><template></xk><h2 id="install">Ghost</h2></div>', after: "", markdown: "## Install\n",
    expected: installOnly,
    // Containment escapes the mismatched ancestor end inside the template.
    // A Markdown output loses its tail too; a separate cell cannot be swallowed.
    markdownOutput: { ids: [], headings: [], links: [] }, htmlOutput: installOnly,
  },
  {
    name: "annotation-text-html", before: annotation(' encoding="text/html"'), after: "", markdown: "## Install\n",
    expected: installOnly, markdownOutput: ghostThenInstall, htmlOutput: ghostThenInstall,
  },
  {
    name: "annotation-xhtml", before: annotation(' encoding="application/xhtml+xml"'), after: "", markdown: "## Install\n",
    expected: installOnly, markdownOutput: ghostThenInstall, htmlOutput: ghostThenInstall,
  },
  {
    name: "annotation-uppercase-html", before: annotation(' ENCODING="TEXT/HTML"'), after: "", markdown: "## Install\n",
    expected: installOnly, markdownOutput: ghostThenInstall, htmlOutput: ghostThenInstall,
  },
  {
    name: "annotation-mixedcase-xhtml", before: annotation(' encoding="Application/XHTML+XML"'), after: "", markdown: "## Install\n",
    expected: installOnly, markdownOutput: ghostThenInstall, htmlOutput: ghostThenInstall,
  },
  {
    name: "annotation-missing", before: annotation(""), after: "", markdown: "## Install\n",
    expected: ghostThenInstall,
  },
  {
    name: "annotation-empty", before: annotation(' encoding=""'), after: "", markdown: "## Install\n",
    expected: ghostThenInstall,
  },
  {
    name: "annotation-rejected-type", before: annotation(' encoding="text/plain"'), after: "", markdown: "## Install\n",
    expected: ghostThenInstall,
  },
  {
    name: "annotation-rejected-parameters", before: annotation(' encoding="text/html; charset=utf-8"'), after: "", markdown: "## Install\n",
    expected: ghostThenInstall,
  },
  {
    name: "annotation-rejected-spaces", before: annotation(' encoding=" text/html "'), after: "", markdown: "## Install\n",
    expected: ghostThenInstall,
  },
];

const source = (fixture: Fixture) => `${fixture.before}\n\n${fixture.markdown}${fixture.after ? `\n${fixture.after}\n` : ""}`;
function notebook(fixture: Fixture, consumer: Consumer) {
  const markdownCell = (text: string) => ({ cell_type: "markdown", metadata: {}, source: text });
  const outputCell = (mime: string, text: string) => ({
    cell_type: "code", metadata: {}, source: "", execution_count: null,
    outputs: [{ output_type: "display_data", metadata: {}, data: { [mime]: text } }],
  });
  // HTML outputs retain their real ordering around a separate Markdown cell.
  const cells = consumer === "cell" ? [markdownCell(source(fixture))]
    : consumer === "markdown-output" ? [outputCell("text/markdown", source(fixture))]
      : [outputCell("text/html", fixture.before), markdownCell(fixture.markdown),
        ...(fixture.after ? [outputCell("text/html", fixture.after)] : [])];
  return JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 });
}

const fixtures: Record<string, string> = {};
for (const fixture of cases) {
  fixtures[`${fixture.name}.md`] = source(fixture);
  for (const consumer of ["cell", "markdown-output", "html-output"] as const) {
    fixtures[`${fixture.name}-${consumer}.ipynb`] = notebook(fixture, consumer);
  }
}

async function expectDestinations(html: string, scope: string, expected: Destinations, nonheadingBaseOwner = false) {
  const ids: Array<[string, string | null]> = [];
  const headings: Array<[string | null, string]> = [];
  const links: string[] = [];
  // A fresh parse of already-sanitized, fully wrapped output. Include ALL ids:
  // heading-only uniqueness would miss a replacement stealing a div/span id.
  await new HTMLRewriter()
    .on(`${scope} [id]`, { element(el) { ids.push([el.tagName, el.getAttribute("id")]); } })
    .on([1, 2, 3, 4, 5, 6].map((n) => `${scope} h${n}`).join(","), {
      element(el) { headings.push([el.getAttribute("id"), ""]); },
      text(chunk) { headings[headings.length - 1]![1] += chunk.text; },
    })
    .on(`${scope} a.dw-anchor`, { element(el) { links.push(el.getAttribute("href")!); } })
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).text();
  expect.soft(ids).toEqual(expected.ids);
  expect.soft(headings).toEqual(expected.headings);
  expect.soft(links).toEqual(expected.links);
  for (const link of links) {
    expect(headings.filter(([id]) => id === link.slice(1)), `${link} has one final heading`).toHaveLength(1);
    expect(ids.filter(([, id]) => id === link.slice(1)), `${link} preserves its final destination owners`)
      .toHaveLength(nonheadingBaseOwner ? 2 : 1);
  }
}

describe("Markdown anchor destination and parser-policy parity", () => {
  it.each(cases)("keeps synchronous helper destinations for $name", async (fixture) => {
    const rendered = renderMarkdown(source(fixture), `${fixture.name}.md`);
    expect(rendered).not.toBeInstanceOf(Promise);
    expect(typeof rendered.html).toBe("string");
    const sanitized = await sanitizeHtml(rendered.html);
    await expectDestinations(`<article class="dw-md">${sanitized}</article>`, "article.dw-md", fixture.expected, fixture.nonheadingBaseOwner);
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
    it.each(cases)("keeps Markdown HTTP destinations for $name", async (fixture) => {
      await expectDestinations(await page(`${fixture.name}.md`, "markdown"), "article.dw-md", fixture.expected, fixture.nonheadingBaseOwner);
    });
    describe.each(["cell", "markdown-output", "html-output"] as const)("notebook %s", (consumer) => {
      it.each(cases)("keeps notebook HTTP destinations for $name", async (fixture) => {
        const expected = (consumer === "markdown-output" ? fixture.markdownOutput : consumer === "html-output" ? fixture.htmlOutput : undefined) ?? fixture.expected;
        await expectDestinations(await page(`${fixture.name}-${consumer}.ipynb`, "notebook"), "main.dw-nb", expected, fixture.nonheadingBaseOwner);
      });
    });
  });
});
