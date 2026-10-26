import { describe, expect, it } from "vitest";
import { type Viewer } from "@dropway/server";
import { form, freshInstance } from "./helpers";

// RFC 9110 entity-tag: quotes delimit the opaque tag; embedded quotes, controls
// and code points outside obs-text cannot appear inside it.
const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/;

describe("extension viewer ETag contract", () => {
  it.each([
    { name: "ordinary identity", extra: "revision-1", changed: "revision-2" },
    { name: "quote", extra: 'quote"value', changed: "quote%22value" },
    { name: "CR/LF", extra: "line\r\nbreak", changed: "line%0D%0Abreak" },
    { name: "percent", extra: "100%", changed: "100%25" },
    { name: "Unicode", extra: "café雪", changed: "caf%C3%A9%E9%9B%AA" },
    { name: "combined characters", extra: 'quote"\r\n100%雪', changed: "quote%22%0D%0A100%25%E9%9B%AA" },
  ])("renders and revalidates $name without losing extra identity", async ({ extra, changed }) => {
    let identity = extra;
    const viewer: Viewer = {
      id: "contract-etag", version: 1, maxBytes: 1024,
      matches: (file) => file.path === "fixture.txt",
      etagExtra: () => identity,
      async render(context) {
        return new Response(`Contract view: ${await context.readText()} / ${identity}`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      },
    };
    const dw = await freshInstance({}, { viewers: [viewer] });
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({ "fixture.txt": "hello" }, { slug: "extension-etag" }),
    });
    expect(published.status).toBe(201);

    const path = "/s/extension-etag/fixture.txt?view=1";
    const first = await dw.call(path);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-kofra-viewer")).toBe("contract-etag");
    expect(await first.text()).toBe(`Contract view: hello / ${extra}`);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(ENTITY_TAG);

    const unchanged = await dw.call(path, { headers: { "If-None-Match": etag! } });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe(etag);
    expect(await unchanged.text()).toBe("");

    // Literal percent escapes are a different identity, not an already-encoded
    // form of the first one. The file, viewer id and viewer version stay fixed.
    identity = changed;
    const updated = await dw.call(path, { headers: { "If-None-Match": etag! } });
    expect(updated.status).toBe(200);
    expect(await updated.text()).toBe(`Contract view: hello / ${changed}`);
    const nextEtag = updated.headers.get("etag");
    expect(nextEtag).toMatch(ENTITY_TAG);
    expect(nextEtag).not.toBe(etag);
    const revalidated = await dw.call(path, { headers: { "If-None-Match": nextEtag! } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(nextEtag);
  });

  it("keeps a quoted custom viewer id inside one valid entity-tag", async () => {
    const viewer: Viewer = {
      id: 'contract"viewer', version: 1, maxBytes: 1024,
      matches: (file) => file.path === "fixture.txt",
      async render(context) {
        return new Response(`Contract view: ${await context.readText()}`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      },
    };
    const dw = await freshInstance({}, { viewers: [viewer] });
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({ "fixture.txt": "hello" }, { slug: "quoted-viewer" }),
    });
    expect(published.status).toBe(201);
    const path = "/s/quoted-viewer/fixture.txt?view=1";
    const rendered = await dw.call(path);
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("x-kofra-viewer")).toBe('contract"viewer');
    expect(await rendered.text()).toBe("Contract view: hello");
    const etag = rendered.headers.get("etag");
    expect(etag).toMatch(ENTITY_TAG);
    const revalidated = await dw.call(path, { headers: { "If-None-Match": etag! } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
  });

  it("preserves the ordinary built-in code viewer ETag bytes", async () => {
    const dw = await freshInstance();
    const published = await dw.json("/api/v1/publish", {
      method: "POST", key: dw.ownerKey,
      body: form({ "fixture.txt": "hello" }, { slug: "builtin-etag" }),
    });
    expect(published.status).toBe(201);
    const path = "/s/builtin-etag/fixture.txt?view=1";
    const rendered = await dw.call(path);
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("x-kofra-viewer")).toBe("code");
    const etag = 'W/"code@1-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"';
    expect(rendered.headers.get("etag")).toBe(etag);
    const revalidated = await dw.call(path, { headers: { "If-None-Match": etag } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
  });
});
