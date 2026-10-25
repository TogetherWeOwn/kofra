import { createHash } from "node:crypto";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { CLIENT_SCRIPT } from "../src/ui/assets.ts";

/**
 * Acceptance contract for "Browser publishing: review the complete selected
 * file inventory before upload" (TOG-39509, Test Author handoff).
 *
 * PROTECTED TEST FILE: the Builder consumes this file unchanged and must
 * never edit it. It runs the REAL first-party publisher (CLIENT_SCRIPT, the
 * exact bytes served to browsers) inside Node `vm` against a stub DOM plus a
 * disposable in-memory network spy. That is the repo's existing browser-code
 * harness pattern (see path-shim.test.ts); no new dependency, service, or
 * production traffic is involved.
 *
 * What RED means here: the review affordance, traversal-error reporting and
 * busy-state coherence do not exist on the baseline, so the feature tests
 * fail with assertion errors (missing toggle, missing message, publish
 * enabled, manifest mismatch). Harness/infrastructure errors are NOT feature
 * RED: every test boots the real publisher first, and the passing controls
 * below prove the harness drives the baseline correctly.
 *
 * Review contract the Builder implements (inside the existing publisher, not
 * a new upload surface):
 * - A keyboard-operable expandable review (native <details>/<summary> or
 *   button[aria-expanded] + panel) whose accessible name mentions review or
 *   inventory. It lists EVERY included path with its byte size and EVERY
 *   excluded path with its existing ignore reason. Totals match the exact
 *   normalized manifest sent to the server.
 * - Unreadable files/directories surface as role=alert errors naming the
 *   affected path with a reselect/retry action; publishing an incomplete
 *   selection is disabled and impossible.
 * - While enumeration/hash/upload/finalize is active, Clear, picker/drop and
 *   destination controls cannot silently replace the displayed selection.
 * - A single ZIP is labelled as a server-unpacked archive, never as a
 *   verified listing of its entries. Review itself performs zero HTTP
 *   requests, reads no file contents, stores no preference, and never claims
 *   integrity/malware safety.
 *
 * Honest harness limits (Builder verifies these in a real browser and
 * records the evidence): visible focus-ring styling and narrow-viewport
 * wrapping are CSS and cannot be asserted in `vm`; the tests pin the DOM
 * prerequisites instead (natively focusable toggle, one element per path,
 * text-only DOM). No layout engine is present.
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

  constructor(bootJson: string, page: string) {
    this.body = new TEl("body");
    this.body.setAttribute("data-page", page);
    const boot = new TEl("script");
    boot.setAttribute("type", "application/json");
    boot.setAttribute("id", "dw-boot");
    boot.textContent = bootJson;
    this.body.appendChild(boot);
    this.byId.set("dw-boot", boot);
  }
  addRoot(id: string): TEl {
    const el = new TEl("div");
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
    return new TEl(tag);
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

// Exact replica of the client's bytes() formatter for size assertions.
function bytes(n: number): string {
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v < 10 ? 1 : 0) + " " + u[i];
}

const flush = async (rounds = 25): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

// ---------------------------------------------------------------------------
// Boot the real publisher in vm
// ---------------------------------------------------------------------------

interface Harness {
  doc: TDoc;
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

function findParts(root: TEl): Omit<Harness, "doc" | "root" | "spy" | "session" | "local"> {
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
  const sandbox: Record<string, unknown> = {
    document: doc,
    window: { localStorage: local, sessionStorage: session },
    location,
    fetch: (url: string, opts?: { method?: string; body?: unknown }) => spy.fetch(url, opts),
    crypto: {
      subtle: {
        digest: async (_alg: string, data: ArrayBuffer) => {
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
  return { doc, root, spy, session, local, ...findParts(root) };
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

// ---------------------------------------------------------------------------
// A. Review affordance: complete, trustworthy inventory before upload
// ---------------------------------------------------------------------------

describe("inventory review affordance", () => {
  it("exposes a keyboard-operable expandable review of the selection", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/index.html", 41), dirFile("dist/app.js", 1024)]);
    const toggle = findReviewToggle(h.root);
    expect(toggle, "review toggle (details/summary or button[aria-expanded] named like a review)").not.toBeNull();
    // Natively focusable (or explicitly tabbable) so keyboard users reach it.
    const focusable = toggle!.tagName === "button" || toggle!.tagName === "summary" || (toggle!.getAttribute("tabindex") !== null && Number(toggle!.getAttribute("tabindex")) >= 0);
    expect(focusable).toBe(true);
    expect(isExpanded(toggle!)).toBe(false);
    activate(toggle!, "Enter");
    expect(isExpanded(toggle!)).toBe(true);
    activate(toggle!, " ");
    expect(isExpanded(toggle!)).toBe(false);
    activate(toggle!, "click");
    expect(isExpanded(toggle!)).toBe(true);
  });

  it("lists every included path with its byte size once expanded", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/index.html", 41), dirFile("dist/assets/app.js", 2048), dirFile("dist/empty.txt", 0)]);
    const toggle = findReviewToggle(h.root);
    expect(toggle).not.toBeNull();
    activate(toggle!, "click");
    const body = reviewBody(h.root, toggle!)!.textContent;
    for (const [p, s] of [["index.html", 41], ["assets/app.js", 2048], ["empty.txt", 0]] as const) {
      expect(body).toContain(p);
      expect(body).toContain(bytes(s));
    }
  });

  it("lists every excluded path with its existing ignore reason", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [
      dirFile("dist/index.html", 10),
      dirFile("dist/.env", 9),
      dirFile("dist/.DS_Store", 8),
      dirFile("dist/node_modules/dep/x.js", 7),
      dirFile("dist/.git/config", 6),
    ]);
    const toggle = findReviewToggle(h.root);
    expect(toggle).not.toBeNull();
    activate(toggle!, "click");
    const body = reviewBody(h.root, toggle!)!.textContent;
    expect(body).toContain(".env");
    expect(body).toContain("may contain secrets");
    expect(body).toContain(".DS_Store");
    expect(body).toContain("system file");
    expect(body).toContain("node_modules/dep/x.js");
    expect(body).toContain("node_modules folder");
    expect(body).toContain(".git/config");
    expect(body).toContain(".git folder");
  });

  it("keeps more than five exclusions inspectable instead of truncating at five", async () => {
    const h = await bootPublisher();
    const files = [dirFile("dist/index.html", 10)];
    for (let i = 0; i < 7; i++) files.push(dirFile(`dist/secret-${i}.env`, 5));
    await pickFolder(h, files);
    // Baseline failure mode: only five skipped paths are shown in the
    // summary, then "…". The contract below is the fix: every exclusion
    // inspectable inside the review.
    const toggle = findReviewToggle(h.root);
    expect(toggle, "review must exist so all 7 exclusions stay inspectable").not.toBeNull();
    activate(toggle!, "click");
    const body = reviewBody(h.root, toggle!)!.textContent;
    for (let i = 0; i < 7; i++) expect(body).toContain(`secret-${i}.env`);
  });

  it("shows review totals matching the exact normalized manifest sent to the server", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/index.html", 41), dirFile("dist/a.js", 100), dirFile("dist/.env", 9)]);
    const toggle = findReviewToggle(h.root);
    expect(toggle).not.toBeNull();
    activate(toggle!, "click");
    const body = reviewBody(h.root, toggle!)!.textContent;
    expect(body).toContain("2 files");
    expect(body).toContain(bytes(141));
    await clickPublish(h);
    expect(h.spy.manifests).toHaveLength(1);
    const manifest = h.spy.manifests[0]!;
    expect(manifest.map((f) => f.path).sort()).toEqual(["a.js", "index.html"]);
    expect(manifest.reduce((s, f) => s + f.size, 0)).toBe(141);
    expect(manifest).toHaveLength(2);
  });

  it("renders nested, stripped, zero-byte, Unicode and punctuation names exactly", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [
      dirFile("dist/docs/a b ✓.md", 12),
      dirFile("dist/café.html", 13),
      dirFile("dist/a,b [1] (2).js", 14),
      dirFile("dist/empty.bin", 0),
    ]);
    const toggle = findReviewToggle(h.root);
    expect(toggle).not.toBeNull();
    activate(toggle!, "click");
    const body = reviewBody(h.root, toggle!)!.textContent;
    for (const p of ["docs/a b ✓.md", "café.html", "a,b [1] (2).js", "empty.bin"]) expect(body).toContain(p);
    expect(body).not.toContain("dist/");
  });

  it("reviews an all-ignored selection with every exclusion and keeps Publish disabled", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/.env", 9), dirFile("dist/.DS_Store", 8), dirFile("dist/node_modules/x.js", 7)]);
    expect(h.publishBtn.disabled).toBe(true);
    const toggle = findReviewToggle(h.root);
    expect(toggle, "all-ignored selection still gets an inspectable exclusion review").not.toBeNull();
    activate(toggle!, "click");
    const body = reviewBody(h.root, toggle!)!.textContent;
    for (const p of [".env", ".DS_Store", "node_modules/x.js"]) expect(body).toContain(p);
  });

  it("renders each reviewed path in its own element so narrow screens can wrap", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/one.html", 3), dirFile("dist/two.html", 3), dirFile("dist/.env", 3)]);
    const toggle = findReviewToggle(h.root);
    expect(toggle).not.toBeNull();
    activate(toggle!, "click");
    const body = reviewBody(h.root, toggle!)!;
    // One element per path (list rows), never one comma-joined line.
    const rows = reviewRows(body).map((r) => r.textContent);
    expect(rows.some((t) => t.includes("one.html") && !t.includes("two.html"))).toBe(true);
    expect(rows.some((t) => t.includes("two.html") && !t.includes("one.html"))).toBe(true);
  });

  it("renders hostile filenames as text without creating elements from them", async () => {
    const h = await bootPublisher();
    // Keep markup slash-free: fakeFile treats "/" as a path separator.
    await pickFiles(h, [fakeFile('"><img src=x onerror=alert(1)>.html', 5), fakeFile("<svg onload=alert(1)>.html", 5)]);
    const toggle = findReviewToggle(h.root);
    expect(toggle).not.toBeNull();
    activate(toggle!, "click");
    const body = reviewBody(h.root, toggle!)!;
    expect(body.textContent).toContain('"><img src=x onerror=alert(1)>.html');
    expect(body.textContent).toContain("<svg onload=alert(1)>.html");
    expect(allElements(body).filter((e) => ["img", "script", "svg"].includes(e.tagName))).toHaveLength(0);
  });

  it("labels a single ZIP as a server-unpacked archive, not a verified entry listing", async () => {
    const h = await bootPublisher();
    await pickFiles(h, [fakeFile("site.zip", 5000)]);
    const toggle = findReviewToggle(h.root);
    expect(toggle).not.toBeNull();
    activate(toggle!, "click");
    const body = reviewBody(h.root, toggle!)!;
    expect(body.textContent).toContain("site.zip");
    expect(body.textContent).toMatch(/unpack|archive/i);
    expect(body.textContent).toMatch(/server/i);
    // No per-entry rows can be verified without unpacking: exactly one row
    // names the archive, never a listing of its entries.
    expect(reviewRows(body).filter((r) => r.textContent.includes("site.zip"))).toHaveLength(1);
  });

  it("performs zero HTTP requests while reviewing (expand/collapse/change selection)", async () => {
    const h = await bootPublisher();
    const callsAtBoot = h.spy.calls.length;
    await pickFolder(h, [dirFile("dist/index.html", 41)]);
    expect(h.spy.calls.length).toBe(callsAtBoot);
    const toggle = findReviewToggle(h.root);
    expect(toggle).not.toBeNull();
    activate(toggle!, "click");
    await flush();
    activate(toggle!, "click");
    await flush();
    expect(h.spy.calls.length).toBe(callsAtBoot);
  });

  it("reads no file contents for review and stores no local preference", async () => {
    const h = await bootPublisher();
    const files = [dirFile("dist/index.html", 41), dirFile("dist/a.js", 42)];
    await pickFolder(h, files);
    for (const f of files) expect(f.arrayBufferCalls).toBe(0);
    const writesAtSelect = h.session.writes.length + h.local.writes.length;
    const toggle = findReviewToggle(h.root);
    expect(toggle).not.toBeNull();
    activate(toggle!, "click");
    activate(toggle!, "click");
    await flush();
    for (const f of files) expect(f.arrayBufferCalls).toBe(0);
    expect(h.session.writes.length + h.local.writes.length).toBe(writesAtSelect);
  });

  it("offers the same review in the compact home-page publisher", async () => {
    const h = await bootPublisher("home");
    await pickFolder(h, [dirFile("dist/index.html", 41), dirFile("dist/.env", 9)]);
    const toggle = findReviewToggle(h.root);
    expect(toggle, "home quick publisher shares the review affordance").not.toBeNull();
    activate(toggle!, "click");
    expect(reviewBody(h.root, toggle!)!.textContent).toContain("index.html");
  });
});

// ---------------------------------------------------------------------------
// B. Traversal errors: unreadable entries are never silently dropped
// ---------------------------------------------------------------------------

describe("traversal error reporting", () => {
  it("reports an unreadable file with its path and a reselect/retry action", async () => {
    const h = await bootPublisher();
    await dropFiles(h, [fileEntry("ok.html", 10), fileEntry("broken.html", 11, { fail: true })]);
    const messages = alerts(h.root).map((a) => a.textContent).join("\n");
    expect(messages, "role=alert naming the affected path").toContain("broken.html");
    expect(messages).toMatch(/reselect|retry|try again|choose/i);
  });

  it("disables publishing while the selection is incomplete and never sends a partial manifest", async () => {
    const h = await bootPublisher();
    await dropFiles(h, [fileEntry("ok.html", 10), fileEntry("broken.html", 11, { fail: true })]);
    expect(h.publishBtn.disabled).toBe(true);
    await clickPublish(h);
    expect(h.spy.manifests, "no deploy may be created from an incomplete traversal").toHaveLength(0);
  });

  it("reports an unreadable directory distinctly from intentionally ignored entries", async () => {
    const h = await bootPublisher();
    await dropFiles(h, [dirEntry("assets", [[fileEntry("a.png", 5)]]), dirEntry("locked", [], { fail: true }), fileEntry(".env", 4)]);
    const messages = alerts(h.root).map((a) => a.textContent).join("\n");
    expect(messages).toContain("locked");
    expect(messages).toMatch(/reselect|retry|try again|choose/i);
    // The ignored .env stays an exclusion, never an error alert.
    expect(messages).not.toContain(".env");
    expect(h.publishBtn.disabled).toBe(true);
  });

  it("considers every readEntries batch (control: multi-batch traversal already works)", async () => {
    const h = await bootPublisher();
    await dropFiles(h, [dirEntry("big", [[fileEntry("a1.js", 5), fileEntry("a2.js", 6)], [fileEntry("a3.js", 7)], []])]);
    expect(h.summary.textContent).toContain("3 files");
    expect(h.publishBtn.disabled).toBe(false);
    await clickPublish(h);
    expect(h.spy.manifests[0]!.map((f) => f.path).sort()).toEqual(["a1.js", "a2.js", "a3.js"]);
  });
});

// ---------------------------------------------------------------------------
// C. State coherence: the UI describes the selection actually being sent
// ---------------------------------------------------------------------------

describe("publish state coherence", () => {
  it("prevents Clear from silently replacing the selection while a publish is active", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/index.html", 41), dirFile("dist/a.js", 42)]);
    const release = h.spy.pause("deploys");
    fire(h.publishBtn, "click", {});
    await flush();
    expect(h.spy.calls.some((c) => c.method === "POST" && /\/sites$/.test(c.url))).toBe(true);
    const shownDuringBusy = h.summary.textContent;
    fire(h.clearBtn, "click", {});
    await flush();
    expect(h.summary.textContent, "displayed selection must still describe the in-flight publish").toBe(shownDuringBusy);
    expect(h.summary.textContent).toContain("2 files");
    release();
    await flush(60);
    expect(h.spy.manifests[0]).toHaveLength(2);
  });

  it("prevents picker/drop from silently replacing the selection while a publish is active", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/index.html", 41)]);
    const release = h.spy.pause("upload");
    fire(h.publishBtn, "click", {});
    await flush();
    fire(h.zone, "drop", { dataTransfer: dropOf([fileEntry("sneaky.html", 9)]) });
    h.fileInput.files = [fakeFile("other.html", 8)];
    fire(h.fileInput, "change", {});
    await flush();
    expect(h.summary.textContent, "late selections must not replace the in-flight display").toContain("index.html");
    expect(h.summary.textContent).not.toContain("sneaky.html");
    expect(h.summary.textContent).not.toContain("other.html");
    release();
    await flush(60);
    expect(h.spy.manifests[0]!.map((f) => f.path)).toEqual(["index.html"]);
  });

  it("disables destination controls while a publish is active", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/index.html", 41)]);
    const release = h.spy.pause("finalize");
    fire(h.publishBtn, "click", {});
    await flush();
    expect(h.modeNew.disabled).toBe(true);
    expect(h.modeUpd.disabled).toBe(true);
    expect(h.slugInput.disabled).toBe(true);
    expect(h.siteSelect.disabled).toBe(true);
    release();
    await flush(60);
  });

  it("keeps the in-flight inventory and gives notice when a pending drop resolves during publish", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/index.html", 41), dirFile("dist/.env", 9)]);
    const toggle = findReviewToggle(h.root)!;
    activate(toggle, "click");
    const shown = h.summary.textContent;
    const reviewed = reviewBody(h.root, toggle)!.textContent;
    const resolveDrop = await beginGatedDrop(h);
    const release = h.spy.pause("deploys");
    try {
      fire(h.publishBtn, "click", {});
      await flush();
      expect(h.publishBtn.disabled).toBe(true);
      expect(h.spy.calls.some((c) => c.method === "POST" && /\/deploys$/.test(c.url))).toBe(true);
      resolveDrop();
      await flush();
      expect(h.summary.textContent).toBe(shown);
      expect(reviewBody(h.root, findReviewToggle(h.root)!)!.textContent).toBe(reviewed);
      expect(h.root.textContent).not.toContain("late.html");
      expect(h.doc.getElementById("dw-toasts")!.textContent, "a discarded pending drop must not be silent").toMatch(/drop|selection|publish/i);
    } finally {
      resolveDrop();
      release();
      await flush(60);
    }
    expect(h.spy.manifests).toHaveLength(1);
    expect(h.spy.manifests[0]!.map((f) => ({ path: f.path, size: f.size }))).toEqual([{ path: "index.html", size: 41 }]);
  });

  it("keeps the completed selection cleared when a pending drop resolves after publish success", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/index.html", 41)]);
    const resolveDrop = await beginGatedDrop(h);
    await clickPublish(h);
    expect(h.result.textContent).toMatch(/live/i);
    expect(h.summary.textContent).toBe("");
    resolveDrop();
    await flush();
    expect(h.summary.textContent, "a stale drop must not repopulate a completed publish").toBe("");
    expect(h.root.textContent).not.toContain("late.html");
    expect(h.clearBtn.hidden).toBe(true);
    expect(h.publishBtn.disabled).toBe(true);
    await clickPublish(h);
    expect(h.spy.manifests).toHaveLength(1);
    expect(h.spy.manifests[0]!.map((f) => ({ path: f.path, size: f.size }))).toEqual([{ path: "index.html", size: 41 }]);
  });

  it("keeps the original selection and review retryable when a pending drop resolves after publish failure", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/index.html", 41), dirFile("dist/a.js", 42), dirFile("dist/.env", 9)]);
    const toggle = findReviewToggle(h.root)!;
    activate(toggle, "click");
    const shown = h.summary.textContent;
    const reviewed = reviewBody(h.root, toggle)!.textContent;
    const resolveDrop = await beginGatedDrop(h);
    h.spy.failNextDeploys = true;
    await clickPublish(h);
    expect(h.result.textContent).toMatch(/failed/i);
    expect(h.summary.textContent).toBe(shown);
    resolveDrop();
    await flush();
    expect(h.summary.textContent, "a stale drop must not replace the retryable selection").toBe(shown);
    const retainedToggle = findReviewToggle(h.root)!;
    expect(isExpanded(retainedToggle)).toBe(true);
    expect(reviewBody(h.root, retainedToggle)!.textContent).toBe(reviewed);
    expect(h.root.textContent).not.toContain("late.html");
    expect(h.publishBtn.disabled).toBe(false);
    await clickPublish(h);
    expect(h.spy.manifests).toHaveLength(1);
    expect(h.spy.manifests[0]!.map((f) => ({ path: f.path, size: f.size })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "a.js", size: 42 },
      { path: "index.html", size: 41 },
    ]);
  });

  it("keeps the selection and review available after a failed publish (control)", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/index.html", 41), dirFile("dist/a.js", 42)]);
    h.spy.failNextDeploys = true;
    await clickPublish(h);
    expect(h.result.textContent).toMatch(/failed/i);
    expect(h.summary.textContent).toContain("2 files");
    expect(h.publishBtn.disabled).toBe(false);
    // Retry with the same selection succeeds and sends the full manifest.
    await clickPublish(h);
    expect(h.spy.manifests).toHaveLength(1);
    expect(h.spy.manifests[0]).toHaveLength(2);
  });

  it("clears only the completed selection after a successful publish (control)", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/index.html", 41)]);
    await clickPublish(h);
    expect(h.result.textContent).toMatch(/live/i);
    expect(h.summary.textContent).toBe("");
    expect(h.clearBtn.hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. Contract guards: existing behavior the Builder must preserve
// ---------------------------------------------------------------------------

describe("preserved publisher behavior (controls)", () => {
  it("sends the exact normalized inventory: common root stripped, ignored removed", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [
      dirFile("dist/index.html", 41),
      dirFile("dist/docs/a b ✓.md", 12),
      dirFile("dist/empty.bin", 0),
      dirFile("dist/.env", 9),
      dirFile("dist/node_modules/dep/x.js", 7),
    ]);
    await clickPublish(h);
    expect(h.spy.manifests).toHaveLength(1);
    const manifest = h.spy.manifests[0]!;
    expect(manifest.map((f) => f.path).sort()).toEqual(["docs/a b ✓.md", "empty.bin", "index.html"]);
    expect(manifest.find((f) => f.path === "empty.bin")!.size).toBe(0);
    expect(manifest.reduce((s, f) => s + f.size, 0)).toBe(53);
  });

  it("summarizes counts and bytes for a kept selection", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/index.html", 41), dirFile("dist/a.js", 100)]);
    expect(h.summary.textContent).toContain("2 files");
    expect(h.summary.textContent).toContain(bytes(141));
    expect(h.publishBtn.disabled).toBe(false);
  });

  it("labels a single zip as unpacked on the server", async () => {
    const h = await bootPublisher();
    await pickFiles(h, [fakeFile("site.zip", 5000)]);
    expect(h.summary.textContent).toContain("1 zip file");
    expect(h.summary.textContent).toContain("unpacked on the server");
  });

  it("selecting files performs zero HTTP requests", async () => {
    const h = await bootPublisher();
    const callsAtBoot = h.spy.calls.length;
    expect(callsAtBoot).toBeGreaterThan(0); // mount loads the site list
    await pickFolder(h, [dirFile("dist/index.html", 41), dirFile("dist/.env", 9)]);
    await dropFiles(h, [fileEntry("x.html", 5)]);
    expect(h.spy.calls.length).toBe(callsAtBoot);
  });

  it("never claims integrity or malware safety for the selection", async () => {
    const h = await bootPublisher();
    await pickFolder(h, [dirFile("dist/index.html", 41), dirFile("dist/.env", 9)]);
    await pickFiles(h, [fakeFile("site.zip", 5000)]);
    const text = h.root.textContent;
    expect(text).not.toMatch(/malware|virus|integrity|guarantee/i);
    expect(text).not.toMatch(/scanned|verified as safe|safety check/i);
  });
});

// ---------------------------------------------------------------------------
// E. Ignored unreadable entries: exclusions do not make included files incomplete
// ---------------------------------------------------------------------------

// Breaks caught here: treating every traversal failure as blocking, ignoring
// raw prefixes before common-root normalization, or silently dropping unknown
// nonignored contents. These tests exercise the served script, not its helpers.
describe("ignored unreadable entries", () => {
  function expandedRows(h: Harness): string[] {
    const toggle = findReviewToggle(h.root);
    expect(toggle, "the selection must remain inspectable").not.toBeNull();
    if (!isExpanded(toggle!)) activate(toggle!, "click");
    const body = reviewBody(h.root, toggle!)!;
    // Paths and sizes can be sibling text/code nodes in the same list row.
    const rows = allElements(body).filter((e) => e.tagName === "li" || e.tagName === "tr");
    return (rows.length ? rows : reviewRows(body)).map((r) => r.textContent);
  }

  function expectExcluded(rows: string[], path: string, reason: string): string {
    const row = rows.find((r) => r.includes(path));
    expect(row, `excluded row for ${path}`).toBeDefined();
    expect(row).toContain(reason);
    return row!;
  }

  function expectUnknownDirectory(rows: string[], path: string, reason: string): void {
    expectExcluded(rows, path, reason);
    // A failed enumeration is not proof of an empty or completely listed tree.
    const matching = rows.filter((r) => r.includes(path) && r.includes(reason));
    expect(matching.some((r) => /unknown|unreadable|not (?:read|listed|enumerated|inspected)|could not|couldn't|cannot|can't|unavailable/i.test(r)), "excluded directory must disclose unreadable/unknown contents").toBe(true);
  }

  async function expectBlockedWithoutRequests(h: Harness, callsAtBoot: number, path: string): Promise<void> {
    const messages = alerts(h.root).map((a) => a.textContent).join("\n");
    expect(messages).toContain(path);
    expect(messages).toMatch(/reselect|retry|try again|choose/i);
    expect(h.publishBtn.disabled).toBe(true);
    expect(h.spy.calls).toHaveLength(callsAtBoot);
    await clickPublish(h);
    expect(h.spy.calls, "not even site creation is allowed for incomplete included contents").toHaveLength(callsAtBoot);
    expect(h.spy.manifests).toHaveLength(0);
  }

  it.each([
    { path: ".env", reason: "may contain secrets" },
    { path: ".env.local", reason: "may contain secrets" },
    { path: ".git/config", reason: ".git folder" },
    { path: "node_modules/dep/x.js", reason: "node_modules folder" },
  ])("excludes unreadable $path without blocking the readable project", async ({ path, reason }) => {
    const h = await bootPublisher();
    const callsAtBoot = h.spy.calls.length;
    const index = fakeFile("index.html", 41);
    const script = fakeFile("app.js", 12);
    const parts = path.split("/");
    let unreadable: FakeEntry = fileEntry(parts.pop()!, 9, { fail: true });
    for (const name of parts.reverse()) unreadable = dirEntry(name, [[unreadable]]);
    await dropFiles(h, [dirEntry("project", [[
      fileEntry("index.html", 41, { file: index }),
      dirEntry("assets", [[fileEntry("app.js", 12, { file: script })]]),
      unreadable,
    ]])]);
    const rows = expandedRows(h);
    expectExcluded(rows, path, reason);
    expect(rows.some((r) => r.includes("index.html") && r.includes("41 B"))).toBe(true);
    expect(rows.some((r) => r.includes("assets/app.js") && r.includes("12 B"))).toBe(true);
    expect(h.summary.textContent).toContain("2 files");
    expect(h.summary.textContent).toContain("53 B");
    expect(h.spy.calls).toHaveLength(callsAtBoot);
    expect(index.arrayBufferCalls + script.arrayBufferCalls, "review never hashes readable files").toBe(0);
    expect(alerts(h.root), "intentionally excluded files are not traversal blockers").toHaveLength(0);
    expect(h.publishBtn.disabled).toBe(false);
    await clickPublish(h);
    expect(h.spy.manifests).toHaveLength(1);
    expect(h.spy.manifests[0]!.map((f) => ({ path: f.path, size: f.size })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "assets/app.js", size: 12 },
      { path: "index.html", size: 41 },
    ]);
  });

  it.each([
    { name: ".git", reason: ".git folder" },
    { name: "node_modules", reason: "node_modules folder" },
  ])("honestly excludes an unreadable $name directory with unknown contents", async ({ name, reason }) => {
    const h = await bootPublisher();
    const callsAtBoot = h.spy.calls.length;
    const index = fakeFile("index.html", 41);
    await dropFiles(h, [dirEntry("project", [[
      fileEntry("index.html", 41, { file: index }),
      dirEntry(name, [], { fail: true }),
    ]])]);
    const rows = expandedRows(h);
    expectUnknownDirectory(rows, `${name}/`, reason);
    expect(h.spy.calls).toHaveLength(callsAtBoot);
    expect(index.arrayBufferCalls).toBe(0);
    expect(alerts(h.root)).toHaveLength(0);
    expect(h.publishBtn.disabled).toBe(false);
    await clickPublish(h);
    expect(h.spy.manifests).toHaveLength(1);
    expect(h.spy.manifests[0]!.map((f) => ({ path: f.path, size: f.size }))).toEqual([{ path: "index.html", size: 41 }]);
  });

  it("keeps a partially enumerated ignored subtree honest after a later batch fails", async () => {
    const h = await bootPublisher();
    const callsAtBoot = h.spy.calls.length;
    const config = fakeFile("config", 9);
    await dropFiles(h, [dirEntry("project", [[
      fileEntry("index.html", 41),
      dirEntry(".git", [[fileEntry("config", 9, { file: config })]], { failAfterBatches: 1 }),
    ]])]);
    const rows = expandedRows(h);
    expectUnknownDirectory(rows, ".git/", ".git folder");
    expect(h.spy.calls).toHaveLength(callsAtBoot);
    expect(config.arrayBufferCalls).toBe(0);
    expect(alerts(h.root)).toHaveLength(0);
    await clickPublish(h);
    expect(h.spy.manifests).toHaveLength(1);
    expect(h.spy.manifests[0]!.map((f) => ({ path: f.path, size: f.size }))).toEqual([{ path: "index.html", size: 41 }]);
    expect(config.arrayBufferCalls, "excluded contents are never read, even at publish time").toBe(0);
  });

  it.each(["file", "directory"] as const)("still blocks a nonignored unreadable %s alongside ignored failures", async (kind) => {
    const h = await bootPublisher();
    const callsAtBoot = h.spy.calls.length;
    const broken = kind === "file" ? fileEntry("broken.txt", 9, { fail: true }) : dirEntry("locked", [], { fail: true });
    await dropFiles(h, [dirEntry("project", [[
      fileEntry("index.html", 41),
      fileEntry(".env.local", 9, { fail: true }),
      dirEntry("assets", [[broken]]),
    ]])]);
    expandedRows(h);
    await expectBlockedWithoutRequests(h, callsAtBoot, kind === "file" ? "assets/broken.txt" : "assets/locked");
  });

  it.each([".git", "node_modules"])("strips the selected %s root before applying ignore policy", async (root) => {
    const h = await bootPublisher();
    const callsAtBoot = h.spy.calls.length;
    const index = fakeFile("index.html", 41);
    const config = fakeFile("config", 9);
    await dropFiles(h, [dirEntry(root, [[
      fileEntry("index.html", 41, { file: index }),
      fileEntry("config", 9, { file: config }),
      fileEntry(".env", 4),
    ]])]);
    const rows = expandedRows(h);
    expectExcluded(rows, ".env", "may contain secrets");
    expect(rows.some((r) => r.includes("index.html") && r.includes("41 B"))).toBe(true);
    expect(rows.some((r) => r.includes("config") && r.includes("9 B"))).toBe(true);
    expect(rows.join("\n")).not.toContain(`${root}/`);
    expect(alerts(h.root)).toHaveLength(0);
    expect(h.spy.calls).toHaveLength(callsAtBoot);
    expect(index.arrayBufferCalls + config.arrayBufferCalls).toBe(0);
    await clickPublish(h);
    expect(h.spy.manifests).toHaveLength(1);
    expect(h.spy.manifests[0]!.map((f) => ({ path: f.path, size: f.size })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "config", size: 9 },
      { path: "index.html", size: 41 },
    ]);
  });

  it.each([
    { root: ".git", kind: "file" },
    { root: ".git", kind: "directory" },
    { root: "node_modules", kind: "file" },
    { root: "node_modules", kind: "directory" },
  ])("does not ignore an unreadable $kind merely because the selected root is $root", async ({ root, kind }) => {
    const h = await bootPublisher();
    const callsAtBoot = h.spy.calls.length;
    const broken = kind === "file" ? fileEntry("broken.txt", 9, { fail: true }) : dirEntry("locked", [], { fail: true });
    await dropFiles(h, [dirEntry(root, [[fileEntry("index.html", 41), broken]])]);
    expandedRows(h);
    await expectBlockedWithoutRequests(h, callsAtBoot, kind === "file" ? "broken.txt" : "locked");
  });

  it.each([".git", "node_modules"])("does not claim to know the contents of an unreadable selected %s root", async (root) => {
    const h = await bootPublisher();
    const callsAtBoot = h.spy.calls.length;
    await dropFiles(h, [dirEntry(root, [], { fail: true })]);
    await expectBlockedWithoutRequests(h, callsAtBoot, root);
  });

  it("normalizes multiple top-level entries together, preserving their distinct prefixes", async () => {
    const h = await bootPublisher();
    const callsAtBoot = h.spy.calls.length;
    const index = fakeFile("index.html", 41);
    const readme = fakeFile("readme.md", 12);
    await dropFiles(h, [
      dirEntry("site", [[fileEntry("index.html", 41, { file: index }), fileEntry(".env", 9, { fail: true })]]),
      dirEntry(".git", [[fileEntry("config", 9, { fail: true })]]),
      dirEntry("node_modules", [], { fail: true }),
      fileEntry("readme.md", 12, { file: readme }),
    ]);
    const rows = expandedRows(h);
    expectExcluded(rows, "site/.env", "may contain secrets");
    expectExcluded(rows, ".git/config", ".git folder");
    expectUnknownDirectory(rows, "node_modules/", "node_modules folder");
    expect(rows.some((r) => r.includes("site/index.html") && r.includes("41 B"))).toBe(true);
    expect(h.spy.calls).toHaveLength(callsAtBoot);
    expect(index.arrayBufferCalls + readme.arrayBufferCalls).toBe(0);
    expect(alerts(h.root)).toHaveLength(0);
    expect(h.publishBtn.disabled).toBe(false);
    await clickPublish(h);
    expect(h.spy.manifests).toHaveLength(1);
    expect(h.spy.manifests[0]!.map((f) => ({ path: f.path, size: f.size })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "readme.md", size: 12 },
      { path: "site/index.html", size: 41 },
    ]);
  });

  it.each(["file", "directory"] as const)("blocks a nonignored top-level unreadable %s in a mixed selection", async (kind) => {
    const h = await bootPublisher();
    const callsAtBoot = h.spy.calls.length;
    await dropFiles(h, [
      dirEntry("site", [[fileEntry("index.html", 41)]]),
      dirEntry(".git", [], { fail: true }),
      kind === "file" ? fileEntry("broken.txt", 9, { fail: true }) : dirEntry("locked", [], { fail: true }),
    ]);
    expandedRows(h);
    await expectBlockedWithoutRequests(h, callsAtBoot, kind === "file" ? "broken.txt" : "locked");
  });

  it("blocks an unreadable ancestor even when the only discovered children were ignored", async () => {
    const h = await bootPublisher();
    const callsAtBoot = h.spy.calls.length;
    await dropFiles(h, [
      fileEntry("index.html", 41),
      dirEntry("locked", [[dirEntry(".git", [], { fail: true }), fileEntry(".env", 9, { fail: true })]], { failAfterBatches: 1 }),
    ]);
    expandedRows(h);
    await expectBlockedWithoutRequests(h, callsAtBoot, "locked");
  });
});
