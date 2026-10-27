#!/usr/bin/env node
/**
 * Freshness measurement (R-14): publish a change to a site, then poll the live URL until the new
 * bytes are served, and report how long that took. Run against a deployment you own; each sample
 * overwrites one file on the chosen site.
 *
 *   KOFRA_API_KEY=... node scripts/measure-freshness.mjs --api https://example.workers.dev --site freshness
 *
 * Flags: --api <origin> --site <slug> [--samples 10] [--interval-ms 250] [--timeout-ms 90000]
 *        [--file measure.txt] [--json]
 * The key is read from KOFRA_API_KEY (the legacy name works too), never from arguments, and is never printed.
 * Exits nonzero when any sample's change is not visible within --timeout-ms.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const FILE_DEFAULT = "measure.txt";

class MeasureError extends Error {}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function positiveInt(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new MeasureError(`--${name} must be a positive integer.`);
  return n;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function publish(api, key, site, file, content) {
  const form = new FormData();
  form.append("slug", site);
  form.append(file, new File([content], file, { type: "text/plain" }));
  const res = await fetch(new URL("/api/v1/publish", api), { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new MeasureError(`publish failed with HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body.url !== "string") throw new MeasureError("publish response has no url");
  return body.url;
}

async function waitForBytes(url, expected, intervalMs, timeoutMs) {
  const start = performance.now();
  for (let polls = 1; ; polls++) {
    const res = await fetch(url, { cache: "no-store", headers: { "Cache-Control": "no-cache" } }).catch(() => null);
    if (res?.ok && (await res.text()) === expected) return { ms: performance.now() - start, polls };
    if (performance.now() - start >= timeoutMs) throw new MeasureError(`the change was not visible at ${url} within ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      api: { type: "string" }, site: { type: "string" }, file: { type: "string", default: FILE_DEFAULT },
      samples: { type: "string" }, "interval-ms": { type: "string" }, "timeout-ms": { type: "string" }, json: { type: "boolean", default: false },
    },
    strict: true,
  });
  const key = process.env.KOFRA_API_KEY || process.env.DROPWAY_API_KEY; // rebrand:keep
  if (!values.api || !values.site) throw new MeasureError("Usage: KOFRA_API_KEY=... measure-freshness.mjs --api <origin> --site <slug> [--samples N]");
  if (!key) throw new MeasureError("Set KOFRA_API_KEY.");
  const api = new URL(values.api);
  if (!["http:", "https:"].includes(api.protocol)) throw new MeasureError("--api must be an HTTP(S) origin.");
  const samples = positiveInt(values.samples, "samples", 10);
  const intervalMs = positiveInt(values["interval-ms"], "interval-ms", 250);
  const timeoutMs = positiveInt(values["timeout-ms"], "timeout-ms", 90_000);

  const runs = [];
  for (let i = 0; i < samples; i++) {
    const content = `freshness sample ${i + 1} ${randomUUID()}\n`;
    const url = await publish(api, key, values.site, values.file, content);
    runs.push(await waitForBytes(new URL(values.file, url).href, content, intervalMs, timeoutMs));
  }
  const sorted = runs.map((r) => r.ms).sort((a, b) => a - b);
  const result = {
    api: api.origin, site: values.site, samples,
    p50Ms: Math.round(percentile(sorted, 50)), p95Ms: Math.round(percentile(sorted, 95)),
    minMs: Math.round(sorted[0]), maxMs: Math.round(sorted[sorted.length - 1]),
    samplesMs: runs.map((r) => Math.round(r.ms)),
  };
  if (values.json) console.log(JSON.stringify(result));
  else console.log(`${samples} samples on ${result.api}/${result.site}: p50 ${result.p50Ms} ms, p95 ${result.p95Ms} ms (min ${result.minMs}, max ${result.maxMs})`);
}

main().catch((error) => {
  console.error(error instanceof MeasureError || error?.code?.startsWith?.("ERR_PARSE_ARGS") ? error.message : "measure-freshness failed unexpectedly.");
  process.exit(1);
});
