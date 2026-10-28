// Test-only preload: poison network/DNS, writes and stdin at the real Node
// boundary. A caught sentinel still writes a fixed diagnostic to stderr, so
// swallowing its exception cannot turn an attempted operation into a pass.
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

function deny() {
  process.stderr.write("EXPLAIN_FORBIDDEN_SIDE_EFFECT\n");
  throw new Error("EXPLAIN_FORBIDDEN_SIDE_EFFECT");
}
for (const [module, names] of [
  [http, ["request", "get"]], [https, ["request", "get"]],
  [net, ["connect", "createConnection"]], [tls, ["connect"]],
  [dns, ["lookup", "resolve", "resolve4", "resolve6", "reverse"]],
  [dnsPromises, ["lookup", "resolve", "resolve4", "resolve6", "reverse"]],
]) for (const name of names) module[name] = deny;
net.Socket.prototype.connect = deny;
globalThis.fetch = deny;
globalThis.XMLHttpRequest = class { constructor() { deny(); } };

for (const name of ["appendFile", "chmod", "chown", "copyFile", "cp", "link", "mkdir", "mkdtemp", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile"]) {
  for (const module of [fs, fsp]) if (typeof module[name] === "function") module[name] = deny;
  if (typeof fs[`${name}Sync`] === "function") fs[`${name}Sync`] = deny;
}
// Opening a read-only descriptor is legitimate; acquiring a writable one is
// not. Cover the callback, promise and sync entrypoints as well as write helpers.
for (const module of [fs, fsp]) {
  const open = module.open;
  module.open = (path, flags, ...args) => {
    const writable = typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 : /[wa+]/.test(flags);
    return writable ? deny() : open(path, flags, ...args);
  };
}
const openSync = fs.openSync;
fs.openSync = (path, flags, ...args) => {
  const writable = typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 : /[wa+]/.test(flags);
  return writable ? deny() : openSync(path, flags, ...args);
};
const readSync = fs.readSync;
fs.readSync = (fd, ...args) => fd === 0 ? deny() : readSync(fd, ...args);
const read = fs.read;
fs.read = (fd, ...args) => fd === 0 ? deny() : read(fd, ...args);
process.stdin.read = deny;
process.stdin.resume = deny;
syncBuiltinESMExports();
