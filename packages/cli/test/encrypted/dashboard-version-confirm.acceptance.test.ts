import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { base, id, row, slug, startHistoryFixture } from "./loaded-versions-filter.helpers.ts";

let fixture: Awaited<ReturnType<typeof startHistoryFixture>>;
beforeAll(async () => { fixture = await startHistoryFixture(); }, 120_000);
afterEach(async () => { await fixture?.closeViews(); });
afterAll(async () => { await fixture?.dispose(); });

it("the served dashboard cancels without a write and sends the canonical slug on an accepted version delete", async () => {
  const view = await fixture.open();
  const writes: { method: string; path: string; query: string; body: string | null }[] = [];
  await view.context.route(`**${base}/versions/${id(102)}*`, async route => {
    const request = route.request();
    if (request.method() !== "DELETE") return route.fallback();
    const url = new URL(request.url());
    const body = request.postData();
    writes.push({ method: request.method(), path: url.pathname, query: url.search, body });
    const confirmation = url.searchParams.get("confirm") ?? (body ? JSON.parse(body).confirm : undefined);
    if (confirmation !== slug) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "confirmation_required", message: "Confirm the site's slug." } }) });
    view.versions = view.versions.filter(version => version.id !== id(102));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true, id: id(102) }) });
  });
  const button = () => row(view, 102).getByRole("button", { name: /^delete version 102$/i });
  await button().click();
  const dialog = view.page.getByRole("dialog");
  expect(await dialog.innerText()).toContain("Delete v102?");
  await dialog.getByRole("button", { name: /^cancel$/i }).click();
  expect(writes).toEqual([]);
  await button().click();
  await dialog.getByRole("button", { name: /^delete version$/i }).click();
  await expect.poll(() => writes.length).toBe(1);
  const write = writes[0]!;
  expect(write.method).toBe("DELETE");
  expect(write.path).toBe(`${base}/versions/${id(102)}`);
  const query = new URLSearchParams(write.query).get("confirm");
  const body = write.body ? JSON.parse(write.body).confirm : null;
  expect(query ?? body).toBe(slug);
  if (query && body) expect(body).toBe(query);
  await expect.poll(() => row(view, 102).count(), { message: "successful delete refreshes the displayed history" }).toBe(0);
});

it("restoring a version retains its existing no-dialog behavior", async () => {
  const view = await fixture.open();
  view.wire.length = 0;
  await row(view, 102).getByRole("button", { name: /^restore$/i }).click();
  await expect.poll(() => view.wire.filter(request => request.method === "POST").length).toBe(1);
  expect(await view.page.getByRole("dialog").count()).toBe(0);
  expect(view.wire.filter(request => request.method === "POST")[0]!.path).toBe(`${base}/versions/${id(102)}/restore`);
});
