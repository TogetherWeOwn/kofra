import { ApiError, defaultPolicy } from "@dropway/core";
import { createDropway } from "@dropway/server";

// Disposable local-only embedding policy. Refuse at the real extension boundary;
// do not reimplement duplicate, authorization, idempotency or quota algorithms.
export default createDropway({
  adapters: {
    policy: {
      ...defaultPolicy,
      beforeCreateSite(_principal, input) {
        if (input.slug === "policy-refused-copy") {
          throw new ApiError(403, "fixture_duplicate_refused", "This destination is refused.",
            "Choose a destination allowed by the instance policy.", { destination: input.slug, rule: "fixture-policy" });
        }
        if (input.slug === "quota-refused-copy") {
          throw new ApiError(413, "limit_reached", "The instance's destination limit is reached.",
            "Free capacity before duplicating.", { resource: "sites", limit: 0 });
        }
      },
    },
  },
});
