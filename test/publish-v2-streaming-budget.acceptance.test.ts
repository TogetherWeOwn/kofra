import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { resolveFileInputs, type Limits } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, ORIGIN } from "./helpers";

// Review-round regression: the aggregate URL budget (oneShotMaxBytes) must be
// enforced while streaming, not after a whole body has been buffered. With
// maxFileBytes=100 a 64-byte body is a legal single file, but an 8-byte
// aggregate budget must stop consumption as soon as the budget trips —
// the reader is cancelled and at most one in-flight chunk beyond the budget
// is ever delivered by the source.
const CHUNK = 4;
const LIMITS: Limits = { maxFileBytes: 100, maxFiles: 2500, maxSiteBytes: 10_000, oneShotMaxBytes: 8 };

interface Probe {
  delivered: number;
  cancelled: boolean;
}

/** Pull-based body: a chunk is only "delivered" when the reader asks for it. */
function probeBody(totalBytes: number, probe: Probe, signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  let sent = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    probe.cancelled = true;
  };
  signal?.addEventListener("abort", () => {
    stop();
    try { controller?.error(new Error("fetch aborted")); } catch { /* already closed */ }
  }, { once: true });
  return new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    pull(c) {
      if (stopped) return;
      if (sent >= totalBytes) {
        c.close();
        return;
      }
      const n = Math.min(CHUNK, totalBytes - sent);
      sent += n;
      probe.delivered += n;
      c.enqueue(new Uint8Array(n).fill(65));
    },
    cancel() { stop(); },
  });
}

function stubFetcher(bodies: Map<string, { bytes: number; probe: Probe }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const stub = bodies.get(request.url);
    if (!stub) return new Response("unexpected external URL", { status: 400 });
    // No Content-Length: the budget can only be enforced by streaming.
    return new Response(probeBody(stub.bytes, stub.probe, request.signal), {
      headers: { "Content-Type": "application/octet-stream" },
    });
  }) as typeof fetch;
}

async function resolveWith(fetcher: typeof fetch, files: unknown) {
  const dw = await freshInstance();
  const ctx = createExecutionContext();
  const dc = dw.dropway.context(env as unknown as ServerBindings, ctx, new URL(ORIGIN));
  try {
    const principal = await dc.adapters.identity.resolve(
      new Request(`${ORIGIN}/api/v1/me`, { headers: { Authorization: `Bearer ${dw.ownerKey}` } }),
      dc,
    );
    return await resolveFileInputs(dc, principal, files, { lim: LIMITS, scope: null, site: null, fetcher });
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

describe("URL source aggregate budget streaming", () => {
  it("cancels a single URL body as soon as the aggregate budget trips", async () => {
    const probe: Probe = { delivered: 0, cancelled: false };
    const fetcher = stubFetcher(new Map([["https://93.184.216.34/big", { bytes: 64, probe }]]));
    await expect(resolveWith(fetcher, [{ path: "big.bin", url: "https://93.184.216.34/big" }]))
      .rejects.toMatchObject({ code: expect.stringMatching(/too_large/) });
    expect(probe.cancelled, "the over-budget body reader must be cancelled").toBe(true);
    expect(probe.delivered, "consumption must stop at the budget plus one chunk").toBeLessThanOrEqual(LIMITS.oneShotMaxBytes + CHUNK);
    expect(probe.delivered).toBeLessThan(64);
  });

  it("cancels the sibling URL body when the shared budget trips", async () => {
    const small: Probe = { delivered: 0, cancelled: false };
    const sibling: Probe = { delivered: 0, cancelled: false };
    const fetcher = stubFetcher(new Map([
      ["https://93.184.216.34/small", { bytes: 8, probe: small }],
      ["https://93.184.216.34/sibling", { bytes: 64, probe: sibling }],
    ]));
    await expect(resolveWith(fetcher, [
      { path: "small.bin", url: "https://93.184.216.34/small" },
      { path: "sibling.bin", url: "https://93.184.216.34/sibling" },
    ])).rejects.toMatchObject({ code: expect.stringMatching(/too_large/) });
    expect(sibling.cancelled || small.cancelled, "an in-flight body must be cancelled when the budget trips").toBe(true);
    expect(sibling.delivered, "the sibling body must not be buffered in full").toBeLessThan(64);
    // Shared budget plus at most one in-flight chunk per concurrent stream
    // (each stream may also hold one pre-fetched chunk in its queue).
    expect(small.delivered + sibling.delivered).toBeLessThanOrEqual(LIMITS.oneShotMaxBytes + 4 * CHUNK);
  });
});
