/** Disposable REST boundary and browser primitives for the served dashboard script.
 * No selectors or business logic are injected into production. Deferred responses
 * deliberately ignore abort signals: abort alone cannot guarantee ordering. */
import vm from "node:vm";
import { expect } from "vitest";
import { CLIENT_SCRIPT } from "../src/ui/assets.ts";
import { FakeDocument, FakeElement, isHidden } from "./dashboard-version-jump.helpers.ts";

export const BASE = "/api/v1/sites/test-site";
export const OLD = "ver_original_immutable";
export const CURRENT = "ver_current_immutable";
export const SECOND = "ver_second_immutable";
export const FILE = "docs/old note+α.txt";

export function version(id: string, number: number, live = false, status = "ready") {
  return { id, number, live, status, fileCount: 1, totalBytes: 8, message: `release ${number}`,
    client: "acceptance/1", source: "publish", createdAt: "2026-10-19T00:00:00.000Z",
    finalizedAt: status === "ready" ? "2026-10-20T00:00:00.000Z" : null };
}
export type Version = ReturnType<typeof version>;
export function file(path: string, sha256 = "1".repeat(64)) {
  return { path, sha256, size: 8, contentType: "text/plain", kind: "text", extension: "txt",
    url: `https://files.test/test-site/${path.split("/").map(encodeURIComponent).join("/")}`,
    rawUrl: `${BASE}/files/${path.split("/").map(encodeURIComponent).join("/")}` };
}
export type ManifestFile = ReturnType<typeof file>;
export function fixture() {
  const versions = Array.from({ length: 105 }, (_, i) => {
    const n = 105 - i;
    return version(n === 105 ? CURRENT : n === 104 ? SECOND : n === 1 ? OLD : `ver_fixture_${n}`, n, n === 105);
  });
  const files = new Map(versions.map(v => [v.id, [file(v.id === OLD ? FILE : `release-${v.number}.txt`)]]));
  const bytes = new Map(versions.map(v => [v.id, v.id === OLD ? "old body" : "new body"]));
  return { versions, files, bytes, liveId: CURRENT };
}
export type Fixture = ReturnType<typeof fixture>;
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
export const tick = () => new Promise<void>(r => setTimeout(r, 0));
export async function settle() { for (let i = 0; i < 6; i++) await tick(); }
export async function waitFor(predicate: () => boolean, description: string) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2200) throw new Error(`Timed out: ${description}`);
    await tick();
  }
}
class Storage {
  private values = new Map<string, string>();
  getItem(k: string) { return this.values.get(k) ?? null; }
  setItem(k: string, value: string) { this.values.set(k, String(value)); }
  removeItem(k: string) { this.values.delete(k); }
}
export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});
export const failure = (status = 404, message = "Version not found", hint = "Check the version reference and try again.") =>
  json({ error: { code: status === 403 ? "forbidden" : "version_not_found", message, hint } }, status);
export const resolved = (v: Version) => json({ site: "test-site", version: v, missing: v.status === "pending" ? ["f".repeat(64)] : [] });
export const manifest = (v: Version, files: ManifestFile[]) => json({ version: v, files, total: files.length, nextCursor: null });
export type Intercept = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

export async function mount(f = fixture(), options: { requested?: string; prior?: string; intercept?: Intercept } = {}) {
  const doc = new FakeDocument();
  doc.body.setAttribute("data-page", "site");
  const boot = doc.createElement("script");
  boot.id = "dw-boot";
  boot.setAttribute("type", "application/json");
  boot.textContent = JSON.stringify({ v: 1, origin: "https://test/", instanceName: "Test", api: "/api/v1",
    sitesMode: "path", anonymousPublish: false, session: null, page: { name: "site", slug: "test-site" } });
  doc.body.appendChild(boot);
  for (const id of ["dw-account", "dw-site", "dw-toasts"]) {
    const el = doc.createElement("div"); el.id = id; doc.body.appendChild(el);
  }
  const urlFor = (ref?: string) => `https://test/dashboard/sites/test-site?keep=1${ref ? `&version=${encodeURIComponent(ref)}` : ""}`;
  const location = new URL(urlFor(options.requested));
  const entries = [urlFor(options.prior ?? OLD), location.href];
  let position = 1;
  const windowListeners = new Map<string, Array<(event: unknown) => void>>();
  const history = {
    get length() { return entries.length; },
    pushState(_state: unknown, _unused: string, url?: string | URL | null) {
      if (url != null) location.href = new URL(String(url), location).href;
      entries.splice(position + 1); entries.push(location.href); position++;
    },
    replaceState(_state: unknown, _unused: string, url?: string | URL | null) {
      if (url != null) location.href = new URL(String(url), location).href;
      entries[position] = location.href;
    },
    go(delta: number) {
      const next = position + delta;
      if (next < 0 || next >= entries.length) return;
      position = next; location.href = entries[position]!;
      for (const fn of windowListeners.get("popstate") ?? []) fn({ type: "popstate", state: null });
    },
    back() { this.go(-1); }, forward() { this.go(1); },
  };
  const session = new Storage(); session.setItem("dropway.key", "dw_disposable_fixture");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const unexpected: string[] = [];
  let intercept = options.intercept;
  const fetch = async (input: unknown, init: RequestInit = {}) => {
    const raw = String(input); calls.push({ url: raw, init });
    const u = new URL(raw, location);
    const overridden = intercept?.(u, init);
    if (overridden !== undefined) return overridden;
    if (init.method && init.method.toUpperCase() !== "GET") {
      unexpected.push(`${init.method} ${raw}`);
      return failure(405, "Unexpected mutation", "This test is read-only.");
    }
    if (u.pathname === BASE) return json({ site: { slug: "test-site", title: "Test Site", url: "https://files.test/test-site/",
      description: "", settings: { spa: false, renderMarkdown: true, crossOriginIsolation: false, passwordProtected: false } } });
    if (u.pathname === `${BASE}/versions`) {
      const limit = Math.min(500, Math.max(1, Number(u.searchParams.get("limit")) || 50));
      return json({ versions: f.versions.filter(v => v.status === "ready").slice(0, limit).map(v => ({ ...v, live: v.id === f.liveId })),
        currentVersionId: f.liveId });
    }
    if (u.pathname.startsWith(`${BASE}/versions/`)) {
      const ref = decodeURIComponent(u.pathname.slice(`${BASE}/versions/`.length));
      const v = ref === "live" ? f.versions.find(v => v.id === f.liveId) : /^v?\d+$/.test(ref)
        ? f.versions.find(v => v.number === Number(ref.replace(/^v/, ""))) : f.versions.find(v => v.id === ref);
      return v ? resolved({ ...v, live: v.id === f.liveId }) : failure();
    }
    if (u.pathname === `${BASE}/files`) {
      const id = u.searchParams.get("version") ?? f.liveId;
      const v = f.versions.find(v => v.id === id);
      return v ? manifest({ ...v, live: v.id === f.liveId }, f.files.get(id) ?? []) : failure();
    }
    if (u.pathname.startsWith(`${BASE}/files/`)) {
      const id = u.searchParams.get("version") ?? f.liveId;
      const path = u.pathname.slice(`${BASE}/files/`.length).split("/").map(decodeURIComponent).join("/");
      if (!f.files.get(id)?.some(file => file.path === path)) return failure();
      return new Response(f.bytes.get(id), { headers: { "Content-Type": "text/plain", "Content-Disposition": "attachment" } });
    }
    if (u.pathname === "/api/v1/me") return json({ principal: "member", scopes: ["sites:read", "sites:write", "sites:delete"],
      member: { email: "owner@example.com", role: "owner" } });
    unexpected.push(raw);
    return failure(404, "Unexpected endpoint", "Only existing registry operations are allowed.");
  };
  const blobs: Array<{ url: string; blob: Blob }> = [];
  const revoked: string[] = [];
  class ObjectURL extends URL {
    static createObjectURL(blob: Blob) { const url = `blob:download-${blobs.length}`; blobs.push({ url, blob }); return url; }
    static revokeObjectURL(url: string) { revoked.push(url); }
  }
  const sandbox: Record<string, unknown> = {
    document: doc, location, history, sessionStorage: session, localStorage: new Storage(), fetch,
    navigator: { clipboard: { writeText: async () => {} } },
    URL: ObjectURL, URLSearchParams, Headers, Response, Blob, AbortController, DOMException,
    setTimeout, clearTimeout, queueMicrotask, console,
    addEventListener(type: string, fn: (event: unknown) => void) {
      const listeners = windowListeners.get(type) ?? []; listeners.push(fn); windowListeners.set(type, listeners);
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      windowListeners.set(type, (windowListeners.get(type) ?? []).filter(f => f !== fn));
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SCRIPT, sandbox, { filename: "served-dashboard.js" });
  await waitFor(() => !!doc.querySelector("#files table, #files .dw-error, #dw-site .dw-error"), "initial dashboard render");
  await settle();
  return {
    doc, calls, unexpected, f, location, history, blobs, revoked,
    intercept(fn?: Intercept) { intercept = fn; },
    paths() { return doc.querySelectorAll("#files tbody tr").filter(r => !isHidden(r)).map(r => r.querySelector("td")!.textContent); },
    files() { return doc.querySelector("#files")!; },
    lookups() { return calls.filter(c => new URL(c.url, location).pathname.startsWith(`${BASE}/versions/`)); },
    manifests() { return calls.filter(c => new URL(c.url, location).pathname === `${BASE}/files`); },
    lists() { return calls.filter(c => new URL(c.url, location).pathname === `${BASE}/versions`); },
    downloads() { return calls.filter(c => new URL(c.url, location).pathname.startsWith(`${BASE}/files/`)); },
  };
}
export type Mounted = Awaited<ReturnType<typeof mount>>;
export function accessibleName(doc: FakeDocument, el: FakeElement): string {
  const labelled = el.getAttribute("aria-labelledby")?.split(/\s+/).map(id => doc.getElementById(id)?.textContent ?? "").join(" ");
  const labels = doc.querySelectorAll("label").filter(l => (el.id && l.getAttribute("for") === el.id) || l.contains(el));
  return labelled || el.getAttribute("aria-label") || labels.map(l => l.textContent).join(" ") || el.textContent;
}
export function jump(m: Mounted) {
  const inputs = m.doc.querySelectorAll("input").filter(el => /version/i.test(accessibleName(m.doc, el)) && !/filter|search/i.test(accessibleName(m.doc, el)));
  expect(inputs, "one labelled version-reference input, separate from loaded-history filtering").toHaveLength(1);
  const input = inputs[0]!;
  const scope = input.closest("form") ?? input.parentNode!;
  const buttons = scope.querySelectorAll("button,input").filter(el => /^(open|go)(\s+version)?$/i.test(accessibleName(m.doc, el).trim()) ||
    /^(open|go)(\s+version)?$/i.test(el.getAttribute("value") ?? ""));
  expect(buttons, "an explicit Open/Go submit next to the version-reference input").toHaveLength(1);
  return { input, button: buttons[0]! };
}
export function typeReference(m: Mounted, ref: string) {
  const { input } = jump(m); input.focus(); input.value = ref; input.dispatch("input"); return input;
}
export function submit(m: Mounted, ref: string, enter = false) {
  const input = typeReference(m, ref);
  if (enter) input.dispatch("keydown", { key: "Enter" }); else jump(m).button.click();
}
export function rowButtons(m: Mounted, name: string) {
  return m.doc.querySelectorAll("tr").flatMap(row => row.querySelectorAll("button").filter(b => b.textContent.trim() === name));
}
export function errorText(m: Mounted) {
  return m.doc.querySelectorAll('[role="alert"], .dw-error, [aria-live="polite"], [aria-live="assertive"]')
    .filter(el => !isHidden(el)).map(el => el.textContent).join(" ");
}
export async function expectSelection(m: Mounted, id: string, number: number) {
  await waitFor(() => m.files().textContent.includes(`Files in v${number}`) && m.paths().join("|") === m.f.files.get(id)!.map(f => f.path).join("|"), `display ${id}`);
  expect(new URL(m.manifests().at(-1)!.url, m.location).searchParams.get("version")).toBe(id);
}
