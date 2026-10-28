import { expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { SiteRow } from "@dropway/core";

/**
 * Deterministic interleaving over real disposable D1/R2/KV, shared by the
 * version-restore/delete identity and ownership acceptance suites.
 *
 * A competitor runs real services and SQL while the request under test is
 * paused at a precise point; nothing here fabricates rows or write results.
 * While a competitor runs, every spy passes straight through so its own
 * statements are neither recorded nor able to re-trigger the interleaving.
 */
export type Competitor = () => Promise<void>;
export type SqlProbe = (sql: string, values: unknown[]) => boolean;

export interface InterleavePlan {
  /** Runs once, immediately before the first real D1 batch (the fenced write). */
  beforeBatch?: Competitor;
  /**
   * Runs once, immediately before the first real SELECT that satisfies `matches`
   * executes. When `beforeBatch` is also set, only reads after that batch count.
   */
  beforeSelect?: { matches: SqlProbe; compete: Competitor };
}

export function interleave(plan: InterleavePlan) {
  const prepare = env.DB.prepare.bind(env.DB);
  const batch = env.DB.batch.bind(env.DB);
  const fired = { batch: 0, select: 0 };
  const statements: string[] = [];
  let competing = false;
  const run = async (compete: Competitor) => {
    competing = true;
    try { await compete(); } finally { competing = false; }
  };
  const selectArmed = () => !competing && fired.select === 0 && (!plan.beforeBatch || fired.batch > 0);
  vi.spyOn(env.DB, "batch").mockImplementation(async <T = unknown>(list: D1PreparedStatement[]) => {
    if (plan.beforeBatch && !competing && fired.batch === 0) {
      fired.batch++;
      await run(plan.beforeBatch);
    }
    return batch<T>(list);
  });
  vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    if (!competing) statements.push(sql);
    const statement = prepare(sql);
    const select = plan.beforeSelect;
    if (!select || !/^\s*SELECT\b/i.test(sql)) return statement;
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...values) => {
      const bound = bind(...values);
      if (!selectArmed() || !select.matches(sql, values)) return bound;
      const first = bound.first.bind(bound);
      vi.spyOn(bound, "first").mockImplementation(async (columnName?: string) => {
        if (selectArmed()) {
          fired.select++;
          await run(select.compete);
        }
        return Reflect.apply(first, bound, columnName === undefined ? [] : [columnName]);
      });
      return bound;
    });
    return statement;
  });
  return {
    /** SQL prepared by the request under test (competitor statements excluded). */
    statements,
    /** Forget statements prepared so far, for example right after a competitor finished. */
    forget: () => { statements.length = 0; },
    done() {
      if (plan.beforeBatch) expect(fired.batch, "the fenced write batch must be reached once").toBe(1);
      if (plan.beforeSelect) expect(fired.select, "the deterministic read interleaving must execute once").toBe(1);
    },
  };
}

/** Spy on every prepared statement without interleaving; competitor-free tests only. */
export function recordStatements() {
  const prepare = env.DB.prepare.bind(env.DB);
  const statements: string[] = [];
  vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    statements.push(sql);
    return prepare(sql);
  });
  return statements;
}

export const isMutation = (sql: string) => /^\s*(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(sql);
export const readsVersions = (sql: string) => /^\s*SELECT\b[\s\S]*\bFROM\s+versions\b/i.test(sql);

/**
 * Every row of the tables a restore or delete could touch, including unjoined
 * children, usage and blob accounting, plus the live-cache entry of each slug.
 */
export async function worldState(extraSlugs: string[] = []) {
  const sites = (await env.DB.prepare("SELECT * FROM sites ORDER BY id").all<SiteRow>()).results;
  const versions = (await env.DB.prepare("SELECT * FROM versions ORDER BY id").all()).results;
  const files = (await env.DB.prepare("SELECT * FROM version_files ORDER BY version_id, path").all()).results;
  const usage = (await env.DB.prepare("SELECT * FROM usage_counters ORDER BY tenant_id, key").all()).results;
  const blobs = (await env.DB.prepare("SELECT * FROM blobs ORDER BY sha256").all()).results;
  const scopes = (await env.DB.prepare("SELECT * FROM blob_scopes ORDER BY scope, sha256").all()).results;
  const slugs = [...new Set([...sites.map((site) => site.slug), ...extraSlugs])].sort();
  const cache = await Promise.all(slugs.map(async (slug) => [slug, await env.CACHE.get(`live:${slug}`)]));
  return { sites, versions, files, usage, blobs, scopes, cache };
}

/** Spies for effects a refused request must never produce. */
export function effectSpies(clearSinks: () => void, sinks: () => unknown[][]) {
  const put = vi.spyOn(env.CACHE, "put");
  const remove = vi.spyOn(env.CACHE, "delete");
  const r2put = vi.spyOn(env.FILES, "put");
  const r2delete = vi.spyOn(env.FILES, "delete");
  const clear = () => {
    put.mockClear();
    remove.mockClear();
    r2put.mockClear();
    r2delete.mockClear();
    clearSinks();
  };
  clear();
  return {
    clear,
    expectNoEffects() {
      expect.soft(put, "the request must not refresh live KV").not.toHaveBeenCalled();
      expect.soft(remove, "the request must not invalidate live KV").not.toHaveBeenCalled();
      expect.soft(r2put, "the request must not write R2").not.toHaveBeenCalled();
      expect.soft(r2delete, "the request must not delete R2").not.toHaveBeenCalled();
      for (const sink of sinks()) expect.soft(sink, "no publish, delete or metering event").toEqual([]);
    },
  };
}
