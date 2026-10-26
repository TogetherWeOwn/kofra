/** Implementer-owned regression coverage; protected dashboard fixtures are imported read-only. */
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { Route } from "playwright";
import {
  announcements, api, closeViews, deferred, fillAndSubmit, frame, hrefs, open, origin,
  proposed, ready, renameForm, start, stop, submit, visibleText, type View,
} from "./dashboard-rename.helpers";

beforeAll(start, 120_000);
const pendingViews: View[] = [];
afterEach(async () => {
  for (const view of pendingViews.splice(0)) {
    view.gate?.resolve();
    await view.context.unrouteAll({ behavior: "wait" });
  }
  await closeViews();
});
afterAll(stop);

// Let settings PATCHes reach the disposable Worker without changing the protected
// fixture's normal rename/delete-only mutation allowlist.
async function allowSettings(view: View, gate?: ReturnType<typeof deferred>) {
  pendingViews.push(view);
  await view.context.route(`${origin}/api/v1/sites/${view.site.slug}`, async route => {
    const request = route.request();
    if (request.method() !== "PATCH") return route.fallback();
    view.writes.push({ method: "PATCH", path: new URL(request.url()).pathname, query: "",
      body: request.postData(), authenticated: !!request.headers().authorization });
    if (gate) await gate.promise;
    await route.continue();
  });
}

// A second published version leaves v1 non-live, so Restore/Delete version render.
async function publishSecondVersion(view: View) {
  const data = new FormData();
  data.set("slug", view.site.slug);
  data.append("index.html", new File(["<h1>Second disposable version</h1>"], "index.html", { type: "text/html" }));
  await api("/api/v1/publish", { method: "POST", body: data });
  await view.page.reload({ waitUntil: "networkidle" });
  await ready(view);
}

// Let version restore/delete reach the disposable Worker (or a held failure)
// without changing the protected fixture's rename/delete-only allowlist.
async function allowVersionMutation(view: View, handle: (route: Route) => Promise<void>) {
  pendingViews.push(view);
  await view.context.route(`${origin}/api/v1/sites/${view.site.slug}/versions/**`, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const isRestore = request.method() === "POST" && path.endsWith("/restore");
    const isDelete = request.method() === "DELETE" && /^\/api\/v1\/sites\/[^/]+\/versions\/[^/]+$/.test(path);
    if (!isRestore && !isDelete) return route.fallback();
    view.writes.push({ method: request.method(), path, query: "",
      body: request.postData(), authenticated: !!request.headers().authorization });
    await handle(route);
  });
}

// Break: settings save clears the pending rename's form and detaches its refusal.
it("keeps a pending rename proposal and refusal visible when settings are submitted", async () => {
  const gate = deferred();
  const view = await open({ rename: async route => {
    await gate.promise;
    await route.fulfill({ status: 409, contentType: "application/json",
      body: JSON.stringify({ error: { code: "slug_taken", message: "Race proposal was taken.", hint: "Choose another name." } }) });
  } });
  view.gate = gate;
  const data = new FormData();
  data.set("slug", view.site.slug);
  data.append("index.html", new File(["<h1>Second disposable version</h1>"], "index.html", { type: "text/html" }));
  await api("/api/v1/publish", { method: "POST", body: data });
  await api(`/api/v1/sites/${view.site.slug}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "disposable-site-password" }) });
  await view.page.reload({ waitUntil: "networkidle" });
  await allowSettings(view);
  await ready(view);
  const before = await hrefs(view);
  await fillAndSubmit(view, "race-proposal");
  await expect.poll(() => view.writes.length).toBe(1);
  const save = view.page.getByRole("button", { name: "Save settings", exact: true });
  expect(await save.isDisabled(), "settings cannot retire an outstanding rename form").toBe(true);
  for (const name of ["Remove password", "Restore", "Delete version 1", "Delete site"]) {
    const button = view.page.getByRole("button", { name, exact: true });
    expect(await button.count(), `${name} is present in the real fixture`).toBe(1);
    expect(await button.isDisabled(), `${name} waits for the rename`).toBe(true);
    await button.dispatchEvent("click");
  }
  // A submit event must also be guarded, not merely a disabled click target.
  await view.page.locator("#dw-s-title").evaluate(node => (node as any).form!.requestSubmit());
  await frame(view);
  expect(view.writes).toHaveLength(1);
  expect(await proposed(view).inputValue()).toBe("race-proposal");
  expect(await hrefs(view)).toEqual(before);
  gate.resolve();
  await expect.poll(() => visibleText(announcements(view))).toContain("Race proposal was taken.");
  expect(await proposed(view).inputValue()).toBe("race-proposal");
  expect(await hrefs(view)).toEqual(before);
  await expect.poll(() => save.isEnabled()).toBe(true);
  expect(await submit(view).isEnabled()).toBe(true);
  await view.page.getByRole("textbox", { name: "Title", exact: true }).fill("Saved after refusal");
  await save.click();
  await expect.poll(() => view.page.getByRole("heading", { name: "Saved after refusal", exact: true }).count()).toBe(1);
  expect(view.writes.map(write => write.method)).toEqual(["POST", "PATCH"]);
  view.expectedWrites = 2;
});

// Break: cancelling a destructive confirmation leaves rename locked or loses keyboard focus.
it("releases the mutation lock and restores focus when deletion is cancelled", async () => {
  const view = await open();
  await ready(view);
  const deletion = view.page.getByRole("button", { name: "Delete site", exact: true });
  await deletion.click();
  expect(await submit(view).isDisabled()).toBe(true);
  await proposed(view).evaluate(node => { (node as any).value = "must-not-start-in-dialog"; });
  await renameForm(view).evaluate(node => (node as any).requestSubmit());
  expect(view.writes).toEqual([]);
  await view.page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => submit(view).isEnabled()).toBe(true);
  expect(await deletion.evaluate(node => node === (globalThis as any).document.activeElement), "keyboard focus returns to the destructive trigger").toBe(true);
  expect(view.writes).toEqual([]);
  await fillAndSubmit(view, "renamed-after-cancel");
  await expect.poll(() => view.page.getByRole("heading", { name: "Renamed to renamed-after-cancel", exact: true }).count()).toBe(1);
  view.expectedWrites = 1;
});

// Break: a settings request that started first finishes over a newer rename.
it("does not start a rename until the outstanding settings save has settled", async () => {
  const view = await open();
  const gate = deferred();
  view.gate = gate;
  await allowSettings(view, gate);
  await ready(view);
  await view.page.getByRole("textbox", { name: "Title", exact: true }).fill("Settings finished first");
  await view.page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect.poll(() => view.writes.length).toBe(1);
  expect(await submit(view).isDisabled(), "rename waits for the settings mutation").toBe(true);
  await proposed(view).fill("must-not-start-yet");
  await renameForm(view).evaluate(node => (node as any).requestSubmit());
  await frame(view);
  expect(view.writes.map(write => write.method)).toEqual(["PATCH"]);
  gate.resolve();
  await expect.poll(() => view.page.getByRole("heading", { name: "Settings finished first", exact: true }).count()).toBe(1);
  expect(await submit(view).isEnabled()).toBe(true);
  await fillAndSubmit(view, "settings-then-renamed");
  await expect.poll(() => view.page.getByRole("heading", { name: "Renamed to settings-then-renamed", exact: true }).count()).toBe(1);
  expect(view.writes.map(write => write.method)).toEqual(["PATCH", "POST"]);
  view.expectedWrites = 2;
});

// Break: a Restore started first leaves rename enabled, so its pages.site()
// reload detaches the outstanding rename's proposal and refusal. The first
// held restore fails (controls must recover in place); the retry succeeds.
it("does not start a rename until the outstanding version restore has settled", async () => {
  const view = await open();
  await publishSecondVersion(view);
  const gate = deferred();
  view.gate = gate;
  let restores = 0;
  await allowVersionMutation(view, async route => {
    restores++;
    if (restores > 1) return route.continue();
    await gate.promise;
    await route.fulfill({ status: 500, contentType: "application/json",
      body: JSON.stringify({ error: { code: "restore_probe", message: "Restore probe failed.", hint: "Retry the restore." } }) });
  });
  const before = await hrefs(view);
  const restore = view.page.getByRole("button", { name: "Restore", exact: true });
  expect(await restore.count(), "Restore is present for the non-live version").toBe(1);
  await restore.click();
  await expect.poll(() => view.writes.length).toBe(1);
  expect(view.writes[0]!.path).toMatch(/\/versions\/[^/]+\/restore$/);
  expect(await submit(view).isDisabled(), "rename waits for the restore").toBe(true);
  await proposed(view).fill("must-not-start-yet");
  await renameForm(view).evaluate(node => (node as any).requestSubmit());
  await frame(view);
  expect(view.writes, "forced submit sends no rename while the restore is outstanding").toHaveLength(1);
  expect(await hrefs(view)).toEqual(before);
  gate.resolve();
  await expect.poll(() => visibleText(announcements(view))).toContain("Restore probe failed.");
  await expect.poll(() => submit(view).isEnabled()).toBe(true);
  expect(await proposed(view).inputValue(), "a failed restore preserves the proposal").toBe("must-not-start-yet");
  expect(await hrefs(view)).toEqual(before);
  await restore.click();
  await expect.poll(async () => (await proposed(view).count()) === 1 && (await proposed(view).inputValue()) === "",
    { message: "the completed restore reloads a fresh, enabled settings page" }).toBe(true);
  await fillAndSubmit(view, "restore-then-renamed");
  await expect.poll(() => view.page.getByRole("heading", { name: "Renamed to restore-then-renamed", exact: true }).count()).toBe(1);
  expect(view.writes.map(write => write.method)).toEqual(["POST", "POST", "POST"]);
  expect(view.writes[2]!.path).toBe(`/api/v1/sites/${view.site.slug}/rename`);
  view.expectedWrites = 3;
});

// Break: Delete version acquires the lock before its confirmation, so neither
// the open dialog nor the held confirmed DELETE may let a rename start. The
// cancel must release the lock and restore trigger focus.
it("does not start a rename while a version deletion is open or outstanding", async () => {
  const view = await open();
  await publishSecondVersion(view);
  const gate = deferred();
  view.gate = gate;
  await allowVersionMutation(view, async route => {
    await gate.promise;
    await route.continue();
  });
  const deletion = view.page.getByRole("button", { name: "Delete version 1", exact: true });
  expect(await deletion.count(), "Delete version is present for the non-live version").toBe(1);
  await deletion.click();
  await expect.poll(() => view.page.getByRole("dialog").count()).toBe(1);
  expect(await submit(view).isDisabled(), "rename waits while the deletion confirmation is open").toBe(true);
  await proposed(view).evaluate(node => { (node as any).value = "must-not-start-in-dialog"; });
  await renameForm(view).evaluate(node => (node as any).requestSubmit());
  await frame(view);
  expect(view.writes).toEqual([]);
  await view.page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => submit(view).isEnabled()).toBe(true);
  expect(await deletion.evaluate(node => node === (globalThis as any).document.activeElement), "keyboard focus returns to the version-delete trigger").toBe(true);
  expect(view.writes).toEqual([]);
  const before = await hrefs(view);
  await deletion.click();
  await expect.poll(() => view.page.getByRole("dialog").count()).toBe(1);
  await view.page.getByRole("dialog").getByRole("button", { name: "Delete version", exact: true }).click();
  await expect.poll(() => view.writes.length).toBe(1);
  expect(view.writes[0]!.method).toBe("DELETE");
  expect(view.writes[0]!.path).toMatch(/\/versions\/[^/]+$/);
  expect(await submit(view).isDisabled(), "rename waits for the confirmed version deletion").toBe(true);
  await renameForm(view).evaluate(node => (node as any).requestSubmit());
  await frame(view);
  expect(view.writes, "forced submit sends no rename while the DELETE is outstanding").toHaveLength(1);
  expect(await hrefs(view)).toEqual(before);
  gate.resolve();
  await expect.poll(async () => (await proposed(view).count()) === 1 && (await proposed(view).inputValue()) === "",
    { message: "the completed deletion reloads a fresh, enabled settings page" }).toBe(true);
  expect(await deletion.count(), "the deleted version's action is gone after the reload").toBe(0);
  await fillAndSubmit(view, "delete-version-then-renamed");
  await expect.poll(() => view.page.getByRole("heading", { name: "Renamed to delete-version-then-renamed", exact: true }).count()).toBe(1);
  expect(view.writes.map(write => write.method)).toEqual(["DELETE", "POST"]);
  expect(view.writes[1]!.path).toBe(`/api/v1/sites/${view.site.slug}/rename`);
  view.expectedWrites = 2;
});
