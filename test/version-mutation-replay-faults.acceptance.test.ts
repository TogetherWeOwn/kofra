import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { clearLiveMemoryCache } from "@dropway/core";
import {
  ACTIONS, SLUG, SURFACES, bounded, claims, expectFailure, expectReplay, expectSuccess,
  fixture, input, observe, pointer, publish, signal, snapshot, transport, type Action, type Harness, type Outcome,
} from "./version-mutation-replay.helpers";

afterEach(() => { vi.restoreAllMocks(); clearLiveMemoryCache(); });

function expectExecutionFailure(r: Outcome) {
  expect(r.isError, "an uncertain mutation failure must not become a success receipt").toBe(true);
  expect(r.body.error?.code, "valid keyed input must reach the execution fault, not be rejected by the transport schema").not.toBe("invalid_request");
}

/**
 * Execute the actual disposable-D1 transaction, then lose its response, or fail
 * the subsequent live-manifest read. No row, changes count or commit is mocked.
 * The statement map only identifies the business batch, never a claim/result write.
 */
function databaseFault(action: Action, mode: "lost response" | "refresh read") {
  const prepare = env.DB.prepare.bind(env.DB);
  const batch = env.DB.batch.bind(env.DB);
  const sqlByStatement = new WeakMap<object, string>();
  let commits = 0;
  let readFailures = 0;
  const failure = new Error(`acceptance ${mode} after real ${action} commit`);
  vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    sqlByStatement.set(statement, sql);
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...values) => {
      const bound = bind(...values);
      sqlByStatement.set(bound, sql);
      if (mode === "refresh read" && /\bFROM\s+sites\s+s\s+LEFT\s+JOIN\s+versions\b/i.test(sql)) {
        const first = bound.first.bind(bound);
        vi.spyOn(bound, "first").mockImplementation(async (columnName?: string) => {
          if (commits === 1 && readFailures === 0) { readFailures++; throw failure; }
          return Reflect.apply(first, bound, columnName === undefined ? [] : [columnName]);
        });
      }
      return bound;
    });
    return statement;
  });
  vi.spyOn(env.DB, "batch").mockImplementation(async <T = unknown>(list: D1PreparedStatement[]) => {
    const business = commits === 0 && list.some(statement => {
      const sql = sqlByStatement.get(statement) ?? "";
      return action === "restore" ? /^\s*UPDATE\s+sites\s+SET\s+current_version_id\b/i.test(sql) : /^\s*DELETE\s+FROM\s+versions\b/i.test(sql);
    });
    const result = await batch<T>(list);
    if (business) {
      commits++;
      if (mode === "lost response") throw failure;
    }
    return result;
  });
  return { assertFired() {
    expect(commits, "fault must follow one real business commit").toBe(1);
    if (mode === "refresh read") expect(readFailures, "live-manifest D1 read must fail after pointer commit").toBe(1);
  } };
}

/** Hold a real target SELECT result while a same-key contender arrives. */
function pauseTarget(h: Harness) {
  const prepare = env.DB.prepare.bind(env.DB);
  const entered = signal();
  const release = signal();
  let reads = 0;
  vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (!/^\s*SELECT\b[\s\S]*\bFROM\s+versions\b/i.test(sql)) return statement;
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...values) => {
      const bound = bind(...values);
      if (!values.includes(h.target) || !values.includes(h.site.id)) return bound;
      const first = bound.first.bind(bound);
      vi.spyOn(bound, "first").mockImplementation(async (columnName?: string) => {
        const row = await Reflect.apply(first, bound, columnName === undefined ? [] : [columnName]);
        reads++;
        if (reads === 1) {
          expect(row).toMatchObject({ id: h.target, site_id: h.site.id });
          entered.resolve();
          await release.promise;
        }
        return row;
      });
      return bound;
    });
    return statement;
  });
  return { entered: entered.promise, release: release.resolve, reads: () => reads };
}

for (const surface of SURFACES) describe(`${surface} uncertain version mutation outcomes`, () => {
  it.each(["KV put", "D1 read"] as const)("retains a pending restore after %s fails following pointer commit", async fault => {
    const h = await fixture();
    const t = await transport(h, surface);
    try {
      let puts = 0;
      let dbFault: ReturnType<typeof databaseFault> | undefined;
      if (fault === "KV put") {
        const put = env.CACHE.put.bind(env.CACHE);
        vi.spyOn(env.CACHE, "put").mockImplementation(async (key, value, options) => {
          if (key === `live:${SLUG}` && puts++ === 0) throw new Error("acceptance KV put failed after restore commit");
          return put(key, value, options);
        });
      } else dbFault = databaseFault("restore", "refresh read");
      const a = input(h, "restore");
      const first = await t.invoke("restore", a);
      expectExecutionFailure(first);
      expect(await pointer(h), "the pointer REALLY committed despite the error response").toBe(h.target);
      if (fault === "KV put") expect(puts).toBe(1); else dbFault!.assertFired();
      expect.soft((await claims()).map(row => row.state), "callback failure must leave an unknown-outcome claim").toEqual(["pending"]);
      vi.restoreAllMocks();
      const winner = await publish(h.dw, "another actor wins after an uncertain restore");
      const before = await snapshot();
      const observed = observe(h);
      const retry = await t.invoke("restore", a);
      expectFailure(retry, 409, "idempotency_in_progress");
      observed.expectNoAction();
      expect.soft(await pointer(h), "a retry MUST NOT restore over the new publisher").toBe(winner);
      expect.soft(await snapshot()).toEqual(before);
    } finally { await t.close(); }
  });

  for (const action of ACTIONS) describe(action, () => {
    it("retains the claim when a real committed D1 mutation loses its response", async () => {
      const h = await fixture();
      const t = await transport(h, surface);
      try {
        const fault = databaseFault(action, "lost response");
        const a = input(h, action);
        const first = await t.invoke(action, a);
        expectExecutionFailure(first);
        fault.assertFired();
        if (action === "restore") expect(await pointer(h)).toBe(h.target);
        else expect(await env.DB.prepare("SELECT id FROM versions WHERE id = ?").bind(h.target).first()).toBeNull();
        vi.restoreAllMocks();
        if (action === "restore") await publish(h.dw, "publisher after ambiguous DB response");
        const before = await snapshot();
        const observed = observe(h);
        expectFailure(await t.invoke(action, a), 409, "idempotency_in_progress");
        observed.expectNoAction();
        expect.soft(await snapshot()).toEqual(before);
      } finally { await t.close(); }
    });

    it("preserves the first successful response but fails closed after real replay-persistence failure", async () => {
      const h = await fixture();
      const t = await transport(h, surface);
      await env.DB.prepare(`CREATE TRIGGER acceptance_reject_version_replay
        BEFORE UPDATE OF state ON idempotency_keys WHEN NEW.state = 'done'
        BEGIN SELECT RAISE(ABORT, 'acceptance version replay persistence failed'); END;`).run();
      try {
        const a = input(h, action);
        const first = await t.invoke(action, a);
        expectSuccess(first);
        expect(first.body).toMatchObject(action === "restore" ? { restored: true, version: { id: h.target } } : { deleted: true, id: h.target });
        expect.soft((await claims()).map(row => row.state)).toEqual(["pending"]);
        await env.DB.exec("DROP TRIGGER acceptance_reject_version_replay");
        if (action === "restore") await publish(h.dw, "publisher after persistence failed");
        const before = await snapshot();
        const observed = observe(h);
        expectFailure(await t.invoke(action, a), 409, "idempotency_in_progress");
        observed.expectNoAction();
        expect.soft(await snapshot()).toEqual(before);
      } finally {
        await env.DB.exec("DROP TRIGGER IF EXISTS acceptance_reject_version_replay");
        await t.close();
      }
    });

    it("conservatively retains the claim even after a callback's real SQL transaction aborts", async () => {
      const h = await fixture();
      const t = await transport(h, surface);
      const when = action === "restore" ? "BEFORE UPDATE OF current_version_id ON sites" : "BEFORE DELETE ON versions";
      await env.DB.prepare(`CREATE TRIGGER acceptance_abort_version_action ${when}
        BEGIN SELECT RAISE(ABORT, 'acceptance version action aborted'); END;`).run();
      try {
        const before = await snapshot();
        const a = input(h, action);
        const first = await t.invoke(action, a);
        expectExecutionFailure(first);
        expect(await snapshot(), "the actual D1 batch rolled back").toEqual(before);
        await env.DB.exec("DROP TRIGGER acceptance_abort_version_action");
        const observed = observe(h);
        expectFailure(await t.invoke(action, a), 409, "idempotency_in_progress");
        observed.expectNoAction();
        expect.soft(await snapshot()).toEqual(before);
      } finally {
        await env.DB.exec("DROP TRIGGER IF EXISTS acceptance_abort_version_action");
        await t.close();
      }
    });

    it("serializes same-key contenders without resolving or executing the second target", async () => {
      const h = await fixture();
      const firstClient = await transport(h, surface);
      const secondClient = await transport(h, surface);
      const pause = pauseTarget(h);
      const a = input(h, action);
      const first = firstClient.invoke(action, a);
      let duplicate: Promise<Outcome> | undefined;
      try {
        await bounded(Promise.race([pause.entered, first.then(result => {
          expectSuccess(result);
          throw new Error("first request missed the target-read hold");
        })]), "first request must acquire the claim and reach target resolution");
        const before = await snapshot();
        duplicate = secondClient.invoke(action, a);
        expectFailure(await bounded(duplicate, "a pending claim must refuse, not wait for its owner"), 409, "idempotency_in_progress");
        expectFailure(await secondClient.invoke(action, input(h, action, h.second)), 422, "idempotency_key_reused");
        expect.soft(pause.reads(), "only the owner may resolve a target").toBe(1);
        expect.soft(await snapshot()).toEqual(before);
        pause.release();
        const completed = await first;
        expectSuccess(completed);
        expectReplay(await secondClient.invoke(action, a), completed);
      } finally {
        pause.release();
        await Promise.allSettled([first, ...(duplicate ? [duplicate] : [])]);
        await firstClient.close(); await secondClient.close();
      }
    });
  });
});
