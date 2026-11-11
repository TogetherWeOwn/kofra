import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "@kofra/core";
import { ORIGIN, type Instance } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import {
  cookies, create, DAY, FILES, follow, get, HOUR, input, instance, instanceWithVars,
  member, op, operations, PASSWORD, passwordDigest, recipientFile, ref, refusal, revoke, SITES,
  siteFile, state, storageUsage, storedFileCount, sweep, unlock, update,
} from "./transfer-fixtures";

// Acceptance-owned behavior, written before a transfer implementation exists.
// Fresh fixtures use reserved example domains and documentation-only IPs. No
// legacy implementation, fixture, account, host or test literal was copied.
let dw: Instance;
beforeEach(async () => { dw = await instance(); });
afterEach(() => { vi.useRealTimers(); });

function proofRefused(result: { status: number; body: any }) {
  expect([400, 403, 409, 422], "proof refusal is a client error, never a server failure").toContain(result.status);
  refusal(result, result.status);
}

describe("transfer operation surfaces", () => {
  it("advertises transfer operations consistently to REST, MCP, OpenAPI and the CLI", async () => {
    const table = await operations(dw);
    const spec = await dw.json("/openapi.json");
    const client = await connectMcp(dw, dw.ownerKey);
    try {
      const tools = await client.tools();
      const documented = Object.values(spec.body.paths).flatMap((path: any) => Object.values(path).map((o: any) => o.operationId));
      for (const id of ["create_transfer", "get_transfer", "update_transfer", "revoke_transfers"]) {
        const operation = table.find((o) => o.id === id);
        expect(operation, id).toBeDefined();
        expect(operation!.cli?.command.length, `${id} CLI command`).toBeGreaterThan(0);
        expect(tools.some((t) => t.name === id), `${id} MCP tool`).toBe(true);
        expect(documented).toContain(id);
      }
    } finally { await client.client.close(); }
  });

  it("creates through REST and exposes transfer mode through get_transfer", async () => {
    const t = await create(dw);
    const saved = await get(dw, t);
    expect(saved).toMatchObject({ id: t.id, slug: "parcel-sample", mode: "transfer", message: "A short delivery note" });
    expect(saved.files.map((f) => [f.path, f.size])).toEqual([["notes.txt", 21], ["page.html", 32]]);
  });

  it("creates through MCP using the same recipient normalization and refusal rules", async () => {
    const client = await connectMcp(dw, dw.ownerKey);
    try {
      expect((await client.tools()).map((t) => t.name), "create_transfer must be registered before calling it").toContain("create_transfer");
      const r = await client.call("create_transfer", input({ recipients: [" READER@example.net ", "reader@example.net"] }));
      expect(r.isError, r.text).toBe(false);
      const t = r.data.transfer ?? r.data;
      expect(t.mode).toBe("transfer");
      expect(t.recipients.map((x: any) => x.email)).toEqual(["reader@example.net"]);
      const bad = await client.call("create_transfer", input({ slug: "invalid-parcel", password: "tiny" }));
      expect(bad.isError).toBe(true);
      expect(bad.data.error.code).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(bad.data.error.hint.length).toBeGreaterThan(0);
    } finally { await client.client.close(); }
  });
});

describe("creation and bounds", () => {
  it("normalizes and deduplicates recipients and returns distinct recipient and general links", async () => {
    const t = await create(dw, { recipients: [" READER@example.net ", "reader@example.net", "Second@EXAMPLE.ORG"] });
    expect(t.recipients.map((r) => r.email)).toEqual(["reader@example.net", "second@example.org"]);
    const links = [t.url, ...t.recipients.map((r) => r.url)];
    expect(new Set(links).size).toBe(3);
    for (const link of links) expect(new URL(link).origin).toBe(ORIGIN);
    expect((await get(dw, t)).recipients).toHaveLength(2);
  });

  it("permits a general-only delivery without recipients, message or password", async () => {
    const t = await create(dw, { recipients: [], message: undefined, password: undefined });
    expect(t.recipients).toEqual([]);
    expect((await dw.call(siteFile(t))).status).toBe(200);
  });

  it("accepts exactly 50 distinct recipient addresses", async () => {
    const t = await create(dw, { recipients: Array.from({ length: 50 }, (_, i) => `reader-${i}@example.net`) });
    expect(t.recipients).toHaveLength(50);
    expect(new Set(t.recipients.map((r) => r.url)).size).toBe(50);
  });

  it("refuses 51 distinct recipients", async () => {
    refusal(await op(dw, "create_transfer", input({ recipients: Array.from({ length: 51 }, (_, i) => `reader-${i}@example.net`) })), 400);
  });

  it("refuses a malformed recipient", async () => {
    refusal(await op(dw, "create_transfer", input({ recipients: ["not-an-address"] })), 400);
  });

  it.each([8, 1024])("accepts a password of %i characters", async (length) => {
    const t = await create(dw, { password: "p".repeat(length) });
    expect((await dw.call(siteFile(t), { headers: { Accept: "application/json" } })).status).toBe(403);
  });

  it.each(["p".repeat(7), "p".repeat(1025), "long\u0000password"])("refuses an out-of-bounds password %#", async (password) => {
    refusal(await op(dw, "create_transfer", input({ password })), 400);
  });

  it("treats an empty password as no password", async () => {
    const t = await create(dw, { password: "" });
    expect((await dw.call(siteFile(t))).status).toBe(200);
  });

  it("accepts a 10,000-character message", async () => {
    const t = await create(dw, { message: "m".repeat(10_000) });
    expect((await get(dw, t)).message).toHaveLength(10_000);
  });

  it("refuses a 10,001-character message", async () => {
    refusal(await op(dw, "create_transfer", input({ message: "m".repeat(10_001) })), 400);
  });

  it("accepts the minimum one-hour expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2032-04-07T12:00:00Z"));
    const expiresAt = Date.now() + HOUR;
    expect((await create(dw, { expiresAt })).expiresAt).toBe(expiresAt);
  });

  it("refuses expiry one millisecond below one hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    refusal(await op(dw, "create_transfer", input({ expiresAt: Date.now() + HOUR - 1 })), 400);
  });

  it("accepts the default 30-day ceiling and refuses one millisecond above it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const deadline = Date.now() + 30 * DAY;
    expect((await create(dw, { expiresAt: deadline })).expiresAt).toBe(deadline);
    refusal(await op(dw, "create_transfer", input({ slug: "too-late", expiresAt: deadline + 1 })), 400);
  });

  it("honors a lower operator TRANSFER_MAX_EXPIRY_DAYS", async () => {
    dw = await instanceWithVars({ TRANSFER_MAX_EXPIRY_DAYS: "7" });
    await create(dw, { expiresAt: Date.now() + 6 * DAY });
    refusal(await op(dw, "create_transfer", input({ slug: "too-late", expiresAt: Date.now() + 8 * DAY })), 400);
  });

  it("never allows an operator ceiling above 3,650 days", async () => {
    dw = await instanceWithVars({ TRANSFER_MAX_EXPIRY_DAYS: "9000" });
    refusal(await op(dw, "create_transfer", input({ expiresAt: Date.now() + 3651 * DAY })), 400);
  });

  it("accepts a configured 3,650-day maximum", async () => {
    dw = await instanceWithVars({ TRANSFER_MAX_EXPIRY_DAYS: "3650" });
    vi.useFakeTimers({ toFake: ["Date"] });
    const deadline = Date.now() + 3650 * DAY;
    expect((await create(dw, { expiresAt: deadline })).expiresAt).toBe(deadline);
  });

  it("reads the effective expiry ceiling through PolicyAdapter.limits", async () => {
    dw = await instance({}, { adapters: { policy: {
      async limits(_principal, _owner, dc) { return { ...dc.config.limits, transferMaxExpiryDays: 2 }; },
    } } });
    await create(dw, { expiresAt: Date.now() + DAY });
    refusal(await op(dw, "create_transfer", input({ slug: "policy-refusal", expiresAt: Date.now() + 3 * DAY })), 400);
  });

  it.each([1, 10_000])("accepts download limit %i", async (downloadLimit) => {
    await create(dw, { downloadLimit });
  });

  it.each([0, -1, 10_001, 1.5])("refuses download limit %s", async (downloadLimit) => {
    refusal(await op(dw, "create_transfer", input({ downloadLimit })), 400);
  });
});

describe("origin separation and inert transfer pages", () => {
  it("shows escaped message text, file names and sizes on the app origin", async () => {
    const message = '<img src=x onerror="alert(7)"><script>bad()</script> & delivery';
    const t = await create(dw, { message });
    expect(new URL(t.url).origin).toBe(ORIGIN);
    const page = await follow(dw, t.url, { headers: { Accept: "text/html" } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain(message);
    expect(html).not.toContain("<script>bad()");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
    for (const f of t.files) {
      expect(html).toContain(f.path);
      expect(html).toContain(String(f.size));
    }
  });

  it.each(["", "?view=1", "?view=source", "?raw=1", "?download=0"])("always downloads HTML, even with viewer selector %s", async (query) => {
    const t = await create(dw);
    const r = await dw.call(siteFile(t, "page.html") + query, { headers: { Accept: "text/html", "Sec-Fetch-Dest": "document" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(/^attachment(?:;|$)/i);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-kofra-viewer")).toBeNull();
    expect(await r.text()).toBe(FILES[1]!.content);
  });

  it("never serves transfer file bytes from an app-origin alias", async () => {
    const t = await create(dw);
    const r = await dw.call(`${ORIGIN}/s/${t.slug}/notes.txt`);
    if ([301, 302, 307, 308].includes(r.status)) {
      expect(new URL(r.headers.get("location")!, ORIGIN).origin).toBe(SITES);
    } else {
      expect(r.status).toBe(404);
    }
    expect(await r.text()).not.toBe(FILES[0]!.content);
  });

  it("serves a new transfer without any scanner binding, job or verdict", async () => {
    const t = await create(dw);
    const r = await dw.call(siteFile(t));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(FILES[0]!.content);
    const page = await follow(dw, t.url, { headers: { Accept: "text/html" } });
    expect(await page.text()).not.toMatch(/virus[- ]free|scann(?:ed|ing)|scan (?:pending|complete|status)/i);
  });
});

describe("download precedence and expiry boundary", () => {
  it("returns 404 for an unknown slug", async () => {
    expect((await dw.call(`${SITES}/never-created-parcel/notes.txt`)).status).toBe(404);
  });

  it("places missing files above takedown, expiry and password", async () => {
    const t = await create(dw, { password: PASSWORD });
    await state(t, { takedown_at: Date.now(), expires_at: Date.now() - 1 });
    expect((await dw.call(siteFile(t, "absent.txt"))).status).toBe(404);
  });

  it("places a deleted transfer above a live takedown", async () => {
    const t = await create(dw);
    await state(t, { deleted_at: Date.now(), takedown_at: Date.now() });
    expect((await dw.call(siteFile(t))).status).toBe(404);
  });

  it.each(["expired", "revoked", "locked"])("places slug-level takedown above %s and discloses no ground", async (condition) => {
    const t = await create(dw, { password: PASSWORD });
    await state(t, {
      takedown_at: Date.now(), takedown_reason: "private-reason-canary",
      ...(condition === "expired" ? { expires_at: Date.now() - 1 } : {}),
      ...(condition === "revoked" ? { revoked_at: Date.now() } : {}),
    });
    const r = await dw.call(siteFile(t), { headers: { Accept: "text/html" } });
    expect(r.status).toBe(451);
    expect(await r.text()).not.toContain("private-reason-canary");
    const page = await dw.call(t.url, { headers: { Accept: "text/html" } });
    expect(page.status).toBe(451);
    expect(await page.text()).not.toContain("private-reason-canary");
  });

  it.each(["expired", "revoked"])("places %s above a password form", async (condition) => {
    const t = await create(dw, { password: PASSWORD });
    await state(t, condition === "expired" ? { expires_at: Date.now() - 1 } : { revoked_at: Date.now() });
    const r = await dw.call(siteFile(t), { headers: { Accept: "text/html" } });
    expect(r.status).toBe(410);
    expect(await r.text()).not.toMatch(/<input[^>]+type=["']password/);
    expect((await dw.call(siteFile(t), { headers: { Accept: "application/json" } })).status).toBe(410);
  });

  it("places a reached download limit above the password lock", async () => {
    const t = await create(dw, { downloadLimit: 1, password: PASSWORD });
    const cookie = cookies(await unlock(dw, t, PASSWORD));
    expect((await dw.call(siteFile(t), { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await dw.call(siteFile(t), { headers: { Accept: "application/json" } })).status).toBe(410);
  });

  it("places password lock above file bytes: HTML form for browsers, 403 for API clients", async () => {
    const t = await create(dw, { password: PASSWORD });
    const api = await dw.call(siteFile(t), { headers: { Accept: "application/json" } });
    expect(api.status).toBe(403);
    expect(await api.text()).not.toContain(FILES[0]!.content);
    const page = await dw.call(t.url, { headers: { Accept: "text/html" } });
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toMatch(/<input[^>]+type=["']password/);
  });

  it("allows exactly the expiry instant, then refuses one millisecond later without counting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const deadline = Date.now() + HOUR;
    const t = await create(dw, { expiresAt: deadline });
    vi.setSystemTime(deadline);
    expect((await dw.call(siteFile(t))).status).toBe(200);
    vi.setSystemTime(deadline + 1);
    expect((await dw.call(siteFile(t))).status).toBe(410);
    expect((await get(dw, t)).files.find((f) => f.path === "notes.txt")!.downloads).toBe(1);
  });
});

describe("download counts", () => {
  it("counts a GET and any byte range, but not HEAD, per file and recipient", async () => {
    const t = await create(dw, { recipients: ["one@example.net", "two@example.net"] });
    const a = await recipientFile(dw, t, 0);
    const b = await recipientFile(dw, t, 1);
    expect((await dw.call(a)).status).toBe(200);
    const start = await dw.call(a, { headers: { Range: "bytes=0-7" } });
    expect(start.status).toBe(206);
    expect(await start.text()).toBe("transfer");
    const resume = await dw.call(a, { headers: { Range: "bytes=8-" } });
    expect(resume.status).toBe(206);
    expect(await resume.text()).toBe(" sample bytes");
    expect((await dw.call(a, { method: "HEAD" })).status).toBe(200);
    expect((await dw.call(b)).status).toBe(200);
    expect((await dw.call(siteFile(t, "page.html"))).status).toBe(200);
    const saved = await get(dw, t);
    expect(saved.files.find((f) => f.path === "notes.txt")!.downloads).toBe(4);
    expect(saved.files.find((f) => f.path === "page.html")!.downloads).toBe(1);
    expect(saved.recipients.map((r) => r.downloads)).toEqual([3, 1]);
  });

  it("charges a nonzero-offset range against the download limit", async () => {
    const t = await create(dw, { downloadLimit: 1 });
    const a = await recipientFile(dw, t, 0);
    const ranged = await dw.call(a, { headers: { Range: "bytes=1-" } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("ransfer sample bytes");
    expect((await dw.call(a)).status).toBe(410);
    expect((await dw.call(a, { headers: { Range: "bytes=1-" } })).status).toBe(410);
    const saved = await get(dw, t);
    expect(saved.files.map((f) => f.downloads)).toEqual([1, 0]);
    expect(saved.recipients.map((r) => r.downloads)).toEqual([1]);
  });

  it("does not charge a download for reading the page or for an invalid range", async () => {
    const t = await create(dw);
    expect((await follow(dw, t.url, { headers: { Accept: "text/html" } })).status).toBe(200);
    expect((await dw.call(siteFile(t), { headers: { Range: "bytes=9999-" } })).status).toBe(416);
    expect((await get(dw, t)).files.map((f) => f.downloads)).toEqual([0, 0]);
  });

  it("stops at the limit across links and files, with no extra count on a denial", async () => {
    const t = await create(dw, { downloadLimit: 1, recipients: ["one@example.net", "two@example.net"] });
    const a = await recipientFile(dw, t, 0);
    const b = await recipientFile(dw, t, 1, "page.html");
    expect((await dw.call(a)).status).toBe(200);
    expect((await dw.call(b)).status).toBe(410);
    expect((await dw.call(siteFile(t))).status).toBe(410);
    const saved = await get(dw, t);
    expect(saved.files.map((f) => f.downloads)).toEqual([1, 0]);
    expect(saved.recipients.map((r) => r.downloads)).toEqual([1, 0]);
  });

  it("does not count password, takedown or missing-file refusals", async () => {
    const t = await create(dw, { password: PASSWORD });
    expect((await dw.call(siteFile(t), { headers: { Accept: "application/json" } })).status).toBe(403);
    await state(t, { takedown_at: Date.now() });
    expect((await dw.call(siteFile(t))).status).toBe(451);
    expect((await dw.call(siteFile(t, "absent.txt"))).status).toBe(404);
    expect((await get(dw, t)).files.map((f) => f.downloads)).toEqual([0, 0]);
  });
});

describe("ownership and guarded updates", () => {
  it("makes another owner's transfer indistinguishable from a missing one", async () => {
    const alice = await member(dw, "sender-a@example.net");
    const bob = await member(dw, "sender-b@example.net");
    const t = await create(dw, {}, alice.key);
    for (const id of [t.id, "nonexistent-transfer-id"]) {
      const hidden = await op(dw, "get_transfer", { transfer: id }, bob.key);
      refusal(hidden, 404);
      expect(hidden.body.error.code).not.toBe("forbidden");
    }
    const foreign = await op(dw, "get_transfer", ref(t), bob.key);
    const missing = await op(dw, "get_transfer", { transfer: "nonexistent-transfer-id" }, bob.key);
    // Correlation is per request, not part of the ownership oracle. Compare
    // every other envelope/error field exactly, including any future fields.
    const { requestId: foreignRequestId, ...foreignBody } = foreign.body;
    const { requestId: missingRequestId, ...missingBody } = missing.body;
    for (const [response, requestId] of [[foreign, foreignRequestId], [missing, missingRequestId]] as const) {
      expect(requestId).toEqual(expect.any(String));
      expect(requestId.length).toBeGreaterThan(0);
      expect(response.res.headers.get("X-Request-Id")).toBe(requestId);
    }
    expect(foreignBody).toEqual(missingBody);
    refusal(await op(dw, "update_transfer", { ...ref(t), message: "not mine" }, bob.key), 404);
    refusal(await op(dw, "revoke_transfers", { ids: [t.id] }, bob.key), 404);
  });

  it("updates message, expiry, recipients and limit while live and unnotified", async () => {
    const t = await create(dw);
    const expiresAt = Date.now() + 3 * DAY;
    const r = await update(dw, t, { message: "Revised note", expiresAt, recipients: ["replacement@example.net"], downloadLimit: 9 });
    expect(r.status).toBe(200);
    const saved = await get(dw, t);
    expect(saved.message).toBe("Revised note");
    expect(saved.expiresAt).toBe(expiresAt);
    expect(saved.recipients.map((x) => x.email)).toEqual(["replacement@example.net"]);
    for (let i = 0; i < 9; i++) expect((await dw.call(siteFile(t))).status).toBe(200);
    expect((await dw.call(siteFile(t))).status).toBe(410);
  });

  it("preserves omitted fields on a partial update", async () => {
    const t = await create(dw, { password: PASSWORD, downloadLimit: 7 });
    expect((await update(dw, t, { message: "Only this changes" })).status).toBe(200);
    const saved = await get(dw, t);
    expect(saved.expiresAt).toBe(t.expiresAt);
    expect(saved.recipients.map((x) => x.email)).toEqual(t.recipients.map((x) => x.email));
    expect((await dw.call(siteFile(t), { headers: { Accept: "application/json" } })).status).toBe(403);
  });

  it.each(["expired", "revoked", "notified", "held", "taken down"])("rejects ordinary updates when %s", async (condition) => {
    const t = await create(dw);
    const states: Record<string, Record<string, number>> = {
      expired: { expires_at: Date.now() - 1 }, revoked: { revoked_at: Date.now() },
      notified: { notified_at: Date.now() }, held: { legal_hold: 1 }, "taken down": { takedown_at: Date.now() },
    };
    const fields = states[condition]!;
    await state(t, fields);
    for (const changes of [
      { message: "must not change" }, { expiresAt: Date.now() + 4 * DAY },
      { recipients: ["not-permitted@example.net"] }, { downloadLimit: 4 },
    ]) refusal(await update(dw, t, changes), 409);
    expect((await get(dw, t)).message).toBe("A short delivery note");
  });

  it("a semantic no-op returns 200 without a new event", async () => {
    const events: unknown[] = [];
    const hooks = { onPublish() {}, onEvent(event: unknown) { events.push(event); } };
    dw = await instance({}, { hooks: [hooks] });
    const t = await create(dw, { recipients: ["one@example.net", "two@example.net"] });
    events.length = 0;
    expect((await update(dw, t, { message: "One genuine change" })).status).toBe(200);
    expect(events.length, "positive control: real change must emit an event").toBeGreaterThan(0);
    const count = events.length;
    expect((await update(dw, t, { message: "One genuine change", recipients: [" TWO@EXAMPLE.NET ", "one@example.net", "one@example.net"] })).status).toBe(200);
    expect(events).toHaveLength(count);
  });

  it("refuses invalid updates without partially changing other fields", async () => {
    const t = await create(dw);
    refusal(await update(dw, t, { message: "must roll back", downloadLimit: 0 }), 400);
    expect((await get(dw, t)).message).toBe("A short delivery note");
  });
});

describe("revoke and cleanup", () => {
  it("revokes immediately, retains owner read access and counts no denied request", async () => {
    const t = await create(dw);
    expect((await revoke(dw, t)).status).toBe(200);
    expect((await dw.call(siteFile(t))).status).toBe(410);
    expect((await get(dw, t)).files.map((f) => f.downloads)).toEqual([0, 0]);
    refusal(await update(dw, t, { message: "cannot revive" }), 409);
  });

  it("bulk revokes named transfers only and returns the changed count", async () => {
    const a = await create(dw, { slug: "parcel-a" });
    const b = await create(dw, { slug: "parcel-b" });
    const c = await create(dw, { slug: "parcel-c" });
    const r = await op(dw, "revoke_transfers", { ids: [a.id, b.id] });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect((await dw.call(siteFile(a))).status).toBe(410);
    expect((await dw.call(siteFile(b))).status).toBe(410);
    expect((await dw.call(siteFile(c))).status).toBe(200);
  });

  it("bulk revokes all live caller-owned transfers, excluding closed and foreign ones", async () => {
    const a = await create(dw, { slug: "parcel-a" });
    const b = await create(dw, { slug: "parcel-b" });
    const closed = await create(dw, { slug: "parcel-closed" });
    await state(closed, { expires_at: Date.now() - 1 });
    const other = await member(dw, "other-sender@example.net");
    const foreign = await create(dw, { slug: "parcel-foreign" }, other.key);
    const r = await op(dw, "revoke_transfers", { allLive: true });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect((await dw.call(siteFile(a))).status).toBe(410);
    expect((await dw.call(siteFile(b))).status).toBe(410);
    expect((await dw.call(siteFile(foreign))).status).toBe(200);
  });

  it("allows exactly one winner when revoke races an update", async () => {
    const t = await create(dw);
    const [changed, revoked] = await Promise.all([update(dw, t, { message: "racing edit" }), revoke(dw, t)]);
    expect([changed.status, revoked.status].sort()).toEqual([200, 409]);
    const saved = await get(dw, t);
    if (revoked.status === 200) {
      expect(saved.message).toBe("A short delivery note");
      expect((await dw.call(siteFile(t))).status).toBe(410);
    } else {
      expect(saved.message).toBe("racing edit");
      expect((await dw.call(siteFile(t))).status).toBe(200);
    }
  });

  it("claims expired transfers once per deadline, even under a hold", async () => {
    const t = await create(dw);
    await state(t, { expires_at: Date.now() - 1, legal_hold: 1 });
    const first = await sweep(dw);
    const second = await sweep(dw);
    expect(first.expiredTransfers).toBe(1);
    expect(second.expiredTransfers).toBe(0);
    expect((await dw.call(siteFile(t))).status).toBe(410);
    expect((await get(dw, t)).id).toBe(t.id);
    expect(await storedFileCount(t), "a hold fences byte purge, never expiry").toBe(2);
  });

  it("does not claim transfers at the exact expiry instant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const deadline = Date.now() + HOUR;
    const t = await create(dw, { expiresAt: deadline });
    vi.setSystemTime(deadline);
    expect((await sweep(dw)).expiredTransfers).toBe(0);
    expect((await dw.call(siteFile(t))).status).toBe(200);
    vi.setSystemTime(deadline + 1);
    expect((await sweep(dw)).expiredTransfers).toBe(1);
    expect((await sweep(dw)).expiredTransfers).toBe(0);
  });

  it("releases storage usage once at purge, never on revoke", async () => {
    const t = await create(dw);
    expect(await storageUsage()).toBe(53);
    expect((await revoke(dw, t)).status).toBe(200);
    expect(await storageUsage()).toBe(53);
    // Move past the retention window without timers controlling I/O.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 366 * DAY);
    await sweep(dw);
    expect(await storageUsage()).toBe(0);
    await sweep(dw);
    expect(await storageUsage()).toBe(0);
  });
});

describe("password proof and unlock invalidation", () => {
  it("stores a digest compatible with the password-site KDF, never plaintext", async () => {
    const t = await create(dw, { password: PASSWORD });
    const digest = await passwordDigest(t);
    expect(digest).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, digest)).toBe(true);
    expect(await verifyPassword("wrong-delivery-password", digest)).toBe(false);
    expect(JSON.stringify(await get(dw, t))).not.toContain(PASSWORD);
    expect(JSON.stringify(await get(dw, t))).not.toContain(digest);
  });

  it.each(["changed-delivery-password", ""])("requires current proof in the same call for password replacement %#", async (password) => {
    const t = await create(dw, { password: PASSWORD });
    proofRefused(await update(dw, t, { password }));
    proofRefused(await update(dw, t, { password, currentPassword: "wrong-proof" }));
    expect((await update(dw, t, { password, currentPassword: PASSWORD })).status).toBe(200);
    expect((await dw.call(siteFile(t), { headers: { Accept: "application/json" } })).status).toBe(password ? 403 : 200);
  });

  it("an earlier browser unlock cannot stand in for same-call current-password proof", async () => {
    const t = await create(dw, { password: PASSWORD });
    const grant = await unlock(dw, t, PASSWORD);
    expect([200, 302, 303]).toContain(grant.status);
    const cookie = cookies(grant);
    expect((await dw.call(siteFile(t), { headers: { Cookie: cookie } })).status).toBe(200);
    const change = await op(dw, "update_transfer", { ...ref(t), password: "changed-delivery-password" }, dw.ownerKey, { Cookie: cookie });
    proofRefused(change);
  });

  it("invalidates every old unlock after changing the password digest", async () => {
    const t = await create(dw, { password: PASSWORD });
    const oldCookie = cookies(await unlock(dw, t, PASSWORD));
    expect((await dw.call(siteFile(t), { headers: { Cookie: oldCookie } })).status).toBe(200);
    expect((await update(dw, t, { password: "changed-delivery-password", currentPassword: PASSWORD })).status).toBe(200);
    expect((await dw.call(siteFile(t), { headers: { Cookie: oldCookie, Accept: "application/json" } })).status).toBe(403);
    const freshCookie = cookies(await unlock(dw, t, "changed-delivery-password"));
    expect((await dw.call(siteFile(t), { headers: { Cookie: freshCookie } })).status).toBe(200);
    proofRefused(await update(dw, t, { password: "", currentPassword: PASSWORD }));
  });

  it("rate limits repeated unlock attempts for one IP across transfers", async () => {
    const a = await create(dw, { password: PASSWORD, slug: "locked-a" });
    const b = await create(dw, { password: PASSWORD, slug: "locked-b" });
    let limited: Response | undefined;
    for (let i = 0; i < 200; i++) {
      const r = await unlock(dw, i % 2 ? a : b, "wrong-password", "192.0.2.81");
      if (r.status === 429) { limited = r; break; }
      expect([400, 401, 403]).toContain(r.status);
    }
    expect(limited, "finite per-IP unlock budget").toBeDefined();
    expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);
    const untouched = await create(dw, { password: PASSWORD, slug: "locked-c" });
    expect((await unlock(dw, untouched, PASSWORD, "192.0.2.81")).status).toBe(429);
    const fresh = await unlock(dw, untouched, PASSWORD, "192.0.2.82");
    expect([200, 302, 303]).toContain(fresh.status);
  });

  it("rate limits a transfer even when every attempt changes IP", async () => {
    const t = await create(dw, { password: PASSWORD });
    let limited: Response | undefined;
    for (let i = 1; i < 200; i++) {
      const r = await unlock(dw, t, "wrong-password", `198.51.100.${i}`);
      if (r.status === 429) { limited = r; break; }
      expect([400, 401, 403]).toContain(r.status);
    }
    expect(limited, "finite per-transfer unlock budget independent of IP").toBeDefined();
    expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);
    const other = await create(dw, { password: PASSWORD, slug: "untouched-transfer" });
    expect([200, 302, 303]).toContain((await unlock(dw, other, PASSWORD, "192.0.2.83")).status);
  });
});

describe("permanent sender-owned slug tombstones", () => {
  it("reserves a renamed slug against other senders but permits its original sender to reuse it", async () => {
    const alice = await member(dw, "sender-a@example.net");
    const bob = await member(dw, "sender-b@example.net");
    const t = await create(dw, { slug: "reserved-parcel" }, alice.key);
    const rename = await op(dw, "rename_site", { site: t.slug, slug: "renamed-parcel" }, alice.key);
    expect(rename.status).toBe(200);
    refusal(await op(dw, "create_transfer", input({ slug: "reserved-parcel" }), bob.key), 409);
    const reused = await create(dw, { slug: "reserved-parcel" }, alice.key);
    expect(reused.slug).toBe("reserved-parcel");
  });

  it("also fences ordinary publishing and renaming into another sender's tombstone", async () => {
    const alice = await member(dw, "sender-a@example.net");
    const bob = await member(dw, "sender-b@example.net");
    const t = await create(dw, { slug: "reserved-parcel" }, alice.key);
    expect((await op(dw, "rename_site", { site: t.slug, slug: "renamed-parcel" }, alice.key)).status).toBe(200);
    refusal(await op(dw, "publish_site", { slug: "reserved-parcel", files: FILES }, bob.key), 409);
    const other = await create(dw, { slug: "other-parcel" }, bob.key);
    refusal(await op(dw, "rename_site", { site: other.slug, slug: "reserved-parcel" }, bob.key), 409);
    expect((await dw.call(siteFile(other))).status).toBe(200);
  });

  it("lets the original sender reuse their deleted transfer's slug", async () => {
    const alice = await member(dw, "sender-a@example.net");
    const t = await create(dw, { slug: "reusable-parcel" }, alice.key);
    const deleted = await op(dw, "delete_site", { site: t.slug, confirm: t.slug }, alice.key);
    expect([200, 204]).toContain(deleted.status);
    const reused = await create(dw, { slug: "reusable-parcel" }, alice.key);
    expect(reused.id).not.toBe(t.id);
    expect(reused.slug).toBe("reusable-parcel");
  });

  it("keeps the tombstone after transfer purge and member deletion", async () => {
    const alice = await member(dw, "sender-a@example.net");
    const bob = await member(dw, "sender-b@example.net");
    const t = await create(dw, { slug: "permanent-parcel" }, alice.key);
    const deleted = await op(dw, "delete_site", { site: t.slug, confirm: t.slug }, alice.key);
    expect([200, 204]).toContain(deleted.status);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 366 * DAY);
    await sweep(dw);
    const removed = await dw.call(`/api/v1/members/${alice.id}`, { method: "DELETE", key: dw.ownerKey });
    expect(removed.status).toBe(200);
    refusal(await op(dw, "create_transfer", input({ slug: "permanent-parcel" }), bob.key), 409);
    expect((await dw.call(siteFile(t))).status).toBe(404);
  });
});
