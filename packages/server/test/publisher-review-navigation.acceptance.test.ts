import { describe, expect, it } from "vitest";
import {
  TEl, TText, allElements, fire, activate, dirFile, fakeFile, fileEntry, dirEntry,
  dropFiles, pickFolder, pickFiles, clickPublish, bootPublisher, flush,
  findReviewToggle, reviewBody, isExpanded, alerts, beginGatedDrop,
} from "./publisher-review-navigation.helpers.ts";
import type { Harness } from "./publisher-review-navigation.helpers.ts";

/**
 * PROTECTED paired acceptance tests. Builder consumes these files unchanged.
 * Exercise CLIENT_SCRIPT (the exact first-party browser artifact), not private
 * implementation helpers. New controls may use any IDs/classes; locate by
 * accessible label and native element semantics. No dependency or production I/O.
 *
 * Deterministic ordering contract chosen for this slice:
 * - Path: ascending, case-sensitive UTF-16/code-unit path order, within groups.
 * - Size: included bytes descending, equal sizes use that same path order.
 * - Included group precedes excluded group. Exclusions always use path order;
 *   unreadable sizes stay unknown (never treated as zero or guessed).
 * - Clear resets query, category=All, order=Path, never the selected inventory.
 * The canonical publisher note must explain these choices and that all included
 * files, not just matching rows, are uploaded. Human prose is not source-grep tested.
 *
 * Bugs caught: regex/locale search, category OR instead of AND, unstable ties,
 * in-place inventory sorting/filtering, visible-count upload claims, DOM injection,
 * control-triggered I/O, missing busy locks, stale traversal and stale navigation.
 * Real keyboard tab sequence, focus rings, CSS tokens and 320px layout require
 * Builder browser evidence on Home and Dashboard; VM has no layout engine.
 */

const INCLUDED_PATHS = [
  "assets/equal-a.txt", "assets/equal-b.txt", "docs/café ✓.md", "empty.bin",
  "index.html", "notes/[x]+?.txt", "tags/<img onerror=boom>.txt", "z-last.bin",
];
const EXCLUDED_PATHS = [".env.local", ".git/config", "node_modules/dep.js"];
const PATH_ORDER = [...INCLUDED_PATHS, ...EXCLUDED_PATHS];
const SIZE_ORDER = [
  "z-last.bin", "index.html", "assets/equal-a.txt", "assets/equal-b.txt",
  "docs/café ✓.md", "notes/[x]+?.txt", "tags/<img onerror=boom>.txt", "empty.bin",
  ...EXCLUDED_PATHS,
];

function fixture() {
  // Deliberately neither Path nor Size order. All bytes are synthetic and local.
  return [
    dirFile("dist/z-last.bin", 9), dirFile("dist/docs/café ✓.md", 3),
    dirFile("dist/assets/equal-b.txt", 4), dirFile("dist/empty.bin", 0),
    dirFile("dist/.git/config", 5), dirFile("dist/assets/equal-a.txt", 4),
    dirFile("dist/node_modules/dep.js", 7), dirFile("dist/notes/[x]+?.txt", 2),
    dirFile("dist/tags/<img onerror=boom>.txt", 1), dirFile("dist/.env.local", 9),
    dirFile("dist/index.html", 8),
  ];
}

function visible(el: TEl): boolean {
  let child = el;
  for (let p: TEl | null = el; p; p = p.parentNode) {
    if (p.hidden || p.getAttribute("aria-hidden") === "true" || p.style["display"] === "none") return false;
    if (p.tagName === "details" && !p.open && child !== p && child.tagName !== "summary") return false;
    child = p;
  }
  return true;
}

function visibleText(root: TEl): string {
  return allElements(root).filter(visible).flatMap((e) => e.children.filter((c) => c instanceof TText).map((c) => c.textContent)).join(" ");
}

function accessibleName(h: Harness, el: TEl): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const ids = el.getAttribute("aria-labelledby");
  if (ids) return ids.split(/\s+/).map((id) => h.doc.getElementById(id)?.textContent ?? "").join(" ");
  const id = el.getAttribute("id");
  const label = allElements(h.root).find((e) => e.tagName === "label" && id && e.getAttribute("for") === id);
  if (label) return label.textContent;
  for (let p = el.parentNode; p; p = p.parentNode) if (p.tagName === "label") return p.textContent;
  return el.tagName === "button" ? el.textContent : "";
}

function panel(h: Harness): TEl {
  const toggle = findReviewToggle(h.root);
  expect(toggle, "existing expandable review mounts before navigation assertions").not.toBeNull();
  if (!isExpanded(toggle!)) activate(toggle!, "Enter");
  expect(isExpanded(toggle!)).toBe(true);
  const body = reviewBody(h.root, toggle!);
  expect(body).not.toBeNull();
  return body!;
}

function navigation(h: Harness) {
  const body = panel(h);
  const els = allElements(body);
  const search = els.find((e) => e.tagName === "input" && ["search", "text"].includes(e.getAttribute("type") ?? "text") && /search|filter/i.test(accessibleName(h, e)));
  expect(search, "labelled review path search is missing").toBeDefined();
  const selects = els.filter((e) => e.tagName === "select");
  const category = selects.find((e) => ["All", "Included", "Excluded"].every((v) => allElements(e).some((o) => o.tagName === "option" && new RegExp(`\\b${v}\\b`, "i").test(o.textContent))));
  expect(category, "review visibility control needs All / Included / Excluded").toBeDefined();
  const order = selects.find((e) => ["Path", "Size"].every((v) => allElements(e).some((o) => o.tagName === "option" && new RegExp(`\\b${v}\\b`, "i").test(o.textContent))));
  expect(order, "review ordering control needs Path / Size").toBeDefined();
  const clear = els.find((e) => e.tagName === "button" && /clear|reset/i.test(accessibleName(h, e)));
  expect(clear, "review Clear must not be the publisher's selection Clear").toBeDefined();
  for (const e of [search!, category!, order!, clear!]) {
    expect(accessibleName(h, e).trim(), "each navigation control has an accessible name").not.toBe("");
    expect(e.tabIndex).toBeGreaterThanOrEqual(0);
  }
  expect(clear).not.toBe(h.clearBtn);
  return { body, search: search!, category: category!, order: order!, clear: clear! };
}

type Nav = ReturnType<typeof navigation>;

async function query(nav: Nav, value: string) {
  nav.search.value = value;
  fire(nav.search, "input", {});
  await flush(3);
}

async function choose(el: TEl, label: "All" | "Included" | "Excluded" | "Path" | "Size") {
  const option = allElements(el).find((o) => o.tagName === "option" && new RegExp(`\\b${label}\\b`, "i").test(o.textContent));
  expect(option, `option ${label}`).toBeDefined();
  el.value = option!.getAttribute("value") ?? option!.value;
  fire(el, "change", {});
  await flush(3);
}

function rows(body: TEl): TEl[] {
  // <li> / <tr> are the existing accessible row convention. Only visible rows
  // count; a hidden full list must not accidentally satisfy a filtered assertion.
  return allElements(body).filter((e) => (e.tagName === "li" || e.tagName === "tr") && visible(e) && !allElements(e).some((c) => c !== e && (c.tagName === "li" || c.tagName === "tr")));
}

function paths(body: TEl, candidates = PATH_ORDER): string[] {
  return rows(body).flatMap((r) => {
    const path = candidates.find((p) => r.textContent.includes(p));
    return path ? [path] : [];
  });
}

function expectCounts(body: TEl, included: number, totalIncluded: number, excluded: number, totalExcluded: number) {
  const live = allElements(body).filter((e) => visible(e) && (e.getAttribute("role") === "status" || e.getAttribute("aria-live") === "polite"));
  expect(live.length, "matching/total review counts are accessible live status").toBeGreaterThan(0);
  const text = live.map((e) => e.textContent).join(" ");
  // Flexible wording, but each fraction must be explicitly bound to its category.
  const fraction = (n: number, total: number, noun: string) => new RegExp(`(?:${n}\\s*(?:/|of)\\s*${total}\\s*${noun}|${noun}[^\\d]*${n}\\s*(?:/|of)\\s*${total})`, "i");
  expect(text, "included matching / full included count").toMatch(fraction(included, totalIncluded, "included(?: files)?"));
  expect(text, "excluded matching / full excluded count").toMatch(fraction(excluded, totalExcluded, "excluded(?: paths)?"));
}

function effects(h: Harness, files: ReturnType<typeof fixture>) {
  return {
    calls: h.spy.calls.length, reads: files.map((f) => f.arrayBufferCalls), hashes: h.io.hashes,
    local: [...h.local.writes], session: [...h.session.writes],
  };
}

function publishBodies(h: Harness) {
  return h.spy.calls.filter((c) => c.method === "POST" && (/\/sites$/.test(c.url) || /\/deploys$/.test(c.url))).map((c) => ({ url: c.url, body: c.body }));
}

// Both entry points share behavior, not only a source-text marker.
describe.each(["publish", "home"] as const)("%s publisher review navigation", (page) => {
  it("defaults to complete grouped deterministic Path order with full selected totals", async () => {
    const h = await bootPublisher(page);
    await pickFolder(h, fixture());
    const body = panel(h);
    expect(paths(body)).toEqual(PATH_ORDER);
    expectCounts(body, 8, 8, 3, 3);
    expect(h.summary.textContent).toContain("8 files");
    expect(h.summary.textContent).toContain("31 B");
    expect(h.publishBtn.disabled).toBe(false);
  });

  it("announces complete included and excluded matching/total counts before any query", async () => {
    const h = await bootPublisher(page);
    await pickFolder(h, fixture());
    expectCounts(panel(h), 8, 8, 3, 3);
  });

  it("matches literal case-insensitive nested Unicode and punctuation paths, not regexes or reasons", async () => {
    const h = await bootPublisher(page);
    await pickFolder(h, fixture());
    const nav = navigation(h);
    for (const [term, want] of [
      ["DOCS/CAFÉ ✓", ["docs/café ✓.md"]],
      ["[x]+?", ["notes/[x]+?.txt"]],
      ["EQUAL-", ["assets/equal-a.txt", "assets/equal-b.txt"]],
      ["may contain secrets", []],
      [".*", []],
    ] as const) {
      await query(nav, term);
      expect(paths(nav.body), `literal query ${term}`).toEqual(want);
    }
  });

  it("ANDs path search with All/Included/Excluded and preserves every exclusion reason", async () => {
    const h = await bootPublisher(page);
    await pickFolder(h, fixture());
    const nav = navigation(h);
    await choose(nav.category, "Excluded");
    expect(paths(nav.body)).toEqual(EXCLUDED_PATHS);
    for (const [path, reason] of [[".env.local", "may contain secrets"], [".git/config", ".git folder"], ["node_modules/dep.js", "node_modules folder"]]) {
      expect(rows(nav.body).find((r) => r.textContent.includes(path!))?.textContent).toContain(reason);
    }
    await query(nav, "CONFIG");
    expect(paths(nav.body)).toEqual([".git/config"]);
    expectCounts(nav.body, 0, 8, 1, 3);
    await choose(nav.category, "Included");
    expect(paths(nav.body)).toEqual([]);
    expectCounts(nav.body, 0, 8, 0, 3);
    await query(nav, "");
    expect(paths(nav.body)).toEqual(INCLUDED_PATHS);
    await choose(nav.category, "All");
    expect(paths(nav.body)).toEqual(PATH_ORDER);
  });

  it("orders included Size descending with path ties and keeps exclusions path-ordered last", async () => {
    const h = await bootPublisher(page);
    await pickFolder(h, fixture());
    const nav = navigation(h);
    await choose(nav.order, "Size");
    expect(paths(nav.body)).toEqual(SIZE_ORDER);
    await query(nav, "EQUAL");
    expect(paths(nav.body)).toEqual(["assets/equal-a.txt", "assets/equal-b.txt"]);
    await choose(nav.order, "Path");
    await query(nav, "");
    expect(paths(nav.body)).toEqual(PATH_ORDER);
  });

  it("keeps Path order and equal-size ties independent of locale for case and Unicode", async () => {
    const h = await bootPublisher(page);
    await pickFiles(h, ["é.txt", "a.txt", "Ω.txt", "z.txt", "A.txt"].map((name) => fakeFile(name, 2)));
    const expected = ["A.txt", "a.txt", "z.txt", "é.txt", "Ω.txt"];
    expect(paths(panel(h), expected)).toEqual(expected);
    const nav = navigation(h);
    await choose(nav.order, "Size");
    expect(paths(nav.body, expected)).toEqual(expected);
    await query(nav, "A.TXT");
    expect(paths(nav.body, expected)).toEqual(["A.txt", "a.txt"]);
  });

  it("distinguishes no matches from empty selection without shrinking selected totals or upload eligibility", async () => {
    const h = await bootPublisher(page);
    await pickFolder(h, fixture());
    const nav = navigation(h);
    const fullTotals = h.summary.textContent;
    await query(nav, "not-in-this-fixture");
    expect(paths(nav.body)).toEqual([]);
    expectCounts(nav.body, 0, 8, 0, 3);
    expect(visibleText(nav.body)).toMatch(/no (?:matching|matches|(?:files|paths|results) (?:match|found))|0 matching/i);
    expect(visible(h.summary), "full selected totals stay visible outside filtering").toBe(true);
    expect(h.summary.textContent).toBe(fullTotals);
    expect(h.publishBtn.disabled, "zero visible rows is not zero selected files").toBe(false);
    expect(nav.body.textContent, "review explains visibility is not upload scope").toMatch(/all included|(?:filter|search|show|review)[^.]*\b(?:not|only)\b[^.]*(?:upload|publish|display|review)|(?:upload|publish)[^.]*\b(?:all|not affected)\b/i);
    fire(h.clearBtn, "click", {});
    await flush(3);
    expect(h.summary.textContent).toBe("");
    expect(h.publishBtn.disabled).toBe(true);
    expect(visibleText(h.root)).not.toMatch(/no (?:matching|matches|(?:files|paths|results) (?:match|found))|0 matching/i);
  });

  it("keeps an all-ignored selection inspectable and distinct from a no-match included selection", async () => {
    const h = await bootPublisher(page);
    await pickFolder(h, [dirFile("dist/.env.local", 4), dirFile("dist/.git/config", 5)]);
    const nav = navigation(h);
    expectCounts(nav.body, 0, 0, 2, 2);
    expect(paths(nav.body)).toEqual([".env.local", ".git/config"]);
    expect(h.publishBtn.disabled).toBe(true);
    await choose(nav.category, "Included");
    expectCounts(nav.body, 0, 0, 0, 2);
    expect(paths(nav.body)).toEqual([]);
    const before = h.spy.calls.length;
    await clickPublish(h);
    expect(h.spy.calls).toHaveLength(before);
    await choose(nav.category, "Excluded");
    expect(paths(nav.body)).toEqual([".env.local", ".git/config"]);
  });

  it("Clear restores All/Path/full review, keeps files, and returns keyboard focus to search", async () => {
    const h = await bootPublisher(page);
    await pickFolder(h, fixture());
    let nav = navigation(h);
    const total = h.summary.textContent;
    await query(nav, "env");
    await choose(nav.category, "Excluded");
    await choose(nav.order, "Size");
    nav.clear.focus();
    activate(nav.clear, "Enter");
    await flush(3);
    nav = navigation(h);
    expect(nav.search.value).toBe("");
    expect(paths(nav.body)).toEqual(PATH_ORDER);
    expectCounts(nav.body, 8, 8, 3, 3);
    expect(h.doc.activeElement, "Clear returns focus to the labelled search input").toBe(nav.search);
    expect(h.summary.textContent).toBe(total);
    expect(h.publishBtn.disabled).toBe(false);
    // A category/order reset must be real state, not just a one-time full render.
    await query(nav, "EQUAL");
    expect(paths(nav.body)).toEqual(["assets/equal-a.txt", "assets/equal-b.txt"]);
  });

  it("retains navigation across collapse/reopen and keeps typing focus attached", async () => {
    const h = await bootPublisher(page);
    await pickFolder(h, fixture());
    let nav = navigation(h);
    nav.search.focus();
    for (const value of ["d", "do", "docs"]) {
      await query(nav, value);
      expect(h.doc.activeElement).toBe(nav.search);
      expect(allElements(h.root)).toContain(nav.search);
    }
    const toggle = findReviewToggle(h.root)!;
    activate(toggle, " ");
    expect(isExpanded(toggle)).toBe(false);
    expect(h.publishBtn.disabled).toBe(false);
    activate(toggle, "Enter");
    expect(isExpanded(toggle)).toBe(true);
    nav = navigation(h);
    expect(nav.search.value).toBe("docs");
    expect(paths(nav.body)).toEqual(["docs/café ✓.md"]);
  });

  it("renders literal hostile-looking paths and zero bytes safely without losing their text", async () => {
    const h = await bootPublisher(page);
    await pickFolder(h, fixture());
    const nav = navigation(h);
    await query(nav, "<IMG ONERROR=BOOM>");
    expect(paths(nav.body)).toEqual(["tags/<img onerror=boom>.txt"]);
    expect(allElements(nav.body).some((e) => ["img", "script", "iframe"].includes(e.tagName))).toBe(false);
    expect(allElements(nav.body).some((e) => Object.keys(e.attributes).some((a) => /^on/i.test(a)))).toBe(false);
    expect(allElements(nav.body).some((e) => e.children.some((c) => c instanceof TText && c.textContent.includes("<img onerror=boom>")))).toBe(true);
    await query(nav, "empty.bin");
    expect(paths(nav.body)).toEqual(["empty.bin"]);
    expect(rows(nav.body).find((r) => r.textContent.includes("empty.bin"))?.textContent).toContain("0 B");
    await pickFolder(h, [dirFile("dist/index.html", 1), dirFile("dist/.env.<img onerror=boom>", 2)]);
    const excludedNav = navigation(h);
    await choose(excludedNav.category, "Excluded");
    await query(excludedNav, "<IMG ONERROR=BOOM>");
    expect(paths(excludedNav.body, [".env.<img onerror=boom>"])).toEqual([".env.<img onerror=boom>"]);
    expect(rows(excludedNav.body)[0]!.textContent).toContain("may contain secrets");
    expect(allElements(excludedNav.body).some((e) => ["img", "script", "iframe"].includes(e.tagName))).toBe(false);
    expect(allElements(excludedNav.body).some((e) => Object.keys(e.attributes).some((a) => /^on/i.test(a)))).toBe(false);
  });

  it("does no requests, file-content reads, hashing or preference writes for navigation", async () => {
    const h = await bootPublisher(page);
    const files = fixture();
    await pickFolder(h, files);
    const before = effects(h, files);
    const nav = navigation(h);
    await query(nav, "CAFÉ");
    await choose(nav.category, "Excluded");
    await choose(nav.order, "Size");
    activate(nav.clear, "Enter");
    activate(findReviewToggle(h.root)!, "Enter");
    activate(findReviewToggle(h.root)!, "Enter");
    await flush();
    expect(effects(h, files)).toEqual(before);
    expect(before.reads).toEqual(Array(11).fill(0));
    expect(before.hashes).toBe(0);
  });

  it.each(["new", "update"] as const)("publishes byte-for-byte the same complete ordered manifest and %s destination after filtering/sorting", async (mode) => {
    const destination = (h: Harness) => {
      h.slugInput.value = "review-fixture";
      if (mode === "update") {
        h.modeNew.checked = false;
        h.modeUpd.checked = true;
        fire(h.modeUpd, "change", {});
        h.siteSelect.value = "existing-fixture";
        fire(h.siteSelect, "change", {});
      }
    };
    const baseline = await bootPublisher(page);
    await pickFolder(baseline, fixture());
    destination(baseline);
    await clickPublish(baseline);
    expect(baseline.spy.manifests).toHaveLength(1);
    expect(baseline.spy.manifests[0]!.map((f) => f.path).sort()).toEqual(INCLUDED_PATHS);
    expect(baseline.spy.manifests[0]!.reduce((n, f) => n + f.size, 0)).toBe(31);
    const h = await bootPublisher(page);
    const files = fixture();
    await pickFolder(h, files);
    destination(h);
    const nav = navigation(h);
    await choose(nav.order, "Size");
    await choose(nav.category, "Excluded");
    await query(nav, "CONFIG");
    expect(paths(nav.body)).toEqual([".git/config"]);
    await clickPublish(h);
    expect(h.spy.manifests).toHaveLength(1);
    expect(publishBodies(h), "all manifest fields, ordering and destination options are unchanged").toEqual(publishBodies(baseline));
    expect(h.spy.manifests[0]).toEqual(baseline.spy.manifests[0]);
    expect(files.map((f) => f.arrayBufferCalls)).toEqual([1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1]);
    expect(h.spy.calls.filter((c) => c.method === "PUT")).toHaveLength(8);
    expect(h.result.textContent).toContain("picked-site");
  });

  it("keeps unknown exclusion sizes honest under Size order without blocking included upload", async () => {
    const h = await bootPublisher(page);
    await dropFiles(h, [dirEntry("project", [[
      fileEntry("index.html", 8), fileEntry("empty.bin", 0),
      fileEntry(".env.local", 99, { fail: true }), dirEntry("node_modules", [], { fail: true }),
    ]])]);
    const nav = navigation(h);
    await choose(nav.order, "Size");
    expect(paths(nav.body, ["index.html", "empty.bin", ".env.local", "node_modules/"])).toEqual(["index.html", "empty.bin", ".env.local", "node_modules/"]);
    await choose(nav.category, "Excluded");
    for (const path of [".env.local", "node_modules/"]) {
      const row = rows(nav.body).find((r) => r.textContent.includes(path));
      expect(row?.textContent).toMatch(/unknown|unreadable|could not|not (?:read|listed)|unavailable/i);
      expect(row?.textContent).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:B|KB|MB)\b/);
    }
    expect(rows(nav.body).find((r) => r.textContent.includes(".env.local"))?.textContent).toContain("may contain secrets");
    expect(rows(nav.body).find((r) => r.textContent.includes("node_modules/"))?.textContent).toContain("node_modules folder");
    expectCounts(nav.body, 0, 2, 2, 2);
    expect(h.publishBtn.disabled).toBe(false);
    await clickPublish(h);
    expect(h.spy.manifests[0]!.map((f) => ({ path: f.path, size: f.size }))).toEqual([{ path: "index.html", size: 8 }, { path: "empty.bin", size: 0 }]);
  });

  it("never filters away incomplete-read refusal or enables a partial upload", async () => {
    const h = await bootPublisher(page);
    const before = h.spy.calls.length;
    await dropFiles(h, [dirEntry("project", [[fileEntry("index.html", 8), fileEntry("broken.txt", 5, { fail: true }), fileEntry(".env", 3)]])]);
    const nav = navigation(h);
    await query(nav, "no-match");
    await choose(nav.category, "Excluded");
    await choose(nav.order, "Size");
    const refusal = alerts(h.root).filter(visible).map((e) => e.textContent).join(" ");
    expect(refusal).toContain("broken.txt");
    expect(refusal).toMatch(/reselect|retry|choose/i);
    expect(h.publishBtn.disabled).toBe(true);
    activate(findReviewToggle(h.root)!, "Enter");
    expect(alerts(h.root).filter(visible).map((e) => e.textContent).join(" ")).toContain("broken.txt");
    await clickPublish(h);
    expect(h.spy.calls).toHaveLength(before);
    expect(h.spy.manifests).toHaveLength(0);
  });

  it("keeps pending enumeration separate from presentation and resets when its completed selection arrives", async () => {
    const h = await bootPublisher(page);
    const files = fixture();
    await pickFolder(h, files);
    let nav = navigation(h);
    const totals = h.summary.textContent;
    const releaseDrop = await beginGatedDrop(h);
    try {
      const before = effects(h, files);
      // Implementations may lock navigation during enumeration or leave the old
      // completed review usable. Neither may read bytes or show partial files.
      if (!nav.search.disabled) await query(nav, "equal");
      if (!nav.order.disabled) await choose(nav.order, "Size");
      expect(effects(h, files)).toEqual(before);
      expect(h.summary.textContent).toBe(totals);
      expect(h.root.textContent).not.toContain("late.html");
      releaseDrop();
      await flush();
      nav = navigation(h);
      expect(nav.search.value).toBe("");
      expect(paths(nav.body, ["late.html"])).toEqual(["late.html"]);
      expectCounts(nav.body, 1, 1, 0, 0);
      expect(h.summary.textContent).toContain("1 file");
      expect(h.summary.textContent).toContain("9 B");
    } finally {
      releaseDrop(); await flush();
    }
  });

  it("resets navigation for a replacement selection instead of hiding its new inventory", async () => {
    const h = await bootPublisher(page);
    await pickFolder(h, fixture());
    let nav = navigation(h);
    await query(nav, "config");
    await choose(nav.category, "Excluded");
    await choose(nav.order, "Size");
    await pickFolder(h, [dirFile("next/z.txt", 9), dirFile("next/a.txt", 0), dirFile("next/.env", 2)]);
    nav = navigation(h);
    expect(nav.search.value).toBe("");
    expect(paths(nav.body, ["a.txt", "z.txt", ".env"])).toEqual(["a.txt", "z.txt", ".env"]);
    expectCounts(nav.body, 2, 2, 1, 1);
    expect(h.summary.textContent).toContain("2 files");
    expect(h.summary.textContent).toContain("9 B");
  });

  it("locks review controls throughout hashing, upload and finalize without replacing the active selection", async () => {
    const h = await bootPublisher(page);
    const files = fixture();
    let releaseHash!: () => void;
    const hashGate = new Promise<void>((r) => { releaseHash = r; });
    const read = files[0]!.arrayBuffer;
    files[0]!.arrayBuffer = async () => { await hashGate; return read(); };
    await pickFolder(h, files);
    const nav = navigation(h);
    await query(nav, "equal");
    await choose(nav.order, "Size");
    const uploadDone = h.spy.pause("upload");
    const finalizeDone = h.spy.pause("finalize");
    const totals = h.summary.textContent;
    fire(h.publishBtn, "click", {});
    try {
      await flush();
      const hashingNav = navigation(h);
      for (const e of [hashingNav.search, hashingNav.category, hashingNav.order, hashingNav.clear]) expect(e.disabled, "controls lock during hashing").toBe(true);
      // Even synthetic activation cannot clear the inventory during an upload.
      activate(hashingNav.clear, "Enter");
      fire(h.clearBtn, "click", {});
      await pickFiles(h, [fakeFile("replacement.txt", 20)]);
      expect(h.summary.textContent).toBe(totals);
      releaseHash();
      await flush(40);
      expect(h.spy.calls.some((c) => c.method === "PUT")).toBe(true);
      const uploadingNav = navigation(h);
      for (const e of [uploadingNav.search, uploadingNav.category, uploadingNav.order, uploadingNav.clear]) expect(e.disabled, "controls lock during blob upload").toBe(true);
      uploadDone();
      await flush(40);
      expect(h.spy.calls.some((c) => c.url.includes("/finalize"))).toBe(true);
      const finalizingNav = navigation(h);
      for (const e of [finalizingNav.search, finalizingNav.category, finalizingNav.order, finalizingNav.clear]) expect(e.disabled, "controls lock during finalize").toBe(true);
      expect(h.summary.textContent).toBe(totals);
      expect(h.spy.manifests[0]!.map((f) => f.path).sort()).toEqual(INCLUDED_PATHS);
    } finally {
      releaseHash(); uploadDone(); finalizeDone();
      await flush(40);
    }
  });

  it.each(["success", "failure"] as const)("discards late traversal after publish %s and resets only on the next real selection", async (outcome) => {
    const h = await bootPublisher(page);
    await pickFolder(h, fixture());
    let nav = navigation(h);
    await query(nav, "equal");
    await choose(nav.category, "Included");
    await choose(nav.order, "Size");
    const releaseDrop = await beginGatedDrop(h);
    const done = h.spy.pause("deploys");
    h.spy.failNextDeploys = outcome === "failure";
    fire(h.publishBtn, "click", {});
    try {
      await flush();
      expect(h.publishBtn.disabled).toBe(true);
      done();
      await flush(60);
      releaseDrop();
      await flush();
      expect(h.root.textContent).not.toContain("late.html");
      if (outcome === "success") {
        expect(h.summary.textContent).toBe("");
        expect(h.publishBtn.disabled).toBe(true);
      } else {
        nav = navigation(h);
        expect(nav.search.disabled).toBe(false);
        expect(nav.search.value).toBe("equal");
        expect(paths(nav.body)).toEqual(["assets/equal-a.txt", "assets/equal-b.txt"]);
        expect(h.publishBtn.disabled).toBe(false);
      }
      await pickFiles(h, [fakeFile("fresh.txt", 0)]);
      nav = navigation(h);
      expect(nav.search.value).toBe("");
      expect(paths(nav.body, ["fresh.txt"])).toEqual(["fresh.txt"]);
      expectCounts(nav.body, 1, 1, 0, 0);
    } finally {
      done(); releaseDrop(); await flush();
    }
  });
});

// Passing controls distinguish missing navigation from a broken import/fixture.
describe("navigation harness controls", () => {
  it.each(["publish", "home"] as const)("runs the real %s publisher, reviews and sends the unfiltered fixture", async (page) => {
    const h = await bootPublisher(page);
    const files = fixture();
    await pickFolder(h, files);
    const body = panel(h);
    expect(paths(body).sort()).toEqual([...PATH_ORDER].sort());
    expect(h.summary.textContent).toContain("31 B");
    expect(h.io.hashes).toBe(0);
    expect(files.every((f) => f.arrayBufferCalls === 0)).toBe(true);
    await clickPublish(h);
    expect(h.spy.manifests).toHaveLength(1);
    expect(h.spy.manifests[0]!.map((f) => f.path).sort()).toEqual(INCLUDED_PATHS);
    expect(h.io.hashes).toBe(8);
  });
});
