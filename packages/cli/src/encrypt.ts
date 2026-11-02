import { createHash, randomBytes, webcrypto } from "node:crypto";
import { CliError, EXIT } from "./client.ts";
import type { SourceFile } from "./publish.ts";

/** One authenticated container: no source filenames, hashes or bytes reach the instance. */
export async function encryptFiles(files: SourceFile[]): Promise<{ files: SourceFile[]; fragment: string }> {
  if (!files.length) throw new CliError({ code: "no_files", message: "There are no files to encrypt.", hint: "Choose a non-empty file or folder.", exitCode: EXIT.usage });
  if (files.length > 10000) throw new CliError({ code: "encrypted_too_many_files", message: "Encrypted publishing supports at most 10,000 files.", hint: "Publish fewer files; remove files or split the folder into smaller sites.", exitCode: EXIT.invalid });
  const maxBytes = 16 * 1024 * 1024;
  const inputTooLarge = () => new CliError({ code: "encrypted_input_too_large", message: "Encrypted publishing supports at most 16 MiB of source files.", hint: "Publish a smaller folder; encrypted sites are decrypted entirely in browser memory.", exitCode: EXIT.invalid });
  const paths = new Set<string>();
  let knownBytes = 0;
  // Validate the whole inventory before invoking even the first lazy body reader.
  for (const file of files) {
    if (!file.path || file.path.startsWith("/") || /[\\\x00-\x1f]/.test(file.path) || file.path.split("/").some(s => !s || s === "." || s === "..") || paths.has(file.path)) throw new CliError({ code: "encrypted_invalid_path", message: "An encrypted file path is invalid or duplicated.", hint: "Rename or remove files with backslashes, control characters, empty or dot path segments, or duplicate paths.", exitCode: EXIT.invalid });
    paths.add(file.path);
    knownBytes += Math.max(0, file.size);
    if (knownBytes > maxBytes) throw inputTooLarge();
  }
  let total = 0;
  const packed: Array<{ path: string; data: string }> = [];
  for (const file of files) {
    const body = await file.body();
    const remaining = maxBytes - total;
    let bytes: Uint8Array;
    if (body instanceof Uint8Array) {
      if (body.byteLength > remaining) throw inputTooLarge();
      bytes = body;
    } else {
      if (body.size > remaining) throw inputTooLarge();
      const reader = body.stream().getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > remaining) {
            await reader.cancel().catch(() => {});
            throw inputTooLarge();
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    }
    total += bytes.byteLength;
    packed.push({ path: file.path, data: Buffer.from(bytes).toString("base64") });
  }
  const entry = files.find(f => /^index\.html?$/i.test(f.path))?.path ?? files[0]!.path;
  const plaintext = new TextEncoder().encode(JSON.stringify({ format: "dropway-encrypted-v1", entry, files: packed }));
  // Match the loader's transport bound: 8-byte magic, 12-byte nonce and 16-byte tag.
  if (plaintext.byteLength + 36 > 24 * 1024 * 1024) throw new CliError({ code: "encrypted_container_too_large", message: "The encoded encrypted container exceeds the 24 MiB limit.", hint: "Publish a smaller folder or use shorter file paths; base64 and JSON overhead count toward the limit.", exitCode: EXIT.invalid });
  const rawKey = randomBytes(32);
  const iv = randomBytes(12);
  const key = await webcrypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  // The container magic is authenticated data: it binds the header to the
  // ciphertext so the prefix cannot be swapped without failing decryption.
  const magic = new TextEncoder().encode("DWENC001");
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128, additionalData: magic }, key, plaintext));
  // Versioned magic + 96-bit nonce + ciphertext with its full 128-bit authentication tag.
  const bytes = Buffer.concat([Buffer.from(magic), iv, ciphertext]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    files: [{ path: "encrypted.bin", size: bytes.byteLength, sha256, body: async () => bytes }],
    fragment: `key=${rawKey.toString("base64url")}`,
  };
}
