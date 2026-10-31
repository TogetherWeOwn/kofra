import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { CLIENT_SCRIPT } from "../src/ui/assets";
import { localRedirectPath } from "../src/local-redirect";

const ORIGIN = "https://kofra.test";

/** `next` values (already URL-decoded once, as URLSearchParams returns them) that must not leave the origin. */
const OFF_ORIGIN = [
  "//attacker.test/",
  "/\\attacker.test/",
  "\\\\attacker.test/",
  "/\t/attacker.test/",
  "/\n\\attacker.test/",
  "/\r//attacker.test/",
  "/\x00/attacker.test/",
  "https://attacker.test/",
  "HTTPS://attacker.test/",
  "https:attacker.test",
  "//kofra.test@attacker.test/",
  "javascript:alert(1)",
  " //attacker.test/",
  "%2F%2Fattacker.test/",
  "%2f%5cattacker.test/",
  "",
];

/** Encoded separators stay inside the path: browsers do not decode them into an authority. */
const LOCAL: [string, string][] = [
  ["/dashboard/sites?tab=files", "/dashboard/sites?tab=files"],
  ["/dashboard#keys", "/dashboard#keys"],
  ["/%2F%2Fattacker.test/", "/%2F%2Fattacker.test/"],
  ["/%5Cattacker.test/", "/%5Cattacker.test/"],
];

async function login(next: string): Promise<string> {
  let submit!: (event: { preventDefault(): void }) => Promise<void>;
  const button = { disabled: false };
  const form = {
    elements: { key: { value: "dw_test" }, remember: { checked: false } },
    addEventListener(_type: string, callback: typeof submit) { submit = callback; },
    querySelector() { return button; },
  };
  const output = { firstChild: null };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const location = { search: `?next=${encodeURIComponent(next)}`, origin: ORIGIN, href: `${ORIGIN}/login` };
  const document = {
    body: { getAttribute: () => "login" },
    getElementById(id: string) {
      if (id === "dw-boot") return { textContent: JSON.stringify({ api: "/api/v1" }) };
      if (id === "dw-signin") return form;
      if (id === "dw-signin-out") return output;
      return null;
    },
    querySelectorAll: () => [],
  };
  vm.runInNewContext(CLIENT_SCRIPT, {
    document, location, window: { localStorage: storage, sessionStorage: storage },
    URL, URLSearchParams, Headers, Blob,
    fetch: async () => new Response(JSON.stringify({ principal: "member" }), { status: 200 }),
  });
  await submit({ preventDefault() {} });
  return location.href;
}

describe("login redirect security (browser sign-in)", () => {
  it.each(OFF_ORIGIN)("does not navigate to an attacker-controlled origin for %j", async (next) => {
    expect(await login(next)).toBe("/dashboard");
  });
  it.each(LOCAL)("keeps the local path %j", async (next, expected) => {
    expect(await login(next)).toBe(expected);
  });
});

describe("localRedirectPath (server redirects)", () => {
  it.each(OFF_ORIGIN)("refuses %j", (next) => {
    expect(localRedirectPath(next, ORIGIN)).toBeNull();
  });
  it.each(LOCAL)("keeps the local path %j", (next, expected) => {
    expect(localRedirectPath(next, ORIGIN)).toBe(expected);
  });
  it("refuses missing values", () => {
    expect(localRedirectPath(null, ORIGIN)).toBeNull();
    expect(localRedirectPath(undefined, ORIGIN)).toBeNull();
  });
  it("keeps redirects under the site base, after dot-segments are resolved", () => {
    expect(localRedirectPath("/s/mine/page?x=1", ORIGIN, "/s/mine/")).toBe("/s/mine/page?x=1");
    expect(localRedirectPath("/s/theirs/", ORIGIN, "/s/mine/")).toBeNull();
    expect(localRedirectPath("/s/mine/../theirs/", ORIGIN, "/s/mine/")).toBeNull();
    expect(localRedirectPath("/s/mine/%2e%2e/theirs/", ORIGIN, "/s/mine/")).toBeNull();
  });
});
