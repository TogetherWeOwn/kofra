/**
 * Test-only adaptation of the existing dashboard VM harness. This is NOT a
 * browser: native keyboard traversal, dialog modality and layout are checked
 * separately in browser.acceptance.test.ts, not inferred from this model.
 */
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { expect } from "vitest";
import { sourceSlug, type Fixture, type Reply, type Wire } from "./fixture";

type Listener = (event: any) => void;
class TextNode {
  nodeType = 3;
  parentNode: Element | null = null;
  textContent: string;
  constructor(text: string) { this.textContent = text; }
  remove() { this.parentNode?.removeChild(this); }
}
type Child = Element | TextNode;
export class Element {
  nodeType = 1;
  parentNode: Element | null = null;
  childNodes: Child[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  value = "";
  checked = false;
  disabled = false;
  hidden: unknown = false;
  style: Record<string, string> = {};
  tabIndex = 0;
  readonly doc: Document;
  readonly tag: string;
  constructor(doc: Document, tag: string) { this.doc = doc; this.tag = tag; }
  get localName() { return this.tag; }
  get tagName() { return this.tag.toUpperCase(); }
  get id() { return this.getAttribute("id") ?? ""; }
  set id(value: string) { this.setAttribute("id", value); }
  get className() { return this.getAttribute("class") ?? ""; }
  set className(value: string) { this.setAttribute("class", value); }
  get children(): Element[] { return this.childNodes.filter((node): node is Element => node instanceof Element); }
  get firstChild(): Child | null { return this.childNodes[0] ?? null; }
  get parentElement() { return this.parentNode; }
  get isConnected(): boolean { return this === this.doc.body || !!this.parentNode?.isConnected; }
  get textContent(): string { return this.childNodes.map(node => node.textContent).join(""); }
  set textContent(value: string) {
    this.childNodes.forEach(node => { node.parentNode = null; });
    this.childNodes = [];
    if (value) this.appendChild(new TextNode(String(value)));
  }
  get innerHTML(): never { throw Error("the VM harness does not parse HTML"); }
  set innerHTML(_value: string) { throw Error("dashboard must render untrusted text through DOM text nodes, not HTML"); }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value));
    if (name === "disabled") this.disabled = true;
    if (name === "hidden") this.hidden = true;
  }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  removeAttribute(name: string) {
    this.attrs.delete(name);
    if (name === "disabled") this.disabled = false;
    if (name === "hidden") this.hidden = false;
  }
  appendChild<T extends Child>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  append(...children: (Child | string)[]) { children.forEach(child => this.appendChild(typeof child === "string" ? new TextNode(child) : child)); }
  removeChild<T extends Child>(child: T): T {
    this.childNodes = this.childNodes.filter(node => node !== child);
    child.parentNode = null;
    return child;
  }
  replaceChildren(...children: (Child | string)[]) { this.textContent = ""; this.append(...children); }
  remove() { this.parentNode?.removeChild(this); }
  contains(child: Element): boolean { return child === this || this.children.some(node => node.contains(child)); }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]); }
  removeEventListener(type: string, fn: Listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(listener => listener !== fn)); }
  dispatch(type: string, init: Record<string, unknown> = {}) {
    const event: any = { type, target: this, currentTarget: this, defaultPrevented: false, ...init,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    let current: Element | null = this;
    while (current) {
      event.currentTarget = current;
      for (const listener of current.listeners.get(type) ?? []) listener(event);
      if (event.stopped) break;
      current = current.parentNode;
    }
    return event;
  }
  click() {
    if (this.disabled) return;
    this.focus();
    const event = this.dispatch("click");
    if (!event.defaultPrevented && this.tag === "button" && this.getAttribute("type") !== "button") this.closest("form")?.requestSubmit();
  }
  focus() { this.doc.activeElement = this; }
  select() {}
  scrollIntoView() {}
  showModal() { this.setAttribute("open", ""); }
  close() { this.removeAttribute("open"); this.dispatch("close"); }
  checkValidity(): boolean {
    if (["input", "textarea"].includes(this.tag)) {
      if (this.hasAttribute("required") && !this.value) return false;
      const pattern = this.getAttribute("pattern");
      if (pattern && this.value && !new RegExp(`^(?:${pattern})$`).test(this.value)) return false;
      return true;
    }
    return this.children.every(child => child.checkValidity());
  }
  reportValidity() { return this.checkValidity(); }
  requestSubmit() { if (this.checkValidity()) this.dispatch("submit"); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string) { return descendants(this).filter(node => selector.split(",").some(group => matches(node, group.trim()))); }
  closest(selector: string): Element | null { return matches(this, selector) ? this : this.parentNode?.closest(selector) ?? null; }
}
function descendants(root: Element): Element[] { return root.children.flatMap(child => [child, ...descendants(child)]); }
function matches(node: Element, selector: string): boolean {
  const parts = selector.split(/\s+(?![^\[]*\])/);
  const simple = parts.pop()!;
  const tag = /^[a-z][\w-]*/i.exec(simple)?.[0];
  if (tag && node.tag !== tag.toLowerCase()) return false;
  const id = /#([\w-]+)/.exec(simple)?.[1];
  if (id && node.id !== id) return false;
  for (const [, name] of simple.matchAll(/\.([\w-]+)/g)) if (!node.className.split(/\s+/).includes(name!)) return false;
  for (const [, name, rawValue] of simple.matchAll(/\[([\w-]+)(?:=([^\]]+))?\]/g)) {
    if (!node.hasAttribute(name!)) return false;
    if (rawValue !== undefined && node.getAttribute(name!) !== rawValue.replace(/^["']|["']$/g, "")) return false;
  }
  if (!parts.length) return true;
  let parent = node.parentNode;
  while (parent) { if (matches(parent, parts.join(" "))) return true; parent = parent.parentNode; }
  return false;
}
export class Document {
  body = new Element(this, "body");
  activeElement: Element | null = null;
  title = "";
  createElement(tag: string) { return new Element(this, tag.toLowerCase()); }
  createTextNode(text: string) { return new TextNode(String(text)); }
  getElementById(id: string) { return [this.body, ...descendants(this.body)].find(node => node.id === id) ?? null; }
  querySelector(selector: string) { return this.body.querySelector(selector); }
  querySelectorAll(selector: string) { return this.body.querySelectorAll(selector); }
  addEventListener(type: string, listener: Listener) { this.body.addEventListener(type, listener); }
  removeEventListener(type: string, listener: Listener) { this.body.removeEventListener(type, listener); }
  execCommand() { return false; }
}
class Storage {
  map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
  removeItem(key: string) { this.map.delete(key); }
}
export function visible(node: Element): boolean {
  if (node.hidden || node.hasAttribute("hidden") || node.style.display === "none" || node.style.visibility === "hidden") return false;
  if (node.tag === "dialog" && !node.hasAttribute("open")) return false;
  return !node.parentNode || visible(node.parentNode);
}
export function accessibleName(node: Element): string {
  const labelledBy = node.getAttribute("aria-labelledby");
  if (labelledBy) return labelledBy.split(/\s+/).map(id => node.doc.getElementById(id)?.textContent ?? "").join(" ").trim();
  const explicit = node.getAttribute("aria-label");
  if (explicit) return explicit;
  if (["input", "textarea"].includes(node.tag)) {
    const label = node.doc.querySelectorAll("label").find(label => label.getAttribute("for") === node.id && node.id);
    return label?.textContent.trim() ?? node.closest("label")?.textContent.trim() ?? "";
  }
  return node.textContent.trim();
}
export function find(root: Element, predicate: (node: Element) => boolean) { return [root, ...descendants(root)].filter(node => visible(node) && predicate(node)); }
export function button(root: Element, name: RegExp) {
  const nodes = find(root, node => (node.tag === "button" || node.getAttribute("role") === "button") && name.test(accessibleName(node)));
  expect(nodes.length, `expected one visible button named ${name}; visible text: ${root.textContent.slice(0, 1200)}`).toBe(1);
  return nodes[0]!;
}
export function field(root: Element, name: RegExp) {
  const nodes = find(root, node => ["input", "textarea"].includes(node.tag) && name.test(accessibleName(node)));
  expect(nodes.length, `expected one labelled field ${name}`).toBe(1);
  return nodes[0]!;
}
export function fill(node: Element, value: string) { node.value = value; node.dispatch("input"); node.dispatch("change"); }
export async function settle() { await new Promise(resolve => setTimeout(resolve, 30)); }
export async function until(predicate: () => boolean, label: string) {
  const end = Date.now() + 2500;
  while (!predicate() && Date.now() < end) await settle();
  expect(predicate(), label).toBe(true);
}

export async function mount(fixture: Fixture, reply?: Reply) {
  const doc = new Document();
  doc.body.setAttribute("data-page", "site");
  for (const [tag, id, text] of [["script", "dw-boot", fixture.bootText], ["div", "dw-account", ""], ["div", "dw-site", ""], ["div", "dw-toasts", ""]]) {
    const node = doc.createElement(tag!); node.id = id!; node.textContent = text!; doc.body.appendChild(node);
  }
  const sessionStorage = new Storage();
  sessionStorage.setItem("dropway.key", fixture.ownerKey);
  const wire: Wire[] = [];
  const navigation: string[] = [];
  const errors: unknown[] = [];
  let href = `${fixture.origin}/dashboard/sites/${sourceSlug}`;
  const location = {
    get href() { return href; }, set href(value: string) { href = String(value); navigation.push(href); },
    pathname: `/dashboard/sites/${sourceSlug}`, search: "", origin: fixture.origin,
    assign(value: string) { this.href = value; }, replace(value: string) { this.href = value; },
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const trackedTimeout = (fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(...args); }, ms); timers.add(timer); return timer;
  };
  const sandbox: Record<string, unknown> = {
    document: doc, sessionStorage, localStorage: new Storage(), location,
    history: { pushState(_data: unknown, _title: string, url: string) { navigation.push(String(url)); }, replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } }, crypto: webcrypto,
    fetch: async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input), fixture.origin);
      if (url.origin !== fixture.origin) throw Error("dashboard must not send requests outside its disposable Worker");
      const call: Wire = { method: (init.method ?? "GET").toUpperCase(), path: url.pathname + url.search, headers: new Headers(init.headers), body: String(init.body ?? "") };
      wire.push(call);
      if (!["GET", "HEAD", "OPTIONS"].includes(call.method)) {
        if (reply) return reply(call);
        throw Error(`unexpected dashboard mutation: ${call.method} ${call.path}`);
      }
      return fixture.request(url.href, init);
    },
    Headers, Request, Response, URL, URLSearchParams, Blob, TextEncoder, AbortController,
    setTimeout: trackedTimeout, clearTimeout, queueMicrotask,
    requestAnimationFrame: (fn: () => void) => trackedTimeout(fn, 0),
    console: { ...console, error: (...args: unknown[]) => errors.push(args) },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener: (type: string, fn: Listener) => doc.addEventListener(type, fn),
    removeEventListener: (type: string, fn: Listener) => doc.removeEventListener(type, fn),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  // These are the actual HTTP-served bytes, not a source import or a substitute UI.
  vm.runInContext(fixture.script, sandbox, { filename: fixture.scriptPath });
  try {
    await until(() => find(doc.body, node => node.tag === "a" && /^browse(?: files)?$/i.test(accessibleName(node))).length === 1, "served dashboard must finish loading its original site actions");
  } catch (error) {
    timers.forEach(clearTimeout);
    throw Error(`${String(error)}\nRendered: ${doc.body.textContent}\nErrors: ${errors.map(String).join("; ")}\nRequests: ${wire.map(call => call.path).join(", ")}`);
  }
  return { doc, wire, navigation, errors, dispose: () => { timers.forEach(clearTimeout); timers.clear(); } };
}
export type View = Awaited<ReturnType<typeof mount>>;
