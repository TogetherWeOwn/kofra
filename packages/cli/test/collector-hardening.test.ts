import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/client.ts";

const fault = vi.hoisted(() => ({
  readTarget: "",
  readCode: "",
  /** Delay the injected read failure so the stalled sibling is provably in flight first. */
  readDelayMs: 0,
  slowTarget: "",
  slowStatTarget: "",
  statTarget: "",
  statCode: "",
  started: [] as string[],
  statStarted: [] as string[],
  slowStarted: false,
  slowAborted: false,
  slowStatStarted: false,
  slowStatAborted: false,
}));

function hangUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<never> {
  if (signal?.aborted) {
    onAbort?.();
    throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
  }
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => {
        onAbort?.();
        reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

// Fault injection at the stat/read boundary: real filesystem, real walk/hash,
// only stat/readFile are interposed so a disappearing file (ENOENT) or a
// stalled sibling (hang-until-abort) is deterministic.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (path: unknown, ...args: unknown[]) => {
      const p = String(path);
      fault.statStarted.push(p);
      if (fault.statTarget && p === fault.statTarget) {
        const err = new Error(`injected ${fault.statCode}`) as NodeJS.ErrnoException;
        err.code = fault.statCode;
        throw err;
      }
      if (fault.slowStatTarget && p === fault.slowStatTarget) {
        // stat() takes no signal; the collector races it against abort, so a
        // stalled stat settles here once the sibling failure aborts the run.
        // No signal is passed through — hang until the race's abort fires.
        // The race holds the only handle; resolve it via the shared fault flag.
        fault.slowStatStarted = true;
        await hangUntilAbort(undefined, undefined);
        // The hang above never settles on its own; the test instead asserts
        // the collector's race releases the worker. Fall through to real stat
        // only if something resolved unexpectedly.
        return (actual.stat as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      }
      return (actual.stat as (...a: unknown[]) => Promise<unknown>)(path, ...args);
    },
    readFile: async (path: unknown, ...args: unknown[]) => {
      const p = String(path);
      fault.started.push(p);
      if (fault.readTarget && p === fault.readTarget) {
        // Delay the failure so the stalled sibling is provably in flight
        // first; otherwise the test races sibling scheduling against abort.
        if (fault.readDelayMs > 0) await new Promise((r) => setTimeout(r, fault.readDelayMs));
        const err = new Error(`injected ${fault.readCode}`) as NodeJS.ErrnoException;
        err.code = fault.readCode;
        throw err;
      }
      if (fault.slowTarget && p === fault.slowTarget) {
        fault.slowStarted = true;
        const signal = (args[0] as { signal?: AbortSignal } | undefined)?.signal;
        await hangUntilAbort(signal, () => {
          fault.slowAborted = true;
        });
        throw new Error("unreachable: slow read settled without abort");
      }
      return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...args);
    },
  };
});

import { collectFiles } from "../src/files.ts";

let dir: string;

beforeEach(async () => {
  fault.readTarget = "";
  fault.readCode = "";
  fault.readDelayMs = 0;
  fault.slowTarget = "";
  fault.slowStatTarget = "";
  fault.statTarget = "";
  fault.statCode = "";
  fault.started = [];
  fault.statStarted = [];
  fault.slowStarted = false;
  fault.slowAborted = false;
  fault.slowStatStarted = false;
  fault.slowStatAborted = false;
  dir = await mkdtemp(join(tmpdir(), "collector-hardening-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("collector fail-fast", () => {
  it(
    "aborts an in-flight sibling and schedules no new work after the first failure",
    { timeout: 10000 },
    async () => {
      await writeFile(join(dir, "a-fail.txt"), "boom");
      await writeFile(join(dir, "m-slow.txt"), "slow");
      await writeFile(join(dir, "z-never.txt"), "never");
      fault.readTarget = join(dir, "a-fail.txt");
      fault.readCode = "EACCES";
      fault.readDelayMs = 50;
      fault.slowTarget = join(dir, "m-slow.txt");

      const err = await collectFiles(dir, { concurrency: 2 }).then(
        () => {
          throw new Error("expected collectFiles to reject");
        },
        (e) => e,
      );
      // The original failure wins; the aborted sibling must not replace it.
      expect(err?.code).toBe("EACCES");
      expect(err?.name).not.toBe("AbortError");
      expect(fault.slowStarted).toBe(true);
      expect(fault.slowAborted).toBe(true);
      expect(fault.started).toContain(join(dir, "a-fail.txt"));
      expect(fault.started).toContain(join(dir, "m-slow.txt"));
      expect(fault.started).not.toContain(join(dir, "z-never.txt"));
    },
  );

  it(
    "does not wait for a stalled stat after a sibling fails",
    { timeout: 10000 },
    async () => {
      // stat() takes no signal; the collector races it against abort so a
      // stalled metadata read cannot hold Promise.all open. Without the race
      // this test hangs until the timeout instead of rejecting with EACCES.
      await writeFile(join(dir, "a-fail.txt"), "boom");
      await writeFile(join(dir, "m-stalled.txt"), "stalled");
      fault.readTarget = join(dir, "a-fail.txt");
      fault.readCode = "EACCES";
      fault.readDelayMs = 50;
      fault.slowStatTarget = join(dir, "m-stalled.txt");

      const err = await collectFiles(dir, { concurrency: 2 }).then(
        () => {
          throw new Error("expected collectFiles to reject");
        },
        (e) => e,
      );
      expect(err?.code).toBe("EACCES");
      expect(err?.name).not.toBe("AbortError");
      expect(fault.slowStatStarted).toBe(true);
    },
  );
});

describe("collector cancellation before root reads", () => {
  it("prefers cancellation over path_not_found when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    // Without the pre-check, the root stat runs first and a missing root
    // reports path_not_found instead of the abort reason.
    const err = await collectFiles(join(dir, "missing"), { signal: controller.signal }).then(
      () => {
        throw new Error("expected collectFiles to reject");
      },
      (e) => e,
    );
    expect(err?.name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(CliError);
  });

  it("aborts before reading the ignore file when already aborted", async () => {
    await writeFile(join(dir, ".dropwayignore"), "*.log\n");
    await writeFile(join(dir, "keep.txt"), "keep");
    const controller = new AbortController();
    controller.abort();
    await expect(collectFiles(dir, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("collector read-boundary ENOENT", () => {
  it("maps a file that disappears at read to source_changed naming the relative path", async () => {
    await writeFile(join(dir, "payload.txt"), "payload");
    fault.readTarget = join(dir, "payload.txt");
    fault.readCode = "ENOENT";

    const err = await collectFiles(dir).then(
      () => {
        throw new Error("expected collectFiles to reject");
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({ code: "source_changed", exitCode: 2 });
    expect(err.message).toContain("payload.txt");
    expect(err.message).not.toContain(dir);
    expect(err.hint).toMatch(/^Re-run when the tree is quiet\.?$/);
  });

  it("propagates a non-ENOENT read error untouched", async () => {
    await writeFile(join(dir, "payload.txt"), "payload");
    fault.readTarget = join(dir, "payload.txt");
    fault.readCode = "EACCES";

    const err = await collectFiles(dir).then(
      () => {
        throw new Error("expected collectFiles to reject");
      },
      (e) => e,
    );
    expect(err).not.toBeInstanceOf(CliError);
    expect(err?.code).toBe("EACCES");
  });
});

describe.runIf(process.platform !== "win32")("collector filename decoding (POSIX)", () => {
  const rawPath = (name: Buffer) => Buffer.concat([Buffer.from(`${dir}/`), name]);

  it("rejects a name that is not valid UTF-8", async () => {
    await writeFile(rawPath(Buffer.from([0xff])) as unknown as string, "hi");
    await expect(collectFiles(dir)).rejects.toMatchObject({ code: "invalid_filename" });
  });

  it("accepts a real U+FFFD name without rejecting it as invalid", async () => {
    await writeFile(join(dir, "�.txt"), "ok");
    const c = await collectFiles(dir);
    expect(c.files.map((f) => f.path)).toEqual(["�.txt"]);
  });

  it("preserves a leading BOM instead of stripping it from the decoded name", async () => {
    // EF BB BF is a legal filename prefix (U+FEFF); TextDecoder must not
    // strip it or "\uFEFFa.txt" would collect as the wrong path "a.txt".
    await writeFile(rawPath(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x2e, 0x74, 0x78, 0x74])) as unknown as string, "bom");
    const c = await collectFiles(dir);
    expect(c.files.map((f) => f.path)).toEqual(["\uFEFFa.txt"]);
  });

  it("records a symlink loop as broken_symlink instead of failing", async () => {
    // stat on a cycle fails with ELOOP; publish skips unresolvable links.
    await symlink("b", join(dir, "a"));
    await symlink("a", join(dir, "b"));
    const c = await collectFiles(dir);
    expect(c.files).toEqual([]);
    expect(c.omissions).toEqual([
      { path: "a", reason: "broken_symlink" },
      { path: "b", reason: "broken_symlink" },
    ]);
  });

  it("records a link through a non-directory as broken_symlink", async () => {
    // stat on real.txt/child fails with ENOTDIR; the link is unresolvable.
    await writeFile(join(dir, "real.txt"), "x");
    await symlink(join("real.txt", "child"), join(dir, "bad"));
    const c = await collectFiles(dir);
    expect(c.files.map((f) => f.path)).toEqual(["real.txt"]);
    expect(c.omissions).toContainEqual({ path: "bad", reason: "broken_symlink" });
  });

  it("propagates a transient stat failure on a link target instead of omitting it", async () => {
    // EIO is not a target-resolution error: the link is fine, the
    // filesystem hiccuped. Recording broken_symlink would silently drop
    // the file from the published version; the error must fail loudly.
    await writeFile(join(dir, "real.txt"), "x");
    await symlink("real.txt", join(dir, "link"));
    fault.statTarget = join(dir, "link");
    fault.statCode = "EIO";
    await expect(collectFiles(dir)).rejects.toMatchObject({ code: "EIO" });
  });

  it("does not let a non-UTF-8 name and a U+FFFD name collapse in a Map", async () => {
    await writeFile(rawPath(Buffer.from([0xff])) as unknown as string, "raw");
    await writeFile(join(dir, "�"), "decoded");
    // Either invalid_filename or duplicate_path proves no silent collapse;
    // with strict decoding the non-UTF-8 name fails first.
    await expect(collectFiles(dir)).rejects.toMatchObject({ code: "invalid_filename" });
  });
});
