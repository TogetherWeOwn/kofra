import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerBindings } from "@kofra/server";
import { ORIGIN, type Instance } from "./helpers";
import {
  DAY, get, instance, op, operations, refusal, SITES, state, storageUsage, sweep, update,
} from "./transfer-fixtures";
import {
  accountingWrite, assertStoredBytes, databaseBoundary, delivery, fileLinks, lifecycle,
  operationRequest, references, request, REVIEW_FILES, REVIEW_PASSWORD, reviewInput, transferWrite,
} from "./delivery-review-fixtures";

// Review-spec acceptance, not implementation-derived assertions. Each group names
// a reproduced break and keeps real workerd routing, D1/R2/KV and service behavior.
let dw: Instance;
beforeEach(async () => { dw = await instance(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("bearer values never enter operational-error logs", () => {
  it.each(["download R2", "download D1", "app D1"])("returns 500 with redacted credentials on %s failure", async (boundary) => {
    const t = await delivery(dw, { password: REVIEW_PASSWORD });
    const [link] = await fileLinks(dw, t, 0, REVIEW_PASSWORD);
    const url = new URL(link!);
    const grant = url.searchParams.get("grant");
    const recipient = url.searchParams.get("recipient");
    expect(grant, "real unlocked link must carry a grant").toBeTruthy();
    expect(recipient, "real recipient link must carry attribution").toBeTruthy();
    // Prove this is valid authorization, not an error caused by a fabricated grant.
    const valid = await dw.call(link!);
    expect(valid.status).toBe(200);
    expect(await valid.text()).toBe("alpha\n");

    const logged: string[] = [];
    for (const method of ["error", "warn", "log", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((value) => value instanceof Error ? `${value.message}\n${value.stack}`
          : value instanceof Request ? value.url : typeof value === "string" ? value : JSON.stringify(value)).join(" "));
      });
    }
    let injected = false;
    const bindings: Partial<ServerBindings> = boundary === "download R2" ? {
      FILES: new Proxy(env.FILES, { get(target, property) {
        if (property === "get") return () => { injected = true; throw new Error("review R2 read unavailable"); };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } }),
    } : { DB: databaseBoundary(async (sql) => {
      if (sql.some((statement) => /\bSELECT\b[\s\S]*\bFROM\s+transfers\b/i.test(statement))) {
        injected = true;
        throw new Error("review D1 read unavailable");
      }
    }) };
    if (boundary === "app D1") {
      const operation = (await operations(dw)).find((entry) => entry.id === "get_transfer")!;
      url.href = new URL(operation.path.replace("{transfer}", encodeURIComponent(t.id)), ORIGIN).href + url.search;
    }
    const failed = await request(dw, url.href, {
      headers: { Accept: "application/json", ...(boundary === "download R2" ? { Range: "bytes=0-2" } : {}),
        ...(boundary === "app D1" ? { Authorization: `Bearer ${dw.ownerKey}` } : {}) },
    }, bindings);
    expect(injected, "failure must come from the intended operational boundary").toBe(true);
    expect(failed.status).toBe(500);
    await failed.text();
    expect(logged.length, "operational errors must remain observable").toBeGreaterThan(0);
    for (const secret of new Set([grant!, recipient!, encodeURIComponent(grant!), encodeURIComponent(recipient!)])) {
      // Do not echo a live credential again in the test runner's failure output.
      expect.soft(logged.some((line) => line.includes(secret)), "logs must not contain live bearer query values").toBe(false);
    }
  });
});

describe("password form wire-byte budget", () => {
  it("cancels an unknown-length stream on the first chunk past 16,384 bytes, before decoding or KDF", async () => {
    const t = await delivery(dw, { password: REVIEW_PASSWORD });
    let pulled = 0;
    let cancelled = false;
    let reachedEof = false;
    // Exactly the cap in two chunks, then one byte over, then unread tail.
    // Invalid UTF-8 also catches measuring decoded/re-encoded text, not wire bytes.
    const chunks = [new Uint8Array(8192).fill(255), new Uint8Array(8192).fill(255),
      new Uint8Array([255]), ...Array.from({ length: 5 }, () => new Uint8Array(8192).fill(255))];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === chunks.length) { reachedEof = true; controller.close(); }
        else controller.enqueue(chunks[pulled++]!);
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    const req = new Request(t.url, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: stream,
    });
    expect(req.headers.has("Content-Length")).toBe(false);
    const response = await request(dw, req.url, { method: req.method, headers: req.headers, body: req.body });
    expect(response.status).toBe(413);
    expect.soft(pulled, "stop at the third (first over-budget) chunk").toBe(3);
    expect.soft(cancelled, "release/cancel the unread request tail").toBe(true);
    expect.soft(reachedEof, "do not buffer the rest before refusing").toBe(false);
    expect.soft(decode, "reject the wire body before decoding it").not.toHaveBeenCalled();
    expect.soft(derive, "oversized unauthenticated input must not reach the password KDF").not.toHaveBeenCalled();
    await response.text();
  });

  it.each(["small", "exactly 16,384 bytes"])("still accepts a valid unknown-length password form: %s", async (size) => {
    const t = await delivery(dw, { password: REVIEW_PASSWORD });
    const prefix = new URLSearchParams({ password: REVIEW_PASSWORD }).toString() + "&padding=";
    const bytes = new TextEncoder().encode(prefix + (size === "small" ? "x" : "x".repeat(16_384 - prefix.length)));
    expect(bytes.length).toBe(size === "small" ? prefix.length + 1 : 16_384);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const response = await request(dw, t.url, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: stream,
    });
    expect([200, 302, 303]).toContain(response.status);
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
    await response.text();
  });
});

describe("legal holds preserve evidence, not public access", () => {
  it.each(["ids", "allLive"])("revokes a held live delivery via %s without releasing its references", async (selection) => {
    const t = await delivery(dw);
    const [link] = await fileLinks(dw, t);
    await state(t, { legal_hold: 1 });
    const before = await lifecycle(t.slug);
    const revoked = await op(dw, "revoke_transfers", selection === "ids" ? { ids: [t.id] } : { allLive: true });
    expect.soft(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect.soft(revoked.body.count).toBe(1);
    const after = await lifecycle(t.slug);
    expect.soft(after?.revoked_at).toEqual(expect.any(Number));
    expect.soft((await dw.call(link!)).status).toBe(410);
    expect(after).toMatchObject({ legal_hold: 1, purged_at: null, deleted_at: null, site_deleted_at: null,
      site_id: before!.site_id, current_version_id: before!.current_version_id });
    expect(await storageUsage()).toBe(18);
    await assertStoredBytes(before!.site_id);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 366 * DAY);
    await sweep(dw);
    await sweep(dw);
    await assertStoredBytes(before!.site_id);
    expect(await storageUsage()).toBe(18);
    expect((await lifecycle(t.slug))?.legal_hold).toBe(1);
  });

  it("still refuses ordinary held edits/deletion and only purges after hold release", async () => {
    const t = await delivery(dw);
    await state(t, { legal_hold: 1 });
    const before = await lifecycle(t.slug);
    refusal(await update(dw, t, { message: "must not replace held evidence" }), 409);
    refusal(await op(dw, "delete_site", { site: t.slug, confirm: t.slug }), 409);
    expect(await lifecycle(t.slug)).toEqual(before);
    await state(t, { expires_at: Date.now() - 1 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 366 * DAY);
    await sweep(dw);
    await assertStoredBytes(before!.site_id);
    expect(await storageUsage()).toBe(18);
    await state(t, { legal_hold: 0 });
    await sweep(dw);
    expect(await references(before!.site_id)).toEqual([]);
    expect(await storageUsage()).toBe(0);
    await sweep(dw);
    expect(await storageUsage()).toBe(0);
  });
});

describe("publication-aware creation failure compensation", () => {
  it("keeps lifecycle/accounting ownership after a post-commit KV failure until references are purged", async () => {
    const expiresAt = Date.now() + 2 * DAY;
    let committed: Awaited<ReturnType<typeof lifecycle>> = null;
    let injected = false;
    const cache = new Proxy(env.CACHE, { get(target, property) {
      if (property === "put") return async (...args: Parameters<KVNamespace["put"]>) => {
        if (!injected && args[0] === "live:review-parcel") {
          committed = await lifecycle("review-parcel");
          expect(committed?.current_version_id, "fault is after the real D1 live-pointer commit").toBeTruthy();
          expect(await references(committed!.site_id)).toHaveLength(2);
          const ready = await env.DB.prepare("SELECT status FROM versions WHERE id = ?").bind(committed!.current_version_id).first();
          expect(ready?.status).toBe("ready");
          injected = true;
          throw new Error("review KV publication unavailable after commit");
        }
        return target.put(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await operationRequest(dw, "create_transfer", reviewInput({ expiresAt }), { CACHE: cache });
    expect(injected).toBe(true);
    // Either recover publication or return an operational error; both must leave
    // real ownership, or compensate by actually removing all byte references.
    expect([201, 500]).toContain(result.status);
    const siteId = committed!.site_id;
    const after = await lifecycle("review-parcel");
    const refs = await references(siteId);
    if (refs.length) {
      expect.soft(after?.transfer_id, "a committed site must not lose its transfer lifecycle owner").toEqual(expect.any(String));
      expect.soft(after?.purged_at, "surviving references must not be marked purged").toBeNull();
      expect.soft(await storageUsage(), "usage is retained for all surviving version references").toBe(18);
      await assertStoredBytes(siteId);
    } else {
      expect(await storageUsage()).toBe(0);
      expect(after === null || after.site_deleted_at !== null || after.current_version_id === null).toBe(true);
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(expiresAt + 1);
    await sweep(dw);
    if (after?.transfer_id && after.purged_at === null && after.deleted_at === null) {
      expect((await lifecycle("review-parcel"))?.expired_at).toEqual(expect.any(Number));
      expect((await dw.call(`${SITES}/review-parcel/alpha.txt`)).status).toBe(410);
      await assertStoredBytes(siteId);
      expect(await storageUsage()).toBe(18);
    }
    vi.setSystemTime(expiresAt + 2 * DAY);
    await sweep(dw);
    await sweep(dw);
    expect.soft(await references(siteId), "retention cleanup must reach the committed references").toEqual([]);
    expect(await storageUsage()).toBe(0);
    const orphan = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sites s LEFT JOIN transfers t ON t.site_id = s.id
      WHERE s.mode = 'transfer' AND s.deleted_at IS NULL AND s.current_version_id IS NOT NULL AND t.id IS NULL`).first<{ n: number }>();
    expect.soft(orphan!.n, "no live transfer-mode site may be orphaned").toBe(0);
  });
});

describe("hold fence at the deletion write", () => {
  it("returns 409 with no deletion, cache or success effects when a hold arrives after selection", async () => {
    const events: unknown[] = [];
    dw = await instance({}, { hooks: [{ onPublish() {}, onDelete(event) { events.push(event); }, onEvent(event) { events.push(event); } }] });
    const t = await delivery(dw);
    const before = await lifecycle(t.slug);
    events.length = 0;
    let injected = false;
    const db = databaseBoundary(async (sql) => {
      if (!injected && sql.some((statement) => /\bUPDATE\s+sites\s+SET\b[\s\S]*\bdeleted_at\s*=/i.test(statement))) {
        injected = true;
        const held = await env.DB.prepare("UPDATE transfers SET legal_hold = 1 WHERE id = ?").bind(t.id).run();
        expect(held.meta.changes).toBe(1);
      }
    });
    const cacheDeletes: string[] = [];
    const cache = new Proxy(env.CACHE, { get(target, property) {
      if (property === "delete") return async (key: string) => { cacheDeletes.push(key); return target.delete(key); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await operationRequest(dw, "delete_site", { slug: t.slug, confirm: t.slug }, { DB: db, CACHE: cache });
    expect(injected, "external hold must arrive at the actual D1 deletion boundary").toBe(true);
    expect.soft(result.status, JSON.stringify(result.body)).toBe(409);
    expect.soft(await lifecycle(before!.site_id, "id")).toEqual({ ...before, legal_hold: 1 });
    expect.soft(cacheDeletes, "failed deletion must not invalidate the live cache").toEqual([]);
    expect.soft(events, "failed deletion must not emit success hooks/events").toEqual([]);
    await assertStoredBytes(before!.site_id);
    expect(await storageUsage()).toBe(18);
  });
});

describe("dynamic app origins with isolated file routing", () => {
  it.each(["path", "subdomain"] as const)("creates, renders and downloads in %s mode with APP_ORIGIN unset", async (mode) => {
    dw = await instance({ appOrigin: null, sitesMode: mode, sitesOrigin: mode === "path" ? SITES : null,
      sitesDomain: mode === "subdomain" ? "files.example.net" : null });
    const t = await delivery(dw);
    expect(new URL(t.url).origin).toBe(ORIGIN);
    const [file] = await fileLinks(dw, t);
    expect(new URL(file!).origin).toBe(mode === "path" ? SITES : `https://${t.slug}.files.example.net`);
    const download = await dw.call(file!);
    expect.soft(download.status).toBe(200);
    if (download.status === 200) {
      expect(download.headers.get("content-disposition")).toMatch(/^attachment(?:;|$)/i);
      expect(await download.text()).toBe("alpha\n");
    } else await download.text();
    for (const pathname of [`/s/${t.slug}/alpha.txt`, new URL(file!).pathname]) {
      const alias = await dw.call(new URL(pathname + new URL(file!).search, ORIGIN).href);
      expect([301, 302, 307, 308, 404]).toContain(alias.status);
      if (alias.status !== 404) expect(new URL(alias.headers.get("location")!, ORIGIN).origin).toBe(new URL(file!).origin);
      expect(await alias.text()).not.toBe("alpha\n");
    }
  });
});

/** Force competing real accounting writes to share their initial snapshots. */
function accountingBarrier(participants: number) {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const db = databaseBoundary(async (sql) => {
    if (sql.some(accountingWrite) && arrived < participants) {
      arrived++;
      if (arrived === participants) release();
      await ready;
    }
  });
  return { db, arrivals: () => arrived };
}

describe("download traffic is not a conflicting management edit", () => {
  it.each([
    { limit: null, sameRecipient: false }, { limit: 4, sameRecipient: false },
    { limit: null, sameRecipient: true }, { limit: 4, sameRecipient: true },
  ])("serves/counts all four eligible downloads: limit=$limit sameRecipient=$sameRecipient", async ({ limit, sameRecipient }) => {
    const t = await delivery(dw, { downloadLimit: limit });
    const first = await fileLinks(dw, t, 0);
    const second = await fileLinks(dw, t, sameRecipient ? 0 : 1);
    const urls = [first[0]!, second[1]!, first[0]!, second[1]!];
    const barrier = accountingBarrier(4);
    const responses = await Promise.all(urls.map((url) => request(dw, url, {}, { DB: barrier.db })));
    expect(barrier.arrivals(), "all four real counter writes overlap").toBe(4);
    expect.soft(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    for (const [i, response] of responses.entries()) {
      const text = await response.text();
      if (response.status === 200) expect(text).toBe(REVIEW_FILES[i % 2]!.content);
    }
    const saved = await get(dw, t);
    expect.soft(saved.files.map((file) => file.downloads)).toEqual([2, 2]);
    expect.soft(saved.recipients.map((recipient) => recipient.downloads)).toEqual(sameRecipient ? [4, 0] : [2, 2]);
    expect.soft((await lifecycle(t.slug))?.downloads).toBe(4);
  });

  it("retains limit-one atomicity across competing files and recipients", async () => {
    const t = await delivery(dw, { downloadLimit: 1 });
    const first = await fileLinks(dw, t, 0);
    const second = await fileLinks(dw, t, 1);
    const barrier = accountingBarrier(2);
    const responses = await Promise.all([first[0]!, second[1]!].map((url) => request(dw, url, {}, { DB: barrier.db })));
    expect(barrier.arrivals()).toBe(2);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 410]);
    const winner = responses.findIndex((r) => r.status === 200);
    for (const response of responses) await response.text();
    const saved = await get(dw, t);
    expect(saved.files.map((file) => file.downloads)).toEqual(winner === 0 ? [1, 0] : [0, 1]);
    expect(saved.recipients.map((recipient) => recipient.downloads)).toEqual(winner === 0 ? [1, 0] : [0, 1]);
    expect((await lifecycle(t.slug))?.downloads).toBe(1);
  });

  it.each(["update", "recipient update", "revoke"])("does not make a pending %s conflict solely because of a successful download", async (kind) => {
    const t = await delivery(dw);
    const [link] = await fileLinks(dw, t);
    let injected = false;
    const db = databaseBoundary(async (sql) => {
      if (!injected && sql.some((statement) => transferWrite(statement) && !accountingWrite(statement))) {
        injected = true;
        const downloaded = await dw.call(link!);
        expect(downloaded.status).toBe(200);
        expect(await downloaded.text()).toBe("alpha\n");
      }
    });
    const changes = kind === "recipient update"
      ? { transfer: t.id, recipients: ["reader-a@example.net", "reader-b@example.org", "new-reader@example.net"] }
      : { transfer: t.id, message: "Management edit during traffic" };
    const result = await operationRequest(dw, kind === "revoke" ? "revoke_transfers" : "update_transfer",
      kind === "revoke" ? { ids: [t.id] } : changes, { DB: db });
    expect(injected).toBe(true);
    expect.soft(result.status, JSON.stringify(result.body)).toBe(200);
    const saved = await get(dw, t);
    expect(saved.files.map((file) => file.downloads)).toEqual([1, 0]);
    expect.soft(saved.recipients.map((recipient) => recipient.downloads)).toEqual(kind === "recipient update" ? [1, 0, 0] : [1, 0]);
    if (kind === "update") expect.soft(saved.message).toBe("Management edit during traffic");
    if (kind === "recipient update") expect.soft(saved.recipients.map((recipient) => recipient.email))
      .toEqual(["reader-a@example.net", "reader-b@example.org", "new-reader@example.net"]);
    if (kind === "revoke") expect.soft((await dw.call(link!)).status).toBe(410);
  });

  it.each(["password", "recipients"])("refuses an in-flight stale link after a real %s change", async (kind) => {
    const t = await delivery(dw, kind === "password" ? { password: REVIEW_PASSWORD } : {});
    const [link] = await fileLinks(dw, t, 0, kind === "password" ? REVIEW_PASSWORD : undefined);
    let injected = false;
    const db = databaseBoundary(async (sql) => {
      if (!injected && sql.some(accountingWrite)) {
        injected = true;
        const changed = await update(dw, t, kind === "password"
          ? { password: "replacement-review-passphrase", currentPassword: REVIEW_PASSWORD }
          : { recipients: ["replacement-reader@example.net"] });
        expect(changed.status).toBe(200);
      }
    });
    const response = await request(dw, link!, { headers: { Accept: "application/json" } }, { DB: db });
    expect(injected).toBe(true);
    expect([403, 404, 409]).toContain(response.status);
    expect(await response.text()).not.toBe("alpha\n");
    const saved = await get(dw, t);
    expect(saved.files.map((file) => file.downloads)).toEqual([0, 0]);
    expect(saved.recipients.map((recipient) => recipient.downloads)).toEqual(kind === "password" ? [0, 0] : [0]);
    expect((await lifecycle(t.slug))?.downloads).toBe(0);
  });
});

const legacyLimits = { maxFileBytes: 1_000_000, maxFiles: 100, maxSiteBytes: 10_000_000, oneShotMaxBytes: 10_000_000 };
describe("legacy policy adapters inherit the configured delivery ceiling", () => {
  it("creates beyond 30 days when the legacy adapter omits the optional expiry field", async () => {
    dw = await instance({ limits: { transferMaxExpiryDays: 90 } }, { adapters: { policy: { async limits() { return legacyLimits; } } } });
    const expiresAt = Date.now() + 45 * DAY;
    const result = await op(dw, "create_transfer", reviewInput({ expiresAt }));
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect((result.body.transfer ?? result.body).expiresAt).toBe(expiresAt);
  });

  it("updates beyond 30 days when the legacy adapter omits the optional expiry field", async () => {
    dw = await instance({ limits: { transferMaxExpiryDays: 90 } }, { adapters: { policy: { async limits() { return legacyLimits; } } } });
    const t = await delivery(dw);
    const expiresAt = Date.now() + 45 * DAY;
    const result = await update(dw, t, { expiresAt });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect((await get(dw, t)).expiresAt).toBe(expiresAt);
  });

  it("still refuses creation and update above an explicit lower policy ceiling", async () => {
    dw = await instance({ limits: { transferMaxExpiryDays: 90 } }, { adapters: { policy: {
      async limits() { return { ...legacyLimits, transferMaxExpiryDays: 7 }; },
    } } });
    refusal(await op(dw, "create_transfer", reviewInput({ expiresAt: Date.now() + 45 * DAY })), 400);
    const t = await delivery(dw);
    refusal(await update(dw, t, { expiresAt: Date.now() + 45 * DAY }), 400);
    expect((await get(dw, t)).expiresAt).toBe(t.expiresAt);
  });
});
