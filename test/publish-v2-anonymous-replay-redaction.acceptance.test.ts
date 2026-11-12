import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { sha256Hex } from "@kofra/core";
import { freshInstance, jsonBody, type Instance } from "./helpers";

// Anonymous JSON publishing is scoped to the client IP, so a caller who
// repeats an Idempotency-Key from the same network must never receive the
// first request's live credentials again — and the stored replay record must
// not keep them at rest either. The first response delivers credentials once.

let dw: Instance;
beforeEach(async () => { dw = await freshInstance({ anonymous: { enabled: true } }); });

function anonymousPublish(body: Record<string, unknown>, key: string) {
  const init = jsonBody(body);
  return dw.json("/api/v1/publish", {
    ...init, headers: { ...init.headers, "Idempotency-Key": key, "CF-Connecting-IP": "203.0.113.9" },
  });
}

async function storedPayloads(): Promise<string> {
  const keys = (await env.DB.prepare("SELECT result_json FROM idempotency_keys").all<{ result_json: string | null }>()).results;
  const chunks = (await env.DB.prepare("SELECT result_json FROM idempotency_result_chunks").all<{ result_json: string }>()).results;
  return [...keys.map((r) => r.result_json ?? ""), ...chunks.map((r) => r.result_json)].join("");
}

describe("anonymous publish replay redaction", () => {
  it("stores and replays no claim credential while the first response delivers it once", async () => {
    const body = { files: [{ path: "note.txt", content: "redacted replay bytes" }] };
    const first = await anonymousPublish(body, "redaction-claim");
    expect(first.status).toBe(201);
    expect(first.body.claimToken).toMatch(/^dwc_\S+$/);
    expect(first.body.claim.token).toBe(first.body.claimToken);
    expect(first.body.replayed).not.toBe(true);

    const replay = await anonymousPublish(body, "redaction-claim");
    expect(replay.status).toBe(first.status);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.site.id).toBe(first.body.site.id);
    expect(replay.body.claimToken).toBeNull();
    expect(replay.body.claim.token).toBeNull();
    expect(replay.body.claim.url).not.toContain("#token=");
    expect(replay.body.claimUrl).not.toContain("#token=");
    expect(replay.body.note).toContain("not re-issued");
    expect(JSON.stringify(replay.body)).not.toContain(first.body.claimToken);

    const stored = await storedPayloads();
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).not.toContain(first.body.claimToken);
    expect(stored).not.toContain("dwc_");
    expect(stored).not.toContain("#token=");
    const sites = await env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE tenant_id IS NULL").first<{ n: number }>();
    expect(sites?.n).toBe(1);
  });

  it("stores and replays no upload credential for a pending anonymous publish", async () => {
    const content = new TextEncoder().encode("upload me later");
    const body = { files: [{ path: "big.bin", sha256: await sha256Hex(content), size: content.length }] };
    const first = await anonymousPublish(body, "redaction-upload");
    expect(first.status).toBe(202);
    expect(first.body.status).toBe("awaiting_upload");
    expect(first.body.claimToken).toMatch(/^dwc_\S+$/);
    const authorization = first.body.upload.items[0].headers.Authorization;
    expect(authorization).toMatch(/^Bearer dwu_\S+$/);
    const uploadToken = authorization.slice("Bearer ".length);
    expect(first.body.upload.items[0].curl).toContain(uploadToken);

    const replay = await anonymousPublish(body, "redaction-upload");
    expect(replay.status).toBe(first.status);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.status).toBe("awaiting_upload");
    expect(replay.body.upload.items[0].headers.Authorization).toBeNull();
    expect(replay.body.upload.items[0].curl).toBeNull();
    expect(JSON.stringify(replay.body)).not.toContain(uploadToken);
    expect(JSON.stringify(replay.body)).not.toContain("dwu_");

    const stored = await storedPayloads();
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).not.toContain(uploadToken);
    expect(stored).not.toContain("dwu_");
    expect(stored).not.toContain(first.body.claimToken);
    expect(stored).not.toContain("dwc_");
  });
});
