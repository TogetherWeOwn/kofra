import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { runCleanup, sha256Hex } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonBody, manifestEntry, type Instance } from "./helpers";
import { DAY, instance, storageUsage } from "./transfer-fixtures";
import {
  assertStoredBytes, databaseBoundary, delivery, fileLinks, lifecycle, operationRequest,
  references, request, REVIEW_FILES, REVIEW_PASSWORD, reviewInput,
} from "./delivery-review-fixtures";

// These catch loss of protected pending evidence through generic cleanup and raw
// URL credential disclosure through operational errors. Only I/O boundaries are
// instrumented; authorization, transactions, cleanup and downloaded bytes are real.
let dw: Instance;
beforeEach(async () => { dw = await instance(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

type Protection = "legal hold" | "takedown";
const protections: Protection[] = ["legal hold", "takedown"];

async function protection(siteId: string, kind: Protection, enabled: boolean) {
  const result = kind === "legal hold"
    ? await env.DB.prepare("UPDATE transfers SET legal_hold = ? WHERE site_id = ?").bind(enabled ? 1 : 0, siteId).run()
    : await env.DB.prepare("UPDATE transfers SET takedown_at = ?, takedown_reason = ? WHERE site_id = ?")
      .bind(enabled ? Date.now() : null, enabled ? "Disposable evidence fixture" : null, siteId).run();
  expect(result.meta.changes, "protection must affect the real transfer").toBe(1);
}

async function pendingVersions(siteId: string) {
  const rows = await env.DB.prepare("SELECT id, status FROM versions WHERE site_id = ? ORDER BY id")
    .bind(siteId).all<{ id: string; status: string }>();
  return rows.results;
}

async function protectionState(siteId: string) {
  return env.DB.prepare("SELECT legal_hold, takedown_at, takedown_reason, purged_at FROM transfers WHERE site_id = ?")
    .bind(siteId).first();
}

async function cleanup(bindings: Partial<ServerBindings> = {}) {
  const ctx = createExecutionContext();
  const result = await runCleanup(dw.dropway.context({ ...env, ...bindings } as unknown as ServerBindings, ctx));
  await waitOnExecutionContext(ctx);
  return result;
}

/** Fail before the real finalize transaction can make the pending version ready. */
async function failedPendingDelivery(kind: Protection) {
  let injected = false;
  let siteId = "";
  const db = databaseBoundary(async (sql) => {
    if (injected || !sql.some((statement) => /\bUPDATE\s+versions\b[\s\S]*\bstatus\s*=\s*'ready'/i.test(statement))) return;
    const before = await lifecycle("pending-evidence");
    expect(before?.current_version_id, "failure must be precommit, not a cache failure after publication").toBeNull();
    siteId = before!.site_id;
    expect((await pendingVersions(siteId)).map((version) => version.status)).toEqual(["pending"]);
    await assertStoredBytes(siteId);
    expect(await storageUsage(), "uploaded bytes already have an accounting owner").toBe(18);
    await protection(siteId, kind, true);
    injected = true;
    throw new Error("Disposable finalize boundary failure before commit");
  });
  const result = await operationRequest(dw, "create_transfer", reviewInput({ slug: "pending-evidence" }), { DB: db });
  expect(injected, "reach the actual precommit finalize boundary after both blobs upload").toBe(true);
  expect(result.status).toBe(500);
  const versions = await pendingVersions(siteId);
  expect(versions.map((version) => version.status)).toEqual(["pending"]);
  expect((await lifecycle(siteId, "id"))?.current_version_id).toBeNull();
  await assertStoredBytes(siteId);
  expect(await storageUsage()).toBe(18);
  return { siteId, versions, refs: await references(siteId), protectedState: await protectionState(siteId) };
}

async function expectObjects(refs: Awaited<ReturnType<typeof references>>, present: boolean) {
  for (const ref of refs) {
    const object = await env.FILES.get(ref.storage_key);
    expect.soft(object !== null, `${ref.path}: R2 object presence`).toBe(present);
    if (object) {
      const bytes = await object.arrayBuffer();
      if (present) {
        expect.soft(bytes.byteLength, `${ref.path}: retained byte length`).toBe(ref.size);
        expect.soft(await sha256Hex(bytes), `${ref.path}: retained content hash`).toBe(ref.sha256);
      }
    }
  }
}

describe("pending uploads remain evidence until protection is released", () => {
  it.each(protections)("preserves pending references, objects and accounted bytes under %s through full cleanup", async (kind: Protection) => {
    const pending = await failedPendingDelivery(kind);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 4 * DAY);
    await cleanup();
    await cleanup();
    expect.soft(await pendingVersions(pending.siteId), "generic pending-upload cleanup must respect protection").toEqual(pending.versions);
    expect.soft(await references(pending.siteId), "preserve the references that prevent orphan collection").toEqual(pending.refs);
    await expectObjects(pending.refs, true);
    expect.soft(await storageUsage(), "protected pending bytes remain accounted").toBe(18);
    expect.soft(await protectionState(pending.siteId), "cleanup must not clear protection or mark evidence purged").toEqual(pending.protectedState);

    await protection(pending.siteId, kind, false);
    await cleanup();
    vi.setSystemTime(Date.now() + 4 * DAY);
    await cleanup();
    expect.soft(await references(pending.siteId)).toEqual([]);
    expect.soft(await pendingVersions(pending.siteId)).toEqual([]);
    await expectObjects(pending.refs, false);
    expect.soft(await storageUsage(), "release permits exactly one accounting decrement").toBe(0);
    await cleanup();
    expect.soft(await storageUsage(), "repeated cleanup must not decrement twice").toBe(0);
  });

  it.each(protections)("rechecks a %s arriving after stale pending-candidate selection at the destructive write", async (kind: Protection) => {
    const slug = "pending-ownership-race";
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug }) });
    expect(created.status).toBe(201);
    const files = await Promise.all(REVIEW_FILES.map((file) => manifestEntry(file.path, file.content, file.contentType)));
    const started = await dw.json(`/api/v1/sites/${slug}/deploys`, {
      key: dw.ownerKey, ...jsonBody({ files: files.map(({ bytes, ...entry }) => entry) }),
    });
    expect(started.status).toBe(201);
    for (const file of files) {
      const uploaded = await dw.call(`/api/v1/blobs/${file.sha256}`, {
        method: "PUT", key: dw.ownerKey, body: file.bytes, headers: { "Content-Length": String(file.size) },
      });
      expect(uploaded.status).toBe(201);
      await uploaded.text();
    }
    const site = await lifecycle(slug);
    expect(site?.transfer_id, "candidate begins as an ordinary abandoned upload").toBeNull();
    const pending = { siteId: site!.site_id, versions: await pendingVersions(site!.site_id), refs: await references(site!.site_id) };
    expect(pending.versions.map((version) => version.status)).toEqual(["pending"]);
    await assertStoredBytes(pending.siteId);
    expect(await storageUsage()).toBe(0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 4 * DAY);
    // No transfer exists at selection. Attach ownership and protection only
    // before the real destructive write, after the candidate query has returned.
    let selected = false;
    let raced = false;
    const db = databaseBoundary(async (sql) => {
      if (!selected && sql.some((statement) => /\bSELECT\b[\s\S]*\bFROM\s+versions\b[\s\S]*\bstatus\s*=\s*'pending'/i.test(statement))) {
        expect((await lifecycle(slug))?.transfer_id).toBeNull();
        selected = true;
      } else if (selected && !raced && sql.some((statement) => /\bDELETE\s+FROM\s+(?:version_files|versions)\b/i.test(statement))) {
        expect(await pendingVersions(pending.siteId)).toEqual(pending.versions);
        const transferId = crypto.randomUUID();
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO transfers (id, site_id, tenant_id, member_id, slug, expires_at, storage_bytes, created_at)
            SELECT ?, id, tenant_id, created_by, slug, ?, 18, ? FROM sites WHERE id = ?`)
            .bind(transferId, Date.now() + 2 * DAY, Date.now(), pending.siteId),
          env.DB.prepare(`INSERT INTO transfer_files (transfer_id, path, sha256, size, content_type)
            SELECT ?, vf.path, vf.sha256, vf.size, vf.content_type FROM version_files vf
            JOIN versions v ON v.id = vf.version_id WHERE v.site_id = ?`).bind(transferId, pending.siteId),
          env.DB.prepare("UPDATE sites SET mode = 'transfer' WHERE id = ?").bind(pending.siteId),
        ]);
        await protection(pending.siteId, kind, true);
        expect((await lifecycle(slug))?.transfer_id).toBe(transferId);
        expect(await storageUsage(), "real transfer insertion accounts for its bytes").toBe(18);
        raced = true;
      }
    });
    await cleanup({ DB: db });
    expect(selected, "exercise the real pending candidate query").toBe(true);
    expect(raced, "protection arrives before, not after, the destructive D1 batch").toBe(true);
    const savedProtection = await protectionState(pending.siteId);
    expect.soft(kind === "legal hold" ? savedProtection?.legal_hold === 1 : typeof savedProtection?.takedown_at === "number").toBe(true);
    expect.soft(savedProtection?.purged_at).toBeNull();
    expect.soft(await pendingVersions(pending.siteId), "stale candidate is not authority to delete").toEqual(pending.versions);
    expect.soft(await references(pending.siteId)).toEqual(pending.refs);
    await expectObjects(pending.refs, true);
    expect.soft(await storageUsage()).toBe(18);
    await cleanup();
    expect.soft(await references(pending.siteId)).toEqual(pending.refs);
    await expectObjects(pending.refs, true);
    expect.soft(await storageUsage()).toBe(18);
  });

  it("still collects released pending transfer uploads without double-decrementing", async () => {
    const pending = await failedPendingDelivery("legal hold");
    await protection(pending.siteId, "legal hold", false);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 4 * DAY);
    await cleanup();
    vi.setSystemTime(Date.now() + 4 * DAY);
    await cleanup();
    expect(await pendingVersions(pending.siteId)).toEqual([]);
    expect(await references(pending.siteId)).toEqual([]);
    await expectObjects(pending.refs, false);
    expect(await storageUsage()).toBe(0);
    await cleanup();
    expect(await storageUsage()).toBe(0);
  });

  it("still cleans an ordinary abandoned site upload with no transfer or protection", async () => {
    const created = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "abandoned-site" }) });
    expect(created.status).toBe(201);
    const file = await manifestEntry("abandoned.txt", "ordinary abandoned bytes");
    const { bytes, ...entry } = file;
    const started = await dw.json("/api/v1/sites/abandoned-site/deploys", { key: dw.ownerKey, ...jsonBody({ files: [entry] }) });
    expect(started.status).toBe(201);
    const uploaded = await dw.call(`/api/v1/blobs/${file.sha256}`, {
      method: "PUT", key: dw.ownerKey, body: bytes, headers: { "Content-Length": String(file.size) },
    });
    expect(uploaded.status).toBe(201);
    await uploaded.text();
    const site = await lifecycle("abandoned-site");
    expect(site?.transfer_id).toBeNull();
    expect((await pendingVersions(site!.site_id)).map((version) => version.status)).toEqual(["pending"]);
    const refs = await references(site!.site_id);
    expect(refs.map((ref) => [ref.path, ref.size])).toEqual([["abandoned.txt", 24]]);
    await expectObjects(refs, true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 4 * DAY);
    await cleanup();
    await cleanup();
    expect(await pendingVersions(site!.site_id)).toEqual([]);
    expect(await references(site!.site_id)).toEqual([]);
    await expectObjects(refs, false);
    expect(await storageUsage()).toBe(0);
    await cleanup();
    expect(await storageUsage()).toBe(0);
  });
});

type Encoding = "canonical" | "dot upper" | "dot lower" | "unreserved upper" | "unreserved lower" | "mixed" | "partial recipient";
const encodings: Encoding[] = ["canonical", "dot upper", "dot lower", "unreserved upper", "unreserved lower", "mixed", "partial recipient"];

function encoded(value: string, style: Encoding, recipient: boolean) {
  if (style === "canonical") return encodeURIComponent(value);
  return [...value].map((char, index) => {
    const escape = style.startsWith("dot") ? char === "."
      : style === "partial recipient" ? recipient && index % 3 === 0
      : style === "mixed" ? index % 2 === 0 : true;
    if (!escape) return char;
    const hex = char.charCodeAt(0).toString(16).padStart(2, "0");
    return `%${style.endsWith("lower") || (style === "mixed" && index % 4 === 0) ? hex.toLowerCase() : hex.toUpperCase()}`;
  }).join("");
}

function encodedLink(link: string, style: Encoding) {
  const original = new URL(link);
  const secrets = ["recipient", "grant"].map((key) => {
    const value = original.searchParams.get(key);
    expect(Boolean(value), `real issued download must contain ${key}`).toBe(true);
    return { key, value: value!, raw: encoded(value!, style, key === "recipient") };
  });
  // Do not round-trip through URLSearchParams: that would normalize the attack
  // input and silently turn these regressions into canonical-only controls.
  const parts = original.search.slice(1).split("&").map((part) => {
    const secret = secrets.find(({ key }) => part.startsWith(`${key}=`));
    return secret ? `${secret.key}=${secret.raw}` : part;
  });
  const url = `${original.origin}${original.pathname}?${parts.join("&")}`;
  for (const secret of secrets) {
    expect(new URL(url).searchParams.get(secret.key) === secret.value, "encoding preserves the issued bearer value").toBe(true);
  }
  if (style !== "canonical") expect(url !== link, "noncanonical control must actually change URL spelling").toBe(true);
  return { url, secrets };
}

function captureConsole() {
  const lines: { method: string; text: string }[] = [];
  const render = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return `${value.message}\n${value.stack}\n${render(value.cause)}`;
    if (value instanceof Request) return value.url;
    try {
      return JSON.stringify(value, (_, nested) => nested instanceof Error
        ? { message: nested.message, stack: nested.stack, cause: nested.cause } : nested) ?? String(value);
    } catch { return String(value); }
  };
  for (const method of ["error", "warn", "log", "info", "debug", "trace", "dir", "dirxml", "table", "assert", "group", "groupCollapsed"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push({ method, text: args.map(render).join(" ") }); });
  }
  return lines;
}

describe("issued credentials stay out of credential-bearing operational errors", () => {
  for (const boundary of ["download R2", "download D1", "non-API app D1"] as const) {
    it.each(encodings)(`${boundary}: accepts %s credentials but never logs their bearer values on failure`, async (style: Encoding) => {
      const t = await delivery(dw, { password: REVIEW_PASSWORD });
      const [link] = await fileLinks(dw, t, 0, REVIEW_PASSWORD);
      const { url: download, secrets } = encodedLink(link!, style);
      const success = await dw.call(download);
      expect(success.status, "real downloads must succeed with equivalent encoded credentials").toBe(200);
      expect(success.headers.get("content-disposition")).toMatch(/^attachment(?:;|$)/i);
      expect(await success.text()).toBe("alpha\n");
      const url = boundary === "non-API app D1"
        ? new URL(t.recipients[0]!.url).origin + new URL(t.recipients[0]!.url).pathname + new URL(download).search
        : download;
      expect(new Request(url).url === url, "the raw mixed percent-encoding reaches the request unchanged").toBe(true);
      if (boundary === "non-API app D1") expect(new URL(url).pathname.startsWith("/api/")).toBe(false);
      const error = new Error(`Disposable operational read failure: ${url}; ${secrets.map((s) => `${s.key}=${s.raw}`).join(" ")}`);
      error.stack = `Error: Disposable operational read failure: ${url}\n    at fixture (${url})\n    ${secrets.map((s) => `${s.key}=${s.raw}`).join(" ")}`;
      const lines = captureConsole();
      let injected = false;
      const bindings: Partial<ServerBindings> = boundary === "download R2" ? {
        FILES: new Proxy(env.FILES, { get(target, property) {
          if (property === "get") return () => { injected = true; throw error; };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        } }),
      } : { DB: databaseBoundary(async (sql) => {
        if (sql.some((statement) => /\bSELECT\b[\s\S]*\bFROM\s+transfers\b/i.test(statement))) {
          injected = true;
          throw error;
        }
      }) };
      const response = await request(dw, url, {
        headers: { Accept: "application/json", ...(boundary === "download R2" ? { Range: "bytes=0-2" } : {}) },
      }, bindings);
      await response.text();
      expect(injected, "the intended real I/O boundary must cause the error").toBe(true);
      expect(response.status).toBe(500);
      expect(lines.some((line) => ["error", "warn"].includes(line.method)), "an operational error must remain observable").toBe(true);
      // Boolean assertions deliberately keep fresh fixture credentials out of
      // Vitest failure diffs too. Omitting unsafe error details is acceptable.
      const forbidden = new Set([url, ...secrets.flatMap((s) => [s.value, encodeURIComponent(s.value), s.raw])]);
      for (const bearer of forbidden) {
        expect.soft(lines.some((line) => line.text.includes(bearer)), "no console output may disclose a decoded or raw-encoded bearer").toBe(false);
      }
    });
  }
});
