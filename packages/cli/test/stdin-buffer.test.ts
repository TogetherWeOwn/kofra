import { describe, expect, it } from "vitest";
import { EXIT, CliError } from "../src/client.ts";
import { collectStdinFile, normaliseStdinPath } from "../src/files.ts";
import { readBounded } from "../src/stdin.ts";

function source(chunks: Uint8Array[], onReturn?: () => void, onPull?: () => void): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          onPull?.();
          return i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined };
        },
        async return() {
          onReturn?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

const bytes = (...n: number[]) => new Uint8Array(n);

describe("readBounded", () => {
  it("concatenates chunks without decoding (binary stays byte-identical)", async () => {
    const out = await readBounded(source([bytes(0xff, 0x00), bytes(), bytes(0xfe, 0x80)]), 16);
    expect([...out]).toEqual([0xff, 0x00, 0xfe, 0x80]);
  });

  it("returns an empty buffer for an empty source", async () => {
    expect((await readBounded(source([]), 16)).byteLength).toBe(0);
  });

  it("accepts exactly maxBytes and refuses one byte more with file_too_large (exit 6)", async () => {
    expect((await readBounded(source([new Uint8Array(8), new Uint8Array(8)]), 16)).byteLength).toBe(16);
    const err = await readBounded(source([new Uint8Array(8), new Uint8Array(9)]), 16).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({ code: "file_too_large", exitCode: EXIT.invalid });
    expect(err.hint).toMatch(/compress|split|path/i);
  });

  it("stops pulling and releases the source once the bound is crossed", async () => {
    let pulls = 0;
    let released = 0;
    const chunks = Array.from({ length: 50 }, () => new Uint8Array(4));
    await expect(readBounded(source(chunks, () => released++, () => pulls++), 10)).rejects.toMatchObject({ code: "file_too_large" });
    expect(pulls).toBe(3);
    expect(released).toBe(1);
  });

  it("releases the source after a normal end too", async () => {
    let released = 0;
    await readBounded(source([bytes(1)], () => released++), 16);
    expect(released).toBe(1);
  });

  it("refuses a pipe that never produces a first byte with stdin_timeout (exit 2), never as empty", async () => {
    let released = 0;
    const silent: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}), return: async () => { released++; return { done: true, value: undefined }; } }) };
    const err = await readBounded(silent, 16, { firstByteTimeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({ code: "stdin_timeout", exitCode: EXIT.usage });
    expect(String(err.message)).toMatch(/silent/i);
    expect(released).toBe(1);
  });

  it("applies the timeout to the first byte only", async () => {
    const slow: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let n = 0;
        return {
          next: async () => {
            if (n++ === 0) return { done: false, value: bytes(1) };
            await new Promise((r) => setTimeout(r, 60));
            return n === 2 ? { done: false, value: bytes(2) } : { done: true, value: undefined };
          },
        };
      },
    };
    expect([...(await readBounded(slow, 16, { firstByteTimeoutMs: 20 }))]).toEqual([1, 2]);
  });
});

describe("stdin file path and collection", () => {
  it("normalises like the server and refuses reserved, unsafe and never-published names", () => {
    expect(normaliseStdinPath("./assets\\app.js")).toBe("assets/app.js");
    expect(() => normaliseStdinPath("__dropway/x.html")).toThrowError(expect.objectContaining({ code: "reserved_path", exitCode: EXIT.invalid }));
    expect(() => normaliseStdinPath("../x.html")).toThrowError(expect.objectContaining({ code: "invalid_path", exitCode: EXIT.invalid }));
    expect(() => normaliseStdinPath("/")).toThrowError(expect.objectContaining({ code: "invalid_path" }));
    expect(() => normaliseStdinPath("a\u0001b.html")).toThrowError(expect.objectContaining({ code: "invalid_path" }));
    expect(() => normaliseStdinPath(".env")).toThrowError(expect.objectContaining({ code: "ignored_file", exitCode: EXIT.usage }));
    expect(() => normaliseStdinPath(`${"a/".repeat(600)}x`)).toThrowError(expect.objectContaining({ code: "invalid_path" }));
  });

  it("hashes the bytes and reads them back unchanged", async () => {
    const c = collectStdinFile("a.bin", bytes(0, 1, 2), { allowSecrets: true });
    expect(c.files).toHaveLength(1);
    expect(c.files[0]).toMatchObject({ path: "a.bin", size: 3, sha256: "ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc" });
    expect([...((await c.files[0]!.body()) as Uint8Array)]).toEqual([0, 1, 2]);
  });
});
