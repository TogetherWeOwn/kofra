#!/usr/bin/env node
// Builds the Kofra Security Print design system for @dropway/server from packages/server/design/:
//   themes.json      -> colour tokens for light (:root), dark (prefers-color-scheme) and [data-theme] overrides
//   css/*.css        -> component CSS written without prefixes; every class gets "k-" here (bundles.json "raw" files excepted)
//   bundles.json     -> the "app" bundle (one cached stylesheet) and the "site" bundle (inlined on site origins)
//   fonts/           -> self-hosted woff2 files + fonts.json (unicode ranges, fallback metrics) + OFL licences
//   ui/motifs.ts     -> the engraved plate, rendered once per mode into static SVG files
// and writes the only generated modules: src/ui/design.generated.ts and src/ui/fonts.generated.ts.
//
// Usage: node scripts/build-design.mjs           write the generated modules
//        node scripts/build-design.mjs --check   regenerate in memory; exit 1 if the committed files differ
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DESIGN = join(ROOT, "packages/server/design");
const OUT_DESIGN = join(ROOT, "packages/server/src/ui/design.generated.ts");
const OUT_FONTS = join(ROOT, "packages/server/src/ui/fonts.generated.ts");
export const PREFIX = "k-";

const sha8 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);

// ------------------------------------------------------------------ CSS helpers

/** Remove comments and collapse whitespace, leaving strings untouched. */
export function minifyCss(css) {
  let out = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === "\\" ? 2 : 1;
      out += css.slice(i, j + 1);
      i = j;
      continue;
    }
    if (/\s/.test(c)) {
      while (i + 1 < css.length && /\s/.test(css[i + 1])) i++;
      const prev = out[out.length - 1];
      const next = css[i + 1];
      if (prev === undefined || "{};,>".includes(prev) || (next !== undefined && "{};,>!".includes(next))) continue;
      out += " ";
      continue;
    }
    out += c;
  }
  return out.replace(/;}/g, "}").trim();
}

/** Index just past the block that starts at css[open] === "{" (strings and nesting respected). */
function blockEnd(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  throw new Error(`Unbalanced CSS block at ${open}`);
}

/** Prefix every class in one selector list: ".btn.ghost:not(.x)" -> ".k-btn.k-ghost:not(.k-x)". Strings and [attribute] selectors are left alone. */
export function prefixSelector(sel, prefix = PREFIX) {
  let out = "";
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < sel.length && sel[j] !== c) j += sel[j] === "\\" ? 2 : 1;
      out += sel.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      while (j < sel.length && sel[j] !== "]") {
        if (sel[j] === '"' || sel[j] === "'") {
          const q = sel[j];
          j++;
          while (j < sel.length && sel[j] !== q) j += sel[j] === "\\" ? 2 : 1;
        }
        j++;
      }
      out += sel.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "." && /[A-Za-z_]/.test(sel[i + 1] ?? "")) {
      out += `.${prefix}`;
      continue;
    }
    out += c;
  }
  return out;
}

const GROUPING_AT_RULES = new Set(["media", "supports", "layer", "container", "document", "scope"]);

/** Prefix the classes in every rule prelude of a stylesheet. At-rule preludes, declarations, url() and strings are never touched. */
export function prefixCss(css, prefix = PREFIX) {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const ws = /^\s*/.exec(css.slice(i))[0];
    out += ws;
    i += ws.length;
    if (i >= css.length) break;
    if (css[i] === "}") throw new Error(`Unexpected } at ${i}`);
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      const stop = end < 0 ? css.length : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }
    // Prelude: up to "{" or ";" outside strings and parentheses.
    let j = i;
    let paren = 0;
    while (j < css.length) {
      const c = css[j];
      if (c === '"' || c === "'") {
        let k = j + 1;
        while (k < css.length && css[k] !== c) k += css[k] === "\\" ? 2 : 1;
        j = k + 1;
        continue;
      }
      if (c === "(") paren++;
      else if (c === ")") paren--;
      else if (paren === 0 && (c === "{" || c === ";")) break;
      j++;
    }
    const prelude = css.slice(i, j);
    if (css[j] === ";" || j >= css.length) {
      out += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const end = blockEnd(css, j);
    if (prelude.trim().startsWith("@")) {
      const name = /^@([\w-]+)/.exec(prelude.trim())?.[1]?.toLowerCase() ?? "";
      if (GROUPING_AT_RULES.has(name)) out += `${prelude}{${prefixCss(css.slice(j + 1, end - 1), prefix)}}`;
      else out += prelude + css.slice(j, end);
    } else {
      out += prefixSelector(prelude, prefix) + css.slice(j, end);
    }
    i = end;
  }
  return out;
}

/** Every class name a stylesheet defines (after prefixing). */
export function classesIn(css) {
  const out = new Set();
  const re = /\.(-?[_A-Za-z][_A-Za-z0-9-]*)/g;
  // Only selectors: drop declaration blocks first.
  const selectors = css.replace(/\{[^{}]*\}/g, "{}");
  for (const m of selectors.matchAll(re)) out.add(m[1]);
  return out;
}

// ------------------------------------------------------------------ build

/**
 * Load ui/motifs.ts (the same drawing code the Worker runs). Node 22.18+ strips the types itself; on older
 * Node (the repo supports >= 20) the module is transpiled with esbuild (already a dev dependency) and
 * imported from a data: URL. motifs.ts has no imports, so this is the whole module.
 */
async function loadMotifs() {
  const url = new URL("../packages/server/src/ui/motifs.ts", import.meta.url);
  try {
    return await import(url.href);
  } catch (e) {
    if (e?.code !== "ERR_UNKNOWN_FILE_EXTENSION") throw e;
    const { transformSync } = await import("esbuild");
    const { code } = transformSync(readFileSync(url, "utf8"), { loader: "ts", format: "esm", target: "node20" });
    return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  }
}

export function buildDesign() {
  const themes = JSON.parse(readFileSync(join(DESIGN, "themes.json"), "utf8"));
  const bundles = JSON.parse(readFileSync(join(DESIGN, "bundles.json"), "utf8"));
  const fonts = JSON.parse(readFileSync(join(DESIGN, "fonts/fonts.json"), "utf8"));
  const byId = Object.fromEntries(themes.schemes.map((s) => [s.id, s]));
  const light = byId[themes.modes.light];
  const dark = byId[themes.modes.dark];
  if (!light || !dark) throw new Error("themes.json modes.light / modes.dark must name schemes");
  const names = [...themes.tokens, ...themes.syntaxTokens];
  for (const s of [light, dark]) for (const t of names) if (!/^#[0-9A-F]{6}$/i.test(s.colors[t] ?? "")) throw new Error(`${s.id}: token ${t} missing or not #RRGGBB`);
  const vars = (s) => names.map((t) => `--${t}:${s.colors[t]};`).join("");
  const themeCss = [
    `:root,[data-theme="light"]{color-scheme:light;${vars(light)}}`,
    `[data-theme="light"]{color-scheme:only light}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;${vars(dark)}}}`,
    `[data-theme="dark"]{color-scheme:only dark;${vars(dark)}}`,
  ].join("\n");

  // Plates: static SVG per mode, with the mode's token colours written into the SVG's own <style>.
  const art = {};
  const artStyle = (s) =>
    `path,circle,rect{fill:none}.k-e1{stroke:${s.colors["eng-1"]}}.k-e2{stroke:${s.colors["eng-2"]}}.k-e3{stroke:${s.colors["eng-3"]}}.k-em{stroke:${s.colors["eng-mark"]}}.k-ef{stroke:${s.colors["eng-frame"]}}.k-fm{fill:${s.colors["eng-mark"]}}.k-ft{fill:${s.colors["eng-1"]}}.k-fp{fill:${s.colors["paper-2"]}}`;
  return loadMotifs().then(({ plate }) => {
    const plates = { "plate-home": { seed: "kofra-home", lite: false }, "plate-lite": { seed: "kofra-signin", lite: true } };
    for (const [name, p] of Object.entries(plates)) {
      for (const [mode, s] of [["light", light], ["dark", dark]]) {
        const style = artStyle(s);
        const svg = plate(p.seed, { lite: p.lite, label: "KOFRA", style });
        // The SVG itself is drawn again on first request (ui/design-routes.ts), so the Worker bundle carries
        // only the recipe; the hash pins the URL to this exact drawing.
        art[`${name}-${mode}`] = { seed: p.seed, lite: p.lite, style, hash: sha8(svg), bytes: svg.length };
      }
    }
    const artUrl = (n) => `/__dropway/ui/art/${n}.${art[n].hash}.svg`;
    const artCss = Object.keys(plates)
      .map((name) => {
        const sel = name === "plate-home" ? ".k-plate-art" : ".k-plate-art.k-lite";
        const L = `background-image:url(${artUrl(`${name}-light`)})`;
        const D = `background-image:url(${artUrl(`${name}-dark`)})`;
        return `${sel},[data-theme="light"] ${sel}{${L}}@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) ${sel}{${D}}}[data-theme="dark"] ${sel}{${D}}`;
      })
      .join("");

    // Fonts: the files, their hashed URLs and @font-face rules (+ metric-matched local fallbacks).
    const fontFiles = {};
    for (const f of fonts.files) {
      const bytes = readFileSync(join(DESIGN, "fonts", f.file));
      const slug = f.family.toLowerCase().replace(/\s+/g, "-");
      const name = `${slug}-${f.subset}-${f.style}`;
      fontFiles[name] = { name, file: f.file, family: f.family, hash: sha8(bytes), b64: bytes.toString("base64"), preload: !!f.preload };
    }
    const fontFace = (base) =>
      fonts.files
        .map((f) => {
          const slug = f.family.toLowerCase().replace(/\s+/g, "-");
          const ff = fontFiles[`${slug}-${f.subset}-${f.style}`];
          return `@font-face{font-family:'${f.family}';font-style:${f.style};font-weight:${f.weight};font-display:swap;src:url(${base}/__dropway/fonts/${ff.name}.${ff.hash}.woff2) format('woff2');unicode-range:${f.unicodeRange}}`;
        })
        .join("");
    // Each family's fallback faces in order: "<Family> Fallback", then " B", " C" (fonts.json fallbacksAbout).
    const fallbackCss = Object.entries(fonts.fallbacks)
      .flatMap(([family, list]) => (Array.isArray(list) ? list : [list]).map((m, i) => ({ name: `${family} Fallback${i ? ` ${"BCDEFG"[i - 1]}` : ""}`, m })))
      .map(({ name, m }) => `@font-face{font-family:'${name}';src:${[m.local].flat().map((l) => `local('${l}')`).join(",")};size-adjust:${m.sizeAdjust};ascent-override:${m.ascentOverride};descent-override:${m.descentOverride};line-gap-override:${m.lineGapOverride}}`)
      .join("");
    const licences = fonts.licences.map((l) => `${l.family}\n${"=".repeat(l.family.length)}\n\n${readFileSync(join(DESIGN, "fonts", l.file), "utf8").trim()}\n`).join("\n\n");

    const read = (file) => {
      const src = readFileSync(join(DESIGN, "css", file), "utf8");
      return minifyCss(bundles.raw.includes(file) ? src : prefixCss(src));
    };
    const appCss = minifyCss(themeCss) + fallbackCss + fontFace("") + bundles.app.map(read).join("") + artCss;
    const siteCss = minifyCss(themeCss) + fallbackCss + bundles.site.map(read).join("");
    if (siteCss.length > bundles.siteBudgetBytes) throw new Error(`site bundle is ${siteCss.length} bytes, over the ${bundles.siteBudgetBytes}-byte budget`);
    const FONT_BASE = "__FONT_BASE__";

    const header = (what) => `// GENERATED by scripts/build-design.mjs from packages/server/design/ (${what}). Do not edit by hand:\n// change the design sources and run \`npm run design:build\`. \`npm run design:check\` fails when this file is stale.\n/* eslint-disable */\n`;
    const designTs =
      header("CSS bundles, theme colours, plate art") +
      `\n/** Every app-origin page: served as /__dropway/ui/kofra-<APP_CSS_HASH>.css (fonts relative to the app origin). */\nexport const APP_CSS = ${JSON.stringify(appCss)};\nexport const APP_CSS_HASH = ${JSON.stringify(sha8(appCss))};\n` +
      `\n/** Site-origin pages: inlined. Fonts come from the app origin through siteFontFaceCss(appOrigin). */\nexport const SITE_CSS = ${JSON.stringify(siteCss)};\nexport const SITE_CSS_HASH = ${JSON.stringify(sha8(siteCss))};\n` +
      `\n/** @font-face rules for the self-hosted fonts; ${FONT_BASE} is replaced by the app origin ("" on the app origin). */\nexport const FONT_FACE_TEMPLATE = ${JSON.stringify(fontFace(FONT_BASE))};\n` +
      `\n/** Font files preloaded on app pages (path, no origin). */\nexport const PRELOAD_FONTS: readonly string[] = ${JSON.stringify(Object.values(fontFiles).filter((f) => f.preload).map((f) => `/__dropway/fonts/${f.name}.${f.hash}.woff2`))};\n` +
      `\n/** Page background per mode, for <meta name="theme-color">. */\nexport const THEME_COLORS = ${JSON.stringify({ light: light.colors.paper, dark: dark.colors.paper })} as const;\n` +
      `\n/** Colour tokens per mode (contrast tests and literal colours written into generated art). */\nexport const THEME_TOKENS = ${JSON.stringify({ light: light.colors, dark: dark.colors })} as const;\n` +
      `\n/** Static plate art, one SVG per mode, served at /__dropway/ui/art/<name>.<hash>.svg: the recipe for ui/motifs.ts plate() and the hash of its output. */\nexport const ART: Record<string, { seed: string; lite: boolean; style: string; hash: string; bytes: number }> = ${JSON.stringify(art, null, 1)};\n`;
    const fontsTs =
      header("self-hosted fonts, SIL OFL 1.1") +
      `\n/** woff2 files (base64), served at /__dropway/fonts/<name>.<hash>.woff2. */\nexport const FONT_FILES: Record<string, { name: string; family: string; hash: string; b64: string }> = ${JSON.stringify(
        Object.fromEntries(Object.values(fontFiles).map((f) => [f.name, { name: f.name, family: f.family, hash: f.hash, b64: f.b64 }])),
        null,
        1,
      )};\n` +
      `\n/** The three SIL Open Font License 1.1 texts, served at /__dropway/fonts/OFL.txt. */\nexport const FONT_LICENCES = ${JSON.stringify(licences)};\n`;
    return { designTs, fontsTs, appCss, siteCss, themes };
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const check = process.argv.includes("--check");
  const { designTs, fontsTs, appCss, siteCss } = await buildDesign();
  if (check) {
    const stale = [[OUT_DESIGN, designTs], [OUT_FONTS, fontsTs]].filter(([p, s]) => {
      try {
        return readFileSync(p, "utf8") !== s;
      } catch {
        return true;
      }
    });
    if (stale.length) {
      console.error(`design:check: stale generated file(s): ${stale.map(([p]) => p.replace(ROOT, "")).join(", ")}. Run npm run design:build.`);
      process.exit(1);
    }
    console.log(`design:check: generated modules are up to date (app ${appCss.length} B, site ${siteCss.length} B).`);
  } else {
    writeFileSync(OUT_DESIGN, designTs);
    writeFileSync(OUT_FONTS, fontsTs);
    console.log(`design:build: app ${appCss.length} B, site ${siteCss.length} B -> ${OUT_DESIGN.replace(ROOT, "")}, ${OUT_FONTS.replace(ROOT, "")}`);
  }
}
