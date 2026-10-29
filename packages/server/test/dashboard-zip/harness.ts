/** PROTECTED acceptance harness. Builder must not edit this directory.
 * Runs the actual first-party dashboard asset, not a replacement download handler.
 * Transport/DOM doubles make stream failure and cancellation deterministic; the
 * paired browser test separately covers the served shell, native keys and download.
 */
import vm from "node:vm";
import { expect } from "vitest";
import { CLIENT_SCRIPT } from "../../src/ui/assets.ts";
import { FakeDocument, type FakeElement } from "./dom.ts";

export const ORIGIN = "https://dashboard.test";
export const SLUG = "zip-fixture";
export const KEY = "dw_disposable_zip_acceptance_key";
export const OLD = "ver_zip_immutable_old";
export const LIVE = "ver_zip_immutable_new";
export const MIB = 1024 * 1024;
export const exportPath = (id = OLD) => `/api/v1/sites/${SLUG}/versions/${encodeURIComponent(id)}/export`;

export function version(id = OLD, number = 1, live = false) {
  return {
    id, number, live, status: "ready", fileCount: 2, totalBytes: 17,
    message: `fixture ${number}`, client: "test", source: "test",
    createdAt: "2026-10-20T00:00:00.000Z", finalizedAt: "2026-10-20T00:00:01.000Z",
  };
}
export type Version = Omit<ReturnType<typeof version>, "totalBytes" | "fileCount" | "finalizedAt"> & {
  totalBytes?: unknown; fileCount?: unknown; finalizedAt: string | null;
};
export interface Wire { url: URL; method: string; headers: Headers; signal?: AbortSignal | null }
export interface Options {
  row?: Partial<Version>;
  requested?: string;
  /** Manifest paths served for the selected version; `[]` exercises the empty-manifest view. */
  files?: string[];
  response?: (request: Wire) => Response | Promise<Response>;
}

class Storage {
  map = new Map<string, string>();
  writes: string[] = [];
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes.push(key); this.map.set(key, String(value)); }
  removeItem(key: string) { this.writes.push(key); this.map.delete(key); }
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export const tick = () => new Promise<void>(done => setTimeout(done, 0));
export async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await tick();
  }
}
export function zipResponse(bytes = new Uint8Array([80, 75, 5, 6]), extra: Record<string, string> = {}) {
  return new Response(bytes, { headers: {
    "Content-Type": "application/zip", "X-Kofra-Version": OLD,
    "Content-Disposition": `attachment; filename="${SLUG}-v1.zip"`, ...extra,
  } });
}

/** No read-ahead: every pull corresponds to an actual consumer read. */
export function countedStream(count: number, chunkBytes: number, options: { failAt?: number; gate?: Promise<void> } = {}) {
  const state = { pulls: 0, cancelled: false, completed: false };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (options.gate) await options.gate;
      if (state.pulls === options.failAt) { controller.error(new TypeError("Archive connection interrupted")); return; }
      if (state.pulls === count) { state.completed = true; controller.close(); return; }
      state.pulls++;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, state };
}
export function streamedResponse(body: ReadableStream<Uint8Array>, extra: Record<string, string> = {}) {
  return new Response(body, { headers: {
    "Content-Type": "application/zip", "X-Kofra-Version": OLD,
    "Content-Disposition": `attachment; filename="${SLUG}-v1.zip"`, ...extra,
  } });
}

export async function mount(options: Options = {}) {
  const doc = new FakeDocument();
  doc.body.setAttribute("data-page", "site");
  for (const [tag, id] of [["script", "dw-boot"], ["div", "dw-account"], ["div", "dw-site"], ["div", "dw-toasts"]]) {
    const element = doc.createElement(tag!);
    element.id = id!;
    doc.body.appendChild(element);
  }
  doc.getElementById("dw-boot")!.textContent = JSON.stringify({
    v: 1, origin: `${ORIGIN}/`, instanceName: "Disposable", api: "/api/v1",
    sitesMode: "path", anonymousPublish: false, session: null, page: { name: "site", slug: SLUG },
  });
  const row: Version = { ...version(), ...options.row };
  const liveId = row.live ? row.id : LIVE;
  const versions = [version(LIVE, 2, !row.live), row];
  const calls: Wire[] = [];
  const unexpected: string[] = [];
  const created: Array<{ url: string; blob: Blob }> = [];
  const revoked: string[] = [];
  const downloads: Array<{ url: string; filename: string; blob?: Blob; target: string | null; revokedAtClick: boolean }> = [];
  const session = new Storage();
  session.map.set("dropway.key", KEY);
  const local = new Storage();
  class ObjectURL extends URL {
    static createObjectURL(blob: Blob) {
      const url = `blob:${ORIGIN}/zip-${created.length + 1}`;
      created.push({ url, blob });
      return url;
    }
    static revokeObjectURL(url: string) { revoked.push(url); }
  }
  doc.clicked = element => {
    if (element.tag !== "a") return;
    const url = element.getAttribute("href") ?? "";
    downloads.push({
      url, filename: element.getAttribute("download") ?? "", target: element.getAttribute("target"),
      blob: created.find(item => item.url === url)?.blob, revokedAtClick: revoked.includes(url),
    });
  };
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const fetchFixture = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), ORIGIN), init);
    const wire: Wire = { url: new URL(request.url), method: request.method, headers: request.headers, signal: request.signal };
    calls.push(wire);
    const path = wire.url.pathname;
    const base = `/api/v1/sites/${SLUG}`;
    if (wire.url.origin !== ORIGIN || wire.method !== "GET") {
      unexpected.push(`${wire.method} ${wire.url}`);
      return json({ error: { code: "unexpected_request", message: "Read-only fixture", hint: "Do not mutate." } }, 400);
    }
    if (path.endsWith("/export")) return options.response ? options.response(wire) : zipResponse();
    if (path === "/api/v1/me") return json({ principal: "member", scopes: ["sites:read", "sites:write"], member: { email: "fixture@example.com", role: "owner" } });
    if (path === base) return json({ site: {
      slug: SLUG, title: "ZIP fixture", description: "", currentVersionId: liveId, url: `https://files.test/${SLUG}/`,
      settings: { spa: false, renderMarkdown: true, crossOriginIsolation: false, passwordProtected: false },
    } });
    if (path === `${base}/versions`) return json({ versions: versions.filter(v => v.status === "ready"), currentVersionId: liveId });
    if (path.startsWith(`${base}/versions/`)) {
      const found = versions.find(v => v.id === decodeURIComponent(path.slice(`${base}/versions/`.length)));
      return found ? json({ site: SLUG, version: found, missing: [] }) : json({ error: { code: "version_not_found", message: "Version unavailable", hint: "Reload versions." } }, 404);
    }
    if (path === `${base}/files`) {
      const selected = versions.find(v => v.id === wire.url.searchParams.get("version")) ?? versions[0]!;
      const paths = options.files ?? ["alpha.txt", "beta.txt"];
      return json({ version: selected, total: paths.length, nextCursor: null, files: paths.map(path => ({
        path, size: 8, sha256: "a".repeat(64), contentType: "text/plain", kind: "text", extension: "txt",
        url: `https://files.test/${SLUG}/${path}`, rawUrl: `${base}/files/${path}`,
      })) });
    }
    unexpected.push(`${wire.method} ${wire.url}`);
    return json({ error: { code: "not_found", message: "Unexpected request", hint: "Use the existing version export route." } }, 404);
  };
  const requested = options.requested ?? OLD;
  const sandbox: Record<string, unknown> = {
    document: doc, localStorage: local, sessionStorage: session,
    location: { href: `${ORIGIN}/dashboard/sites/${SLUG}?version=${requested}`, pathname: `/dashboard/sites/${SLUG}`, search: `?version=${requested}`, replace() {} },
    history: { pushState() {}, replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: fetchFixture, Headers, Request, Response, URL: ObjectURL, URLSearchParams,
    Blob, ReadableStream, AbortController, AbortSignal, DOMException, Uint8Array, TextDecoder, TextEncoder,
    setTimeout, clearTimeout, console, queueMicrotask,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    alert: () => { throw Error("Errors must be visible in the dashboard, not alert()."); },
    prompt: () => null, confirm: () => false,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SCRIPT, sandbox, { filename: "served-dashboard.js" });
  await until(() => ["#files table", "#files .dw-error", "#files .dw-empty"].some(selector => doc.querySelector(selector) !== null), "real dashboard loaded fixture files");
  if (row.status !== "pending") {
    expect(doc.querySelector("#files")!.textContent, "fixture prerequisite: actual script rendered selected version")
      .toContain(options.files?.length === 0 ? "No files in this version" : "alpha.txt");
  }
  const initialCalls = calls.length;
  const view = {
    doc, row, calls, initialCalls, unexpected, created, revoked, downloads, session, local,
    exports: () => calls.filter(call => call.url.pathname.endsWith("/export")),
    rowElement: () => doc.querySelectorAll("tr").find(element => element.querySelectorAll("td").some(cell => new RegExp(`\\bv${row.number}\\b`).test(cell.textContent))),
    action: () => {
      const rowElement = view.rowElement();
      const inRow = rowElement?.querySelectorAll("button,a").find(element => /download zip/i.test(element.getAttribute("aria-label") ?? element.textContent));
      // Row or currently loaded detail are both valid; never silently select another row's action.
      const inDetail = requested === row.id ? doc.querySelector("#files")?.querySelectorAll("button,a").find(element => /download zip/i.test(element.getAttribute("aria-label") ?? element.textContent)) : undefined;
      const action = inRow ?? inDetail;
      expect(action, "a loaded immutable version needs a keyboard-accessible Download ZIP action").toBeDefined();
      return action!;
    },
  };
  return view;
}
export type View = Awaited<ReturnType<typeof mount>>;
export async function activate(view: View) {
  const action = view.action();
  expect(action.disabled, "eligible fixture action must be available").toBe(false);
  action.click();
  await tick();
  return action;
}
export function assertReadOnly(view: View) {
  expect(view.unexpected, "no public URLs, mutation endpoints or auxiliary byte fetches").toEqual([]);
  expect(view.calls.every(call => call.method === "GET")).toBe(true);
  for (const element of view.doc.querySelectorAll("*")) {
    for (const value of element.attrs.values()) expect(value).not.toMatch(/dw_disposable|dwc_|dwu_|dw_preview/);
  }
  for (const call of view.calls) expect(call.url.href).not.toMatch(/dw_disposable|dwc_|dwu_|dw_preview/);
}
export function visibleErrors(view: View): string {
  const visible = (element: FakeElement) => {
    for (let current: FakeElement | null = element; current; current = current.parentNode) if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
    return true;
  };
  return view.doc.querySelectorAll('.dw-error,[role="alert"],#dw-toasts').filter(visible).map(element => element.textContent).join("\n");
}
export async function expectRefusal(view: View, reason: RegExp) {
  await until(() => reason.test(visibleErrors(view)), `actionable visible error ${reason}`);
  expect(visibleErrors(view)).toMatch(/retry|try again|reload|sign in|log in|api|cli|upload|finaliz|choose|select|smaller|file.by.file/i);
  expect(view.downloads, "no partial/error attachment").toEqual([]);
  expect(view.created, "failed responses are never offered as object URLs").toEqual([]);
  expect(view.doc.querySelector("#dw-toasts")!.textContent, "no successful-download toast on an error").not.toMatch(/success|download(?:ed| (?:ready|complete))|saved/i);
  expect(view.action().disabled, "busy state restored on refusal").toBe(false);
  assertReadOnly(view);
}
