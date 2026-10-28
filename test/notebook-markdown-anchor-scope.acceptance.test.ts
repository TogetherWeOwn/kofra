/**
 * Protected acceptance: one notebook page is one fragment namespace. Heading
 * reservations must span every Markdown cell and every rendered Markdown or
 * HTML output in the notebook, in document order. The paired implementation
 * must not edit this file. Expectations are hand-derived from pre-fix served
 * notebook output: in every row the duplicate `notes` Markdown heading was
 * unreachable, while every `notes-1` heading was previously unique.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { renderNotebook } from "../packages/server/src/viewers/notebook";
import { sanitizeHtml } from "../packages/server/src/viewers/sanitize";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
const SHADOW = '<h2 id="notes">Raw Notes</h2>\n\n## Notes\n';

function markdownCell(source: string) {
  return { cell_type: "markdown", metadata: {}, source };
}

function outputCell(mime: string, data: string) {
  return {
    cell_type: "code", metadata: {}, source: "", execution_count: null,
    outputs: [{ output_type: "display_data", metadata: {}, data: { [mime]: data } }],
  };
}

function notebook(cells: unknown[]) {
  return { cells, metadata: {}, nbformat: 4, nbformat_minor: 5 };
}

const fixtureNotebooks: Record<string, ReturnType<typeof notebook>> = {
  "cross-md.ipynb": notebook([markdownCell(SHADOW), markdownCell("## Notes 1\n")]),
  "cross-md-mdout.ipynb": notebook([markdownCell(SHADOW), outputCell("text/markdown", "## Notes 1\n")]),
  "cross-md-htmlout.ipynb": notebook([markdownCell(SHADOW), outputCell("text/html", '<h2 id="notes-1">Future HTML</h2>')]),
  "cross-htmlout-md.ipynb": notebook([outputCell("text/html", '<h2 id="notes">Raw HTML</h2>'), markdownCell("## Notes\n\n## Notes 1\n")]),
  "cross-mdout-md.ipynb": notebook([outputCell("text/markdown", SHADOW), markdownCell("## Notes 1\n")]),
  "cross-before.ipynb": notebook([markdownCell("## Notes 1\n"), markdownCell(SHADOW)]),
  "cross-htmlout-only.ipynb": notebook([outputCell("text/html", '<h2 id="notes">Raw HTML</h2>'), markdownCell("## Notes\n")]),
};

const fixtures: Record<string, string> = Object.fromEntries(
  Object.entries(fixtureNotebooks).map(([path, nb]) => [path, JSON.stringify(nb)]),
);

async function inspect(html: string) {
  const headings: Array<{ id: string | null; text: string }> = [];
  const links: string[] = [];
  await new HTMLRewriter()
    .on("main.dw-nb h1,main.dw-nb h2,main.dw-nb h3,main.dw-nb h4,main.dw-nb h5,main.dw-nb h6", {
      element(el) {
        headings.push({ id: el.getAttribute("id"), text: "" });
      },
      text(chunk) {
        headings[headings.length - 1]!.text += chunk.text;
      },
    })
    .on("main.dw-nb a.dw-anchor", {
      element(el) {
        links.push(el.getAttribute("href")!);
      },
    })
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    .text();
  return { headings, links };
}

async function expectNotebook(html: string, ids: readonly string[], links: readonly string[]) {
  const inspected = await inspect(html);
  expect(inspected.headings.map((h) => h.id)).toEqual(ids);
  expect(inspected.links).toEqual(links);
  for (const link of inspected.links) {
    expect(
      inspected.headings.filter((h) => h.id === link.slice(1)),
      `${link} resolves to exactly one heading in the whole notebook`,
    ).toHaveLength(1);
  }
  return inspected;
}

const crossCases = [
  ["a later Markdown cell", "cross-md.ipynb", ["notes", "notes-2", "notes-1"], ["#notes-2", "#notes-1"]],
  ["a later text/markdown output", "cross-md-mdout.ipynb", ["notes", "notes-2", "notes-1"], ["#notes-2", "#notes-1"]],
  ["a later text/html output", "cross-md-htmlout.ipynb", ["notes", "notes-2", "notes-1"], ["#notes-2"]],
  ["an earlier text/html output and a later Markdown cell", "cross-htmlout-md.ipynb", ["notes", "notes-2", "notes-1"], ["#notes-2", "#notes-1"]],
  ["an earlier text/markdown output and a later Markdown cell", "cross-mdout-md.ipynb", ["notes", "notes-2", "notes-1"], ["#notes-2", "#notes-1"]],
  ["an earlier Markdown cell that already owns the suffix", "cross-before.ipynb", ["notes-1", "notes", "notes-2"], ["#notes-1", "#notes-2"]],
  ["an earlier text/html output owner alone", "cross-htmlout-only.ipynb", ["notes", "notes-1"], ["#notes-1"]],
] as const;

describe("notebook Markdown anchors are planned across the whole notebook", () => {
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
    expect(res.headers.get("x-kofra-viewer")).toBe("notebook");
    return res.text();
  };

  it.each(crossCases)("preserves every previously unique destination across %s", async (_label, path, ids, links) => {
    await expectNotebook(await page(path), ids, links);
  });

  it("keeps the direct renderNotebook consumer synchronous and notebook-wide", async () => {
    const fragment = renderNotebook(fixtureNotebooks["cross-md.ipynb"]!);
    expect(fragment).not.toBeInstanceOf(Promise);
    const sanitized = await sanitizeHtml(fragment as string);
    const { headings } = await expectNotebook(
      `<main class="dw-nb">${sanitized}</main>`,
      ["notes", "notes-2", "notes-1"],
      ["#notes-2", "#notes-1"],
    );
    expect(headings.find((h) => h.id === "notes-1")!.text).toBe("Notes 1#");
  });
});
