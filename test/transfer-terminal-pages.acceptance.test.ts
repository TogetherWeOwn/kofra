// Terminal delivery states render as browser pages (TWO-1119, finding B1).
// Browser navigations (Accept: text/html) to /t/{slug} and delivery file URLs
// get the standard system page with recipient-safe copy in every terminal
// state; API callers keep byte-identical JSON. Limit-reached (410, same code)
// gets its own page when the state is known.
import { beforeEach, describe, expect, it } from "vitest";
import { ORIGIN, type Instance } from "./helpers";
import { create, instance, revoke, SITES, siteFile, state } from "./transfer-fixtures";

const GONE = {
  status: 410,
  title: "This delivery is no longer available",
  body: "It has expired or the sender withdrew it. Ask the sender to send the files again — this link can't be reopened.",
};
const LIMITED = {
  status: 410,
  title: "This delivery has reached its download limit",
  body: "Ask the sender to send the files again if you still need them.",
};
const TAKEN_DOWN = {
  status: 451,
  title: "This delivery is unavailable",
  body: "Contact the sender if you expected to receive files here.",
};
const NOT_FOUND = {
  status: 404,
  title: "We couldn't find that delivery",
  body: "Check that you opened the complete link the sender gave you — it is long, and mail apps sometimes break it across lines. If it still doesn't work, ask the sender for a new link.",
};

const GONE_JSON = {
  status: 410,
  code: "transfer_gone",
  message: "This delivery is no longer available.",
  hint: "Ask the sender for a new delivery.",
};
const TAKEN_DOWN_JSON = {
  status: 451,
  code: "transfer_unavailable",
  message: "This delivery is unavailable.",
  hint: "Contact the sender.",
};
const NOT_FOUND_JSON = {
  status: 404,
  code: "transfer_not_found",
  message: "No transfer available to this caller.",
  hint: "Check the transfer reference and use its sender's key.",
};

let dw: Instance;
beforeEach(async () => { dw = await instance(); });

/** Page copy is HTML-escaped on the way out; match what the browser receives. */
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function expectPage(url: string, expected: { status: number; title: string; body: string }) {
  const res = await dw.call(url, { headers: { Accept: "text/html" } });
  expect(res.status).toBe(expected.status);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  expect(html).toContain(`<title>${esc(expected.title)}</title>`);
  expect(html).toContain(`<h1>${esc(expected.title)}</h1>`);
  expect(html).toContain(esc(expected.body));
  // Recipient pages never name the error code or use the word "transfer",
  // carry no form and no retry button, and run no script.
  expect(html).not.toMatch(/transfer/i);
  expect(html).not.toMatch(/transfer_gone|transfer_unavailable|transfer_not_found/);
  expect(html).not.toMatch(/<form/i);
  expect(html).not.toMatch(/<script/i);
  return html;
}

async function expectJson(url: string, expected: { status: number; code: string; message: string; hint: string }, init: RequestInit = {}) {
  const res = await dw.call(url, { ...init, headers: { Accept: "application/json", ...(init.headers ?? {}) } });
  expect(res.status).toBe(expected.status);
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = (await res.json()) as any;
  expect(body.error.code).toBe(expected.code);
  expect(body.error.message).toBe(expected.message);
  expect(body.error.hint).toBe(expected.hint);
}

describe("delivery page route renders terminal states as pages", () => {
  it("revoked delivery page renders the gone page", async () => {
    const t = await create(dw, { slug: "terminal-revoked" });
    const r = await revoke(dw, t);
    expect(r.status).toBe(200);
    await expectPage(t.url, GONE);
  });

  it("expired delivery page renders the gone page", async () => {
    const t = await create(dw, { slug: "terminal-expired" });
    await state(t, { expires_at: Date.now() - 60_000 });
    await expectPage(t.url, GONE);
  });

  it("limit-reached delivery page names the download limit", async () => {
    const t = await create(dw, { slug: "terminal-limited", downloadLimit: 1 });
    expect((await dw.call(siteFile(t))).status).toBe(200);
    await expectPage(t.url, LIMITED);
  });

  it("taken-down delivery page stays neutral", async () => {
    const t = await create(dw, { slug: "terminal-takedown" });
    await state(t, { takedown_at: Date.now() });
    const html = await expectPage(t.url, TAKEN_DOWN);
    expect(html).not.toMatch(/reason|abuse|report/i);
  });

  it("unknown delivery page renders the not-found page", async () => {
    await expectPage(`${ORIGIN}/t/never-created-delivery`, NOT_FOUND);
  });

  it("unlock submit against a revoked delivery renders the gone page, not JSON", async () => {
    const t = await create(dw, { slug: "terminal-revoked-unlock", password: "delivery-page-passphrase" });
    const r = await revoke(dw, t);
    expect(r.status).toBe(200);
    const res = await dw.call(t.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: ORIGIN,
        Accept: "text/html",
        "CF-Connecting-IP": "192.0.2.77",
      },
      body: new URLSearchParams({ password: "delivery-page-passphrase" }),
    });
    expect(res.status).toBe(410);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`<h1>${esc(GONE.title)}</h1>`);
    expect(html).toContain(esc(GONE.body));
    expect(html).not.toMatch(/transfer/i);
    expect(html).not.toMatch(/<form/i);
  });
});

describe("delivery file URLs render terminal states as pages", () => {
  it("revoked file URL renders the gone page", async () => {
    const t = await create(dw, { slug: "terminal-file-revoked" });
    const r = await revoke(dw, t);
    expect(r.status).toBe(200);
    await expectPage(siteFile(t), GONE);
  });

  it("limit-reached file URL names the download limit", async () => {
    const t = await create(dw, { slug: "terminal-file-limited", downloadLimit: 1 });
    expect((await dw.call(siteFile(t))).status).toBe(200);
    await expectPage(siteFile(t), LIMITED);
  });

  it("taken-down file URL renders the unavailable page", async () => {
    const t = await create(dw, { slug: "terminal-file-takedown" });
    await state(t, { takedown_at: Date.now() });
    await expectPage(siteFile(t), TAKEN_DOWN);
  });

  it("unknown file path renders the not-found page", async () => {
    const t = await create(dw, { slug: "terminal-file-unknown" });
    await expectPage(siteFile(t, "nope.txt"), NOT_FOUND);
  });
});

describe("non-HTML callers keep byte-identical JSON", () => {
  it("page route keeps codes, statuses, messages and hints", async () => {
    const revoked = await create(dw, { slug: "terminal-json-revoked" });
    expect((await revoke(dw, revoked)).status).toBe(200);
    const expired = await create(dw, { slug: "terminal-json-expired" });
    await state(expired, { expires_at: Date.now() - 60_000 });
    const limited = await create(dw, { slug: "terminal-json-limited", downloadLimit: 1 });
    expect((await dw.call(siteFile(limited))).status).toBe(200);
    const takenDown = await create(dw, { slug: "terminal-json-takedown" });
    await state(takenDown, { takedown_at: Date.now() });

    await expectJson(revoked.url, GONE_JSON);
    await expectJson(expired.url, GONE_JSON);
    await expectJson(limited.url, GONE_JSON);
    await expectJson(takenDown.url, TAKEN_DOWN_JSON);
    await expectJson(`${ORIGIN}/t/never-created-delivery`, NOT_FOUND_JSON);
  });

  it("file route keeps codes, statuses, messages and hints", async () => {
    const revoked = await create(dw, { slug: "terminal-file-json-revoked" });
    expect((await revoke(dw, revoked)).status).toBe(200);
    const takenDown = await create(dw, { slug: "terminal-file-json-takedown" });
    await state(takenDown, { takedown_at: Date.now() });
    const live = await create(dw, { slug: "terminal-file-json-live" });

    await expectJson(siteFile(revoked), GONE_JSON);
    await expectJson(siteFile(takenDown), TAKEN_DOWN_JSON);
    await expectJson(siteFile(live, "nope.txt"), NOT_FOUND_JSON);
    // Unknown sites-origin slugs were never transfers; the sites 404 is untouched.
    const missing = await dw.call(`${SITES}/never-created-delivery/notes.txt`, { headers: { Accept: "application/json" } });
    expect(missing.status).toBe(404);
  });

  it("unlock submit against a revoked delivery keeps JSON for API callers", async () => {
    const t = await create(dw, { slug: "terminal-json-unlock", password: "delivery-page-passphrase" });
    expect((await revoke(dw, t)).status).toBe(200);
    await expectJson(t.url, GONE_JSON, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, "CF-Connecting-IP": "192.0.2.78" },
      body: new URLSearchParams({ password: "delivery-page-passphrase" }),
    });
  });
});
