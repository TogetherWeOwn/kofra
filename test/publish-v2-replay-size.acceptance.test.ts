import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { sha256Hex } from "@dropway/core";
import { freshInstance, jsonBody } from "./helpers";

// Review-round regression: a legal keyed publish can produce a PublishResult
// larger than D1's 2,000,000-byte per-value limit. Replay storage must never
// persist a single value above that limit (local Miniflare accepts oversized
// values, so only reading the store directly applies the production rule),
// while same-key replay still returns the identical first result.
const D1_VALUE_LIMIT = 2_000_000;
const encoder = new TextEncoder();

const byteLength = (value: unknown) => encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).length;

async function oversizedManifest(count: number) {
  const files = [];
  for (let i = 0; i < count; i++) {
    // Legal long paths (< 1024 chars), distinct missing digests, size 1.
    // The awaiting_upload result repeats each path in upload metadata plus
    // its curl line, multiplying the manifest size several times over.
    const path = `missing-${String(i).padStart(4, "0")}/${"segment-".repeat(110)}file-${i}.txt`;
    files.push({ path, sha256: await sha256Hex(encoder.encode(`replay-size-missing-${i}`)), size: 1 });
  }
  return files;
}

describe("keyed publish replay storage size", () => {
  it("persists no idempotency value over the D1 limit and replays the identical oversized result", async () => {
    const dw = await freshInstance();
    const body = { site: "replay-size", files: await oversizedManifest(800) };
    const init = jsonBody(body);
    const publish = () => dw.json("/api/v1/publish", {
      ...init, key: dw.ownerKey, headers: { ...init.headers, "Idempotency-Key": "replay-size" },
    });

    const first = await publish();
    expect(first.status).toBe(202);
    expect(first.body.status).toBe("awaiting_upload");
    expect(first.body.upload.items).toHaveLength(800);
    // Fixture sanity: the result itself is the oversized payload under test.
    // Without this, a too-small fixture would pass the storage check vacuously.
    expect(byteLength(first.body), "fixture result must exceed the D1 per-value limit").toBeGreaterThan(D1_VALUE_LIMIT);

    const { results } = await env.DB.prepare("SELECT * FROM idempotency_keys").all<Record<string, unknown>>();
    expect(results.length).toBeGreaterThan(0);
    for (const row of results) {
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== "string") continue;
        expect(byteLength(value), `idempotency_keys.${column} must fit D1's per-value limit`).toBeLessThanOrEqual(D1_VALUE_LIMIT);
      }
    }

    const replay = await publish();
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual({ ...first.body, replayed: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sites").first<{ n: number }>())?.n).toBe(1);
  });
});
