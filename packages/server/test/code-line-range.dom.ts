/**
 * Protected test utility for the code-viewer line-range acceptance suite.
 * A small disposable DOM + HTML parser so the REAL rendered page (markup from
 * the production code viewer, parsed generically) can run its REAL inline
 * script under Node vm. No layout, painting or native keyboard/AX engine:
 * pointer/keyboard activation is modelled as the events a browser dispatches,
 * and layout claims must be proven separately in a real browser check.
 * Only the Test Author may change this file.
 */

export interface FakeEventInit {
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  button?: number;
  [k: string]: unknown;
}

export class FakeEvent {
  type: string;
  target: FakeElement | FakeDocument | null = null;
  currentTarget: FakeElement | FakeDocument | null = null;
  key: string | undefined;
  shiftKey = false;
  ctrlKey = false;
  metaKey = false;
  altKey = false;
  button = 0;
  defaultPrevented = false;
  propagationStopped = false;
  constructor(type: string, init: FakeEventInit = {}) {
    this.type = type;
    this.key = init.key;
    this.shiftKey = !!init.shiftKey;
    this.ctrlKey = !!init.ctrlKey;
    this.metaKey = !!init.metaKey;
    this.altKey = !!init.altKey;
    this.button = typeof init.button === "number" ? init.button : 0;
    for (const [k, v] of Object.entries(init)) {
      if (!(k in this)) (this as unknown as Record<string, unknown>)[k] = v;
    }
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.propagationStopped = true;
  }
  stopImmediatePropagation(): void {
    this.propagationStopped = true;
  }
}

type FakeListener = (ev: FakeEvent) => void;

export class FakeText {
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

export type FakeChild = FakeElement | FakeText;

const camelToKebab = (s: string) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

export class FakeElement {
  readonly nodeType = 1 as const;
  parentNode: FakeElement | null = null;
  childNodes: FakeChild[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, FakeListener[]>();
  style: Record<string, string> = {};
  value = "";
  checked = false;
  scrollCalls = 0;
  private customValidityMessage = "";
  readonly ownerDocument: FakeDocument;

  constructor(doc: FakeDocument, readonly tag: string) {
    this.ownerDocument = doc;
  }

  get localName(): string {
    return this.tag;
  }
  get tagName(): string {
    return this.tag.toUpperCase();
  }
  get parentElement(): FakeElement | null {
    return this.parentNode;
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
  get classList() {
    const el = this;
    const read = () => el.className.split(/\s+/).filter(Boolean);
    const write = (list: string[]) => el.setAttribute("class", list.join(" "));
    return {
      add: (...names: string[]) => {
        const list = read();
        for (const n of names) if (!list.includes(n)) list.push(n);
        write(list);
      },
      remove: (...names: string[]) => write(read().filter((c) => !names.includes(c))),
      contains: (name: string) => read().includes(name),
      toggle: (name: string, force?: boolean) => {
        const has = read().includes(name);
        const want = force === undefined ? !has : !!force;
        if (want && !has) write([...read(), name]);
        if (!want && has) write(read().filter((c) => c !== name));
        return want;
      },
    };
  }
  get dataset(): Record<string, string> {
    const el = this;
    return new Proxy({} as Record<string, string>, {
      get: (_t, prop: string) => el.getAttribute("data-" + camelToKebab(prop)) ?? undefined,
      set: (_t, prop: string, v: string) => {
        el.setAttribute("data-" + camelToKebab(prop), String(v));
        return true;
      },
      has: (_t, prop: string) => el.getAttribute("data-" + camelToKebab(prop)) !== null,
    });
  }
  get hidden(): boolean {
    return this.hasAttribute("hidden");
  }
  set hidden(v: boolean) {
    if (v) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }
  get disabled(): boolean {
    return this.hasAttribute("disabled");
  }
  set disabled(v: boolean) {
    if (v) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get type(): string {
    const t = this.getAttribute("type");
    if (t) return t.toLowerCase();
    if (this.tag === "input") return "text";
    if (this.tag === "button") return "submit";
    return "";
  }
  set type(v: string) {
    this.setAttribute("type", v);
  }
  get href(): string {
    return this.getAttribute("href") ?? "";
  }
  set href(v: string) {
    this.setAttribute("href", v);
  }
  get valueAsNumber(): number {
    return this.value.trim() === "" ? NaN : Number(this.value);
  }
  get form(): FakeElement | null {
    return this.closest("form");
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    const s = String(v);
    if (s) this.appendChild(new FakeText(s));
  }
  get innerText(): string {
    return this.textContent;
  }
  set innerText(v: string) {
    this.textContent = v;
  }
  set innerHTML(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    for (const node of parseFragment(this.ownerDocument, String(v))) this.appendChild(node);
  }
  get innerHTML(): string {
    return this.childNodes.map((c) => (c instanceof FakeElement ? `<${c.tag}>${c.innerHTML}</${c.tag}>` : c.text)).join("");
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }
  get firstChild(): FakeChild | null {
    return this.childNodes[0] ?? null;
  }
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  setAttribute(k: string, v: string): void {
    const key = k.toLowerCase();
    this.attrs.set(key, String(v));
    if (key === "checked") this.checked = true;
    if (key === "value" && this.tag === "input") this.value = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k.toLowerCase()) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k.toLowerCase());
  }
  removeAttribute(k: string): void {
    const key = k.toLowerCase();
    this.attrs.delete(key);
    if (key === "checked") this.checked = false;
  }
  toggleAttribute(k: string, force?: boolean): boolean {
    const want = force === undefined ? !this.hasAttribute(k) : !!force;
    if (want) this.setAttribute(k, "");
    else this.removeAttribute(k);
    return want;
  }

  appendChild<T extends FakeChild>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore<T extends FakeChild>(child: T, ref: FakeChild | null): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i >= 0) this.childNodes.splice(i, 0, child);
    else this.childNodes.push(child);
    return child;
  }
  append(...nodes: Array<FakeChild | string>): void {
    for (const n of nodes) this.appendChild(typeof n === "string" ? new FakeText(n) : n);
  }
  replaceChildren(...nodes: Array<FakeChild | string>): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  removeChild<T extends FakeChild>(child: T): T {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  contains(node: FakeChild | null): boolean {
    let cur: FakeElement | null = node instanceof FakeElement ? node : node?.parentNode ?? null;
    if (node && node.parentNode === this) return true;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  addEventListener(type: string, fn: FakeListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: FakeListener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  dispatchEvent(ev: FakeEvent): boolean {
    ev.target = this;
    const path: Array<FakeElement | FakeDocument> = [];
    let cur: FakeElement | null = this;
    while (cur) {
      path.push(cur);
      cur = cur.parentNode;
    }
    path.push(this.ownerDocument);
    for (const node of path) {
      ev.currentTarget = node;
      const list = node instanceof FakeDocument ? node.listeners.get(ev.type) ?? [] : node.listeners.get(ev.type) ?? [];
      for (const fn of [...list]) fn(ev);
      if (ev.propagationStopped) break;
    }
    ev.currentTarget = null;
    return !ev.defaultPrevented;
  }
  dispatch(type: string, init: FakeEventInit = {}): FakeEvent {
    const ev = new FakeEvent(type, init);
    this.dispatchEvent(ev);
    return ev;
  }
  click(): void {
    this.dispatch("click");
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  select(): void {}
  setSelectionRange(): void {}
  scrollIntoView(): void {
    this.scrollCalls++;
    this.ownerDocument.scrolledTo.push(this.id || this.tag);
  }
  getBoundingClientRect(): Record<string, number> {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  setCustomValidity(msg: string): void {
    this.customValidityMessage = String(msg);
  }
  get validationMessage(): string {
    if (this.customValidityMessage) return this.customValidityMessage;
    const v = this.validity;
    if (v.valueMissing) return "Please fill in this field.";
    if (v.badInput) return "Please enter a number.";
    if (v.rangeUnderflow) return `Value must be greater than or equal to ${this.getAttribute("min")}.`;
    if (v.rangeOverflow) return `Value must be less than or equal to ${this.getAttribute("max")}.`;
    if (v.stepMismatch) return "Please enter a valid value.";
    return "";
  }
  get validity(): { valid: boolean; valueMissing: boolean; badInput: boolean; rangeUnderflow: boolean; rangeOverflow: boolean; stepMismatch: boolean; customError: boolean } {
    const out = { valid: true, valueMissing: false, badInput: false, rangeUnderflow: false, rangeOverflow: false, stepMismatch: false, customError: this.customValidityMessage !== "" };
    if (this.tag === "input") {
      const raw = this.value;
      if (this.hasAttribute("required") && raw.trim() === "") out.valueMissing = true;
      if (this.type === "number" && raw.trim() !== "") {
        const n = Number(raw);
        if (!Number.isFinite(n)) out.badInput = true;
        else {
          const min = this.getAttribute("min");
          const max = this.getAttribute("max");
          const step = Number(this.getAttribute("step") ?? "1");
          if (min !== null && n < Number(min)) out.rangeUnderflow = true;
          if (max !== null && n > Number(max)) out.rangeOverflow = true;
          const base = min !== null ? Number(min) : 0;
          if (Number.isFinite(step) && step > 0 && Math.abs(((n - base) / step) % 1) > 1e-9) out.stepMismatch = true;
        }
      }
    }
    out.valid = !out.valueMissing && !out.badInput && !out.rangeUnderflow && !out.rangeOverflow && !out.stepMismatch && !out.customError;
    return out;
  }
  checkValidity(): boolean {
    return this.validity.valid;
  }
  reportValidity(): boolean {
    const ok = this.checkValidity();
    if (!ok) this.ownerDocument.reportedValidity = this;
    return ok;
  }

  matches(sel: string): boolean {
    return queryAll(this.ownerDocument.documentElement, sel, true).includes(this);
  }
  closest(sel: string): FakeElement | null {
    let cur: FakeElement | null = this;
    const matched = new Set(queryAll(this.ownerDocument.documentElement, sel, true));
    while (cur) {
      if (matched.has(cur)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  querySelector(sel: string): FakeElement | null {
    return queryAll(this, sel, false)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    return queryAll(this, sel, false);
  }
  getElementsByClassName(name: string): FakeElement[] {
    return subtree(this).slice(1).filter((el) => el.className.split(/\s+/).includes(name));
  }
  getElementsByTagName(name: string): FakeElement[] {
    const tag = name.toLowerCase();
    return subtree(this).slice(1).filter((el) => tag === "*" || el.tag === tag);
  }
}

// --- Selector engine: tag, #id, .class, [attr], [attr=v], [attr^=v], descendant, child (>), groups, :checked. ---

interface SimpleSel {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: Array<{ name: string; op: string; value: string | null }>;
  checked: boolean;
}

function parseSimple(src: string): SimpleSel {
  const sel: SimpleSel = { tag: null, id: null, classes: [], attrs: [], checked: false };
  let i = 0;
  const isName = (c: string) => /[a-zA-Z0-9_-]/.test(c);
  const readName = () => {
    let s = "";
    while (i < src.length && (isName(src[i]!) || src[i] === "\\")) {
      if (src[i] === "\\") i++;
      if (i < src.length) s += src[i++];
    }
    return s;
  };
  if (src[i] === "*") i++;
  else if (i < src.length && /[a-zA-Z]/.test(src[i]!)) sel.tag = readName().toLowerCase();
  while (i < src.length) {
    const c = src[i]!;
    if (c === "#") {
      i++;
      sel.id = readName();
    } else if (c === ".") {
      i++;
      sel.classes.push(readName());
    } else if (c === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) throw new Error(`Bad selector ${JSON.stringify(src)}`);
      const inner = src.slice(i + 1, end).trim();
      const m = inner.match(/^([a-zA-Z0-9_-]+)\s*(?:(\^=|\$=|\*=|=)\s*(.*))?$/);
      if (!m) throw new Error(`Bad selector ${JSON.stringify(src)}`);
      let value: string | null = m[3] !== undefined ? m[3].trim() : null;
      if (value !== null && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
      sel.attrs.push({ name: m[1]!.toLowerCase(), op: m[2] ?? "", value });
      i = end + 1;
    } else if (c === ":") {
      i++;
      const name = readName();
      if (name === "checked") sel.checked = true;
      else throw new Error(`Unsupported pseudo-class :${name} in test DOM selector`);
    } else {
      throw new Error(`Bad selector ${JSON.stringify(src)}`);
    }
  }
  return sel;
}

function matchesSimple(el: FakeElement, sel: SimpleSel): boolean {
  if (sel.tag && el.tag !== sel.tag) return false;
  if (sel.id && el.id !== sel.id) return false;
  if (sel.checked && !el.checked) return false;
  const classes = el.className.split(/\s+/).filter(Boolean);
  for (const c of sel.classes) if (!classes.includes(c)) return false;
  for (const a of sel.attrs) {
    const got = el.getAttribute(a.name);
    if (a.value === null) {
      if (got === null) return false;
    } else if (got === null) return false;
    else if (a.op === "=" && got !== a.value) return false;
    else if (a.op === "^=" && !got.startsWith(a.value)) return false;
    else if (a.op === "$=" && !got.endsWith(a.value)) return false;
    else if (a.op === "*=" && !got.includes(a.value)) return false;
  }
  return true;
}

function splitTop(src: string, sep: (ch: string) => boolean): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let quote: string | null = null;
  for (const ch of src) {
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
    } else if (depth === 0 && sep(ch)) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function subtree(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [root];
  for (const c of root.children) out.push(...subtree(c));
  return out;
}

export function queryAll(root: FakeElement, selector: string, includeSelf: boolean): FakeElement[] {
  const all = subtree(root);
  const inScope = new Set(all);
  const candidates = includeSelf ? all : all.slice(1);
  const out: FakeElement[] = [];
  for (const group of splitTop(selector, (ch) => ch === ",")) {
    // Split combinators: keep track of child (>) vs descendant (space).
    const rawParts = group.split(/(\s*>\s*|\s+)/).filter((p) => p.trim() !== "" || p.includes(">") || /^\s+$/.test(p));
    const steps: Array<{ sel: SimpleSel; childOnly: boolean }> = [];
    let pendingChild = false;
    for (const part of rawParts) {
      if (part.includes(">")) {
        pendingChild = true;
      } else if (/^\s+$/.test(part)) {
        // descendant separator; pendingChild already says otherwise
      } else {
        steps.push({ sel: parseSimple(part.trim()), childOnly: pendingChild });
        pendingChild = false;
      }
    }
    if (!steps.length) continue;
    for (const el of candidates) {
      let idx = steps.length - 1;
      if (!matchesSimple(el, steps[idx]!.sel)) continue;
      let cur: FakeElement | null = el;
      let ok = true;
      while (idx > 0) {
        const want = steps[idx - 1]!.sel;
        const childOnly = steps[idx]!.childOnly;
        cur = cur!.parentNode;
        if (childOnly) {
          if (!cur || !inScope.has(cur) || !matchesSimple(cur, want)) {
            ok = false;
            break;
          }
        } else {
          while (cur && inScope.has(cur) && !matchesSimple(cur, want)) cur = cur.parentNode;
          if (!cur || !inScope.has(cur)) {
            ok = false;
            break;
          }
        }
        idx--;
      }
      if (ok && !out.includes(el)) out.push(el);
    }
  }
  return out;
}

export class FakeDocument {
  documentElement: FakeElement;
  head: FakeElement;
  body: FakeElement;
  activeElement: FakeElement | null = null;
  listeners = new Map<string, FakeListener[]>();
  readyState = "complete";
  scrolledTo: string[] = [];
  reportedValidity: FakeElement | null = null;
  defaultView: Record<string, unknown> | null = null;

  constructor() {
    this.documentElement = new FakeElement(this, "html");
    this.head = new FakeElement(this, "head");
    this.body = new FakeElement(this, "body");
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag.toLowerCase());
  }
  createTextNode(text: string): FakeText {
    return new FakeText(String(text));
  }
  getElementById(id: string): FakeElement | null {
    return subtree(this.documentElement).find((el) => el.id === id) ?? null;
  }
  querySelector(sel: string): FakeElement | null {
    return queryAll(this.documentElement, sel, true)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    return queryAll(this.documentElement, sel, true);
  }
  getElementsByClassName(name: string): FakeElement[] {
    return this.documentElement.getElementsByClassName(name);
  }
  getElementsByTagName(name: string): FakeElement[] {
    return this.documentElement.getElementsByTagName(name);
  }
  addEventListener(type: string, fn: FakeListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: FakeListener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  dispatch(type: string, init: FakeEventInit = {}): FakeEvent {
    const ev = new FakeEvent(type, init);
    ev.target = this;
    ev.currentTarget = this;
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
    return ev;
  }
}

// --- Minimal generic HTML parser for the viewer's server-rendered markup. ---

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TAGS = new Set(["script", "style"]);

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    switch (body) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      case "nbsp": return " ";
      default: return whole;
    }
  });
}

function parseInto(doc: FakeDocument, html: string, root: FakeElement): void {
  const stack: FakeElement[] = [root];
  const top = () => stack[stack.length - 1]!;
  let i = 0;
  const pushText = (raw: string, decode = true) => {
    if (!raw) return;
    top().appendChild(new FakeText(decode ? decodeEntities(raw) : raw));
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    pushText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const end = html.indexOf(">", lt);
      const name = html.slice(lt + 2, end < 0 ? html.length : end).trim().toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s]!.tag === name) {
          stack.length = s;
          break;
        }
      }
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt));
    if (!m) {
      pushText("<", false);
      i = lt + 1;
      continue;
    }
    const tag = m[1]!.toLowerCase();
    let j = lt + m[0].length;
    const el = doc.createElement(tag);
    let selfClosed = false;
    while (j < html.length) {
      while (j < html.length && /\s/.test(html[j]!)) j++;
      if (html.startsWith("/>", j)) {
        selfClosed = true;
        j += 2;
        break;
      }
      if (html[j] === ">") {
        j++;
        break;
      }
      const nameMatch = /^[^\s=/>]+/.exec(html.slice(j));
      if (!nameMatch) {
        j++;
        continue;
      }
      const attrName = nameMatch[0].toLowerCase();
      j += nameMatch[0].length;
      while (j < html.length && /\s/.test(html[j]!)) j++;
      let attrValue = "";
      if (html[j] === "=") {
        j++;
        while (j < html.length && /\s/.test(html[j]!)) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, j + 1);
          attrValue = html.slice(j + 1, end < 0 ? html.length : end);
          j = end < 0 ? html.length : end + 1;
        } else {
          const vm = /^[^\s>]*/.exec(html.slice(j));
          attrValue = vm![0];
          j += vm![0].length;
        }
      }
      el.setAttribute(attrName, decodeEntities(attrValue));
    }
    top().appendChild(el);
    i = j;
    if (RAW_TAGS.has(tag) && !selfClosed) {
      const close = `</${tag}>`;
      const end = html.toLowerCase().indexOf(close, i);
      const raw = end < 0 ? html.slice(i) : html.slice(i, end);
      if (raw) el.appendChild(new FakeText(raw));
      i = end < 0 ? html.length : end + close.length;
      continue;
    }
    if (!selfClosed && !VOID_TAGS.has(tag)) stack.push(el);
  }
}

export function parseFragment(doc: FakeDocument, html: string): FakeChild[] {
  const holder = doc.createElement("div");
  parseInto(doc, html, holder);
  const nodes = [...holder.childNodes];
  for (const n of nodes) n.parentNode = null;
  holder.childNodes = [];
  return nodes;
}

/** Parse a full rendered page into the document (replaces head/body). */
export function parseDocument(doc: FakeDocument, html: string): void {
  const holder = doc.createElement("html");
  parseInto(doc, html, holder);
  const htmlEl = holder.children.find((c) => c.tag === "html") ?? holder;
  const head = htmlEl.children.find((c) => c.tag === "head");
  const body = htmlEl.children.find((c) => c.tag === "body");
  doc.documentElement = htmlEl;
  if (head) doc.head = head;
  if (body) doc.body = body;
  doc.activeElement = doc.body;
  // Rebind ownerDocument expectations: elements keep the doc they were built with.
}

export function allElements(root: FakeElement): FakeElement[] {
  return subtree(root);
}

export function isHiddenEl(el: FakeElement): boolean {
  let cur: FakeElement | null = el;
  while (cur) {
    if (cur.hidden || cur.getAttribute("aria-hidden") === "true") return true;
    if ((cur.style["display"] ?? "") === "none") return true;
    cur = cur.parentNode;
  }
  return false;
}
