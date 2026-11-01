import { createExecutionContext, env } from "cloudflare:test";
import { clearLiveMemoryCache, getLiveSite, liveKey } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { afterEach, describe, expect, it } from "vitest";
import { form, freshInstance } from "./helpers";

/**
 * Acceptance contract for the pre-upgrade (v4) manifest read path.
 *
 * A live, unchanged multi-file site whose KV entry is still a v4 manifest
 * must not pay a complete `version_files` manifest load on every cold read.
 * Across three cold-isolate reads (memory cache cleared before each), the
 * total number of file rows materialized from `version_files` may not exceed
 * one complete manifest (FILE_COUNT rows). D1 metadata reads (site/version
 * rows, aggregates) are unrestricted: only returned rows that carry a file
 * `path` count against the bound, so any validation or upgrade strategy that
 * avoids repeatedly loading every file row satisfies this test. The unsafe
 * asynchronous `live:<slug>` miss fill is NOT required; work scheduled via
 * waitUntil is drained deterministically after each read (no sleeping).
 *
 * Correctness against a *stale* v4 entry (superseded version) stays pinned
 * by "ignores an old-format manifest that may have been poisoned before
 * upgrade" in live-cache-race.test.ts; here the v4 entry is the site's
 * current manifest, downgraded only in format version.
 */

afterEach(() => clearLiveMemoryCache());

const FILES: Record<string, string> = {
  "index.html": "home",
  "about.txt": "about",
  "app.js": "console.log(1)",
  "data.json": "{}",
};
const FILE_COUNT = Object.keys(FILES).length;

interface ManifestCounter {
  /** Rows carrying a file `path` returned from version_files queries. */
  manifestRows: number;
  /** version_files query executions that returned at least one file row. */
  manifestLoads: number;
}

function wrapStatement(statement: D1PreparedStatement, isVersionFiles: boolean, counter: ManifestCounter): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, prop) {
      if (prop === "bind") return (...args: unknown[]) => wrapStatement(target.bind(...args), isVersionFiles, counter);
      if (prop === "all") return async () => {
        const result = await target.all<Record<string, unknown>>();
        if (isVersionFiles) {
          const fileRows = result.results.filter((row) => row && typeof row === "object" && "path" in row);
          counter.manifestRows += fileRows.length;
          if (fileRows.length > 0) counter.manifestLoads++;
        }
        return result;
      };
      if (prop === "first") return async () => {
        const row = await target.first<Record<string, unknown>>();
        if (isVersionFiles && row && typeof row === "object" && "path" in row) counter.manifestRows++;
        return row;
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function countingDb(counter: ManifestCounter) {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) =>
        wrapStatement(target.prepare(query), /from\s+version_files/i.test(query), counter);
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("live cache upgrade reads", () => {
  it("does not reload the complete version_files manifest on every cold read of an unchanged v4 site", async () => {
    const dw = await freshInstance();
    const slug = "cache-upgrade-bounded";
    const published = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form(FILES, { slug }) });
    expect(published.status).toBe(201);

    // Simulate the pre-upgrade state: KV holds this site's current manifest
    // in the old v4 format.
    const current = JSON.parse((await env.CACHE.get(liveKey(slug)))!);
    current.v = 4;
    await env.CACHE.put(liveKey(slug), JSON.stringify(current));

    const counter: ManifestCounter = { manifestRows: 0, manifestLoads: 0 };
    const pending: Promise<unknown>[] = [];
    const base = dw.dropway.context(env as unknown as ServerBindings, createExecutionContext());
    const dc = {
      ...base,
      env: { ...base.env, DB: countingDb(counter) },
      waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    };

    const versionIds = new Set<string | null>();
    for (let coldRead = 0; coldRead < 3; coldRead++) {
      // Cold isolate: no memory entry survives into the next read.
      clearLiveMemoryCache();
      const live = await getLiveSite(dc, slug);
      // Deterministically drain any upgrade work the read scheduled.
      while (pending.length > 0) await Promise.all(pending.splice(0));
      expect(live?.slug).toBe(slug);
      expect(Object.keys(live!.files).sort()).toEqual(Object.keys(FILES).sort());
      versionIds.add(live!.versionId);
    }
    expect(versionIds.size).toBe(1);
    expect([...versionIds][0]).toBeTruthy();

    expect(
      counter.manifestRows,
      `complete-manifest work across 3 cold reads: ${counter.manifestRows} file rows in ${counter.manifestLoads} load(s); bound is one manifest (${FILE_COUNT} rows)`,
    ).toBeLessThanOrEqual(FILE_COUNT);

    // The site still serves correctly after the measured reads.
    const page = await dw.call(`/s/${slug}/?raw=1`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("home");
  });
});
