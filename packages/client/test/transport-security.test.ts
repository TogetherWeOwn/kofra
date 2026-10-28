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

  it.each(["http://localhost.:8787", "http://[::ffff:127.0.0.1]:8787", "http://[::ffff:127.2.3.4]:8787"])(
    "recognises the valid loopback spelling %s", async (api) => {
      const requests: Request[] = [];
      const client = new DropwayClient({ api, token: "dw_secret", fetch: async (request) => { requests.push(request); return new Response("{}"); } });
      await client.get("/sites");
      expect(requests).toHaveLength(1);
    },
  );

  it.each(["http://[::ffff:192.0.2.1]", "http://localhost..", "http://sub.localhost.evil.test"])(
    "still refuses the loopback lookalike %s", async (api) => {
      let calls = 0;
      const client = new DropwayClient({ api, token: "dw_secret", fetch: async () => { calls++; return new Response("{}"); } });
      await expect(client.get("/sites")).rejects.toMatchObject({ code: "invalid_api_url" });
      expect(calls).toBe(0);
    },
  );

  it.each([{ Cookie: "session=synthetic" }, { "X-Contract-Session": "yes" }] as Array<Record<string, string>>)(
    "treats an explicit credential header %j as authenticated even with no token", async (headers) => {
      let calls = 0;
      const client = new DropwayClient({ api: "http://remote.test", token: null, fetch: async () => { calls++; return new Response("{}"); } });
      await expect(client.get("/sites", { headers })).rejects.toMatchObject({ code: "invalid_api_url" });
      expect(calls).toBe(0);
    },
  );

  it("does not treat standard non-credential headers alone as authentication", async () => {
    const requests: Request[] = [];
    const client = new DropwayClient({ api: "http://remote.test", token: null, fetch: async (request) => { requests.push(request); return new Response("{}"); } });
    await client.get("/sites", { headers: { Accept: "application/json", "Cache-Control": "no-cache" } });
    expect(requests).toHaveLength(1);
  });

  it("lets a caller explicitly declare a credential-free request with a benign custom header", async () => {
    const requests: Request[] = [];
    const client = new DropwayClient({ api: "http://remote.test", token: null, fetch: async (request) => { requests.push(request); return new Response("{}"); } });
    await client.get("/sites", { headers: { "X-Trace": "trace-1" }, authenticated: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("X-Trace")).toBe("trace-1");
  });

  it("lets a session-authenticated client declare that at construction, with no token or headers", async () => {
    let calls = 0;
    const client = new DropwayClient({ api: "http://remote.test", token: null, authenticated: true, fetch: async () => { calls++; return new Response("{}"); } });
    await expect(client.get("/sites")).rejects.toMatchObject({ code: "invalid_api_url" });
    expect(calls).toBe(0);
  });

  it("refuses to replay an authenticated write that redirects, before any second request", async () => {
    const urls: string[] = [];
    const client = new DropwayClient({
      api: "https://remote.test", token: "dw_secret",
      fetch: async (request) => {
        urls.push(request.url);
        return new Response(null, { status: 307, headers: { Location: "https://remote.test/api/v1/sites/other-site" } });
      },
    });
    await expect(client.request("PATCH", "/sites/settings-fixture", { json: { spa: false } }))
      .rejects.toMatchObject({ code: "redirect_refused", retryable: false });
    expect(urls).toEqual(["https://remote.test/api/v1/sites/settings-fixture"]);
  });

  it("refuses an authenticated GET that redirects down to HTTP, before the second request", async () => {
    let calls = 0;
    const client = new DropwayClient({
      api: "https://remote.test", token: "dw_secret",
      fetch: async () => { calls++; return new Response(null, { status: 302, headers: { Location: "http://remote.test/api/v1/sites" } }); },
    });
    await expect(client.get("/sites")).rejects.toMatchObject({ code: "invalid_api_url" });
    expect(calls).toBe(1);
  });

  it("follows a same-origin GET redirect and keeps its credentials", async () => {
    const requests: Request[] = [];
    const client = new DropwayClient({
      api: "https://remote.test", token: "dw_secret",
      fetch: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? new Response(null, { status: 302, headers: { Location: "/api/v1/sites?moved=1" } })
          : new Response("{}");
      },
    });
    await client.get("/sites");
    expect(requests.map((request) => request.url)).toEqual([
      "https://remote.test/api/v1/sites", "https://remote.test/api/v1/sites?moved=1",
    ]);
    expect(requests[1]!.headers.get("Authorization")).toBe("Bearer dw_secret");
  });

  it("follows a cross-origin GET redirect only after stripping credential headers", async () => {
    const requests: Request[] = [];
    const client = new DropwayClient({
      api: "https://remote.test", token: "dw_secret",
      fetch: async (request) => {
        requests.push(request);
        return requests.length === 1
          ? new Response(null, { status: 302, headers: { Location: "https://other.test/api/v1/sites" } })
          : new Response("{}");
      },
    });
    await client.get("/sites", { headers: { Cookie: "session=synthetic", "X-Contract-Session": "yes" } });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.headers.has("Authorization")).toBe(false);
    expect(requests[1]!.headers.has("Cookie")).toBe(false);
    expect(requests[1]!.headers.has("X-Contract-Session")).toBe(false);
    expect(requests[1]!.headers.get("Accept")).toBe("application/json");
  });

  it("stops a GET redirect loop instead of following it forever", async () => {
    let calls = 0;
    const client = new DropwayClient({
      api: "https://remote.test", token: "dw_secret",
      fetch: async () => { calls++; return new Response(null, { status: 302, headers: { Location: "/api/v1/sites" } }); },
    });
    await expect(client.get("/sites")).rejects.toMatchObject({ code: "redirect_refused" });
    expect(calls).toBeLessThanOrEqual(6);
  });
});
