/**
 * Protected harness: renders the REAL code-viewer page with the production
 * viewer (same renderer the Worker serves; the workerd companion suite pins
 * that the served page carries this same markup/script over HTTP), parses it
 * generically, then runs the page's REAL inline script under Node vm against
 * disposable browser doubles (location/history with entries, clipboard,
 * storage, network recorders). Nothing here reimplements selection logic.
 * Only the Test Author may change this file.
 */
import vm from "node:vm";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import { codeViewer } from "../src/viewers/code.ts";
import { toViewerFile, type ViewerContext } from "../src/viewers/index.ts";
import { allElements, FakeDocument, FakeElement, FakeEvent, isHiddenEl, parseDocument, type FakeEventInit } from "./code-line-range.dom.ts";

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export async function settle(): Promise<void> {
  await tick();
  await tick();
  await tick();
}

export const PAGE_URL = "https://files.example.test/s/demo/src/app.ts?view=1&probe=keep-me";

class Browser {
  entries: string[];
  index = 0;
  ops: Array<{ op: string; url: string }> = [];
  windowListeners = new Map<string, Array<(ev: FakeEvent) => void>>();
  onhashchange: ((ev: FakeEvent) => void) | null = null;
  onpopstate: ((ev: FakeEvent) => void) | null = null;
  navigations: string[] = [];
  formSubmits = 0;

  constructor(initial: string) {
    this.entries = [initial];
  }
  get url(): URL {
    return new URL(this.entries[this.index]!);
  }
  get href(): string {
    return this.url.href;
  }
  fireWindow(type: string): void {
    const ev = new FakeEvent(type);
    for (const fn of [...(this.windowListeners.get(type) ?? [])]) fn(ev);
    if (type === "hashchange" && this.onhashchange) this.onhashchange(ev);
    if (type === "popstate" && this.onpopstate) this.onpopstate(ev);
  }
  private queueHashChangeIfNeeded(oldUrl: URL, newUrl: URL): void {
    if (oldUrl.hash !== newUrl.hash) queueMicrotask(() => this.fireWindow("hashchange"));
  }
  push(url: string, op: string): void {
    const old = this.url;
    const next = new URL(url, old.href);
    this.entries = [...this.entries.slice(0, this.index + 1), next.href];
    this.index++;
    this.ops.push({ op, url: next.href });
    this.queueHashChangeIfNeeded(old, next);
  }
  replace(url: string, op: string): void {
    const old = this.url;
    const next = new URL(url, old.href);
    this.entries[this.index] = next.href;
    this.ops.push({ op, url: next.href });
    this.queueHashChangeIfNeeded(old, next);
  }
  pushState(url?: string | null): void {
    const old = this.url;
    const next = url ? new URL(url, old.href) : old;
    this.entries = [...this.entries.slice(0, this.index + 1), next.href];
    this.index++;
    this.ops.push({ op: "pushState", url: next.href });
  }
  replaceState(url?: string | null): void {
    const old = this.url;
    const next = url ? new URL(url, old.href) : old;
    this.entries[this.index] = next.href;
    this.ops.push({ op: "replaceState", url: next.href });
  }
  traverse(delta: number): void {
    const target = this.index + delta;
    if (target < 0 || target >= this.entries.length) return;
    const old = this.url;
    this.index = target;
    const next = this.url;
    this.ops.push({ op: delta < 0 ? "back" : "forward", url: next.href });
    queueMicrotask(() => {
      this.fireWindow("popstate");
      if (old.hash !== next.hash) this.fireWindow("hashchange");
    });
  }
  location = (() => {
    const b = this;
    return {
      get href() {
        return b.href;
      },
      set href(v: string) {
        const next = new URL(v, b.href);
        if (next.origin + next.pathname + next.search === b.url.origin + b.url.pathname + b.url.search) b.push(next.href, "assign-hash");
        else b.navigations.push(next.href);
      },
      get origin() {
        return b.url.origin;
      },
      get pathname() {
        return b.url.pathname;
      },
      get search() {
        return b.url.search;
      },
      get hash() {
        return b.url.hash;
      },
      set hash(v: string) {
        const next = b.url;
        next.hash = v;
        if (next.href !== b.href) b.push(next.href, "hash-assign");
      },
      assign(v: string) {
        const next = new URL(v, b.href);
        if (next.origin + next.pathname + next.search === b.url.origin + b.url.pathname + b.url.search) b.push(next.href, "assign-hash");
        else b.navigations.push(next.href);
      },
      replace(v: string) {
        const next = new URL(v, b.href);
        if (next.origin + next.pathname + next.search === b.url.origin + b.url.pathname + b.url.search) b.replace(next.href, "location-replace");
        else b.navigations.push(next.href);
      },
      toString() {
        return b.href;
      },
    };
  })();
  history = (() => {
    const b = this;
    return {
      get length() {
        return b.entries.length;
      },
      pushState: (_s: unknown, _t: string, url?: string | null) => b.pushState(url),
      replaceState: (_s: unknown, _t: string, url?: string | null) => b.replaceState(url),
      back: () => b.traverse(-1),
      forward: () => b.traverse(1),
      go: (n: number) => b.traverse(n),
    };
  })();
}

function storageDouble(log: string[]) {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => {
      log.push("get");
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      log.push("set");
      data.set(k, String(v));
    },
    removeItem: (k: string) => {
      log.push("remove");
      data.delete(k);
    },
    clear: () => {
      log.push("clear");
      data.clear();
    },
  };
}

export interface Fixture {
  /** File path inside the demo site. */
  path: string;
  text: string;
}

export const twelveLines: Fixture = {
  path: "src/app.ts",
  text:
    [
      "const alpha = 1;",
      "const beta = 2;",
      'const hostile = "</script><script>alert(1)</script>";',
      "const angles = \"<img src=x onerror=alert(1)> & 'quotes'\";",
      "const epsilon = 5;",
      "const zeta = 6;",
      "const eta = 7;",
      "const theta = 8;",
      "const iota = 9;",
      "const kappa = 10;",
      "const lambda = 'ünïcode ✓';",
      "const mu = '" + "x".repeat(400) + "'; // long line for wrap",
    ].join("\n") + "\n",
};

export async function render(fixture: Fixture): Promise<{ html: string; headers: Headers; status: number }> {
  const bytes = new TextEncoder().encode(fixture.text);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const vc = {
    dw: {},
    request: new Request(PAGE_URL),
    url: new URL(PAGE_URL),
    live: { v: 2, siteId: "s1", slug: "demo", tenantId: "t", versionId: "v1", spa: false, renderMarkdown: true, crossOriginIsolation: false, passwordHash: null, expiresAt: null, files: {} },
    file: toViewerFile(fixture.path, sha, bytes.length, "text/plain"),
    mode: "document",
    embed: false,
    fileUrl: `/s/demo/${fixture.path}`,
    viewUrl: `/s/demo/${fixture.path}?view=1`,
    sourceUrl: `/s/demo/${fixture.path}?view=source`,
    rawUrl: `/s/demo/${fixture.path}?raw=1`,
    downloadUrl: `/s/demo/${fixture.path}?download=1`,
    siteBase: "/s/demo/",
    appViewerUrl: `https://app.example.test/v/demo/${fixture.path}`,
    readText: async () => fixture.text,
    readBytes: async (offset = 0, length?: number) => bytes.slice(offset, length === undefined ? undefined : offset + length),
  } as unknown as ViewerContext;
  const res = await codeViewer.render(vc);
  return { html: await res.text(), headers: res.headers, status: res.status };
}

function accessibleName(doc: FakeDocument, el: FakeElement): string {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => doc.getElementById(id)?.textContent.trim() ?? "").filter(Boolean).join(" ");
    if (text) return text;
  }
  if (el.id) {
    const label = allElements(doc.documentElement).find((e) => e.tag === "label" && e.getAttribute("for") === el.id);
    if (label) return label.textContent.trim();
  }
  const wrap = el.closest("label");
  if (wrap) return wrap.textContent.trim();
  if (el.tag === "button") return el.textContent.trim();
  return "";
}

export type Mounted = Awaited<ReturnType<typeof mount>>;

export async function mount(fixture: Fixture = twelveLines, opts: { initialHash?: string; clipboard?: boolean } = {}) {
  const { html, headers, status } = await render(fixture);
  expect(status, "code viewer render").toBe(200);
  const doc = new FakeDocument();
  parseDocument(doc, html);
  const scripts = doc.querySelectorAll("script").map((s) => s.textContent);
  const initial = PAGE_URL + (opts.initialHash ?? "");
  const browser = new Browser(initial);
  const clipboard: string[] = [];
  const storageLog: string[] = [];
  const network: string[] = [];
  const selectionLog: string[] = [];
  const local = storageDouble(storageLog);
  const session = storageDouble(storageLog);
  class SandboxEvent extends FakeEvent {}
  const sandbox: Record<string, unknown> = {
    document: doc,
    location: browser.location,
    history: browser.history,
    localStorage: local,
    sessionStorage: session,
    navigator: {
      ...(opts.clipboard === false
        ? {}
        : { clipboard: { writeText: async (t: string) => { clipboard.push(String(t)); } } }),
      sendBeacon: (u: unknown) => {
        network.push("beacon " + String(u));
        return true;
      },
    },
    fetch: async (u: unknown) => {
      network.push("fetch " + String(u));
      throw new Error("network is disabled in this harness");
    },
    XMLHttpRequest: class {
      open(m: string, u: string) {
        network.push(`xhr ${m} ${u}`);
      }
      send() {}
    },
    Event: SandboxEvent,
    CustomEvent: SandboxEvent,
    KeyboardEvent: SandboxEvent,
    MouseEvent: SandboxEvent,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
    getSelection: () => ({
      removeAllRanges: () => selectionLog.push("removeAllRanges"),
      toString: () => "",
      anchorNode: null,
      rangeCount: 0,
    }),
    addEventListener: (type: string, fn: (ev: FakeEvent) => void) => {
      const list = browser.windowListeners.get(type) ?? [];
      list.push(fn);
      browser.windowListeners.set(type, list);
    },
    removeEventListener: (type: string, fn: (ev: FakeEvent) => void) => {
      browser.windowListeners.set(type, (browser.windowListeners.get(type) ?? []).filter((f) => f !== fn));
    },
  };
  Object.defineProperty(sandbox, "onhashchange", {
    get: () => browser.onhashchange,
    set: (fn: ((ev: FakeEvent) => void) | null) => {
      browser.onhashchange = fn;
    },
  });
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  doc.defaultView = sandbox;
  vm.createContext(sandbox);
  for (const src of scripts) vm.runInContext(src, sandbox, { filename: "served-code-viewer-script.js" });
  doc.dispatch("DOMContentLoaded");
  browser.fireWindow("DOMContentLoaded");
  browser.fireWindow("load");
  await settle();

  const toolbarRegion = (): FakeElement => {
    const head = doc.querySelectorAll(".dw-codehead")[0];
    expect(head, "code viewer toolbar (.dw-codehead)").toBeDefined();
    return head!;
  };
  const renderedLineNumbers = (): number[] =>
    doc
      .querySelectorAll("a")
      .map((a) => /^#L(\d+)$/.exec(a.getAttribute("href") ?? "")?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  const lineAnchor = (n: number): FakeElement => {
    const a = doc.querySelectorAll("a").find((el) => el.getAttribute("href") === `#L${n}`);
    expect(a, `line ${n} anchor`).toBeDefined();
    return a!;
  };
  const highlighted = (): number[] =>
    allElements(doc.documentElement)
      .filter((el) => el.classList.contains("dw-hl"))
      .map((el) => /^L(\d+)$/.exec(el.id)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);

  function activateLabel(label: FakeElement): void {
    const forId = label.getAttribute("for");
    const control = forId ? doc.getElementById(forId) : label.querySelectorAll("input,button")[0];
    if (!control) return;
    if (control.tag === "input" && control.type === "checkbox") control.checked = !control.checked;
    control.focus();
    control.dispatch("click");
    control.dispatch("change");
  }

  async function click(el: FakeElement, init: FakeEventInit = {}): Promise<void> {
    if (["a", "button", "input", "label", "select", "textarea"].includes(el.tag)) el.focus();
    el.dispatch("mousedown", init);
    el.dispatch("mouseup", init);
    if (el.tag === "input" && el.type === "checkbox" && !init.__skipToggle) el.checked = !el.checked;
    const ev = el.dispatch("click", init);
    if (!ev.defaultPrevented) {
      if (el.tag === "label") activateLabel(el);
      else if (el.tag === "a") {
        const href = el.getAttribute("href") ?? "";
        // Shift and Alt are modified activations in real browsers: shift-click
        // opens a new window, ctrl/meta/alt open a new tab/window or download.
        // None of them perform a same-tab fragment navigation. Model that so a
        // missing preventDefault is observable as a recorded native navigation
        // instead of a same-tab push that would mask the bug.
        const modified = init.ctrlKey || init.metaKey || init.altKey || init.shiftKey || (init.button ?? 0) !== 0;
        if (!href) {
          // No navigation target.
        } else if (!modified) {
          if (href.startsWith("#")) {
            const next = browser.url;
            next.hash = href.slice(1);
            if (next.href !== browser.href) browser.push(next.href, "anchor-default");
          } else {
            browser.navigations.push(new URL(href, browser.href).href);
          }
        } else {
          // Native modified-link behavior: the current tab stays put and the
          // target opens elsewhere. Record the target so handled shift-clicks
          // can pin its cancellation and unhandled modified clicks can pin its
          // retention.
          if (href.startsWith("#")) {
            const target = new URL(browser.href);
            target.hash = href.slice(1);
            browser.navigations.push(target.href);
          } else {
            browser.navigations.push(new URL(href, browser.href).href);
          }
        }
      } else if ((el.tag === "button" || (el.tag === "input" && el.type === "submit")) && el.type === "submit") {
        const form = el.form;
        if (form) {
          const submit = form.dispatch("submit");
          if (!submit.defaultPrevented) browser.formSubmits++;
        }
      }
    }
    await settle();
  }

  const rangeControls = () => {
    const region = toolbarRegion();
    const inputs = region.querySelectorAll("input").filter((i) => ["number", "text", ""].includes(i.type));
    const byName = (re: RegExp) => inputs.filter((i) => re.test(accessibleName(doc, i)));
    const first = byName(/(first|start|from)\b[^]*\bline/i);
    const last = byName(/(last|end|to)\b[^]*\bline/i);
    const buttons = region
      .querySelectorAll("button")
      .concat(region.querySelectorAll("input").filter((i) => ["submit", "button"].includes(i.type)))
      .filter((b) => /select/i.test(b.tag === "input" ? b.value || accessibleName(doc, b) : accessibleName(doc, b)));
    expect(first, "labelled first/start line input in the code toolbar").toHaveLength(1);
    expect(last, "labelled last/end line input in the code toolbar").toHaveLength(1);
    expect(buttons, "explicit Select action in the code toolbar").toHaveLength(1);
    expect(first[0]).not.toBe(last[0]);
    return { region, first: first[0]!, last: last[0]!, button: buttons[0]! };
  };

  async function keyboardSelect(firstValue: string, lastValue: string): Promise<void> {
    const { first, last, button } = rangeControls();
    for (const [input, value] of [[first, firstValue], [last, lastValue]] as const) {
      input.focus();
      input.value = value;
      input.dispatch("input");
      input.dispatch("change");
    }
    button.focus();
    const key = button.dispatch("keydown", { key: "Enter" });
    if (!key.defaultPrevented) await click(button);
    else await settle();
  }

  /** Press Enter while focused in a range input, modelling implicit submission. */
  async function pressEnterIn(input: FakeElement): Promise<void> {
    input.focus();
    const key = input.dispatch("keydown", { key: "Enter" });
    if (!key.defaultPrevented) {
      // Real browsers implicitly submit the surrounding form when Enter is
      // pressed in a text/number input. The code viewer has no <form> today,
      // so this stays a no-op there; pin the contract anyway so a future form
      // wrapper or a missing preventDefault cannot slip through silently.
      const form = input.form;
      if (form) {
        const submit = form.dispatch("submit");
        if (!submit.defaultPrevented) browser.formSubmits++;
      }
    }
    await settle();
  }

  /** Fill both range inputs, then press Enter in the named one (not the button). */
  async function keyboardSelectViaInput(which: "first" | "last", firstValue: string, lastValue: string): Promise<void> {
    const { first, last } = rangeControls();
    for (const [input, value] of [[first, firstValue], [last, lastValue]] as const) {
      input.focus();
      input.value = value;
      input.dispatch("input");
      input.dispatch("change");
    }
    await pressEnterIn(which === "first" ? first : last);
  }

  function explanations(beforeRegionText: string): string {
    const region = toolbarRegion();
    const parts: string[] = [];
    for (const el of allElements(doc.documentElement)) {
      const role = el.getAttribute("role");
      const live = el.getAttribute("aria-live");
      if ((role === "alert" || role === "status" || live === "polite" || live === "assertive") && !isHiddenEl(el)) parts.push(el.textContent.trim());
    }
    for (const input of region.querySelectorAll("input")) {
      const describedBy = input.getAttribute("aria-describedby");
      if (describedBy) {
        for (const id of describedBy.split(/\s+/)) {
          const el = doc.getElementById(id);
          if (el && !isHiddenEl(el)) parts.push(el.textContent.trim());
        }
      }
      if (input.getAttribute("aria-invalid") === "true") parts.push(input.validationMessage);
    }
    if (doc.reportedValidity) parts.push(doc.reportedValidity.validationMessage);
    const now = region.textContent;
    if (now !== beforeRegionText) parts.push(now);
    return parts.filter(Boolean).join("\n");
  }

  return {
    doc,
    html,
    headers,
    scripts,
    browser,
    clipboard,
    storageLog,
    network,
    selectionLog,
    url: () => browser.url,
    hash: () => browser.url.hash,
    historyDepth: () => browser.entries.length,
    toolbarRegion,
    toolbarText: () => toolbarRegion().textContent,
    renderedLineNumbers,
    lineAnchor,
    lineRow: (n: number) => doc.getElementById(`L${n}`),
    highlighted,
    click,
    clickLine: async (n: number) => click(lineAnchor(n)),
    shiftClickLine: async (n: number) => click(lineAnchor(n), { shiftKey: true }),
    modifiedClickLine: async (n: number) => click(lineAnchor(n), { ctrlKey: true }),
    shiftCtrlClickLine: async (n: number) => click(lineAnchor(n), { shiftKey: true, ctrlKey: true }),
    shiftMetaClickLine: async (n: number) => click(lineAnchor(n), { shiftKey: true, metaKey: true }),
    shiftAltClickLine: async (n: number) => click(lineAnchor(n), { shiftKey: true, altKey: true }),
    rangeControls,
    keyboardSelect,
    pressEnterIn,
    keyboardSelectViaInput,
    explanations,
    setHashManual: async (hash: string) => {
      browser.location.hash = hash;
      await settle();
    },
    back: async () => {
      browser.traverse(-1);
      await settle();
    },
    forward: async () => {
      browser.traverse(1);
      await settle();
    },
    accessibleName: (el: FakeElement) => accessibleName(doc, el),
    settle,
  };
}
