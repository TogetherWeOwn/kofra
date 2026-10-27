/**
 * PROTECTED acceptance handoff: consume this file AND publish-target.helpers.ts
 * unchanged in the paired build. No implementation source/diff was consulted.
 *
 * Run from repo root:
 *   npm ci --include=dev
 *   npm ci --prefix packages/cli/test/encrypted --include=dev
 *   packages/cli/test/encrypted/node_modules/.bin/playwright install --with-deps chromium
 *   npm run test:browser-code -- test/publish-target.acceptance.test.ts
 *   npm run check
 *
 * Fixtures/reset: each test gets a temporary local Worker, actual migrations +
 * isolated D1/R2/KV, synthetic setup principal and 203 live sites plus one deleted
 * fixture. A publish cannot move another test's old target into its first page.
 * Worker, browser, gates and temporary storage are disposed in teardown; rerun to
 * reset. Never point this suite at a remote instance. Only HTTP timing/errors are
 * controlled; list, lookup, manifest, upload and finalize use the actual Worker.
 *
 * RED is a missing bounded lookup/selection or fail-closed assertion, NOT a
 * fixture/bootstrap/Chromium failure. The independent passing controls prove
 * served-script execution and existing publishing, raw identity and CSP.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TargetWorld, alternate, chooseFiles, deferred, failedClosed, listed, listReads,
  lookup, lookupInput, older, publishAndWaitForFinalize, publishButton, publishProtocolTimeout, resolved, selector, settle,
  singleReads, updateMode, writes,
} from "../../cli/test/encrypted/publish-target.helpers.ts";
import type { Fixture } from "../../cli/test/encrypted/publish-target.helpers.ts";

const world = new TargetWorld();
beforeEach(() => world.start(), 120_000);
afterEach(async () => {
  try { await world.closeFixtures(); } finally { await world.stop(); }
}, 30_000);

async function published(f: Fixture, slug: string) {
  expect((await publishAndWaitForFinalize(f, slug)).status()).toBe(200);
  await expect.poll(() => f.page.locator(`#dw-publish a[href="${world.origin}/s/${slug}/"]`).count(), {
    message: "the finalized destination is rendered in the publisher receipt",
  }).toBeGreaterThan(0);
  const mutations = writes(f);
  expect(mutations.some(r => r.path === "/api/v1/sites" || r.path === "/api/v1/publish"), "no create-site or one-shot fallback for a manifest update").toBe(false);
  expect(mutations.filter(r => r.method === "POST" && r.path.endsWith("/deploys")).map(r => r.path)).toEqual([`/api/v1/sites/${slug}/deploys`]);
  expect(mutations.filter(r => r.path.includes("/sites/")).every(r => r.path.startsWith(`/api/v1/sites/${slug}/`))).toBe(true);
  const manifest = mutations.find(r => r.path.endsWith("/deploys"))!.body;
  expect(manifest.files.map((file: any) => ({ path: file.path, size: file.size })).sort((a: any, b: any) => a.path.localeCompare(b.path))).toEqual([
    { path: "index.html", size: 39 }, { path: "readme.txt", size: 26 },
  ]);
}

// Break: silently picking the first listed site instead of independently verifying
// a nonempty explicit target, or sweeping all pages to find it.
describe("Publish update: destination beyond the first 200 sites", () => {
  it("resolves the explicit target once independently of a completed first page", async () => {
    const f = await world.open({ target: older });
    await expect.poll(() => singleReads(f).map(r => r.path), { message: "explicit target uses the existing single-site GET" }).toEqual([`/api/v1/sites/${older}`]);
    await resolved(f, older);
    expect(listReads(f)).toHaveLength(1);
    expect(singleReads(f)[0]!.authenticated).toBe(true);
    expect(await f.page.locator('#dw-publish input[value="update"]').isChecked()).toBe(true);
    expect(await publishButton(f).isDisabled(), "resolving a destination does not invent a file selection").toBe(true);
  });

  it("verifies an explicit first-page target too, without duplicating its option", async () => {
    const f = await world.open({ target: listed });
    await expect.poll(() => singleReads(f).map(r => r.path)).toEqual([`/api/v1/sites/${listed}`]);
    await resolved(f, listed);
    expect(listReads(f)).toHaveLength(1);
  });

  // Break: the initial list completion drops an already verified absent option.
  it("retains a resolved explicit target when the initial list arrives later", async () => {
    const gate = deferred();
    const f = await world.open({ target: older, listGate: gate });
    await expect.poll(() => singleReads(f).length, { message: "lookup must not wait for list loading" }).toBe(1);
    await resolved(f, older);
    gate.resolve();
    await expect.poll(() => selector(f).locator("option").count()).toBeGreaterThanOrEqual(200);
    await resolved(f, older);
    expect(singleReads(f)).toHaveLength(1);
  });

  // Break: a first-page default becomes publishable before explicit verification.
  it("keeps Publish disabled while the explicit target waits behind a loaded list", async () => {
    const gate = deferred();
    const f = await world.open({ target: older, lookups: new Map([[`/api/v1/sites/${older}`, gate]]) });
    await expect.poll(() => selector(f).locator(`option[value="${listed}"]`).count()).toBe(1);
    await chooseFiles(f);
    await expect.poll(() => singleReads(f).length).toBe(1);
    expect(await publishButton(f).isDisabled()).toBe(true);
    expect(await f.page.locator('#dw-publish [role="status"], #dw-publish [aria-live]').allTextContents()).toEqual(expect.arrayContaining([expect.stringMatching(/look|load|resolv/i)]));
    gate.resolve();
    await resolved(f, older);
    expect(await publishButton(f).isEnabled()).toBe(true);
  });

  // Break: successful publish refresh reverts to the list default or adds duplicates.
  it("publishes only to the verified slug and retains it through successful refresh", async () => {
    const f = await world.open({ target: older });
    await expect.poll(() => singleReads(f).length).toBe(1);
    await resolved(f, older);
    await expect.poll(() => selector(f).locator(`option[value="${listed}"]`).count()).toBe(1);
    // Replay the real pre-publish first page on refresh. A competing update or
    // stale list response can keep the selected destination outside that page;
    // merely resetting to the newest row must not accidentally pass this test.
    f.results.set("/api/v1/sites", await world.request("/sites?limit=200"));
    await chooseFiles(f);
    const [refresh] = await Promise.all([
      f.page.waitForResponse((r: any) => r.request().method() === "GET"
        && new URL(r.url()).pathname === "/api/v1/sites", { timeout: publishProtocolTimeout }),
      published(f, older),
    ]);
    await refresh.finished();
    await settle(f);
    await resolved(f, older);
    expect(singleReads(f).every(r => r.path === `/api/v1/sites/${older}`)).toBe(true);
    expect(listReads(f).length).toBeLessThanOrEqual(2);
    const raw = await fetch(`${world.origin}/s/${older}/index.html?raw=1`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("<h1>Disposable update destination</h1>\n");
  });

  // Break: typing fires a remote search, or Enter triggers Publish instead of lookup.
  it("looks up a manually entered slug only on submit, with Enter and a button", async () => {
    const f = await world.open();
    await updateMode(f);
    await chooseFiles(f);
    const input = await lookupInput(f);
    await f.page.clock.install();
    await input.fill(older);
    await f.page.clock.runFor(5000);
    expect(singleReads(f)).toEqual([]);
    expect(writes(f)).toEqual([]);
    await input.press("Enter");
    await resolved(f, older);
    expect(singleReads(f).map(r => r.path)).toEqual([`/api/v1/sites/${older}`]);
    expect(writes(f)).toEqual([]);
    await lookup(f, alternate, "button");
    await resolved(f, alternate);
    expect(singleReads(f).map(r => r.path)).toEqual([`/api/v1/sites/${older}`, `/api/v1/sites/${alternate}`]);
    expect(writes(f)).toEqual([]);
  });

  // Break: deploying to the unverified input rather than the returned stable slug.
  it("uses the returned canonical slug for selection and the deploy request", async () => {
    const f = await world.open();
    await updateMode(f);
    // A controlled single-site response retains the complete real API envelope.
    // The response is authoritative, not the manually entered reference string.
    f.results.set("/api/v1/sites/requested-reference", await world.request(`/sites/${older}`));
    await lookup(f, "requested-reference");
    await resolved(f, older);
    await chooseFiles(f);
    await published(f, older);
    expect(singleReads(f).map(r => r.path)).toEqual(["/api/v1/sites/requested-reference"]);
  });

  // Break: stale success OR error overwrites the newer verified explicit choice.
  for (const staleStatus of [200, 404]) {
    it(`ignores an older ${staleStatus} lookup after a newer explicit choice resolves`, async () => {
      const gate = deferred();
      const f = await world.open({ lookups: new Map([[`/api/v1/sites/${older}`, gate]]) });
      await updateMode(f);
      if (staleStatus !== 200) f.failures.set(`/api/v1/sites/${older}`, staleStatus);
      await lookup(f, older);
      await expect.poll(() => singleReads(f).length).toBe(1);
      await lookup(f, alternate);
      await resolved(f, alternate);
      gate.resolve();
      await expect.poll(() => gate.delivered, { message: "stale response reached the browser or was cancelled" }).toBe(true);
      await settle(f);
      await resolved(f, alternate);
      await chooseFiles(f);
      await published(f, alternate);
    });
  }

  it("does not rescue a newer failed lookup with an older successful response", async () => {
    const gate = deferred();
    const f = await world.open({ lookups: new Map([[`/api/v1/sites/${older}`, gate]]) });
    await updateMode(f);
    await chooseFiles(f);
    await lookup(f, older);
    await expect.poll(() => singleReads(f).length).toBe(1);
    await lookup(f, "never-created-destination");
    await failedClosed(f);
    gate.resolve();
    await expect.poll(() => gate.delivered).toBe(true);
    await settle(f);
    await failedClosed(f);
    await lookup(f, alternate);
    await resolved(f, alternate);
    expect(await publishButton(f).isEnabled()).toBe(true);
  });

  // Break: late automatic resolution overwrites a deliberate first-page choice.
  it("does not overwrite a newer picker choice with an older initial explicit lookup", async () => {
    const gate = deferred();
    const f = await world.open({ target: older, lookups: new Map([[`/api/v1/sites/${older}`, gate]]) });
    await expect.poll(() => selector(f).locator(`option[value="${listed}"]`).count()).toBe(1);
    await expect.poll(() => singleReads(f).length, { message: "initial explicit lookup actually started" }).toBe(1);
    await selector(f).selectOption(listed);
    gate.resolve();
    await expect.poll(() => gate.delivered).toBe(true);
    await settle(f);
    await resolved(f, listed);
    await chooseFiles(f);
    await published(f, listed);
  });

  for (const reference of ["never-created-destination", "deleted-destination"]) {
    // Break: failed initial lookup silently falls back to New or a listed site.
    it(`fails closed for ${reference} and recovers through explicit retry`, async () => {
      const f = await world.open({ target: reference });
      await chooseFiles(f);
      await expect.poll(() => singleReads(f).length).toBe(1);
      await failedClosed(f);
      await lookup(f, older);
      await resolved(f, older);
      expect(await publishButton(f).isEnabled()).toBe(true);
    });
  }

  it("fails closed when the original site-restricted principal cannot read the target", async () => {
    const f = await world.open({ target: older, key: world.restrictedKey });
    await chooseFiles(f);
    await expect.poll(() => singleReads(f).length).toBe(1);
    expect(singleReads(f).every(r => r.authenticated), "keep the original principal; no authority fallback").toBe(true);
    await failedClosed(f);
  });

  it("keeps a failed manual lookup unresolved rather than reusing the previous selection", async () => {
    const f = await world.open();
    await updateMode(f);
    await selector(f).selectOption(listed);
    await chooseFiles(f);
    f.failures.set(`/api/v1/sites/${older}`, 503);
    await lookup(f, older);
    await failedClosed(f);
    f.failures.delete(`/api/v1/sites/${older}`);
    await lookup(f, older);
    await resolved(f, older);
    expect(await publishButton(f).isEnabled()).toBe(true);
  });

  // Break: reference is concatenated as a URL/path or decoded twice, enabling an
  // unrelated endpoint, query injection or markup. These are literal wire paths.
  for (const [reference, path] of [
    ["a/b?c#d%", "/api/v1/sites/a%2Fb%3Fc%23d%25"],
    ["snow-雪%2F", "/api/v1/sites/snow-%E9%9B%AA%252F"],
    ['<img src=x onerror=alert(1)>', "/api/v1/sites/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E"],
  ]) {
    it(`treats hostile reference ${JSON.stringify(reference)} as one encoded path segment`, async () => {
      const f = await world.open({ target: reference });
      await chooseFiles(f);
      await expect.poll(() => singleReads(f).map(r => r.path)).toEqual([path]);
      expect(singleReads(f)[0]!.query).toBe("");
      expect(await f.page.locator('#dw-publish img, #dw-publish script').count()).toBe(0);
      await failedClosed(f);
    });
  }

  it("does not request an empty lookup and labels an empty owned-site list", async () => {
    const f = await world.open({ key: world.restrictedKey });
    await updateMode(f);
    const input = await lookupInput(f);
    await input.fill("   ");
    await input.press("Enter");
    await settle(f);
    expect(singleReads(f)).toEqual([]);
    expect(writes(f)).toEqual([]);
    // An empty list must still offer lookup, rather than forcing new-site mode.
    await f.page.route("**/api/v1/sites?limit=200", (route: any) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ sites: [], nextCursor: null }) }));
    await f.page.reload();
    await updateMode(f);
    expect(await lookupInput(f)).toBeTruthy();
    expect(await f.page.locator("#dw-publish").innerText()).toMatch(/no .*sites|no sites|empty|no existing/i);
  });

  // Break: controls disappear offscreen, focus is detached, announcement absent,
  // or adding the destination panel loses the selected-file review.
  it("supports keyboard lookup, announcement and file review at 360px", async () => {
    const f = await world.open({ narrow: true });
    await updateMode(f);
    await chooseFiles(f);
    const input = await lookupInput(f);
    await input.focus();
    await f.page.keyboard.insertText(older);
    await f.page.keyboard.press("Enter");
    await resolved(f, older);
    expect(await f.page.evaluate(() => {
      const document = (globalThis as any).document;
      return document.activeElement !== document.body && document.activeElement?.isConnected;
    }), "lookup retains useful keyboard focus").toBe(true);
    const live = await f.page.locator('#dw-publish [aria-live], #dw-publish [role="status"]').allTextContents();
    expect(live.join(" ")).toContain(older);
    const review = f.page.locator('#dw-publish summary').filter({ hasText: /review|selected|files/i });
    expect(await review.count()).toBe(1);
    await review.focus();
    await review.press("Enter");
    expect(await f.page.locator("#dw-publish").innerText()).toContain("index.html");
    expect(await f.page.locator("#dw-publish").innerText()).toContain("readme.txt");
    expect(await f.page.evaluate(() => {
      const document = (globalThis as any).document;
      return document.documentElement.scrollWidth <= (globalThis as any).innerWidth + 1;
    }), "retain narrow-screen wrapping; no horizontal document overflow").toBe(true);
    await f.page.keyboard.press("Tab");
    expect(await f.page.evaluate(() => (globalThis as any).document.activeElement?.isConnected)).toBe(true);
  });
});

// Passing controls distinguish harness errors/pre-existing regressions from RED.
describe("Publish target: unchanged-surface controls", () => {
  it("updates a listed site through the real manifest/upload/finalize protocol", async () => {
    const f = await world.open();
    await updateMode(f);
    await expect.poll(() => selector(f).locator(`option[value="${listed}"]`).count()).toBe(1);
    await selector(f).selectOption(listed);
    await chooseFiles(f);
    await published(f, listed);
    expect(singleReads(f).length).toBeLessThanOrEqual(1);
    const raw = await fetch(`${world.origin}/s/${listed}/index.html?raw=1`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe("<h1>Disposable update destination</h1>\n");
  });

  it("leaves new-site publishing unchanged without an explicit destination", async () => {
    const f = await world.open();
    expect(await f.page.locator('#dw-publish input[value="new"]').isChecked()).toBe(true);
    await f.page.locator("#dw-pub-slug").fill("disposable-new-destination");
    await chooseFiles(f);
    expect((await publishAndWaitForFinalize(f)).status()).toBe(200);
    expect(writes(f).filter(r => r.path === "/api/v1/sites")).toHaveLength(1);
    expect(singleReads(f)).toEqual([]);
  });

  it("leaves anonymous quick publishing unchanged", async () => {
    const f = await world.open({ anonymous: true });
    await chooseFiles(f);
    expect((await publishAndWaitForFinalize(f)).status()).toBe(200);
    expect(writes(f).filter(r => r.path === "/api/v1/sites")).toHaveLength(1);
    expect(singleReads(f)).toEqual([]);
    expect(listReads(f)).toEqual([]);
  });

  it("serves the exact immutable first-party script under the existing CSP", async () => {
    const response = await fetch(world.origin + "/dashboard/publish");
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp.match(/script-src[^;]*/)?.[0]).not.toMatch(/unsafe-inline|unsafe-eval/);
    const html = await response.text();
    const path = html.match(/src="(\/__dropway\/ui\/app-[a-f0-9]{8}\.js)"/)?.[1];
    expect(path).toBeTruthy();
    const script = await fetch(world.origin + path);
    expect(script.status).toBe(200);
    expect(script.headers.get("cache-control")).toMatch(/immutable/);
    expect(script.headers.get("content-type")).toMatch(/javascript/);
    const servedBytes = await script.text();
    const repeated = await fetch(world.origin + path);
    expect(await repeated.text(), "hash-addressed script retains byte identity across requests").toBe(servedBytes);
    expect(repeated.headers.get("etag")).toBe(script.headers.get("etag"));
  });

  it("does not publish or attempt destination lookup with JavaScript disabled", async () => {
    const f = await world.open({ target: older, noScript: true, narrow: true });
    expect(await f.page.getByRole("navigation").count()).toBeGreaterThan(0);
    expect(await publishButton(f).count()).toBe(0);
    expect(f.wire).toEqual([]);
  });
});
