/**
 * BLIND failing acceptance: CLI version-delete replay contract (P3 scope).
 *
 * P3 is replay only. Historical-reference expansion/activation beyond the
 * newest window is EXPLICITLY OUT OF SCOPE: no beyond-500 direct mutation
 * tests, no requirement that explicit IDs skip the pre-existing bounded
 * selection/list reads, no new flag, no historical activation.
 *
 * Contract under test (delete --version only; restore is pinned separately):
 * - `delete <site> --version <explicit-id> --yes` preserves the current
 *   selection algorithm and receipt, generates one fresh cryptographic UUID
 *   per deliberate invocation, sends it as `Idempotency-Key` on the single
 *   DELETE .../versions/{id} mutation, and performs exactly ONE mutation
 *   fetch for 429 (including Retry-After), 5xx, network loss and 409.
 * - Exit 7 for 429/5xx/network, existing refusal exit 5 for 409.
 * - No extra read/probe AFTER the single mutation fails: discovery reads
 *   before selection are allowed and preserved; reads after the first
 *   mutation are forbidden.
 * - No --idempotency-key flag. Canonical confirm=slug behavior is preserved
 *   (covered by existing tests; this file pins it only to guard the wire).
 * - Later invocations use distinct UUIDs.
 *
 * Harness: real run() from src/main.ts, only fetch is stubbed.
 */
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, type Io } from "../src/main.ts";

const API = "https://delete-replay-fixture.example";
const SITE = "delete-replay-site";
const KEY = "dw_delete_replay_sentinel_not_a_real_key";

const OLD = {
  id: "ver_delete_old_01",
  number: 1,
  status: "ready",
  live: false,
  fileCount: 1,
  totalBytes: 5,
  createdAt: "2024-01-01T00:00:00.000Z",
  finalizedAt: "2024-01-01T00:00:00.000Z",
};
const LIVE = { ...OLD, id: "ver_delete_live_02", number: 2, live: true };

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Seen = {
  method: string;
  url: string;
  path: string;
  search: string;
  key: string | null;
  body: string;
};

type MutationBehavior =
  | { kind: "success" }
  | { kind: "status"; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: "sequence"; replies: Array<{ status: number; body: unknown; headers?: Record<string, string> } | { network: true }> }
  | { kind: "network" };

let work: string;
beforeEach(async () => {
  work = await mkdtemp(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "delete-replay-"),
  );
  vi.stubGlobal("fetch", async () => {
    throw new Error("Unexpected network outside delete replay fixture");
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(work, { recursive: true, force: true });
});

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function invoke(extra: string[], mutation: MutationBehavior) {
  const seen: Seen[] = [];
  let stdout = "";
  let stderr = "";
  let mutationCalls = 0;
  const history = [LIVE, OLD];

  const io: Io = {
    cwd: work,
    env: { KOFRA_CONFIG_DIR: join(work, "config"), KOFRA_API_KEY: KEY },
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    stdinIsTTY: false,
    stderrIsTTY: false,
    readStdin: async () => "",
    prompt: async () => {
      throw new Error("delete replay uses --yes and must never prompt");
    },
    fetch: (async (req: Request) => {
      const url = new URL(req.url);
      expect(url.origin).toBe(API);
      const body = await req.clone().text().catch(() => "");
      seen.push({
        method: req.method,
        url: req.url,
        path: url.pathname,
        search: url.search,
        key: req.headers.get("Idempotency-Key"),
        body,
      });
      const base = `/api/v1/sites/${SITE}`;
      if (req.method === "GET" && url.pathname === base) {
        return json({ site: { slug: SITE, currentVersionId: LIVE.id } });
      }
      if (req.method === "GET" && url.pathname === `${base}/versions`) {
        return json({ versions: history, currentVersionId: LIVE.id });
      }
      if (req.method === "GET" && url.pathname.startsWith(`${base}/versions/`)) {
        const ref = decodeURIComponent(url.pathname.slice(`${base}/versions/`.length));
        if (ref === OLD.id || ref === "v1" || ref === "1")
          return json({ site: SITE, version: OLD, missing: [] });
        if (ref === LIVE.id || ref === "live" || ref === "v2" || ref === "2")
          return json({ site: SITE, version: LIVE, missing: [] });
        return json(
          {
            error: {
              code: "version_not_found",
              message: "Version not found.",
              hint: "List the site's versions and use an id or version number from that list.",
            },
          },
          404,
        );
      }
      if (req.method === "DELETE" && url.pathname.startsWith(`${base}/versions/`)) {
        const idx = mutationCalls++;
        const confirm =
          url.searchParams.get("confirm") ??
          (body ? (JSON.parse(body) as { confirm?: unknown }).confirm : undefined);
        if (confirm !== SITE) {
          return json(
            { error: { code: "confirmation_required", message: "Confirm the canonical slug." } },
            400,
          );
        }
        if (mutation.kind === "success") {
          const id = decodeURIComponent(url.pathname.slice(`${base}/versions/`.length));
          return json({ deleted: true, id });
        }
        if (mutation.kind === "network") throw new TypeError("fixture network loss");
        if (mutation.kind === "status") {
          return json(mutation.body, mutation.status, mutation.headers ?? {});
        }
        const reply = mutation.replies[Math.min(idx, mutation.replies.length - 1)]!;
        if ("network" in reply) throw new TypeError("fixture network loss");
        return json(reply.body, reply.status, reply.headers ?? {});
      }
      return json(
        { error: { code: "unexpected_fixture_request", message: `${req.method} ${url.pathname}` } },
        400,
      );
    }) as Io["fetch"],
  };
  const code = await run(["delete", SITE, ...extra, "--api", API, "--json"], io);
  const mutations = seen.filter(
    (r) => r.method === "DELETE" && r.path.startsWith(`/api/v1/sites/${SITE}/versions/`),
  );
  return { code, stdout, stderr, seen, mutations };
}

function bodyOf(r: { stdout: string }) {
  const v = JSON.parse(r.stdout);
  expect(v !== null && typeof v === "object" && !Array.isArray(v)).toBe(true);
  return v as Record<string, unknown>;
}

function expectUuid(key: string | null) {
  expect(key, "DELETE must send Idempotency-Key").not.toBeNull();
  expect(key!).toMatch(UUID_V4);
}

function expectConfirm(m: Seen) {
  const url = new URL(m.url);
  const query = url.searchParams.get("confirm");
  const parsed = m.body ? (JSON.parse(m.body) as { confirm?: unknown }) : {};
  expect(query ?? parsed.confirm).toBe(SITE);
}

function expectNoReadsAfterMutation(seen: Seen[]) {
  const idx = seen.findIndex(
    (s) => s.method === "DELETE" && s.path.startsWith(`/api/v1/sites/${SITE}/versions/`),
  );
  if (idx === -1) return;
  expect(
    seen.slice(idx + 1).filter((s) => s.method === "GET" || s.method === "HEAD"),
    "no extra read/probe after the mutation",
  ).toEqual([]);
}

async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  async function visit(path: string) {
    let info;
    try {
      info = await stat(path);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = await readdir(path);
      } catch {
        return;
      }
      for (const e of entries) await visit(join(path, e));
    } else if (info.isFile()) {
      try {
        const text = await readFile(path, "utf8");
        if (text.includes(needle)) hits.push(path);
      } catch {
        // Binary or unreadable: ignore.
      }
    }
  }
  await visit(dir);
  return hits;
}

describe("version delete replay: explicit ID sends fresh UUID once", () => {
  it("success sends one UUID key on one DELETE with canonical confirm", async () => {
    const r = await invoke(["--version", OLD.id, "--yes"], { kind: "success" });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.mutations).toHaveLength(1);
    expect(r.mutations[0]!.path).toBe(
      `/api/v1/sites/${SITE}/versions/${OLD.id}`,
    );
    expectUuid(r.mutations[0]!.key);
    expectConfirm(r.mutations[0]!);
    expectNoReadsAfterMutation(r.seen);
  });

  it("429 with Retry-After: exactly one DELETE, exit 7, UUID, no reads after", async () => {
    const r = await invoke(["--version", OLD.id, "--yes"], {
      kind: "status",
      status: 429,
      headers: { "Retry-After": "0" },
      body: { error: { code: "rate_limited", message: "slow" } },
    });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expectConfirm(r.mutations[0]!);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expectNoReadsAfterMutation(r.seen);
  });

  it("429 then success still exits 7 with one DELETE (never retries)", async () => {
    const r = await invoke(["--version", OLD.id, "--yes"], {
      kind: "sequence",
      replies: [
        { status: 429, headers: { "Retry-After": "0" }, body: { error: { code: "rate_limited", message: "slow" } } },
        { status: 200, body: { deleted: true, id: OLD.id } },
      ],
    });
    expect(r.mutations).toHaveLength(1);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expectNoReadsAfterMutation(r.seen);
  });

  it.each([[500], [503]] as const)("%s: exactly one DELETE, exit 7, UUID, no reads after", async (status) => {
    const r = await invoke(["--version", OLD.id, "--yes"], {
      kind: "status",
      status,
      body: { error: { code: "internal_error", message: "boom" } },
    });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expectNoReadsAfterMutation(r.seen);
  });

  it("network loss: exactly one DELETE attempt, exit 7, UUID, no reads after", async () => {
    const r = await invoke(["--version", OLD.id, "--yes"], { kind: "network" });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expectNoReadsAfterMutation(r.seen);
  });

  it("network then success still exits 7 with one attempt", async () => {
    const r = await invoke(["--version", OLD.id, "--yes"], {
      kind: "sequence",
      replies: [{ network: true }, { status: 200, body: { deleted: true, id: OLD.id } }],
    });
    expect(r.mutations).toHaveLength(1);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expectNoReadsAfterMutation(r.seen);
  });

  it("409: exactly one DELETE, existing refusal exit 5, UUID, no reads after", async () => {
    const r = await invoke(["--version", OLD.id, "--yes"], {
      kind: "status",
      status: 409,
      body: { error: { code: "version_conflict", message: "moved", hint: "Refetch." } },
    });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expectNoReadsAfterMutation(r.seen);
  });

  it("mutation-response 404: nonzero refusal, one DELETE, no post-mutation probe", async () => {
    const r = await invoke(["--version", OLD.id, "--yes"], {
      kind: "status",
      status: 404,
      body: { error: { code: "version_not_found", message: "Version not found.", hint: "List versions." } },
    });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expectConfirm(r.mutations[0]!);
    expect(r.code, r.stdout + r.stderr).not.toBe(0);
    expect(bodyOf(r)).toMatchObject({ ok: false });
    expectNoReadsAfterMutation(r.seen);
    expect(r.stdout + r.stderr).not.toContain("Deleted version");
  });

  it("generated UUID is not persisted in any file under the work directory", async () => {
    const r = await invoke(["--version", OLD.id, "--yes"], { kind: "success" });
    expect(r.mutations).toHaveLength(1);
    const key = r.mutations[0]!.key;
    expectUuid(key);
    const hits = await filesContaining(work, key!);
    expect(hits, `UUID leaked into work files: ${hits.join(", ")}`).toEqual([]);
  });

  it("later delete invocations use distinct UUIDs", async () => {
    const a = await invoke(["--version", OLD.id, "--yes"], { kind: "success" });
    const b = await invoke(["--version", OLD.id, "--yes"], { kind: "success" });
    expect(a.mutations).toHaveLength(1);
    expect(b.mutations).toHaveLength(1);
    expectUuid(a.mutations[0]!.key);
    expectUuid(b.mutations[0]!.key);
    expect(a.mutations[0]!.key).not.toBe(b.mutations[0]!.key);
  });
});

describe("version delete has no idempotency-key flag", () => {
  it("rejects --idempotency-key as an unknown option before any fetch", async () => {
    const r = await invoke(["--version", OLD.id, "--yes", "--idempotency-key", "k1"], {
      kind: "success",
    });
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.seen).toEqual([]);
    expect(bodyOf(r)).toMatchObject({ ok: false, exitCode: 2 });
  });

  it("delete help advertises no key flag", async () => {
    let stdout = "";
    let stderr = "";
    const io: Io = {
      cwd: work,
      env: { KOFRA_CONFIG_DIR: join(work, "config") },
      stdout: (t) => void (stdout += t),
      stderr: (t) => void (stderr += t),
      stdinIsTTY: false,
      stderrIsTTY: false,
      readStdin: async () => "",
      prompt: async () => "",
      fetch: (async () => {
        throw new Error("help must stay offline");
      }) as unknown as Io["fetch"],
    };
    const code = await run(["delete", "--help"], io);
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).not.toContain("--idempotency-key");
  });
});
