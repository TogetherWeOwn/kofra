/**
 * Protected acceptance: raw owners follow sanitizer removal lifetimes, not the
 * namespace of a later heading or a blanket foreign-root deletion rule.
 * The paired implementation must not edit this file. These frozen literals
 * deliberately remain unbalanced; output containment is tested as served.
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
  name: string; raw: string; heading: "I" | "Install";
  expected: Destinations;
  markdownOutput?: Destinations;
};
type Consumer = "cell" | "markdown-output" | "html-output";

// Literal expectations checked with the unchanged sanitizer and a prewritten,
// noncolliding sentinel, then reparsed inside each real consumer's wrapper.
// No Markdown renderer or reservation scanner supplied those oracle values.
const rawI: Destinations = {
  ids: [["h2", "i"], ["h2", "i-1"]],
  headings: [["i", "H"], ["i-1", "I#"]], links: ["#i-1"],
};
const onlyI: Destinations = {
  ids: [["h2", "i"]], headings: [["i", "I#"]], links: ["#i"],
};
const rawInstall: Destinations = {
  ids: [["h2", "install"], ["h2", "install-1"]],
  headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
};
const onlyInstall: Destinations = {
  ids: [["h2", "install"]], headings: [["install", "Install#"]], links: ["#install"],
};
const absent: Destinations = { ids: [], headings: [], links: [] };

const cases: readonly Fixture[] = [
  {
    name: "published-span", raw: '<div><svg/><span><input><h2 id="i">H</h2></span></div>', heading: "I",
    expected: rawI,
  },
  {
    name: "published-section", raw: '<div><svg/><section><input><h2 id="i">H</h2></section></div>', heading: "I",
    expected: onlyI,
  },
  {
    name: "svg-slash-span-input", raw: '<div><svg/><span><input><h2 id="install">Raw</h2></div>', heading: "Install",
    expected: rawInstall,
  },
  {
    name: "svg-slash-section-input", raw: '<div><svg/><section><input><h2 id="install">Raw</h2></div>', heading: "Install",
    expected: onlyInstall,
  },
  {
    name: "svg-slash-section-checkbox", raw: '<div><svg/><section><input type="checkbox"><h2 id="install">Raw</h2></div>', heading: "Install",
    expected: rawInstall,
  },
  {
    name: "svg-span-checkbox", raw: '<div><svg><span><input type="checkbox"><h2 id="install">Raw</h2></div>', heading: "Install",
    expected: onlyInstall, markdownOutput: absent,
  },
  {
    name: "math-slash-span-input", raw: '<div><math/><span><input><h2 id="install">Raw</h2></div>', heading: "Install",
    expected: rawInstall,
  },
  {
    name: "math-slash-section-input", raw: '<div><math/><section><input><h2 id="install">Raw</h2></div>', heading: "Install",
    expected: onlyInstall,
  },
  {
    name: "math-slash-section-checkbox", raw: '<div><math/><section><input type="checkbox"><h2 id="install">Raw</h2></div>', heading: "Install",
    expected: rawInstall,
  },
  {
    name: "math-span-checkbox", raw: '<div><math><span><input type="checkbox"><h2 id="install">Raw</h2></div>', heading: "Install",
    expected: onlyInstall, markdownOutput: absent,
  },
];

const source = (fixture: Fixture) => `${fixture.raw}\n\n## ${fixture.heading}\n`;
function notebook(fixture: Fixture, consumer: Consumer) {
  const markdownCell = (text: string) => ({ cell_type: "markdown", metadata: {}, source: text });
  const outputCell = (mime: string, text: string) => ({
    cell_type: "code", metadata: {}, source: "", execution_count: null,
    outputs: [{ output_type: "display_data", metadata: {}, data: { [mime]: text } }],
  });
  // Independently verified: an open foreign root consumes the Markdown-output
  // tail in the two absent rows. A separate HTML output cannot eat the next cell.
  const cells = consumer === "cell" ? [markdownCell(source(fixture))]
    : consumer === "markdown-output" ? [outputCell("text/markdown", source(fixture))]
      : [outputCell("text/html", fixture.raw), markdownCell(`## ${fixture.heading}\n`)];
  return JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 });
}

const fixtures: Record<string, string> = {};
for (const fixture of cases) {
  fixtures[`${fixture.name}.md`] = source(fixture);
  for (const consumer of ["cell", "markdown-output", "html-output"] as const) {
    fixtures[`${fixture.name}-${consumer}.ipynb`] = notebook(fixture, consumer);
  }
}

async function expectDestinations(html: string, scope: string, expected: Destinations, heading: string) {
  const ids: Array<[string, string | null]> = [];
  const headings: Array<[string | null, string]> = [];
  const links: string[] = [];
  // Reparse already-sanitized, fully wrapped output, not sanitizer callbacks on
  // the original input: a callback alone does not prove a reachable destination.
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
    expect(headings.filter(([id]) => id === link.slice(1)), `${link} first resolves only to the Markdown heading`)
      .toEqual([[link.slice(1), `${heading}#`]]);
    expect(ids.filter(([, id]) => id === link.slice(1)), `${link} has exactly one destination owner`).toHaveLength(1);
  }
}

describe("Markdown anchors honor raw-owner removal lifetimes", () => {
  it.each(cases)("keeps synchronous helper destinations for $name", async (fixture) => {
    const rendered = renderMarkdown(source(fixture), `${fixture.name}.md`);
    expect(rendered).not.toBeInstanceOf(Promise);
    expect(typeof rendered.html).toBe("string");
    const sanitized = await sanitizeHtml(rendered.html);
    await expectDestinations(`<article class="dw-md">${sanitized}</article>`, "article.dw-md", fixture.expected, fixture.heading);
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
      await expectDestinations(await page(`${fixture.name}.md`, "markdown"), "article.dw-md", fixture.expected, fixture.heading);
    });
    describe.each(["cell", "markdown-output", "html-output"] as const)("notebook %s", (consumer) => {
      it.each(cases)("keeps notebook HTTP destinations for $name", async (fixture) => {
        const expected = consumer === "markdown-output" ? fixture.markdownOutput ?? fixture.expected : fixture.expected;
        await expectDestinations(await page(`${fixture.name}-${consumer}.ipynb`, "notebook"), "main.dw-nb", expected, fixture.heading);
      });
    });
  });
});
