/** Protected served-artifact VM harness; API and DOM are disposable test doubles. */
import vm from "node:vm";
import { expect } from "vitest";
import { CLIENT_SCRIPT } from "../src/ui/assets.ts";
import { FakeDocument, FakeElement, isHidden } from "./loaded-versions-filter.dom.ts";
import { allVersions, artifact, base, id, manifest, slug } from "./loaded-versions-filter.fixtures.ts";

export const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
export async function waitFor(predicate: () => boolean, detail: string) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000) throw Error(`Timed out: ${detail}`);
    await tick();
  }
  await tick();
}
export async function settle() { await tick(); await tick(); }

class Storage {
  values = new Map<string, string>();
  writes: string[] = [];
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); this.writes.push("set"); }
  removeItem(key: string) { this.values.delete(key); this.writes.push("remove"); }
}
class TestURL extends URL {
  static createObjectURL() { return "blob:disposable"; }
  static revokeObjectURL() {}
}
export async function mount(options: { linked?: number; empty?: boolean } = {}) {
  const doc = new FakeDocument();
  doc.body.setAttribute("data-page", "site");
  for (const name of ["dw-boot", "dw-account", "dw-site", "dw-toasts"]) {
    const element = doc.createElement(name === "dw-boot" ? "script" : "div");
    element.id = name;
    if (name === "dw-boot") element.textContent = JSON.stringify({
      v: 1, origin: "https://dashboard.example.test/", instanceName: "Fixture", api: "/api/v1",
      sitesMode: "path", anonymousPublish: false, session: null, page: { name: "site", slug },
    });
    doc.body.appendChild(element);
  }
  const local = new Storage();
  const session = new Storage();
  session.values.set("dropway.key", "dw_disposable_fixture");
  const calls: { method: string; path: string; query: string; body: unknown }[] = [];
  const dialogs: string[] = [];
  const violations: string[] = [];
  const clipboard: string[] = [];
  const versions = options.empty ? [] : allVersions.map(row => ({ ...row }));
  const initial = `https://dashboard.example.test/dashboard/sites/${slug}${options.linked === undefined ? "" : `?version=${id(options.linked)}`}`;
  const location = { href: initial, pathname: new URL(initial).pathname, search: new URL(initial).search,
    replace(url: string) { this.href = new URL(url, this.href).href; },
  };
  const historyCalls: string[] = [];
  const recordHistory = (_state: unknown, _title: string, url: string) => {
    historyCalls.push(url); const parsed = new URL(url, location.href);
    location.href = parsed.href; location.pathname = parsed.pathname; location.search = parsed.search;
  };
  const control = { confirm: false };
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const sandbox: Record<string, unknown> = {
    document: doc, localStorage: local, sessionStorage: session, location,
    history: { pushState: recordHistory, replaceState: recordHistory },
    navigator: { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } },
    confirm: (message: string) => { dialogs.push(message); return control.confirm; },
    alert: (message: string) => { dialogs.push(message); },
    fetch: async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(String(url), location.href);
      const method = init.method ?? "GET";
      calls.push({ method, path: parsed.pathname, query: parsed.search, body: init.body ?? null });
      if (parsed.pathname === "/api/v1/me") return response({ principal: "member", scopes: ["sites:read", "sites:write", "sites:delete"], member: { email: "history@example.test", role: "owner" } });
      if (parsed.pathname === base) return response({ site: { slug, title: "History fixture", description: "", url: "https://files.example.test/history/",
        currentVersionId: options.empty ? null : id(105), settings: { spa: false, renderMarkdown: true, crossOriginIsolation: false, passwordProtected: false } } });
      if (parsed.pathname === `${base}/versions`) {
        if (parsed.searchParams.get("limit") !== "100" || [...parsed.searchParams.keys()].some(key => key !== "limit")) violations.push(`unbounded or remote history query: ${parsed.search}`);
        return response({ versions: versions.slice(0, 100), currentVersionId: options.empty ? null : id(105) });
      }
      if (parsed.pathname === `${base}/files`) {
        const selected = parsed.searchParams.get("version") ?? id(105);
        const row = versions.find(row => row.id === selected);
        return row ? response(manifest(row.number)) : response({ error: { code: "version_not_found", message: "Unknown version", hint: "Choose another version." } }, 404);
      }
      const match = parsed.pathname.match(new RegExp(`^${base}/(?:versions|deploys)/([^/]+)(/restore)?$`));
      if (match) {
        const row = versions.find(row => row.id === decodeURIComponent(match[1]!));
        if (row && method === "GET") return response({ site: slug, version: row, missing: [] });
        if (row && (method === "POST" || method === "DELETE")) return response({ error: {
          code: "fixture_refused", message: "Disposable action refused.", hint: "Keep the current selection.",
        } }, 409);
      }
      violations.push(`unexpected ${method} ${parsed.pathname}`);
      return response({ error: { code: "not_found", message: "Unexpected fixture request", hint: "Use the loaded data." } }, 404);
    },
    Headers, URL: TestURL, URLSearchParams, Blob, setTimeout, clearTimeout, console,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SCRIPT, sandbox, { filename: "served-dashboard.js" });
  await waitFor(() => doc.querySelectorAll("h2,h3").some(el => el.textContent === "Versions"), "served script must render Versions");
  if (options.linked !== undefined) await waitFor(() => doc.querySelector("#files")?.textContent.includes(artifact(options.linked!)) ?? false, "direct version's files must render");
  await settle();
  const heading = doc.querySelectorAll("h2,h3").find(el => el.textContent === "Versions")!;
  let section: FakeElement = heading;
  while (section.parentNode && section.tag !== "section") section = section.parentNode;
  const visibleRows = () => section.querySelectorAll("tbody tr").filter(row => !isHidden(row));
  const numbers = () => visibleRows().map(row => Number(row.textContent.match(/\bv(\d+)\b/)![1]));
  const button = (rowNumber: number, label: string) => {
    const row = visibleRows().find(row => new RegExp(`\\bv${rowNumber}\\b`).test(row.textContent));
    const found = row?.querySelectorAll("button").find(button => button.textContent === label);
    expect(found, `${label} button for v${rowNumber}`).toBeDefined();
    return found!;
  };
  const snapshot = () => ({ files: doc.querySelector("#files")?.textContent, href: location.href,
    history: [...historyCalls], local: [...local.values], session: [...session.values],
    localWrites: [...local.writes], sessionWrites: [...session.writes], clipboard: [...clipboard],
  });
  return { doc, section, calls, dialogs, violations, control, visibleRows, numbers, button, snapshot };
}
export type Mounted = Awaited<ReturnType<typeof mount>>;
export function filter(m: Mounted) {
  const candidates = m.section.querySelectorAll("input").filter(input => {
    if (input.getAttribute("aria-label") === "Filter loaded versions") return true;
    return m.section.querySelectorAll("label").some(label => label.textContent === "Filter loaded versions" &&
      (label.getAttribute("for") === input.id && input.id !== "" || label.querySelectorAll("input").includes(input)));
  });
  expect(candidates, "Versions must expose the labelled Filter loaded versions input").toHaveLength(1);
  return candidates[0]!;
}
export function clear(m: Mounted) {
  const button = m.section.querySelectorAll("button").find(button => button.textContent === "Clear");
  expect(button, "Versions needs an accessible Clear button").toBeDefined();
  return button!;
}
export async function query(m: Mounted, value: string) {
  const input = filter(m); input.focus(); input.value = value; input.dispatch("input"); await settle();
}
