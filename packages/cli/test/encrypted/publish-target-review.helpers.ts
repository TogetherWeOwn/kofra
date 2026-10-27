import { expect } from "vitest";
import {
  deferred, publishAndWaitForFinalize, publishButton, settle, writes,
} from "./publish-target.helpers.ts";
import type { Fixture, TargetWorld } from "./publish-target.helpers.ts";

/**
 * Opt-in mutation proof against the actual served script, never a source write.
 * Use PUBLISH_TARGET_GUARD_MUTANT=submit|focus|input-disabled|malformed on the
 * reviewed head only. An absent/non-unique anchor is a harness error, not proof.
 * Each run disables exactly ONE guard; ordinary acceptance runs alter no bytes.
 */
export function installServedGuardMutant(world: TargetWorld) {
  const mutant = process.env.PUBLISH_TARGET_GUARD_MUTANT;
  if (!mutant) return;
  const patches: Record<string, [string | RegExp, string]> = {
    submit: ["if (!anonymous && modeUpd.checked && destUnresolved()) return;", ""],
    focus: [/(slugInput\.addEventListener\("focus", function\s*\(\)\s*\{\s*modeNew\.checked = true;\s*)invalidateDest\(\);/g, "$1"],
    "input-disabled": ["lookupInput.disabled = on;", ""],
    malformed: ["if (!site || !site.slug)", "if (false)"],
  };
  const patch = patches[mutant];
  if (!patch) throw new Error("Unknown publisher guard mutant: " + mutant);
  const newContext = world.browser.newContext.bind(world.browser);
  world.browser.newContext = async (...args: any[]) => {
    const context = await newContext(...args);
    const newPage = context.newPage.bind(context);
    context.newPage = async (...pageArgs: any[]) => {
      const page = await newPage(...pageArgs);
      await page.route("**/__dropway/ui/app-*.js", async (route: any) => {
        const response = await route.fetch();
        const script = await response.text();
        const matches = typeof patch[0] === "string" ? script.split(patch[0]).length - 1 : [...script.matchAll(patch[0])].length;
        expect(matches, `mutant ${mutant} must change one unique served-script guard`).toBe(1);
        await route.fulfill({ response, body: script.replace(patch[0], patch[1]) });
      });
      return page;
    };
    return context;
  };
}

/** Supplemental-only utilities layered on the shared protected driver. */
export const lookupButton = (f: Fixture) => f.page.getByRole("button", { name: /look\s*up|find|resolve|load site/i });
export const feedback = (f: Fixture) => f.page.locator('#dw-publish [role="alert"]');
export const announcements = (f: Fixture) => f.page.locator('#dw-publish [role="status"], #dw-publish [aria-live]');

export async function lookupAlert(f: Fixture) {
  await expect.poll(() => feedback(f).innerText(), { message: "lookup failure has an actionable alert" })
    .toMatch(/not found|unavailable|could not|couldn't|failed|unable|refused|error|forbidden|invalid/i);
  expect(await feedback(f).innerText()).toMatch(/retry|try again|slug|check|choose|look\s*up/i);
  expect(await publishButton(f).isDisabled()).toBe(true);
  expect(writes(f)).toEqual([]);
}

/** Native .click() suppresses disabled buttons: dispatch invokes the real listener. */
export async function forcedPublishIsInert(f: Fixture) {
  expect(await publishButton(f).isDisabled()).toBe(true);
  const observed = await publishButton(f).evaluate(async (button: any) => {
    const root = button.closest("#dw-publish");
    const before = root.innerText;
    const changes: string[] = [];
    const Observer = (globalThis as any).MutationObserver;
    const observer = new Observer((records: any[]) => changes.push(...records.map(r => r.type + ":" + (r.attributeName ?? "content"))));
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["disabled", "aria-busy", "hidden", "style"] });
    button.dispatchEvent(new (globalThis as any).MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise<void>(done => (globalThis as any).requestAnimationFrame(() => (globalThis as any).requestAnimationFrame(done)));
    observer.disconnect();
    return { before, after: root.innerText, changes };
  });
  expect(observed.changes, "unresolved submit returns BEFORE progress, busy toggles or publish-error DOM work").toEqual([]);
  expect(observed.after).toBe(observed.before);
  await settle(f);
  expect(writes(f), "forced dispatch must never create, upload or finalize").toEqual([]);
}

export async function finishPublish(f: Fixture, origin: string, slug: string, create = false) {
  expect((await publishAndWaitForFinalize(f, slug)).status()).toBe(200);
  await expect.poll(() => f.page.locator(`#dw-publish a[href="${origin}/s/${slug}/"]`).count()).toBeGreaterThan(0);
  const mutations = writes(f);
  expect(mutations.filter(r => r.method === "POST" && r.path === "/api/v1/sites")).toHaveLength(create ? 1 : 0);
  if (create) expect(mutations.find(r => r.method === "POST" && r.path === "/api/v1/sites")!.body.slug).toBe(slug);
  expect(mutations.filter(r => r.path === "/api/v1/publish")).toEqual([]);
  expect(mutations.filter(r => r.path.endsWith("/deploys")).map(r => r.path)).toEqual([`/api/v1/sites/${slug}/deploys`]);
  expect(mutations.filter(r => r.path.includes("/sites/")).every(r => r.path.startsWith(`/api/v1/sites/${slug}/`))).toBe(true);
  const raw = await fetch(`${origin}/s/${slug}/index.html?raw=1`);
  expect(raw.status).toBe(200);
  expect(await raw.text()).toBe("<h1>Disposable update destination</h1>\n");
}

export function observeDestinationReads(f: Fixture) {
  const reads: string[] = [];
  f.page.on("request", (request: any) => {
    const url = new URL(request.url());
    if (request.method() !== "GET") return;
    if ((url.pathname.startsWith("/api/v1/sites") && !(url.pathname === "/api/v1/sites" && url.search === "?limit=200"))
      || url.pathname === "/api/v1" || url.pathname === "/api/v1/") reads.push(url.pathname + url.search);
  });
  return reads;
}

/** Catch normalized dot endpoints before the protected driver's list validator. */
export async function trapDotEndpoints(f: Fixture) {
  await f.page.route("**/api/**", async (route: any) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && ((["/api/v1/sites", "/api/v1/sites/"].includes(url.pathname) && !url.search)
      || url.pathname === "/api/v1" || url.pathname === "/api/v1/")) {
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: {
        code: "invalid_destination", message: "Invalid destination slug.", hint: "Check the slug and try again.",
      } }) });
    }
    return route.fallback();
  });
}

export async function holdPublishPhase(f: Fixture, phase: "manifest" | "upload" | "finalize", fail: boolean) {
  const gate = { ...deferred(), entered: false };
  f.gates.push(gate);
  await f.page.route("**/api/**", async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    const match = phase === "manifest" ? request.method() === "POST" && url.pathname.endsWith("/deploys")
      : phase === "upload" ? request.method() === "PUT"
      : request.method() === "POST" && url.pathname.endsWith("/finalize");
    if (!match) return route.fallback();
    gate.entered = true;
    await gate.promise;
    if (!fail) {
      try { return await route.fallback(); }
      catch { return; /* Failed-test teardown can cancel a held request. */ }
    }
    let body: any = request.postData();
    try { body = JSON.parse(body); } catch { /* Uploads contain raw bytes. */ }
    f.wire.push({ method: request.method(), path: url.pathname, query: url.search, body,
      authenticated: !!request.headers().authorization });
    try {
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: {
        code: "invalid_publish_fixture", message: "Disposable publish phase failed.", hint: "Try again.",
      } }) });
    } finally { gate.delivered = true; }
  });
  return gate;
}
