/**
 * Protected acceptance: select and link a line range without editing the URL.
 *
 * Runs the REAL rendered code-viewer page + its REAL inline script in the
 * disposable VM/DOM harness (see code-line-range.harness.ts). The workerd
 * companion `test/code-line-range.acceptance.test.ts` pins the same markup,
 * script hash, ETag and raw bytes over HTTP. This VM cannot prove visual
 * layout (narrow widths, wrapped-line painting) or native screen-reader
 * behaviour; those need the Builder's real-browser check.
 *
 * Deterministic contract choices pinned here (from the card's outcome
 * contract): the shift-click anchor is the first line of the current valid
 * `#L…` hash selection (so manual hashes and Back/Forward behave the same as
 * clicked selections); an equal endpoint collapses to a single `#Ln`; each
 * successful selection pushes exactly one history entry; keyboard inputs are
 * bounded with min=1 / max=<rendered line count> in the server markup.
 *
 * Only the Test Author may change this file or its protected helpers.
 * Run: npm run test:browser-code -- test/code-line-range.acceptance.test.ts
 */
import { describe, expect, it } from "vitest";
import { mount, PAGE_URL, twelveLines, type Mounted } from "./code-line-range.harness.ts";

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Selections may change only the fragment/highlight: nothing else may move. */
function expectOnlyFragmentChanged(m: Mounted, before: { depth: number; storage: string[]; network: string[] }) {
  expect(m.url().origin + m.url().pathname + m.url().search).toBe(new URL(PAGE_URL).origin + new URL(PAGE_URL).pathname + new URL(PAGE_URL).search);
  expect(m.network).toEqual(before.network);
  expect(m.storageLog).toEqual(before.storage);
  expect(m.browser.navigations).toEqual([]);
  expect(m.browser.formSubmits).toBe(0);
  expect(m.historyDepth() - before.depth).toBeLessThanOrEqual(1);
}
const snapshot = (m: Mounted) => ({ depth: m.historyDepth(), storage: [...m.storageLog], network: [...m.network] });

// --- Positive controls: baseline behaviour that must keep working. A failure
// here means the fixture/runtime is broken, not that the feature is missing.
describe("controls (pre-existing behaviour)", () => {
  it("renders one real anchor per line and keeps hostile source inert as text", async () => {
    const m = await mount();
    expect(m.renderedLineNumbers()).toEqual(range(1, 12));
    for (const n of [1, 12]) {
      expect(m.lineRow(n)?.id).toBe(`L${n}`);
      expect(m.lineAnchor(n).getAttribute("href")).toBe(`#L${n}`);
    }
    expect(m.lineRow(3)?.textContent).toContain('"</script><script>alert(1)</script>"');
    expect(m.doc.querySelectorAll("script")).toHaveLength(1);
    expect(m.doc.querySelectorAll("img")).toHaveLength(0);
  });

  it("highlights a manually supplied range hash on load, reversed hashes included", async () => {
    expect((await mount(twelveLines, { initialHash: "#L3-L5" })).highlighted()).toEqual([3, 4, 5]);
    expect((await mount(twelveLines, { initialHash: "#L5-L2" })).highlighted()).toEqual([2, 3, 4, 5]);
    expect((await mount(twelveLines, { initialHash: "#L4-L4" })).highlighted()).toEqual([4]);
  });

  it("malformed hashes highlight nothing, never throw, and later hashes still work", async () => {
    const m = await mount();
    for (const bad of ["#L0", "#L999", "#Labc", "#foo", "#L-1", "#L1.5", "#L1-L2-L3", "#L999999-L9999999", "#"]) {
      await m.setHashManual(bad);
      expect(m.highlighted(), bad).toEqual([]);
    }
    await m.setHashManual("#L2-L3");
    expect(m.highlighted()).toEqual([2, 3]);
  });

  it("normal line-number activation keeps plain #Ln behaviour", async () => {
    const m = await mount();
    const before = snapshot(m);
    await m.clickLine(4);
    expect(m.hash()).toBe("#L4");
    expect(m.highlighted().filter((n) => n !== 4)).toEqual([]);
    expectOnlyFragmentChanged(m, before);
    expect(m.historyDepth()).toBe(before.depth + 1);
  });

  it("Copy still copies the whole shown file text and nothing else", async () => {
    const m = await mount();
    await m.setHashManual("#L2-L3");
    const copy = m.doc.querySelectorAll("button").find((b) => b.textContent.trim() === "Copy");
    expect(copy, "Copy button").toBeDefined();
    await m.click(copy!);
    await m.settle();
    expect(m.clipboard).toEqual([twelveLines.text.replace(/\n$/, "")]);
  });

  it("Wrap is still a labelled toggle for the same checkbox control", async () => {
    const m = await mount();
    const wrap = m.doc.getElementById("dw-wrap");
    expect(wrap?.type).toBe("checkbox");
    const label = m.doc.querySelectorAll("label").find((l) => l.getAttribute("for") === "dw-wrap");
    expect(label?.textContent.trim()).toBe("Wrap");
    expect(wrap!.checked).toBe(false);
    await m.click(label!);
    expect(m.doc.getElementById("dw-wrap")!.checked).toBe(true);
    expect(m.hash()).toBe("");
  });

  it("modified (ctrl) clicks are not hijacked into a same-tab selection", async () => {
    const m = await mount(twelveLines, { initialHash: "#L2-L4" });
    await m.modifiedClickLine(9);
    expect(m.hash()).toBe("#L2-L4");
    expect(m.highlighted()).toEqual([2, 3, 4]);
  });
});

// --- Shift-click range selection.
describe("shift-click line ranges", () => {
  it("click then shift-click selects the inclusive range with one history entry", async () => {
    const m = await mount();
    await m.clickLine(3);
    const before = snapshot(m);
    await m.shiftClickLine(7);
    expect(m.hash()).toBe("#L3-L7");
    expect(m.highlighted()).toEqual(range(3, 7));
    expect(m.historyDepth()).toBe(before.depth + 1);
    expectOnlyFragmentChanged(m, before);
  });

  it("shift-click above the anchor normalizes to #Lmin-Lmax", async () => {
    const m = await mount();
    await m.clickLine(9);
    await m.shiftClickLine(4);
    expect(m.hash()).toBe("#L4-L9");
    expect(m.highlighted()).toEqual(range(4, 9));
  });

  it("first shift-click with no established anchor selects just that line", async () => {
    const m = await mount();
    await m.shiftClickLine(6);
    expect(m.hash()).toBe("#L6");
    expect(m.highlighted().filter((n) => n !== 6)).toEqual([]);
  });

  it("shift-click with only a malformed hash behaves like no anchor", async () => {
    const m = await mount(twelveLines, { initialHash: "#nonsense" });
    await m.shiftClickLine(6);
    expect(m.hash()).toBe("#L6");
  });

  it("first shift-click stays in the current tab: no new-window navigation", async () => {
    const m = await mount();
    const before = snapshot(m);
    await m.shiftClickLine(6);
    expect(m.hash()).toBe("#L6");
    expect(m.highlighted().filter((n) => n !== 6)).toEqual([]);
    expect(m.historyDepth()).toBe(before.depth + 1);
    // A real shift-click opens a new window unless the page cancels it. The
    // harness records that native target; handled selection must cancel it.
    expect(m.browser.navigations).toEqual([]);
    expectOnlyFragmentChanged(m, before);
  });

  it.each([
    { name: "shift+ctrl", run: (m: Mounted) => m.shiftCtrlClickLine(9) },
    { name: "shift+meta", run: (m: Mounted) => m.shiftMetaClickLine(9) },
    { name: "shift+alt", run: (m: Mounted) => m.shiftAltClickLine(9) },
  ])("shifted modified activation ($name) keeps the current range and retains native semantics", async ({ run }) => {
    const m = await mount(twelveLines, { initialHash: "#L2-L4" });
    const depth = m.historyDepth();
    await run(m);
    expect(m.hash()).toBe("#L2-L4");
    expect(m.highlighted()).toEqual([2, 3, 4]);
    expect(m.historyDepth()).toBe(depth);
    // Native modified-link behavior opens the target elsewhere; the guard must
    // leave it uncancelled and the current tab untouched.
    expect(m.browser.navigations).toHaveLength(1);
    expect(m.browser.navigations[0]).toContain("#L9");
  });

  it("repeated shift-clicks re-extend from the established first line", async () => {
    const m = await mount();
    await m.clickLine(3);
    await m.shiftClickLine(8);
    expect(m.hash()).toBe("#L3-L8");
    await m.shiftClickLine(11);
    expect(m.hash()).toBe("#L3-L11");
    await m.shiftClickLine(2);
    expect(m.hash()).toBe("#L2-L3");
    expect(m.highlighted()).toEqual([2, 3]);
  });

  it("shift-clicking the anchor itself collapses to the single line", async () => {
    const m = await mount();
    await m.clickLine(5);
    await m.shiftClickLine(5);
    expect(m.hash()).toBe("#L5");
  });

  it("a manually supplied range is the anchor for the next shift-click", async () => {
    const m = await mount(twelveLines, { initialHash: "#L4-L9" });
    await m.shiftClickLine(11);
    expect(m.hash()).toBe("#L4-L11");
    const m2 = await mount(twelveLines, { initialHash: "#L4-L9" });
    await m2.shiftClickLine(2);
    expect(m2.hash()).toBe("#L2-L4");
    const m3 = await mount(twelveLines, { initialHash: "#L4-L9" });
    await m3.shiftClickLine(6);
    expect(m3.hash()).toBe("#L4-L6");
  });

  it("a subsequent normal activation replaces the range with a single line", async () => {
    const m = await mount();
    await m.clickLine(3);
    await m.shiftClickLine(8);
    await m.clickLine(10);
    expect(m.hash()).toBe("#L10");
    expect(m.highlighted().filter((n) => n !== 10)).toEqual([]);
  });

  it("Back and Forward restore hash and highlight, and the restored selection anchors again", async () => {
    const m = await mount();
    await m.clickLine(2);
    await m.shiftClickLine(5);
    expect(m.hash()).toBe("#L2-L5");
    await m.back();
    expect(m.hash()).toBe("#L2");
    expect(m.highlighted().filter((n) => n !== 2)).toEqual([]);
    await m.forward();
    expect(m.hash()).toBe("#L2-L5");
    expect(m.highlighted()).toEqual(range(2, 5));
    await m.back();
    await m.shiftClickLine(9);
    expect(m.hash()).toBe("#L2-L9");
  });

  it("rapid hash changes settle on the last selection only", async () => {
    const m = await mount();
    m.browser.location.hash = "#L1-L2";
    m.browser.location.hash = "#L10-L12";
    await m.settle();
    expect(m.hash()).toBe("#L10-L12");
    expect(m.highlighted()).toEqual([10, 11, 12]);
  });
});

// --- Keyboard range selection in the existing toolbar.
describe("keyboard line-range selection", () => {
  it("exposes labelled first/last inputs bounded to the rendered lines plus a Select action", async () => {
    const m = await mount();
    const { first, last, button } = m.rangeControls();
    for (const input of [first, last]) {
      expect(input.getAttribute("min")).toBe("1");
      expect(input.getAttribute("max")).toBe("12");
      expect(input.type === "number" || input.getAttribute("inputmode") === "numeric").toBe(true);
    }
    expect(button.textContent.trim() || button.getAttribute("aria-label") || "").toMatch(/select/i);
  });

  it("selects an inclusive range, normalizes reversed input, and collapses equal ends", async () => {
    const m = await mount();
    const before = snapshot(m);
    await m.keyboardSelect("4", "9");
    expect(m.hash()).toBe("#L4-L9");
    expect(m.highlighted()).toEqual(range(4, 9));
    expect(m.historyDepth()).toBe(before.depth + 1);
    expectOnlyFragmentChanged(m, before);
    expect(m.doc.activeElement).not.toBe(m.doc.body);
    await m.keyboardSelect("9", "4");
    expect(m.hash()).toBe("#L4-L9");
    await m.keyboardSelect("6", "6");
    expect(m.hash()).toBe("#L6");
  });

  it.each([
    { which: "first" as const },
    { which: "last" as const },
  ])("Enter in the $which line input selects the normalized range without leaving the toolbar", async ({ which }) => {
    const m = await mount();
    const before = snapshot(m);
    // Reversed values prove normalization; the handler lives on the input,
    // not the Select button, so Enter must work from either field.
    await m.keyboardSelectViaInput(which, "9", "4");
    expect(m.hash()).toBe("#L4-L9");
    expect(m.highlighted()).toEqual(range(4, 9));
    expect(m.historyDepth()).toBe(before.depth + 1);
    expectOnlyFragmentChanged(m, before);
    const { first, last, button } = m.rangeControls();
    expect([first, last, button]).toContain(m.doc.activeElement);
    expect(m.doc.activeElement).not.toBe(m.doc.body);
  });

  it.each([
    { first: "", last: "5", name: "empty first" },
    { first: "3", last: "", name: "empty last" },
    { first: "0", last: "5", name: "zero" },
    { first: "-2", last: "5", name: "negative" },
    { first: "x", last: "5", name: "non-numeric" },
    { first: "2.5", last: "5", name: "fractional" },
    { first: "3", last: "13", name: "beyond the last rendered line" },
    { first: "9999", last: "99999", name: "far beyond the file" },
  ])("invalid input ($name) explains itself, changes nothing, and keeps focus usable", async ({ first, last }) => {
    const m = await mount(twelveLines, { initialHash: "#L2-L3" });
    const beforeText = m.toolbarText();
    const depth = m.historyDepth();
    await m.keyboardSelect(first, last);
    expect(m.hash()).toBe("#L2-L3");
    expect(m.highlighted()).toEqual([2, 3]);
    expect(m.historyDepth()).toBe(depth);
    expect(m.explanations(beforeText)).toMatch(/line|range|between|valid|number/i);
    const { first: f, last: l, button } = m.rangeControls();
    expect([f, l, button]).toContain(m.doc.activeElement);
    expect(m.network).toEqual([]);
    expect(m.browser.formSubmits).toBe(0);
  });

  it("a valid selection after an invalid one works and clears the complaint", async () => {
    const m = await mount();
    await m.keyboardSelect("0", "5");
    await m.keyboardSelect("2", "5");
    expect(m.hash()).toBe("#L2-L5");
    expect(m.highlighted()).toEqual(range(2, 5));
  });

  it("keyboard selection replaces a shift-click selection deterministically", async () => {
    const m = await mount();
    await m.clickLine(8);
    await m.shiftClickLine(11);
    await m.keyboardSelect("1", "3");
    expect(m.hash()).toBe("#L1-L3");
    expect(m.highlighted()).toEqual([1, 2, 3]);
  });
});

// --- Ceilings and truncated sources.
describe("ceilings and truncated sources", () => {
  const manyLines = { path: "notes.txt", text: Array.from({ length: 5100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n" };

  it("control: a manual range highlights at most the existing 5000-line ceiling", async () => {
    const m = await mount(manyLines, { initialHash: "#L1-L5100" });
    const hl = m.highlighted();
    expect(hl).toHaveLength(5000);
    expect(hl[0]).toBe(1);
    expect(hl[hl.length - 1]).toBe(5000);
  });

  it("shift-click across the ceiling still highlights only the ceiling", async () => {
    const m = await mount(manyLines);
    await m.clickLine(1);
    await m.shiftClickLine(5100);
    expect(m.hash()).toBe("#L1-L5100");
    const hl = m.highlighted();
    expect(hl).toHaveLength(5000);
    expect(hl[hl.length - 1]).toBe(5000);
  });

  it("keyboard selection over the ceiling is explained, never silently partial", async () => {
    const m = await mount(manyLines);
    const beforeText = m.toolbarText();
    await m.keyboardSelect("1", "5100");
    // Either the selection is refused (hash/highlight unchanged) or it is
    // accepted with the ceiling made explicit; both must explain the limit.
    expect(m.explanations(beforeText)).toMatch(/5000|limit|at most|maximum|cap/i);
    if (m.hash() === "#L1-L5100") {
      expect(m.highlighted()).toHaveLength(5000);
    } else {
      expect(m.hash()).toBe("");
      expect(m.highlighted()).toEqual([]);
    }
  });

  it("lines exist in a truncated source only where rendered; omitted lines cannot be selected", async () => {
    const truncated = { path: "big.txt", text: Array.from({ length: 20 }, (_, i) => `line${i + 1}-` + "a".repeat(60 * 1024)).join("\n") + "\n" };
    const m = await mount(truncated);
    const rendered = m.renderedLineNumbers();
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(20);
    const max = rendered[rendered.length - 1]!;
    const { first, last } = m.rangeControls();
    expect(first.getAttribute("max")).toBe(String(max));
    expect(last.getAttribute("max")).toBe(String(max));
    const beforeText = m.toolbarText();
    await m.keyboardSelect("1", "20");
    expect(m.hash()).toBe("");
    expect(m.explanations(beforeText)).toMatch(/line|range|between|valid|shown/i);
    await m.keyboardSelect("1", String(max));
    const hl = m.highlighted();
    expect(hl[hl.length - 1] ?? 0).toBeLessThanOrEqual(max);
    expect(m.hash()).toBe(`#L1-L${max}`);
  });
});
