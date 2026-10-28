import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, type Io } from "../src/main.ts";

const origin = "https://delete-fixture.example";
const slug = "canonical-site";
const old = { id: "ver_old", number: 1, status: "ready", live: false, fileCount: 1, totalBytes: 5, createdAt: "2024-01-01T00:00:00Z", finalizedAt: "2024-01-01T00:00:00Z" };
const live = { ...old, id: "ver_live", number: 2, live: true };
let work: string;
beforeEach(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "delete-confirm-"));
  vi.stubGlobal("fetch", async () => { throw new Error("Unexpected network"); });
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(work, { recursive: true, force: true }); });

async function invoke(args: string[], answer?: string) {
  const requests: { method: string; url: URL; body: string }[] = [];
  const prompts: string[] = [];
  let output = "";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const io: Io = {
    cwd: work, env: { KOFRA_CONFIG_DIR: join(work, "config"), KOFRA_API_KEY: "dw_disposable_test" },
    stdout: s => { output += s; }, stderr: s => { output += s; },
    stdinIsTTY: answer !== undefined, stderrIsTTY: answer !== undefined,
    readStdin: async () => "", prompt: async question => { prompts.push(question); return answer ?? ""; },
    fetch: async req => {
      const url = new URL(req.url);
      expect(url.origin).toBe(origin);
      const body = await req.clone().text();
      requests.push({ method: req.method, url, body });
      const base = `/api/v1/sites/${encodeURIComponent(args[1]!)}`;
      if (req.method === "GET" && url.pathname === base) return json({ site: { slug, currentVersionId: live.id } });
      if (req.method === "GET" && url.pathname === `${base}/versions`) return json({ versions: [live, old], currentVersionId: live.id });
      if (req.method === "GET" && url.pathname.startsWith(`${base}/versions/`)) return json({ site: slug, version: old, missing: [] });
      if (req.method === "DELETE" && url.pathname === `${base}/versions/${old.id}`) {
        const confirmation = url.searchParams.get("confirm") ?? (body ? JSON.parse(body).confirm : undefined);
        return confirmation === slug ? json({ deleted: true, id: old.id }) : json({ error: { code: "confirmation_required", message: "Confirm the canonical slug." } }, 400);
      }
      if (req.method === "POST" && url.pathname === `${base}/versions/${old.id}/restore`) return json({ restored: true, alreadyLive: false, version: old, url: `${origin}/s/${slug}/` });
      return json({ error: { code: "unexpected_fixture_request", message: `${req.method} ${url.pathname}` } }, 400);
    },
  };
  const code = await run([...args, "--api", origin], io);
  return { code, output, requests, prompts };
}

describe("version deletion confirms the canonical site on the wire", () => {
  it.each([["--yes"], ["-y"]])("sends confirmation after %s and completes the delete", async flag => {
    const r = await invoke(["delete", slug, "--version", "v1", flag]);
    expect(r.prompts).toEqual([]);
    const writes = r.requests.filter(request => request.method === "DELETE");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url.pathname).toBe(`/api/v1/sites/${slug}/versions/${old.id}`);
    const query = writes[0]!.url.searchParams.get("confirm");
    const body = writes[0]!.body ? JSON.parse(writes[0]!.body).confirm : null;
    expect(query ?? body).toBe(slug);
    if (query && body) expect(body).toBe(query);
    expect(r.code, r.output).toBe(0);
  });

  it("keeps the typed prompt and sends confirmation only when it matches", async () => {
    const r = await invoke(["delete", slug, "--version", "v1"], slug);
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toContain(slug);
    const writes = r.requests.filter(request => request.method === "DELETE");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url.searchParams.get("confirm") ?? (writes[0]!.body ? JSON.parse(writes[0]!.body).confirm : null)).toBe(slug);
    expect(r.code, r.output).toBe(0);
  });

  it.each(["wrong-site", ""])("rejects prompt response %j without a mutation", async answer => {
    const r = await invoke(["delete", slug, "--version", "v1"], answer);
    expect(r.prompts).toHaveLength(1);
    expect(r.code).not.toBe(0);
    expect(r.requests.filter(request => !["GET", "HEAD"].includes(request.method))).toEqual([]);
  });

  it("without a terminal or --yes refuses without a mutation", async () => {
    const r = await invoke(["delete", slug, "--version", "v1"]);
    expect(r.prompts).toEqual([]);
    expect(r.code).not.toBe(0);
    expect(r.requests.filter(request => !["GET", "HEAD"].includes(request.method))).toEqual([]);
  });

  it("does not introduce a confirmation prompt for restore", async () => {
    const r = await invoke(["restore", slug, "v1"], "wrong-site");
    expect(r.prompts).toEqual([]);
    expect(r.requests.filter(request => request.method === "POST")).toHaveLength(1);
    expect(r.code, r.output).toBe(0);
  });
});

/**
 * Non-canonical supported site names. The server resolves a site name
 * case-insensitively (the stored slug is canonical lowercase) but requires the
 * destructive confirmation to equal that canonical slug exactly. The CLI must
 * therefore send the canonical stored slug, not the raw positional, while keeping
 * the prompt, typed-argument and refusal behavior. Only endpoints that exist today
 * are served: a canonical lookup may use them, but no new endpoint is available.
 */
async function invokeNamed(rawName: string, extra: string[], answer?: string) {
  const requests: { method: string; url: URL; body: string }[] = [];
  const prompts: string[] = [];
  let output = "";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const io: Io = {
    cwd: work, env: { KOFRA_CONFIG_DIR: join(work, "config"), KOFRA_API_KEY: "dw_disposable_test" },
    stdout: s => { output += s; }, stderr: s => { output += s; },
    stdinIsTTY: answer !== undefined, stderrIsTTY: answer !== undefined,
    readStdin: async () => "", prompt: async question => { prompts.push(question); return answer ?? ""; },
    fetch: async req => {
      const url = new URL(req.url);
      expect(url.origin).toBe(origin);
      const body = await req.clone().text();
      requests.push({ method: req.method, url, body });
      const match = /^\/api\/v1\/sites\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!match || decodeURIComponent(match[1]!).toLowerCase() !== slug) {
        return json({ error: { code: "site_not_found", message: "No such site." } }, 404);
      }
      const rest = match[2] ?? "";
      if (req.method === "GET" && rest === "") return json({ site: { slug, currentVersionId: live.id } });
      if (req.method === "GET" && rest === "/versions") return json({ versions: [live, old], currentVersionId: live.id });
      const single = /^\/versions\/([^/]+)$/.exec(rest);
      if (req.method === "GET" && single) {
        const ref = decodeURIComponent(single[1]!);
        if (["v1", "1", old.id].includes(ref)) return json({ site: slug, version: old, missing: [] });
        if (["live", "v2", "2", live.id].includes(ref)) return json({ site: slug, version: live, missing: [] });
        return json({ error: { code: "version_not_found", message: "No such version." } }, 404);
      }
      if (req.method === "DELETE" && single && decodeURIComponent(single[1]!) === old.id) {
        const confirmation = url.searchParams.get("confirm") ?? (body ? JSON.parse(body).confirm : undefined);
        return confirmation === slug
          ? json({ deleted: true, id: old.id })
          : json({ error: { code: "confirm_mismatch", message: `Set confirm to the site's slug ("${slug}").` } }, 400);
      }
      return json({ error: { code: "unexpected_fixture_request", message: `${req.method} ${url.pathname}` } }, 400);
    },
  };
  const code = await run(["delete", rawName, ...extra, "--api", origin], io);
  const writes = requests.filter(request => !["GET", "HEAD"].includes(request.method));
  return { code, output, requests, prompts, writes };
}

const confirmationOf = (request: { url: URL; body: string }) =>
  request.url.searchParams.get("confirm") ?? (request.body ? JSON.parse(request.body).confirm : undefined);

describe("version deletion with a non-canonical site name confirms the canonical stored slug", () => {
  it.each(["Canonical-Site", "CANONICAL-SITE"])("%s --yes deletes the historical version and sends the canonical slug", async rawName => {
    const r = await invokeNamed(rawName, ["--version", "v1", "--yes"]);
    expect(r.prompts).toEqual([]);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]!.method).toBe("DELETE");
    expect(decodeURIComponent(r.writes[0]!.url.pathname).toLowerCase()).toBe(`/api/v1/sites/${slug}/versions/${old.id}`);
    expect(confirmationOf(r.writes[0]!), "the wire confirmation is the canonical stored slug, not the typed name").toBe(slug);
    expect(r.code, r.output).toBe(0);
  });

  it("keeps the typed prompt: the typed name is accepted and the canonical slug is sent", async () => {
    const r = await invokeNamed("Canonical-Site", ["--version", "v1"], "Canonical-Site");
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]!.toLowerCase()).toContain(slug);
    expect(r.writes).toHaveLength(1);
    expect(confirmationOf(r.writes[0]!)).toBe(slug);
    expect(r.code, r.output).toBe(0);
  });

  it.each(["wrong-site", ""])("a refused prompt answer %j sends no mutation", async answer => {
    const r = await invokeNamed("Canonical-Site", ["--version", "v1"], answer);
    expect(r.prompts).toHaveLength(1);
    expect(r.code).not.toBe(0);
    expect(r.writes).toEqual([]);
  });

  it("without a terminal or --yes refuses without a mutation", async () => {
    const r = await invokeNamed("CANONICAL-SITE", ["--version", "v1"]);
    expect(r.prompts).toEqual([]);
    expect(r.code).not.toBe(0);
    expect(r.writes).toEqual([]);
  });
});
