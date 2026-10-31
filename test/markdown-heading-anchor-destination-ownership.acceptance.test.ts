/**
 * Protected acceptance: replacement IDs preserve named destinations, and only
 * surviving generated headings spend replacement suffixes. The paired
 * implementation must not edit this file. These 16 frozen fixtures use literal
 * expectations, not the reservation scanner or a second Markdown allocator.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { renderMarkdown } from "../packages/server/src/viewers/markdown";
import { sanitizeHtml } from "../packages/server/src/viewers/sanitize";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
type Destination = readonly [tag: string, id: string | null, name: string | null, text: string];
type Owner = readonly [fragment: string, tag: string, text: string];
type Expected = { nodes: readonly Destination[]; links: readonly string[]; owners: readonly Owner[] };
type NamedFixture = { name: string; before: string; markdown: string; after: string; expected: Expected };
type GeneratedFixture = {
  name: string; raw: string; open: string; inside: string; close: string; visible: string; after: string;
  expected: Expected; notebook: Expected;
};
type Consumer = "cell" | "markdown-output" | "html-output";

const named: readonly NamedFixture[] = [
  {
    name: "name-after", before: '<h2 id="notes">Raw</h2>', markdown: "## Notes\n", after: '<a name="notes-1">Named after</a>',
    expected: {
      nodes: [["h2", "notes", null, "Raw"], ["h2", "notes-2", null, "Notes#"], ["a", null, "notes-1", "Named after"]],
      links: ["#notes-2"], owners: [["notes", "h2", "Raw"], ["notes-1", "a", "Named after"], ["notes-2", "h2", "Notes#"]],
    },
  },
  {
    name: "name-before", before: '<a name="notes-1">Named before</a>\n<h2 id="notes">Raw</h2>', markdown: "## Notes\n", after: "",
    expected: {
      nodes: [["a", null, "notes-1", "Named before"], ["h2", "notes", null, "Raw"], ["h2", "notes-2", null, "Notes#"]],
      links: ["#notes-2"], owners: [["notes", "h2", "Raw"], ["notes-1", "a", "Named before"], ["notes-2", "h2", "Notes#"]],
    },
  },
  {
    name: "decoded-name-and-id", before: '<h2 id="notes">Raw</h2>', markdown: "## Notes\n", after: '<a id="notes-1" name="notes&#45;2">Dual owner</a>',
    expected: {
      nodes: [["h2", "notes", null, "Raw"], ["h2", "notes-3", null, "Notes#"], ["a", "notes-1", "notes&#45;2", "Dual owner"]],
      links: ["#notes-3"], owners: [["notes-1", "a", "Dual owner"], ["notes-2", "a", "Dual owner"], ["notes-3", "h2", "Notes#"]],
    },
  },
  {
    name: "non-destinations", before: '<h2 id="notes">Raw</h2>', markdown: "## Notes\n",
    after: '<span name="notes-1">Non-anchor</span><a data-name="notes-1">Stripped attribute</a><a name="">Empty</a>',
    expected: {
      nodes: [["h2", "notes", null, "Raw"], ["h2", "notes-1", null, "Notes#"], ["a", null, "", "Empty"]],
      links: ["#notes-1"], owners: [["notes", "h2", "Raw"], ["notes-1", "h2", "Notes#"]],
    },
  },
  {
    name: "removed-name", before: '<h2 id="notes">Raw</h2>', markdown: "## Notes\n", after: '<template><a name="notes-1">Removed</a></template>',
    expected: {
      nodes: [["h2", "notes", null, "Raw"], ["h2", "notes-1", null, "Notes#"]],
      links: ["#notes-1"], owners: [["notes", "h2", "Raw"], ["notes-1", "h2", "Notes#"]],
    },
  },
  {
    // Named/non-heading owners alone deliberately do not trigger relocation.
    name: "named-only-no-trigger", before: '<a name="notes">Existing name</a>', markdown: "## Notes\n", after: "",
    expected: {
      nodes: [["a", null, "notes", "Existing name"], ["h2", "notes", null, "Notes#"]],
      links: ["#notes"], owners: [["notes", "h2", "Notes#"]],
    },
  },
  {
    name: "nonheading-only-no-trigger", before: '<div id="notes">Existing div</div>', markdown: "## Notes\n", after: '<a name="notes-1">Named after</a>',
    expected: {
      nodes: [["div", "notes", null, "Existing div"], ["h2", "notes", null, "Notes#"], ["a", null, "notes-1", "Named after"]],
      links: ["#notes"], owners: [["notes", "div", "Existing div"], ["notes-1", "a", "Named after"]],
    },
  },
  {
    name: "id-precedes-name", before: '<a name="notes-1">Earlier name</a>\n<h2 id="notes">Raw</h2>', markdown: "## Notes\n", after: '<div id="notes-1">ID owner</div>',
    expected: {
      nodes: [["a", null, "notes-1", "Earlier name"], ["h2", "notes", null, "Raw"], ["h2", "notes-2", null, "Notes#"], ["div", "notes-1", null, "ID owner"]],
      links: ["#notes-2"], owners: [["notes-1", "div", "ID owner"], ["notes-2", "h2", "Notes#"]],
    },
  },
  {
    name: "first-named-owner", before: '<h2 id="notes">Raw</h2>', markdown: "## Notes\n", after: '<a name="notes-1">First name</a><a name="notes-1">Second name</a>',
    expected: {
      nodes: [["h2", "notes", null, "Raw"], ["h2", "notes-2", null, "Notes#"], ["a", null, "notes-1", "First name"], ["a", null, "notes-1", "Second name"]],
      links: ["#notes-2"], owners: [["notes-1", "a", "First name"], ["notes-2", "h2", "Notes#"]],
    },
  },
  {
    name: "case-distinct-name", before: '<h2 id="notes">Raw</h2>', markdown: "## Notes\n", after: '<a name="Notes-1">Case distinct</a>',
    expected: {
      nodes: [["h2", "notes", null, "Raw"], ["h2", "notes-1", null, "Notes#"], ["a", null, "Notes-1", "Case distinct"]],
      links: ["#notes-1"], owners: [["Notes-1", "a", "Case distinct"], ["notes-1", "h2", "Notes#"]],
    },
  },
];

const movedOnce: Expected = {
  nodes: [["h2", "notes", null, "Raw"], ["h2", "notes-1", null, "Notes#"]],
  links: ["#notes-1"], owners: [["notes", "h2", "Raw"], ["notes-1", "h2", "Notes#"]],
};
const twoWithinFragment: Expected = {
  nodes: [["h2", "notes", null, "Raw"], ["h2", "notes-2", null, "Notes#"], ["h2", "notes-1", null, "Notes#"]],
  links: ["#notes-2", "#notes-1"], owners: [["notes", "h2", "Raw"], ["notes-1", "h2", "Notes#"], ["notes-2", "h2", "Notes#"]],
};
const twoAcrossFragments: Expected = {
  nodes: [["h2", "notes", null, "Raw"], ["h2", "notes-1", null, "Notes#"], ["h2", "notes-2", null, "Notes#"]],
  links: ["#notes-1", "#notes-2"], owners: [["notes", "h2", "Raw"], ["notes-1", "h2", "Notes#"], ["notes-2", "h2", "Notes#"]],
};
const generated: readonly GeneratedFixture[] = [
  {
    name: "template-dropped", raw: '<h2 id="notes">Raw</h2>', open: "<template>", inside: "## Notes\n", close: "</template>", visible: "## Notes\n", after: "",
    expected: movedOnce, notebook: movedOnce,
  },
  {
    name: "closed-details-survives", raw: '<h2 id="notes">Raw</h2>', open: "<details>", inside: "## Notes\n", close: "</details>", visible: "## Notes\n", after: "",
    expected: twoWithinFragment, notebook: twoAcrossFragments,
  },
  {
    name: "aria-css-hidden-survives", raw: '<h2 id="notes">Raw</h2>', open: '<div aria-hidden="true" style="display:none">', inside: "## Notes\n", close: "</div>", visible: "## Notes\n", after: "",
    expected: twoWithinFragment, notebook: twoAcrossFragments,
  },
  {
    name: "template-future-reservation", raw: '<h2 id="notes">Raw</h2>', open: "<template>", inside: "## Notes\n", close: "</template>", visible: "## Notes\n", after: '<div id="notes-1">Future</div>',
    // The visible standalone heading already owns historical baseline notes-1.
    // Notebook fragments reset Marked's counter, so a replacement must skip it.
    expected: {
      nodes: [["h2", "notes", null, "Raw"], ["h2", "notes-1", null, "Notes#"], ["div", "notes-1", null, "Future"]],
      links: ["#notes-1"], owners: [["notes-1", "h2", "Notes#"]],
    },
    notebook: {
      nodes: [["h2", "notes", null, "Raw"], ["h2", "notes-2", null, "Notes#"], ["div", "notes-1", null, "Future"]],
      links: ["#notes-2"], owners: [["notes-1", "div", "Future"], ["notes-2", "h2", "Notes#"]],
    },
  },
  {
    name: "template-historical-counters", raw: '<h2 id="notes">Raw</h2>', open: "<template>", inside: "## Notes\n\n## Notes\n", close: "</template>", visible: "## Notes\n", after: "",
    expected: {
      nodes: [["h2", "notes", null, "Raw"], ["h2", "notes-2", null, "Notes#"]],
      links: ["#notes-2"], owners: [["notes", "h2", "Raw"], ["notes-2", "h2", "Notes#"]],
    },
    notebook: movedOnce,
  },
  {
    name: "template-nonheading-no-trigger", raw: '<div id="notes">Raw div</div>', open: "<template>", inside: "## Notes\n", close: "</template>", visible: "## Notes\n", after: "",
    expected: {
      nodes: [["div", "notes", null, "Raw div"], ["h2", "notes-1", null, "Notes#"]],
      links: ["#notes-1"], owners: [["notes", "div", "Raw div"], ["notes-1", "h2", "Notes#"]],
    },
    notebook: {
      nodes: [["div", "notes", null, "Raw div"], ["h2", "notes", null, "Notes#"]],
      links: ["#notes"], owners: [["notes", "div", "Raw div"]],
    },
  },
];

const markdownCell = (source: string) => ({ cell_type: "markdown", metadata: {}, source });
const outputCell = (mime: string, source: string) => ({
  cell_type: "code", metadata: {}, source: "", execution_count: null,
  outputs: [{ output_type: "display_data", metadata: {}, data: { [mime]: source } }],
});
const notebook = (cells: unknown[]) => JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 });
const namedSource = (fixture: NamedFixture) => `${fixture.before}\n\n${fixture.markdown}${fixture.after ? `\n${fixture.after}\n` : ""}`;
const hiddenSource = (fixture: GeneratedFixture, includeRaw = true) => `${includeRaw ? `${fixture.raw}\n\n` : ""}${fixture.open}\n\n${fixture.inside}\n${fixture.close}\n`;
const visibleSource = (fixture: GeneratedFixture) => `${fixture.visible}${fixture.after ? `\n${fixture.after}\n` : ""}`;
const generatedSource = (fixture: GeneratedFixture) => `${hiddenSource(fixture)}\n${visibleSource(fixture)}`;

function namedNotebook(fixture: NamedFixture, consumer: Consumer) {
  return notebook(consumer === "cell" ? [markdownCell(namedSource(fixture))]
    : consumer === "markdown-output" ? [outputCell("text/markdown", namedSource(fixture))]
      : [outputCell("text/html", fixture.before), markdownCell(fixture.markdown),
        ...(fixture.after ? [outputCell("text/html", fixture.after)] : [])]);
}
function generatedNotebook(fixture: GeneratedFixture, consumer: Consumer) {
  return notebook(consumer === "cell" ? [markdownCell(hiddenSource(fixture)), markdownCell(visibleSource(fixture))]
    : consumer === "markdown-output" ? [outputCell("text/markdown", hiddenSource(fixture)), outputCell("text/markdown", visibleSource(fixture))]
      : [outputCell("text/html", fixture.raw), markdownCell(hiddenSource(fixture, false)), markdownCell(visibleSource(fixture))]);
}

const fixtures: Record<string, string> = {};
for (const fixture of named) {
  fixtures[`${fixture.name}.md`] = namedSource(fixture);
  for (const consumer of ["cell", "markdown-output", "html-output"] as const) fixtures[`${fixture.name}-${consumer}.ipynb`] = namedNotebook(fixture, consumer);
}
for (const fixture of generated) {
  fixtures[`${fixture.name}.md`] = generatedSource(fixture);
  for (const consumer of ["cell", "markdown-output", "html-output"] as const) fixtures[`${fixture.name}-${consumer}.ipynb`] = generatedNotebook(fixture, consumer);
}

async function expectDestinations(html: string, scope: string, expected: Expected) {
  const nodes: Array<[string, string | null, string | null, string]> = [];
  const links: string[] = [];
  await new HTMLRewriter()
    .on(`${scope} [id],${scope} a[name]`, {
      element(el) { nodes.push([el.tagName, el.getAttribute("id"), el.getAttribute("name"), ""]); },
      text(chunk) { nodes[nodes.length - 1]![3] += chunk.text; },
    })
    .on(`${scope} a.dw-anchor`, { element(el) { links.push(el.getAttribute("href")!); } })
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).text();
  expect.soft(nodes, `ordered final destinations: ${JSON.stringify(nodes)}`).toEqual(expected.nodes);
  expect.soft(links, `final heading hrefs: ${JSON.stringify(links)}`).toEqual(expected.links);
  // HTML's indicated-element rule searches ALL IDs before a[name], then uses
  // tree order within that category, with exact case-sensitive equality:
  // https://html.spec.whatwg.org/multipage/browsing-the-web.html#the-indicated-part-of-the-document
  // HTMLRewriter getters preserve authored references. This one literal mapping
  // decodes the frozen decimal-hyphen spelling; no product decoder is the oracle.
  const names: Record<string, string> = { "notes&#45;2": "notes-2" };
  for (const [fragment, tag, text] of expected.owners) {
    const owner = nodes.find(([, id]) => id === fragment)
      ?? nodes.find(([kind, , name]) => kind === "a" && (name === null ? null : names[name] ?? name) === fragment);
    expect.soft(owner && [owner[0], owner[3]], `#${fragment} retains its actual first owner`).toEqual([tag, text]);
  }
}

const all = [...named.map((fixture) => ({ fixture, source: namedSource(fixture) })),
  ...generated.map((fixture) => ({ fixture, source: generatedSource(fixture) }))];

describe("Markdown replacement destination ownership", () => {
  it.each(all)("keeps synchronous helper owners for $fixture.name", async ({ fixture, source }) => {
    const rendered = renderMarkdown(source, `${fixture.name}.md`);
    expect(rendered).not.toBeInstanceOf(Promise);
    expect(typeof rendered.html).toBe("string");
    await expectDestinations(`<article class="dw-md">${await sanitizeHtml(rendered.html)}</article>`, "article.dw-md", fixture.expected);
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
    it.each(all)("keeps Markdown HTTP owners for $fixture.name", async ({ fixture }) => {
      await expectDestinations(await page(`${fixture.name}.md`, "markdown"), "article.dw-md", fixture.expected);
    });
    describe.each(["cell", "markdown-output", "html-output"] as const)("notebook %s", (consumer) => {
      it.each(named)("keeps named HTTP destinations for $name", async (fixture) => {
        await expectDestinations(await page(`${fixture.name}-${consumer}.ipynb`, "notebook"), "main.dw-nb", fixture.expected);
      });
      it.each(generated)("charges only live generated headings for $name", async (fixture) => {
        await expectDestinations(await page(`${fixture.name}-${consumer}.ipynb`, "notebook"), "main.dw-nb", fixture.notebook);
      });
    });
  });
});
