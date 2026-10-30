/**
 * Protected Test Author acceptance: duplicate a live site from its dashboard.
 * Builder must not edit this directory. Correct assertions through the author.
 *
 * npm ci --include=dev
 * npm ci --include=dev --prefix packages/cli/test/encrypted
 * npx vitest run -c packages/cli/vitest.config.ts test/encrypted/duplicate-dashboard/acceptance.test.ts
 *
 * Runs the REAL HTTP-served dashboard JavaScript in the existing VM/DOM style,
 * backed by a disposable local Worker with real D1/R2/KV. No source-string UI
 * assertions, production requests, imported implementation, or new dependencies.
 * Only the mutation boundary is intercepted for deterministic error/race cases.
 * Browser-native AX/layout coverage lives in browser.acceptance.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { deferred, mutations, refusal, response, sourceSlug, startFixture, type Fixture, type Reply } from "./fixture";
import { accessibleName, button, field, fill, find, mount, settle, until, visible, type View } from "./dom";

let fixture: Fixture;
const views: View[] = [];
beforeAll(async () => { fixture = await startFixture(); }, 120_000);
afterEach(() => { views.splice(0).forEach(view => view.dispose()); });
afterAll(async () => { await fixture?.dispose(); });
async function visit(reply?: Reply) {
  const view = await mount(fixture, reply);
  views.push(view);
  return view;
}
function open(view: View) {
  button(view.doc.body, /^duplicate(?: site)?$/i).click();
  const destination = field(view.doc.body, /(?:destination|new).*slug|^slug$/i);
  const dialog = destination.closest("dialog") ?? destination.closest('[role="dialog"]');
  const panel = dialog ?? destination.closest("form");
  expect(panel, "Duplicate opens a form or dialog, not a native prompt").not.toBeNull();
  if (dialog) expect(accessibleName(dialog), "dialog has an accessible name").toMatch(/duplicate|copy/i);
  const message = field(panel!, /message/i);
  const submit = button(panel!, /^(?:duplicate(?: site)?|create copy|copy site)$/i);
  const cancel = button(panel!, /^cancel$/i);
  return { panel: panel!, destination, message, submit, cancel };
}
function enter(form: ReturnType<typeof open>, slug = "requested-copy", message = "Snapshot for a colleague") {
  fill(form.destination, slug);
  fill(form.message, message);
}
function announcements(view: View) {
  return find(view.doc.body, node => ["status", "alert"].includes(node.getAttribute("role") ?? "") || ["polite", "assertive"].includes(node.getAttribute("aria-live") ?? ""))
    .map(node => node.textContent).join("\n");
}
function links(view: View) { return find(view.doc.body, node => node.tag === "a"); }
function assertDuplicateOnly(view: View, count: number) {
  const writes = mutations(view.wire);
  expect(writes).toHaveLength(count);
  for (const write of writes) {
    expect(write.method).toBe("POST");
    expect([`/api/v1/sites/${sourceSlug}/duplicate`, `/api/v1/sites/${fixture.source.id}/duplicate`]).toContain(write.path);
    expect(write.headers.get("Idempotency-Key"), "every submission is replay-safe").toMatch(/\S{8,}/);
    expect(write.headers.get("Authorization"), "reuse the signed-in caller, not a new authority").toBe(`Bearer ${fixture.ownerKey}`);
    expect(Object.keys(JSON.parse(write.body)).every(key => ["newSlug", "message"].includes(key)), "do not copy passwords, access, settings, files or versions in the UI").toBe(true);
  }
}
function noGuessedSuccess(view: View, requested = "requested-copy") {
  expect(view.navigation, "an error must not navigate anywhere").toEqual([]);
  expect(links(view).filter(node => (node.getAttribute("href") ?? "").includes(requested)), "no guessed destination links after a refusal").toEqual([]);
  expect(announcements(view)).not.toMatch(/successfully|duplicate created|site duplicated/i);
}
async function expectReceipt(view: View) {
  const url = `${fixture.origin}/s/dashboard-returned-copy/`;
  await until(() => links(view).some(link => link.getAttribute("href") === url), "receipt links to the returned destination URL");
  expect(view.doc.body.textContent, "destination URL is visible, not only an icon href").toContain(url);
  expect(links(view).some(link => {
    const url = new URL(link.getAttribute("href") ?? "", fixture.origin);
    return url.origin === fixture.origin && url.pathname === "/dashboard/sites/dashboard-returned-copy";
  }), "receipt includes the returned site's management link (a version query is allowed)").toBe(true);
  expect(links(view).some(link => (link.getAttribute("href") ?? "").includes("requested-copy")), "submitted text is not authoritative identity").toBe(false);
  for (const url of view.navigation) expect(new URL(url, fixture.origin).pathname).toBe("/dashboard/sites/dashboard-returned-copy");
}

// A broken or substituted harness cannot count as feature-assertion RED.
describe("disposable dashboard harness controls", () => {
  it("executes the served script, loads real site data, and preserves Browse/Publish/Open", async () => {
    const view = await visit();
    const pageHead = view.doc.body.querySelector(".dw-pagehead");
    expect(pageHead, "the original site actions remain in the page head").not.toBeNull();
    const actions = find(pageHead!, node => node.tag === "a");
    for (const [name, href] of [
      [/^browse(?: files)?$/i, `/v/${sourceSlug}/`],
      [/^publish(?: update)?$/i, `/dashboard/publish?site=${sourceSlug}`],
      [/^open(?: site)?$/i, `${fixture.origin}/s/${sourceSlug}/`],
    ] as const) {
      const matches = actions.filter(link => name.test(accessibleName(link)));
      expect(matches).toHaveLength(1);
      expect(matches[0]!.getAttribute("href")).toBe(href);
    }
    expect(view.wire.some(call => call.path === `/api/v1/sites/${sourceSlug}`)).toBe(true);
    expect(view.doc.body.textContent).toContain("Original title");
    expect(mutations(view.wire)).toEqual([]);
    expect(view.errors).toEqual([]);
    expect(view.navigation).toEqual([]);
  });
});

describe("duplicate dashboard outcome contract", () => {
  it("opens labelled fields and warns that the separate copy does not inherit protection before any mutation", async () => {
    const view = await visit();
    const form = open(view);
    const text = form.panel.textContent.replace(/\s+/g, " ");
    expect(text).toMatch(/separate|independent|new site/i);
    expect(text).toMatch(/password|access protection/i);
    expect(text).toMatch(/not (?:be )?(?:copied|inherited|transferred)|does not (?:copy|inherit)|re.?apply/i);
    expect(text).not.toMatch(/passwords? (?:are|is|will be) copied|protection (?:is|will be) copied/i);
    expect(form.message.hasAttribute("required"), "message is optional").toBe(false);
    expect(form.destination.disabled).toBe(false);
    expect(mutations(view.wire)).toEqual([]);
  });

  it("Cancel sends no mutation, returns focus, and leaves the original site/version/settings unchanged", async () => {
    const before = await fixture.snapshot();
    const view = await visit();
    const opener = button(view.doc.body, /^duplicate(?: site)?$/i);
    const form = open(view);
    enter(form);
    form.cancel.click();
    await settle();
    expect(!form.panel.isConnected || !visible(form.panel), "Cancel dismisses the duplicate form").toBe(true);
    expect(view.doc.activeElement, "focus returns to the Duplicate action").toBe(opener);
    expect(mutations(view.wire)).toEqual([]);
    expect(view.navigation).toEqual([]);
    expect(await fixture.snapshot()).toEqual(before);
  });

  it.each(["", "spaces are not slugs", "../escape", '<img src=x onerror="alert(1)">'])("rejects invalid destination %j without sending a request or creating markup", async slug => {
    const view = await visit();
    const form = open(view);
    enter(form, slug);
    form.submit.click();
    await settle();
    expect(mutations(view.wire), "invalid input must not create a randomly named site").toEqual([]);
    expect(view.navigation).toEqual([]);
    expect(find(form.panel, node => node.tag === "img" || node.hasAttribute("onerror"))).toEqual([]);
    expect(form.destination.value).toBe(slug);
  });

  it.each([
    ["double hyphen", "bad--name", "Snapshot", /slug|name/i],
    ["two-character slug", "ab", "Snapshot", /slug|name/i],
    ["57-character slug", "a".repeat(57), "Snapshot", /slug|name/i],
    ["501-character message", "requested-copy", "m".repeat(501), /message/i],
  ] as const)("rejects %s in the served submit handler with a field-specific error", async (_case, slug, message, error) => {
    const view = await visit(async () => response(fixture.destinationResponse));
    const form = open(view);
    enter(form, slug, message);
    // Bypass native constraint validation: the served handler must enforce bounds
    // even when programmatic input exceeds maxlength (as this VM permits).
    const submitForm = form.destination.closest("form");
    expect(submitForm).not.toBeNull();
    submitForm!.dispatch("submit");
    await until(() => error.test(announcements(view)), "invalid field is named in an actionable error");
    expect(announcements(view)).toMatch(/choose|enter|must|between|at most|characters|valid/i);
    expect(mutations(view.wire)).toEqual([]);
    expect(form.destination.value).toBe(slug);
    expect(form.message.value).toBe(message);
    noGuessedSuccess(view);
  });

  it.each([
    [3, 499], [3, 500], [56, 499], [56, 500],
  ] as const)("submits valid slug length %s and message length %s unchanged", async (slugLength, messageLength) => {
    const view = await visit(async () => response(fixture.destinationResponse));
    const form = open(view);
    const slug = "a".repeat(slugLength);
    const message = "m".repeat(messageLength);
    enter(form, slug, message);
    form.submit.click();
    await expectReceipt(view);
    assertDuplicateOnly(view, 1);
    expect(JSON.parse(mutations(view.wire)[0]!.body)).toEqual({ newSlug: slug, message });
  });

  it("submits source identity, explicit destination and literal message only through duplicate_site", async () => {
    const before = await fixture.snapshot();
    const view = await visit(async () => refusal("slug_taken", "Choose another destination slug."));
    const form = open(view);
    const message = '<img src=x onerror="alert(1)"> & "snapshot"';
    enter(form, "requested-copy", message);
    form.submit.click();
    await until(() => mutations(view.wire).length > 0, "Duplicate submits the registry request");
    assertDuplicateOnly(view, 1);
    expect(JSON.parse(mutations(view.wire)[0]!.body)).toEqual({ newSlug: "requested-copy", message });
    expect(form.message.value).toBe(message);
    expect(find(view.doc.body, node => node.tag === "img" || node.hasAttribute("onerror"))).toEqual([]);
    expect(await fixture.snapshot()).toEqual(before);
  });

  it("does not require a message or invent other mutation fields", async () => {
    const view = await visit(async () => response(fixture.destinationResponse));
    const form = open(view);
    enter(form, "requested-copy", "");
    form.submit.click();
    await expectReceipt(view);
    assertDuplicateOnly(view, 1);
    const body = JSON.parse(mutations(view.wire)[0]!.body);
    expect(body.newSlug).toBe("requested-copy");
    expect(body.message === undefined || body.message === "").toBe(true);
  });

  it("suppresses simultaneous submit/clicks and exposes a busy state until the request settles", async () => {
    const gate = deferred();
    const view = await visit(async () => { await gate.promise; return refusal("slug_taken", "Choose another slug."); });
    try {
      const form = open(view);
      enter(form);
      form.submit.click();
      form.submit.click();
      (form.panel.closest("form") ?? form.panel.querySelector("form"))?.dispatch("submit");
      await until(() => mutations(view.wire).length > 0, "first request starts");
      expect(form.submit.disabled || form.submit.getAttribute("aria-disabled") === "true", "busy submission cannot be activated twice").toBe(true);
      expect(form.panel.getAttribute("aria-busy") === "true" || /duplicat(?:ing|e in progress)|copying|creating/i.test(form.submit.textContent + announcements(view)), "busy progress is exposed to assistive technology").toBe(true);
      assertDuplicateOnly(view, 1);
      gate.resolve();
      await until(() => announcements(view).includes("Choose another slug."), "busy ends with an actionable refusal");
      expect(form.submit.disabled).toBe(false);
    } finally { gate.resolve(); }
  });

  it.each([
    [409, "slug_taken", "Choose an unused destination slug."],
    [409, "slug_reserved", "Choose a slug that is not reserved."],
    [404, "site_not_found", "Reload the site list and select an existing source."],
    [409, "site_changed", "Reload the source before duplicating again."],
    [409, "no_live_version", "Publish a version before duplicating this source."],
    [403, "feature_unavailable", "Ask the instance administrator to enable this operation."],
  ] as const)("announces %s %s with its server hint and never guesses success", async (status, code, hint) => {
    const before = await fixture.snapshot();
    const view = await visit(async () => refusal(code, hint, status));
    const form = open(view);
    enter(form);
    form.submit.click();
    await until(() => announcements(view).includes(hint), `announce ${code} remediation`);
    expect(announcements(view)).toContain(code);
    expect(form.destination.value).toBe("requested-copy");
    expect(form.message.value).toBe("Snapshot for a colleague");
    assertDuplicateOnly(view, 1);
    noGuessedSuccess(view);
    expect(await fixture.snapshot()).toEqual(before);
  });

  it("keeps one idempotency key across an ambiguous network retry with unchanged inputs", async () => {
    let attempts = 0;
    const view = await visit(async () => {
      if (++attempts === 1) throw new TypeError("Network disconnected after submission");
      return response(fixture.destinationResponse);
    });
    const form = open(view);
    enter(form);
    form.submit.click();
    await until(() => /network|connect|retry|fetch/i.test(announcements(view)), "a network failure announces recovery instead of success");
    noGuessedSuccess(view);
    form.submit.click();
    await expectReceipt(view);
    assertDuplicateOnly(view, 2);
    const [first, retry] = mutations(view.wire);
    expect(retry!.headers.get("Idempotency-Key")).toBe(first!.headers.get("Idempotency-Key"));
    expect(retry!.path).toBe(first!.path);
    expect(retry!.body).toBe(first!.body);
  });

  it("restores both inputs and the original attempt after an ambiguous failure, Cancel and reopen", async () => {
    let attempts = 0;
    const view = await visit(async () => {
      if (++attempts === 1) throw new TypeError("Network disconnected after submission");
      return response(fixture.destinationResponse);
    });
    const form = open(view);
    enter(form);
    form.submit.click();
    await until(() => /network|connect|retry|fetch/i.test(announcements(view)), "ambiguous failure announces recovery");
    noGuessedSuccess(view);
    assertDuplicateOnly(view, 1);
    const first = mutations(view.wire)[0]!;
    form.cancel.click();
    await settle();
    expect(!form.panel.isConnected || !visible(form.panel)).toBe(true);
    const reopened = open(view);
    expect(reopened.destination.value).toBe("requested-copy");
    expect(reopened.message.value).toBe("Snapshot for a colleague");
    expect(mutations(view.wire)).toHaveLength(1);
    reopened.submit.click();
    await expectReceipt(view);
    assertDuplicateOnly(view, 2);
    const retry = mutations(view.wire)[1]!;
    expect(retry.path).toBe(first.path);
    expect(retry.body).toBe(first.body);
    expect(retry.headers.get("Idempotency-Key")).toBe(first.headers.get("Idempotency-Key"));
  });

  it.each([
    ["javascript URL", { url: "javascript:alert(1)" }],
    ["data URL", { url: "data:text/html,<script>alert(1)</script>" }],
    ["relative URL", { url: "/s/dashboard-returned-copy/" }],
    ["malformed URL", { url: "https://[invalid" }],
    ["missing URL", { url: undefined }],
    ["missing slug", { site: { slug: undefined } }],
    ["empty slug", { site: { slug: "" } }],
    ["non-string slug", { site: { slug: 123 } }],
  ])("rejects a successful HTTP receipt with %s and preserves the unchanged retry", async (_case, invalid) => {
    let attempts = 0;
    const view = await visit(async () => response(++attempts === 1
      ? { ...fixture.destinationResponse, ...invalid, ...("site" in invalid ? { site: { ...fixture.destinationResponse.site, ...invalid.site } } : {}) }
      : fixture.destinationResponse));
    const form = open(view);
    enter(form);
    form.submit.click();
    await until(() => /retry|try again|reload|check/i.test(announcements(view)), "invalid receipt announces actionable recovery");
    noGuessedSuccess(view);
    expect(announcements(view)).not.toMatch(/successfully|duplicate created|site duplicated|copy created/i);
    expect(links(view).filter(link => {
      const href = link.getAttribute("href") ?? "";
      return /^(?:javascript|data):/i.test(href) || href.includes("dashboard-returned-copy") || href.includes("/dashboard/sites/123");
    }), "invalid response supplies neither a live link nor a destination management link").toEqual([]);
    expect(form.destination.value).toBe("requested-copy");
    expect(form.message.value).toBe("Snapshot for a colleague");
    expect(form.submit.disabled).toBe(false);
    assertDuplicateOnly(view, 1);
    const first = mutations(view.wire)[0]!;
    form.submit.click();
    await expectReceipt(view);
    assertDuplicateOnly(view, 2);
    const retry = mutations(view.wire)[1]!;
    expect(retry.path).toBe(first.path);
    expect(retry.body).toBe(first.body);
    expect(retry.headers.get("Idempotency-Key")).toBe(first.headers.get("Idempotency-Key"));
  });

  it.each(["slug", "message"] as const)("replaces the idempotency key when the %s changes after a refusal", async changed => {
    const view = await visit(async () => refusal("slug_taken", "Change the destination and retry."));
    const form = open(view);
    enter(form);
    form.submit.click();
    await until(() => announcements(view).includes("Change the destination and retry."), "first refusal settles");
    const first = mutations(view.wire)[0]!;
    fill(changed === "slug" ? form.destination : form.message, changed === "slug" ? "different-copy" : "A different message");
    form.submit.click();
    await until(() => mutations(view.wire).length === 2, "changed submission is sent");
    assertDuplicateOnly(view, 2);
    expect(mutations(view.wire)[1]!.headers.get("Idempotency-Key")).not.toBe(first.headers.get("Idempotency-Key"));
    expect(JSON.parse(mutations(view.wire)[1]!.body)).toEqual(changed === "slug"
      ? { newSlug: "different-copy", message: "Snapshot for a colleague" }
      : { newSlug: "requested-copy", message: "A different message" });
  });

  it("renders server-supplied error text literally, including the actionable hint", async () => {
    const hint = '<img src=x onerror="alert(1)"> Choose a different slug & retry.';
    const view = await visit(async () => refusal("slug_reserved", hint));
    const form = open(view);
    enter(form);
    form.submit.click();
    await until(() => announcements(view).includes(hint), "untrusted hint stays readable plain text");
    expect(find(view.doc.body, node => node.tag === "img" || node.hasAttribute("onerror"))).toEqual([]);
    noGuessedSuccess(view);
  });

  it("uses returned destination identity for both receipt links and any navigation", async () => {
    const before = await fixture.snapshot();
    const view = await visit(async () => response(fixture.destinationResponse));
    const form = open(view);
    enter(form, "requested-copy", '<script>alert("message")</script>');
    form.submit.click();
    await expectReceipt(view);
    assertDuplicateOnly(view, 1);
    expect(find(view.doc.body, node => node.tag === "script" && node.id !== "dw-boot")).toEqual([]);
    expect(view.errors).toEqual([]);
    expect(await fixture.snapshot()).toEqual(before);
  });

  it("duplicates through the real Worker and leaves the original live identity, manifest and settings unchanged", async () => {
    const before = await fixture.snapshot();
    const view = await visit(call => fixture.request(call.path, { method: call.method, headers: call.headers, body: call.body }));
    const form = open(view);
    enter(form, "dashboard-live-copy", "Literal dashboard copy");
    form.submit.click();
    await until(() => links(view).some(link => link.getAttribute("href") === `${fixture.origin}/s/dashboard-live-copy/`), "real Worker duplicate returns a live copy receipt");
    assertDuplicateOnly(view, 1);
    expect(await fixture.snapshot()).toEqual(before);
    const copy = (await fixture.json("/api/v1/sites/dashboard-live-copy")).site;
    expect(copy.slug).toBe("dashboard-live-copy");
    expect(copy.slug).not.toBe(before.site.slug);
    expect(before.site.currentVersionId).toMatch(/\S+/);
    expect(copy.currentVersionId).toMatch(/\S+/);
    expect(copy.currentVersionId).not.toBe(before.site.currentVersionId);
    expect(copy.settings).toMatchObject({ spa: true, passwordProtected: false });
    expect(copy.currentVersion.message).toBe("Literal dashboard copy");
    expect(view.navigation.every(url => new URL(url, fixture.origin).pathname === "/dashboard/sites/dashboard-live-copy")).toBe(true);
  });
});
