/**
 * Independent dashboard lifecycle acceptance; protected tests, not an implementation.
 *
 * Prerequisites (existing repository test harness, no dependency changes):
 *   npm ci --include=dev
 *   npm ci --prefix packages/cli/test/encrypted --include=dev
 *   packages/cli/test/encrypted/node_modules/.bin/playwright install --with-deps chromium
 *   npm run test:cli -- test/encrypted/dashboard-rename.acceptance.test.ts
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH may select an installed Chromium.
 *
 * Uses real sign-in, HTML, CSP, hashed script, Chromium form/keyboard semantics,
 * and a disposable loopback Worker/D1/R2/KV. Controlled rename responses cover
 * deterministic errors, in-flight races, and returned URL/deadline variants.
 * The end-to-end case passes the rename through to the real Worker unchanged.
 * Never run against a deployed instance. No production source imports/mocks.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  announcements, api, cancel, closeViews, deferred, fillAndSubmit, frame, hrefs,
  main, navigateReturned, open, origin, proposed, ready, renameForm, reply,
  result, serveIdentity, start, stop, submit, visibleText, writesAreRename,
  type RenameResult, type View,
} from "./dashboard-rename.helpers";

beforeAll(start, 120_000);
afterEach(closeViews);
afterAll(stop);

async function noSuccess(view: View) {
  const feedback = await visibleText(announcements(view));
  expect(feedback).not.toMatch(/successfully renamed|rename (?:complete|successful)|renamed (?:to|from)/i);
}

async function receipt(view: View, response: RenameResult) {
  // Break: guessing a URL, losing the old identity, or displaying the proposal
  // instead of the server's canonical identity.
  await expect.poll(() => main(view).innerText(), { message: "successful rename displays the returned new URL" }).toContain(response.url);
  const text = await main(view).innerText();
  expect(text).toContain(view.site.url);
  expect(text).toContain(response.slug);
  expect(await main(view).locator('a[href]').evaluateAll(links => links.map(link => (link as any).href))).toContain(response.url);
  expect(view.page.url()).not.toContain("/dashboard/sites/unconfirmed-proposal");
}

async function showsDeadline(view: View) {
  const text = await main(view).innerText();
  const dateTimes = await main(view).locator("time[datetime]").evaluateAll(nodes => nodes.map(node => node.getAttribute("datetime")));
  // Exact machine-readable datetime or a readable date in the fixed en-US/UTC
  // context. The fixture is deliberately NOT twelve months from today.
  const hasDate = dateTimes.includes("2041-02-03T04:05:06.000Z") ||
    /2041-02-03|Feb(?:ruary)?\s+0?3(?:rd)?,?\s+2041|0?2\/0?3\/2041/.test(text);
  expect(hasDate, "show the returned redirectUntil, not a hardcoded retention period").toBe(true);
  expect(text).toMatch(/308/);
  expect(text).toMatch(/redirect/i);
  expect(text).toMatch(/old (?:name|slug)|previous (?:name|slug)/i);
  expect(text).toMatch(/bound|retain|reserv|held|hold/i);
  expect(text).not.toMatch(/12 months|twelve months|365 days|forever|permanent redirect forever/i);
}

// Break: a rename affordance is added outside settings, or the dashboard fails
// before any interaction. This is also a positive control for the browser harness.
it("boots a real served settings page without speculative mutations", async () => {
  const view = await open();
  expect(await main(view).innerText()).toContain(view.site.slug);
  expect(await hrefs(view)).toContain(view.site.url);
  expect(view.writes).toEqual([]);
});

describe("labelled rename form and no-mutation exits", () => {
  // Break: an unlabelled textbox/button-only handler is inaccessible to keyboard users.
  it("exposes current and proposed names and keeps existing editable settings", async () => {
    const view = await open();
    await ready(view);
    const ax = await renameForm(view).ariaSnapshot();
    expect(ax).toMatch(/textbox .*new|textbox .*proposed/i);
    expect(ax).toMatch(/button .*cancel/i);
    expect(await view.page.getByRole("textbox", { name: /^title$/i }).isVisible()).toBe(true);
    expect(await view.page.getByRole("button", { name: /delete site/i }).isVisible()).toBe(true);
    expect(view.writes).toEqual([]);
  });

  // Break: Cancel submits, changes live links, or leaves a destructive operation queued.
  it("cancels an explicit proposal without any mutation or live-link change", async () => {
    const view = await open();
    await ready(view);
    const originalLinks = await hrefs(view);
    await proposed(view).fill("cancelled-proposal");
    await cancel(view).click();
    await frame(view);
    expect(view.writes).toEqual([]);
    expect(await hrefs(view)).toEqual(originalLinks);
    expect(view.page.url()).toBe(`${origin}/dashboard/sites/${view.site.slug}`);
    await noSuccess(view);
    expect((await api(`/api/v1/sites/${view.site.slug}`)).slug).toBe(view.site.slug);
  });

  // Break: a canonical no-op is called a successful rename or invents a redirect deadline.
  it.each(["identical", "canonical"])('treats a %s same-name submission as a no-op', async mode => {
    const view = await open();
    await ready(view);
    const originalLinks = await hrefs(view);
    const before = await api(`/api/v1/sites/${view.site.slug}`);
    const name = mode === "identical" ? view.site.slug : `  ${view.site.slug.toUpperCase()}  `;
    await proposed(view).fill(name);
    if (await submit(view).isEnabled()) await submit(view).click();
    else await proposed(view).press("Enter"); // A disabled same-name action is a valid local no-op.
    await frame(view);
    await view.page.waitForLoadState("networkidle");
    // Either suppress the no-op locally or use the existing canonicalizing endpoint once.
    expect(view.writes.length).toBeLessThanOrEqual(1);
    for (const write of view.writes) {
      expect(write.method).toBe("POST");
      expect(write.path).toBe(`/api/v1/sites/${view.site.slug}/rename`);
      const sent = JSON.parse(write.body ?? "null");
      expect(Object.keys(sent)).toEqual(["newSlug"]);
      expect(sent.newSlug.trim().toLowerCase()).toBe(view.site.slug);
    }
    expect(await api(`/api/v1/sites/${view.site.slug}`)).toEqual(before);
    expect(await hrefs(view)).toEqual(originalLinks);
    expect(view.page.url()).toBe(`${origin}/dashboard/sites/${view.site.slug}`);
    await noSuccess(view);
  });
});

describe("response-bound rename success", () => {
  // Break: client derives the destination from the input or assumes path mode.
  it.each(["path", "subdomain"])('uses returned %s URLs and canonical slug, preserving the configured deadline', async mode => {
    let response!: RenameResult;
    const view = await open({ rename: async route => reply(route, response) });
    response = result(view, {
      url: mode === "path" ? `${origin}/s/server-canonical-name/?from=rename&v=7` : "https://server-canonical-name.sites.example.test/",
    });
    await serveIdentity(view, response);
    await fillAndSubmit(view, "unconfirmed-proposal");
    await receipt(view, response);
    await showsDeadline(view);
    writesAreRename(view, "unconfirmed-proposal");
    await navigateReturned(view, response.slug);
    expect(view.writes).toHaveLength(1);
  });

  // Break: a missing or expired deadline becomes a promised future redirect.
  it.each(["null", "omitted", "expired"])('does not promise an active redirect for a %s deadline', async kind => {
    let response!: RenameResult;
    const view = await open({ rename: async route => reply(route, response) });
    response = result(view, { redirectUntil: kind === "expired" ? "2001-02-03T04:05:06.000Z" : null });
    if (kind === "omitted") delete response.redirectUntil;
    await serveIdentity(view, response);
    await fillAndSubmit(view, "unconfirmed-proposal");
    await receipt(view, response);
    const feedback = await visibleText(announcements(view));
    const text = await main(view).innerText();
    expect(text).not.toMatch(/12 months|twelve months|365 days|redirects? forever/i);
    // Omission is safe for an absent deadline: do not require particular copy.
    // A receipt which does promise an active redirect must qualify that claim.
    const claimsActive = /will (?:continue to )?redirect|redirect (?:is|remains) active|redirects? until/i.test(feedback);
    const qualified = /no |not |without|unavailable|expired|ended|unknown|not provided/i.test(feedback);
    expect(claimsActive && !qualified, "never invent an active redirect without a future deadline").toBe(false);
    if (kind === "expired") {
      expect(text).toContain("2001");
      expect(text).toMatch(/expired|ended|not active|not guaranteed|no active/i);
    }
    writesAreRename(view, "unconfirmed-proposal");
    await navigateReturned(view, response.slug);
  });

  // Break: real backend outcome is ignored, or the UI introduces a second mutation.
  it("renames a disposable live site through the existing endpoint and follows its real identity", async () => {
    const view = await open();
    const original = await api(`/api/v1/sites/${view.site.slug}`);
    const newSlug = `${view.site.slug}-new`;
    let response!: RenameResult;
    view.page.on("response", async res => {
      if (res.request().method() === "POST" && new URL(res.url()).pathname === `/api/v1/sites/${view.site.slug}/rename`) response = await res.json();
    });
    await fillAndSubmit(view, newSlug);
    await expect.poll(() => response?.renamed).toBe(true);
    await receipt(view, response);
    const updated = await api(`/api/v1/sites/${newSlug}`);
    expect(updated.slug).toBe(newSlug);
    expect(updated.currentVersionId, "rename does not publish or restore a version").toBe(original.currentVersionId);
    expect(updated.settings).toEqual(original.settings);
    expect(updated.title).toBe(original.title);
    expect(updated.description).toBe(original.description);
    const redirect = await fetch(view.site.url, { redirect: "manual" });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe(response.url);
    const live = await fetch(response.url);
    expect(await live.text()).toContain("Disposable rename fixture");
    writesAreRename(view, newSlug);
    await navigateReturned(view, newSlug);
  });
});

describe("deterministic failure, preserved state and retry", () => {
  const refusals = [
    { status: 400, code: "invalid_slug", message: "That name is invalid.", hint: "Use lowercase letters, digits and single hyphens." },
    { status: 409, code: "slug_taken", message: "That name is already taken.", hint: "Choose another site name." },
    { status: 409, code: "slug_reserved", message: "That name is reserved.", hint: "Choose a name not held by the configured retention policy." },
    { status: 403, code: "rename_refused", message: "The configured policy refused this rename.", hint: "Ask your instance administrator about its policy." },
    { status: 500, code: "internal_error", message: "The server could not rename this site.", hint: "Retry the rename later." },
  ];
  // Break: a refusal clears the proposal, invents success, mutates current links,
  // loses the original principal, or provides an inaccessible/unactionable error.
  it.each(refusals)("keeps the proposal and original identity for $code", async error => {
    const view = await open({ rename: route => reply(route, { error: { ...error, retryable: error.status === 500 } }, error.status) });
    await ready(view);
    const originalLinks = await hrefs(view);
    const original = await api(`/api/v1/sites/${view.site.slug}`);
    await proposed(view).fill("proposed-valid-name");
    await submit(view).click();
    await expect.poll(() => visibleText(announcements(view)), { message: "server refusal is announced accessibly with its remediation" }).toContain(error.message);
    expect(await visibleText(announcements(view))).toContain(error.hint);
    expect(await proposed(view).inputValue()).toBe("proposed-valid-name");
    expect(await submit(view).isEnabled()).toBe(true);
    expect(await hrefs(view)).toEqual(originalLinks);
    expect(view.page.url()).toBe(`${origin}/dashboard/sites/${view.site.slug}`);
    expect(await api(`/api/v1/sites/${view.site.slug}`)).toEqual(original);
    await noSuccess(view);
    writesAreRename(view, "proposed-valid-name");
  });

  // Break: failed fetch leaves the form disabled, discards edits, or retries itself.
  it("preserves a network-failed proposal and retries only on explicit resubmission", async () => {
    let attempt = 0;
    let response!: RenameResult;
    const view = await open({ rename: async route => {
      if (++attempt === 1) return route.abort("failed");
      return reply(route, response);
    } });
    response = result(view);
    await serveIdentity(view, response);
    await ready(view);
    const originalLinks = await hrefs(view);
    await proposed(view).fill("proposed-valid-name");
    await submit(view).click();
    await expect.poll(() => visibleText(announcements(view))).toMatch(/network|fetch|failed|unable|error|could not|couldn't/i);
    expect(await proposed(view).inputValue()).toBe("proposed-valid-name");
    expect(await submit(view).isEnabled()).toBe(true);
    expect(await hrefs(view)).toEqual(originalLinks);
    await noSuccess(view);
    await frame(view);
    writesAreRename(view, "proposed-valid-name");
    await submit(view).click();
    await receipt(view, response);
    writesAreRename(view, "proposed-valid-name", 2);
  });

  // Break: pressing Enter or dispatching a second submit bypasses the pending guard.
  it("keeps live links unchanged in flight and permits only one outstanding rename", async () => {
    const gate = deferred();
    let response!: RenameResult;
    const view = await open({ rename: async route => { await gate.promise; await reply(route, response); } });
    view.gate = gate;
    response = result(view);
    await serveIdentity(view, response);
    await ready(view);
    const originalLinks = await hrefs(view);
    await view.page.clock.install();
    await proposed(view).fill("proposed-valid-name");
    await proposed(view).press("Enter");
    await expect.poll(() => view.writes.length).toBe(1);
    expect(await submit(view).isDisabled(), "pending state is visible and prevents duplicate activation").toBe(true);
    await proposed(view).press("Enter");
    await renameForm(view).dispatchEvent("submit");
    await view.page.clock.runFor(1000); // Flush delayed/re-entrant submits while the first response is still held.
    writesAreRename(view, "proposed-valid-name");
    expect(await hrefs(view)).toEqual(originalLinks);
    expect(view.page.url()).toBe(`${origin}/dashboard/sites/${view.site.slug}`);
    await noSuccess(view);
    gate.resolve();
    await receipt(view, response);
    writesAreRename(view, "proposed-valid-name");
  });

  // Break: data from the server or settings is interpreted as app-origin markup.
  it("renders hostile title and refusal text literally, without injected elements or handlers", async () => {
    const hostile = '<img src="/rename-injected" onerror="globalThis.renameInjected=true"> & "literal"';
    const view = await open({ title: hostile, rename: route => reply(route, { error: {
      code: "rename_refused", message: hostile, hint: "Choose <another> name & retry.",
    } }, 403) });
    await fillAndSubmit(view, "escaped-proposal");
    await expect.poll(() => visibleText(announcements(view))).toContain(hostile);
    expect(await visibleText(announcements(view))).toContain("Choose <another> name & retry.");
    expect(await view.page.getByRole("textbox", { name: /^title$/i }).inputValue()).toBe(hostile);
    expect(await view.page.locator('img[src="/rename-injected"], [onerror*="renameInjected"]').count()).toBe(0);
    expect(await view.page.evaluate(() => (globalThis as any).renameInjected)).toBeUndefined();
    writesAreRename(view, "escaped-proposal");
  });
});

describe("truthful deletion guidance and destructive confirmation", () => {
  // Break: deleting advertises immediate acquisition/reuse or exposes a release/override control.
  it("explains configured name retention instead of saying deletion frees the name", async () => {
    const view = await open();
    const deleteButton = view.page.getByRole("button", { name: /delete site/i });
    const section = deleteButton.locator("xpath=ancestor::section[1]");
    expect(await section.count(), "deletion guidance lives beside the existing destructive action").toBe(1);
    const copy = await section.innerText();
    expect(copy).not.toMatch(/and the name is freed|the name is freed[.!]|deletion frees the name|name (?:is|becomes) immediately available/i);
    expect(copy).toMatch(/retain|reserv|hold|held|bound/i);
    expect(copy).toMatch(/configur|policy|retention|lifetime/i);
    expect(copy).toMatch(/\bnot\b|\bdoesn['’]?t\b|\bcannot\b|\bcan['’]?t\b|\bwon['’]?t\b/i);
    expect(copy).toMatch(/immediate|another (?:tenant|owner|account)|reuse|re-use|reclaim|acquir/i);
    expect(await view.page.getByRole("button", { name: /release (?:name|slug)|override (?:hold|retention)|force (?:release|rename)/i }).count()).toBe(0);
    expect(view.writes).toEqual([]);
  });

  // Break: cancel/wrong-name can delete, or correct-name confirmation no longer works.
  it("retains the typed current-slug gate for cancelled, wrong and exact deletion confirmations", async () => {
    const view = await open({ allowDelete: true });
    const button = view.page.getByRole("button", { name: /delete site/i });
    const dialog = view.page.getByRole("dialog");
    for (let i = 0; i < 2; i++) {
      await button.click();
      await expect.poll(() => dialog.isVisible()).toBe(true);
      expect(await dialog.innerText()).toContain(view.site.slug);
      const confirmation = dialog.getByRole("button", { name: /^delete(?: site)?$/i });
      expect(await confirmation.isDisabled()).toBe(true);
      if (i === 1) {
        await dialog.getByRole("textbox").fill("wrong-site-name");
        await dialog.getByRole("textbox").press("Enter");
        expect(await confirmation.isDisabled()).toBe(true);
      }
      expect(view.writes, "neither cancellation nor typing another name deletes").toEqual([]);
      await dialog.getByRole("button", { name: /^cancel$/i }).click();
      await expect.poll(() => dialog.isVisible()).toBe(false);
      expect((await api(`/api/v1/sites/${view.site.slug}`)).slug).toBe(view.site.slug);
    }
    await button.click();
    await dialog.getByRole("textbox").fill(view.site.slug);
    expect(await dialog.getByRole("button", { name: /^delete(?: site)?$/i }).isEnabled()).toBe(true);
    await dialog.getByRole("button", { name: /^delete(?: site)?$/i }).click();
    await expect.poll(() => view.writes.length).toBe(1);
    view.expectedWrites = 1;
    const write = view.writes[0]!;
    expect(write.method).toBe("DELETE");
    expect(write.path).toBe(`/api/v1/sites/${view.site.slug}`);
    const confirmation = write.body ? JSON.parse(write.body).confirm : new URLSearchParams(write.query).get("confirm");
    expect(confirmation).toBe(view.site.slug);
    await view.page.waitForURL(url => url.origin === origin && url.pathname === "/dashboard");
  });
});

// Break: the form is clipped on phones, focus is lost on an error/cancel, or
// real keyboard submission sends twice. Uses actual Chromium layout and AX.
it("works at 360px with labelled controls, native keyboard submit and recoverable focus", async () => {
  const view = await open({ mobile: true, rename: route => reply(route, { error: {
    code: "slug_taken", message: "That name is taken.", hint: "Choose another name and retry.",
  } }, 409) });
  await ready(view);
  await proposed(view).focus();
  await view.page.keyboard.type("mobile-proposal");
  await view.page.keyboard.press("Enter");
  await expect.poll(() => visibleText(announcements(view))).toContain("That name is taken.");
  expect(await proposed(view).inputValue()).toBe("mobile-proposal");
  const ax = await main(view).ariaSnapshot();
  expect(ax).toMatch(/textbox .*new|textbox .*proposed/i);
  expect(ax).toMatch(/alert|status|That name is taken/);
  const focusIsRecoverable = await view.page.evaluate(() => {
    const document = (globalThis as any).document;
    const active = document.activeElement;
    return active && active !== document.body && (active.closest("form") || active.closest('[role="alert"], [role="status"]'));
  });
  expect(Boolean(focusIsRecoverable), "failure leaves keyboard focus at the form or its actionable feedback").toBe(true);
  for (const control of [proposed(view), submit(view), cancel(view)]) {
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    expect(box, "rename control is rendered, not hidden offscreen").not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(361);
  }
  await cancel(view).focus();
  await view.page.keyboard.press("Enter");
  await frame(view);
  writesAreRename(view, "mobile-proposal");
});
