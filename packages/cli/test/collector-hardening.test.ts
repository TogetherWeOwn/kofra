import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/client.ts";

const fault = vi.hoisted(() => ({
  readTarget: "",
  readCode: "",
  slowTarget: "",
  started: [] as string[],
  slowStarted: false,
  slowAborted: false,
}));

// Fault injection at the byte-read boundary: real filesystem, real walk/hash,
// only readFile is interposed so a disappearing file (ENOENT) or a stalled
// sibling (hang-until-abort) is deterministic.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: unknown, ...args: unknown[]) => {
      const p = String(path);
      fault.started.push(p);
      if (fault.readTarget && p === fault.readTarget) {
        const err = new Error(`injected ${fault.readCode}`) as NodeJS.ErrnoException;
        err.code = fault.readCode;
        throw err;
      }
      if (fault.slowTarget && p === fault.slowTarget) {
        fault.slowStarted = true;
        const signal = (args[0] as { signal?: AbortSignal } | undefined)?.signal;
        if (signal?.aborted) {
          fault.slowAborted = true;
          throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
        }
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              fault.slowAborted = true;
              reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
            },
            { once: true },
          );
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
  fault.slowTarget = "";
  fault.started = [];
  fault.slowStarted = false;
  fault.slowAborted = false;
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

  it("does not let a non-UTF-8 name and a U+FFFD name collapse in a Map", async () => {
    await writeFile(rawPath(Buffer.from([0xff])) as unknown as string, "raw");
    await writeFile(join(dir, "�"), "decoded");
    // Either invalid_filename or duplicate_path proves no silent collapse;
    // with strict decoding the non-UTF-8 name fails first.
    await expect(collectFiles(dir)).rejects.toMatchObject({ code: "invalid_filename" });
  });
});
