/**
 * Protected failing-first acceptance contract; only the Test Author may edit.
 * Runs CLIENT_SCRIPT through the real page dispatch, not extracted helpers or
 * source-text assertions. The Builder implements all three surfaces together.
 * Run: npm run test:browser-code -- test/expiry-left.acceptance.test.ts
 */
import { describe, expect, it } from "vitest";
import { boundaries, day, hour, instant, marker, reads, surfaces } from "./expiry-left.fixtures.ts";
import { mount } from "./expiry-left.harness.ts";

for (const surface of surfaces) {
  describe(`${surface}: expiry remaining`, () => {
    // Break: render no page, lose controls, fetch extra data, mutate, poll, or
    // insert metadata with innerHTML. These controls must already pass on main.
    it("renders its existing controls with only the existing bounded reads", async () => {
      const view = await mount(surface);
      expect(view.region(), "the real client must finish rendering").toBeTruthy();
      if (surface === "site") {
        expect(view.root.textContent).toContain("Versions");
        expect(view.root.textContent).toContain("Settings");
        expect(view.root.textContent).toContain("Open site");
      } else if (surface === "sites") {
        expect(view.doc.getElementById("dw-sites-count")!.textContent).toBe("1 site.");
        const search = view.root.querySelector('input[aria-label="Filter loaded sites"]')!;
        search.value = "does-not-match"; search.dispatch("input");
        expect(Boolean(view.region().hidden)).toBe(true);
        expect(view.doc.getElementById("dw-sites-count")!.textContent).toBe("0 matches of 1 loaded site.");
        search.value = ""; search.dispatch("input");
        expect(Boolean(view.region().hidden)).toBe(false);
      } else {
        expect(view.root.textContent).toContain("Revoke");
        expect(view.root.textContent).toContain("Never used");
      }
      expect([...view.calls].sort()).toEqual([...reads[surface]].sort());
      expect(view.violations).toEqual([]);
      expect(view.timers).toEqual([]);
    });

    // Break: keep calendar-only formatting, use the wrong rounding or plural,
    // or prefix a negative duration with "in" instead of marking it Expired.
    it.each(boundaries)("renders $label honestly", async ({ offset, want }) => {
      const iso = instant(offset);
      const view = await mount(surface, iso);
      const text = view.expiry()?.textContent ?? "";
      if (surface === "site") expect(text).toContain(want);
      else expect(text).toBe(want);
      expect(text).not.toMatch(/in\s*-\d|Invalid Date|Expires Expired/);
      expect(view.region().querySelectorAll("[title]").some(el => el.getAttribute("title") === iso)
        || view.region().getAttribute("title") === iso, "the exact input instant stays in title").toBe(true);
      if (surface === "site") expect(text, "detail shows local date AND time beside relative text")
        .toContain(new Date(iso).toLocaleString());
    });

    // Break: show enormous relative day counts, switch locale/timezone, or
    // change the existing ago()-style long-date fallback.
    it.each([30, 45])("uses the locale date at %i days", async days => {
      const iso = instant(days * day);
      const view = await mount(surface, iso);
      const date = new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      if (surface === "site") expect(view.expiry()!.textContent).toContain(`Expires ${date}`);
      else expect(view.expiry()?.textContent).toBe(`Expires ${date}`);
      expect(view.region().textContent).not.toMatch(/in (30|45) days/);
    });

    // Break: call Date on null/undefined/empty, invent an expiry for permanent
    // resources, or replace the existing key cell's literal No expiry.
    it.each([undefined, null, ""])("preserves the non-expiring display for %s", async value => {
      const view = await mount(surface, value);
      if (surface === "keys") expect(view.expiry()!.textContent).toBe("No expiry");
      else expect(view.region().textContent).not.toMatch(/Expir|No expiry|Invalid Date/);
    });

    // Break: display Invalid Date, echo invalid timestamps, or allow markup to
    // become app-origin elements. Invalid differs from an intentionally absent expiry.
    it.each(["not-a-date", "2026-99-99T99:99:99Z", marker])("omits invalid expiry %s", async value => {
      const view = await mount(surface, value);
      const text = surface === "keys" ? view.expiry()!.textContent : view.region().textContent;
      expect(text).not.toMatch(/Expir|No expiry|Invalid Date/);
      expect(text).not.toContain(value);
      expect(view.region().querySelectorAll("img,script,iframe")).toEqual([]);
      expect(view.region().querySelectorAll("[title]").some(el => el.getAttribute("title") === value)).toBe(false);
      expect(view.violations).toEqual([]);
    });

    // Break: add any expiry timer, polling, new endpoint or mutation, or update
    // already-rendered text merely because wall time moves forward.
    it("computes at render only, without extra reads or scheduled work", async () => {
      const view = await mount(surface, instant(3 * hour));
      const before = view.region().textContent;
      await view.advance();
      expect(view.region().textContent).toBe(before);
      expect([...view.calls].sort()).toEqual([...reads[surface]].sort());
      expect(view.timers).toEqual([]);
      expect(view.violations).toEqual([]);
    });
  });
}
