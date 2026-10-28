/** Protected acceptance: only the Test Author may edit this file and its helper.
 * npm run test:cli -- test/encrypted/manifest-filter.acceptance.test.ts
 * Runs the served dashboard in Chromium on a disposable local Worker. Intentionally
 * RED until matching inventory feedback is implemented; no acceptance-only merge.
 */
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  base, clear, feedback, files, filter, flush, id, inViewport, localState, mixed,
  pathOrder, paths, query, sizeDescending, sort, startManifestFixture, statuses,
  visibleRows, type ManifestView,
} from "./manifest-filter.helpers.ts";

let fixture: Awaited<ReturnType<typeof startManifestFixture>>;
beforeAll(async () => { fixture = await startManifestFixture(); }, 120_000);
afterEach(async () => { await fixture?.closeViews(); });
afterAll(async () => { await fixture?.dispose(); });
async function expectPaths(v: ManifestView, expected: string[]) {
  await expect.poll(() => paths(v)).toEqual(expected);
}
async function selected(v: ManifestView, number: number) {
  await expect.poll(() => files(v).innerText()).toMatch(new RegExp(`Files in v${number}\\b`));
  expect(new URL(v.page.url()).searchParams.get("version")).toBe(id(number));
}
async function noEffects(v: ManifestView, before: Awaited<ReturnType<typeof localState>>) {
  await flush(v);
  expect(v.requests, "filter, Clear and sort are local, not remote searches or downloads").toEqual([]);
  expect(await localState(v), "no credential/preference writes or history/selection changes").toEqual(before);
}
async function focusIsFilter(v: ManifestView) {
  expect(await filter(v).evaluate(el => (globalThis as any).document.activeElement === el), "typing/Clear leaves focus on the path filter").toBe(true);
}

async function rowControls(v: ManifestView) {
  await v.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: v.origin });
  for (const entry of mixed) {
    const row = visibleRows(v).filter({ has: v.page.getByRole("cell", { name: entry.path, exact: true }) });
    expect(await row.innerText()).toContain(entry.sha256);
    await row.getByRole("button", { name: /copy.*(?:sha.?256|checksum)/i }).click();
    expect(await v.page.evaluate(() => (globalThis as any).navigator.clipboard.readText())).toBe(entry.sha256);
  }
  const row = visibleRows(v).filter({ has: v.page.getByRole("cell", { name: "docs/a[1].txt", exact: true }) });
  v.requests.length = 0;
  const pending = v.page.waitForEvent("download");
  await row.getByRole("button", { name: /^download$/i }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("a[1].txt");
  expect(await readFile((await download.path())!, "utf8")).toBe(`selected=${id(1)};path=docs/a[1].txt`);
  expect(v.requests).toHaveLength(1);
  const target = new URL(v.requests[0]!.slice("GET ".length));
  expect(target.pathname).toBe(`${base}/files/docs/a%5B1%5D.txt`);
  expect(target.searchParams.get("version")).toBe(id(1));
}

// Positive control: catches fixture wiring, missing script execution and wrong
// version targeting separately from deliberately missing count/empty feedback.
describe("selected-version inventory fixture control", () => {
  it("renders six mixed-size historical files and keeps local filter/sort identity", async () => {
    const v = await fixture.open();
    await selected(v, 1);
    await sort(v, "Path", "ascending");
    await expectPaths(v, pathOrder);
    const before = await localState(v); v.requests.length = 0;
    await query(v, "DOCS/");
    await expectPaths(v, ["docs/Guide.txt", "docs/a[1].txt"]);
    await sort(v, "Size", "descending");
    await expectPaths(v, ["docs/Guide.txt", "docs/a[1].txt"]);
    await query(v, "");
    await expectPaths(v, sizeDescending);
    await noEffects(v, before);
  });
});

it("prerequisite: checksum controls and an actual immutable download work after manual reset", async () => {
  const v = await fixture.open();
  await sort(v, "Size", "descending");
  await query(v, "docs/");
  await query(v, "");
  await rowControls(v);
});

// Breaks: reporting the unfiltered row count after filtering, summing hidden
// bytes, counting live/history rows instead of the selected loaded manifest,
// omitting live announcements or moving focus while the person types.
describe("accessible matching / loaded inventory feedback", () => {
  it.each([
    { text: "", expected: pathOrder, count: 6, bytes: 100, name: "unfiltered inventory" },
    { text: "DoCs/", expected: ["docs/Guide.txt", "docs/a[1].txt"], count: 2, bytes: 40, name: "mixed-case path" },
    { text: "empty.txt", expected: ["empty.txt"], count: 1, bytes: 0, name: "zero-byte file" },
    { text: "資料/café-🙂", expected: ["資料/CAFÉ-🙂.txt"], count: 1, bytes: 7, name: "Unicode path" },
    { text: "[1]", expected: ["docs/a[1].txt"], count: 1, bytes: 11, name: "literal regex punctuation" },
    { text: "<b>&", expected: ["markup/<b>&quote.txt"], count: 1, bytes: 13, name: "literal path markup" },
    { text: ".*", expected: [], count: 0, bytes: 0, name: "literal wildcard, not a regular expression" },
  ])("announces $name with independently calculated matching bytes", async ({ text, expected, count, bytes }) => {
    const v = await fixture.open();
    await sort(v, "Path", "ascending");
    const before = await localState(v); v.requests.length = 0;
    await query(v, text);
    await expectPaths(v, expected);
    await focusIsFilter(v);
    await noEffects(v, before);
    expect(await files(v).locator("b,img,iframe,script").count(), "path/query markup stays inert on the app origin").toBe(0);
    await feedback(v, count, 6, bytes);
  });

  it("changes the same live region while typing and leaves the filter focused", async () => {
    const v = await fixture.open();
    await filter(v).focus();
    expect(await filter(v).ariaSnapshot(), "path filter has an accessible name").toMatch(/searchbox\s+"[^"]+"/);
    const count = statuses(v).filter({ hasText: /loaded|selected[\s-]+version/i }).first();
    expect(await count.count(), "persistent accessible inventory announcement").toBe(1);
    const handle = await count.elementHandle();
    const before = await localState(v); v.requests.length = 0;
    await filter(v).pressSequentially("docs"); await flush(v);
    await focusIsFilter(v); await feedback(v, 2, 6, 40);
    expect(await handle!.evaluate(el => el.isConnected), "typing updates rather than replacing the live region").toBe(true);
    await query(v, "no-such-path");
    await focusIsFilter(v); await feedback(v, 0, 6, 0);
    await noEffects(v, before);
  });
});

// Breaks: a blank table presented as an empty version, interpreting a query as
// markup, resetting version/sort instead of only query, inaccessible recovery.
describe("no matches, genuine emptiness and Clear recovery", () => {
  it.each([false, true])("offers keyboard Clear at a usable width (narrow=%s)", async narrow => {
    const v = await fixture.open({ narrow });
    await sort(v, "Size", "descending");
    const before = await localState(v); v.requests.length = 0;
    const hostile = '<img src=x onerror="window.__manifestQueryExecuted=true">';
    await query(v, hostile);
    await expectPaths(v, []);
    const text = await files(v).innerText();
    expect(text, "explicit no-match message, not a genuinely empty manifest").toMatch(/no\s+(?:matching\s+files|files\s+match|matches)|no\s+paths\s+match/i);
    expect(text, "query is quoted back as inert text, not only left inside the input").toContain(hostile);
    expect(text).not.toMatch(/no files (?:in|for|yet)|version is empty/i);
    expect(await files(v).locator("img,script,iframe").count()).toBe(0);
    expect(await v.page.evaluate(() => (globalThis as any).__manifestQueryExecuted ?? false)).toBe(false);
    expect(await clear(v).count(), "named Clear filter recovery").toBe(1);
    await feedback(v, 0, 6, 0);
    await inViewport(filter(v), narrow ? 360 : 1100);
    await inViewport(clear(v), narrow ? 360 : 1100);
    await inViewport(statuses(v).filter({ hasText: /loaded|selected[\s-]+version/i }).first(), narrow ? 360 : 1100);
    // Native Tab traversal, not a synthetic .click() or a programmatic focus on Clear.
    await filter(v).focus();
    let reached = false;
    for (let tab = 0; tab < 12; tab++) {
      await v.page.keyboard.press("Tab");
      reached = await clear(v).evaluate(el => (globalThis as any).document.activeElement === el);
      if (reached) break;
    }
    expect(reached, "Clear is reachable from the filter by keyboard").toBe(true);
    await v.page.keyboard.press("Enter"); await flush(v);
    expect(await filter(v).inputValue()).toBe("");
    await focusIsFilter(v); await selected(v, 1);
    expect(await files(v).getByRole("columnheader", { name: /\bsize\b/i }).getAttribute("aria-sort")).toBe("descending");
    await expectPaths(v, sizeDescending);
    await feedback(v, 6, 6, 100);
    expect(await files(v).innerText()).not.toContain(hostile);
    await noEffects(v, before);
  });

  it("calls a genuinely empty selected version empty, not a failed path search", async () => {
    const v = await fixture.open({ selected: 104 });
    await selected(v, 104);
    expect(await paths(v)).toEqual([]);
    const text = await files(v).innerText();
    expect(text).toMatch(/no files|empty|nothing/i);
    expect(text).not.toMatch(/no\s+(?:matches|matching)|files\s+match/i);
    expect(await clear(v).isVisible()).toBe(false);
    await feedback(v, 0, 0, 0);
  });
});

// Breaks: losing predicate/counts while sorting, stale denominator/byte totals
// on a version switch, row-index checksum callbacks and downloads using live.
describe("sort, immutable versions and row controls", () => {
  it("retains matching feedback in both sort directions without extra requests", async () => {
    const v = await fixture.open();
    await query(v, "docs/");
    const before = await localState(v); v.requests.length = 0;
    await sort(v, "Size", "ascending");
    await expectPaths(v, ["docs/a[1].txt", "docs/Guide.txt"]);
    expect(await filter(v).inputValue()).toBe("docs/");
    await feedback(v, 2, 6, 40);
    await sort(v, "Path", "descending");
    await expectPaths(v, ["docs/a[1].txt", "docs/Guide.txt"]);
    await feedback(v, 2, 6, 40);
    await noEffects(v, before);
  });

  it("recomputes from a different immutable manifest rather than unioning versions", async () => {
    const v = await fixture.open();
    await query(v, "docs/");
    const history = v.page.locator("section").filter({ has: v.page.getByRole("heading", { name: /^versions$/i }) });
    await history.getByRole("row").filter({ hasText: /\bv105\b/ }).getByRole("button", { name: /^files$/i }).click();
    await expect.poll(() => paths(v)).toHaveLength(2);
    await selected(v, 105);
    expect(await files(v).innerText()).not.toContain("docs/Guide.txt");
    // A version change may reset or retain the query; either way feedback must
    // derive from the NEW manifest. Apply the same query explicitly to compare.
    const before = await localState(v); v.requests.length = 0;
    await query(v, "docs/");
    await expectPaths(v, ["docs/current.txt"]);
    await feedback(v, 1, 2, 3);
    await clear(v).click(); await flush(v);
    await feedback(v, 2, 2, 8);
    await expectPaths(v, ["current-only.bin", "docs/current.txt"]);
    await noEffects(v, before);
  });

  it("preserves each checksum and pinned download after filtering, sorting and Clear", async () => {
    const v = await fixture.open();
    await sort(v, "Size", "descending");
    await query(v, "no-such-path");
    await clear(v).click(); await flush(v);
    await expectPaths(v, sizeDescending); await selected(v, 1);
    await rowControls(v);
  });
});
