import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { dropwayClient } from "../packages/server/src/ui/client";
import {
  clearLiveMemoryCache,
  getLiveSite,
  loadLiveSiteFromD1,
  liveKey,
  type DropwayContext,
} from "@dropway/core";
import { freshInstance, jsonBody, type Instance } from "./helpers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { ServerBindings } from "@dropway/server";

/**
 * Extract the real buildTree(files) from the shipped dashboard script source.
 * The client is intentionally one self-contained function; this executes its
 * actual tree code, not a copy, so the regression pins the shipped behavior.
 */
function realBuildTree(): (files: { path: string }[]) => any {
  const src = dropwayClient.toString();
  const marker = "function buildTree(files)";
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("buildTree not found in client source");
  const brace = src.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        const fnSrc = src.slice(start, i + 1);
        // eslint-disable-next-line no-new-func
        const fn = new Function(`${fnSrc}; return buildTree;`)() as (files: { path: string }[]) => any;
        return fn;
      }
    }
  }
  throw new Error("unbalanced braces in buildTree extraction");
}

async function withDc<T>(dw: Instance, fn: (dc: DropwayContext) => Promise<T>): Promise<T> {
  const ctx = createExecutionContext();
  const dc = dw.dropway.context(env as unknown as ServerBindings, ctx);
  try {
    return await fn(dc);
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

describe("browser tree preserves legal names", () => {
  it("builds mixed normal/special directories without throwing and keeps own keys", () => {
    const buildTree = realBuildTree();
    const protoBefore = Object.getOwnPropertyDescriptors(Object.prototype);
    const files = [
      { path: "docs/a.txt" },
      { path: "constructor/a.txt" },
      { path: "toString/a.txt" },
      { path: "__proto__/a.txt" },
      { path: "normal/__proto__/a.txt" },
      { path: "hasOwnProperty/nested.txt" },
      { path: "a/__proto__/constructor/toString/deep.txt" },
    ];
    let root: any;
    expect(() => {
      root = buildTree(files);
    }).not.toThrow();
    // Every top-level name is own data, including inherited-property names.
    for (const name of ["docs", "constructor", "toString", "__proto__", "normal", "hasOwnProperty", "a"]) {
      expect(Object.hasOwn(root.dirs, name)).toBe(true);
    }
    // Nested __proto__ is own data, not the prototype.
    expect(Object.hasOwn(root.dirs["normal"].dirs, "__proto__")).toBe(true);
    expect(root.dirs["normal"].dirs["__proto__"].files.map((f: any) => f.path)).toEqual(["normal/__proto__/a.txt"]);
    expect(Object.hasOwn(root.dirs["__proto__"].dirs, "__proto__")).toBe(false);
    expect(root.dirs["__proto__"].files.map((f: any) => f.path)).toEqual(["__proto__/a.txt"]);
    // Deep chain survives.
    const deep = root.dirs["a"].dirs["__proto__"].dirs["constructor"].dirs["toString"];
    expect(deep.files.map((f: any) => f.path)).toEqual(["a/__proto__/constructor/toString/deep.txt"]);
    // No shared prototype mutation.
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(protoBefore);
  });

  it("keeps siblings, prefixes and ordering without merging or losing files", () => {
    const buildTree = realBuildTree();
    const files = [
      { path: "docs/a.txt" },
      { path: "other/a.txt" },
      { path: "constructor/a.txt" },
      { path: "__proto__/a.txt" },
      { path: "a.txt" },
      { path: "a/b.txt" },
      { path: "ab.txt" },
    ];
    const root = buildTree(files);
    // Same-basename siblings in different folders are distinct.
    expect(root.dirs["docs"].files.map((f: any) => f.path)).toEqual(["docs/a.txt"]);
    expect(root.dirs["other"].files.map((f: any) => f.path)).toEqual(["other/a.txt"]);
    // File/folder common prefixes do not merge.
    expect(root.files.map((f: any) => f.path).sort()).toEqual(["a.txt", "ab.txt"]);
    expect(root.dirs["a"].files.map((f: any) => f.path)).toEqual(["a/b.txt"]);
    // Normal ordering still works via the same sort renderNode uses.
    expect(Object.keys(root.dirs).sort()).toEqual(["__proto__", "a", "constructor", "docs", "other"]);
  });

  it("missing inherited-property names stay missing, not synthetic entries", () => {
    const buildTree = realBuildTree();
    const root = buildTree([{ path: "docs/a.txt" }]);
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(Object.hasOwn(root.dirs, name)).toBe(false);
      expect((root.dirs as any)[name]).toBeUndefined();
    }
  });
});

describe("live manifests preserve legal names", () => {
  const SPECIAL = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];
  const NESTED = "normal/__proto__/deep.txt";

  async function publishSpecials(dw: Instance, slug: string) {
    // Paths are string values in an array, never object-literal __proto__ keys.
    const files = [
      ...SPECIAL.map((name) => ({ path: name, content: `bytes:${name}` })),
      { path: NESTED, content: "bytes:nested" },
      { path: "index.html", content: "<p>home</p>" },
    ];
    const res = await dw.json("/api/v1/publish", {
      key: dw.ownerKey,
      ...jsonBody({ slug, files }),
    });
    expect(res.status).toBe(201);
    return res.body.slug as string;
  }

  it("D1 build, KV write and KV hit keep an own __proto__ file with exact tuples", async () => {
    const dw = await freshInstance();
    const protoBefore = Object.getOwnPropertyDescriptors(Object.prototype);
    const slug = await publishSpecials(dw, "legal-names-live");

    // D1 is the source of truth and must contain the __proto__ row.
    const row = await env.DB.prepare("SELECT path, sha256, size, content_type FROM version_files WHERE path = ?")
      .bind("__proto__")
      .first<{ path: string; sha256: string; size: number; content_type: string }>();
    expect(row).not.toBeNull();

    await withDc(dw, async (dc) => {
      clearLiveMemoryCache();
      const fromD1 = await loadLiveSiteFromD1(dc, { slug });
      expect(fromD1).not.toBeNull();
      // Own-key assertions for every special name.
      for (const name of [...SPECIAL, NESTED, "index.html"]) {
        expect(Object.hasOwn(fromD1!.files, name)).toBe(true);
      }
      // Exact tuple metadata survives.
      expect(fromD1!.files["__proto__"]).toEqual([row!.sha256, row!.size, row!.content_type]);
      // JSON round-trip keeps the own __proto__ key (no magic-setter loss).
      const roundTrip = JSON.parse(JSON.stringify(fromD1)) as typeof fromD1;
      expect(Object.hasOwn(roundTrip!.files, "__proto__")).toBe(true);
      expect(roundTrip!.files["__proto__"]).toEqual([row!.sha256, row!.size, row!.content_type]);
    });

    // KV must have the faithful representation after publish.
    const kvRaw = await env.CACHE.get(liveKey(slug));
    expect(kvRaw).not.toBeNull();
    const kvParsed = JSON.parse(kvRaw!);
    expect(Object.hasOwn(kvParsed.files, "__proto__")).toBe(true);
    expect(kvParsed.files["__proto__"]).toEqual([row!.sha256, row!.size, row!.content_type]);

    // A subsequent KV hit (memory cleared, KV kept) must still serve the file.
    await withDc(dw, async (dc) => {
      clearLiveMemoryCache();
      const fromKv = await getLiveSite(dc, slug);
      expect(fromKv).not.toBeNull();
      expect(Object.hasOwn(fromKv!.files, "__proto__")).toBe(true);
      expect(fromKv!.files["__proto__"]).toEqual([row!.sha256, row!.size, row!.content_type]);
      for (const name of SPECIAL) {
        expect(Object.hasOwn(fromKv!.files, name)).toBe(true);
      }
    });

    // Live serving returns exact bytes for the __proto__ file and its nested twin.
    clearLiveMemoryCache();
    const protoRes = await dw.call(`/s/${slug}/__proto__`);
    expect(protoRes.status).toBe(200);
    expect(await protoRes.text()).toBe("bytes:__proto__");
    const nestedRes = await dw.call(`/s/${slug}/${NESTED}`);
    expect(nestedRes.status).toBe(200);
    expect(await nestedRes.text()).toBe("bytes:nested");

    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(protoBefore);
  });

  it("missing inherited-property names are ordinary 404s, never synthetic files", async () => {
    const dw = await freshInstance();
    const pub = await dw.json("/api/v1/publish", {
      key: dw.ownerKey,
      ...jsonBody({ slug: "legal-names-missing", files: [{ path: "index.html", content: "<p>hi</p>" }] }),
    });
    const slug = pub.body.slug as string;
    await withDc(dw, async (dc) => {
      clearLiveMemoryCache();
      const live = await getLiveSite(dc, slug);
      expect(live).not.toBeNull();
      for (const name of SPECIAL) {
        expect(Object.hasOwn(live!.files, name)).toBe(false);
      }
    });
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      const res = await dw.call(`/s/${slug}/${name}`);
      expect(res.status).toBe(404);
    }
  });

  it("stale cached manifests without the faithful file rebuild from D1", async () => {
    const dw = await freshInstance();
    const slug = await publishSpecials(dw, "legal-names-stale");
    // Simulate an older cache entry that cannot represent __proto__: v2 without it.
    const stale = {
      v: 2,
      siteId: "stale",
      slug,
      tenantId: null,
      versionId: null,
      spa: false,
      renderMarkdown: false,
      crossOriginIsolation: false,
      passwordHash: null,
      expiresAt: null,
      files: { "index.html": ["0".repeat(64), 1, "text/html"] },
    };
    await env.CACHE.put(liveKey(slug), JSON.stringify(stale));
    await withDc(dw, async (dc) => {
      clearLiveMemoryCache();
      const live = await getLiveSite(dc, slug);
      expect(live).not.toBeNull();
      // Bounded invalidation: the stale entry is ignored and rebuilt with the real file.
      expect(Object.hasOwn(live!.files, "__proto__")).toBe(true);
      expect(live!.siteId).not.toBe("stale");
    });
  });
});
