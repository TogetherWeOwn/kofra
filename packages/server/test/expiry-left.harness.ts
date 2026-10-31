/** Protected test-only harness for the unmodified, actually served client bytes. */
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { CLIENT_SCRIPT } from "../src/ui/assets.ts";
import { FakeDocument, FakeElement } from "./loaded-versions-filter.dom.ts";
import { now, paths, reply, roots, slug, type Surface } from "./expiry-left.fixtures.ts";

export async function settle() {
  for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve));
}
export async function mount(surface: Surface, expiresAt?: string | null) {
  const doc = new FakeDocument();
  doc.body.setAttribute("data-page", surface);
  for (const id of ["dw-boot", "dw-account", roots[surface], "dw-sites-count", "dw-toasts"]) {
    const element = doc.createElement(id === "dw-boot" ? "script" : "div");
    element.id = id;
    if (id === "dw-boot") element.textContent = JSON.stringify({ v: 1,
      origin: "https://dashboard.example.test", instanceName: "Expiry fixture", api: "/api/v1",
      sitesMode: "path", anonymousPublish: false, session: null, page: { name: surface, slug } });
    doc.body.appendChild(element);
  }
  const values = new Map([["dropway.key", "dw_disposable_fixture"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      if (key !== "dropway.me") throw Error("Rendering must not write credentials");
      values.set(key, String(value));
    },
    removeItem() { throw Error("Rendering must not remove credentials"); } };
  const calls: string[] = [];
  const timers: string[] = [];
  const violations: string[] = [];
  // A sink catches HTML string insertion; normal h()/createTextNode remain real
  // within this repo's DOM subset. Never transform or extract client functions.
  Object.defineProperty(FakeElement.prototype, "innerHTML", {
    configurable: true, set() { throw Error("The dashboard must not use innerHTML"); },
  });
  const sandbox: Record<string, unknown> = {
    document: doc, sessionStorage: storage, localStorage: { ...storage, getItem: () => null },
    location: { href: `https://dashboard.example.test${paths[surface]}`, pathname: paths[surface], search: "" },
    history: { pushState() { throw Error("Expiry rendering must not navigate"); }, replaceState() {} },
    navigator: { clipboard: { writeText() { throw Error("Expiry rendering must not copy"); } } },
    crypto: webcrypto, URL, URLSearchParams, Headers, Blob, console,
    setTimeout() { timers.push("timeout"); return timers.length; }, clearTimeout() {},
    setInterval() { timers.push("interval"); return timers.length; }, clearInterval() {},
    requestAnimationFrame() { timers.push("frame"); return timers.length; },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    fetch: async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(String(url), "https://dashboard.example.test");
      calls.push(parsed.pathname + parsed.search);
      if ((init.method ?? "GET") !== "GET" || parsed.origin !== "https://dashboard.example.test") {
        violations.push(`${init.method} ${parsed.href}`);
        throw Error("Unexpected mutation or off-origin request");
      }
      return new Response(JSON.stringify(reply(parsed.pathname, expiresAt)), { headers: { "Content-Type": "application/json" } });
    },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(`Date = class extends Date {
    constructor(value) { super(arguments.length ? value : ${now}); }
    static now() { return ${now}; }
  };`, context);
  vm.runInContext(CLIENT_SCRIPT, context, { filename: "served-dashboard.js" });
  await settle();
  const root = doc.getElementById(roots[surface])!;
  const region = () => surface === "site" ? root.querySelector(".dw-pagehead")! : root.querySelector("tbody tr")!;
  const expiry = () => surface === "sites"
    ? region().querySelectorAll(".dw-badge").find(el => /^(Expires|Expired)\b/.test(el.textContent))
    : surface === "keys" ? region().querySelectorAll("td")[3] : region();
  return { doc, root, region, expiry, calls, timers, violations,
    advance: async () => { vm.runInContext(`Date.now = () => ${now + 2 * 86_400_000}`, context); await settle(); } };
}
