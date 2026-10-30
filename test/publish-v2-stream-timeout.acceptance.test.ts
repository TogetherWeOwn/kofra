import { expect, it } from "vitest";
import { ApiError } from "@dropway/core";
import { fetchUrlSource } from "../packages/core/src/services/sources";

// Catches a timeout that is translated during fetch(), but leaks a DOMException
// once headers have arrived and the service is waiting for the body reader.
it("turns a stalled URL body read into fetch_failed and cancels the reader", async () => {
  let cancelled = false;
  let pulls = 0;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Missing timeout support must fail the assertions, not hang the suite.
      fallback = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode("too late"));
        controller.close();
      }, 1000);
    },
    pull() { pulls++; },
    cancel() {
      cancelled = true;
      if (fallback !== undefined) clearTimeout(fallback);
    },
  });
  const fetcher = (async () => new Response(body, {
    headers: { "Content-Type": "text/plain" },
  })) as typeof fetch;
  let failure: unknown;
  try {
    await fetchUrlSource("https://93.184.216.34/stalled-body", {
      maxBytes: 1024, timeoutMs: 10, fetcher,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (fallback !== undefined) clearTimeout(fallback);
  }
  expect(pulls, "the response headers arrived and body reading started").toBeGreaterThan(0);
  expect.soft(failure).toBeInstanceOf(ApiError);
  expect.soft(failure).toMatchObject({
    status: 422, code: "fetch_failed", hint: expect.stringMatching(/\S/),
  });
  expect(cancelled, "the stalled response reader must be cancelled on timeout").toBe(true);
});
