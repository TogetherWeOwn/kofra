import { describe, expect, it } from "vitest";
import {
  boot, copyButton, effects, elements, fallback, file, finalized, fire, flush,
  oneShot, PUBLIC_URL, publish, select, SENTINELS, text, version, visible,
  type Element, type Harness,
} from "./public-receipt.harness";

// Protected independent acceptance contract: copy a PUBLIC publish receipt.
// No production changes belong in this handoff. Builders consume these files
// unchanged; corrections belong to the test author. No exact receipt formatting,
// CSS classes or private function names are prescribed.
//
// Breaks caught: serializing a whole result; using the selected files instead of
// response counts; promoting a signed preview to a public URL; treating the live
// URL as pinned; losing fallback on clipboard error; a late copy completion
// changing a replacement result; copy triggering another mutation or persistence.
// CLIENT_SCRIPT is the real self-contained script served by the Worker, not a
// reimplementation. VM keyboard activation checks DOM prerequisites only, not
// browser focus/selection/permission behavior.

function receipt(h: Harness): { button: Element; area: Element; value: string } {
  expect(h.result.textContent, "control: fixture must reach publish success, not an error screen").toMatch(/live|nothing changed|published/i);
  const button = copyButton(h);
  expect(button, "successful publish must offer Copy public details (separate from Copy URL / claim token)").toBeDefined();
  const area = fallback(h);
  expect(area, "the exact public receipt must remain visible in a selectable fallback").toBeDefined();
  const value = text(area!);
  expect(value.trim(), "fallback must not be empty").not.toBe("");
  return { button: button!, area: area!, value };
}
function noSecrets(value: string): void {
  for (const canary of Object.values(SENTINELS)) expect(value).not.toContain(canary);
}
function count(value: string, label: string, number: string): void {
  // Accept either "Files: 3" or "3 files" without enforcing typography.
  expect(value).toMatch(new RegExp(`(?:${label}[^\\n\\d]*${number}\\b|\\b${number}\\s+${label})`, "i"));
}
function identity(value: string, id = "ver-receipt-exact", n = 17): void {
  expect(value).toContain(id);
  expect(value).toMatch(new RegExp(`(?:version[^\\n]*\\b${n}\\b|\\bv${n}\\b)`, "i"));
}
function feedback(h: Harness): string {
  return elements(h.doc.body).filter((x) => visible(x) &&
    (x.getAttribute("role") === "status" || x.getAttribute("role") === "alert" ||
      ["polite", "assertive"].includes(x.getAttribute("aria-live") ?? "")))
    .map((x) => x.textContent).join("\n");
}
async function complete(options: Parameters<typeof boot>[0] = {}): Promise<Harness> {
  const h = await boot(options);
  await select(h);
  expect(h.publish.disabled, "fixture must reach a publishable selection").toBe(false);
  await publish(h);
  expect(h.result.textContent, "control: successful response must actually render").toContain("receipt-example");
  return h;
}
function tainted() {
  return { apiKey: SENTINELS.api, claimToken: SENTINELS.claim,
    upload: { items: [{ url: "https://upload.example.test/?token=" + SENTINELS.upload, headers: { Authorization: "Bearer " + SENTINELS.upload } }] },
    password: SENTINELS.password, access: { token: SENTINELS.access },
    versionUrl: "https://preview.example.test/?dw_preview=" + SENTINELS.preview,
    localPath: SENTINELS.localPath, debug: SENTINELS.extra };
}

describe("public receipt: real publisher interaction controls", () => {
  it("runs the real served-script publisher through selection and finalize before feature assertions", async () => {
    const h = await complete();
    expect(h.calls.some((x) => /\/deploys$/.test(x.url))).toBe(true);
    expect(h.calls.filter((x) => /\/finalize$/.test(x.url))).toHaveLength(1);
    expect(h.publish.disabled, "completed selection is cleared by the existing publisher").toBe(true);
    expect(h.clipboard).toEqual([]);
    expect(h.permissions).toEqual([]);
  });

  it("keeps the existing anonymous claim-token action explicitly separate (control)", async () => {
    const h = await boot({ anonymous: true, page: "home" });
    h.state.final = { ...finalized(), claimToken: SENTINELS.claim };
    await select(h);
    await publish(h);
    const claim = elements(h.result).find((x) => x.tagName === "button" && /copy claim token/i.test(x.getAttribute("aria-label") ?? x.textContent));
    expect(claim, "existing claim copy must render before feature assertions").toBeDefined();
    expect(h.clipboard).toEqual([]);
    fire(claim!, "click");
    await flush();
    expect(h.clipboard).toEqual([SENTINELS.claim]);
  });

  it("does not offer a public receipt before success or for a refused publish", async () => {
    const h = await boot();
    expect(copyButton(h)).toBeUndefined();
    h.state.fail = true;
    await select(h);
    await publish(h);
    expect(h.result.textContent).not.toContain(PUBLIC_URL);
    expect(copyButton(h)).toBeUndefined();
    expect(h.clipboard).toEqual([]);
  });
});

describe("public receipt: response identity and allowlist", () => {
  it("copies exact response identity and totals, not the one-file eleven-byte selection", async () => {
    const h = await complete();
    const r = receipt(h);
    expect(r.value).toContain(PUBLIC_URL);
    identity(r.value);
    count(r.value, "files?", "3");
    count(r.value, "bytes?", "8,?193");
    expect(r.value).not.toContain("index.html");
    const before = effects(h);
    fire(r.button, "click");
    await flush();
    expect(h.clipboard).toEqual([r.value]);
    expect(text(r.area)).toBe(r.value);
    expect(effects(h), "copy is local: no request, persistence, permission or navigation").toBe(before);
  });

  it("keeps claim-token copy separate and excludes every secret and nonallowlisted field", async () => {
    const h = await boot({ anonymous: true, page: "home" });
    h.state.final = { ...finalized(), ...tainted() };
    await select(h);
    await publish(h);
    const r = receipt(h);
    identity(r.value);
    noSecrets(r.value);
    const before = effects(h);
    fire(r.button, "click");
    await flush();
    expect(h.clipboard).toEqual([r.value]);
    noSecrets(JSON.stringify(h.logs));
    noSecrets(JSON.stringify(h.local.data));
    noSecrets(JSON.stringify(h.session.data));
    expect(effects(h)).toBe(before);
    const claim = elements(h.result).find((x) => x.tagName === "button" && /copy claim token/i.test(x.getAttribute("aria-label") ?? x.textContent));
    expect(claim, "existing separately labelled sensitive control is preserved").toBeDefined();
    fire(claim!, "click");
    await flush();
    expect(h.clipboard, "only explicitly choosing claim-token copy may disclose it").toEqual([r.value, SENTINELS.claim]);
  });

  it("uses the original immutable identity on an unchanged manifest response", async () => {
    const h = await boot();
    h.state.deploy = { unchanged: true, deploy: version("ver-existing", 4),
      missing: [], uploads: [], finalizeUrl: "/api/v1/sites/receipt-example/deploys/ver-existing/finalize", next: [] };
    await select(h);
    await publish(h);
    expect(h.calls.filter((x) => /\/finalize$/.test(x.url)), "unchanged deploy must not finalize again").toHaveLength(0);
    const r = receipt(h);
    identity(r.value, "ver-existing", 4);
    expect(r.value).not.toContain("ver-receipt-exact");
    fire(r.button, "click");
    await flush();
    expect(h.clipboard).toEqual([r.value]);
  });

  it.each([false, true])("supports the one-shot zip response shape (unchanged=%s)", async (unchanged) => {
    const h = await boot();
    h.state.shot = { ...oneShot(version("ver-zip-result", 8)), unchanged, ...tainted() };
    await select(h, [file("bundle.zip", 29)]);
    await publish(h);
    expect(h.calls.filter((x) => /\/publish(?:\?|$)/.test(x.url))).toHaveLength(1);
    const r = receipt(h);
    identity(r.value, "ver-zip-result", 8);
    count(r.value, "files?", "3");
    count(r.value, "bytes?", "8,?193");
    noSecrets(r.value);
    fire(r.button, "click");
    await flush();
    expect(h.clipboard).toEqual([r.value]);
    noSecrets(JSON.stringify(h.logs));
  });

  it("omits missing metadata instead of guessing selection counts or a version number", async () => {
    const h = await boot();
    h.state.final = { live: true, url: PUBLIC_URL, site: { slug: "receipt-example" }, warnings: [] };
    await select(h, [file("selected-but-not-response.html", 997)]);
    await publish(h);
    const r = receipt(h);
    expect(r.value).toContain(PUBLIC_URL);
    expect(r.value).not.toMatch(/\b997\b|selected-but-not-response|ver-receipt-exact|\bv1\b/i);
    expect(r.value).not.toMatch(/files?[^\n\d]*\d|bytes?[^\n\d]*\d|version[^\n\d]*\d/i);
    fire(r.button, "click");
    await flush();
    expect(h.clipboard).toEqual([r.value]);
  });

  it("retains a supplied id but does not invent missing number/counts", async () => {
    const h = await boot();
    h.state.final = finalized({ id: "ver-id-only", status: "ready", live: true });
    await select(h);
    await publish(h);
    const r = receipt(h);
    expect(r.value).toContain("ver-id-only");
    expect(r.value).not.toMatch(/\bv1\b|\b11\s*(?:B|bytes?)\b|files?[^\n\d]*1\b/i);
  });

  it("does not mistake supplied zero totals for missing metadata", async () => {
    const h = await boot();
    h.state.final = finalized({ ...version(), fileCount: 0, totalBytes: 0 });
    await select(h);
    await publish(h);
    const r = receipt(h);
    count(r.value, "files?", "0");
    count(r.value, "bytes?", "0");
  });

  it("treats returned user text as inert and excludes message/title from the minimal receipt", async () => {
    const h = await boot();
    const hostile = '<img src=x onerror="globalThis.receiptInjected=true"> & <script>bad()</script>';
    h.state.final = finalized({ ...version(), message: hostile });
    (h.state.final["site"] as Record<string, unknown>)["title"] = hostile;
    await select(h, [file('<svg onload="bad()">.html', 23)]);
    await publish(h);
    const r = receipt(h);
    expect(r.value).not.toContain(hostile);
    expect(elements(h.result).filter((x) => ["img", "svg", "script"].includes(x.tagName))).toEqual([]);
    identity(r.value);
  });
});

describe("public receipt: public URL and honest scope", () => {
  it.each([
    "https://user:SYNTHETIC_PASSWORD_CANARY@public.example.test/site/",
    PUBLIC_URL + "?dw_preview=" + SENTINELS.preview,
    PUBLIC_URL + "?token=" + SENTINELS.access,
    PUBLIC_URL + "#key=" + SENTINELS.access,
    "javascript:alert('SYNTHETIC_ACCESS_CANARY')",
  ])("omits an unsafe public URL entirely rather than stripping credentials: %s", async (url) => {
    const h = await boot();
    h.state.final = { ...finalized(), url, ...tainted() };
    await select(h);
    await publish(h);
    const r = receipt(h);
    identity(r.value);
    expect(r.value).not.toMatch(/https?:\/\//i);
    noSecrets(r.value);
    fire(r.button, "click");
    await flush();
    expect(h.clipboard).toEqual([r.value]);
  });

  it("does not substitute a signed versionUrl or reconstruct a missing public URL from slug", async () => {
    const h = await boot();
    h.state.final = { ...finalized(), url: undefined, ...tainted() };
    await select(h);
    await publish(h);
    const r = receipt(h);
    identity(r.value);
    expect(r.value).not.toMatch(/https?:\/\//i);
    noSecrets(r.value);
  });

  it("explains live URL mutability, version receipt identity and unchanged access restrictions", async () => {
    const h = await complete();
    receipt(h);
    const explanation = h.result.textContent;
    expect(explanation).toMatch(/(?:live[\s\S]*(?:change|mutable)|(?:change|mutable)[\s\S]*live)/i);
    expect(explanation).toMatch(/version[\s\S]*receipt|receipt[\s\S]*version/i);
    expect(explanation).toMatch(/(?:not|isn't|does not|doesn't|unchanged)[\s\S]*(?:preview|immutable|pinned)/i);
    expect(explanation).toMatch(/(?:access|restriction|password)[\s\S]*(?:unchanged|remain|not|still)|(?:not|still)[\s\S]*(?:access|restriction|password)/i);
  });
});

describe("public receipt: clipboard, AX prerequisites and replacement", () => {
  it("offers a keyboard-reachable copy button, selectable labelled text and accessible success feedback", async () => {
    const h = await complete();
    const r = receipt(h);
    expect(r.button.getAttribute("tabindex")).not.toBe("-1");
    expect(r.button.disabled).toBe(false);
    const labelled = r.area.getAttribute("aria-label") || r.area.getAttribute("aria-labelledby") ||
      elements(h.result).find((x) => x.tagName === "label" && x.getAttribute("for") === r.area.getAttribute("id"))?.textContent;
    expect(labelled, "selectable receipt needs an accessible name").toBeTruthy();
    if (["textarea", "input"].includes(r.area.tagName)) expect(r.area.readOnly).toBe(true);
    else {
      expect(r.area.getAttribute("tabindex"), "static fallback must explicitly enter keyboard tab order").not.toBeNull();
      expect(Number(r.area.getAttribute("tabindex"))).toBeGreaterThanOrEqual(0);
    }
    const before = effects(h);
    fire(r.button, "keydown", { key: "Enter" });
    await flush();
    expect(h.clipboard).toEqual([r.value]);
    expect(feedback(h)).toMatch(/copied|copy[\s\S]*success/i);
    expect(text(r.area)).toBe(r.value);
    expect(r.button.disabled).toBe(false);
    expect(effects(h)).toBe(before);
  });

  it.each(["reject", "unsupported"] as const)("keeps exact selectable text and accessible manual-copy feedback when clipboard is %s", async (clipboard) => {
    const h = await complete({ clipboard });
    const r = receipt(h);
    const before = effects(h);
    fire(r.button, "click");
    await flush();
    expect(text(r.area)).toBe(r.value);
    expect(visible(r.area)).toBe(true);
    expect(feedback(h)).toMatch(/manual|select|unavailable|could not|couldn't|unable|not supported|clipboard/i);
    expect(feedback(h)).not.toMatch(/public details copied|copied public details/i);
    if (clipboard === "reject") {
      expect(h.clipboard).toEqual([r.value]);
      expect(r.button.disabled, "a rejection must not leave the copy action permanently busy").toBe(false);
    } else expect(h.clipboard).toEqual([]);
    expect(effects(h)).toBe(before);
    noSecrets(JSON.stringify(h.logs));
  });

  it("prevents duplicate clipboard writes while a copy is pending and recovers button state", async () => {
    const h = await complete({ clipboard: "pending" });
    const r = receipt(h);
    const before = effects(h);
    fire(r.button, "click");
    await flush();
    expect(r.button.disabled, "pending copy must be visibly busy/disabled").toBe(true);
    fire(r.button, "click");
    expect(h.clipboard).toEqual([r.value]);
    expect(text(r.area)).toBe(r.value);
    h.clipboardGate.resolve();
    await flush();
    expect(r.button.disabled).toBe(false);
    expect(effects(h)).toBe(before);
  });

  it("binds retained receipt to the completed response when another selection arrives", async () => {
    const h = await complete();
    const old = receipt(h);
    await select(h, [file("new-selection.html", 997)]);
    const next = copyButton(h);
    // Clearing the previous result on selection is allowed. If retained, it
    // must stay bound to the old successful response, never the new selection.
    if (next) {
      const r = receipt(h);
      expect(r.value).toBe(old.value);
      fire(next, "click");
      await flush();
      expect(h.clipboard).toEqual([old.value]);
    }
    expect(h.clipboard.join("\n")).not.toContain("997");
    expect(h.calls.filter((x) => /\/finalize$/.test(x.url))).toHaveLength(1);
  });

  it("does not let an old pending copy overwrite a newer result or guess its missing totals", async () => {
    const h = await complete({ clipboard: "pending" });
    const old = receipt(h);
    fire(old.button, "click");
    await flush();
    h.state.final = { ...finalized(version("ver-replacement", 21, false)), url: "https://dropway.test/s/replacement/" };
    await select(h, [file("replacement.html", 997)]);
    await publish(h);
    const next = receipt(h);
    identity(next.value, "ver-replacement", 21);
    expect(next.value).not.toMatch(/ver-receipt-exact|8,?193|\b997\b/);
    expect(next.value).not.toMatch(/files?[^\n\d]*3\b|bytes?[^\n\d]*\d/i);
    const before = effects(h);
    h.clipboardGate.resolve();
    await flush();
    expect(text(fallback(h)!)).toBe(next.value);
    expect(next.button.disabled).toBe(false);
    fire(next.button, "click");
    await flush();
    expect(h.clipboard).toEqual([old.value, next.value]);
    expect(effects(h)).toBe(before);
  });
});
