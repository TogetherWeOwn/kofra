/**
 * Acceptance: Settings shows caller-effective publishing limits and capability
 * explanations from the already-authorized GET /api/v1/me response.
 *
 * Acceptance-owned contract. The follow-up build runs this file unchanged
 * (plus `npm run check`) and must never edit it. It is RED on the baseline
 * without the feature: the dashboard script renders identity only.
 *
 * Seam: the real served dashboard script (CLIENT_SCRIPT) executed in node:vm
 * against a stub Settings DOM and stub fetch, the same technique as
 * path-shim.test.ts. No new dependencies, no network, no browser binary.
 *
 * Honest limits of this seam (the follow-up covers these in a real browser
 * before merge): narrow-width visual wrapping, visible focus order and rings,
 * and long-session polling beyond the 120 ms quiet window asserted here.
 */

import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { CLIENT_SCRIPT } from "../src/ui/assets";

// ---------------------------------------------------------------------------
// Minimal stub DOM: just what the settings page and its script touch.
// ---------------------------------------------------------------------------

type Child = FakeElement | FakeText;

class FakeText {
  readonly nodeType = 3 as const;
  parentNode: FakeElement | null = null;
  constructor(public textContent: string) {}
}

class FakeElement {
  readonly nodeType = 1 as const;
  parentNode: FakeElement | null = null;
  readonly children: Child[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  className = "";
  value = "";
  checked = false;
  hidden = false;
  disabled = false;
  title = "";
  tabIndex = 0;

  constructor(public readonly tagName: string) {}

  get firstChild(): Child | null {
    return this.children[0] ?? null;
  }

  get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }

  set textContent(value: string) {
    for (const c of this.children) c.parentNode = null;
    this.children.length = 0;
    if (value !== "") {
      const t = new FakeText(value);
      t.parentNode = this;
      this.children.push(t);
    }
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }

  appendChild<T extends Child>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  insertBefore<T extends Child>(child: T, ref: Child | null): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    if (ref === null) {
      this.children.push(child);
    } else {
      const at = this.children.indexOf(ref);
      if (at < 0) this.children.push(child);
      else this.children.splice(at, 0, child);
    }
    child.parentNode = this;
    return child;
  }

  removeChild<T extends Child>(child: T): T {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  closest(selector: string): FakeElement | null {
    const want = selector.trim().toLowerCase();
    let el: FakeElement | null = this;
    while (el) {
      if (el.tagName.toLowerCase() === want) return el;
      el = el.parentNode;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return queryDescendants(this, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return queryDescendants(this, selector);
  }

  focus(): void {}
  click(): void {}
  scrollIntoView(): void {}
}

function queryDescendants(root: FakeElement, selector: string): FakeElement[] {
  const groups = selector
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: FakeElement[] = [];
  const walk = (el: FakeElement): void => {
    for (const child of el.children) {
      if (child instanceof FakeElement) {
        if (groups.some((g) => matchesCompound(child, g))) out.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

function matchesCompound(el: FakeElement, selector: string): boolean {
  if (!selector || /[\s>+~]/.test(selector)) return false;
  let rest = selector;
  const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest)?.[0] ?? "";
  if (tag) {
    if (el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    rest = rest.slice(tag.length);
  }
  while (rest) {
    if (rest.startsWith("#")) {
      const id = /^#([a-zA-Z0-9_-]+)/.exec(rest)?.[1];
      if (!id || el.getAttribute("id") !== id) return false;
      rest = rest.slice(id.length + 1);
    } else if (rest.startsWith(".")) {
      const cls = /^\.([a-zA-Z0-9_-]+)/.exec(rest)?.[1];
      if (!cls || !el.className.split(/\s+/).includes(cls)) return false;
      rest = rest.slice(cls.length + 1);
    } else if (rest.startsWith("[")) {
      const m = /^\[([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/.exec(rest);
      if (!m) return false;
      const value = el.getAttribute(m[1]!);
      const want = m[2] ?? m[3] ?? m[4];
      if (want === undefined ? value === null : value !== want) return false;
      rest = rest.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

class FakeDocument {
  readonly body: FakeElement;
  title = "";
  private readonly pinned = new Map<string, FakeElement>();

  constructor() {
    this.body = new FakeElement("body");
  }

  pin(el: FakeElement): void {
    const id = el.getAttribute("id");
    if (id) this.pinned.set(id, el);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  getElementById(id: string): FakeElement | null {
    return this.pinned.get(id) ?? findById(this.body, id);
  }

  querySelector(selector: string): FakeElement | null {
    return queryDescendants(this.body, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return queryDescendants(this.body, selector);
  }

  addEventListener(): void {}
  execCommand(): boolean {
    return false;
  }
}

function findById(root: FakeElement, id: string): FakeElement | null {
  if (root.getAttribute("id") === id) return root;
  for (const child of root.children) {
    if (child instanceof FakeElement) {
      const hit = findById(child, id);
      if (hit) return hit;
    }
  }
  return null;
}

function makeStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, String(value));
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
  };
}

function descendants(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (el: FakeElement): void => {
    for (const child of el.children) {
      if (child instanceof FakeElement) {
        out.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

function depth(el: FakeElement): number {
  let n = 0;
  let at = el.parentNode;
  while (at) {
    n++;
    at = at.parentNode;
  }
  return n;
}

/** The byte formatting the dashboard and the server share. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// World: stub settings page + stub fetch, running the real dashboard script.
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  method: string;
}

interface SettingsWorld {
  doc: FakeDocument;
  account: FakeElement;
  me: FakeElement;
  members: FakeElement;
  membersSection: FakeElement;
  fetchCalls: FetchCall[];
  /** Requests observed during the quiet window after settle (polling check). */
  quietGrowth: number;
}

const API_KEY = "dw_acceptance_key";
const BOOT = {
  v: 1,
  origin: "https://kofra.test",
  instanceName: "Kofra",
  api: "/api/v1",
  sitesMode: "path",
  anonymousPublish: false,
  session: null,
  page: { name: "settings" },
};

async function runSettings(
  mePayload: unknown,
  membersPayload: unknown = { members: [] },
  cachedMe?: unknown,
): Promise<SettingsWorld> {
  const doc = new FakeDocument();
  doc.body.setAttribute("data-page", "settings");

  const boot = doc.createElement("script");
  boot.setAttribute("id", "dw-boot");
  boot.setAttribute("type", "application/json");
  boot.textContent = JSON.stringify(BOOT);

  const account = doc.createElement("div");
  account.setAttribute("id", "dw-account");
  account.className = "dw-account";

  const me = doc.createElement("div");
  me.setAttribute("id", "dw-me");
  me.className = "dw-pad";
  const accountSection = doc.createElement("section");
  accountSection.appendChild(me);

  const members = doc.createElement("div");
  members.setAttribute("id", "dw-members");
  const membersSection = doc.createElement("section");
  membersSection.appendChild(members);

  const toasts = doc.createElement("div");
  toasts.setAttribute("id", "dw-toasts");

  doc.body.appendChild(account);
  doc.body.appendChild(accountSection);
  doc.body.appendChild(membersSection);
  doc.body.appendChild(toasts);
  for (const el of [boot, account, me, members, toasts]) doc.pin(el);

  const fetchCalls: FetchCall[] = [];
  const ok = (payload: unknown) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  });
  const stubFetch = async (
    url: unknown,
    init?: { method?: string },
  ): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
    const href = String(url);
    fetchCalls.push({ url: href, method: init?.method ?? "GET" });
    if (href === "/api/v1/me") return ok(mePayload);
    if (href === "/api/v1/members") return ok(membersPayload);
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: "not_found", message: "Not found" } }) };
  };

  const session = makeStorage({
    "dropway.key": API_KEY,
    ...(cachedMe === undefined ? {} : {
      "dropway.me": JSON.stringify({ key: API_KEY, at: Date.now(), me: cachedMe }),
    }),
  });
  const local = makeStorage();
  const location = {
    href: "https://kofra.test/dashboard/settings",
    pathname: "/dashboard/settings",
    search: "",
    replaced: [] as string[],
    replace(url: string): void {
      this.replaced.push(url);
    },
  };
  const sandbox: Record<string, unknown> = {
    document: doc,
    window: {
      localStorage: local,
      sessionStorage: session,
      addEventListener: (): void => {},
    },
    location,
    fetch: stubFetch,
    Headers,
    URL,
    setTimeout,
    clearTimeout,
    navigator: {},
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(CLIENT_SCRIPT, context);

  const deadline = Date.now() + 2000;
  for (;;) {
    await sleep(5);
    const identityRendered = descendants(me).some((el) => el.tagName === "dl");
    if (identityRendered) break;
    if (Date.now() > deadline) {
      throw new Error(`settings world did not settle (calls: ${JSON.stringify(fetchCalls)}, identity: ${identityRendered})`);
    }
  }
  const before = fetchCalls.length;
  await sleep(120);
  return { doc, account, me, members, membersSection, fetchCalls, quietGrowth: fetchCalls.length - before };
}

// ---------------------------------------------------------------------------
// Canonical /me fixtures. Distinctive values prove caller-effective rendering:
// the instance defaults are 100 MB / 2500 files / 10 GB / 25 MB, never these.
// ---------------------------------------------------------------------------

const EFFECTIVE_LIMITS = {
  maxFileBytes: 8388608, // 8.0 MB
  maxFiles: 120,
  maxSiteBytes: 536870912, // 512 MB
  oneShotMaxBytes: 4194304, // 4.0 MB
};

const OWNER_SCOPES = ["sites:read", "sites:write", "sites:delete", "keys:write", "members:write", "data:write"];
const MEMBER_SCOPES = ["sites:read", "sites:write", "sites:delete", "data:write"];

const allowed = (): { allowed: true } => ({ allowed: true });

function refused(code: string, message: string, hint: string, requires?: string): Record<string, unknown> {
  return {
    allowed: false,
    error: {
      code,
      message,
      hint,
      ...(requires ? { details: { requires: [requires] } } : {}),
    },
  };
}

interface MeOverrides {
  role?: string;
  scopes?: string[];
  siteRestriction?: string | null;
  limits?: Record<string, number | null | undefined>;
  capabilities?: Record<string, unknown>;
  usage?: Record<string, number>;
  member?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

function memberMe(overrides: MeOverrides = {}): Record<string, unknown> {
  return {
    capabilities: overrides.capabilities ?? {
      site_password: allowed(),
      members: allowed(),
      api_keys: allowed(),
    },
    limits: {
      ...EFFECTIVE_LIMITS,
      sites: 5,
      storage_bytes: 1073741824, // 1.0 GB
      ...(overrides.limits ?? {}),
    },
    usage: overrides.usage ?? { sites: 2, storage_bytes: 123456 },
    principal: "member",
    tenant: { id: "ten_acceptance", name: "Acme" },
    member: {
      id: "mem_acceptance_self",
      email: "dev@example.test",
      name: "Dev",
      role: overrides.role ?? "owner",
      ...(overrides.member ?? {}),
    },
    keyId: "key_acceptance",
    scopes: overrides.scopes ?? OWNER_SCOPES,
    siteRestriction: overrides.siteRestriction ?? null,
    ...(overrides.extra ?? {}),
  };
}

const ADMIN_MEMBERS = {
  members: [
    { id: "mem_acceptance_self", email: "dev@example.test", name: "Dev", role: "owner", createdAt: "2026-03-04T05:06:07.000Z" },
    { id: "mem_acceptance_peer", email: "peer@example.test", name: "Peer", role: "member", createdAt: "2026-05-06T07:08:09.000Z" },
  ],
};

// ---------------------------------------------------------------------------
// Locators and shared assertions.
// ---------------------------------------------------------------------------

/** The effective-policy block the client renders: its heading and container. */
function policyBlock(world: SettingsWorld): { heading: FakeElement; root: FakeElement } {
  const headings = descendants(world.doc.body).filter((el) => ["h1", "h2", "h3", "h4"].includes(el.tagName));
  expect(headings.length, "the settings client renders an effective-policy section with a heading").toBeGreaterThan(0);
  const heading = headings[0]!;
  const root = heading.parentNode;
  expect(root, "the policy heading lives inside a section container").not.toBeNull();
  return { heading, root: root! };
}

/** dd / tr / li whose text matches every pattern. */
function rowMatching(root: FakeElement, patterns: RegExp[]): FakeElement | null {
  const rows = descendants(root).filter((el) => ["dd", "tr", "li"].includes(el.tagName));
  return rows.find((row) => patterns.every((p) => p.test(row.textContent))) ?? null;
}

/** The row showing a byte count, raw or formatted. */
function byteRow(root: FakeElement, n: number): FakeElement | null {
  const rows = descendants(root).filter((el) => ["dd", "tr", "li"].includes(el.tagName));
  return rows.find((row) => row.textContent.includes(String(n)) || row.textContent.includes(formatBytes(n))) ?? null;
}

/** The dd paired with a dt label (definition-list shape). */
function ddForLabel(root: FakeElement, label: string): FakeElement | null {
  for (const dl of descendants(root).filter((el) => el.tagName === "dl")) {
    const kids = dl.children.filter((c): c is FakeElement => c instanceof FakeElement);
    for (let i = 0; i + 1 < kids.length; i++) {
      const dt = kids[i]!;
      const dd = kids[i + 1]!;
      if (dt.tagName === "dt" && dd.tagName === "dd" && dt.textContent === label) return dd;
    }
  }
  return null;
}

/** The row carrying one stable capability id. */
function capabilityRow(root: FakeElement, id: string): FakeElement | null {
  const hits = descendants(root).filter((el) => el.textContent.includes(id));
  if (!hits.length) return null;
  hits.sort((a, b) => depth(b) - depth(a));
  let row = hits[0]!;
  if (row.textContent.trim().length < id.length + 8 && row.parentNode && descendants(root).includes(row.parentNode)) {
    row = row.parentNode;
  }
  return row;
}

/** Only the already-authorized reads, once each, never a mutation or new call. */
function expectReadsOnly(world: SettingsWorld, opts: { members: boolean }): void {
  for (const call of world.fetchCalls) {
    expect(call.method, `settings makes no mutating requests (saw ${call.method} ${call.url})`).toBe("GET");
    expect(["/api/v1/me", "/api/v1/members"], `settings calls no new endpoint (saw ${call.url})`).toContain(call.url);
  }
  expect(
    world.fetchCalls.filter((c) => c.url === "/api/v1/me").length,
    "settings reads /me exactly once (no polling)",
  ).toBe(1);
  expect(
    world.fetchCalls.filter((c) => c.url === "/api/v1/members").length,
    opts.members ? "admin settings loads members once" : "non-admin settings never loads members",
  ).toBe(opts.members ? 1 : 0);
  expect(world.quietGrowth, "no late or polling requests after settle").toBe(0);
}

describe("settings effective policy", () => {
  it("replaces a warm same-key cache with current effective limits, usage and capability refusals", async () => {
    const cached = memberMe({
      limits: {
        maxFileBytes: 16777216,
        maxFiles: 777,
        maxSiteBytes: 805306368,
        oneShotMaxBytes: 33554432,
        sites: 97,
        storage_bytes: 2147483648,
      },
      usage: { sites: 73, storage_bytes: 2097152 },
      capabilities: { screenshots: allowed(), stale_capability: allowed() },
    });
    const fresh = memberMe({
      capabilities: {
        screenshots: refused(
          "feature_unavailable",
          "Screenshots are unavailable for the current caller.",
          "Ask the instance administrator about current screenshot support.",
        ),
      },
    });
    const world = await runSettings(fresh, ADMIN_MEMBERS, cached);
    const { root } = policyBlock(world);
    for (const n of [8388608, 536870912, 4194304]) {
      expect(byteRow(root, n), `current effective limit ${n} replaces the cached value`).not.toBeNull();
    }
    expect(rowMatching(root, [/\b120\b/]), "current files-per-version limit renders").not.toBeNull();
    expect(rowMatching(root, [/\b2\b/, /\b5\b/]), "current site usage and limit render together").not.toBeNull();
    const storage = byteRow(root, 123456);
    expect(storage, "current retained storage usage renders").not.toBeNull();
    expect(storage, "current retained storage limit renders in the same row").toBe(byteRow(root, 1073741824));
    const screenshots = capabilityRow(root, "screenshots");
    expect(screenshots, "current screenshot refusal replaces cached availability").not.toBeNull();
    expect(screenshots!.textContent).toContain("feature_unavailable");
    expect(screenshots!.textContent).toContain("Screenshots are unavailable for the current caller.");
    expect(screenshots!.textContent).toContain("Ask the instance administrator about current screenshot support.");
    expect(screenshots!.textContent).not.toMatch(/\ballowed\b/i);
    expect(capabilityRow(root, "stale_capability"), "cached-only capabilities disappear").toBeNull();
    for (const stale of [16777216, 805306368, 33554432, 2147483648, 2097152]) {
      expect(byteRow(root, stale), `cached byte value ${stale} is not rendered`).toBeNull();
    }
    expect(rowMatching(root, [/\b777\b/]), "cached file count is not rendered").toBeNull();
    expect(rowMatching(root, [/\b73\b/, /\b97\b/]), "cached site usage and limit are not rendered").toBeNull();
    expectReadsOnly(world, { members: true });
  });

  it.each([
    { label: "non-admin member", scopes: MEMBER_SCOPES, siteRestriction: null },
    { label: "site-restricted key", scopes: ["sites:read", "sites:write"], siteRestriction: "site_current_only" },
  ])("does not inherit warm-cache member controls for a current $label", async ({ scopes, siteRestriction }) => {
    const cachedOwner = memberMe();
    const fresh = memberMe({ role: "member", scopes, siteRestriction });
    const world = await runSettings(fresh, ADMIN_MEMBERS, cachedOwner);
    expect(ddForLabel(world.me, "Role")!.textContent).toBe("member");
    expect(ddForLabel(world.me, "Key scopes")!.textContent).toBe(scopes.join(" "));
    expect(ddForLabel(world.me, "Key limited to a site")!.textContent).toBe(siteRestriction ? "yes" : "no");
    expect(world.membersSection.hidden, "cached owner privileges cannot expose member controls").toBe(true);
    expect(world.members.textContent).not.toContain("peer@example.test");
    expect(world.members.textContent).not.toContain("Remove");
    expect(descendants(world.members).filter((el) => ["button", "input", "select", "form"].includes(el.tagName))).toEqual([]);
    expectReadsOnly(world, { members: false });
  });

  it("loads authorized members for a current owner despite a warm restricted-member cache", async () => {
    const cachedMember = memberMe({
      role: "member",
      scopes: ["sites:read"],
      siteRestriction: "site_cached_only",
    });
    const world = await runSettings(memberMe(), ADMIN_MEMBERS, cachedMember);
    expect(ddForLabel(world.me, "Role")!.textContent).toBe("owner");
    expect(ddForLabel(world.me, "Key scopes")!.textContent).toBe(OWNER_SCOPES.join(" "));
    expect(ddForLabel(world.me, "Key limited to a site")!.textContent).toBe("no");
    expect(world.membersSection.hidden, "current owner keeps the authorized members section").toBe(false);
    expect(world.members.textContent).toContain("peer@example.test");
    expect(world.members.textContent).toContain("You");
    expect(world.members.textContent).toContain("Remove");
    expectReadsOnly(world, { members: true });
  });

  it("renders the four caller-effective byte/count limits, distinct from instance defaults", async () => {
    const world = await runSettings(memberMe(), ADMIN_MEMBERS);
    const { heading, root } = policyBlock(world);
    expect(heading.textContent, "the section is labeled as the caller's effective values").toMatch(/effective|your/i);
    for (const n of [EFFECTIVE_LIMITS.maxFileBytes, EFFECTIVE_LIMITS.maxSiteBytes, EFFECTIVE_LIMITS.oneShotMaxBytes]) {
      expect(byteRow(root, n), `effective limit ${n} is shown`).not.toBeNull();
    }
    expect(rowMatching(root, [/\b120\b/]), "effective files-per-version 120 is shown").not.toBeNull();
    expect(root.textContent, "instance defaults are not presented as the caller's values").not.toContain("2500");
    expect(root.textContent, "instance defaults are not presented as the caller's values").not.toContain("104857600");
    expectReadsOnly(world, { members: true });
  });

  it("shows site usage against its configured limit in one row", async () => {
    const world = await runSettings(memberMe(), ADMIN_MEMBERS);
    const { root } = policyBlock(world);
    const row = rowMatching(root, [/\b2\b/, /\b5\b/]);
    expect(row, "a row shows 2 used of a 5-site limit").not.toBeNull();
    expect(row!.textContent).toMatch(/[a-z]{3,}/i);
    expectReadsOnly(world, { members: true });
  });

  it("shows retained storage against its limit, never as merely served files", async () => {
    const world = await runSettings(memberMe(), ADMIN_MEMBERS);
    const { root } = policyBlock(world);
    const used = byteRow(root, 123456);
    const limit = byteRow(root, 1073741824);
    expect(used, "retained storage usage is shown").not.toBeNull();
    expect(limit, "the configured storage limit is shown").not.toBeNull();
    expect(used, "usage is shown against its limit").toBe(limit);
    expect(used!.textContent, "retained usage is named as stored/retained").toMatch(/retain|stored/i);
    expect(used!.textContent, "retained usage is not described as served").not.toMatch(/served/i);
    expectReadsOnly(world, { members: true });
  });

  it("renders allowed capabilities by stable id without implying every operation is authorized", async () => {
    const world = await runSettings(memberMe(), ADMIN_MEMBERS);
    const { root } = policyBlock(world);
    const row = capabilityRow(root, "site_password");
    expect(row, "the allowed site_password capability is shown by its stable id").not.toBeNull();
    expect(row!.textContent).toMatch(/allow|available|enabled|\byes\b|\bon\b|✓/i);
    expect(root.textContent, "an allowed capability never claims full authorization").not.toMatch(
      /all operations|every operation|full access/i,
    );
    expectReadsOnly(world, { members: true });
  });

  it("renders refusals with code, message and hint as plain text", async () => {
    const world = await runSettings(
      memberMe({
        capabilities: {
          members: allowed(),
          screenshots: refused(
            "feature_unavailable",
            "This instance does not support screenshots.",
            "Ask the instance administrator to configure BROWSER.",
            "BROWSER",
          ),
        },
      }),
      ADMIN_MEMBERS,
    );
    const { root } = policyBlock(world);
    const row = capabilityRow(root, "screenshots");
    expect(row, "the refused screenshots capability is shown").not.toBeNull();
    expect(row!.textContent).toContain("feature_unavailable");
    expect(row!.textContent).toContain("This instance does not support screenshots.");
    expect(row!.textContent).toContain("Ask the instance administrator to configure BROWSER.");
    expectReadsOnly(world, { members: true });
  });

  it("keeps markup-looking refusal text inert: literal text, no created elements", async () => {
    const message = "Refused for <b>zebrastripe</b> & <img src=x onerror=alert(1)>.";
    const hint = "Ask <i>quillback</i> & retry <script>alert(1)</script>.";
    const world = await runSettings(
      memberMe({ capabilities: { site_password: refused("acme_refused_for_review", message, hint) } }),
      ADMIN_MEMBERS,
    );
    const { root } = policyBlock(world);
    const row = capabilityRow(root, "site_password");
    expect(row, "the custom refusal is shown").not.toBeNull();
    expect(row!.textContent).toContain("acme_refused_for_review");
    expect(row!.textContent).toContain(message);
    expect(row!.textContent).toContain(hint);
    const tags = descendants(root).map((el) => el.tagName);
    expect(tags, "refusal text never becomes elements").not.toContain("script");
    expect(tags, "refusal text never becomes elements").not.toContain("img");
    expect(
      descendants(root).some((el) => el.tagName === "b" && el.textContent.includes("zebrastripe")),
      "the <b> in the message is text, not an element",
    ).toBe(false);
    expect(
      descendants(root).some((el) => el.tagName === "i" && el.textContent.includes("quillback")),
      "the <i> in the hint is text, not an element",
    ).toBe(false);
    expectReadsOnly(world, { members: true });
  });

  it("never turns a missing binding into an enable or buy control", async () => {
    const world = await runSettings(
      memberMe({
        capabilities: {
          members: allowed(),
          screenshots: refused(
            "feature_unavailable",
            "This instance does not support screenshots.",
            "Ask the instance administrator to configure BROWSER.",
            "BROWSER",
          ),
          site_data: refused(
            "feature_unavailable",
            "This instance does not support site_data.",
            "Ask the instance administrator to configure SITE_DATA.",
            "SITE_DATA",
          ),
        },
      }),
      ADMIN_MEMBERS,
    );
    const { root } = policyBlock(world);
    expect(capabilityRow(root, "screenshots")!.textContent).toContain("BROWSER");
    expect(capabilityRow(root, "site_data")!.textContent).toContain("SITE_DATA");
    const tags = descendants(root).map((el) => el.tagName);
    for (const interactive of ["button", "input", "select", "textarea"]) {
      expect(tags, "the read-only policy section has no controls").not.toContain(interactive);
    }
    for (const link of descendants(root).filter((el) => el.tagName === "a")) {
      expect(link.textContent, "no link offers to enable or sell the missing binding").not.toMatch(/enable|buy|upgrade|activate/i);
    }
    expectReadsOnly(world, { members: true });
  });

  it("renders a zero quota as 0, never as unlimited or unavailable", async () => {
    const world = await runSettings(
      memberMe({
        limits: {
          maxFileBytes: 12582912,
          maxFiles: 121,
          maxSiteBytes: 536870912,
          oneShotMaxBytes: 12582912,
          sites: 0,
          storage_bytes: 12884901888,
        },
        usage: { sites: 0, storage_bytes: 123456 },
      }),
      ADMIN_MEMBERS,
    );
    const { root } = policyBlock(world);
    const row = rowMatching(root, [/\b0\b/]);
    expect(row, "the zero site quota is shown as 0").not.toBeNull();
    expect(row!.textContent).not.toMatch(/unlimited/i);
    expect(row!.textContent).not.toMatch(/unavailable|unknown/i);
    expectReadsOnly(world, { members: true });
  });

  it("renders a null quota as unlimited while other nulls stay ordinary", async () => {
    const world = await runSettings(
      memberMe({ limits: { sites: null }, member: { name: null } }),
      ADMIN_MEMBERS,
    );
    const { root } = policyBlock(world);
    const sites = rowMatching(root, [/\b2\b/, /unlimited/i]);
    expect(sites, "null sites quota renders usage 2 of unlimited").not.toBeNull();
    const storage = byteRow(root, 1073741824);
    expect(storage, "the configured storage limit still renders").not.toBeNull();
    expect(storage!.textContent, "a configured limit is not called unlimited").not.toMatch(/unlimited/i);
    expect(ddForLabel(world.me, "Signed in as")!.textContent, "a null member name falls back to email").toBe("dev@example.test");
    expect(ddForLabel(world.me, "Key limited to a site")!.textContent, "a null site restriction stays no").toBe("no");
    expectReadsOnly(world, { members: true });
  });

  it("marks unknown values unavailable instead of inventing zero usage", async () => {
    const world = await runSettings(memberMe({ usage: {} }), ADMIN_MEMBERS);
    const { root } = policyBlock(world);
    const sites = rowMatching(root, [/\b5\b/]);
    expect(sites, "the sites row still shows its limit").not.toBeNull();
    expect(sites!.textContent).toMatch(/unavailable|unknown/i);
    expect(sites!.textContent, "unknown site usage is not invented as 0").not.toMatch(/\b0\b/);
    const storage = byteRow(root, 1073741824);
    expect(storage, "the storage row still shows its limit").not.toBeNull();
    expect(storage!.textContent).toMatch(/unavailable|unknown/i);
    expect(storage!.textContent, "unknown storage usage is not invented as 0").not.toContain("0 B");
    expect(storage!.textContent, "unknown storage usage is not invented as 0").not.toMatch(/\b0 of\b/);
    expectReadsOnly(world, { members: true });
  });

  it("tolerates partial shapes: renders what is returned, marks gaps, never crashes", async () => {
    const world = await runSettings(
      memberMe({
        capabilities: { site_password: allowed() },
        usage: { sites: 2 },
      }),
      ADMIN_MEMBERS,
    );
    const { root } = policyBlock(world);
    expect(byteRow(root, EFFECTIVE_LIMITS.maxFileBytes), "returned limits render").not.toBeNull();
    expect(rowMatching(root, [/\b2\b/, /\b5\b/]), "returned site usage renders").not.toBeNull();
    expect(capabilityRow(root, "site_password"), "the returned capability renders").not.toBeNull();
    const storage = byteRow(root, 1073741824);
    expect(storage, "the storage row still shows its limit").not.toBeNull();
    expect(storage!.textContent).toMatch(/unavailable|unknown/i);
    expect(world.doc.body.textContent).not.toContain("0 B");
    expect(world.doc.body.textContent).not.toMatch(/\bNaN\b/);
    expect(world.doc.body.textContent).not.toMatch(/\bundefined\b/);
    expectReadsOnly(world, { members: true });
  });

  it("shows the policy section to non-admin members while members stay hidden", async () => {
    const world = await runSettings(memberMe({ role: "member", scopes: MEMBER_SCOPES }), { members: [] });
    expect(world.membersSection.hidden, "members stay hidden without members:write").toBe(true);
    const { root } = policyBlock(world);
    expect(byteRow(root, EFFECTIVE_LIMITS.maxFileBytes), "non-admin members see effective limits").not.toBeNull();
    expect(capabilityRow(root, "site_password"), "non-admin members see capabilities").not.toBeNull();
    expectReadsOnly(world, { members: false });
  });

  it("shows the policy section to site-scoped keys with identity gating unchanged", async () => {
    const world = await runSettings(
      memberMe({ role: "member", scopes: ["sites:read", "sites:write"], siteRestriction: "site_acceptance_only" }),
      { members: [] },
    );
    expect(ddForLabel(world.me, "Key limited to a site")!.textContent).toBe("yes");
    expect(world.membersSection.hidden, "members stay hidden without members:write").toBe(true);
    const { root } = policyBlock(world);
    expect(byteRow(root, EFFECTIVE_LIMITS.maxFileBytes), "site-scoped keys see effective limits").not.toBeNull();
    expectReadsOnly(world, { members: false });
  });

  it("uses semantic read-only markup: labeled lists, no chart, meter, or calculated metrics", async () => {
    const world = await runSettings(memberMe(), ADMIN_MEMBERS);
    const { heading, root } = policyBlock(world);
    expect(heading.textContent).toMatch(/effective|your/i);
    const policyLists = descendants(root)
      .filter((el) => ["dl", "table", "ul", "ol"].includes(el.tagName))
      .filter((el) => el.textContent.includes("120") || el.textContent.includes("site_password"));
    expect(policyLists.length, "policy content lives in a definition list, table, or list").toBeGreaterThan(0);
    for (const list of policyLists) {
      expect(list.textContent, "policy rows carry labels").toMatch(/[a-z]{4,}/i);
      expect(list.className === "" || list.className.includes("dw-"), "policy lists reuse dashboard classes").toBe(true);
    }
    const tags = descendants(root).map((el) => el.tagName);
    for (const forbidden of ["canvas", "meter", "progress", "input", "select", "textarea", "button"]) {
      expect(tags, `no ${forbidden} in the read-only policy section`).not.toContain(forbidden);
    }
    expect(root.textContent, "no calculated percentages").not.toContain("%");
    for (const el of descendants(root)) {
      const attr = el.getAttribute("tabindex");
      expect(el.tabIndex > 0 || (attr !== null && Number(attr) > 0), "no positive tabindex disturbs keyboard order").toBe(false);
    }
    expectReadsOnly(world, { members: true });
  });

  it("control: the existing identity rows render unchanged (harness proof)", async () => {
    const world = await runSettings(memberMe(), ADMIN_MEMBERS);
    expect(ddForLabel(world.me, "Signed in as")!.textContent).toBe("dev@example.test");
    expect(ddForLabel(world.me, "Role")!.textContent).toBe("owner");
    expect(ddForLabel(world.me, "Key scopes")!.textContent).toBe(OWNER_SCOPES.join(" "));
    expect(ddForLabel(world.me, "Key limited to a site")!.textContent).toBe("no");
    expectReadsOnly(world, { members: true });
  });

  it("control: member controls gate on members:write exactly as before", async () => {
    const admin = await runSettings(memberMe(), ADMIN_MEMBERS);
    expect(admin.membersSection.hidden).toBe(false);
    expect(admin.members.textContent).toContain("dev@example.test");
    expect(admin.members.textContent).toContain("peer@example.test");
    expect(admin.members.textContent).toContain("You");
    expect(admin.members.textContent).toContain("Remove");
    expectReadsOnly(admin, { members: true });

    const member = await runSettings(memberMe({ role: "member", scopes: MEMBER_SCOPES }), { members: [] });
    expect(member.membersSection.hidden, "members stay hidden without members:write").toBe(true);
    expectReadsOnly(member, { members: false });
  });

  it("control: an older /me without policy fields neither crashes nor invents usage", async () => {
    const legacy = {
      principal: "member",
      tenant: { id: "ten_acceptance", name: "Acme" },
      member: { id: "mem_acceptance_self", email: "dev@example.test", name: "Dev", role: "owner" },
      keyId: "key_acceptance",
      scopes: OWNER_SCOPES,
      siteRestriction: null,
    };
    const world = await runSettings(legacy, ADMIN_MEMBERS);
    expect(ddForLabel(world.me, "Signed in as")!.textContent, "identity still renders").toBe("dev@example.test");
    expect(world.members.textContent, "members still load after an older /me").toContain("peer@example.test");
    const headings = descendants(world.doc.body).filter((el) => ["h1", "h2", "h3", "h4"].includes(el.tagName));
    if (headings.length > 0) {
      expect(headings[0]!.parentNode!.textContent, "a policy block for an older /me admits it is unavailable").toMatch(
        /unavailable|unknown/i,
      );
    }
    expect(world.doc.body.textContent).not.toContain("0 B");
    expect(world.doc.body.textContent).not.toMatch(/\b0 of\b/);
    expect(world.doc.body.textContent).not.toMatch(/\bNaN\b/);
    expect(world.doc.body.textContent).not.toMatch(/\bundefined\b/);
    expectReadsOnly(world, { members: true });
  });

  it("control: unknown /me fields and key material are never rendered", async () => {
    const topSecret = "probe_top_s3cr3t_zebra";
    const memberSecret = "probe_member_s3cr3t_quill";
    const world = await runSettings(
      memberMe({ member: { totpProbe: memberSecret }, extra: { signingProbe: topSecret } }),
      ADMIN_MEMBERS,
    );
    expect(world.doc.body.textContent).not.toContain(topSecret);
    expect(world.doc.body.textContent).not.toContain(memberSecret);
    expect(world.doc.body.textContent, "the signing key itself is never rendered").not.toContain(API_KEY);
    expectReadsOnly(world, { members: true });
  });

  it("control: settings issues only its authorized reads, once each", async () => {
    expectReadsOnly(await runSettings(memberMe(), ADMIN_MEMBERS), { members: true });
    expectReadsOnly(await runSettings(memberMe({ role: "member", scopes: MEMBER_SCOPES }), { members: [] }), {
      members: false,
    });
  });
});
