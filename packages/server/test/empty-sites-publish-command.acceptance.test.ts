/**
 * Empty dashboard first-run: a copyable CLI publish command pre-filled with
 * this instance's origin, the browser-publish link and the /connect link, with
 * the sites search/filter hidden until at least one site exists.
 *
 * Runs the real served CLIENT_SCRIPT in the Node VM/DOM harness (same doubles
 * as the loaded-versions and expiry suites); no source-string assertions.
 * Run: npm run test:browser-code -- empty-sites-publish-command
 */
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLIENT_SCRIPT } from "../src/ui/assets.ts";
import { FakeDocument, FakeElement, isHidden } from "./loaded-versions-filter.dom.ts";

const ORIGIN = "https://dashboard.example.test";
const COMMAND = `npx kofra publish ./my-folder --api ${ORIGIN}`;

function siteRow() {
  return {
    id: "site-first", slug: "first-site", title: "", description: "",
    url: "https://first-site.example.test/", expiresAt: null,
    createdAt: "2026-10-26T11:00:00.000Z", updatedAt: "2026-10-26T11:30:00.000Z",
    currentVersion: null, currentVersionId: null,
    settings: { spa: false, renderMarkdown: true, crossOriginIsolation: false, passwordProtected: false },
  };
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function waitFor(predicate: () => boolean, detail: string) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000) throw new Error(`Timed out: ${detail}`);
    await tick();
  }
  await tick();
  await tick();
}

async function mount(options: { sites?: ReturnType<typeof siteRow>[] } = {}) {
  const sites = options.sites ?? [];
  const doc = new FakeDocument();
  doc.body.setAttribute("data-page", "sites");
  for (const id of ["dw-boot", "dw-account", "dw-sites", "dw-sites-count", "dw-toasts"]) {
    const element = doc.createElement(id === "dw-boot" ? "script" : "div");
    element.id = id;
    if (id === "dw-boot") {
      element.textContent = JSON.stringify({ v: 1,
        origin: ORIGIN, instanceName: "Empty fixture", api: "/api/v1",
        sitesMode: "path", anonymousPublish: false, session: null, page: { name: "sites" } });
    }
    doc.body.appendChild(element);
  }
  const values = new Map([["dropway.key", "dw_disposable_fixture"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      if (key !== "dropway.me") throw new Error("Rendering must not write credentials");
      values.set(key, String(value));
    },
    removeItem() { throw new Error("Rendering must not remove credentials"); } };
  const calls: string[] = [];
  const clipboard: string[] = [];
  // A sink catches HTML string insertion; normal h()/createTextNode remain real
  // within this repo's DOM subset. Never transform or extract client functions.
  Object.defineProperty(FakeElement.prototype, "innerHTML", {
    configurable: true, set() { throw new Error("The dashboard must not use innerHTML"); },
  });
  const location = { href: `${ORIGIN}/dashboard`, pathname: "/dashboard", search: "",
    replace(url: string) { this.href = new URL(url, this.href).href; } };
  const sandbox: Record<string, unknown> = {
    document: doc, sessionStorage: storage, localStorage: { ...storage, getItem: () => null },
    location,
    history: { pushState() {}, replaceState() {} },
    navigator: { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } },
    crypto: webcrypto, URL, URLSearchParams, Headers, Blob, console,
    setTimeout, clearTimeout,
    setInterval() { throw new Error("The sites list must not poll"); },
    clearInterval() {},
    requestAnimationFrame() { throw new Error("The sites list must not animate"); },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    fetch: async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(String(url), ORIGIN);
      calls.push(parsed.pathname + parsed.search);
      if ((init.method ?? "GET") !== "GET" || parsed.origin !== ORIGIN) {
        throw new Error(`Unexpected mutation or off-origin request: ${init.method} ${parsed.href}`);
      }
      if (parsed.pathname === "/api/v1/me") {
        return new Response(JSON.stringify({ principal: "member",
          scopes: ["sites:read", "sites:write", "sites:delete", "keys:write"],
          siteRestriction: null, member: { id: "member-fixture", email: "owner@example.test", role: "owner" } }),
        { headers: { "Content-Type": "application/json" } });
      }
      if (parsed.pathname === "/api/v1/sites") {
        return new Response(JSON.stringify({ sites, nextCursor: null }),
          { headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected fixture request: ${parsed.pathname}`);
    },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(CLIENT_SCRIPT, context, { filename: "served-dashboard.js" });
  await waitFor(
    () => (doc.getElementById("dw-sites-count")?.textContent ?? "").length > 0
      && doc.getElementById("dw-sites-count")?.textContent !== "Loading…",
    "the served script must finish the sites list",
  );
  return { doc, calls, clipboard };
}

describe("empty dashboard publish command", () => {
  it("shows the copyable CLI command, both links, and hides the search with zero sites", async () => {
    const view = await mount({ sites: [] });
    const root = view.doc.getElementById("dw-sites")!;

    expect(view.doc.getElementById("dw-sites-count")!.textContent).toBe("No sites yet.");
    expect(root.querySelector("h3")?.textContent).toBe("No sites yet");
    expect(root.textContent).toContain("Publish your first folder from a terminal:");

    const code = root.querySelectorAll("code").find(el => el.textContent.startsWith("npx kofra publish"));
    expect(code?.textContent).toBe(COMMAND);

    const copy = root.querySelectorAll("button").find(el => el.getAttribute("aria-label") === "Copy publish command");
    expect(copy, "Copy button needs the accessible name").toBeDefined();
    expect(copy!.textContent).toBe("Copy");
    copy!.click();
    await waitFor(() => view.clipboard.length > 0, "Copy must write the command");
    expect(view.clipboard).toEqual([COMMAND]);
    expect(copy!.textContent).toBe("Copied");

    const browserLink = root.querySelectorAll("a").find(el => el.textContent === "publish from this browser");
    expect(browserLink?.getAttribute("href")).toBe("/dashboard/publish");
    const connectLink = root.querySelectorAll("a").find(el => el.textContent === "Connect one");
    expect(connectLink?.getAttribute("href")).toBe("/connect");
    expect(root.textContent).toContain("Publishing with an AI agent instead?");

    const search = view.doc.querySelector('input[aria-label="Filter loaded sites"]')!;
    expect(search, "the filter input stays mounted").toBeDefined();
    expect(isHidden(search), "the filter stays hidden with zero sites").toBe(true);
    expect(root.querySelector("table"), "no table with zero sites").toBeNull();
    expect([...view.calls].sort()).toEqual(["/api/v1/me", "/api/v1/sites?limit=100"]);
  });

  it("restores the search, list and count with at least one site", async () => {
    const view = await mount({ sites: [siteRow()] });
    const root = view.doc.getElementById("dw-sites")!;

    expect(view.doc.getElementById("dw-sites-count")!.textContent).toBe("1 site.");
    const search = view.doc.querySelector('input[aria-label="Filter loaded sites"]')!;
    expect(isHidden(search), "the filter shows with a site").toBe(false);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(root.textContent).not.toContain("No sites yet");
    expect(root.textContent).not.toContain("npx kofra publish");
  });
});
