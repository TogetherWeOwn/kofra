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
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENCRYPTED_DIR = join(ROOT, "packages", "cli", "test", "encrypted");
const ENCRYPTED_MODULES = join(ENCRYPTED_DIR, "node_modules");
const STAMP = join(ENCRYPTED_MODULES, ".encrypted-test-deps-fingerprint");

// Every package the encrypted acceptance tests import from their own tree.
// The stamp only tracks manifest staleness, so a pruned node_modules (stamp
// plus one package.json intact, a sibling dep deleted) must still reinstall.
const REQUIRED_PACKAGES = ["playwright", "playwright-core", "fflate", "jsqr"];

function fingerprint() {
  const hash = createHash("sha256");
  for (const file of ["package.json", "package-lock.json"]) {
    hash.update(readFileSync(join(ENCRYPTED_DIR, file)));
  }
  return `${hash.digest("hex")}\n`;
}

function encryptedRequire() {
  // Resolved from the encrypted package's own tree (never the root one), so
  // the pinned Playwright decides the build and PLAYWRIGHT_BROWSERS_PATH is
  // honored exactly as the tests will see it.
  return createRequire(join(ENCRYPTED_DIR, "package.json"));
}

function installedPackagesComplete() {
  const require = encryptedRequire();
  return REQUIRED_PACKAGES.every((name) => {
    try {
      require.resolve(`${name}/package.json`);
      return true;
    } catch {
      return false;
    }
  });
}

function chromiumExecutablePath() {
  return encryptedRequire()("playwright").chromium.executablePath();
}

function browserRevision(name) {
  try {
    // NB: playwright-core's exports map does not expose ./browsers.json, so
    // go through package.json (always resolvable) and step next to it.
    const require = encryptedRequire();
    const packagePath = require.resolve("playwright-core/package.json");
    const registry = JSON.parse(readFileSync(join(packagePath, "..", "browsers.json"), "utf8"));
    return registry.browsers?.find((browser) => browser?.name === name)?.revision ?? null;
  } catch {
    return null;
  }
}

function headlessShellDir() {
  // The acceptance tests launch headless Chromium, which Playwright serves
  // from its separate headless-shell build (there is no public path API for
  // it), so checking the full-Chromium executable alone can miss a
  // half-populated browser cache. The shell ships as a sibling of the pinned
  // Chromium build, so derive it without assuming any platform layout.
  // Returns null when the layout is unrecognized (fail open: keep the
  // full-Chromium check rather than forcing a reinstall).
  const chromiumRevision = browserRevision("chromium");
  const shellRevision = browserRevision("chromium-headless-shell");
  if (!chromiumRevision || !shellRevision) return null;
  let executable;
  try {
    executable = chromiumExecutablePath();
  } catch {
    return null;
  }
  const prefix = executable.split(`chromium-${chromiumRevision}${sep}`)[0];
  if (prefix === executable) return null;
  return join(prefix, `chromium_headless_shell-${shellRevision}`);
}

function dirIsPopulated(dir) {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

const wanted = fingerprint();
const stamp = existsSync(STAMP) ? readFileSync(STAMP, "utf8") : "";
// Windows ships npm as npm.cmd, which execFileSync cannot launch directly.
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
if (stamp !== wanted || !installedPackagesComplete()) {
  console.log("encrypted test deps: installing packages/cli/test/encrypted (not covered by root npm ci) ...");
  execFileSync(NPM, ["ci", "--prefix", ENCRYPTED_DIR, "--no-audit", "--no-fund"], { stdio: "inherit" });
  writeFileSync(STAMP, wanted);
} else {
  console.log("encrypted test deps: up to date, skipping install.");
}

const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (override) {
  // The acceptance tests prefer this binary over the Playwright-managed one,
  // so a download would not even be used. Fail fast instead: the tests would
  // fail at launch with a less obvious Playwright error.
  if (!existsSync(override)) {
    console.error(`encrypted test deps: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH points at a missing browser: ${override}`);
    console.error("Unset it to use the Playwright-managed Chromium, or point it at an installed Chromium.");
    process.exit(1);
  }
  console.log(`encrypted test deps: using PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH (${override}), skipping browser download.`);
} else {
  let executable;
  try {
    executable = chromiumExecutablePath();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`encrypted test deps: cannot resolve the Playwright Chromium path: ${detail}`);
    process.exit(1);
  }
  const shellDir = headlessShellDir();
  const shellMissing = shellDir !== null && !dirIsPopulated(shellDir);
  if (!existsSync(executable) || shellMissing) {
    if (shellMissing) console.log(`encrypted test deps: headless shell missing (${shellDir}), downloading ...`);
    else console.log(`encrypted test deps: Chromium missing, downloading (${executable}) ...`);
    execFileSync(process.execPath,
      [join(ENCRYPTED_MODULES, "playwright", "cli.js"), "install", "chromium"], { stdio: "inherit" });
    const shellDirAfter = headlessShellDir();
    if (!existsSync(chromiumExecutablePath()) || (shellDirAfter !== null && !dirIsPopulated(shellDirAfter))) {
      console.error("encrypted test deps: Chromium still missing after `playwright install chromium`.");
      console.error("On Linux without system browser libraries, run with OS packages instead:");
      console.error("  packages/cli/test/encrypted/node_modules/.bin/playwright install --with-deps chromium");
      process.exit(1);
    }
  } else {
    console.log("encrypted test deps: Chromium present, skipping download.");
  }
}
