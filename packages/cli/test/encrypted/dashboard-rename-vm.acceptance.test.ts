/**
 * Worker-served dashboard executed in the existing fake-DOM/Node VM harness.
 * Run: npm run test:cli -- test/encrypted/dashboard-rename-vm.acceptance.test.ts
 *
 * This provides feature-assertion RED evidence even where Chromium cannot load
 * OS libraries. It does NOT claim real-browser, layout, native keyboard or AX
 * coverage; those assertions are in dashboard-rename.acceptance.test.ts.
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
async function mount(options: { allowDelete?: boolean } = {}) {
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
  // fixtureFetch supplies the actual fixture credential at the transport seam;
  // the VM still follows the normal signed-in API-key dashboard path.
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
        const allowed = method === "POST" && url.pathname === `/api/v1/sites/${site.slug}/rename` ||
          options.allowDelete && method === "DELETE" && url.pathname === `/api/v1/sites/${site.slug}`;
        if (!allowed) { violations.push(`${method} ${url.pathname}`); throw Error("unexpected fixture mutation"); }
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
  expect(violations).toEqual([]);
  expect(writes).toEqual([]);
  return { doc, root, site, writes, violations, location };
}

function label(element: FakeElement, doc: FakeDocument) {
  const aria = element.getAttribute("aria-label");
  if (aria) return aria;
  const ids = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  if (ids.length) return ids.map(id => doc.getElementById(id)?.textContent ?? "").join(" ");
  let parent = element.parentNode;
  while (parent) { if (parent.tag === "label") return parent.textContent; parent = parent.parentNode; }
  return doc.querySelectorAll("label").filter(node => element.id && node.getAttribute("for") === element.id).map(node => node.textContent).join(" ");
}

function proposed(view: Awaited<ReturnType<typeof mount>>) {
  const inputs = view.root.querySelectorAll("input").filter(input => /(?:new|proposed).*(?:slug|name)|(?:slug|name).*(?:new|proposed)/i.test(label(input, view.doc)));
  expect(inputs.length, "settings expose one accessibly labelled proposed-name input").toBe(1);
  return inputs[0]!;
}

// Positive control: startup, real REST reads, DOM rendering, and served asset
// execution must work before absence of a rename form counts as feature RED.
it("executes the served asset against disposable Worker settings before feature assertions", async () => {
  const view = await mount();
  expect(view.root.textContent).toContain(view.site.slug);
  expect(view.root.textContent).toMatch(/settings/i);
  expect(view.root.querySelectorAll("a").map(link => link.getAttribute("href"))).toContain(view.site.url);
  expect(view.writes).toEqual([]);
});

// Break: rename is absent/unlabelled, or Cancel queues a mutation.
it("offers a labelled proposal and a Cancel interaction without changing identity", async () => {
  const view = await mount();
  const input = proposed(view);
  const originalLinks = view.root.querySelectorAll("a").map(link => link.getAttribute("href"));
  input.value = "cancelled-proposal";
  input.dispatch("input");
  const cancel = view.root.querySelectorAll("button").filter(button => /^cancel$/i.test(button.textContent.trim()));
  expect(cancel.length, "explicit Cancel action beside rename").toBe(1);
  cancel[0]!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(view.writes).toEqual([]);
  expect(view.root.querySelectorAll("a").map(link => link.getAttribute("href"))).toEqual(originalLinks);
  expect((await api(`/api/v1/sites/${view.site.slug}`)).slug).toBe(view.site.slug);
});

// Break: the misleading deletion promise remains in the rendered lifecycle area.
it("shows configured name-retention guidance rather than a freed-name promise", async () => {
  const view = await mount();
  const copy = view.root.textContent;
  expect(copy, "deletion must not promise that its name is freed for immediate acquisition").not.toMatch(/and the name is freed|the name is freed[.!]|deletion frees the name|name (?:is|becomes) immediately available/i);
  expect(copy).toMatch(/retain|reserv|hold|held|bound/i);
  expect(copy).toMatch(/configur|policy|retention|lifetime/i);
  expect(view.writes).toEqual([]);
});

// Model the browser default for a method=dialog form explicitly. This is not
// native-event evidence; the companion Chromium suite owns that verification.
function submitDialog(dialog: FakeElement, button: FakeElement) {
  if (button.disabled) return;
  const click = button.dispatch("click");
  if (click.defaultPrevented) return;
  const form = dialog.querySelector("form");
  const event = form?.dispatch("submit", { submitter: button });
  const method = button.getAttribute("formmethod") ?? form?.getAttribute("method");
  if (dialog.hasAttribute("open") && !event?.defaultPrevented && method === "dialog") dialog.close(button.getAttribute("value") ?? button.value);
}

// Positive control + no-extra-mutation guard for the pre-existing destructive flow.
it("keeps cancellation and wrong typed confirmation from deleting the disposable site", async () => {
  const view = await mount();
  const button = view.root.querySelectorAll("button").find(button => /delete site/i.test(button.textContent))!;
  for (let i = 0; i < 2; i++) {
    button.click();
    const dialog = view.doc.querySelector("dialog[open]");
    expect(dialog, "existing typed confirmation opens before deletion").not.toBeNull();
    expect(dialog!.textContent).toContain(view.site.slug);
    const input = dialog!.querySelector("input");
    expect(input).not.toBeNull();
    const confirm = dialog!.querySelectorAll("button").find(node => /delete/i.test(node.textContent))!;
    expect(confirm.disabled).toBe(true);
    if (i === 1) {
      input!.value = "wrong-site-name";
      input!.dispatch("input");
      expect(confirm.disabled, "another name never enables deletion").toBe(true);
    }
    const cancel = dialog!.querySelectorAll("button").find(node => /cancel/i.test(node.textContent))!;
    submitDialog(dialog!, cancel);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.doc.querySelectorAll("dialog[open]").length, "Cancel closes the destructive confirmation").toBe(0);
    expect(view.writes).toEqual([]);
    expect((await api(`/api/v1/sites/${view.site.slug}`)).slug).toBe(view.site.slug);
  }
  expect(view.violations).toEqual([]);
});

// Positive control for the exact typed gate, using the real local delete endpoint.
it("only sends deletion after the current slug is typed exactly", async () => {
  const view = await mount({ allowDelete: true });
  view.root.querySelectorAll("button").find(button => /delete site/i.test(button.textContent))!.click();
  const dialog = view.doc.querySelector("dialog[open]")!;
  const input = dialog.querySelector("input")!;
  const confirm = dialog.querySelectorAll("button").find(button => /delete/i.test(button.textContent))!;
  expect(confirm.disabled).toBe(true);
  input.value = view.site.slug;
  input.dispatch("input");
  expect(confirm.disabled).toBe(false);
  expect(view.writes).toEqual([]);
  submitDialog(dialog, confirm);
  await expect.poll(() => view.writes.length).toBe(1);
  expect(view.writes[0]!.method).toBe("DELETE");
  expect(view.writes[0]!.path).toBe(`/api/v1/sites/${view.site.slug}`);
  await expect.poll(() => new URL(view.location.href, origin).pathname).toBe("/dashboard");
  expect((await fixtureFetch(`/api/v1/sites/${view.site.slug}`)).status).toBe(404);
  expect(view.violations).toEqual([]);
});
