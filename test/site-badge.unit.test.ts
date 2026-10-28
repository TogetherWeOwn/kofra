import { describe, expect, it } from "vitest";
import type { LiveSite } from "@dropway/core";
import { badgeAge, badgeFor } from "../packages/server/src/site-badge";

const NOW = 1_800_000_000_000;
const live = (over: Partial<LiveSite> = {}): LiveSite => ({
  v: 4, siteId: "s", slug: "demo", tenantId: "t", versionId: "ver", versionNumber: 7, versionAt: NOW - 3 * 3_600_000,
  spa: false, renderMarkdown: true, crossOriginIsolation: false, passwordHash: null, expiresAt: null, files: {}, ...over,
});

describe("badge rendering", () => {
  it("buckets age into minutes, hours and days, never exact times", () => {
    expect(badgeAge(-5_000)).toBe("just now");
    expect(badgeAge(59_999)).toBe("just now");
    expect(badgeAge(60_000)).toBe("1 min ago");
    expect(badgeAge(59 * 60_000 + 59_000)).toBe("59 min ago");
    expect(badgeAge(3_600_000)).toBe("1 h ago");
    expect(badgeAge(23 * 3_600_000 + 59 * 60_000)).toBe("23 h ago");
    expect(badgeAge(24 * 3_600_000)).toBe("1 d ago");
    expect(badgeAge(400 * 86_400_000)).toBe("400 d ago");
  });

  it("names the version for a public live site", () => {
    const svg = badgeFor(live(), NOW);
    expect(svg).toContain("v7 · 3 h ago");
  });

  it.each([
    ["missing", null],
    ["passworded", live({ passwordHash: "x" })],
    ["expired", live({ expiresAt: NOW - 1 })],
    ["nothing live", live({ versionId: null, versionNumber: null, versionAt: null })],
    ["stale manifest without version data", live({ versionNumber: undefined, versionAt: undefined })],
  ])("renders the generic badge for %s", (_name, site) => {
    expect(badgeFor(site, NOW)).toBe(badgeFor(null, NOW));
  });
});
