// @ts-nocheck
/**
 * Kofra Security Print motifs as pure string generators (ported from the design prototype's
 * security-print.js). No DOM and no randomness at run time: every mark is seeded, so the same input
 * always draws the same SVG.
 *
 * - seal(seed, opts): a guilloche seal. File seals are seeded with "SHA256:<hex>", so each file gets
 *   its own mark; strokes and fills are token classes (k-e1, k-e2, k-em, k-ef, k-fm), so the seal
 *   recolours with the page's colour mode. A seal shows which bytes were stored. It never means the
 *   file is safe, scanned or verified.
 * - plate(seed, opts): the engraved hero plate, built once at design-build time into static SVG files
 *   (one per mode, scripts/build-design.mjs).
 *
 * This file is ONE self-contained function: ./assets.ts embeds its source text in the dashboard script
 * (the same way as the client itself), so never reference anything outside kofraMotifs().
 */
export function kofraMotifs() {
  "use strict";
  function fnv(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function rng(seed) {
    return function () {
      seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fx(v) {
    var r = Math.round(v * 10) / 10;
    return String(r === 0 ? 0 : r);
  }
  /** One guilloche curve: a circle of radius R modulated by two harmonics. */
  function curve(cx, cy, g, ph, B, m2, N) {
    var d = "";
    for (var k = 0; k <= N; k++) {
      var t = (k / N) * 2 * Math.PI;
      var rad = g.R + g.A * Math.sin(g.n * t + ph) + B * Math.sin(m2 * g.n * t - ph * 2);
      d += (k ? "L" : "M") + fx(cx + rad * Math.cos(t)) + " " + fx(cy + rad * Math.sin(t));
    }
    return d + "Z";
  }
  function harmonics(r, B0, B1) {
    return { B: (B0 === undefined ? 1.2 : B0) + r() * (B1 === undefined ? 2.2 : B1), m2: 2 + Math.floor(r() * 3), skew: r() * Math.PI };
  }
  function rosette(cx, cy, bands, h, N, animate) {
    var out = "";
    bands.forEach(function (g, gi) {
      for (var j = 0; j < g.cp; j++) {
        out +=
          '<path d="' + curve(cx, cy, g, (j * 2 * Math.PI) / g.cp + h.skew * gi, h.B, h.m2, N) + '" class="k-' + g.cls + '" stroke-width="' + g.w + '"' +
          (animate ? ' pathLength="1" style="animation-delay:' + gi * 40 + 'ms"' : "") + "/>";
      }
    });
    return out;
  }

  /**
   * A seal for `seed`. size: "mini" (40px file seals: three bold bands), "small" (no ring text) or
   * "full" (ring text). label: the accessible name (required; the SVG is role=img).
   */
  function seal(seed, opts) {
    opts = opts || {};
    var size = opts.size || "mini";
    var mini = size === "mini";
    var small = size !== "full";
    var r = rng(fnv(String(seed)));
    var c = 100;
    var animate = !!opts.animate;
    var body = '<circle cx="100" cy="100" r="' + (mini ? 94 : 98) + '" class="k-ef" stroke-width="' + (mini ? 6 : 0.8) + '"/>';
    if (!mini) body += '<circle cx="100" cy="100" r="95.5" class="k-ef" stroke-width="0.4"/>';
    if (!small) {
      var text = opts.text || String(seed) + " · KOFRA · ";
      var id = "k-ring-" + (fnv(String(seed)) % 1e6);
      body +=
        '<defs><path id="' + id + '" d="M100,7.5 a92.5,92.5 0 1,1 -0.01,0"/></defs><text class="k-ft" font-size="4.2" font-family="Martian Mono, ui-monospace, monospace" letter-spacing=".6" aria-hidden="true"><textPath href="#' +
        id + '">' + esc(text.repeat(Math.ceil(200 / text.length))) + "</textPath></text>";
    }
    var h = harmonics(r);
    var bands = [
      { R: 80, A: 5 + r() * 3, n: 20 + Math.floor(r() * 12), cp: small ? 7 : 12, cls: "e1", w: 0.32 },
      { R: 61, A: 9 + r() * 5, n: 9 + Math.floor(r() * 7), cp: small ? 7 : 14, cls: "e1", w: 0.32 },
      { R: 40, A: 8 + r() * 5, n: 6 + Math.floor(r() * 6), cp: small ? 6 : 12, cls: "e2", w: 0.32 },
      { R: 18, A: 5 + r() * 3, n: 5 + Math.floor(r() * 4), cp: small ? 5 : 9, cls: "em", w: 0.42 },
    ];
    var use = mini
      ? bands.slice(0, 3).map(function (g) {
          return { R: g.R, A: g.A, n: g.n, cp: 3, cls: g.cls, w: 3.84 };
        })
      : bands.map(function (g) {
          return { R: g.R, A: g.A, n: g.n, cp: g.cp, cls: g.cls, w: small ? Math.round(g.w * 1.6 * 100) / 100 : g.w };
        });
    body += rosette(c, c, use, h, mini ? 72 : small ? 180 : 300, animate);
    body += '<circle cx="100" cy="100" r="' + (mini ? 9 : 4) + '" class="k-fm"/>';
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" class="k-sp-svg k-seal' + (animate ? " k-draw" : "") + '"' +
      (opts.label ? ' role="img" aria-label="' + esc(opts.label) + '"' : ' aria-hidden="true"') + ' focusable="false">' + body + "</svg>"
    );
  }

  /**
   * The engraved plate: lathe-line ground, a double frame with microtext, four corner rosettes and a
   * central rosette. lite: fewer, thicker lines (for small art). points: points per curve.
   * style: CSS put inside the SVG (the build writes the mode's token colours here).
   */
  function plate(seed, opts) {
    opts = opts || {};
    var W = 600;
    var H = 400;
    var lite = !!opts.lite;
    var N = opts.points || (lite ? 160 : 240);
    var r = rng(fnv("plate:" + seed));
    var out = "";
    var f1 = 14 + r() * 8;
    var f2 = 5 + r() * 3;
    var a1 = 2.2 + r() * 1.4;
    out += '<g class="k-e3" stroke-width="' + (lite ? 0.9 : 0.5) + '" opacity=".75">';
    for (var y0 = 4; y0 < H; y0 += lite ? 9 : 6) {
      var d = "";
      for (var x = 0; x <= W; x += 8) d += (x ? "L" : "M") + x + " " + fx(y0 + a1 * Math.sin(x / f1 + y0 / 23) + 1.1 * Math.sin(x / f2 - y0 / 9));
      out += '<path d="' + d + '"/>';
    }
    out += "</g>";
    if (!lite) {
      out += '<rect x="10" y="10" width="' + (W - 20) + '" height="' + (H - 20) + '" class="k-ef" fill="none" stroke-width=".9"/>';
      out += '<rect x="15" y="15" width="' + (W - 30) + '" height="' + (H - 30) + '" class="k-ef" fill="none" stroke-width=".4"/>';
      var label = (opts.label || "KOFRA") + " · " + String(seed).toUpperCase() + " · ";
      var line = esc(label.repeat(Math.ceil(110 / label.length)).slice(0, 110));
      [22, H - 19].forEach(function (y) {
        out += '<text x="24" y="' + y + '" class="k-ft" font-size="4.5" font-family="Martian Mono, ui-monospace, monospace" letter-spacing=".5" textLength="' + (W - 48) + '">' + line + "</text>";
      });
      [[60, 60], [W - 60, 60], [60, H - 60], [W - 60, H - 60]].forEach(function (p) {
        out += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="36" class="k-fp"/>';
        var hc = harmonics(r);
        out += rosette(p[0], p[1], [{ R: 28, A: 4 + r() * 2, n: 12 + Math.floor(r() * 6), cp: 8, cls: "e1", w: 0.45 }, { R: 15, A: 4 + r() * 2, n: 6 + Math.floor(r() * 3), cp: 6, cls: "e2", w: 0.45 }], hc, Math.round(N * 0.75));
      });
    }
    var cx = W / 2;
    var cy = H / 2;
    var k = lite ? 0.9 : 1;
    var hp = harmonics(r, 1.6, 3);
    out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + fx(176 * k) + '" class="k-fp"/>';
    out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + fx(176 * k) + '" class="k-ef" stroke-width=".8"/>';
    out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + fx(171 * k) + '" class="k-ef" stroke-width=".35"/>';
    var bands = [
      { R: 154 * k, A: 8 + r() * 4, n: 30 + Math.floor(r() * 12), cp: lite ? 6 : 16, cls: "e1", w: lite ? 1.4 : 0.5 },
      { R: 122 * k, A: 14 + r() * 6, n: 14 + Math.floor(r() * 8), cp: lite ? 6 : 20, cls: "e1", w: lite ? 1.4 : 0.45 },
      { R: 88 * k, A: 12 + r() * 6, n: 10 + Math.floor(r() * 6), cp: lite ? 5 : 18, cls: "e2", w: lite ? 1.4 : 0.45 },
      { R: 54 * k, A: 9 + r() * 4, n: 7 + Math.floor(r() * 5), cp: lite ? 4 : 14, cls: "e2", w: lite ? 1.4 : 0.45 },
      { R: 24 * k, A: 6 + r() * 3, n: 5 + Math.floor(r() * 4), cp: lite ? 3 : 10, cls: "em", w: lite ? 1.6 : 0.6 },
    ];
    out += rosette(cx, cy, bands, hp, N, false);
    out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (lite ? 6 : 4.5) + '" class="k-fm"/>';
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMidYMid slice">' +
      (opts.style ? "<style>" + opts.style + "</style>" : "") + out + "</svg>"
    );
  }

  return { seal: seal, plate: plate, fnv: fnv, rng: rng };
}

const motifs = kofraMotifs() as {
  seal(seed: string, opts?: { size?: "mini" | "small" | "full"; label?: string; text?: string; animate?: boolean }): string;
  plate(seed: string, opts?: { lite?: boolean; label?: string; points?: number; style?: string }): string;
};

/** A checksum seal for a file (seeded with its SHA-256). The label names the file and the short hash. */
export function fileSeal(path: string, sha256: string, size: "mini" | "small" = "mini"): string {
  return motifs.seal(`SHA256:${sha256}`, { size, label: `Checksum seal for ${path}, SHA-256 ${sha256.slice(0, 12)}` });
}

export const seal = motifs.seal;
export const plate = motifs.plate;
