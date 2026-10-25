// Test-only containment and request evidence for the real CLI subprocess.
import { appendFileSync } from "node:fs";

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const allowed = url.origin === process.env.OPERATIONS_TEST_ORIGIN
    && url.pathname === "/api/v1/operations" && url.search === ""
    && request.method === "GET";
  appendFileSync(process.env.OPERATIONS_TEST_WIRE, JSON.stringify({
    method: request.method, url: request.url,
    headers: Object.fromEntries(request.headers),
    body: await request.clone().text(), allowed,
  }) + "\n");
  if (!allowed) throw new Error("Acceptance transport refused non-catalog request");
  return nativeFetch(request);
};
