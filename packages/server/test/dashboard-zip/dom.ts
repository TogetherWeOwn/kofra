/** Protected test-only DOM, adapted from dashboard-version-link.acceptance.test.ts.
 * Adds native disabled clicks and observation of attachment anchors. No layout/AX engine.
 */
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

export class FakeElement {
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
    if (this.disabled) return;
    this.doc.clicked?.(this);
    this.dispatch("click", {});
  }
  get href(): string { return this.getAttribute("href") ?? ""; }
  set href(value: string) { this.setAttribute("href", value); }
  get download(): string { return this.getAttribute("download") ?? ""; }
  set download(value: string) { this.setAttribute("download", value); }
  get isConnected(): boolean { return subtree(this.doc.body).includes(this); }
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

export class FakeDocument {
  clicked?: (element: FakeElement) => void;
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
