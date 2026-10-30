import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody } from "./helpers";
import { b64 } from "./mcp-helpers";
import { create, instance, PASSWORD } from "./transfer-fixtures";

// An explicit ?theme= survives image Previous/Next and the delivery password retry/unlock.

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
const png = (tag: number) => b64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 8, 0, 0, 0, 8, 8, 2, 0, 0, 0, tag]));
const attr = (html: string, re: RegExp) => (re.exec(html)?.[1] ?? "").replace(/&amp;/g, "&");

describe("image folder navigation keeps an explicit mode", () => {
  it("keeps ?theme= on Previous/Next in an explicit mode and adds nothing in Auto", async () => {
    const dw = await freshInstance();
    const res = await dw.json("/api/v1/publish", { key: dw.ownerKey, ...jsonBody({ slug: "pics", files: [
      { path: "a.png", content: png(1), encoding: "base64" },
      { path: "b.png", content: png(2), encoding: "base64" },
    ] }) });
    expect([200, 201]).toContain(res.status);

    const auto = await (await dw.call("/s/pics/a.png", { headers: NAV })).text();
    expect(attr(auto, /<a [^>]*rel="next" href="([^"]*)"/)).toBe("/s/pics/b.png");

    const dark = await (await dw.call("/s/pics/a.png?theme=dark", { headers: NAV })).text();
    const next = attr(dark, /<a [^>]*rel="next" href="([^"]*)"/);
    expect(next).toBe("/s/pics/b.png?theme=dark");
    const landed = await (await dw.call(next, { headers: NAV })).text();
    expect(landed).toMatch(/<html[^>]*data-theme="dark"/);
    expect(attr(landed, /<a [^>]*rel="prev" href="([^"]*)"/)).toBe("/s/pics/a.png?theme=dark");
  });
});

describe("delivery password page keeps an explicit mode", () => {
  const post = (dw: Awaited<ReturnType<typeof instance>>, action: string, password: string) => dw.call(action, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html", Origin: new URL(action).origin, "CF-Connecting-IP": "192.0.2.77" },
    body: new URLSearchParams({ password }),
    redirect: "manual",
  });

  it("carries ?theme= into the retry form and the unlock redirect, keeping the recipient", async () => {
    const dw = await instance();
    const t = await create(dw, { slug: "themed-parcel", password: PASSWORD });
    const page = new URL(t.recipients[0]!.url);
    const token = page.searchParams.get("recipient");
    page.searchParams.set("theme", "dark");

    const first = await (await dw.call(page.href, { headers: { Accept: "text/html" } })).text();
    const action = new URL(attr(first, /<form method="post" action="([^"]*)"/));
    expect(action.searchParams.get("theme")).toBe("dark");
    expect(action.searchParams.get("recipient")).toBe(token);

    const wrong = await post(dw, action.href, "not-the-delivery-password");
    expect(wrong.status).toBe(403);
    const retry = await wrong.text();
    expect(retry).toMatch(/<html[^>]*data-theme="dark"/);
    expect(new URL(attr(retry, /<form method="post" action="([^"]*)"/)).searchParams.get("theme")).toBe("dark");

    const ok = await post(dw, action.href, PASSWORD);
    expect(ok.status).toBe(303);
    const to = new URL(ok.headers.get("location")!);
    expect([to.searchParams.get("theme"), to.searchParams.get("recipient")]).toEqual(["dark", token]);
  });

  it("adds nothing in Auto and ignores an unknown theme value", async () => {
    const dw = await instance();
    const t = await create(dw, { slug: "plain-parcel", password: PASSWORD });
    for (const q of ["", "&theme=sepia%22", "&theme=auto"]) {
      const html = await (await dw.call(t.url + (t.url.includes("?") ? q : q.replace("&", "?")), { headers: { Accept: "text/html" } })).text();
      expect(new URL(attr(html, /<form method="post" action="([^"]*)"/)).searchParams.has("theme")).toBe(false);
    }
  });
});
