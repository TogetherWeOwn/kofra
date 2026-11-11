#!/usr/bin/env node
// Guard for the disposable verification deployment config
// (wrangler.verification.jsonc, used only by
// .github/workflows/verification-deploy.yml).
//
// The verification token is account-wide and the same account hosts other
// Workers and data resources, so this guard fails before any wrangler call
// unless the config is exactly the reviewed verification shape. It is an
// allowlist, not a denylist: only the permitted top-level keys and their
// pinned values pass. Any other key, any pinned value changed in any way,
// extra keys inside a binding, or a resource addressed by id refuses.
// That covers build/run keys, entry-point repointing and routing keys
// without having to enumerate every key wrangler might honour.
//
// Usage:
//   node scripts/guard-verification-config.mjs [config]   check a config (default wrangler.verification.jsonc)
//   node scripts/guard-verification-config.mjs --self-test run fixture checks (CI)
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_CONFIG = "wrangler.verification.jsonc";

/** The only top-level keys the verification config may carry. */
const ALLOWED_KEYS = new Set([
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "observability",
  "vars",
  "d1_databases",
  "r2_buckets",
  "kv_namespaces",
  "triggers",
]);

/** Pinned top-level values: any change refuses. */
const PINNED = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "kofra-verification",
  main: "apps/worker/src/index.ts",
  compatibility_date: "2026-10-01",
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  workers_dev: true,
  observability: { enabled: true },
  vars: {
    APP_ORIGIN: "",
    SITES_MODE: "path",
    SITES_ORIGIN: "",
    SITES_DOMAIN: "",
    ANONYMOUS_PUBLISH: "false",
  },
  d1_databases: [
    { binding: "DB", database_name: "kofra-verification", migrations_dir: "packages/core/migrations" },
  ],
  r2_buckets: [{ binding: "FILES", bucket_name: "kofra-verification-files" }],
  kv_namespaces: [{ binding: "CACHE" }],
  triggers: { crons: ["17 * * * *", "0 0 * * *"] },
};

/** Keys that must each appear exactly once in the comment-stripped text. */
const EXACTLY_ONCE_KEYS = ['"name"', '"main"', '"database_name"', '"bucket_name"'];

/** Strip // line comments that sit outside string literals (keeping newlines). */
export function stripLineComments(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Check a verification config's text. Returns a list of refusal reasons
 * (empty when the config passes). Pure: no file system access.
 */
export function checkVerificationConfig(text) {
  const errors = [];
  // Escaped keys decode to real keys for the JSONC parser but would be
  // invisible to a text scan, and block comments could hide a fake line;
  // this config needs neither, so both refuse outright.
  if (text.includes("\\") || text.includes("/*")) {
    return ["contains a backslash escape or block comment; the verification config must stay plain JSONC so the guard sees every key wrangler sees"];
  }
  const stripped = stripLineComments(text);
  // Exactly-once checks on the text wrangler will parse: a second literal
  // key the extraction cannot see must also refuse.
  for (const key of EXACTLY_ONCE_KEYS) {
    const count = stripped.split(key).length - 1;
    if (count !== 1) errors.push(`must contain the key ${key} exactly once (found ${count})`);
  }
  let config;
  try {
    config = JSON.parse(stripped);
  } catch (e) {
    return [...errors, `is not valid JSONC: ${e.message}`];
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [...errors, "must be a JSON object"];
  }
  for (const key of Object.keys(config)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`has top-level key "${key}", which is not in the permitted verification allowlist`);
  }
  for (const key of ALLOWED_KEYS) {
    if (!(key in config)) {
      errors.push(`is missing required top-level key "${key}"`);
      continue;
    }
    if (!same(config[key], PINNED[key])) {
      errors.push(`top-level key "${key}" must be ${JSON.stringify(PINNED[key])} (found ${JSON.stringify(config[key])})`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------- self-test

function selfTest() {
  const committed = readFileSync(join(ROOT, DEFAULT_CONFIG), "utf8");
  const base = JSON.parse(stripLineComments(committed));
  const mutate = (change) => {
    const copy = JSON.parse(JSON.stringify(base));
    change(copy);
    return JSON.stringify(copy, null, 2);
  };
  const cases = [
    { name: "current committed config passes", text: committed, pass: true },
    { name: "build command entry refused", text: mutate((c) => { c.build = { command: "echo hi" }; }), pass: false },
    { name: "repointed main refused", text: mutate((c) => { c.main = "apps/worker/src/other.ts"; }), pass: false },
    { name: "routes key refused", text: mutate((c) => { c.routes = [{ pattern: "example.com/*" }]; }), pass: false },
    { name: "route key refused", text: mutate((c) => { c.route = "example.com/*"; }), pass: false },
    { name: "workers_dev flipped refused", text: mutate((c) => { c.workers_dev = false; }), pass: false },
    { name: "unknown top-level key refused", text: mutate((c) => { c.custom_key = 1; }), pass: false },
    { name: "wrong Worker name refused", text: mutate((c) => { c.name = "other"; }), pass: false },
    { name: "wrong bucket refused", text: mutate((c) => { c.r2_buckets[0].bucket_name = "other-bucket"; }), pass: false },
    { name: "id-addressed D1 refused", text: mutate((c) => { c.d1_databases[0].database_id = "abc"; }), pass: false },
    { name: "extra KV id refused", text: mutate((c) => { c.kv_namespaces[0].id = "abc"; }), pass: false },
    { name: "vars change refused", text: mutate((c) => { c.vars.ANONYMOUS_PUBLISH = "true"; }), pass: false },
    { name: "weakened compatibility flags refused", text: mutate((c) => { c.compatibility_flags = ["nodejs_compat"]; }), pass: false },
    { name: "duplicate name key refused", text: committed.replace('"name": "kofra-verification"', '"name": "kofra-verification", "name": "kofra-verification"'), pass: false },
    { name: "escaped key refused", text: committed.replace('"name"', '"na\\u006de"'), pass: false },
    { name: "block comment refused", text: `/* hi */\n${committed}`, pass: false },
  ];
  let failed = 0;
  for (const c of cases) {
    const errors = checkVerificationConfig(c.text);
    const ok = c.pass ? errors.length === 0 : errors.length > 0;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${c.name}${ok ? "" : `: expected ${c.pass ? "pass" : "refusal"}, got errors [${errors.join("; ")}]`}`);
  }
  if (failed) {
    console.error(`verification config guard self-test: ${failed} case(s) failed`);
    process.exit(1);
  }
  console.log(`verification config guard self-test: ${cases.length} cases passed`);
}

// ---------------------------------------------------------------- main

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const configPath = arg ?? DEFAULT_CONFIG;
  if (process.env.WRANGLER_CONFIG && process.env.WRANGLER_CONFIG !== DEFAULT_CONFIG) {
    console.error(`::error::WRANGLER_CONFIG is '${process.env.WRANGLER_CONFIG}', expected ${DEFAULT_CONFIG}. Refusing to run.`);
    process.exit(1);
  }
  let text;
  try {
    text = readFileSync(resolve(ROOT, configPath), "utf8");
  } catch (e) {
    console.error(`::error::cannot read ${configPath}: ${e.message}`);
    process.exit(1);
  }
  const errors = checkVerificationConfig(text);
  if (errors.length) {
    for (const e of errors) console.error(`::error::${configPath} ${e}. Refusing to run.`);
    process.exit(1);
  }
  console.log(`Guard ok: ${configPath} matches the pinned verification shape (Worker kofra-verification, D1 kofra-verification, R2 kofra-verification-files, allowlisted keys only).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
