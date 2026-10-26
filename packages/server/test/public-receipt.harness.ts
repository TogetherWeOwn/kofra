import vm from "node:vm";
import { createHash } from "node:crypto";
import { CLIENT_SCRIPT } from "../src/ui/assets.ts";

// Protected acceptance-test support. The real first-party dashboard script runs
// unchanged; only browser APIs and the remote publish boundary are disposable.
// DOM conventions follow publisher-inventory-review.acceptance.test.ts. This is
// not a layout engine: actual focus, selection and clipboard permissions need a
// browser check in addition to these interaction tests.
type Listener = (event: Record<string, unknown>) => unknown;
export class TextNode {
  readonly nodeType = 3;
  parentNode: Element | null = null;
  constructor(public data: string) {}
  get textContent(): string { return this.data; }
  set textContent(value: string) { this.data = String(value); }
}
export class Element {
  readonly nodeType = 1;
  parentNode: Element | null = null;
  children: Array<Element | TextNode> = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  className = "";
  style: Record<string, string> = {};
  private explicitValue: string | undefined;
  get value(): string { return this.explicitValue ?? (this.tagName === "textarea" ? this.textContent : this.attributes["value"] ?? ""); }
  set value(value: string) { this.explicitValue = String(value); }
  checked = false;
  tabIndex = 0;
  files: ReturnType<typeof file>[] = [];
  focusCalls = 0;
  selectCalls = 0;
  constructor(public tagName: string) { this.tagName = tagName.toLowerCase(); }
  get hidden(): boolean { return "hidden" in this.attributes; }
  set hidden(value: boolean) { this.flag("hidden", value); }
  get disabled(): boolean { return "disabled" in this.attributes; }
  set disabled(value: boolean) { this.flag("disabled", value); }
  get readOnly(): boolean { return "readonly" in this.attributes; }
  set readOnly(value: boolean) { this.flag("readonly", value); }
  get open(): boolean { return "open" in this.attributes; }
  set open(value: boolean) { this.flag("open", value); }
  private flag(key: string, value: boolean): void {
    if (value) this.attributes[key] = "";
    else delete this.attributes[key];
  }
  get firstChild(): Element | TextNode | null { return this.children[0] ?? null; }
  get classList() {
    return {
      add: (name: string) => { if (!this.classList.contains(name)) this.className += " " + name; },
      remove: (name: string) => { this.className = this.className.split(/\s+/).filter((x) => x !== name).join(" "); },
      contains: (name: string) => this.className.split(/\s+/).includes(name),
    };
  }
  appendChild<T extends Element | TextNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild<T extends Element | TextNode>(child: T): T {
    this.children = this.children.filter((x) => x !== child);
    child.parentNode = null;
    return child;
  }
  remove(): void { this.parentNode?.removeChild(this); }
  setAttribute(key: string, value: string): void {
    key = key.toLowerCase();
    this.attributes[key] = String(value);
    if (key === "tabindex") this.tabIndex = Number(value);
  }
  getAttribute(key: string): string | null { return this.attributes[key] ?? null; }
  removeAttribute(key: string): void { delete this.attributes[key]; }
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
  get textContent(): string { return this.children.map((x) => x.textContent).join(""); }
  set textContent(value: string) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    if (value !== "") this.appendChild(new TextNode(String(value)));
  }
  set innerHTML(_value: string) { throw new Error("Unsafe HTML write: receipt must use text nodes"); }
  get innerHTML(): string { throw new Error("DOM harness does not serialize HTML"); }
  click(): void { fire(this, "click"); }
  focus(): void { this.focusCalls++; }
  select(): void { this.selectCalls++; }
  setSelectionRange(): void { this.selectCalls++; }
  querySelector(): null { return null; }
  querySelectorAll(): [] { return []; }
}
export function elements(root: Element): Element[] {
  return [root, ...root.children.flatMap((x) => x instanceof Element ? elements(x) : [])];
}
export function visible(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentNode) {
    if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
  }
  return true;
}
export function fire(el: Element, type: string, extra: Record<string, unknown> = {}): void {
  if (type === "click" && el.disabled) return;
  let prevented = false;
  const event = { type, target: el, currentTarget: el,
    preventDefault: () => { prevented = true; }, stopPropagation() {}, ...extra };
  for (const fn of el.listeners[type] ?? []) fn(event);
  // Native button activation is simulated, not evidence of real browser AX.
  if (!prevented && type === "keydown" && ["Enter", " "].includes(String(extra["key"])) && el.tagName === "button") fire(el, "click");
}
class Document {
  body = new Element("body");
  title = "";
  constructor(page: string, anonymous: boolean) {
    this.body.setAttribute("data-page", page);
    const boot = this.addRoot("dw-boot", "script");
    boot.textContent = JSON.stringify({ origin: ORIGIN, api: "/api/v1", anonymousPublish: anonymous,
      session: null, instanceName: "Receipt fixture", page: { name: page } });
  }
  addRoot(id: string, tag = "div"): Element {
    const el = new Element(tag);
    el.setAttribute("id", id);
    this.body.appendChild(el);
    return el;
  }
  getElementById(id: string): Element | null { return elements(this.body).find((x) => x.getAttribute("id") === id) ?? null; }
  createElement(tag: string): Element { return new Element(tag); }
  createTextNode(value: string): TextNode { return new TextNode(String(value)); }
  querySelector(): null { return null; }
  querySelectorAll(): [] { return []; }
}
function storage() {
  const data: Record<string, string> = {};
  const writes: Array<{ key: string; value?: string }> = [];
  return { data, writes, getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { writes.push({ key, value: String(value) }); data[key] = String(value); },
    removeItem: (key: string) => { writes.push({ key }); delete data[key]; } };
}
export const ORIGIN = "https://dropway.test";
export const PUBLIC_URL = ORIGIN + "/s/receipt-example/";
// Deliberately synthetic canaries, never credentials from a real instance.
export const SENTINELS = {
  api: "dw_SYNTHETIC_API_CANARY", claim: "dwc_SYNTHETIC_CLAIM_CANARY",
  upload: "dwu_SYNTHETIC_UPLOAD_CANARY", password: "SYNTHETIC_PASSWORD_CANARY",
  preview: "SYNTHETIC_PREVIEW_CANARY", access: "SYNTHETIC_ACCESS_CANARY",
  localPath: "/home/fixture/SYNTHETIC_PRIVATE_PATH_CANARY/report.html",
  extra: "SYNTHETIC_UNALLOWLISTED_CANARY",
};
export function version(id = "ver-receipt-exact", number = 17, counts = true) {
  return { id, number, status: "ready", live: true,
    ...(counts ? { fileCount: 3, totalBytes: 8193 } : {}) };
}
export function finalized(v: Record<string, unknown> = version()) {
  return { live: true, url: PUBLIC_URL, unchanged: false,
    site: { id: "site-receipt", slug: "receipt-example", currentVersionId: v["id"], currentVersion: v },
    warnings: [] };
}
export function oneShot(v: Record<string, unknown> = version()) {
  return { url: PUBLIC_URL, slug: "receipt-example", site: { id: "site-receipt", slug: "receipt-example" },
    version: v, created: true, unchanged: false, files: ["index.html", "a.css", "b.js"], uploaded: 3, warnings: [] };
}
export function file(name = "index.html", size = 11) {
  return { name, size, webkitRelativePath: "", arrayBuffer: async () => new Uint8Array(size).buffer };
}
export const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
export type Harness = Awaited<ReturnType<typeof boot>>;
export async function boot(options: { anonymous?: boolean; clipboard?: "ok" | "reject" | "unsupported" | "pending"; page?: "publish" | "home" } = {}) {
  const page = options.page ?? "publish";
  const doc = new Document(page, !!options.anonymous);
  const root = doc.addRoot(page === "home" ? "dw-quick" : "dw-publish");
  doc.addRoot("dw-toasts");
  const local = storage();
  const session = storage();
  if (!options.anonymous) session.data["dropway.key"] = SENTINELS.api;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const logs: unknown[][] = [];
  const clipboard: string[] = [];
  const permissions: unknown[] = [];
  const navigations: unknown[] = [];
  const clipboardGate = deferred();
  const state = {
    final: finalized() as Record<string, unknown>,
    shot: oneShot() as Record<string, unknown>,
    deploy: null as Record<string, unknown> | null,
    fail: false,
  };
  const response = (body: unknown, status = 200) => ({ ok: status < 400, status,
    text: async () => JSON.stringify(body), json: async () => body });
  const fetch = async (url: string, init: { method?: string; body?: unknown } = {}) => {
    const u = String(url);
    const method = (init.method ?? (init.body === undefined ? "GET" : "POST")).toUpperCase();
    calls.push({ url: u, method, body: init.body });
    if (u.endsWith("/me")) return response({ principal: options.anonymous ? "anonymous" : "member", member: { id: "m1", role: "owner" }, scopes: ["sites:read", "sites:write"] });
    if (method === "GET" && u.includes("/sites?")) return response({ sites: [] });
    if (method === "POST" && /\/sites$/.test(u)) return response({ site: { slug: "receipt-example" }, ...(options.anonymous ? { claimToken: SENTINELS.claim } : {}) });
    if (method === "POST" && /\/deploys$/.test(u)) {
      if (state.fail) return response({ error: { code: "fixture_refused", message: "Synthetic refusal", hint: "Retry" } }, 500);
      return response(state.deploy ?? { deploy: { id: "pending-receipt" }, uploads: [], finalizeUrl: "/api/v1/sites/receipt-example/deploys/pending-receipt/finalize" });
    }
    if (method === "POST" && /\/finalize$/.test(u)) return response(state.final);
    if (method === "POST" && /\/publish(?:\?|$)/.test(u)) return response(state.shot);
    if (method === "PUT" && /\/blobs\//.test(u)) return response({});
    throw new Error("Unexpected dashboard request: " + method + " " + u);
  };
  const navigator: Record<string, unknown> = {
    permissions: { query: (input: unknown) => { permissions.push(input); throw new Error("Receipt must not request permissions"); } },
    sendBeacon: (...args: unknown[]) => { calls.push({ url: String(args[0]), method: "BEACON", body: args[1] }); return true; },
  };
  if (options.clipboard !== "unsupported") navigator["clipboard"] = { writeText: async (text: string) => {
    clipboard.push(String(text));
    if (options.clipboard === "pending") await clipboardGate.promise;
    if (options.clipboard === "reject") throw new Error("Synthetic clipboard rejection");
  } };
  const location = { href: ORIGIN + "/dashboard/publish", pathname: page === "home" ? "/" : "/dashboard/publish", search: "" };
  const window = { localStorage: local, sessionStorage: session, navigator, location,
    open: (...args: unknown[]) => { navigations.push(args); } };
  const sandbox = { document: doc, window, navigator, location, fetch,
    console: Object.fromEntries(["log", "info", "warn", "error", "debug"].map((key) => [key, (...args: unknown[]) => { logs.push(args); }])),
    crypto: { subtle: { digest: async (_algorithm: string, data: ArrayBuffer) => Uint8Array.from(createHash("sha256").update(new Uint8Array(data)).digest()).buffer } },
    URL, URLSearchParams, Headers, FormData, Blob, TextEncoder, setTimeout, clearTimeout };
  vm.runInNewContext(CLIENT_SCRIPT, sandbox);
  await flush();
  const controls = elements(root);
  const pick = controls.find((x) => x.tagName === "input" && x.getAttribute("type") === "file" && x.getAttribute("webkitdirectory") === null);
  const publish = controls.find((x) => x.tagName === "button" && x.textContent === "Publish");
  const progress = controls.find((x) => x.getAttribute("role") === "progressbar");
  const result = progress?.parentNode?.children[(progress.parentNode.children.indexOf(progress)) + 2];
  if (!pick || !publish || !(result instanceof Element)) throw new Error("Publisher failed to mount in existing DOM harness");
  return { doc, root, pick, publish, result, state, calls, local, session, clipboard, clipboardGate, logs, permissions, navigations, location };
}
export async function select(h: Harness, files = [file()]): Promise<void> {
  h.pick.files = files;
  fire(h.pick, "change");
  await flush();
}
export async function publish(h: Harness): Promise<void> {
  fire(h.publish, "click");
  await flush();
}
export function copyButton(h: Harness): Element | undefined {
  return elements(h.result).find((x) => x.tagName === "button" && /copy public details/i.test(x.getAttribute("aria-label") ?? x.textContent) && visible(x));
}
export function fallback(h: Harness): Element | undefined {
  const candidates = elements(h.result).filter((x) => visible(x) &&
    (["textarea", "pre", "code"].includes(x.tagName) ||
      (x.tagName === "input" && x.readOnly) || x.getAttribute("role") === "textbox"));
  const name = (x: Element) => x.getAttribute("aria-label") ||
    (x.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => h.doc.getElementById(id)?.textContent ?? "").join(" ") ||
    elements(h.result).find((label) => label.tagName === "label" && label.getAttribute("for") === x.getAttribute("id"))?.textContent || "";
  return candidates.find((x) => /public (?:details|receipt)|publish receipt/i.test(name(x))) ??
    candidates.find((x) => ["textarea", "pre"].includes(x.tagName));
}
export function text(el: Element): string { return ["textarea", "input"].includes(el.tagName) ? el.value : el.textContent; }
export function effects(h: Harness) {
  return JSON.stringify({ calls: h.calls, local: h.local, session: h.session,
    permissions: h.permissions, navigations: h.navigations, location: h.location });
}
