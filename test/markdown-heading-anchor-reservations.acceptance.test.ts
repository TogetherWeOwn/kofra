/**
 * Protected acceptance: a moved Markdown heading may only take an id that is
 * free in the served document's DOM, across the whole fragment the viewer
 * wraps and sanitizes. The paired implementation must not edit this file.
 * Expectations are hand-derived from the compatibility contract and checked
 * against pre-fix served output, not an independent HTML scanner.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { renderMarkdown } from "../packages/server/src/viewers/markdown";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };

const fixtures: Record<string, string> = {
  // The script ends while still in the (single) escaped state: no `-->`
  // precedes the appropriate `</script>` end tag.
  "escaped-future.md": '<h2 id="notes">Raw</h2>\n\n## Notes\n\n<script><!-- hidden </script>\n\n<h2 id="notes-1">Future</h2>\n',
  "escaped-after.md": '<script><!-- hidden </script>\n\n<h2 id="install">Raw</h2>\n\n## Install\n',
  // Control: here the escape is closed by `-->` before the end tag.
  "escaped-closed-future.md": '<h2 id="notes">Raw</h2>\n\n## Notes\n\n<script><!-- hidden --></script>\n\n<h2 id="notes-1">Future</h2>\n',
  "custom-underscore.md": `<div><x_widget data-note='<h2 id="install">Ghost</h2>'></x_widget></div>\n\n## Install\n`,
  "custom-dot.md": `<div><x.widget data-note='<h2 id="install">Ghost</h2>'></x.widget></div>\n\n## Install\n`,
  "leading-equals.md": '<h2 =id="install" id="other">Raw</h2>\n\n## Install\n\n## Other\n',
  // No closing `>` and no trailing newline: only the viewer wrapper that
  // follows the fragment completes this tag in the served page.
  "wrapper-eof.md": '<h2 id="notes">Raw</h2>\n\n## Notes\n\n<h2 id="notes-1"',
  "encoded-dec.md": '<h2 id="notes">Raw</h2>\n\n## Notes\n\n<h2 id="notes&#45;1">Future</h2>\n',
  "encoded-hex.md": '<h2 id="notes">Raw</h2>\n\n## Notes\n\n<h2 id="notes&#x2d;1">Future</h2>\n',
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

async function fragmentIds(html: string): Promise<Array<string | null>> {
  return (await inspect(html, "")).headings.map((h) => h.id);
}

function timedRender(source: string) {
  const started = performance.now();
  const rendered = renderMarkdown(source, "bounds.md");
  return { rendered, elapsedMs: performance.now() - started };
}

describe("Markdown anchors reserve only free DOM ids in the served page", () => {
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

  it("ends script suppression at an ordinary escaped-script close", async () => {
    const { headings, links } = await inspect(await page("escaped-after.md"));
    // The sanitizer serves the raw heading after the dropped script, so the
    // later Markdown heading is the shadowed one and must move.
    expect(headings.map((h) => h.id)).toEqual(["install", "install-1"]);
    expect(headings[0]!.text).toBe("Raw");
    expect(links).toEqual(["#install-1"]);
    expectUnambiguousLinks(headings, links);
  });

  it("reserves a future raw suffix owner after an ordinary escaped-script close", async () => {
    const { headings, links } = await inspect(await page("escaped-future.md"));
    expect(headings.map((h) => h.id)).toEqual(["notes", "notes-2", "notes-1"]);
    expect(headings.find((h) => h.id === "notes-1")!.text).toBe("Future");
    expect(links).toEqual(["#notes-2"]);
    expectUnambiguousLinks(headings, links);
  });

  it("keeps reserving the future owner when the script escape closes before the end tag", async () => {
    const { headings, links } = await inspect(await page("escaped-closed-future.md"));
    expect(headings.map((h) => h.id)).toEqual(["notes", "notes-2", "notes-1"]);
    expect(headings.find((h) => h.id === "notes-1")!.text).toBe("Future");
    expect(links).toEqual(["#notes-2"]);
    expectUnambiguousLinks(headings, links);
  });

  it.each(["custom-underscore.md", "custom-dot.md"])(
    "does not reserve a heading that only appears inside a quoted custom-tag attribute in %s",
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

  it("does not treat a leading-equals attribute as the id attribute", async () => {
    const { headings, links } = await inspect(await page("leading-equals.md"));
    // Served raw id is `other` (the real id attribute); `=id` is a different
    // attribute. #install was previously reachable and must stay on Install,
    // while Other is shadowed by the earlier raw heading and must move.
    expect(headings.map((h) => h.id)).toEqual(["other", "install", "other-1"]);
    expect(headings[0]!.text).toBe("Raw");
    expect(links).toEqual(["#install", "#other-1"]);
    expectUnambiguousLinks(headings, links);
  });

  it("reserves a raw id whose final tag is completed by the viewer wrapper", async () => {
    const { headings, links } = await inspect(await page("wrapper-eof.md"));
    // The served page carries the completed authored heading as the third
    // heading, so the moved Markdown heading must not take its id. This is
    // the wrapper boundary, not the true fragment-EOF case pinned elsewhere.
    expect(headings.map((h) => h.id)).toEqual(["notes", "notes-2", "notes-1"]);
    expect(headings[2]!.id).toBe("notes-1");
    expect(links).toEqual(["#notes-2"]);
    expectUnambiguousLinks(headings, links);
  });

  it.each([
    ["encoded-dec.md", "notes&#45;1"],
    ["encoded-hex.md", "notes&#x2d;1"],
  ] as const)("reserves a future raw id by its decoded DOM value in %s", async (path, authored) => {
    const html = await page(path);
    // Authored bytes keep the character reference; a browser decodes the
    // future raw id to `notes-1`. HTMLRewriter reports the authored spelling,
    // so that spelling is what the served sequence shows for the raw heading.
    expect(html).toContain(`id="${authored}"`);
    const { headings, links } = await inspect(html);
    expect(headings.map((h) => h.id)).toEqual(["notes", "notes-2", authored]);
    expect(headings[2]!.text).toBe("Future");
    expect(links).toEqual(["#notes-2"]);
  });
});

describe("Markdown heading reservation work stays bounded in the synchronous helper", () => {
  it("keeps the exported renderMarkdown helper synchronous", () => {
    const rendered = renderMarkdown("## Install\n", "sync.md");
    expect(rendered).not.toBeInstanceOf(Promise);
    expect(rendered.html).toContain('id="install"');
  });

  // Scaling bound used below: quadrupling the input may cost at most eight
  // times the smaller render, plus a fixed 250 ms overhead allowance. A
  // forward-progress implementation costs roughly four times; restarting a
  // suffix/stack/suffix search for every item costs roughly sixteen times.
  // The ratio, not an absolute wall-clock budget, is the bound, so machine
  // speed and sustained load cancel out of the comparison.
  function expectNearLinearScaling(smallMs: number, largeMs: number, label: string) {
    expect(largeMs, `${label}: quadrupling the input took ${largeMs.toFixed(1)} ms after ${smallMs.toFixed(1)} ms`).toBeLessThan(smallMs * 8 + 250);
  }

  it("allocates moved suffixes monotonically for many same-base shadowed headings", async () => {
    const source = (m: number) => {
      const raw = Array.from({ length: m }, (_, i) => `<h2 id="notes${i ? `-${i}` : ""}">R</h2>`).join("\n\n");
      return `${raw}\n\n${"## Notes\n\n".repeat(m)}`;
    };
    renderMarkdown(source(1_000), "bounds.md"); // warm this code path before timing
    const small = timedRender(source(2_000));
    const smallIds = await fragmentIds(small.rendered.html);
    expect(smallIds).toHaveLength(4_000);
    expect(smallIds[2_000]).toBe("notes-2000");
    expect(smallIds[3_999]).toBe("notes-3999");

    const large = timedRender(source(8_000));
    const ids = await fragmentIds(large.rendered.html);
    expect(ids).toHaveLength(16_000);
    expect(ids[0]).toBe("notes");
    expect(ids[7_999]).toBe("notes-7999");
    expect(ids[8_000]).toBe("notes-8000");
    expect(ids[15_999]).toBe("notes-15999");
    expect(new Set(ids).size).toBe(16_000);
    expectNearLinearScaling(small.elapsedMs, large.elapsedMs, "suffix allocation must not restart from suffix 1 for every heading");
  }, 30_000);

  it("scans many ordinary comments without rescanning the remaining suffix", async () => {
    const source = (k: number) => `${"<!--x-->".repeat(k)}\n\n<h2 id="install">Raw</h2>\n\n## Install\n`;
    renderMarkdown(source(2_500), "bounds.md"); // warm this code path before timing
    const small = timedRender(source(5_000));
    expect(await fragmentIds(small.rendered.html)).toEqual(["install", "install-1"]);
    const large = timedRender(source(20_000));
    expect(await fragmentIds(large.rendered.html)).toEqual(["install", "install-1"]);
    expectNearLinearScaling(small.elapsedMs, large.elapsedMs, "comment scanning must keep overall forward progress");
  }, 30_000);

  it("scans many unmatched close tags without rescanning the open stack", async () => {
    const source = (depth: number) => `${"<div>".repeat(depth)}${"</article>".repeat(depth)}\n\n<h2 id="install">Raw</h2>\n\n## Install\n`;
    // Inspect only the output tail: feeding the deliberately deep stack to
    // HTMLRewriter exhausts its parser memory before it reaches the headings.
    const tailIds = (html: string) => fragmentIds(html.slice(-2_000));
    renderMarkdown(source(6_000), "bounds.md"); // warm this code path before timing
    const small = timedRender(source(12_000));
    expect(await tailIds(small.rendered.html)).toEqual(["install", "install-1"]);
    const large = timedRender(source(48_000));
    expect(await tailIds(large.rendered.html)).toEqual(["install", "install-1"]);
    expectNearLinearScaling(small.elapsedMs, large.elapsedMs, "unmatched-close handling must not rescan an unchanged stack");
  }, 30_000);

  it("scans repeated double-escaped script closes without rescanning the remaining suffix", async () => {
    const source = (k: number) => `<script>${"<!--<script></script>".repeat(k)}--></script>\n\n<h2 id="install">Raw</h2>\n\n## Install\n`;
    renderMarkdown(source(3_000), "bounds.md"); // warm this code path before timing
    const small = timedRender(source(6_000));
    expect(await fragmentIds(small.rendered.html)).toEqual(["install", "install-1"]);
    const large = timedRender(source(24_000));
    expect(await fragmentIds(large.rendered.html)).toEqual(["install", "install-1"]);
    expectNearLinearScaling(small.elapsedMs, large.elapsedMs, "escaped-script scanning must keep overall forward progress");
  }, 30_000);
});
