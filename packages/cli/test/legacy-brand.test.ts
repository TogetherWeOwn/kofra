// The product's former name (Dropway) keeps working in the CLI. // rebrand:keep
// rebrand:keep-file (scripts/rebrand.mjs never edits this file.)
import { describe, expect, it } from "vitest";
import { KofraClient } from "../src/client.ts";
import { withLegacyEnv } from "../src/legacy-brand.ts";
import { waitForVersion } from "../src/publish.ts";

describe("former name compatibility", () => {
  it("accepts DROPWAY_* variables; KOFRA_* wins when both are set", () => {
    const env = withLegacyEnv({ DROPWAY_API_KEY: "old", DROPWAY_API: "https://old.example", KOFRA_API: "https://new.example", KOFRA_CLIENT: "", DROPWAY_CLIENT: "agent/1" });
    expect(env.KOFRA_API_KEY).toBe("old");
    expect(env.KOFRA_API).toBe("https://new.example");
    expect(env.KOFRA_CLIENT).toBe("agent/1");
    expect(env.DROPWAY_API_KEY).toBe("old");
  });

  it("sends the client header under both names (instances from before the rename read X-Dropway-*)", async () => {
    let seen: Headers | null = null;
    const client = new KofraClient({
      api: "https://instance.example",
      token: null,
      client: "test/1",
      fetch: async (req) => {
        seen = req.headers;
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    await client.request("GET", "/me");
    expect(seen!.get("x-kofra-client")).toBe("test/1");
    expect(seen!.get("x-dropway-client")).toBe("test/1");
  });
});

describe("publish --wait against instances from before the rename", () => {
  const live = (headers: Record<string, string>) => async () => new Response("ok", { status: 200, headers });
  const wait = (versionId: string, headers: Record<string, string>) => waitForVersion("https://site.example/", versionId, { timeoutMs: 0, intervalMs: 1, fetch: live(headers) });

  it("reads the version from X-Dropway-Version when an instance sends only that", async () => {
    expect(await wait("v_1", { "X-Dropway-Version": "v_1" })).toBe(true);
  });

  it("reads the version from X-Kofra-Version", async () => {
    expect(await wait("v_1", { "X-Kofra-Version": "v_1" })).toBe(true);
  });

  it("returns false when neither header names the version; X-Kofra-Version wins when both are sent", async () => {
    expect(await wait("v_1", { "X-Dropway-Version": "v_0" })).toBe(false);
    expect(await wait("v_1", {})).toBe(false);
    expect(await wait("v_1", { "X-Kofra-Version": "v_2", "X-Dropway-Version": "v_1" })).toBe(false);
  });
});
