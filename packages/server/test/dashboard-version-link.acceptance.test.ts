/**
 * Acceptance: a dashboard link that names a version must show that version's
 * files, even when the version is not in the initially loaded versions list.
 *
 * Publish results carry versionUrl = /dashboard/sites/<slug>?version=<id>,
 * including awaiting_upload results whose version is still pending. The site
 * page loads GET /sites/<slug>/versions?limit=100, which lists ready versions
 * only, newest first — so a pending version never appears in it, and a ready
 * version older than the newest 100 does not either. The files panel must
 * still render for the requested version (the API can serve it directly:
 * GET /sites/<slug>/versions/<id> and GET /sites/<slug>/files?version=<id>
 * both accept any version id), not hide itself.
 *
 * Drives the real dashboard script (CLIENT_SCRIPT) in Node's vm with the same
 * fake-DOM harness as version-files-sort.acceptance.test.ts. Fixture fetch
 * mirrors the real API shapes and list semantics described above.
 *
 * Run: npx vitest run -c packages/server/vitest.config.ts test/dashboard-version-link.acceptance.test.ts
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

// ---------------------------------------------------------------------------
// Fixtures and mount
// ---------------------------------------------------------------------------

interface VersionFixture extends Record<string, unknown> {
  id: string;
  number: number;
  live: boolean;
  status: string;
}

function versionFixture(id: string, number: number, live: boolean, status: string, fileCount: number): VersionFixture {
  return {
    id,
    number,
    live,
    status,
    fileCount,
    totalBytes: 1000,
    message: `version ${number}`,
    client: "test",
    source: "test",
    finalizedAt: status === "ready" ? "2026-10-20T00:00:00.000Z" : null,
    createdAt: "2026-10-19T00:00:00.000Z",
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

async function tick(ms = 0): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`Missing ${what}`);
  return v;
}

interface Fixture {
  /** Every version that exists, newest first. */
  versions: VersionFixture[];
  filesByVersion: Map<string, ManifestFile[]>;
}

async function mount(requestedVersion: string, fixture: Fixture) {
  const slug = "test-site";
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
  const jsonResponse = (data: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(data),
    json: async () => data,
    blob: async () => new Blob([JSON.stringify(data)]),
  });
  const liveId = fixture.versions.find((v) => v.live)?.id;
  const fetchMock = async (url: unknown) => {
    const raw = String(url);
    calls.push(raw);
    const path = raw.split("?")[0]!;
    const query = new URLSearchParams(raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "");
    const base = `/api/v1/sites/${slug}`;
    if (path === base) {
      return jsonResponse({ site: {
        slug, title: "Test Site", url: `https://${slug}.test/`, description: "",
        settings: { spa: false, renderMarkdown: true, crossOriginIsolation: false, passwordProtected: false },
      } });
    }
    if (path === `${base}/versions`) {
      // Real list semantics: ready versions only, newest first, limit honoured (server cap 500).
      const limit = Math.min(500, Math.max(1, Number(query.get("limit")) || 50));
      const ready = fixture.versions.filter((v) => v.status === "ready");
      return jsonResponse({ versions: ready.slice(0, limit), currentVersionId: liveId ?? null });
    }
    if (path.startsWith(`${base}/versions/`)) {
      const id = decodeURIComponent(path.slice(`${base}/versions/`.length));
      const version = fixture.versions.find((v) => v.id === id);
      if (!version) return jsonResponse({ error: { code: "version_not_found", message: "Unknown version", hint: "List versions first." } }, 404);
      return jsonResponse({ site: slug, version, missing: version.status === "pending" ? ["0".repeat(64)] : [] });
    }
    if (path === `${base}/files`) {
      const versionId = query.get("version") ?? liveId ?? "";
      const version = fixture.versions.find((v) => v.id === versionId);
      if (!version) return jsonResponse({ error: { code: "version_not_found", message: "Unknown version", hint: "List versions first." } }, 404);
      const files = fixture.filesByVersion.get(versionId) ?? [];
      return jsonResponse({ version, files, total: files.length, nextCursor: null });
    }
    if (path === "/api/v1/me") {
      return jsonResponse({ principal: "member", scopes: ["sites:read", "sites:write"], member: { email: "owner@example.com", role: "owner" } });
    }
    return jsonResponse({ error: { code: "not_found", message: `No mock for ${raw}`, hint: "Version links must not need new endpoints." } }, 404);
  };

  const sandbox: Record<string, unknown> = {
    document: doc,
    localStorage: new FakeStorage(),
    sessionStorage: session,
    location: {
      href: `https://test/dashboard/sites/${slug}?version=${encodeURIComponent(requestedVersion)}`,
      pathname: `/dashboard/sites/${slug}`,
      search: `?version=${encodeURIComponent(requestedVersion)}`,
      replace(_url: string): void {},
    },
    history: { pushState(_a: unknown, _b: string, _c: string): void {} },
    navigator: { clipboard: { writeText: async (_text: string) => {} } },
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
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SCRIPT, sandbox, { filename: "app-dashboard.js" });

  const start = Date.now();
  for (;;) {
    const section = doc.querySelector("#files");
    if (section && (isHidden(section) || doc.querySelector("#files table") !== null || doc.querySelector("#files .dw-empty") !== null || doc.querySelector("#files .dw-error") !== null)) break;
    if (!section && doc.querySelector("#dw-site .dw-error")) break;
    if (Date.now() - start > 5000) throw new Error(`Timed out waiting for the files panel to settle.\n${dump(doc.body, 0).slice(0, 4000)}`);
    await tick(10);
  }
  await tick(0);
  await tick(0);

  return {
    doc,
    calls,
    get filesSection() { return must(doc.querySelector("#files"), "#files section"); },
    visiblePaths: () => [...must(doc.querySelector("#files"), "#files section").querySelectorAll("tbody tr")]
      .filter((r) => !isHidden(r))
      .map((tr) => must(tr.querySelectorAll("td")[0], "path cell").textContent),
  };
}

function expectFilesPanel(m: Awaited<ReturnType<typeof mount>>, version: VersionFixture, files: ManifestFile[]) {
  expect(isHidden(m.filesSection), "the files section must not be hidden for a linked version").toBe(false);
  expect(m.filesSection.textContent).toContain(`Files in v${version.number}`);
  expect(m.visiblePaths()).toEqual(files.map((f) => f.path));
  expect(
    m.calls.some((u) => u.includes("/files") && u.includes(`version=${encodeURIComponent(version.id)}`)),
    `expected a files request pinned to ${version.id}; calls: ${m.calls.join(", ")}`,
  ).toBe(true);
}

describe("dashboard version links", () => {
  it("keeps site history and settings when a pinned immutable version no longer exists", async () => {
    const liveFiles = [manifestFile("live-only-sentinel.txt", "text", 12)];
    const live = versionFixture("v-live", 2, true, "ready", liveFiles.length);
    // An explicit id that has been deleted has the same 404 contract as an
    // unknown id. It must not erase the site page or silently select live.
    const missingId = "ver_deleted_immutable";
    const fixture = { versions: [live], filesByVersion: new Map([[live.id, liveFiles]]) };
    const expectSiteChrome = (page: Awaited<ReturnType<typeof mount>>) => {
      const root = must(page.doc.querySelector("#dw-site"), "site page");
      expect(root.textContent).toContain("test-site");
      const headings = root.querySelectorAll("h2,h3").map((el) => el.textContent);
      expect(headings.some((text) => /versions/i.test(text))).toBe(true);
      expect(headings.some((text) => /settings/i.test(text))).toBe(true);
      expect(root.textContent).toContain("v2");
    };
    // The same shell assertions must hold on a known version: this guards
    // against accidentally testing nonexistent selectors or fixture wording.
    expectSiteChrome(await mount(live.id, fixture));
    const m = await mount(missingId, fixture);
    expect(m.calls).toContain(`/api/v1/sites/test-site/versions/${missingId}`);
    expectSiteChrome(m);
    expect(isHidden(m.filesSection)).toBe(false);
    expect(m.filesSection.textContent).toMatch(/unknown version|version.*(?:unavailable|not found|no longer)|(?:unavailable|not found).*version/i);
    expect(m.visiblePaths()).toEqual([]);
    expect(m.doc.querySelector("#dw-site")!.textContent).not.toContain("live-only-sentinel.txt");
    const fileRequests = m.calls.filter((url) => url.split("?")[0] === "/api/v1/sites/test-site/files");
    expect(fileRequests.every((url) => new URL(url, "https://test").searchParams.get("version") === missingId)).toBe(true);
  });

  it("renders the files panel for a pending version named by ?version= (awaiting_upload versionUrl)", async () => {
    const liveFiles = [manifestFile("index.html", "html", 12, "text/html")];
    const pendingFiles = [manifestFile("pending.txt", "text", 7)];
    const live = versionFixture("v-live", 2, true, "ready", liveFiles.length);
    const pending = versionFixture("v-pending", 3, false, "pending", pendingFiles.length);
    const m = await mount("v-pending", {
      versions: [pending, live],
      filesByVersion: new Map([["v-live", liveFiles], ["v-pending", pendingFiles]]),
    });
    expectFilesPanel(m, pending, pendingFiles);
  });

  it("renders the files panel for a ready version older than the newest 100", async () => {
    const filesByVersion = new Map<string, ManifestFile[]>();
    const versions: VersionFixture[] = [];
    for (let n = 105; n >= 1; n--) {
      const files = [manifestFile(n === 1 ? "old.txt" : `file-${n}.txt`, "text", n)];
      filesByVersion.set(`v-${n}`, files);
      versions.push(versionFixture(`v-${n}`, n, n === 105, "ready", files.length));
    }
    const oldest = must(versions.find((v) => v.id === "v-1"), "oldest version");
    const m = await mount("v-1", { versions, filesByVersion });
    expectFilesPanel(m, oldest, filesByVersion.get("v-1")!);
  });

  it("still renders the files panel for a listed version named by ?version=", async () => {
    const liveFiles = [manifestFile("index.html", "html", 12, "text/html")];
    const live = versionFixture("v-live", 1, true, "ready", liveFiles.length);
    const m = await mount("v-live", {
      versions: [live],
      filesByVersion: new Map([["v-live", liveFiles]]),
    });
    expectFilesPanel(m, live, liveFiles);
  });
});
