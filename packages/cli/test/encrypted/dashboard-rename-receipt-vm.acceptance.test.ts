/**
 * Implementer-owned VM coverage for two review-pinned rename paths.
 *
 * Paperclip Review 4/5 on the dashboard-rename change proved by revert mutants
 * that no in-repo test pins (1) malformed/non-HTTP(S) receipt validation and
 * renamed:false handling, or (2) retiring old-slug controls after a confirmed
 * rename. This file pins those paths in the disposable-Worker + fake-DOM VM
 * harness. Run: npm run test:cli -- test/encrypted/dashboard-rename-receipt-vm.acceptance.test.ts
 *
 * This is NOT part of the Test Author's protected acceptance set. It imports
 * dashboard-rename.helpers and dashboard-rename-vm-dom.helpers read-only; those
 * files must stay byte-identical to the protected deliverable.
 */
import vm from "node:vm";
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

type Write = { method: string; path: string; body: string | null };
type Mounted = {
  doc: FakeDocument; root: FakeElement; site: Site; writes: Write[]; violations: string[];
  interceptRename: (reply: (proposed: string) => unknown) => void;
};

// Mount mirrors the protected VM harness (same served shell, asset, boot payload
// and settle conditions) with one seam: interceptRename replaces the rename POST
// response so malformed-receipt paths can be exercised without a hostile server.
async function mount(): Promise<Mounted> {
  const site: Site = await fixtureSite();
  const shell = await fixtureFetch(`/dashboard/sites/${site.slug}`);
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
  expect(bootData.page).toMatchObject({ name: "site", slug: site.slug });
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
  const violations: string[] = [];
  recordedViolations.push(violations);
  const location = { origin, href: `${origin}/dashboard/sites/${site.slug}`, pathname: `/dashboard/sites/${site.slug}`, search: "",
    assign(value: string) { this.href = new URL(value, origin).href; },
    replace(value: string) { this.assign(value); },
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  cleanups.push(() => { for (const timer of timers) clearTimeout(timer); });
  let renameReply: ((proposed: string) => unknown) | null = null;
  const sandbox: Record<string, unknown> = {
    document: doc, sessionStorage: storage, localStorage: new Storage(), location,
    history: {
      pushState(_a: unknown, _b: unknown, value: string) { location.assign(value); },
      replaceState(_a: unknown, _b: unknown, value: string) { location.assign(value); },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (path: string, init: RequestInit = {}) => {
      const url = new URL(String(path), origin);
      if (url.origin !== origin) { violations.push("off-origin request"); throw Error("off-origin fixture request refused"); }
      const method = init.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        writes.push({ method, path: url.pathname, body: typeof init.body === "string" ? init.body : null });
        const isRename = method === "POST" && url.pathname === `/api/v1/sites/${site.slug}/rename`;
        if (!isRename) { violations.push(`${method} ${url.pathname}`); throw Error("unexpected fixture mutation"); }
        if (renameReply) {
          let proposed = "";
          try {
            const parsed = JSON.parse(typeof init.body === "string" ? init.body : "{}") as { newSlug?: unknown };
            if (typeof parsed.newSlug === "string") proposed = parsed.newSlug;
          } catch { proposed = ""; }
          return new Response(JSON.stringify(renameReply(proposed)), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
      }
      return fixtureFetch(url.href, init);
    },
    prompt: () => null,
    confirm: () => false, alert: () => {},
    Headers, URL: TestURL, URLSearchParams, Blob, console,
    setTimeout: (fn: (...args: any[]) => void, ms?: number) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: asset });
  const root = doc.getElementById("dw-site")!;
  await expect.poll(() => root.querySelectorAll("button").some(button => /delete site/i.test(button.textContent)), {
    message: "served dashboard script renders real fixture settings before feature assertions", timeout: 5000,
  }).toBe(true);
  await expect.poll(() => {
    const hrefs = root.querySelectorAll("a").map(link => link.getAttribute("href") ?? "");
    const browser = hrefs.includes(`/v/${site.slug}/index.html`);
    const live = hrefs.some(href => /^https?:\/\//.test(href) && href.endsWith("/index.html"));
    return browser && live;
  }, {
    message: "initial files rendering settles before link snapshot", timeout: 5000,
  }).toBe(true);
  expect(violations).toEqual([]);
  expect(writes).toEqual([]);
  return { doc, root, site, writes, violations, interceptRename: (reply) => { renameReply = reply; } };
}

function renameForm(view: Mounted): FakeElement {
  const form = view.root.querySelector('form[aria-label="Rename site"]');
  expect(form, "settings expose the rename form").not.toBeNull();
  return form!;
}
function proposedInput(view: Mounted): FakeElement {
  const input = view.doc.getElementById("dw-s-new-slug");
  expect(input, "rename exposes the proposed-slug input").not.toBeNull();
  return input!;
}
function feedback(view: Mounted): FakeElement {
  const box = view.doc.getElementById("dw-s-rename-feedback");
  expect(box, "rename exposes accessible feedback").not.toBeNull();
  return box!;
}
function anchors(view: Mounted): Array<string | null> {
  return view.root.querySelectorAll("a").map(link => link.getAttribute("href"));
}
function submitRename(view: Mounted, name: string) {
  const input = proposedInput(view);
  input.value = name;
  input.dispatch("input");
  renameForm(view).dispatch("submit");
}

// Break: a non-HTTP(S) receipt URL is rendered as a live link or claims success.
it("rejects a non-HTTP(S) rename receipt without changing identity", async () => {
  const view = await mount();
  view.interceptRename((proposed) => ({
    renamed: true, oldSlug: view.site.slug, slug: proposed,
    url: `javascript:alert(${JSON.stringify(view.site.slug)})`,
    redirectUntil: null, site: view.site,
  }));
  const linksBefore = anchors(view);
  submitRename(view, "receipt-target");
  const box = feedback(view);
  await expect.poll(() => box.textContent, { message: "malformed receipt surfaces an accessible error", timeout: 5000 })
    .toContain("Could not confirm the rename response");
  expect(view.doc.getElementById("dw-rename-result"), "no success receipt on a rejected response").toBeNull();
  expect(
    anchors(view).every((href) => {
      const parsed = new URL(href ?? "", origin);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    }),
    "rejected URL never becomes a link",
  ).toBe(true);
  expect(proposedInput(view).value, "proposal preserved for correction").toBe("receipt-target");
  expect(proposedInput(view).disabled, "form re-armed after the error").toBe(false);
  expect(anchors(view)).toEqual(linksBefore);
  expect(view.writes).toHaveLength(1);
  expect(JSON.parse(view.writes[0]!.body ?? "null")).toEqual({ newSlug: "receipt-target" });
  expect((await api(`/api/v1/sites/${view.site.slug}`)).slug).toBe(view.site.slug);
});

// Break: deleting only the shape guard accepts invalid identity fields with a valid URL.
it.each([
  { name: "non-boolean renamed", invalid: { renamed: 1 } },
  { name: "missing renamed", invalid: { renamed: undefined } },
  { name: "missing slug", invalid: { slug: undefined } },
  { name: "non-string slug", invalid: { slug: 123 } },
  { name: "empty slug", invalid: { slug: "" } },
  { name: "non-string URL", invalid: { url: ["https://receipt.example.test/shape-target/"] } },
])("rejects $name with otherwise valid receipt fields", async ({ invalid }) => {
  const view = await mount();
  view.interceptRename(() => ({
    renamed: true, oldSlug: view.site.slug, slug: "shape-target",
    url: "https://receipt.example.test/shape-target/", ...invalid,
  }));
  const linksBefore = anchors(view);
  submitRename(view, "shape-target");
  const box = feedback(view);
  await expect.poll(() => box.textContent, { message: "malformed receipt surfaces an accessible error", timeout: 5000 })
    .toContain("Could not confirm the rename response");
  expect(view.doc.getElementById("dw-rename-result"), "no success receipt on a rejected response").toBeNull();
  expect(proposedInput(view).value, "proposal preserved for correction").toBe("shape-target");
  expect(anchors(view)).toEqual(linksBefore);
  expect(view.writes).toHaveLength(1);
});

// Break: renamed:false renders a success receipt instead of the no-op message.
it("treats a renamed:false response as a no-op without rendering a receipt", async () => {
  const view = await mount();
  view.interceptRename(() => ({
    renamed: false, oldSlug: view.site.slug, slug: view.site.slug,
    url: view.site.url, redirectUntil: null, site: view.site,
  }));
  const linksBefore = anchors(view);
  submitRename(view, "already-current");
  const box = feedback(view);
  await expect.poll(() => box.textContent, { message: "renamed:false surfaces the no-op message", timeout: 5000 })
    .toContain("already has that name");
  expect(view.doc.getElementById("dw-rename-result"), "no receipt for a no-op rename").toBeNull();
  expect(proposedInput(view).value, "proposal preserved after the no-op").toBe("already-current");
  expect(anchors(view)).toEqual(linksBefore);
  expect(view.writes).toHaveLength(1);
});

// Break: old-slug controls (rename form, delete, settings) survive a confirmed rename.
it("retires old-slug controls after a confirmed rename", async () => {
  const view = await mount();
  const moved = `${view.site.slug}-moved`;
  submitRename(view, moved);
  await expect.poll(() => view.doc.getElementById("dw-rename-result")?.textContent ?? "", {
    message: "confirmed rename renders a receipt", timeout: 10_000,
  }).toBe(`Renamed to ${moved}`);
  expect(view.root.querySelector('form[aria-label="Rename site"]'), "rename form retired after success").toBeNull();
  expect(
    view.root.querySelectorAll("button").filter(button => /delete site/i.test(button.textContent)),
    "delete control retired after success",
  ).toEqual([]);
  expect(
    view.root.querySelectorAll("button").filter(button => /save settings/i.test(button.textContent)),
    "settings form retired after success",
  ).toEqual([]);
  expect(view.root.querySelector(`a[href="/dashboard/sites/${moved}"]`), "management continues with the confirmed slug").not.toBeNull();
  expect(view.writes).toHaveLength(1);
  expect(view.writes[0]).toMatchObject({ method: "POST", path: `/api/v1/sites/${view.site.slug}/rename` });
  expect(JSON.parse(view.writes[0]!.body ?? "null")).toEqual({ newSlug: moved });
  expect((await api(`/api/v1/sites/${moved}`)).slug).toBe(moved);
});
