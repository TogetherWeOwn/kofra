import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOperation } from "@kofra/server";
import { freshInstance } from "./helpers";

function discoveryOperation(id: string, path: string) {
  return defineOperation({
    id,
    path,
    method: "GET",
    toolset: "core",
    scopes: ["sites:read"],
    summary: "Read the instance catalog",
    description: "Return a catalog marker from an instance-specific operation.",
    input: z.object({}),
    output: z.object({ catalog: z.string() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async handler() { return { catalog: "instance" }; },
  });
}

// Dropping the instance registry from the embedded brief makes it disagree with
// the full endpoint reference, even though the registered REST route still works.
describe("/llms-full.txt embedded brief registry", () => {
  it("advertises a custom operation in both the brief and full endpoint reference", async () => {
    const dw = await freshInstance({}, {
      operations: [discoveryOperation("read_catalog", "/api/v1/catalog")],
    });
    const route = await dw.json("/api/v1/catalog", { key: dw.ownerKey });
    expect(route.status).toBe(200);
    expect(route.body).toEqual({ catalog: "instance" });

    const response = await dw.call("/llms-full.txt");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("### GET /api/v1/catalog\n");
    expect.soft(text).toContain("- `GET /api/v1/catalog` (read_catalog)");
  });

  it("advertises a replacement core path instead of the old path in the brief", async () => {
    const dw = await freshInstance({}, {
      operations: [discoveryOperation("list_sites", "/api/v1/catalog/sites")],
    });
    const route = await dw.json("/api/v1/catalog/sites", { key: dw.ownerKey });
    expect(route.status).toBe(200);
    expect(route.body).toEqual({ catalog: "instance" });

    const response = await dw.call("/llms-full.txt");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("### GET /api/v1/catalog/sites\n");
    expect.soft(text).toContain("- `GET /api/v1/catalog/sites` (list_sites)");
    expect.soft(text).not.toContain("- `GET /api/v1/sites` (list_sites)");
  });
});
