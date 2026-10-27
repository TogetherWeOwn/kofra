/**
 * Acceptance: keyboard focus must be visible on the no-script viewer toggles
 * (WCAG 2.4.7). The image/SVG "Actual size" zoom toggle and the JSON
 * Tree/Pretty radios are visually hidden inputs whose visible control is a
 * <label> reached through general-sibling selectors; when the hidden input
 * takes keyboard focus, that label must show an indicator, in light and dark
 * schemes, distinguishable from the checked state. The code viewer's Wrap
 * toggle already does this and is pinned here as a regression.
 *
 * This file is the fast Workers-runtime half: it pins the rendered
 * stylesheet/DOM contract, script-free CSP, and the viewer-version ETag
 * behaviour (a pre-change conditional request must not be answered 304,
 * which would keep serving the stale toggle styling). The computed-style,
 * keyboard-only ground truth in a disposable browser lives in
 * packages/cli/test/encrypted/viewer-toggle-focus.browser.acceptance.test.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { form, freshInstance, type Instance } from "./helpers";

const NAV = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };

/** The unchanged viewer CSP (no scripts at all) for the image, SVG and JSON
 * pages, including the sandbox suffix the shared header layer appends. */
const SCRIPT_FREE_CSP =
  "default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'unsafe-inline' https:; font-src * data:; frame-src https:; base-uri 'none'; form-action 'none'; " +
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock";

interface CssRule {
  selectors: string[];
  declarations: string;
}

/** Rules from every <style> block; @media wrappers yield their inner rules. */
function cssRules(html: string): CssRule[] {
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!).join("\n");
  const rules: CssRule[] = [];
  for (const m of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.split(",").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (selectors.length) rules.push({ selectors, declarations: m[2]! });
  }
  return rules;
}

/** A declaration block paints a visible indicator: a real outline or a box-shadow. */
function paintsIndicator(declarations: string): boolean {
  if (/(^|;)\s*outline\s*:\s*(?!none\b|0(?:px|rem|em)?(\s|;|$))/.test(declarations)) return true;
  if (/(^|;)\s*box-shadow\s*:\s*(?!none\b)/.test(declarations)) return true;
  return /(^|;)\s*outline-style\s*:\s*(?!none\b)/.test(declarations) && /(^|;)\s*outline-width\s*:\s*(?!0(?:px|rem|em)?(\s|;|$))/.test(declarations);
}

/**
 * True when some rule puts a visible indicator on `target` while the toggle
 * input (any of `inputRefs`, e.g. "#dw-zoom") holds :focus-visible, via the
 * general-sibling pattern the viewers already use for :checked (or an
 * equivalent :has() form). An adjacent-sibling (`+`) rule does not count:
 * in these viewers no label is the input's adjacent sibling.
 */
function hasFocusIndicatorRule(html: string, inputRefs: string[], target: RegExp): boolean {
  for (const rule of cssRules(html)) {
    if (!paintsIndicator(rule.declarations)) continue;
    for (const selector of rule.selectors) {
      if (!selector.includes(":focus-visible")) continue;
      if (!inputRefs.some((ref) => selector.includes(ref))) continue;
      const hasIdx = selector.indexOf(":has(");
      if (hasIdx >= 0) {
        const close = selector.indexOf(")", hasIdx);
        if (close >= 0 && target.test(selector.slice(close + 1))) return true;
        continue;
      }
      const afterFocus = selector.slice(selector.indexOf(":focus-visible"));
      const tilde = afterFocus.indexOf("~");
      if (tilde >= 0 && target.test(afterFocus.slice(tilde))) return true;
    }
  }
  return false;
}

/** A :checked rule reaching `target` (the pre-existing toggle behaviour). */
function hasCheckedRule(html: string, inputRef: string, target: RegExp): boolean {
  return cssRules(html).some((rule) =>
    rule.selectors.some((s) => s.includes(`${inputRef}:checked`) && s.includes("~") && target.test(s.slice(s.indexOf("~")))),
  );
}

const MEDIABAR_LABEL = /dw-mediabar[^~]*label|label\s*\[\s*for\s*=\s*"?dw-zoom"?\s*\]/;
const treeLabel = /label\s*\[\s*for\s*=\s*"?dw-jt-tree"?\s*\]/;
const prettyLabel = /label\s*\[\s*for\s*=\s*"?dw-jt-pretty"?\s*\]/;
const WRAP_LABEL = /dw-codehead[^~]*label|label\s*\[\s*for\s*=\s*"?dw-wrap"?\s*\]/;

describe("viewer toggle focus (rendered contract)", () => {
  let dw: Instance;
  let slug: string;
  // PNG header stub with a 64x32 IHDR, as in viewers.test.ts; the media
  // viewer only reads the header here.
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32, 8, 2, 0, 0, 0, 1, 2, 3]);

  beforeAll(async () => {
    dw = await freshInstance();
    const res = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      body: form({
        "img/logo.png": PNG,
        "img/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
        "data/config.json": '{"name":"focus","list":[1,2,3],"nested":{"ok":true}}',
        "src/app.ts": "// toggle focus fixture\nexport const answer: number = 42;\n",
      }),
    });
    expect(res.status).toBe(201);
    slug = res.body.slug;
  });

  const get = (path: string, headers: Record<string, string> = NAV) => dw.call(`/s/${slug}/${path}`, { headers });
  const page = async (path: string) => {
    const res = await get(path);
    expect(res.status, path).toBe(200);
    return { res, html: await res.text() };
  };

  it.each([
    ["image", "img/logo.png"],
    ["svg", "img/icon.svg"],
  ])("%s viewer: focused zoom toggle outlines the visible Actual size control", async (_id, path) => {
    const { html } = await page(path);
    // The hidden input, its visible mediabar control, and the stage label,
    // still siblings in this order so the :checked~ zoom rules keep working.
    const input = html.indexOf('<input type="checkbox" id="dw-zoom"');
    const mediabar = html.indexOf('class="dw-mediabar"');
    const stage = html.indexOf("dw-stage dw-checker");
    expect(input, "zoom toggle input").toBeGreaterThan(-1);
    expect(mediabar, "mediabar follows the toggle").toBeGreaterThan(input);
    expect(stage, "checker stage follows the mediabar").toBeGreaterThan(mediabar);
    expect(html).toContain('<label for="dw-zoom" class="dw-btn">Actual size</label>');
    expect(html).toContain('<label for="dw-zoom" class="dw-stage dw-checker">');
    // Pre-existing checked behaviour stays wired (click/tap and zoom).
    expect(hasCheckedRule(html, "#dw-zoom", /\.dw-stage/), "checked zoom still reaches the stage").toBe(true);
    // The fix under test: keyboard focus on the hidden input must paint a
    // visible indicator on the visible control.
    expect(
      hasFocusIndicatorRule(html, ["#dw-zoom", ".dw-toggle"], MEDIABAR_LABEL),
      "a :focus-visible general-sibling rule paints an outline/shadow on the Actual size label",
    ).toBe(true);
    // Distinguishable from checked: the checked mediabar-label rule must not
    // be the thing doing the outlining (focus paints while unchecked too;
    // the browser suite asserts the computed styles).
    const checkedMediabar = cssRules(html).filter((r) => r.selectors.some((s) => s.includes("#dw-zoom:checked") && MEDIABAR_LABEL.test(s)));
    expect(checkedMediabar.every((r) => !paintsIndicator(r.declarations)), "checked styling does not masquerade as the focus indicator").toBe(true);
  });

  it("json viewer: focused Tree/Pretty radios outline their own tab labels", async () => {
    const { html } = await page("data/config.json");
    const tree = html.indexOf('<input type="radio" name="dw-jt" id="dw-jt-tree"');
    const pretty = html.indexOf('<input type="radio" name="dw-jt" id="dw-jt-pretty"');
    const tabs = html.indexOf('class="dw-jtabs"');
    const treePane = html.indexOf("dw-jpane dw-jtree");
    expect(tree, "Tree radio").toBeGreaterThan(-1);
    expect(pretty, "Pretty radio follows Tree").toBeGreaterThan(tree);
    expect(tabs, "tab labels follow the radios").toBeGreaterThan(pretty);
    expect(treePane, "panes follow the tab labels").toBeGreaterThan(tabs);
    expect(html).toContain('<label for="dw-jt-tree">Tree</label>');
    expect(html).toContain('<label for="dw-jt-pretty">Pretty</label>');
    // No-script tab switch keeps its :checked~ wiring for both panes.
    expect(hasCheckedRule(html, "#dw-jt-tree", /\.dw-jtree/), "checked Tree still shows the tree pane").toBe(true);
    expect(hasCheckedRule(html, "#dw-jt-pretty", /\.dw-jpretty/), "checked Pretty still shows the pretty pane").toBe(true);
    // Each radio's focus must outline its own label (a shared class-only
    // rule cannot tell the two apart, so the radio ids are required here).
    expect(hasFocusIndicatorRule(html, ["#dw-jt-tree"], treeLabel), "Tree radio focus outlines the Tree label").toBe(true);
    expect(hasFocusIndicatorRule(html, ["#dw-jt-pretty"], prettyLabel), "Pretty radio focus outlines the Pretty label").toBe(true);
    // Focus is not the checked style: checked tab rules paint no outline.
    const checkedTabs = cssRules(html).filter((r) => r.selectors.some((s) => /#dw-jt-(tree|pretty):checked/.test(s) && /dw-jtabs/.test(s)));
    expect(checkedTabs.length, "checked tab styling exists").toBeGreaterThan(0);
    expect(checkedTabs.every((r) => !paintsIndicator(r.declarations)), "checked tab styling is not the focus indicator").toBe(true);
  });

  it("code viewer: Wrap toggle focus indicator keeps working (regression)", async () => {
    const { html } = await page("src/app.ts");
    const input = html.indexOf('<input type="checkbox" id="dw-wrap"');
    expect(input, "wrap toggle input").toBeGreaterThan(-1);
    expect(html.indexOf('class="dw-codehead"'), "code head follows the toggle").toBeGreaterThan(input);
    expect(html).toContain('<label for="dw-wrap" class="dw-btn">Wrap</label>');
    expect(hasFocusIndicatorRule(html, ["#dw-wrap", ".dw-toggle"], WRAP_LABEL), "Wrap label still outlined on :focus-visible").toBe(true);
  });

  it("source views are unchanged and keep the Wrap focus indicator", async () => {
    for (const path of ["img/icon.svg?view=source", "data/config.json?view=source"]) {
      const { res, html } = await page(path);
      expect(res.headers.get("x-kofra-viewer"), path).toBe("source");
      expect(hasFocusIndicatorRule(html, ["#dw-wrap", ".dw-toggle"], WRAP_LABEL), `${path}: Wrap focus rule`).toBe(true);
    }
  });

  it("image, SVG and JSON viewers stay script-free with the unchanged CSP", async () => {
    for (const path of ["img/logo.png", "img/icon.svg", "data/config.json"]) {
      const { res, html } = await page(path);
      expect(html, `${path}: no script element`).not.toContain("<script");
      expect(res.headers.get("content-security-policy"), `${path}: CSP unchanged`).toBe(SCRIPT_FREE_CSP);
    }
    // The code viewer's single hashed helper script is the only exception,
    // exactly as today.
    const { res, html } = await page("src/app.ts");
    expect((html.match(/<script/g) ?? []).length, "code viewer keeps exactly its one hashed script").toBe(1);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain("script-src 'unsafe-inline'");
  });

  it.each([
    ["image", "img/logo.png"],
    ["svg", "img/icon.svg"],
    ["json", "data/config.json"],
  ])("%s viewer: ETag version is bumped so stale styling is never revalidated", async (viewerId, path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag")!;
    const m = new RegExp(`^W/"${viewerId}@(\\d+)-[a-f0-9]{64}(?:-nav[a-z0-9]+)?"$`).exec(etag);
    expect(m, `${viewerId} ETag shape: ${etag}`).not.toBeNull();
    // Viewer ETags derive from the viewer version; the pre-change pages were
    // version 1, so anything still at 1 can be answered 304 with the old
    // (focus-less) styling. This includes the JSON viewer: its CSS is
    // rendered into every page, so its version interaction must move too.
    expect(Number(m![1]), `${viewerId} viewer version must be bumped past the pre-change 1`).toBeGreaterThan(1);
  });

  it.each([
    ["image", "img/logo.png"],
    ["svg", "img/icon.svg"],
    ["json", "data/config.json"],
  ])("%s viewer: a pre-change conditional request gets fresh styling, the current one 304", async (viewerId, path) => {
    const res = await get(path);
    const etag = res.headers.get("etag")!;
    expect(etag, `${viewerId} serves an ETag`).toMatch(new RegExp(`^W/"${viewerId}@\\d+-`));
    // The validator a browser cached before the focus fix existed.
    const stale = etag.replace(/@\d+-/, "@1-");
    const revalidated = await get(path, { ...NAV, "If-None-Match": stale });
    expect(revalidated.status, `${viewerId}: pre-change validator must not match`).toBe(200);
    expect(await revalidated.text(), `${viewerId}: revalidated body carries a focus indicator rule`).toContain(":focus-visible");
    const current = await get(path, { ...NAV, "If-None-Match": etag });
    expect(current.status, `${viewerId}: current validator still short-circuits`).toBe(304);
  });
});
