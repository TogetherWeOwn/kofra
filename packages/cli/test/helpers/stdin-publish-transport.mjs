// Test-only preload. No request is ever forwarded to the real network.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const setup = JSON.parse(fs.readFileSync(process.env.STDIN_ACCEPTANCE_SETUP, "utf8"));
const append = fs.appendFileSync.bind(fs);
const record = entry => append(setup.auditFile, JSON.stringify(entry) + "\n");
const track = (operation, path) => {
  const name = path instanceof URL ? fileURLToPath(path) : typeof path === "string" ? resolve(path) : "";
  if (name.startsWith(setup.home + "/")) record({ kind: "fs", operation, path: name });
};

for (const name of ["readFile", "open", "readdir", "stat", "lstat", "access"]) {
  const callback = fs[name].bind(fs);
  fs[name] = (path, ...args) => { track(name, path); return callback(path, ...args); };
  const promise = fsp[name].bind(fsp);
  fsp[name] = (path, ...args) => { track(name, path); return promise(path, ...args); };
  const sync = fs[name + "Sync"].bind(fs);
  fs[name + "Sync"] = (path, ...args) => { track(name + "Sync", path); return sync(path, ...args); };
}
syncBuiltinESMExports();

const iterator = process.stdin[Symbol.asyncIterator];
process.stdin[Symbol.asyncIterator] = function (...args) {
  record({ kind: "stdin" });
  return iterator.apply(this, args);
};

const version = { id: "ver_stdin_fixture", number: 1 };
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const text = await request.text();
  const body = text ? JSON.parse(text) : null;
  record({ kind: "fetch", method: request.method, url: request.url,
    authorization: request.headers.get("Authorization"), body });
  const site = slug => ({ id: "site_stdin_fixture", slug, url: `${url.origin}/s/${slug}/`, currentVersion: version });
  if (request.method === "POST" && url.pathname === "/api/v1/sites") {
    return Response.json({ site: site(body?.slug ?? "stdin-created-fixture") }, { status: 201 });
  }
  if (request.method === "POST" && /^\/api\/v1\/sites\/[^/]+\/deploys$/.test(url.pathname)) {
    return Response.json({ unchanged: true, deploy: version, missing: [], uploads: [], finalizeUrl: null });
  }
  const match = /^\/api\/v1\/sites\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && match) return Response.json({ site: site(decodeURIComponent(match[1])) });
  throw new Error(`No fixture response for ${request.method} ${url.pathname}; real network is disabled`);
};
