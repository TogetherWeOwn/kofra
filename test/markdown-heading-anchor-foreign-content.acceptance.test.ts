/**
 * Protected acceptance: raw heading reservations follow the real sanitizer's
 * foreign-content interpretation, not an independent Markdown-side tokenizer.
 * The paired implementation must not edit this file.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { renderMarkdown } from "../packages/server/src/viewers/markdown";
import { sanitizeHtml } from "../packages/server/src/viewers/sanitize";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
const MARKDOWN = "## Install\n";

type Expected = { headings: readonly (readonly string[])[]; links: readonly string[] };
type Fixture = Expected & { name: string; raw: string; markdownFirst?: boolean };
type Consumer = "cell" | "markdown-output" | "html-output";

// Literal destinations, independently checked by sanitizing each raw fragment
// plus a prewritten sentinel heading (no renderMarkdown call in that oracle),
// then reparsing the result. Foreign style/title are not HTML raw-text elements.
const cases: readonly Fixture[] = [
  {
    name: "svg-style",
    raw: '<div><svg><style></svg><h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "math-title",
    raw: '<div><math><title></math><h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "svg-style-self-closing",
    raw: '<div><svg><style/></svg><h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "math-title-self-closing",
    raw: '<div><math><title/></math><h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "svg-self-closing-control",
    raw: '<div><svg/><h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "math-self-closing-control",
    raw: '<div><math/><h2 id="install">Raw</h2></div>',
    headings: [["install", "Raw"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  {
    name: "html-style-control",
    raw: '<div><style></svg><h2 id="install">Ghost</h2></style></div>',
    headings: [["install", "Install#"]], links: ["#install"],
  },
  {
    name: "html-title-control",
    raw: '<div><title></math><h2 id="install">Ghost</h2></title></div>',
    headings: [["install", "Install#"]], links: ["#install"],
  },
  {
    name: "html-style-self-closing-control",
    raw: '<div><style/><h2 id="install">Ghost</h2></style></div>',
    headings: [["install", "Install#"]], links: ["#install"],
  },
  {
    name: "svg-integration-point-control",
    raw: '<div><svg><foreignObject><style></svg><h2 id="install">Ghost</h2></style></foreignObject></svg></div>',
    headings: [["install", "Install#"]], links: ["#install"],
  },
  {
    name: "math-integration-point-control",
    raw: '<div><math><mtext><style></math><h2 id="install">Ghost</h2></style></mtext></math></div>',
    headings: [["install", "Install#"]], links: ["#install"],
  },
  {
    name: "markdown-first-control",
    raw: '<h2 id="install">Raw</h2>', markdownFirst: true,
    // Compatibility: a later raw duplicate never displaces the earlier link.
    headings: [["install", "Install#"], ["install", "Raw"]], links: ["#install"],
  },
];

// Independently checked output containment before sanitization. Escaping the
// inner integration-point tags makes the foreign close effective in these
// outputs, so the raw heading survives here (but not in standalone/cell HTML).
// Keep these expectations consumer-specific; do not change sanitizer policy.
const outputExpectations: Record<string, Expected> = {
  "svg-integration-point-control": {
    headings: [["install", "Ghost"], ["install-1", "Install#"]], links: ["#install-1"],
  },
  "math-integration-point-control": {
    headings: [["install", "Ghost"], ["install-1", "Install#"]], links: ["#install-1"],
  },
};

function source(fixture: Fixture) {
  return fixture.markdownFirst ? `${MARKDOWN}\n${fixture.raw}\n` : `${fixture.raw}\n\n${MARKDOWN}`;
}

function notebook(fixture: Fixture, consumer: Consumer) {
  const markdownCell = (text: string) => ({ cell_type: "markdown", metadata: {}, source: text });
  const outputCell = (mime: string, text: string) => ({
    cell_type: "code", metadata: {}, source: "", execution_count: null,
    outputs: [{ output_type: "display_data", metadata: {}, data: { [mime]: text } }],
  });
  // HTML output is not Markdown: use a separate real Markdown cell in the
  // same document, in the specified order, to exercise shared reservations.
  const cells = consumer === "cell"
    ? [markdownCell(source(fixture))]
    : consumer === "markdown-output"
      ? [outputCell("text/markdown", source(fixture))]
      : fixture.markdownFirst
        ? [markdownCell(MARKDOWN), outputCell("text/html", fixture.raw)]
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

async function expectDestinations(html: string, scope: string, expected: Expected, markdownFirst = false) {
  const headings: Array<[string | null, string]> = [];
  const links: string[] = [];
  // A new parse of already-sanitized, fully wrapped output: sanitizer callbacks
  // over the original input are not proof of a reachable fragment destination.
  await new HTMLRewriter()
    .on([1, 2, 3, 4, 5, 6].map((n) => `${scope} h${n}`).join(","), {
      element(el) { headings.push([el.getAttribute("id"), ""]); },
      text(chunk) { headings[headings.length - 1]![1] += chunk.text; },
    })
    .on(`${scope} a.dw-anchor`, {
      element(el) { links.push(el.getAttribute("href")!); },
    })
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    .text();
  expect.soft(headings).toEqual(expected.headings);
  expect.soft(links).toEqual(expected.links);
  for (const link of links) {
    const destinations = headings.filter(([id]) => id === link.slice(1));
    expect(destinations[0]?.[1], `${link} first resolves to the Markdown heading`).toBe("Install#");
    if (!markdownFirst) expect(destinations, `${link} has one final heading destination`).toHaveLength(1);
  }
}

describe("Markdown heading reservations in foreign content", () => {
  it.each(cases)("keeps synchronous helper destinations after sanitizer reparse for $name", async (fixture) => {
    const rendered = renderMarkdown(source(fixture), `${fixture.name}.md`);
    expect(rendered).not.toBeInstanceOf(Promise);
    expect(typeof rendered.html).toBe("string");
    const sanitized = await sanitizeHtml(rendered.html);
    await expectDestinations(`<article class="dw-md">${sanitized}</article>`, "article.dw-md", fixture, fixture.markdownFirst);
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
      const directives = (res.headers.get("Content-Security-Policy") ?? "").split(";").map((d) => d.trim().split(/\s+/));
      const scripts = directives.find(([name]) => name === "script-src") ?? directives.find(([name]) => name === "default-src");
      expect(scripts?.slice(1)).toEqual(["'none'"]);
      return res.text();
    };

    it.each(cases)("keeps Markdown HTTP destinations after final reparse for $name", async (fixture) => {
      await expectDestinations(await page(`${fixture.name}.md`, "markdown"), "article.dw-md", fixture, fixture.markdownFirst);
    });
    describe.each(["cell", "markdown-output", "html-output"] as const)("notebook %s", (consumer) => {
      it.each(cases)("keeps notebook HTTP destinations after final reparse for $name", async (fixture) => {
        const expected = consumer === "cell" ? fixture : outputExpectations[fixture.name] ?? fixture;
        await expectDestinations(await page(`${fixture.name}-${consumer}.ipynb`, "notebook"), "main.dw-nb", expected, fixture.markdownFirst);
      });
    });
  });
});
