/**
 * Protected acceptance: run the real CLIENT_SCRIPT artifact, unchanged, in the
 * existing Node VM/DOM harness. No production implementation imports beyond the
 * served artifact and no source-string assertions. See Chromium companion for
 * native keyboard, AX and 360px layout checks; VM cannot prove those properties.
 *
 * npm run test:browser-code -- test/loaded-versions-filter.acceptance.test.ts
 * Only the Test Author may change this file or its protected helpers.
 */
import { describe, expect, it } from "vitest";
import { artifact, base, id, loadedNumbers, markup } from "./loaded-versions-filter.fixtures.ts";
import { clear, filter, mount, query, settle, waitFor } from "./loaded-versions-filter.vm.ts";
import { isHidden } from "./loaded-versions-filter.dom.ts";

// Positive controls distinguish a feature failure from broken fixture/runtime
// setup. The existing ui.test.ts also pins CLIENT_SCRIPT to the served response.
describe("history VM prerequisite controls", () => {
  it("renders the actual script's newest 100 and selects a loaded immutable id", async () => {
    const m = await mount();
    expect(m.numbers()).toEqual(loadedNumbers);
    m.calls.length = 0;
    m.button(103, "Files").click();
    await waitFor(() => m.doc.querySelector("#files")!.textContent.includes(artifact(103)), "Files click");
    expect(m.calls).toContainEqual({ method: "GET", path: `${base}/files`, query: `?version=${id(103)}`, body: null });
    expect(m.violations).toEqual([]);
  });

  it("resolves a linked old version absent from the loaded page without silently selecting live", async () => {
    const m = await mount({ linked: 1 });
    expect(m.numbers()).toEqual(loadedNumbers);
    expect(m.calls).toContainEqual({ method: "GET", path: `${base}/versions/${id(1)}`, query: "", body: null });
    expect(m.doc.querySelector("#files")!.textContent).toContain(artifact(1));
    expect(m.violations).toEqual([]);
  });

  it("keeps the existing Delete dialog cancellable without sending a mutation", async () => {
    const m = await mount({ linked: 1 });
    m.calls.length = 0;
    m.button(102, "Delete").click();
    await settle();
    const dialog = m.doc.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Delete v102?");
    dialog.querySelectorAll("button").find(button => button.textContent === "Cancel")!.click();
    await settle();
    expect(m.doc.querySelector("dialog")).toBeNull();
    expect(m.calls).toEqual([]);
    expect(m.violations).toEqual([]);
  });

  it("keeps the existing direct Restore intent bound to an immutable id on refusal", async () => {
    const m = await mount({ linked: 1 });
    const before = m.snapshot();
    m.calls.length = 0;
    m.button(102, "Restore").click();
    await waitFor(() => m.calls.length > 0, "baseline Restore request");
    expect(m.calls[0]!.method).toBe("POST");
    expect(m.calls[0]!.path).toMatch(new RegExp(`^${base}/(?:versions|deploys)/${id(102)}/restore$`));
    expect(m.snapshot()).toEqual(before);
    expect(m.violations).toEqual([]);
  });
});

// Breaks caught: omitted metadata field; case-sensitive or regex-based matching;
// coercing null to "null"; searching unloaded history; sorting visible results;
// selecting the first match; using a remote query or exporting while typing.
describe("loaded-only literal version predicate", () => {
  it.each([
    { text: "v73", expected: [73], name: "vN" },
    { text: "73", expected: [73], name: "N" },
    { text: "V73", expected: [73], name: "case-insensitive vN" },
    { text: "HISTORY-RELEASE-42", expected: [42], name: "immutable id" },
    { text: "nEeDlE", expected: [104, 102], name: "message and original server order" },
    { text: "dEsKtOp/2.7", expected: [42], name: "client" },
    { text: "McP", expected: [64], name: "source" },
    { text: "[blue].* + (safe)", expected: [103], name: "punctuation" },
    { text: ".*", expected: [103], name: "regex wildcard is literal" },
    { text: "[", expected: [103], name: "unbalanced regex is literal" },
    { text: "null", expected: [], name: "null metadata" },
    { text: "old linked release", expected: [], name: "unloaded versions excluded" },
    { text: markup, expected: [87], name: "HTML is literal text" },
  ])("filters $name locally without changing selected files", async ({ text, expected }) => {
    const m = await mount({ linked: 41 });
    const before = m.snapshot();
    m.calls.length = 0;
    await query(m, text);
    await waitFor(() => JSON.stringify(m.numbers()) === JSON.stringify(expected), "literal matching results");
    expect(m.numbers()).toEqual(expected);
    expect(m.snapshot()).toEqual(before);
    expect(m.calls, "input must not fetch, restore, delete, export or download").toEqual([]);
    expect(m.dialogs).toEqual([]);
    expect(m.violations).toEqual([]);
    expect(m.section.querySelectorAll("img,iframe")).toEqual([]);
    if (text === markup) expect(m.visibleRows()[0]!.textContent).toContain(markup);
  });
});

// Breaks caught: wrong counts/complete-history promise, missing live status,
// confusing no versions with no matches, clearing selection with the predicate.
describe("bounded scope, counts and reset", () => {
  it("announces 2/100 then 0/100 and restores all loaded rows with Clear", async () => {
    const m = await mount({ linked: 41 });
    filter(m);
    const status = m.section.querySelectorAll('[role="status"], [aria-live="polite"], [aria-live="assertive"]');
    expect(status.length, "accessible count/status region").toBeGreaterThan(0);
    expect(m.section.textContent).toMatch(/(?:newest|latest)[\s\S]{0,100}100|100[\s\S]{0,100}(?:newest|latest)/i);
    const before = m.snapshot();
    m.calls.length = 0;
    await query(m, "needle");
    expect(m.numbers()).toEqual([104, 102]);
    const announcement = () => status.map(region => region.textContent).join(" ");
    expect(announcement()).toMatch(/2\s+(?:match|of)|2\s*\/\s*100/i);
    expect(announcement()).toMatch(/100/);
    expect(announcement()).toMatch(/load/i);
    await query(m, "no-such-release");
    expect(m.numbers()).toEqual([]);
    expect(announcement()).toMatch(/0\s+(?:match|of)|0\s*\/\s*100/i);
    expect(m.section.textContent).toMatch(/no\s+(?:matching\s+versions|versions\s+match|matches)/i);
    clear(m).click();
    await settle();
    expect(filter(m).value).toBe("");
    expect(m.numbers()).toEqual(loadedNumbers);
    expect(m.snapshot()).toEqual(before);
    expect(m.calls).toEqual([]);
  });

  it("does not tell a zero-match history that it has never been published", async () => {
    const empty = await mount({ empty: true });
    const emptyText = empty.section.textContent;
    expect(emptyText).toMatch(/nothing\s+published|no\s+(?:published\s+)?versions(?:\s+published|\s+yet)?/i);
    const m = await mount();
    await query(m, "no-such-release");
    expect(m.section.textContent).toMatch(/no\s+(?:matching\s+versions|versions\s+match|matches)/i);
    expect(m.section.textContent).not.toBe(emptyText);
  });

  it("preserves direct historical lookup and its files even when every loaded row is hidden", async () => {
    const m = await mount({ linked: 1 });
    const before = m.snapshot();
    m.calls.length = 0;
    await query(m, "old linked release");
    expect(m.numbers()).toEqual([]);
    expect(isHidden(m.doc.querySelector("#files")!)).toBe(false);
    expect(m.doc.querySelector("#files")!.textContent).toContain(artifact(1));
    clear(m).click();
    await settle();
    expect(m.numbers()).toEqual(loadedNumbers);
    expect(m.snapshot()).toEqual(before);
    expect(m.calls).toEqual([]);
  });
});

// Breaks caught: row-index closure targets the wrong immutable id after filter;
// confirmation cancellation mutates anyway; refusal replaces selected files.
describe("filtered row actions", () => {
  it("Files targets the second matching row's id rather than the second unfiltered row", async () => {
    const m = await mount({ linked: 1 });
    await query(m, "needle");
    expect(m.numbers()).toEqual([104, 102]);
    m.calls.length = 0;
    m.button(102, "Files").click();
    await waitFor(() => m.doc.querySelector("#files")!.textContent.includes(artifact(102)), "matched row files");
    expect(m.calls).toEqual([{ method: "GET", path: `${base}/files`, query: `?version=${id(102)}`, body: null }]);
  });

  it.each(["Restore", "Delete"])("%s confirms the matched identity and preserves selection on refusal", async action => {
    const m = await mount({ linked: 1 });
    await query(m, "needle");
    const before = m.snapshot();
    m.calls.length = 0;
    if (action === "Delete") {
      m.button(102, action).click();
      await settle();
      const dialog = m.doc.querySelector("dialog")!;
      expect(dialog.textContent).toContain("Delete v102?");
      dialog.querySelectorAll("button").find(button => button.textContent === "Cancel")!.click();
      await settle();
      expect(m.calls).toEqual([]);
      expect(m.snapshot()).toEqual(before);
    }
    m.button(102, action).click();
    if (action === "Delete") {
      await settle();
      const dialog = m.doc.querySelector("dialog")!;
      expect(dialog.textContent).toContain("Delete v102?");
      dialog.querySelectorAll("button").find(button => button.textContent === "Delete version")!.click();
    }
    await waitFor(() => m.calls.length > 0, "confirmed row action");
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.method).toBe(action === "Restore" ? "POST" : "DELETE");
    expect(m.calls[0]!.path).toMatch(new RegExp(`^${base}/(?:versions|deploys)/${id(102)}${action === "Restore" ? "/restore" : ""}$`));
    expect(m.doc.querySelector("dialog")).toBeNull();
    expect(m.snapshot()).toEqual(before);
    expect(m.violations).toEqual([]);
  });
});
