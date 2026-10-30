import { createHash } from "node:crypto";
import vm from "node:vm";
import { expect } from "vitest";
import { CLIENT_SCRIPT } from "../src/ui/assets.ts";

/**
 * Test-only publisher driver, copied from the existing protected inventory suite.
 * That suite must remain unchanged, so extracting its private helpers would
 * violate the paired-test handoff. This copy adds focus and hash instrumentation
 * only; all selection, rendering, normalization and publishing run CLIENT_SCRIPT.
 * No source reimplementation or external requests are used.
 */

// ---------------------------------------------------------------------------
// Minimal stub DOM (just enough for the real dropwayClient publisher path)
// ---------------------------------------------------------------------------

type Listener = (e: Record<string, unknown>) => void;

class TText {
  readonly nodeType = 3;
  parentNode: TEl | null = null;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
  set textContent(v: string) {
    this.data = String(v);
  }
}

class TEl {
  readonly nodeType = 1;
  parentNode: TEl | null = null;
  ownerDocument: TDoc | null = null;
  children: Array<TEl | TText> = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  className = "";
  style: Record<string, string> = {};
  value = "";
  checked = false;
  tabIndex = 0;
  files: FakeFile[] = [];
  clickCalls = 0;
  focusCalls = 0;
  tagName: string;

  constructor(tag: string) {
    this.tagName = tag.toLowerCase();
  }

  // reflected attributes (attribute <-> property stay in sync like real DOM)
  get hidden(): boolean {
    return "hidden" in this.attributes;
  }
  set hidden(v: boolean) {
    if (v) this.attributes["hidden"] = "";
    else delete this.attributes["hidden"];
  }
  get disabled(): boolean {
    return "disabled" in this.attributes;
  }
  set disabled(v: boolean) {
    if (v) this.attributes["disabled"] = "";
    else delete this.attributes["disabled"];
  }
  get open(): boolean {
    return "open" in this.attributes;
  }
  set open(v: boolean) {
    if (v) this.attributes["open"] = "";
    else delete this.attributes["open"];
  }

  get firstChild(): TEl | TText | null {
    return this.children[0] ?? null;
  }
  get classList(): { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean } {
    const el = this;
    const parts = () => el.className.split(/\s+/).filter(Boolean);
    return {
      add(c: string) {
        if (!parts().includes(c)) el.className = [...parts(), c].join(" ");
      },
      remove(c: string) {
        el.className = parts().filter((p) => p !== c).join(" ");
      },
      contains(c: string) {
        return parts().includes(c);
      },
    };
  }
  appendChild<T extends TEl | TText>(c: T): T {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild<T extends TEl | TText>(c: T): T {
    this.children = this.children.filter((k) => k !== c);
    c.parentNode = null;
    return c;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  setAttribute(k: string, v: string): void {
    this.attributes[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return k in this.attributes ? this.attributes[k]! : null;
  }
  removeAttribute(k: string): void {
    delete this.attributes[k];
  }
  addEventListener(t: string, fn: Listener): void {
    (this.listeners[t] ??= []).push(fn);
  }
  get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children = [];
    if (v !== "") this.appendChild(new TText(String(v)));
  }
  // The client never uses innerHTML (pinned by test/ui.test.ts); the review
  // must not either. Throw loudly so a violation fails as a feature error.
  get innerHTML(): string {
    throw new Error("harness: innerHTML read is not supported");
  }
  set innerHTML(_v: string) {
    throw new Error("harness: innerHTML writes are forbidden in the publisher (use text nodes)");
  }
  click(): void {
    this.clickCalls++;
    fire(this, "click", {});
  }
  focus(): void {
    this.focusCalls++;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): [] {
    return [];
  }
}

class TDoc {
  body: TEl;
  private byId = new Map<string, TEl>();
  title = "";
  activeElement: TEl | null = null;

  constructor(bootJson: string, page: string) {
    this.body = this.createElement("body");
    this.body.setAttribute("data-page", page);
    const boot = this.createElement("script");
    boot.setAttribute("type", "application/json");
    boot.setAttribute("id", "dw-boot");
    boot.textContent = bootJson;
    this.body.appendChild(boot);
    this.byId.set("dw-boot", boot);
  }
  addRoot(id: string): TEl {
    const el = this.createElement("div");
    el.setAttribute("id", id);
    this.body.appendChild(el);
    this.byId.set(id, el);
    return el;
  }
  getElementById(id: string): TEl | null {
    if (this.byId.has(id)) return this.byId.get(id)!;
    // Dynamically created nodes (e.g. a review panel with an id): search.
    const found = allElements(this.body).find((e) => e.getAttribute("id") === id);
    return found ?? null;
  }
  createElement(tag: string): TEl {
    const el = new TEl(tag);
    el.ownerDocument = this;
    return el;
  }
  createTextNode(s: string): TText {
    return new TText(String(s));
  }
  querySelector(): null {
    return null;
  }
  querySelectorAll(): [] {
    return [];
  }
}

function allElements(root: TEl): TEl[] {
  const out: TEl[] = [];
  const walk = (el: TEl): void => {
    out.push(el);
    for (const c of el.children) if (c instanceof TEl) walk(c);
  };
  walk(root);
  return out;
}

/** Dispatch listeners. Faithful bits: disabled buttons never fire click. */
function fire(el: TEl, type: string, extra: Record<string, unknown>): void {
  if (type === "click" && el.disabled) return;
  const e: Record<string, unknown> = {
    type,
    currentTarget: el,
    target: el,
    preventDefault() {},
    stopPropagation() {},
    ...extra,
  };
  for (const fn of el.listeners[type] ?? []) fn(e);
  // Native activation behavior the stub must emulate: Enter/Space on a
  // button or summary fires click; a summary click toggles its <details>.
  if (type === "keydown" && (extra["key"] === "Enter" || extra["key"] === " ")) {
    if (el.tagName === "button" || el.tagName === "summary") fire(el, "click", {});
  }
  if (type === "click" && el.tagName === "summary" && el.parentNode?.tagName === "details") {
    el.parentNode.open = !el.parentNode.open;
  }
}

/** Keyboard-or-pointer activation for the review toggle. */
function activate(toggle: TEl, via: "click" | "Enter" | " "): void {
  if (via === "click") fire(toggle, "click", {});
  else fire(toggle, "keydown", { key: via });
}

// ---------------------------------------------------------------------------
// Fixtures: files, directory entries, transfers, storage, network spy
// ---------------------------------------------------------------------------

interface FakeFile {
  name: string;
  size: number;
  webkitRelativePath: string;
  arrayBufferCalls: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function fakeFile(path: string, size: number): FakeFile {
  // Deterministic synthetic bytes derived from the path (never fixtures).
  const seed = Array.from(path).reduce((a, c) => a + c.charCodeAt(0), 0);
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (seed + i * 31) % 256;
  const f: FakeFile = {
    name: path.split("/").pop() ?? path,
    size,
    webkitRelativePath: "",
    arrayBufferCalls: 0,
    arrayBuffer: async () => {
      f.arrayBufferCalls++;
      return bytes.slice().buffer as ArrayBuffer;
    },
  };
  return f;
}

function dirFile(relativePath: string, size: number): FakeFile {
  const f = fakeFile(relativePath, size);
  f.webkitRelativePath = relativePath;
  return f;
}

interface FakeEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface FakeFileEntry extends FakeEntry {
  isFile: true;
  isDirectory: false;
  file: (ok: (f: FakeFile) => void, err: () => void) => void;
}

interface FakeDirEntry extends FakeEntry {
  isFile: false;
  isDirectory: true;
  createReader: () => { readEntries: (ok: (b: FakeEntry[]) => void, err: () => void) => void };
}

function fileEntry(name: string, size: number, opts?: { fail?: boolean; gate?: Promise<void>; file?: FakeFile }): FakeFileEntry {
  const f = opts?.file ?? fakeFile(name, size);
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok, err) => {
      if (opts?.fail) {
        err();
        return;
      }
      if (opts?.gate) void opts.gate.then(() => ok(f));
      else ok(f);
    },
  };
}

function dirEntry(name: string, batches: FakeEntry[][], opts?: { fail?: boolean; failAfterBatches?: number }): FakeDirEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let i = 0;
      return {
        readEntries: (ok, err) => {
          if (opts?.fail || (opts?.failAfterBatches !== undefined && i >= opts.failAfterBatches)) {
            err();
            return;
          }
          ok(batches[i++] ?? []);
        },
      };
    },
  };
}

interface FakeDataTransfer {
  items: Array<{ webkitGetAsEntry?: () => FakeEntry | null }>;
  files: FakeFile[];
}

const dropOf = (entries: FakeEntry[]): FakeDataTransfer => ({
  items: entries.map((e) => ({ webkitGetAsEntry: () => e })),
  files: [],
});

function makeStorage(): {
  data: Record<string, string>;
  writes: Array<{ op: string; key: string }>;
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
} {
  const s = {
    data: {} as Record<string, string>,
    writes: [] as Array<{ op: string; key: string }>,
    getItem: (k: string) => (k in s.data ? s.data[k]! : null),
    setItem: (k: string, v: string) => {
      s.writes.push({ op: "set", key: k });
      s.data[k] = String(v);
    },
    removeItem: (k: string) => {
      s.writes.push({ op: "remove", key: k });
      delete s.data[k];
    },
  };
  return s;
}

type StorageStub = ReturnType<typeof makeStorage>;

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

/** Disposable in-memory network spy: programmable routes + pause gates. */
class Spy {
  calls: FetchCall[] = [];
  manifests: ManifestEntry[][] = [];
  /** Route key -> gate promise the response waits on. */
  gates = new Map<string, Promise<void>>();
  /** Fail the next deploy-create with 500 (retained-selection test). */
  failNextDeploys = false;
  slug = "picked-site";

  private releaseFns = new Map<string, () => void>();

  /** Pause a route until the returned release() is called. */
  pause(key: "sites" | "deploys" | "finalize" | "upload"): () => void {
    let release!: () => void;
    this.gates.set(key, new Promise<void>((r) => (release = r)));
    this.releaseFns.set(key, release);
    return release;
  }
  release(key: "sites" | "deploys" | "finalize" | "upload"): void {
    this.releaseFns.get(key)?.();
    this.releaseFns.delete(key);
    this.gates.delete(key);
  }

  private resp(obj: unknown, status = 200): { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> } {
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => (typeof obj === "string" ? {} : obj) };
  }

  async fetch(url: string, opts: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }> {
    const method = (opts.method ?? (opts.body !== undefined ? "POST" : "GET")).toUpperCase();
    let body: unknown = opts.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* leave as string */
      }
    }
    this.calls.push({ url: String(url), method, body });
    const u = String(url);

    if (u.endsWith("/me")) return this.resp({ principal: "member", member: { id: "m1", role: "owner" }, scopes: ["sites:read", "sites:write", "sites:delete", "keys:write", "members:write"] });
    if (method === "GET" && u.includes("/sites?")) return this.resp({ sites: [] });
    if (method === "POST" && /\/sites$/.test(u)) {
      await this.gates.get("sites");
      return this.resp({ site: { slug: this.slug } });
    }
    const deployMatch = /\/sites\/([^/]+)\/deploys$/.exec(u);
    if (method === "POST" && deployMatch) {
      await this.gates.get("deploys");
      if (this.failNextDeploys) {
        this.failNextDeploys = false;
        return this.resp({ error: { code: "boom", message: "Injected failure.", hint: "Retry." } }, 500);
      }
      const files = (body as { files?: ManifestEntry[] }).files ?? [];
      this.manifests.push(files);
      const uploads = files.map((f) => ({ sha256: f.sha256, size: f.size, paths: [f.path], url: `https://dropway.test/api/v1/uploads/${f.sha256}?sig=t`, headers: {} }));
      return this.resp({ uploads, finalizeUrl: `/api/v1/sites/${deployMatch[1]}/deploys/dep1/finalize`, deploy: { id: "dep1" } });
    }
    if (method === "PUT") {
      await this.gates.get("upload");
      return this.resp({});
    }
    if (method === "POST" && u.includes("/finalize")) {
      await this.gates.get("finalize");
      return this.resp({ url: `https://dropway.test/s/${this.slug}/`, site: { currentVersion: { number: 1 } }, warnings: [] });
    }
    if (method === "POST" && u.includes("/publish")) return this.resp({ url: `https://dropway.test/s/${this.slug}/`, slug: this.slug, version: { number: 1 } });
    return this.resp({ error: { code: "not_found", message: "No spy route for " + u, hint: "Fix the test." } }, 404);
  }
}

const flush = async (rounds = 25): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

// ---------------------------------------------------------------------------
// Boot the real publisher in vm
// ---------------------------------------------------------------------------

interface Harness {
  doc: TDoc;
  io: { hashes: number };
  root: TEl;
  spy: Spy;
  session: StorageStub;
  local: StorageStub;
  zone: TEl;
  dirInput: TEl;
  fileInput: TEl;
  summary: TEl;
  publishBtn: TEl;
  clearBtn: TEl;
  status: TEl;
  progress: TEl;
  result: TEl;
  siteSelect: TEl;
  slugInput: TEl;
  modeNew: TEl;
  modeUpd: TEl;
}

const BOOT = JSON.stringify({ origin: "https://dropway.test", api: "/api/v1", anonymousPublish: false, session: null, instanceName: "test", page: { name: "publish" } });
const BOOT_HOME = JSON.stringify({ origin: "https://dropway.test", api: "/api/v1", anonymousPublish: false, session: null, instanceName: "test", page: { name: "home" } });

function findParts(root: TEl): Omit<Harness, "doc" | "io" | "root" | "spy" | "session" | "local"> {
  const els = allElements(root);
  const one = (pred: (e: TEl) => boolean, what: string): TEl => {
    const hit = els.find(pred);
    if (!hit) throw new Error(`harness: publisher part missing: ${what}`);
    return hit;
  };
  const zone = one((e) => e.tagName === "div" && (e.getAttribute("aria-label") ?? "").includes("Drop a folder"), "drop zone");
  const fileInputs = els.filter((e) => e.tagName === "input" && e.getAttribute("type") === "file");
  const dirInput = fileInputs.find((e) => e.getAttribute("webkitdirectory") !== null);
  const fileInput = fileInputs.find((e) => e.getAttribute("webkitdirectory") === null);
  if (!dirInput || !fileInput) throw new Error("harness: file/dir inputs missing");
  const summary = one((e) => e.tagName === "div" && e.getAttribute("aria-live") === "polite" && e.className.includes("dw-muted"), "summary");
  const publishBtn = one((e) => e.tagName === "button" && e.textContent === "Publish", "Publish button");
  const clearBtn = one((e) => e.tagName === "button" && e.textContent === "Clear", "Clear button");
  const progress = one((e) => e.getAttribute("role") === "progressbar", "progress");
  const pi = root.children.indexOf(progress);
  const status = root.children[pi + 1];
  const result = root.children[pi + 2];
  if (!(status instanceof TEl) || !(result instanceof TEl)) throw new Error("harness: status/result siblings missing");
  const siteSelect = one((e) => e.getAttribute("id") === "dw-pub-site", "site select");
  const slugInput = one((e) => e.getAttribute("id") === "dw-pub-slug", "slug input");
  const modeNew = one((e) => e.tagName === "input" && e.getAttribute("type") === "radio" && e.value === "new", "mode new");
  const modeUpd = one((e) => e.tagName === "input" && e.getAttribute("type") === "radio" && e.value === "update", "mode update");
  return { zone, dirInput, fileInput, summary, publishBtn, clearBtn, status, progress, result, siteSelect, slugInput, modeNew, modeUpd };
}

async function bootPublisher(page: "publish" | "home" = "publish"): Promise<Harness> {
  const doc = new TDoc(page === "publish" ? BOOT : BOOT_HOME, page);
  const root = doc.addRoot(page === "publish" ? "dw-publish" : "dw-quick");
  doc.addRoot("dw-toasts");
  const spy = new Spy();
  const session = makeStorage();
  const local = makeStorage();
  session.setItem("dropway.key", "dw_test_key");
  session.writes.length = 0; // sign-in seeding is not a review preference write
  const location = { href: `https://dropway.test/${page === "publish" ? "dashboard/publish" : ""}`, pathname: page === "publish" ? "/dashboard/publish" : "/", search: "" };
  const io = { hashes: 0 };
  const sandbox: Record<string, unknown> = {
    document: doc,
    window: { localStorage: local, sessionStorage: session },
    location,
    fetch: (url: string, opts?: { method?: string; body?: unknown }) => spy.fetch(url, opts),
    crypto: {
      subtle: {
        digest: async (_alg: string, data: ArrayBuffer) => {
          io.hashes++;
          const h = createHash("sha256").update(Buffer.from(new Uint8Array(data)));
          return Uint8Array.from(h.digest()).buffer as ArrayBuffer;
        },
      },
    },
    URL,
    URLSearchParams,
    Headers,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SCRIPT, sandbox);
  await flush();
  if (page === "home") {
    // Home quick publisher mounts into #dw-quick when present.
    if (root.children.length === 0) throw new Error("harness: home quick publisher did not mount");
  }
  return { doc, io, root, spy, session, local, ...findParts(root) };
}

// ---------------------------------------------------------------------------
// Review-contract locators (what the Builder's review must expose)
// ---------------------------------------------------------------------------

/** Expandable review toggle: <summary> or button[aria-expanded] named like a review. */
function findReviewToggle(root: TEl): TEl | null {
  return (
    allElements(root).find((e) => {
      const name = e.textContent;
      const looksLikeReview = /review|inventor|includ|exclud|selected files/i.test(name);
      if (!looksLikeReview) return false;
      if (e.tagName === "summary") return true;
      if (e.tagName === "button" && e.getAttribute("aria-expanded") !== null) return true;
      return false;
    }) ?? null
  );
}

/** The expanded review body whose text must contain every path + reason. */
function reviewBody(root: TEl, toggle: TEl): TEl | null {
  if (toggle.tagName === "summary" && toggle.parentNode?.tagName === "details") return toggle.parentNode;
  const id = toggle.getAttribute("aria-controls");
  if (id) {
    const panel = allElements(root).find((e) => e.getAttribute("id") === id);
    if (panel) return panel;
  }
  return toggle.parentNode;
}

function isExpanded(toggle: TEl): boolean {
  if (toggle.tagName === "summary" && toggle.parentNode?.tagName === "details") return toggle.parentNode.open;
  return toggle.getAttribute("aria-expanded") === "true";
}

/** Single-text-child row elements inside the review (any reasonable row tag). */
function reviewRows(body: TEl): TEl[] {
  const tags = new Set(["li", "div", "span", "td", "p", "dd", "dt", "a", "code"]);
  return allElements(body).filter((e) => e.children.length === 1 && e.children[0] instanceof TText && tags.has(e.tagName));
}

/** Pre-publish error alerts (role=alert inside the publisher, before Publish). */
function alerts(root: TEl): TEl[] {
  return allElements(root).filter((e) => e.getAttribute("role") === "alert");
}

// ---------------------------------------------------------------------------
// Selection drivers (real seams: drop, folder picker, file picker)
// ---------------------------------------------------------------------------

async function dropFiles(h: Harness, entries: FakeEntry[]): Promise<void> {
  fire(h.zone, "drop", { dataTransfer: dropOf(entries) });
  await flush();
}

/** Keep a drop's file read pending, proving it entered traversal before Publish. */
async function beginGatedDrop(h: Harness): Promise<() => void> {
  let resolveDrop!: () => void;
  const gate = new Promise<void>((r) => (resolveDrop = r));
  const entry = fileEntry("late.html", 9, { gate });
  const read = entry.file;
  let readStarted = false;
  entry.file = (ok, err) => {
    readStarted = true;
    read(ok, err);
  };
  await dropFiles(h, [entry]);
  expect(readStarted, "the drop must reach its gated file read before publishing starts").toBe(true);
  return resolveDrop;
}

async function pickFolder(h: Harness, files: FakeFile[]): Promise<void> {
  h.dirInput.files = files;
  fire(h.dirInput, "change", {});
  await flush();
}

async function pickFiles(h: Harness, files: FakeFile[]): Promise<void> {
  h.fileInput.files = files;
  fire(h.fileInput, "change", {});
  await flush();
}

async function clickPublish(h: Harness): Promise<void> {
  fire(h.publishBtn, "click", {});
  await flush(60);
}

export {
  TEl, TText, allElements, fire, activate, fakeFile, dirFile, fileEntry, dirEntry,
  dropFiles, pickFolder, pickFiles, clickPublish, bootPublisher, flush,
  findReviewToggle, reviewBody, isExpanded, alerts, beginGatedDrop,
};
export type { Harness, FakeFile };
