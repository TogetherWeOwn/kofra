import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/args.ts";

const specs = { token: { kind: "string" as const }, "dry-run": { kind: "boolean" as const }, json: { kind: "boolean" as const } };

describe("claim argv", () => {
  it("reads the site positional and --token in both spellings", () => {
    expect(parseArgs(["site-a", "--token", "dwc_x"], specs)).toEqual({ positionals: ["site-a"], flags: { token: "dwc_x" } });
    expect(parseArgs(["site-a", "--token=dwc_x", "--dry-run"], specs).flags).toEqual({ token: "dwc_x", "dry-run": true });
  });

  it("refuses a valueless --token and unknown flags", () => {
    expect(() => parseArgs(["site-a", "--token"], specs)).toThrow(/needs a value/);
    expect(() => parseArgs(["site-a", "--token", "--json"], specs)).toThrow(UsageError);
    expect(() => parseArgs(["site-a", "--bogus"], specs)).toThrow(/Unknown option/);
  });
});
