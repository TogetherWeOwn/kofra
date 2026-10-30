import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Instance } from "./helpers";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { hashPassword } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { attributeUrl, cookies, create, follow, get, instance, op, PASSWORD, recipientFile, siteFile, state, unlock, update } from "./transfer-fixtures";

let dw: Instance;
beforeEach(async () => { dw = await instance(); });
afterEach(() => { vi.useRealTimers(); });

// A real Workers/D1/R2 request must finish the counted final download,
// without treating an unrelated nonzero Range as proof of that download.
describe("limited download continuations", () => {
  it("finishes the final permitted partial download without counting again", async () => {
    const t = await create(dw, { downloadLimit: 1 });
    const url = siteFile(t);
    const start = await dw.call(url, { headers: { Range: "bytes=0-7" } });
    expect(start.status).toBe(206);
    expect(await start.text()).toBe("transfer");
    const cookie = start.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    const resume = await dw.call(url, { headers: { Range: "bytes=8-", Cookie: cookie } });
    expect(resume.status).toBe(206);
    expect(await resume.text()).toBe(" sample bytes");
    expect(resume.headers.get("Set-Cookie")).toBeNull();
    expect(start.headers.get("Set-Cookie")).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=/);
    const saved = await get(dw, t);
    expect(saved.files.map((f) => f.downloads)).toEqual([1, 0]);
    expect(saved.recipients.map((r) => r.downloads)).toEqual([0]);
  });

  it("can resume an interrupted full GET, including retrying the same tail", async () => {
    const t = await create(dw, { downloadLimit: 1 });
    const start = await dw.call(siteFile(t));
    expect(start.status).toBe(200);
    await start.body!.cancel();
    const cookie = start.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    for (let i = 0; i < 2; i++) {
      const resume = await dw.call(siteFile(t), { headers: { Range: "bytes=8-", Cookie: cookie } });
      expect(resume.status).toBe(206);
      expect(await resume.text()).toBe(" sample bytes");
      expect(resume.headers.get("Set-Cookie")).toBeNull();
    }
    expect((await get(dw, t)).files.map((f) => f.downloads)).toEqual([1, 0]);
  });

  it("does not let a continuation start a new download or cross file, transfer or recipient boundaries", async () => {
    const t = await create(dw, { downloadLimit: 1, recipients: ["one@example.net", "two@example.net"] });
    const a = await recipientFile(dw, t, 0);
    const b = await recipientFile(dw, t, 1);
    const start = await dw.call(a, { headers: { Range: "bytes=0-7" } });
    expect(start.status).toBe(206);
    await start.text();
    const cookie = start.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    const other = await create(dw, { slug: "other-delivery", downloadLimit: 1 });
    await (await dw.call(siteFile(other))).text();
    for (const [url, method, range, credential] of [
      [a, "GET", "bytes=8-", ""],
      [a, "GET", "bytes=8-", `${cookie}x`],
      [a, "GET", "bytes=8-", cookie.slice(0, -1) + (cookie.endsWith("0") ? "1" : "0")],
      [a, "GET", "bytes=0-7", cookie],
      [a, "GET", "", cookie],
      [a, "HEAD", "bytes=8-", cookie],
      [a, "GET", "bytes=999-", cookie],
      [a, "GET", "bytes=8-9,12-13", cookie],
      [b, "GET", "bytes=8-", cookie],
      [siteFile(t), "GET", "bytes=8-", cookie],
      [siteFile(t, "page.html"), "GET", "bytes=8-", cookie],
      [siteFile(other), "GET", "bytes=8-", cookie],
    ]) {
      const denied = await dw.call(url!, { method, headers: { Range: range!, Cookie: credential! } });
      expect(denied.status, `${method} ${url} ${range}`).toBe(410);
      expect(await denied.text()).not.toContain(" sample bytes");
    }
    const resume = await dw.call(a, { headers: { Range: "bytes=8-", Cookie: cookie } });
    expect(resume.status).toBe(206);
    expect(await resume.text()).toBe(" sample bytes");
    const saved = await get(dw, t);
    expect(saved.files.map((f) => f.downloads)).toEqual([1, 0]);
    expect(saved.recipients.map((r) => r.downloads)).toEqual([1, 0]);
  });

  it.each([
    ["revoked", { revoked_at: 1 }, 410],
    ["expired", { expired_at: 1 }, 410],
    ["past expiry", { expires_at: 1 }, 410],
    ["taken down", { takedown_at: 1 }, 451],
    ["deleted", { deleted_at: 1 }, 404],
    ["purged", { purged_at: 1 }, 404],
    ["revised", { revision: 2 }, 410],
  ] as const)("refuses a continuation when the transfer is %s", async (_, fields, status) => {
    const t = await create(dw, { downloadLimit: 1 });
    const start = await dw.call(siteFile(t), { headers: { Range: "bytes=0-7" } });
    expect(start.status).toBe(206);
    await start.text();
    const cookie = start.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    if ("purged_at" in fields) {
      // Purging also fires the storage-accounting trigger, so meta.changes
      // includes that second row; assert the targeted transfer via RETURNING.
      const purged = await env.DB.prepare("UPDATE transfers SET purged_at = ? WHERE id = ? RETURNING id")
        .bind(fields.purged_at, t.id).first<{ id: string }>();
      expect(purged?.id).toBe(t.id);
    } else await state(t, fields);
    expect((await dw.call(siteFile(t), { headers: { Range: "bytes=8-", Cookie: cookie } })).status).toBe(status);
  });

  it("expires after 15 minutes without renewing the continuation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const t = await create(dw, { downloadLimit: 1 });
    const start = await dw.call(siteFile(t), { headers: { Range: "bytes=0-7" } });
    await start.text();
    const cookie = start.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    vi.setSystemTime(now + 14 * 60_000);
    const resume = await dw.call(siteFile(t), { headers: { Range: "bytes=8-9", Cookie: cookie } });
    expect(resume.status).toBe(206);
    expect(await resume.text()).toBe(" s");
    expect(resume.headers.get("Set-Cookie")).toBeNull();
    vi.setSystemTime(now + 15 * 60_000 + 1);
    expect((await dw.call(siteFile(t), { headers: { Range: "bytes=10-", Cookie: cookie } })).status).toBe(410);
  });

  it("requires both the password grant and continuation proof on a protected final download", async () => {
    const t = await create(dw, { downloadLimit: 1, password: PASSWORD });
    const unlocked = await unlock(dw, t, PASSWORD);
    const page = await follow(dw, t.url, { headers: { Cookie: cookies(unlocked), Accept: "text/html" } });
    expect(page.status).toBe(200);
    const links: string[] = [];
    await new HTMLRewriter().on("a[href]", { element(e) { links.push(attributeUrl(e.getAttribute("href")!, t.url)); } }).transform(page).text();
    const url = links.find((link) => new URL(link).pathname.endsWith("/notes.txt"))!;
    expect(new URL(url).searchParams.get("grant")).toBeTruthy();
    const start = await dw.call(url, { headers: { Range: "bytes=0-7" } });
    expect(start.status).toBe(206);
    await start.text();
    const cookie = start.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    expect((await dw.call(url, { headers: { Range: "bytes=8-" } })).status).toBe(410);
    expect((await dw.call(siteFile(t), { headers: { Range: "bytes=8-", Cookie: cookie } })).status).toBe(403);
    const resumed = await dw.call(url, { headers: { Range: "bytes=8-", Cookie: cookie } });
    expect(resumed.status).toBe(206);
    expect(await resumed.text()).toBe(" sample bytes");
  });

  it("invalidates the continuation when the password changes", async () => {
    const t = await create(dw, { downloadLimit: 2 });
    const start = await dw.call(siteFile(t), { headers: { Range: "bytes=0-7" } });
    await start.text();
    const cookie = start.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    expect((await update(dw, t, { password: PASSWORD })).status).toBe(200);
    expect((await dw.call(siteFile(t), { headers: { Range: "bytes=8-", Cookie: cookie } })).status).toBe(403);
    await state(t, { downloads: 2 });
    expect((await dw.call(siteFile(t), { headers: { Range: "bytes=8-", Cookie: cookie } })).status).toBe(410);
  });

  it.each(["ids", "allLive"])("lets the sender revoke exhausted transfers through %s", async (kind) => {
    const t = await create(dw, { downloadLimit: 1 });
    const start = await dw.call(siteFile(t), { headers: { Range: "bytes=0-7" } });
    await start.text();
    const cookie = start.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    expect((await update(dw, t, { downloadLimit: 2 })).status).toBe(409);
    const revoked = await op(dw, "revoke_transfers", kind === "ids" ? { ids: [t.id] } : { allLive: true });
    expect(revoked.status).toBe(200);
    expect(revoked.body.count).toBe(1);
    expect((await dw.call(siteFile(t), { headers: { Range: "bytes=8-", Cookie: cookie } })).status).toBe(410);
  });

  it("binds proof to the live password digest even without a revision change", async () => {
    const t = await create(dw, { downloadLimit: 1 });
    const start = await dw.call(siteFile(t), { headers: { Range: "bytes=0-7" } });
    await start.text();
    const cookie = start.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    await env.DB.prepare("UPDATE sites SET password_hash = ? WHERE id = (SELECT site_id FROM transfers WHERE id = ?)")
      .bind(await hashPassword(PASSWORD), t.id).run();
    expect((await dw.call(siteFile(t), { headers: { Range: "bytes=8-", Cookie: cookie } })).status).toBe(410);
  });

  it.each([
    ["revoked", { revoked_at: 1 }, 410],
    ["revised", { revision: 2 }, 410],
    ["taken down", { takedown_at: 1 }, 451],
  ] as const)("rechecks proof and live state after opening R2 when %s", async (_, fields, status) => {
    const t = await create(dw, { downloadLimit: 1 });
    const start = await dw.call(siteFile(t), { headers: { Range: "bytes=0-7" } });
    await start.text();
    const cookie = start.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    // Only inject the competing write at the real storage read boundary.
    // The blob, signature verification, D1 queries and HTTP response stay real.
    const files = new Proxy(env.FILES, { get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "get") return async (...args: unknown[]) => {
        const body = await value.apply(target, args);
        await state(t, fields);
        return body;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const ctx = createExecutionContext();
    const response = await dw.dropway.fetch(new Request(siteFile(t), { headers: { Range: "bytes=8-", Cookie: cookie } }),
      { ...env, FILES: files } as unknown as ServerBindings, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(" sample bytes");
    expect((await get(dw, t)).files.map((f) => f.downloads)).toEqual([1, 0]);
  });

  it("never issues a continuation on HEAD, an uncounted range or a denied request", async () => {
    const t = await create(dw, { downloadLimit: 1 });
    for (const init of [{ method: "HEAD" }, { headers: { Range: "bytes=8-" } }]) {
      const response = await dw.call(siteFile(t), init);
      expect(response.status).toBe(init.method ? 200 : 206);
      expect(response.headers.get("Set-Cookie")).toBeNull();
      await response.text();
    }
    await (await dw.call(siteFile(t))).text();
    const denied = await dw.call(siteFile(t));
    expect(denied.status).toBe(410);
    expect(denied.headers.get("Set-Cookie")).toBeNull();
  });
});
