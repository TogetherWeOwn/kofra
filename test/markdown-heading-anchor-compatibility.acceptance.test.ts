/**
 * Protected acceptance follow-up: only a Markdown heading shadowed by an
 * earlier raw heading may move. A replacement must not steal an existing
 * suffix link, and markup absent from the served document reserves nothing.
 * The paired implementation must not edit this file.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@dropway/core";
import { renderMarkdown } from "../packages/server/src/viewers/markdown";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };

const fixtures: Record<string, string> = {
  "suffix-after.md": '# Report Title\n\n<h2 id="step">Raw Step</h2>\n\n## Step\n\n## Step 1\n',
  "suffix-before.md": '# Report Title\n\n## Notes 1\n\n<h2 id="notes">Raw Notes</h2>\n\n## Notes\n',
  "suffix-future-duplicates.md": '# Report Title\n\n<h2 id="notes">Raw Notes</h2>\n\n## Notes\n\n## Notes\n\n## Notes\n',
  "suffix-middle-duplicate.md": '# Report Title\n\n## Notes\n\n<h2 id="notes-1">Raw Notes</h2>\n\n## Notes\n\n## Notes\n',
  "raw-multihop.md": '# Report Title\n\n<h2 id="notes">Raw Notes</h2>\n\n<h2 id="notes-1">Raw Notes One</h2>\n\n## Notes\n',
  "raw-single-quoted.md": "# Report Title\n\n<h2 id='install'>Raw Install</h2>\n\n## Install\n",
  "raw-unquoted.md": '# Report Title\n\n<h2 id=install>Raw Install</h2>\n\n## Install\n',
  "raw-unquoted-slash.md": '# Report Title\n\n<h2 id=install/>Raw Install</h2>\n\n## Install\n',
  "comment-heading.md": '# Report Title\n\n<!-- <h2 id="install">Ghost</h2> -->\n\n## Install\n',
  "template-heading.md": '# Report Title\n\n<template><h2 id="install">Ghost</h2></template>\n\n## Install\n',
  "textarea-heading.md": '# Report Title\n\n<textarea><h2 id="install">Ghost</h2></textarea>\n\n## Install\n',
  "script-heading.md": '# Report Title\n\n<script>const example = \'<h2 id="install">Ghost</h2>\';</script>\n\n## Install\n',
  // These duplicate ids predate the raw-heading fix and are not permission
  // to globally deduplicate Markdown slugs or change collision-free bytes.
  "markdown-slug-overlap.md": '# Report Title\n\n## Notes\n\n## Notes 1\n\n## Notes\n\n## Notes 1\n\n## Notes\n',
  "unrelated-slug-overlap.md": '# Report Title\n\n## Intro\n\n## Intro 1\n\n## Intro\n\n<h2 id="notes">Raw Notes</h2>\n\n## Notes\n',
  // 64 KiB of malformed raw HTML, local only. No tight timing assertion:
  // this pins the real render/serve path and output; a disposable probe
  // records baseline/head scaling separately.
  "unterminated-headings.md": '# Report Title\n\n' + '<h2 '.repeat(16_000),
};

interface Heading {
  id: string | null;
  text: string;
  generated: boolean;
  href: string | null;
}

async function articleHeadings(html: string): Promise<Heading[]> {
  const headings: Heading[] = [];
  await new HTMLRewriter()
    .on("article.dw-md h1,article.dw-md h2,article.dw-md h3,article.dw-md h4,article.dw-md h5,article.dw-md h6", {
      element(el) {
        headings.push({ id: el.getAttribute("id"), text: "", generated: false, href: null });
      },
      text(chunk) {
        headings[headings.length - 1]!.text += chunk.text;
      },
    })
    .on("article.dw-md a.dw-anchor", {
      element(el) {
        const heading = headings[headings.length - 1]!;
        heading.generated = true;
        heading.href = el.getAttribute("href");
      },
    })
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    .text();
  return headings;
}

// Hand-derived contract expectations, not computed by the renderer. In each
// row, only the heading shadowed by earlier raw HTML changes its baseline id.
const movedCases = [
  ["suffix-after.md", ["report-title", "step", "step-2", "step-1"]],
  ["suffix-before.md", ["report-title", "notes-1", "notes", "notes-2"]],
  ["suffix-future-duplicates.md", ["report-title", "notes", "notes-3", "notes-1", "notes-2"]],
  ["suffix-middle-duplicate.md", ["report-title", "notes", "notes-1", "notes-3", "notes-2"]],
  ["raw-multihop.md", ["report-title", "notes", "notes-1", "notes-2"]],
  ["raw-single-quoted.md", ["report-title", "install", "install-1"]],
  ["raw-unquoted.md", ["report-title", "install", "install-1"]],
  ["unrelated-slug-overlap.md", ["report-title", "intro", "intro-1", "intro-1", "notes", "notes-1"]],
] as const;

const unchangedCases = [
  ["raw-unquoted-slash.md", ["report-title", "install/", "install"]],
  ["comment-heading.md", ["report-title", "install"]],
  ["template-heading.md", ["report-title", "install"]],
  ["textarea-heading.md", ["report-title", "install"]],
  ["script-heading.md", ["report-title", "install"]],
  ["markdown-slug-overlap.md", ["report-title", "notes", "notes-1", "notes-1", "notes-1-1", "notes-2"]],
  ["unterminated-headings.md", ["report-title", null]],
] as const;

// SHA-256 of complete served version-3 bodies, normalizing only the freshly
// allocated site slug to "kofra-golden-slug". Filled from disposable baseline
// Worker output, never from the new implementation.
const BASELINE_BODY_SHA256: Record<string, string> = {
  "raw-unquoted-slash.md": "53165bfac9dab0ed205c84f8b17588420999145b684282a7b4e56e54bf850df9",
  "comment-heading.md": "2c47f838b532db6cc504ec743268720fca10ff62c393e496a4ba792fc3e18439",
  "template-heading.md": "f794f205fd19c7da5aad30e45395bc3c42ae982d4e647dcbf9dd957f2dd7082e",
  "textarea-heading.md": "1e8e7a168d73341ec376f92847a268f53ea29c16d69d2870f881ea1e10294d46",
  "script-heading.md": "777f15dee7f2ef989953a7c4c70522954853eff4b294a026536c3a4150a6fef7",
  "markdown-slug-overlap.md": "6389982d3e70f7ded65a991b1014aee75cb69f20f846f97668af4e4978c8104f",
  "unterminated-headings.md": "c08c51b64cf0c4be0de657939532f27955ea7a43f782ec96eebcbc1b9816d42b",
};

describe("Markdown anchor compatibility follow-up in workerd", () => {
  let dw: Instance;
  let slug: string;

  beforeAll(async () => {
    dw = await freshInstance();
    const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(fixtures) });
    expect(published.status).toBe(201);
    slug = published.body.slug;
  });

  const page = async (path: string): Promise<string> => {
    const res = await dw.call(`/s/${slug}/${path}`, { headers: NAV });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("markdown");
    return res.text();
  };

  it.each(movedCases)("preserves every previously reachable suffix in %s", async (path, ids) => {
    const headings = await articleHeadings(await page(path));
    expect(headings.map((h) => h.id)).toEqual(ids);
    for (const heading of headings.filter((h) => h.generated)) {
      expect(heading.href).toBe(`#${heading.id}`);
    }
  });

  it("keeps #step-1 on Step 1 rather than the newly moved Step heading", async () => {
    const headings = await articleHeadings(await page("suffix-after.md"));
    expect(headings.filter((h) => h.id === "step-1")).toHaveLength(1);
    expect(headings.find((h) => h.id === "step-1")!.text).toBe("Step 1#");
  });

  it.each(unchangedCases)("keeps baseline heading ids in %s without phantom reservations", async (path, ids) => {
    const headings = await articleHeadings(await page(path));
    expect(headings.map((h) => h.id)).toEqual(ids);
    for (const heading of headings.filter((h) => h.generated)) {
      expect(heading.href).toBe(`#${heading.id}`);
    }
  });

  it.each(["comment-heading.md", "template-heading.md", "textarea-heading.md", "script-heading.md"])(
    "does not serve the apparent raw heading in %s or reserve its id",
    async (path) => {
      const headings = await articleHeadings(await page(path));
      expect(headings.map((h) => h.generated)).toEqual([true, true]);
      expect(headings.map((h) => h.id)).toEqual(["report-title", "install"]);
      expect(headings[1]!.text).toContain("Install");
      expect(headings[1]!.text).not.toContain("Ghost");
    },
  );

  it("keeps the authored slash in an unquoted id and leaves the Markdown link alone", async () => {
    const headings = await articleHeadings(await page("raw-unquoted-slash.md"));
    expect(headings[1]!.generated).toBe(false);
    expect(headings[1]!.id).toBe("install/");
    expect(headings[1]!.text).toBe("Raw Install");
    expect(headings[2]!.id).toBe("install");
    expect(headings[2]!.href).toBe("#install");
  });

  it.each(unchangedCases)("keeps the complete collision-free body of %s byte-identical", async (path) => {
    const html = (await page(path)).split(slug).join("kofra-golden-slug");
    expect(BASELINE_BODY_SHA256[path], "fixture has an independently captured baseline digest").toMatch(/^[a-f0-9]{64}$/);
    expect(await sha256Hex(new TextEncoder().encode(html))).toBe(BASELINE_BODY_SHA256[path]);
  });

  it("renders a bounded unterminated heading-prefix run without inventing an id", async () => {
    const html = await page("unterminated-headings.md");
    // HTMLRewriter closes the unfinished raw tag when viewer chrome follows;
    // baseline serves that heading without an id. Do not change its semantics.
    expect((await articleHeadings(html)).map((h) => h.id)).toEqual(["report-title", null]);
    const fragment = renderMarkdown(fixtures["unterminated-headings.md"]!, "unterminated-headings.md");
    expect(fragment.title).toBe("Report Title");
    expect(fragment.html).toContain('<h2 '.repeat(16_000));
  });
});
