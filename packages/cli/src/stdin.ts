/**
 * A bounded, single-pass read of piped bytes (`kofra publish --stdin`).
 *
 * The source is consumed exactly once and never buffered past `maxBytes`: the
 * read stops at the first chunk that would cross the bound, so an unbounded
 * pipe cannot exhaust memory. Bytes stay bytes (no text decoding), so binary
 * content publishes byte-identical.
 */
import { CliError, EXIT } from "./client.ts";
import { formatBytes } from "./output.ts";

/** Hard bound for one piped file: the default per-file limit of an instance (100 MiB). */
export const STDIN_MAX_BYTES = 100 * 1024 * 1024;

/** How long a pipe may stay silent before it is treated as empty (slow producers, e.g. a model, still get time to start). */
export const STDIN_FIRST_BYTE_MS = 30_000;

export function stdinTooLarge(maxBytes: number): CliError {
  return new CliError({
    code: "file_too_large",
    message: `Piped input is larger than the ${formatBytes(maxBytes)} the CLI buffers from stdin.`,
    hint: "Compress or split the file, or write it to disk and publish the path instead.",
    details: { limit: maxBytes },
    exitCode: EXIT.invalid,
  });
}

/** Concatenate `source` into one buffer; throws `file_too_large` (exit 6) when it exceeds `maxBytes`. */
export async function readBounded(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number = STDIN_MAX_BYTES,
  opts: { firstByteTimeoutMs?: number } = {},
): Promise<Uint8Array> {
  const it = source[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silent = new Promise<"silent">((resolve) => {
    if (opts.firstByteTimeoutMs !== undefined) timer = setTimeout(() => resolve("silent"), opts.firstByteTimeoutMs);
  });
  try {
    for (let first = true; ; first = false) {
      const next = it.next();
      const r = first && opts.firstByteTimeoutMs !== undefined ? await Promise.race([next, silent]) : await next;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (r === "silent" || r.done) break;
      total += r.value.byteLength;
      if (total > maxBytes) throw stdinTooLarge(maxBytes);
      chunks.push(r.value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Release the source whether we finished, overflowed or gave up; a failed release changes nothing.
    void Promise.resolve(it.return?.()).catch(() => {});
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
