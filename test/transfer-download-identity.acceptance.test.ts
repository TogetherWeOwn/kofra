import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { ServerBindings } from "@dropway/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { Instance } from "./helpers";
import { cookies, create, get, instance, invalidate, op, siteFile, type Transfer } from "./transfer-fixtures";

// Independent acceptance: only the public contracts and existing test fixtures
// were read. The response, storage read and authorization queries stay real.
let dw: Instance;
beforeEach(async () => { dw = await instance(); });

const reads = [
  { name: "full start", range: "", body: "transfer sample bytes" },
  { name: "partial start", range: "bytes=0-7", body: "transfer" },
  { name: "continuation", range: "bytes=8-", body: " sample bytes" },
] as const;

async function requestHeaders(t: Transfer, read: typeof reads[number]) {
  const headers = new Headers();
  if (read.range) headers.set("Range", read.range);
  if (read.name === "continuation") {
    const start = await dw.call(siteFile(t), { headers: { Range: "bytes=0-7" } });
    expect(start.status).toBe(206);
    expect(await start.text()).toBe("transfer");
    headers.set("Cookie", cookies(start));
  }
  return headers;
}

/** Inject only the competing write, after opening the actual disposable R2 body. */
async function readAcrossWrite(url: string, headers: Headers, write: () => Promise<void>) {
  let crossed = false;
  const files = new Proxy(env.FILES, { get(target, property) {
    const value = Reflect.get(target, property);
    if (property === "get") return async (...args: unknown[]) => {
      const opened = await value.apply(target, args);
      if (!crossed && opened) {
        crossed = true;
        await write();
      }
      return opened;
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const ctx = createExecutionContext();
  const response = await dw.dropway.fetch(new Request(url, { headers }),
    { ...env, FILES: files } as unknown as ServerBindings, ctx);
  await waitOnExecutionContext(ctx);
  expect(crossed, "the competing write must occur after the real R2 read").toBe(true);
  return response;
}

describe("download authorization retains the opened immutable identity", () => {
  it.each(reads)("refuses a $name when its original transfer is deleted and its slug is reused", async (read) => {
    const t = await create(dw, { downloadLimit: 1 });
    const headers = await requestHeaders(t, read);
    let replacement: Transfer | undefined;
    const response = await readAcrossWrite(siteFile(t), headers, async () => {
      const deleted = await op(dw, "delete_site", { site: t.slug, confirm: t.slug });
      expect(deleted.status).toBe(200);
      replacement = await create(dw, {
        slug: t.slug, recipients: [], downloadLimit: 1,
        files: [{ path: "notes.txt", content: "changed transfer data", contentType: "text/plain" }],
      });
      expect(replacement.id).not.toBe(t.id);
    });
    const body = await response.text();
    expect.soft([404, 409, 410], "a new transfer at the same slug cannot authorize the already-open old body").toContain(response.status);
    expect.soft(body).not.toBe(read.body);
    expect((await get(dw, replacement!)).files.map((f) => f.downloads), "the replacement never started this download").toEqual([0]);
  });

  it.each(reads)("refuses a $name when the opened file is replaced at the same path and size", async (read) => {
    const t = await create(dw, { downloadLimit: 1 });
    const other = await create(dw, {
      slug: "different-representation", recipients: [],
      files: [{ path: "notes.txt", content: "changed transfer data", contentType: "text/plain" }],
    });
    expect(other.files[0]!.size).toBe(21);
    const file = await env.DB.prepare("SELECT sha256 FROM transfer_files WHERE transfer_id = ? AND path = ?")
      .bind(other.id, "notes.txt").first<{ sha256: string }>();
    expect(file?.sha256).toEqual(expect.any(String));
    const headers = await requestHeaders(t, read);
    const response = await readAcrossWrite(siteFile(t), headers, async () => {
      // A competing storage writer changes the actual representation without
      // changing its path, size or transfer revision. A path-only check is stale.
      const changed = await env.DB.prepare("UPDATE transfer_files SET sha256 = ? WHERE transfer_id = ? AND path = ? RETURNING sha256")
        .bind(file!.sha256, t.id, "notes.txt").first<{ sha256: string }>();
      expect(changed?.sha256).toBe(file!.sha256);
      await invalidate(t);
    });
    const body = await response.text();
    expect.soft([404, 409, 410], "authorization must still describe the representation opened before the write").toContain(response.status);
    expect(body).not.toBe(read.body);
  });

  it("refuses a continuation when its file disappears after opening storage", async () => {
    const t = await create(dw, { downloadLimit: 1 });
    const headers = await requestHeaders(t, reads[2]);
    const response = await readAcrossWrite(siteFile(t), headers, async () => {
      const removed = await env.DB.prepare("DELETE FROM transfer_files WHERE transfer_id = ? AND path = ? RETURNING path")
        .bind(t.id, "notes.txt").first<{ path: string }>();
      expect(removed?.path).toBe("notes.txt");
      await invalidate(t);
    });
    expect.soft(response.status).toBe(404);
    expect(await response.text()).not.toBe(" sample bytes");
  });
});
