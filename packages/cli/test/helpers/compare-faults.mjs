// Test-only Node preload: real filesystem/CLI, deterministic observation at
// the byte-read boundary. Does not replace the collector or comparison logic.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const setup = JSON.parse(fs.readFileSync(process.env.COMPARE_FAULT_SETUP, "utf8"));
const append = fs.appendFileSync.bind(fs);
const nativeStat = fs.statSync.bind(fs);
const nativeUtimes = fs.utimesSync.bind(fs);
const nativeAppend = fs.appendFileSync.bind(fs);
const event = value => append(setup.journal, JSON.stringify(value) + "\n");
const target = path => {
  const value = path instanceof URL ? fileURLToPath(path) : typeof path === "string" ? resolve(path) : "";
  return setup.targets.includes(value) ? value : null;
};
let faultFired = false;
function observed(path, method) {
  const value = target(path);
  if (value) {
    event({ type: "read", path: value, method });
    if (setup.mode === "cap") throw new Error("Fixture refused eligible-file bytes before cap validation");
  }
  return value;
}
async function beforeRead(path) {
  if (setup.mode !== "cancel" || faultFired) return;
  faultFired = true;
  event({ type: "hash_gate", path });
  // Parent sends an actual OS SIGINT only after this exact content-read gate.
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 2000);
    process.once("message", () => { clearTimeout(timer); resolve(); });
    process.send?.({ type: "hash_gate" });
  });
  await new Promise(resolve => setImmediate(resolve));
}
function afterRead(path) {
  if (faultFired || !["mtime", "size"].includes(setup.mode)) return;
  faultFired = true;
  if (setup.mode === "size") nativeAppend(path, "changed-during-hash");
  else {
    const s = nativeStat(path);
    nativeUtimes(path, s.atime, new Date(s.mtimeMs + 60_000));
  }
  event({ type: "source_mutated", path, mode: setup.mode });
}

const nativeRead = fsp.readFile.bind(fsp);
fsp.readFile = async (path, ...args) => {
  const value = observed(path, "readFile");
  if (value) await beforeRead(value);
  const bytes = await nativeRead(path, ...args);
  if (value) afterRead(value);
  return bytes;
};
const nativeStream = fs.createReadStream.bind(fs);
fs.createReadStream = (path, ...args) => {
  const value = observed(path, "createReadStream");
  const stream = nativeStream(path, ...args);
  if (value) {
    const iterator = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = async function* () {
      await beforeRead(value);
      for await (const chunk of { [Symbol.asyncIterator]: iterator }) yield chunk;
      afterRead(value);
    };
  }
  return stream;
};
// Refuse alternate byte-read paths as well in the before-hashing cap sentinel.
for (const method of ["readFileSync", "openSync", "openAsBlob"]) {
  if (typeof fs[method] !== "function") continue;
  const original = fs[method].bind(fs);
  fs[method] = (path, ...args) => { observed(path, method); return original(path, ...args); };
}
const nativeOpen = fsp.open.bind(fsp);
fsp.open = async (path, ...args) => { observed(path, "open"); return nativeOpen(path, ...args); };
syncBuiltinESMExports();

let calls = 0;
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  event({ type: "request", method: req.method, path: url.pathname, search: url.search,
    authenticated: req.headers.get("Authorization") === `Bearer ${setup.key}` });
  const base = `/api/v1/sites/${setup.site}`;
  if (url.origin !== setup.api || req.method !== "GET" || ++calls > 2 ||
      ![`${base}/versions`, `${base}/files`].includes(url.pathname) || req.headers.has("Idempotency-Key")) {
    event({ type: "forbidden_request" });
    throw new Error("Only the two authenticated manifest GETs are allowed");
  }
  const body = url.pathname.endsWith("/versions")
    ? { currentVersionId: setup.version.id, versions: [setup.version] }
    : { version: setup.version, files: [] };
  if (url.pathname.endsWith("/files") && url.searchParams.get("version") !== setup.version.id) {
    event({ type: "unpinned_request" });
    throw new Error("Manifest must use immutable version id");
  }
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};
