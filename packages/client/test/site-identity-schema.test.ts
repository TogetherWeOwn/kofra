import { expect, it } from "vitest";
import { emitInterface } from "../../../scripts/generate-client.mjs";
import { SITE_OUT } from "../../server/src/mcp/schemas.ts";

it("exposes the serialized stable site id to consumers of the shared output schema", () => {
  const result = emitInterface("SiteResult", SITE_OUT);
  expect(result).toContain("id: string;");
});
