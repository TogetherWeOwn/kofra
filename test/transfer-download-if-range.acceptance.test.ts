import { beforeEach, describe, expect, it } from "vitest";
import type { Instance } from "./helpers";
import { cookies, create, get, instance, recipientFile, siteFile } from "./transfer-fixtures";

let dw: Instance;
beforeEach(async () => { dw = await instance(); });

const invalidValidators = [
  { name: "stale strong", value: '"a-different-representation"' },
  { name: "weak", value: 'W/"a-different-representation"' },
  { name: "unquoted", value: "not-an-entity-tag" },
  { name: "unterminated", value: '"unterminated' },
  { name: "multiple entity tags", value: '"first", "second"' },
] as const;

describe("limited downloads use representation validators for HTTP resumption", () => {
  it("exposes the same stable strong validator on full, partial, recipient and HEAD responses", async () => {
    const t = await create(dw, { downloadLimit: 4 });
    const recipient = await recipientFile(dw, t, 0);
    const full = await dw.call(siteFile(t));
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("transfer sample bytes");
    const validator = full.headers.get("ETag");
    expect(validator, "If-Range needs a strong representation validator, not an absent or weak tag").toEqual(expect.stringMatching(/^"[^"\r\n]+"$/));
    for (const url of [siteFile(t), recipient]) {
      const partial = await dw.call(url, { headers: { Range: "bytes=0-7" } });
      expect(partial.status).toBe(206);
      expect(await partial.text()).toBe("transfer");
      expect(partial.headers.get("ETag")).toBe(validator);
    }
    const head = await dw.call(siteFile(t), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("ETag")).toBe(validator);
    expect(await head.text()).toBe("");
    expect((await get(dw, t)).files.map((f) => f.downloads)).toEqual([3, 0]);
  });

  it("reconstructs exact bytes with a matching If-Range after the counted allowance is exhausted", async () => {
    // Deterministic HTTP coverage, NOT a browser-managed interruption/resume.
    const t = await create(dw, { downloadLimit: 1 });
    const url = await recipientFile(dw, t, 0);
    const start = await dw.call(url, { headers: { Range: "bytes=0-7" } });
    expect(start.status).toBe(206);
    const prefix = new Uint8Array(await start.arrayBuffer());
    const validator = start.headers.get("ETag");
    expect(validator).toEqual(expect.stringMatching(/^"[^"\r\n]+"$/));
    const resumed = await dw.call(url, { headers: { Range: "bytes=8-", "If-Range": validator!, Cookie: cookies(start) } });
    expect(resumed.status).toBe(206);
    expect(resumed.headers.get("Content-Range")).toBe("bytes 8-20/21");
    expect(resumed.headers.get("ETag")).toBe(validator);
    expect(resumed.headers.get("Set-Cookie")).toBeNull();
    const suffix = new Uint8Array(await resumed.arrayBuffer());
    expect([...prefix, ...suffix]).toEqual([...new TextEncoder().encode("transfer sample bytes")]);
    const saved = await get(dw, t);
    expect(saved.files.map((f) => f.downloads)).toEqual([1, 0]);
    expect(saved.recipients.map((r) => r.downloads)).toEqual([1]);
  });

  it.each(invalidValidators)("counts a full fallback for a $name If-Range while one start remains", async ({ value }) => {
    const t = await create(dw, { downloadLimit: 2 });
    const url = await recipientFile(dw, t, 0);
    const start = await dw.call(url, { headers: { Range: "bytes=0-7" } });
    expect(start.status).toBe(206);
    expect(await start.text()).toBe("transfer");
    const fallback = await dw.call(url, { headers: { Range: "bytes=8-", "If-Range": value, Cookie: cookies(start) } });
    expect.soft(fallback.status, "an unusable If-Range means a full representation, never the requested suffix").toBe(200);
    expect.soft(fallback.headers.get("Content-Range")).toBeNull();
    expect.soft(await fallback.text()).toBe("transfer sample bytes");
    const saved = await get(dw, t);
    expect.soft(saved.files.map((f) => f.downloads)).toEqual([2, 0]);
    expect(saved.recipients.map((r) => r.downloads)).toEqual([2]);
  });

  it.each(invalidValidators)("refuses a $name If-Range full fallback after exhaustion even with a valid continuation", async ({ value }) => {
    const t = await create(dw, { downloadLimit: 1 });
    const url = siteFile(t);
    const start = await dw.call(url, { headers: { Range: "bytes=0-7" } });
    expect(start.status).toBe(206);
    expect(await start.text()).toBe("transfer");
    const refused = await dw.call(url, { headers: { Range: "bytes=8-", "If-Range": value, Cookie: cookies(start) } });
    expect.soft(refused.status, "a continuation cannot authorize the full-download fallback").toBe(410);
    expect.soft(await refused.text()).not.toBe(" sample bytes");
    expect(refused.headers.get("Set-Cookie")).toBeNull();
    expect((await get(dw, t)).files.map((f) => f.downloads)).toEqual([1, 0]);
  });

  it("never treats a weak form of the current validator as an If-Range match", async () => {
    const t = await create(dw, { downloadLimit: 1 });
    const start = await dw.call(siteFile(t), { headers: { Range: "bytes=0-7" } });
    expect(start.status).toBe(206);
    await start.text();
    const validator = start.headers.get("ETag");
    expect(validator).toEqual(expect.stringMatching(/^"[^"\r\n]+"$/));
    const refused = await dw.call(siteFile(t), { headers: { Range: "bytes=8-", "If-Range": `W/${validator}`, Cookie: cookies(start) } });
    expect(refused.status).toBe(410);
    expect(await refused.text()).not.toBe(" sample bytes");
    expect((await get(dw, t)).files.map((f) => f.downloads)).toEqual([1, 0]);
  });
});
