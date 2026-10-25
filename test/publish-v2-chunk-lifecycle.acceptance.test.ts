import { describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { runCleanup, sha256Hex } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { freshInstance, jsonBody, type Instance } from "./helpers";

const D1_LIMIT = 2_000_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: unknown) => encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).length;

interface StoredKey {
  key_hash: string;
  owner_token: string;
  state: string;
  expires_at: number;
}
interface Chunk {
  key_hash: string;
  owner_token: string;
  chunk_index: number;
  result_json: string;
}

async function chunks(keyHash: string) {
  return (await env.DB.prepare("SELECT * FROM idempotency_result_chunks WHERE key_hash = ? ORDER BY chunk_index")
    .bind(keyHash).all<Chunk>()).results;
}

async function storedKey() {
  const row = await env.DB.prepare("SELECT key_hash, owner_token, state, expires_at FROM idempotency_keys").first<StoredKey>();
  expect(row).not.toBeNull();
  return row!;
}

function keyedPublish(dw: Instance, body: Record<string, unknown>, key: string) {
  const init = jsonBody(body);
  return dw.json("/api/v1/publish", {
    ...init, key: dw.ownerKey, headers: { ...init.headers, "Idempotency-Key": key },
  });
}

async function oversizedPublish() {
  const dw = await freshInstance();
  const files = [];
  for (let i = 0; i < 800; i++) {
    // Each legal path is < 1024 UTF-8 bytes. Dense astral characters exercise
    // UTF-16 chunk cuts as well as the UTF-8 byte limit of stored D1 rows.
    files.push({
      path: `missing-${i}/${"😀".repeat(200)}-${"é".repeat(20)}.txt`,
      sha256: await sha256Hex(encoder.encode(`chunk-lifecycle-${i}`)), size: 1,
    });
  }
  const body = { site: "chunk-lifecycle", files };
  const publish = () => keyedPublish(dw, body, "chunk-lifecycle");
  const first = await publish();
  expect(first.status).toBe(202);
  expect(first.body.status).toBe("awaiting_upload");
  expect(first.body.upload.items).toHaveLength(800);
  expect(first.body.upload.items[0].path).toBe(files[0]!.path);
  expect(bytes(first.body), "fixture must require oversized replay storage").toBeGreaterThan(D1_LIMIT);
  const parent = await storedKey();
  expect(parent.state).toBe("done");
  const payload = await chunks(parent.key_hash);
  expect(payload.length).toBeGreaterThan(1);
  return { dw, first, publish, parent, payload };
}

describe("chunked keyed-publish replay lifecycle", () => {
  it("bounds every stored value and row and replays an oversized Unicode result exactly", async () => {
    const { first, publish, parent, payload } = await oversizedPublish();
    const parents = (await env.DB.prepare("SELECT * FROM idempotency_keys").all<Record<string, unknown>>()).results;
    for (const row of [...parents, ...payload]) {
      // JSON row encoding is a conservative upper bound here: it includes key
      // names and escapes in addition to all stored column values.
      expect(bytes(row), "each replay row must fit D1's row limit").toBeLessThanOrEqual(D1_LIMIT);
      for (const value of Object.values(row)) {
        if (typeof value === "string") expect(bytes(value)).toBeLessThanOrEqual(D1_LIMIT);
      }
    }
    expect(payload.map((row) => row.chunk_index)).toEqual(payload.map((_, i) => i));
    for (const row of payload) {
      expect(row.owner_token).toBe(parent.owner_token);
      // Encoding a lone surrogate replaces it with U+FFFD; splitting a pair
      // across rows must fail here even when joining JS strings would hide it.
      expect(decoder.decode(encoder.encode(row.result_json))).toBe(row.result_json);
    }
    expect(payload.some((row) => /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(row.result_json))).toBe(true);
    const replay = await publish();
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual({ ...first.body, replayed: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sites").first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>())?.n).toBe(1);
  });

  it("cascades expired-parent cleanup to all persisted payload chunks", async () => {
    const { dw, parent } = await oversizedPublish();
    const now = Date.now();
    await env.DB.prepare("UPDATE idempotency_keys SET expires_at = ? WHERE key_hash = ?")
      .bind(now - 1, parent.key_hash).run();
    const ctx = createExecutionContext();
    try {
      await runCleanup(dw.dropway.context(env as unknown as ServerBindings, ctx), now);
    } finally {
      await waitOnExecutionContext(ctx);
    }
    expect(await env.DB.prepare("SELECT key_hash FROM idempotency_keys WHERE key_hash = ?").bind(parent.key_hash).first()).toBeNull();
    expect(await chunks(parent.key_hash)).toEqual([]);
    // Replay expiry must not delete the published site/version itself.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>())?.n).toBe(1);
  });

  it("reclaims an expired key without retaining or replaying the previous owner's chunks", async () => {
    const { dw, parent } = await oversizedPublish();
    await env.DB.prepare("UPDATE idempotency_keys SET expires_at = ? WHERE key_hash = ?")
      .bind(Date.now() - 1, parent.key_hash).run();
    const replacementBody = { site: "chunk-successor", files: [{ path: "fresh.txt", content: "successor 😀 bytes" }] };
    const successor = await keyedPublish(dw, replacementBody, "chunk-lifecycle");
    expect(successor.status).toBe(201);
    expect(successor.body.site.slug).toBe("chunk-successor");
    const replacement = await storedKey();
    expect(replacement.key_hash).toBe(parent.key_hash);
    expect(replacement.owner_token).not.toBe(parent.owner_token);
    expect(replacement.expires_at).toBeGreaterThan(Date.now());
    expect(await chunks(parent.key_hash)).toEqual([]);
    const replay = await keyedPublish(dw, replacementBody, "chunk-lifecycle");
    expect(replay.status).toBe(successor.status);
    expect(replay.body).toEqual({ ...successor.body, replayed: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sites").first<{ n: number }>())?.n).toBe(2);
  });

  it("preserves mutation success but fails replay closed after a persistence write fails", async () => {
    const dw = await freshInstance();
    // Local real-D1 fault injection: only replay completion fails. Site/blob/
    // version writes and the initial pending claim still execute normally.
    await env.DB.prepare(`CREATE TRIGGER test_reject_replay_completion
      BEFORE UPDATE OF state ON idempotency_keys WHEN NEW.state = 'done'
      BEGIN SELECT RAISE(ABORT, 'test replay persistence failure'); END;`).run();
    try {
      const body = { site: "persist-failure", files: [{ path: "index.txt", content: "committed once 😀" }] };
      const publish = () => keyedPublish(dw, body, "persist-failure");
      const first = await publish();
      expect(first.status).toBe(201);
      expect(first.body.site.slug).toBe("persist-failure");
      const parent = await storedKey();
      expect(parent.state).toBe("pending");
      const live = await dw.call("/api/v1/sites/persist-failure/files/index.txt", { key: dw.ownerKey });
      expect(live.status).toBe(200);
      expect(await live.text()).toBe("committed once 😀");
      // Recovery of the storage dependency must not reopen an unknown outcome.
      await env.DB.exec("DROP TRIGGER test_reject_replay_completion");
      const retry = await publish();
      expect(retry.status).toBe(409);
      expect(retry.body.error.hint).toMatch(/\S/);
      expect(await storedKey()).toEqual(parent);
      expect(await chunks(parent.key_hash)).toEqual([]);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sites").first<{ n: number }>())?.n).toBe(1);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>())?.n).toBe(1);
    } finally {
      await env.DB.exec("DROP TRIGGER IF EXISTS test_reject_replay_completion");
    }
  });
});
