import { describe, expect, it } from "vitest";
import { bearerToken, defaultIdentity, principalFromToken, requestIp } from "@dropway/core";
import { freshInstance, jsonBody, manifestEntry } from "./helpers";

// Review-round guard pin: operation-level authorization is the last line of
// defence for an upload Principal. defaultIdentity also gates dwu_ tokens by
// URL/method, but an embedding identity adapter may legitimately resolve a
// dwu_ token itself (via principalFromToken) and hand the already-resolved
// upload Principal to operations on any route. authorizeOperation must then
// refuse every operation except upload_blob, before policy or any handler.
describe("operation authorization for an already-resolved upload Principal", () => {
  it("refuses non-upload operations pre-handler while the authorized blob upload succeeds", async () => {
    const uploadOperations: string[] = [];
    const dw = await freshInstance({}, { adapters: {
      identity: { async resolve(request, dc) {
        const token = bearerToken(request);
        // Embedding adapter: authenticate the issued dwu_ token on any route,
        // bypassing defaultIdentity's URL/method gate on purpose.
        if (token?.startsWith("dwu_")) return principalFromToken(dc, token, requestIp(request));
        return defaultIdentity.resolve(request, dc);
      } },
      policy: {
        limits: (_p, _o, dc) => dc.config.limits,
        // beforeOperation runs after authorization and before dispatch, so
        // seeing an upload Principal here proves authorization let it through.
        beforeOperation(principal, op) {
          if (principal.kind === "upload") uploadOperations.push(op.id);
        },
      },
    } });

    const entry = await manifestEntry("data.txt", "scoped upload bytes");
    const { bytes: _bytes, ...manifest } = entry;
    const pending = await dw.json("/api/v1/publish", { ...jsonBody({ site: "upload-op-auth", files: [manifest] }), key: dw.ownerKey });
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe("awaiting_upload");
    const item = pending.body.upload.items[0];
    const token = new Headers(item.headers).get("Authorization")!;
    expect(token).toMatch(/^Bearer dwu_\S+$/);

    // Positive owner control: the same route answers with a real credential.
    const ownerList = await dw.json("/api/v1/sites", { key: dw.ownerKey });
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.sites).toHaveLength(1);

    const forbidden = await dw.json("/api/v1/sites", { headers: { Authorization: token } });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toMatchObject({ code: expect.any(String), hint: expect.any(String) });
    expect(forbidden.body.sites).toBeUndefined();
    expect(uploadOperations, "no non-upload operation may reach policy/handler dispatch").toEqual([]);

    const put = await dw.json(`/api/v1/blobs/${entry.sha256}`, {
      method: "PUT",
      headers: { Authorization: token, "Content-Length": String(entry.size) },
      body: entry.bytes,
    });
    expect(put.status).toBe(201);
    // Positive control: the upload operation does pass authorization, so the
    // empty list above cannot be explained by a broken recorder.
    expect(uploadOperations).toEqual(["upload_blob"]);
  });
});
