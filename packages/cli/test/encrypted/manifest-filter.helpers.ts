/** Protected acceptance fixture: only the Test Author may edit this file.
 * Reuses the disposable loopback Worker, real shell/script/CSP and sign-in from
 * the history browser fixture. Only manifest/download REST boundaries change.
 */
import { expect } from "vitest";
import type { Locator } from "playwright";
import { base, flush, id, startHistoryFixture, type View } from "./loaded-versions-filter.helpers.ts";
export { base, flush, id };

export const mixed = [
  { path: "z-last.bin", size: 40, sha256: "1".repeat(64) },
  { path: "docs/Guide.txt", size: 29, sha256: "2".repeat(64) },
  { path: "empty.txt", size: 0, sha256: "3".repeat(64) },
  { path: "資料/CAFÉ-🙂.txt", size: 7, sha256: "4".repeat(64) },
  { path: "docs/a[1].txt", size: 11, sha256: "5".repeat(64) },
  { path: "markup/<b>&quote.txt", size: 13, sha256: "6".repeat(64) },
];
export const pathOrder = ["docs/Guide.txt", "docs/a[1].txt", "empty.txt", "markup/<b>&quote.txt", "z-last.bin", "資料/CAFÉ-🙂.txt"];
export const sizeDescending = ["z-last.bin", "docs/Guide.txt", "markup/<b>&quote.txt", "docs/a[1].txt", "資料/CAFÉ-🙂.txt", "empty.txt"];
const current = [
  { path: "docs/current.txt", size: 3, sha256: "a".repeat(64) },
  { path: "current-only.bin", size: 5, sha256: "b".repeat(64) },
];
export type ManifestView = View & { requests: string[]; origin: string };
export const files = (v: ManifestView) => v.page.locator("#files");
export const filter = (v: ManifestView) => files(v).locator('input[type="search"]');
export const clear = (v: ManifestView) => files(v).getByRole("button", { name: /^clear(?:\s+(?:path\s+)?filter)?$/i });
export const statuses = (v: ManifestView) => files(v).locator('[role="status"], [aria-live="polite"], [aria-live="assertive"]');
export const visibleRows = (v: ManifestView) => files(v).locator("tbody tr:visible").filter({ has: v.page.getByRole("button", { name: /^download$/i }) });
export async function paths(v: ManifestView) {
  return visibleRows(v).evaluateAll(rows => rows.map(row => row.querySelector("td")!.textContent!.trim()));
}
export async function startManifestFixture() {
  const fixture = await startHistoryFixture();
  return {
    ...fixture,
    async open(options: { narrow?: boolean; selected?: number } = {}) {
      const view = await fixture.open({ linked: options.selected ?? 1, narrow: options.narrow });
      const origin = new URL(view.page.url()).origin;
      const v: ManifestView = Object.assign(view, { requests: [] as string[], origin });
      v.page.on("request", request => v.requests.push(`${request.method()} ${request.url()}`));
      await v.context.addInitScript(() => {
        const g = globalThis as any;
        g.__manifestStorageWrites = [];
        for (const method of ["setItem", "removeItem", "clear"] as const) {
          const original = g.Storage.prototype[method];
          g.Storage.prototype[method] = function (...args: unknown[]) {
            g.__manifestStorageWrites.push(method);
            return original.apply(this, args);
          };
        }
      });
      await v.context.route(`${origin}${base}/files**`, async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() !== "GET") {
          v.violations.push(`unexpected manifest mutation ${request.method()}`);
          return route.abort("blockedbyclient");
        }
        const selected = url.searchParams.get("version");
        const version = v.versions.find(row => row.id === selected);
        if (!version) {
          v.violations.push("manifest/download omitted immutable version id");
          return route.abort("blockedbyclient");
        }
        const inventory = selected === id(1) ? mixed : selected === id(104) ? [] : current;
        if (url.pathname === `${base}/files`) {
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({
            version: { ...version, fileCount: inventory.length, totalBytes: selected === id(1) ? 100 : selected === id(104) ? 0 : 8 },
            files: inventory.map(entry => ({ ...entry, contentType: "text/plain", kind: "text", extension: "txt",
              url: `${origin}/s/loaded-version-history/${entry.path.split("/").map(encodeURIComponent).join("/")}`,
              rawUrl: `${base}/files/${entry.path.split("/").map(encodeURIComponent).join("/")}`,
            })), total: inventory.length, nextCursor: null,
          }) });
        }
        const path = url.pathname.slice(`${base}/files/`.length).split("/").map(decodeURIComponent).join("/");
        const entry = inventory.find(file => file.path === path);
        if (!entry) {
          v.violations.push(`download of a path outside the selected inventory: ${path}`);
          return route.abort("blockedbyclient");
        }
        // Controlled bytes distinguish immutable selections; this is not a hash
        // verification test. SHA controls must copy the manifest's exact value.
        return route.fulfill({ contentType: "application/octet-stream", body: `selected=${selected};path=${path}`,
          headers: { "Content-Disposition": "attachment" } });
      });
      await v.page.reload({ waitUntil: "networkidle" });
      await expect.poll(() => files(v).innerText()).toMatch(new RegExp(`Files in v${options.selected ?? 1}\\b`));
      if ((options.selected ?? 1) !== 104) await expect.poll(() => paths(v)).toHaveLength((options.selected ?? 1) === 1 ? 6 : 2);
      return v;
    },
  };
}
export async function query(v: ManifestView, text: string) {
  await filter(v).fill(text);
  await flush(v);
}
export async function sort(v: ManifestView, field: "Path" | "Size", direction: "ascending" | "descending") {
  const header = files(v).getByRole("columnheader", { name: new RegExp(`\\b${field}\\b`, "i") });
  for (let attempts = 0; attempts < 3; attempts++) {
    if (await header.getAttribute("aria-sort") === direction) return;
    await header.getByRole("button").click();
  }
  expect(await header.getAttribute("aria-sort"), `${field} ${direction}`).toBe(direction);
}
export async function feedback(v: ManifestView, matching: number, loaded: number, bytes: number) {
  const text = (await statuses(v).allTextContents()).join(" ");
  expect(text, "file feedback must announce live changes through an accessible status region").not.toBe("");
  expect(text, "scope is loaded/selected-version inventory, not server-wide search").toMatch(/loaded|selected[\s-]+version/i);
  if (matching === loaded) {
    expect(text, "unfiltered loaded total").toMatch(new RegExp(`\\b${loaded}\\s*(?:files?|loaded|of|/|match)`, "i"));
  } else {
    expect(text, "matching numerator").toMatch(new RegExp(`\\b${matching}\\s*(?:/|of|match|files?\\s+match)`, "i"));
    expect(text, "loaded denominator").toMatch(new RegExp(`(?:/|of)\\s*${loaded}\\b|\\b${loaded}\\s+(?:loaded\\s+)?files?`, "i"));
  }
  expect(text, "sum only matching manifest bytes").toMatch(new RegExp(`\\b${bytes}\\s*(?:B|bytes?)\\b`, "i"));
  expect(text).not.toMatch(/all (?:site|server|version)s|server.wide|every version/i);
}
export async function localState(v: ManifestView) {
  return v.page.evaluate(async () => {
    const g = globalThis as any;
    const digest = async (storage: unknown) => Array.from(new Uint8Array(await g.crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(JSON.stringify(storage)),
    ))).join(",");
    return { url: g.location.href, history: g.history.length, state: JSON.stringify(g.history.state),
      local: await digest(g.localStorage), session: await digest(g.sessionStorage), writes: [...g.__manifestStorageWrites] };
  });
}
export async function inViewport(locator: Locator, width: number) {
  const box = await locator.boundingBox();
  expect(box, "visible usable control/status").not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
}
