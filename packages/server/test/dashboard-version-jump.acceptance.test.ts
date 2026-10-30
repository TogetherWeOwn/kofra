/**
 * Protected acceptance contract: open an explicit version and download exactly
 * the inspected bytes. Exercises CLIENT_SCRIPT (the served app script), not a
 * replacement UI or implementation helper. Fixtures contain 105 ready versions;
 * v1 exists but is absent from the newest-100 history window.
 *
 * Selector contract is semantic: a labelled version input (not Filter/Search),
 * Open/Go, native Enter submission, and existing #files/history row controls.
 * Either pushState or replaceState is permitted. Traversing an existing history
 * entry must select its URL's version; navigation must not add entries itself.
 * Browser layout/keyboard fidelity still needs disposable-Worker verification
 * in the build handoff; this Node DOM cannot measure pixels or run native layout.
 *
 * Run: npx vitest run -c packages/server/vitest.config.ts test/dashboard-version-jump.acceptance.test.ts
 */
import { describe, expect, it } from "vitest";
import { FakeDocument } from "./dashboard-version-jump.helpers.ts";
import {
  BASE, OLD, CURRENT, SECOND, FILE, accessibleName, deferred, errorText, expectSelection,
  failure, file, fixture, jump, manifest, mount, resolved, rowButtons, settle, submit,
  typeReference, version, waitFor, type Mounted,
} from "./dashboard-version-jump.fixture.ts";

const downloadButton = (m: Mounted) => {
  const buttons = m.doc.querySelectorAll("#files tbody button").filter(b => b.textContent.trim() === "Download");
  expect(buttons).toHaveLength(1);
  return buttons[0]!;
};
const selectedUrl = (m: Mounted) => m.location.searchParams.get("version");
function historyRows(m: Mounted) {
  return m.doc.querySelectorAll("tr").filter(row => row.querySelectorAll("button").some(b => b.textContent.trim() === "Files"));
}
function historySnapshot(m: Mounted) {
  return historyRows(m).map(row => ({ text: row.textContent,
    controls: row.querySelectorAll("button,a").map(el => [el.tag, el.textContent, el.getAttribute("href")]) }));
}
function expectActionableError(m: Mounted) {
  expect(errorText(m), "visible announced error tells the person how to recover").toMatch(/check|try|retry|choose|ready|reference|permission|available|not found/i);
  const regions = m.doc.querySelectorAll('[role="alert"], [aria-live="polite"], [aria-live="assertive"]');
  expect(regions.some(el => el.textContent.trim().length > 0), "failure is exposed through a live/alert region").toBe(true);
}

describe("version-jump fixture controls", () => {
  it("serves the real script with only 100 of 105 ready rows and opens old immutable URL links", async () => {
    const m = await mount(fixture(), { requested: OLD });
    expect(m.f.versions).toHaveLength(105);
    expect(historyRows(m)).toHaveLength(100);
    expect(historyRows(m)[0]!.textContent).toContain("v105");
    expect(historyRows(m)[99]!.textContent).toContain("v6");
    expect(historyRows(m).some(r => /\bv1\b/.test(r.textContent))).toBe(false);
    await expectSelection(m, OLD, 1);
    expect(m.lookups().map(c => c.url)).toEqual([`${BASE}/versions/${OLD}`]);
    expect(m.unexpected).toEqual([]);
  });

  it("retains the current loaded Files/Restore/Delete controls and local manifest filtering", async () => {
    const m = await mount();
    expect(rowButtons(m, "Files")).toHaveLength(100);
    expect(rowButtons(m, "Restore")).toHaveLength(99);
    expect(rowButtons(m, "Delete")).toHaveLength(99);
    const before = m.calls.length;
    const input = m.doc.querySelector('#files input[type="search"], #files input');
    expect(input, "existing manifest path filter").not.toBeNull();
    input!.value = "not-in-manifest"; input!.dispatch("input");
    await settle(); expect(m.paths()).toEqual([]);
    input!.value = ""; input!.dispatch("input"); await settle();
    expect(m.paths()).toEqual(["release-105.txt"]);
    expect(m.calls).toHaveLength(before);
  });

  it("models native Enter and click defaults without calling application submit handlers directly", () => {
    const doc = new FakeDocument();
    const form = doc.createElement("form");
    const input = doc.createElement("input");
    const button = doc.createElement("button");
    form.appendChild(input); form.appendChild(button); doc.body.appendChild(form);
    let submits = 0;
    form.addEventListener("submit", ev => { ev.preventDefault(); submits++; });
    input.dispatch("keydown", { key: "Enter" }); button.click();
    expect(submits).toBe(2);
    button.disabled = true; button.click(); expect(submits).toBe(2);
    input.addEventListener("keydown", ev => ev.preventDefault());
    input.dispatch("keydown", { key: "Enter" }); expect(submits).toBe(2);
  });
});

describe("explicit bounded version lookup", () => {
  it("provides labelled keyboard controls outside narrow-screen-hidden cells; typing never fetches", async () => {
    const m = await mount(); const { input, button } = jump(m);
    expect(accessibleName(m.doc, input)).toMatch(/version/i);
    expect(input.tabIndex).toBeGreaterThanOrEqual(0);
    expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    for (const el of [input, button]) {
      expect(el.closest(".dw-hide-sm"), "jump remains available at narrow widths").toBeNull();
      expect(el.closest("tr"), "jump is separate from per-row controls").toBeNull();
    }
    const before = m.calls.length;
    for (const partial of ["v", "v1", OLD, "", "not-a-version"]) typeReference(m, partial);
    await settle(); expect(m.calls).toHaveLength(before);
    expect(m.paths()).toEqual(["release-105.txt"]);
    expect(m.doc.activeElement).toBe(input);
    expect(m.doc.querySelector("#dw-site")!.textContent).toMatch(/(?:newest|latest|recent|loaded)[\s\S]{0,100}100|100[\s\S]{0,100}(?:newest|latest|recent|loaded)/i);
    expect(m.lists().map(c => new URL(c.url, m.location).search)).toEqual(["?limit=100"]);
  });

  it.each([
    ["live", CURRENT, 105], ["v1", OLD, 1], ["1", OLD, 1], [OLD, OLD, 1],
  ] as const)("opens %s with one direct lookup and an immutable manifest request", async (ref, id, number) => {
    const m = await mount(); const before = m.calls.length; const rows = historySnapshot(m);
    submit(m, ref);
    await expectSelection(m, id, number); await settle();
    expect(m.lookups().map(c => c.url)).toEqual([`${BASE}/versions/${encodeURIComponent(ref)}`]);
    const selectionCalls = m.calls.slice(before).map(c => new URL(c.url, m.location));
    expect(selectionCalls.map(u => u.pathname)).toEqual([`${BASE}/versions/${encodeURIComponent(ref)}`, `${BASE}/files`]);
    expect(selectionCalls[1]!.searchParams.get("version")).toBe(id);
    expect(m.lists()).toHaveLength(1);
    expect(historySnapshot(m)).toEqual(rows);
    expect(selectedUrl(m)).toBe(id);
    expect(m.location.searchParams.get("keep")).toBe("1");
    expect(m.location.pathname).toBe("/dashboard/sites/test-site");
    expect(m.unexpected).toEqual([]);
  });

  it("Enter opens once and leaves a connected keyboard focus target", async () => {
    const m = await mount(); submit(m, "v1", true);
    await expectSelection(m, OLD, 1); await settle();
    expect(m.lookups()).toHaveLength(1);
    expect(m.manifests()).toHaveLength(2);
    expect(m.doc.activeElement?.isConnected, "focus is not left on a removed input").toBe(true);
    expect(m.doc.activeElement!.tabIndex).toBeGreaterThanOrEqual(-1);
  });

  it.each(["", "   ", ".", "..", "...", "a/b", "a\\b", "v1?x=1", "v1#x", "\u0000", "v\n1"])(
    "rejects invalid path-segment reference %j before networking, preserving view/URL/focus", async ref => {
      const m = await mount(); const before = m.calls.length; const url = m.location.href;
      submit(m, ref); await settle();
      expect(m.calls).toHaveLength(before);
      expect(m.paths()).toEqual(["release-105.txt"]);
      expect(m.location.href).toBe(url);
      expectActionableError(m);
      expect(m.doc.activeElement).toBe(jump(m).input);
    });

  it.each(["%2e%2e", "%2F", "opaque%25id"])("does not decode %s into a path escape or second segment", async ref => {
    const m = await mount(); submit(m, ref); await settle();
    // Either reject an encoded-looking reference locally, or submit it literally
    // as ONE encoded segment. Never decode it into dots/slashes/query syntax.
    const calls = m.lookups();
    expect(calls.length).toBeLessThanOrEqual(1);
    if (calls.length) expect(calls[0]!.url).toBe(`${BASE}/versions/${encodeURIComponent(ref)}`);
    expect(m.manifests()).toHaveLength(1);
    expect(m.lists()).toHaveLength(1);
    expect(m.paths()).toEqual(["release-105.txt"]);
    expectActionableError(m);
  });

  it.each([
    ["missing", 404], ["deleted", 404], ["foreign", 404], ["refused", 403], ["service-failure", 503],
  ] as const)("retains valid selection after %s lookup refusal; never falls back to live", async (ref, status) => {
    const m = await mount(fixture(), { requested: OLD }); const rows = historySnapshot(m); const url = m.location.href;
    m.intercept(u => u.pathname === `${BASE}/versions/${ref}` ? failure(status) : undefined);
    submit(m, ref); await settle();
    expect(m.lookups().at(-1)!.url).toBe(`${BASE}/versions/${ref}`);
    expect(m.paths()).toEqual([FILE]);
    expect(m.files().textContent).toContain("Files in v1");
    expect(m.location.href).toBe(url);
    expect(m.manifests()).toHaveLength(1);
    expect(historySnapshot(m)).toEqual(rows);
    expectActionableError(m);
  });

  it("does not open a pending manifest or add mutation controls for a direct-only result", async () => {
    const f = fixture(); f.versions.unshift(version("ver_pending", 106, false, "pending"));
    f.files.set("ver_pending", [file("unfinished.txt")]);
    const m = await mount(f, { requested: OLD }); const rows = historySnapshot(m);
    submit(m, "ver_pending"); await settle();
    expect(m.lookups().at(-1)!.url).toBe(`${BASE}/versions/ver_pending`);
    expect(m.paths()).toEqual([FILE]); expect(selectedUrl(m)).toBe(OLD);
    expect(m.manifests()).toHaveLength(1);
    expect(historySnapshot(m)).toEqual(rows);
    expectActionableError(m);
  });

  it("does not commit selection when the immutable manifest is refused", async () => {
    const m = await mount(fixture(), { requested: OLD });
    m.intercept(u => u.pathname === `${BASE}/files` && u.searchParams.get("version") === CURRENT ? failure(403) : undefined);
    submit(m, "live"); await settle();
    expect(m.manifests()).toHaveLength(2);
    expect(m.paths()).toEqual([FILE]); expect(selectedUrl(m)).toBe(OLD);
    expectActionableError(m);
  });
});

describe("version lookup and manifest response ordering", () => {
  it("announces loading without destroying a valid view, then clears loading after success", async () => {
    const m = await mount(); const gate = deferred<Response>();
    m.intercept(u => u.pathname === `${BASE}/versions/v1` ? gate.promise : undefined);
    submit(m, "v1"); await settle();
    expect(m.paths()).toEqual(["release-105.txt"]);
    expect(m.doc.querySelector('[aria-busy="true"], [role="status"], [aria-live="polite"]'), "loading has accessible state").not.toBeNull();
    expect(m.doc.querySelector("#dw-site")!.textContent).toMatch(/loading|opening|looking|resolving/i);
    gate.resolve(resolved(m.f.versions.find(v => v.id === OLD)!));
    await expectSelection(m, OLD, 1); await settle();
    expect(m.doc.querySelector('[aria-busy="true"]')).toBeNull();
    expect(jump(m).input.disabled).toBe(false); expect(jump(m).button.disabled).toBe(false);
  });

  it.each(["old-success", "old-failure"] as const)("ignores stale direct lookup %s after a newer successful selection", async outcome => {
    const m = await mount(); const gate = deferred<Response>();
    m.intercept(u => u.pathname === `${BASE}/versions/v1` ? gate.promise : undefined);
    submit(m, "v1"); await settle(); submit(m, "v104");
    await expectSelection(m, SECOND, 104);
    gate.resolve(outcome === "old-success" ? resolved(m.f.versions.find(v => v.id === OLD)!) : failure());
    await settle();
    expect(m.paths()).toEqual(["release-104.txt"]); expect(selectedUrl(m)).toBe(SECOND);
    expect(m.manifests().map(c => new URL(c.url, m.location).searchParams.get("version"))).toEqual([CURRENT, SECOND]);
    expect(errorText(m)).not.toMatch(/version not found/i);
  });

  it("a stale successful lookup cannot erase a newer lookup failure", async () => {
    const m = await mount(); const gate = deferred<Response>();
    m.intercept(u => u.pathname === `${BASE}/versions/v1` ? gate.promise : undefined);
    submit(m, "v1"); await settle(); submit(m, "missing"); await settle();
    expectActionableError(m); const error = errorText(m); const url = m.location.href;
    gate.resolve(resolved(m.f.versions.find(v => v.id === OLD)!)); await settle();
    expect(m.paths()).toEqual(["release-105.txt"]); expect(m.location.href).toBe(url);
    expect(errorText(m)).toBe(error); expect(m.manifests()).toHaveLength(1);
  });

  it.each([
    ["new-success", "old-success"], ["new-failure", "old-success"],
    ["new-success", "old-failure"], ["new-failure", "old-failure"],
  ] as const)("a stale manifest %s / %s cannot replace the newer result", async (outcome, oldOutcome) => {
    const m = await mount(); const gate = deferred<Response>();
    m.intercept(u => u.pathname === `${BASE}/files` && u.searchParams.get("version") === OLD ? gate.promise : undefined);
    submit(m, "v1");
    await waitFor(() => m.manifests().length === 2, "old immutable manifest in flight");
    submit(m, outcome === "new-success" ? "v104" : "missing"); await settle();
    if (outcome === "new-success") await expectSelection(m, SECOND, 104); else expectActionableError(m);
    const error = errorText(m); const url = m.location.href;
    gate.resolve(oldOutcome === "old-success" ? manifest(m.f.versions.find(v => v.id === OLD)!, m.f.files.get(OLD)!) : failure(403)); await settle();
    expect(m.paths()).toEqual([outcome === "new-success" ? "release-104.txt" : "release-105.txt"]);
    expect(m.location.href).toBe(url); expect(errorText(m)).toBe(error);
  });

  it("local invalid submission supersedes an outstanding lookup without another request", async () => {
    const m = await mount(); const gate = deferred<Response>();
    m.intercept(u => u.pathname === `${BASE}/versions/v1` ? gate.promise : undefined);
    submit(m, "v1"); await settle(); const count = m.calls.length;
    submit(m, ".."); await settle(); expectActionableError(m); const error = errorText(m);
    expect(m.calls).toHaveLength(count);
    gate.resolve(resolved(m.f.versions.find(v => v.id === OLD)!)); await settle();
    expect(m.paths()).toEqual(["release-105.txt"]); expect(errorText(m)).toBe(error);
    expect(m.manifests()).toHaveLength(1);
  });

  it("a history Files selection supersedes an in-flight direct lookup", async () => {
    const m = await mount(); const gate = deferred<Response>();
    m.intercept(u => u.pathname === `${BASE}/versions/v1` ? gate.promise : undefined);
    submit(m, "v1"); await settle(); rowButtons(m, "Files")[1]!.click();
    await expectSelection(m, SECOND, 104);
    gate.resolve(resolved(m.f.versions.find(v => v.id === OLD)!)); await settle();
    expect(m.paths()).toEqual(["release-104.txt"]); expect(selectedUrl(m)).toBe(SECOND);
  });

  it("guards overlapping file loads from existing history rows, independently of the new control", async () => {
    const m = await mount(); const gate = deferred<Response>();
    m.intercept(u => u.pathname === `${BASE}/files` && u.searchParams.get("version") === SECOND ? gate.promise : undefined);
    rowButtons(m, "Files")[1]!.click(); await settle(); rowButtons(m, "Files")[0]!.click();
    await waitFor(() => m.manifests().length === 3, "newer live manifest request"); await settle();
    gate.resolve(manifest(m.f.versions.find(v => v.id === SECOND)!, m.f.files.get(SECOND)!)); await settle();
    expect(m.paths()).toEqual(["release-105.txt"]);
    expect(m.files().textContent).toContain("Files in v105");
  });
});

describe("management URL and browser navigation coherence", () => {
  it("canonicalizes a successful alias and refreshes the exact immutable selection", async () => {
    const m = await mount(); submit(m, "v1"); await expectSelection(m, OLD, 1); await settle();
    expect(selectedUrl(m)).toBe(OLD);
    const refreshed = await mount(m.f, { requested: selectedUrl(m)! });
    await expectSelection(refreshed, OLD, 1);
    expect(historyRows(refreshed)).toHaveLength(100);
  });

  it("Back/Forward follows existing URL entries without manufacturing extra history entries", async () => {
    const m = await mount(fixture(), { requested: CURRENT, prior: OLD });
    const length = m.history.length;
    m.history.back(); await expectSelection(m, OLD, 1); await settle();
    expect(selectedUrl(m)).toBe(OLD); expect(m.history.length).toBe(length);
    m.history.forward(); await expectSelection(m, CURRENT, 105); await settle();
    expect(selectedUrl(m)).toBe(CURRENT); expect(m.history.length).toBe(length);
  });

  it("existing Files controls also record immutable selection in the URL", async () => {
    const m = await mount(); rowButtons(m, "Files")[1]!.click(); await expectSelection(m, SECOND, 104); await settle();
    expect(selectedUrl(m)).toBe(SECOND);
  });

  it("navigation supersedes an outstanding jump instead of accepting its late result", async () => {
    const m = await mount(fixture(), { requested: CURRENT, prior: SECOND }); const gate = deferred<Response>();
    m.intercept(u => u.pathname === `${BASE}/versions/v1` ? gate.promise : undefined);
    submit(m, "v1"); await settle(); m.history.back(); await expectSelection(m, SECOND, 104);
    gate.resolve(resolved(m.f.versions.find(v => v.id === OLD)!)); await settle();
    expect(m.paths()).toEqual(["release-104.txt"]); expect(selectedUrl(m)).toBe(SECOND);
  });
});

describe("single-file attachment downloads are pinned to inspected immutable bytes", () => {
  it.each([true, false])("pins an initially live=%s manifest even after live advances", async live => {
    const f = fixture(); f.liveId = live ? OLD : CURRENT;
    const m = await mount(f, { requested: OLD }); await expectSelection(m, OLD, 1);
    f.liveId = CURRENT;
    // Same path in both versions makes an unpinned request silently return the
    // wrong bytes instead of a convenient 404; checksum still describes v1.
    f.files.set(CURRENT, [file(FILE, "2".repeat(64))]);
    downloadButton(m).click(); await waitFor(() => m.blobs.length === 1, "forced attachment blob"); await settle();
    const request = m.downloads().at(-1)!; const u = new URL(request.url, m.location);
    expect(u.pathname).toBe(`${BASE}/files/docs/old%20note%2B%CE%B1.txt`);
    expect.soft(u.searchParams.get("version")).toBe(OLD);
    expect.soft(await m.blobs[0]!.blob.text()).toBe("old body");
    expect(m.paths()).toEqual([FILE]);
    expect(m.files().textContent).toContain("1".repeat(64));
    expect(u.searchParams.has("dw_preview")).toBe(false);
    expect(request.url).not.toContain("dw_disposable_fixture");
    expect(new Headers(request.init.headers).get("Authorization")).toBe("Bearer dw_disposable_fixture");
    const anchor = m.doc.clickedAnchors.at(-1)!;
    expect(anchor.href).toBe(m.blobs[0]!.url);
    expect(anchor.download).toBe("old note+α.txt");
    await waitFor(() => m.revoked.length === 1 && anchor.parentNode === null, "deferred object-URL and anchor cleanup");
    expect(m.revoked).toEqual([m.blobs[0]!.url]);
    expect(m.doc.querySelectorAll("a").some(a => a.getAttribute("href")?.startsWith("blob:"))).toBe(false);
  });

  it("pins a listed history-row selection too, not just direct version links", async () => {
    const m = await mount(); rowButtons(m, "Files")[0]!.click(); await settle();
    const path = m.f.files.get(CURRENT)![0]!.path;
    m.f.liveId = SECOND; m.f.files.set(SECOND, [file(path)]); m.f.bytes.set(SECOND, "changed!");
    downloadButton(m).click(); await waitFor(() => m.blobs.length === 1, "row attachment");
    expect(new URL(m.downloads()[0]!.url, m.location).searchParams.get("version")).toBe(CURRENT);
    expect(await m.blobs[0]!.blob.text()).toBe("new body");
  });

  it("preserves attachment errors without creating blobs, falling back, or losing inspected rows", async () => {
    const m = await mount(fixture(), { requested: OLD });
    m.intercept(u => u.pathname.startsWith(`${BASE}/files/`) ? failure(403, "Download refused", "Check your permission and retry.") : undefined);
    downloadButton(m).click(); await waitFor(() => m.downloads().length === 1, "failed download"); await settle();
    expect(m.doc.querySelector("#dw-toasts")!.textContent).toMatch(/download refused|permission/i);
    expect(m.blobs).toEqual([]); expect(m.revoked).toEqual([]);
    expect(m.doc.clickedAnchors).toEqual([]);
    expect(m.paths()).toEqual([FILE]); expect(m.downloads()).toHaveLength(1);
    expect(new URL(m.downloads()[0]!.url, m.location).searchParams.get("version")).toBe(OLD);
    expect(downloadButton(m).disabled).toBe(false);
  });
});

describe("checksum copy-status across version jumps", () => {
  const copyButton = (m: Mounted) => {
    const btn = m.doc.querySelectorAll("#files button").find(b => /copy.*sha/i.test(b.getAttribute("aria-label") ?? b.textContent));
    expect(btn, "Copy SHA-256 button in inspected files").not.toBeUndefined();
    return btn!;
  };
  const copyStatus = (m: Mounted) => m.doc.querySelector('#files [role="status"]')!;
  function controlledClipboard() {
    const pending: Array<{ resolve(): void; reject(reason: Error): void }> = [];
    return {
      pending,
      write: (_text: string) => new Promise<void>((resolve, reject) => { pending.push({ resolve, reject }); }),
      finish(index: number, success: boolean) {
        const attempt = pending[index]!;
        expect(attempt, `clipboard attempt ${index}`).not.toBeUndefined();
        if (success) attempt.resolve(); else attempt.reject(new Error("Clipboard denied"));
      },
    };
  }

  it.each([
    ["invalid reference", "..", null],
    ["missing lookup", "missing", null],
    ["pending version", "ver_pending", "pending"],
    ["refused manifest", "live", "manifest-fail"],
  ] as const)("retains copy announcements after %s that preserves the view", async (_label, ref, setup) => {
    const f = fixture();
    if (setup === "pending") {
      f.versions.unshift(version("ver_pending", 106, false, "pending"));
      f.files.set("ver_pending", [file("unfinished.txt")]);
    }
    const m = await mount(f, { requested: OLD });
    copyButton(m).click();
    await waitFor(() => /copied/i.test(copyStatus(m).textContent), "baseline copy announcement");
    expect(m.clipboardWrites).toEqual(["1".repeat(64)]);
    if (setup === "manifest-fail") {
      m.intercept(u => u.pathname === `${BASE}/files` && u.searchParams.get("version") === CURRENT ? failure(403) : undefined);
    }
    submit(m, ref);
    await settle(); await settle();
    expect(m.paths()).toEqual([FILE]);
    expect(selectedUrl(m)).toBe(OLD);
    const writesBefore = m.clipboardWrites.length;
    copyButton(m).click();
    await waitFor(() => /copied/i.test(copyStatus(m).textContent), "copy announcement after retained failure");
    expect(m.clipboardWrites).toHaveLength(writesBefore + 1);
    expect(m.clipboardWrites.at(-1)).toBe("1".repeat(64));
    expect(m.paths()).toEqual([FILE]);
    expect(m.deletes()).toEqual([]);
  });

  it("fences late copy callbacks from a replaced view", async () => {
    const clipboard = controlledClipboard();
    const m = await mount(fixture(), { requested: OLD, writeClipboard: clipboard.write });
    const oldStatus = copyStatus(m);
    copyButton(m).click();
    await settle();
    expect(oldStatus.textContent, "pending copy clears status").toBe("");
    expect(clipboard.pending).toHaveLength(1);
    submit(m, "live");
    await expectSelection(m, CURRENT, 105);
    await settle();
    const newStatus = copyStatus(m);
    expect(newStatus, "replaced view mounts its own status").not.toBe(oldStatus);
    expect(newStatus.textContent).toBe("");
    clipboard.finish(0, true);
    await settle(); await settle(); await settle();
    expect(newStatus.textContent, "late old-view success stays fenced").toBe("");
    expect(oldStatus.textContent, "detached old status stays silent").toBe("");
    expect(m.clipboardWrites).toEqual(["1".repeat(64)]);
    copyButton(m).click();
    await settle();
    expect(clipboard.pending).toHaveLength(2);
    clipboard.finish(1, true);
    await waitFor(() => /copied/i.test(newStatus.textContent), "new view copy announcement");
  });
});

describe("history traversal cancellation and failure", () => {
  it("Forward to already-displayed B cancels in-flight Back lookup to A", async () => {
    const m = await mount(fixture(), { requested: CURRENT, prior: OLD });
    await expectSelection(m, CURRENT, 105);
    const length = m.history.length;
    const gate = deferred<Response>();
    m.intercept(u => u.pathname === `${BASE}/versions/${OLD}` ? gate.promise : undefined);
    m.history.back();
    await settle();
    expect(m.paths()).toEqual(["release-105.txt"]);
    expect(m.location.searchParams.get("version")).toBe(OLD);
    m.history.forward();
    await settle(); await settle();
    expect(m.paths()).toEqual(["release-105.txt"]);
    expect(selectedUrl(m)).toBe(CURRENT);
    expect(m.history.length).toBe(length);
    gate.resolve(resolved(m.f.versions.find(v => v.id === OLD)!));
    await settle(); await settle();
    expect(m.paths()).toEqual(["release-105.txt"]);
    expect(selectedUrl(m)).toBe(CURRENT);
    expect(m.history.length).toBe(length);
    expect(m.manifests().map(c => new URL(c.url, m.location).searchParams.get("version"))).not.toContain(OLD);
  });

  it("failed Back traversal retains B and reconciles URL without new entry", async () => {
    const m = await mount(fixture(), { requested: CURRENT, prior: OLD });
    await expectSelection(m, CURRENT, 105);
    const length = m.history.length;
    m.intercept(u => u.pathname === `${BASE}/versions/${OLD}` ? failure(404) : undefined);
    m.history.back();
    await settle(); await settle(); await settle();
    expect(m.paths()).toEqual(["release-105.txt"]);
    expect(selectedUrl(m)).toBe(CURRENT);
    expect(m.history.length).toBe(length);
    expect(m.location.href).toContain(`version=${CURRENT}`);
  });
});

describe("deletion of inspected versions", () => {
  async function confirmDelete(m: Mounted, index: number) {
    const del = rowButtons(m, "Delete")[index]!;
    del.click();
    await settle();
    const dialog = m.doc.querySelector("dialog")!;
    expect((dialog as unknown as { open: boolean }).open, "Delete confirm dialog opens").toBe(true);
    const confirm = dialog.querySelectorAll("button").find(b => /delete version/i.test(b.textContent))!;
    confirm.click();
    await settle(); await settle(); await settle(); await settle();
    expect((dialog as unknown as { open: boolean }).open, "Delete confirm closes").toBe(false);
  }

  it("deleting inspected non-live version clears its ?version and renders live", async () => {
    const m = await mount(fixture(), { requested: SECOND });
    await expectSelection(m, SECOND, 104);
    expect(rowButtons(m, "Delete")).toHaveLength(99);
    await confirmDelete(m, 0);
    expect(m.deletes().map(c => new URL(c.url, m.location).pathname)).toEqual([`${BASE}/versions/${SECOND}`]);
    expect(m.location.searchParams.get("version")).toBeNull();
    await expectSelection(m, CURRENT, 105);
    expect(m.paths()).toEqual(["release-105.txt"]);
    expect(rowButtons(m, "Files")).toHaveLength(100);
    expect(rowButtons(m, "Delete")).toHaveLength(99);
  });

  it("deleting another version retains current selection", async () => {
    const m = await mount(fixture(), { requested: SECOND });
    await expectSelection(m, SECOND, 104);
    await confirmDelete(m, 1);
    expect(m.deletes()).toHaveLength(1);
    expect(m.location.searchParams.get("version")).toBe(SECOND);
    await expectSelection(m, SECOND, 104);
    expect(m.paths()).toEqual(["release-104.txt"]);
  });
});

describe("selection and popstate pinning across site page re-runs", () => {
  async function confirmDelete(m: Mounted, index: number) {
    const del = rowButtons(m, "Delete")[index]!;
    del.click();
    await settle();
    const dialog = m.doc.querySelector("dialog")!;
    expect((dialog as unknown as { open: boolean }).open, "Delete confirm dialog opens").toBe(true);
    const confirm = dialog.querySelectorAll("button").find(b => /delete version/i.test(b.textContent))!;
    confirm.click();
    await settle(); await settle(); await settle(); await settle();
    expect((dialog as unknown as { open: boolean }).open, "Delete confirm closes").toBe(false);
  }

  it("a selection started before a site page re-run cannot commit after the re-run", async () => {
    const m = await mount(fixture(), { requested: SECOND });
    await expectSelection(m, SECOND, 104);
    const gate = deferred<Response>();
    m.intercept(u => u.pathname === `${BASE}/files` && u.searchParams.get("version") === OLD ? gate.promise : undefined);
    submit(m, "v1");
    await waitFor(() => m.manifests().length === 2, "old immutable manifest in flight");
    // Deleting another version re-runs the site page, which re-displays the
    // URL's v104 selection. The gated v1 manifest belongs to the previous
    // page instance and must never commit once it finally resolves.
    await confirmDelete(m, 1);
    await expectSelection(m, SECOND, 104);
    const href = m.location.href; const length = m.history.length;
    gate.resolve(manifest(m.f.versions.find(v => v.id === OLD)!, m.f.files.get(OLD)!));
    await settle(); await settle();
    expect(m.paths()).toEqual(["release-104.txt"]);
    expect(selectedUrl(m)).toBe(SECOND);
    expect(m.location.href).toBe(href);
    expect(m.history.length).toBe(length);
  });

  it("an explicit version selection pushes one history entry that Back and Forward traverse", async () => {
    const m = await mount();
    const before = m.history.length;
    submit(m, "v1");
    await expectSelection(m, OLD, 1); await settle();
    expect(selectedUrl(m)).toBe(OLD);
    expect(m.history.length).toBe(before + 1);
    m.history.back();
    await expectSelection(m, CURRENT, 105); await settle();
    expect(m.paths()).toEqual(["release-105.txt"]);
    expect(selectedUrl(m)).toBe(CURRENT);
    expect(m.history.length).toBe(before + 1);
    m.history.forward();
    await expectSelection(m, OLD, 1); await settle();
    expect(selectedUrl(m)).toBe(OLD);
    expect(m.history.length).toBe(before + 1);
  });

  it("a site page re-run replaces the popstate listener instead of stacking lookups", async () => {
    const m = await mount(fixture(), { requested: CURRENT, prior: OLD });
    await expectSelection(m, CURRENT, 105);
    // Re-run the site page while keeping the CURRENT selection; the fresh
    // page must replace (not stack on) the previous popstate handler.
    await confirmDelete(m, 1);
    await expectSelection(m, CURRENT, 105);
    m.calls.length = 0;
    m.history.back();
    await expectSelection(m, OLD, 1); await settle();
    expect(m.lookups().map(c => c.url)).toEqual([`${BASE}/versions/${OLD}`]);
    expect(m.manifests().map(c => new URL(c.url, m.location).searchParams.get("version"))).toEqual([OLD]);
  });
});
