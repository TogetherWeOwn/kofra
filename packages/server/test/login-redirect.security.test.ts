import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { CLIENT_SCRIPT } from "../src/ui/assets";

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
  const location = { search: `?next=${encodeURIComponent(next)}`, href: "https://kofra.test/login" };
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
    URLSearchParams, Headers, Blob,
    fetch: async () => new Response(JSON.stringify({ principal: "member" }), { status: 200 }),
  });
  await submit({ preventDefault() {} });
  return location.href;
}

describe("login redirect security", () => {
  it.each(["//attacker.test/", "/\\attacker.test/", "/\t/attacker.test/", "/\n\\attacker.test/", "javascript:alert(1)"])(
    "does not navigate to an attacker-controlled origin for %j", async (next) => {
      expect(await login(next)).toBe("/dashboard");
    },
  );
  it("preserves a local path and query", async () => {
    expect(await login("/dashboard/sites?tab=files")).toBe("/dashboard/sites?tab=files");
  });
});
