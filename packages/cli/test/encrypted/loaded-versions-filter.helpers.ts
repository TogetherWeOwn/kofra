/** Protected acceptance fixture. Only the Test Author may change this file. */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { expect } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
import { slug, base, id, artifact, allVersions, version, manifest } from "../../../server/test/loaded-versions-filter.fixtures.ts";
export { slug, base, id, artifact, markup } from "../../../server/test/loaded-versions-filter.fixtures.ts";
export type Wire = { method: string; path: string; query: string; body: string | null };
export type View = {
  context: BrowserContext; page: Page; wire: Wire[]; violations: string[]; errors: string[];
  dialogs: string[]; confirm: boolean; versions: ReturnType<typeof version>[];
};

export async function startHistoryFixture() {
  const work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "loaded-versions-"));
  const config = join(work, "wrangler.json");
  const persist = join(work, "state");
  const bootstrap = "loaded-versions-disposable-bootstrap-0123456789";
  let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
  let browser: Browser | undefined;
  const views: View[] = [];
  try {
    await writeFile(config, JSON.stringify({
      name: "dropway-loaded-versions-test", main: join(root, "apps/worker/src/index.ts"),
      compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
      vars: { APP_ORIGIN: "", SITES_MODE: "path", SITES_ORIGIN: "", SITES_DOMAIN: "", ANONYMOUS_PUBLISH: "false" },
      d1_databases: [{ binding: "DB", database_name: "loaded-versions-test", migrations_dir: join(root, "packages/core/migrations") }],
      r2_buckets: [{ binding: "FILES", bucket_name: "loaded-versions-test-files" }],
      kv_namespaces: [{ binding: "CACHE" }],
    }));
    await promisify(execFile)(process.execPath, [join(root, "node_modules/wrangler/bin/wrangler.js"),
      "d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persist], {
      cwd: root, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    });
    worker = await unstable_startWorker({
      config, dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
      bindings: { ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: bootstrap } },
    });
    await worker.ready;
    const origin = (await worker.url).origin;
    const api = async (path: string, body: unknown, key: string) => {
      const response = await fetch(origin + path, { method: "POST", headers: {
        Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      }, body: JSON.stringify(body) });
      expect(response.ok, `disposable fixture setup ${path}: ${response.status}`).toBe(true);
      return response.json() as Promise<any>;
    };
    const setup = await api("/api/v1/setup", { email: "history@example.test" }, bootstrap);
    const ownerKey: string = setup.apiKey.key;
    await api("/api/v1/sites", { slug }, ownerKey);
    const { chromium } = require("playwright");
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
    });

    const open = async (options: { linked?: number; empty?: boolean; narrow?: boolean } = {}) => {
      const context = await browser!.newContext({ serviceWorkers: "block",
        viewport: options.narrow ? { width: 360, height: 800 } : { width: 1100, height: 900 },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(2000);
      const view: View = { context, page, wire: [], violations: [], errors: [], dialogs: [], confirm: false,
        versions: options.empty ? [] : allVersions.map(row => ({ ...row })),
      };
      views.push(view);
      // Signing in lands on /dashboard, whose unchanged list page fetches the
      // account's sites once before this fixture navigates to the site page.
      // Permit exactly that bounded request during initial load only; once
      // open() returns it is again unexpected, so typing/clearing keep their
      // no-extra-request assertion (view.wire also records every request).
      let initialDashboardLoad = true;
      page.on("pageerror", error => view.errors.push(error.message));
      page.on("dialog", async dialog => {
        view.dialogs.push(dialog.message());
        if (view.confirm) await dialog.accept(); else await dialog.dismiss();
      });
      await context.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) {
          view.violations.push("off-origin request");
          return route.abort("blockedbyclient");
        }
        const wire = { method: request.method(), path: url.pathname, query: url.search, body: request.postData() };
        view.wire.push(wire);
        const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
        if (url.pathname === `${base}/versions`) {
          expect(request.method()).toBe("GET");
          if (url.searchParams.get("limit") !== "100" || [...url.searchParams.keys()].some(key => key !== "limit")) {
            view.violations.push(`history must remain one newest-100 page: ${url.search}`);
          }
          return json({ versions: view.versions.slice(0, 100), currentVersionId: options.empty ? null : id(105) });
        }
        if (url.pathname === `${base}/files`) {
          const selected = url.searchParams.get("version");
          const row = view.versions.find(row => row.id === (selected ?? id(105)));
          if (!row) return json({ error: { code: "version_not_found", message: "Unknown version", hint: "Choose an existing version." } }, 404);
          return json({ ...manifest(row.number), version: row });
        }
        const match = url.pathname.match(new RegExp(`^${base}/(?:versions|deploys)/([^/]+)(/restore)?$`));
        if (match) {
          const selected = decodeURIComponent(match[1]!);
          const row = view.versions.find(row => row.id === selected);
          if (!row) return json({ error: { code: "version_not_found", message: "Unknown version", hint: "Choose an existing version." } }, 404);
          if (request.method() === "GET" && !match[2]) return json({ site: slug, version: row, missing: [] });
          // No mutation ever reaches the Worker. Observe the shipped UI's exact
          // intent, then refuse: failure must not silently select another row.
          if ((request.method() === "POST" && match[2]) || request.method() === "DELETE") {
            return json({ error: { code: "fixture_refused", message: "Disposable action refused.", hint: "Keep the current selection." } }, 409);
          }
        }
        if (url.pathname === "/api/v1/sites") {
          if (!initialDashboardLoad || request.method() !== "GET"
            || url.searchParams.get("limit") !== "100"
            || [...url.searchParams.keys()].some(key => key !== "limit")) {
            view.violations.push(`unexpected request ${url.pathname}`);
            return route.abort("blockedbyclient");
          }
          return route.continue();
        }
        if (request.method() !== "GET") {
          view.violations.push(`unexpected mutation ${request.method()} ${url.pathname}`);
          return route.abort("blockedbyclient");
        }
        if (!["/login", "/dashboard", `/dashboard/sites/${slug}`, "/api/v1/me", base, "/favicon.ico"].includes(url.pathname)
          && !/^\/__dropway\/ui\/app-[a-f0-9]{8}\.js$/.test(url.pathname)) {
          view.violations.push(`unexpected request ${url.pathname}`);
          return route.abort("blockedbyclient");
        }
        return route.continue();
      });
      await page.goto(`${origin}/login`);
      await page.getByLabel(/api key/i).fill(ownerKey);
      await page.getByRole("button", { name: /^sign in$/i }).click();
      await page.waitForURL("**/dashboard");
      const linked = options.linked === undefined ? "" : `?version=${encodeURIComponent(id(options.linked))}`;
      const response = await page.goto(`${origin}/dashboard/sites/${slug}${linked}`, { waitUntil: "networkidle" });
      expect(response!.status()).toBe(200);
      expect(response!.headers()["content-security-policy"]).toContain("script-src 'self'");
      await expect.poll(() => view.wire.filter(call => call.path === `${base}/versions`).length).toBe(1);
      if (options.linked !== undefined) await expect.poll(() => page.locator("#files").innerText()).toContain(artifact(options.linked));
      initialDashboardLoad = false;
      return view;
    };
    return { open, closeViews: async () => {
      for (const view of views.splice(0)) {
        try {
          expect(view.violations, "no extra endpoints, pagination, remote filtering, or off-origin requests").toEqual([]);
          expect(view.errors, "the served dashboard must not throw").toEqual([]);
        } finally { await view.context.close(); }
      }
    }, dispose: async () => {
      await browser?.close(); await worker?.dispose(); await rm(work, { recursive: true, force: true });
    } };
  } catch (error) {
    await browser?.close(); await worker?.dispose(); await rm(work, { recursive: true, force: true });
    throw error;
  }
}

export const history = (view: View) => view.page.locator("section").filter({ has: view.page.getByRole("heading", { name: /^versions$/i }) });
export const filter = (view: View) => history(view).getByLabel("Filter loaded versions", { exact: true });
export const clear = (view: View) => history(view).getByRole("button", { name: /^clear$/i });
export const row = (view: View, number: number) => history(view).getByRole("row").filter({ hasText: new RegExp(`\\bv${number}\\b`) });
export const rows = (view: View) => history(view).locator("tbody tr:visible");
export async function numbers(view: View) {
  return rows(view).evaluateAll(elements => elements.map(element => Number(element.textContent!.match(/\bv(\d+)\b/)![1])));
}
export async function flush(view: View) {
  await view.page.evaluate(() => new Promise<void>(resolve => {
    const frame = (globalThis as any).requestAnimationFrame;
    frame(() => frame(() => resolve()));
  }));
  // Longer than the UI's normal local-filter debounce; not a CI polling loop.
  await view.page.waitForTimeout(300);
}
export async function state(view: View) {
  return view.page.evaluate(async () => {
    const g = globalThis as any;
    const hash = async (storage: any) => {
      const entries = Object.keys(storage).sort().map(key => [key, storage.getItem(key)]);
      const bytes = new TextEncoder().encode(JSON.stringify(entries));
      return Array.from(new Uint8Array(await g.crypto.subtle.digest("SHA-256", bytes))).join(",");
    };
    return {
      url: g.location.href, historyLength: g.history.length, historyState: JSON.stringify(g.history.state),
      files: g.document.querySelector("#files")?.innerText ?? "",
      local: await hash(g.localStorage), session: await hash(g.sessionStorage),
    };
  });
}
