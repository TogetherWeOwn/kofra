// Contain the bundled CLI subprocess to GETs on the disposable Worker only.
// The wire log deliberately excludes headers, keys, bodies and query values.
import { appendFileSync } from "node:fs";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const base = `/api/v1/sites/${process.env.PULL_TEST_SITE}`;
  const allowed = url.origin === process.env.PULL_TEST_ORIGIN && request.method === "GET"
    && (url.pathname === base || url.pathname.startsWith(`${base}/versions/`)
      || url.pathname === `${base}/files` || url.pathname.startsWith(`${base}/files/`)
      || url.pathname === "/api/v1/read-file");
  appendFileSync(process.env.PULL_TEST_WIRE, JSON.stringify({ method: request.method, path: url.pathname, allowed }) + "\n");
  if (!allowed) throw new Error("Acceptance transport refused non-local or non-read request");
  return nativeFetch(request, { redirect: "error" });
};
