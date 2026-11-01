#!/usr/bin/env node
// rebrand:keep-file
// Rebrand Dropway -> Kofra: rename what users see, keep internal names.
//
// Re-runnable and idempotent. Other branches keep adding "Dropway" text, so after a rebase
// run it again and commit the result; a second run on a clean tree changes nothing.
//
// Renamed (user-visible):
//   - product name in prose, UI copy, page titles, INSTANCE_NAME default   Dropway -> Kofra
//   - CLI command in help text and docs (the `dropway` bin stays as an alias)  dropway -> kofra
//   - CLI package name (not published) and the root package name
//   - environment variables DROPWAY_* -> KOFRA_* (code accepts DROPWAY_* via legacy-brand.ts)
//   - HTTP headers X-Dropway-* -> X-Kofra-* (the server still sends and accepts X-Dropway-*)
//   - Agent Skill name, MCP server name and MCP client config snippets, llms.txt copy
//   - repository URLs under the old repository name -> TogetherWeOwn/kofra (the repository was
//     renamed; old links only work through GitHub's redirect, so --check flags any that return)
// Kept (internal, renaming breaks links, data or deployments):
//   - Worker names (dropway, dropway-sites), D1/R2/KV/Analytics/queue names, DB tables,
//     cookie and localStorage names, reserved paths (/__dropway/), site files (.dropway/),
//     CLI files (dropway.json, .dropwayignore, ~/.config/dropway), test hosts (dropway.test),
//     TypeScript identifiers (createDropway, DropwayContext, ...), workspace package scopes
//     (@dropway/*), the SPDX marker, CHANGELOG history, SQL migrations, CI workflow job names.
//
// Escape hatches: a line containing "rebrand:keep" is never edited; a file containing
// "rebrand:keep-file" is skipped (compat shims that must spell the old names).
//
// Usage:
//   node scripts/rebrand.mjs                    apply, print counts
//   node scripts/rebrand.mjs --check            exit 1 if anything would change (CI)
//   node scripts/rebrand.mjs --root <dir>       run on another checkout
//   node scripts/rebrand.mjs --config <file>    extra rules for a layer built on this repo (.mjs
//                                               exporting { rules, keep, exclude, renames, json })
//   node scripts/rebrand.mjs --no-lock          skip refreshing package-lock.json
//   node scripts/rebrand.mjs --self-test        run the script on throwaway repositories (CI)
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const CHECK = flag("--check");
if (flag("--self-test")) process.exit(selfTest());
const ROOT = resolve(opt("--root") ?? fileURLToPath(new URL("..", import.meta.url)));

const TEXT_EXT = /\.(md|mdx|txt|ts|tsx|mts|js|mjs|cjs|json|jsonc|ya?ml|toml|html|css|svg)$/i;
const CODE_EXT = /\.(ts|tsx|mts|js|mjs|cjs)$/i;
const MD_EXT = /\.mdx?$/i;
/** A Markdown fence line; group 2 is the info string (```ts). */
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w-]*)/;
const CODE_LANG = /^(ts|tsx|typescript|js|jsx|javascript|mjs|cjs)$/i;

/** Paths never edited (regexes on the repo-relative path). */
const EXCLUDE = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)CHANGELOG\.md$/,
  /\.sql$/,
  /(^|\/)migrations\//,
  /^vendor\//,
  /(^|\/)node_modules\//,
  /^scripts\/guard-open-core\.mjs$/,
  /^packages\/server\/src\/viewers\/hljs\.js$/,
];

/** Spans never edited (protected before the rules run, restored after). */
const KEEP = [
  /LicenseRef-Dropway[\w-]*/g, // SPDX marker of the hosted layer
  /"LicenseRef", "Dropway"/g,
];

/** TypeScript identifiers spelled exactly "Dropway" (the createDropway() return type). */
const CODE_KEEP = [/(?<=\b(?:interface|type)\s+)Dropway(?![\w$])/g, /(?<=[\w$)]:\s*)Dropway(?=\s*[;,{=)>\]|])/g];

const CLI_SUBCOMMANDS =
  "publish|list|site|files|versions|restore|delete|whoami|login|logout|setup|api|help|watch|mcp|drive|\\$\\{name\\}|\\$\\{VERSION\\}|<command>|<METHOD>|<operationId";

/** [name, regex, replacement]. Order matters only where noted. */
const RULES = [
  // Repository URLs and action/skill refs. The lookahead keeps a differently named
  // repository that merely starts with the old name (e.g. an "-action" repo) untouched.
  ["repository URL", /\bTogetherWeOwn\/dropway(?![\w-])/g, "TogetherWeOwn/kofra"],
  ["header X-Dropway-*", /\bX-Dropway-/g, "X-Kofra-"],
  ["header x-dropway-*", /\bx-dropway-/g, "x-kofra-"],
  ["env DROPWAY_*", /(?<![A-Za-z0-9_])DROPWAY_(?=[A-Z0-9])/g, "KOFRA_"],
  ["product name", /(?<![A-Za-z0-9_$])Dropway(?![A-Za-z0-9_$])/g, "Kofra"],
  ["cli: npx", /(?<=\bnpx (?:-y )?)dropway(?![\w-])/g, "kofra"],
  ["cli: command", new RegExp(`(?<![\\w$/@.-])dropway(?= (?:${CLI_SUBCOMMANDS}))`, "g"), "kofra"],
  ["cli: name", /(?<![\w$/@.-])dropway(?=`?[ \t]+(?:CLI|command)\b)/g, "kofra"],
  ["cli: error prefix", /(?<=")dropway(?=: )/g, "kofra"],
  ["cli: workspace", /(?<=-w )dropway(?![\w-])/g, "kofra"],
  ["cli: npm package", /(?<=npm package ")dropway(?=")/g, "kofra"],
  ["cli: client id", /\bdropway-cli(?=[/-]\$\{VERSION\})/g, "kofra-cli"],
  ["mcp: server name", /(?<=--transport http )dropway(?![\w-])/g, "kofra"],
  ["mcp: config key", /(?<=mcpServers: \{ )dropway(?=:)|(?<=")dropway(?=": \{)|(?<=mcp_servers\.)dropway\b/g, "kofra"],
  ["mcp: key input", /\bdropway-key\b/g, "kofra-key"],
  ["mcp: default name", /(?<=name \?\? ")dropway(?=")|(?<=Default ")dropway(?=")/g, "kofra"],
  ["skill/mcp: name", /(?<=\bname: "?)dropway(?![\w-])/g, "kofra"],
  ["skill: path", /(?<=skills\/)dropway(?=\/)/g, "kofra"],
  ["skill: constant", /(?<=SKILL_NAME = ")dropway(?=")|(?<=Skill name \()dropway(?=\))/g, "kofra"],
  ["example domain", /\bdropway\.example\.com\b/g, "kofra.example.com"],
];

/** File and folder moves: [from, to]. */
const RENAMES = [["skills/dropway", "skills/kofra"]];

/** package.json edits: path -> function(pkg) returning a changed copy. */
const JSON_EDITS = {
  "package.json": (p) => (p.name === "dropway-monorepo" ? { ...p, name: "kofra-monorepo" } : p),
  "packages/cli/package.json": (p) => {
    const q = { ...p };
    if (q.name === "dropway") q.name = "kofra";
    if (q.bin && !q.bin.kofra) {
      const target = q.bin.dropway ?? Object.values(q.bin)[0];
      q.bin = { kofra: target, dropway: target };
    }
    if (Array.isArray(q.keywords) && !q.keywords.includes("kofra")) q.keywords = ["kofra", ...q.keywords];
    return q;
  },
};

// Extra rules for a layer built on this repository (kept out of this public file).
const configPath = opt("--config");
if (configPath) {
  const extra = (await import(pathToFileURL(resolve(configPath)).href)).default;
  RULES.push(...(extra.rules ?? []));
  KEEP.push(...(extra.keep ?? []));
  EXCLUDE.push(...(extra.exclude ?? []));
  RENAMES.push(...(extra.renames ?? []));
  Object.assign(JSON_EDITS, extra.json ?? {});
  if (extra.replaceDefaultJson) for (const k of Object.keys(JSON_EDITS)) if (!(k in (extra.json ?? {}))) delete JSON_EDITS[k];
}

const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" });
const counts = new Map();
const touched = new Set();
const bump = (name, n) => counts.set(name, (counts.get(name) ?? 0) + n);

const move = (from, to) => {
  mkdirSync(dirname(join(ROOT, to)), { recursive: true });
  try {
    git("mv", from, to);
  } catch {
    renameSync(join(ROOT, from), join(ROOT, to));
  }
};
const remove = (rel) => {
  try {
    git("rm", "-q", "--", rel);
  } catch {
    rmSync(join(ROOT, rel));
  }
};
/** Repo-relative paths of the files under rel (rel itself when it is a file). */
const filesUnder = (rel) => {
  const abs = join(ROOT, rel);
  if (!statSync(abs).isDirectory()) return [rel];
  return readdirSync(abs, { recursive: true })
    .map(String)
    .filter((p) => statSync(join(abs, p)).isFile())
    .map((p) => `${rel}/${p.split(sep).join("/")}`);
};

// 1. Moves. A branch rebased onto the rename can bring files back under the old name while the
// new one exists: each is moved across, or dropped when the new copy is identical. A file present
// under both names with different content is a collision: it stops the run before anything is
// written (with --check too), so a person merges the pair first.
const moves = []; // [kind, from, to, rename]: "tree" moves the whole path, "file" one file, "drop" deletes an identical copy
const collisions = [];
for (const [from, to] of RENAMES) {
  if (!existsSync(join(ROOT, from))) continue;
  if (!existsSync(join(ROOT, to))) {
    moves.push(["tree", from, to, `${from} -> ${to}`]);
    continue;
  }
  for (const rel of filesUnder(from)) {
    const target = to + rel.slice(from.length);
    if (!existsSync(join(ROOT, target))) moves.push(["file", rel, target, `${from} -> ${to}`]);
    else if (readFileSync(join(ROOT, rel)).equals(readFileSync(join(ROOT, target)))) moves.push(["drop", rel, target, `${from} -> ${to}`]);
    else collisions.push(`${rel} and ${target} both exist with different content`);
  }
}
if (collisions.length) {
  for (const c of collisions) console.error(`  collision: ${c}`);
  console.error("rebrand: merge each pair into the new path, delete the old file, then run again. Nothing was written.");
  process.exit(1);
}
for (const [kind, from, to, rename] of moves) {
  bump(`move ${rename}`, 1);
  touched.add(from);
  if (CHECK) continue;
  if (kind === "drop") remove(from);
  else move(from, to);
}
if (!CHECK) {
  for (const [from] of RENAMES) if (existsSync(join(ROOT, from)) && !filesUnder(from).length) rmSync(join(ROOT, from), { recursive: true });
}

// 2. Text rules on tracked files.
const files = git("ls-files", "-z").split("\0").filter(Boolean);
for (const rel of files) {
  if (!TEXT_EXT.test(rel) || EXCLUDE.some((re) => re.test(rel))) continue;
  const abs = join(ROOT, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) continue;
  const before = readFileSync(abs, "utf8");
  if (before.includes("rebrand:keep-file")) continue;
  const codeKeep = [...KEEP, ...CODE_KEEP];
  const keep = CODE_EXT.test(rel) ? codeKeep : KEEP;
  // In Markdown, TypeScript/JavaScript fences are code: their identifiers keep the old name too.
  let fence = null; // [marker, isCode] while inside a fence
  const after = before
    .split("\n")
    .map((line) => {
      let lineKeep = keep;
      if (MD_EXT.test(rel)) {
        const f = FENCE.exec(line);
        if (fence && f && f[1][0] === fence[0][0] && f[1].length >= fence[0].length && !f[2]) fence = null;
        else if (!fence && f) fence = [f[1], CODE_LANG.test(f[2])];
        else if (fence?.[1]) lineKeep = codeKeep;
      }
      return line.includes("rebrand:keep") ? line : rewriteLine(line, lineKeep);
    })
    .join("\n");
  if (after === before) continue;
  touched.add(rel);
  if (!CHECK) writeFileSync(abs, after);
}

function rewriteLine(line, keep) {
  const held = [];
  let s = line;
  for (const re of keep) s = s.replace(re, (m) => `\u0000${held.push(m) - 1}\u0000`);
  for (const [name, re, to] of RULES) {
    s = s.replace(re, (...m) => {
      bump(name, 1);
      return typeof to === "function" ? to(...m) : to;
    });
  }
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]);
}

// 3. package.json edits (structured, so formatting stays npm's).
let manifestsChanged = false;
for (const [rel, edit] of Object.entries(JSON_EDITS)) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  const text = readFileSync(abs, "utf8");
  const next = `${JSON.stringify(edit(JSON.parse(text)), null, 2)}\n`;
  if (next === text) continue;
  bump(`manifest ${rel}`, 1);
  touched.add(rel);
  manifestsChanged = true;
  if (!CHECK) writeFileSync(abs, next);
}

// 4. Lockfile: let npm rewrite the workspace entries (no network needed for renames).
if (!CHECK && manifestsChanged && !flag("--no-lock") && existsSync(join(ROOT, "package-lock.json"))) {
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: ROOT, stdio: "inherit" });
  touched.add("package-lock.json");
}

const total = [...counts.values()].reduce((a, b) => a + b, 0);
for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(6)}  ${name}`);
console.log(`${String(total).padStart(6)}  total replacements in ${touched.size} files${CHECK ? " (check mode, nothing written)" : ""}`);
if (CHECK && total > 0) {
  for (const f of [...touched].sort()) console.error(`  ${f}`);
  console.error("rebrand: user-visible Dropway names remain. Run: node scripts/rebrand.mjs");
  process.exit(1);
}

/** --self-test: run this script on throwaway git repositories and check the result. Returns the exit code. */
function selfTest() {
  const self = fileURLToPath(import.meta.url);
  const failures = [];
  let checks = 0;
  const expect = (what, ok) => {
    checks++;
    if (!ok) failures.push(what);
  };
  const repo = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "rebrand-self-test-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "add", "-A"]);
    return dir;
  };
  const runOn = (dir, ...extra) => {
    try {
      const out = execFileSync(process.execPath, [self, "--root", dir, "--no-lock", ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const read = (dir, rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null);

  // Renames what people see, keeps internal names and marked lines, and is idempotent.
  const keptLine = "See /__dropway/ and dropway.json.";
  // Escaped slash so a repo-wide search for the old repository URL stays clean.
  const oldRepoLine = "Source: https://github.com/TogetherWeOwn\/dropway, install: npx skills add TogetherWeOwn\/dropway, action: TogetherWeOwn\/dropway-action@v1.";
  const newRepoLine = "Source: https://github.com/TogetherWeOwn/kofra, install: npx skills add TogetherWeOwn/kofra, action: TogetherWeOwn\/dropway-action@v1.";
  const markedLine = "Dropway was the old name. <!-- rebrand:keep -->";
  const a = repo({
    "README.md": `Dropway: run \`npx dropway publish ./dist\` with DROPWAY_API_KEY, then read X-Dropway-Version.\n${keptLine}\n${oldRepoLine}\n${markedLine}\n`,
    "src/app.ts": 'import { createDropway, type Dropway } from "@dropway/server";\nexport const app: Dropway = createDropway({ title: "Dropway" });\n',
    "src/compat.ts": '// rebrand:keep-file\nexport const OLD = "X-Dropway-";\n',
    "docs/api.md": "Product: Dropway.\n\n```ts\nexport interface Dropway { fetch(): void }\nconst d: Dropway = createDropway();\n```\n\n```sh\nexport DROPWAY_API=x\n```\n",
    "CHANGELOG.md": "Dropway 0.1\n",
    "skills/dropway/SKILL.md": "name: dropway\n",
    "package.json": '{\n  "name": "dropway-monorepo"\n}\n',
  });
  expect("--check fails before the rename", runOn(a, "--check").code === 1);
  expect("apply succeeds", runOn(a).code === 0);
  expect("prose, CLI, variable, header and repository URL renamed", read(a, "README.md") === `Kofra: run \`npx kofra publish ./dist\` with KOFRA_API_KEY, then read X-Kofra-Version.\n${keptLine}\n${newRepoLine}\n${markedLine}\n`);
  expect("identifiers and package scope kept, string renamed", read(a, "src/app.ts") === 'import { createDropway, type Dropway } from "@dropway/server";\nexport const app: Dropway = createDropway({ title: "Kofra" });\n');
  expect("Markdown: TypeScript fences keep identifiers, prose and shell fences are renamed", read(a, "docs/api.md") === "Product: Kofra.\n\n```ts\nexport interface Dropway { fetch(): void }\nconst d: Dropway = createDropway();\n```\n\n```sh\nexport KOFRA_API=x\n```\n");
  expect("keep-file untouched", read(a, "src/compat.ts") === '// rebrand:keep-file\nexport const OLD = "X-Dropway-";\n');
  expect("CHANGELOG untouched", read(a, "CHANGELOG.md") === "Dropway 0.1\n");
  expect("skill folder moved and renamed", read(a, "skills/kofra/SKILL.md") === "name: kofra\n" && !existsSync(join(a, "skills/dropway")));
  expect("root package renamed", JSON.parse(read(a, "package.json")).name === "kofra-monorepo");
  expect("second run finds nothing (idempotent)", runOn(a, "--check").code === 0);

  // After a rebase, files under the old folder next to the new one: move, drop or report.
  const b = repo({
    "skills/kofra/SKILL.md": "name: kofra\n",
    "skills/kofra/same.md": "same\n",
    "skills/dropway/SKILL.md": "name: kofra\nedited on another branch\n",
    "skills/dropway/same.md": "same\n",
    "skills/dropway/extra.md": "extra\n",
  });
  const checked = runOn(b, "--check");
  expect("--check reports a collision", checked.code === 1 && checked.out.includes("collision: skills/dropway/SKILL.md"));
  expect("--check writes nothing", read(b, "skills/dropway/extra.md") === "extra\n" && read(b, "skills/kofra/extra.md") === null);
  const applied = runOn(b);
  expect("apply fails on a collision and writes nothing", applied.code === 1 && applied.out.includes("collision: skills/dropway/SKILL.md") && read(b, "skills/dropway/extra.md") === "extra\n" && read(b, "skills/dropway/same.md") === "same\n");
  rmSync(join(b, "skills/dropway/SKILL.md")); // a person merged the pair into skills/kofra/SKILL.md
  expect("apply succeeds once the collision is merged", runOn(b).code === 0);
  expect("new file moved across", read(b, "skills/kofra/extra.md") === "extra\n" && read(b, "skills/dropway/extra.md") === null);
  expect("identical copy dropped and the old folder removed", read(b, "skills/kofra/same.md") === "same\n" && !existsSync(join(b, "skills/dropway")));
  expect("idempotent after the merge", runOn(b, "--check").code === 0);

  for (const dir of [a, b]) rmSync(dir, { recursive: true, force: true });
  for (const f of failures) console.error(`  FAIL ${f}`);
  console.log(`rebrand self-test: ${checks - failures.length}/${checks} checks passed`);
  return failures.length ? 1 : 0;
}
