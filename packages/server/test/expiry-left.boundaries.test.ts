/**
 * Supplemental boundary regression coverage for the relative expiry formatter.
 *
 * This file is additive. It imports the protected acceptance harness and
 * fixtures read-only and never modifies them; the protected acceptance
 * contract in expiry-left.acceptance.test.ts remains the Test Author's.
 *
 * It pins two boundaries the whole-second acceptance table does not hit,
 * distinguishing these single-operator mutations of client.ts:
 *
 *   1. `remaining < 0` -> `remaining <= 0` at client.ts:242. Exactly-at-expiry
 *      instants would render "Expired ..." though site/key expiry is strict `<`
 *      server-side (serve.ts:318, core/src/services/keys.ts:186). Expected text
 *      at remaining === 0 is "Expires in under a minute".
 *
 *   2. `Math.round(remaining / 1000)` -> `Math.floor(...)` at client.ts:243.
 *      Whole-second fixture offsets cannot distinguish the two; sub-second
 *      remainders can. 44_500 ms must read "1 min" (floor reads "under a
 *      minute") and 89_500 ms must read "2 min" (floor reads "1 min").
 *      Just below each transition, 44_499 ms stays "under a minute" and
 *      89_499 ms stays "1 min", distinguishing round from Math.ceil.
 *
 * Run: npm run test:browser-code -- test/expiry-left.boundaries.test.ts
 */
import { describe, expect, it } from "vitest";
import { instant, surfaces } from "./expiry-left.fixtures.ts";
import { mount } from "./expiry-left.harness.ts";

// The harness fixes Date.now() to the fixture `now`, so these offsets are the
// exact remaining milliseconds at render time.
const cases = [
  {
    label: "exact expiry instant (remaining === 0)",
    offset: 0,
    want: "Expires in under a minute",
    kills: "remaining <= 0 mutant would render Expired",
  },
  {
    label: "44.499 s rounds down to under a minute",
    offset: 44_499,
    want: "Expires in under a minute",
    kills: "Math.ceil mutant would render Expires in 1 min",
  },
  {
    label: "44.5 s rounds up to one minute",
    offset: 44_500,
    want: "Expires in 1 min",
    kills: "Math.floor mutant would render Expires in under a minute",
  },
  {
    label: "89.499 s rounds down to one minute",
    offset: 89_499,
    want: "Expires in 1 min",
    kills: "Math.ceil mutant would render Expires in 2 min",
  },
  {
    label: "89.5 s rounds up to two minutes",
    offset: 89_500,
    want: "Expires in 2 min",
    kills: "Math.floor mutant would render Expires in 1 min",
  },
];

for (const surface of surfaces) {
  describe(`${surface}: expiry formatter boundary regressions`, () => {
    it.each(cases)(
      "$label renders exactly ($want)",
      async ({ offset, want }) => {
        const iso = instant(offset);
        const view = await mount(surface, iso);
        const text = view.expiry()?.textContent ?? "";

        // The site detail line appends the exact local datetime beside the
        // relative text, so it is a containment assertion; the list badge and
        // the keys cell are exact.
        if (surface === "site") expect(text).toContain(want);
        else expect(text).toBe(want);

        // Guard the mutant directions explicitly, so a future regression is
        // reported in the terms this boundary exists to protect.
        expect(text).not.toMatch(/in\s*-\d|Invalid Date|Expires Expired/);
        expect(text, "an exact-zero instant is not yet expired").not.toMatch(/^Expired\b/);
      },
    );

    it("renders the exact-zero instant as still valid on every surface", async () => {
      const iso = instant(0);
      const view = await mount(surface, iso);
      const text = view.expiry()?.textContent ?? "";
      // Strict `<` expiry semantics: an instant equal to now has not lapsed.
      expect(text).not.toMatch(/^Expired\b/);
      expect(text).toContain("Expires in under a minute");
      // The exact input instant still round-trips into the tooltip.
      expect(
        view.region().querySelectorAll("[title]").some(el => el.getAttribute("title") === iso)
          || view.region().getAttribute("title") === iso,
        "the exact input instant stays in title",
      ).toBe(true);
    });
  });
}
