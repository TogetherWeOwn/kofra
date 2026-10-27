/**
 * Protected acceptance: the dashboard site page shows the badge embed snippet
 * for public sites only (SITE-BADGE case 11).
 *
 * Item TOG-43036 for the TOG-43039 build. No snippet path exists in the served
 * dashboard script today; these tests fail on main and the builder makes them
 * pass on this branch without editing this file.
 *
 * What the builder implements (contract):
 * - On `/dashboard/sites/:slug` (page `site`), when the site is public
 *   (`settings.passwordProtected` false from GET /api/v1/sites/:slug) and has
 *   a live URL (`site.url`, always ending in "/"), show the embed snippet.
 * - DOM (all inside `#dw-site`):
 *   - Container: `[data-testid="site-badge-snippet"]` (must exist and be
 *     visible when public with a URL; absent or hidden otherwise).
 *   - Markdown: `[data-testid="site-badge-markdown"]` whose value-or-text is
 *     exactly `[![kofra]({url}badge.svg)]({url})` with the site's own URL.
 *   - Preview: `img[data-testid="site-badge-preview"]` with `src` exactly
 *     `{url}badge.svg` and `alt` matching /kofra/i.
 *   - Copy: a button in the container that copies the exact markdown.
 * - Gated or URL-less sites show no snippet and no badge address anywhere in
 *   `#dw-site`; all existing site-page controls stay.
 * - Zero new endpoints: only /me, /sites/:slug, /versions, /files.
 *
 * Harness: the real served dashboard script (CLIENT_SCRIPT, exact bytes the
 * Worker serves) in Node's vm with the repo's shared fake DOM
 * (loaded-versions-filter.dom.ts), plus a recording canvas stub for the merged
 * site-QR section that shares this page. Fixtures mirror real API shapes.
 * No production requests.
 *
 * Run: npm run test:browser-code
 *      npx vitest run -c packages/server/vitest.config.ts test/site-badge-snippet.acceptance.test.ts
 */
import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { CLIENT_SCRIPT } from "../src/ui/assets.ts";
import { FakeDocument, FakeElement, isHidden } from "./loaded-versions-filter.dom.ts";

// ---------------------------------------------------------------------------
// Canvas stub: the merged site-QR section draws to a canvas on this page, and
// the shared fake DOM has no canvas. Augment the shared element (this file's
// module registry only) so the page renders faithfully under test.
// ---------------------------------------------------------------------------

interface CanvasStub {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
}

const canvasContexts = new WeakMap<object, CanvasStub>();

function context2d(host: object): CanvasStub {
  let ctx = canvasContexts.get(host);
  if (!ctx) {
    ctx = { fillStyle: "#000", fillRect() {}, clearRect() {} };
    canvasContexts.set(host, ctx);
  }
  return ctx;
}

const elementProto = FakeElement.prototype as unknown as Record<string, unknown>;
elementProto.getContext = function (this: object, kind: string): CanvasStub | null {
  return kind === "2d" ? context2d(this) : null;
};
elementProto.toDataURL = function (): string {
  return "data:image/png;base64," + "YmFkZ2Utc25pcHBldC1maXh0dXJl".repeat(40);
};

// ---------------------------------------------------------------------------
// Fixtures and mount
// ---------------------------------------------------------------------------

const SITE_SLUG = "badge-snippet-fixture";
const SUBDOMAIN_URL = "https://badge-snippet-fixture.sites.test/";
const PATH_URL = "https://dropway.test/s/badge-snippet-fixture/";

const snippetMarkdown = (url: string): string => `[![kofra](${url}badge.svg)](${url})`;

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
    title: "Badge Fixture",
    url: SUBDOMAIN_URL,
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

async function tick(ms = 0): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }

function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`Missing ${what}`);
  return v;
}

function snapshot(doc: FakeDocument): string {
  const site = doc.querySelector("#dw-site");
  const testids = doc.querySelectorAll("[data-testid]").map((el) => el.getAttribute("data-testid"));
  return `text=${JSON.stringify(site?.textContent.slice(0, 1200))} testids=${JSON.stringify(testids)}`;
}

async function mount(site: SiteFixture) {
  const slug = site.slug;
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
  const clipboard: string[] = [];
  const jsonResponse = (data: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(data),
    json: async () => data,
    blob: async () => new Blob([JSON.stringify(data)]),
  });
  const versions = [
    { id: "v-live", number: 1, live: true, status: "ready", fileCount: 1, totalBytes: 12, message: "v1", client: "test", source: "test", finalizedAt: "2026-10-20T00:00:00.000Z", createdAt: "2026-10-19T00:00:00.000Z" },
  ];
  const fetchMock = async (url: unknown) => {
    const raw = String(url);
    calls.push(raw);
    const path = raw.split("?")[0] as string;
    const base = `/api/v1/sites/${slug}`;
    if (path === base) {
      return jsonResponse({ site: {
        slug: site.slug, title: site.title, url: site.url, description: site.description,
        settings: { spa: false, renderMarkdown: true, crossOriginIsolation: false, passwordProtected: site.passwordProtected },
      } });
    }
    if (path === `${base}/versions`) {
      return jsonResponse({ versions, currentVersionId: "v-live" });
    }
    if (path === `${base}/files`) {
      return jsonResponse({ version: versions[0], files: [{ path: "index.html", size: 12, sha256: "0".repeat(64), contentType: "text/html", kind: "html", extension: "html", url: `${site.url ?? ""}index.html`, rawUrl: `/api/v1/sites/${slug}/files/index.html` }], total: 1, nextCursor: null });
    }
    if (path === "/api/v1/me") {
      return jsonResponse({ principal: "member", scopes: ["sites:read", "sites:write"], member: { email: "owner@example.com", role: "owner" } });
    }
    return jsonResponse({ error: { code: "not_found", message: `No mock for ${raw}`, hint: "The snippet must not need new endpoints." } }, 404);
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
    navigator: { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } },
    fetch: fetchMock,
    Headers,
    URL: SandboxURL,
    URLSearchParams,
    Blob,
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    console: { log(): void {}, warn(): void {}, error(): void {}, info(): void {} },
    matchMedia: (_q: string) => ({ matches: false, addEventListener(): void {}, removeEventListener(): void {} }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SCRIPT, sandbox, { filename: "app-dashboard.js" });

  return { doc, calls, clipboard };
}

async function settled(doc: FakeDocument): Promise<void> {
  const start = Date.now();
  for (;;) {
    const site = doc.querySelector("#dw-site");
    if (site && (site.textContent.includes("Versions") || site.querySelector('[data-testid="site-badge-snippet"]'))) break;
    if (Date.now() - start > 5000) throw new Error(`Timed out waiting for the site page to settle.\n${snapshot(doc)}`);
    await tick(10);
  }
  await tick(0);
  await tick(0);
}

function snippetContainer(doc: FakeDocument): FakeElement {
  const el = doc.querySelector('#dw-site [data-testid="site-badge-snippet"]');
  if (!el) throw new Error(`Missing [data-testid="site-badge-snippet"] inside #dw-site: the site page must show the badge snippet for a public site.\n${snapshot(doc)}`);
  return el;
}

function expectExistingControls(doc: FakeDocument): void {
  const site = must(doc.querySelector("#dw-site"), "#dw-site");
  const text = site.textContent;
  for (const label of ["Browse files", "Publish update", "Open site", "Versions", "Settings", "Delete site"]) {
    expect(text, `existing site-page control still present: ${label}`).toContain(label);
  }
  expect(site.querySelector('input[name="password"]'), "password field in Settings").not.toBeNull();
}

/** Shared public-site assertions: exact markdown, matching preview, working copy. */
async function expectSnippet(clipboard: string[], doc: FakeDocument, url: string): Promise<void> {
  const box = snippetContainer(doc);
  expect(isHidden(box), "snippet is visible for a public site").toBe(false);
  const markdown = snippetMarkdown(url);
  const shown = must(box.querySelector('[data-testid="site-badge-markdown"]'), "[data-testid=site-badge-markdown]");
  const shownText = shown.value || shown.textContent;
  expect(shownText, "snippet shows the exact embed markdown").toBe(markdown);
  const preview = must(box.querySelector('[data-testid="site-badge-preview"]'), "[data-testid=site-badge-preview]");
  expect(preview.tag, "snippet preview is an <img>").toBe("img");
  expect(preview.getAttribute("src"), "preview src is the site's badge address").toBe(`${url}badge.svg`);
  expect(preview.getAttribute("alt") ?? "", "preview alt names kofra").toMatch(/kofra/i);
  const copy = box.querySelectorAll("button").find((b) => b.textContent === "Copy");
  if (!copy) throw new Error(`Snippet container must hold a Copy button.\n${snapshot(doc)}`);
  copy.click();
  await tick(20);
  await tick(20);
  expect(clipboard, "Copy writes the exact markdown to the clipboard").toContain(markdown);
}

function expectNoSnippet(doc: FakeDocument, why: string): void {
  const box = doc.querySelector('#dw-site [data-testid="site-badge-snippet"]');
  expect(box === null || isHidden(box), `no visible snippet ${why}`).toBe(true);
  expect(must(doc.querySelector("#dw-site"), "#dw-site").textContent, `no badge address leaks ${why}`).not.toContain("badge.svg");
}

// ---------------------------------------------------------------------------
// Public site: exact snippet, matching preview, working copy
// ---------------------------------------------------------------------------

describe("badge snippet: public site", () => {
  it("shows the exact embed markdown with a matching preview and working copy", async () => {
    const m = await mount(siteFixture({ url: SUBDOMAIN_URL }));
    await settled(m.doc);
    await expectSnippet(m.clipboard, m.doc, SUBDOMAIN_URL);
    expectExistingControls(m.doc);
  });

  it("derives the snippet from the path-mode site URL exactly as returned", async () => {
    const m = await mount(siteFixture({ url: PATH_URL }));
    await settled(m.doc);
    await expectSnippet(m.clipboard, m.doc, PATH_URL);
  });
});

// ---------------------------------------------------------------------------
// Gated or URL-less site: no snippet, existing controls stay
// ---------------------------------------------------------------------------

describe("badge snippet: non-public sites", () => {
  it("shows no snippet for a password-gated site", async () => {
    const m = await mount(siteFixture({ passwordProtected: true }));
    await settled(m.doc);
    expectNoSnippet(m.doc, "for a password-gated site");
    expectExistingControls(m.doc);
  });

  it("shows no snippet when the site has no URL", async () => {
    for (const url of [null, ""]) {
      const m = await mount(siteFixture({ url }));
      await settled(m.doc);
      expectNoSnippet(m.doc, `for a URL-less site (url=${JSON.stringify(url)})`);
      expectExistingControls(m.doc);
    }
  });

  it("uses no new server endpoint for the snippet", async () => {
    const m = await mount(siteFixture());
    await settled(m.doc);
    snippetContainer(m.doc);
    const paths = m.calls.map((u) => (u.split("?")[0] as string));
    for (const p of paths) {
      expect(
        p === `/api/v1/sites/${SITE_SLUG}` || p === `/api/v1/sites/${SITE_SLUG}/versions` || p === `/api/v1/sites/${SITE_SLUG}/files` || p === "/api/v1/me",
        `expected stable read only (got ${p}; calls: ${m.calls.join(", ")})`,
      ).toBe(true);
    }
  });
});
