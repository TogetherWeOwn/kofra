import { detectFileKind, encodePath, extname, type LiveSite } from "@dropway/core";
import { escapeHtml, formatBytes } from "../html";
import { standardTabs, viewerCsp, viewerPage, type ViewerTab } from "./chrome";
import type { ViewMode, Viewer, ViewerContext, ViewerFile } from "./index";

/**
 * Images, SVG, PDF, video, audio and fonts. None of these read the whole file:
 * the page points the browser at the file itself (sub-resource requests get
 * the raw bytes), and images read only their first 64 KB for dimensions.
 *
 * When a site embeds its own file in an <iframe> (mode "frame") the raw bytes
 * are served, so a PDF or video inside a page keeps working as the author meant.
 */
const MEDIA_CSS = `
.dw-media{display:flex;flex-direction:column;align-items:center;padding:1rem .9rem 2rem;gap:.6rem}
.dw-stage{display:flex;align-items:center;justify-content:center;width:100%;min-height:calc(100vh - 9rem);border:1px solid var(--line);border-radius:10px;overflow:auto}
.dw-stage img{display:block;max-width:100%;max-height:calc(100vh - 10rem);object-fit:contain;cursor:zoom-in}
#dw-zoom:checked~.dw-stage{align-items:flex-start;justify-content:flex-start}
#dw-zoom:checked~.dw-stage img{max-width:none;max-height:none;cursor:zoom-out}
#dw-zoom:checked~.dw-mediabar label{border-color:var(--accent);color:var(--accent)}
#dw-zoom:focus-visible~.dw-mediabar label{outline:2px solid var(--accent);outline-offset:2px}
.dw-mediabar{display:flex;gap:.6rem;align-items:center;justify-content:center;flex-wrap:wrap}
.dw-fnav{display:flex;gap:.6rem;align-items:center;justify-content:center;flex-wrap:wrap}
.dw-fnav .dw-fname{display:inline-block;max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.dw-pdf{width:100%;height:calc(100vh - 3.2rem);border:0;display:block}
.dw-video{max-width:100%;max-height:calc(100vh - 9rem);border-radius:10px;background:#000}
.dw-audio{width:min(40rem,100%);margin-top:18vh}
.dw-fallback{max-width:34rem;margin:15vh auto;text-align:center;color:var(--muted)}
`;

const IMAGE_CSS = `
.dw-backgrounds{display:flex;gap:.4rem;align-items:center;justify-content:center;flex-wrap:wrap}
.dw-backgrounds label{display:inline-flex;align-items:center;gap:.35rem}
.dw-backgrounds input{margin:0;accent-color:var(--accent)}
.dw-backgrounds input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dw-backgrounds label:has(input:checked){border-color:var(--accent);font-weight:600}
.dw-media:has(#dw-bg-light:checked)>.dw-stage{background:#fff}
.dw-media:has(#dw-bg-dark:checked)>.dw-stage{background:#000}
#dw-zoom:checked~.dw-stage img{flex-shrink:0}
` + MEDIA_CSS;

const IMAGE_BACKGROUNDS = `<div class="dw-backgrounds" role="radiogroup" aria-label="Image background">
<span class="dw-meta" style="margin:0" aria-hidden="true">Background</span>
<label class="dw-btn"><input type="radio" name="dw-background" id="dw-bg-checker" value="checker" checked>Checker</label>
<label class="dw-btn"><input type="radio" name="dw-background" id="dw-bg-light" value="light">Light</label>
<label class="dw-btn"><input type="radio" name="dw-background" id="dw-bg-dark" value="dark">Dark</label>
</div>`;

/** Pixel size from the first bytes of a PNG, GIF, JPEG, WebP or BMP file. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const u16be = (o: number) => (b[o]! << 8) | b[o + 1]!;
  const u16le = (o: number) => b[o]! | (b[o + 1]! << 8);
  const u32be = (o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  const u32le = (o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") return { width: u32be(16), height: u32be(20) };
  if (b.length >= 10 && ascii(0, 4) === "GIF8") return { width: u16le(6), height: u16le(8) };
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 " && b.length >= 30) return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === "VP8L" && b.length >= 25) {
      const v = u32le(21);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  }
  if (b.length >= 26 && ascii(0, 2) === "BM") return { width: u32le(18), height: Math.abs(u32le(22) | 0) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = u16be(o + 2);
      // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16be(o + 7), height: u16be(o + 5) };
      o += 2 + len;
    }
  }
  return null;
}

function mediaTabs(vc: ViewerContext, label: string): ViewerTab[] {
  return standardTabs(vc, { rendered: label, source: false });
}

const topLevelOnly = (mode: ViewMode | undefined) => mode === "document" || mode === "view" || mode === undefined;

/**
 * The image/SVG files sharing `path`'s folder, in the listing's name order.
 * Only direct children of the folder count (no recursion into subfolders),
 * matching the folder gallery in ./listing.
 */
function folderImagePool(live: LiveSite, path: string): string[] {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const names: string[] = [];
  for (const [p, [, , type]] of Object.entries(live.files)) {
    if (!p.startsWith(dir)) continue;
    const name = p.slice(dir.length);
    if (!name || name.includes("/")) continue;
    const kind = detectFileKind(p, type);
    if (kind === "image" || kind === "svg") names.push(name);
  }
  names.sort((a, b) => a.localeCompare(b));
  return names.map((n) => dir + n);
}

interface FolderNav {
  prev?: string;
  next?: string;
  position: number;
  total: number;
}

/** Previous/next neighbours of `path` within its folder pool, or null when it is alone (or not in the pool). */
function folderNav(live: LiveSite, path: string): FolderNav | null {
  const pool = folderImagePool(live, path);
  const i = pool.indexOf(path);
  if (i === -1 || pool.length < 2) return null;
  return {
    ...(i > 0 ? { prev: pool[i - 1] } : {}),
    ...(i < pool.length - 1 ? { next: pool[i + 1] } : {}),
    position: i + 1,
    total: pool.length,
  };
}

/**
 * Pool identity for the ETag: any change to the ordered pool (a sibling
 * added, removed, renamed or reordered by a republish) changes it, so a
 * conditional request never revalidates stale Previous/Next links.
 */
function folderNavEtag(file: ViewerFile, live: LiveSite): string {
  const pool = folderImagePool(live, file.path);
  if (pool.length < 2 || !pool.includes(file.path)) return "";
  let h = 0x811c9dc5;
  const s = pool.join("\n");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `-nav${(h >>> 0).toString(36)}`;
}

/**
 * Plain-link Previous/Next controls for flipping through a folder's images
 * from the image you opened. No JavaScript: each link is an ordinary file
 * URL, so the neighbour renders in its own viewer. Hidden in embed mode,
 * where the app-origin file browser owns navigation.
 */
function folderNavHtml(vc: ViewerContext): string {
  if (vc.embed) return "";
  const nav = folderNav(vc.live, vc.file.path);
  if (!nav) return "";
  const href = (p: string) => escapeHtml(vc.siteBase + encodePath(p));
  const name = (p: string) => escapeHtml(p.split("/").pop() ?? p);
  const prev = nav.prev ? `<a class="dw-btn" rel="prev" href="${href(nav.prev)}"><span aria-hidden="true">←</span> Previous: <span class="dw-fname">${name(nav.prev)}</span></a>` : "";
  const next = nav.next ? `<a class="dw-btn" rel="next" href="${href(nav.next)}">Next: <span class="dw-fname">${name(nav.next)}</span> <span aria-hidden="true">→</span></a>` : "";
  return `<nav class="dw-fnav" aria-label="Other images in this folder">${prev}<span class="dw-meta" style="margin:0">${nav.position} of ${nav.total} in this folder</span>${next}</nav>`;
}

export const imageViewer: Viewer = {
  id: "image",
  version: 4,
  etagExtra: folderNavEtag,
  maxBytes: Number.MAX_SAFE_INTEGER,
  matches: (file, _live, mode) => file.kind === "image" && topLevelOnly(mode),
  async render(vc) {
    const head = await vc.readBytes(0, Math.min(vc.file.size, 64 * 1024)).catch(() => new Uint8Array(0));
    const dim = imageSize(head);
    const name = vc.file.path.split("/").pop() ?? vc.file.path;
    const meta = [dim ? `${dim.width.toLocaleString("en-US")} × ${dim.height.toLocaleString("en-US")} px` : null, formatBytes(vc.file.size), vc.file.contentType.split(";")[0]]
      .filter(Boolean)
      .join(" · ");
    return viewerPage(vc, {
      tabs: mediaTabs(vc, "Image"),
      css: IMAGE_CSS,
      body: `<main class="dw-media"><input type="checkbox" id="dw-zoom" class="dw-toggle">
<div class="dw-mediabar">${folderNavHtml(vc)}<span class="dw-meta" style="margin:0">${escapeHtml(meta)}</span><label for="dw-zoom" class="dw-btn">Actual size</label></div>
${IMAGE_BACKGROUNDS}
<label for="dw-zoom" class="dw-stage dw-checker"><img src="${escapeHtml(vc.fileUrl)}" alt="${escapeHtml(name)}"${dim ? ` width="${dim.width}" height="${dim.height}"` : ""}></label></main>`,
      headers: dim ? { "X-Kofra-Image-Size": `${dim.width}x${dim.height}` } : {},
    });
  },
};

export const svgViewer: Viewer = {
  id: "svg",
  version: 4,
  etagExtra: folderNavEtag,
  maxBytes: Number.MAX_SAFE_INTEGER,
  matches: (file, _live, mode) => file.kind === "svg" && topLevelOnly(mode),
  async render(vc) {
    const name = vc.file.path.split("/").pop() ?? vc.file.path;
    // Shown through <img>, so scripts inside the SVG never run.
    return viewerPage(vc, {
      tabs: standardTabs(vc, { rendered: "Image", source: true }),
      // Keep small SVGs legible without reading or embedding their markup.
      css: ".dw-stage img{min-width:min(16rem,100%)}" + IMAGE_CSS,
      body: `<main class="dw-media"><input type="checkbox" id="dw-zoom" class="dw-toggle">
<div class="dw-mediabar">${folderNavHtml(vc)}<span class="dw-meta" style="margin:0">${escapeHtml(`${formatBytes(vc.file.size)} · SVG (scripts inside it do not run here)`)}</span><label for="dw-zoom" class="dw-btn">Actual size</label></div>
${IMAGE_BACKGROUNDS}
<label for="dw-zoom" class="dw-stage dw-checker"><img src="${escapeHtml(vc.fileUrl)}" alt="${escapeHtml(name)}"></label></main>`,
    });
  },
};

export const pdfViewer: Viewer = {
  id: "pdf",
  version: 2,
  maxBytes: Number.MAX_SAFE_INTEGER,
  matches: (file, _live, mode) => file.kind === "pdf" && topLevelOnly(mode),
  async render(vc) {
    const fallback = `<div class="dw-fallback"><p>This browser cannot show the PDF inside the page.</p><p><a class="dw-btn" href="${escapeHtml(vc.rawUrl)}" rel="nofollow">Open the PDF</a> <a class="dw-btn" href="${escapeHtml(vc.downloadUrl)}" rel="nofollow" download>Download</a></p></div>`;
    return viewerPage(vc, {
      tabs: mediaTabs(vc, "PDF"),
      css: MEDIA_CSS,
      body: `<object class="dw-pdf" data="${escapeHtml(vc.rawUrl)}" type="application/pdf" aria-label="${escapeHtml(vc.file.path)}">${fallback}</object>`,
      csp: viewerCsp({ objectSrc: [vc.url.origin], frameSrc: [vc.url.origin] }),
    });
  },
};

/** A same-name .vtt next to a video becomes its subtitle track (talk.mp4 + talk.vtt or talk.en.vtt). */
function subtitleTracks(vc: ViewerContext): string {
  const dot = vc.file.path.lastIndexOf(".");
  const stem = dot > 0 ? vc.file.path.slice(0, dot) : vc.file.path;
  const tracks: string[] = [];
  for (const p of Object.keys(vc.live.files)) {
    if (!p.startsWith(stem) || extname(p) !== "vtt") continue;
    const mid = p.slice(stem.length, -4);
    if (mid !== "" && !/^\.[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(mid)) continue;
    const lang = mid ? mid.slice(1) : "";
    const src = vc.siteBase + p.split("/").map(encodeURIComponent).join("/");
    tracks.push(`<track kind="subtitles" src="${escapeHtml(src)}"${lang ? ` srclang="${escapeHtml(lang)}" label="${escapeHtml(lang)}"` : ' label="Subtitles"'}${tracks.length ? "" : " default"}>`);
  }
  return tracks.join("");
}

export const videoViewer: Viewer = {
  id: "video",
  version: 2,
  maxBytes: Number.MAX_SAFE_INTEGER,
  matches: (file, _live, mode) => file.kind === "video" && topLevelOnly(mode),
  async render(vc) {
    return viewerPage(vc, {
      tabs: mediaTabs(vc, "Video"),
      css: MEDIA_CSS,
      body: `<main class="dw-media"><video class="dw-video" controls playsinline preload="metadata" src="${escapeHtml(vc.fileUrl)}">${subtitleTracks(vc)}<a href="${escapeHtml(vc.downloadUrl)}">Download the video</a></video>
<p class="dw-meta">${escapeHtml(`${formatBytes(vc.file.size)} · ${vc.file.contentType.split(";")[0]}`)}</p></main>`,
    });
  },
};

export const audioViewer: Viewer = {
  id: "audio",
  version: 2,
  maxBytes: Number.MAX_SAFE_INTEGER,
  matches: (file, _live, mode) => file.kind === "audio" && topLevelOnly(mode),
  async render(vc) {
    const name = vc.file.path.split("/").pop() ?? vc.file.path;
    return viewerPage(vc, {
      tabs: mediaTabs(vc, "Audio"),
      css: MEDIA_CSS,
      body: `<main class="dw-media"><audio class="dw-audio" controls preload="metadata" src="${escapeHtml(vc.fileUrl)}"><a href="${escapeHtml(vc.downloadUrl)}">Download the audio</a></audio>
<p class="dw-meta"><strong style="color:var(--fg)">${escapeHtml(name)}</strong> · ${escapeHtml(`${formatBytes(vc.file.size)} · ${vc.file.contentType.split(";")[0]}`)}</p></main>`,
    });
  },
};

const FONT_FORMATS: Record<string, string> = { woff2: "woff2", woff: "woff", ttf: "truetype", otf: "opentype", eot: "embedded-opentype" };

export const fontViewer: Viewer = {
  id: "font",
  version: 2,
  maxBytes: Number.MAX_SAFE_INTEGER,
  matches: (file, _live, mode) => file.kind === "font" && topLevelOnly(mode),
  async render(vc) {
    const fmt = FONT_FORMATS[extname(vc.file.path)];
    const name = vc.file.path.split("/").pop() ?? vc.file.path;
    const sizes = [12, 16, 20, 28, 40, 56, 72]
      .map((px) => `<div class="dw-fs"><span>${px}px</span><p style="font-size:${px}px">The quick brown fox jumps over the lazy dog</p></div>`)
      .join("");
    return viewerPage(vc, {
      tabs: mediaTabs(vc, "Specimen"),
      css: `@font-face{font-family:"dw-specimen";src:url("${vc.fileUrl.replace(/["\\\n]/g, "")}")${fmt ? ` format("${fmt}")` : ""};font-display:block}
.dw-font{max-width:60rem;margin:0 auto;padding:1.5rem 1.25rem 4rem}
.dw-font .s{font-family:"dw-specimen",ui-monospace,monospace}
.dw-font .big{font-size:clamp(5rem,16vw,11rem);line-height:1;margin:.5rem 0 1rem}
.dw-font .set{font-size:1.6rem;line-height:1.5;word-break:break-all;margin:0 0 .6rem}
.dw-font .try{font-size:2rem;line-height:1.35;border:1px dashed var(--line);border-radius:10px;padding:1rem;margin:1.5rem 0;outline:0}
.dw-font .try:focus{border-color:var(--accent)}
.dw-fs{display:flex;gap:1rem;align-items:baseline;border-top:1px solid var(--line);padding:.4rem 0}
.dw-fs span{flex:none;width:3.5rem;color:var(--muted);font-size:.8rem;font-family:ui-monospace,monospace}
.dw-fs p{margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:"dw-specimen",ui-monospace,monospace}`,
      body: `<main class="dw-font"><p class="dw-meta" style="text-align:left">${escapeHtml(`${name} · ${formatBytes(vc.file.size)} · ${vc.file.contentType.split(";")[0]}`)}</p>
<div class="s big" aria-hidden="true">Aa Gg</div>
<p class="s set">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br>0123456789 !?&amp;@#%()[]{}.,;:'"-+=*/\\</p>
<div class="s try" contenteditable="true" spellcheck="false" aria-label="Type to try the font">Type here to try this font.</div>
${sizes}</main>`,
    });
  },
};
