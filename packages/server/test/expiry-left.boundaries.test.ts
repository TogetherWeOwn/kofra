/** Supplemental regressions; protected acceptance fixtures/harness stay read-only. */
import { describe, expect, it } from "vitest";
import { day, hour, instant, minute, surfaces, type Surface } from "./expiry-left.fixtures.ts";
import { mount } from "./expiry-left.harness.ts";

// Literal expectations pin both directions of each rounding stage, including
// the strict millisecond sign check before rounding and the expired ago() path.
const cases = [
  { label: "one millisecond past", offset: -1, want: "Expired just now" },
  { label: "exact expiry instant", offset: 0, want: "Expires in under a minute" },
  { label: "one millisecond ahead", offset: 1, want: "Expires in under a minute" },
  { label: "44.499 s rounds down", offset: 44_499, want: "Expires in under a minute" },
  { label: "44.5 s rounds up", offset: 44_500, want: "Expires in 1 min" },
  { label: "89.499 s rounds down", offset: 89_499, want: "Expires in 1 min" },
  { label: "89.5 s rounds up", offset: 89_500, want: "Expires in 2 min" },
  { label: "61 minutes", offset: 61 * minute, want: "Expires in 1 h" },
  { label: "89 minutes", offset: 89 * minute, want: "Expires in 1 h" },
  { label: "90 minutes", offset: 90 * minute, want: "Expires in 2 h" },
  { label: "23 hours 29 minutes", offset: 23 * hour + 29 * minute, want: "Expires in 23 h" },
  { label: "23 hours 30 minutes", offset: 23 * hour + 30 * minute, want: "Expires in 1 day" },
  { label: "25 hours", offset: 25 * hour, want: "Expires in 1 day" },
  { label: "36 hours", offset: 36 * hour, want: "Expires in 2 days" },
  { label: "below rounded date cutover", offset: 29 * day + 11 * hour + 29 * minute, want: "Expires in 29 days" },
  { label: "44.499 s past rounds down", offset: -44_499, want: "Expired just now" },
  { label: "44.5 s past rounds up", offset: -44_500, want: "Expired 1 min ago" },
  { label: "89.499 s past rounds down", offset: -89_499, want: "Expired 1 min ago" },
  { label: "89.5 s past rounds up", offset: -89_500, want: "Expired 2 min ago" },
  { label: "59 minutes 29 seconds past", offset: -(59 * minute + 29_000), want: "Expired 59 min ago" },
  { label: "59 minutes 30 seconds past", offset: -(59 * minute + 30_000), want: "Expired 1 h ago" },
  { label: "61 minutes past", offset: -61 * minute, want: "Expired 1 h ago" },
  { label: "90 minutes past", offset: -90 * minute, want: "Expired 2 h ago" },
  { label: "23 hours 29 minutes past", offset: -(23 * hour + 29 * minute), want: "Expired 23 h ago" },
  { label: "23 hours 30 minutes past", offset: -(23 * hour + 30 * minute), want: "Expired 1 day ago" },
  { label: "25 hours past", offset: -25 * hour, want: "Expired 1 day ago" },
  { label: "36 hours past", offset: -36 * hour, want: "Expired 2 days ago" },
];

// Select the actual status paragraph: matching a substring of the entire site
// header would accept contradictory prefixes such as "Expired Expires ...".
function assertExpiry(view: Awaited<ReturnType<typeof mount>>, surface: Surface, iso: string, want: string) {
  const node = surface === "site"
    ? view.region().querySelectorAll("p[title]").find(el => el.getAttribute("title") === iso)
    : view.expiry();
  expect(node, "the expiry status node must exist").toBeDefined();
  expect(node?.getAttribute("title")).toBe(iso);
  expect(node?.textContent).toBe(surface === "site" ? `${want} · ${new Date(iso).toLocaleString()}` : want);
}

for (const surface of surfaces) {
  describe(`${surface}: expiry formatter boundary regressions`, () => {
    it.each(cases)("$label renders exactly ($want)", async ({ offset, want }) => {
      const iso = instant(offset);
      assertExpiry(await mount(surface, iso), surface, iso, want);
    });

    // Native date formatting is the locale oracle, independent of the formatter's
    // numeric cutover. The explicit New York/midnight oracle lives in Chromium.
    it.each([
      { label: "rounded hour/day cutover", offset: 29 * day + 11 * hour + 30 * minute },
      { label: "29.5 days", offset: 29.5 * day },
      { label: "30 days past", offset: -30 * day },
      { label: "45 days past", offset: -45 * day },
    ])("uses the local date at $label", async ({ offset }) => {
      const iso = instant(offset);
      const date = new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      assertExpiry(await mount(surface, iso), surface, iso, `${offset < 0 ? "Expired" : "Expires"} ${date}`);
    });

    it("renders the exact-zero instant as still valid on every surface", async () => {
      const iso = instant(0);
      assertExpiry(await mount(surface, iso), surface, iso, "Expires in under a minute");
    });
  });
}
