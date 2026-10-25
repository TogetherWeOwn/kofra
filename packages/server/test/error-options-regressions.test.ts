import { describe, expect, it } from "vitest";
import { ApiError } from "../../core/src/errors";

// These constructor paths already work. Pin option precedence, normalization
// and defaults without claiming they were failing before this test artifact.
describe("direct ApiError constructor options", () => {
  it("uses catalog defaults when metadata is omitted", () => {
    const error = new ApiError(400, "invalid_request", "Invalid input.");
    expect(error.retryable).toBe(false);
    expect(error.retryAfterSeconds).toBeNull();
    expect(error.docs).toBe("/docs/errors#invalid_request");
    expect(error.next).toEqual([]);
    expect(error.hint).toEqual(expect.any(String));
    expect(error.hint!.length).toBeGreaterThan(0);
  });

  it("uses all sixth-argument overrides instead of status, catalog and details defaults", () => {
    const error = new ApiError(503, "temporarily_unavailable", "Unavailable.", "Read before retrying.", {
      retryable: true, retryAfterSeconds: 91, fixture: "details preserved",
    }, {
      retryable: false, retryAfterSeconds: 0,
      docs: "https://help.example/recovery#custom",
      next: [{ tool: "get_site", args: { site: "option-probe" }, why: "Read the current site." }],
    });
    expect(error.retryable).toBe(false);
    expect(error.retryAfterSeconds).toBe(0);
    expect(error.docs).toBe("https://help.example/recovery#custom");
    expect(error.next).toEqual([{ tool: "get_site", args: { site: "option-probe" }, why: "Read the current site." }]);
    expect(error.toJSON("req-options", "https://app.example")).toEqual({
      requestId: "req-options",
      error: {
        code: "temporarily_unavailable", message: "Unavailable.", hint: "Read before retrying.",
        retryable: false, retryAfterSeconds: 0, docs: "https://help.example/recovery#custom",
        next: [{ tool: "get_site", args: { site: "option-probe" }, why: "Read the current site." }],
        details: { retryable: true, retryAfterSeconds: 91, fixture: "details preserved" },
      },
    });
  });

  it("can opt a client error into retrying and resolve custom relative documentation", () => {
    const error = new ApiError(400, "invalid_request", "Retryable fixture.", undefined, undefined, {
      retryable: true, retryAfterSeconds: 37, docs: "/custom-help#retry",
    });
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(37);
    expect(error.toJSON("req-relative", "https://app.example").error.docs).toBe("https://app.example/custom-help#retry");
  });

  it("retains supported legacy details metadata when sixth-argument overrides are absent", () => {
    const error = new ApiError(503, "temporarily_unavailable", "Unavailable.", undefined, {
      retryable: false, retryAfterSeconds: 37,
    });
    expect(error.retryable).toBe(false);
    expect(error.retryAfterSeconds).toBe(37);
    expect(error.toJSON().error).toMatchObject({ retryable: false, retryAfterSeconds: 37 });
  });

  for (const status of [400, 429, 503]) {
    it(`defaults an omitted HTTP ${status} delay to ${status === 400 ? "null" : "exactly one second"}`, () => {
      const error = new ApiError(status, "extension_refusal", "Refused.");
      const expected = status === 400 ? null : 1;
      expect(error.retryAfterSeconds).toBe(expected);
      expect(error.toJSON().error.retryAfterSeconds).toBe(expected);
      expect(error.retryable).toBe(status !== 400);
    });

    for (const [label, supplied] of [
      ["zero", 0], ["positive integer", 37], ["maximum safe integer", Number.MAX_SAFE_INTEGER],
    ] as const) {
      it(`preserves a ${label} delay for HTTP ${status}`, () => {
        const error = new ApiError(status, "extension_refusal", "Refused.", undefined, undefined, { retryAfterSeconds: supplied });
        expect(error.retryAfterSeconds).toBe(supplied);
        expect(error.toJSON().error.retryAfterSeconds).toBe(supplied);
      });
    }

    for (const [label, supplied] of [
      ["negative", -1], ["fractional", 0.5], ["NaN", Number.NaN],
      ["infinite", Number.POSITIVE_INFINITY], ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      it(`normalizes a ${label} delay for HTTP ${status}`, () => {
        const error = new ApiError(status, "extension_refusal", "Refused.", undefined, undefined, { retryAfterSeconds: supplied });
        const expected = status === 400 ? null : 1;
        expect(error.retryAfterSeconds).toBe(expected);
        expect(error.toJSON().error.retryAfterSeconds).toBe(expected);
      });
    }
  }
});
