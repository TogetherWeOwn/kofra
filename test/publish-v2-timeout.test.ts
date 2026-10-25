import { afterEach, expect, it, vi } from "vitest";
import { freshInstance } from "./helpers";
import { connectMcp } from "./mcp-helpers";

// Separate isolate: this deliberately advances real time by 30 seconds, unlike
// the short contract cases, and must not leave a long-lived fixture cache for them.
afterEach(() => { vi.restoreAllMocks(); });

it("R-04 aborts a stalled URL fetch after 30 seconds", async () => {
  const dw = await freshInstance();
  const mcp = await connectMcp(dw, dw.ownerKey);
  let fallback: ReturnType<typeof setTimeout> | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? String(input);
    if (url !== "https://93.184.216.34/stalled") throw new Error("unexpected external URL");
    const signal = request?.signal ?? init?.signal;
    return new Promise<Response>((resolve, reject) => {
      // A bounded successful fallback makes a missing timeout fail, not hang.
      fallback = setTimeout(() => resolve(new Response("too late")), 40_000);
      const abort = () => {
        if (fallback !== undefined) clearTimeout(fallback);
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  });
  const started = Date.now();
  try {
    const result = await mcp.call("publish_site", { files: [{ path: "a.txt", url: "https://93.184.216.34/stalled" }] });
    expect(result.isError).toBe(true);
    expect(result.data.error.code).toBe("fetch_failed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(29_000);
    expect(Date.now() - started).toBeLessThan(40_000);
  } finally {
    if (fallback !== undefined) clearTimeout(fallback);
    await mcp.client.close();
  }
}, 50_000);
