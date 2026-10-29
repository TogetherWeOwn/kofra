/**
 * PROTECTED supplemental handoff: this file and publish-target-review.helpers.ts
 * join the two original protected files (which must remain byte-identical).
 * Tests were authored from the regression spec before consulting implementation.
 *
 * Run: LD_LIBRARY_PATH=<Chromium libraries> npm run test:browser-code -- test/publish-target-review.acceptance.test.ts
 * Also run npm run check. Every test here is expected GREEN on main; a failure
 * is a real publisher regression (or a lost test synchronization barrier).
 * Never skip/weaken those tests to make checks green.
 *
 * Synchronization: forcedPublishIsInert waits for actual initial site-list
 * application (Loading replaced by the 200-option first page) before it
 * observes DOM work, and the dot-only cases hold that list back deliberately.
 * List rendering must never be attributed to a forced Publish dispatch.
 *
 * Reset: rerun. TargetWorld gives EACH test a disposable local Worker/Chromium,
 * isolated migrated D1/R2/KV and synthetic principals. Teardown releases gates and
 * disposes everything. No remote services, production state or source edits.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TargetWorld, alternate, chooseFiles, deferred, listReads, lookup, lookupInput,
  older, publishButton, resolved, selector, settle, singleReads, updateMode, writes,
} from "../../cli/test/encrypted/publish-target.helpers.ts";
import {
  announcements, feedback, finishPublish, forcedPublishIsInert, holdPublishPhase,
  installServedGuardMutant, lookupAlert, lookupButton, observeDestinationReads, trapDotEndpoints,
} from "../../cli/test/encrypted/publish-target-review.helpers.ts";

const world = new TargetWorld();
beforeEach(async () => {
  await world.start();
  installServedGuardMutant(world);
}, 120_000);
afterEach(async () => {
  try { await world.closeFixtures(); } finally { await world.stop(); }
}, 30_000);

describe("Publisher destination review regressions", () => {
  // Break: picker invalidation discards the verified off-page option before a
  // delayed list rebuild, even though the user deliberately selected it again.
  it("retains a deliberately reselected off-page destination through the late initial list", async () => {
    const gate = deferred();
    const f = await world.open({ target: older, listGate: gate });
    await resolved(f, older);
    await lookup(f, alternate);
    await resolved(f, alternate);
    await selector(f).selectOption(older);
    await resolved(f, older);
    gate.resolve();
    await expect.poll(() => gate.delivered).toBe(true);
    await expect.poll(() => selector(f).locator("option").count()).toBeGreaterThanOrEqual(200);
    await resolved(f, older);
    expect(singleReads(f).map(r => r.path)).toEqual([`/api/v1/sites/${older}`, `/api/v1/sites/${alternate}`]);
    await chooseFiles(f);
    await finishPublish(f, world.origin, older);
  });

  // Break: deleting only the unresolved-destination early return must cause real
  // listener work, not be hidden by native disabled-button .click() suppression.
  for (const state of ["pending", "failed"] as const) {
    it(`returns before any publish work on forced dispatch with a ${state} explicit lookup`, async () => {
      const gate = deferred();
      const f = await world.open({ target: older, lookups: new Map([[`/api/v1/sites/${older}`, gate]]) });
      await chooseFiles(f);
      await expect.poll(() => singleReads(f).length).toBe(1);
      await expect.poll(() => selector(f).locator("option").count()).toBeGreaterThanOrEqual(200);
      if (state === "failed") {
        // The gate fetched the real successful response already; supersede it with
        // a genuinely failed explicit lookup instead of reusing that selection.
        await lookup(f, "never-created-destination");
        await lookupAlert(f);
      }
      await forcedPublishIsInert(f);
      gate.resolve();
      await expect.poll(() => gate.delivered).toBe(true);
    });
  }

  // Break: deleting only focus-handler invalidateDest() lets either stale result
  // announce a destination/error after focusing the new-site slug (no radio click).
  for (const status of [200, 404]) {
    it(`supersedes a gated ${status} lookup by FOCUSING the new-site slug`, async () => {
      const gate = deferred();
      const f = await world.open({ lookups: new Map([[`/api/v1/sites/${older}`, gate]]) });
      await updateMode(f);
      if (status === 404) f.failures.set(`/api/v1/sites/${older}`, status);
      await lookup(f, older);
      await expect.poll(() => singleReads(f).length).toBe(1);
      const slug = f.page.locator("#dw-pub-slug");
      await slug.focus();
      expect(await f.page.locator('#dw-publish input[value="new"]').isChecked()).toBe(true);
      await slug.fill("focus-new-destination");
      const before = await announcements(f).allTextContents();
      gate.resolve();
      await expect.poll(() => gate.delivered).toBe(true);
      await settle(f);
      expect(await announcements(f).allTextContents(), "late success/error must not change new-site feedback").toEqual(before);
      expect((await announcements(f).allTextContents()).join(" ")).not.toContain(older);
      expect(await feedback(f).count()).toBe(0);
      await chooseFiles(f);
      await finishPublish(f, world.origin, "focus-new-destination", true);
    });
  }

  // Break: dropping lookupInput.disabled = on, the button equivalent, the busy
  // submit guard, or finally-unlocking controls. Hold each real protocol stage.
  for (const phase of ["manifest", "upload", "finalize"] as const) {
    for (const fail of [false, true]) {
      it(`locks BOTH lookup controls during ${phase} and restores them after ${fail ? "failure" : "success"}`, async () => {
        const f = await world.open({ target: older });
        await resolved(f, older);
        await chooseFiles(f);
        const input = await lookupInput(f);
        const button = lookupButton(f);
        const gate = await holdPublishPhase(f, phase, fail);
        await publishButton(f).click();
        await expect.poll(() => gate.entered, { message: `real ${phase} request is held` }).toBe(true);
        expect(await input.isDisabled(), "lookup INPUT must be disabled while publishing").toBe(true);
        expect(await button.isDisabled(), "lookup BUTTON must be disabled while publishing").toBe(true);
        const reads = singleReads(f).length;
        await button.evaluate((b: any) => b.dispatchEvent(new (globalThis as any).MouseEvent("click", { bubbles: true, cancelable: true })));
        await input.evaluate((i: any) => i.dispatchEvent(new (globalThis as any).KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
        await settle(f);
        expect(singleReads(f), "forced lookup submissions during busy must not issue GET").toHaveLength(reads);
        gate.resolve();
        await expect.poll(() => input.isEnabled(), { message: "lookup input recovers after publish settles", timeout: 15_000 }).toBe(true);
        expect(await button.isEnabled()).toBe(true);
        if (fail) await expect.poll(() => f.page.locator("#dw-publish").innerText()).toMatch(/failed/i);
        else await expect.poll(() => f.page.locator(`#dw-publish a[href="${world.origin}/s/${older}/"]`).count()).toBeGreaterThan(0);
        await lookup(f, alternate, "button");
        await resolved(f, alternate);
        expect(singleReads(f)).toHaveLength(reads + 1);
      });
    }
  }

  // Break: replacing only the malformed-success guard with false must not allow
  // HTTP 200 to count as verified when the envelope cannot name a destination.
  for (const malformed of ["null", "missing site", "empty slug"] as const) {
    it(`fails closed for HTTP 200 with ${malformed} and permits a valid retry`, async () => {
      const f = await world.open();
      await updateMode(f);
      await chooseFiles(f);
      const envelope = await world.request(`/sites/${older}`);
      const result = malformed === "null" ? null : malformed === "missing site" ? {}
        : { ...envelope, site: { ...envelope.site, slug: "" } };
      f.results.set(`/api/v1/sites/${older}`, result);
      await lookup(f, older);
      await expect.poll(() => singleReads(f).length).toBe(1);
      await lookupAlert(f);
      await forcedPublishIsInert(f);
      f.results.delete(`/api/v1/sites/${older}`);
      await lookup(f, older, "button");
      await resolved(f, older);
      expect(await publishButton(f).isEnabled()).toBe(true);
      expect(writes(f)).toEqual([]);
    });
  }

  // Break: encodeURIComponent leaves '.'/'..' untouched; fetch normalizes them
  // into different API endpoints. Reject locally, never emit that GET, recover.
  for (const reference of [".", ".."]) {
    for (const initial of [true, false]) {
      it(`rejects raw ${JSON.stringify(reference)} from ${initial ? "initial ?site" : "manual lookup"} without a lookup GET`, async () => {
        // Deliberately delay the site-list response: its rendering (Loading
        // replaced by the 200-option first page) is DOM work inside
        // #dw-publish, so the inertness check below must not attribute it to
        // a forced Publish dispatch. A request-start count or two animation
        // frames do not prove the list was applied.
        const listGate = deferred();
        const f = await world.open(initial ? {} : { listGate });
        await expect.poll(() => listReads(f).length).toBe(1);
        await trapDotEndpoints(f);
        const reads = observeDestinationReads(f);
        if (initial) {
          // Reload the actual served shell with the target, retaining the same
          // synthetic principal. Traps are installed BEFORE initial script runs.
          // Gate only the reloaded page's list: the first page's list request
          // was already routed above.
          f.listGate = listGate;
          f.gates.push(listGate);
          await f.page.goto(`${world.origin}/dashboard/publish?site=${encodeURIComponent(reference)}`);
          await expect.poll(() => listReads(f).length).toBe(2);
        } else {
          await updateMode(f);
          await lookup(f, reference);
        }
        await chooseFiles(f);
        await settle(f);
        expect(reads, "dot-only destination must be rejected before fetch can normalize it").toEqual([]);
        await lookupAlert(f);
        expect(await selector(f).locator("option", { hasText: "Loading" }).count(),
          "delayed list has NOT been applied when the inertness check starts").toBe(1);
        const inert = forcedPublishIsInert(f);
        listGate.resolve();
        await inert;
        await expect.poll(() => listGate.delivered).toBe(true);
        await lookup(f, older, "button");
        await resolved(f, older);
        expect(await publishButton(f).isEnabled()).toBe(true);
        expect(reads).toEqual([`/api/v1/sites/${older}`]);
        expect(writes(f)).toEqual([]);
      });
    }

    it(`invalid ${JSON.stringify(reference)} supersedes a pending valid lookup without stale rescue`, async () => {
      const gate = deferred();
      const f = await world.open({ target: older, lookups: new Map([[`/api/v1/sites/${older}`, gate]]) });
      await expect.poll(() => singleReads(f).length).toBe(1);
      await trapDotEndpoints(f);
      const reads = observeDestinationReads(f);
      await chooseFiles(f);
      await lookup(f, reference);
      await settle(f);
      expect(reads, "invalid new intent must not escape as another endpoint").toEqual([]);
      await lookupAlert(f);
      gate.resolve();
      await expect.poll(() => gate.delivered).toBe(true);
      await settle(f);
      await lookupAlert(f);
      await forcedPublishIsInert(f);
      await lookup(f, alternate);
      await resolved(f, alternate);
      expect(await publishButton(f).isEnabled()).toBe(true);
      expect(reads).toEqual([`/api/v1/sites/${alternate}`]);
    });
  }
});
