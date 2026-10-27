/**
 * PROTECTED ACCEPTANCE TESTS — bounded, immutable dashboard ZIP download.
 * Builder: start from the pushed test handoff; never edit this directory.
 * Corrections belong to the Test Author. No production code or backend tests here.
 *
 * Breaks caught: moving-live export, credential-bearing links, wrong identity,
 * trusting only Content-Length, unbounded buffering, partial/error downloads,
 * leaked object URLs, stuck busy controls, and damaged selection/filter state.
 * These tests execute the actual dashboard asset. Native keyboard/layout and
 * served ZIP/hash evidence live in the paired disposable browser test.
 */
import { describe, expect, it } from "vitest";
import {
  activate, assertReadOnly, countedStream, deferred, expectRefusal, exportPath,
  KEY, LIVE, MIB, mount, OLD, SLUG, streamedResponse, tick, until, visibleErrors, zipResponse,
} from "./harness.ts";

async function completed(view: Awaited<ReturnType<typeof mount>>) {
  await until(() => view.downloads.length === 1 && view.revoked.length === 1, "one complete attachment and object URL cleanup");
  expect(view.created).toHaveLength(1);
  const attachment = view.downloads[0]!;
  expect(attachment.url).toBe(view.created[0]!.url);
  expect(attachment.filename).toBe(`${SLUG}-v1.zip`);
  expect(attachment.target).not.toBe("_blank");
  expect(attachment.revokedAtClick, "URL must stay usable until the anchor is activated").toBe(false);
  expect(attachment.blob?.type).toMatch(/^application\/zip\b/);
  expect(view.revoked).toEqual([attachment.url]);
  expect(view.action().disabled, "success restores the action").toBe(false);
  assertReadOnly(view);
}

describe("dashboard version ZIP: pinned attachment", () => {
  it("downloads selected immutable bytes with Authorization, server filename and URL cleanup", async () => {
    // Hand-specified empty ZIP end-of-central-directory record. This case
    // checks byte preservation; the browser case unzips real two-file versions.
    const archive = new Uint8Array([80, 75, 5, 6, ...Array<number>(18).fill(0)]);
    const view = await mount({ response: () => zipResponse(archive) });
    expect(view.exports(), "no eager archive request on page load").toEqual([]);
    await activate(view);
    await completed(view);
    const request = view.exports();
    expect(request).toHaveLength(1);
    expect(request[0]!.url.pathname).toBe(exportPath());
    expect(request[0]!.url.search).toBe("");
    expect(request[0]!.headers.get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(request[0]!.method).toBe("GET");
    expect(new Uint8Array(await view.downloads[0]!.blob!.arrayBuffer()), "client preserves the response bytes exactly").toEqual(archive);
  });

  it.each([LIVE, "", "ver_foreign_immutable"])("refuses a mismatched/missing X-Kofra-Version (%s)", async identity => {
    const view = await mount({ response: () => {
      const response = zipResponse(undefined, { "X-Kofra-Version": identity });
      if (!identity) response.headers.delete("X-Kofra-Version");
      return response;
    } });
    await activate(view);
    await expectRefusal(view, /version|identity|match/i);
  });

  it("uses the immutable ID even for a clicked row originally marked live", async () => {
    const view = await mount({ row: { live: true }, response: () => zipResponse() });
    await activate(view);
    await completed(view);
    expect(view.exports().map(request => request.url.pathname)).toEqual([exportPath(OLD)]);
    expect(view.exports().some(request => /\/live\//.test(request.url.pathname))).toBe(false);
  });

  it("has a named native keyboard control and preserves filter, selection and existing actions", async () => {
    const view = await mount();
    const section = view.doc.querySelector("#files")!;
    const filter = section.querySelector("input[type=search]")!;
    expect(filter, "fixture prerequisite: existing file filter").toBeDefined();
    filter.value = "alpha";
    filter.dispatch("input");
    const visibleBefore = section.querySelectorAll("tbody tr").filter(row => !row.hidden).map(row => row.textContent);
    const versionActions = view.rowElement()!.querySelectorAll("button").map(button => button.textContent);
    expect(versionActions.join(" ")).toMatch(/Files/);
    expect(versionActions.join(" ")).toMatch(/Restore/);
    expect(versionActions.join(" ")).toMatch(/Delete/);
    const action = view.action();
    expect(action.tag, "native button supplies Enter/Space activation; browser test exercises actual keys").toBe("button");
    expect(action.tabIndex).toBeGreaterThanOrEqual(0);
    action.focus();
    expect(view.doc.activeElement).toBe(action);
    await activate(view);
    await completed(view);
    expect(view.doc.querySelector("#files input[type=search]")!.value).toBe("alpha");
    expect(view.doc.querySelector("#files")!.textContent).toContain("Files in v1");
    expect(view.doc.querySelector("#files")!.querySelectorAll("tbody tr").filter(row => !row.hidden).map(row => row.textContent)).toEqual(visibleBefore);
    expect(view.rowElement()!.querySelectorAll("button").map(button => button.textContent)).toEqual(versionActions);
  });
});

describe("dashboard ZIP: conservative metadata preflight", () => {
  it("explains both browser limits before offering an eligible archive", async () => {
    const view = await mount();
    const action = view.action();
    const description = view.doc.querySelector("#dw-site")!.textContent + [...action.attrs.values()].join(" ");
    expect(description).toMatch(/16\s*(?:MiB|MB)/i);
    expect(description).toMatch(/1[,.]?000\s*files/i);
    expect(view.exports()).toEqual([]);
  });

  it("does not download an unfinalized pending version or silently fall back to live", async () => {
    const view = await mount({ row: { status: "pending", finalizedAt: null } });
    const section = view.doc.querySelector("#files")!;
    const candidates = section.querySelectorAll("button,a").filter(element => /download zip/i.test(element.textContent));
    candidates[0]?.click();
    await tick();
    expect(visibleErrors(view)).toMatch(/not ready|pending/i);
    expect(visibleErrors(view)).toMatch(/upload|finaliz/i);
    expect(section.querySelector("table"), "pending version does not render a ready manifest").toBeNull();
    expect(view.exports(), "pending preflight refuses before requesting any archive, including live").toEqual([]);
    expect(view.downloads).toEqual([]);
    expect(view.created).toEqual([]);
    assertReadOnly(view);
  });

  it.each([
    ["stored bytes above 16 MiB", { totalBytes: 16 * MIB + 1 }],
    ["more than 1000 files", { fileCount: 1001 }],
    ["missing bytes", { totalBytes: undefined }],
    ["null bytes", { totalBytes: null }],
    ["missing file count", { fileCount: undefined }],
    ["null file count", { fileCount: null }],
    ["negative bytes", { totalBytes: -1 }],
    ["non-numeric bytes", { totalBytes: "unknown" }],
    ["negative count", { fileCount: -1 }],
    ["fractional count", { fileCount: 1.5 }],
  ] as const)("refuses %s without fetching an archive", async (_label, row) => {
    const view = await mount({ row });
    const action = view.action();
    action.click(); // A disabled action with a visible explanation is also a valid refusal.
    await tick();
    const text = view.doc.querySelector("#dw-site")!.textContent + view.doc.querySelector("#dw-toasts")!.textContent;
    expect(view.exports(), "preflight occurs before network/byte allocation").toEqual([]);
    expect(view.downloads).toEqual([]);
    expect(view.created).toEqual([]);
    expect(text).toMatch(/16\s*(?:MiB|MB)|1[,.]?000\s*files/i);
    expect(text).toMatch(/REST|CLI|kofra api/i);
    const nextAction = text + view.doc.querySelectorAll("input,textarea,a,code,pre").map(element => element.value + [...element.attrs.values()].join(" ")).join(" ");
    expect(nextAction, "fallback names the existing immutable authenticated export route").toContain(`/versions/${OLD}/export`);
    assertReadOnly(view);
  });

  it.each([
    [16 * MIB, 2], [17, 1000], [16 * MIB, 1000], [0, 2],
  ])("allows the inclusive stored metadata boundary (%i bytes, %i files)", async (totalBytes, fileCount) => {
    const view = await mount({ row: { totalBytes, fileCount } });
    await activate(view);
    await completed(view);
    expect(view.exports()).toHaveLength(1);
  });
});

describe("dashboard ZIP: bounded streaming and busy lifecycle", () => {
  it.each<Record<string, string>>([{}, { "Content-Length": "1" }, { "Content-Length": String(32 * MIB) }])("cancels overflow based on actual bytes, not advertised length %j", async headers => {
    const stream = countedStream(80, MIB);
    const view = await mount({ response: () => streamedResponse(stream.body, headers) });
    await activate(view);
    await expectRefusal(view, /large|limit|32\s*(?:MiB|MB)|exceed/i);
    expect(stream.state.pulls, "stops at first overflowing chunk; never drains all 80 MiB").toBeLessThanOrEqual(33);
    expect(stream.state.pulls).toBeGreaterThan(0);
    expect(stream.state.completed).toBe(false);
    expect(stream.state.cancelled || view.exports()[0]?.signal?.aborted, "cancel reader or abort fetch on overflow").toBe(true);
  });

  it("allows exactly 32 MiB of response bytes and releases the object URL", async () => {
    const stream = countedStream(32, MIB);
    const view = await mount({ response: () => streamedResponse(stream.body) });
    await activate(view);
    await completed(view);
    expect(view.downloads[0]!.blob!.size).toBe(32 * MIB);
    expect(stream.state.completed).toBe(true);
  });

  it("does not offer a partial attachment or duplicate export while the stream is pending", async () => {
    const gate = deferred<void>();
    const stream = countedStream(1, 8, { gate: gate.promise });
    const view = await mount({ response: () => streamedResponse(stream.body) });
    const action = view.action();
    try {
      await activate(view);
      await until(() => view.exports().length === 1, "export started");
      action.click();
      await tick();
      expect(view.exports()).toHaveLength(1);
      expect(action.disabled || action.getAttribute("aria-busy") === "true", "busy state is exposed").toBe(true);
      expect(view.created).toEqual([]);
      expect(view.downloads).toEqual([]);
    } finally { gate.resolve(); }
    await completed(view);
  });

  it("cleans up a failed stream and can retry the same version successfully", async () => {
    const stream = countedStream(4, 16, { failAt: 1 });
    let attempt = 0;
    const view = await mount({ response: () => ++attempt === 1 ? streamedResponse(stream.body) : zipResponse() });
    await activate(view);
    await expectRefusal(view, /interrupt|failed|error|download/i);
    await activate(view);
    await completed(view);
    expect(view.exports().map(request => request.url.pathname)).toEqual([exportPath(), exportPath()]);
  });

  it("restores busy state after a cancelled request without partial download", async () => {
    const view = await mount({ response: async () => { throw new DOMException("Download cancelled. Try again.", "AbortError"); } });
    await activate(view);
    await expectRefusal(view, /cancel|abort/i);
  });

  it("restores busy state after a network refusal", async () => {
    const view = await mount({ response: async () => { throw new TypeError("Failed to fetch archive. Retry."); } });
    await activate(view);
    await expectRefusal(view, /network|fetch|failed|download/i);
  });

  it("refuses an EOF shorter than Content-Length instead of offering a partial file", async () => {
    const stream = countedStream(1, 8);
    const view = await mount({ response: () => streamedResponse(stream.body, { "Content-Length": "1000" }) });
    await activate(view);
    await expectRefusal(view, /truncat|incomplete|length|failed|download/i);
  });

  it.each(["text/html", "application/json"])("refuses a non-ZIP success response (%s)", async contentType => {
    const view = await mount({ response: () => zipResponse(undefined, { "Content-Type": contentType }) });
    await activate(view);
    await expectRefusal(view, /zip|type|response|download/i);
  });
});

describe("dashboard ZIP: actionable server refusals", () => {
  it.each([
    [409, "missing_blobs", "Pending version has missing bytes.", "Upload missing blobs and finalize, then retry."],
    [404, "version_not_found", "Version was deleted or is unavailable.", "Reload versions and choose another version."],
    [404, "site_not_found", "Site is unavailable for this credential.", "Reload sites and select an accessible site."],
    [413, "export_too_large", "Archive exceeds the server export limit.", "Use CLI export or read files file-by-file."],
    [401, "unauthorized", "Authentication refused.", "Sign in again with a valid API key."],
    [403, "forbidden", "This credential cannot read this version.", "Sign in with a sites:read key for this site."],
    [500, "internal_error", "Export failed.", "Retry the export or use CLI."],
  ] as const)("shows %i %s without a success or partial download", async (status, code, message, hint) => {
    const view = await mount({ response: () => Response.json({ error: { code, message, hint }, requestId: "zip-test" }, { status }) });
    await activate(view);
    await expectRefusal(view, /pending|version|site|limit|archive|auth|credential|export|sign in/i);
    expect(view.exports()).toHaveLength(1);
  });

  it("handles non-JSON server errors without leaking raw HTML into a download", async () => {
    const view = await mount({ response: () => new Response("<h1>Upstream unavailable</h1>", { status: 502, headers: { "Content-Type": "text/html" } }) });
    await activate(view);
    await expectRefusal(view, /502|failed|error|unavailable|download/i);
  });
});

describe("dashboard ZIP: guards that must not regress silently", () => {
  // Server-generated archives for an empty version are a 22-byte EOCD record.
  const emptyArchive = () => new Uint8Array([80, 75, 5, 6, ...Array<number>(18).fill(0)]);

  it("keeps a failure visible after the selection moves away mid-download", async () => {
    const gate = deferred<void>();
    const stream = countedStream(4, 16, { gate: gate.promise, failAt: 0 });
    const view = await mount({ response: () => streamedResponse(stream.body) });
    try {
      await activate(view);
      await until(() => view.exports().length === 1, "export started");
      const liveRow = view.doc.querySelectorAll("tbody tr").find(row => row.querySelectorAll("td").some(cell => /^v2\b/.test(cell.textContent)));
      const liveFiles = liveRow?.querySelectorAll("button").find(button => button.textContent === "Files");
      expect(liveFiles, "fixture prerequisite: live history row has a Files action").toBeDefined();
      liveFiles!.click();
      await until(() => view.doc.querySelector("#files")!.textContent.includes("Files in v2"), "selection moved to v2");
    } finally { gate.resolve(); }
    await until(() => /interrupt/i.test(visibleErrors(view)), "download failure stays visible after the selection moved");
    expect(visibleErrors(view), "the detached failure names the version it belongs to").toContain(OLD);
    expect(view.downloads, "no partial/error attachment").toEqual([]);
    expect(view.created).toEqual([]);
    assertReadOnly(view);
  });

  it.each<[string, string | null]>([
    ["missing header", null],
    ["bare attachment", "attachment"],
    ["inline disposition", `inline; filename="${SLUG}-v1.zip"`],
    ["path traversal", `attachment; filename="../${SLUG}-v1.zip"`],
    ["non-ZIP extension", `attachment; filename="${SLUG}-v1.html"`],
    ["unquoted filename", `attachment; filename=${SLUG}-v1.zip`],
    ["trailing filename* override", `attachment; filename="${SLUG}-v1.zip"; filename*=UTF-8''run.exe`],
  ])("refuses a success response with an invalid Content-Disposition (%s)", async (_label, disposition) => {
    const view = await mount({ response: () => {
      const response = zipResponse(emptyArchive());
      if (disposition === null) response.headers.delete("Content-Disposition");
      else response.headers.set("Content-Disposition", disposition);
      return response;
    } });
    await activate(view);
    await expectRefusal(view, /filename/i);
  });

  it.each<Record<string, string>>([{}, { "Content-Length": "0" }])("refuses a zero-byte 200 ZIP response %j", async headers => {
    const view = await mount({ response: () => zipResponse(new Uint8Array(0), headers) });
    await activate(view);
    await expectRefusal(view, /empty/i);
  });

  it("offers Download ZIP for an empty-manifest version and downloads its archive", async () => {
    const archive = emptyArchive();
    const view = await mount({ files: [], row: { fileCount: 0, totalBytes: 0 }, response: () => zipResponse(archive) });
    expect(view.doc.querySelector("#files")!.textContent).toContain("No files in this version");
    await activate(view);
    await completed(view);
    expect(view.exports().map(request => request.url.pathname)).toEqual([exportPath()]);
    expect(new Uint8Array(await view.downloads[0]!.blob!.arrayBuffer())).toEqual(archive);
  });
});
