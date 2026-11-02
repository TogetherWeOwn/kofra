#!/usr/bin/env node
// Open-core guard for the PUBLIC repo: hosted-service (SaaS) code never lands here.
//
// This repository is the complete single-tenant product (MIT). Plans, prices,
// billing, payment SDKs, public signup and multi-tenant operations belong to a
// separate hosted layer built on createKofra() extension points. This script
// fails (exit 1) when it finds signs of that layer:
//
//   1. a proprietary SPDX marker (every hosted-layer source file carries one)
//   2. a payment SDK or a hosted-layer package in any package.json or npm, Yarn, pnpm or Bun lockfile
//   3. code importing a payment SDK or a hosted-layer package, code/config naming the private repo,
//      or code importing a package its workspace (or the root) does not declare
//   4. a .gitmodules file (the public repo never vendors anything)
//   5. files or folders named for billing, pricing, payments, subscriptions or plans
//   6. billing/pricing words in code under apps/, packages/, scripts/ and test/ (comment lines are
//      skipped; real exceptions go in scripts/open-core-allowlist.txt with a reason)
//   7. Markdown sections about pricing, plans or billing (business docs live in the private repo)
//
// Usage: node scripts/guard-open-core.mjs            scan tracked and untracked (not ignored) files
//        node scripts/guard-open-core.mjs --self-test check the rules against built-in examples
//
// The private names below are assembled at runtime on purpose: the hosted repo's own guard
// fails if public files contain them literally.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = "scripts/guard-open-core.mjs";
const ALLOWLIST = "scripts/open-core-allowlist.txt";

const PRIVATE_REPO = ["dropway", "cloud"].join("-");
const PRIVATE_SCOPE = `@${PRIVATE_REPO}/`;
const MARKER_RE = new RegExp(["LicenseRef", "Dropway", "(?:Cloud-)?Proprietary"].join("-"));

/** Payment SDKs and the hosted layer's packages: never a dependency here. */
const FORBIDDEN_PACKAGES = new Set(["stripe", "chargebee", "chargebee-typescript", "recurly", "braintree", "paddle-sdk", "@paddle/paddle-node-sdk", PRIVATE_REPO]);
const FORBIDDEN_SCOPES = ["@stripe/", "@paddle/", "@lemonsqueezy/", "@chargebee/", "@recurly/", PRIVATE_SCOPE];
const isForbiddenPackage = (name) => FORBIDDEN_PACKAGES.has(name) || FORBIDDEN_SCOPES.some((s) => name.startsWith(s));
const aliasPackage = (spec) => typeof spec === "string" ? spec.match(/^npm:((?:@[\w.-]+\/)?[\w.-]+)(?:@|$)/)?.[1] : undefined;

const CODE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const CONFIG_EXT = new Set([".json", ".jsonc", ".toml", ".yml", ".yaml", ".sql"]);
const WORD_SCAN_DIRS = ["apps/", "packages/", "scripts/", "test/"];

/** Folder or file names that only a hosted, paid service needs. */
const FORBIDDEN_PATH_SEGMENT = /^(billing|pricing|payments?|stripe|checkout|subscriptions?|entitlements?|invoices?|plans|saas)$/i;
const FORBIDDEN_PATH_PREFIX = [/^apps\/cloud[-_]/i, /^packages\/cloud[-_]/i, /^docs\/(business|pricing)/i];

/** Words that mean billing/pricing logic when they appear in code (matched per identifier word). */
const SAAS_WORDS = new Map(
  Object.entries({
    stripe: "stripe",
    billing: "billing",
    pricing: "pricing",
    invoice: "invoice",
    invoices: "invoice",
    payment: "payment",
    payments: "payment",
    paywall: "paywall",
    subscription: "subscription",
    subscriptions: "subscription",
    entitlement: "entitlement",
    entitlements: "entitlement",
    dunning: "dunning",
  }),
);
const PLAN_SUFFIX = new Set(["id", "ids", "name", "tier", "tiers", "limit", "limits", "code", "price", "catalog"]);
const PLAN_PREFIX = new Set(["free", "pro", "team", "business", "enterprise", "paid", "current", "upgrade", "downgrade"]);

/** Split a line into lowercase words: identifiers are split on camelCase, snake_case and kebab-case. */
export function words(line) {
  const out = [];
  for (const token of line.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    for (const w of token.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(" ")) out.push(w.toLowerCase());
  }
  return out;
}

/** SaaS terms found in a line (labels used by the allowlist). */
export function saasTerms(line) {
  const ws = words(line);
  const found = new Set();
  ws.forEach((w, i) => {
    const single = SAAS_WORDS.get(w);
    if (single) found.add(single);
    const next = ws[i + 1];
    if (w === "checkout" && (next === "session" || next === "sessions")) found.add("checkout session");
    if (w === "plan" && next && PLAN_SUFFIX.has(next)) found.add("plan");
    if (PLAN_PREFIX.has(w) && (next === "plan" || next === "plans")) found.add("plan");
  });
  return [...found];
}

const PRICING_HEADING = /^#{1,6}\s+(?:pricing|plans?(?:\s+(?:and|&)\s+pricing)?|billing|subscriptions?|payments?)\b/i;

/** import/export ... from "x" (multi-line), import "x", import("x"), require("x"); run on comment-stripped code. */
const IMPORT_RES = [
  /^\s*(?:import|export)\s[^;]*?\bfrom\s*["']([^"'\n]+)["']/gm,
  /^\s*import\s*["']([^"'\n]+)["']/gm,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];

/** Blank out comments (keeping line numbers) so prose such as "values from 'x'" is never read as an import. */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const BUILTINS = new Set(builtinModules);

/** The npm package an import specifier refers to, or null for relative, builtin and runtime-provided modules. */
function packageOf(spec) {
  if (/^(\.|\/|#|[a-z]+:)/i.test(spec)) return null; // relative, absolute, subpath imports, node:, cloudflare:, https:
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  return BUILTINS.has(name) ? null : name;
}

function declaredDeps(pkg) {
  const out = new Set();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) for (const n of Object.keys(pkg?.[field] ?? {})) out.add(n);
  return out;
}

const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*|#|<!--|--)/.test(line);

function globToRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** "path-glob term  # reason" lines. */
export function parseAllowlist(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [glob, ...term] = line.split(/\s+/);
    out.push({ re: globToRe(glob), term: term.join(" ").toLowerCase() });
  }
  return out;
}

/**
 * Check files ({ path, content }) and return violations ({ path, line, rule, message }).
 * Pure: no file system access, so --self-test can feed it examples.
 */
export function scan(files, allowlist = []) {
  const violations = [];
  const add = (path, line, rule, message) => violations.push({ path, line, rule, message });
  const allowed = (path, term) => allowlist.some((a) => a.term === term && a.re.test(path));

  // Workspaces: package.json dir -> declared dependencies; every workspace's own name is importable.
  const workspaces = new Map();
  const workspaceNames = new Set();
  for (const { path, content } of files) {
    if (content === null || !(path === "package.json" || path.endsWith("/package.json")) || path.includes("node_modules/")) continue;
    let pkg = null;
    try {
      pkg = JSON.parse(content);
    } catch {
      continue;
    }
    workspaces.set(path === "package.json" ? "" : path.slice(0, -"/package.json".length), declaredDeps(pkg));
    if (pkg?.name) workspaceNames.add(pkg.name);
  }
  const importable = (path, name) => {
    if (workspaceNames.has(name) || workspaces.get("")?.has(name)) return true;
    let best = null;
    for (const dir of workspaces.keys()) if (dir && path.startsWith(`${dir}/`) && (!best || dir.length > best.length)) best = dir;
    if (best !== null) return workspaces.get(best).has(name);
    // Root-level tests and scripts exercise every workspace: any workspace's declared dependency is fine.
    return [...workspaces.values()].some((deps) => deps.has(name));
  };

  for (const { path, content } of files) {
    if (path === SELF) continue;
    const ext = extname(path).toLowerCase();
    const base = path.split("/").pop() ?? path;

    if (base === ".gitmodules") add(path, 0, "no-submodules", "The public repo never vendors other repos (git submodules).");
    if (base === "bun.lockb") add(path, 0, "unsupported-lockfile", "Binary lockfiles cannot be audited. Regenerate as bun.lock with bun install --save-text-lockfile.");

    const segments = path.split("/");
    const named = segments.find((s, i) => FORBIDDEN_PATH_SEGMENT.test(i === segments.length - 1 ? s.replace(/\.[^.]+$/, "") : s));
    if ((named && !allowed(path, "path")) || FORBIDDEN_PATH_PREFIX.some((re) => re.test(path))) {
      add(path, 0, "saas-path", "Files and folders for billing, pricing, payments, subscriptions or plans belong to the hosted layer, not here.");
    }

    if (content === null) continue; // binary
    const lines = content.split("\n");

    lines.forEach((line, i) => {
      if (MARKER_RE.test(line)) add(path, i + 1, "proprietary-marker", "Proprietary hosted-layer code must not be copied into the MIT repo.");
    });

    if (base === "package.json") {
      let pkg = null;
      try {
        pkg = JSON.parse(content);
      } catch {
        /* reported by npm, not here */
      }
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const [name, spec] of Object.entries(pkg?.[field] ?? {})) {
          for (const candidate of new Set([name, aliasPackage(spec)].filter(Boolean))) {
            if (isForbiddenPackage(candidate)) add(path, 0, "forbidden-dependency", `"${candidate}" in ${field}: payment SDKs and hosted-layer packages never belong to the open-source product.`);
          }
        }
      }
      if (pkg?.name && isForbiddenPackage(pkg.name)) add(path, 0, "forbidden-dependency", `Package name "${pkg.name}" belongs to the hosted layer.`);
      continue;
    }
    if (["package-lock.json", "npm-shrinkwrap.json"].includes(base)) {
      const names = new Set();
      const visit = (value) => {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          // npm v1 nests dependencies; v2/v3 use installation paths in packages.
          const name = key.split("node_modules/").pop();
          if (isForbiddenPackage(name)) names.add(name);
          if (key === "name" && typeof child === "string" && isForbiddenPackage(child)) names.add(child);
          const alias = aliasPackage(child);
          if (alias && isForbiddenPackage(alias)) names.add(alias);
          visit(child);
        }
      };
      try {
        visit(JSON.parse(content));
      } catch {
        /* malformed JSON is reported by the package manager */
      }
      for (const name of names) add(path, 0, "forbidden-dependency", `"${name}" is in the lockfile.`);
      continue;
    }
    if (["yarn.lock", "pnpm-lock.yaml", "bun.lock"].includes(base)) {
      // Read package keys/selectors, not substrings in URLs or similarly named packages.
      // Bun's text format is JSONC; matching selectors also handles its trailing commas.
      const text = lines.filter((line) => !isCommentLine(line)).join("\n");
      const selectors = /(?:^|[\s"'`,\[{])((?:@[\w.-]+\/)?[\w.-]+)(?=@|:|["'\s,}\]])/gm;
      const aliases = /\bnpm:((?:@[\w.-]+\/)?[\w.-]+)(?=@)/g;
      const legacyPnpm = /^\s*["']?\/((?:@[\w.-]+\/)?[\w.-]+)[/@]/gm;
      const names = new Set([...text.matchAll(selectors), ...text.matchAll(aliases), ...text.matchAll(legacyPnpm)].map((m) => m[1]).filter(isForbiddenPackage));
      for (const name of names) add(path, 0, "forbidden-dependency", `"${name}" is in the lockfile.`);
      continue;
    }

    if (CODE_EXT.has(ext)) {
      const code = stripComments(content);
      for (const m of IMPORT_RES.flatMap((re) => [...code.matchAll(re)])) {
        const spec = m[1];
        const line = code.slice(0, m.index + m[0].length).split("\n").length;
        const pkgName = packageOf(spec);
        if ((pkgName && isForbiddenPackage(pkgName)) || spec.includes(PRIVATE_REPO)) {
          add(path, line, "forbidden-import", `Imports "${spec}". The open-source product never depends on payment SDKs or the hosted layer.`);
        } else if (pkgName && !importable(path, pkgName)) {
          add(path, line, "undeclared-import", `Imports "${spec}", which neither this workspace's package.json nor the root package.json declares.`);
        }
      }
    }

    if (CODE_EXT.has(ext) || CONFIG_EXT.has(ext)) {
      lines.forEach((line, i) => {
        if (line.includes(PRIVATE_REPO) && !allowed(path, PRIVATE_REPO)) add(path, i + 1, "names-private-repo", "Public code and config never refer to the private hosted repo.");
      });
    }

    if (CODE_EXT.has(ext) && WORD_SCAN_DIRS.some((d) => path.startsWith(d))) {
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        for (const term of saasTerms(line)) {
          if (!allowed(path, term)) {
            add(path, i + 1, "saas-term", `"${term}" in code. Billing and pricing logic belongs to the hosted layer; if this use is unrelated, add "${path} ${term}  # reason" to ${ALLOWLIST}.`);
          }
        }
      });
    }

    if (ext === ".md" || ext === ".mdx") {
      lines.forEach((line, i) => {
        if (PRICING_HEADING.test(line) && !allowed(path, "heading")) add(path, i + 1, "business-doc", "Pricing, plans and billing documents belong to the private repo's docs/.");
        if (line.includes(PRIVATE_SCOPE)) add(path, i + 1, "names-private-repo", "Public docs never reference hosted-layer packages.");
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------- self-test

const SELF_TESTS = [
  { name: "marker", files: [{ path: "packages/core/src/x.ts", content: `// SPDX-License-Identifier: ${["LicenseRef", "Dropway", "Proprietary"].join("-")}\n` }], rules: ["proprietary-marker"] },
  { name: "sdk dependency", files: [{ path: "packages/server/package.json", content: JSON.stringify({ dependencies: { stripe: "^1" } }) }], rules: ["forbidden-dependency"] },
  { name: "private scope dependency", files: [{ path: "package.json", content: JSON.stringify({ devDependencies: { [`${PRIVATE_SCOPE}plans`]: "1.0.0" } }) }], rules: ["forbidden-dependency"] },
  { name: "lockfile", files: [{ path: "package-lock.json", content: JSON.stringify({ packages: { "node_modules/@stripe/stripe-js": {} } }) }], rules: ["forbidden-dependency"] },
  { name: "legacy npm lockfile", files: [{ path: "package-lock.json", content: JSON.stringify({ dependencies: { ordinary: { dependencies: { stripe: { version: "1.0.0" } } } } }) }], rules: ["forbidden-dependency"] },
  { name: "shrinkwrap lockfile", files: [{ path: "npm-shrinkwrap.json", content: JSON.stringify({ dependencies: { stripe: { version: "1.0.0" } } }) }], rules: ["forbidden-dependency"] },
  { name: "yarn lockfile", files: [{ path: "yarn.lock", content: '"@stripe/stripe-js@npm:^1":\n  version: 1.0.0\n' }], rules: ["forbidden-dependency"] },
  { name: "pnpm lockfile", files: [{ path: "pnpm-lock.yaml", content: "packages:\n  stripe@1.0.0: {}\n" }], rules: ["forbidden-dependency"] },
  { name: "legacy pnpm lockfile", files: [{ path: "pnpm-lock.yaml", content: "packages:\n  /@stripe/stripe-js/1.0.0: {}\n" }], rules: ["forbidden-dependency"] },
  { name: "bun text lockfile", files: [{ path: "bun.lock", content: '{ "packages": { "alias": ["stripe@1.0.0", "", {}, "sha512-test"], }, }' }], rules: ["forbidden-dependency"] },
  { name: "manifest npm alias", files: [{ path: "package.json", content: JSON.stringify({ dependencies: { alias: "npm:stripe@^1" } }) }], rules: ["forbidden-dependency"] },
  { name: "npm lockfile alias", files: [{ path: "package-lock.json", content: JSON.stringify({ dependencies: { alias: { version: "npm:stripe@1.0.0" } } }) }], rules: ["forbidden-dependency"] },
  { name: "bun npm alias", files: [{ path: "bun.lock", content: '{ "packages": { "alias": ["npm:stripe@1.0.0", "", {}, "sha512-test"] } }' }], rules: ["forbidden-dependency"] },
  { name: "scoped text lockfile alias", files: [{ path: "yarn.lock", content: '"alias@npm:@stripe/stripe-js@^1":\n  version: 1.0.0\n' }], rules: ["forbidden-dependency"] },
  { name: "binary lockfile requires text", files: [{ path: "bun.lockb", content: null }], rules: ["unsupported-lockfile"] },
  { name: "ordinary text lockfiles", files: ["yarn.lock", "pnpm-lock.yaml", "bun.lock"].map((path) => ({ path, content: '# stripe in a comment is not a dependency\n"striped@1.0.0": { "resolved": "https://example.test/stripe/example.tgz" }\n' })), rules: [] },
  { name: "sdk import", files: [{ path: "apps/worker/src/index.ts", content: 'import Stripe from "stripe";\n' }], rules: ["forbidden-import", "saas-term"] },
  { name: "private import", files: [{ path: "packages/server/src/a.ts", content: `const p = await import("${PRIVATE_SCOPE}billing");\n` }], rules: ["forbidden-import", "names-private-repo", "saas-term"] },
  { name: "identifier words", files: [{ path: "apps/worker/src/x.ts", content: "const key = env.STRIPE_SECRET_KEY;\ngetBillingPortal();\nconst striped = true;\n" }], rules: ["saas-term", "saas-term"] },
  { name: "submodule", files: [{ path: ".gitmodules", content: "[submodule]\n" }], rules: ["no-submodules"] },
  { name: "billing folder", files: [{ path: "packages/core/src/billing/index.ts", content: "export {};\n" }], rules: ["saas-path"] },
  { name: "billing word in code", files: [{ path: "packages/core/src/services/sites.ts", content: "const billingEmail = x;\nexport const planId = 1;\n" }], rules: ["saas-term", "saas-term"] },
  { name: "comment lines are fine", files: [{ path: "packages/core/src/adapters.ts", content: "// No plans, prices or billing here.\n * no billing\n" }], rules: [] },
  { name: "allowlisted word", files: [{ path: "packages/core/src/lib/slug.ts", content: '"billing", "help",\n' }], allow: "packages/core/src/lib/slug.ts billing", rules: [] },
  { name: "pricing heading", files: [{ path: "docs/SELF_HOST.md", content: "# Self-host\n\n## Pricing\n" }], rules: ["business-doc"] },
  { name: "docs may say no billing", files: [{ path: "README.md", content: "Single tenant: no signup, no billing.\n" }], rules: [] },
  {
    name: "ordinary code passes",
    files: [
      { path: "packages/cli/package.json", content: JSON.stringify({ name: "kofra", devDependencies: { esbuild: "1" } }) },
      { path: "packages/cli/src/main.ts", content: 'import { readFile } from "node:fs/promises";\nimport { build } from "esbuild";\nimport { env } from "cloudflare:test";\nimport x from "./x.ts";\nconst plan = makePlan();\n' },
    ],
    rules: [],
  },
  {
    name: "prose is not an import",
    files: [{ path: "packages/core/src/b.ts", content: "/** sha256 values from `shas` that the scope lacks */\n// copied from 'somewhere'\nconst s = 1;\n" }],
    rules: [],
  },
  {
    name: "undeclared import",
    files: [
      { path: "package.json", content: JSON.stringify({ devDependencies: { vitest: "1" } }) },
      { path: "packages/core/package.json", content: JSON.stringify({ name: "@kofra/core" }) },
      { path: "packages/core/src/a.ts", content: 'import { x } from "left-pad";\nimport { it } from "vitest";\nimport { y } from "@kofra/core";\n' },
    ],
    rules: ["undeclared-import"],
  },
];

function selfTest() {
  let failed = 0;
  for (const t of SELF_TESTS) {
    const got = scan(t.files, t.allow ? parseAllowlist(t.allow) : []).map((v) => v.rule).sort();
    const want = [...t.rules].sort();
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${t.name}${ok ? "" : `: expected [${want}] got [${got}]`}`);
  }
  if (failed) {
    console.error(`open-core guard self-test: ${failed} case(s) failed`);
    process.exit(1);
  }
  console.log(`open-core guard self-test: ${SELF_TESTS.length} cases passed`);
}

// ---------------------------------------------------------------- main

/** Scan a checkout (default: this repo). */
export function scanTree(root = ROOT) {
  const list = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((p, i, all) => all.indexOf(p) === i && existsSync(join(root, p)));
  const files = list.map((path) => {
    const buf = readFileSync(join(root, path));
    const binary = buf.subarray(0, 8000).includes(0);
    return { path, content: binary ? null : buf.toString("utf8") };
  });
  const allowlist = existsSync(join(root, ALLOWLIST)) ? parseAllowlist(readFileSync(join(root, ALLOWLIST), "utf8")) : [];
  return { files: files.length, violations: scan(files, allowlist) };
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const { files, violations } = scanTree();
  if (violations.length) {
    console.error(`open-core guard: ${violations.length} problem(s). This repo is the single-tenant open-source product; hosted-service code lives elsewhere.`);
    for (const v of violations) console.error(`- ${v.path}${v.line ? `:${v.line}` : ""} [${v.rule}] ${v.message}`);
    process.exit(1);
  }
  console.log(`open-core guard: OK (${files} files checked)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
