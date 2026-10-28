import { describe, expect, it } from "vitest";
import { DropwayClient } from "../src/index.ts";

describe("authenticated HTTP transport", () => {
  it.each(["http://remote.test", "http://localhost.evil.test", "http://127.evil.test", "http://192.0.2.1"])(
    "refuses credentials over non-loopback HTTP at %s before fetch", async (api) => {
      let calls = 0;
      const client = new DropwayClient({ api, token: "dw_secret", fetch: async () => { calls++; return new Response("{}"); } });
      await expect(client.get("/sites")).rejects.toMatchObject({ code: "invalid_api_url", retryable: false });
      expect(calls).toBe(0);
    },
  );

  it.each(["http://localhost:8787", "http://127.0.0.1:8787", "http://127.2.3.4:8787", "http://[::1]:8787", "https://remote.test"])(
    "keeps authenticated development and HTTPS requests working at %s", async (api) => {
      const requests: Request[] = [];
      const client = new DropwayClient({ api, token: "dw_secret", fetch: async (request) => { requests.push(request); return new Response("{}"); } });
      await client.get("/sites");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers.get("Authorization")).toBe("Bearer dw_secret");
    },
  );

  it("checks absolute raw-byte URLs and per-call tokens, not just the configured origin", async () => {
    let calls = 0;
    const client = new DropwayClient({ api: "https://remote.test", token: null, fetch: async () => { calls++; return new Response("{}"); } });
    await expect(client.requestBytes("GET", "http://remote.test/file", { token: "dw_override" }))
      .rejects.toMatchObject({ code: "invalid_api_url" });
    await expect(client.get("http://remote.test/sites", { headers: { authorization: "Bearer dw_header" } }))
      .rejects.toMatchObject({ code: "invalid_api_url" });
    expect(calls).toBe(0);
  });

  it("does not block anonymous HTTP requests when no credentials will be sent", async () => {
    const requests: Request[] = [];
    const client = new DropwayClient({ api: "http://remote.test", token: "dw_unused", fetch: async (request) => { requests.push(request); return new Response("{}"); } });
    await client.get("/sites", { token: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.has("Authorization")).toBe(false);
  });
});
