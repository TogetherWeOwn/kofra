// Test-only egress containment for the bundled CLI; never inherit real credentials.
import { appendFileSync } from "node:fs";

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const allowed = process.env.SETTINGS_TEST_OFFLINE !== "true"
    && url.origin === process.env.SETTINGS_TEST_ORIGIN
    && url.pathname === process.env.SETTINGS_TEST_PATH
    && url.search === ""
    && ["GET", "PATCH"].includes(request.method);
  appendFileSync(process.env.SETTINGS_TEST_WIRE, JSON.stringify({
    method: request.method, url: request.url, body: await request.clone().text(), allowed,
    authenticated: request.headers.get("authorization") === `Bearer ${process.env.KOFRA_API_KEY}`,
  }) + "\n");
  if (!allowed) throw new Error("Site settings acceptance transport refused unexpected egress");
  return nativeFetch(request);
};
