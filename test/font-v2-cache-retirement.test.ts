import { beforeAll, describe, expect, it } from "vitest";
import { form, freshInstance, type Instance } from "./helpers";
import { fontSpecimenBytes, FONT_SPECIMEN_PATH, FONT_SPECIMEN_SHA256 } from "./fixtures/font-specimen";

const NAV = { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" };
let dw: Instance;
let url: string;

beforeAll(async () => {
  dw = await freshInstance();
  const published = await dw.json("/api/v1/publish", {
    method: "POST", key: dw.ownerKey, body: form({ [FONT_SPECIMEN_PATH]: fontSpecimenBytes() }),
  });
  expect(published.status).toBe(201);
  url = `/s/${published.body.slug}/${FONT_SPECIMEN_PATH.split("/").map(encodeURIComponent).join("/")}`;
});

describe("deployed font@2 cache retirement", () => {
  for (const [variant, suffix] of [["full", ""], ["embed", "?view=1&embed=1"]] as const) {
    it(`returns the changed ${variant} specimen instead of a 304 for its deployed validator`, async () => {
      const current = await dw.call(url + suffix, { headers: NAV });
      expect(current.status).toBe(200);
      const tag = current.headers.get("etag");
      const match = tag?.match(/^W\/"font@(\d+)-([a-f0-9]{64})(-folder[A-Za-z0-9_-]+)?(-e)?"$/);
      expect(match).not.toBeNull();
      expect(match![2]).toBe(FONT_SPECIMEN_SHA256);
      expect(match![4] ?? "").toBe(variant === "embed" ? "-e" : "");
      // Keep the folder version suffix: it was already part of deployed full-page tags.
      const deployedTag = `W/"font@2-${FONT_SPECIMEN_SHA256}${match![3] ?? ""}${match![4] ?? ""}"`;
      const response = await dw.call(url + suffix, { headers: { ...NAV, "If-None-Match": deployedTag } });
      expect(response.status).toBe(200);
      expect(Number(match![1])).toBeGreaterThan(2);
      expect(response.headers.get("etag")).toBe(tag);
      expect((await response.text()).length).toBeGreaterThan(0);
    });
  }
});
