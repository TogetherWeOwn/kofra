#!/usr/bin/env node
// Bootstraps the encrypted browser-test dependencies so `npm run check` works
// on a clean clone with no manual steps.
//
// Root `npm ci` does not install packages/cli/test/encrypted: it has its own
// lockfile and is not a workspace, yet the CLI typecheck and test suite need
// its Playwright types and Chromium build. This script installs those when
// missing or stale and is a fast no-op otherwise (no disk writes, no network).
//
// The encrypted package is test-only and is never published with the CLI.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENCRYPTED_DIR = join(ROOT, "packages", "cli", "test", "encrypted");
const ENCRYPTED_MODULES = join(ENCRYPTED_DIR, "node_modules");
const STAMP = join(ENCRYPTED_MODULES, ".encrypted-test-deps-fingerprint");

function fingerprint() {
  const hash = createHash("sha256");
  for (const file of ["package.json", "package-lock.json"]) {
    hash.update(readFileSync(join(ENCRYPTED_DIR, file)));
  }
  return `${hash.digest("hex")}\n`;
}

function chromiumExecutablePath() {
  // Resolved from the encrypted package's own tree (never the root one), so
  // the pinned Playwright decides the build and PLAYWRIGHT_BROWSERS_PATH is
  // honored exactly as the tests will see it.
  const encryptedRequire = createRequire(join(ENCRYPTED_DIR, "package.json"));
  return encryptedRequire("playwright").chromium.executablePath();
}

const wanted = fingerprint();
const stamp = existsSync(STAMP) ? readFileSync(STAMP, "utf8") : "";
const modulesPresent = existsSync(join(ENCRYPTED_MODULES, "playwright", "package.json"));
if (stamp !== wanted || !modulesPresent) {
  console.log("encrypted test deps: installing packages/cli/test/encrypted (not covered by root npm ci) ...");
  execFileSync("npm", ["ci", "--prefix", ENCRYPTED_DIR, "--no-audit", "--no-fund"], { stdio: "inherit" });
  writeFileSync(STAMP, wanted);
} else {
  console.log("encrypted test deps: up to date, skipping install.");
}

let executable;
try {
  executable = chromiumExecutablePath();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`encrypted test deps: cannot resolve the Playwright Chromium path: ${detail}`);
  process.exit(1);
}
if (!existsSync(executable)) {
  console.log(`encrypted test deps: Chromium missing, downloading (${executable}) ...`);
  execFileSync(process.execPath,
    [join(ENCRYPTED_MODULES, "playwright", "cli.js"), "install", "chromium"], { stdio: "inherit" });
  if (!existsSync(chromiumExecutablePath())) {
    console.error("encrypted test deps: Chromium still missing after `playwright install chromium`.");
    console.error("On Linux without system browser libraries, run with OS packages instead:");
    console.error("  packages/cli/test/encrypted/node_modules/.bin/playwright install --with-deps chromium");
    process.exit(1);
  }
} else {
  console.log("encrypted test deps: Chromium present, skipping download.");
}
