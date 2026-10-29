/**
 * Dashboard restore / version-delete single-attempt intent-key acceptance (VM/DOM).
 *
 * Run: npm run test:cli -- test/encrypted/dashboard-restore-delete-intent-vm.acceptance.test.ts
 * (from packages/cli: node_modules/.bin/vitest run -c vitest.config.ts test/encrypted/dashboard-restore-delete-intent-vm.acceptance.test.ts)
 *
 * Blind acceptance from spec, no implementation diffs. Uses the real
 * Worker-served dashboard shell, hashed asset and boot payload executed in the
 * existing fake-DOM/Node VM harness. No source-string assertions: every
 * assertion observes fetch counts, headers, bodies, toasts and DOM.
 *
 * Contract pinned here:
 * - Each deliberate dashboard restore or version-delete click sends a fresh
 *   UUID Idempotency-Key.
 * - Exactly one fetch for 429/5xx/network/409: no silent resubmit, no extra
 *   pointer probe (no GET after the error), no synthetic success toast.
 * - An explicit later click after an error sends a new key/intent (distinct UUID).
 * - Canonical delete confirmation is still transmitted (query or body `confirm`
 *   equals the loaded canonical site.slug, even when the page was opened at a
 *   non-canonical path).
 *
 * This harness is NOT a browser: layout, native dialog modality, Tab traversal
 * and accessibility-tree requirements live in Chromium suites. Chromium
 * verification for this contract is a not-run gap (see final report).
 *
 * Expected behavioral RED against the current dashboard: restore and delete
 * send no Idempotency-Key, so every fresh-UUID assertion fails while the
 * harness controls (asset execution, Cancel without mutation) pass.
 */
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { FakeDocument, FakeElement } from "./dashboard-rename-vm-dom.helpers";
import { api, fixtureFetch, fixtureSite, origin, startWorker, stop, type Site } from "./dashboard-rename.helpers";

beforeAll(startWorker, 120_000);
afterAll(stop);
const cleanups: Array<() => void> = [];
const recordedViolations: string[][] = [];
afterEach(() => {
  try { for (const violations of recordedViolations.splice(0)) expect(violations, "no unexpected mutation or off-origin request").toEqual([]); }
  finally { for (const cleanup of cleanups.splice(0)) cleanup(); }
});

class Storage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
}
class TestURL extends URL {
  static override createObjectURL() { return "blob:fixture"; }
  static override revokeObjectURL() {}
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Write = { method: string; path: string; query: string; body: string | null; idempotencyKey: string | null };
type Read = { method: string; path: string; query: string };
type MutationReply = { status: number; body: unknown } | { network: true };
type VersionRow = { id: string; number: number; live?: boolean };
type Mounted = {
  doc: FakeDocument; root: FakeElement; site: Site; versions: VersionRow[];
  writes: Write[]; reads: Read[]; violations: string[]; location: { href: string };
  queueMutationReply: (reply: MutationReply) => void;
};

async function fixtureSiteWithHistory(count: number): Promise<Site> {
  const first: Site = await fixtureSite();
  for (let n = 2; n <= count; n++) {
    await api("/api/v1/publish", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: first.slug, files: [{ path: "index.html", content: `<h1>${first.slug} v${n}</h1>`, contentType: "text/html" }] }),
    });
  }
  const site: Site = await api(`/api/v1/sites/${first.slug}`);
  expect(site.slug).toBe(first.slug);
  return site;
}

async function mount(options: { historyCount?: number; nonCanonicalPath?: boolean } = {}): Promise<Mounted> {
  const historyCount = options.historyCount ?? 3;
  const site: Site = await fixtureSiteWithHistory(historyCount);
  const pathSlug = options.nonCanonicalPath ? site.slug.toUpperCase() : site.slug;
  const shell = await fixtureFetch(`/dashboard/sites/${encodeURIComponent(pathSlug)}`);
  expect(shell.status).toBe(200);
  const html = await shell.text();
  const asset = html.match(/<script\b[^>]*\bsrc="(\/__dropway\/ui\/app-[a-f0-9]+\.js)"[^>]*>/)?.[1];
  expect(asset, "find the real hashed asset in the served dashboard shell").toBeTruthy();
  const scriptResponse = await fixtureFetch(asset!);
  expect(scriptResponse.status).toBe(200);
  const script = await scriptResponse.text();
  const bootText = html.match(/<script\b(?=[^>]*\bid="dw-boot")[^>]*>([\s\S]*?)<\/script>/)?.[1];
  expect(bootText, "use the real served boot payload, not a guessed API shape").toBeTruthy();
  const bootData = JSON.parse(bootText!);
  expect(bootData.page?.name).toBe("site");
  expect(String(bootData.page?.slug ?? "").toLowerCase(), "boot payload names the disposable site").toBe(site.slug.toLowerCase());

  const versionsResponse = await fixtureFetch(`/api/v1/sites/${site.slug}/versions?limit=100`);
  expect(versionsResponse.status).toBe(200);
  const versionsBody = await versionsResponse.json() as { versions: VersionRow[]; currentVersionId: string | null };
  expect(versionsBody.versions.map(v => v.number).sort((a, b) => a - b)).toEqual([1, 2, 3].slice(0, historyCount));

  const doc = new FakeDocument();
  doc.body.setAttribute("data-page", "site");
  const boot = doc.createElement("script");
  boot.id = "dw-boot";
  boot.textContent = bootText!;
  doc.body.appendChild(boot);
  for (const id of ["dw-account", "dw-site", "dw-toasts"]) {
    const element = doc.createElement("div");
    element.id = id;
    doc.body.appendChild(element);
  }
  const storage = new Storage();
  storage.setItem("dropway.key", "disposable-vm-sign-in");
  const writes: Write[] = [];
  const reads: Read[] = [];
  const violations: string[] = [];
  recordedViolations.push(violations);
  const mutationReplies: MutationReply[] = [];
  const location = {
    origin, href: `${origin}/dashboard/sites/${encodeURIComponent(pathSlug)}`,
    pathname: `/dashboard/sites/${encodeURIComponent(pathSlug)}`, search: "",
    assign(value: string) { this.href = new URL(value, origin).href; },
    replace(value: string) { this.assign(value); },
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  cleanups.push(() => { for (const timer of timers) clearTimeout(timer); });
  const sandbox: Record<string, unknown> = {
    document: doc, sessionStorage: storage, localStorage: new Storage(), location,
    history: {
      pushState(_a: unknown, _b: unknown, value: string) { location.assign(value); },
      replaceState(_a: unknown, _b: unknown, value: string) { location.assign(value); },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    crypto: webcrypto, AbortController, TextEncoder, Request, Response,
    fetch: async (path: string, init: RequestInit = {}) => {
      const url = new URL(String(path), origin);
      if (url.origin !== origin) { violations.push("off-origin request"); throw Error("off-origin fixture request refused"); }
      const method = init.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        const headers = new Headers(init.headers);
        const record: Write = {
          method, path: url.pathname, query: url.search,
          body: typeof init.body === "string" ? init.body : null,
          idempotencyKey: headers.get("Idempotency-Key"),
        };
        writes.push(record);
        const match = /^\/api\/v1\/sites\/([^/]+)\/versions\/([^/]+)(\/restore)?$/.exec(url.pathname);
        const slugSeg = match ? decodeURIComponent(match[1]!) : "";
        const allowed = !!match && slugSeg.toLowerCase() === site.slug.toLowerCase()
          && ((!!match[3] && method === "POST") || (!match[3] && method === "DELETE"));
        if (!allowed) { violations.push(`${method} ${url.pathname}`); throw Error("unexpected fixture mutation"); }
        if (mutationReplies.length > 0) {
          const next = mutationReplies.shift()!;
          if ("network" in next) throw new Error("simulated network failure");
          return new Response(JSON.stringify(next.body), { status: next.status, headers: { "Content-Type": "application/json" } });
        }
        return fixtureFetch(url.href, init);
      }
      reads.push({ method, path: url.pathname, query: url.search });
      return fixtureFetch(url.href, init);
    },
    prompt: () => null, confirm: () => false, alert: () => {},
    Headers, URL: TestURL, URLSearchParams, Blob, console,
    setTimeout: (fn: (...args: unknown[]) => void, ms?: number) => { const timer = setTimeout(fn as () => void, ms); timers.add(timer); return timer; },
    clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: asset });
  const root = doc.getElementById("dw-site")!;
  await expect.poll(() => root.querySelectorAll("button").some(button => /delete site/i.test(button.textContent)), {
    message: "served dashboard script renders real fixture settings before feature assertions", timeout: 10_000,
  }).toBe(true);
  const nonLive = historyCount - 1;
  await expect.poll(() => root.querySelectorAll("button").filter(button => button.textContent.trim() === "Restore").length, {
    message: "version history renders Restore for every non-live row", timeout: 10_000,
  }).toBe(nonLive);
  await expect.poll(() => root.querySelectorAll("button").filter(button => /^delete version \d+$/i.test(button.getAttribute("aria-label") ?? "")).length, {
    message: "version history renders Delete for every non-live row", timeout: 10_000,
  }).toBe(nonLive);
  await expect.poll(() => {
    const hrefs = root.querySelectorAll("a").map(link => link.getAttribute("href") ?? "");
    const browser = hrefs.some(href => href.toLowerCase() === `/v/${site.slug.toLowerCase()}/index.html`);
    const live = hrefs.some(href => /^https?:\/\//.test(href) && href.endsWith("/index.html"));
    return browser && live;
  }, {
    message: "initial files rendering settles before intent assertions", timeout: 10_000,
  }).toBe(true);
  expect(violations).toEqual([]);
  expect(writes).toEqual([]);
  return {
    doc, root, site, versions: versionsBody.versions, writes, reads, violations, location,
    queueMutationReply: (reply: MutationReply) => { mutationReplies.push(reply); },
  };
}

function versionRowFor(view: Mounted, number: number): FakeElement {
  const matches = view.root.querySelectorAll("tr").filter(row => new RegExp(`\\bv${number}\\b`).test(row.textContent));
  expect(matches.length, `expected one history row for v${number}`).toBe(1);
  return matches[0]!;
}

function restoreButtonFor(view: Mounted, number: number): FakeElement {
  const row = versionRowFor(view, number);
  const buttons = row.querySelectorAll("button").filter(button => button.textContent.trim() === "Restore");
  expect(buttons.length, `expected one Restore button for v${number}`).toBe(1);
  return buttons[0]!;
}

function deleteButtonFor(view: Mounted, number: number): FakeElement {
  const row = versionRowFor(view, number);
  const buttons = row.querySelectorAll("button").filter(button => (button.getAttribute("aria-label") ?? "") === `Delete version ${number}`);
  expect(buttons.length, `expected one Delete button for v${number}`).toBe(1);
  return buttons[0]!;
}

async function waitForDialog(view: Mounted): Promise<FakeElement> {
  await expect.poll(() => view.doc.querySelector("dialog[open]"), {
    message: "version-delete confirmation opens", timeout: 5000,
  }).not.toBeNull();
  return view.doc.querySelector("dialog[open]")!;
}

// Model the browser default for a method=dialog form explicitly. This is not
// native-event evidence; Chromium suites own that verification.
function submitDialog(dialog: FakeElement, button: FakeElement) {
  if (button.disabled) return;
  const click = button.dispatch("click");
  if (click.defaultPrevented) return;
  const form = dialog.querySelector("form");
  const event = form?.dispatch("submit", { submitter: button });
  const method = button.getAttribute("formmethod") ?? form?.getAttribute("method");
  if (dialog.hasAttribute("open") && !event?.defaultPrevented && method === "dialog") dialog.close(button.getAttribute("value") ?? button.value);
}

function toastTexts(view: Mounted): string[] {
  const box = view.doc.getElementById("dw-toasts");
  if (!box) return [];
  return box.children.map(child => child.textContent);
}

function hasErrorToast(view: Mounted): boolean {
  const box = view.doc.getElementById("dw-toasts");
  if (!box) return false;
  return box.children.some(child => child.getAttribute("role") === "alert");
}

function hasSuccessToast(view: Mounted, pattern: RegExp): boolean {
  return toastTexts(view).some(text => pattern.test(text));
}

function expectFreshUuid(key: string | null, label: string) {
  expect(key, `${label} must send a fresh UUID Idempotency-Key`).toEqual(expect.stringMatching(UUID_V4));
}

function confirmOf(write: Write): string | undefined {
  const query = new URLSearchParams(write.query).get("confirm") ?? undefined;
  let body: string | undefined;
  if (write.body) {
    try {
      const parsed = JSON.parse(write.body) as { confirm?: unknown };
      if (typeof parsed.confirm === "string") body = parsed.confirm;
    } catch {}
  }
  if (query && body) expect(body, "query and body confirmations must agree").toBe(query);
  return query ?? body;
}

function parseVersionMutation(path: string): { slugSeg: string; idSeg: string; isRestore: boolean } | null {
  const match = /^\/api\/v1\/sites\/([^/]+)\/versions\/([^/]+)(\/restore)?$/.exec(path);
  if (!match) return null;
  return { slugSeg: decodeURIComponent(match[1]!), idSeg: decodeURIComponent(match[2]!), isRestore: !!match[3] };
}

async function quiet(ms = 500) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// Positive control: startup, real REST reads, DOM rendering and served-asset
// execution must work before intent-key absence counts as feature RED.
it("executes the served asset against disposable Worker history before feature assertions", async () => {
  const view = await mount();
  expect(view.root.textContent).toContain(view.site.slug);
  expect(view.root.textContent).toMatch(/versions/i);
  expect(view.writes).toEqual([]);
  expect(view.violations).toEqual([]);
});

// Positive control for the pre-existing destructive flow: Cancel sends nothing.
it("cancelling version delete sends no mutation and leaves the history intact", async () => {
  const view = await mount();
  const baselineReads = view.reads.length;
  deleteButtonFor(view, 1).click();
  const dialog = await waitForDialog(view);
  expect(dialog.textContent).toContain("Delete v1?");
  const cancel = dialog.querySelectorAll("button").find(button => /^cancel$/i.test(button.textContent.trim()));
  expect(cancel, "explicit Cancel action").toBeTruthy();
  submitDialog(dialog, cancel!);
  await quiet(300);
  expect(view.writes).toEqual([]);
  expect(view.reads.length, "Cancel issues no pointer probe").toBe(baselineReads);
  expect(view.violations).toEqual([]);
  const history = await api(`/api/v1/sites/${view.site.slug}/versions?limit=100`) as { versions: VersionRow[] };
  expect(history.versions.map(row => row.number).sort((a, b) => a - b)).toEqual([1, 2, 3]);
});

it("restore sends a fresh UUID Idempotency-Key in exactly one POST", async () => {
  const view = await mount();
  const target = view.versions.find(row => row.number === 1)!;
  expect(target, "v1 is the non-live restore target").toBeTruthy();
  const baselineReads = view.reads.length;
  restoreButtonFor(view, 1).click();
  await expect.poll(() => view.writes.length, { timeout: 5000 }).toBe(1);
  const first = view.writes[0]!;
  expect(first.method).toBe("POST");
  const parsed = parseVersionMutation(first.path);
  expect(parsed, "restore targets one explicit version id").not.toBeNull();
  expect(parsed!.slugSeg.toLowerCase()).toBe(view.site.slug.toLowerCase());
  expect(parsed!.idSeg).toBe(target.id);
  expect(parsed!.isRestore).toBe(true);
  expect(first.query).toBe("");
  expectFreshUuid(first.idempotencyKey, "restore");
  await expect.poll(() => hasSuccessToast(view, /is live again/i), { timeout: 5000 }).toBe(true);
  await quiet();
  expect(view.writes, "one deliberate click sends one mutation").toHaveLength(1);
  expect(view.reads.length, "successful restore reloads the page state").toBeGreaterThan(baselineReads);
  const after = await api(`/api/v1/sites/${view.site.slug}`) as Site;
  expect(after.currentVersionId).toBe(target.id);
  expect(view.violations).toEqual([]);
});

it("version delete sends a fresh UUID Idempotency-Key with the canonical confirmation", async () => {
  const view = await mount();
  const target = view.versions.find(row => row.number === 1)!;
  deleteButtonFor(view, 1).click();
  const dialog = await waitForDialog(view);
  expect(dialog.textContent).toContain("Delete v1?");
  const confirm = dialog.querySelectorAll("button").find(button => /^delete version$/i.test(button.textContent.trim()));
  expect(confirm, "explicit Delete version confirmation").toBeTruthy();
  submitDialog(dialog, confirm!);
  await expect.poll(() => view.writes.length, { timeout: 5000 }).toBe(1);
  const first = view.writes[0]!;
  expect(first.method).toBe("DELETE");
  const parsed = parseVersionMutation(first.path);
  expect(parsed, "delete targets one explicit version id").not.toBeNull();
  expect(parsed!.slugSeg.toLowerCase()).toBe(view.site.slug.toLowerCase());
  expect(parsed!.idSeg).toBe(target.id);
  expect(parsed!.isRestore).toBe(false);
  expect(confirmOf(first), "canonical delete confirmation still transmitted").toBe(view.site.slug);
  expectFreshUuid(first.idempotencyKey, "version delete");
  await expect.poll(() => hasSuccessToast(view, /deleted\./i), { timeout: 5000 }).toBe(true);
  await quiet();
  expect(view.writes).toHaveLength(1);
  const history = await api(`/api/v1/sites/${view.site.slug}/versions?limit=100`) as { versions: VersionRow[] };
  expect(history.versions.map(row => row.number).sort((a, b) => a - b)).toEqual([2, 3]);
  expect(view.violations).toEqual([]);
});

it("version delete opened at a non-canonical path still confirms the canonical slug with a fresh UUID", async () => {
  const view = await mount({ nonCanonicalPath: true });
  const target = view.versions.find(row => row.number === 1)!;
  deleteButtonFor(view, 1).click();
  const dialog = await waitForDialog(view);
  submitDialog(dialog, dialog.querySelectorAll("button").find(button => /^delete version$/i.test(button.textContent.trim()))!);
  await expect.poll(() => view.writes.length, { timeout: 5000 }).toBe(1);
  const first = view.writes[0]!;
  expect(first.method).toBe("DELETE");
  const parsed = parseVersionMutation(first.path);
  expect(parsed).not.toBeNull();
  expect(parsed!.slugSeg.toLowerCase(), "path names the disposable site").toBe(view.site.slug.toLowerCase());
  expect(parsed!.idSeg).toBe(target.id);
  expect(confirmOf(first), "wire confirmation is the canonical loaded slug, not the typed path").toBe(view.site.slug);
  expectFreshUuid(first.idempotencyKey, "non-canonical delete");
  expect(view.violations).toEqual([]);
});

type ErrorCase = { label: string; reply: MutationReply; toast: RegExp };
const ERROR_CASES: ErrorCase[] = [
  { label: "429", reply: { status: 429, body: { error: { code: "rate_limited", message: "Slow down for test.", hint: "Retry later." } } }, toast: /slow down/i },
  { label: "500", reply: { status: 500, body: { error: { code: "internal", message: "Test server error.", hint: "Retry later." } } }, toast: /test server error/i },
  { label: "503", reply: { status: 503, body: { error: { code: "unavailable", message: "Test unavailable.", hint: "Retry later." } } }, toast: /test unavailable/i },
  { label: "network", reply: { network: true }, toast: /could not reach/i },
  { label: "409", reply: { status: 409, body: { error: { code: "version_conflict", message: "Test conflict.", hint: "Reload versions." } } }, toast: /test conflict/i },
  { label: "404", reply: { status: 404, body: { error: { code: "version_not_found", message: "Test target missing.", hint: "Reload versions." } } }, toast: /test target missing/i },
];

it.each(ERROR_CASES)("restore $label sends exactly one UUID intent, no resubmit or probe, retry uses a new key", async ({ reply, toast }) => {
  const view = await mount();
  const target = view.versions.find(row => row.number === 1)!;
  const baselineReads = view.reads.length;
  view.queueMutationReply(reply);
  restoreButtonFor(view, 1).click();
  await expect.poll(() => view.writes.length, { timeout: 5000 }).toBe(1);
  await expect.poll(() => hasErrorToast(view), { timeout: 5000 }).toBe(true);
  expect(toastTexts(view).join("\n")).toMatch(toast);
  const first = view.writes[0]!;
  expect(first.method).toBe("POST");
  const parsed = parseVersionMutation(first.path);
  expect(parsed).not.toBeNull();
  expect(parsed!.slugSeg.toLowerCase()).toBe(view.site.slug.toLowerCase());
  expect(parsed!.idSeg).toBe(target.id);
  expect(parsed!.isRestore).toBe(true);
  expectFreshUuid(first.idempotencyKey, "failed restore");
  expect(hasSuccessToast(view, /is live again/i), "no synthetic success after an error").toBe(false);
  await quiet();
  expect(view.writes, "no silent resubmit after 429/5xx/network/409").toHaveLength(1);
  expect(view.reads.length, "no extra pointer probe after an error").toBe(baselineReads);
  expect(hasSuccessToast(view, /is live again/i)).toBe(false);
  const key1 = first.idempotencyKey;
  restoreButtonFor(view, 1).click();
  await expect.poll(() => view.writes.length, { timeout: 5000 }).toBe(2);
  const second = view.writes[1]!;
  expect(second.method).toBe("POST");
  expectFreshUuid(second.idempotencyKey, "explicit retry restore");
  expect(second.idempotencyKey, "explicit later click sends a new intent key").not.toBe(key1);
  await expect.poll(() => hasSuccessToast(view, /is live again/i), { timeout: 5000 }).toBe(true);
  const after = await api(`/api/v1/sites/${view.site.slug}`) as Site;
  expect(after.currentVersionId).toBe(target.id);
  expect(view.violations).toEqual([]);
});

it.each(ERROR_CASES)("version delete $label sends exactly one UUID intent with canonical confirm, retry uses a new key", async ({ reply, toast }) => {
  const view = await mount();
  const target = view.versions.find(row => row.number === 1)!;
  const baselineReads = view.reads.length;
  view.queueMutationReply(reply);
  deleteButtonFor(view, 1).click();
  const dialog1 = await waitForDialog(view);
  submitDialog(dialog1, dialog1.querySelectorAll("button").find(button => /^delete version$/i.test(button.textContent.trim()))!);
  await expect.poll(() => view.writes.length, { timeout: 5000 }).toBe(1);
  await expect.poll(() => hasErrorToast(view), { timeout: 5000 }).toBe(true);
  expect(toastTexts(view).join("\n")).toMatch(toast);
  const first = view.writes[0]!;
  expect(first.method).toBe("DELETE");
  const parsed = parseVersionMutation(first.path);
  expect(parsed).not.toBeNull();
  expect(parsed!.slugSeg.toLowerCase()).toBe(view.site.slug.toLowerCase());
  expect(parsed!.idSeg).toBe(target.id);
  expect(parsed!.isRestore).toBe(false);
  expect(confirmOf(first), "canonical confirmation still transmitted on a failed delete").toBe(view.site.slug);
  expectFreshUuid(first.idempotencyKey, "failed version delete");
  expect(hasSuccessToast(view, /deleted\./i), "no synthetic success after an error").toBe(false);
  await quiet();
  expect(view.writes, "no silent resubmit after 429/5xx/network/409").toHaveLength(1);
  expect(view.reads.length, "no extra pointer probe after an error").toBe(baselineReads);
  const key1 = first.idempotencyKey;
  deleteButtonFor(view, 1).click();
  const dialog2 = await waitForDialog(view);
  submitDialog(dialog2, dialog2.querySelectorAll("button").find(button => /^delete version$/i.test(button.textContent.trim()))!);
  await expect.poll(() => view.writes.length, { timeout: 5000 }).toBe(2);
  const second = view.writes[1]!;
  expect(second.method).toBe("DELETE");
  expect(confirmOf(second), "retry still confirms the canonical slug").toBe(view.site.slug);
  expectFreshUuid(second.idempotencyKey, "explicit retry delete");
  expect(second.idempotencyKey, "explicit later click sends a new intent key").not.toBe(key1);
  await expect.poll(() => hasSuccessToast(view, /deleted\./i), { timeout: 5000 }).toBe(true);
  const history = await api(`/api/v1/sites/${view.site.slug}/versions?limit=100`) as { versions: VersionRow[] };
  expect(history.versions.map(row => row.number).sort((a, b) => a - b)).toEqual([2, 3]);
  expect(view.violations).toEqual([]);
});
