/**
 * Protected acceptance contract: app-origin manual-activation View mode tabs.
 * The paired builder must not edit this file or its fixture.
 * Run: npm run test:cli -- test/encrypted/view-mode-keyboard.acceptance.test.ts
 * Prerequisites: npm ci --include=dev; npm ci --prefix packages/cli/test/encrypted --include=dev;
 * packages/cli/test/encrypted/node_modules/.bin/playwright install --with-deps chromium
 * Optional: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH and the runner's LD_LIBRARY_PATH.
 * Real local Worker, first-party bundle, native focus, iframe loads and history.
 * No implementation imports, injected UI, mocked content, remote config or deploy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Locator, Page } from "playwright";
import { fixtures, longPath, settle, slug, startFixture, viewerPath, visit, type Fixture, type View } from "./view-mode-keyboard.fixture";

function group(page: Page) { return page.getByRole("tablist", { name: "View mode", exact: true }); }
function mode(page: Page, name: "rendered" | "source" | "raw") {
  // Existing kind-specific labels include Page (HTML), Info (binary) and Rendered.
  // The contract does not require renaming them; the first mode is the preview.
  return name === "rendered" ? group(page).getByRole("tab").first() : group(page).getByRole("tab", { name: new RegExp(`^${name}$`, "i") });
}
function focused(locator: Locator) { return locator.evaluate(el => el.ownerDocument.activeElement === el); }
async function selected(page: Page, name: "rendered" | "source" | "raw") {
  await expect.poll(() => mode(page, name).getAttribute("aria-selected")).toBe("true");
  expect(await group(page).locator('[role="tab"][aria-selected="true"]').count()).toBe(1);
}
async function roving(page: Page, name: "rendered" | "source" | "raw") {
  expect(await mode(page, name).evaluate(el => (el as any).tabIndex), "the focused mode is the only tab stop").toBe(0);
  const stops = await group(page).getByRole("tab").evaluateAll(els => els.map(el => (el as any).tabIndex));
  expect(stops.filter(index => index === 0)).toHaveLength(1);
  expect(stops.every(index => index === 0 || index === -1)).toBe(true);
}
async function wiring(page: Page, active: "rendered" | "source" | "raw") {
  await selected(page, active);
  const relationships = await group(page).getByRole("tab").evaluateAll(tabs => tabs.map(tab => {
    const doc = tab.ownerDocument;
    const panel = doc.getElementById(tab.getAttribute("aria-controls") ?? "");
    const frame = doc.querySelector("iframe");
    return {
      id: tab.id, controls: !!panel, role: panel?.getAttribute("role"),
      selected: tab.getAttribute("aria-selected") === "true",
      labelledBy: (panel?.getAttribute("aria-labelledby") ?? "").split(/\s+/).includes(tab.id),
      containsFrame: !!panel && (panel === frame || (!!frame && panel.contains(frame))),
    };
  }));
  expect(relationships.every(row => row.id.length > 0), "tabs need stable, nonempty association IDs").toBe(true);
  expect(new Set(relationships.map(row => row.id)).size).toBe(relationships.length);
  expect(relationships.every(row => row.controls && row.role === "tabpanel"), "every tab controls a real tabpanel").toBe(true);
  expect(relationships.find(row => row.selected)).toMatchObject({ labelledBy: true, containsFrame: true });
}
async function snapshot(view: View) {
  await settle(view.page);
  return view.page.evaluate(() => {
    const w = globalThis as any;
    return { url: w.location.href, length: w.history.length, state: JSON.stringify(w.history.state), src: w.document.querySelector("iframe").src };
  });
}
async function frame(view: View, fixture: Fixture, path: string, name: "rendered" | "source" | "raw") {
  const url = new URL(await view.page.locator("iframe").getAttribute("src") ?? "", fixture.origin);
  expect(url.origin).toBe(fixture.sites);
  expect(decodeURIComponent(url.pathname)).toBe(`${fixture.sites === fixture.origin ? "/s" : ""}/${slug}/${path}`);
  expect(url.hash).toBe("");
  expect(url.searchParams.get("raw")).toBe(name === "raw" ? "1" : null);
  expect(url.searchParams.get("view")).toBe(name === "source" ? "source" : name === "rendered" && !path.endsWith(".html") ? "1" : null);
  if (name === "source" || (name === "rendered" && !path.endsWith(".html"))) expect(url.searchParams.get("embed")).toBe("1");
  const sandbox = (await view.page.locator("iframe").getAttribute("sandbox") ?? "").split(/\s+/);
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox.includes("allow-same-origin")).toBe(fixture.sites !== fixture.origin);
  expect(await view.page.locator("iframe").getAttribute("referrerpolicy")).toBe("no-referrer");
  return url;
}
async function activate(view: View, fixture: Fixture, path: string, name: "rendered" | "source" | "raw", key?: "Enter" | "Space") {
  const before = await snapshot(view);
  const count = view.calls.length;
  if (key) { await mode(view.page, name).focus(); await view.page.keyboard.press(key); }
  else await mode(view.page, name).click();
  await selected(view.page, name);
  await expect.poll(async () => (await snapshot(view)).src !== before.src).toBe(true);
  await expect.poll(() => view.calls.slice(count).some(call => new URL(call.slice(4)).pathname.startsWith(`${fixture.sites === fixture.origin ? "/s" : ""}/${slug}/`))).toBe(true);
  await view.page.waitForLoadState("networkidle"); await settle(view.page);
  const after = await snapshot(view);
  expect(after.length, "one activation makes one history entry, not keydown plus synthetic click entries").toBe(before.length + 1);
  const content = view.calls.slice(count).filter(call => new URL(call.slice(4)).pathname.startsWith(`${fixture.sites === fixture.origin ? "/s" : ""}/${slug}/`));
  // These source/raw frames contain no subresources. One activation must not
  // reload the old mode or issue the same content navigation twice.
  expect(content, "one activation issues the existing single content request").toHaveLength(1);
  const expected = await frame(view, fixture, path, name);
  expect(new URL(content[0]!.slice(4)).href).toBe(expected.href);
  expect(view.calls.slice(count).every(call => call.startsWith("GET "))).toBe(true);
}

for (const separate of [false, true]) describe(`manual View mode tabs (${separate ? "separate sites origin" : "same-origin sandbox"})`, () => {
  let fixture: Fixture;
  beforeAll(async () => { fixture = await startFixture(separate); }, 120_000);
  afterAll(async () => { await fixture?.dispose(); });

  it("labels the selected panel and exposes exactly one initial tab stop without grabbing focus", async () => {
    const view = await visit(fixture);
    try {
      expect(await group(view.page).count()).toBe(1);
      await selected(view.page, "rendered");
      expect(await group(view.page).evaluate(el => el.contains(el.ownerDocument.activeElement)), "initial load must not focus View mode").toBe(false);
      await roving(view.page, "rendered"); await wiring(view.page, "rendered");
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("associates every mode with a labelled preview panel", async () => {
    const view = await visit(fixture);
    try { await wiring(view.page, "rendered"); }
    finally { await view.context.close(); }
  });

  it("control: text-field Home/End/arrows/Space retain their native behavior outside View mode", async () => {
    const view = await visit(fixture);
    try {
      const search = view.page.getByRole("searchbox", { name: "Filter files", exact: true });
      const before = await snapshot(view); const calls = [...view.calls];
      await search.fill("photo"); await search.press("Home"); await search.press("ArrowRight");
      expect(await focused(search)).toBe(true);
      expect(await search.evaluate(el => (el as any).selectionStart)).toBe(1);
      await search.press("End"); expect(await search.evaluate(el => (el as any).selectionStart)).toBe(5);
      await search.press("Space"); expect(await search.inputValue()).toBe("photo ");
      expect(await snapshot(view)).toEqual(before); expect(view.calls).toEqual(calls);
    } finally { await view.context.close(); }
  });

  it.each([{ path: "index.html", width: 1100 }, { path: "note.txt", width: 360 }])("arrows/Home/End move focus manually without content or history effects ($path, $width px)", async ({ path, width }) => {
    const view = await visit(fixture, path, width);
    try {
      const before = await snapshot(view); const calls = [...view.calls];
      await mode(view.page, "rendered").focus();
      const moves = [
        ["ArrowRight", "source"], ["ArrowRight", "raw"], ["ArrowRight", "rendered"],
        ["ArrowLeft", "raw"], ["Home", "rendered"], ["End", "raw"], ["ArrowLeft", "source"],
      ] as const;
      for (const [key, target] of moves) {
        await view.page.keyboard.press(key); await settle(view.page);
        expect(await focused(mode(view.page, target)), `${key} moves focus to ${target}`).toBe(true);
        await roving(view.page, target); await selected(view.page, "rendered");
        await wiring(view.page, "rendered");
      }
      expect(await snapshot(view)).toEqual(before);
      expect(view.calls, "focus-only keys must never fetch file content or metadata").toEqual(calls);
      await view.page.keyboard.press("Tab");
      expect(await group(view.page).evaluate(el => el.contains(el.ownerDocument.activeElement)), "Tab leaves the group").toBe(false);
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });

  it.each(["Enter", "Space"] as const)("%s activates once and restores the replacement tab, including repeated mode changes", async key => {
    const view = await visit(fixture, "note.txt");
    try {
      for (const target of ["source", "raw", "source"] as const) {
        await activate(view, fixture, "note.txt", target, key);
        expect(await focused(mode(view.page, target)), "activation must not drop focus onto body when controls are rebuilt").toBe(true);
        await roving(view.page, target); await wiring(view.page, target);
      }
      const before = await snapshot(view); const calls = [...view.calls];
      await view.page.keyboard.press(key); await settle(view.page);
      expect(await snapshot(view), "reactivating the selected mode is a no-op").toEqual(before);
      expect(view.calls).toEqual(calls);
      expect(await focused(mode(view.page, "source"))).toBe(true);
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("click activation at 360px keeps the selected replacement tab focused and visible for long Unicode paths", async () => {
    const view = await visit(fixture, longPath, 360);
    try {
      for (const target of ["source", "raw", "source"] as const) {
        await activate(view, fixture, longPath, target);
        expect(await focused(mode(view.page, target)), "a native click originates focus in the tablist").toBe(true);
        await roving(view.page, target); await wiring(view.page, target);
        const box = await mode(view.page, target).boundingBox(); expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(361);
      }
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });

  it.each(["bytes.bin", "photo.png"])("two-mode %s has no Source tab stop and wraps only through available modes", async path => {
    const view = await visit(fixture, path, 360);
    try {
      const available = await group(view.page).getByRole("tab").evaluateAll(tabs => tabs.filter(tab => !(tab as any).disabled && tab.getAttribute("aria-disabled") !== "true").length);
      expect(available).toBe(2);
      if (await mode(view.page, "source").count()) {
        expect(await mode(view.page, "source").evaluate(el => (el as any).disabled || el.getAttribute("aria-disabled") === "true")).toBe(true);
        expect(await mode(view.page, "source").evaluate(el => (el as any).tabIndex)).toBe(-1);
      }
      const before = await snapshot(view); const calls = [...view.calls];
      await mode(view.page, "rendered").focus();
      for (const [key, target] of [["ArrowLeft", "raw"], ["ArrowRight", "rendered"], ["End", "raw"], ["Home", "rendered"]] as const) {
        await view.page.keyboard.press(key); await settle(view.page);
        expect(await focused(mode(view.page, target))).toBe(true); await roving(view.page, target);
      }
      expect(await snapshot(view)).toEqual(before); expect(view.calls).toEqual(calls);
      await activate(view, fixture, path, "raw", "Enter");
      expect(await focused(mode(view.page, "raw"))).toBe(true); await wiring(view.page, "raw");
    } finally { await view.context.close(); }
  });

  it.each(["bytes.bin", "photo.png"])("unavailable Source mode in the URL falls back to the first mode for %s without a dead tab stop", async path => {
    const view = await visit(fixture, path, 360, "source");
    try {
      await selected(view.page, "rendered");
      await roving(view.page, "rendered");
      await wiring(view.page, "rendered");
      // frame() pins the rendered iframe URL exactly (view=1 for these kinds),
      // so a fallback that still loads ?view=source fails here.
      await frame(view, fixture, path, "rendered");
      const available = await group(view.page).getByRole("tab").evaluateAll(tabs => tabs.filter(tab => !(tab as any).disabled && tab.getAttribute("aria-disabled") !== "true").length);
      expect(available).toBe(2);
      if (await mode(view.page, "source").count()) {
        expect(await mode(view.page, "source").evaluate(el => (el as any).disabled || el.getAttribute("aria-disabled") === "true")).toBe(true);
        expect(await mode(view.page, "source").evaluate(el => (el as any).tabIndex)).toBe(-1);
        expect(await mode(view.page, "source").getAttribute("aria-selected")).toBe("false");
      }
      expect(await group(view.page).evaluate(el => el.contains(el.ownerDocument.activeElement)), "fallback on load must not grab focus").toBe(false);
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("an unknown mode in the URL falls back to the first mode", async () => {
    const view = await visit(fixture, "note.txt", 1100, "garbage");
    try {
      await selected(view.page, "rendered");
      await roving(view.page, "rendered");
      await wiring(view.page, "rendered");
      await frame(view, fixture, "note.txt", "rendered");
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("file navigation reconciles Source to a valid mode without stealing focus", async () => {
    const view = await visit(fixture, "note.txt", 360, "source");
    try {
      await selected(view.page, "source");
      const file = view.page.locator(`a[data-path="photo.png"]`);
      await file.focus(); await view.page.keyboard.press("Enter");
      await expect.poll(() => decodeURIComponent(new URL(view.page.url()).pathname)).toBe(viewerPath("photo.png"));
      await selected(view.page, "rendered");
      expect(await focused(file), "file/tree navigation must not move focus into a mode tab").toBe(true);
      await roving(view.page, "rendered"); await wiring(view.page, "rendered");
      if (await mode(view.page, "source").count()) {
        expect(await mode(view.page, "source").evaluate(el => (el as any).disabled || el.getAttribute("aria-disabled") === "true")).toBe(true);
        expect(await mode(view.page, "source").evaluate(el => (el as any).tabIndex)).toBe(-1);
      }
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("Back/Forward restores modes and file URLs without pulling focus from the file filter", async () => {
    const view = await visit(fixture, "note.txt");
    try {
      await activate(view, fixture, "note.txt", "source");
      const source = view.page.url();
      await activate(view, fixture, "note.txt", "raw");
      const raw = view.page.url();
      await view.page.locator('a[data-path="index.html"]').focus();
      await view.page.keyboard.press("Enter");
      await expect.poll(() => new URL(view.page.url()).pathname).toBe(viewerPath("index.html"));
      // File-tree navigation already resets the mode to the file's preview.
      // Preserve that behavior rather than inventing cross-file mode retention.
      await selected(view.page, "rendered");
      const html = view.page.url(); const length = (await snapshot(view)).length;
      const search = view.page.getByRole("searchbox", { name: "Filter files", exact: true });
      await search.focus();
      await view.page.goBack(); await selected(view.page, "raw");
      await expect.poll(() => view.page.url()).toBe(raw);
      expect(await focused(search), "file-history traversal must not focus a mode tab").toBe(true);
      await frame(view, fixture, "note.txt", "raw");
      await view.page.goBack(); await selected(view.page, "source");
      await expect.poll(() => view.page.url()).toBe(source);
      expect(await focused(search), "popstate must not focus Source").toBe(true);
      await frame(view, fixture, "note.txt", "source");
      await view.page.goForward(); await selected(view.page, "raw");
      await expect.poll(() => view.page.url()).toBe(raw);
      expect(await focused(search), "popstate must not focus Raw").toBe(true);
      expect((await snapshot(view)).length).toBe(length);
      await frame(view, fixture, "note.txt", "raw");
      await view.page.goForward(); await selected(view.page, "rendered");
      await expect.poll(() => view.page.url()).toBe(html);
      expect(await focused(search)).toBe(true);
      await frame(view, fixture, "index.html", "rendered");
      expect((await snapshot(view)).length).toBe(length);
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("a programmatic click from outside the group changes mode without stealing focus", async () => {
    const view = await visit(fixture);
    try {
      const search = view.page.getByRole("searchbox", { name: "Filter files", exact: true });
      await search.focus();
      await mode(view.page, "source").evaluate(el => (el as any).click());
      await selected(view.page, "source"); await settle(view.page);
      expect(await focused(search)).toBe(true);
      await frame(view, fixture, "index.html", "source");
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });

  it("keyboard focus has a visible indicator and reverse Tab can leave the group", async () => {
    const view = await visit(fixture, "note.txt", 360);
    try {
      await mode(view.page, "rendered").focus();
      await view.page.keyboard.press("Tab"); await view.page.keyboard.press("Shift+Tab");
      expect(await focused(mode(view.page, "rendered")), "Shift+Tab re-enters the sole tab stop").toBe(true);
      const indicator = await mode(view.page, "rendered").evaluate(el => {
        const css = (globalThis as any).getComputedStyle(el);
        return (css.outlineStyle !== "none" && parseFloat(css.outlineWidth) > 0 && css.outlineColor !== "transparent" && css.outlineColor !== "rgba(0, 0, 0, 0)") || css.boxShadow !== "none";
      });
      expect(indicator, "keyboard focus must be visibly indicated by the shipped styles").toBe(true);
      await view.page.keyboard.press("Shift+Tab");
      expect(await group(view.page).evaluate(el => el.contains(el.ownerDocument.activeElement))).toBe(false);
    } finally { await view.context.close(); }
  });

  it("control: source/raw bytes, iframe isolation and no-script public chrome stay unchanged", async () => {
    const view = await visit(fixture, "note.txt");
    try {
      expect(view.shellCsp).toContain("script-src 'self'");
      expect(view.shellCsp).toContain("frame-ancestors 'none'");
      await frame(view, fixture, "note.txt", "rendered");
      for (const target of ["source", "raw"] as const) await activate(view, fixture, "note.txt", target);
      const raw = await fixture.browser.newContext({ javaScriptEnabled: false });
      try {
        const page = await raw.newPage();
        const response = await page.goto(`${fixture.sites}${fixture.sites === fixture.origin ? "/s" : ""}/${slug}/index.html?view=1`, { waitUntil: "networkidle" });
        expect(response?.status()).toBe(200);
        const csp = response!.headers()["content-security-policy"] ?? "";
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("base-uri 'none'");
        // Code viewers already allow a fixed hash for their line-range script;
        // the public mode bar itself must still work with JavaScript disabled.
        const scripts = csp.split(";").map(part => part.trim()).find(part => part.startsWith("script-src ")) ?? "default-src 'none'";
        expect(scripts).toMatch(/^(?:default-src 'none'|script-src (?:'none'|'sha256-[A-Za-z0-9+/=]+'))$/);
        expect(await page.getByRole("tablist").count(), "public viewer remains plain no-script links").toBe(0);
        const source = page.getByRole("link", { name: "Source", exact: true });
        expect(await source.count()).toBe(1);
        await source.click();
        expect(new URL(page.url()).searchParams.get("view")).toBe("source");
        const bytes = await fetch(`${fixture.sites}${fixture.sites === fixture.origin ? "/s" : ""}/${slug}/note.txt?raw=1`);
        expect(await bytes.text()).toBe(fixtures["note.txt"]);
      } finally { await raw.close(); }
      expect(view.errors).toEqual([]);
    } finally { await view.context.close(); }
  });
});
