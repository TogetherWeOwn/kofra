import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createKofra, defineOperation, type OperationDefinition } from "@kofra/server";

// Both public entry points must reject unusable byte budgets. In particular,
// registration cannot trust that an embedding app called defineOperation first.
function validOperation(): OperationDefinition {
  return defineOperation({
    id: "json_budget_validation", toolset: "core", method: "POST",
    path: "/api/v1/json-budget-validation", scopes: [],
    summary: "Validate JSON byte budgets", description: "A minimal valid operation for registration tests.",
    input: z.object({}), output: z.object({ ok: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async handler() { return { ok: true }; },
  });
}

const invalid = [
  { label: "zero", value: 0 },
  { label: "negative", value: -1 },
  { label: "fractional", value: 1.5 },
  { label: "NaN", value: NaN },
  { label: "positive infinity", value: Infinity },
  { label: "negative infinity", value: -Infinity },
  { label: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
];

// Run the guard-deletion proof with:
// npx vitest run -c test/operation-json-budget.mutants.config.ts
// Expected: all 14 rejection tests fail; the four valid controls still pass.
describe("JSON byte budget validation", () => {
  it.each(invalid)("defineOperation rejects $label", ({ value }) => {
    const definition = { ...validOperation(), jsonBodyMaxBytes: value };
    expect(() => defineOperation(definition)).toThrow(/JSON.*byte.*limit/i);
  });

  it.each(invalid)("createKofra registration rejects $label without defineOperation", ({ value }) => {
    // Deliberately override AFTER valid definition: this bypasses the definition
    // guard so only factory registration validation can reject the bad value.
    const unchecked = { ...validOperation(), jsonBodyMaxBytes: value };
    expect(() => createKofra({ operations: [unchecked] })).toThrow(/JSON.*byte.*limit/i);
  });

  it.each([
    { label: "one byte", budget: { jsonBodyMaxBytes: 1 } },
    { label: "omitted default", budget: {} },
  ])("defineOperation accepts $label", ({ budget }) => {
    expect(() => defineOperation({ ...validOperation(), ...budget })).not.toThrow();
  });

  it.each([
    { label: "one byte", budget: { jsonBodyMaxBytes: 1 } },
    { label: "omitted default", budget: {} },
  ])("createKofra registration accepts $label", ({ budget }) => {
    expect(() => createKofra({ operations: [{ ...validOperation(), ...budget }] })).not.toThrow();
  });
});
