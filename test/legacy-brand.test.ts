// The product's former name (Dropway) keeps working for clients built before the rename. // rebrand:keep
// rebrand:keep-file (scripts/rebrand.mjs never edits this file.)
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServerBindings } from "@kofra/server";
import { legacyBrandHeaders } from "../packages/server/src/legacy-brand";
import { form, freshInstance, ORIGIN, type Instance } from "./helpers";

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

describe("former name compatibility", () => {
  it("sends every X-Kofra-* response header as X-Dropway-* too", async () => {
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "<p>hi</p>", "notes.md": "# Notes" }) });
    expect(pub.status).toBe(201);
    const page = await dw.call(`/s/${pub.body.slug}/`);
    expect(page.headers.get("x-kofra-site")).toBe(pub.body.slug);
    expect(page.headers.get("x-dropway-site")).toBe(pub.body.slug);
    expect(page.headers.get("x-kofra-version")).toBeTruthy();
    expect(page.headers.get("x-dropway-version")).toBe(page.headers.get("x-kofra-version"));
    const viewer = await dw.call(`/s/${pub.body.slug}/notes.md`, { headers: { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" } });
    expect(viewer.headers.get("x-kofra-viewer")).toBe("markdown");
    expect(viewer.headers.get("x-dropway-viewer")).toBe("markdown");
  });

  it("reads X-Dropway-* request headers, and X-Kofra-* wins when both are sent", async () => {
    const legacy = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, headers: { "Content-Type": "text/markdown", "X-Dropway-Path": "old.md" }, body: "# Old" });
    expect(legacy.status).toBe(201);
    expect(legacy.body.files).toEqual(["old.md"]);
    const both = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      headers: { "Content-Type": "text/markdown", "X-Dropway-Path": "old.md", "X-Kofra-Path": "new.md" },
      body: "# New",
    });
    expect(both.body.files).toEqual(["new.md"]);
  });

  it("allows and exposes both header spellings to browsers (CORS)", async () => {
    const res = await dw.call("/api/v1/publish", {
      method: "OPTIONS",
      headers: { Origin: "https://example.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-dropway-path" },
    });
    expect(res.status).toBeLessThan(300);
    const allowed = res.headers.get("access-control-allow-headers") ?? "";
    expect(allowed).toContain("X-Kofra-Path");
    expect(allowed).toContain("X-Dropway-Path");
    const mcp = await dw.call("/mcp", { method: "OPTIONS", headers: { Origin: "http://localhost:6274", "Access-Control-Request-Method": "POST" } });
    expect(mcp.headers.get("access-control-allow-headers")).toContain("X-Dropway-Toolsets");
  });

  it("applies to the exported app too, called directly or mounted by a layer on top", async () => {
    const parent = new Hono();
    parent.route("/", dw.kofra.app);
    const fetchers: Record<string, (req: Request, ctx: ExecutionContext) => Response | Promise<Response>> = {
      "app.fetch": (req, ctx) => dw.kofra.app.fetch(req, env as unknown as ServerBindings, ctx),
      mounted: (req, ctx) => parent.fetch(req, env as unknown as ServerBindings, ctx),
    };
    for (const [how, fetcher] of Object.entries(fetchers)) {
      const call = async (path: string, init: RequestInit) => {
        const ctx = createExecutionContext();
        const res = await fetcher(new Request(`${ORIGIN}${path}`, init), ctx);
        await waitOnExecutionContext(ctx);
        return res;
      };
      const auth = { Authorization: `Bearer ${dw.ownerKey}` };
      const pub = await call("/api/v1/publish", { method: "POST", headers: { ...auth, "Content-Type": "text/markdown", "X-Dropway-Path": `${how}.md` }, body: "# Hi" });
      const body = (await pub.json()) as { slug: string; files: string[] };
      expect(pub.status, how).toBe(201);
      expect(body.files, how).toEqual([`${how}.md`]);
      const raw = await call(`/api/v1/sites/${body.slug}/files/${how}.md`, { headers: auth });
      expect(raw.status, how).toBe(200);
      expect(raw.headers.get("x-kofra-content-type"), how).toMatch(/^text\/markdown/);
      expect(raw.headers.get("x-dropway-content-type"), how).toBe(raw.headers.get("x-kofra-content-type"));
      expect(raw.headers.get("x-dropway-version"), how).toBe(raw.headers.get("x-kofra-version"));
    }
  });

  it("copies a response whose headers cannot be changed (passed through from fetch or the cache)", async () => {
    const app = new Hono();
    app.use("*", legacyBrandHeaders);
    app.get("/", () => {
      const res = new Response("ok", { headers: { "X-Kofra-Site": "s1" } });
      Object.defineProperty(res.headers, "set", {
        value: () => {
          throw new TypeError("Can't modify immutable headers.");
        },
      });
      return res;
    });
    const res = await app.request("/");
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("x-kofra-site")).toBe("s1");
    expect(res.headers.get("x-dropway-site")).toBe("s1");
  });

  it("serves the Agent Skill under its former name", async () => {
    for (const path of ["/.well-known/agent-skills/dropway/SKILL.md", "/.well-known/skills/dropway/SKILL.md"]) {
      const res = await dw.call(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/^name: kofra$/m);
    }
  });
});
