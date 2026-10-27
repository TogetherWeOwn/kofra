/** Real Worker characterization of the publisher acceptance driver's protocol deadline. */
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TargetWorld, alternate, chooseFiles, older, resolved,
} from "../../cli/test/encrypted/publish-target.helpers.ts";
import {
  finishPublish, holdPublishPhase,
} from "../../cli/test/encrypted/publish-target-review.helpers.ts";
import type { Fixture } from "../../cli/test/encrypted/publish-target.helpers.ts";

const world = new TargetWorld();
beforeEach(() => world.start(), 120_000);
afterEach(async () => {
  try { await world.closeFixtures(); } finally { await world.stop(); }
}, 30_000);

function phase(request: any) {
  const path = new URL(request.url()).pathname;
  if (request.method() === "POST" && path.endsWith("/deploys")) return "manifest";
  if (request.method() === "PUT") return "upload";
  if (request.method() === "POST" && path.endsWith("/finalize")) return "finalize";
}

function observeProtocol(f: Fixture) {
  const started = performance.now();
  const timings: { event: string; phase: string; path: string; ms: number; status?: number }[] = [];
  f.page.on("request", (request: any) => {
    const name = phase(request);
    if (name) timings.push({ event: "request", phase: name, path: new URL(request.url()).pathname,
      ms: Math.round(performance.now() - started) });
  });
  f.page.on("response", (response: any) => {
    const name = phase(response.request());
    if (name) timings.push({ event: "response", phase: name, path: new URL(response.url()).pathname,
      ms: Math.round(performance.now() - started), status: response.status() });
  });
  return { started, timings };
}

async function prepared() {
  const f = await world.open({ target: older });
  await resolved(f, older);
  await chooseFiles(f);
  return f;
}

describe("Publisher acceptance protocol deadline", () => {
  // Break: treating the full hashing/manifest/upload/finalize sequence as a
  // 2.5-second locator action rejects an otherwise successful real publish.
  it("accepts a successful finalize after cumulative manifest and upload latency", async () => {
    const f = await prepared();
    await f.page.route("**/api/**", async (route: any) => {
      const name = phase(route.request());
      if (!name) return route.fallback();
      await delay(name === "finalize" ? 300 : 1500);
      return route.fallback();
    });
    const trace = observeProtocol(f);
    const lateFinalize = f.page.waitForResponse((r: any) => phase(r.request()) === "finalize", { timeout: 15_000 });
    // Handle rejection immediately, but keep observing: a missing request and a
    // late HTTP 200 must not be conflated when this characterization is RED.
    const outcome = await finishPublish(f, world.origin, older).then(() => null, error => error as Error);
    const settledAt = Math.round(performance.now() - trace.started);
    const response = await lateFinalize;
    await response.finished();
    const raw = await fetch(`${world.origin}/s/${older}/index.html?raw=1`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("<h1>Disposable update destination</h1>\n");
    console.info(JSON.stringify({ case: "delayed-success", settledAt, error: outcome?.message ?? null, timings: trace.timings }));
    expect(response.status()).toBe(200);
    expect(trace.timings.find(t => t.event === "response" && t.phase === "finalize")!.ms).toBeGreaterThan(2500);
    if (outcome) throw outcome;
  });

  // Break: an infinite deadline hangs when no finalize request can be produced.
  it("rejects a missing finalize within a finite bound", async () => {
    const f = await prepared();
    const gate = await holdPublishPhase(f, "manifest", false);
    const trace = observeProtocol(f);
    const error = await finishPublish(f, world.origin, older).then(() => null, error => error as Error);
    const elapsed = Math.round(performance.now() - trace.started);
    expect(error?.name).toBe("TimeoutError");
    expect(elapsed).toBeLessThan(20_000);
    expect(gate.entered).toBe(true);
    expect(trace.timings.some(t => t.phase === "finalize")).toBe(false);
    const finalized = f.page.waitForResponse((r: any) => phase(r.request()) === "finalize", { timeout: 15_000 });
    gate.resolve();
    expect((await finalized).status()).toBe(200);
    console.info(JSON.stringify({ case: "missing-finalize", elapsed, error: error?.message, timings: trace.timings }));
  });

  // Break: matching any /finalize lets a successful write to the wrong slug
  // satisfy the intended destination's positive acceptance assertion.
  it("rejects a successful finalize for a different slug within a finite bound", async () => {
    const f = await prepared();
    const trace = observeProtocol(f);
    const error = await finishPublish(f, world.origin, alternate).then(() => null, error => error as Error);
    const elapsed = Math.round(performance.now() - trace.started);
    expect(error?.name).toBe("TimeoutError");
    expect(elapsed).toBeLessThan(20_000);
    const response = trace.timings.find(t => t.event === "response" && t.phase === "finalize");
    expect(response?.status).toBe(200);
    expect(response?.path).toMatch(new RegExp(`^/api/v1/sites/${older}/deploys/[^/]+/finalize$`));
    console.info(JSON.stringify({ case: "wrong-slug-finalize", elapsed, error: error?.message, timings: trace.timings }));
  });
});
