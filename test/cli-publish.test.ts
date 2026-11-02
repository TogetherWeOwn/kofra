/**
 * The CLI's publish protocol (packages/cli/src/publish.ts + client.ts) against
 * the real Worker inside the Workers runtime, with fault injection. The CLI as
 * a whole (files, flags, credentials, the binary) is tested end to end in
 * packages/cli/test/e2e.test.ts.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@kofra/core";
import type { ServerBindings } from "@kofra/server";
import { CliError, KofraClient, EXIT, type FetchLike } from "../packages/cli/src/client.ts";
import { publish, type SourceFile } from "../packages/cli/src/publish.ts";
import { freshInstance, ORIGIN, type Instance } from "./helpers";

interface Call {
  method: string;
  url: string;
  authorization: string | null;
}

function workerFetch(dw: Instance, intercept?: (req: Request) => Response | null): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: Request) => {
    let req = input;
    // A real HTTP client sends Content-Length for byte bodies (Node's fetch does); a Request
    // handed straight to the Worker has none, so add it as the network would.
    if (req.body && !req.headers.get("content-length")) {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const headers = new Headers(req.headers);
      headers.set("content-length", String(bytes.byteLength));
      req = new Request(req.url, { method: req.method, headers, body: bytes });
    }
    calls.push({ method: req.method, url: req.url, authorization: req.headers.get("authorization") });
    const injected = intercept?.(req);
    if (injected) return injected;
    const ctx = createExecutionContext();
    const res = await dw.kofra.fetch(req, env as unknown as ServerBindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  return Object.assign(f, { calls });
}

async function mem(path: string, content: string): Promise<SourceFile> {
  const bytes = new TextEncoder().encode(content);
  return { path, size: bytes.length, sha256: await sha256Hex(bytes), body: async () => bytes };
}

const client = (dw: Instance, fetch: FetchLike, token: string | null = dw.ownerKey) =>
  new KofraClient({ api: ORIGIN, token, fetch, backoffMs: 1, client: "test/cli-publish" });

describe("CLI publish protocol", () => {
  it("creates a site, uploads in parallel, and serves it", async () => {
    const dw = await freshInstance();
    const files = await Promise.all(Array.from({ length: 30 }, (_, i) => mem(i === 0 ? "index.html" : `assets/f${i}.txt`, `file ${i}`)));
    let inFlight = 0;
    let peak = 0;
    const base = workerFetch(dw);
    const tracking: FetchLike = async (req) => {
      const isUpload = req.method === "PUT";
      if (isUpload) peak = Math.max(peak, ++inFlight);
      try {
        return await base(req);
      } finally {
        if (isUpload) inFlight--;
      }
    };
    const out = await publish(client(dw, tracking), files, { concurrency: 4, message: "parallel" });
    expect(out).toMatchObject({ created: true, unchanged: false, files: 30, uploaded: 30, reused: 0 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(out.url).toBe(`${ORIGIN}/s/${out.slug}/`);
    const page = await dw.call(`/s/${out.slug}/assets/f7.txt`);
    expect(await page.text()).toBe("file 7");
    // Attribution reaches the version.
    const versions = await dw.json(`/api/v1/sites/${out.slug}/versions`, { key: dw.ownerKey });
    expect(versions.body.versions[0]).toMatchObject({ client: "test/cli-publish", message: "parallel" });
  });

  it("never re-uploads bytes the owner already stored, even for another site", async () => {
    const dw = await freshInstance();
    const files = [await mem("index.html", "<p>same</p>"), await mem("a.css", "p{}")];
    const f = workerFetch(dw);
    await publish(client(dw, f), files);
    const second = await publish(client(dw, f), files, { site: "copy-of-it" });
    expect(second).toMatchObject({ slug: "copy-of-it", created: true, uploaded: 0, reused: 2 });
    const again = await publish(client(dw, f), files, { site: "copy-of-it" });
    expect(again).toMatchObject({ unchanged: true, created: false, uploaded: 0 });
    expect(again.version?.number).toBe(1);
  });

  it("retries uploads that fail with 5xx", async () => {
    const dw = await freshInstance();
    let failures = 0;
    const f = workerFetch(dw, (req) => (req.method === "PUT" && failures++ < 2 ? new Response("upstream hiccup", { status: 503 }) : null));
    const out = await publish(client(dw, f), [await mem("index.html", "<p>retry</p>")]);
    expect(out.uploaded).toBe(1);
    expect(f.calls.filter((r) => r.method === "PUT")).toHaveLength(3);
  });

  it("does not leave an empty site behind when the files are refused", async () => {
    const dw = await freshInstance({ limits: { maxFileBytes: 8 } });
    const err = await publish(client(dw, workerFetch(dw)), [await mem("index.html", "far more than eight bytes")]).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({ code: "file_too_large", exitCode: EXIT.invalid, status: 413 });
    const sites = await dw.json("/api/v1/sites", { key: dw.ownerKey });
    expect(sites.body.sites).toEqual([]);
  });

  it("maps refusals to stable exit codes", async () => {
    const dw = await freshInstance();
    const anon = await publish(client(dw, workerFetch(dw), null), [await mem("index.html", "x")]).catch((e) => e);
    expect(anon).toMatchObject({ code: "anonymous_publish_disabled", exitCode: EXIT.auth });

    const f = workerFetch(dw);
    const first = await publish(client(dw, f), [await mem("index.html", "v1")], { site: "conflicts" });
    await publish(client(dw, f), [await mem("index.html", "v2")], { site: "conflicts" });
    const stale = await publish(client(dw, f), [await mem("index.html", "v3")], { site: "conflicts", baseVersionId: first.version!.id }).catch((e) => e);
    expect(stale).toMatchObject({ code: "version_conflict", exitCode: EXIT.conflict });

    // A long Retry-After is not slept through: the caller gets a retryable error at once.
    const limited = workerFetch(dw, () => new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }), { status: 429, headers: { "Retry-After": "3600" } }));
    const rl = await publish(client(dw, limited), [await mem("index.html", "x")]).catch((e) => e);
    expect(rl).toMatchObject({ code: "rate_limited", exitCode: EXIT.unavailable, retryable: true });
  });

  it("publishes anonymously with the claim token when the instance allows it", async () => {
    const dw = await freshInstance({ anonymous: { enabled: true } });
    const f = workerFetch(dw);
    const out = await publish(client(dw, f, null), [await mem("index.html", "<p>anon</p>")]);
    expect(out.claimToken).toMatch(/^dwc_/);
    expect(out.expiresAt).toBeTruthy();
    // Uploads and finalize used the claim token, not anonymous calls.
    const auths = f.calls.filter((r) => r.method === "PUT" || r.url.endsWith("/finalize")).map((r) => r.authorization);
    expect(auths.every((a) => a === `Bearer ${out.claimToken}`)).toBe(true);
    const upd = await publish(client(dw, f, out.claimToken!), [await mem("index.html", "<p>anon 2</p>")], { site: out.slug });
    expect(upd).toMatchObject({ slug: out.slug, created: false, uploaded: 1 });
  });
});
