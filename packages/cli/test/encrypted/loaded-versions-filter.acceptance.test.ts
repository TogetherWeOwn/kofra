/**
 * Protected acceptance tests: only the Test Author may change this file.
 *
 * Runs the real served dashboard shell/script/CSP in Chromium on a disposable
 * loopback Worker, using the existing encrypted/ test-only browser harness.
 * Only version/file API responses are controlled (105 immutable versions).
 * No source transforms, production requests, remote fixtures or new dependencies.
 *
 * npm ci --include=dev
 * npm ci --prefix packages/cli/test/encrypted --include=dev
 * packages/cli/test/encrypted/node_modules/.bin/playwright install chromium
 * npm run test:cli -- test/encrypted/loaded-versions-filter.acceptance.test.ts
 *
 * The tests are intentionally RED until the Builder implements loaded-only
 * filtering. Do not merge this tests-only branch or weaken these assertions.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  artifact, base, clear, filter, flush, history, id, markup, numbers, row, rows,
  startHistoryFixture, state, type View,
} from "./loaded-versions-filter.helpers.ts";

let fixture: Awaited<ReturnType<typeof startHistoryFixture>>;
beforeAll(async () => { fixture = await startHistoryFixture(); }, 120_000);
afterEach(async () => { await fixture?.closeViews(); });
afterAll(async () => { await fixture?.dispose(); });

async function requireFilter(view: View) {
  expect(await filter(view).count(), "Versions must expose the labelled Filter loaded versions input").toBe(1);
  expect(await filter(view).isVisible(), "the filter is available next to Versions, not hidden markup").toBe(true);
  expect(await clear(view).count(), "Versions must expose a named Clear button").toBe(1);
}
async function query(view: View, value: string) {
  await requireFilter(view);
  await filter(view).fill(value);
  await flush(view);
}
async function expectNumbers(view: View, expected: number[]) {
  await expect.poll(() => numbers(view)).toEqual(expected);
}
const loadedNumbers = Array.from({ length: 100 }, (_, index) => 105 - index);
const mutations = (view: View) => view.wire.filter(call => call.method !== "GET");

// Break: a fake harness that never executes the served script, or ignores the
// version argument, must not be mistaken for feature-assertion RED evidence.
describe("real served history harness prerequisites", () => {
  it("renders the bounded page and binds an unfiltered Files click to an immutable id", async () => {
    const view = await fixture.open();
    await expectNumbers(view, loadedNumbers);
    expect(await row(view, 1).count(), "the old version is outside the 100 loaded rows").toBe(0);
    view.wire.length = 0;
    await row(view, 103).getByRole("button", { name: /^files$/i }).click();
    await expect.poll(() => view.page.locator("#files").innerText()).toContain(artifact(103));
    expect(view.wire.filter(call => call.path === `${base}/files`)).toEqual([
      { method: "GET", path: `${base}/files`, query: `?version=${id(103)}`, body: null },
    ]);
    expect(mutations(view)).toEqual([]);
  });

  it("resolves a direct historical link outside the loaded page before any filtering", async () => {
    const view = await fixture.open({ linked: 1 });
    await expectNumbers(view, loadedNumbers);
    expect(view.wire.some(call => call.path === `${base}/versions/${id(1)}` && call.method === "GET")).toBe(true);
    expect(await view.page.locator("#files").innerText()).toContain(artifact(1));
  });
});

// Break: omitting one metadata field, using case-sensitive matching, converting
// user text to a RegExp, coercing null to searchable text, or sorting matches.
describe("literal matching over only the loaded versions", () => {
  it.each([
    { text: "v73", expected: [73], field: "v-prefixed version number" },
    { text: "73", expected: [73], field: "plain version number" },
    { text: "V73", expected: [73], field: "case-insensitive version label" },
    { text: "HISTORY-RELEASE-42", expected: [42], field: "immutable id" },
    { text: "nEeDlE", expected: [104, 102], field: "message in server order" },
    { text: "dEsKtOp/2.7", expected: [42], field: "client" },
    { text: "McP", expected: [64], field: "source" },
    { text: "[blue].* + (safe)", expected: [103], field: "literal punctuation" },
    { text: ".*", expected: [103], field: "literal regex metacharacters" },
    { text: "[", expected: [103], field: "unbalanced regex punctuation" },
    { text: "null", expected: [], field: "null metadata is empty" },
    { text: "old linked release", expected: [], field: "unloaded history is not searched" },
  ])("matches $field without requests or selection changes", async ({ text, expected }) => {
    const view = await fixture.open({ linked: 41 });
    const before = await state(view);
    view.wire.length = 0;
    await query(view, text);
    await expectNumbers(view, expected);
    expect(await state(view), "local filtering preserves selected files, URL/history and credentials").toEqual(before);
    expect(view.wire, "typing must not fetch, restore, delete, download or export").toEqual([]);
    expect(view.dialogs).toEqual([]);
  });

  it("renders hostile message/query characters as text rather than HTML", async () => {
    const view = await fixture.open({ linked: 41 });
    const before = await state(view);
    view.wire.length = 0;
    await query(view, markup);
    await expectNumbers(view, [87]);
    expect(await rows(view).innerText()).toContain(markup);
    expect(await history(view).locator("img,script,iframe").count(), "user metadata never becomes app-origin elements").toBe(0);
    expect(await view.page.evaluate(() => (globalThis as any).__historyMarkupExecuted ?? false)).toBe(false);
    expect(view.wire).toEqual([]);
    expect(await state(view)).toEqual(before);
  });
});

// Break: claiming complete-history search, announcing the wrong numerator or
// denominator, conflating an empty account with zero local matches, or using
// Clear to reset file selection instead of only the history predicate.
describe("bounded counts, empty states and reset", () => {
  it("announces matching/loaded counts and the newest-100 limit, including zero and reset", async () => {
    const view = await fixture.open({ linked: 41 });
    await requireFilter(view);
    const status = history(view).locator('[role="status"], [aria-live="polite"], [aria-live="assertive"]');
    expect(await status.count(), "Versions needs an accessible count/status region").toBeGreaterThan(0);
    const before = await state(view);
    view.wire.length = 0;
    expect(await history(view).innerText(), "scope must say newest loaded 100, not all history").toMatch(/(?:newest|latest)[\s\S]{0,100}100|100[\s\S]{0,100}(?:newest|latest)/i);
    expect(await status.allTextContents()).toEqual(expect.arrayContaining([expect.stringMatching(/100/)]));
    await query(view, "needle");
    const matched = (await status.allTextContents()).join(" ");
    expect(matched).toMatch(/2\s+(?:match|of)|2\s*\/\s*100/i);
    expect(matched).toMatch(/100/);
    expect(matched).toMatch(/load/i);
    await query(view, "no-such-release");
    await expectNumbers(view, []);
    expect(await history(view).innerText()).toMatch(/no\s+(?:matching\s+versions|versions\s+match|matches)/i);
    expect((await status.allTextContents()).join(" ")).toMatch(/0\s+(?:match|of)|0\s*\/\s*100/i);
    await clear(view).click();
    await flush(view);
    expect(await filter(view).inputValue()).toBe("");
    await expectNumbers(view, loadedNumbers);
    expect(await state(view)).toEqual(before);
    expect(view.wire).toEqual([]);
  });

  it("distinguishes no published versions from a nonempty page with no matches", async () => {
    const empty = await fixture.open({ empty: true });
    const emptyText = await history(empty).innerText();
    expect(emptyText).toMatch(/nothing\s+published|no\s+(?:published\s+)?versions(?:\s+published|\s+yet)?/i);
    const view = await fixture.open();
    await query(view, "no-such-release");
    const noMatches = await history(view).innerText();
    expect(noMatches).toMatch(/no\s+(?:matching\s+versions|versions\s+match|matches)/i);
    expect(noMatches).not.toBe(emptyText);
    await clear(view).click();
    await expectNumbers(view, loadedNumbers);
  });

  it("can hide a directly linked old version without replacing its pinned files", async () => {
    const view = await fixture.open({ linked: 1 });
    const before = await state(view);
    view.wire.length = 0;
    await query(view, "needle");
    await expectNumbers(view, [104, 102]);
    expect(await view.page.locator("#files").innerText()).toContain(artifact(1));
    await clear(view).click();
    await flush(view);
    await expectNumbers(view, loadedNumbers);
    expect(await state(view)).toEqual(before);
    expect(view.wire, "the direct lookup must not be replaced with list/live lookups on filter or Clear").toEqual([]);
  });
});

// Break: handler indexes into the unfiltered list, silently targets live, skips
// the existing destructive confirmation, or handles refusal by changing files.
describe("filtered actions keep immutable version identity", () => {
  it("Files selects the actual matched row, not its filtered row index or live", async () => {
    const view = await fixture.open({ linked: 1 });
    await query(view, "needle");
    await expectNumbers(view, [104, 102]);
    view.wire.length = 0;
    await row(view, 102).getByRole("button", { name: /^files$/i }).click();
    await expect.poll(() => view.page.locator("#files").innerText()).toContain(artifact(102));
    expect(view.wire.filter(call => call.path === `${base}/files`)).toEqual([
      { method: "GET", path: `${base}/files`, query: `?version=${id(102)}`, body: null },
    ]);
    expect(mutations(view)).toEqual([]);
  });

  it.each(["Restore", "Delete"])("%s preserves confirmation, immutable id and selection on refusal", async action => {
    const view = await fixture.open({ linked: 1 });
    await query(view, "needle");
    await expectNumbers(view, [104, 102]);
    const before = await state(view);
    view.wire.length = 0;
    if (action === "Delete") {
      await row(view, 102).getByRole("button", { name: /^delete$/i }).click();
      const dialog = view.page.getByRole("dialog");
      expect(await dialog.innerText()).toContain("Delete v102?");
      await dialog.getByRole("button", { name: /^cancel$/i }).click();
      await flush(view);
      expect(mutations(view), "dismissed confirmation sends no mutation").toEqual([]);
      expect(await state(view)).toEqual(before);
    }
    await row(view, 102).getByRole("button", { name: new RegExp(`^${action}$`, "i") }).click();
    if (action === "Delete") {
      const dialog = view.page.getByRole("dialog");
      expect(await dialog.innerText()).toContain("Delete v102?");
      await dialog.getByRole("button", { name: /^delete version$/i }).click();
    }
    await expect.poll(() => mutations(view).length).toBe(1);
    expect(mutations(view)[0]!.method).toBe(action === "Restore" ? "POST" : "DELETE");
    expect(mutations(view)[0]!.path).toMatch(new RegExp(`^${base}/(?:versions|deploys)/${id(102)}${action === "Restore" ? "/restore" : ""}$`));
    await flush(view);
    expect(await state(view), "a refused mutation cannot select the live or first visible version").toEqual(before);
  });
});

// Break: rerender replaces a focused input, Clear is inaccessible to keyboard,
// or the new controls overflow a narrow viewport. Real layout/AX, not fake DOM.
it("keeps keyboard focus and selected files while filtering and clearing at 360px", async () => {
  const view = await fixture.open({ linked: 1, narrow: true });
  await requireFilter(view);
  const before = await state(view);
  view.wire.length = 0;
  await filter(view).focus();
  await filter(view).pressSequentially("needle");
  await flush(view);
  await expectNumbers(view, [104, 102]);
  expect(await filter(view).evaluate(element => element === element.ownerDocument.activeElement), "typing retains input focus").toBe(true);
  await filter(view).press("Tab");
  expect(await clear(view).evaluate(element => element === element.ownerDocument.activeElement), "Clear follows the labelled input in keyboard order").toBe(true);
  await clear(view).press("Enter");
  await flush(view);
  await expectNumbers(view, loadedNumbers);
  expect(await filter(view).inputValue()).toBe("");
  expect(await view.page.evaluate(() => {
    const g = globalThis as any;
    const active = g.document.activeElement;
    return active?.isConnected && active !== g.document.body;
  }), "Clear leaves focus on a connected control, never the page body").toBe(true);
  for (const control of [filter(view), clear(view)]) {
    const box = await control.boundingBox();
    expect(box, "filter controls remain rendered on narrow screens").not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, "controls fit the viewport without horizontal scrolling").toBeLessThanOrEqual(361);
  }
  expect(await filter(view).ariaSnapshot()).toMatch(/(?:textbox|searchbox).*Filter loaded versions/);
  expect(await clear(view).ariaSnapshot()).toMatch(/button.*Clear/);
  expect(await state(view)).toEqual(before);
  expect(view.wire).toEqual([]);
});
