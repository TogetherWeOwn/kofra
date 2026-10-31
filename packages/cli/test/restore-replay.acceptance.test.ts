/**
 * BLIND failing acceptance: CLI restore replay contract (P3 scope).
 *
 * P3 is replay only. Historical-reference expansion/activation beyond the
 * newest window is EXPLICITLY OUT OF SCOPE: no beyond-500 direct mutation
 * tests, no requirement that explicit IDs skip the pre-existing bounded
 * selection/list reads, no new flag, no historical activation.
 *
 * Contract under test (restore only; delete is pinned separately):
 * - `restore <site> <explicit-current-id>` and `restore <site>` (omitted,
 *   default one-before-live) preserve the current selection algorithm and
 *   receipt, generate one fresh cryptographic UUID per deliberate
 *   invocation, send it as `Idempotency-Key` on the POST .../restore
 *   mutation, and perform exactly ONE mutation fetch for 429 (including
 *   Retry-After), 5xx, network loss and 409.
 * - Exit 7 for 429/5xx/network, existing refusal exit 5 for 409.
 * - No extra read/probe AFTER the single mutation fails (or after a
 *   synthetic success): discovery reads before selection are allowed and
 *   preserved; reads after the first mutation are forbidden.
 * - No --idempotency-key flag (unknown-option usage refusal, no fetch).
 * - Later invocations use distinct UUIDs. Omitted selection stays stable.
 *
 * Harness: real run() from src/main.ts, only fetch is stubbed. Disposable
 * temp dirs under PAPERCLIP_RUN_SCRATCH_DIR. No real network.
 */
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, type Io } from "../src/main.ts";

const API = "https://restore-replay-fixture.example";
const SITE = "replay-site";
const KEY = "dw_restore_replay_sentinel_not_a_real_key";

const PREV = {
  id: "ver_replay_prev_01",
  number: 1,
  status: "ready",
  live: false,
  fileCount: 1,
  totalBytes: 5,
  createdAt: "2024-01-01T00:00:00.000Z",
  finalizedAt: "2024-01-01T00:00:00.000Z",
};
const LIVE = {
  ...PREV,
  id: "ver_replay_live_02",
  number: 2,
  live: true,
};

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
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "restore-replay-"),
  );
  vi.stubGlobal("fetch", async () => {
    throw new Error("Unexpected network outside restore replay fixture");
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

async function invoke(args: string[], mutation: MutationBehavior) {
  const seen: Seen[] = [];
  let stdout = "";
  let stderr = "";
  let mutationCalls = 0;
  const history = [LIVE, PREV];

  const io: Io = {
    cwd: work,
    env: { KOFRA_CONFIG_DIR: join(work, "config"), KOFRA_API_KEY: KEY },
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    stdinIsTTY: false,
    stderrIsTTY: false,
    readStdin: async () => "",
    prompt: async () => {
      throw new Error("restore replay must never prompt");
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
        if (ref === LIVE.id || ref === "live" || ref === "v2" || ref === "2")
          return json({ site: SITE, version: LIVE, missing: [] });
        if (ref === PREV.id || ref === "v1" || ref === "1")
          return json({ site: SITE, version: PREV, missing: [] });
        return json(
          {
            error: {
              code: "version_not_found",
              message: "Version not found.",
              hint: "List the site's versions and use an id or version number from that list.",
            },
            requestId: "req_restore_replay",
          },
          404,
        );
      }
      if (req.method === "POST" && url.pathname.endsWith("/restore")) {
        const idx = mutationCalls++;
        if (mutation.kind === "success") {
          const id = decodeURIComponent(
            url.pathname.slice(`${base}/versions/`.length, -"/restore".length),
          );
          const version = id === LIVE.id ? LIVE : PREV;
          return json({
            restored: version.id !== LIVE.id,
            alreadyLive: version.id === LIVE.id,
            version,
            url: `${API}/s/${SITE}/`,
          });
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
  const code = await run([...args, "--api", API, "--json"], io);
  const mutations = seen.filter((r) => r.method === "POST" && r.path.endsWith("/restore"));
  const lists = seen.filter(
    (r) => r.method === "GET" && r.path === `/api/v1/sites/${SITE}/versions`,
  );
  return { code, stdout, stderr, seen, mutations, lists };
}

function bodyOf(r: { stdout: string }) {
  const v = JSON.parse(r.stdout);
  expect(v !== null && typeof v === "object" && !Array.isArray(v)).toBe(true);
  return v as Record<string, unknown>;
}

function expectUuid(key: string | null) {
  expect(key, "mutation must send Idempotency-Key").not.toBeNull();
  expect(key!).toMatch(UUID_V4);
  expect(key!.toLowerCase()).not.toBe("00000000-0000-4000-8000-000000000000");
}

function readsAfterFirstMutation(seen: Seen[]): Seen[] {
  const idx = seen.findIndex((s) => s.method === "POST" && s.path.endsWith("/restore"));
  if (idx === -1) return [];
  return seen.slice(idx + 1).filter((s) => s.method === "GET" || s.method === "HEAD");
}

function expectNoReadsAfterMutation(seen: Seen[]) {
  expect(readsAfterFirstMutation(seen), "no extra read/probe after the mutation").toEqual([]);
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
        // Binary or unreadable: ignore for UUID persistence check.
      }
    }
  }
  await visit(dir);
  return hits;
}

describe("restore explicit current ID: fresh UUID, one mutation after selection", () => {
  it("success sends one UUID key on one POST, preserving selection reads", async () => {
    const r = await invoke(["restore", SITE, LIVE.id], { kind: "success" });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.mutations).toHaveLength(1);
    expect(r.mutations[0]!.path).toBe(
      `/api/v1/sites/${SITE}/versions/${LIVE.id}/restore`,
    );
    expectUuid(r.mutations[0]!.key);
    expectNoReadsAfterMutation(r.seen);
    expect(bodyOf(r)).toMatchObject({ ok: true });
  });

  it("explicit 429 with Retry-After: exactly one POST, exit 7, UUID, no reads after", async () => {
    const r = await invoke(["restore", SITE, LIVE.id], {
      kind: "status",
      status: 429,
      headers: { "Retry-After": "0" },
      body: { error: { code: "rate_limited", message: "slow down", hint: "Retry later." } },
    });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expect(bodyOf(r)).toMatchObject({ ok: false, exitCode: 7 });
    expectNoReadsAfterMutation(r.seen);
  });

  it("explicit 429 without Retry-After: exactly one POST, exit 7, UUID", async () => {
    const r = await invoke(["restore", SITE, LIVE.id], {
      kind: "status",
      status: 429,
      body: { error: { code: "rate_limited", message: "slow", hint: "Retry later." } },
    });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expectNoReadsAfterMutation(r.seen);
  });

  it("explicit 429 then success still surfaces exit 7 with one POST (never retries)", async () => {
    const r = await invoke(["restore", SITE, LIVE.id], {
      kind: "sequence",
      replies: [
        { status: 429, headers: { "Retry-After": "0" }, body: { error: { code: "rate_limited", message: "slow" } } },
        { status: 200, body: { restored: false, alreadyLive: true, version: LIVE, url: `${API}/s/${SITE}/` } },
      ],
    });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expect(bodyOf(r)).toMatchObject({ ok: false, exitCode: 7 });
    expectNoReadsAfterMutation(r.seen);
  });

  it.each([[500], [503]] as const)("explicit %s: exactly one POST, exit 7, UUID key", async (status) => {
    const r = await invoke(["restore", SITE, LIVE.id], {
      kind: "status",
      status,
      body: { error: { code: "internal_error", message: "boom" } },
    });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expectNoReadsAfterMutation(r.seen);
  });

  it("explicit 500 then success still surfaces exit 7 with one POST", async () => {
    const r = await invoke(["restore", SITE, LIVE.id], {
      kind: "sequence",
      replies: [
        { status: 500, body: { error: { code: "internal_error", message: "boom" } } },
        { status: 200, body: { restored: false, alreadyLive: true, version: LIVE, url: `${API}/s/${SITE}/` } },
      ],
    });
    expect(r.mutations).toHaveLength(1);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expectNoReadsAfterMutation(r.seen);
  });

  it("explicit network loss: exactly one POST attempt, exit 7, UUID key", async () => {
    const r = await invoke(["restore", SITE, LIVE.id], { kind: "network" });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expect(bodyOf(r)).toMatchObject({ ok: false, exitCode: 7 });
    expectNoReadsAfterMutation(r.seen);
  });

  it("explicit network then success still surfaces exit 7 with one attempt", async () => {
    const r = await invoke(["restore", SITE, LIVE.id], {
      kind: "sequence",
      replies: [
        { network: true },
        { status: 200, body: { restored: false, alreadyLive: true, version: LIVE, url: `${API}/s/${SITE}/` } },
      ],
    });
    expect(r.mutations).toHaveLength(1);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expectNoReadsAfterMutation(r.seen);
  });

  it("explicit 409: exactly one POST, existing refusal exit 5, UUID key", async () => {
    const r = await invoke(["restore", SITE, LIVE.id], {
      kind: "status",
      status: 409,
      body: { error: { code: "version_conflict", message: "moved", hint: "Refetch and retry." } },
    });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(bodyOf(r)).toMatchObject({ ok: false, exitCode: 5 });
    expectNoReadsAfterMutation(r.seen);
  });

  it("explicit mutation-response 404: nonzero refusal, one POST, no post-mutation probe", async () => {
    const r = await invoke(["restore", SITE, LIVE.id], {
      kind: "status",
      status: 404,
      body: { error: { code: "version_not_found", message: "Version not found.", hint: "List versions." } },
    });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).not.toBe(0);
    expect(bodyOf(r)).toMatchObject({ ok: false });
    expect(bodyOf(r).ok).toBe(false);
    expectNoReadsAfterMutation(r.seen);
    expect(r.stdout + r.stderr).not.toContain("already live");
  });

  it("generated UUID is not persisted in any file under the work directory", async () => {
    const r = await invoke(["restore", SITE, LIVE.id], { kind: "success" });
    expect(r.mutations).toHaveLength(1);
    const key = r.mutations[0]!.key;
    expectUuid(key);
    const hits = await filesContaining(work, key!);
    expect(hits, `UUID leaked into work files: ${hits.join(", ")}`).toEqual([]);
  });

  it("later explicit invocations use distinct UUIDs", async () => {
    const a = await invoke(["restore", SITE, LIVE.id], { kind: "success" });
    const b = await invoke(["restore", SITE, LIVE.id], { kind: "success" });
    expect(a.mutations).toHaveLength(1);
    expect(b.mutations).toHaveLength(1);
    expectUuid(a.mutations[0]!.key);
    expectUuid(b.mutations[0]!.key);
    expect(a.mutations[0]!.key).not.toBe(b.mutations[0]!.key);
  });
});

describe("restore omitted selection: stable one-before-live, fresh UUIDs, one mutation", () => {
  it("omitted selects the same one-before-live ID across invocations with distinct UUIDs", async () => {
    const a = await invoke(["restore", SITE], { kind: "success" });
    const b = await invoke(["restore", SITE], { kind: "success" });
    expect(a.code, a.stdout + a.stderr).toBe(0);
    expect(b.code, b.stdout + b.stderr).toBe(0);
    expect(a.mutations).toHaveLength(1);
    expect(b.mutations).toHaveLength(1);
    expect(a.mutations[0]!.path).toBe(
      `/api/v1/sites/${SITE}/versions/${PREV.id}/restore`,
    );
    expect(b.mutations[0]!.path).toBe(a.mutations[0]!.path);
    expectUuid(a.mutations[0]!.key);
    expectUuid(b.mutations[0]!.key);
    expect(a.mutations[0]!.key).not.toBe(b.mutations[0]!.key);
  });

  it("omitted preserves discovery then one mutation (no extra probes after)", async () => {
    const r = await invoke(["restore", SITE], { kind: "success" });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.lists.length).toBeGreaterThanOrEqual(1);
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expectNoReadsAfterMutation(r.seen);
    expect(
      r.seen.filter((s) => s.method !== "GET" && !(s.method === "POST" && s.path.endsWith("/restore"))),
      "no non-restore mutations",
    ).toEqual([]);
  });

  it("omitted 429 with Retry-After: one mutation, exit 7, UUID, no reads after", async () => {
    const r = await invoke(["restore", SITE], {
      kind: "status",
      status: 429,
      headers: { "Retry-After": "0" },
      body: { error: { code: "rate_limited", message: "slow" } },
    });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expectNoReadsAfterMutation(r.seen);
  });

  it("omitted 500: one mutation, exit 7, UUID, no reads after", async () => {
    const r = await invoke(["restore", SITE], {
      kind: "status",
      status: 500,
      body: { error: { code: "internal_error", message: "boom" } },
    });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expectNoReadsAfterMutation(r.seen);
  });

  it("omitted network loss: one mutation attempt, exit 7, UUID, no reads after", async () => {
    const r = await invoke(["restore", SITE], { kind: "network" });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expectNoReadsAfterMutation(r.seen);
  });

  it("omitted 409: one mutation, exit 5, UUID, no reads after", async () => {
    const r = await invoke(["restore", SITE], {
      kind: "status",
      status: 409,
      body: { error: { code: "version_conflict", message: "moved", hint: "Refetch." } },
    });
    expect(r.mutations).toHaveLength(1);
    expectUuid(r.mutations[0]!.key);
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expectNoReadsAfterMutation(r.seen);
  });

  it("omitted 429 then success still exits 7 with one mutation", async () => {
    const r = await invoke(["restore", SITE], {
      kind: "sequence",
      replies: [
        { status: 429, headers: { "Retry-After": "0" }, body: { error: { code: "rate_limited", message: "slow" } } },
        { status: 200, body: { restored: true, alreadyLive: false, version: PREV, url: `${API}/s/${SITE}/` } },
      ],
    });
    expect(r.mutations).toHaveLength(1);
    expect(r.code, r.stdout + r.stderr).toBe(7);
    expectNoReadsAfterMutation(r.seen);
  });
});

describe("restore has no idempotency-key flag", () => {
  it("rejects --idempotency-key as an unknown option before any fetch", async () => {
    const r = await invoke(
      ["restore", SITE, LIVE.id, "--idempotency-key", "k1"],
      { kind: "success" },
    );
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.seen).toEqual([]);
    expect(bodyOf(r)).toMatchObject({ ok: false, exitCode: 2 });
  });

  it("restore help advertises no key flag", async () => {
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
    const code = await run(["restore", "--help"], io);
    expect(code).toBe(0);
    expect(stdout.toLowerCase()).not.toContain("--idempotency-key");
  });
});
