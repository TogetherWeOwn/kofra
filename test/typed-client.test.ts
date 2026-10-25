import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { DropwayClient, DropwayError, OPERATIONS, type FetchLike } from "@dropway/client";
import type { ServerBindings } from "@dropway/server";
import { toMethodName as toMethod } from "../scripts/generate-client.mjs";
import { freshInstance, ORIGIN, type Instance } from "./helpers";
import { registry } from "./operation-fixtures";

function clientFor(dw: Instance, token: string | null = dw.ownerKey): DropwayClient {
  const fetch: FetchLike = async (request) => {
    const ctx = createExecutionContext();
    const res = await dw.dropway.fetch(request, env as unknown as ServerBindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  return new DropwayClient({ api: ORIGIN, token, fetch });
}

describe("@dropway/client generated from the registry", () => {
  let dw: Instance;
  beforeEach(async () => {
    dw = await freshInstance();
  });

  it("covers every registry operation with the same method and path", () => {
    const ops = registry(dw);
    expect(ops.length).toBeGreaterThan(20);
    const client = clientFor(dw);
    for (const op of ops) {
      const entry = (OPERATIONS as Record<string, { method: string; path: string }>)[op.id];
      expect(entry, `operation table covers ${op.id}`).toBeDefined();
      expect(entry!.method).toBe(op.method);
      expect(entry!.path).toBe(op.path);
      expect(typeof (client as unknown as Record<string, unknown>)[toMethod(op.id)], `client method for ${op.id}`).toBe(
        "function",
      );
    }
  });

  it("reads whoami, sites and versions through typed methods", async () => {
    const client = clientFor(dw);
    const me = await client.whoami();
    expect(typeof me.principal).toBe("string");
    expect(me.scopes).toContain("sites:write");
    const created = await client.createSite({ slug: "typed-probe" });
    expect(created.site!.slug).toBe("typed-probe");
    expect((await client.getSite({ slug: "typed-probe" })).site!.slug).toBe("typed-probe");
    expect((await client.listSites({})).sites!.map((s) => s.slug)).toContain("typed-probe");
    const versions = (await client.listVersions({ slug: "typed-probe" })) as unknown as { versions: unknown[] };
    expect(versions.versions).toEqual([]);
  });

  it("publishes inline content and reads the bytes back", async () => {
    const client = clientFor(dw);
    const pub = await client.publishUpload({
      slug: "typed-files",
      files: [{ path: "hello.txt", content: "Hello, typed world." }],
    });
    expect(pub.slug).toBe("typed-files");
    const bytes = await client.getFileBytes({ slug: "typed-files", path: "hello.txt" });
    expect(new TextDecoder().decode(bytes.data)).toBe("Hello, typed world.");
    expect(bytes.contentType).toContain("text/plain");
    const read = await client.readFile({ site: "typed-files", path: "hello.txt" });
    expect(read.content).toContain("Hello, typed world.");
  });

  it("creates and reads a transfer on an isolated sites origin", async () => {
    const isolated = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test" });
    const client = clientFor(isolated);
    const transfer = await client.createTransfer({
      files: [{ path: "note.txt", content: "Hello" }],
      recipients: ["teammate@example.com"],
      message: "For review.",
    });
    expect(transfer.mode).toBe("transfer");
    const seen = await client.getTransfer({ transfer: transfer.slug });
    expect(seen.slug).toBe(transfer.slug);
    expect(seen.message).toBe("For review.");
  });

  it("maps server failures to DropwayError with code, hint and status", async () => {
    const client = clientFor(dw);
    const missing = await client.getSite({ slug: "no-such-site" }).catch((e) => e as DropwayError);
    expect(missing).toBeInstanceOf(DropwayError);
    expect(missing.status).toBe(404);
    expect(typeof missing.code).toBe("string");
    const bad = await client.createSite({ slug: "NOT A SLUG" }).catch((e) => e as DropwayError);
    expect(bad.status).toBe(400);
    expect(typeof bad.hint).toBe("string");
  });
});
