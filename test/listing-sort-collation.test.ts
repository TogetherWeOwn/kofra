/**
 * Pins the two comparator guarantees the listing sort documents that the
 * acceptance suite's fixtures do not discriminate:
 *
 *   - folder rows use the same English collation as file rows
 *     ("apple-dir" before "Zebra-dir", not code-unit order), and
 *   - names that English collation equates (canonically equivalent NFC and
 *     NFD spellings) fall back to code-unit order, so row order never
 *     follows manifest insertion order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { LiveSite } from "@dropway/core";
import { renderListing } from "../packages/server/src/viewers/listing";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const SORTS = ["name", "size", "type"] as const;

const NFC = "\u00e9clair.txt";
const NFD = "e\u0301clair.txt";

let dw: Instance;

async function publish(files: Record<string, string>): Promise<string> {
  const res = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(files) });
  expect(res.status, `publish failed: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.slug as string;
}

async function rowNames(slug: string, sort: string): Promise<string[]> {
  const res = await dw.call(`/s/${slug}/?sort=${sort}`, { headers: NAV });
  const html = await res.text();
  expect(res.headers.get("x-kofra-viewer")).toBe("listing");
  const re = /<li[^>]*>\s*<a href="[^"]+"[^>]*>([^<]+)<\/a>\s*<span class="k">/g;
  return [...html.matchAll(re)].map((m) => m[1]!);
}

beforeAll(async () => {
  dw = await freshInstance();
});

describe("listing sort: collation guarantees", () => {
  it("orders folder rows by English collation under every sort", async () => {
    const slug = await publish({
      "Zebra-dir/inner.txt": "z",
      "apple-dir/inner.txt": "a",
      "loose.txt": "x",
    });
    for (const sort of SORTS) {
      expect(await rowNames(slug, sort), sort).toEqual(["apple-dir/", "Zebra-dir/", "loose.txt"]);
    }
  });

  it("breaks collation-equal names by code unit, independent of manifest order", async () => {
    // The publish pipeline hands the listing a path-ordered manifest, so the
    // tiebreak is pinned directly: the same two entries in both insertion
    // orders must render the same rows under every sort.
    const entry = (): [string, number, string] => ["0".repeat(64), 4, "text/plain"];
    const mode = { kind: "path", base: "/s/x/", sandbox: true, rewrite: null } as const;
    const render = async (paths: string[], sort: string) => {
      const files = Object.fromEntries(paths.map((path) => [path, entry()]));
      const live = { v: 3, slug: "x", files } as unknown as LiveSite;
      const html = await renderListing(live, "", mode, undefined, sort).text();
      return [...html.matchAll(/<li[^>]*>\s*<a href="[^"]+"[^>]*>([^<]+)<\/a>\s*<span class="k">/g)].map((m) => m[1]!);
    };
    // NFD ("e" + combining acute) sorts before NFC ("\u00e9") by code unit.
    const want = [NFD, NFC];
    for (const sort of SORTS) {
      expect(await render([NFC, NFD], sort), `nfc-first ${sort}`).toEqual(want);
      expect(await render([NFD, NFC], sort), `nfd-first ${sort}`).toEqual(want);
    }
  });
});
