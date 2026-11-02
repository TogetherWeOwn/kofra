// Acceptance-owned delivery-page hardening (TOG-39593, TRANSFER-PAGES / R-52
// completion). Written from the card spec before any page implementation
// exists: honest no-scan disclosure, usable HTML password/rate-limit/unavailable
// errors with a JSON matrix for API clients, download-allowance display with a
// zero-new-query proof, no-JS rendering and escaping.
//
// PROTECTED: the Builder builds on this exact pushed branch and never edits
// this file. RED contract: disclosure, browser HTML errors (wrong password,
// rate-limited, unavailable), the "N of M downloads used" line, the
// zero-new-query line presence, and unlimited wording fail now; the JSON
// matrix, retention (sha/type/size/expiry), banned-claim absence, no-JS shape
// and escaping controls pass now. Only this repo's test-owned fixtures and
// reserved example domains/documentation IPs are used; no legacy
// implementation, fixture, account, host or test literal was copied.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@kofra/core";
import { ORIGIN, type Instance } from "./helpers";
import { request } from "./delivery-review-fixtures";
import { create, FILES, instance, siteFile, unlock } from "./transfer-fixtures";

const PASSWORD = "delivery-page-passphrase";
const WRONG_PASSWORD = "wrong-delivery-password";

let dw: Instance;
beforeEach(async () => { dw = await instance(); });
afterEach(() => { vi.useRealTimers(); });

/** Post the real rendered password form, like a browser would. */
async function postForm(
  dw: Instance,
  pageUrl: string,
  password: string,
  accept: string,
  ip: string,
  bindings: { DB?: D1Database } = {},
): Promise<{ action: string; res: Response }> {
  const page = await dw.call(pageUrl, { headers: { Accept: "text/html" } });
  expect(page.headers.get("content-type")).toContain("text/html");
  let action: string | null = null;
  await new HTMLRewriter().on("form", {
    element(e) { action = e.getAttribute("action"); },
  }).transform(page).text();
  expect(action, "locked delivery must render a password form").toBeTruthy();
  const target = new URL(action!, pageUrl).href;
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: ORIGIN,
      Accept: accept,
      "CF-Connecting-IP": ip,
    },
    body: new URLSearchParams({ password }),
  };
  const res = Object.keys(bindings).length ? await request(dw, target, init, bindings) : await dw.call(target, init);
  return { action: target, res };
}

async function fileDigests(): Promise<string[]> {
  return Promise.all(FILES.map((f) => sha256Hex(new TextEncoder().encode(f.content))));
}

/** Fail the unlock counter closed, keeping routing, gates and KDF real. */
function unavailableBucketsDb(): D1Database {
  const faulted = (raw: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(raw, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => faulted(target.bind(...values));
        if (property === "first") return async () => null;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => (/transfer_unlock_buckets/i.test(sql) ? faulted(target.prepare(sql)) : target.prepare(sql));
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function countingDb(counter: { statements: number }): D1Database {
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          counter.statements++;
          return target.prepare(sql);
        };
      }
      if (property === "batch") {
        return async (batch: D1PreparedStatement[]) => {
          counter.statements += batch.length;
          return target.batch(batch);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("honest trust disclosure on delivery pages", () => {
  it("states plainly next to the file list that Kofra does not scan files", async () => {
    const t = await create(dw, { slug: "disclosed-parcel" });
    const page = await dw.call(t.url, { headers: { Accept: "text/html" } });
    expect(page.status).toBe(200);
    const html = await page.text();
    const disclosure = html.match(/Kofra does not scan files/i);
    expect(disclosure, "delivery page must plainly disclose that Kofra does not scan files").toBeTruthy();
    const listAt = html.indexOf("<ul");
    expect(listAt, "file list must be a list").toBeGreaterThan(-1);
    expect(
      Math.abs(html.indexOf(disclosure![0]) - listAt),
      "disclosure must sit next to the file list, not buried far away",
    ).toBeLessThan(2000);
  });

  it("retains per-file sha, type, size and expiry", async () => {
    const t = await create(dw, { slug: "retained-parcel" });
    const page = await dw.call(t.url, { headers: { Accept: "text/html" } });
    expect(page.status).toBe(200);
    const html = await page.text();
    const digests = await fileDigests();
    for (const [i, f] of FILES.entries()) {
      expect(html).toContain(f.path);
      expect(html).toContain(String(new TextEncoder().encode(f.content).length));
      expect(html).toContain(f.contentType);
      expect(html).toContain(digests[i]);
    }
    expect(html).toContain("Available until");
    expect(html).toContain(new Date(t.expiresAt).toISOString());
  });

  it("never claims files are scanned or virus-free", async () => {
    const t = await create(dw, { slug: "honest-parcel" });
    const page = await dw.call(t.url, { headers: { Accept: "text/html" } });
    expect(await page.text()).not.toMatch(/scanned|scanning|virus-free|virus free/i);
  });
});

describe("wrong-password errors: HTML for browsers, JSON for API clients", () => {
  it("browser POST re-renders the password form (403) with an actionable message and preserved recipient context", async () => {
    const t = await create(dw, { slug: "locked-parcel", password: PASSWORD });
    const recipientUrl = t.recipients[0]!.url;
    const token = new URL(recipientUrl).searchParams.get("recipient");
    expect(token, "fixture must use a real recipient link").toBeTruthy();
    const { action, res } = await postForm(dw, recipientUrl, WRONG_PASSWORD, "text/html", "192.0.2.90");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toMatch(/<form[^>]*method=["']post["']/i);
    expect(html).toMatch(/<input[^>]+type=["']password["']/i);
    expect(html, "message must name the failure").toMatch(/incorrect|wrong/i);
    expect(html, "message must say what to do next").toMatch(/try again|ask the sender/i);
    expect(html).not.toContain("<script");
    expect(new URL(action).searchParams.get("recipient"), "re-rendered form must preserve recipient context").toBe(token);
  });

  it("non-HTML Accept still receives the existing transfer_locked JSON", async () => {
    const t = await create(dw, { slug: "locked-api-parcel", password: PASSWORD });
    const { res } = await postForm(dw, t.url, WRONG_PASSWORD, "application/json", "192.0.2.91");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("transfer_locked");
    expect(body.error.hint.length).toBeGreaterThan(0);
  });

  it("wrong-password HTML reveals nothing new: identical shape across deliveries, no delivery content", async () => {
    const a = await create(dw, { slug: "locked-alfa", password: PASSWORD, message: "message-alfa-canary" });
    const b = await create(dw, { slug: "locked-bravo", password: PASSWORD, message: "message-bravo-canary" });
    const digests = await fileDigests();
    const pages: string[] = [];
    for (const t of [a, b]) {
      const { res } = await postForm(dw, t.url, WRONG_PASSWORD, "text/html", "192.0.2.92");
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("text/html");
      pages.push(await res.text());
    }
    for (const html of pages) {
      expect(html).toMatch(/incorrect|wrong/i);
      expect(html).toMatch(/try again|ask the sender/i);
      for (const secret of ["message-alfa-canary", "message-bravo-canary", "reader@example.net", ...digests]) {
        expect(html, "failed unlock must not leak delivery content").not.toContain(secret);
      }
    }
  });

  it("an invalid recipient stays 404, identical for unknown slugs", async () => {
    const t = await create(dw, { slug: "recipient-parcel", password: PASSWORD });
    const unknown = await dw.call(`${ORIGIN}/t/never-created-parcel`, { headers: { Accept: "application/json" } });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as any).error.code).toBe("transfer_not_found");
    const badRecipient = await dw.call(`${t.url}?recipient=dwr_bogus-token`, { headers: { Accept: "application/json" } });
    expect(badRecipient.status).toBe(404);
    expect(((await badRecipient.json()) as any).error.code).toBe("transfer_not_found");
    const posted = await dw.call(`${t.url}?recipient=dwr_bogus-token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Accept: "text/html", "CF-Connecting-IP": "192.0.2.93" },
      body: new URLSearchParams({ password: WRONG_PASSWORD }),
    });
    expect(posted.status, "a bogus recipient must not reach password checking").toBe(404);
  });
});

describe("rate-limited and unavailable unlocks", () => {
  async function exhaustIpBudget() {
    const a = await create(dw, { slug: "limited-a", password: PASSWORD });
    const b = await create(dw, { slug: "limited-b", password: PASSWORD });
    let limited: Response | undefined;
    for (let i = 0; i < 60 && !limited; i++) {
      const probe = await unlock(dw, i % 2 ? a : b, WRONG_PASSWORD, "192.0.2.94");
      if (probe.status === 429) limited = probe;
      else expect([400, 401, 403]).toContain(probe.status);
      await probe.text().catch(() => {});
    }
    expect(limited, "finite per-IP unlock budget").toBeDefined();
    return { a, b };
  }

  it("rate-limited browser POST re-renders the form with a wait-and-retry message and Retry-After", async () => {
    const { a } = await exhaustIpBudget();
    const { res } = await postForm(dw, a.url, WRONG_PASSWORD, "text/html", "192.0.2.94");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after")), "Retry-After must survive the HTML render").toBeGreaterThan(0);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toMatch(/<form[^>]*method=["']post["']/i);
    expect(html).toMatch(/<input[^>]+type=["']password["']/i);
    expect(html).toMatch(/too many|rate.?limit/i);
    expect(html).toMatch(/wait/i);
    expect(html).toMatch(/try again|retry/i);
    expect(html).not.toContain("<script");
  });

  it("rate-limited API POST still receives rate_limited JSON with Retry-After", async () => {
    const { b } = await exhaustIpBudget();
    const { res } = await postForm(dw, b.url, WRONG_PASSWORD, "application/json", "192.0.2.94");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as any).error.code).toBe("rate_limited");
  });

  it("unlock-unavailable browser POST renders a retry-later page (503)", async () => {
    const t = await create(dw, { slug: "unavailable-parcel", password: PASSWORD });
    const { res } = await postForm(dw, t.url, PASSWORD, "text/html", "192.0.2.95", { DB: unavailableBucketsDb() });
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toMatch(/unavailable/i);
    expect(html).toMatch(/try again|retry/i);
    expect(html).toMatch(/later/i);
    expect(html).not.toContain("<script");
  });

  it("unlock-unavailable API POST still receives transfer_unlock_unavailable JSON, failing closed before password checks", async () => {
    const t = await create(dw, { slug: "unavailable-api-parcel", password: PASSWORD });
    const db = unavailableBucketsDb();
    for (const password of [PASSWORD, WRONG_PASSWORD]) {
      const { res } = await postForm(dw, t.url, password, "application/json", "192.0.2.96", { DB: db });
      expect(res.status, "an unavailable counter refuses even before checking the password").toBe(503);
      expect(((await res.json()) as any).error.code).toBe("transfer_unlock_unavailable");
    }
  });
});

describe("download allowance display", () => {
  it("shows N of M downloads used when a limit is set", async () => {
    const t = await create(dw, { slug: "counted-parcel", downloadLimit: 4 });
    expect((await dw.call(siteFile(t))).status).toBe(200);
    const page = await dw.call(t.url, { headers: { Accept: "text/html" } });
    expect(page.status).toBe(200);
    const html = await page.text();
    const used = html.match(/(\d+)\s+of\s+(\d+)\s+downloads?\s+used/i);
    expect(used, "limited delivery must show downloads used").toBeTruthy();
    expect([used![1], used![2]]).toEqual(["1", "4"]);
    expect(html).not.toMatch(/unlimited/i);
    expect(html).toContain("Available until");
  });

  it("shows the allowance from already-fetched state: zero new queries", async () => {
    const unlimited = await create(dw, { slug: "parcel-unlimited" });
    const limited = await create(dw, { slug: "parcel-limited", downloadLimit: 4 });
    const render = async (url: string) => {
      const counter = { statements: 0 };
      const res = await request(dw, url, { headers: { Accept: "text/html" } }, { DB: countingDb(counter) });
      expect(res.status).toBe(200);
      return { html: await res.text(), queries: counter.statements };
    };
    const plain = await render(unlimited.url);
    const counted = await render(limited.url);
    expect(plain.queries, "query counting must observe the real page path").toBeGreaterThan(0);
    expect(counted.html, "limited delivery must show its allowance (non-vacuous zero-query proof)").toMatch(/0\s+of\s+4\s+downloads?\s+used/i);
    expect(counted.queries, "allowance display must add zero D1 statements").toBe(plain.queries);
  });

  it("uses unlimited wording otherwise", async () => {
    const t = await create(dw, { slug: "uncounted-parcel" });
    const page = await dw.call(t.url, { headers: { Accept: "text/html" } });
    const html = await page.text();
    expect(html).toMatch(/unlimited downloads/i);
    expect(html).not.toMatch(/\d+\s+of\s+\d+\s+downloads?\s+used/i);
    expect(html).toContain("Available until");
    expect(html).toContain(new Date(t.expiresAt).toISOString());
  });
});

describe("no-JS rendering and escaping", () => {
  it("unlocked and locked pages work with JS disabled", async () => {
    const open = await create(dw, { slug: "nojs-open-parcel" });
    const locked = await create(dw, { slug: "nojs-locked-parcel", password: PASSWORD });
    const unlocked = await dw.call(open.url, { headers: { Accept: "text/html" } });
    expect(unlocked.status).toBe(200);
    const unlockedHtml = await unlocked.text();
    expect(unlockedHtml).not.toMatch(/<script/i);
    expect(unlockedHtml).not.toMatch(/\son[a-z]+\s*=/i);
    expect(unlockedHtml.match(/<a[^>]+href=/gi)!.length, "files must be plain links").toBeGreaterThanOrEqual(2);
    const gate = await dw.call(locked.url, { headers: { Accept: "text/html" } });
    expect(gate.status).toBe(403);
    expect(gate.headers.get("content-security-policy")).toContain("default-src 'none'");
    const gateHtml = await gate.text();
    expect(gateHtml).not.toMatch(/<script/i);
    expect(gateHtml).not.toMatch(/\son[a-z]+\s*=/i);
    expect(gateHtml).toMatch(/<form[^>]*method=["']post["']/i);
    expect(gateHtml).toMatch(/<input[^>]+type=["']password["']/i);
  });

  it("message and filename payloads are escaped, never executed", async () => {
    const message = `<img src=x onerror="alert(7)"><script>bad()</script> & 'quotes' "q"`;
    const hostile = `x<img src=x onerror="alert(9)">y.txt`;
    const t = await create(dw, {
      slug: "escaped-parcel",
      message,
      files: [{ path: hostile, content: "hostile bytes", contentType: "text/plain" }],
    });
    const page = await dw.call(t.url, { headers: { Accept: "text/html" } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain(message);
    expect(html).not.toContain("<script>bad()");
    expect(html).not.toContain(hostile);
    expect(html).not.toContain(`<img src=x onerror="alert(9)">`);
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
    expect(html).not.toMatch(/<script/i);
  });
});
