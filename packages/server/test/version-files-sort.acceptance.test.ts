/**
 * Acceptance: sort the loaded version-files manifest by path, kind or byte size.
 *
 * Drives the real first-party dashboard script (CLIENT_SCRIPT, the exact bytes the
 * Worker serves) inside Node's vm with a minimal fake DOM and controlled manifest
 * fixtures. No new dependency and no new service: this is the repo's declared
 * browser-code harness (packages/server/vitest.config.ts; same vm-plus-stubs style
 * as path-shim.test.ts). Fixture entries mirror GET /api/v1/sites/:slug/files
 * ({path, size, sha256, contentType, kind, extension, url, rawUrl}).
 *
 * Sort UI contract exercised here (all inside the #files section of the site page):
 * - One keyboard-focusable control per field (Path, Kind, Size): sortable column
 *   headers (button in th), a toolbar (selects/buttons), or both. Any shape is
 *   accepted; the tests discover controls by data-sort-field, th scope, and
 *   accessible names containing the field word plus "sort" (or header context).
 * - The active sort is exposed truthfully: exactly one sortable th carries
 *   aria-sort="ascending|descending" when headers exist; native toolbar values
 *   cannot substitute for a missing header state. The independent toolbar cases
 *   pin both select change handlers and their synchronization with those headers.
 *   Toolbar-only discovery retains equally explicit native state (field select
 *   plus a direction select/button naming ascending/descending, Asc/Desc or arrows).
 * - Default is deterministic Path ascending, exposed as above.
 * - First activation of an inactive field sorts ascending; activating the active
 *   field toggles direction.
 * - Size orders by exact numeric manifest bytes; path/kind order deterministically
 *   with the full path as tie-breaker (ascending ties); descending keeps the
 *   primary direction exact and ties deterministic across repeats.
 * - Sorting and filtering compose (neither resets the other), row identity and
 *   live/historical link semantics survive every sort and version switch, sorts
 *   issue no network request and write no storage, and every field stays sortable
 *   when the Kind column is hidden on narrow screens (controls outside .dw-hide-sm).
 *
 * Run: npm run test:browser-code
 *      npx vitest run -c packages/server/vitest.config.ts test/version-files-sort.acceptance.test.ts
 *
 * Acceptance pin: implementations satisfy these tests without editing this file.
 */
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { CLIENT_SCRIPT } from "../src/ui/assets.ts";

// ---------------------------------------------------------------------------
// Minimal fake DOM: the subset the site page of the dashboard script uses
// (createElement/createTextNode, h()/add()/clear()/$()/$$() helpers, filter
// input events, button clicks, version switching, download clicks).
// ---------------------------------------------------------------------------

interface FakeEventInit {
  key?: string;
  [k: string]: unknown;
}

interface FakeEvent {
  type: string;
  target: FakeElement;
  currentTarget: FakeElement;
  key: string | undefined;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

type FakeListener = (ev: FakeEvent) => void;

const NATIVELY_FOCUSABLE = new Set(["button", "select", "input", "textarea", "a"]);

class FakeText {
  readonly nodeType = 3 as const;
  parentNode: FakeElement | null = null;
  constructor(public text: string) {}
  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = String(v);
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
}

type FakeChild = FakeElement | FakeText;

class FakeElement {
  readonly nodeType = 1 as const;
  parentNode: FakeElement | null = null;
  childNodes: FakeChild[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, FakeListener[]>();
  value = "";
  checked = false;
  disabled = false;
  // The dashboard assigns `tr.hidden = q && ...` (string-or-boolean); accept both.
  hidden: unknown = false;
  explicitTabIndex: number | null = null;
  private doc: FakeDocument;

  constructor(doc: FakeDocument, readonly tag: string) {
    this.doc = doc;
  }

  get localName(): string {
    return this.tag;
  }
  get tagName(): string {
    return this.tag.toUpperCase();
  }
  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  set id(v: string) {
    this.setAttribute("id", v);
  }
  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  set className(v: string) {
    this.setAttribute("class", v);
  }
  classList(): string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }
  get textContent(): string {
    return this.childNodes
      .map((c) => (c instanceof FakeElement ? c.textContent : c.text))
      .join("");
  }
  set textContent(v: string) {
    const s = String(v);
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (s) {
      const t = new FakeText(s);
      t.parentNode = this;
      this.childNodes.push(t);
    }
    this.doc.textMutated();
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }
  get firstChild(): FakeChild | null {
    return this.childNodes[0] ?? null;
  }
  get tabIndex(): number {
    if (this.explicitTabIndex !== null) return this.explicitTabIndex;
    return NATIVELY_FOCUSABLE.has(this.tag) ? 0 : -1;
  }
  set tabIndex(v: number) {
    this.explicitTabIndex = Number(v);
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
    if (k === "disabled") this.disabled = true;
    if (k === "hidden") this.hidden = true;
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
    if (k === "disabled") this.disabled = false;
    if (k === "hidden") this.hidden = false;
  }

  appendChild<T extends FakeChild>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    this.doc.textMutated();
    return child;
  }
  removeChild<T extends FakeChild>(child: T): T {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    this.doc.textMutated();
    return child;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }

  addEventListener(type: string, fn: FakeListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: FakeListener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((f) => f !== fn),
    );
  }
  dispatch(type: string, init: FakeEventInit = {}): void {
    const ev: FakeEvent = {
      type,
      target: this,
      currentTarget: this,
      key: init.key,
      defaultPrevented: false,
      preventDefault() {
        ev.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  click(): void {
    this.dispatch("click", {});
  }
  focus(): void {
    this.doc.activeElement = this;
  }
  scrollIntoView(_opts?: unknown): void {}
  select(): void {}
  submit(): void {}

  querySelector(sel: string): FakeElement | null {
    return queryAll(this, sel, false)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    return queryAll(this, sel, false);
  }
}

// --- Tiny selector engine: tag, #id, .class, [attr], [attr=value], descendant, group. ---

interface SimpleSel {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: Array<{ name: string; value: string | null }>;
}

function parseSimple(src: string): SimpleSel {
  const sel: SimpleSel = { tag: null, id: null, classes: [], attrs: [] };
  let i = 0;
  const isName = (c: string) => /[a-zA-Z0-9_-]/.test(c);
  if (src[i] === "*") {
    i++;
  } else if (i < src.length && /[a-zA-Z]/.test(src[i]!)) {
    let tag = "";
    while (i < src.length && isName(src[i]!)) tag += src[i++];
    sel.tag = tag.toLowerCase();
  }
  while (i < src.length) {
    const c = src[i]!;
    if (c === "#") {
      i++;
      let id = "";
      while (i < src.length && isName(src[i]!)) id += src[i++];
      sel.id = id;
    } else if (c === ".") {
      i++;
      let cls = "";
      while (i < src.length && isName(src[i]!)) cls += src[i++];
      sel.classes.push(cls);
    } else if (c === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) throw new Error(`Bad selector ${JSON.stringify(src)}`);
      const inner = src.slice(i + 1, end);
      const eq = inner.indexOf("=");
      if (eq < 0) {
        sel.attrs.push({ name: inner.trim(), value: null });
      } else {
        let value = inner.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        sel.attrs.push({ name: inner.slice(0, eq).trim(), value });
      }
      i = end + 1;
    } else if (c === ":") {
      throw new Error(`Unsupported pseudo-class in selector ${JSON.stringify(src)}`);
    } else {
      throw new Error(`Bad selector ${JSON.stringify(src)}`);
    }
  }
  return sel;
}

function matchesSimple(el: FakeElement, sel: SimpleSel): boolean {
  if (sel.tag && el.tag !== sel.tag) return false;
  if (sel.id && el.getAttribute("id") !== sel.id) return false;
  const classes = el.classList();
  for (const c of sel.classes) if (!classes.includes(c)) return false;
  for (const a of sel.attrs) {
    const got = el.getAttribute(a.name);
    if (a.value === null) {
      if (got === null) return false;
    } else if (got !== a.value) {
      return false;
    }
  }
  return true;
}

/** Split on spaces, but not inside [brackets] or quotes. */
function splitChain(group: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let quote: string | null = null;
  for (const ch of group) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "[") {
      depth++;
      cur += ch;
    } else if (ch === "]") {
      depth--;
      cur += ch;
    } else if (/\s/.test(ch) && depth === 0) {
      if (cur) parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

function subtree(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [root];
  for (const c of root.children) out.push(...subtree(c));
  return out;
}

function queryAll(root: FakeElement, selector: string, includeSelf: boolean): FakeElement[] {
  const all = subtree(root);
  const allowed = new Set(all);
  const candidates = includeSelf ? all : all.slice(1);
  const out: FakeElement[] = [];
  for (const group of selector.split(",")) {
    const chain = splitChain(group.trim()).filter(Boolean).map(parseSimple);
    if (!chain.length) continue;
    const last = chain[chain.length - 1]!;
    for (const el of candidates) {
      if (!matchesSimple(el, last)) continue;
      let ok = true;
      let cur: FakeElement | null = el.parentNode;
      for (let i = chain.length - 2; i >= 0; i--) {
        let found: FakeElement | null = null;
        let p: FakeElement | null = cur;
        while (p && allowed.has(p)) {
          if (matchesSimple(p, chain[i]!)) {
            found = p;
            break;
          }
          p = p.parentNode;
        }
        if (!found) {
          ok = false;
          break;
        }
        cur = found.parentNode;
      }
      if (ok && !out.includes(el)) out.push(el);
    }
  }
  return out;
}

class FakeDocument {
  body: FakeElement;
  title = "";
  activeElement: FakeElement | null = null;
  private textObservers = new Set<{ element: FakeElement; values: string[]; previous: string; queued: boolean }>();

  // Sample at the mutation-observer microtask boundary, not at each assignment:
  // a same-turn clear/restore must NOT look like two observable announcements.
  observeText(element: FakeElement): string[] {
    const values: string[] = [];
    this.textObservers.add({ element, values, previous: element.textContent, queued: false });
    return values;
  }
  textMutated(): void {
    for (const observer of this.textObservers) {
      if (observer.queued) continue;
      observer.queued = true;
      queueMicrotask(() => {
        observer.queued = false;
        const text = observer.element.textContent;
        if (text !== observer.previous) {
          observer.values.push(text);
          observer.previous = text;
        }
      });
    }
  }

  constructor() {
    this.body = new FakeElement(this, "body");
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag.toLowerCase());
  }
  createTextNode(text: string): FakeText {
    return new FakeText(String(text));
  }
  getElementById(id: string): FakeElement | null {
    return subtree(this.body).find((el) => el.getAttribute("id") === id) ?? null;
  }
  querySelector(sel: string): FakeElement | null {
    return queryAll(this.body, sel, true)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    return queryAll(this.body, sel, true);
  }
  execCommand(_cmd: string): boolean {
    return false;
  }
}

function isHidden(el: FakeElement): boolean {
  return !!el.hidden || el.getAttribute("hidden") !== null;
}

function dump(el: FakeElement | FakeText, depth: number): string {
  const pad = "  ".repeat(depth);
  if (el instanceof FakeText) {
    const t = el.text.slice(0, 60).replace(/\s+/g, " ");
    return `${pad}#text ${JSON.stringify(t)}\n`;
  }
  const attrs = [...el.attrs.entries()].map(([k, v]) => `${k}=${JSON.stringify(v.slice(0, 40))}`).join(" ");
  let s = `${pad}<${el.tag}${attrs ? " " + attrs : ""}>\n`;
  if (depth > 6) return s;
  for (const c of el.childNodes.slice(0, 40)) s += dump(c, depth + 1);
  return s;
}

// ---------------------------------------------------------------------------
// Fixtures mirroring GET /api/v1/sites/:slug/files entries
// ---------------------------------------------------------------------------

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
  kind: string;
  extension: string;
  url: string;
  rawUrl: string;
}

function manifestFile(path: string, kind: string, size: number, contentType = "text/plain"): ManifestFile {
  const ext = path.split("/").pop()!.split(".").slice(1).join(".");
  return {
    path,
    size,
    sha256: "0".repeat(64),
    contentType,
    kind,
    extension: ext,
    url: `https://files.test/test-site/${path}`,
    rawUrl: `/api/v1/sites/test-site/files/${path}`,
  };
}

/** ASCII-only set for exact order assertions (byte order == locale order here). */
const ASCII_FILES: ManifestFile[] = [
  manifestFile("index.html", "html", 100, "text/html"),
  manifestFile("assets/app.js", "code", 10, "text/javascript"),
  manifestFile("assets/logo.svg", "svg", 2, "image/svg+xml"),
  manifestFile("docs/guide.md", "markdown", 10, "text/markdown"),
  manifestFile("docs/README.md", "markdown", 0, "text/markdown"),
  manifestFile("a/index.html", "html", 50, "text/html"),
  manifestFile("data/table.csv", "csv", 100, "text/csv"),
];

/** Full set adds a Unicode path for determinism/identity assertions. */
const FULL_FILES: ManifestFile[] = [...ASCII_FILES, manifestFile("café/naïve ☃.txt", "text", 5)];

const HISTORICAL_FILES: ManifestFile[] = [
  manifestFile("old.html", "html", 20, "text/html"),
  manifestFile("legacy/app.js", "code", 30, "text/javascript"),
];

function siteFixture(slug: string): Record<string, unknown> {
  return {
    slug,
    title: "Test Site",
    url: `https://${slug}.test/`,
    description: "",
    settings: { spa: false, renderMarkdown: true, crossOriginIsolation: false, passwordProtected: false },
  };
}

function versionFixture(id: string, number: number, live: boolean, fileCount: number): Record<string, unknown> {
  return {
    id,
    number,
    live,
    fileCount,
    totalBytes: 1000,
    message: live ? "live version" : "older version",
    client: "test",
    source: "test",
    finalizedAt: "2026-10-20T00:00:00.000Z",
    createdAt: "2026-10-19T00:00:00.000Z",
  };
}

function encodePath(p: string): string {
  return p
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

// Reference comparators defining the ordering contract.
type SortField = "path" | "kind" | "size";
type SortDirection = "ascending" | "descending";

function cmpPath(a: ManifestFile, b: ManifestFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
function cmpKindAsc(a: ManifestFile, b: ManifestFile): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return cmpPath(a, b);
}
function cmpSizeAsc(a: ManifestFile, b: ManifestFile): number {
  if (a.size !== b.size) return a.size - b.size;
  return cmpPath(a, b);
}
function expectedOrder(files: ManifestFile[], field: SortField, direction: SortDirection): string[] {
  const sorted = [...files];
  if (field === "path") {
    sorted.sort(cmpPath);
    if (direction === "descending") sorted.reverse();
    return sorted.map((f) => f.path);
  }
  if (field === "kind") {
    sorted.sort(cmpKindAsc);
    if (direction === "descending") {
      // Primary direction is exact; ties stay deterministic (asserted by repetition).
      sorted.sort((a, b) => (a.kind !== b.kind ? (a.kind < b.kind ? 1 : -1) : cmpPath(a, b)));
    }
    return sorted.map((f) => f.path);
  }
  sorted.sort(cmpSizeAsc);
  if (direction === "descending") {
    sorted.sort((a, b) => (a.size !== b.size ? b.size - a.size : cmpPath(a, b)));
  }
  return sorted.map((f) => f.path);
}

// ---------------------------------------------------------------------------
// Mount: run the real dashboard script in vm with stub browser globals
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  method: string;
}
interface StorageWrite {
  store: string;
  method: string;
  key: string;
}

class FakeStorage {
  map = new Map<string, string>();
  constructor(
    private name: string,
    private writes: StorageWrite[],
  ) {}
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.writes.push({ store: this.name, method: "setItem", key: k });
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.writes.push({ store: this.name, method: "removeItem", key: k });
    this.map.delete(k);
  }
}

class SandboxURL extends URL {
  static createObjectURL(_blob: unknown): string {
    return "blob:fake-download";
  }
  static revokeObjectURL(_url: string): void {}
}

interface MountOptions {
  liveFiles: ManifestFile[];
  historicalFiles?: ManifestFile[];
  slug?: string;
  writeClipboard?: (text: string) => Promise<void>;
}

async function tick(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`Missing ${what}`);
  return v;
}

interface Mounted {
  doc: FakeDocument;
  calls: FetchCall[];
  clipboardWrites: string[];
  storageWrites: StorageWrite[];
  filesSection: FakeElement;
  filterInput: FakeElement;
  tbody: FakeElement | null;
  rows(): FakeElement[];
  visibleRows(): FakeElement[];
  visiblePaths(): string[];
  settled(): Promise<void>;
  waitFor(cond: () => boolean, what: string): Promise<void>;
  click(el: FakeElement): void;
  setFilter(q: string): void;
  fireChange(el: FakeElement): void;
  /** Keyboard activation under real browser semantics: keydown, plus the click a
   *  native button/link/select fires for Enter/Space. Custom key handlers run first. */
  press(el: FakeElement, key: string): void;
}

async function mount(opts: MountOptions): Promise<Mounted> {
  const slug = opts.slug ?? "test-site";
  const liveFiles = opts.liveFiles;
  const historicalFiles = opts.historicalFiles;
  const versions = historicalFiles
    ? [versionFixture("v-live", 2, true, liveFiles.length), versionFixture("v-old", 1, false, historicalFiles.length)]
    : [versionFixture("v-live", 2, true, liveFiles.length)];

  const doc = new FakeDocument();
  doc.body.setAttribute("data-page", "site");
  const boot = doc.createElement("script");
  boot.setAttribute("id", "dw-boot");
  boot.setAttribute("type", "application/json");
  boot.textContent = JSON.stringify({
    v: 1,
    origin: "https://test/",
    instanceName: "Test",
    api: "/api/v1",
    sitesMode: "path",
    anonymousPublish: false,
    session: null,
    page: { name: "site", slug },
  });
  const account = doc.createElement("div");
  account.setAttribute("id", "dw-account");
  account.setAttribute("class", "dw-account");
  const root = doc.createElement("div");
  root.setAttribute("id", "dw-site");
  const toasts = doc.createElement("div");
  toasts.setAttribute("id", "dw-toasts");
  toasts.setAttribute("class", "dw-toasts");
  doc.body.appendChild(boot);
  doc.body.appendChild(account);
  doc.body.appendChild(root);
  doc.body.appendChild(toasts);

  const storageWrites: StorageWrite[] = [];
  const session = new FakeStorage("session", storageWrites);
  const local = new FakeStorage("local", storageWrites);
  session.map.set("dropway.key", "dw_test_key");

  const calls: FetchCall[] = [];
  const clipboardWrites: string[] = [];
  const jsonResponse = (data: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(data),
    json: async () => data,
    blob: async () => new Blob([JSON.stringify(data)]),
  });
  const fetchMock = async (url: unknown, init?: { method?: string; body?: unknown }): Promise<ReturnType<typeof jsonResponse>> => {
    const raw = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: raw, method });
    const path = raw.split("?")[0]!;
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
    const base = `/api/v1/sites/${slug}`;
    if (path === `${base}/files/` || path.startsWith(`${base}/files/`)) {
      return jsonResponse({ bytes: "test-bytes" });
    }
    if (path === `${base}/files`) {
      const versionId = new URLSearchParams(query).get("version") ?? "v-live";
      const version = versions.find((v) => v.id === versionId);
      if (!version) return jsonResponse({ error: { code: "not_found", message: "Unknown version", hint: "Select a fixture version." } }, 404);
      const files = versionId === "v-live" ? liveFiles : historicalFiles!;
      return jsonResponse({ version, files, total: files.length, nextCursor: null });
    }
    if (path === `${base}/versions`) return jsonResponse({ versions });
    if (path === base) return jsonResponse({ site: siteFixture(slug) });
    if (path === "/api/v1/me") {
      return jsonResponse({ principal: "member", scopes: ["sites:read", "sites:write"], member: { email: "owner@example.com", role: "owner" } });
    }
    return jsonResponse({ error: { code: "not_found", message: `No mock for ${raw}`, hint: "Sorts must not need new endpoints." } }, 404);
  };

  const locationStub = {
    href: `https://test/dashboard/sites/${slug}`,
    pathname: `/dashboard/sites/${slug}`,
    search: "",
    replace(_url: string): void {},
  };
  const sandbox: Record<string, unknown> = {
    document: doc,
    localStorage: local,
    sessionStorage: session,
    location: locationStub,
    history: { pushState(_a: unknown, _b: string, _c: string): void {} },
    navigator: { clipboard: { writeText: async (text: string) => {
      clipboardWrites.push(text);
      await opts.writeClipboard?.(text);
    } } },
    fetch: fetchMock,
    Headers,
    URL: SandboxURL,
    URLSearchParams,
    Blob,
    setTimeout,
    clearTimeout,
    console,
    matchMedia: (_q: string) => ({ matches: false, addEventListener(): void {}, removeEventListener(): void {} }),
  };
  sandbox.window = sandbox;
  sandbox.windowAddEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SCRIPT, sandbox, { filename: "app-dashboard.js" });

  const waitFor = async (cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for ${what}.\n${dump(doc.body, 0).slice(0, 4000)}`);
      }
      await tick(10);
    }
  };

  await waitFor(
    () => doc.querySelector("#files table") !== null || doc.querySelector("#files .dw-empty") !== null,
    "the version-files table (or empty state) to render",
  );

  const filesSection = must(doc.querySelector("#files"), "#files section");
  const filterInput = must(filesSection.querySelector("input[type=search]"), "the files filter input");
  const tbody = filesSection.querySelector("tbody");
  const rows = (): FakeElement[] => [...filesSection.querySelectorAll("tbody tr")];
  const visibleRows = (): FakeElement[] => rows().filter((r) => !isHidden(r));
  const pathOf = (tr: FakeElement): string => {
    const tds = tr.querySelectorAll("td");
    return must(tds[0], "path cell").textContent;
  };

  return {
    doc,
    calls,
    clipboardWrites,
    storageWrites,
    filesSection,
    filterInput,
    tbody,
    rows,
    visibleRows,
    visiblePaths: () => visibleRows().map(pathOf),
    settled: async () => {
      await tick(0);
      await tick(0);
      await tick(0);
    },
    waitFor,
    click: (el) => el.click(),
    setFilter: (q) => {
      filterInput.value = q;
      filterInput.dispatch("input", {});
    },
    fireChange: (el) => el.dispatch("change", {}),
    press: (el, key) => {
      el.focus();
      el.dispatch("keydown", { key });
      if ((key === "Enter" || key === " ") && (el.tag === "button" || el.tag === "a" || el.tag === "select" || el.tag === "input")) {
        el.dispatch("click", {});
      }
      if (key === "Enter" && el.tag === "select") el.dispatch("change", {});
    },
  };
}

// ---------------------------------------------------------------------------
// Sort driver: discovers header and/or toolbar sort UI and drives it
// ---------------------------------------------------------------------------

interface SortState {
  field: SortField;
  direction: SortDirection;
}

function fieldFromWord(word: string): SortField | null {
  const w = word.toLowerCase();
  if (w === "path" || w === "name" || w === "file" || w === "filename") return "path";
  if (w === "kind" || w === "type") return "kind";
  if (w === "size" || w === "bytes") return "size";
  return null;
}

function accessibleName(el: FakeElement): string {
  return (el.getAttribute("aria-label") ?? el.textContent ?? el.value ?? "").trim();
}

interface HeaderControl {
  field: SortField;
  th: FakeElement;
  activator: FakeElement;
}

interface ToolbarModel {
  fieldSelect: FakeElement | null;
  directionSelect: FakeElement | null;
  directionButton: FakeElement | null;
  fieldButtons: Map<SortField, FakeElement>;
}

function discoverHeaders(filesSection: FakeElement): HeaderControl[] {
  const out: HeaderControl[] = [];
  for (const th of filesSection.querySelectorAll("th")) {
    const dataField = th.getAttribute("data-sort-field") ?? th.querySelector("button")?.getAttribute("data-sort-field");
    let field: SortField | null = dataField ? fieldFromWord(dataField) : null;
    if (!field) {
      const label = th.textContent.toLowerCase();
      if (label.includes("path") || label.includes("name")) field = "path";
      else if (label.includes("kind") || label.includes("type")) field = "kind";
      else if (label.includes("size") || label.includes("bytes")) field = "size";
    }
    if (!field) continue;
    const button = th.querySelector("button");
    const selfFocusable = (th.tabIndex >= 0 && th.getAttribute("role") !== null) || th.hasAttribute("data-sort-field");
    const hasSortMarker =
      th.getAttribute("aria-sort") !== null || dataField !== null || (button !== null && /sort/.test(accessibleName(button).toLowerCase()));
    const headerButton = button !== null && (hasSortMarker || th.textContent.toLowerCase().includes(field === "path" ? "path" : field));
    if (button && headerButton) {
      // A button in a Path/Kind/Size header with any sort marker (or header context) is a sort control.
      if (hasSortMarker || true) out.push({ field, th, activator: button });
    } else if (selfFocusable && th.getAttribute("aria-sort") !== null) {
      out.push({ field, th, activator: th });
    } else if (hasSortMarker && !button && th.tabIndex >= 0) {
      out.push({ field, th, activator: th });
    }
  }
  // Deduplicate by field (first wins).
  const seen = new Set<SortField>();
  return out.filter((h) => (seen.has(h.field) ? false : (seen.add(h.field), true)));
}

function discoverToolbar(filesSection: FakeElement): ToolbarModel {
  const model: ToolbarModel = { fieldSelect: null, directionSelect: null, directionButton: null, fieldButtons: new Map() };
  for (const select of filesSection.querySelectorAll("select")) {
    const name = accessibleName(select).toLowerCase();
    const options = select.querySelectorAll("option").map((o) => (o.getAttribute("value") ?? o.textContent).trim());
    const optionWords = options.join(" ").toLowerCase();
    const mentionsField = ["path", "kind", "size", "name", "type", "bytes"].some((w) => optionWords.includes(w));
    const mentionsDirection = ["asc", "desc", "direction", "order"].some((w) => optionWords.includes(w) || name.includes(w));
    if (name.includes("sort") && mentionsField && !model.fieldSelect) model.fieldSelect = select;
    else if (name.includes("sort") && mentionsDirection && !model.directionSelect) model.directionSelect = select;
    else if (mentionsField && !mentionsDirection && !model.fieldSelect) model.fieldSelect = select;
    else if (mentionsDirection && !mentionsField && !model.directionSelect) model.directionSelect = select;
  }
  for (const button of filesSection.querySelectorAll("button")) {
    // Skip header buttons and row actions (Download/Open are links or per-row buttons).
    if (button.querySelectorAll("*").length === 0) {
      const name = accessibleName(button).toLowerCase();
      const inRow = ancestorHas(button, (a) => a.tag === "tr" && a.getAttribute("data-search") !== null);
      if (inRow) continue;
      const inTh = ancestorHas(button, (a) => a.tag === "th");
      if (inTh) continue;
      if (!name.includes("sort") && !name.includes("direction") && !name.includes("order")) continue;
      const fieldWord = ["path", "kind", "size", "name", "type", "bytes"].find((w) => name.includes(w));
      if (fieldWord) {
        const field = fieldFromWord(fieldWord)!;
        if (!model.fieldButtons.has(field)) model.fieldButtons.set(field, button);
      } else if (!model.directionButton) {
        model.directionButton = button;
      }
    }
  }
  return model;
}

function ancestorHas(el: FakeElement, pred: (a: FakeElement) => boolean): boolean {
  let p = el.parentNode;
  while (p) {
    if (pred(p)) return true;
    p = p.parentNode;
  }
  return false;
}

function directionFromText(text: string): SortDirection | null {
  const t = text.toLowerCase();
  if (t.includes("desc")) return "descending";
  if (t.includes("asc")) return "ascending";
  if (t.includes("▼") || t.includes("↓") || t.includes("▼")) return "descending";
  if (t.includes("▲") || t.includes("↑") || t.includes("▲")) return "ascending";
  return null;
}

interface Sorter {
  mode: string;
  state(): SortState;
  setSort(field: SortField, direction: SortDirection): Promise<void>;
  controls(field: SortField): FakeElement[];
  allControls(): FakeElement[];
}

function createSorter(m: Mounted): Sorter {
  const headers = discoverHeaders(m.filesSection);
  const toolbar = discoverToolbar(m.filesSection);
  const headerFields = new Set(headers.map((h) => h.field));
  const toolbarCanField = (f: SortField): boolean => toolbar.fieldSelect !== null || toolbar.fieldButtons.has(f);
  const toolbarCoversAll = (["path", "kind", "size"] as const).every(toolbarCanField);
  const headersCoverAll = headerFields.has("path") && headerFields.has("kind") && headerFields.has("size");

  if (!headersCoverAll && !toolbarCoversAll) {
    const thLabels = m.filesSection.querySelectorAll("th").map((th) => JSON.stringify(th.textContent.trim()));
    const buttons = m.filesSection.querySelectorAll("button").map((b) => JSON.stringify(accessibleName(b).slice(0, 40)));
    const selects = m.filesSection.querySelectorAll("select").map((s) => JSON.stringify(accessibleName(s).slice(0, 40)));
    throw new Error(
      `No version-files sort UI found: expected one keyboard-focusable control per field (Path, Kind, Size) ` +
        `as sortable th buttons (with aria-sort) or a labelled toolbar (selects/buttons). Headers with sort affordance: ` +
        `${headers.map((h) => h.field).join(", ") || "none"}. Toolbar field select: ${toolbar.fieldSelect ? "yes" : "no"}. ` +
        `th labels: [${thLabels.join(", ")}]. buttons: [${buttons.join(", ")}]. selects: [${selects.join(", ")}].`,
    );
  }
  const mode = headersCoverAll && toolbarCoversAll ? "mixed" : headersCoverAll ? "headers" : "toolbar";

  const state = (): SortState => {
    const sorted = m.filesSection
      .querySelectorAll("th")
      .filter((th) => th.getAttribute("aria-sort") === "ascending" || th.getAttribute("aria-sort") === "descending");
    if (sorted.length > 1) {
      throw new Error(`Untruthful sort state: ${sorted.length} headers carry aria-sort; exactly one may.`);
    }
    if (headers.length > 0 && sorted.length === 0) {
      throw new Error("Untruthful sort state: sortable headers exist but none carries active aria-sort; toolbar state cannot substitute.");
    }
    if (sorted.length === 1) {
      const th = sorted[0]!;
      const header = headers.find((h) => h.th === th);
      const field = header?.field ?? fieldFromHeaderLabel(th.textContent);
      if (!field) throw new Error("Untruthful sort state: aria-sort is on an unrecognized header.");
      return { field, direction: th.getAttribute("aria-sort") as SortDirection };
    }
    // Toolbar-native state: field select plus an explicit direction indicator.
    if (toolbar.fieldSelect) {
      const field = matchFieldOption(toolbar.fieldSelect, toolbar.fieldSelect.value) ?? matchFieldOption(toolbar.fieldSelect, selectedOptionText(toolbar.fieldSelect));
      if (!field) throw new Error(`Cannot read toolbar sort field from value ${JSON.stringify(toolbar.fieldSelect.value)}.`);
      if (toolbar.directionSelect) {
        const dir = matchDirectionOption(toolbar.directionSelect, toolbar.directionSelect.value) ?? directionFromText(selectedOptionText(toolbar.directionSelect));
        if (!dir) throw new Error(`Cannot read toolbar sort direction from value ${JSON.stringify(toolbar.directionSelect.value)}.`);
        return { field, direction: dir };
      }
      if (toolbar.directionButton) {
        const dir = directionFromText(accessibleName(toolbar.directionButton));
        if (!dir) {
          throw new Error(
            `Cannot read toolbar sort direction from button ${JSON.stringify(accessibleName(toolbar.directionButton))}: ` +
              `name it with ascending/descending (or Asc/Desc, or up/down arrows).`,
          );
        }
        return { field, direction: dir };
      }
      // Field buttons alone: the pressed/active button carries the state.
      for (const [f, btn] of toolbar.fieldButtons) {
        if (btn.getAttribute("aria-pressed") === "true" || directionFromText(accessibleName(btn)) !== null) {
          const dir = directionFromText(accessibleName(btn)) ?? "ascending";
          return { field: f, direction: dir };
        }
      }
    }
    if (toolbar.fieldButtons.size > 0) {
      for (const [f, btn] of toolbar.fieldButtons) {
        const dir = directionFromText(accessibleName(btn));
        if (btn.getAttribute("aria-pressed") === "true" || dir) return { field: f, direction: dir ?? "ascending" };
      }
    }
    throw new Error(
      "No truthful sort state found: reflect the active sort with aria-sort on its th, or with an explicit toolbar state " +
        "(field select plus a direction select/button naming ascending/descending).",
    );
  };

  const setSort = async (field: SortField, direction: SortDirection): Promise<void> => {
    if (headersCoverAll) {
      const header = must(
        headers.find((h) => h.field === field),
        `header sort control for ${field}`,
      );
      for (let i = 0; i < 4; i++) {
        let current: SortState | null = null;
        try {
          current = state();
        } catch {
          current = null;
        }
        if (current && current.field === field && current.direction === direction) return;
        m.click(header.activator);
        await m.settled();
      }
      throw new Error(`Could not reach ${field} ${direction} via its header control (4 activations). Last state: ${JSON.stringify(safeState())}.`);
    }
    // Toolbar-driven.
    if (toolbar.fieldSelect) {
      setSelectToField(toolbar.fieldSelect, field);
      m.fireChange(toolbar.fieldSelect);
      await m.settled();
    } else {
      const btn = must(toolbar.fieldButtons.get(field), `toolbar sort button for ${field}`);
      m.click(btn);
      await m.settled();
    }
    for (let i = 0; i < 4; i++) {
      let current: SortState | null = null;
      try {
        current = state();
      } catch {
        current = null;
      }
      if (current && current.field === field && current.direction === direction) return;
      if (toolbar.directionSelect) {
        setSelectToDirection(toolbar.directionSelect, direction);
        m.fireChange(toolbar.directionSelect);
      } else if (toolbar.directionButton) {
        m.click(toolbar.directionButton);
      } else if (toolbar.fieldSelect) {
        // Single-select toolbars sometimes toggle on re-select; otherwise this is a no-op retry.
        m.fireChange(toolbar.fieldSelect);
      } else {
        const btn = must(toolbar.fieldButtons.get(field), `toolbar sort button for ${field}`);
        m.click(btn);
      }
      await m.settled();
    }
    throw new Error(`Could not reach ${field} ${direction} via the toolbar (4 attempts). Last state: ${JSON.stringify(safeState())}.`);
  };

  const safeState = (): unknown => {
    try {
      return state();
    } catch (e) {
      return String(e).slice(0, 200);
    }
  };

  const controls = (field: SortField): FakeElement[] => {
    const out: FakeElement[] = [];
    const header = headers.find((h) => h.field === field);
    if (header) out.push(header.activator);
    const fieldBtn = toolbar.fieldButtons.get(field);
    if (fieldBtn) out.push(fieldBtn);
    if (toolbar.fieldSelect && toolbarCoversAll) out.push(toolbar.fieldSelect);
    if (toolbar.directionSelect && !out.includes(toolbar.directionSelect)) out.push(toolbar.directionSelect);
    if (toolbar.directionButton && !out.includes(toolbar.directionButton)) out.push(toolbar.directionButton);
    return out;
  };

  const allControls = (): FakeElement[] => {
    const out: FakeElement[] = [];
    for (const h of headers) out.push(h.activator);
    if (toolbar.fieldSelect) out.push(toolbar.fieldSelect);
    if (toolbar.directionSelect) out.push(toolbar.directionSelect);
    if (toolbar.directionButton) out.push(toolbar.directionButton);
    for (const btn of toolbar.fieldButtons.values()) if (!out.includes(btn)) out.push(btn);
    return out;
  };

  return { mode, state, setSort, controls, allControls };
}

function fieldFromHeaderLabel(label: string): SortField | null {
  const t = label.toLowerCase();
  if (t.includes("path") || t.includes("name")) return "path";
  if (t.includes("kind") || t.includes("type")) return "kind";
  if (t.includes("size") || t.includes("bytes")) return "size";
  return null;
}

function optionValues(select: FakeElement): Array<{ value: string; text: string }> {
  return select.querySelectorAll("option").map((o) => ({ value: o.getAttribute("value") ?? o.textContent, text: o.textContent }));
}

function selectedOptionText(select: FakeElement): string {
  const found = optionValues(select).find((o) => o.value === select.value);
  return found ? found.text : "";
}

function matchFieldOption(select: FakeElement, candidate: string): SortField | null {
  const c = candidate.trim().toLowerCase();
  if (!c) return null;
  const direct = fieldFromWord(c);
  if (direct) return direct;
  for (const o of optionValues(select)) {
    if (o.value.toLowerCase() === c || o.text.toLowerCase() === c) {
      const byWord = fieldFromWord(o.value) ?? fieldFromWord(o.text);
      if (byWord) return byWord;
    }
  }
  for (const w of c.split(/[^a-z]+/)) {
    const byWord = fieldFromWord(w);
    if (byWord) return byWord;
  }
  return null;
}

function matchDirectionOption(select: FakeElement, candidate: string): SortDirection | null {
  const direct = directionFromText(candidate);
  if (direct) return direct;
  for (const o of optionValues(select)) {
    if (o.value.toLowerCase() === candidate.trim().toLowerCase()) return directionFromText(o.text) ?? directionFromText(o.value);
  }
  return null;
}

function setSelectToField(select: FakeElement, field: SortField): void {
  const options = optionValues(select);
  const match =
    options.find((o) => o.value.toLowerCase() === field) ??
    options.find((o) => o.text.toLowerCase() === field) ??
    options.find((o) => (fieldFromWord(o.value) ?? fieldFromWord(o.text)) === field);
  if (!match) throw new Error(`Toolbar field select has no option for ${field} (options: ${options.map((o) => JSON.stringify(o.text)).join(", ")}).`);
  select.value = match.value;
}

function setSelectToDirection(select: FakeElement, direction: SortDirection): void {
  const want = direction === "ascending" ? "asc" : "desc";
  const options = optionValues(select);
  const match =
    options.find((o) => o.value.toLowerCase() === direction) ??
    options.find((o) => o.text.toLowerCase() === direction) ??
    options.find((o) => o.value.toLowerCase().includes(want) || o.text.toLowerCase().includes(want));
  if (!match) {
    throw new Error(`Toolbar direction select has no option for ${direction} (options: ${options.map((o) => JSON.stringify(o.text)).join(", ")}).`);
  }
  select.value = match.value;
}

// Direct select drivers never choose a header, even when both surfaces exist.
function toolbarSelects(m: Mounted): { field: FakeElement; direction: FakeElement } {
  const toolbar = discoverToolbar(m.filesSection);
  return {
    field: must(toolbar.fieldSelect, "toolbar field select"),
    direction: must(toolbar.directionSelect, "toolbar direction select"),
  };
}

async function changeToolbarField(m: Mounted, field: SortField): Promise<void> {
  const select = toolbarSelects(m).field;
  setSelectToField(select, field);
  m.fireChange(select);
  await m.settled();
}

async function changeToolbarDirection(m: Mounted, direction: SortDirection): Promise<void> {
  const select = toolbarSelects(m).direction;
  setSelectToDirection(select, direction);
  m.fireChange(select);
  await m.settled();
}

function assertSynchronizedSort(m: Mounted, field: SortField, direction: SortDirection): void {
  const headers = discoverHeaders(m.filesSection);
  expect(headers.map((header) => header.field).sort(), "sortable headers for every field").toEqual(["kind", "path", "size"]);
  const active = must(headers.find((header) => header.field === field), `active ${field} header`);
  const activeHeaders = m.filesSection.querySelectorAll("th").filter((th) =>
    th.getAttribute("aria-sort") === "ascending" || th.getAttribute("aria-sort") === "descending",
  );
  expect(activeHeaders.length, "exactly one header exposes active aria-sort, independently of toolbar values").toBe(1);
  expect(activeHeaders[0] === active.th, `aria-sort belongs to the ${field} header`).toBe(true);
  expect(active.th.getAttribute("aria-sort"), `${field} header direction`).toBe(direction);
  for (const header of headers) {
    if (header !== active) {
      expect([null, "none"], `inactive ${header.field} header does not claim ordering`).toContain(header.th.getAttribute("aria-sort"));
    }
  }
  const selects = toolbarSelects(m);
  expect(matchFieldOption(selects.field, selects.field.value), "toolbar field tracks header state").toBe(field);
  expect(matchDirectionOption(selects.direction, selects.direction.value), "toolbar direction tracks header state").toBe(direction);
  expect(createSorter(m).state(), "header-driven state does not fall back to native selects").toEqual({ field, direction });
}

// Hand-checked full-path orders, including the 10-byte and 100-byte ties.
const TOOLBAR_ORDERS: Array<{ field: SortField; ascending: string[]; descending: string[] }> = [
  {
    field: "path",
    ascending: ["a/index.html", "assets/app.js", "assets/logo.svg", "data/table.csv", "docs/README.md", "docs/guide.md", "index.html"],
    descending: ["index.html", "docs/guide.md", "docs/README.md", "data/table.csv", "assets/logo.svg", "assets/app.js", "a/index.html"],
  },
  {
    field: "kind",
    ascending: ["assets/app.js", "data/table.csv", "a/index.html", "index.html", "docs/README.md", "docs/guide.md", "assets/logo.svg"],
    descending: ["assets/logo.svg", "docs/README.md", "docs/guide.md", "a/index.html", "index.html", "data/table.csv", "assets/app.js"],
  },
  {
    field: "size",
    ascending: ["docs/README.md", "assets/logo.svg", "assets/app.js", "docs/guide.md", "a/index.html", "data/table.csv", "index.html"],
    descending: ["data/table.csv", "index.html", "a/index.html", "assets/app.js", "docs/guide.md", "assets/logo.svg", "docs/README.md"],
  },
];

// ---------------------------------------------------------------------------
// Row reading and association assertions
// ---------------------------------------------------------------------------

interface RowView {
  tr: FakeElement;
  path: string;
  kind: string;
  sizeText: string;
  pathLinkHref: string | null;
  openHref: string | null;
  downloadButton: FakeElement | null;
}

function readRow(tr: FakeElement): RowView {
  const tds = tr.querySelectorAll("td");
  const pathCell = must(tds[0], "path cell");
  const kindCell = must(tds[1], "kind cell");
  const sizeCell = must(tds[2], "size cell");
  const actions = must(tr.querySelector(".act") ?? tds[tds.length - 1], "actions cell");
  const pathLink = pathCell.querySelector("a");
  const open = actions.querySelector("a[target=_blank]");
  const downloadButton = actions.querySelectorAll("button").find((b) => b.textContent.trim() === "Download") ?? null;
  return {
    tr,
    path: pathCell.textContent,
    kind: kindCell.textContent,
    sizeText: sizeCell.textContent,
    pathLinkHref: pathLink ? pathLink.getAttribute("href") : null,
    openHref: open ? open.getAttribute("href") : null,
    downloadButton,
  };
}

function assertRowsMatchFixtures(m: Mounted, fixtures: ManifestFile[], live: boolean, slug = "test-site"): void {
  const views = m.visibleRows().map(readRow);
  expect(views.map((v) => v.path).sort()).toEqual(fixtures.map((f) => f.path).sort());
  expect(views.length).toBe(fixtures.length);
  const byPath = new Map(fixtures.map((f) => [f.path, f]));
  for (const v of views) {
    const f = must(byPath.get(v.path), `fixture for row ${JSON.stringify(v.path)}`);
    expect(v.kind, `kind for ${v.path}`).toBe(f.kind);
    // textContent concatenates an optional secondary size without its visual spacing.
    const exactBytes = /^(\d{1,3}(?:,\d{3})+|\d+) bytes?(?=$|[^a-z])/i.exec(v.sizeText);
    expect(exactBytes, `exact byte count for ${v.path}: ${JSON.stringify(v.sizeText)}`).not.toBeNull();
    expect(Number(exactBytes![1]!.replace(/,/g, "")), `manifest bytes for ${v.path}`).toBe(f.size);
    if (live) {
      expect(v.pathLinkHref, `path link for ${v.path}`).toBe(`/v/${slug}/${encodePath(f.path)}`);
      expect(v.openHref, `Open href for ${v.path}`).toBe(f.url);
    } else {
      expect(v.pathLinkHref, `historical path must not link (${v.path})`).toBeNull();
      expect(v.openHref, `historical row must not offer Open (${v.path})`).toBeNull();
    }
    expect(v.downloadButton, `Download button for ${v.path}`).not.toBeNull();
  }
}

// ---------------------------------------------------------------------------
// Controls: the harness drives the real panel (green on the current baseline)
// ---------------------------------------------------------------------------

describe("version-files panel harness controls", () => {
  it("serves a script built with safe DOM construction (no HTML sinks)", () => {
    expect(CLIENT_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("renders every manifest entry with its path, kind, size and live targets", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    assertRowsMatchFixtures(m, ASCII_FILES, true);
  });

  it("renders exact bytes even when a human-readable size would round adjacent values together", async () => {
    const files = [manifestFile("a.bin", "binary", 1024), manifestFile("b.bin", "binary", 1025)];
    const m = await mount({ liveFiles: files });
    assertRowsMatchFixtures(m, files, true);
    await createSorter(m).setSort("size", "descending");
    expect(m.visiblePaths()).toEqual(["b.bin", "a.bin"]);
    assertRowsMatchFixtures(m, files, true);
  });

  it("pins metadata requests to the selected immutable version for both live and historical rows", async () => {
    const m = await mount({ liveFiles: ASCII_FILES, historicalFiles: HISTORICAL_FILES });
    const metadataVersionIds = () => m.calls
      .map((call) => new URL(call.url, "https://test/"))
      .filter((url) => url.pathname === "/api/v1/sites/test-site/files")
      .map((url) => url.searchParams.get("version"));
    expect(metadataVersionIds()).toEqual(["v-live"]);
    const filesButtons = m.doc.querySelectorAll("button").filter((b) => b.textContent.trim() === "Files");
    m.click(filesButtons[1]!);
    await m.waitFor(() => m.visiblePaths().length === HISTORICAL_FILES.length, "historical rows");
    assertRowsMatchFixtures(m, HISTORICAL_FILES, false);
    m.click(filesButtons[0]!);
    await m.waitFor(() => m.visiblePaths().length === ASCII_FILES.length, "live rows again");
    assertRowsMatchFixtures(m, ASCII_FILES, true);
    expect(metadataVersionIds()).toEqual(["v-live", "v-old", "v-live"]);
  });

  it("filters by path without issuing new requests", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const before = m.calls.length;
    m.setFilter("docs");
    await m.settled();
    expect(m.visiblePaths().sort()).toEqual(["docs/README.md", "docs/guide.md"]);
    expect(m.rows().filter((r) => isHidden(r)).length).toBe(ASCII_FILES.length - 2);
    expect(m.calls.length).toBe(before);
  });

  it("downloads request the encoded path of their own row", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const row = must(m.visibleRows().map(readRow).find((v) => v.path === "docs/guide.md"), "row for docs/guide.md");
    const before = m.calls.length;
    m.click(must(row.downloadButton, "Download button"));
    await m.waitFor(() => m.calls.length > before, "the download request");
    const last = m.calls[m.calls.length - 1]!;
    expect(last.url).toContain(`/api/v1/sites/test-site/files/${encodePath("docs/guide.md")}`);
    // Even a live-marked row describes an immutable manifest: a later publish
    // must not change the bytes of this individual download.
    expect(new URL(last.url, "https://test/").searchParams.get("version")).toBe("v-live");
  });

  it("switching versions swaps rows and link semantics without losing the panel", async () => {
    const m = await mount({ liveFiles: ASCII_FILES, historicalFiles: HISTORICAL_FILES });
    const filesButtons = m.doc.querySelectorAll("button").filter((b) => b.textContent.trim() === "Files");
    expect(filesButtons.length).toBe(2);
    m.click(filesButtons[1]!);
    await m.waitFor(() => m.visiblePaths().sort().join("|") === HISTORICAL_FILES.map((f) => f.path).sort().join("|"), "historical rows");
    assertRowsMatchFixtures(m, HISTORICAL_FILES, false);
    m.click(filesButtons[0]!);
    await m.waitFor(() => m.visiblePaths().length === ASCII_FILES.length, "live rows again");
    assertRowsMatchFixtures(m, ASCII_FILES, true);
  });
});

// ---------------------------------------------------------------------------
// Sort controls: presence, labels, truthful state, default
// ---------------------------------------------------------------------------

describe("version-files sorting controls", () => {
  it("exposes one keyboard-focusable control per field (Path, Kind, Size)", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    for (const field of ["path", "kind", "size"] as const) {
      const ctrls = sorter.controls(field);
      expect(ctrls.length, `sort controls for ${field} (mode: ${sorter.mode})`).toBeGreaterThan(0);
      for (const el of ctrls) {
        const focusable = (NATIVELY_FOCUSABLE.has(el.tag) && !el.disabled) || el.tabIndex >= 0;
        expect(focusable, `${field} control <${el.tag}> is keyboard-focusable`).toBe(true);
      }
    }
  });

  it("exposes the active sort truthfully (aria-sort or equally explicit native state)", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    const s = sorter.state();
    expect(["path", "kind", "size"]).toContain(s.field);
    expect(["ascending", "descending"]).toContain(s.direction);
    // State must match reality: the visible order equals the claimed ordering.
    expect(m.visiblePaths()).toEqual(expectedOrder(ASCII_FILES, s.field, s.direction));
  });

  it("defaults to deterministic Path ascending", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    expect(m.visiblePaths()).toEqual(expectedOrder(ASCII_FILES, "path", "ascending"));
    const sorter = createSorter(m);
    expect(sorter.state()).toEqual({ field: "path", direction: "ascending" });
  });

  it("first activation of an inactive field sorts ascending, then toggles", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    await sorter.setSort("size", "ascending");
    expect(sorter.state()).toEqual({ field: "size", direction: "ascending" });
    await sorter.setSort("size", "descending");
    expect(sorter.state()).toEqual({ field: "size", direction: "descending" });
    await sorter.setSort("kind", "ascending");
    expect(sorter.state()).toEqual({ field: "kind", direction: "ascending" });
  });
});

// ---------------------------------------------------------------------------
// Independent toolbar interactions and header accessibility (no native fallback)
// ---------------------------------------------------------------------------

describe("version-files toolbar sorting and header aria-sort", () => {
  it("exposes exactly one correct active header at default and after each header interaction", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const callsBefore = [...m.calls];
    const writesBefore = [...m.storageWrites];
    assertSynchronizedSort(m, "path", "ascending");
    for (const orders of TOOLBAR_ORDERS) {
      const header = must(discoverHeaders(m.filesSection).find((h) => h.field === orders.field), `${orders.field} header`);
      // Path starts active, so its first click descends; inactive fields start ascending.
      const directions: SortDirection[] = orders.field === "path" ? ["descending", "ascending"] : ["ascending", "descending"];
      for (const direction of directions) {
        m.click(header.activator);
        await m.settled();
        expect(m.visiblePaths()).toEqual(orders[direction]);
        assertSynchronizedSort(m, orders.field, direction);
      }
    }
    expect(m.calls, "header sorting performs no requests").toEqual(callsBefore);
    expect(m.storageWrites, "header sorting writes no preferences").toEqual(writesBefore);
  });

  it.each(TOOLBAR_ORDERS)("sorts $field through toolbar change events in both directions, including ties", async (orders) => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const callsBefore = [...m.calls];
    const writesBefore = [...m.storageWrites];
    // Start on a different header descending: a no-op field handler must not pass.
    const previousField = orders.field === "size" ? "kind" : "size";
    await createSorter(m).setSort(previousField, "descending");
    assertSynchronizedSort(m, previousField, "descending");
    await changeToolbarField(m, orders.field);
    expect(m.visiblePaths(), "field change itself sorts ascending").toEqual(orders.ascending);
    assertSynchronizedSort(m, orders.field, "ascending");
    for (const direction of ["descending", "ascending", "descending"] as const) {
      await changeToolbarDirection(m, direction);
      expect(m.visiblePaths(), `toolbar ${orders.field} ${direction}`).toEqual(orders[direction]);
      assertSynchronizedSort(m, orders.field, direction);
      assertRowsMatchFixtures(m, ASCII_FILES, true);
      expect(m.calls, "toolbar sorts request no metadata or content").toEqual(callsBefore);
      expect(m.storageWrites, "toolbar sorts persist no preferences").toEqual(writesBefore);
    }
    // Header activation after toolbar changes must use that same active sort state.
    const header = must(discoverHeaders(m.filesSection).find((h) => h.field === orders.field), `${orders.field} header`);
    m.click(header.activator);
    await m.settled();
    expect(m.visiblePaths()).toEqual(orders.ascending);
    assertSynchronizedSort(m, orders.field, "ascending");
    expect(m.calls).toEqual(callsBefore);
    expect(m.storageWrites).toEqual(writesBefore);
  });

  it.each(TOOLBAR_ORDERS)("retains an active filter during $field toolbar changes without requests or storage writes", async (orders) => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const callsBefore = [...m.calls];
    const writesBefore = [...m.storageWrites];
    m.setFilter("assets");
    await m.settled();
    await changeToolbarField(m, orders.field);
    for (const direction of ["ascending", "descending"] as const) {
      await changeToolbarDirection(m, direction);
      const assetsFirst = orders.field === "size" ? direction === "descending" : direction === "ascending";
      expect(m.visiblePaths()).toEqual(assetsFirst ? ["assets/app.js", "assets/logo.svg"] : ["assets/logo.svg", "assets/app.js"]);
      expect(m.filterInput.value, "toolbar changes preserve the query").toBe("assets");
      expect(m.rows().filter(isHidden).length, "nonmatching rows remain hidden").toBe(5);
      assertSynchronizedSort(m, orders.field, direction);
      expect(m.calls).toEqual(callsBefore);
      expect(m.storageWrites).toEqual(writesBefore);
    }
    m.setFilter("");
    await m.settled();
    expect(m.visiblePaths(), "clearing the filter retains toolbar ordering").toEqual(orders.descending);
    assertSynchronizedSort(m, orders.field, "descending");
    expect(m.calls).toEqual(callsBefore);
    expect(m.storageWrites).toEqual(writesBefore);
  });
});

// ---------------------------------------------------------------------------
// Field orderings
// ---------------------------------------------------------------------------

describe("version-files field orderings", () => {
  it("orders Path ascending and descending by full path", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    await sorter.setSort("path", "ascending");
    expect(m.visiblePaths()).toEqual(expectedOrder(ASCII_FILES, "path", "ascending"));
    await sorter.setSort("path", "descending");
    expect(m.visiblePaths()).toEqual(expectedOrder(ASCII_FILES, "path", "descending"));
    assertRowsMatchFixtures(m, ASCII_FILES, true);
  });

  it("orders Kind with the full path as tie-breaker", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    await sorter.setSort("kind", "ascending");
    expect(m.visiblePaths()).toEqual(expectedOrder(ASCII_FILES, "kind", "ascending"));
    // html tie: a/index.html before index.html; markdown tie: README before guide.
    const paths = m.visiblePaths();
    expect(paths.indexOf("a/index.html")).toBeLessThan(paths.indexOf("index.html"));
    expect(paths.indexOf("docs/README.md")).toBeLessThan(paths.indexOf("docs/guide.md"));
    assertRowsMatchFixtures(m, ASCII_FILES, true);
  });

  it("orders Kind descending primarily, deterministically across repeats", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    await sorter.setSort("kind", "descending");
    const kinds = m.visibleRows().map(readRow).map((v) => v.kind);
    const sorted = [...kinds].sort().reverse();
    expect(kinds).toEqual(sorted);
    const first = m.visiblePaths();
    await sorter.setSort("path", "ascending");
    await sorter.setSort("kind", "descending");
    expect(m.visiblePaths()).toEqual(first);
  });

  it("orders Size by exact numeric bytes, not formatted text (2 < 10 < 100)", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    await sorter.setSort("size", "ascending");
    expect(m.visiblePaths()).toEqual(expectedOrder(ASCII_FILES, "size", "ascending"));
    const sizes = m.visibleRows().map(readRow).map((v) => ASCII_FILES.find((f) => f.path === v.path)!.size);
    expect(sizes).toEqual([0, 2, 10, 10, 50, 100, 100]);
    await sorter.setSort("size", "descending");
    const descSizes = m.visibleRows().map(readRow).map((v) => ASCII_FILES.find((f) => f.path === v.path)!.size);
    expect(descSizes).toEqual([100, 100, 50, 10, 10, 2, 0]);
    assertRowsMatchFixtures(m, ASCII_FILES, true);
  });

  it("keeps equal sizes in deterministic full-path order", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    await sorter.setSort("size", "ascending");
    const paths = m.visiblePaths();
    // 10-byte tie: assets/app.js before docs/guide.md; 100-byte tie: data/table.csv before index.html.
    expect(paths.indexOf("assets/app.js")).toBeLessThan(paths.indexOf("docs/guide.md"));
    expect(paths.indexOf("data/table.csv")).toBeLessThan(paths.indexOf("index.html"));
    const first = [...paths];
    await sorter.setSort("size", "descending");
    await sorter.setSort("size", "ascending");
    expect(m.visiblePaths()).toEqual(first);
  });

  it("places zero-byte files first ascending and last descending", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    await sorter.setSort("size", "ascending");
    expect(m.visiblePaths()[0]).toBe("docs/README.md");
    await sorter.setSort("size", "descending");
    const paths = m.visiblePaths();
    expect(paths[paths.length - 1]).toBe("docs/README.md");
  });

  it("keeps same basenames under different paths distinct and ordered by full path", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    await sorter.setSort("path", "ascending");
    const views = m.visibleRows().map(readRow);
    const a = must(views.find((v) => v.path === "a/index.html"), "a/index.html row");
    const root = must(views.find((v) => v.path === "index.html"), "index.html row");
    expect(m.visiblePaths().indexOf("a/index.html")).toBeLessThan(m.visiblePaths().indexOf("index.html"));
    expect(a.pathLinkHref).toBe(`/v/test-site/${encodePath("a/index.html")}`);
    expect(root.pathLinkHref).toBe(`/v/test-site/${encodePath("index.html")}`);
    expect(a.openHref).not.toBe(root.openHref);
  });

  it("handles Unicode paths deterministically without losing row identity", async () => {
    const m = await mount({ liveFiles: FULL_FILES });
    const sorter = createSorter(m);
    await sorter.setSort("path", "ascending");
    const first = m.visiblePaths();
    expect(first.length).toBe(FULL_FILES.length);
    await sorter.setSort("size", "descending");
    await sorter.setSort("path", "ascending");
    expect(m.visiblePaths()).toEqual(first);
    // Numeric size order still holds with the Unicode entry (5 bytes) in place.
    await sorter.setSort("size", "ascending");
    const sizes = m.visibleRows().map(readRow).map((v) => FULL_FILES.find((f) => f.path === v.path)!.size);
    expect(sizes).toEqual([0, 2, 5, 10, 10, 50, 100, 100]);
    assertRowsMatchFixtures(m, FULL_FILES, true);
  });

  it("repeated direction changes are stable and return to prior orders", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    await sorter.setSort("path", "ascending");
    const pathAsc = m.visiblePaths();
    await sorter.setSort("size", "descending");
    const sizeDesc = m.visiblePaths();
    await sorter.setSort("kind", "ascending");
    await sorter.setSort("path", "ascending");
    expect(m.visiblePaths()).toEqual(pathAsc);
    await sorter.setSort("size", "descending");
    expect(m.visiblePaths()).toEqual(sizeDesc);
    await sorter.setSort("size", "ascending");
    await sorter.setSort("size", "descending");
    expect(m.visiblePaths()).toEqual(sizeDesc);
  });
});

// ---------------------------------------------------------------------------
// Checksum-copy announcements: repeated outcomes and superseded attempts
// ---------------------------------------------------------------------------

const COPY_FILE = { ...manifestFile("docs/checksum.txt", "text", 17), sha256: "0123456789abcdef".repeat(4) };
const COPY_SUCCESS = /^copied\b/i;
const COPY_FAILURE = /could not|unable|failed|not copied|unavailable|blocked|denied/i;

function controlledClipboard() {
  const pending: Array<{ resolve(): void; reject(reason: Error): void }> = [];
  return {
    pending,
    write: (_text: string) => new Promise<void>((resolve, reject) => { pending.push({ resolve, reject }); }),
    finish(index: number, success: boolean): void {
      const attempt = must(pending[index], `clipboard attempt ${index}`);
      if (success) attempt.resolve();
      else attempt.reject(new Error("Clipboard permission denied"));
    },
  };
}

async function copyMicrotasks(): Promise<void> {
  // Drain promise/observer continuations without allowing a timer task to run.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function copyControls(m: Mounted, rowIndex = 0) {
  const row = must(m.rows()[rowIndex], "checksum row");
  const copy = must(row.querySelectorAll("button").find((b) => /copy.*(?:sha.?256|checksum)/i.test(accessibleName(b))), "Copy SHA-256 button");
  const status = must(row.querySelector('[role="status"]') ?? m.filesSection.querySelector('[role="status"]'), "mounted checksum status");
  return { row, copy, status };
}

describe("checksum-copy announcements", () => {
  // Catches identical status reassignment and same-task clear/restore: neither
  // gives the mounted live region a distinct empty/nonempty mutation delivery.
  it.each([true, false])("reannounces a repeated outcome in a later task (clipboard success=%s)", async (success) => {
    const clipboard = controlledClipboard();
    const m = await mount({ liveFiles: [COPY_FILE], writeClipboard: clipboard.write });
    const { copy, status } = copyControls(m);
    const outcome = success ? COPY_SUCCESS : COPY_FAILURE;
    m.press(copy, "Enter");
    clipboard.finish(0, success);
    await m.waitFor(() => outcome.test(status.textContent), "first truthful copy outcome");
    const firstOutcome = status.textContent;
    const mutations = m.doc.observeText(status);

    m.press(copy, " ");
    expect(status.textContent, "a new attempt clears the existing mounted status immediately").toBe("");
    await copyMicrotasks();
    expect(status.textContent, "the region stays empty while the clipboard is pending").toBe("");
    expect(mutations, "the cleared region is observable before the clipboard settles").toEqual([""]);
    clipboard.finish(1, success);
    await copyMicrotasks();
    expect(status.textContent, "the outcome is restored in a later task, not a promise/observer microtask").toBe("");
    await m.waitFor(() => status.textContent !== "", "repeated copy announcement");
    await copyMicrotasks();
    expect(status.textContent).toBe(firstOutcome);
    expect(mutations, "separate clear and restore deliveries, even for identical feedback").toEqual(["", firstOutcome]);
    expect(copyControls(m).status, "the observed live region stays mounted").toBe(status);
    expect(m.doc.activeElement).toBe(copy);
    expect(m.clipboardWrites).toEqual([COPY_FILE.sha256, COPY_FILE.sha256]);
  });

  // Catches a slow older promise overwriting a newer completed attempt.
  it.each([true, false])("ignores reverse completion after the newer outcome (latest success=%s)", async (latestSuccess) => {
    const clipboard = controlledClipboard();
    const newerFile = { ...manifestFile("other.txt", "text", 23), sha256: "fedcba9876543210".repeat(4) };
    const m = await mount({ liveFiles: [COPY_FILE, newerFile], writeClipboard: clipboard.write });
    const { copy, status } = copyControls(m);
    const newerCopy = copyControls(m, 1).copy;
    m.press(copy, "Enter");
    m.press(newerCopy, " ");
    clipboard.finish(1, latestSuccess);
    await m.waitFor(() => (latestSuccess ? COPY_SUCCESS : COPY_FAILURE).test(status.textContent), "newer copy outcome");
    const latestOutcome = status.textContent;
    const mutations = m.doc.observeText(status);
    clipboard.finish(0, !latestSuccess);
    await m.settled();
    expect(status.textContent, "an older completion cannot replace newer feedback").toBe(latestOutcome);
    expect(mutations, "no stale announcement is delivered").toEqual([]);
    expect(m.clipboardWrites).toEqual([COPY_FILE.sha256, newerFile.sha256]);
    expect(m.doc.activeElement).toBe(newerCopy);
  });

  // Catches fencing only after the latest promise settles: the newer attempt
  // already owns the region while its clipboard operation is still pending.
  it.each([true, false])("suppresses an older result while the newer copy is pending (older success=%s)", async (olderSuccess) => {
    const clipboard = controlledClipboard();
    const m = await mount({ liveFiles: [COPY_FILE], writeClipboard: clipboard.write });
    const { copy, status } = copyControls(m);
    const mutations = m.doc.observeText(status);
    m.click(copy);
    m.click(copy);
    clipboard.finish(0, olderSuccess);
    await m.settled();
    expect(status.textContent, "pending newer copy must not announce the older result").toBe("");
    expect(mutations).toEqual([]);
    clipboard.finish(1, !olderSuccess);
    await m.waitFor(() => (olderSuccess ? COPY_FAILURE : COPY_SUCCESS).test(status.textContent), "newer pending copy outcome");
  });

  it("supersedes an already queued announcement when another copy starts", async () => {
    const clipboard = controlledClipboard();
    const m = await mount({ liveFiles: [COPY_FILE], writeClipboard: clipboard.write });
    const { copy, status } = copyControls(m);
    m.click(copy);
    clipboard.finish(0, true);
    await copyMicrotasks();
    // The first clipboard operation is finished, but its later-task announcement
    // has not run. Starting another attempt must invalidate that queued callback.
    m.click(copy);
    await copyMicrotasks();
    const mutations = m.doc.observeText(status);
    await m.settled();
    expect(status.textContent, "queued stale success stays silent while the next attempt is pending").toBe("");
    expect(mutations).toEqual([]);
    clipboard.finish(1, false);
    await m.waitFor(() => COPY_FAILURE.test(status.textContent), "latest failure announcement");
    expect(status.textContent).not.toMatch(/^copied/i);
  });

  it("preserves the full manual checksum, keyboard focus and metadata-only copy behavior", async () => {
    const clipboard = controlledClipboard();
    const m = await mount({ liveFiles: [COPY_FILE], writeClipboard: clipboard.write });
    const { row, copy, status } = copyControls(m);
    const callsBefore = [...m.calls];
    const writesBefore = [...m.storageWrites];
    for (const [index, success] of [true, false].entries()) {
      m.press(copy, index === 0 ? "Enter" : " ");
      clipboard.finish(index, success);
      await m.waitFor(() => (success ? COPY_SUCCESS : COPY_FAILURE).test(status.textContent), "truthful copy result");
      expect(row.textContent).toContain(COPY_FILE.sha256);
      const manualChecksum = must(row.querySelector("code"), "manual checksum text");
      expect(manualChecksum.textContent).toBe(COPY_FILE.sha256);
      expect(isHidden(manualChecksum), "manual fallback stays visible after success or failure").toBe(false);
      expect(m.doc.activeElement).toBe(copy);
    }
    expect(m.clipboardWrites).toEqual([COPY_FILE.sha256, COPY_FILE.sha256]);
    expect(m.calls, "no content or metadata refetch for explicit checksum copy").toEqual(callsBefore);
    expect(m.storageWrites).toEqual(writesBefore);
  });
});

// ---------------------------------------------------------------------------
// Identity, filtering, versions, empty state
// ---------------------------------------------------------------------------

describe("version-files sort identity and composition", () => {
  it("keeps each full checksum and Copy action associated with its row across sorts and version switches", async () => {
    const liveFiles = ASCII_FILES.map((f, i) => ({ ...f, sha256: (i + 1).toString(16).repeat(64) }));
    const historicalFiles = HISTORICAL_FILES.map((f, i) => ({ ...f, sha256: (i + 10).toString(16).repeat(64) }));
    const m = await mount({ liveFiles, historicalFiles });
    const filesButtons = m.doc.querySelectorAll("button").filter((b) => b.textContent.trim() === "Files");
    for (const [button, fixtures, live] of [
      [filesButtons[0]!, liveFiles, true],
      [filesButtons[1]!, historicalFiles, false],
      [filesButtons[0]!, liveFiles, true],
    ] as const) {
      m.click(button);
      await m.waitFor(() => m.visiblePaths().length === fixtures.length, "selected manifest rows");
      const sorter = createSorter(m);
      for (const field of ["path", "kind", "size"] as const) {
        for (const direction of ["ascending", "descending"] as const) {
          await sorter.setSort(field, direction);
          assertRowsMatchFixtures(m, fixtures, live);
          const callsBefore = [...m.calls];
          const writesBefore = [...m.storageWrites];
          for (const row of m.visibleRows().map(readRow)) {
            const fixture = must(fixtures.find((f) => f.path === row.path), `fixture for ${row.path}`);
            expect(row.tr.textContent, `full SHA-256 for ${row.path}`).toContain(fixture.sha256);
            const copy = must(row.tr.querySelectorAll("button").find((b) => /copy.*(?:sha.?256|checksum)/i.test(accessibleName(b))), `checksum Copy for ${row.path}`);
            const copiedBefore = m.clipboardWrites.length;
            m.click(copy);
            await m.settled();
            expect(m.clipboardWrites.slice(copiedBefore), `copied SHA-256 for ${row.path}`).toEqual([fixture.sha256]);
          }
          expect(m.calls, "sorting and copying use loaded metadata only").toEqual(callsBefore);
          expect(m.storageWrites, "sorting and copying write no preferences").toEqual(writesBefore);
        }
      }
    }
  });

  it("never mutates the source manifest array or its entries", async () => {
    const files = ASCII_FILES.map((f) => ({ ...f }));
    const before = JSON.stringify(files);
    const m = await mount({ liveFiles: files });
    const sorter = createSorter(m);
    await sorter.setSort("size", "descending");
    await sorter.setSort("kind", "ascending");
    await sorter.setSort("path", "descending");
    expect(JSON.stringify(files)).toBe(before);
    expect(m.rows().length).toBe(ASCII_FILES.length);
  });

  it("keeps every row's path/kind/size association and targets across sorts", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    for (const [field, direction] of [
      ["path", "descending"],
      ["kind", "ascending"],
      ["size", "descending"],
      ["size", "ascending"],
    ] as const) {
      await sorter.setSort(field, direction);
      assertRowsMatchFixtures(m, ASCII_FILES, true);
    }
  });

  it("keeps Download targets attached to the correct row after sorting", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    await sorter.setSort("size", "descending");
    const row = must(m.visibleRows().map(readRow).find((v) => v.path === "assets/logo.svg"), "row for assets/logo.svg");
    const before = m.calls.length;
    m.click(must(row.downloadButton, "Download button"));
    await m.waitFor(() => m.calls.length > before, "the sorted download request");
    expect(m.calls[m.calls.length - 1]!.url).toContain(`/api/v1/sites/test-site/files/${encodePath("assets/logo.svg")}`);
  });

  it("sorting neither resets the filter query nor reveals hidden nonmatches", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    m.setFilter("docs");
    await m.settled();
    await sorter.setSort("size", "ascending");
    expect(m.filterInput.value).toBe("docs");
    expect(m.visiblePaths()).toEqual(["docs/README.md", "docs/guide.md"]);
    expect(m.rows().filter((r) => isHidden(r)).length).toBe(ASCII_FILES.length - 2);
    await sorter.setSort("path", "descending");
    expect(m.filterInput.value).toBe("docs");
    expect(m.visiblePaths()).toEqual(["docs/guide.md", "docs/README.md"]);
  });

  it("changing the filter query retains the chosen ordering", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    await sorter.setSort("size", "ascending");
    m.setFilter("assets");
    await m.settled();
    expect(sorter.state()).toEqual({ field: "size", direction: "ascending" });
    expect(m.visiblePaths()).toEqual(["assets/logo.svg", "assets/app.js"]);
    m.setFilter("");
    await m.settled();
    expect(sorter.state()).toEqual({ field: "size", direction: "ascending" });
    expect(m.visiblePaths()).toEqual(expectedOrder(ASCII_FILES, "size", "ascending"));
  });

  it("version switches keep row identity with working sorts in both directions", async () => {
    const m = await mount({ liveFiles: ASCII_FILES, historicalFiles: HISTORICAL_FILES });
    const filesButtons = m.doc.querySelectorAll("button").filter((b) => b.textContent.trim() === "Files");
    const sorter = createSorter(m);
    await sorter.setSort("size", "ascending");
    m.click(filesButtons[1]!);
    await m.waitFor(() => m.visiblePaths().length === HISTORICAL_FILES.length, "historical rows");
    assertRowsMatchFixtures(m, HISTORICAL_FILES, false);
    const historicalSorter = createSorter(m);
    await historicalSorter.setSort("size", "descending");
    expect(m.visiblePaths()).toEqual(["legacy/app.js", "old.html"]);
    assertRowsMatchFixtures(m, HISTORICAL_FILES, false);
    m.click(filesButtons[0]!);
    await m.waitFor(() => m.visiblePaths().length === ASCII_FILES.length, "live rows again");
    assertRowsMatchFixtures(m, ASCII_FILES, true);
    const liveSorter = createSorter(m);
    await liveSorter.setSort("path", "ascending");
    expect(m.visiblePaths()).toEqual(expectedOrder(ASCII_FILES, "path", "ascending"));
  });

  it("shows a useful empty state for an empty manifest", async () => {
    const m = await mount({ liveFiles: [] });
    expect(m.rows().length).toBe(0);
    // The repo's empty pattern (.dw-empty, as the versions section uses): an explicit
    // message, not just a "0 files" count beside a blank table.
    const empty = m.filesSection.querySelector(".dw-empty");
    expect(empty, "an explicit .dw-empty message in #files (not just the count)").not.toBeNull();
    expect(empty!.textContent).toMatch(/no files|empty|nothing/i);
  });
});

// ---------------------------------------------------------------------------
// Keyboard, focus, narrow screens, read-only invariants
// ---------------------------------------------------------------------------

describe("version-files sort keyboard, viewport and read-only invariants", () => {
  it("activates sorts from the keyboard (Tab focus plus Enter/Space)", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    // Every control takes focus in turn, as Tab would move through them.
    for (const el of sorter.allControls()) {
      el.focus();
      expect(m.doc.activeElement).toBe(el);
    }
    const sizeCtrls = sorter.controls("size");
    expect(sizeCtrls.length).toBeGreaterThan(0);
    const sizeCtrl = sizeCtrls[0]!;
    m.press(sizeCtrl, "Enter");
    await m.settled();
    if (sorter.mode === "headers") {
      expect(sorter.state().field).toBe("size");
      const afterEnter = m.visiblePaths();
      m.press(sizeCtrl, " ");
      await m.settled();
      // Space toggles direction on the active header.
      expect(m.visiblePaths()).not.toEqual(afterEnter);
      expect(sorter.state()).toEqual({ field: "size", direction: "descending" });
    } else {
      // Toolbar select: keyboard changes the value, which fires change.
      if (sizeCtrl.tag === "select") {
        setSelectToField(sizeCtrl, "kind");
        sizeCtrl.focus();
        m.fireChange(sizeCtrl);
        await m.settled();
        expect(sorter.state().field).toBe("kind");
      } else {
        expect(sorter.state().field).toBe("size");
      }
    }
  });

  it("keeps every field sortable when the Kind column is hidden on narrow screens", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    const hiddenByNarrow = (el: FakeElement): boolean => {
      if (el.classList().includes("dw-hide-sm")) return true;
      return ancestorHas(el, (a) => a.classList().includes("dw-hide-sm"));
    };
    for (const field of ["path", "kind", "size"] as const) {
      const visible = sorter.controls(field).filter((el) => !hiddenByNarrow(el) && !isHidden(el));
      expect(visible.length, `${field} has a sort control outside .dw-hide-sm (mode: ${sorter.mode})`).toBeGreaterThan(0);
    }
    // Structural narrow-screen check, not a CSS/layout claim: interact only with
    // selects that remain outside the hidden Kind column, never its header.
    const selects = toolbarSelects(m);
    for (const select of [selects.field, selects.direction]) {
      expect(hiddenByNarrow(select) || isHidden(select), "toolbar select remains available outside .dw-hide-sm").toBe(false);
      expect(ancestorHas(select, (el) => el.tag === "th"), "narrow-screen driver does not use a header").toBe(false);
    }
    const kindOrders = must(TOOLBAR_ORDERS.find((orders) => orders.field === "kind"), "Kind orders");
    await changeToolbarField(m, "kind");
    expect(m.visiblePaths()).toEqual(kindOrders.ascending);
    assertSynchronizedSort(m, "kind", "ascending");
    await changeToolbarDirection(m, "descending");
    expect(m.visiblePaths()).toEqual(kindOrders.descending);
    assertSynchronizedSort(m, "kind", "descending");
  });

  it("uses native focusable controls with visible focus and existing tokens", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    for (const el of sorter.allControls()) {
      expect(["button", "select", "input", "a", "th"].includes(el.tag), `control is a native element (<${el.tag}>)`).toBe(true);
      expect(el.disabled, "sort control is enabled while files exist").toBe(false);
      el.focus();
      expect(m.doc.activeElement).toBe(el);
      const style = el.getAttribute("style") ?? "";
      expect(style, "focus ring is not suppressed inline").not.toMatch(/outline\s*:\s*(none|0)/i);
      if (el.tag === "button") {
        const inHeader = ancestorHas(el, (a) => a.tag === "th");
        expect(el.classList().includes("dw-btn") || inHeader, "button uses existing button tokens or header context").toBe(true);
      }
      if (el.tag === "select") {
        expect(el.classList().includes("dw-select"), "select uses existing select tokens").toBe(true);
      }
    }
  });

  it("sorts only loaded metadata: no new requests, writes or mutations", async () => {
    const m = await mount({ liveFiles: ASCII_FILES });
    const sorter = createSorter(m);
    const callsBefore = m.calls.length;
    const writesBefore = m.storageWrites.length;
    await sorter.setSort("path", "descending");
    await sorter.setSort("kind", "ascending");
    await sorter.setSort("size", "descending");
    await sorter.setSort("size", "ascending");
    m.setFilter("a");
    await m.settled();
    m.setFilter("");
    await m.settled();
    expect(m.calls.length, "no API/content request while sorting or filtering").toBe(callsBefore);
    expect(m.storageWrites.length, "no persistent preference while sorting").toBe(writesBefore);
    for (const c of m.calls) {
      expect(c.method, `no remote write (${c.method} ${c.url})`).toBe("GET");
      expect(c.url.startsWith("/api/v1/sites/") || c.url.startsWith("/api/v1/me"), `no new endpoint (${c.url})`).toBe(true);
    }
  });
});
