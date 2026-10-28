import { expect, it } from "vitest";
import { emitInterface } from "../../../scripts/generate-client.mjs";
import { SITE_OUT } from "../../server/src/mcp/schemas.ts";

it("exposes the serialized stable site id to consumers of the shared output schema", () => {
  const result = emitInterface("SiteResult", SITE_OUT);
  expect(result).toContain("id?: string;");
});

it("keeps pre-upgrade idempotency receipts valid: older stored site results have no id", () => {
  // Receipts stored before serializeSite emitted id replay unchanged, so the
  // replayed shape must still satisfy the output schema instead of failing
  // validation (or, worse, being re-executed).
  expect(SITE_OUT.required).toEqual(["slug", "url"]);
  expect(SITE_OUT.properties).toMatchObject({ id: { type: "string" } });
});
