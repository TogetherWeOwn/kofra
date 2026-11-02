/**
 * Encrypted-container AAD at the public encryptFiles boundary. Real crypto,
 * in-memory inputs: the DWENC001 magic must authenticate the ciphertext, so a
 * container made without it (pre-change output) no longer decrypts.
 */
import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptFiles } from "../src/encrypt.ts";
import type { SourceFile } from "../src/publish.ts";

const magic = new TextEncoder().encode("DWENC001");

async function sealed() {
  const bytes = new Uint8Array([1, 2, 3]);
  const encrypted = await encryptFiles([{
    path: "index.html", size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    body: async () => bytes,
  } satisfies SourceFile]);
  const container = Buffer.from(await encrypted.files[0]!.body() as Uint8Array);
  expect(container.subarray(0, 8).toString()).toBe("DWENC001");
  const token = encrypted.fragment.split("key=")[1]!;
  const key = await webcrypto.subtle.importKey("raw", Buffer.from(token, "base64url"), "AES-GCM", false, ["decrypt"]);
  return { container, key };
}

function parts(container: Buffer) {
  return { iv: container.subarray(8, 20), ciphertext: container.subarray(20) };
}

describe("encrypted container authenticates its DWENC001 magic", () => {
  it("decrypts with the magic as additional data", async () => {
    const { container, key } = await sealed();
    const { iv, ciphertext } = parts(container);
    const plaintext = await webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128, additionalData: magic }, key, ciphertext);
    const bundle = JSON.parse(Buffer.from(plaintext).toString("utf8"));
    expect(bundle.format).toBe("dropway-encrypted-v1");
    expect(bundle.entry).toBe("index.html");
  });

  it("rejects decryption without additional data, as a pre-change loader would attempt", async () => {
    const { container, key } = await sealed();
    const { iv, ciphertext } = parts(container);
    await expect(webcrypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, ciphertext))
      .rejects.toThrow();
  });

  it("rejects decryption when the authenticated magic is swapped", async () => {
    const { container, key } = await sealed();
    const { iv, ciphertext } = parts(container);
    const swapped = new TextEncoder().encode("DWENC002");
    await expect(webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128, additionalData: swapped }, key, ciphertext))
      .rejects.toThrow();
  });
});
