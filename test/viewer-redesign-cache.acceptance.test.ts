/**
 * Retire validators and 30-day fragments issued before the shared-shell redesign.
 * Historical versions and key variants are fixed observations, not registry-derived
 * expectations; current validators must remain reusable after a successful refresh.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { sha256Hex } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { cachedRender, clearRenderMemoryCache } from "../packages/server/src/viewers/cache";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document" };
const fixtures = [
  { id: "markdown", path: "note.md", oldVersion: 5, keys: ["markdown@5/"], bytes: (label: string) => strToU8(`# ${label}\n`) },
  { id: "csv", path: "table.csv", oldVersion: 5, keys: ["csv@5/csv/"], bytes: (label: string) => strToU8(`name,value\n${label},42\n`) },
  { id: "notebook", path: "note.ipynb", oldVersion: 4, keys: ["notebook@4/"], bytes: (label: string) => strToU8(JSON.stringify({
    metadata: { language_info: { name: "python" } }, cells: [{ cell_type: "markdown", source: `# ${label}` }],
  })) },
  { id: "code", path: "app.ts", oldVersion: 5, keys: ["code@5/typescript/full/"], bytes: (label: string) => strToU8(`// ${label}\nexport const answer = 42;\n`) },
  { id: "json", path: "data.json", oldVersion: 5, keys: ["json@5/tree/", "code@5/json/pretty/"], bytes: (label: string) => strToU8(JSON.stringify({ [label]: 42 })) },
  { id: "archive", path: "files.zip", oldVersion: 4, keys: ["archive@4/"], bytes: (label: string) => zipSync({ [`${label}.txt`]: strToU8("Archive entry\n") }) },
];

async function publish(dw: Instance, fixture: typeof fixtures[number], label: string) {
  const bytes = fixture.bytes(label);
  const published = await dw.json("/api/v1/publish", {
    method: "POST", key: dw.ownerKey, body: form({ [fixture.path]: bytes }),
  });
  expect(published.status).toBe(201);
  return {
    url: `/s/${published.body.slug}/${fixture.path}?view=1`,
    hash: await sha256Hex(bytes),
  };
}

beforeEach(() => clearRenderMemoryCache());

describe("shared-shell redesign cache retirement", () => {
  for (const embed of [false, true]) {
    it.each(fixtures)(`refreshes $id pre-redesign validators, then revalidates current output (embed=${embed})`, async (fixture) => {
      const dw = await freshInstance();
      const label = `FRESH_VALIDATOR_${fixture.id}_${embed}`;
      const published = await publish(dw, fixture, label);
      const url = published.url + (embed ? "&embed=1" : "");
      const initial = await dw.call(url, { headers: NAV });
      expect(initial.status).toBe(200);
      expect(initial.headers.get("x-kofra-viewer")).toBe(fixture.id);
      expect(await initial.text()).toContain(label);
      const current = initial.headers.get("etag")!;
      expect(current).toMatch(new RegExp(`^W/"${fixture.id}@\\d+-${published.hash}-folder[A-Za-z0-9_-]+-chrome\\d+(?:\\.[0-9a-f]{8})?${embed ? "-e" : ""}"$`));
      // Exercise shared chrome and the content render version independently;
      // preserve the manifest and embed suffixes that deployed validators carried.
      const staleChrome = current.replace(/-chrome\d+(?:\.[0-9a-f]{8})?/, "-chrome2");
      const staleRender = current.replace(/@\d+-/, `@${fixture.oldVersion}-`);
      for (const legacy of [staleChrome, staleRender]) {
        const refreshed = await dw.call(url, { headers: { ...NAV, "If-None-Match": legacy } });
        expect(refreshed.status, `${fixture.id}: pre-redesign cached pages must refresh`).toBe(200);
        expect(refreshed.headers.get("etag")).toBe(current);
        expect(await refreshed.text()).toContain(label);
      }
      const revalidated = await dw.call(url, { headers: { ...NAV, "If-None-Match": current } });
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("etag")).toBe(current);
      expect(await revalidated.text()).toBe("");
    });
  }

  for (const tier of ["memory", "edge"] as const) {
    it.each(fixtures)(`does not reuse a $id pre-redesign fragment from ${tier}`, async (fixture) => {
      const dw = await freshInstance();
      // Distinct bytes keep validator tests and the other tier from warming the
      // current fragment first and accidentally hiding a stale-key collision.
      const label = `FRESH_FRAGMENT_${fixture.id}_${tier}`;
      const { url, hash } = await publish(dw, fixture, label);
      const oldHtml = `<p>STALE_PRE_REDESIGN_${fixture.id}</p>`;
      const ctx = createExecutionContext();
      const dc = dw.dropway.context(env as unknown as ServerBindings, ctx, new URL(url, ORIGIN));
      for (const prefix of fixture.keys) {
        const key = prefix + hash;
        if (tier === "memory") {
          await cachedRender(dc, key, async () => oldHtml);
        } else {
          await caches.default.put(new Request(`${ORIGIN}/__dropway/render/${key}`), new Response(oldHtml, {
            headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=2592000" },
          }));
        }
      }
      await waitOnExecutionContext(ctx);
      if (tier === "edge") clearRenderMemoryCache();

      const refreshed = await dw.call(url, { headers: NAV });
      expect(refreshed.status).toBe(200);
      expect(refreshed.headers.get("x-kofra-viewer")).toBe(fixture.id);
      const html = await refreshed.text();
      expect(html, `${fixture.id}: retire every pre-redesign fragment, including JSON's highlighted Pretty pane`).not.toContain("STALE_PRE_REDESIGN");
      expect(html).toContain(label);
      expect(refreshed.headers.get("x-kofra-render-cache")).toBe("miss");

      const warm = await dw.call(url, { headers: NAV });
      expect(warm.headers.get("x-kofra-render-cache")).toBe("memory");
      expect(await warm.text()).toBe(html);
      clearRenderMemoryCache();
      const edge = await dw.call(url, { headers: NAV });
      expect(edge.headers.get("x-kofra-render-cache")).toBe("edge");
      expect(await edge.text()).toBe(html);
    });
  }

  it("binds viewer validators to the shared design stylesheet hash", async () => {
    const dw = await freshInstance();
    const home = await dw.call("/");
    expect(home.status).toBe(200);
    const cssHash = (await home.text()).match(/\/__dropway\/ui\/kofra-([0-9a-f]{8})\.css/)?.[1];
    expect(cssHash, "the shared shell advertises its content-addressed design stylesheet").toBeDefined();
    const { url } = await publish(dw, fixtures[0]!, "FRESH_CSS_IDENTITY");
    const response = await dw.call(url, { headers: NAV });
    expect(response.status).toBe(200);
    expect(response.headers.get("etag"), "changing the design stylesheet must retire cached viewer pages").toMatch(new RegExp(`-chrome\\d+\\.${cssHash}"$`));
  });
});
