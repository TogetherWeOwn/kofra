/**
 * Protected acceptance: both notebook consumers of the shared Markdown renderer
 * must receive repaired anchors on cold renders, old fragment-cache hits and
 * conditional requests. The paired implementation must not edit this file.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { cachedRender, clearRenderMemoryCache } from "../packages/server/src/viewers/cache";
import { renderNotebook } from "../packages/server/src/viewers/notebook";
import { sanitizeHtml } from "../packages/server/src/viewers/sanitize";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
const SOURCE = '<h2 id="step">Raw Step</h2>\n\n## Step\n\n## Step 1\n';
const CONSUMERS = ["cell", "output"] as const;
type Consumer = (typeof CONSUMERS)[number];

function notebook(consumer: Consumer, fixture: string) {
  const cell = consumer === "cell"
    ? { cell_type: "markdown", metadata: {}, source: SOURCE }
    : {
      cell_type: "code", metadata: {}, source: "", execution_count: null,
      outputs: [{ output_type: "display_data", metadata: {}, data: { "text/markdown": SOURCE } }],
    };
  return { cells: [cell], metadata: { anchor_cache_fixture: fixture }, nbformat: 4, nbformat_minor: 5 };
}

// Sanitized notebook@2 fragments captured from baseline 319e1d1, not produced by
// the renderer under test. Metadata labels below do not change rendered bytes.
const LEGACY_FRAGMENTS: Record<Consumer, string> = {
  cell: '<div class="dw-cell"><div class="dw-prompt"></div><div class="dw-mdcell"><h2 id="step">Raw Step</h2><h2 id="step">Step<a class="dw-anchor" href="#step" aria-label="Link to this section" rel="nofollow noopener noreferrer">#</a></h2>\n<h2 id="step-1">Step 1<a class="dw-anchor" href="#step-1" aria-label="Link to this section" rel="nofollow noopener noreferrer">#</a></h2>\n</div></div>',
  output: '<div class="dw-cell"><div class="dw-prompt">In [ ]:</div><div><pre><code class="hljs"></code></pre><div class="dw-out"><div><h2 id="step">Raw Step</h2><h2 id="step">Step<a class="dw-anchor" href="#step" aria-label="Link to this section" rel="nofollow noopener noreferrer">#</a></h2>\n<h2 id="step-1">Step 1<a class="dw-anchor" href="#step-1" aria-label="Link to this section" rel="nofollow noopener noreferrer">#</a></h2>\n</div></div></div></div>',
};

// Independently captured from pre-feature main 923ac4bbcfa616368f0f180552d527b52baf55bd
// using workerd: sanitizeHtml(renderNotebook(nb)) equals the real notebook@3
// Cache API fragment after HTTP navigation. The cell bytes happen to match @2;
// the output now includes main's native fold. Neither uses the feature renderer.
const MAIN3_FRAGMENTS: Record<Consumer, string> = {
  cell: '<div class="dw-cell"><div class="dw-prompt"></div><div class="dw-mdcell"><h2 id="step">Raw Step</h2><h2 id="step">Step<a class="dw-anchor" href="#step" aria-label="Link to this section" rel="nofollow noopener noreferrer">#</a></h2>\n<h2 id="step-1">Step 1<a class="dw-anchor" href="#step-1" aria-label="Link to this section" rel="nofollow noopener noreferrer">#</a></h2>\n</div></div>',
  output: '<div class="dw-cell"><div class="dw-prompt">In [ ]:</div><div><pre><code class="hljs"></code></pre><details class="dw-out" open><summary>Outputs (1)</summary><div><h2 id="step">Raw Step</h2><h2 id="step">Step<a class="dw-anchor" href="#step" aria-label="Link to this section" rel="nofollow noopener noreferrer">#</a></h2>\n<h2 id="step-1">Step 1<a class="dw-anchor" href="#step-1" aria-label="Link to this section" rel="nofollow noopener noreferrer">#</a></h2>\n</div></details></div></div>',
};

const fixtures: Record<string, string> = {};
for (const consumer of CONSUMERS) {
  for (const scenario of ["cold", "edge", "memory", "validator-page", "validator-embed", "raw", "main3-edge", "main3-memory", "main3-validator-page", "main3-validator-embed"]) {
    const path = `${consumer}-${scenario}.ipynb`;
    // A distinct content hash per scenario prevents a preceding cold-render
    // test from populating the current cache identity before the legacy seed.
    fixtures[path] = JSON.stringify(notebook(consumer, path));
  }
}

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

async function expectRepaired(html: string) {
  const { headings, links } = await inspect(html);
  expect(headings.map((h) => h.id)).toEqual(["step", "step-2", "step-1"]);
  expect(headings[0]!.text).toBe("Raw Step");
  expect(headings.find((h) => h.id === "step-1")!.text).toBe("Step 1#");
  expect(links).toEqual(["#step-2", "#step-1"]);
  for (const link of links) {
    expect(headings.filter((h) => h.id === link.slice(1)), `${link} resolves to one notebook heading`).toHaveLength(1);
  }
}

describe("notebook Markdown anchor cache and validator retirement in workerd", () => {
  let dw: Instance;
  let slug: string;
  let versionId: string;

  beforeAll(async () => {
    dw = await freshInstance();
    const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(fixtures) });
    expect(published.status).toBe(201);
    slug = published.body.slug;
    versionId = published.body.version.id;
  });
  beforeEach(() => clearRenderMemoryCache());

  const get = (path: string, headers: Record<string, string> = NAV) => dw.call(`/s/${slug}/${path}`, { headers });
  const hashOf = (path: string) => sha256Hex(new TextEncoder().encode(fixtures[path]!));
  const legacyRequest = (hash: string) => new Request(`${ORIGIN}/__dropway/render/notebook@2/${hash}`); // rebrand:keep -- existing legacy cache URL

  it.each(CONSUMERS)("keeps the direct renderNotebook %s consumer covered by the real sanitizer", async (consumer) => {
    const fragment = await sanitizeHtml(renderNotebook(notebook(consumer, "helper")));
    await expectRepaired(`<main class="dw-nb">${fragment}</main>`);
  });

  it.each(CONSUMERS)("serves repaired headings on a cold %s notebook render", async (consumer) => {
    const res = await get(`${consumer}-cold.ipynb`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-kofra-viewer")).toBe("notebook");
    expect(res.headers.get("x-kofra-render-cache")).toBe("miss");
    await expectRepaired(await res.text());
  });

  it.each(CONSUMERS)("rejects an old notebook@2 edge fragment for the %s consumer", async (consumer) => {
    const path = `${consumer}-edge.ipynb`;
    const req = legacyRequest(await hashOf(path));
    await caches.default.put(req, new Response(LEGACY_FRAGMENTS[consumer], {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=2592000, immutable" },
    }));
    const seeded = await caches.default.match(req);
    expect(seeded, "the real Cache API accepted the old fragment").toBeDefined();
    expect(await seeded!.text()).toBe(LEGACY_FRAGMENTS[consumer]);
    clearRenderMemoryCache();

    const res = await get(path);
    expect(res.status).toBe(200);
    await expectRepaired(await res.text());
    expect(res.headers.get("x-kofra-render-cache")).toBe("miss");
    const warm = await get(path);
    expect(warm.headers.get("x-kofra-render-cache")).toBe("memory");
    await expectRepaired(await warm.text());
  });

  it.each(CONSUMERS)("rejects an old notebook@2 memory fragment for the %s consumer", async (consumer) => {
    const path = `${consumer}-memory.ipynb`;
    const hash = await hashOf(path);
    const ctx = createExecutionContext();
    const dc = dw.dropway.context(env as unknown as ServerBindings, ctx, new URL(`${ORIGIN}/s/${slug}/${path}`));
    const seeded = await cachedRender(dc, `notebook@2/${hash}`, async () => LEGACY_FRAGMENTS[consumer]);
    await waitOnExecutionContext(ctx);
    expect(seeded.html).toBe(LEGACY_FRAGMENTS[consumer]);

    const res = await get(path);
    expect(res.status).toBe(200);
    await expectRepaired(await res.text());
    expect(res.headers.get("x-kofra-render-cache")).toBe("miss");
  });

  it.each(CONSUMERS)("retires the old full-page notebook validator for the %s consumer", async (consumer) => {
    const path = `${consumer}-validator-page.ipynb`;
    const legacy = `W/"notebook@2-${await hashOf(path)}-folder${versionId}"`;
    const res = await get(path, { ...NAV, "If-None-Match": legacy });
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(etag).not.toBe(legacy);
    await expectRepaired(await res.text());

    const fresh = await get(path, { ...NAV, "If-None-Match": etag! });
    expect(fresh.status).toBe(304);
    expect(await fresh.text()).toBe("");
  });

  it.each(CONSUMERS)("retires the old embedded notebook validator for the %s consumer", async (consumer) => {
    const path = `${consumer}-validator-embed.ipynb`;
    const legacy = `W/"notebook@2-${await hashOf(path)}-e"`;
    const res = await get(`${path}?embed=1`, { ...NAV, "If-None-Match": legacy });
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(etag).not.toBe(legacy);
    await expectRepaired(await res.text());

    const fresh = await get(`${path}?embed=1`, { ...NAV, "If-None-Match": etag! });
    expect(fresh.status).toBe(304);
    expect(await fresh.text()).toBe("");
  });

  describe("current-main notebook@3 identity retirement", () => {
    it.each(CONSUMERS)("rejects a notebook@3 edge fragment for the %s consumer", async (consumer) => {
      const path = `${consumer}-main3-edge.ipynb`;
      const req = new Request(`${ORIGIN}/__dropway/render/notebook@3/${await hashOf(path)}`); // rebrand:keep -- actual pre-feature cache URL
      await caches.default.put(req, new Response(MAIN3_FRAGMENTS[consumer], {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=2592000, immutable" },
      }));
      const seeded = await caches.default.match(req);
      expect(seeded, "the real Cache API accepted the main fragment").toBeDefined();
      expect(await seeded!.text()).toBe(MAIN3_FRAGMENTS[consumer]);
      clearRenderMemoryCache();

      const res = await get(path);
      expect(res.status).toBe(200);
      expect.soft(res.headers.get("x-kofra-render-cache"), "old edge identity is retired").toBe("miss");
      await expectRepaired(await res.text());
      const warm = await get(path);
      expect(warm.headers.get("x-kofra-render-cache")).toBe("memory");
      await expectRepaired(await warm.text());
    });

    it.each(CONSUMERS)("rejects a notebook@3 memory fragment for the %s consumer", async (consumer) => {
      const path = `${consumer}-main3-memory.ipynb`;
      const hash = await hashOf(path);
      const ctx = createExecutionContext();
      const dc = dw.dropway.context(env as unknown as ServerBindings, ctx, new URL(`${ORIGIN}/s/${slug}/${path}`));
      const seeded = await cachedRender(dc, `notebook@3/${hash}`, async () => MAIN3_FRAGMENTS[consumer]);
      await waitOnExecutionContext(ctx);
      expect(seeded.html).toBe(MAIN3_FRAGMENTS[consumer]);
      const memoryHit = await cachedRender(dc, `notebook@3/${hash}`, async () => {
        throw new Error("the seeded pre-feature memory entry must already exist");
      });
      expect(memoryHit.cache).toBe("memory");
      expect(memoryHit.html).toBe(MAIN3_FRAGMENTS[consumer]);

      const res = await get(path);
      expect(res.status).toBe(200);
      expect.soft(res.headers.get("x-kofra-render-cache"), "old memory identity is retired").toBe("miss");
      await expectRepaired(await res.text());
    });

    // Actual main validators include chrome1. Pin that old identity, not a
    // made-up minimum new notebook version; any correctly retired identity fits.
    it.each(CONSUMERS)("retires the notebook@3 full-page validator for the %s consumer", async (consumer) => {
      const path = `${consumer}-main3-validator-page.ipynb`;
      const legacy = `W/"notebook@3-${await hashOf(path)}-folder${versionId}-chrome1"`;
      const res = await get(path, { ...NAV, "If-None-Match": legacy });
      expect(res.status).toBe(200);
      const etag = res.headers.get("etag");
      expect(etag).toBeTruthy();
      expect(etag).not.toBe(legacy);
      await expectRepaired(await res.text());
      const fresh = await get(path, { ...NAV, "If-None-Match": etag! });
      expect(fresh.status).toBe(304);
      expect(await fresh.text()).toBe("");
    });

    it.each(CONSUMERS)("retires the notebook@3 embedded validator for the %s consumer", async (consumer) => {
      const path = `${consumer}-main3-validator-embed.ipynb`;
      const legacy = `W/"notebook@3-${await hashOf(path)}-chrome1-e"`;
      const res = await get(`${path}?embed=1`, { ...NAV, "If-None-Match": legacy });
      expect(res.status).toBe(200);
      const etag = res.headers.get("etag");
      expect(etag).toBeTruthy();
      expect(etag).not.toBe(legacy);
      await expectRepaired(await res.text());
      const fresh = await get(`${path}?embed=1`, { ...NAV, "If-None-Match": etag! });
      expect(fresh.status).toBe(304);
      expect(await fresh.text()).toBe("");
    });
  });

  it.each(CONSUMERS)("leaves raw and download notebook bytes unchanged for the %s consumer", async (consumer) => {
    const path = `${consumer}-raw.ipynb`;
    for (const query of ["?raw=1", "?download=1"]) {
      const res = await get(`${path}${query}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-kofra-viewer")).toBeNull();
      expect(await res.text()).toBe(fixtures[path]);
    }
  });
});
