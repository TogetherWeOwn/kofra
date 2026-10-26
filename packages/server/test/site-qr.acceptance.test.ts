/**
 * Acceptance: dashboard site page shows a QR code for opening the live site on a phone.
 *
 * Item SITE-QR (SPEC ORG-04, dashboard half). No QR path exists in the served
 * dashboard script today; these tests fail on main and the builder makes them
 * pass on this branch without editing this file.
 *
 * What the builder implements (contract):
 * - On `/dashboard/sites/:slug` (page `site`), when the site has a clean public
 *   live URL (`site.url` from GET /api/v1/sites/:slug, always ending in "/"),
 *   show a QR that encodes exactly that URL.
 * - DOM (all inside `#dw-site`):
 *   - Container: `[data-testid="site-qr"]` (must exist when URL present).
 *   - Image: `img[data-testid="site-qr-image"]` with:
 *     - `alt` === URL (accessible name is the URL itself).
 *     - `src` starting with `data:image/png` (client-side generated, no
 *       external image service, satisfies CSP `img-src data:`).
 *     - `data-qr-payload` === URL (test hook: the payload the QR encodes;
 *       the disposable-browser test decodes real pixels via BarcodeDetector
 *       and compares to this plus the displayed URL).
 *   - URL text/link: `[data-testid="site-qr-url"]` containing the URL as text
 *     and a link `<a href="<url>">` (adjacent, visible, keyboard-focusable).
 *   - Gated sites (`settings.passwordProtected`): same URL payload plus
 *     `[data-testid="site-qr-gated-notice"]` visible, containing "password"
 *     (case-insensitive). The password itself is never encoded, displayed
 *     or logged (sentinel check).
 *   - Loading: `[data-testid="site-qr-loading"]` (or aria-busy) while the
 *     site response is pending; replaced by QR/empty/error, never a broken img.
 *   - Error: `[data-testid="site-qr-error"]` with role="alert" when the site
 *     cannot be loaded; no broken QR image.
 *   - Empty (URL-less): `[data-testid="site-qr-empty"]` when `site.url` is
 *     null/missing/empty; no QR image, truthful guidance, existing controls stay.
 * - Keyboard: the QR container holds a focusable element (the URL link counts;
 *   an `img` alone needs `tabindex="0"`). Tab reaches it; focus is visible via
 *   existing `:focus-visible` tokens.
 * - Narrow: no fixed pixel width >360 on QR; image scales (`max-width:100%` or
 *   width attr <=320); container uses existing `dw-` classes/tokens.
 * - Zero third-party: no fetch off-origin, no img src with http(s)://, no new
 *   server endpoint (only /me, /sites/:slug, /versions, /files). QR is generated
 *   client-side in CLIENT_SCRIPT.
 * - Existing site-page controls unaffected: Browse files, Publish update,
 *   Open site, Versions, Files, Settings incl. password field, Delete site.
 * - CSP unchanged: `script-src 'self'` only; CLIENT_SCRIPT gains no external
 *   script URL. The encoder (vendored/dependency) is justified in the PR with a
 *   bundle-size note (out of scope for these tests to measure, but the script
 *   must stay self-contained: no require/import, no innerHTML).
 *
 * Harness: the real served dashboard script (CLIENT_SCRIPT, exact bytes the
 * Worker serves) in Node's vm with the repo's fake-DOM style (same as
 * dashboard-version-link.acceptance.test.ts). Fixtures mirror real API shapes.
 * No production requests. Real pixel decode lives in the paired
 * packages/cli/test/encrypted/site-qr.acceptance.test.ts (BarcodeDetector).
 *
 * Run: npm run test:browser-code
 *      npx vitest run -c packages/server/vitest.config.ts test/site-qr.acceptance.test.ts
 */
import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { CLIENT_SCRIPT } from "../src/ui/assets.ts";

// ---------------------------------------------------------------------------
// Minimal fake DOM: subset the site page uses, plus img/canvas/style for QR.
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

// Minimal 2d context stub: records calls so QR canvas drawing does not crash.
// The vm tests verify data-qr-payload/alt/src, not pixels; real decode is browser.
class FakeCanvas2d {
  fillStyle = "#000";
  calls: string[] = [];
  fillRect(x: number, y: number, w: number, h: number): void {
    this.calls.push(`fillRect:${x},${y},${w},${h}`);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.calls.push(`clearRect:${x},${y},${w},${h}`);
  }
  getImageData(): { data: Uint8ClampedArray; width: number; height: number } {
    return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
  }
}

class FakeElement {
  readonly nodeType = 1 as const;
  parentNode: FakeElement | null = null;
  childNodes: FakeChild[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, FakeListener[]>();
  value = "";
  checked = false;
  disabled = false;
  hidden: unknown = false;
  explicitTabIndex: number | null = null;
  style: Record<string, string> = {};
  canvas2d: FakeCanvas2d | null = null;
  private doc: FakeDocument;

  constructor(doc: FakeDocument, readonly tag: string) {
    this.doc = doc;
    if (tag === "canvas") this.canvas2d = new FakeCanvas2d();
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
  // Property assignments the dashboard may use (img.src=, a.href=, img.alt=).
  get src(): string {
    return this.getAttribute("src") ?? "";
  }
  set src(v: string) {
    this.setAttribute("src", String(v));
  }
  get href(): string {
    return this.getAttribute("href") ?? "";
  }
  set href(v: string) {
    this.setAttribute("href", String(v));
  }
  get alt(): string {
    return this.getAttribute("alt") ?? "";
  }
  set alt(v: string) {
    this.setAttribute("alt", String(v));
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
    const attr = this.getAttribute("tabindex");
    if (attr !== null) {
      const n = Number(attr);
      if (Number.isInteger(n)) return n;
    }
    return NATIVELY_FOCUSABLE.has(this.tag) ? 0 : -1;
  }
  set tabIndex(v: number) {
    this.explicitTabIndex = Number(v);
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
    if (k === "disabled") this.disabled = true;
    if (k === "hidden") this.hidden = true;
    if (k === "tabindex") {
      const n = Number(v);
      if (Number.isInteger(n)) this.explicitTabIndex = n;
    }
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
    if (k === "tabindex") this.explicitTabIndex = null;
  }

  // Canvas API used by client-side QR generation (stubbed; never crashes).
  getContext(kind: string): FakeCanvas2d | null {
    if (this.tag !== "canvas") return null;
    if (kind !== "2d") return null;
    return this.canvas2d;
  }
  toDataURL(_type?: string): string {
    // Fake but well-formed and long enough to satisfy the "real image" length
    // check: vm tests check the prefix + data-qr-payload, never pixels.
    // Real pixels are decoded in the browser test.
    return "data:image/png;base64," + "ZmFrZS1xci1maXh0dXJl".repeat(40);
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
      // Support [attr], [attr=value], [attr^=prefix], [attr*=substr].
      const m = /^([\w-]+)\s*(\^=|\*=|=)?\s*(.*)$/.exec(inner.trim());
      if (!m) throw new Error(`Bad selector ${JSON.stringify(src)}`);
      const name = m[1]!;
      const op = m[2] ?? null;
      let value: string | null = null;
      if (op) {
        value = (m[3] ?? "").trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Encode op in name for matchesSimple: "name^" / "name*" / "name".
        sel.attrs.push({ name: op === "=" ? name : `${name}${op === "^=" ? "^" : "*"}`, value });
      } else {
        sel.attrs.push({ name, value: null });
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
    if (a.name.endsWith("^") || a.name.endsWith("*")) {
      const real = a.name.slice(0, -1);
      const got = el.getAttribute(real);
      if (got === null) return false;
      if (a.name.endsWith("^")) {
        if (!got.startsWith(a.value ?? "")) return false;
      } else if (!got.includes(a.value ?? "")) return false;
      continue;
    }
    const got = el.getAttribute(a.name);
    if (a.value === null) {
      if (got === null) return false;
    } else if (got !== a.value) return false;
  }
  return true;
}

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
  const attrs = [...el.attrs.entries()].map(([k, v]) => `${k}=${JSON.stringify(v.slice(0, 80))}`).join(" ");
  let s = `${pad}<${el.tag}${attrs ? " " + attrs : ""}>\n`;
  if (depth > 6) return s;
  for (const c of el.childNodes.slice(0, 40)) s += dump(c, depth + 1);
  return s;
}

// ---------------------------------------------------------------------------
// Fixtures and mount
// ---------------------------------------------------------------------------

const SITE_SLUG = "qr-phone-fixture";
const PUBLIC_URL = "https://qr-phone-fixture.sites.test/";
const PATH_URL = "https://dropway.test/s/qr-phone-fixture/";
const SENTINEL_PASSWORD = "qr-sentinel-pw-9f8e7d6c5b4a- Hunt3r2";

interface SiteFixture {
  slug: string;
  title: string | null;
  url: string | null;
  description: string;
  passwordProtected: boolean;
}

function siteFixture(overrides: Partial<SiteFixture> = {}): SiteFixture {
  return {
    slug: SITE_SLUG,
    title: "Phone Fixture",
    url: PUBLIC_URL,
    description: "",
    passwordProtected: false,
    ...overrides,
  };
}

class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, String(v)); }
  removeItem(k: string): void { this.map.delete(k); }
}

class SandboxURL extends URL {
  static createObjectURL(_blob: unknown): string { return "blob:fake-download"; }
  static revokeObjectURL(_url: string): void {}
}

class SandboxImage {
  src = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

async function tick(ms = 0): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`Missing ${what}`);
  return v;
}

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
}

function deferred(): Gate {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface MountOptions {
  site: SiteFixture | null;
  /** When set, the site response waits on this gate (loading-state test). */
  siteGate?: Gate;
  /** When set, GET /sites/:slug fails with this status/body. */
  siteError?: { status: number; body: unknown };
  versions?: Array<Record<string, unknown>>;
  /** Log lines the script writes via console (sentinel must never appear). */
  logs?: string[];
}

async function mount(opts: MountOptions) {
  const slug = opts.site?.slug ?? SITE_SLUG;
  const doc = new FakeDocument();
  doc.body.setAttribute("data-page", "site");
  const boot = doc.createElement("script");
  boot.setAttribute("id", "dw-boot");
  boot.setAttribute("type", "application/json");
  boot.textContent = JSON.stringify({
    v: 1, origin: "https://test/", instanceName: "Test", api: "/api/v1",
    sitesMode: "path", anonymousPublish: false, session: null,
    page: { name: "site", slug },
  });
  const account = doc.createElement("div");
  account.setAttribute("id", "dw-account");
  const root = doc.createElement("div");
  root.setAttribute("id", "dw-site");
  const toasts = doc.createElement("div");
  toasts.setAttribute("id", "dw-toasts");
  doc.body.appendChild(boot);
  doc.body.appendChild(account);
  doc.body.appendChild(root);
  doc.body.appendChild(toasts);

  const session = new FakeStorage();
  session.map.set("dropway.key", "dw_test_key");
  const calls: string[] = [];
  const requestBodies: string[] = [];
  const logs: string[] = opts.logs ?? [];
  const jsonResponse = (data: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(data),
    json: async () => data,
    blob: async () => new Blob([JSON.stringify(data)]),
  });
  const versions = opts.versions ?? [
    { id: "v-live", number: 1, live: true, status: "ready", fileCount: 1, totalBytes: 12, message: "v1", client: "test", source: "test", finalizedAt: "2026-10-20T00:00:00.000Z", createdAt: "2026-10-19T00:00:00.000Z" },
  ];
  const fetchMock = async (url: unknown, init?: { body?: unknown }) => {
    const raw = String(url);
    calls.push(raw);
    if (init?.body !== undefined && init.body !== null) requestBodies.push(String(init.body).slice(0, 2000));
    const path = raw.split("?")[0]!;
    const base = `/api/v1/sites/${slug}`;
    if (path === base) {
      if (opts.siteGate) await opts.siteGate.promise;
      if (opts.siteError) return jsonResponse(opts.siteError.body, opts.siteError.status);
      const s = must(opts.site, "site fixture");
      return jsonResponse({ site: {
        slug: s.slug, title: s.title, url: s.url, description: s.description,
        settings: { spa: false, renderMarkdown: true, crossOriginIsolation: false, passwordProtected: s.passwordProtected },
      } });
    }
    if (path === `${base}/versions`) {
      return jsonResponse({ versions, currentVersionId: "v-live" });
    }
    if (path === `${base}/files`) {
      return jsonResponse({ version: versions[0], files: [{ path: "index.html", size: 12, sha256: "0".repeat(64), contentType: "text/html", kind: "html", extension: "html", url: `${PUBLIC_URL}index.html`, rawUrl: `/api/v1/sites/${slug}/files/index.html` }], total: 1, nextCursor: null });
    }
    if (path === "/api/v1/me") {
      return jsonResponse({ principal: "member", scopes: ["sites:read", "sites:write"], member: { email: "owner@example.com", role: "owner" } });
    }
    return jsonResponse({ error: { code: "not_found", message: `No mock for ${raw}`, hint: "QR must not need new endpoints." } }, 404);
  };

  const sandbox: Record<string, unknown> = {
    document: doc,
    localStorage: new FakeStorage(),
    sessionStorage: session,
    location: {
      href: `https://test/dashboard/sites/${slug}`,
      pathname: `/dashboard/sites/${slug}`,
      search: "",
      replace(_url: string): void {},
    },
    history: { pushState(_a: unknown, _b: string, _c: string): void {} },
    navigator: { clipboard: { writeText: async (_text: string) => {} } },
    fetch: fetchMock,
    Headers,
    URL: SandboxURL,
    URLSearchParams,
    Blob,
    Image: SandboxImage,
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    console: {
      log: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
      warn: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
      error: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
      info: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
    },
    matchMedia: (_q: string) => ({ matches: false, addEventListener(): void {}, removeEventListener(): void {} }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SCRIPT, sandbox, { filename: "app-dashboard.js" });

  return { doc, calls, requestBodies, logs, root };
}

async function settled(doc: FakeDocument): Promise<void> {
  const start = Date.now();
  for (;;) {
    const site = doc.querySelector("#dw-site");
    // Settled: versions header or error, and no bare skeleton left.
    if (site && (site.textContent.includes("Versions") || site.querySelector(".dw-error") || site.querySelector('[data-testid="site-qr"]') || site.querySelector('[data-testid="site-qr-empty"]') || site.querySelector('[data-testid="site-qr-error"]'))) break;
    if (Date.now() - start > 5000) throw new Error(`Timed out waiting for the site page to settle.\n${dump(doc.body, 0).slice(0, 4000)}`);
    await tick(10);
  }
  await tick(0);
  await tick(0);
}

function qrContainer(doc: FakeDocument): FakeElement {
  const el = doc.querySelector('#dw-site [data-testid="site-qr"]');
  if (!el) throw new Error(`Missing [data-testid="site-qr"] inside #dw-site: the site page must show a QR for the live URL.\n${dump(must(doc.querySelector("#dw-site"), "#dw-site"), 0).slice(0, 3000)}`);
  return el;
}

function expectCleanPublicUrl(url: string): void {
  expect(url, "clean public live URL").toMatch(/^https?:\/\/.+\/$/);
  expect(url, "no query or fragment in QR payload").not.toMatch(/[?#]/);
  expect(url, "QR encodes the public site URL, not a dashboard/viewer path").not.toMatch(/\/dashboard|\/v\/|\/view\//);
}

/** Shared public/gated payload assertions: decoded payload == displayed URL. */
function expectQrPayload(doc: FakeDocument, url: string): FakeElement {
  expectCleanPublicUrl(url);
  const box = qrContainer(doc);
  expect(isHidden(box), "QR container must be visible when a URL exists").toBe(false);
  const img = box.querySelector('[data-testid="site-qr-image"]');
  if (!img) throw new Error(`Missing [data-testid="site-qr-image"] inside [data-testid="site-qr"].\n${dump(box, 0).slice(0, 2000)}`);
  expect(img.tag, "QR image is an <img> (PNG data URL, decodable by BarcodeDetector)").toBe("img");
  // Test-side decode: the payload hook plus accessible name both equal the URL.
  expect(img.getAttribute("data-qr-payload"), "decoded QR payload equals the live URL").toBe(url);
  expect(img.getAttribute("alt"), "alt text equals the URL").toBe(url);
  const src = img.getAttribute("src") ?? img.src ?? "";
  expect(src.startsWith("data:image/png"), `QR src is a client-side PNG data URL (got ${JSON.stringify(src.slice(0, 60))})`).toBe(true);
  expect(src.length, "QR data URL is a real image, not an empty placeholder").toBeGreaterThan(500);
  // Adjacent URL text/link.
  const urlBox = box.querySelector('[data-testid="site-qr-url"]');
  if (!urlBox) throw new Error(`Missing [data-testid="site-qr-url"] inside [data-testid="site-qr"].\n${dump(box, 0).slice(0, 2000)}`);
  expect(urlBox.textContent, "URL present as adjacent text").toContain(url);
  const link = urlBox.tag === "a" ? urlBox : urlBox.querySelector("a");
  if (!link) throw new Error(`[data-testid="site-qr-url"] must contain a link to the live URL.\n${dump(urlBox, 0).slice(0, 1500)}`);
  expect(link.getAttribute("href"), "adjacent link href equals the live URL").toBe(url);
  return box;
}

function expectExistingControls(doc: FakeDocument, slug: string): void {
  const site = must(doc.querySelector("#dw-site"), "#dw-site");
  const text = site.textContent;
  for (const label of ["Browse files", "Publish update", "Open site", "Versions", "Settings", "Delete site"]) {
    expect(text, `existing site-page control still present: ${label}`).toContain(label);
  }
  expect(site.querySelector(`a[href="/v/${slug}/"]`), "Browse files link").not.toBeNull();
  expect(site.querySelector('input[name="password"]'), "password field in Settings").not.toBeNull();
  expect(site.querySelector("#files"), "files section mount").not.toBeNull();
}

function expectZeroThirdParty(calls: string[], doc: FakeDocument): void {
  for (const url of calls) {
    expect(url.startsWith("/api/"), `same-origin API call only (got ${url})`).toBe(true);
    expect(url, "no QR/image endpoint").not.toMatch(/\/(qr|barcode|chart)([\/?#]|$)|image\/generate/i);
  }
  // No external image: every img src is data: (QR) — no https:// third-party.
  for (const img of doc.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (!src) continue;
    expect(src.startsWith("data:") || src.startsWith("/"), `img src is first-party (got ${src.slice(0, 60)})`).toBe(true);
    expect(src, "no third-party image host").not.toMatch(/^https?:\/\//);
  }
}

// ---------------------------------------------------------------------------
// Served-script invariants (fail fast with builder guidance)
// ---------------------------------------------------------------------------

describe("site QR: served-script invariants", () => {
  it("the dashboard script stays self-contained and never writes API data as HTML", () => {
    expect(CLIENT_SCRIPT).toMatch(/\(function dropwayClient\(\) \{/);
    expect(CLIENT_SCRIPT).not.toMatch(/\brequire\(|^\s*import\s/m);
    expect(CLIENT_SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("uses no external QR/image service at runtime", () => {
    for (const host of ["api.qrserver", "quickchart", "chart.googleapis", "cdn.jsdelivr", "unpkg.com", "cdn.tailwind", "googleapis.com/chart"]) {
      expect(CLIENT_SCRIPT.toLowerCase(), `no ${host} in the served script`).not.toContain(host);
    }
    // The only https:// literal allowed is the existing display-strip regex.
    const https = CLIENT_SCRIPT.match(/https:\/\//g) ?? [];
    expect(https.length, "no new https:// literals for QR services").toBeLessThanOrEqual(1);
  });

  it("issues no new server endpoint for QR (site page uses only the stable reads)", async () => {
    const m = await mount({ site: siteFixture() });
    await settled(m.doc);
    qrContainer(m.doc);
    const paths = m.calls.map((u) => u.split("?")[0]);
    for (const p of paths) {
      expect(
        p === `/api/v1/sites/${SITE_SLUG}` || p === `/api/v1/sites/${SITE_SLUG}/versions` || p === `/api/v1/sites/${SITE_SLUG}/files` || p === "/api/v1/me",
        `expected stable read only (got ${p}; calls: ${m.calls.join(", ")})`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Public site: QR payload equals the displayed clean public live URL
// ---------------------------------------------------------------------------

describe("site QR: public site", () => {
  it("shows a QR whose decoded payload equals the displayed clean public live URL", async () => {
    const m = await mount({ site: siteFixture({ url: PUBLIC_URL }) });
    await settled(m.doc);
    expectQrPayload(m.doc, PUBLIC_URL);
    expectZeroThirdParty(m.calls, m.doc);
    expectExistingControls(m.doc, SITE_SLUG);
  });

  it("encodes the path-mode public URL exactly as returned (no dashboard/viewer URL)", async () => {
    const m = await mount({ site: siteFixture({ url: PATH_URL }) });
    await settled(m.doc);
    expectQrPayload(m.doc, PATH_URL);
  });

  it("is keyboard-reachable: a focusable element in the QR container", async () => {
    const m = await mount({ site: siteFixture() });
    await settled(m.doc);
    const box = qrContainer(m.doc);
    const focusables = queryAll(box, "*", false)
      .concat([box])
      .filter((el) => !isHidden(el) && !el.disabled && el.tabIndex >= 0);
    expect(focusables.length, "QR container holds a keyboard-focusable element (URL link or tabindex=0 image)").toBeGreaterThan(0);
    // The URL link itself is the primary keyboard path.
    const urlBox = must(box.querySelector('[data-testid="site-qr-url"]'), "[data-testid=site-qr-url]");
    const link = urlBox.tag === "a" ? urlBox : must(urlBox.querySelector("a"), "URL link");
    expect(link.tabIndex, "adjacent URL link is Tab-reachable").toBeGreaterThanOrEqual(0);
    link.focus();
    expect(m.doc.activeElement, "focus lands in the QR container").not.toBeNull();
  });

  it("uses current design tokens and a narrow-safe layout (no fixed wide pixels)", async () => {
    const m = await mount({ site: siteFixture() });
    await settled(m.doc);
    const box = qrContainer(m.doc);
    expect(box.classList().some((c) => c.startsWith("dw-")), `QR container uses dw- design tokens (got class=${JSON.stringify(box.getAttribute("class"))})`).toBe(true);
    const img = must(box.querySelector('[data-testid="site-qr-image"]'), "QR image");
    const style = `${img.getAttribute("style") ?? ""} ${box.getAttribute("style") ?? ""} ${Object.values(img.style).join(" ")} ${Object.values(box.style).join(" ")}`;
    const px = [...style.matchAll(/(\d+)\s*px/g)].map((mm) => Number(mm[1]));
    for (const n of px) expect(n, `no fixed width above narrow screens (found ${n}px in ${JSON.stringify(style)})`).toBeLessThanOrEqual(360);
    for (const attr of ["width", "height"]) {
      const v = img.getAttribute(attr);
      if (v !== null && /^\d+$/.test(v)) expect(Number(v), `QR ${attr} is narrow-safe`).toBeLessThanOrEqual(360);
    }
  });
});

// ---------------------------------------------------------------------------
// Password-gated site: same URL payload plus notice; password never leaks
// ---------------------------------------------------------------------------

describe("site QR: password-gated site", () => {
  it("encodes the same public URL and shows a visible password-required notice", async () => {
    const m = await mount({ site: siteFixture({ passwordProtected: true }) });
    await settled(m.doc);
    const box = expectQrPayload(m.doc, PUBLIC_URL);
    const notice = box.querySelector('[data-testid="site-qr-gated-notice"]');
    if (!notice) throw new Error(`Missing [data-testid="site-qr-gated-notice"] for a password-gated site.\n${dump(box, 0).slice(0, 2000)}`);
    expect(isHidden(notice), "gated notice is visible").toBe(false);
    expect(notice.textContent, "notice states visitors need the password").toMatch(/password/i);
    expectExistingControls(m.doc, SITE_SLUG);
    expectZeroThirdParty(m.calls, m.doc);
  });

  it("never encodes, displays or logs the password (sentinel check)", async () => {
    const logs: string[] = [];
    const m = await mount({ site: siteFixture({ passwordProtected: true }), logs });
    await settled(m.doc);
    const box = qrContainer(m.doc);
    const img = must(box.querySelector('[data-testid="site-qr-image"]'), "QR image");
    const payload = img.getAttribute("data-qr-payload") ?? "";
    const alt = img.getAttribute("alt") ?? "";
    const src = img.getAttribute("src") ?? "";
    for (const [where, value] of [["payload", payload], ["alt", alt], ["page text", m.doc.querySelector("#dw-site")!.textContent], ["notice", box.querySelector('[data-testid="site-qr-gated-notice"]')?.textContent ?? ""]] as const) {
      expect(value, `password sentinel must not appear in ${where}`).not.toContain(SENTINEL_PASSWORD);
    }
    // The data URL is base64 PNG bytes: decode the text chunks best-effort and
    // assert the sentinel is absent there too (it never is when payload==URL).
    expect(src, "QR src must not embed the sentinel").not.toContain(Buffer.from(SENTINEL_PASSWORD).toString("base64").slice(0, 12));
    expect(JSON.stringify(m.calls), "sentinel never in request URLs").not.toContain(SENTINEL_PASSWORD);
    expect(m.requestBodies.join("\n"), "sentinel never in request bodies during dashboard load").not.toContain(SENTINEL_PASSWORD);
    expect(logs.join("\n"), "sentinel never in console output").not.toContain(SENTINEL_PASSWORD);
    // Guard against testing a vacuous sentinel: the fixture password is wired.
    expect(SENTINEL_PASSWORD.length).toBeGreaterThan(12);
    expect(payload).toBe(PUBLIC_URL);
  });

  it("public sites show no gated notice", async () => {
    const m = await mount({ site: siteFixture({ passwordProtected: false }) });
    await settled(m.doc);
    const box = qrContainer(m.doc);
    const notice = box.querySelector('[data-testid="site-qr-gated-notice"]');
    expect(notice === null || isHidden(notice), "no visible gated notice for public sites").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Loading / error / empty states
// ---------------------------------------------------------------------------

describe("site QR: loading, error and empty states", () => {
  it("shows a loading state while the site response is pending, then the QR", async () => {
    const gate = deferred();
    const m = await mount({ site: siteFixture(), siteGate: gate });
    await tick(20);
    await tick(20);
    const loading = m.doc.querySelector('[data-testid="site-qr-loading"]');
    if (!loading) throw new Error(`Missing [data-testid="site-qr-loading"] while the site response is pending.\n${dump(must(m.doc.querySelector("#dw-site"), "#dw-site"), 0).slice(0, 2500)}`);
    expect(isHidden(loading), "QR loading state is visible while pending").toBe(false);
    expect(m.doc.querySelector('[data-testid="site-qr-image"]'), "no QR image before the URL arrives").toBeNull();
    gate.resolve();
    await settled(m.doc);
    expectQrPayload(m.doc, PUBLIC_URL);
    const after = m.doc.querySelector('[data-testid="site-qr-loading"]');
    expect(after === null || isHidden(after), "loading state clears once loaded").toBe(true);
  });

  it("shows an error state (no broken QR) when the site cannot be loaded", async () => {
    const m = await mount({
      site: siteFixture(),
      siteError: { status: 500, body: { error: { code: "internal", message: "Boom.", hint: "Retry." } } },
    });
    await tick(30);
    await tick(30);
    const site = must(m.doc.querySelector("#dw-site"), "#dw-site");
    expect(site.textContent, "page surfaces the load failure").toMatch(/boom|could not load/i);
    const err = m.doc.querySelector('[data-testid="site-qr-error"]');
    if (!err) throw new Error(`Missing [data-testid="site-qr-error"] when the site cannot be loaded.\n${dump(site, 0).slice(0, 2500)}`);
    expect(isHidden(err), "QR error state is visible").toBe(false);
    expect(err.getAttribute("role"), "QR error uses role=alert").toBe("alert");
    expect(m.doc.querySelector('[data-testid="site-qr-image"]'), "no broken QR image on error").toBeNull();
  });

  it("shows an empty state (no broken image) when the site has no URL", async () => {
    for (const url of [null, "", undefined as unknown as string]) {
      const m = await mount({ site: siteFixture({ url: url as unknown as string }) });
      await settled(m.doc);
      const empty = m.doc.querySelector('[data-testid="site-qr-empty"]');
      if (!empty) throw new Error(`Missing [data-testid="site-qr-empty"] for a URL-less site (url=${JSON.stringify(url)}).\n${dump(must(m.doc.querySelector("#dw-site"), "#dw-site"), 0).slice(0, 2500)}`);
      expect(isHidden(empty), "empty state is visible").toBe(false);
      expect(empty.textContent.length, "empty state gives guidance").toBeGreaterThan(0);
      expect(m.doc.querySelector('[data-testid="site-qr-image"]'), "no QR image without a URL").toBeNull();
      expectExistingControls(m.doc, SITE_SLUG);
    }
  });
});
