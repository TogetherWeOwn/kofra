import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "@kofra/core";
import { form, ORIGIN, type Instance } from "./helpers";
import {
  attributeUrl, cookies, create, DAY, FILES, get, instance, op, PASSWORD, passwordDigest,
  recipientFile, refusal, SITES, siteFile, state, storageUsage, storedFileCount,
  sweep, unlock, update, type Transfer,
} from "./transfer-fixtures";

// Independent acceptance: no implementation diff or private predecessor was read.
// Each block names its break: cross-host cookie reliance, lifecycle bypass,
// lost-update/digest side effects, over-counting, or purge crossing a hold.
let dw: Instance;
beforeEach(async () => { dw = await instance(); });
afterEach(() => { vi.useRealTimers(); });

describe("password unlock across app and sites origins", () => {
  it.each(["general", "recipient"])("downloads the %s page's rendered link with no app cookie on the sites request", async (kind) => {
    const t = await create(dw, { password: PASSWORD });
    const pageUrl = kind === "recipient" ? t.recipients[0]!.url : t.url;
    expect(new URL(pageUrl).origin).toBe(ORIGIN);
    const grant = await unlock(dw, { ...t, url: pageUrl }, PASSWORD);
    expect([200, 302, 303]).toContain(grant.status);
    const appCookie = cookies(grant);
    // Browsers cannot send an app-origin host-only cookie to SITES. Only the
    // app request receives it; the actual rendered file link must stand alone.
    let url = pageUrl;
    let page: Response | undefined;
    for (let i = 0; i < 4; i++) {
      expect(new URL(url).origin).toBe(ORIGIN);
      page = await dw.call(url, { headers: { Cookie: appCookie, Accept: "text/html" } });
      if (![301, 302, 303, 307, 308].includes(page.status)) break;
      expect(page.headers.get("location")).toBeTruthy();
      url = new URL(page.headers.get("location")!, url).href;
    }
    expect(page!.status).toBe(200);
    const links: string[] = [];
    await new HTMLRewriter().on("a[href]", {
      element(e) { links.push(attributeUrl(e.getAttribute("href")!, url)); },
    }).transform(page!).text();
    const file = links.find((link) => new URL(link).origin === SITES && new URL(link).pathname.endsWith("/notes.txt"));
    expect(file, "the unlocked page must render an authorized sites-host download").toBeDefined();
    expect((await dw.call(siteFile(t), { headers: { Accept: "application/json" } })).status).toBe(403);
    const download = await dw.call(file!); // Intentionally NO Cookie or Authorization.
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment(?:;|$)/i);
    expect(await download.text()).toBe(FILES[0]!.content);
    const saved = await get(dw, t);
    expect(saved.files.map((f) => f.downloads)).toEqual([1, 0]);
    expect(saved.recipients.map((r) => r.downloads)).toEqual(kind === "recipient" ? [1] : [0]);
    // A copied link is digest-bound too; changing the password revokes it.
    expect((await update(dw, t, { password: "replacement-delivery-password", currentPassword: PASSWORD })).status).toBe(200);
    expect((await dw.call(file!, { headers: { Accept: "application/json" } })).status).toBe(403);
    expect((await get(dw, t)).files.map((f) => f.downloads)).toEqual([1, 0]);
  });
});

const conditions: Record<string, () => Record<string, number>> = {
  expired: () => ({ expires_at: Date.now() - 1 }),
  revoked: () => ({ revoked_at: Date.now() }),
  notified: () => ({ notified_at: Date.now() }),
  held: () => ({ legal_hold: 1 }),
  "taken down": () => ({ takedown_at: Date.now() }),
};
const replacements = [{ path: "notes.txt", content: "unauthorized replacement", contentType: "text/plain" }];
const bypasses: Array<{ name: string; call: (t: Transfer, version: string) => ReturnType<Instance["json"]> }> = [
  { name: "publish_site", call: (t) => op(dw, "publish_site", { site: t.slug, files: replacements }) },
  { name: "multipart publish", call: (t) => dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "notes.txt": "unauthorized replacement" }, { slug: t.slug }) }) },
  { name: "update_site_files", call: (t) => op(dw, "update_site_files", { slug: t.slug, files: replacements }) },
  { name: "update_site_settings", call: (t) => op(dw, "update_site_settings", { slug: t.slug, password: null, title: "unauthorized edit" }) },
  { name: "set_site_access", call: (t) => op(dw, "set_site_access", { slug: t.slug, mode: "public" }) },
  { name: "restore_version", call: (t, id) => op(dw, "restore_version", { slug: t.slug, id }) },
];

describe("ordinary site routes cannot bypass transfer lifecycle guards", () => {
  for (const [condition, fields] of Object.entries(conditions)) {
    it.each(bypasses)(`refuses $name when ${condition} without changing bytes or password`, async ({ call }) => {
      const t = await create(dw, { password: PASSWORD });
      const versions = await op(dw, "list_versions", { slug: t.slug });
      expect(versions.status).toBe(200);
      expect(versions.body.versions).toHaveLength(1);
      const version = versions.body.versions[0].id;
      const digest = await passwordDigest(t);
      await state(t, fields());
      refusal(await call(t, version), 409);
      const after = await op(dw, "list_versions", { slug: t.slug });
      expect(after.status).toBe(200);
      expect(after.body.versions.map((v: { id: string }) => v.id)).toEqual([version]);
      expect(await passwordDigest(t)).toBe(digest);
      expect(await storedFileCount(t)).toBe(2);
      const saved = await get(dw, t);
      expect(saved.message).toBe("A short delivery note");
      expect(saved.files.map((f) => f.downloads)).toEqual([0, 0]);
    });
  }

  it("refuses ordinary deletion while a legal hold protects the transfer", async () => {
    const t = await create(dw);
    await state(t, { legal_hold: 1 });
    refusal(await op(dw, "delete_site", { site: t.slug, confirm: t.slug }), 409);
    expect((await get(dw, t)).id).toBe(t.id);
    expect(await storedFileCount(t)).toBe(2);
  });

  it.each([
    { name: "settings", call: (t: Transfer) => op(dw, "update_site_settings", { slug: t.slug, password: null }) },
    { name: "access", call: (t: Transfer) => op(dw, "set_site_access", { slug: t.slug, mode: "public" }) },
  ])("cannot clear a live transfer password through $name without same-call proof", async ({ call }) => {
    const t = await create(dw, { password: PASSWORD });
    const digest = await passwordDigest(t);
    const denied = await call(t);
    expect([400, 403, 409, 422]).toContain(denied.status);
    refusal(denied, denied.status);
    expect(await passwordDigest(t)).toBe(digest);
    expect((await dw.call(siteFile(t), { headers: { Accept: "application/json" } })).status).toBe(403);
  });
});

describe("atomic transfer concurrency", () => {
  it("never overwrites a winning edit or password digest when password replacement races an ordinary update", async () => {
    const t = await create(dw, { password: PASSWORD });
    const nextPassword = "concurrent-delivery-password";
    const [password, message] = await Promise.all([
      update(dw, t, { password: nextPassword, currentPassword: PASSWORD, message: "password winner" }),
      update(dw, t, { message: "message winner" }),
    ]);
    expect([password.status, message.status].sort()).toEqual([200, 409]);
    const passwordWon = password.status === 200;
    expect((await get(dw, t)).message).toBe(passwordWon ? "password winner" : "message winner");
    const digest = await passwordDigest(t);
    expect(await verifyPassword(passwordWon ? nextPassword : PASSWORD, digest)).toBe(true);
    expect(await verifyPassword(passwordWon ? PASSWORD : nextPassword, digest)).toBe(false);
  });

  it("allows only one of two password replacements using the same old proof", async () => {
    const t = await create(dw, { password: PASSWORD });
    const passwords = ["first-concurrent-password", "second-concurrent-password"];
    const results = await Promise.all(passwords.map((password, i) => update(dw, t, {
      password, currentPassword: PASSWORD, message: `password edit ${i}`,
    })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const winner = results.findIndex((r) => r.status === 200);
    const loser = results[1 - winner]!;
    expect([400, 403, 409, 422]).toContain(loser.status);
    refusal(loser, loser.status);
    expect((await get(dw, t)).message).toBe(`password edit ${winner}`);
    const digest = await passwordDigest(t);
    expect(await verifyPassword(passwords[winner]!, digest)).toBe(true);
    expect(await verifyPassword(passwords[1 - winner]!, digest)).toBe(false);
    expect(await verifyPassword(PASSWORD, digest)).toBe(false);
  });

  it("admits exactly one concurrent download across recipient links and files at limit one", async () => {
    const t = await create(dw, { downloadLimit: 1, recipients: ["first@example.net", "second@example.net"] });
    const links = [await recipientFile(dw, t, 0), await recipientFile(dw, t, 1, "page.html")];
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => dw.call(links[i % 2]!)));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 410, 410, 410, 410, 410]);
    const winner = responses.findIndex((r) => r.status === 200);
    expect(await responses[winner]!.text()).toBe(FILES[winner % 2]!.content);
    const saved = await get(dw, t);
    expect(saved.files.map((f) => f.downloads)).toEqual(winner % 2 === 0 ? [1, 0] : [0, 1]);
    expect(saved.recipients.map((r) => r.downloads)).toEqual(winner % 2 === 0 ? [1, 0] : [0, 1]);
    expect((await dw.call(links[0]!)).status).toBe(410);
    expect((await get(dw, t)).files.map((f) => f.downloads)).toEqual(saved.files.map((f) => f.downloads));
  });
});

describe("holds at the actual purge boundary", () => {
  it.each(["expired", "deleted"])("retains %s bytes and storage usage past retention until the hold is released", async (condition) => {
    const t = await create(dw);
    if (condition === "deleted") expect((await op(dw, "delete_site", { site: t.slug, confirm: t.slug })).status).toBe(200);
    await state(t, { legal_hold: 1, ...(condition === "expired" ? { expires_at: Date.now() - 1 } : {}) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 366 * DAY);
    await sweep(dw);
    await sweep(dw);
    expect((await dw.call(siteFile(t))).status).toBe(condition === "expired" ? 410 : 404);
    expect(await storedFileCount(t)).toBe(2);
    expect(await storageUsage()).toBe(53);
    await state(t, { legal_hold: 0 });
    await sweep(dw);
    expect(await storedFileCount(t)).toBe(0);
    expect(await storageUsage()).toBe(0);
    await sweep(dw);
    expect(await storageUsage()).toBe(0);
  });
});
