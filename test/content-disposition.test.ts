import { describe, expect, it } from "vitest";
import { attachmentDisposition } from "../packages/server/src/content-disposition";

describe("attachmentDisposition", () => {
  it("keeps pure-ASCII names byte-identical to the historical single-parameter form", () => {
    expect(attachmentDisposition("report.pdf")).toBe('attachment; filename="report.pdf"');
  });

  it("emits an ASCII fallback plus RFC 5987 filename* for non-ASCII names", () => {
    expect(attachmentDisposition("café.js")).toBe(
      'attachment; filename="caf_.js"; filename*=UTF-8\'\'caf%C3%A9.js',
    );
  });

  it("always emits filename* for transfers, even for ASCII names", () => {
    expect(attachmentDisposition("report.pdf", { alwaysExtended: true })).toBe(
      "attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
    );
  });

  it("neutralizes quoted-string breakers and controls in the fallback", () => {
    const header = attachmentDisposition('a"b\\c\nd.txt');
    expect(header).toBe(
      "attachment; filename=\"a_b_c_d.txt\"; filename*=UTF-8''a%22b%5Cc%0Ad.txt",
    );
    expect(header).not.toMatch(/[\r\n]/);
  });

  it("normalizes lone surrogates to U+FFFD instead of throwing", () => {
    expect(attachmentDisposition("a\uD800b.txt")).toBe(
      'attachment; filename="a_b.txt"; filename*=UTF-8\'\'a%EF%BF%BDb.txt',
    );
    expect(attachmentDisposition("a\uDC00b.txt")).toBe(
      'attachment; filename="a_b.txt"; filename*=UTF-8\'\'a%EF%BF%BDb.txt',
    );
  });

  it("preserves valid surrogate pairs (emoji) in filename*", () => {
    expect(attachmentDisposition("😀.txt")).toBe(
      'attachment; filename="__.txt"; filename*=UTF-8\'\'%F0%9F%98%80.txt',
    );
  });
});
